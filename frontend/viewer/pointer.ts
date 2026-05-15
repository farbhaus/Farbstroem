// Pointer overlay: shows other participants' cursors, sends our own (when
// pointer mode is on) over the WebSocket. 33ms send throttle prevents
// 60fps mousemove spam.

import { esc } from '../shared/utils.js';
import { getParticipantId } from './session.js';
import { viewerStore } from './state.js';
import type { WsClientMessage } from './types.js';

const POINTER_COLORS = [
  '#FF3030', // red
  '#00C853', // green
  '#2979FF', // blue
  '#FFD600', // yellow
  '#D500F9', // magenta
  '#FF6D00', // orange
  '#00E5FF', // cyan
  '#FF4081', // pink
  '#76FF03', // lime
  '#651FFF', // purple
];

interface CursorEntry {
  el: HTMLElement;
  fadeTimer: ReturnType<typeof setTimeout> | null;
}

const cursors = new Map<string, CursorEntry>();
let throttleTimer: ReturnType<typeof setTimeout> | null = null;

let sendFn: ((msg: WsClientMessage) => void) | null = null;

export function configurePointer(opts: { send: (msg: WsClientMessage) => void }): void {
  sendFn = opts.send;
}

export function getPointerColor(pid: string): string {
  let h = 0;
  for (let i = 0; i < pid.length; i++) {
    h = Math.imul(h ^ pid.charCodeAt(i), 2654435761);
  }
  return POINTER_COLORS[(h >>> 0) % POINTER_COLORS.length]!;
}

function pOverlay(): HTMLElement {
  return document.getElementById('pointer-overlay')!;
}

// The video is rendered object-fit:contain, so it's letterboxed/pillarboxed
// differently per device. Coordinates must be relative to the visible video
// IMAGE, not the tile box, otherwise the same image point maps to different
// normalized values across devices.
//
// The reference is a fixed-aspect rectangle letterboxed inside the overlay
// box. Using the stream's real aspect ratio once it's known, otherwise a
// 16:9 default — NEVER the raw tile box, whose aspect varies per device and
// when offline (no <video> at all). Every client computes the same
// proportional sub-rectangle, so a normalized (x, y) lands on the same
// logical point everywhere, stream live or not.
const DEFAULT_ASPECT = 16 / 9;
let cachedAspect = 0; // videoWidth / videoHeight of the live stream, when seen

function streamAspect(): number {
  const vids = document.querySelectorAll<HTMLVideoElement>('#player video');
  for (const v of Array.from(vids)) {
    if (v.videoWidth > 0 && v.videoHeight > 0) {
      cachedAspect = v.videoWidth / v.videoHeight;
    }
  }
  return cachedAspect || DEFAULT_ASPECT;
}

// Returns the reference image rect in overlay-local coordinates.
function videoContentRect(overlay: HTMLElement): {
  left: number;
  top: number;
  width: number;
  height: number;
} {
  const R = overlay.getBoundingClientRect();
  if (R.width === 0 || R.height === 0) {
    return { left: 0, top: 0, width: R.width, height: R.height };
  }
  const a = streamAspect();
  const boxAspect = R.width / R.height;
  let cw: number;
  let ch: number;
  if (boxAspect > a) {
    ch = R.height;
    cw = ch * a;
  } else {
    cw = R.width;
    ch = cw / a;
  }
  return { left: (R.width - cw) / 2, top: (R.height - ch) / 2, width: cw, height: ch };
}

export function renderPointer(pid: string, name: string, x: number, y: number): void {
  const overlay = pOverlay();
  let entry = cursors.get(pid);
  if (!entry) {
    const el = document.createElement('div');
    el.className = 'remote-pointer';
    const color = getPointerColor(pid);
    el.innerHTML =
      `<div class="remote-pointer-dot"><svg viewBox="0 0 24 24" fill="${color}"><path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/><path d="M13 13l6 6" stroke-linecap="round"/></svg></div>` +
      `<div class="remote-pointer-label" style="background:${color}">${esc(name)}</div>`;
    overlay.appendChild(el);
    entry = { el, fadeTimer: null };
    cursors.set(pid, entry);
  }
  const c = videoContentRect(overlay);
  entry.el.style.left = c.left + x * c.width + 'px';
  entry.el.style.top = c.top + y * c.height + 'px';
  entry.el.classList.remove('faded');
  if (entry.fadeTimer) clearTimeout(entry.fadeTimer);
  entry.fadeTimer = setTimeout(() => entry!.el.classList.add('faded'), 3000);
}

export function hidePointer(pid: string): void {
  const entry = cursors.get(pid);
  if (!entry) return;
  if (entry.fadeTimer) clearTimeout(entry.fadeTimer);
  entry.el.remove();
  cursors.delete(pid);
}

export function clearAllPointers(): void {
  for (const pid of cursors.keys()) hidePointer(pid);
}

// Drop pointer entries for participants no longer in the roster. Called
// from the WS roster-update handler.
export function pruneCursorsToRoster(currentPids: Set<string>): void {
  for (const pid of cursors.keys()) {
    if (!currentPids.has(pid)) hidePointer(pid);
  }
}

function pointerCursorUrl(): string {
  const color = getPointerColor(getParticipantId() || 'me');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" fill="${color}" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"><path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/><path d="M13 13l6 6" stroke-linecap="round"/></svg>`;
  return `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}") 2 2, crosshair`;
}

// Turn pointer mode off. Idempotent — safe to call when already off.
// Called on layout change (the overlay only lives on the stream tile, so
// any non-stream-focused layout makes it stale) and from togglePointer.
export function disablePointerMode(): void {
  if (!viewerStore.get().pointerMode) return;
  viewerStore.set({ pointerMode: false });
  document.getElementById('pointer-btn')?.classList.remove('active');
  const overlay = pOverlay();
  overlay.classList.remove('active');
  overlay.style.cursor = '';
  sendFn?.({ type: 'pointer:hide' });
}

function togglePointer(): void {
  if (viewerStore.get().pointerMode) {
    disablePointerMode();
    return;
  }
  viewerStore.set({ pointerMode: true });
  document.getElementById('pointer-btn')?.classList.add('active');
  const overlay = pOverlay();
  overlay.classList.add('active');
  overlay.style.cursor = pointerCursorUrl();
}

function sendMove(cx: number, cy: number): void {
  const { pointerMode } = viewerStore.get();
  if (!pointerMode || !sendFn) return;
  if (throttleTimer) return;
  throttleTimer = setTimeout(() => {
    throttleTimer = null;
  }, 33);
  const overlay = pOverlay();
  const rect = overlay.getBoundingClientRect();
  const c = videoContentRect(overlay);
  const x = (cx - rect.left - c.left) / c.width;
  const y = (cy - rect.top - c.top) / c.height;
  // Cursor is over a letterbox bar (outside the image) — don't send.
  if (x < 0 || x > 1 || y < 0 || y > 1) return;
  sendFn({ type: 'pointer:move', x, y });
}

function sendHide(): void {
  if (sendFn) sendFn({ type: 'pointer:hide' });
}

export function initPointer(): void {
  document.getElementById('pointer-btn')?.addEventListener('click', togglePointer);

  const overlay = pOverlay();
  overlay.addEventListener('mousemove', (e) => sendMove(e.clientX, e.clientY));
  overlay.addEventListener('mouseleave', () => {
    if (viewerStore.get().pointerMode) sendHide();
  });
  overlay.addEventListener(
    'touchmove',
    (e) => {
      if (!viewerStore.get().pointerMode) return;
      e.preventDefault();
      const t = e.touches[0];
      if (t) sendMove(t.clientX, t.clientY);
    },
    { passive: false },
  );
  overlay.addEventListener('touchend', () => {
    if (viewerStore.get().pointerMode) sendHide();
  });
}
