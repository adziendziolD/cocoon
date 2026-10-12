import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentAdapter } from '@cocoon/protocol';
import { CODEX_TRUST_SCRIPT, LLM_KEY_ENV, MERGE_CONFIG_SCRIPT, wireEndpoint, type ModelEndpoint } from './adapters.ts';

const endpoint = (overrides: Partial<ModelEndpoint> = {}): ModelEndpoint => ({
  label: 'Local llama',
  style: 'chat',
  baseUrl: 'http://cocoon-proxy:8080/p-llama/v1',
  key: 'cocoon-placeholder-key',
  keyHeader: 'bearer',
  model: 'qwen3-coder-30b',
  ...overrides,
});

const ADAPTERS: AgentAdapter[] = ['claude-code', 'codex', 'opencode', 'pi', 'qwen-code', 'gemini', 'generic'];

describe('wireEndpoint', () => {
  it.each(ADAPTERS.filter((a) => a !== 'gemini'))('%s always gets the requested model', (adapter) => {
    const wiring = wireEndpoint(adapter, endpoint({ model: 'my-model' }));
    const text = JSON.stringify(wiring);
    expect(text).toContain('my-model');
  });

  describe('claude-code', () => {
    it('sets base URL, model aliases and the limits as env vars', () => {
      const wiring = wireEndpoint(
        'claude-code',
        endpoint({ style: 'messages', baseUrl: 'http://proxy/p-x', contextWindow: 131072, maxOutputTokens: 16384 }),
      );
      expect(wiring.args).toEqual(['--model', 'qwen3-coder-30b']);
      expect(wiring.files).toEqual([]);
      expect(wiring.env).toEqual({
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: '131072',
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: '16384',
        ANTHROPIC_BASE_URL: 'http://proxy/p-x',
        ANTHROPIC_AUTH_TOKEN: 'cocoon-placeholder-key',
        ANTHROPIC_MODEL: 'qwen3-coder-30b',
        ANTHROPIC_SMALL_FAST_MODEL: 'qwen3-coder-30b',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'qwen3-coder-30b',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'qwen3-coder-30b',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'qwen3-coder-30b',
        CLAUDE_CODE_SUBAGENT_MODEL: 'qwen3-coder-30b',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      });
    });

    it('uses ANTHROPIC_API_KEY for x-api-key endpoints', () => {
      const { env } = wireEndpoint('claude-code', endpoint({ style: 'messages', keyHeader: 'x-api-key', key: 'sk-ant-xyz' }));
      expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-xyz');
      expect(env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN');
    });

    it('omits limit env vars when the limits are unknown', () => {
      const { env } = wireEndpoint('claude-code', endpoint({ style: 'messages' }));
      expect(env).not.toHaveProperty('CLAUDE_CODE_AUTO_COMPACT_WINDOW');
      expect(env).not.toHaveProperty('CLAUDE_CODE_MAX_OUTPUT_TOKENS');
    });
  });

  describe('codex', () => {
    it('registers a responses provider with the key read from an env var', () => {
      const wiring = wireEndpoint('codex', endpoint({ style: 'responses' }));
      expect(wiring.env).toEqual({ [LLM_KEY_ENV]: 'cocoon-placeholder-key' });
      expect(wiring.files).toEqual([]);
      expect(wiring.args).toEqual([
        '-c',
        'model_provider="cocoon"',
        '-c',
        'model_providers.cocoon={ name = "Local llama", base_url = "http://cocoon-proxy:8080/p-llama/v1", env_key = "COCOON_LLM_API_KEY", wire_api = "responses" }',
        '-m',
        'qwen3-coder-30b',
      ]);
    });

    it('passes the context window and an auto-compact limit of 80 %', () => {
      const { args } = wireEndpoint('codex', endpoint({ style: 'responses', contextWindow: 32768 }));
      expect(args.slice(-4)).toEqual(['-c', 'model_context_window=32768', '-c', 'model_auto_compact_token_limit=26214']);
    });

    it('rounds the auto-compact limit down', () => {
      const { args } = wireEndpoint('codex', endpoint({ contextWindow: 10001 }));
      expect(args).toContain('model_auto_compact_token_limit=8000');
    });

    it('escapes quotes and backslashes in TOML strings', () => {
      const { args } = wireEndpoint('codex', endpoint({ label: 'My "fast" \\ model' }));
      expect(args[3]).toContain('name = "My \\"fast\\" \\\\ model"');
    });
  });

  describe('opencode', () => {
    const configOf = (wiring: ReturnType<typeof wireEndpoint>) => JSON.parse(wiring.env.OPENCODE_CONFIG_CONTENT!);

    it('uses the OpenAI-compatible SDK for chat endpoints and passes the limits', () => {
      const wiring = wireEndpoint('opencode', endpoint({ contextWindow: 65536, maxOutputTokens: 8192 }));
      expect(wiring.args).toEqual(['-m', 'cocoon/qwen3-coder-30b']);
      expect(wiring.env[LLM_KEY_ENV]).toBe('cocoon-placeholder-key');
      const config = configOf(wiring);
      expect(config.model).toBe('cocoon/qwen3-coder-30b');
      expect(config.provider.cocoon).toEqual({
        npm: '@ai-sdk/openai-compatible',
        name: 'Local llama',
        options: { baseURL: 'http://cocoon-proxy:8080/p-llama/v1', apiKey: '{env:COCOON_LLM_API_KEY}' },
        models: { 'qwen3-coder-30b': { name: 'qwen3-coder-30b', limit: { context: 65536, output: 8192 } } },
      });
      // the key value itself never ends up in the config
      expect(wiring.env.OPENCODE_CONFIG_CONTENT).not.toContain('cocoon-placeholder-key');
    });

    it('uses the Anthropic SDK with /v1 appended for messages endpoints', () => {
      const config = configOf(wireEndpoint('opencode', endpoint({ style: 'messages', baseUrl: 'http://proxy/p-x' })));
      expect(config.provider.cocoon.npm).toBe('@ai-sdk/anthropic');
      expect(config.provider.cocoon.options.baseURL).toBe('http://proxy/p-x/v1');
    });

    it('sets only the known limits', () => {
      expect(configOf(wireEndpoint('opencode', endpoint())).provider.cocoon.models['qwen3-coder-30b']).toEqual({ name: 'qwen3-coder-30b' });
      expect(configOf(wireEndpoint('opencode', endpoint({ contextWindow: 4096 }))).provider.cocoon.models['qwen3-coder-30b'].limit).toEqual({ context: 4096 });
      expect(configOf(wireEndpoint('opencode', endpoint({ maxOutputTokens: 512 }))).provider.cocoon.models['qwen3-coder-30b'].limit).toEqual({ output: 512 });
    });
  });

  describe('pi', () => {
    const provider = (wiring: ReturnType<typeof wireEndpoint>) => (wiring.files[0]!.json as any).providers.cocoon;

    it('writes models.json with chat compat settings and limits', () => {
      const wiring = wireEndpoint('pi', endpoint({ contextWindow: 131072, maxOutputTokens: 32768 }));
      expect(wiring.args).toEqual(['--provider', 'cocoon', '--model', 'qwen3-coder-30b']);
      expect(wiring.env).toEqual({ [LLM_KEY_ENV]: 'cocoon-placeholder-key' });
      expect(wiring.files.map((f) => f.path)).toEqual(['.pi/agent/models.json']);
      expect(provider(wiring)).toEqual({
        baseUrl: 'http://cocoon-proxy:8080/p-llama/v1',
        api: 'openai-completions',
        apiKey: LLM_KEY_ENV,
        compat: { supportsDeveloperRole: false, maxTokensField: 'max_tokens' },
        models: [{ id: 'qwen3-coder-30b', name: 'qwen3-coder-30b', contextWindow: 131072, maxTokens: 32768 }],
      });
    });

    it.each([
      ['responses', 'openai-responses'],
      ['messages', 'anthropic-messages'],
    ] as const)('maps style %s to api %s without chat compat', (style, api) => {
      const p = provider(wireEndpoint('pi', endpoint({ style })));
      expect(p.api).toBe(api);
      expect(p).not.toHaveProperty('compat');
      expect(p.models).toEqual([{ id: 'qwen3-coder-30b', name: 'qwen3-coder-30b' }]);
    });
  });

  describe('qwen-code', () => {
    it('uses OpenAI env vars and sets sessionTokenLimit from the context window', () => {
      const wiring = wireEndpoint('qwen-code', endpoint({ contextWindow: 65536 }));
      expect(wiring.env).toEqual({ OPENAI_BASE_URL: 'http://cocoon-proxy:8080/p-llama/v1', OPENAI_API_KEY: 'cocoon-placeholder-key', OPENAI_MODEL: 'qwen3-coder-30b' });
      expect(wiring.args).toEqual(['-m', 'qwen3-coder-30b']);
      expect(wiring.files).toEqual([
        { path: '.qwen/settings.json', json: { security: { auth: { selectedType: 'openai' } }, model: { sessionTokenLimit: 65536 } } },
      ]);
    });

    it('leaves sessionTokenLimit out when unknown', () => {
      expect(wireEndpoint('qwen-code', endpoint()).files[0]!.json).toEqual({ security: { auth: { selectedType: 'openai' } } });
    });
  });

  it('gemini gets no wiring (custom endpoints are not supported)', () => {
    expect(wireEndpoint('gemini', endpoint({ contextWindow: 1000 }))).toEqual({ env: {}, args: [], files: [] });
  });

  describe('generic', () => {
    it('gets OpenAI-style env plus COCOON_* for chat/responses endpoints', () => {
      expect(wireEndpoint('generic', endpoint({ contextWindow: 8192, maxOutputTokens: 2048 }))).toEqual({
        env: {
          OPENAI_BASE_URL: 'http://cocoon-proxy:8080/p-llama/v1',
          OPENAI_API_KEY: 'cocoon-placeholder-key',
          OPENAI_MODEL: 'qwen3-coder-30b',
          COCOON_MODEL: 'qwen3-coder-30b',
          COCOON_CONTEXT_WINDOW: '8192',
          COCOON_MAX_OUTPUT_TOKENS: '2048',
        },
        args: [],
        files: [],
      });
    });

    it('gets Anthropic-style env for messages endpoints and no limits when unknown', () => {
      expect(wireEndpoint('generic', endpoint({ style: 'messages', baseUrl: 'http://proxy/p-x' })).env).toEqual({
        ANTHROPIC_BASE_URL: 'http://proxy/p-x',
        ANTHROPIC_AUTH_TOKEN: 'cocoon-placeholder-key',
        ANTHROPIC_MODEL: 'qwen3-coder-30b',
        COCOON_MODEL: 'qwen3-coder-30b',
      });
    });
  });
});

// ── shell scripts run inside the sandbox ──────────────────────────────────────

/** `node -e '<code>'` → <code> (the script is single-quoted for sh; the code itself contains no single quotes). */
const mergeCode = MERGE_CONFIG_SCRIPT.replace(/^node -e '/, '').replace(/'$/, '');

describe('MERGE_CONFIG_SCRIPT', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cocoon-merge-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const run = (files: unknown) =>
    execFileSync(process.execPath, ['-e', mergeCode], { env: { HOME: home, COCOON_CONFIG_FILES: JSON.stringify(files) } });

  it('is a single-quoted node one-liner without inner single quotes', () => {
    expect(MERGE_CONFIG_SCRIPT.startsWith("node -e '")).toBe(true);
    expect(mergeCode).not.toContain("'");
  });

  it('creates missing files and directories with mode 0600', () => {
    run([{ path: '.qwen/settings.json', json: { a: 1 } }]);
    const file = join(home, '.qwen/settings.json');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ a: 1 });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('deep-merges objects into an existing file, replacing arrays and scalars', () => {
    mkdirSync(join(home, '.pi/agent'), { recursive: true });
    writeFileSync(
      join(home, '.pi/agent/models.json'),
      JSON.stringify({ theme: 'dark', providers: { other: { baseUrl: 'x' }, cocoon: { api: 'old', models: [{ id: 'a' }, { id: 'b' }] } } }),
    );
    run([{ path: '.pi/agent/models.json', json: { providers: { cocoon: { api: 'openai-completions', models: [{ id: 'new' }] } } } }]);
    expect(JSON.parse(readFileSync(join(home, '.pi/agent/models.json'), 'utf8'))).toEqual({
      theme: 'dark',
      providers: { other: { baseUrl: 'x' }, cocoon: { api: 'openai-completions', models: [{ id: 'new' }] } },
    });
  });

  it('replaces an unparsable file and handles several files', () => {
    writeFileSync(join(home, 'broken.json'), '{nope');
    run([
      { path: 'broken.json', json: { fixed: true } },
      { path: 'deep/er/x.json', json: { y: null } },
    ]);
    expect(JSON.parse(readFileSync(join(home, 'broken.json'), 'utf8'))).toEqual({ fixed: true });
    expect(JSON.parse(readFileSync(join(home, 'deep/er/x.json'), 'utf8'))).toEqual({ y: null });
  });

  it('runs through sh exactly as written', () => {
    const res = spawnSync('sh', ['-c', MERGE_CONFIG_SCRIPT], {
      env: { PATH: process.env.PATH, HOME: home, COCOON_CONFIG_FILES: JSON.stringify([{ path: 'a.json', json: { ok: 1 } }]) },
    });
    expect(res.status).toBe(0);
    expect(JSON.parse(readFileSync(join(home, 'a.json'), 'utf8'))).toEqual({ ok: 1 });
  });
});

describe('CODEX_TRUST_SCRIPT', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cocoon-trust-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const run = (wd: string) => {
    const res = spawnSync('sh', ['-c', CODEX_TRUST_SCRIPT], { env: { PATH: process.env.PATH, HOME: home, WD: wd } });
    expect(res.status).toBe(0);
    return readFileSync(join(home, '.codex/config.toml'), 'utf8');
  };

  it('appends a trusted project table after existing top-level keys', () => {
    mkdirSync(join(home, '.codex'));
    writeFileSync(join(home, '.codex/config.toml'), 'model = "o3"\n');
    expect(run('/workspace/repo')).toBe('model = "o3"\n\n[projects."/workspace/repo"]\ntrust_level = "trusted"\n');
  });

  it('is idempotent and adds other workspaces separately', () => {
    run('/workspace/a');
    run('/workspace/a');
    const content = run('/workspace/b');
    expect(content.match(/\[projects\."\/workspace\/a"\]/g)).toHaveLength(1);
    expect(content).toContain('[projects."/workspace/b"]');
  });
});
