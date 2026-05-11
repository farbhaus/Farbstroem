// Viewer bootstrap. Stitches the modules together and runs init order.

import { applyBranding } from '../shared/branding.js';
import { configureChat, initChat } from './chat.js';
import {
  initConference,
  refreshConfButtons,
  setCallLayout,
  showConfPrompt,
  syncConferenceTiles,
  disconnectLiveKit,
} from './conference.js';
import { initLayout, sizePlayer } from './layout.js';
import { destroyPlayer, initPlayer, initPlayerControls, configurePlayer, reloadPlayer } from './player.js';
import { configurePointer, initPointer } from './pointer.js';
import {
  configureJoinOutcome,
  configureScreens,
  doJoin,
  initJoinForm,
  initLandingForm,
  loadRoomInfo,
  pollAdmission,
  showEnded,
  showJoin,
  showKicked,
  showLanding,
  showLeft,
  showWaitingScreen,
  stopAdmissionPoll,
  type RoomInfoOutcome,
} from './screens.js';
import { consumePresession, isPresenter, slug, updateSavedStreamKey } from './session.js';
import { getState, setState, viewerStore } from './state.js';
import type { RoomStatus } from './types.js';
import {
  closeWs,
  configureWs,
  connectWs,
  startKickedPoller,
  stopKickedPoller,
  wsSend,
} from './ws.js';

// ---- Room status side effects ----

function setRoomStatus(status: RoomStatus, playerPlaying = false): void {
  setState({ status });
  const offline = document.getElementById('offline-screen');
  const badge = document.getElementById('live-badge');
  const msg = document.getElementById('offline-msg');
  if (!offline || !badge || !msg) return;

  // Determine "actually playing" from the live OvenPlayer state when available.
  const pState = playerPlaying;
  if (status === 'live' && pState) {
    offline.classList.remove('visible');
    badge.classList.add('visible');
  } else if (status === 'live' && !pState) {
    badge.classList.remove('visible');
  } else if (status === 'ended') {
    msg.textContent = 'Session has ended.';
    offline.classList.add('visible');
    badge.classList.remove('visible');
  } else {
    msg.textContent = 'Waiting for livestream source...';
    offline.classList.add('visible');
    badge.classList.remove('visible');
  }
}

// ---- Stream-key transitions ----

function handleStreamAssigned(newKey: string): void {
  updateSavedStreamKey(newKey);
  setState({ streamKey: newKey });
  // A stream was attached while this client was sitting on the
  // "stream ended" overlay — reload the player and dismiss it instead of
  // keeping them stuck.
  const overlay = document.getElementById('stream-removed-overlay');
  if (overlay?.classList.contains('visible')) {
    overlay.classList.remove('visible');
    reloadPlayer();
    return;
  }
  // Call-mode client: prompt refresh so the page boots into broadcast mode
  // with OvenPlayer.
  if (getState().mode === 'call') {
    document.getElementById('stream-assigned-banner')?.classList.add('visible');
  }
}

function handleStreamRemoved(): void {
  updateSavedStreamKey(null);
  setState({ streamKey: null });
  if (getState().mode !== 'broadcast') return;
  destroyPlayer();
  document.getElementById('stream-removed-overlay')?.classList.add('visible');
}

// ---- App show / leave ----

function showApp(initialStatus?: RoomStatus): void {
  stopAdmissionPoll();
  document.getElementById('join-screen')?.classList.add('hidden');
  document.getElementById('waiting-screen')?.classList.add('hidden');
  document.getElementById('app')?.classList.add('visible');

  const roomInfo = getState().roomInfo;
  const label = document.getElementById('room-name-label');
  if (label) label.textContent = roomInfo?.name || slug;

  // Room mode: 'broadcast' (OvenPlayer stage) or 'call' (LiveKit-only grid).
  // Driven by presence of a stream key — no separate flag in the DB.
  const mode = getState().streamKey ? 'broadcast' : 'call';
  setState({ mode });
  document.body.classList.remove('mode-broadcast', 'mode-call');
  document.body.classList.add(`mode-${mode}`);
  if (mode === 'call') setCallLayout('grid');

  setRoomStatus(initialStatus || 'pending');

  requestAnimationFrame(() => {
    sizePlayer();
    initPlayer();
  });
  connectWs();
  showConfPrompt();
}

function leaveRoom(): void {
  stopAdmissionPoll();
  closeWs();
  void disconnectLiveKit();
  destroyPlayer();
  showLeft(getState().roomInfo?.name || slug);
}

function dispatchOutcome(o: RoomInfoOutcome): void {
  switch (o.kind) {
    case 'show-app':
      showApp(o.initialStatus);
      break;
    case 'show-waiting':
      showWaitingScreen(o.waitingName || '');
      pollAdmission();
      break;
    case 'show-kicked':
      showKicked();
      startKickedPoller();
      break;
    case 'show-join':
      showJoin();
      break;
    case 'show-landing':
      showLanding();
      break;
  }
}

// ---- Init ----

function init(): void {
  // Enforce canonical /watch/{slug} URL — redirect anything else.
  if (slug && !location.pathname.startsWith('/watch/')) {
    location.replace('/watch/' + slug + location.search);
    return;
  }

  // Apply branding (logo + colors + bg). Read-only — same as landing.
  void applyBranding({
    bgTarget: document.documentElement,
  }).then((data) => {
    if (data?.hasLogo) {
      document.querySelectorAll<HTMLImageElement>('.screen-logo, .brand-logo').forEach((img) => {
        img.src = '/api/branding/logo';
      });
    }
    if (data?.hasBg) {
      document.body.style.background = 'transparent';
    }
  });

  // Wire all subsystems.
  configureChat({ send: wsSend });
  configurePointer({ send: wsSend });
  configurePlayer({
    onPlayingChange: () => setRoomStatus('live', true),
  });
  configureWs({
    onAuthOk: () => {},
    onRoomLive: () => setRoomStatus('live'),
    onRoomPending: () => setRoomStatus('pending'),
    onRoomEnded: () => showEnded(),
    onStreamAssigned: handleStreamAssigned,
    onStreamRemoved: handleStreamRemoved,
    onKicked: () => {
      document.getElementById('app')?.classList.remove('visible');
      showKicked();
    },
  });
  configureScreens({
    onAdmitted: () => showApp(),
  });
  configureJoinOutcome(dispatchOutcome);

  // DOM listeners.
  initLayout();
  initPlayerControls();
  initPointer();
  initChat();
  initConference();
  initLandingForm();
  initJoinForm();

  document.getElementById('leave-btn')?.addEventListener('click', leaveRoom);
  document.getElementById('left-rejoin-btn')?.addEventListener('click', () => location.reload());
  document.getElementById('stream-assigned-refresh')?.addEventListener('click', () => location.reload());

  // Subscribe: keep `participant-num` and tile sync responsive to roster changes.
  // (ws.ts already triggers syncConferenceTiles on roster updates; subscribing
  // here is a no-op safety net for any other state-driven re-renders.)
  viewerStore.subscribe((s) => {
    refreshConfButtons();
    void s; // touched intentionally so future state hooks are easy
  });

  // Boot.
  if (!slug) {
    showLanding();
    return;
  }

  consumePresession();
  void loadRoomInfo().then(dispatchOutcome);
}

// Avoid unused-import warning while we keep the syncConferenceTiles export
// available to other modules. (ws.ts uses it directly via import.)
void syncConferenceTiles;
void isPresenter;
void stopKickedPoller;

init();
