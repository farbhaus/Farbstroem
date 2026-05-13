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
  const rect = overlay.getBoundingClientRect();
  entry.el.style.left = x * rect.width + 'px';
  entry.el.style.top = y * rect.height + 'px';
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

function togglePointer(): void {
  const next = !viewerStore.get().pointerMode;
  viewerStore.set({ pointerMode: next });
  document.getElementById('pointer-btn')?.classList.toggle('active', next);
  const overlay = pOverlay();
  overlay.classList.toggle('active', next);
  overlay.style.cursor = next ? pointerCursorUrl() : '';
  if (!next) sendFn?.({ type: 'pointer:hide' });
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
  const x = (cx - rect.left) / rect.width;
  const y = (cy - rect.top) / rect.height;
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
