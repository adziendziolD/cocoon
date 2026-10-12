import { describe, expect, it } from 'vitest';
import { ApiProvider, defaultMaxOutput, methods, ModelInfo, PROVIDER_PRESETS, Settings, SharedService } from './index.ts';

describe('defaultMaxOutput', () => {
  it('is a quarter of the context window', () => {
    expect(defaultMaxOutput(32_768)).toBe(8192);
    expect(defaultMaxOutput(65_536)).toBe(16_384);
    expect(defaultMaxOutput(10_001)).toBe(2500); // rounded down
  });

  it('never goes below 1k', () => {
    expect(defaultMaxOutput(1024)).toBe(1024);
    expect(defaultMaxOutput(4095)).toBe(1024);
    expect(defaultMaxOutput(4096)).toBe(1024);
    expect(defaultMaxOutput(4100)).toBe(1025);
    expect(defaultMaxOutput(0)).toBe(1024);
  });

  it('never exceeds 32k', () => {
    expect(defaultMaxOutput(131_072)).toBe(32_768);
    expect(defaultMaxOutput(200_000)).toBe(32_768);
    expect(defaultMaxOutput(1_048_576)).toBe(32_768);
  });
});

describe('ModelInfo', () => {
  it('accepts partial limits and enforces minimums', () => {
    expect(ModelInfo.parse({})).toEqual({});
    expect(ModelInfo.parse({ contextWindow: 8192, source: 'user' })).toEqual({ contextWindow: 8192, source: 'user' });
    expect(ModelInfo.safeParse({ contextWindow: 512 }).success).toBe(false);
    expect(ModelInfo.safeParse({ maxOutputTokens: 100 }).success).toBe(false);
    expect(ModelInfo.safeParse({ contextWindow: 8192.5 }).success).toBe(false);
    expect(ModelInfo.safeParse({ source: 'guessed' }).success).toBe(false);
  });
});

describe('ApiProvider', () => {
  it('fills defaults: bearer auth and no models', () => {
    expect(ApiProvider.parse({ label: 'vLLM', kind: 'openai', baseUrl: 'http://gpu:8000/v1' })).toEqual({
      label: 'vLLM',
      kind: 'openai',
      baseUrl: 'http://gpu:8000/v1',
      auth: 'bearer',
      models: [],
    });
  });

  it('validates base URL protocol, secret names, env prefixes and per-model info', () => {
    const base = { label: 'x', kind: 'openai', baseUrl: 'https://x.dev/v1' };
    expect(ApiProvider.safeParse({ ...base, baseUrl: 'ftp://x.dev' }).success).toBe(false);
    expect(ApiProvider.safeParse({ ...base, baseUrl: 'not a url' }).success).toBe(false);
    expect(ApiProvider.safeParse({ ...base, label: '' }).success).toBe(false);
    expect(ApiProvider.safeParse({ ...base, secret: 'lower_case' }).success).toBe(false);
    expect(ApiProvider.safeParse({ ...base, secret: 'MY_KEY' }).success).toBe(true);
    expect(ApiProvider.safeParse({ ...base, envPrefix: '1ABC' }).success).toBe(false);
    expect(ApiProvider.safeParse({ ...base, apis: ['chat', 'graphql'] }).success).toBe(false);
    expect(ApiProvider.safeParse({ ...base, modelInfo: { m: { contextWindow: 100 } } }).success).toBe(false);
    expect(ApiProvider.parse({ ...base, modelInfo: { m: { contextWindow: 4096 } } }).modelInfo).toEqual({ m: { contextWindow: 4096 } });
  });

  it('presets are valid providers', () => {
    for (const [id, preset] of Object.entries(PROVIDER_PRESETS)) {
      expect(ApiProvider.safeParse(preset.provider).success, id).toBe(true);
    }
  });
});

describe('SharedService', () => {
  it('attaches to all sandboxes by default', () => {
    const service = SharedService.parse({ id: 'postgres', kind: 'postgres', mode: 'managed', createdAt: '2026-01-01T00:00:00Z' });
    expect(service.attach).toBe('all');
    expect(service).not.toHaveProperty('autoStop');
  });

  it('validates ids, kinds, ports and memory', () => {
    const base = { id: 'db', kind: 'postgres', mode: 'external', createdAt: 'x' };
    expect(SharedService.safeParse(base).success).toBe(true);
    expect(SharedService.safeParse({ ...base, id: 'Db' }).success).toBe(false);
    expect(SharedService.safeParse({ ...base, id: '1db' }).success).toBe(false);
    expect(SharedService.safeParse({ ...base, kind: 'oracle' }).success).toBe(false);
    expect(SharedService.safeParse({ ...base, port: 0 }).success).toBe(false);
    expect(SharedService.safeParse({ ...base, port: 65536 }).success).toBe(false);
    expect(SharedService.safeParse({ ...base, memoryMb: 64 }).success).toBe(false);
    expect(SharedService.safeParse({ ...base, mode: 'cloud' }).success).toBe(false);
  });
});

describe('Settings', () => {
  it('fills every section with defaults from an empty object', () => {
    const settings = Settings.parse({});
    expect(settings.general.language).toBe('en');
    expect(settings.sandbox).toMatchObject({ image: 'cocoon/sandbox:latest', network: 'egress', workdir: '/workspace' });
    expect(settings.egress.credentialProxy).toBe(true);
    expect(settings.status).toEqual({ pollIntervalMs: 1000, idleAfterMs: 2500 });
    expect(settings.providers).toEqual({});
    expect(Object.keys(settings.agents)).toContain('claude-code');
  });
});

describe('settings.update params (patch schemas)', () => {
  const params = methods['settings.update'].params;

  it('does not fill in defaults for omitted fields of a section', () => {
    // A plain .partial() would fill pollIntervalMs/idleAfterMs/language with defaults and overwrite stored values.
    expect(params.parse({ status: { idleAfterMs: 4000 } })).toEqual({ status: { idleAfterMs: 4000 } });
    expect(params.parse({ general: { onboardingCompletedAt: 'now' } })).toEqual({ general: { onboardingCompletedAt: 'now' } });
    expect(params.parse({ sandbox: {} })).toEqual({ sandbox: {} });
    expect(params.parse({})).toEqual({});
  });

  it('still validates the given fields', () => {
    expect(params.safeParse({ status: { idleAfterMs: 10 } }).success).toBe(false);
    expect(params.safeParse({ general: { language: 'fr' } }).success).toBe(false);
    expect(params.safeParse({ sandbox: { network: 'everything' } }).success).toBe(false);
  });

  it('replaces maps (providers) without injecting defaults', () => {
    const parsed = params.parse({ providers: { local: { label: 'L', kind: 'openai', baseUrl: 'http://localhost:1234/v1' } } });
    expect(parsed.providers?.local).toMatchObject({ auth: 'bearer', models: [] });
    expect(parsed).not.toHaveProperty('agents');
  });
});
