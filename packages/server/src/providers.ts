import type { ApiProvider, ApiStyle, MethodResult, ModelInfo } from '@cocoon/protocol';
import { CocoonError } from './errors.ts';
import { t } from './i18n.ts';
import type { SecretsService } from './secrets.ts';
import type { SettingsService } from './settings.ts';

const TEST_TIMEOUT_MS = 10_000;
/** Local models may need a while for the first token. */
const PROBE_TIMEOUT_MS = 45_000;

/** Credential-proxy route name of a provider. */
export const providerRoute = (id: string) => `p-${id}`;
/** Route that translates the given API style to the provider's Chat Completions endpoint. */
export const translatedRoute = (id: string, style: string) => `p-${id}~${style}`;

/**
 * URL layout of a model provider: `root` (API root, what the proxy forwards to) and `v1Suffix` (path from the root to the
 * OpenAI-style base, usually "/v1"). OpenAI-kind base URLs are given with /v1, Anthropic-kind ones without.
 */
export function providerUrls(provider: Pick<ApiProvider, 'kind' | 'baseUrl'>): { root: string; v1Suffix: string } {
  const base = provider.baseUrl.replace(/\/$/, '');
  const v1Base = provider.kind === 'anthropic' && !/\/v1$/.test(base) ? `${base}/v1` : base;
  return v1Base.endsWith('/v1') ? { root: v1Base.slice(0, -3), v1Suffix: '/v1' } : { root: v1Base, v1Suffix: '' };
}

/** Env prefix for http-kind providers, e.g. "my-api" → "MY_API". */
export const envPrefixFor = (id: string, provider: ApiProvider) => provider.envPrefix ?? id.toUpperCase().replace(/[^A-Z0-9]/g, '_');

/**
 * "localhost" on the server means the host when seen from a container (host.docker.internal / host.containers.internal).
 * Without a host alias (bubblewrap shares the host network) the URL stays as is.
 */
export function containerReachableUrl(url: string, hostAlias?: string): string {
  const parsed = new URL(url);
  if (hostAlias && ['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname)) parsed.hostname = hostAlias;
  return parsed.toString().replace(/\/$/, '');
}

/** The HTTP header (name, value) carrying a provider's key, or undefined for auth = none. */
export function authHeaderFor(provider: ApiProvider, key: string): { name: string; value: string } | undefined {
  if (provider.kind === 'openai') return { name: 'authorization', value: `Bearer ${key}` };
  switch (provider.auth) {
    case 'bearer':
      return { name: 'authorization', value: `Bearer ${key}` };
    case 'x-api-key':
      return { name: 'x-api-key', value: key };
    case 'header':
      return provider.authHeader ? { name: provider.authHeader.toLowerCase(), value: key } : undefined;
    default:
      return undefined;
  }
}

/** Custom API endpoints (settings.providers) plus their keys (secrets). */
export class ProviderService {
  constructor(
    private readonly settings: SettingsService,
    private readonly secrets: SecretsService,
  ) {}

  all(): Record<string, ApiProvider> {
    return this.settings.get().providers;
  }

  get(id: string): ApiProvider {
    const provider = this.all()[id];
    if (!provider) throw new CocoonError('bad_request', t('error.unknownProvider', { id }));
    return provider;
  }

  key(provider: ApiProvider): string | undefined {
    return provider.secret && provider.auth !== 'none' ? this.secrets.resolve(provider.secret) : undefined;
  }

  /** Calls the provider's model list (or base URL for http kind) from the server. */
  async test(provider: ApiProvider): Promise<MethodResult<'providers.test'>> {
    const key = this.key(provider);
    if (provider.secret && provider.auth !== 'none' && !key) {
      return { ok: false, message: t('provider.missingKey', { secret: provider.secret }), models: [], apis: [], modelInfo: {} };
    }
    const base = provider.baseUrl.replace(/\/$/, '');
    const url = provider.kind === 'anthropic' ? `${base}/v1/models` : provider.kind === 'openai' ? `${base}/models` : base;
    const headers: Record<string, string> = { accept: 'application/json' };
    if (provider.kind === 'anthropic') headers['anthropic-version'] = '2023-06-01';
    const auth = key ? authHeaderFor(provider, key) : undefined;
    if (auth) headers[auth.name] = auth.value;

    let res: Response;
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(TEST_TIMEOUT_MS) });
    } catch (err) {
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      return { ok: false, message: t('provider.unreachable', { error: cause?.code ?? cause?.message ?? (err as Error).message }), models: [], apis: [], modelInfo: {} };
    }
    const body = await res.text();
    if (res.status === 401 || res.status === 403) {
      return { ok: false, status: res.status, message: t('provider.authFailed', { status: res.status }), models: [], apis: [], modelInfo: {} };
    }
    if (!res.ok) {
      return { ok: false, status: res.status, message: t('provider.httpError', { status: res.status, message: errorText(body) }), models: [], apis: [], modelInfo: {} };
    }
    const models = provider.kind === 'http' ? [] : parseModels(body);
    const model = provider.defaultModel ?? provider.models[0] ?? models[0];
    const apis = provider.kind === 'http' || !model ? [] : await this.detectApis(provider, headers, model);
    return {
      ok: true,
      status: res.status,
      message: models.length ? t('provider.okModels', { count: models.length }) : t('provider.ok'),
      models,
      apis,
      modelInfo: provider.kind === 'http' ? {} : parseModelInfo(body),
    };
  }

  /** Tests a saved provider and stores what was found (API styles, model list, default model). */
  async testAndRemember(id: string): Promise<MethodResult<'providers.test'>> {
    const provider = this.get(id);
    const result = await this.test(provider);
    if (result.ok) {
      // Detected limits refresh earlier detections; values the user set are kept.
      const modelInfo: Record<string, ModelInfo> = { ...provider.modelInfo };
      for (const [model, info] of Object.entries(result.modelInfo)) {
        if (modelInfo[model]?.source !== 'user') modelInfo[model] = info;
      }
      const updated: ApiProvider = {
        ...provider,
        apis: result.apis.length ? result.apis : provider.apis,
        models: provider.models.length ? provider.models : result.models,
        defaultModel: provider.defaultModel ?? result.models[0],
        modelInfo: Object.keys(modelInfo).length ? modelInfo : undefined,
      };
      this.settings.update({ providers: { ...this.all(), [id]: updated } });
    }
    return result;
  }

  /** API styles of a provider – stored ones, or detected now (and remembered). */
  async apisOf(id: string): Promise<ApiStyle[]> {
    const provider = this.get(id);
    if (provider.apis) return provider.apis;
    return (await this.testAndRemember(id)).apis;
  }

  /**
   * Which API styles the endpoint speaks: one minimal request (1 token) per style. 404/405/501 = not supported;
   * any other answer (200, or a 400 about the request itself) means the endpoint exists.
   */
  private async detectApis(provider: ApiProvider, authHeaders: Record<string, string>, model: string): Promise<ApiStyle[]> {
    const base = provider.baseUrl.replace(/\/$/, '');
    const v1 = provider.kind === 'anthropic' && !/\/v1$/.test(base) ? `${base}/v1` : base;
    const prompt = 'Reply with OK';
    const probes: Record<ApiStyle, { url: string; body: unknown; headers?: Record<string, string> }> = {
      chat: { url: `${v1}/chat/completions`, body: { model, messages: [{ role: 'user', content: prompt }], max_tokens: 1 } },
      responses: { url: `${v1}/responses`, body: { model, input: prompt, max_output_tokens: 16 } },
      messages: {
        url: `${v1}/messages`,
        body: { model, max_tokens: 1, messages: [{ role: 'user', content: prompt }] },
        headers: { 'anthropic-version': '2023-06-01' },
      },
    };
    const results = await Promise.all(
      (Object.entries(probes) as [ApiStyle, (typeof probes)[ApiStyle]][]).map(async ([style, probe]) => {
        try {
          const res = await fetch(probe.url, {
            method: 'POST',
            headers: { ...authHeaders, 'content-type': 'application/json', ...probe.headers },
            body: JSON.stringify(probe.body),
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
          });
          await res.body?.cancel();
          return [404, 405, 501].includes(res.status) ? undefined : style;
        } catch {
          return undefined;
        }
      }),
    );
    return results.filter((style): style is ApiStyle => Boolean(style));
  }
}

const num = (value: unknown): number | undefined => {
  const n = typeof value === 'string' ? Number.parseInt(value, 10) : typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
};

/** Value of a CLI flag in an argument list, e.g. ["--ctx-size", "131072"] or ["-c=4096"]. */
function flagValue(args: unknown, names: string[]): number | undefined {
  if (!Array.isArray(args)) return undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i]);
    for (const name of names) {
      if (arg === name) return num(args[i + 1]);
      if (arg.startsWith(`${name}=`)) return num(arg.slice(name.length + 1));
    }
  }
  return undefined;
}

/**
 * Model limits from a /models listing. Understands llama.cpp routers (server args / preset with --ctx-size),
 * vLLM (max_model_len), OpenRouter (context_length, top_provider.max_completion_tokens), LM Studio
 * (max_context_length) and common field names of other servers.
 */
export function parseModelInfo(body: string): Record<string, ModelInfo> {
  type Entry = Record<string, unknown> & { id?: string; name?: string };
  let list: Entry[] = [];
  try {
    const json = JSON.parse(body) as { data?: Entry[]; models?: Entry[] };
    list = json.data ?? json.models ?? [];
  } catch {
    return {};
  }
  const result: Record<string, ModelInfo> = {};
  for (const entry of list) {
    const id = entry.id ?? entry.name;
    if (!id) continue;
    const meta = (entry.meta ?? {}) as Record<string, unknown>;
    const top = (entry.top_provider ?? {}) as Record<string, unknown>;
    const status = (entry.status ?? {}) as Record<string, unknown>;
    const preset = typeof entry.preset === 'string' ? /(?:^|\n)\s*ctx-size\s*=\s*(\d+)/.exec(entry.preset)?.[1] : undefined;
    const contextWindow =
      num(entry.context_length) ?? num(entry.context_window) ?? num(entry.max_model_len) ?? num(entry.max_context_length) ??
      num(entry.max_input_tokens) ?? num(entry.n_ctx) ?? num(meta.n_ctx) ?? flagValue(status.args, ['--ctx-size', '-c']) ??
      num(preset) ?? num(top.context_length) ?? num(meta.n_ctx_train);
    const maxOutputTokens = num(entry.max_output_tokens) ?? num(entry.max_completion_tokens) ?? num(top.max_completion_tokens);
    if (contextWindow || maxOutputTokens) result[String(id)] = { contextWindow, maxOutputTokens, source: 'detected' };
  }
  return result;
}

function parseModels(body: string): string[] {
  try {
    const json = JSON.parse(body) as { data?: { id?: string }[]; models?: { id?: string; name?: string }[] };
    const list = json.data ?? json.models ?? [];
    return [...new Set(list.map((m) => ('id' in m && m.id) || ('name' in m && m.name) || '').filter(Boolean) as string[])].sort();
  } catch {
    return [];
  }
}

function errorText(body: string): string {
  try {
    const json = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
    const message = typeof json.error === 'string' ? json.error : (json.error?.message ?? json.message);
    if (message) return message.slice(0, 200);
  } catch {
    // not JSON
  }
  return body.slice(0, 200).trim() || '—';
}
