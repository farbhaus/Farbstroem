// Shared auth state + the apiFetch wrapper every other admin module uses.
// Holds the JWT in localStorage and triggers a logout on 401.

const TOKEN_KEY = 'stream_token';

let token = localStorage.getItem(TOKEN_KEY) || '';
let onLogout: (() => void) | null = null;

export function getToken(): string {
  return token;
}

export function setToken(value: string): void {
  token = value;
  localStorage.setItem(TOKEN_KEY, value);
}

export function clearToken(): void {
  token = '';
  localStorage.removeItem(TOKEN_KEY);
}

export function setLogoutHandler(fn: () => void): void {
  onLogout = fn;
}

export async function apiFetch(path: string, opts: RequestInit = {}): Promise<Response | null> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...((opts.headers as Record<string, string> | undefined) ?? {}),
  };
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401) {
    if (onLogout) onLogout();
    return null;
  }
  return res;
}

export interface LoginResult {
  ok: boolean;
  error?: string;
  totpRequired?: boolean;
}

export async function login(password: string, totpCode?: string): Promise<LoginResult> {
  let res: Response;
  try {
    res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password, totp_code: totpCode }),
    });
  } catch {
    return { ok: false, error: 'Cannot reach server — is the backend running?' };
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: data.error || 'Sign in failed' };
  // Password OK but a 2FA code is still needed (HTTP 200, no token).
  if (data.totpRequired) return { ok: false, totpRequired: true };
  setToken(data.token);
  return { ok: true };
}

export interface AuthMethods {
  totpEnabled: boolean;
  passkeyEnabled: boolean;
}

export async function fetchAuthMethods(): Promise<AuthMethods> {
  try {
    const res = await fetch('/api/auth/methods');
    if (res.ok) return await res.json();
  } catch {
    /* fall through */
  }
  return { totpEnabled: false, passkeyEnabled: false };
}

// Run the WebAuthn assertion ceremony; sets the token on success.
export async function passkeyLogin(
  doAuthenticate: (options: unknown) => Promise<unknown>,
): Promise<LoginResult> {
  let res: Response;
  try {
    res = await fetch('/api/auth/passkey/start', { method: 'POST' });
  } catch {
    return { ok: false, error: 'Cannot reach server' };
  }
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    return { ok: false, error: e.error || 'No passkeys available' };
  }
  const { id, options } = await res.json();
  let credential: unknown;
  try {
    credential = await doAuthenticate(options);
  } catch {
    return { ok: false, error: 'Passkey cancelled' };
  }
  const fin = await fetch('/api/auth/passkey/finish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, credential }),
  });
  const data = await fin.json().catch(() => ({}));
  if (!fin.ok) return { ok: false, error: data.error || 'Passkey rejected' };
  setToken(data.token);
  return { ok: true };
}
