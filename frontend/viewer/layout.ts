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
  // The focused tile sits in the last column (desktop: strip | tile) and
  // last row (mobile: strip row, then tile row).
  const cellW = cols.length ? cols[cols.length - 1]! : stage.clientWidth;
  const cellH = rows.length ? rows[rows.length - 1]! : stage.clientHeight;
  if (!(cellW > 0) || !(cellH > 0)) return;
  const contentAspect = readFocusAspect(tile);
  const widthLimited = cellW / cellH < contentAspect;
  tile.classList.toggle('focus-fit-w', widthLimited);
  tile.classList.toggle('focus-fit-h', !widthLimited);
}

// In focus mode the player is height-limited and centres in its grid cell,
// leaving grey leftover space on either side. Absorb that leftover into
// the chat panel and the side strip (issue #125 originally for chat;
// issue #151 extends it to the strip) so the gap between player and the
// neighbouring panels stays constant.
//
// Strategy: chat absorbs first up to --panel-w-max, then any residual
// goes to the strip up to --strip-w-max.
//
// Target widths are computed from #main-row dimensions plus the discrete
// --strip-w / .strip-hidden state — NOT from computed grid columns,
// because those return interpolated values during the strip's CSS
// transition. Reading interpolated values caused the chat target to
// chase a moving cellW each tick, restarting chat's own width transition
// and making the player resize mid-animation.
// Mobile breakpoint. Must stay in sync with the `@media (max-width: 700px)`
// rules in www/viewer/index.html (and the shared 700px breakpoint documented in
// www/shared/tokens.css).
const MOBILE_BP = 700;
const STAGE_PAD = 16; // 8px on each side
const COL_GAP = 8;
const CHAT_MARGIN_R = 8;
function sizeFocusPanels(stage: HTMLElement): void {
  const panel = document.getElementById('right-panel');
  const focus = document.body.classList.contains('has-focus');
  const desktop = window.innerWidth > MOBILE_BP;
  if (!focus || !desktop) {
    if (panel) panel.style.width = '';
    stage.style.gridTemplateColumns = '';
    return;
  }
  const tile = focusedTile(stage);
  const mainRow = stage.parentElement;
  if (!tile || !mainRow) {
    if (panel) panel.style.width = '';
    stage.style.gridTemplateColumns = '';
    return;
  }

  const open = !!panel?.classList.contains('open');
  const root = getComputedStyle(document.documentElement);
  const chatBase = parseFloat(root.getPropertyValue('--panel-w')) || 320;
  const chatMax = parseFloat(root.getPropertyValue('--panel-w-max')) || 560;
  const stripBase = parseFloat(root.getPropertyValue('--strip-w')) || 220;
  const stripMin = parseFloat(root.getPropertyValue('--strip-w-min')) || 180;
  const stripMax = parseFloat(root.getPropertyValue('--strip-w-max')) || 360;
  const stripHidden = document.body.classList.contains('strip-hidden');
  // When the strip is hidden the CSS also collapses the column gap to 0
  // (see `body.has-focus.strip-hidden #stage`), so drop it here too.
  const strip = stripHidden ? 0 : stripBase;
  const colGap = stripHidden ? 0 : COL_GAP;
  // When chat is closed the right panel collapses out of flow.
  const chatW = open ? chatBase : 0;
  const chatMarginR = open ? CHAT_MARGIN_R : 0;

  // Final cell width assuming both panels sit at their base widths —
  // independent of any in-flight transitions.
  const mainW = mainRow.clientWidth;
  const finalCellW = mainW - chatW - chatMarginR - STAGE_PAD - strip - colGap;
  // Stage vertical sizing isn't affected by horizontal transitions, so
  // clientHeight is stable.
  const cellH = stage.clientHeight - STAGE_PAD;
  if (!(finalCellW > 0) || !(cellH > 0)) {
    if (panel) panel.style.width = '';
    stage.style.gridTemplateColumns = '';
    return;
  }

  const aspect = readFocusAspect(tile);
  const playerW = cellH * aspect;
  // Signed leftover relative to bases. Positive = room to grow; negative =
  // we need to *narrow* the strip below its base to keep the tile at full
  // height.
  const leftover = finalCellW - playerW;

  let chatExtra = 0;
  let stripExtra = 0;
  if (leftover >= 0) {
    // Plenty of room: chat absorbs first, strip absorbs residual.
    chatExtra = open ? Math.min(chatMax - chatBase, leftover) : 0;
    stripExtra = stripHidden
      ? 0
      : Math.min(stripMax - stripBase, leftover - chatExtra);
  } else if (!stripHidden) {
    // Tight: chat stays at its base; auto-narrow the strip (down to
    // --strip-w-min) so the player tile keeps its height-limited size.
    stripExtra = Math.max(-(stripBase - stripMin), leftover);
  }

  if (panel) {
    panel.style.width = open ? `${Math.round(chatBase + chatExtra)}px` : '';
  }
  // Leave .strip-hidden to its CSS rule (collapses to `0 1fr`).
  if (stripHidden || stripExtra === 0) {
    stage.style.gridTemplateColumns = '';
  } else {
    stage.style.gridTemplateColumns = `${Math.round(stripBase + stripExtra)}px 1fr`;
  }
}

export function sizeStage(): void {
  const stage = document.getElementById('stage');
  if (!stage) return;
  if (document.body.classList.contains('has-focus')) {
    // Grid mode sets an inline grid-template-columns (repeat(...)); an inline
    // style outranks the focus-mode stylesheet rule, so leaving it set would
    // override `var(--strip-w) 1fr` and make the strip + focused tile collide.
    // Clear it so the focus / strip-hidden CSS governs (grid mode re-sets it).
    stage.style.gridTemplateColumns = '';
    sizeFocusPanels(stage);
    fitFocusedTile(stage);
    return;
  }
  sizeFocusPanels(stage);
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

// The chat panel / focus strip animate their width over ~0.25s. sizeStage()
// (and its fitFocusedTile axis pick) must be re-run *every frame* through that
// window, not at a few discrete points — otherwise the wrong limiting axis
// stays active between ticks and max-width/height clamps the focused tile to a
// non-16:9 box, the letterbox/pillarbox that "sticks" to the moving cell until
// the next tick. sizeFocusPanels() computes its targets from stable #main-row
// dims, so re-asserting them each frame doesn't restart the panel's own
// transition.
const PANEL_TRANSITION_MS = 320; // a touch over the 0.25s CSS transition
let panelReflowUntil = 0;
function reflowDuringPanelTransition(): void {
  const alreadyTicking = panelReflowUntil > performance.now();
  panelReflowUntil = performance.now() + PANEL_TRANSITION_MS;
  if (alreadyTicking) return; // running loop will honour the extended deadline
  const tick = (): void => {
    sizeStage();
    if (performance.now() < panelReflowUntil) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

export function toggleChat(): void {
  const next = !viewerStore.get().chatOpen;
  viewerStore.set({ chatOpen: next });
  document.getElementById('right-panel')?.classList.toggle('open', next);
  document.getElementById('chat-toggle')?.classList.toggle('panel-open', next);
  if (next) document.getElementById('chat-toggle')?.classList.remove('has-notification');
  reflowDuringPanelTransition();
}

// Swap the chat panel between its Chat and Files tab panes. Pure DOM state —
// no store field, since nothing outside the panel needs to read it.
export function switchPanelTab(tab: 'chat' | 'files'): void {
  document.querySelectorAll<HTMLElement>('.panel-tab').forEach((b) => {
    b.classList.toggle('is-active', b.dataset['tab'] === tab);
  });
  document.querySelectorAll<HTMLElement>('.tab-pane').forEach((p) => {
    p.hidden = p.dataset['tab'] !== tab;
  });
  if (tab === 'files') {
    document.getElementById('tab-files')?.classList.remove('has-notification');
  }
}

export function toggleConf(): void {
  // In the unified stage model, the "strip" is the focus-mode side strip.
  // The Participants toggle button now shows/hides that strip; when not in
  // focus mode it's a no-op (the CSS hides the button via body.no-strip).
  const next = !viewerStore.get().confOpen;
  viewerStore.set({ confOpen: next });
  document.body.classList.toggle('strip-hidden', !next);
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

// Mobile landscape splits the bottom toolbar into two vertical side bars
// and folds the top bar's items into them so the player gets the full
// viewport height (#151). DOM-move (not clone) so existing event listeners
// keep working. Original {parent, nextSibling} positions are recorded on
// first move and used to restore when leaving the breakpoint.
type Anchor = { parent: ParentNode; next: Node | null };
const moveAnchors = new Map<Element, Anchor>();

function moveTo(el: Element | null, dest: Element | null): void {
  if (!el || !dest) return;
  if (!moveAnchors.has(el)) {
    moveAnchors.set(el, { parent: el.parentNode!, next: el.nextSibling });
  }
  dest.appendChild(el);
}

function restoreAll(): void {
  // Restore in reverse insert order so nextSibling references resolve
  // correctly even when multiple siblings moved out of the same parent.
  const entries = Array.from(moveAnchors.entries()).reverse();
  for (const [el, a] of entries) {
    if (a.next && a.next.parentNode === a.parent) {
      a.parent.insertBefore(el, a.next);
    } else {
      a.parent.appendChild(el);
    }
  }
  moveAnchors.clear();
}

function makeCluster(): HTMLDivElement {
  const d = document.createElement('div');
  d.className = 'side-cluster';
  return d;
}

function makeSep(): HTMLDivElement {
  const d = document.createElement('div');
  d.className = 'tb-sep';
  return d;
}

// Append a sequence of "logical blocks" to a side-bar cluster, inserting
// tb-sep separators between blocks — mirrors the desktop bottom toolbar's
// group separators.
function appendBlocks(cluster: HTMLDivElement, blocks: (Element | null)[][]): void {
  let first = true;
  for (const block of blocks) {
    const items = block.filter((el): el is Element => !!el);
    if (items.length === 0) continue;
    if (!first) cluster.appendChild(makeSep());
    for (const el of items) moveTo(el, cluster);
    first = false;
  }
}

function applyLandscapeLayout(active: boolean): void {
  const body = document.body;
  if (active === body.classList.contains('landscape-mobile')) return;
  const left = document.getElementById('left-toolbar');
  const right = document.getElementById('right-toolbar');
  if (active && left && right) {
    const camGroup = document.getElementById('cam-btn')?.parentElement ?? null;
    const pointer = document.getElementById('pointer-btn');
    const focusBtn = document.getElementById('focus-btn');
    const confToggle = document.getElementById('conf-toggle');
    const chatToggle = document.getElementById('chat-toggle');
    const playerControls = document.getElementById('player-controls');
    const deviceBtn = document.getElementById('device-btn');
    const resyncBtn = document.getElementById('resync-btn');
    const fullscreenBtn = document.getElementById('fullscreen-btn');
    const wsStatus = document.getElementById('ws-status');
    const participantCount = document.getElementById('participant-count');
    const liveBadge = document.getElementById('live-badge');
    const leaveBtn = document.getElementById('leave-btn');

    // Main control columns. Logical blocks mirror the desktop bottom toolbar's
    // grouping.
    const lCluster = makeCluster();
    appendBlocks(lCluster, [
      [camGroup],                  // media inputs (cam/mic/screen)
      [focusBtn, confToggle],      // layout toggles (focus + strip)
    ]);
    const rCluster = makeCluster();
    appendBlocks(rCluster, [
      [playerControls, resyncBtn, fullscreenBtn], // play/mute + reload + fullscreen
      [chatToggle],                               // chat panel toggle
    ]);

    // Outer lane per bar: status indicator + button(s) on the screen edge. Top
    // items pack up; the bottom button (left: pointer, right: gear) is pinned
    // to the BOTTOM (CSS margin-top:auto) so the notch's mid band — empty
    // between them — tucks in harmlessly (no safe-area reserve needed).
    const lOuter = document.createElement('div');
    lOuter.className = 'side-outer';
    moveTo(wsStatus, lOuter);
    moveTo(participantCount, lOuter);
    moveTo(pointer, lOuter);      // pointer pinned to the bottom

    const rOuter = document.createElement('div');
    rOuter.className = 'side-outer';
    moveTo(liveBadge, rOuter);
    moveTo(leaveBtn, rOuter);
    moveTo(deviceBtn, rOuter);

    // .side-row aligns the outer lane to the top of the control column.
    const lRow = document.createElement('div');
    lRow.className = 'side-row';
    lRow.appendChild(lOuter);
    lRow.appendChild(lCluster);
    left.appendChild(lRow);

    const rRow = document.createElement('div');
    rRow.className = 'side-row';
    rRow.appendChild(rCluster);
    rRow.appendChild(rOuter);
    right.appendChild(rRow);

    body.classList.add('landscape-mobile');
  } else {
    restoreAll();
    // Drop the cluster wrappers — they're disposable; on next entry we
    // build fresh ones.
    if (left) left.replaceChildren();
    if (right) right.replaceChildren();
    body.classList.remove('landscape-mobile');
  }
  // Stage dimensions changed — re-run sizing.
  requestAnimationFrame(sizeStage);
}

function setupLandscapeToolbar(): void {
  const mql = window.matchMedia('(max-height: 440px) and (orientation: landscape)');
  const apply = (): void => applyLandscapeLayout(mql.matches);
  apply();
  // MediaQueryList is the most reliable signal; resize/orientationchange are
  // belt-and-braces for older Safari versions where MQL.change can miss
  // mid-rotation states.
  mql.addEventListener?.('change', apply);
  window.addEventListener('resize', apply);
  screen.orientation?.addEventListener('change', apply);
}

export function initLayout(): void {
  document.getElementById('chat-toggle')?.addEventListener('click', toggleChat);
  document.getElementById('chat-close')?.addEventListener('click', () => {
    if (viewerStore.get().chatOpen) toggleChat();
  });
  document.getElementById('conf-toggle')?.addEventListener('click', toggleConf);
  document.querySelectorAll<HTMLElement>('.panel-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset['tab'];
      if (tab === 'chat' || tab === 'files') switchPanelTab(tab);
    });
  });

  setupFullscreen();
  setupLandscapeToolbar();

  window.addEventListener('resize', sizeStage);
  // iOS animates rotation over ~300ms and reports stale dimensions mid-flight,
  // so re-fit on a delayed cadence after the orientation settles.
  const onRotate = (): void => {
    sizeStage();
    for (const ms of [50, 150, 300, 500]) setTimeout(sizeStage, ms);
  };
  screen.orientation?.addEventListener('change', onRotate);
  window.addEventListener('orientationchange', onRotate);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', sizeStage);
  }
}
