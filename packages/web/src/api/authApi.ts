import type { SessionResult, SetupInfoResult, WireError } from '@cocoon/protocol';
import { getLanguage, t } from '../i18n';
import { ApiError, describeError } from './rpc';

/**
 * Signing in and choosing a password need no token, so they are not RPC methods: plain POST requests to /v1/auth/*.
 * A failed sign-in must not look like an expired session, which is why these calls never go through rpc().
 */
async function publicPost<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cocoon-lang': getLanguage() },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError('network', t('error.networkHint'));
  }
  const data = (await res.json().catch(() => ({}))) as { result?: T; error?: WireError };
  if (!res.ok || data.error) throw new ApiError(data.error?.code ?? 'internal', data.error?.message ?? `HTTP ${res.status}`, data.error?.details);
  return data.result as T;
}

export const login = (username: string, password: string) => publicPost<SessionResult>('/v1/auth/login', { username, password });
export const setupInfo = (token: string) => publicPost<SetupInfoResult>('/v1/auth/setup-info', { token });
export const completeSetup = (token: string, password: string) => publicPost<SessionResult>('/v1/auth/setup', { token, password });

/** What to show next to a form field: the server's own sentence (already in the UI language) rather than "Not signed in: …". */
export function formMessage(err: unknown): string {
  return err instanceof ApiError && err.code !== 'network' && err.message ? err.message : describeError(err);
}
