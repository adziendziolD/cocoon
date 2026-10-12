import {
  ADAPTERS,
  AGENT_TOOLS,
  AgentTool,
  DEFAULT_PROFILES,
  profileAdapter,
  profileTool,
  type AgentAdapter,
  type AgentProfile,
  type ApiProvider,
  type ApiStyle,
  type ImageInfo,
} from '@cocoon/protocol';

/**
 * Which agents can use which API provider, and whether an agent's CLI is installed in the toolbox.
 *
 * - native:       the agent speaks one of the provider's APIs itself
 * - translated:   CoCoon translates between the provider's API and the agent's (e.g. Chat ↔ Responses for Codex)
 * - incompatible: no common API (or the agent does not support custom providers at all)
 * - unknown:      the provider's APIs were not detected yet – run the connection test
 */
export type Compat = 'native' | 'translated' | 'incompatible' | 'unknown';

export const API_STYLES: ApiStyle[] = ['chat', 'responses', 'messages'];

/** Agent CLIs in the order the UI lists them. */
export const TOOL_ORDER: AgentTool[] = AgentTool.options;

/** Built-in agent types that run one of the toolbox CLIs (key = tool name = adapter name). */
export const AGENT_BASES = TOOL_ORDER.filter((tool) => !!DEFAULT_PROFILES[tool]);

/** True for providers that give access to an AI model (Anthropic/OpenAI-compatible); plain HTTP APIs are only extra APIs. */
export const isModelProvider = (p: Pick<ApiProvider, 'kind'> | undefined): p is ApiProvider => !!p && p.kind !== 'http';

/** Detected API styles of a provider (undefined/empty = not tested yet). */
export function providerApis(p: Pick<ApiProvider, 'apis'>): ApiStyle[] | undefined {
  return p.apis && p.apis.length > 0 ? p.apis : undefined;
}

/** Compatibility of an adapter with a set of API styles (undefined = unknown). */
export function apisCompat(adapter: AgentAdapter, apis: ApiStyle[] | undefined): Compat {
  const a = ADAPTERS[adapter];
  if (!a.customProviders) return 'incompatible';
  if (!apis) return 'unknown';
  if (a.native.some((s) => apis.includes(s))) return 'native';
  if (a.translated.some((s) => apis.includes(s))) return 'translated';
  return 'incompatible';
}

export function providerCompat(adapter: AgentAdapter, provider: Pick<ApiProvider, 'apis' | 'kind'>): Compat {
  if (provider.kind === 'http') return 'native';
  return apisCompat(adapter, providerApis(provider));
}

const RANK: Record<Compat, number> = { native: 0, translated: 1, unknown: 2, incompatible: 3 };

/** The worse of two compat levels. */
const worse = (a: Compat, b: Compat): Compat => (RANK[a] >= RANK[b] ? a : b);

export interface ProfileCompat {
  /** none = the agent type uses no custom model provider (built-in access). */
  level: Compat | 'none';
  adapter: AgentAdapter;
  /** The model provider the level refers to (the worst one if several). */
  providerId?: string;
  /** The adapter does not support custom providers at all (Gemini CLI). */
  noCustomProviders?: boolean;
}

/** Compatibility of an agent type with its (or the given) model providers. */
export function profileCompat(
  profile: Pick<AgentProfile, 'adapter' | 'tool' | 'command' | 'providers'>,
  providers: Record<string, ApiProvider>,
  providerIds: string[] = profile.providers ?? [],
): ProfileCompat {
  const adapter = profileAdapter(profile);
  const used = providerIds.filter((id) => isModelProvider(providers[id]));
  if (used.length === 0) return { level: 'none', adapter };
  if (!ADAPTERS[adapter].customProviders) return { level: 'incompatible', adapter, providerId: used[0], noCustomProviders: true };
  let level: Compat = 'native';
  let providerId = used[0];
  for (const id of used) {
    const c = providerCompat(adapter, providers[id]!);
    if (RANK[c] > RANK[level]) providerId = id;
    level = worse(level, c);
  }
  return { level, adapter, providerId };
}

// ── Toolbox ──────────────────────────────────────────────────────────────────

/**
 * - installed / missing: the profile's CLI is (not) in the toolbox
 * - none:    the profile runs no toolbox CLI (e.g. a plain shell)
 * - unknown: toolbox state not known yet
 */
export type ToolState = 'installed' | 'missing' | 'none' | 'unknown';

export function toolboxImage(images: ImageInfo[] | undefined): ImageInfo | undefined {
  return images?.find((i) => i.kind === 'agents');
}

/** CLIs currently installed in the toolbox (undefined = unknown). */
export function installedTools(images: ImageInfo[] | undefined): AgentTool[] | undefined {
  if (!images) return undefined;
  const box = toolboxImage(images);
  if (!box) return undefined;
  if (!box.exists) return [];
  if (!box.tools) return undefined;
  return box.tools.filter((t): t is AgentTool => (AgentTool.options as string[]).includes(t));
}

export function toolState(profile: Pick<AgentProfile, 'tool' | 'command'>, images: ImageInfo[] | undefined): ToolState {
  const tool = profileTool(profile);
  if (!tool) return 'none';
  const installed = installedTools(images);
  if (!installed) return 'unknown';
  return installed.includes(tool) ? 'installed' : 'missing';
}

export const toolLabel = (tool: string): string => AGENT_TOOLS[tool as AgentTool]?.label ?? tool;

// ── Recommendation ───────────────────────────────────────────────────────────

/** Preference among equally compatible agents: agents built for many providers first for chat-only servers. */
const PREFERENCE: AgentTool[] = ['claude-code', 'codex', 'opencode', 'pi', 'qwen-code', 'gemini'];

/** API styles to assume for an untested provider, from its kind (conservative: OpenAI-compatible → Chat Completions only). */
export function assumedApis(p: Pick<ApiProvider, 'apis' | 'kind'>): ApiStyle[] {
  return providerApis(p) ?? (p.kind === 'anthropic' ? ['messages'] : ['chat']);
}

export interface BaseCandidate {
  base: AgentTool;
  compat: Compat;
  installed: boolean | undefined;
}

/**
 * Built-in agents that can use a provider, best first: native before translated, installed before missing.
 * For untested providers the APIs are guessed from the kind (the compat shown is still "unknown").
 */
export function rankBases(provider: Pick<ApiProvider, 'apis' | 'kind'>, images?: ImageInfo[]): BaseCandidate[] {
  const apis = assumedApis(provider);
  const installed = installedTools(images);
  const known = !!providerApis(provider);
  return AGENT_BASES.map((base) => {
    const guess = apisCompat(base, apis);
    return { base, guess, compat: known ? guess : guess === 'incompatible' ? guess : ('unknown' as Compat), installed: installed?.includes(base) };
  })
    .filter((c) => c.guess !== 'incompatible')
    .sort((a, b) => RANK[a.guess] - RANK[b.guess] || Number(b.installed ?? false) - Number(a.installed ?? false) || PREFERENCE.indexOf(a.base) - PREFERENCE.indexOf(b.base))
    .map(({ base, compat, installed: inst }) => ({ base, compat, installed: inst }));
}

/**
 * For chat-only servers prefer agents that speak Chat Completions natively (OpenCode, Pi, Qwen Code)
 * over Codex / Claude Code (which then need CoCoon's translation).
 */
export function recommendedBase(provider: Pick<ApiProvider, 'apis' | 'kind'>, images?: ImageInfo[]): AgentTool | undefined {
  return rankBases(provider, images)[0]?.base;
}
