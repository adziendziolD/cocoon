import { z } from 'zod';

export const Language = z.enum(['de', 'en']);
export type Language = z.infer<typeof Language>;

/** Either a plain string (user-entered) or a built-in text in both languages. */
export const LocalizedText = z.union([z.string(), z.object({ de: z.string(), en: z.string() })]);
export type LocalizedText = z.infer<typeof LocalizedText>;

export const localize = (text: LocalizedText | undefined, lang: Language): string | undefined =>
  text === undefined || typeof text === 'string' ? text : text[lang];

export const SECRET_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;

export const SandboxStatus = z.enum(['creating', 'running', 'stopped', 'error', 'missing']);
export type SandboxStatus = z.infer<typeof SandboxStatus>;

/**
 * Agent status, modelled after herdr's pane states:
 * - idle:    quiet, has not worked since spawn / last input
 * - working: busy (hook report, screen output changing, or foreground process running)
 * - blocked: waiting for a human decision (permission prompt, y/n, ...)
 * - done:    finished the task it was given
 * - exited:  process ended (see exitCode)
 * - unknown: status could not be determined (e.g. sandbox unreachable)
 */
export const AgentStatus = z.enum(['idle', 'working', 'blocked', 'done', 'exited', 'unknown']);
export type AgentStatus = z.infer<typeof AgentStatus>;

/**
 * - none:   no network at all
 * - egress: internet only through the CoCoon egress proxy (domain allowlist + credential proxy)
 * - open:   unrestricted internet
 */
export const NetworkMode = z.enum(['none', 'egress', 'open']);
export type NetworkMode = z.infer<typeof NetworkMode>;

export const Resources = z.object({
  cpus: z.number().positive().max(64).optional(),
  memoryMb: z.number().int().min(128).optional(),
  pids: z.number().int().min(16).optional(),
});
export type Resources = z.infer<typeof Resources>;

/** Folder of a repository inside the workspace, relative (e.g. "api" or "services/web"). */
export const REPO_PATH = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*(\/[a-zA-Z0-9_][a-zA-Z0-9_.-]*)*$/;

export const RepoSource = z.object({
  url: z.string().min(1),
  ref: z.string().optional(),
  /** Folder inside the workspace. Default: the workspace itself for a single repository, else derived from the URL. */
  path: z.string().regex(REPO_PATH).optional(),
});
export type RepoSource = z.infer<typeof RepoSource>;

/** A repository cloned into a sandbox. path "" = the workspace folder itself. */
export const SandboxRepo = z.object({
  url: z.string(),
  ref: z.string().optional(),
  path: z.string(),
});
export type SandboxRepo = z.infer<typeof SandboxRepo>;

/** Folder name for a repository URL: last path segment without ".git". */
export function repoFolderName(url: string): string {
  const last = url.replace(/[?#].*$/, '').replace(/\/+$/, '').split(/[/:]/).pop() ?? '';
  return last.replace(/\.git$/, '').replace(/[^a-zA-Z0-9_.-]/g, '-').replace(/^[.-]+/, '') || 'repo';
}

/**
 * Where each repository goes: a single repository without a path is cloned into the workspace itself (as before),
 * otherwise every repository gets its own folder (explicit path or derived from the URL, made unique).
 */
export function planRepos(repos: RepoSource[], taken: string[] = []): SandboxRepo[] {
  if (repos.length === 1 && !repos[0]!.path && !taken.length) return [{ url: repos[0]!.url, ref: repos[0]!.ref, path: '' }];
  const used = new Set(taken);
  return repos.map((repo) => {
    let path = repo.path ?? repoFolderName(repo.url);
    if (!repo.path) for (let n = 2; used.has(path); n++) path = `${repoFolderName(repo.url)}-${n}`;
    used.add(path);
    return { url: repo.url, ref: repo.ref, path };
  });
}

export const Sandbox = z.object({
  id: z.string(),
  name: z.string(),
  image: z.string(),
  status: SandboxStatus,
  network: NetworkMode,
  runtime: z.string().nullable().default(null),
  resources: Resources,
  /** First repository (kept for older clients); see repos. */
  repo: RepoSource.optional(),
  /** All repositories in this sandbox. */
  repos: z.array(SandboxRepo).default([]),
  workdir: z.string(),
  createdAt: z.string(),
  error: z.string().optional(),
  /** Workspace this sandbox belongs to (none = unassigned). */
  workspaceId: z.string().optional(),
  /** Task this sandbox was created for (per-task sandboxes). */
  taskId: z.string().optional(),
  /** Shared services (databases, mocks) attached to this sandbox. */
  services: z.array(z.string()).default([]),
});
export type Sandbox = z.infer<typeof Sandbox>;

export const Agent = z.object({
  id: z.string(),
  sandboxId: z.string(),
  kind: z.string(),
  command: z.array(z.string()),
  prompt: z.string().optional(),
  /** API providers (ids from settings.providers) wired into this agent. */
  providers: z.array(z.string()).default([]),
  model: z.string().optional(),
  /** Context window / answer length the agent was started with (if known). */
  contextWindow: z.number().int().optional(),
  maxOutputTokens: z.number().int().optional(),
  status: AgentStatus,
  /** Where the current status came from: agent hooks (reliable) or screen heuristics. */
  statusSource: z.enum(['hook', 'heuristic']).default('heuristic'),
  exitCode: z.number().int().nullable(),
  createdAt: z.string(),
  statusChangedAt: z.string(),
});
export type Agent = z.infer<typeof Agent>;

/** Agent CLIs that can be installed into the shared toolbox. */
export const AgentTool = z.enum(['claude-code', 'codex', 'opencode', 'pi', 'qwen-code', 'gemini']);
export type AgentTool = z.infer<typeof AgentTool>;

export const AGENT_TOOLS: Record<AgentTool, { label: string; npm: string; bin: string }> = {
  'claude-code': { label: 'Claude Code', npm: '@anthropic-ai/claude-code', bin: 'claude' },
  codex: { label: 'OpenAI Codex', npm: '@openai/codex', bin: 'codex' },
  opencode: { label: 'OpenCode', npm: 'opencode-ai', bin: 'opencode' },
  pi: { label: 'Pi', npm: '@earendil-works/pi-coding-agent', bin: 'pi' },
  'qwen-code': { label: 'Qwen Code', npm: '@qwen-code/qwen-code', bin: 'qwen' },
  gemini: { label: 'Gemini CLI', npm: '@google/gemini-cli', bin: 'gemini' },
};

/**
 * Wire format of a model API:
 * - chat:      OpenAI Chat Completions (/v1/chat/completions) – what most local servers (llama.cpp, vLLM, Ollama, LM Studio) speak
 * - responses: OpenAI Responses API (/v1/responses) – required by current Codex versions
 * - messages:  Anthropic Messages API (/v1/messages) – required by Claude Code
 */
export const ApiStyle = z.enum(['chat', 'responses', 'messages']);
export type ApiStyle = z.infer<typeof ApiStyle>;

/**
 * How CoCoon wires a model provider into an agent CLI (start parameters, config files, environment).
 * `native` = API styles the agent speaks itself; `translated` = styles CoCoon can translate for it in the proxy.
 */
export const AgentAdapter = z.enum(['claude-code', 'codex', 'opencode', 'pi', 'qwen-code', 'gemini', 'generic']);
export type AgentAdapter = z.infer<typeof AgentAdapter>;

/** CLI flag selecting the model for agents running on their own credentials (no custom provider). */
export const DEFAULT_MODEL_FLAG: Partial<Record<AgentAdapter, string>> = { 'claude-code': '--model', codex: '-m', gemini: '-m' };

export const ADAPTERS: Record<AgentAdapter, { native: ApiStyle[]; translated: ApiStyle[]; customProviders: boolean }> = {
  'claude-code': { native: ['messages'], translated: ['chat'], customProviders: true },
  codex: { native: ['responses'], translated: ['chat'], customProviders: true },
  opencode: { native: ['chat', 'messages', 'responses'], translated: [], customProviders: true },
  pi: { native: ['chat', 'messages', 'responses'], translated: [], customProviders: true },
  'qwen-code': { native: ['chat'], translated: [], customProviders: true },
  gemini: { native: [], translated: [], customProviders: false },
  generic: { native: ['chat', 'messages', 'responses'], translated: [], customProviders: true },
};

const BIN_TO_TOOL: Record<string, AgentTool> = Object.fromEntries(
  Object.entries(AGENT_TOOLS).map(([tool, info]) => [info.bin, tool as AgentTool]),
);

/** How an agent CLI is launched and how its terminal output is interpreted. */
export const AgentProfile = z.object({
  label: LocalizedText.optional(),
  description: LocalizedText.optional(),
  command: z.array(z.string()).min(1),
  /** "arg": prompt is passed as CLI argument (after `promptFlag`, if set); "input": typed into the terminal after start. */
  promptMode: z.enum(['arg', 'input']).default('input'),
  /** Flag preceding the prompt for promptMode "arg", e.g. "--prompt" (OpenCode) or "-i" (Qwen Code). */
  promptFlag: z.string().optional(),
  /** How providers/models are wired into this CLI (start parameters, config files). Default: derived from the command. */
  adapter: AgentAdapter.optional(),
  /** Toolbox tool that provides the CLI (used to tell the user when it is not installed). Default: derived from the command. */
  tool: AgentTool.optional(),
  /** Names of secrets injected into the agent (e.g. API keys). Missing ones are skipped. */
  secrets: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  /** API providers (ids from settings.providers) to wire in, e.g. a custom Anthropic- or OpenAI-compatible endpoint. */
  providers: z.array(z.string()).default([]),
  /** Model name passed to the agent (overrides the provider's default model). */
  model: z.string().optional(),
  /** Context window / answer length for this agent type (override the model's detected limits). */
  contextWindow: z.number().int().min(1024).optional(),
  maxOutputTokens: z.number().int().min(256).optional(),
  /** Installs native status hooks into the agent CLI so it reports its own status. */
  hooks: z.enum(['claude-code', 'codex']).optional(),
  /** Regexes matched against the bottom of the screen. */
  workingPatterns: z.array(z.string()).default([]),
  blockedPatterns: z.array(z.string()).default([]),
  /**
   * For shell-like agents: foreground process names that mean "waiting at the prompt".
   * Any other foreground process (e.g. a running build) counts as working even if the screen is quiet.
   */
  idleForeground: z.array(z.string()).optional(),
});
export type AgentProfile = z.infer<typeof AgentProfile>;

/** Toolbox tool behind a profile (explicit, or derived from the command, e.g. "codex" → codex). */
export function profileTool(profile: Pick<AgentProfile, 'tool' | 'command'>): AgentTool | undefined {
  return profile.tool ?? BIN_TO_TOOL[profile.command[0] ?? ''];
}

/** Adapter of a profile (explicit, or derived from its tool; otherwise generic). */
export function profileAdapter(profile: Pick<AgentProfile, 'adapter' | 'tool' | 'command'>): AgentAdapter {
  return profile.adapter ?? (profileTool(profile) as AgentAdapter | undefined) ?? 'generic';
}

const commonBlocked = ['\\(y/n\\)', '\\[y/N\\]', '\\[Y/n\\]', 'Press Enter to continue'];

export const DEFAULT_PROFILES: Record<string, AgentProfile> = {
  'claude-code': AgentProfile.parse({
    label: 'Claude Code',
    description: {
      de: 'Anthropics Coding-Agent. Braucht einen Anthropic API-Key, ein Claude-Abo-Token oder einen eigenen API-Anbieter.',
      en: "Anthropic's coding agent. Needs an Anthropic API key, a Claude subscription token or a custom API provider.",
    },
    command: ['claude'],
    promptMode: 'arg',
    adapter: 'claude-code',
    tool: 'claude-code',
    secrets: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'GITHUB_TOKEN'],
    hooks: 'claude-code',
    workingPatterns: ['esc to interrupt'],
    blockedPatterns: [...commonBlocked, 'Do you want to', '❯ 1\\. Yes'],
  }),
  codex: AgentProfile.parse({
    label: 'OpenAI Codex',
    description: {
      de: 'OpenAIs Coding-Agent. Braucht einen OpenAI API-Key oder einen eigenen OpenAI-kompatiblen Anbieter.',
      en: "OpenAI's coding agent. Needs an OpenAI API key or a custom OpenAI-compatible provider.",
    },
    command: ['codex'],
    promptMode: 'arg',
    adapter: 'codex',
    tool: 'codex',
    secrets: ['OPENAI_API_KEY', 'GITHUB_TOKEN'],
    hooks: 'codex',
    workingPatterns: ['esc to interrupt'],
    blockedPatterns: [...commonBlocked, 'Allow command\\?', 'Trust this folder', 'enter continue'],
  }),
  opencode: AgentProfile.parse({
    label: 'OpenCode',
    description: {
      de: 'Offener Coding-Agent für viele Anbieter – arbeitet direkt mit lokalen Modellen (OpenAI-kompatibel, z. B. llama.cpp, Ollama, vLLM).',
      en: 'Open coding agent for many providers – works directly with local models (OpenAI-compatible, e.g. llama.cpp, Ollama, vLLM).',
    },
    command: ['opencode'],
    promptMode: 'arg',
    promptFlag: '--prompt',
    adapter: 'opencode',
    tool: 'opencode',
    secrets: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GITHUB_TOKEN'],
    workingPatterns: ['esc interrupt', 'esc to interrupt'],
    blockedPatterns: [...commonBlocked, 'Allow once', 'Permission required'],
  }),
  pi: AgentProfile.parse({
    label: 'Pi',
    description: {
      de: 'Schlanker, erweiterbarer Coding-Agent – gut für lokale Modelle (OpenAI-kompatibel) und viele Anbieter.',
      en: 'Minimal, extensible coding agent – great with local models (OpenAI-compatible) and many providers.',
    },
    command: ['pi'],
    promptMode: 'arg',
    adapter: 'pi',
    tool: 'pi',
    secrets: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GITHUB_TOKEN'],
    workingPatterns: ['Working', 'esc to interrupt'],
    blockedPatterns: commonBlocked,
  }),
  'qwen-code': AgentProfile.parse({
    label: 'Qwen Code',
    description: {
      de: 'Coding-Agent für Qwen- und andere OpenAI-kompatible Modelle – auch lokal.',
      en: 'Coding agent for Qwen and other OpenAI-compatible models – local ones too.',
    },
    command: ['qwen'],
    promptMode: 'arg',
    promptFlag: '-i',
    adapter: 'qwen-code',
    tool: 'qwen-code',
    secrets: ['OPENAI_API_KEY', 'GITHUB_TOKEN'],
    workingPatterns: ['esc to cancel', 'esc to interrupt'],
    blockedPatterns: [...commonBlocked, 'Allow execution', 'Apply this change\\?'],
  }),
  gemini: AgentProfile.parse({
    label: 'Gemini CLI',
    description: {
      de: 'Googles Coding-Agent. Braucht einen Gemini API-Key (keine eigenen Anbieter).',
      en: "Google's coding agent. Needs a Gemini API key (no custom providers).",
    },
    command: ['gemini'],
    promptMode: 'arg',
    promptFlag: '-i',
    adapter: 'gemini',
    tool: 'gemini',
    secrets: ['GEMINI_API_KEY', 'GITHUB_TOKEN'],
    workingPatterns: ['esc to cancel'],
    blockedPatterns: [...commonBlocked, 'Allow execution', 'Apply this change\\?'],
  }),
  shell: AgentProfile.parse({
    label: { de: 'Terminal (Bash)', en: 'Terminal (Bash)' },
    description: {
      de: 'Eine normale Kommandozeile in der Sandbox – zum Ausprobieren und für eigene Befehle.',
      en: 'A plain command line inside the sandbox – for trying things out and running your own commands.',
    },
    command: ['bash', '-l'],
    blockedPatterns: commonBlocked,
    idleForeground: ['bash', 'sh'],
  }),
};

export const DEFAULT_ALLOWLIST = [
  'api.anthropic.com',
  'statsig.anthropic.com',
  'claude.ai',
  'console.anthropic.com',
  'api.openai.com',
  'auth.openai.com',
  'chatgpt.com',
  'github.com',
  '*.github.com',
  '*.githubusercontent.com',
  'registry.npmjs.org',
  'pypi.org',
  'files.pythonhosted.org',
  'generativelanguage.googleapis.com',
  'models.dev',
  'opencode.ai',
];

/**
 * A custom API endpoint agents may use.
 * - anthropic: Anthropic-compatible (Claude Code) → ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN
 * - openai:    OpenAI-compatible (Codex & many tools) → OPENAI_BASE_URL + OPENAI_API_KEY
 * - http:      any HTTP API → <PREFIX>_BASE_URL (+ <PREFIX>_API_KEY); the proxy adds the auth header
 * In egress mode the agent talks to the credential proxy, which adds the real key – it never enters the sandbox.
 */
export const ProviderKind = z.enum(['anthropic', 'openai', 'http']);
export type ProviderKind = z.infer<typeof ProviderKind>;

/** Limits of a model; agents are told these so they compact history in time and don't exceed the server's context. */
export const ModelInfo = z.object({
  /** Context window in tokens (e.g. llama.cpp --ctx-size, vLLM max_model_len). */
  contextWindow: z.number().int().min(1024).optional(),
  /** Maximum tokens per answer. Default: a quarter of the context window, at most 32k. */
  maxOutputTokens: z.number().int().min(256).optional(),
  /** "detected" by the connection test or set by the "user" (user values are never overwritten). */
  source: z.enum(['detected', 'user']).optional(),
});
export type ModelInfo = z.infer<typeof ModelInfo>;

/** Default answer length for a context window: a quarter of it, between 1k and 32k tokens. */
export const defaultMaxOutput = (contextWindow: number) => Math.max(1024, Math.min(32_768, Math.floor(contextWindow / 4)));

export const ApiProvider = z.object({
  label: z.string().min(1),
  kind: ProviderKind,
  baseUrl: z.url({ protocol: /^https?$/ }),
  /** Name of the secret holding the API key (see secrets). Empty = no authentication. */
  secret: z.string().regex(SECRET_NAME).optional(),
  /** How the key is sent: Authorization: Bearer, x-api-key, a custom header, or not at all. */
  auth: z.enum(['bearer', 'x-api-key', 'header', 'none']).default('bearer'),
  /** Header name for auth = "header". */
  authHeader: z.string().optional(),
  models: z.array(z.string()).default([]),
  defaultModel: z.string().optional(),
  /** http kind: prefix of the env vars the agent gets (default: provider id in upper case). */
  envPrefix: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  /** API styles the endpoint was found to support (set by the connection test). */
  apis: z.array(ApiStyle).optional(),
  /** Per-model limits (detected by the connection test where the server reports them, editable). */
  modelInfo: z.record(z.string(), z.lazy(() => ModelInfo)).optional(),
});
export type ApiProvider = z.infer<typeof ApiProvider>;

export const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Ready-made templates the UI offers when adding a provider. */
export const PROVIDER_PRESETS: Record<string, { provider: ApiProvider; description: LocalizedText }> = {
  openrouter: {
    provider: ApiProvider.parse({ label: 'OpenRouter', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', secret: 'OPENROUTER_API_KEY' }),
    description: { de: 'Hunderte Modelle über einen OpenAI-kompatiblen Zugang.', en: 'Hundreds of models through one OpenAI-compatible endpoint.' },
  },
  ollama: {
    provider: ApiProvider.parse({ label: 'Ollama (lokal)', kind: 'openai', baseUrl: 'http://localhost:11434/v1', auth: 'none' }),
    description: { de: 'Lokale Modelle, die auf dem Server selbst laufen.', en: 'Local models running on the server itself.' },
  },
  litellm: {
    provider: ApiProvider.parse({ label: 'LiteLLM-Gateway', kind: 'anthropic', baseUrl: 'http://localhost:4000', secret: 'LITELLM_API_KEY', auth: 'bearer' }),
    description: { de: 'Eigenes Gateway, das viele Anbieter bündelt (Anthropic-kompatibel).', en: 'Your own gateway bundling many providers (Anthropic-compatible).' },
  },
  deepseek: {
    provider: ApiProvider.parse({
      label: 'DeepSeek',
      kind: 'anthropic',
      baseUrl: 'https://api.deepseek.com/anthropic',
      secret: 'DEEPSEEK_API_KEY',
      auth: 'x-api-key',
    }),
    description: { de: 'DeepSeek-Modelle über eine Anthropic-kompatible API (für Claude Code).', en: 'DeepSeek models via an Anthropic-compatible API (for Claude Code).' },
  },
  groq: {
    provider: ApiProvider.parse({ label: 'Groq', kind: 'openai', baseUrl: 'https://api.groq.com/openai/v1', secret: 'GROQ_API_KEY' }),
    description: { de: 'Sehr schnelle offene Modelle, OpenAI-kompatibel.', en: 'Very fast open models, OpenAI-compatible.' },
  },
  mistral: {
    provider: ApiProvider.parse({ label: 'Mistral', kind: 'openai', baseUrl: 'https://api.mistral.ai/v1', secret: 'MISTRAL_API_KEY' }),
    description: { de: 'Modelle von Mistral AI, OpenAI-kompatibel.', en: 'Mistral AI models, OpenAI-compatible.' },
  },
  'custom-anthropic': {
    provider: ApiProvider.parse({ label: 'Eigene Anthropic-kompatible API', kind: 'anthropic', baseUrl: 'https://example.com', secret: 'CUSTOM_ANTHROPIC_KEY', auth: 'x-api-key' }),
    description: { de: 'Eigener Endpunkt im Format der Anthropic-API (z. B. Firmen-Gateway, Bedrock-Proxy).', en: 'Your own endpoint speaking the Anthropic API (e.g. company gateway, Bedrock proxy).' },
  },
  'custom-openai': {
    provider: ApiProvider.parse({ label: 'Eigene OpenAI-kompatible API', kind: 'openai', baseUrl: 'https://example.com/v1', secret: 'CUSTOM_OPENAI_KEY' }),
    description: { de: 'Eigener Endpunkt im Format der OpenAI-API (z. B. vLLM, Azure-Gateway).', en: 'Your own endpoint speaking the OpenAI API (e.g. vLLM, Azure gateway).' },
  },
  'custom-http': {
    provider: ApiProvider.parse({ label: 'Eigene HTTP-API', kind: 'http', baseUrl: 'https://api.example.com', secret: 'MY_API_KEY', envPrefix: 'MY_API' }),
    description: {
      de: 'Beliebige REST-API (z. B. firmenintern). Der Agent bekommt MY_API_BASE_URL; den Schlüssel fügt CoCoon automatisch hinzu.',
      en: 'Any REST API (e.g. internal). The agent gets MY_API_BASE_URL; CoCoon adds the key automatically.',
    },
  },
};

/**
 * A workflow runs a task through several stages, each a fresh agent in the task's sandbox.
 * Prompt templates may use {{task.title}}, {{task.description}}, {{task}} (both), {{previous.output}}
 * (last screen of the previous stage's agent), {{diff}} (changed files) and {{feedback}} (review feedback).
 */
export const WorkflowStage = z.object({
  name: LocalizedText,
  /** Agent type (key of settings.agents). */
  agentKind: z.string(),
  prompt: z.string().min(1),
  /** Wait for a human approval after this stage before continuing (the last stage always ends in review). */
  approval: z.boolean().default(false),
});
export type WorkflowStage = z.infer<typeof WorkflowStage>;

export const Workflow = z.object({
  label: LocalizedText,
  description: LocalizedText.optional(),
  stages: z.array(WorkflowStage).min(1),
});
export type Workflow = z.infer<typeof Workflow>;

export const WORKFLOW_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

export const DEFAULT_WORKFLOWS: Record<string, Workflow> = {
  'plan-build-review': Workflow.parse({
    label: { de: 'Planen → Umsetzen → Prüfen', en: 'Plan → Build → Review' },
    description: {
      de: 'Ein Agent schreibt zuerst einen Plan, den du freigibst. Dann setzt ein Agent ihn um, ein dritter prüft das Ergebnis.',
      en: 'One agent writes a plan for you to approve, another implements it, a third reviews the result.',
    },
    stages: [
      {
        name: { de: 'Planen', en: 'Plan' },
        agentKind: 'claude-code',
        prompt:
          'Read the project and write a short, concrete implementation plan for this task. Do not change any code yet. Save the plan to PLAN.md.\n\nTask:\n{{task}}',
        approval: true,
      },
      {
        name: { de: 'Umsetzen', en: 'Build' },
        agentKind: 'claude-code',
        prompt: 'Implement the plan in PLAN.md for this task. Run the tests if there are any.\n\nTask:\n{{task}}{{feedback}}',
      },
      {
        name: { de: 'Prüfen', en: 'Review' },
        agentKind: 'claude-code',
        prompt:
          'Review the changes made for this task (changed files: {{diff}}). Check correctness, run the tests, fix obvious problems and summarise what you found.\n\nTask:\n{{task}}',
      },
    ],
  }),
  'build-review': Workflow.parse({
    label: { de: 'Umsetzen → Prüfen', en: 'Build → Review' },
    description: { de: 'Ein Agent setzt die Aufgabe um, ein zweiter prüft das Ergebnis.', en: 'One agent implements the task, a second one reviews it.' },
    stages: [
      { name: { de: 'Umsetzen', en: 'Build' }, agentKind: 'claude-code', prompt: '{{task}}{{feedback}}' },
      {
        name: { de: 'Prüfen', en: 'Review' },
        agentKind: 'claude-code',
        prompt: 'Review the changes made for this task (changed files: {{diff}}). Run the tests, fix obvious problems and summarise.\n\nTask:\n{{task}}',
      },
    ],
  }),
};

export const NotificationEvent = z.enum(['agent.blocked', 'task.review', 'task.failed', 'task.done']);
export type NotificationEvent = z.infer<typeof NotificationEvent>;

export const Settings = z.object({
  general: z
    .object({
      /** Default language for server messages when the client does not send one. */
      language: Language.default('en'),
      /** Set when the onboarding wizard was completed or skipped; the UI shows the wizard until then. */
      onboardingCompletedAt: z.string().optional(),
      /** Built-in agent types already offered once (new built-ins are added to existing installs, deleted ones stay deleted). */
      defaultProfilesSeen: z.array(z.string()).optional(),
    })
    .prefault({}),
  providers: z.record(z.string().regex(PROVIDER_ID), ApiProvider).default({}),
  sandbox: z
    .object({
      image: z.string().default('cocoon/sandbox:latest'),
      network: NetworkMode.default('egress'),
      resources: Resources.default({ cpus: 2, memoryMb: 4096, pids: 1024 }),
      /** OCI runtime: null = Docker default (runc), "runsc" = gVisor, "kata-fc" = Kata/Firecracker microVM. */
      runtime: z.string().nullable().default(null),
      maxSandboxes: z.number().int().positive().default(20),
      workdir: z.string().default('/workspace'),
    })
    .prefault({}),
  egress: z
    .object({
      /** Domains reachable from sandboxes in "egress" mode. "*.example.com" matches subdomains. */
      allowlist: z.array(z.string()).default(DEFAULT_ALLOWLIST),
      /** Keep API keys out of sandboxes: agents talk to the proxy, which adds the real key. */
      credentialProxy: z.boolean().default(true),
    })
    .prefault({}),
  agents: z.record(z.string(), AgentProfile).default(DEFAULT_PROFILES),
  status: z
    .object({
      pollIntervalMs: z.number().int().min(200).default(1000),
      idleAfterMs: z.number().int().min(500).default(2500),
    })
    .prefault({}),
  git: z
    .object({
      authorName: z.string().default('cocoon-agent'),
      authorEmail: z.string().default('agent@cocoon.local'),
    })
    .prefault({}),
  workflows: z.record(z.string().regex(WORKFLOW_ID), Workflow).default(DEFAULT_WORKFLOWS),
  notifications: z
    .object({
      /** Incoming webhook (Slack, Discord via /slack, Mattermost, Teams workflows, or any JSON endpoint). Receives { text, event, ... }. */
      webhookUrl: z.url().nullable().optional(),
      events: z.array(NotificationEvent).default(['agent.blocked', 'task.review', 'task.failed']),
    })
    .prefault({}),
});
export type Settings = z.infer<typeof Settings>;

/** Secrets the UI explains to users. Custom names are allowed as well. */
export const KNOWN_SECRETS: Record<string, { label: LocalizedText; description: LocalizedText; helpUrl?: string }> = {
  ANTHROPIC_API_KEY: {
    label: { de: 'Anthropic API-Key', en: 'Anthropic API key' },
    description: {
      de: 'Für Claude Code. Beginnt mit „sk-ant-“. Erstellen unter console.anthropic.com → API Keys.',
      en: 'For Claude Code. Starts with "sk-ant-". Create one at console.anthropic.com → API Keys.',
    },
    helpUrl: 'https://console.anthropic.com/settings/keys',
  },
  CLAUDE_CODE_OAUTH_TOKEN: {
    label: { de: 'Claude-Abo-Token', en: 'Claude subscription token' },
    description: {
      de: 'Alternative zum API-Key, wenn du ein Claude Pro/Max-Abo hast. Erzeugen mit „claude setup-token“ auf deinem Rechner.',
      en: 'Alternative to an API key if you have a Claude Pro/Max subscription. Create it with "claude setup-token" on your computer.',
    },
  },
  OPENAI_API_KEY: {
    label: { de: 'OpenAI API-Key', en: 'OpenAI API key' },
    description: {
      de: 'Für OpenAI Codex. Beginnt mit „sk-“. Erstellen unter platform.openai.com → API keys.',
      en: 'For OpenAI Codex. Starts with "sk-". Create one at platform.openai.com → API keys.',
    },
    helpUrl: 'https://platform.openai.com/api-keys',
  },
  GEMINI_API_KEY: {
    label: { de: 'Gemini API-Key', en: 'Gemini API key' },
    description: {
      de: 'Für die Gemini CLI. Erstellen in Google AI Studio → Get API key.',
      en: 'For Gemini CLI. Create one in Google AI Studio → Get API key.',
    },
    helpUrl: 'https://aistudio.google.com/apikey',
  },
  GITHUB_TOKEN: {
    label: { de: 'GitHub-Token', en: 'GitHub token' },
    description: {
      de: 'Optional. Für private Repositories, zum Hochladen (Push) von Änderungen und zum Erstellen von Pull Requests. Rechte: „Contents“ und „Pull requests“ (lesen & schreiben).',
      en: 'Optional. For private repositories, pushing changes and creating pull requests. Permissions: "Contents" and "Pull requests" (read & write).',
    },
    helpUrl: 'https://github.com/settings/personal-access-tokens/new',
  },
};

export const SecretInfo = z.object({
  name: z.string(),
  set: z.boolean(),
  /** Masked value, e.g. "sk-ant-…a1b2". */
  preview: z.string().optional(),
  source: z.enum(['store', 'env']).optional(),
  updatedAt: z.string().optional(),
});
export type SecretInfo = z.infer<typeof SecretInfo>;

export const TokenInfo = z.object({
  id: z.string(),
  name: z.string(),
  preview: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().optional(),
});
export type TokenInfo = z.infer<typeof TokenInfo>;

export const ActivityEntry = z.object({
  id: z.number(),
  at: z.string(),
  level: z.enum(['info', 'warn', 'error']),
  /** Rendered in the language of the requesting client. */
  message: z.string(),
  /** Message key and parameters, for clients that want to render the text themselves. */
  key: z.string().optional(),
  params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  sandboxId: z.string().optional(),
  agentId: z.string().optional(),
});
export type ActivityEntry = z.infer<typeof ActivityEntry>;

/**
 * - sandbox: base image for sandboxes (container drivers)
 * - proxy:   egress proxy image (container drivers)
 * - agents:  the shared agent toolbox (Claude Code, Codex CLIs) mounted read-only into every sandbox
 */
export const ImageKind = z.enum(['sandbox', 'proxy', 'agents']);
export type ImageKind = z.infer<typeof ImageKind>;


/** Isolation backend of the server. */
export const DriverKind = z.enum(['docker', 'podman', 'bwrap']);
export type DriverKind = z.infer<typeof DriverKind>;

export const DriverCapabilities = z.object({
  /** Uses container images (sandbox/proxy images can be built). */
  images: z.boolean(),
  /** CPU / memory / process limits are enforced. */
  resourceLimits: z.boolean(),
  /** "Restricted" network mode is enforced (otherwise the proxy is only configured, not mandatory). */
  enforcedEgress: z.boolean(),
  /** Alternative OCI runtimes (gVisor, Kata) can be selected. */
  runtimes: z.boolean(),
});
export type DriverCapabilities = z.infer<typeof DriverCapabilities>;

export const ImageInfo = z.object({
  kind: ImageKind,
  ref: z.string(),
  exists: z.boolean(),
  createdAt: z.string().optional(),
  sizeMb: z.number().optional(),
  building: z.boolean(),
  /** agents kind: installed tools. */
  tools: z.array(z.string()).optional(),
  /** agents kind: installed version per npm package. */
  versions: z.record(z.string(), z.string()).optional(),
});
export type ImageInfo = z.infer<typeof ImageInfo>;

// ── ports ───────────────────────────────────────────────────────────────────

/** preview: only for people logged in to CoCoon (through cocoond) · shared: reachable on the host's network. */
export const PortMode = z.enum(['preview', 'shared']);
export type PortMode = z.infer<typeof PortMode>;

/** A TCP port inside a sandbox: detected because something listens on it, and/or opened to the outside. */
export const SandboxPort = z.object({
  port: z.number().int(),
  /** Something listens on the port right now. */
  listening: z.boolean(),
  /** all = 0.0.0.0 / :: (reachable from outside the sandbox) · loopback = only 127.0.0.1 / ::1 (not reachable through the gateway). */
  address: z.enum(['all', 'loopback']).optional(),
  opened: z
    .object({
      mode: PortMode,
      name: z.string().optional(),
      openedAt: z.string(),
      /** Port on the CoCoon host the gateway forwards. */
      hostPort: z.number().int(),
      /** shared: address on the host's network, e.g. http://192.168.1.20:7550. */
      url: z.string().optional(),
    })
    .optional(),
});
export type SandboxPort = z.infer<typeof SandboxPort>;

// ── updates ─────────────────────────────────────────────────────────────────

/** What an update covers: CoCoon itself, the agent CLIs in the toolbox, CoCoon's own container images. */
export const UpdateTarget = z.enum(['cocoon', 'tools', 'images']);
export type UpdateTarget = z.infer<typeof UpdateTarget>;

/** current = up to date, outdated = newer version available, missing = not installed / built, unknown = could not be determined. */
export const UpdateState = z.enum(['current', 'outdated', 'missing', 'unknown']);
export type UpdateState = z.infer<typeof UpdateState>;

export const CocoonUpdateInfo = z.object({
  state: UpdateState,
  version: z.string(),
  commit: z.string().optional(),
  branch: z.string().optional(),
  /** Upstream branch the update comes from, e.g. "origin/main". */
  upstream: z.string().optional(),
  latestVersion: z.string().optional(),
  latestCommit: z.string().optional(),
  /** Commits on the upstream branch that are not installed yet / local commits not on the upstream branch. */
  behind: z.number().int(),
  ahead: z.number().int(),
  /** Newest first, at most 30. */
  changes: z.array(z.object({ commit: z.string(), subject: z.string() })),
  /**
   * Why CoCoon cannot update itself: notGit = not installed from a git clone, noUpstream = branch tracks no remote branch,
   * dirty = tracked files were changed locally, diverged = local commits and new upstream commits.
   */
  blocked: z.enum(['notGit', 'noUpstream', 'dirty', 'diverged']).optional(),
  /** The check itself failed (e.g. "git fetch" without network). */
  error: z.string().optional(),
});
export type CocoonUpdateInfo = z.infer<typeof CocoonUpdateInfo>;

export const ToolUpdateInfo = z.object({
  tool: AgentTool,
  label: z.string(),
  npm: z.string(),
  installed: z.string().optional(),
  latest: z.string().optional(),
  state: UpdateState,
  error: z.string().optional(),
});
export type ToolUpdateInfo = z.infer<typeof ToolUpdateInfo>;

export const ImageUpdateInfo = z.object({
  kind: z.enum(['sandbox', 'proxy']),
  ref: z.string(),
  state: UpdateState,
  /**
   * definition = CoCoon's Dockerfile changed since the build, base = a newer base image (e.g. node) was published,
   * untracked = built before CoCoon recorded build information, custom = a custom image CoCoon does not manage.
   */
  reason: z.enum(['definition', 'base', 'untracked', 'custom']).optional(),
  /** Base image of the Dockerfile, e.g. docker.io/library/node:24-bookworm-slim. */
  base: z.string().optional(),
  builtAt: z.string().optional(),
  /** sandbox: variant of the last build (slim or full). */
  variant: z.enum(['slim', 'full']).optional(),
});
export type ImageUpdateInfo = z.infer<typeof ImageUpdateInfo>;

export const UpdateStatus = z.object({
  checkedAt: z.string(),
  cocoon: CocoonUpdateInfo,
  /** Installed agent CLIs (empty when the toolbox is not installed). */
  tools: z.array(ToolUpdateInfo),
  /** CoCoon's container images (empty with bubblewrap). */
  images: z.array(ImageUpdateInfo),
  /** Targets with something to update. */
  available: z.array(UpdateTarget),
  /** An update is running right now. */
  running: z.boolean(),
  /** CoCoon was updated and needs a restart to use the new version. */
  restartRequired: z.boolean(),
  /** The server restarts itself (it runs under CoCoon's supervisor, e.g. via "pnpm start" or systemd). */
  canRestart: z.boolean(),
  /** The server is restarting right now. */
  restarting: z.boolean(),
});
export type UpdateStatus = z.infer<typeof UpdateStatus>;

export const SetupStep = z.object({
  id: z.enum(['docker', 'image', 'proxy', 'credentials', 'sandbox', 'agent']),
  title: z.string(),
  done: z.boolean(),
  detail: z.string().optional(),
});
export type SetupStep = z.infer<typeof SetupStep>;

export const FileEntry = z.object({
  name: z.string(),
  type: z.enum(['file', 'dir', 'symlink', 'other']),
  size: z.number(),
  modifiedAt: z.string(),
});
export type FileEntry = z.infer<typeof FileEntry>;

export const GitFileStatus = z.object({ path: z.string(), status: z.string() });

export const DeniedConnection = z.object({
  at: z.string(),
  sandboxId: z.string().optional(),
  host: z.string(),
  port: z.number().optional(),
});
export type DeniedConnection = z.infer<typeof DeniedConnection>;
