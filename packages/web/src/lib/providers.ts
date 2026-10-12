import {
  ApiProvider,
  DEFAULT_PROFILES,
  localize,
  profileTool,
  PROVIDER_ID,
  SECRET_NAME,
  type AgentProfile,
  type AgentTool,
  type ApiStyle,
  type MethodResult,
  type ModelInfo,
  type ProviderKind,
  type SecretInfo,
  type Settings,
} from '@cocoon/protocol';
import type { TFunction } from '../i18n';
import { isSecretSet } from './secrets';

/** Shared logic for API providers: form model, validation, env preview and agent-type suggestions. */

export type Auth = ApiProvider['auth'];
export type TestResult = MethodResult<'providers.test'>;

export const KINDS: ProviderKind[] = ['anthropic', 'openai', 'http'];
export const AUTHS: Auth[] = ['bearer', 'x-api-key', 'header', 'none'];
const HEADER_RE = /^[A-Za-z0-9-]+$/;
const PREFIX_RE = /^[A-Z][A-Z0-9_]*$/;

const upperSlug = (id: string) => id.toUpperCase().replace(/-/g, '_');
/** `<ID>_API_KEY`, made a valid secret name even if the id starts with a digit. */
export const defaultSecretName = (id: string) => {
  const base = upperSlug(id) || 'PROVIDER';
  return `${/^[A-Z_]/.test(base) ? base : `P_${base}`}_API_KEY`;
};
/** Default env prefix for http providers: id in upper case, "-" → "_". */
export const defaultEnvPrefix = (id: string) => {
  const base = upperSlug(id) || 'API';
  return /^[A-Z]/.test(base) ? base : `P_${base}`;
};

/** Env vars an agent gets for a provider (values are filled in by the server at spawn time). */
export function providerEnvVars(kind: ProviderKind, auth: Auth, prefix: string): string[] {
  if (kind === 'anthropic') return ['ANTHROPIC_BASE_URL', ...(auth === 'none' ? [] : ['ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN'])];
  if (kind === 'openai') return ['OPENAI_BASE_URL', ...(auth === 'none' ? [] : ['OPENAI_API_KEY'])];
  return [`${prefix}_BASE_URL`, ...(auth === 'none' ? [] : [`${prefix}_API_KEY`])];
}

export function keyStatus(p: ApiProvider, secrets: SecretInfo[] | undefined): 'none' | 'set' | 'missing' {
  if (p.auth === 'none' || !p.secret) return 'none';
  return isSecretSet(secrets, p.secret) ? 'set' : 'missing';
}

export function profilesUsing(settings: Settings | undefined, id: string): string[] {
  return Object.entries(settings?.agents ?? {})
    .filter(([, p]) => p.providers?.includes(id))
    .map(([k]) => k);
}

export interface ProviderForm {
  id: string;
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  auth: Auth;
  authHeader: string;
  secret: string;
  /** false = secret name follows the id automatically. */
  secretCustom: boolean;
  models: string[];
  defaultModel: string;
  envPrefix: string;
  envPrefixCustom: boolean;
  /** API styles detected by the last connection test (kept when saving). */
  apis?: ApiStyle[];
  /** Per-model limits (detected by the connection test or entered by the user; kept when saving). */
  modelInfo?: Record<string, ModelInfo>;
}

export function formFrom(id: string, p: ApiProvider, isNew: boolean): ProviderForm {
  return {
    id,
    label: p.label,
    kind: p.kind,
    baseUrl: p.baseUrl,
    auth: p.auth,
    authHeader: p.authHeader ?? '',
    secret: p.secret ?? defaultSecretName(id),
    secretCustom: !!p.secret && (!isNew || p.secret !== defaultSecretName(id)),
    models: [...p.models],
    defaultModel: p.defaultModel ?? '',
    envPrefix: p.envPrefix ?? defaultEnvPrefix(id),
    envPrefixCustom: !!p.envPrefix && (!isNew || p.envPrefix !== defaultEnvPrefix(id)),
    ...(p.apis ? { apis: [...p.apis] } : {}),
    ...(p.modelInfo ? { modelInfo: { ...p.modelInfo } } : {}),
  };
}

export const BLANK_PROVIDER: ApiProvider = { label: '', kind: 'openai', baseUrl: '', auth: 'bearer', models: [] };

export function buildProvider(f: ProviderForm): ApiProvider {
  const secret = f.secretCustom ? f.secret.trim() : defaultSecretName(f.id);
  return {
    label: f.label.trim(),
    kind: f.kind,
    baseUrl: f.baseUrl.trim(),
    auth: f.auth,
    ...(f.auth !== 'none' ? { secret } : {}),
    ...(f.auth === 'header' ? { authHeader: f.authHeader.trim() } : {}),
    models: f.models,
    ...(f.defaultModel.trim() ? { defaultModel: f.defaultModel.trim() } : {}),
    ...(f.kind === 'http' ? { envPrefix: f.envPrefixCustom ? f.envPrefix.trim() : defaultEnvPrefix(f.id) } : {}),
    ...(f.kind !== 'http' && f.apis?.length ? { apis: f.apis } : {}),
    ...(f.kind !== 'http' && f.modelInfo && Object.keys(f.modelInfo).length ? { modelInfo: f.modelInfo } : {}),
  };
}

export type ProviderFormErrors = Partial<Record<'id' | 'label' | 'baseUrl' | 'authHeader' | 'secret' | 'envPrefix' | 'defaultModel', string>>;

/** `requireModel`: model providers need a model (agents can't start without one). */
export function validateForm(t: TFunction, f: ProviderForm, isNew: boolean, existing: Record<string, ApiProvider>, requireModel = false): ProviderFormErrors {
  const e: ProviderFormErrors = {};
  if (!f.id) e.id = t('providers.err.idRequired');
  else if (!PROVIDER_ID.test(f.id)) e.id = t('providers.err.idFormat');
  else if (isNew && existing[f.id]) e.id = t('providers.err.idTaken');
  if (!f.label.trim()) e.label = t('providers.err.labelRequired');
  if (!f.baseUrl.trim()) e.baseUrl = t('providers.err.urlRequired');
  else if (!ApiProvider.shape.baseUrl.safeParse(f.baseUrl.trim()).success) e.baseUrl = t('providers.err.urlFormat');
  if (f.auth === 'header' && !HEADER_RE.test(f.authHeader.trim())) e.authHeader = t('providers.err.header');
  const secret = f.secretCustom ? f.secret.trim() : defaultSecretName(f.id);
  if (f.auth !== 'none' && !SECRET_NAME.test(secret)) e.secret = t('providers.err.secret');
  const prefix = f.envPrefixCustom ? f.envPrefix.trim() : defaultEnvPrefix(f.id);
  if (f.kind === 'http' && !PREFIX_RE.test(prefix)) e.envPrefix = t('providers.err.prefix');
  if (requireModel && f.kind !== 'http' && !f.defaultModel.trim()) e.defaultModel = t('compat.err.modelRequired');
  return e;
}

// ── Agent types for a provider ───────────────────────────────────────────────

const text = (v: AgentProfile['label'], lang: 'de' | 'en') => localize(v, lang) ?? '';

/** Suggestion "<agent> über <provider>": copies the built-in profile of the agent CLI and wires in the provider. */
export function providerProfile(base: AgentTool, providerId: string, provider: ApiProvider): AgentProfile {
  const builtIn = DEFAULT_PROFILES[base]!;
  const de = text(builtIn.label, 'de') || base;
  const en = text(builtIn.label, 'en') || base;
  return {
    ...builtIn,
    label: { de: `${de} über ${provider.label}`, en: `${en} via ${provider.label}` },
    description: {
      de: `${de} mit dem API-Anbieter „${provider.label}“ statt des Standard-Zugangs.`,
      en: `${en} using the API provider "${provider.label}" instead of the default access.`,
    },
    adapter: builtIn.adapter ?? base,
    tool: builtIn.tool ?? base,
    providers: [providerId],
  };
}

export const providerProfileKey = (base: string, providerId: string) => `${base === 'claude-code' ? 'claude' : base}-${providerId}`.slice(0, 41).replace(/-+$/, '');

/** Agent types that run the given agent CLI with exactly this provider. */
export function providerProfilesFor(agents: Record<string, AgentProfile>, providerId: string, base?: AgentTool): string[] {
  return Object.entries(agents)
    .filter(([k, p]) => (base && k === providerProfileKey(base, providerId)) || (p.providers.length === 1 && p.providers[0] === providerId && (!base || profileTool(p) === base)))
    .map(([k]) => k);
}

/** True if an agent type already runs the given agent CLI with exactly this provider. */
export function hasProviderProfile(agents: Record<string, AgentProfile>, base: AgentTool, providerId: string): boolean {
  return providerProfilesFor(agents, providerId, base).length > 0;
}

// ── AI access ────────────────────────────────────────────────────────────────

/** Built-in secrets that give agents access to an AI model (mirrors the server's setup check). */
export const CREDENTIAL_SECRETS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'GEMINI_API_KEY'] as const;

/** Model providers (Anthropic/OpenAI-compatible) that are usable: no key needed or key stored. */
export function usableModelProviders(settings: Settings | undefined, secrets: SecretInfo[] | undefined): Array<[string, ApiProvider]> {
  return Object.entries(settings?.providers ?? {}).filter(([, p]) => p.kind !== 'http' && keyStatus(p, secrets) !== 'missing');
}

/** Number of configured AI accesses (built-in keys plus usable custom providers). */
export function countAiAccess(settings: Settings | undefined, secrets: SecretInfo[] | undefined): number {
  return CREDENTIAL_SECRETS.filter((s) => isSecretSet(secrets, s)).length + usableModelProviders(settings, secrets).length;
}
