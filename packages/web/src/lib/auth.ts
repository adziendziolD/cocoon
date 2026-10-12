/** Admin/API token handling. The token lives in localStorage and is never put into URLs we keep. */
const KEY = 'cocoon.token';
const listeners = new Set<() => void>();
let expired = false;

export function getToken(): string | null {
  return localStorage.getItem(KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(KEY, token.trim());
  expired = false;
  emit();
}

/** Clears the token; `sessionExpired` lets the login page explain why the user was logged out. */
export function clearToken(sessionExpired = false): void {
  localStorage.removeItem(KEY);
  expired = sessionExpired;
  emit();
}

export function wasSessionExpired(): boolean {
  return expired;
}

export function subscribeToken(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of listeners) fn();
}

/** Picks up `?token=…` from the login URL printed by the server, stores it and strips it from the address bar. */
export function consumeTokenFromUrl(): void {
  const url = new URL(window.location.href);
  const token = url.searchParams.get('token');
  if (!token) return;
  setToken(token);
  url.searchParams.delete('token');
  window.history.replaceState(null, '', url.pathname + url.search + url.hash);
}
