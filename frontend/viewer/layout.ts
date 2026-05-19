// Panel toggles, stage grid sizing, fullscreen.
// Mobile-Safari resize listeners (visualViewport) live here too.

import { getPlayer } from './player.js';
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
function pxList(s: string): number[] {
  return s
    .split(' ')
    .map((v) => parseFloat(v))
    .filter((v) => !Number.isNaN(v));
}

function readFocusAspect(tile: HTMLElement): number {
  const raw = getComputedStyle(tile).getPropertyValue('--focus-aspect').trim();
  if (raw) {
    const [a, b] = raw.split('/').map((v) => parseFloat(v));
    if (a && b && a > 0 && b > 0) return a / b;
  }
  return 16 / 9;
}

function focusedTile(stage: HTMLElement): HTMLElement | null {
  return stage.querySelector<HTMLElement>(
    '#tile-stream[data-focused], #tile-share[data-focused]',
  );
}

function fitFocusedTile(stage: HTMLElement): void {
  const tile = focusedTile(stage);
  if (!tile) return;
  const cs = getComputedStyle(stage);
  const cols = pxList(cs.gridTemplateColumns);
  const rows = pxList(cs.gridTemplateRows);
  // The focused tile sits in the last column (desktop: rail | tile) and
  // last row (mobile: rail row, then tile row).
  const cellW = cols.length ? cols[cols.length - 1]! : stage.clientWidth;
  const cellH = rows.length ? rows[rows.length - 1]! : stage.clientHeight;
  if (!(cellW > 0) || !(cellH > 0)) return;
  const contentAspect = readFocusAspect(tile);
  const widthLimited = cellW / cellH < contentAspect;
  tile.classList.toggle('focus-fit-w', widthLimited);
  tile.classList.toggle('focus-fit-h', !widthLimited);
}

// In focus mode the player is height-limited and centres in its grid cell,
// leaving grey leftover space on either side. Absorb most of that into the
// chat panel so the gap between player and chat is small and roughly
// constant (issue #125). Resets the inline width whenever the conditions
// don't apply, so the CSS default (var(--panel-w)) takes over.
const CHAT_SIDE_GAP = 16; // ~8px gap each side of the player remains
const MOBILE_BP = 640;
function sizeChatPanel(stage: HTMLElement): void {
  const panel = document.getElementById('right-panel');
  if (!panel) return;
  const open = panel.classList.contains('open');
  const focus = document.body.classList.contains('has-focus');
  const desktop = window.innerWidth > MOBILE_BP;
  if (!open || !focus || !desktop) {
    panel.style.width = '';
    return;
  }
  const tile = focusedTile(stage);
  if (!tile) {
    panel.style.width = '';
    return;
  }
  const cs = getComputedStyle(stage);
  const cols = pxList(cs.gridTemplateColumns);
  const rows = pxList(cs.gridTemplateRows);
  const cellW = cols.length ? cols[cols.length - 1]! : stage.clientWidth;
  const cellH = rows.length ? rows[rows.length - 1]! : stage.clientHeight;
  if (!(cellW > 0) || !(cellH > 0)) return;

  const root = getComputedStyle(document.documentElement);
  const base = parseFloat(root.getPropertyValue('--panel-w')) || 360;
  const max = parseFloat(root.getPropertyValue('--panel-w-max')) || 560;

  // Compute leftover as if chat were at its base width — stable regardless
  // of what width we last set, so we don't oscillate when called repeatedly.
  const currentChatW = panel.getBoundingClientRect().width;
  const baseCellW = cellW + (currentChatW - base);
  const aspect = readFocusAspect(tile);
  const playerW = cellH * aspect;
  const leftover = baseCellW - playerW;
  const extra = Math.max(0, Math.min(max - base, leftover - CHAT_SIDE_GAP));
  panel.style.width = `${Math.round(base + extra)}px`;
}

export function sizeStage(): void {
  const stage = document.getElementById('stage');
  if (!stage) return;
  if (document.body.classList.contains('has-focus')) {
    stage.style.gridTemplateColumns = '';
    sizeChatPanel(stage);
    fitFocusedTile(stage);
    return;
  }
  sizeChatPanel(stage);
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

// The chat panel / focus rail animate their width over ~0.25s. sizeStage()
// (and its fitFocusedTile axis pick) must be re-run through that window or
// the focused tile keeps the size it had before the cell finished
// resizing — which shows up as a stale letterbox/pillarbox.
function reflowDuringPanelTransition(): void {
  requestAnimationFrame(sizeStage);
  for (const ms of [60, 150, 280, 420]) setTimeout(sizeStage, ms);
}

export function toggleChat(): void {
  const next = !viewerStore.get().chatOpen;
  viewerStore.set({ chatOpen: next });
  document.getElementById('right-panel')?.classList.toggle('open', next);
  document.getElementById('chat-toggle')?.classList.toggle('panel-open', next);
  if (next) document.getElementById('chat-toggle')?.classList.remove('has-notification');
  reflowDuringPanelTransition();
}

export function toggleConf(): void {
  // In the unified stage model, the "rail" is the focus-mode side strip.
  // The Participants toggle button now shows/hides that rail; when not in
  // focus mode it's a no-op (the CSS hides the button via body.no-rail).
  const next = !viewerStore.get().confOpen;
  viewerStore.set({ confOpen: next });
  document.body.classList.toggle('rail-hidden', !next);
  document.getElementById('conf-toggle')?.classList.toggle('panel-open', next);
  reflowDuringPanelTransition();
}

function setupFullscreen(): void {
  const btn = document.getElementById('fullscreen-btn');
  // iOS pauses the underlying media element when leaving fullscreen. Resume
  // the live player so the stream doesn't sit frozen on a still frame.
  const resumePlayback = (): void => {
    const p = getPlayer();
    if (!p) return;
    const kick = (): void => {
      try {
        if (p.getState() !== 'playing') p.play();
      } catch {}
    };
    kick();
    setTimeout(kick, 300);
  };
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
      // iPhone: only the <video> can go fullscreen, and exiting it doesn't
      // fire document fullscreenchange — resume on its own end event.
      const video = document.querySelector<HTMLVideoElement>('#player video');
      if (video?.webkitEnterFullscreen) {
        video.addEventListener('webkitendfullscreen', resumePlayback, { once: true });
        video.webkitEnterFullscreen();
      }
    }
  });
  const onFsChange = (): void => {
    const inFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
    btn?.classList.toggle('active', inFs);
    if (!inFs) resumePlayback();
    // Layout/aspect can change coming out of fullscreen — re-fit the tile.
    requestAnimationFrame(sizeStage);
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
