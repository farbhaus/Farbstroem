import { apiFetch } from './auth.js';
import { closeModal, confirmModal, openModal } from '../shared/components.js';
import { esc, toast } from '../shared/utils.js';
import type { StreamKey } from './types.js';

const INGEST_HOST = location.hostname;

let keys: StreamKey[] = [];
let onChange: () => void = () => {};

export function getStreamKeys(): StreamKey[] {
  return keys;
}

export function setOnChange(fn: () => void): void {
  onChange = fn;
}

export async function loadKeys(): Promise<void> {
  const res = await apiFetch('/api/stream-keys');
  if (!res) return;
  keys = await res.json();
  renderKeys();
}

function renderKeys(): void {
  const container = document.getElementById('keys-list');
  if (!container) return;
  if (!keys.length) {
    container.innerHTML = '<div class="empty">No stream keys yet.</div>';
    return;
  }

  const proto = location.protocol === 'https:' ? 'https' : 'http';
  const wsproto = location.protocol === 'https:' ? 'wss' : 'ws';

  container.innerHTML = keys
    .map((k) => {
      const srtUrl = `srt://${INGEST_HOST}:9999?streamid=default/live/${k.key_token}`;
      const rtmpServer = `rtmp://${INGEST_HOST}:1935/live`;
      const whipUrl = `${proto}://${INGEST_HOST}/live/${k.key_token}?direction=whip`;
      const webrtcUrl = `${wsproto}://${INGEST_HOST}/live/${k.key_token}`;
      const llhlsUrl = `${proto}://${INGEST_HOST}/live/${k.key_token}/llhls.m3u8`;
      const srtPlayUrl = `srt://${INGEST_HOST}:9998?streamid=default/live/${k.key_token}/playlist`;

      const row = (label: string, value: string, labelStyle = ''): string => `
        <div class="url-row">
          <span class="url-label" ${labelStyle ? `style="${labelStyle}"` : ''}>${esc(label)}</span>
          <input readonly class="url-input" style="font-family:monospace;font-size:11px" value="${esc(value)}">
        </div>`;

      return `
      <div class="key-card">
        <div class="key-card-header">
          <div class="key-card-name">${esc(k.name)}</div>
          ${k.room_names ? `<div class="key-card-rooms">Used in: ${esc(k.room_names)}</div>` : ''}
          <button class="btn btn-sm btn-danger" data-action="delete-key" data-id="${esc(k.id)}">Delete</button>
        </div>
        <div class="key-card-body">
          ${row('Stream Key', k.key_token)}
          ${row('SRT', srtUrl)}
          ${row('RTMP', rtmpServer)}
          <div class="url-row">
            <span class="url-label"></span>
            <input readonly class="url-input" style="font-family:monospace;font-size:11px" value="${esc(k.key_token)}">
          </div>
          ${row('WHIP', whipUrl)}
          <hr class="url-divider">
          ${row('WebRTC', webrtcUrl, 'color:var(--accent)')}
          ${row('LLHLS', llhlsUrl, 'color:var(--accent)')}
          ${row('SRT', srtPlayUrl, 'color:var(--accent)')}
        </div>
      </div>`;
    })
    .join('');
}

function openKeyModal(): void {
  (document.getElementById('key-name') as HTMLInputElement).value = '';
  openModal('key-modal');
}

async function saveKey(): Promise<void> {
  const name = (document.getElementById('key-name') as HTMLInputElement).value.trim();
  if (!name) {
    toast('Name required');
    return;
  }
  const res = await apiFetch('/api/stream-keys', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  if (!res || !res.ok) {
    toast('Failed to create key');
    return;
  }
  closeModal('key-modal');
  toast('Stream key created');
  onChange();
}

async function deleteKey(id: string): Promise<void> {
  if (
    !(await confirmModal({
      title: 'Delete Stream Key',
      message: 'Any encoder using this key will stop being able to ingest.',
      confirmLabel: 'Delete',
      danger: true,
    }))
  )
    return;
  const res = await apiFetch(`/api/stream-keys/${id}`, { method: 'DELETE' });
  if (res && res.ok) {
    toast('Key deleted');
    onChange();
  } else {
    toast('Delete failed');
  }
}

export function initStreamKeys(): void {
  document.getElementById('new-key-btn')?.addEventListener('click', openKeyModal);
  document
    .getElementById('key-modal-close')
    ?.addEventListener('click', () => closeModal('key-modal'));
  document
    .getElementById('key-modal-cancel')
    ?.addEventListener('click', () => closeModal('key-modal'));
  document.getElementById('key-modal-save')?.addEventListener('click', saveKey);
}

export function handleKeyAction(action: string, target: HTMLElement): void {
  if (action === 'delete-key') {
    const id = target.getAttribute('data-id') || '';
    void deleteKey(id);
  }
}
