// Panel toggles, stage grid sizing, fullscreen.
// Mobile-Safari resize listeners (visualViewport) live here too.

import { viewerStore } from './state.js';

// Compute the optimal column count for the stage grid so 16:9 tiles fill
// the container as efficiently as possible without overflowing. Skipped
// when the stage is in focus sub-layout (CSS handles that case).
// In focus mode the pinned stream/share tile is constrained to the content
// aspect ratio (--focus-aspect, set by conference.updateFocusAspect). CSS
// can't know whether the grid cell is wider or taller than that ratio, so
// pick the limiting axis here: choose which dimension is 100% and let the
// other follow aspect-ratio. Without this the tile letterboxes (or
// pillarboxes) inside its own cell instead of hugging the image.
function fitFocusedTile(stage: HTMLElement): void {
  const tile = stage.querySelector<HTMLElement>(
    '#tile-stream[data-focused], #tile-share[data-focused]',
  );
  if (!tile) return;
  const cs = getComputedStyle(stage);
  const px = (s: string): number[] =>
    s
      .split(' ')
      .map((v) => parseFloat(v))
      .filter((v) => !Number.isNaN(v));
  const cols = px(cs.gridTemplateColumns);
  const rows = px(cs.gridTemplateRows);
  // The focused tile sits in the last column (desktop: rail | tile) and
  // last row (mobile: rail row, then tile row).
  const cellW = cols.length ? cols[cols.length - 1]! : stage.clientWidth;
  const cellH = rows.length ? rows[rows.length - 1]! : stage.clientHeight;
  if (!(cellW > 0) || !(cellH > 0)) return;

  let contentAspect = 16 / 9;
  const raw = getComputedStyle(tile).getPropertyValue('--focus-aspect').trim();
  if (raw) {
    const [a, b] = raw.split('/').map((v) => parseFloat(v));
    if (a && b && a > 0 && b > 0) contentAspect = a / b;
  }
  const widthLimited = cellW / cellH < contentAspect;
  tile.classList.toggle('focus-fit-w', widthLimited);
  tile.classList.toggle('focus-fit-h', !widthLimited);
}

export function sizeStage(): void {
  const stage = document.getElementById('stage');
  if (!stage) return;
  if (document.body.classList.contains('has-focus')) {
    stage.style.gridTemplateColumns = '';
    fitFocusedTile(stage);
    return;
  }
  // Visible tiles only — hidden #tile-stream / #tile-share don't take grid cells.
  const tiles = Array.from(stage.querySelectorAll<HTMLElement>(':scope > .tile')).filter(
    (el) => !el.classList.contains('hidden') && el.offsetParent !== null,
  );
  const n = tiles.length;
  if (n === 0) {
    stage.style.gridTemplateColumns = '';
    return;
  }
  const gap = 8;
  const pad = 16;
  const cw = stage.clientWidth - pad;
  const ch = stage.clientHeight - pad;
  const RATIO = 16 / 9;
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
  const colW = (cw - gap * (bestCols - 1)) / bestCols;
  if (bestTileW < colW - 1) {
    stage.style.gridTemplateColumns = `repeat(${bestCols}, ${Math.floor(bestTileW)}px)`;
  } else {
    stage.style.gridTemplateColumns = `repeat(${bestCols}, 1fr)`;
  }
}

export function toggleChat(): void {
  const next = !viewerStore.get().chatOpen;
  viewerStore.set({ chatOpen: next });
  document.getElementById('right-panel')?.classList.toggle('open', next);
  document.getElementById('chat-toggle')?.classList.toggle('panel-open', next);
  if (next) document.getElementById('chat-toggle')?.classList.remove('has-notification');
  requestAnimationFrame(sizeStage);
}

export function toggleConf(): void {
  // In the unified stage model, the "rail" is the focus-mode side strip.
  // The Participants toggle button now shows/hides that rail; when not in
  // focus mode it's a no-op (the CSS hides the button via body.no-rail).
  const next = !viewerStore.get().confOpen;
  viewerStore.set({ confOpen: next });
  document.body.classList.toggle('rail-hidden', !next);
  document.getElementById('conf-toggle')?.classList.toggle('panel-open', next);
  requestAnimationFrame(sizeStage);
}

function setupFullscreen(): void {
  const btn = document.getElementById('fullscreen-btn');
  btn?.addEventListener('click', () => {
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsEl) {
      (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
      return;
    }
    // Fullscreen the focused tile if there is one, otherwise the whole stage.
    const focused = document.querySelector<HTMLElement>('#stage > .tile[data-focused]');
    const target = focused || document.getElementById('stage');
    if (!target) return;
    if (target.requestFullscreen) {
      void target.requestFullscreen();
    } else if (target.webkitRequestFullscreen) {
      target.webkitRequestFullscreen();
    } else {
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

  setupFullscreen();

  window.addEventListener('resize', sizeStage);
  screen.orientation?.addEventListener('change', () => {
    sizeStage();
    for (const ms of [50, 150, 300, 500]) setTimeout(sizeStage, ms);
  });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', sizeStage);
  }
}
