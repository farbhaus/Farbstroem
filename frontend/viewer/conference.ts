// Conference subsystem: LiveKit room lifecycle, tile-grid DOM sync,
// cam/mic/screen-share toggles, device picker, presenter moderation
// (kick + mute). Co-located because tile rendering is tightly coupled to
// LiveKit's track state.

import { toast } from '../shared/utils.js';
import { sizeCallGrid } from './layout.js';
import { getParticipantId, getToken, PREF_KEY, slug } from './session.js';
import { viewerStore } from './state.js';
import type { LivekitTokenResponse, RosterEntry } from './types.js';

let livekitRoom: LkRoom | null = null;
let activeScreenShareId: string | null = null; // participant.identity or 'local'
let activeScreenShareTrack: LkTrack | null = null;
let selfMuteInFlight = false;

const SVG_USER =
  '<svg viewBox="0 0 24 24" stroke="currentColor" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>';
const SVG_MIC =
  '<svg viewBox="0 0 24 24" stroke="currentColor" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="1" width="6" height="11" rx="3"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>';
const SVG_MIC_OFF =
  '<svg viewBox="0 0 24 24" stroke="currentColor" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>';

function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function getLivekitRoom(): LkRoom | null {
  return livekitRoom;
}

// ---- Screen share ----

function showScreenShare(track: LkTrack, label: string): void {
  if (activeScreenShareTrack) {
    activeScreenShareTrack.detach(document.getElementById('screenshare-video'));
  }
  activeScreenShareTrack = track;
  track.attach(document.getElementById('screenshare-video'));
  const lblEl = document.getElementById('screenshare-label');
  if (lblEl) lblEl.textContent = label;
  document.getElementById('screenshare-wrap')?.classList.add('active');
  document.body.classList.add('sharing-screen');
  // Auto-switch call-mode to Presenter unless the user has manually picked
  // a layout for this share session.
  const { mode, layoutOverride } = viewerStore.get();
  if (mode === 'call' && !layoutOverride) setCallLayout('presenter');
}

function hideScreenShare(): void {
  if (activeScreenShareTrack) {
    activeScreenShareTrack.detach(document.getElementById('screenshare-video'));
    activeScreenShareTrack = null;
  }
  document.getElementById('screenshare-wrap')?.classList.remove('active');
  document.body.classList.remove('sharing-screen');
  activeScreenShareId = null;
  // Share ended → return to Grid and drop the manual-override flag so the
  // next share can auto-switch again.
  if (viewerStore.get().mode === 'call') {
    viewerStore.set({ layoutOverride: false });
    setCallLayout('grid');
  }
}

export function setCallLayout(layout: 'grid' | 'presenter'): void {
  viewerStore.set({ layout });
  document.body.classList.toggle('call-layout-grid', layout === 'grid');
  document.body.classList.toggle('call-layout-presenter', layout === 'presenter');
  document.getElementById('layout-btn')?.classList.toggle('panel-open', layout === 'presenter');
  requestAnimationFrame(sizeCallGrid);
}

// ---- LiveKit init ----

export async function initLiveKit(): Promise<void> {
  if (livekitRoom) {
    await livekitRoom.disconnect();
    livekitRoom = null;
  }

  const res = await fetch(
    `/api/public/rooms/${encodeURIComponent(slug)}/livekit-token` +
      `?participantId=${encodeURIComponent(getParticipantId())}&token=${encodeURIComponent(getToken())}`,
  );
  if (!res.ok) throw new Error('Could not get LiveKit token');
  const { token: lkToken, url: lkUrl } = (await res.json()) as LivekitTokenResponse;

  const room = new LivekitClient.Room();
  livekitRoom = room;

  room.on(LivekitClient.RoomEvent.ParticipantConnected, () => syncConferenceTiles());
  room.on(LivekitClient.RoomEvent.ParticipantDisconnected, () => syncConferenceTiles());
  room.on(LivekitClient.RoomEvent.TrackPublished, () => syncConferenceTiles());
  room.on(LivekitClient.RoomEvent.TrackUnpublished, () => syncConferenceTiles());
  room.on(LivekitClient.RoomEvent.TrackMuted, (pub, participant) => {
    syncConferenceTiles();
    syncLocalMuteState(pub as LkPublication, participant as LkLocalParticipant);
  });
  room.on(LivekitClient.RoomEvent.TrackUnmuted, (pub, participant) => {
    syncConferenceTiles();
    syncLocalMuteState(pub as LkPublication, participant as LkLocalParticipant);
  });
  room.on(LivekitClient.RoomEvent.TrackSubscribed, (track, _pub, participant) => {
    attachTrack(track as LkTrack, participant as LkRemoteParticipant);
  });
  room.on(LivekitClient.RoomEvent.TrackUnsubscribed, (track, _pub, participant) => {
    const t = track as LkTrack;
    const p = participant as LkRemoteParticipant;
    if (t.source === LivekitClient.Track.Source.ScreenShare) {
      if (activeScreenShareId === p.identity) hideScreenShare();
      return;
    }
    t.detach();
    syncConferenceTiles();
  });
  room.on(LivekitClient.RoomEvent.LocalTrackUnpublished, (pub) => {
    const p = pub as LkPublication;
    if (p.source === LivekitClient.Track.Source.ScreenShare && activeScreenShareId === 'local') {
      hideScreenShare();
      viewerStore.set({ screenOn: false });
      document.getElementById('screen-btn')?.classList.remove('active');
    }
  });

  await room.connect(lkUrl, lkToken);

  // Attach any tracks already subscribed (participants present before we
  // joined). The post-connect snapshot avoids missing peers that joined
  // during the connect roundtrip.
  syncConferenceTiles();
  for (const p of room.remoteParticipants.values()) {
    for (const pub of p.trackPublications.values()) {
      if (pub.track) attachTrack(pub.track, p);
    }
  }

  const { cameraOn, micOn } = viewerStore.get();
  if (cameraOn) await room.localParticipant.setCameraEnabled(true);
  if (micOn) await room.localParticipant.setMicrophoneEnabled(true);

  updateSelfTile();
}

export async function disconnectLiveKit(): Promise<void> {
  if (livekitRoom) {
    try {
      await livekitRoom.disconnect();
    } catch {}
    livekitRoom = null;
  }
}

// ---- Mute state sync (forced-mute detection) ----

function startMicBreathe(): void {
  document.getElementById('mic-btn')?.classList.add('force-muted');
}
function stopMicBreathe(): void {
  document.getElementById('mic-btn')?.classList.remove('force-muted');
}

function syncLocalMuteState(pub: LkPublication, participant: unknown): void {
  if (!livekitRoom || participant !== livekitRoom.localParticipant) return;
  if (pub.source === LivekitClient.Track.Source.Microphone) {
    const { micOn } = viewerStore.get();
    // Forced mute detection: muted event arrived while we still thought mic
    // was on and no local toggle is in flight → host/presenter muted us.
    if (pub.isMuted && micOn && !selfMuteInFlight) startMicBreathe();
    if (!pub.isMuted) stopMicBreathe();
    viewerStore.set({ micOn: !pub.isMuted });
    refreshConfButtons();
    updateSelfTile();
  }
  if (pub.source === LivekitClient.Track.Source.Camera) {
    viewerStore.set({ cameraOn: !pub.isMuted });
    refreshConfButtons();
    updateSelfTile();
  }
}

// ---- Self tile ----

function updateSelfTile(): void {
  const v = document.getElementById('self-preview') as HTMLVideoElement;
  const selfTile = document.getElementById('self-tile') as HTMLElement;
  const micIcon = document.getElementById('self-mic-icon') as HTMLElement;
  const { cameraOn, micOn } = viewerStore.get();

  if (!cameraOn && !micOn) {
    selfTile.style.display = 'none';
    selfTile.classList.remove('mic-only');
    micIcon.style.display = 'none';
    return;
  }
  if (cameraOn && livekitRoom) {
    const camPub = livekitRoom.localParticipant.getTrackPublication(
      LivekitClient.Track.Source.Camera,
    );
    if (camPub?.track) {
      v.srcObject = new MediaStream([camPub.track.mediaStreamTrack]);
    }
    selfTile.classList.remove('mic-only');
    micIcon.style.display = 'none';
    selfTile.style.display = 'block';
  } else {
    v.srcObject = null;
    selfTile.classList.add('mic-only');
    micIcon.style.display = '';
    selfTile.style.display = 'flex';
  }
}

// ---- Tile grid sync ----

export function syncConferenceTiles(): void {
  const { mode, roster, role: myRole, cameraOn, micOn } = viewerStore.get();
  // In call mode the tiles live in the center-stage grid; otherwise in the
  // left sidebar. Move #self-tile + #conf-empty into the active container
  // so existing CSS keeps working unchanged.
  const tilesEl = document.getElementById(mode === 'call' ? 'call-grid' : 'conf-tiles');
  const emptyEl = document.getElementById('conf-empty');
  const selfTile = document.getElementById('self-tile');
  if (!tilesEl) return;
  if (selfTile && selfTile.parentElement !== tilesEl) tilesEl.appendChild(selfTile);
  if (emptyEl && emptyEl.parentElement !== tilesEl) tilesEl.appendChild(emptyEl);

  const lkMap: Map<string, LkRemoteParticipant> = livekitRoom
    ? new Map(Array.from(livekitRoom.remoteParticipants.values()).map((p) => [p.identity, p]))
    : new Map();

  // Every remote participant from the roster gets a tile. Watch-only users
  // (not in LiveKit) render as a placeholder; LK peers attach their cam/mic
  // to the same tile.
  const myPid = getParticipantId();
  const byId = new Map<string, RosterEntry>();
  for (const p of roster) {
    if (p.id !== myPid) byId.set(p.id, p);
  }
  // Race safety: a LK peer might briefly be missing from the roster (e.g.
  // participants:update lagging). Synthesize a minimal entry.
  for (const [id, lkp] of lkMap) {
    if (!byId.has(id)) {
      let role: RosterEntry['role'] = 'viewer';
      try {
        const meta = JSON.parse(lkp.metadata || '{}');
        if (meta.role === 'presenter') role = 'presenter';
      } catch {}
      byId.set(id, { id, name: lkp.name || id, role });
    }
  }

  // Remove tiles for participants no longer present.
  for (const tile of Array.from(tilesEl.querySelectorAll('.conf-tile[id^="conf-tile-"]'))) {
    const id = tile.id.slice('conf-tile-'.length);
    if (!byId.has(id)) tile.remove();
  }

  for (const [pid, rp] of byId) {
    const lkp = lkMap.get(pid);
    const camPub = lkp?.getTrackPublication(LivekitClient.Track.Source.Camera);
    const micPub = lkp?.getTrackPublication(LivekitClient.Track.Source.Microphone);
    const hasCam = !!(camPub && !camPub.isMuted);
    const hasMic = !!(micPub && !micPub.isMuted);

    let tile = document.getElementById(`conf-tile-${pid}`);
    if (!tile) {
      tile = document.createElement('div');
      tile.id = `conf-tile-${pid}`;
      tile.className = 'conf-tile';

      const isTargetPresenter = rp.role === 'presenter';
      const micSid = micPub?.trackSid || '';
      const micMuted = micPub?.isMuted ?? true;

      tile.innerHTML =
        `<div id="conf-player-${pid}" class="conf-player-inner">` +
        `<video autoplay playsinline style="width:100%;height:100%;object-fit:cover"></video></div>` +
        `<div class="conf-user-icon">${SVG_USER}</div>` +
        `<div class="conf-mic-icon" style="display:none">${SVG_MIC}</div>` +
        `<div class="conf-name">${escAttr(rp.name || pid)}</div>` +
        (myRole === 'presenter' && !isTargetPresenter
          ? `<div class="tile-actions">` +
            `<button class="tile-btn${micMuted ? ' muted-indicator' : ''}" title="${micMuted ? 'Unmute' : 'Mute'}" ` +
            `data-action="presenter-mute" data-identity="${escAttr(pid)}" data-sid="${escAttr(micSid)}">${micMuted ? SVG_MIC_OFF : SVG_MIC}</button>` +
            `<button class="tile-btn danger" title="Remove from conference" ` +
            `data-action="presenter-kick" data-identity="${escAttr(pid)}">` +
            `<svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>` +
            `</div>`
          : '');
      tilesEl.insertBefore(tile, emptyEl);
    }

    // Keep the display name in sync with roster updates.
    const nameEl = tile.querySelector('.conf-name');
    const nextName = rp.name || pid;
    if (nameEl && nameEl.textContent !== nextName) nameEl.textContent = nextName;

    if (myRole === 'presenter') {
      const muteBtn = tile.querySelector<HTMLButtonElement>('[data-action="presenter-mute"]');
      if (muteBtn) {
        const micSid = micPub?.trackSid || '';
        const micMuted = micPub?.isMuted ?? true;
        muteBtn.className = `tile-btn${micMuted ? ' muted-indicator' : ''}`;
        muteBtn.title = micMuted ? 'Unmute' : 'Mute';
        muteBtn.dataset['sid'] = micSid;
        muteBtn.innerHTML = micMuted ? SVG_MIC_OFF : SVG_MIC;
      }
    }

    tile.classList.toggle('cam-off', !hasCam);
    const micIconEl = tile.querySelector<HTMLElement>('.conf-mic-icon');
    const userIconEl = tile.querySelector<HTMLElement>('.conf-user-icon');
    if (micIconEl) micIconEl.style.display = hasMic && !hasCam ? 'flex' : 'none';
    if (userIconEl) userIconEl.style.display = !hasMic && !hasCam ? 'flex' : 'none';
  }

  const hasRemoteTiles = byId.size > 0;
  if (emptyEl)
    emptyEl.style.display = hasRemoteTiles || cameraOn || micOn ? 'none' : '';
  sizeCallGrid();
}

function attachTrack(track: LkTrack, participant: LkRemoteParticipant): void {
  // Audio (mic or screen share audio) — auto-attach to a new <audio> element.
  if (track.kind === LivekitClient.Track.Kind.Audio) {
    track.attach();
    return;
  }
  // Screen share — route to center overlay.
  if (track.source === LivekitClient.Track.Source.ScreenShare) {
    activeScreenShareId = participant.identity;
    activeScreenShareTrack = track;
    showScreenShare(track, (participant.name || participant.identity) + ' — Screen');
    return;
  }
  // Camera — attach to the participant's conf tile.
  const inner = document.getElementById(`conf-player-${participant.identity}`);
  if (!inner) {
    syncConferenceTiles();
    const innerRetry = document.getElementById(`conf-player-${participant.identity}`);
    const v = innerRetry?.querySelector('video');
    if (v) track.attach(v);
    return;
  }
  const video = inner.querySelector('video');
  if (video) track.attach(video);
  syncConferenceTiles();
}

// ---- Conference buttons (cam/mic/screen) ----

interface BtnState {
  active?: boolean;
  muted?: boolean;
  disabled?: boolean;
}

function setConfBtns(camState: BtnState, micState: BtnState): void {
  const camBtn = document.getElementById('cam-btn') as HTMLButtonElement;
  const micBtn = document.getElementById('mic-btn') as HTMLButtonElement;
  camBtn.classList.toggle('active', !!camState.active);
  camBtn.classList.toggle('muted', !!camState.muted);
  camBtn.disabled = !!camState.disabled;
  micBtn.classList.toggle('active', !!micState.active);
  micBtn.classList.toggle('muted', !!micState.muted);
  micBtn.disabled = !!micState.disabled;
}

export function refreshConfButtons(): void {
  const { cameraOn, micOn } = viewerStore.get();
  setConfBtns({ active: cameraOn, muted: !cameraOn }, { active: micOn, muted: !micOn });
}

// Browsers (Safari especially) surface permission/hardware failures as
// DOMException names rather than messages. Map them to actionable copy
// so the toggle doesn't just silently revert.
function deviceErrorMessage(err: unknown, kind: 'cam' | 'mic'): string {
  const label = kind === 'mic' ? 'Microphone' : 'Camera';
  const name = err instanceof Error ? err.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return `${label} blocked — enable it in your browser's site settings.`;
    case 'NotFoundError':
    case 'OverconstrainedError':
      return `No ${label.toLowerCase()} found on this device.`;
    case 'NotReadableError':
    case 'AbortError':
      return `${label} is in use by another app.`;
    default:
      return `Couldn't enable ${label.toLowerCase()}.`;
  }
}

async function toggleCamera(): Promise<void> {
  const { cameraOn, micOn } = viewerStore.get();
  localStorage.setItem(PREF_KEY, !cameraOn ? (micOn ? 'both' : 'cam') : micOn ? 'mic' : 'none');
  const next = !cameraOn;
  viewerStore.set({ cameraOn: next });
  setConfBtns({ disabled: true }, { active: micOn, disabled: true });
  try {
    if (livekitRoom) {
      await livekitRoom.localParticipant.setCameraEnabled(next);
      updateSelfTile();
    } else {
      await initLiveKit();
    }
  } catch (err) {
    console.error('[conf cam]', err);
    viewerStore.set({ cameraOn });
    toast(deviceErrorMessage(err, 'cam'));
  }
  refreshConfButtons();
}

async function toggleMic(): Promise<void> {
  stopMicBreathe(); // user acknowledged — clear any force-mute alert immediately
  const { cameraOn, micOn } = viewerStore.get();
  localStorage.setItem(PREF_KEY, cameraOn ? (!micOn ? 'both' : 'cam') : !micOn ? 'mic' : 'none');
  const next = !micOn;
  viewerStore.set({ micOn: next });
  selfMuteInFlight = true;
  setConfBtns({ active: cameraOn, disabled: true }, { disabled: true });
  try {
    if (livekitRoom) {
      await livekitRoom.localParticipant.setMicrophoneEnabled(next);
      updateSelfTile();
    } else if (next) {
      await initLiveKit();
    }
  } catch (err) {
    console.error('[conf mic]', err);
    viewerStore.set({ micOn });
    toast(deviceErrorMessage(err, 'mic'));
  } finally {
    selfMuteInFlight = false;
  }
  refreshConfButtons();
}

async function toggleScreenShare(): Promise<void> {
  const next = !viewerStore.get().screenOn;
  viewerStore.set({ screenOn: next });
  document.getElementById('screen-btn')?.classList.toggle('active', next);
  try {
    if (!livekitRoom) {
      if (next) await initLiveKit();
      else return;
    }
    await livekitRoom!.localParticipant.setScreenShareEnabled(next);
    if (next) {
      const pub = livekitRoom!.localParticipant.getTrackPublication(
        LivekitClient.Track.Source.ScreenShare,
      );
      if (pub?.track) {
        activeScreenShareId = 'local';
        activeScreenShareTrack = pub.track;
        showScreenShare(pub.track, 'You — Screen');
      }
    } else {
      hideScreenShare();
    }
  } catch (err) {
    console.error('[screen share]', err);
    viewerStore.set({ screenOn: false });
    document.getElementById('screen-btn')?.classList.remove('active');
    hideScreenShare();
  }
}

// ---- Conference permission prompt ----

async function applyConfPref(pref: 'both' | 'cam' | 'mic' | 'none', save = true): Promise<void> {
  const overlay = document.getElementById('conf-prompt-overlay') as HTMLElement & {
    _dismissHandler?: ((e: MouseEvent) => void) | null;
  };
  if (overlay._dismissHandler) {
    overlay.removeEventListener('click', overlay._dismissHandler);
    overlay._dismissHandler = null;
  }
  overlay.classList.add('hidden');
  if (save) localStorage.setItem(PREF_KEY, pref);

  let cameraOn = false;
  let micOn = false;
  if (pref === 'both') {
    cameraOn = true;
    micOn = true;
  } else if (pref === 'cam') {
    cameraOn = true;
  } else if (pref === 'mic') {
    micOn = true;
  }
  viewerStore.set({ cameraOn, micOn });

  // Auto-open conference panel when camera or mic is enabled.
  // (Use direct toggle instead of the layout module to avoid a cycle.)
  if ((cameraOn || micOn) && !viewerStore.get().confOpen) {
    document.getElementById('conf-toggle')?.click();
  }

  refreshConfButtons();
  setConfBtns({ disabled: true }, { disabled: true });
  try {
    await initLiveKit();
  } catch (err) {
    console.error('[conf prompt]', err);
    viewerStore.set({ cameraOn: false, micOn: false });
  }
  refreshConfButtons();
}

export function showConfPrompt(): void {
  const saved = localStorage.getItem(PREF_KEY);
  if (saved) {
    void applyConfPref(saved as 'both' | 'cam' | 'mic' | 'none', false);
    return;
  }
  document.getElementById('prompt-mic')?.classList.add('pref-saved');
  const overlay = document.getElementById('conf-prompt-overlay') as HTMLElement & {
    _dismissHandler?: ((e: MouseEvent) => void) | null;
  };
  overlay.classList.remove('hidden');
  if (overlay._dismissHandler) overlay.removeEventListener('click', overlay._dismissHandler);
  const dismiss = (e: MouseEvent): void => {
    if (e.target !== overlay) return;
    overlay.removeEventListener('click', dismiss);
    overlay._dismissHandler = null;
    void applyConfPref('mic');
  };
  overlay._dismissHandler = dismiss;
  overlay.addEventListener('click', dismiss);
}

// ---- Device picker ----

function populateDeviceSelect(selectId: string, devices: MediaDeviceInfo[]): void {
  const sel = document.getElementById(selectId) as HTMLSelectElement;
  sel.innerHTML = '';
  if (!devices.length) {
    sel.innerHTML = '<option>No devices found</option>';
    return;
  }
  devices.forEach((d, i) => {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `Device ${i + 1}`;
    sel.appendChild(opt);
  });
}

async function openDevicePicker(): Promise<void> {
  const overlay = document.getElementById('device-picker-overlay') as HTMLElement;
  overlay.classList.remove('hidden');
  try {
    // Request permission first to get labeled devices.
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    stream.getTracks().forEach((t) => t.stop());
  } catch (err) {
    console.warn('[device picker] pre-prompt failed', err);
    toast(deviceErrorMessage(err, 'cam'));
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  populateDeviceSelect(
    'device-camera',
    devices.filter((d) => d.kind === 'videoinput'),
  );
  populateDeviceSelect(
    'device-mic',
    devices.filter((d) => d.kind === 'audioinput'),
  );
  populateDeviceSelect(
    'device-speaker',
    devices.filter((d) => d.kind === 'audiooutput'),
  );

  if (livekitRoom) {
    const camTrack = livekitRoom.localParticipant.getTrackPublication(
      LivekitClient.Track.Source.Camera,
    )?.track;
    const micTrack = livekitRoom.localParticipant.getTrackPublication(
      LivekitClient.Track.Source.Microphone,
    )?.track;
    if (camTrack?.mediaStreamTrack) {
      (document.getElementById('device-camera') as HTMLSelectElement).value =
        camTrack.mediaStreamTrack.getSettings().deviceId || '';
    }
    if (micTrack?.mediaStreamTrack) {
      (document.getElementById('device-mic') as HTMLSelectElement).value =
        micTrack.mediaStreamTrack.getSettings().deviceId || '';
    }
  }
}

// ---- Presenter moderation ----

async function presenterKick(targetId: string): Promise<void> {
  try {
    await fetch(`/api/public/rooms/${slug}/conference/kick`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        participantId: getParticipantId(),
        token: getToken(),
        targetId,
      }),
    });
  } catch (err) {
    console.error('[kick]', err);
  }
}

async function presenterMute(targetId: string): Promise<void> {
  const micPub = livekitRoom?.remoteParticipants
    .get(targetId)
    ?.getTrackPublication(LivekitClient.Track.Source.Microphone);
  if (!micPub) return;
  const nowMuted = !micPub.isMuted;
  try {
    await fetch(`/api/public/rooms/${slug}/conference/mute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        participantId: getParticipantId(),
        token: getToken(),
        targetId,
        trackSid: micPub.trackSid,
        muted: nowMuted,
      }),
    });
  } catch (err) {
    console.error('[mute]', err);
  }
}

// ---- Wire DOM ----

export function initConference(): void {
  document.getElementById('cam-btn')?.addEventListener('click', toggleCamera);
  document.getElementById('mic-btn')?.addEventListener('click', toggleMic);
  document.getElementById('screen-btn')?.addEventListener('click', toggleScreenShare);

  document.getElementById('layout-btn')?.addEventListener('click', () => {
    if (viewerStore.get().mode !== 'call') return;
    const next = viewerStore.get().layout === 'grid' ? 'presenter' : 'grid';
    setCallLayout(next);
    // If a share is active, remember the user's choice so auto-switch
    // doesn't clobber it until the share ends.
    if (activeScreenShareTrack) viewerStore.set({ layoutOverride: true });
  });

  document.getElementById('prompt-both')?.addEventListener('click', () => void applyConfPref('both'));
  document.getElementById('prompt-mic')?.addEventListener('click', () => void applyConfPref('mic'));
  document.getElementById('prompt-skip')?.addEventListener('click', () => void applyConfPref('none'));

  document.getElementById('device-btn')?.addEventListener('click', () => void openDevicePicker());
  document.getElementById('device-picker-close')?.addEventListener('click', () => {
    document.getElementById('device-picker-overlay')?.classList.add('hidden');
  });
  document.getElementById('device-picker-overlay')?.addEventListener('click', (e) => {
    const overlay = document.getElementById('device-picker-overlay');
    if (e.target === overlay) overlay?.classList.add('hidden');
  });
  document.getElementById('device-camera')?.addEventListener('change', async (e) => {
    if (!livekitRoom) return;
    try {
      await livekitRoom.switchActiveDevice('videoinput', (e.target as HTMLSelectElement).value);
      updateSelfTile();
    } catch (err) {
      console.error('[device switch cam]', err);
    }
  });
  document.getElementById('device-mic')?.addEventListener('change', async (e) => {
    if (!livekitRoom) return;
    try {
      await livekitRoom.switchActiveDevice('audioinput', (e.target as HTMLSelectElement).value);
      updateSelfTile();
    } catch (err) {
      console.error('[device switch mic]', err);
    }
  });
  document.getElementById('device-speaker')?.addEventListener('change', async (e) => {
    if (!livekitRoom) return;
    try {
      await livekitRoom.switchActiveDevice('audiooutput', (e.target as HTMLSelectElement).value);
    } catch (err) {
      console.error('[device switch speaker]', err);
    }
  });

  // Presenter moderation, delegated at #app level — tiles live in #left-panel
  // in broadcast mode and #call-grid in call mode. One listener handles both.
  document.getElementById('app')?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (!btn || viewerStore.get().role !== 'presenter') return;
    const action = btn.dataset['action'];
    const identity = btn.dataset['identity'];
    if (!identity) return;
    if (action === 'presenter-kick') {
      e.stopPropagation();
      void presenterKick(identity);
    } else if (action === 'presenter-mute') {
      e.stopPropagation();
      void presenterMute(identity);
    }
  });
}
