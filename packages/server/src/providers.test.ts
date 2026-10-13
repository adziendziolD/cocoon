import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '@cocoon/protocol';
import {
  authHeaderFor,
  containerReachableUrl,
  envPrefixFor,
  parseModelInfo,
  providerRoute,
  ProviderService,
  providerUrls,
  translatedRoute,
} from './providers.ts';
import type { SecretsService } from './secrets.ts';
import type { SettingsService } from './settings.ts';

const body = (value: unknown) => JSON.stringify(value);

describe('parseModelInfo', () => {
  it('reads --ctx-size from a llama.cpp router status.args', () => {
    const info = parseModelInfo(
      body({
        object: 'list',
        data: [
          { id: 'qwen3-coder', object: 'model', status: { value: 'loaded', args: ['llama-server', '--model', '/m/q.gguf', '--ctx-size', '131072', '--port', '8081'] } },
          { id: 'gemma', status: { value: 'unloaded', args: ['llama-server', '-c', '8192'] } },
          { id: 'small', status: { args: ['llama-server', '--ctx-size=4096'] } },
        ],
      }),
    );
    expect(info).toEqual({
      'qwen3-coder': { contextWindow: 131072, maxOutputTokens: undefined, source: 'detected' },
      gemma: { contextWindow: 8192, maxOutputTokens: undefined, source: 'detected' },
      small: { contextWindow: 4096, maxOutputTokens: undefined, source: 'detected' },
    });
  });

  it('reads "ctx-size = N" from a llama.cpp router preset', () => {
    const info = parseModelInfo(
      body({ data: [{ id: 'glm', preset: '[glm]\nmodel = /models/glm.gguf\nctx-size = 65536\nn-gpu-layers = 99' }, { id: 'nope', preset: 'my-ctx-size = 5' }] }),
    );
    expect(info).toEqual({ glm: { contextWindow: 65536, maxOutputTokens: undefined, source: 'detected' } });
  });

  it('reads vLLM max_model_len', () => {
    const info = parseModelInfo(body({ object: 'list', data: [{ id: 'Qwen/Qwen3-32B', object: 'model', owned_by: 'vllm', max_model_len: 40960 }] }));
    expect(info['Qwen/Qwen3-32B']).toEqual({ contextWindow: 40960, maxOutputTokens: undefined, source: 'detected' });
  });

  it('reads OpenRouter context_length and top_provider.max_completion_tokens', () => {
    const info = parseModelInfo(
      body({
        data: [
          {
            id: 'anthropic/claude-sonnet-4',
            name: 'Anthropic: Claude Sonnet 4',
            context_length: 200000,
            top_provider: { context_length: 200000, max_completion_tokens: 64000, is_moderated: true },
            pricing: { prompt: '0.000003' },
          },
          { id: 'only-top', top_provider: { context_length: 32768, max_completion_tokens: null } },
        ],
      }),
    );
    expect(info).toEqual({
      'anthropic/claude-sonnet-4': { contextWindow: 200000, maxOutputTokens: 64000, source: 'detected' },
      'only-top': { contextWindow: 32768, maxOutputTokens: undefined, source: 'detected' },
    });
  });

  it('reads LM Studio max_context_length', () => {
    const info = parseModelInfo(body({ object: 'list', data: [{ id: 'qwen2.5-7b-instruct', type: 'llm', state: 'loaded', max_context_length: 32768 }] }));
    expect(info['qwen2.5-7b-instruct']?.contextWindow).toBe(32768);
  });

  it('reads n_ctx and falls back to meta.n_ctx_train', () => {
    const info = parseModelInfo(
      body({
        data: [
          { id: 'a', n_ctx: 16384 },
          { id: 'b', meta: { n_ctx: 8192, n_ctx_train: 131072 } },
          { id: 'c', meta: { n_ctx_train: 131072, n_params: 7e9 } },
        ],
      }),
    );
    expect(info.a?.contextWindow).toBe(16384);
    expect(info.b?.contextWindow).toBe(8192);
    expect(info.c?.contextWindow).toBe(131072);
  });

  it('prefers the configured context over the training context and server args over the preset', () => {
    const info = parseModelInfo(
      body({ data: [{ id: 'm', meta: { n_ctx_train: 262144 }, status: { args: ['-c', '32768'] }, preset: 'ctx-size = 4096' }] }),
    );
    expect(info.m?.contextWindow).toBe(32768);
  });

  it('reads Anthropic-style max_input_tokens / max_output_tokens and the "models" list key', () => {
    const info = parseModelInfo(body({ models: [{ name: 'gemini-x', max_input_tokens: 1048576, max_output_tokens: 65536 }] }));
    expect(info).toEqual({ 'gemini-x': { contextWindow: 1048576, maxOutputTokens: 65536, source: 'detected' } });
  });

  it('accepts numeric strings and ignores zero, negative and non-numeric values', () => {
    const info = parseModelInfo(
      body({
        data: [
          { id: 'str', context_length: '8192' },
          { id: 'zero', context_length: 0, max_model_len: 2048 },
          { id: 'neg', context_length: -1 },
          { id: 'nan', context_length: 'big' },
          { id: 'flagless', status: { args: ['--ctx-size'] } },
        ],
      }),
    );
    expect(info).toEqual({
      str: { contextWindow: 8192, maxOutputTokens: undefined, source: 'detected' },
      zero: { contextWindow: 2048, maxOutputTokens: undefined, source: 'detected' },
    });
  });

  it('returns nothing for missing data, entries without id or invalid JSON', () => {
    expect(parseModelInfo(body({ object: 'list', data: [{ id: 'gpt-4o', object: 'model', owned_by: 'openai' }] }))).toEqual({});
    expect(parseModelInfo(body({ data: [{ context_length: 4096 }] }))).toEqual({});
    expect(parseModelInfo(body({}))).toEqual({});
    expect(parseModelInfo('<html>Not found</html>')).toEqual({});
    expect(parseModelInfo('')).toEqual({});
  });
});

describe('URL and route helpers', () => {
  it('names proxy routes', () => {
    expect(providerRoute('llama')).toBe('p-llama');
    expect(translatedRoute('llama', 'messages')).toBe('p-llama~messages');
  });

  it.each([
    [{ kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1' }, { root: 'https://openrouter.ai/api', v1Suffix: '/v1' }],
    [{ kind: 'openai', baseUrl: 'http://localhost:8080/v1/' }, { root: 'http://localhost:8080', v1Suffix: '/v1' }],
    [{ kind: 'openai', baseUrl: 'https://api.example.com/openai' }, { root: 'https://api.example.com/openai', v1Suffix: '' }],
    [{ kind: 'anthropic', baseUrl: 'https://api.deepseek.com/anthropic' }, { root: 'https://api.deepseek.com/anthropic', v1Suffix: '/v1' }],
    [{ kind: 'anthropic', baseUrl: 'http://localhost:4000/v1' }, { root: 'http://localhost:4000', v1Suffix: '/v1' }],
    [{ kind: 'http', baseUrl: 'https://api.example.com/' }, { root: 'https://api.example.com', v1Suffix: '' }],
  ] as const)('providerUrls(%o)', (provider, expected) => {
    expect(providerUrls(provider)).toEqual(expected);
  });

  it('derives env prefixes from the id unless given', () => {
    const p = ApiProvider.parse({ label: 'x', kind: 'http', baseUrl: 'https://x.dev' });
    expect(envPrefixFor('my-api.v2', p)).toBe('MY_API_V2');
    expect(envPrefixFor('my-api', { ...p, envPrefix: 'CUSTOM' })).toBe('CUSTOM');
  });

  it('rewrites localhost for containers only when a host alias exists', () => {
    expect(containerReachableUrl('http://localhost:11434/v1/', 'host.docker.internal')).toBe('http://host.docker.internal:11434/v1');
    expect(containerReachableUrl('http://127.0.0.1:8080/v1', 'host.containers.internal')).toBe('http://host.containers.internal:8080/v1');
    expect(containerReachableUrl('http://[::1]:8080', 'host.docker.internal')).toBe('http://host.docker.internal:8080');
    expect(containerReachableUrl('http://localhost:8080/v1')).toBe('http://localhost:8080/v1');
    expect(containerReachableUrl('https://api.example.com/v1', 'host.docker.internal')).toBe('https://api.example.com/v1');
  });

  it('builds auth headers per kind and auth mode', () => {
    const base = { label: 'x', baseUrl: 'https://x.dev' };
    expect(authHeaderFor(ApiProvider.parse({ ...base, kind: 'openai', auth: 'x-api-key' }), 'k')).toEqual({ name: 'authorization', value: 'Bearer k' });
    expect(authHeaderFor(ApiProvider.parse({ ...base, kind: 'anthropic' }), 'k')).toEqual({ name: 'authorization', value: 'Bearer k' });
    expect(authHeaderFor(ApiProvider.parse({ ...base, kind: 'anthropic', auth: 'x-api-key' }), 'k')).toEqual({ name: 'x-api-key', value: 'k' });
    expect(authHeaderFor(ApiProvider.parse({ ...base, kind: 'http', auth: 'header', authHeader: 'X-Token' }), 'k')).toEqual({ name: 'x-token', value: 'k' });
    expect(authHeaderFor(ApiProvider.parse({ ...base, kind: 'http', auth: 'header' }), 'k')).toBeUndefined();
    expect(authHeaderFor(ApiProvider.parse({ ...base, kind: 'http', auth: 'none' }), 'k')).toBeUndefined();
  });
});

describe('ProviderService.test (API style detection)', () => {
  afterEach(() => vi.unstubAllGlobals());

  const service = (keys: Record<string, string> = {}) =>
    new ProviderService({ get: () => ({ providers: {} }) } as unknown as SettingsService, { resolve: (name: string) => keys[name] } as unknown as SecretsService);

  /** fetch stub: GET → model list; POST → status per probe path suffix. */
  function stubFetch(models: unknown, probes: Record<string, number | Error>) {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (!init?.method || init.method === 'GET') return new Response(JSON.stringify(models), { status: 200 });
        const suffix = Object.keys(probes).find((s) => url.endsWith(s));
        const result = suffix ? probes[suffix]! : 404;
        if (result instanceof Error) throw result;
        return new Response('{}', { status: result });
      }),
    );
    return calls;
  }

  it('treats 404/405/501 as unsupported and anything else (200, 400) as supported', async () => {
    const calls = stubFetch(
      { data: [{ id: 'b-model', max_model_len: 32768 }, { id: 'a-model' }] },
      { '/chat/completions': 200, '/responses': 400, '/messages': 405 },
    );
    const provider = ApiProvider.parse({ label: 'vLLM', kind: 'openai', baseUrl: 'http://gpu:8000/v1/', secret: 'VLLM_KEY' });
    const result = await service({ VLLM_KEY: 'sk-1' }).test(provider);
    expect(result).toMatchObject({ ok: true, status: 200, models: ['a-model', 'b-model'], apis: ['chat', 'responses'] });
    expect(result.modelInfo).toEqual({ 'b-model': { contextWindow: 32768, maxOutputTokens: undefined, source: 'detected' } });

    expect(calls[0]!.url).toBe('http://gpu:8000/v1/models');
    expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBe('Bearer sk-1');
    const probes = calls.slice(1);
    expect(probes.map((c) => c.url).sort()).toEqual(['http://gpu:8000/v1/chat/completions', 'http://gpu:8000/v1/messages', 'http://gpu:8000/v1/responses']);
    // probes use the first model (sorted list) and carry the auth header
    for (const probe of probes) {
      expect(JSON.parse(probe.init!.body as string).model).toBe('a-model');
      expect((probe.init!.headers as Record<string, string>).authorization).toBe('Bearer sk-1');
    }
  });

  it.each([404, 405, 501])('status %i means not supported', async (status) => {
    stubFetch({ data: [{ id: 'm' }] }, { '/chat/completions': 200, '/responses': status, '/messages': status });
    const result = await service().test(ApiProvider.parse({ label: 'x', kind: 'openai', baseUrl: 'http://h/v1', auth: 'none' }));
    expect(result.apis).toEqual(['chat']);
  });

  it('treats network errors of a probe as unsupported', async () => {
    stubFetch({ data: [{ id: 'm' }] }, { '/chat/completions': new TypeError('fetch failed'), '/responses': 500, '/messages': 401 });
    const result = await service().test(ApiProvider.parse({ label: 'x', kind: 'openai', baseUrl: 'http://h/v1', auth: 'none' }));
    expect(result.apis).toEqual(['responses', 'messages']);
  });

  it('probes anthropic providers under /v1 with anthropic-version and the configured default model', async () => {
    const calls = stubFetch({ data: [{ id: 'listed' }] }, { '/messages': 200 });
    const provider = ApiProvider.parse({
      label: 'DeepSeek',
      kind: 'anthropic',
      baseUrl: 'https://api.deepseek.com/anthropic',
      secret: 'DEEPSEEK_API_KEY',
      auth: 'x-api-key',
      defaultModel: 'deepseek-chat',
    });
    const result = await service({ DEEPSEEK_API_KEY: 'k' }).test(provider);
    expect(result.apis).toEqual(['messages']);
    expect(calls[0]!.url).toBe('https://api.deepseek.com/anthropic/v1/models');
    const messages = calls.find((c) => c.url.endsWith('/messages'))!;
    expect(messages.url).toBe('https://api.deepseek.com/anthropic/v1/messages');
    expect(messages.init!.headers).toMatchObject({ 'x-api-key': 'k', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' });
    expect(JSON.parse(messages.init!.body as string).model).toBe('deepseek-chat');
  });

  it('skips detection when there is no model or for http providers', async () => {
    const calls = stubFetch({ data: [] }, {});
    const empty = await service().test(ApiProvider.parse({ label: 'x', kind: 'openai', baseUrl: 'http://h/v1', auth: 'none' }));
    expect(empty).toMatchObject({ ok: true, apis: [], models: [] });
    const http = await service().test(ApiProvider.parse({ label: 'x', kind: 'http', baseUrl: 'http://h/api', auth: 'none' }));
    expect(http).toMatchObject({ ok: true, apis: [], models: [], modelInfo: {} });
    expect(calls.every((c) => !c.init?.method || c.init.method === 'GET')).toBe(true);
  });

  it('reports a missing key without calling the provider', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const result = await service().test(ApiProvider.parse({ label: 'x', kind: 'openai', baseUrl: 'http://h/v1', secret: 'MISSING_KEY' }));
    expect(result.ok).toBe(false);
    expect(result.message).toContain('MISSING_KEY');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reports auth failures and HTTP errors with the server message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"message":"bad key"}}', { status: 401 })));
    const provider = ApiProvider.parse({ label: 'x', kind: 'openai', baseUrl: 'http://h/v1', auth: 'none' });
    expect(await service().test(provider)).toMatchObject({ ok: false, status: 401, apis: [] });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"model list disabled"}', { status: 500 })));
    const res = await service().test(provider);
    expect(res).toMatchObject({ ok: false, status: 500 });
    expect(res.message).toContain('model list disabled');
  });
});

describe('ProviderService.defaultModels', () => {
  const ALIASES = ['opus', 'sonnet', 'haiku', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
  afterEach(() => vi.unstubAllGlobals());

  const service = (keys: Record<string, string> = {}) =>
    new ProviderService({ get: () => ({ providers: {} }) } as unknown as SettingsService, { resolve: (name: string) => keys[name] } as unknown as SecretsService);

  it('offers the built-in aliases without a key and lists the vendor models with one', async () => {
    expect(await service().defaultModels('claude-code')).toEqual({ models: [...ALIASES], source: 'builtin' });
    expect(await service().defaultModels('codex')).toEqual({ models: [], source: 'none' });
    expect(await service().defaultModels('opencode')).toEqual({ models: [], source: 'none' });

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'claude-b' }, { id: 'claude-a' }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await service({ ANTHROPIC_API_KEY: 'sk-ant' }).defaultModels('claude-code');
    expect(result).toEqual({ models: [...ALIASES, 'claude-a', 'claude-b'], source: 'api' });
    expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({ 'x-api-key': 'sk-ant' });
  });

  it('lists with the subscription token as OAuth bearer when there is no API key', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'claude-x' }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await service({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat' }).defaultModels('claude-code');
    expect(result.models).toContain('claude-x');
    expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({ authorization: 'Bearer sk-ant-oat', 'anthropic-beta': 'oauth-2025-04-20' });
  });

  it('keeps only chat models of OpenAI and falls back on errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'gpt-5' }, { id: 'text-embedding-3' }, { id: 'o3' }, { id: 'gpt-4o-audio' }] }), { status: 200 })));
    expect((await service({ OPENAI_API_KEY: 'k' }).defaultModels('codex')).models).toEqual(['gpt-5', 'o3']);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no', { status: 401 })));
    expect(await service({ ANTHROPIC_API_KEY: 'bad' }).defaultModels('claude-code')).toEqual({ models: [...ALIASES], source: 'builtin' });
  });
});
