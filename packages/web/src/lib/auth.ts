/**
 * Sign-in state. The credential (an admin/API token, or the session token a user gets after signing in with a password)
 * lives in localStorage and is never put into URLs we keep.
 */
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

const MODE_KEY = 'cocoon.loginMode';
export type LoginMode = 'password' | 'token';

/** Which sign-in form the login page opens with: the one this browser used last (admins mostly use the token). */
export function getLoginMode(): LoginMode {
  return localStorage.getItem(MODE_KEY) === 'token' ? 'token' : 'password';
}

export function setLoginMode(mode: LoginMode): void {
  localStorage.setItem(MODE_KEY, mode);
}

/** The token of a setup link opened in this tab, until the setup page has used it. */
let pendingSetup: string | null = null;

export function getPendingSetup(): string | null {
  return pendingSetup;
}

export function clearPendingSetup(): void {
  pendingSetup = null;
  emit();
}

/**
 * Picks up `#setup=<token>` from the link an admin shared. The token sits in the fragment, which browsers send neither
 * to the server nor in a Referer header, and it is removed from the address bar right away. Returns whether there was one.
 */
export function consumeSetupFromUrl(): boolean {
  const token = new URLSearchParams(window.location.hash.slice(1)).get('setup');
  if (!token) return false;
  pendingSetup = token;
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
  return true;
}

// A link pasted into a tab that already shows the app only changes the fragment: no reload, so listen for it.
window.addEventListener('hashchange', () => {
  if (consumeSetupFromUrl()) emit();
});
