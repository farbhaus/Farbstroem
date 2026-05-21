// Slug + URL parameter parsing, presenter-handoff consumption, sessionStorage
// helpers. Most session values are immutable for the page's lifetime once set.

import type { SavedSession } from './types.js';

const path = location.pathname.replace(/^\//, '').split('/').filter(Boolean);
export const slug: string = path[path.length - 1] || '';

const query = new URLSearchParams(location.search);
// Host links carry `role` + `pk` in the URL fragment so the secret never
// hits the server (no Referer leak, no access logs) and we can wipe it
// from the address bar immediately after capture.
const hash = new URLSearchParams(location.hash.replace(/^#/, ''));

export const autoPassword = query.get('p') || '';
export const autoName = query.get('n') || '';
export const presenterKey = hash.get('pk') || '';
export const isPresenter = hash.get('role') === 'presenter' && presenterKey.length > 0;

if (location.hash) {
  history.replaceState(null, '', location.pathname + location.search);
}

// Mutable session identity, populated on join() or session resume.
let participantId: string | null = null;
let token: string | null = null;

export function setSession(pid: string, tok: string): void {
  participantId = pid;
  token = tok;
}

export function getParticipantId(): string {
  return participantId ?? '';
}

export function getToken(): string {
  return token ?? '';
}

// Storage key helpers — every key is namespaced by slug so a single browser
// can hold sessions for multiple rooms without collision.
export const PREF_KEY = `conf_pref_${slug}`;
export const NAME_KEY = `viewer_name_${slug}`;
export const PASS_KEY = `viewer_pass_${slug}`;
export const SESSION_KEY = `viewer_session_${slug}`;
export const KICKED_KEY = `viewer_kicked_${slug}`;
const PRESESSION_KEY = `_presession_${slug}`;

export function loadSavedSession(): SavedSession | null {
  try {
    return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
  } catch {
    return null;
  }
}

export function saveSession(s: SavedSession): void {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
}

export function updateSavedStreamKey(newKey: string | null): void {
  const raw = sessionStorage.getItem(SESSION_KEY);
  if (!raw) return;
  try {
    const s = JSON.parse(raw) as SavedSession;
    s.streamKey = newKey;
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
  } catch {}
}

export function clearSession(): void {
  sessionStorage.removeItem(SESSION_KEY);
}

export function isKicked(): boolean {
  return !!sessionStorage.getItem(KICKED_KEY);
}

export function markKicked(): void {
  sessionStorage.setItem(KICKED_KEY, '1');
}

export function clearKicked(): void {
  sessionStorage.removeItem(KICKED_KEY);
}

// Admin "Enter Room" — consume one-time presenter session handed off via
// localStorage. Run synchronously before loadRoomInfo() so the resume path
// finds the saved session. Idempotent (consumes + removes in one go).
export function consumePresession(): void {
  try {
    const raw = localStorage.getItem(PRESESSION_KEY);
    if (!raw) return;
    localStorage.removeItem(PRESESSION_KEY);
    const ps = JSON.parse(raw);
    if (!ps.participantId || !ps.token) return;
    saveSession({
      participantId: ps.participantId,
      token: ps.token,
      deliveryMode: ps.deliveryMode || 'webrtc',
      streamKey: ps.streamKey || null,
      role: ps.role || 'presenter',
    });
  } catch {}
}
