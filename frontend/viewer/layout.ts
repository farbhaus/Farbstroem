// Panel toggles, 16:9 player sizing, call-grid sizing, fullscreen.
// Mobile-Safari resize listeners (visualViewport) live here too.

import { viewerStore } from './state.js';

export function sizePlayer(): void {
  const area = document.getElementById('center-area');
  const wrap = document.getElementById('player-wrap');
  if (!area || !wrap) return;
  const aw = area.clientWidth;
  const ah = area.clientHeight;
  let w = aw;
  let h = Math.round((aw * 9) / 16);
  if (h > ah) {
    h = ah;
    w = Math.round((ah * 16) / 9);
  }
  wrap.style.width = w + 'px';
  wrap.style.height = h + 'px';
}

// Compute the optimal column count for the call grid so 3:2 tiles fill the
// container as efficiently as possible without overflowing.
export function sizeCallGrid(): void {
  const grid = document.getElementById('call-grid');
  if (!grid || !document.body.classList.contains('mode-call')) return;
  if (document.body.classList.contains('call-layout-presenter')) {
    grid.style.gridTemplateColumns = '';
    return;
  }
  const tiles = grid.querySelectorAll('.conf-tile');
  const n = tiles.length;
  if (n === 0) {
    grid.style.gridTemplateColumns = '';
    return;
  }
  const gap = 8;
  const pad = 16;
  const cw = grid.clientWidth - pad;
  const ch = grid.clientHeight - pad;
  const RATIO = 3 / 2;
  let bestCols = 1;
  let bestArea = 0;
  let bestTileW = cw;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const tw = (cw - gap * (cols - 1)) / cols;
    const th = (ch - gap * (rows - 1)) / rows;
    const tileH = Math.min(th, tw / RATIO);
    const tileW = tileH * RATIO;
    const area = tileW * tileH;
    if (area > bestArea) {
      bestArea = area;
      bestCols = cols;
      bestTileW = tileW;
    }
  }
  // When height is the binding constraint the tiles must be narrower than
  // a full 1fr column — set explicit pixel widths so aspect-ratio doesn't
  // push them past the row height and cause overlap.
  const colW = (cw - gap * (bestCols - 1)) / bestCols;
  if (bestTileW < colW - 1) {
    grid.style.gridTemplateColumns = `repeat(${bestCols}, ${Math.floor(bestTileW)}px)`;
  } else {
    grid.style.gridTemplateColumns = `repeat(${bestCols}, 1fr)`;
  }
}

// Continuously resize the player during CSS transition so it stays in sync.
function sizePlayerDuringTransition(): void {
  let start: number | null = null;
  function step(ts: number): void {
    if (!start) start = ts;
    sizePlayer();
    if (ts - start < 300) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

export function toggleChat(): void {
  const next = !viewerStore.get().chatOpen;
  viewerStore.set({ chatOpen: next });
  document.getElementById('right-panel')?.classList.toggle('open', next);
  document.getElementById('chat-toggle')?.classList.toggle('panel-open', next);
  if (next) document.getElementById('chat-toggle')?.classList.remove('has-notification');
  if (next && viewerStore.get().confOpen) toggleConf();
  sizePlayerDuringTransition();
}

export function toggleConf(): void {
  const next = !viewerStore.get().confOpen;
  viewerStore.set({ confOpen: next });
  document.getElementById('left-panel')?.classList.toggle('open', next);
  document.getElementById('conf-toggle')?.classList.toggle('panel-open', next);
  if (next && viewerStore.get().chatOpen) toggleChat();
  sizePlayerDuringTransition();
}

function setupFullscreen(): void {
  const btn = document.getElementById('fullscreen-btn');
  btn?.addEventListener('click', () => {
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsEl) {
      (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
      return;
    }
    const target = document.getElementById('center-area');
    if (!target) return;
    if (target.requestFullscreen) {
      void target.requestFullscreen();
    } else if (target.webkitRequestFullscreen) {
      target.webkitRequestFullscreen();
    } else {
      // iPhone: only video element supports fullscreen
      const video = document.querySelector<HTMLVideoElement>('#player video');
      if (video?.webkitEnterFullscreen) video.webkitEnterFullscreen();
    }
  });
  const onFsChange = (): void => {
    btn?.classList.toggle(
      'active',
      !!(document.fullscreenElement || document.webkitFullscreenElement),
    );
  };
  document.addEventListener('fullscreenchange', onFsChange);
  document.addEventListener('webkitfullscreenchange', onFsChange);
}

export function initLayout(): void {
  document.getElementById('chat-toggle')?.addEventListener('click', toggleChat);
  document.getElementById('chat-close')?.addEventListener('click', () => {
    if (viewerStore.get().chatOpen) toggleChat();
  });
  document.getElementById('conf-toggle')?.addEventListener('click', toggleConf);
  document.getElementById('conf-close')?.addEventListener('click', () => {
    if (viewerStore.get().confOpen) toggleConf();
  });

  setupFullscreen();

  window.addEventListener('resize', () => {
    sizePlayer();
    sizeCallGrid();
  });
  screen.orientation?.addEventListener('change', () => {
    sizePlayer();
    sizeCallGrid();
    // iOS rotation animation takes ~300ms; re-measure throughout
    for (const ms of [50, 150, 300, 500]) setTimeout(sizePlayer, ms);
  });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', sizePlayer);
  }
}
