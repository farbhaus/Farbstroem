// Chat sidebar + file sharing (upload XHR with cancel + progress).

import { esc, fmtBytes } from '../shared/utils.js';
import { getParticipantId, getToken, slug } from './session.js';
import { viewerStore } from './state.js';
import type { Role, SessionFile, WsClientMessage } from './types.js';

let sendFn: ((msg: WsClientMessage) => void) | null = null;

export function configureChat(opts: { send: (msg: WsClientMessage) => void }): void {
  sendFn = opts.send;
}

export function setChatEnabled(enabled: boolean): void {
  (document.getElementById('chat-input') as HTMLInputElement).disabled = !enabled;
  (document.getElementById('chat-send') as HTMLButtonElement).disabled = !enabled;
  (document.getElementById('chat-attach') as HTMLButtonElement).disabled = !enabled;
}

function notifyChat(): void {
  if (!viewerStore.get().chatOpen) {
    document.getElementById('chat-toggle')?.classList.add('has-notification');
  }
}

function fmtTime(ts: number): string {
  const t = new Date(ts);
  return (
    t.getHours().toString().padStart(2, '0') + ':' + t.getMinutes().toString().padStart(2, '0')
  );
}

function dlUrl(fileId: string): string {
  return (
    `/api/public/rooms/${encodeURIComponent(slug)}/files/${encodeURIComponent(fileId)}/download` +
    `?participantId=${encodeURIComponent(getParticipantId())}&token=${encodeURIComponent(getToken())}`
  );
}

interface ChatMsg {
  ts: number;
  name: string;
  role: Role;
  text: string;
}

export function appendChatMessage(msg: ChatMsg): void {
  const list = document.getElementById('chat-messages');
  if (!list) return;
  const d = document.createElement('div');
  d.className = 'chat-msg';
  d.innerHTML =
    `<div class="chat-meta"><span class="chat-who ${esc(msg.role)}">${esc(msg.name)}</span><span class="chat-time">${fmtTime(msg.ts)}</span></div>` +
    `<div class="chat-text">${esc(msg.text)}</div>`;
  list.appendChild(d);
  list.scrollTop = list.scrollHeight;
  notifyChat();
}

interface FileMsg {
  ts: number;
  name: string;
  role: Role;
  id: string;
  size: number;
  uploaderName: string;
}

export function appendFileMessage(msg: FileMsg, notify = true): void {
  const list = document.getElementById('chat-messages');
  if (!list) return;
  const url = dlUrl(msg.id);
  const d = document.createElement('div');
  d.className = 'chat-msg';
  d.innerHTML =
    `<div class="chat-meta"><span class="chat-who ${esc(msg.role)}">${esc(msg.uploaderName)}</span><span class="chat-time">${fmtTime(msg.ts)}</span></div>` +
    `<div class="chat-file">` +
    `<span class="chat-file-icon"><svg viewBox="0 0 24 24"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg></span>` +
    `<div class="chat-file-info"><div class="chat-file-name" title="${esc(msg.name)}">${esc(msg.name)}</div><div class="chat-file-size">${fmtBytes(msg.size)}</div></div>` +
    `<a class="chat-file-dl" href="${url}" download="${esc(msg.name)}">Get</a>` +
    `</div>`;
  list.appendChild(d);
  list.scrollTop = list.scrollHeight;
  if (notify) notifyChat();
}

export function addFileToSection(f: SessionFile): void {
  const list = document.getElementById('files-list');
  if (!list) return;
  document.getElementById('files-empty')?.remove();
  if (list.querySelector(`[data-fid="${CSS.escape(f.id)}"]`)) return;
  const url = dlUrl(f.id);
  const row = document.createElement('div');
  row.className = 'file-row';
  row.dataset['fid'] = f.id;
  row.innerHTML =
    `<div class="file-row-name" title="${esc(f.name)}">${esc(f.name)}</div>` +
    `<span class="file-row-size">${fmtBytes(f.size)}</span>` +
    `<a class="file-row-dl" href="${url}" download="${esc(f.name)}">Get</a>`;
  list.appendChild(row);
  const count = document.getElementById('files-count');
  if (count) count.textContent = String(list.querySelectorAll('.file-row').length);
}

export function appendChatHistory(
  messages: Array<ChatMsg | (FileMsg & { type: 'file:shared' })>,
): void {
  for (const m of messages) {
    if ('type' in m && m.type === 'file:shared') {
      appendFileMessage(m as FileMsg, false);
      addFileToSection({
        id: m.id,
        name: m.name,
        size: m.size,
        uploaderName: m.uploaderName,
        role: m.role,
      });
    } else {
      const list = document.getElementById('chat-messages');
      if (!list) continue;
      const d = document.createElement('div');
      d.className = 'chat-msg';
      d.innerHTML =
        `<div class="chat-meta"><span class="chat-who ${esc(m.role)}">${esc(m.name)}</span><span class="chat-time">${fmtTime(m.ts)}</span></div>` +
        `<div class="chat-text">${esc((m as ChatMsg).text)}</div>`;
      list.appendChild(d);
    }
  }
  const list = document.getElementById('chat-messages');
  if (list) list.scrollTop = list.scrollHeight;
}

export async function loadSessionFiles(): Promise<void> {
  try {
    const res = await fetch(
      `/api/public/rooms/${encodeURIComponent(slug)}/files` +
        `?participantId=${encodeURIComponent(getParticipantId())}&token=${encodeURIComponent(getToken())}`,
    );
    if (!res.ok) return;
    const files: SessionFile[] = await res.json();
    files.forEach(addFileToSection);
  } catch {}
}

let currentUploadXhr: XMLHttpRequest | null = null;

function uploadFile(file: File): void {
  const attachBtn = document.getElementById('chat-attach') as HTMLButtonElement;
  const progressBar = document.getElementById('upload-progress-bar') as HTMLElement;
  const progressFill = document.getElementById('upload-progress-fill') as HTMLElement;
  const progressRow = document.getElementById('upload-progress-row') as HTMLElement;
  const progressName = document.getElementById('upload-progress-name') as HTMLElement;
  const progressPct = document.getElementById('upload-progress-pct') as HTMLElement;
  const cancelBtn = document.getElementById('upload-progress-cancel') as HTMLButtonElement;

  attachBtn.disabled = true;
  progressBar.style.display = '';
  progressRow.style.display = 'flex';
  progressFill.style.width = '0%';
  progressName.textContent = file.name;
  progressName.title = file.name;
  progressPct.textContent = '0%';

  const xhr = new XMLHttpRequest();
  currentUploadXhr = xhr;
  xhr.open(
    'POST',
    `/api/public/rooms/${encodeURIComponent(slug)}/files` +
      `?participantId=${encodeURIComponent(getParticipantId())}&token=${encodeURIComponent(getToken())}`,
  );
  xhr.upload.addEventListener('progress', (e) => {
    if (e.lengthComputable) {
      const pct = Math.round((e.loaded / e.total) * 100);
      progressFill.style.width = pct + '%';
      progressPct.textContent = pct + '%';
    }
  });
  const done = (): void => {
    currentUploadXhr = null;
    attachBtn.disabled = false;
    progressBar.style.display = 'none';
    progressRow.style.display = 'none';
    progressFill.style.width = '0%';
  };
  xhr.onload = done;
  xhr.onerror = done;
  xhr.onabort = done;
  cancelBtn.onclick = () => {
    if (currentUploadXhr) currentUploadXhr.abort();
  };

  const fd = new FormData();
  fd.append('file', file);
  xhr.send(fd);
}

function sendChat(): void {
  const input = document.getElementById('chat-input') as HTMLInputElement;
  const text = input.value.trim();
  if (!text || !sendFn) return;
  sendFn({ type: 'chat:message', text });
  input.value = '';
}

export function initChat(): void {
  document.getElementById('chat-send')?.addEventListener('click', sendChat);
  document.getElementById('chat-input')?.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') sendChat();
  });
  document.getElementById('chat-attach')?.addEventListener('click', () => {
    (document.getElementById('file-input') as HTMLInputElement).click();
  });
  document.getElementById('file-input')?.addEventListener('change', (e) => {
    const target = e.target as HTMLInputElement;
    const file = target.files?.[0];
    if (file) uploadFile(file);
    target.value = '';
  });
}
