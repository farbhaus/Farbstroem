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
}

export async function login(password: string): Promise<LoginResult> {
  let res: Response;
  try {
    res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
  } catch {
    return { ok: false, error: 'Cannot reach server — is the backend running?' };
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: data.error || 'Sign in failed' };
  setToken(data.token);
  return { ok: true };
}
