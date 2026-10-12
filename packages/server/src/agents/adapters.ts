import type { AgentAdapter, ApiStyle } from '@cocoon/protocol';

/** A model endpoint as one agent should use it: the API style it will speak, where, with which key and model. */
export interface ModelEndpoint {
  label: string;
  style: ApiStyle;
  /** Base URL in the convention of the style: ends with /v1 for chat/responses; API root (without /v1) for messages. */
  baseUrl: string;
  /** Key value for the agent (a proxy placeholder, the real key, or a dummy when no auth is needed). */
  key: string;
  /** How the key is expected: Authorization bearer token or x-api-key. */
  keyHeader: 'bearer' | 'x-api-key';
  model: string;
  /** Model limits in tokens, if known – passed on so the agent compacts in time and never exceeds the context. */
  contextWindow?: number;
  maxOutputTokens?: number;
}

/** A config file written into the sandbox before the agent starts; `json` objects are deep-merged into an existing file. */
export interface ConfigFile {
  path: string;
  json: Record<string, unknown>;
}

export interface AdapterWiring {
  env: Record<string, string>;
  args: string[];
  files: ConfigFile[];
}

/** Env var holding the endpoint key for agents that read it by name (Codex env_key, OpenCode {env:…}, Pi apiKey). */
export const LLM_KEY_ENV = 'COCOON_LLM_API_KEY';
/** Provider id used inside agent configs. */
const PROVIDER_ID = 'cocoon';

const tomlString = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * Start parameters, environment and config files that make an agent CLI use a custom model endpoint.
 * Built from each CLI's documented configuration (Codex config overrides, Claude Code env vars, OpenCode config,
 * Pi models.json, Qwen Code OpenAI env vars).
 */
export function wireEndpoint(adapter: AgentAdapter, endpoint: ModelEndpoint): AdapterWiring {
  const { label, style, baseUrl, key, model, contextWindow: ctx, maxOutputTokens: out } = endpoint;
  switch (adapter) {
    case 'claude-code':
      return {
        env: {
          ...(ctx ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(ctx) } : {}),
          ...(out ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(out) } : {}),
          ANTHROPIC_BASE_URL: baseUrl,
          [endpoint.keyHeader === 'x-api-key' ? 'ANTHROPIC_API_KEY' : 'ANTHROPIC_AUTH_TOKEN']: key,
          ANTHROPIC_MODEL: model,
          // Background tasks (titles, summaries) and model aliases must use the custom model too.
          ANTHROPIC_SMALL_FAST_MODEL: model,
          ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
          ANTHROPIC_DEFAULT_SONNET_MODEL: model,
          ANTHROPIC_DEFAULT_OPUS_MODEL: model,
          CLAUDE_CODE_SUBAGENT_MODEL: model,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        },
        args: ['--model', model],
        files: [],
      };
    case 'codex':
      return {
        env: { [LLM_KEY_ENV]: key },
        args: [
          '-c',
          `model_provider=${tomlString(PROVIDER_ID)}`,
          '-c',
          `model_providers.${PROVIDER_ID}={ name = ${tomlString(label)}, base_url = ${tomlString(baseUrl)}, env_key = ${tomlString(LLM_KEY_ENV)}, wire_api = "responses" }`,
          '-m',
          model,
          ...(ctx ? ['-c', `model_context_window=${ctx}`, '-c', `model_auto_compact_token_limit=${Math.floor(ctx * 0.8)}`] : []),
        ],
        files: [],
      };
    case 'opencode': {
      const config = {
        $schema: 'https://opencode.ai/config.json',
        autoupdate: false,
        share: 'disabled',
        provider: {
          [PROVIDER_ID]: {
            npm: style === 'messages' ? '@ai-sdk/anthropic' : '@ai-sdk/openai-compatible',
            name: label,
            options: { baseURL: style === 'messages' ? `${baseUrl}/v1` : baseUrl, apiKey: `{env:${LLM_KEY_ENV}}` },
            models: { [model]: { name: model, ...(ctx || out ? { limit: { ...(ctx ? { context: ctx } : {}), ...(out ? { output: out } : {}) } } : {}) } },
          },
        },
        model: `${PROVIDER_ID}/${model}`,
      };
      return { env: { [LLM_KEY_ENV]: key, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) }, args: ['-m', `${PROVIDER_ID}/${model}`], files: [] };
    }
    case 'pi':
      return {
        env: { [LLM_KEY_ENV]: key },
        args: ['--provider', PROVIDER_ID, '--model', model],
        files: [
          {
            path: '.pi/agent/models.json',
            json: {
              providers: {
                [PROVIDER_ID]: {
                  baseUrl,
                  api: style === 'messages' ? 'anthropic-messages' : style === 'responses' ? 'openai-responses' : 'openai-completions',
                  apiKey: LLM_KEY_ENV,
                  // Local OpenAI-compatible servers usually lack the "developer" role and max_completion_tokens.
                  ...(style === 'chat' ? { compat: { supportsDeveloperRole: false, maxTokensField: 'max_tokens' } } : {}),
                  models: [{ id: model, name: model, ...(ctx ? { contextWindow: ctx } : {}), ...(out ? { maxTokens: out } : {}) }],
                },
              },
            },
          },
        ],
      };
    case 'qwen-code':
      return {
        env: { OPENAI_BASE_URL: baseUrl, OPENAI_API_KEY: key, OPENAI_MODEL: model },
        args: ['-m', model],
        files: [
          { path: '.qwen/settings.json', json: { security: { auth: { selectedType: 'openai' } }, ...(ctx ? { model: { sessionTokenLimit: ctx } } : {}) } },
        ],
      };
    case 'gemini':
      return { env: {}, args: [], files: [] };
    default: {
      const limits: Record<string, string> = {
        ...(ctx ? { COCOON_CONTEXT_WINDOW: String(ctx) } : {}),
        ...(out ? { COCOON_MAX_OUTPUT_TOKENS: String(out) } : {}),
      };
      const wiring: AdapterWiring = style === 'messages'
        ? { env: { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: key, ANTHROPIC_MODEL: model, COCOON_MODEL: model }, args: [], files: [] }
        : { env: { OPENAI_BASE_URL: baseUrl, OPENAI_API_KEY: key, OPENAI_MODEL: model, COCOON_MODEL: model }, args: [], files: [] };
      return { ...wiring, env: { ...wiring.env, ...limits } };
    }
  }
}

/**
 * Node one-liner (run in the sandbox as the agent user) that deep-merges JSON objects into config files under $HOME.
 * Input: env COCOON_CONFIG_FILES = JSON [{ path, json }].
 */
export const MERGE_CONFIG_SCRIPT = `node -e '
const fs = require("fs"), path = require("path");
const merge = (a, b) => { for (const [k, v] of Object.entries(b)) a[k] = v && typeof v === "object" && !Array.isArray(v) && a[k] && typeof a[k] === "object" ? merge(a[k], v) : v; return a; };
for (const f of JSON.parse(process.env.COCOON_CONFIG_FILES)) {
  const file = path.join(process.env.HOME, f.path);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let cur = {}; try { cur = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  fs.writeFileSync(file, JSON.stringify(merge(cur, f.json), null, 2), { mode: 0o600 });
}'`;

/** Marks the workspace as trusted in ~/.codex/config.toml (idempotent; tables go after the top-level keys). */
export const CODEX_TRUST_SCRIPT = `mkdir -p "$HOME/.codex"; f="$HOME/.codex/config.toml"
grep -qF "[projects.\\"$WD\\"]" "$f" 2>/dev/null || printf '\\n[projects."%s"]\\ntrust_level = "trusted"\\n' "$WD" >> "$f"`;
