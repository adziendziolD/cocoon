import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { localize, PROVIDER_PRESETS, type AgentTool, type ApiProvider, type ProviderKind } from '@cocoon/protocol';
import { Bot, BrainCircuit, Check, CircleCheck, Crown, ExternalLink, FilePlus2, KeyRound, Plug, Plus, Sparkles, Zap } from 'lucide-react';
import { qk } from '../../../api/keys';
import { useImages, useSecrets, useSettings } from '../../../api/queries';
import { rpc } from '../../../api/rpc';
import { useAction } from '../../../api/useAction';
import { useSaveSecret } from '../../../api/useSaveSecret';
import { Badge } from '../../../components/Badge';
import { Button } from '../../../components/Button';
import { BuildLog } from '../../../components/BuildLog';
import { CodeBlock } from '../../../components/CodeBlock';
import { CompatBadge, InstallToolButton } from '../../../components/CompatBits';
import { ModelSelect } from '../../../components/ModelSelect';
import { ChoiceCard, Field, Input, Select } from '../../../components/Field';
import { Callout } from '../../../components/HelpText';
import { KeyBadge, KindBadge, ProviderTestResult } from '../../../components/ProviderTestResult';
import { SecretInput } from '../../../components/SecretInput';
import { ProviderLimitsCard } from '../../../components/ModelLimits';
import { mergeDetected } from '../../../lib/modelLimits';
import { rich, useLanguage, useT } from '../../../i18n';
import { cn } from '../../../lib/cn';
import { profileLabel } from '../../../lib/profiles';
import { providerApis, rankBases, toolLabel } from '../../../lib/compat';
import {
  BLANK_PROVIDER,
  buildProvider,
  countAiAccess,
  defaultSecretName,
  formFrom,
  hasProviderProfile,
  keyStatus,
  providerProfile,
  providerProfileKey,
  providerProfilesFor,
  usableModelProviders,
  validateForm,
  type ProviderForm,
  type TestResult,
} from '../../../lib/providers';
import { isSecretSet, secretLabel } from '../../../lib/secrets';
import { useDraftField, useOnboarding } from '../context';
import { useKeyVerdicts, type Verdict } from '../keyChecks';
import { HowTo, StepFrame, StoredSecret } from '../StepFrame';

type Option = 'anthropic' | 'subscription' | 'openai' | 'custom';

/** Fixed provider definitions used to verify the built-in keys (no settings entry needed). */
const ANTHROPIC_TEST: ApiProvider = { label: 'Anthropic', kind: 'anthropic', baseUrl: 'https://api.anthropic.com', secret: 'ANTHROPIC_API_KEY', auth: 'x-api-key', models: [] };
const OPENAI_TEST: ApiProvider = { label: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', secret: 'OPENAI_API_KEY', auth: 'bearer', models: [] };

const OPTIONS: Array<{ id: Option; icon: typeof KeyRound; title: 'onboarding.ai.anthropic.title' | 'onboarding.ai.subscription.title' | 'onboarding.ai.openai.title' | 'onboarding.ai.custom.title'; text: 'onboarding.ai.anthropic.card' | 'onboarding.ai.subscription.card' | 'onboarding.ai.openai.card' | 'onboarding.ai.custom.card'; forAgent: string }> = [
  { id: 'anthropic', icon: KeyRound, title: 'onboarding.ai.anthropic.title', text: 'onboarding.ai.anthropic.card', forAgent: 'Claude Code' },
  { id: 'subscription', icon: Crown, title: 'onboarding.ai.subscription.title', text: 'onboarding.ai.subscription.card', forAgent: 'Claude Code' },
  { id: 'openai', icon: Sparkles, title: 'onboarding.ai.openai.title', text: 'onboarding.ai.openai.card', forAgent: 'Codex' },
  { id: 'custom', icon: Plug, title: 'onboarding.ai.custom.title', text: 'onboarding.ai.custom.card', forAgent: 'OpenCode, Pi, Qwen Code, Codex, Claude Code' },
];

export function AiAccessStep() {
  const t = useT();
  const { lang } = useLanguage();
  const { next } = useOnboarding();
  const settings = useSettings();
  const secrets = useSecrets();
  const [option, setOption] = useDraftField<Option | null>('ai.option', null);
  const keyVerdicts = useKeyVerdicts();
  const verdicts: Record<Option, Verdict> = { anthropic: keyVerdicts.ANTHROPIC_API_KEY, openai: keyVerdicts.OPENAI_API_KEY, subscription: 'ok', custom: 'ok' };

  const configured: Record<Option, boolean> = {
    anthropic: isSecretSet(secrets.data, 'ANTHROPIC_API_KEY'),
    subscription: isSecretSet(secrets.data, 'CLAUDE_CODE_OAUTH_TOKEN'),
    openai: isSecretSet(secrets.data, 'OPENAI_API_KEY'),
    custom: usableModelProviders(settings.data, secrets.data).length > 0,
  };
  // A key the provider rejected (401/403) does not count as working access.
  const rejected = (['anthropic', 'openai'] as const).filter((o) => configured[o] && verdicts[o] === 'rejected');
  const count = countAiAccess(settings.data, secrets.data) - rejected.length;
  const unverified = (['anthropic', 'openai'] as const).some((o) => configured[o] && verdicts[o] === 'unverified');
  const chips = [
    ...(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'GEMINI_API_KEY'] as const)
      .filter((s) => isSecretSet(secrets.data, s))
      .filter((s) => !(s === 'ANTHROPIC_API_KEY' && rejected.includes('anthropic')) && !(s === 'OPENAI_API_KEY' && rejected.includes('openai')))
      .map((s) => secretLabel(s, lang)),
    ...usableModelProviders(settings.data, secrets.data).map(([, p]) => p.label),
  ];

  return (
    <StepFrame
      icon={BrainCircuit}
      title={t('onboarding.ai.title')}
      lead={t('onboarding.ai.lead')}
      onNext={next}
      nextDisabled={count === 0}
      footerHint={count === 0 ? t(rejected.length ? 'onboarding.ai.rejectedHint' : 'onboarding.ai.needOne') : undefined}
      doneBanner={
        count === 0 ? false : (
        <Callout tone={unverified ? 'warning' : 'success'} title={t('onboarding.ai.configuredTitle', { count })}>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {chips.map((c) => (
              <Badge key={c} tone="green">
                <Check className="size-3" /> {c}
              </Badge>
            ))}
          </div>
          <p className="mt-2">{t(unverified ? 'onboarding.ai.unverifiedText' : 'onboarding.ai.configuredText')}</p>
        </Callout>
        )
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {OPTIONS.map(({ id, icon: Icon, title, text, forAgent }) => {
          const selected = option === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => setOption(selected ? null : id)}
              aria-expanded={selected}
              aria-controls="ai-option-panel"
              className={cn(
                'flex items-start gap-3.5 rounded-xl border p-4 text-left transition-all focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
                selected ? 'border-accent bg-accent-soft ring-2 ring-accent/30' : 'border-line bg-surface hover:border-line-strong hover:bg-surface-2/60',
              )}
            >
              <span className={cn('flex size-10 shrink-0 items-center justify-center rounded-xl', selected ? 'bg-accent text-accent-fg' : 'bg-surface-2 text-fg-muted')}>
                <Icon className="size-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-fg">{t(title)}</span>
                  {configured[id] && verdicts[id] === 'rejected' && <Badge tone="red">{t('onboarding.ai.rejected')}</Badge>}
                  {configured[id] && verdicts[id] === 'unverified' && <Badge tone="amber">{t('onboarding.ai.unverified')}</Badge>}
                  {configured[id] && verdicts[id] === 'ok' && (
                    <Badge tone="green">
                      <Check className="size-3" /> {t('onboarding.ai.configured')}
                    </Badge>
                  )}
                </span>
                <span className="mt-0.5 block text-xs font-medium text-fg-subtle">{t('onboarding.ai.forAgent', { agent: forAgent })}</span>
                <span className="mt-1.5 block text-sm leading-relaxed text-fg-muted">{t(text)}</span>
              </span>
            </button>
          );
        })}
      </div>

      {option && (
        <div id="ai-option-panel" className="animate-in rounded-xl border border-line bg-surface-2/30 p-5">
          {option === 'anthropic' && (
            <ApiKeyPanel
              secret="ANTHROPIC_API_KEY"
              provider={ANTHROPIC_TEST}
              prefix="sk-ant-"
              helpUrl="https://console.anthropic.com/settings/keys"
              helpLabel={t('onboarding.ai.anthropic.open')}
              steps={[t('onboarding.ai.anthropic.how1'), t('onboarding.ai.anthropic.how2'), t('onboarding.ai.anthropic.how3')]}
              note={t('onboarding.ai.anthropic.note')}
            />
          )}
          {option === 'openai' && (
            <ApiKeyPanel
              secret="OPENAI_API_KEY"
              provider={OPENAI_TEST}
              prefix="sk-"
              helpUrl="https://platform.openai.com/api-keys"
              helpLabel={t('onboarding.ai.openai.open')}
              steps={[t('onboarding.ai.openai.how1'), t('onboarding.ai.openai.how2'), t('onboarding.ai.openai.how3')]}
              note={t('onboarding.ai.openai.note')}
            />
          )}
          {option === 'subscription' && <SubscriptionPanel />}
          {option === 'custom' && <CustomProviderPanel />}
        </div>
      )}
    </StepFrame>
  );
}

// ── Built-in API keys (Anthropic, OpenAI) ────────────────────────────────────

function ApiKeyPanel({
  secret,
  provider,
  prefix,
  helpUrl,
  helpLabel,
  steps,
  note,
}: {
  secret: string;
  provider: ApiProvider;
  prefix: string;
  helpUrl: string;
  helpLabel: string;
  steps: string[];
  note: string;
}) {
  const t = useT();
  const { lang } = useLanguage();
  const secrets = useSecrets();
  const info = secrets.data?.find((s) => s.name === secret && s.set);
  const [value, setValue] = useDraftField(`secret.${secret}`, '');
  const [result, setResult] = useDraftField<TestResult | null>(`ai.test.${secret}`, null);
  const [replace, setReplace] = useState(false);

  const test = useAction(() => rpc('providers.test', { provider }), {
    error: t('providers.test.failed'),
    onSuccess: (r) => setResult({ ...r, models: [] }),
  });
  const save = useSaveSecret(secret, {
    onSuccess: () => {
      setValue('');
      setReplace(false);
      setResult(null);
      test.mutate();
    },
  });
  const trimmed = value.trim();
  const looksWrong = trimmed.length > 0 && !trimmed.startsWith(prefix);

  return (
    <div className="space-y-5">
      <HowTo
        steps={[
          <>
            {steps[0]}{' '}
            <a href={helpUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-accent hover:underline">
              {helpLabel} <ExternalLink className="size-3.5" />
            </a>
          </>,
          steps[1],
          steps[2],
        ]}
      />
      <Field label={secretLabel(secret, lang)} hint={looksWrong ? undefined : note} error={looksWrong ? t('onboarding.ai.prefixWarning', { prefix }) : undefined}>
        {info && !replace ? (
          <StoredSecret info={info}>
            <Button size="sm" icon={<Zap className="size-3.5" />} loading={test.isPending} onClick={() => test.mutate()}>
              {t('onboarding.ai.verify')}
            </Button>
            <Button size="sm" onClick={() => setReplace(true)}>
              {t('providers.form.replaceKey')}
            </Button>
          </StoredSecret>
        ) : (
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (trimmed) save.mutate(trimmed);
            }}
          >
            <SecretInput value={value} onChange={(e) => setValue(e.target.value)} placeholder={`${prefix}…`} invalid={looksWrong} aria-label={secretLabel(secret, lang)} className="min-w-60" />
            <Button type="submit" variant="primary" loading={save.isPending || test.isPending} disabled={!trimmed}>
              {t('onboarding.ai.saveVerify')}
            </Button>
            {replace && <Button onClick={() => setReplace(false)}>{t('common.cancel')}</Button>}
          </form>
        )}
      </Field>
      {test.isPending && <p className="text-sm text-fg-muted">{t('onboarding.ai.verifying')}</p>}
      {result && !test.isPending && (
        <div className="space-y-2">
          <ProviderTestResult result={result} onDismiss={() => setResult(null)} />
          {!result.ok && <p className="text-xs text-fg-muted">{t('onboarding.ai.verifyFailedHint')}</p>}
        </div>
      )}
      <p className="text-xs text-fg-subtle">{t('onboarding.ai.keySafety')}</p>
    </div>
  );
}

// ── Claude subscription token ────────────────────────────────────────────────

function SubscriptionPanel() {
  const t = useT();
  const { lang } = useLanguage();
  const secrets = useSecrets();
  const name = 'CLAUDE_CODE_OAUTH_TOKEN';
  const info = secrets.data?.find((s) => s.name === name && s.set);
  const [value, setValue] = useDraftField(`secret.${name}`, '');
  const [replace, setReplace] = useState(false);
  const save = useSaveSecret(name, {
    onSuccess: () => {
      setValue('');
      setReplace(false);
    },
  });
  return (
    <div className="space-y-5">
      <p className="text-sm leading-relaxed text-fg-muted">{t('onboarding.ai.subscription.intro')}</p>
      <HowTo
        steps={[
          <div key="1" className="space-y-2">
            <div>{t('onboarding.ai.subscription.how1')}</div>
            <CodeBlock code="npm install -g @anthropic-ai/claude-code" />
          </div>,
          <div key="2" className="space-y-2">
            <div>{t('onboarding.ai.subscription.how2')}</div>
            <CodeBlock code="claude setup-token" />
          </div>,
          t('onboarding.ai.subscription.how3'),
        ]}
      />
      <Field label={secretLabel(name, lang)}>
        {info && !replace ? (
          <StoredSecret info={info}>
            <Button size="sm" onClick={() => setReplace(true)}>
              {t('providers.form.replaceKey')}
            </Button>
          </StoredSecret>
        ) : (
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (value.trim()) save.mutate(value.trim());
            }}
          >
            <SecretInput value={value} onChange={(e) => setValue(e.target.value)} placeholder="sk-ant-oat…" aria-label={secretLabel(name, lang)} className="min-w-60" />
            <Button type="submit" variant="primary" loading={save.isPending} disabled={!value.trim()}>
              {t('common.save')}
            </Button>
            {replace && <Button onClick={() => setReplace(false)}>{t('common.cancel')}</Button>}
          </form>
        )}
      </Field>
      <Callout tone="info" title={t('onboarding.ai.subscription.noVerifyTitle')}>
        {t('onboarding.ai.subscription.noVerifyText')}
      </Callout>
    </div>
  );
}

// ── Custom API provider ──────────────────────────────────────────────────────

/** Presets that give access to an AI model (plain HTTP APIs are not an "AI access"). */
const MODEL_PRESETS = Object.entries(PROVIDER_PRESETS).filter(([, p]) => p.provider.kind !== 'http');
const MODEL_KINDS: ProviderKind[] = ['anthropic', 'openai'];

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

function uniqueId(base: string, taken: Record<string, unknown>): string {
  const b = slug(base) || 'provider';
  if (!taken[b]) return b;
  for (let i = 2; ; i++) {
    const id = `${b.slice(0, 37)}-${i}`;
    if (!taken[id]) return id;
  }
}

function CustomProviderPanel() {
  const t = useT();
  const { lang } = useLanguage();
  const qc = useQueryClient();
  const settings = useSettings();
  const secrets = useSecrets();
  /** undefined = choosing a template; null = blank form. */
  const [preset, setPreset] = useDraftField<string | null | undefined>('ai.custom.preset', undefined);
  const [form, setForm] = useDraftField<ProviderForm>('ai.custom.form', formFrom('', BLANK_PROVIDER, true));
  const [savedId, setSavedId] = useDraftField<string | undefined>('ai.custom.savedId', undefined);
  const [result, setResult] = useDraftField<TestResult | null>('ai.custom.result', null);
  const [key, setKey] = useDraftField('secret.custom.key', '');
  const [touched, setTouched] = useState(false);
  const [replaceKey, setReplaceKey] = useState(false);

  const providers = settings.data?.providers ?? {};
  const existing = Object.entries(providers).filter(([, p]) => p.kind !== 'http');
  const isNew = !savedId;
  const errors = validateForm(t, form, isNew, providers);
  const shown = touched ? errors : {};
  const secretName = form.secretCustom ? form.secret.trim() : defaultSecretName(form.id);
  const keyStored = isSecretSet(secrets.data, secretName);
  const needsKey = form.auth !== 'none';
  const saved = savedId ? providers[savedId] : undefined;

  const update = (patch: Partial<ProviderForm>) =>
    setForm((f) => {
      const nextForm = { ...f, ...patch };
      // Blank template: the id follows the name until the provider is saved.
      if (isNew && preset === null && patch.label !== undefined) nextForm.id = uniqueId(patch.label || 'provider', providers);
      return nextForm;
    });

  const pick = (k: string | null) => {
    if (k) {
      const p = PROVIDER_PRESETS[k]!.provider;
      const f = formFrom(uniqueId(k, providers), p, true);
      setForm({ ...f, ...(p.secret ? { secret: p.secret, secretCustom: true } : {}) });
    } else {
      setForm(formFrom('my-provider', { ...BLANK_PROVIDER, kind: 'openai' }, true));
    }
    setPreset(k);
    setSavedId(undefined);
    setResult(null);
    setTouched(false);
  };

  const reset = () => {
    setPreset(undefined);
    setSavedId(undefined);
    setResult(null);
    setKey('');
    setTouched(false);
  };

  const saveAndTest = useAction(
    async () => {
      const id = form.id;
      const built = buildProvider(form);
      const current0 = qc.getQueryData<typeof settings.data>(qk.settings) ?? settings.data;
      // Keep the limits already stored for this provider (detected or entered by the user).
      const keepInfo = current0?.providers[id]?.modelInfo;
      const provider: ApiProvider = keepInfo ? { ...built, modelInfo: keepInfo } : built;
      if (needsKey && key.trim()) await rpc('secrets.set', { name: secretName, value: key.trim() });
      const current = qc.getQueryData<typeof settings.data>(qk.settings) ?? settings.data;
      const nextSettings = await rpc('settings.update', { providers: { ...(current?.providers ?? {}), [id]: provider } });
      qc.setQueryData(qk.settings, nextSettings);
      setSavedId(id);
      setKey('');
      setReplaceKey(false);
      const r = await rpc('providers.test', { id });
      // The server stores the detected APIs on the provider; also preselect the first discovered model.
      let fresh = await rpc('settings.get');
      const p = fresh.providers[id];
      if (p && r.ok) {
        const patch: Partial<ApiProvider> = {};
        if (!p.apis?.length && r.apis?.length) patch.apis = r.apis;
        const merged = mergeDetected(p.modelInfo, r.modelInfo);
        if (JSON.stringify(merged ?? {}) !== JSON.stringify(p.modelInfo ?? {})) patch.modelInfo = merged;
        if (!p.defaultModel && r.models[0]) {
          patch.defaultModel = r.models[0];
          if (!p.models.includes(r.models[0])) patch.models = [...p.models, r.models[0]];
        }
        if (Object.keys(patch).length) fresh = await rpc('settings.update', { providers: { ...fresh.providers, [id]: { ...p, ...patch } } });
      }
      qc.setQueryData(qk.settings, fresh);
      return r;
    },
    {
      success: (r) => (r.ok ? t('onboarding.ai.custom.savedOk', { name: form.label.trim() }) : t('onboarding.ai.custom.savedNotOk', { name: form.label.trim() })),
      error: t('common.saveFailed'),
      invalidate: [qk.secrets, qk.setup],
      onSuccess: (r) => setResult(r),
    },
  );

  const saveProvider = useAction(
    async (patch: Partial<ApiProvider>) => {
      const current = settings.data!;
      const p = current.providers[savedId!]!;
      return rpc('settings.update', { providers: { ...current.providers, [savedId!]: { ...p, ...patch } } });
    },
    { success: t('onboarding.ai.custom.modelSaved'), error: t('common.saveFailed'), onSuccess: (s) => qc.setQueryData(qk.settings, s) },
  );

  const saveLimits = useAction(
    async (patch: Partial<ApiProvider>) => {
      const current = settings.data!;
      const { modelInfo: _old, ...p } = current.providers[savedId!]!;
      return rpc('settings.update', { providers: { ...current.providers, [savedId!]: { ...p, ...(patch.modelInfo ? { modelInfo: patch.modelInfo } : {}) } } });
    },
    { success: t('limits.saved'), error: t('common.saveFailed'), onSuccess: (s) => qc.setQueryData(qk.settings, s) },
  );

  const createProfile = useAction(
    async (base: AgentTool) => {
      const current = settings.data!;
      const profile = providerProfile(base, savedId!, current.providers[savedId!]!);
      return rpc('settings.update', { agents: { ...current.agents, [providerProfileKey(base, savedId!)]: profile } });
    },
    {
      success: t('onboarding.ai.custom.profileCreated'),
      error: t('common.saveFailed'),
      invalidate: [qk.setup],
      onSuccess: (s) => qc.setQueryData(qk.settings, s),
    },
  );

  const submit = () => {
    setTouched(true);
    if (Object.keys(errors).length === 0) saveAndTest.mutate();
  };

  return (
    <div className="space-y-5">
      {existing.length > 0 && (
        <div>
          <div className="mb-2 text-sm font-medium text-fg">{t('onboarding.ai.custom.existing')}</div>
          <ul className="space-y-1.5">
            {existing.map(([id, p]) => (
              <li key={id} className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-sm">
                <Plug className="size-3.5 text-fg-subtle" />
                <span className="font-medium text-fg">{p.label}</span>
                <KindBadge kind={p.kind} />
                <KeyBadge status={keyStatus(p, secrets.data)} />
                {p.defaultModel && <span className="font-mono text-xs text-fg-subtle">{p.defaultModel}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {preset === undefined ? (
        <div>
          <div className="mb-1 text-sm font-medium text-fg">{t('onboarding.ai.custom.pickTitle')}</div>
          <p className="mb-3 text-sm text-fg-muted">{t('onboarding.ai.custom.pickText')}</p>
          <div className="grid gap-2.5 sm:grid-cols-2">
            {MODEL_PRESETS.map(([k, p]) => (
              <ChoiceCard key={k} selected={false} onSelect={() => pick(k)} icon={<Plug className="size-5" />} title={p.provider.label} badge={<KindBadge kind={p.provider.kind} />} description={localize(p.description, lang)} />
            ))}
            <ChoiceCard selected={false} onSelect={() => pick(null)} icon={<FilePlus2 className="size-5" />} title={t('providers.dialog.blank')} description={t('onboarding.ai.custom.blankText')} />
          </div>
        </div>
      ) : (
        <>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-fg">{preset ? PROVIDER_PRESETS[preset]?.provider.label : t('providers.dialog.blank')}</span>
              <KindBadge kind={form.kind} />
              <button type="button" onClick={reset} className="ml-auto text-xs text-accent hover:underline">
                {t('onboarding.ai.custom.otherTemplate')}
              </button>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('providers.form.label')} error={shown.label} hint={t('providers.form.labelHint')}>
                <Input value={form.label} onChange={(e) => update({ label: e.target.value })} invalid={!!shown.label} />
              </Field>
              {preset === null ? (
                <Field label={t('providers.form.kind')} hint={t(`providers.kind.${form.kind}.description`)}>
                  <Select value={form.kind} onChange={(e) => update({ kind: e.target.value as ProviderKind })} disabled={!isNew}>
                    {MODEL_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {t(`providers.kind.${k}`)}
                      </option>
                    ))}
                  </Select>
                </Field>
              ) : (
                <div />
              )}
            </div>
            <Field label={t('providers.form.baseUrl')} error={shown.baseUrl ?? shown.id} hint={t(`providers.form.baseUrlHint.${form.kind}`)}>
              <Input value={form.baseUrl} onChange={(e) => update({ baseUrl: e.target.value })} invalid={!!shown.baseUrl} className="font-mono" />
            </Field>
            {needsKey && (
              <Field
                label={t('providers.form.apiKey')}
                error={shown.secret}
                hint={rich(t('providers.form.apiKeyHint'), { secret: <code className="rounded bg-surface-2 px-1 font-mono">{secretName || '…'}</code> })}
              >
                {keyStored && !replaceKey && !key ? (
                  <StoredSecret info={secrets.data?.find((s) => s.name === secretName)}>
                    <span className="text-xs text-fg-subtle">{t('onboarding.ai.custom.keyReuse')}</span>
                    <Button size="sm" onClick={() => setReplaceKey(true)}>
                      {t('providers.form.replaceKey')}
                    </Button>
                  </StoredSecret>
                ) : (
                  <div className="flex gap-2">
                    <SecretInput value={key} onChange={(e) => setKey(e.target.value)} placeholder={t('providers.form.apiKeyPlaceholder')} autoFocus={replaceKey} />
                    {replaceKey && (
                      <Button
                        onClick={() => {
                          setReplaceKey(false);
                          setKey('');
                        }}
                      >
                        {t('common.cancel')}
                      </Button>
                    )}
                  </div>
                )}
              </Field>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" variant="primary" icon={<Zap className="size-4" />} loading={saveAndTest.isPending} disabled={needsKey && !key.trim() && (!keyStored || replaceKey)}>
                {savedId ? t('onboarding.ai.custom.saveAgain') : t('onboarding.ai.custom.saveTest')}
              </Button>
              <span className="text-xs text-fg-subtle">{t('onboarding.ai.custom.moreOptions')}</span>
            </div>
          </form>

          {result && (
            <ProviderTestResult
              result={{ ...result, models: [] }}
              kind={form.kind}
              onDismiss={() => setResult(null)}
              limitModels={saved ? [...(saved.defaultModel ? [saved.defaultModel] : []), ...saved.models] : undefined}
            />
          )}

          {saved && (result || !saved.defaultModel) && (
            <ModelPicker
              key={`${savedId}:${saved.defaultModel ?? ''}`}
              models={[...new Set([...(result?.models ?? []), ...saved.models])]}
              value={saved.defaultModel ?? ''}
              saving={saveProvider.isPending}
              onSave={(m) => saveProvider.mutate({ defaultModel: m || undefined, models: m && !saved.models.includes(m) ? [...saved.models, m] : saved.models })}
            />
          )}

          {saved && saved.kind !== 'http' && (saved.defaultModel || saved.models.length > 0) && (
            <ProviderLimitsCard provider={saved} detected={result?.modelInfo} saving={saveLimits.isPending} onSave={(modelInfo) => saveLimits.mutate({ modelInfo })} />
          )}

          {saved && saved.kind !== 'http' && settings.data && (
            <AgentTypeCreator
              provider={saved}
              existing={providerProfilesFor(settings.data.agents, savedId!).map((k) => profileLabel(k, settings.data?.agents[k], lang))}
              exists={(base) => hasProviderProfile(settings.data!.agents, base, savedId!)}
              loading={createProfile.isPending}
              onCreate={(base) => createProfile.mutate(base)}
            />
          )}

          {saved && (
            <Button variant="ghost" icon={<Plus className="size-4" />} onClick={reset}>
              {t('onboarding.ai.custom.addAnother')}
            </Button>
          )}
        </>
      )}
    </div>
  );
}

function ModelPicker({ models, value, saving, onSave }: { models: string[]; value: string; saving: boolean; onSave: (model: string) => void }) {
  const t = useT();
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const changed = draft.trim() !== value;
  return (
    <form
      className="rounded-xl border border-line bg-surface px-4 py-3.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (changed && draft.trim()) onSave(draft.trim());
      }}
    >
      <Field
        label={t('onboarding.ai.custom.modelTitle')}
        error={!value && !draft.trim() ? t('compat.err.modelRequired') : undefined}
        hint={models.length ? t('onboarding.ai.custom.modelHintFound', { count: models.length }) : t('onboarding.ai.custom.modelHintNone')}
      >
        <div className="flex flex-wrap items-start gap-2">
          <ModelSelect value={draft} onChange={setDraft} models={models} className="max-w-md flex-1" invalid={!value && !draft.trim()} />
          <Button type="submit" loading={saving} disabled={!changed || !draft.trim()}>
            {t('common.save')}
          </Button>
        </div>
      </Field>
      {value && !changed && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-400">
          <CircleCheck className="size-3.5" /> {t('compat.modelSet', { model: value })}
        </p>
      )}
    </form>
  );
}

/**
 * Explicit "create agent type" for a provider: the user sees which agent will use it (with compatibility)
 * and nothing is created until they click. Chat-only servers get OpenCode / Pi / Qwen Code recommended.
 */
function AgentTypeCreator({
  provider,
  existing,
  exists,
  loading,
  onCreate,
}: {
  provider: ApiProvider;
  existing: string[];
  exists: (base: AgentTool) => boolean;
  loading: boolean;
  onCreate: (base: AgentTool) => void;
}) {
  const t = useT();
  const images = useImages();
  const candidates = rankBases(provider, images.data);
  const recommended = candidates[0]?.base;
  const [base, setBase] = useState<AgentTool | undefined>(undefined);
  const chosen = base ?? recommended;
  const pick = candidates.find((c) => c.base === chosen);
  const apis = providerApis(provider);
  const chatOnly = !!apis && apis.includes('chat') && !apis.includes('responses') && !apis.includes('messages');
  const name = chosen ? t('onboarding.ai.custom.profileName', { agent: toolLabel(chosen), provider: provider.label }) : '';
  const hasModel = !!provider.defaultModel;
  const already = chosen ? exists(chosen) : false;

  return (
    <div className="space-y-4 rounded-xl border border-accent/30 bg-accent-soft/30 px-4 py-4">
      <div className="flex items-start gap-3">
        <Bot className="mt-0.5 size-5 text-accent" />
        <div className="min-w-0 flex-1">
          <div className="font-medium text-fg">{t('compat.create.title')}</div>
          <p className="mt-0.5 text-sm leading-relaxed text-fg-muted">{t('compat.create.text', { provider: provider.label })}</p>
        </div>
      </div>

      {existing.length > 0 && (
        <p className="flex flex-wrap items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400">
          <CircleCheck className="size-4" /> {t('compat.create.existing', { names: existing.join(', ') })}
        </p>
      )}

      {candidates.length === 0 ? (
        <Callout tone="warning">{t('compat.create.none')}</Callout>
      ) : (
        <>
          <div className="text-sm font-medium text-fg">{t('compat.create.which')}</div>
          <div className="grid gap-2 sm:grid-cols-2">
            {candidates.map((c) => (
              <ChoiceCard
                key={c.base}
                selected={chosen === c.base}
                onSelect={() => setBase(c.base)}
                icon={<Bot className="size-5" />}
                title={toolLabel(c.base)}
                badge={
                  <>
                    {c.base === recommended && <Badge tone="accent">{t('compat.create.recommended')}</Badge>}
                    <CompatBadge level={c.compat} />
                    {c.installed === false && <Badge tone="amber">{t('compat.tool.missing')}</Badge>}
                    {exists(c.base) && <Badge tone="green">{t('compat.create.exists')}</Badge>}
                  </>
                }
                description={<span className="text-xs">{t(`compat.create.why.${c.compat}`)}</span>}
              />
            ))}
          </div>
          {chatOnly && <p className="text-xs leading-relaxed text-fg-muted">{t('compat.create.chatOnlyNote')}</p>}
          {!apis && <p className="text-xs leading-relaxed text-fg-muted">{t('compat.create.untestedNote')}</p>}
          {pick?.installed === false && chosen && (
            <div className="flex flex-wrap items-center gap-2 text-sm text-fg-muted">
              <span>{t('compat.create.notInstalled', { tool: toolLabel(chosen) })}</span>
              <InstallToolButton tool={chosen} size="sm" />
            </div>
          )}
          <BuildLog kind="agents" />
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" icon={<Plus className="size-4" />} loading={loading} disabled={!chosen || !hasModel || already} onClick={() => chosen && onCreate(chosen)}>
              {chosen ? t('compat.create.button', { name }) : t('onboarding.ai.custom.profileCreate')}
            </Button>
            {!hasModel && <span className="text-xs text-amber-700 dark:text-amber-400">{t('compat.create.needModel')}</span>}
            {already && <span className="text-xs text-fg-subtle">{t('onboarding.ai.custom.profileExists', { name })}</span>}
          </div>
          <p className="text-xs text-fg-subtle">{t('onboarding.ai.custom.profileWhy')}</p>
        </>
      )}
    </div>
  );
}
