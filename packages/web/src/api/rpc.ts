import type { MethodName, MethodParams, MethodResult, WireError } from '@cocoon/protocol';
import { getLanguage, t, type MessageKey } from '../i18n';
import { clearToken, getToken } from '../lib/auth';

export type ApiErrorCode = WireError['code'] | 'network';

export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const CODE_LABELS: Record<ApiErrorCode, MessageKey> = {
  bad_request: 'error.bad_request',
  unauthorized: 'error.unauthorized',
  not_found: 'error.not_found',
  conflict: 'error.conflict',
  timeout: 'error.timeout',
  internal: 'error.internal',
  network: 'error.network',
};

/** Human-readable description (in the active UI language) of any error thrown by rpc() or elsewhere. */
export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    const key = CODE_LABELS[err.code];
    const label = key ? t(key) : t('error.generic');
    return err.message && err.message !== label ? `${label}: ${err.message}` : label;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

export function isNotFound(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'not_found';
}

/** Typed call of a control-plane method via `POST /v1/rpc/<method>`. */
export async function rpc<M extends MethodName>(method: M, params?: MethodParams<M>, token = getToken()): Promise<MethodResult<M>> {
  let res: Response;
  try {
    res = await fetch(`/v1/rpc/${method}`, {
      method: 'POST',
      // x-cocoon-lang: the server renders error messages, activity entries etc. in this language.
      headers: { authorization: `Bearer ${token ?? ''}`, 'content-type': 'application/json', 'x-cocoon-lang': getLanguage() },
      body: JSON.stringify(params ?? {}),
    });
  } catch {
    throw new ApiError('network', t('error.networkHint'));
  }

  const body = (await res.json().catch(() => ({}))) as { result?: unknown; error?: WireError };

  if (res.status === 401) {
    // Only log out if the failing token is still the active one (not e.g. a login attempt).
    if (token && token === getToken()) clearToken(true);
    throw new ApiError('unauthorized', body.error?.message ?? t('error.invalidToken'));
  }
  if (!res.ok || body.error) {
    const e = body.error;
    throw new ApiError(e?.code ?? (res.status === 404 ? 'not_found' : 'internal'), e?.message ?? `HTTP ${res.status}`, e?.details);
  }
  return body.result as MethodResult<M>;
}

/** Builds a same-origin WebSocket URL with token and language as query parameters (browsers cannot set headers). */
export function wsUrl(path: string, query: Record<string, string | number> = {}): string {
  const url = new URL(path, window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('token', getToken() ?? '');
  url.searchParams.set('lang', getLanguage());
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
  return url.toString();
}

/** Download URL for a file or directory (tar archive) from a sandbox. */
export function archiveUrl(sandboxId: string, path: string): string {
  const params = new URLSearchParams({ path, token: getToken() ?? '', lang: getLanguage() });
  return `/v1/sandboxes/${encodeURIComponent(sandboxId)}/archive?${params}`;
}
