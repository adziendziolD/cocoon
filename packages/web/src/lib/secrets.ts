import { KNOWN_SECRETS, localize, type AgentProfile, type ApiProvider, type Language, type ProviderKind, type SecretInfo } from '@cocoon/protocol';
import { getLanguage } from '../i18n';

/** Secrets that improve an agent but are never required to start it. */
export const OPTIONAL_SECRETS = new Set(['GITHUB_TOKEN']);

/** Built-in model credentials that a custom model provider replaces (the provider brings its own model access). */
const REPLACED_BY_PROVIDER = new Set(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'GEMINI_API_KEY']);
const MODEL_KINDS: ProviderKind[] = ['anthropic', 'openai'];

export interface MissingProviderKey {
  id: string;
  label: string;
  secret: string;
}

export interface SecretCheck {
  ok: boolean;
  /** Required secret names of which at least one must be set (empty = nothing required). */
  anyOf: string[];
  /** True if none of `anyOf` is stored. */
  missingAnyOf: boolean;
  /** Providers the agent uses whose API key is not stored yet. */
  missingProviderKeys: MissingProviderKey[];
  /** Provider ids referenced by the profile that no longer exist in the settings. */
  unknownProviders: string[];
}

/**
 * An agent profile lists secrets it can use. Apart from optional ones (GITHUB_TOKEN),
 * one of them is enough (e.g. Claude Code works with an API key OR an subscription token).
 * Custom model providers replace the built-in model keys (with a provider, Claude Code needs no
 * ANTHROPIC_API_KEY and OpenCode no OPENAI_API_KEY – CoCoon wires the provider in, translating if needed);
 * instead the provider's own key must be stored.
 */
export function checkProfileSecrets(
  profile: AgentProfile,
  secrets: SecretInfo[] | undefined,
  providers: Record<string, ApiProvider> = {},
  providerIds: string[] = profile.providers ?? [],
): SecretCheck {
  const used = providerIds.map((id) => [id, providers[id]] as const);
  const unknownProviders = used.filter(([, p]) => !p).map(([id]) => id);
  const kinds = new Set(used.flatMap(([, p]) => (p ? [p.kind] : [])));

  let anyOf = profile.secrets.filter((s) => !OPTIONAL_SECRETS.has(s));
  if (MODEL_KINDS.some((k) => kinds.has(k))) anyOf = anyOf.filter((s) => !REPLACED_BY_PROVIDER.has(s));

  const missingProviderKeys: MissingProviderKey[] = [];
  for (const [id, p] of used) {
    if (!p || p.auth === 'none' || !p.secret) continue;
    if (secrets && !isSecretSet(secrets, p.secret)) missingProviderKeys.push({ id, label: p.label, secret: p.secret });
  }

  if (!secrets) return { ok: true, anyOf, missingAnyOf: false, missingProviderKeys, unknownProviders };
  const set = new Set(secrets.filter((s) => s.set).map((s) => s.name));
  const missingAnyOf = anyOf.length > 0 && !anyOf.some((s) => set.has(s));
  return { ok: !missingAnyOf && missingProviderKeys.length === 0, anyOf, missingAnyOf, missingProviderKeys, unknownProviders };
}

export function secretLabel(name: string, lang: Language = getLanguage()): string {
  return localize(KNOWN_SECRETS[name]?.label, lang) ?? name;
}

export function secretDescription(name: string, lang: Language = getLanguage()): string | undefined {
  return localize(KNOWN_SECRETS[name]?.description, lang);
}

export function isSecretSet(secrets: SecretInfo[] | undefined, name: string): boolean {
  return !!secrets?.some((s) => s.name === name && s.set);
}
