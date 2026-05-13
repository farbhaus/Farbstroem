export function esc(str: unknown): string {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;

export function toast(msg: string, dur = 2500): void {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el!.classList.remove('show'), dur);
}

export function copyToClipboard(text: string): void {
  navigator.clipboard.writeText(text).then(() => toast('Copied'));
}

export function fmtDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

// Parse a SQLite "YYYY-MM-DD HH:MM:SS" UTC string (no zone marker) into a Date.
// Real ISO strings (with T and Z) are passed through.
export function parseDbDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  return /[TZ]/.test(s) ? new Date(s) : new Date(s.replace(' ', 'T') + 'Z');
}

export function fmtDateTime(s: string | null | undefined): string | null {
  const d = parseDbDate(s);
  if (!d) return null;
  return d.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function fmtBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return (bytes / 1_073_741_824).toFixed(1) + ' GB';
  if (bytes >= 1_048_576) return (bytes / 1_048_576).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return bytes + ' B';
}

export function fmtBitrate(bps: number | undefined | null): string {
  if (!bps) return '—';
  if (bps >= 1_000_000) return (bps / 1_000_000).toFixed(1) + ' Mbps';
  return Math.round(bps / 1000) + ' kbps';
}

// Bits-per-second from a bytes/sec input. Used for network display, since
// link capacity (e.g. 1 Gbps) is conventionally measured in bits.
export function fmtBitRate(bytesPerSec: number): string {
  const bps = (bytesPerSec || 0) * 8;
  if (bps >= 1e9) return (bps / 1e9).toFixed(2) + ' Gbps';
  if (bps >= 1e6) return (bps / 1e6).toFixed(1) + ' Mbps';
  if (bps >= 1e3) return (bps / 1e3).toFixed(0) + ' kbps';
  return bps + ' bps';
}

export function fmtDuration(secs: number): string {
  secs = Math.floor(secs || 0);
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `up ${d}d ${h}h`;
  if (h > 0) return `up ${h}h ${m}m`;
  return `up ${m}m`;
}

export function fmtUptime(iso: string): string {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}

export function pctClass(p: number): 'ok' | 'warn' | 'crit' {
  if (p > 85) return 'crit';
  if (p > 60) return 'warn';
  return 'ok';
}

export function fmtSourceIp(url: string | null | undefined): string {
  if (!url) return '';
  const m = url.match(/\/\/([^:/]+)/);
  return m && m[1] ? m[1] : '';
}
