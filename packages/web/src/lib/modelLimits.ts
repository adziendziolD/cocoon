import { defaultMaxOutput, type AgentProfile, type ApiProvider, type ModelInfo, type Settings } from '@cocoon/protocol';
import { isModelProvider } from './compat';

/** Model limits (context window / answer length): formatting, parsing and the server's resolution order. */

export const MIN_CONTEXT = 1024;
export const MIN_OUTPUT = 256;

/** Compact token count: 131072 → "128k", 200000 → "200k", 1048576 → "1M", 8192 → "8k". */
export function formatTokens(n: number): string {
  const binary = n % 1024 === 0;
  const k = binary ? n / 1024 : n / 1000;
  if (k < 1) return String(n);
  if (k >= 1000) {
    const m = binary ? k / 1024 : k / 1000;
    return `${Number.isInteger(m) ? m : m.toFixed(1).replace(/\.0$/, '')}M`;
  }
  return `${k >= 10 ? Math.round(k) : Number(k.toFixed(1))}k`;
}

/**
 * Parses a token count typed by the user: "131072", "128k", "128 K", "1M", "1.5m", "131.072".
 * Returns undefined for empty input, NaN for garbage.
 */
export function parseTokens(input: string): number | undefined {
  const s = input.trim().toLowerCase().replace(/[\s_']/g, '');
  if (!s) return undefined;
  const m = /^(\d+(?:[.,]\d+)?)(k|m)?$/.exec(s);
  if (!m) return NaN;
  const unit = m[2];
  // "131.072" / "131,072" without a unit = thousands separator.
  const num = unit ? Number(m[1]!.replace(',', '.')) : Number(m[1]!.replace(/[.,]/g, ''));
  const value = unit === 'k' ? num * 1024 : unit === 'm' ? num * 1024 * 1024 : num;
  return Math.round(value);
}

/** Text field value for a token count. */
export const tokensText = (n: number | undefined) => (n === undefined ? '' : String(n));

export type TokenFieldError = 'format' | 'min';

/** Validates a token field ('' is fine = not set). */
export function tokenError(input: string, min: number): TokenFieldError | undefined {
  const v = parseTokens(input);
  if (v === undefined) return undefined;
  if (Number.isNaN(v)) return 'format';
  if (v < min) return 'min';
  return undefined;
}

/** Limits of a model at a provider (only entries with at least one value). */
export function providerModelInfo(provider: ApiProvider | undefined, model: string | undefined): ModelInfo | undefined {
  if (!provider || !model) return undefined;
  const info = provider.modelInfo?.[model];
  return info && (info.contextWindow !== undefined || info.maxOutputTokens !== undefined) ? info : undefined;
}

/** Where an effective value comes from (server resolution order). */
export type LimitSource = 'start' | 'type' | 'detected' | 'user' | 'default';

export interface EffectiveLimits {
  contextWindow?: number;
  contextSource?: LimitSource;
  maxOutputTokens?: number;
  /** 'default' = derived from the context window (a quarter, 1k–32k). */
  outputSource?: LimitSource;
}

/**
 * Effective limits as the server resolves them: start params → agent type → provider.modelInfo[model];
 * a missing answer length defaults to defaultMaxOutput(context).
 */
export function effectiveLimits(opts: {
  start?: { contextWindow?: number; maxOutputTokens?: number };
  profile?: Pick<AgentProfile, 'contextWindow' | 'maxOutputTokens'>;
  providers?: Record<string, ApiProvider>;
  providerIds?: string[];
  model?: string;
}): EffectiveLimits {
  const { start, profile, providers = {}, providerIds = [], model } = opts;
  const info = providerIds.map((id) => providerModelInfo(providers[id], model)).find(Boolean);
  const modelSource: LimitSource = info?.source === 'user' ? 'user' : 'detected';
  const out: EffectiveLimits = {};
  if (start?.contextWindow !== undefined) [out.contextWindow, out.contextSource] = [start.contextWindow, 'start'];
  else if (profile?.contextWindow !== undefined) [out.contextWindow, out.contextSource] = [profile.contextWindow, 'type'];
  else if (info?.contextWindow !== undefined) [out.contextWindow, out.contextSource] = [info.contextWindow, modelSource];
  if (start?.maxOutputTokens !== undefined) [out.maxOutputTokens, out.outputSource] = [start.maxOutputTokens, 'start'];
  else if (profile?.maxOutputTokens !== undefined) [out.maxOutputTokens, out.outputSource] = [profile.maxOutputTokens, 'type'];
  else if (info?.maxOutputTokens !== undefined) [out.maxOutputTokens, out.outputSource] = [info.maxOutputTokens, modelSource];
  else if (out.contextWindow !== undefined) [out.maxOutputTokens, out.outputSource] = [defaultMaxOutput(out.contextWindow), 'default'];
  return out;
}

/** Model an agent type uses with its model providers ('' = none / agent default). */
export function profileModel(profile: Pick<AgentProfile, 'providers' | 'model'>, providers: Record<string, ApiProvider>): { model: string; providerIds: string[] } {
  const providerIds = profile.providers.filter((id) => isModelProvider(providers[id]));
  const first = providerIds.map((id) => providers[id]!)[0];
  return { model: profile.model || first?.defaultModel || first?.models[0] || '', providerIds };
}

/** Agent types that use a model of this provider whose context window is unknown, with the model. */
export function typesWithoutContext(settings: Settings | undefined, providerId: string): Array<{ key: string; model: string }> {
  if (!settings) return [];
  const providers = settings.providers;
  return Object.entries(settings.agents).flatMap(([key, profile]) => {
    if (!profile.providers.includes(providerId) || profile.contextWindow !== undefined) return [];
    const { model, providerIds } = profileModel(profile, providers);
    if (!model || !providerIds.includes(providerId)) return [];
    return effectiveLimits({ profile, providers, providerIds, model }).contextWindow === undefined ? [{ key, model }] : [];
  });
}

/** Merges detected limits into a provider's modelInfo; entries set by the user are kept. */
export function mergeDetected(current: Record<string, ModelInfo> | undefined, detected: Record<string, ModelInfo> | undefined): Record<string, ModelInfo> | undefined {
  if (!detected || Object.keys(detected).length === 0) return current;
  const next = { ...(current ?? {}) };
  for (const [model, info] of Object.entries(detected)) {
    if (next[model]?.source === 'user') continue;
    if (info.contextWindow === undefined && info.maxOutputTokens === undefined) continue;
    next[model] = { ...info, source: 'detected' };
  }
  return next;
}
