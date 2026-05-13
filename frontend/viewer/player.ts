// OvenPlayer lifecycle: instantiate on broadcast-mode rooms, retry on error,
// keep play/pause/mute/volume controls in sync. Call mode never instantiates
// the player.

import { viewerStore } from './state.js';
let player: OvenPlayerInstance | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let offlineTimer: ReturnType<typeof setTimeout> | null = null;

let onPlayingChange: () => void = () => {};

export function configurePlayer(opts: { onPlayingChange: () => void }): void {
  onPlayingChange = opts.onPlayingChange;
}

export function getPlayer(): OvenPlayerInstance | null {
  return player;
}

export function destroyPlayer(): void {
  if (retryTimer) clearTimeout(retryTimer);
  if (offlineTimer) clearTimeout(offlineTimer);
  retryTimer = null;
  offlineTimer = null;
  if (player) {
    try {
      player.remove();
    } catch {}
    player = null;
  }
}

export function reloadPlayer(): void {
  if (retryTimer) clearTimeout(retryTimer);
  if (offlineTimer) clearTimeout(offlineTimer);
  if (!player) {
    initPlayer();
    return;
  }
  try {
    if (player.getState() === 'playing') return;
    player.load();
  } catch {
    destroyPlayer();
    initPlayer();
  }
}

export function initPlayer(): void {
  if (player) return;
  const { deliveryMode, streamKey } = viewerStore.get();
  // No stream key → there's nothing to play. OvenPlayer stays unmounted.
  if (!streamKey) return;

  const host = location.host;
  const proto = location.protocol === 'https:' ? 'https' : 'http';
  const wsproto = location.protocol === 'https:' ? 'wss' : 'ws';
  const sources =
    deliveryMode === 'llhls'
      ? [{ type: 'll-hls', file: `${proto}://${host}/live/${streamKey}/llhls.m3u8` }]
      : [{ type: 'webrtc', file: `${wsproto}://${host}/live/${streamKey}` }];

  player = OvenPlayer.create('player', {
    autoStart: true,
    autoFallback: false,
    mute: true,
    sources,
    parseStream: { enabled: true },
    webrtcConfig: { timeoutMaxRetry: 3, connectionTimeout: 8000 },
    hlsConfig: { liveSyncDuration: 1, liveMaxLatencyDuration: 2, maxLiveSyncPlaybackRate: 1 },
  });

  enablePlayerControls(true);
  syncPlayerControls();

  player.on('stateChanged', (e) => {
    syncPlayerControls();
    if (!player) return;
    if (e?.newstate === 'playing') {
      if (offlineTimer) clearTimeout(offlineTimer);
      onPlayingChange();
    } else if (e?.newstate === 'error') {
      if (offlineTimer) clearTimeout(offlineTimer);
      const status = viewerStore.get().status;
      if (status === 'live') {
        // Room is live but player errored — show waiting overlay after 3s
        // if it doesn't recover (covers stream-stop case).
        offlineTimer = setTimeout(() => {
          if (player?.getState() !== 'playing') {
            const offline = document.getElementById('offline-screen');
            const msg = document.getElementById('offline-msg');
            if (msg) msg.textContent = 'Waiting for livestream source...';
            offline?.classList.add('visible');
          }
        }, 3000);
      }
      if (status !== 'ended') {
        retryTimer = setTimeout(reloadPlayer, 8000);
      }
    }
  });

  player.on('mute', () => syncPlayerControls());
  player.on('volumeChanged', () => syncPlayerControls());
}

function enablePlayerControls(on: boolean): void {
  (document.getElementById('play-btn') as HTMLButtonElement).disabled = !on;
  (document.getElementById('mute-btn') as HTMLButtonElement).disabled = !on;
  (document.getElementById('volume-slider') as HTMLInputElement).disabled = !on;
}

function syncPlayerControls(): void {
  if (!player) return;
  const playing = player.getState() === 'playing';
  const iconPlay = document.getElementById('icon-play');
  const iconPause = document.getElementById('icon-pause');
  if (iconPlay) iconPlay.style.display = playing ? 'none' : '';
  if (iconPause) iconPause.style.display = playing ? '' : 'none';

  const muted = player.getMute();
  const iconVol = document.getElementById('icon-vol');
  const iconMuted = document.getElementById('icon-muted');
  if (iconVol) iconVol.style.display = muted ? 'none' : '';
  if (iconMuted) iconMuted.style.display = muted ? '' : 'none';
  const muteBtn = document.getElementById('mute-btn');
  muteBtn?.classList.toggle('muted', muted);
  if (muteBtn) muteBtn.title = muted ? 'Unmute' : 'Mute';

  const slider = document.getElementById('volume-slider') as HTMLInputElement;
  slider.value = String(player.getVolume());
}

export function initPlayerControls(): void {
  document.getElementById('play-btn')?.addEventListener('click', () => {
    if (!player) return;
    if (player.getState() === 'playing') player.pause();
    else player.play();
  });
  document.getElementById('mute-btn')?.addEventListener('click', () => {
    if (!player) return;
    player.setMute(!player.getMute());
  });
  document.getElementById('volume-slider')?.addEventListener('input', (e) => {
    if (!player) return;
    const vol = parseInt((e.target as HTMLInputElement).value, 10);
    if (player.getMute() && vol > 0) player.setMute(false);
    player.setVolume(vol);
    syncPlayerControls();
  });
  document.getElementById('resync-btn')?.addEventListener('click', () => {
    destroyPlayer();
    initPlayer();
  });
}
