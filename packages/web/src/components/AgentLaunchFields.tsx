import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ADAPTERS, profileAdapter, profileTool, type AgentProfile, type ImageInfo, type SecretInfo, type Settings } from '@cocoon/protocol';
import { ChevronDown, ChevronRight, Gauge, Plug } from 'lucide-react';
import { useDefaultModels, useImages, useSecrets, useSettings } from '../api/queries';
import { rich, useLanguage, useT, type TFunction } from '../i18n';
import { isModelProvider, profileCompat, providerCompat, toolState, type ProfileCompat } from '../lib/compat';
import { isShellProfile, profileLabel } from '../lib/profiles';
import { checkProfileSecrets, secretLabel, type SecretCheck } from '../lib/secrets';
import { AgentTypeCards } from './AgentTypeCards';
import { buttonClasses } from './Button';
import { CompatBadge, compatProblem } from './CompatBits';
import { Checkbox, Field } from './Field';
import { Callout } from './HelpText';
import { ModelSelect } from './ModelSelect';
import { formatTokens, effectiveLimits, MIN_CONTEXT, MIN_OUTPUT, parseTokens, type EffectiveLimits } from '../lib/modelLimits';
import { limitsPairError, limitSourceLabel, TokenInput } from './ModelLimits';

/**
 * What the user picked: agent type, provider override (null = the type's providers), model ('' = default)
 * and optional context window / answer length for this start (as typed, '' = not set).
 */
export interface LaunchChoice {
  kind: string;
  providers: string[] | null;
  model: string;
  contextWindow?: string;
  maxOutputTokens?: string;
}

export const EMPTY_CHOICE: LaunchChoice = { kind: '', providers: null, model: '' };

export interface LaunchInfo {
  profile?: AgentProfile;
  isShell: boolean;
  providers: string[];
  /** Model providers among `providers` (Anthropic/OpenAI-compatible). */
  modelProviders: string[];
  /** A model must be chosen (custom model provider). */
  needsModel: boolean;
  /** Known models of the model providers. */
  models: string[];
  /** Model that will be used ('' = agent's own default). */
  model: string;
  check: SecretCheck;
  compat: ProfileCompat | undefined;
  /** Effective context window / answer length (start overrides → agent type → model). */
  limits: EffectiveLimits;
  /** Placeholders of the override fields: what applies without them. */
  limitPlaceholders: { contextWindow?: number; maxOutputTokens?: number };
  /** Invalid override (undefined = fine). */
  limitsError?: string;
  /** Why the agent can't be started (undefined = it can). */
  problem?: string;
}

const NO_CHECK: SecretCheck = { ok: true, anyOf: [], missingAnyOf: false, missingProviderKeys: [], unknownProviders: [] };

export function launchInfo(t: TFunction, lang: 'de' | 'en', choice: LaunchChoice, settings: Settings | undefined, secrets: SecretInfo[] | undefined, images: ImageInfo[] | undefined): LaunchInfo {
  const profile = choice.kind ? settings?.agents[choice.kind] : undefined;
  const all = settings?.providers ?? {};
  const providers = choice.providers ?? profile?.providers ?? [];
  const modelProviders = providers.filter((id) => isModelProvider(all[id]));
  const isShell = isShellProfile(choice.kind, profile);
  const compat = profile ? profileCompat(profile, all, providers) : undefined;
  const needsModel = !!profile && !isShell && modelProviders.length > 0 && ADAPTERS[compat!.adapter].customProviders;
  const models = Array.from(new Set(modelProviders.flatMap((id) => [...(all[id]!.defaultModel ? [all[id]!.defaultModel!] : []), ...all[id]!.models])));
  const first = modelProviders.map((id) => all[id]!)[0];
  const model = choice.model.trim() || (needsModel ? profile?.model || first?.defaultModel || models[0] || '' : '');
  const check = profile ? checkProfileSecrets(profile, secrets, all, providers) : NO_CHECK;
  const limitsModel = model || profile?.model || '';
  const limitsError = limitsPairError(t, choice.contextWindow ?? '', choice.maxOutputTokens ?? '');
  const start = launchLimits(choice);
  const resolve = (s?: typeof start) => effectiveLimits({ start: s, profile, providers: all, providerIds: modelProviders, model: limitsModel });
  const limits = resolve(limitsError ? undefined : start);
  // The default answer length follows the context window chosen for this start.
  const limitPlaceholders = { contextWindow: resolve().contextWindow, maxOutputTokens: resolve({ contextWindow: start.contextWindow }).maxOutputTokens };

  let problem: string | undefined;
  if (!profile) problem = t('launch.pickAgent');
  else {
    const label = profileLabel(choice.kind, profile, lang);
    const tool = profileTool(profile);
    if (toolState(profile, images) === 'missing' && tool) problem = t('compat.reason.notInstalledShort', { agent: label });
    else if (compat && compatProblem(t, compat, all, label)) problem = compatProblem(t, compat, all, label);
    else if (!check.ok || check.unknownProviders.length > 0) problem = t('launch.missingAccess');
    else if (needsModel && !model) problem = t('compat.err.modelRequired');
    else if (!isShell && limitsError) problem = t('limits.launch.invalid');
  }
  return { profile, isShell, providers, modelProviders, needsModel, models, model, check, compat, limits, limitPlaceholders, limitsError, problem };
}

/** Hook variant of launchInfo with the usual queries. */
export function useLaunchInfo(choice: LaunchChoice): LaunchInfo & { loading: boolean } {
  const t = useT();
  const { lang } = useLanguage();
  const settings = useSettings();
  const secrets = useSecrets();
  const images = useImages();
  return { ...launchInfo(t, lang, choice, settings.data, secrets.data, images.data), loading: settings.isLoading };
}

/** Context window / answer length overrides to send to the server (only valid, set values). */
export function launchLimits(choice: LaunchChoice): { contextWindow?: number; maxOutputTokens?: number } {
  const c = parseTokens(choice.contextWindow ?? '');
  const o = parseTokens(choice.maxOutputTokens ?? '');
  return {
    ...(c !== undefined && !Number.isNaN(c) && c >= MIN_CONTEXT ? { contextWindow: c } : {}),
    ...(o !== undefined && !Number.isNaN(o) && o >= MIN_OUTPUT ? { maxOutputTokens: o } : {}),
  };
}

/** Model to send to the server: the chosen/default model for custom providers, an explicit override otherwise. */
export const launchModel = (choice: LaunchChoice, info: LaunchInfo): string | undefined => (info.needsModel ? info.model || undefined : choice.model.trim() || undefined);

/**
 * Agent type cards plus provider / model choice and access warnings – shared by "start agent" and "switch agent".
 * `onNavigate` is called before following a link to the settings (e.g. to close the dialog).
 */
export function AgentLaunchFields({
  choice,
  onChange,
  info,
  onNavigate,
  heading,
}: {
  choice: LaunchChoice;
  onChange: (c: LaunchChoice) => void;
  info: LaunchInfo;
  onNavigate?: () => void;
  heading?: string;
}) {
  const t = useT();
  const { lang } = useLanguage();
  const settings = useSettings();
  const [advanced, setAdvanced] = useState(false);
  const all = settings.data?.providers ?? {};
  const profiles = Object.entries(settings.data?.agents ?? {});
  const { profile, check, compat } = info;
  const defaultModels = useDefaultModels(choice.kind, !!profile && !info.isShell && !info.needsModel);
  const providerEntries = Object.entries(all);

  const set = (patch: Partial<LaunchChoice>) => onChange({ ...choice, ...patch });
  // No default credentials for this agent, but own model providers it can use: offer them right here (explicit click).
  const adapter = profile ? profileAdapter(profile) : undefined;
  const usableProviders =
    profile && adapter && ADAPTERS[adapter].customProviders && info.providers.length === 0 && check.missingAnyOf
      ? providerEntries.filter(([, p]) => isModelProvider(p) && providerCompat(adapter, p) !== 'incompatible')
      : [];
  const link = (to: string, label: string) => (
    <Link to={to} onClick={onNavigate} className={buttonClasses('secondary', 'sm')}>
      {label}
    </Link>
  );

  return (
    <div className="space-y-5">
      <div>
        <div className="mb-2 text-sm font-medium text-fg">{heading ?? t('spawn.whichAgent')}</div>
        <AgentTypeCards profiles={profiles} providers={all} value={choice.kind} onChange={(kind) => onChange({ ...EMPTY_CHOICE, kind })} />
      </div>

      {profile && !info.isShell && (
        <div className="space-y-3 rounded-xl border border-line bg-surface-2/50 px-4 py-3">
          <div className="flex flex-wrap items-center gap-2 text-sm text-fg-muted">
            <Plug className="size-4 text-fg-subtle" />
            <span>
              {t('spawn.uses')}{' '}
              <strong className="text-fg">
                {info.providers.length > 0 ? info.providers.map((id) => all[id]?.label ?? id).join(', ') : t('spawn.defaultProvider')}
              </strong>
            </span>
            {compat && compat.level !== 'none' && <CompatBadge level={compat.level} />}
          </div>
          {compat?.level === 'translated' && <p className="text-xs text-fg-muted">{t('launch.translatedHint', { agent: profileLabel(choice.kind, profile, lang) })}</p>}
          {compat?.level === 'unknown' && (
            <p className="text-xs text-fg-muted">
              {rich(t('launch.unknownHint'), {
                link: (
                  <Link to="/settings/providers" onClick={onNavigate} className="text-accent hover:underline">
                    {t('settingsNav.providers')}
                  </Link>
                ),
              })}
            </p>
          )}
          {info.needsModel ? (
            <Field label={t('spawn.modelField')} hint={t('launch.modelHint')} error={!info.model ? t('compat.err.modelRequired') : undefined}>
              <ModelSelect value={info.model} onChange={(model) => set({ model })} models={info.models} invalid={!info.model} />
            </Field>
          ) : (
            <Field label={t('spawn.modelField')} optional hint={t('spawn.modelHint')}>
              <ModelSelect
                key={(defaultModels.data?.models ?? []).join(',')}
                value={choice.model}
                onChange={(model) => set({ model })}
                models={defaultModels.data?.models ?? []}
                allowEmpty
                emptyLabel={profile.model ? t('compat.model.agentDefault', { model: profile.model }) : t('compat.model.default')}
                placeholder={profile.model || ''}
              />
            </Field>
          )}
          <LimitsLine info={info} onNavigate={onNavigate} />
        </div>
      )}

      {usableProviders.length > 0 && (
        <Callout tone="info" title={t('launch.useOwnTitle')}>
          <p>{t('launch.useOwnText', { agent: profileLabel(choice.kind, profile!, lang) })}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {usableProviders.map(([id, p]) => (
              <button key={id} type="button" className={buttonClasses('secondary', 'sm')} onClick={() => set({ providers: [id], model: '' })}>
                <Plug className="size-3.5" /> {t('launch.useOwnButton', { provider: p.label })}
                <CompatBadge level={providerCompat(adapter!, p)} />
              </button>
            ))}
          </div>
        </Callout>
      )}

      {profile && !check.ok && usableProviders.length === 0 && (
        <Callout
          tone="warning"
          title={t('spawn.missingTitle')}
          action={
            <>
              {check.missingAnyOf && link('/settings/secrets', t('spawn.toKeys'))}
              {check.missingProviderKeys.length > 0 && link('/settings/providers', t('spawn.toProviders'))}
            </>
          }
        >
          {check.missingAnyOf && (
            <p>
              {t(check.anyOf.length > 1 ? 'spawn.missingAnyOf' : 'spawn.missingOne', {
                agent: profileLabel(choice.kind, profile, lang),
                keys: check.anyOf.map((s) => secretLabel(s, lang)).join(` ${t('common.or')} `),
              })}
            </p>
          )}
          {check.missingProviderKeys.map((m) => (
            <p key={m.id}>{t('spawn.missingProviderKey', { provider: m.label, secret: m.secret })}</p>
          ))}
        </Callout>
      )}
      {check.unknownProviders.length > 0 && (
        <Callout tone="warning" title={t('spawn.unknownProviders')}>
          {t('spawn.unknownProvidersText', { ids: check.unknownProviders.join(', ') })}
        </Callout>
      )}
      {profile && compat && compat.level === 'incompatible' && choice.providers !== null && (
        <Callout tone="warning">{compatProblem(t, compat, all, profileLabel(choice.kind, profile, lang))}</Callout>
      )}

      {profile && !info.isShell && (
        <div className="rounded-xl border border-line">
          <button type="button" onClick={() => setAdvanced((a) => !a)} className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm font-medium text-fg">
            {advanced ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
            {t('spawn.advanced')}
          </button>
          {advanced && (
            <div className="space-y-4 border-t border-line px-4 py-4">
              <Field label={t('spawn.providers')} hint={t('spawn.providersHint')}>
                {providerEntries.length === 0 ? (
                  <p className="text-sm text-fg-muted">
                    {rich(t('spawn.noProviders'), {
                      link: (
                        <Link to="/settings/providers" onClick={onNavigate} className="text-accent hover:underline">
                          {t('providers.title')}
                        </Link>
                      ),
                    })}
                  </p>
                ) : (
                  <div className="grid gap-2 rounded-lg border border-line p-3 sm:grid-cols-2">
                    {providerEntries.map(([id, p]) => (
                      <Checkbox
                        key={id}
                        checked={info.providers.includes(id)}
                        onChange={(on) => set({ providers: on ? [...info.providers, id] : info.providers.filter((x) => x !== id), model: '' })}
                        label={
                          <span className="flex flex-wrap items-center gap-1.5">
                            {p.label}
                            {compat && isModelProvider(p) && <CompatBadge level={ADAPTERS[compat.adapter].customProviders ? providerCompat(compat.adapter, p) : 'incompatible'} />}
                          </span>
                        }
                        description={t(`providers.kind.${p.kind}.short`)}
                      />
                    ))}
                  </div>
                )}
                {choice.providers && (
                  <button type="button" className="mt-1 text-xs text-accent hover:underline" onClick={() => set({ providers: null, model: '' })}>
                    {t('spawn.resetToProfile')}
                  </button>
                )}
              </Field>
              <div className="space-y-2">
                <div className="text-sm font-medium text-fg">
                  {t('limits.launch.overrideTitle')} <span className="ml-1 font-normal text-fg-subtle">{t('common.optional')}</span>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label={<span className="text-xs font-normal text-fg-muted">{t('limits.contextLabel')}</span>}>
                    <TokenInput
                      value={choice.contextWindow ?? ''}
                      onChange={(contextWindow) => set({ contextWindow })}
                      min={MIN_CONTEXT}
                      placeholder={info.limitPlaceholders.contextWindow !== undefined ? String(info.limitPlaceholders.contextWindow) : t('limits.unknown')}
                    />
                  </Field>
                  <Field label={<span className="text-xs font-normal text-fg-muted">{t('limits.outputLabel')}</span>}>
                    <TokenInput
                      value={choice.maxOutputTokens ?? ''}
                      onChange={(maxOutputTokens) => set({ maxOutputTokens })}
                      min={MIN_OUTPUT}
                      placeholder={info.limitPlaceholders.maxOutputTokens !== undefined ? String(info.limitPlaceholders.maxOutputTokens) : ''}
                    />
                  </Field>
                </div>
                {info.limitsError ? (
                  <p className="text-xs text-red-600 dark:text-red-400">{info.limitsError}</p>
                ) : (
                  <p className="text-xs leading-relaxed text-fg-muted">
                    {t('limits.launch.overrideHint')} {t('limits.why')}
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Effective context window / answer length next to the model (or a hint that it's unknown). */
function LimitsLine({ info, onNavigate }: { info: LaunchInfo; onNavigate?: () => void }) {
  const t = useT();
  const { limits } = info;
  const model = info.model || info.profile?.model || '';
  if (limits.contextWindow === undefined && limits.maxOutputTokens === undefined) {
    // Only worth a hint for own model providers – built-in accesses know their models' limits.
    if (!model || info.modelProviders.length === 0) return null;
    return (
      <p className="flex items-start gap-1.5 text-xs text-fg-muted">
        <Gauge className="mt-0.5 size-3.5 shrink-0 text-fg-subtle" />
        <span>
          {rich(t('limits.launch.unknown', { model }), {
            link: (
              <Link to="/settings/providers" onClick={onNavigate} className="text-accent hover:underline">
                {t('settingsNav.providers')}
              </Link>
            ),
          })}
        </span>
      </p>
    );
  }
  const part = (value: number | undefined, source: EffectiveLimits['contextSource']) =>
    value === undefined ? t('limits.unknown') : `${formatTokens(value)}${source ? ` (${limitSourceLabel(t, source)})` : ''}`;
  return (
    <p className="flex items-start gap-1.5 text-xs text-fg-muted" title={t('limits.why')}>
      <Gauge className="mt-0.5 size-3.5 shrink-0 text-fg-subtle" />
      <span>{t('limits.summary', { context: part(limits.contextWindow, limits.contextSource), answer: part(limits.maxOutputTokens, limits.outputSource) })}</span>
    </p>
  );
}
