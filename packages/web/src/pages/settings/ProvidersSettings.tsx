import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { localize, PROVIDER_PRESETS, type ApiProvider, type ProviderKind, type SecretInfo, type Settings } from '@cocoon/protocol';
import {
  ChevronDown,
  ChevronRight,
  CircleCheck,
  FilePlus2,
  Globe,
  KeyRound,
  Pencil,
  Plug,
  Plus,
  Server,
  Star,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import { qk } from '../../api/keys';
import { useSecrets, useSettings } from '../../api/queries';
import { describeError, rpc } from '../../api/rpc';
import { useAction } from '../../api/useAction';
import { Button, IconButton } from '../../components/Button';
import { Card, CardBody, CardHeader } from '../../components/Card';
import { ConfirmDialog, Dialog } from '../../components/Dialog';
import { Checkbox, ChoiceCard, Field, Input, Select } from '../../components/Field';
import { Callout } from '../../components/HelpText';
import { ApiChips } from '../../components/CompatBits';
import { ModelSelect } from '../../components/ModelSelect';
import { KeyBadge, KindBadge, ProviderTestResult } from '../../components/ProviderTestResult';
import { SecretInput } from '../../components/SecretInput';
import { ErrorState, LoadingState } from '../../components/States';
import { rich, useLanguage, useT } from '../../i18n';
import { cn } from '../../lib/cn';
import {
  AUTHS,
  BLANK_PROVIDER,
  buildProvider,
  defaultEnvPrefix,
  defaultSecretName,
  formFrom,
  keyStatus,
  KINDS,
  profilesUsing,
  providerEnvVars,
  validateForm,
  type Auth,
  type ProviderForm,
  type ProviderFormErrors,
  type TestResult,
} from '../../lib/providers';
import { isSecretSet } from '../../lib/secrets';
import { AGENT_BASES, apisCompat, providerApis, toolLabel } from '../../lib/compat';
import { Badge } from '../../components/Badge';
import { profileLabel } from '../../components/SpawnAgentDialog';
import { LimitsIntro, ModelLimitsEditor } from '../../components/ModelLimits';
import { formatTokens, mergeDetected, typesWithoutContext } from '../../lib/modelLimits';

export function ProvidersSettings() {
  const t = useT();
  const { lang } = useLanguage();
  const settings = useSettings();
  const secrets = useSecrets();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<{ id?: string } | null>(null);
  const [toDelete, setToDelete] = useState<string | null>(null);
  const [deleteKey, setDeleteKey] = useState(false);

  const providers = settings.data?.providers ?? {};
  const entries = Object.entries(providers);

  const del = useAction(
    async ({ id, withKey }: { id: string; withKey: boolean }) => {
      const current = settings.data!;
      const { [id]: removed, ...rest } = current.providers;
      // Remove the reference from agent types too, so they don't point to a provider that no longer exists.
      const users = profilesUsing(current, id);
      const agents = users.length
        ? Object.fromEntries(Object.entries(current.agents).map(([k, p]) => [k, { ...p, providers: p.providers.filter((x) => x !== id) }]))
        : undefined;
      const next = await rpc('settings.update', { providers: rest, ...(agents ? { agents } : {}) });
      const secret = removed?.secret;
      const sharedSecret = secret && Object.values(rest).some((p) => p.secret === secret);
      if (withKey && secret && !sharedSecret) await rpc('secrets.delete', { name: secret }).catch(() => undefined);
      return next;
    },
    {
      success: (_, v) => t('providers.deleted', { name: providers[v.id]?.label ?? v.id }),
      error: t('common.deleteFailed'),
      invalidate: [qk.secrets, qk.setup],
      onSuccess: (next) => {
        qc.setQueryData(qk.settings, next);
        setToDelete(null);
      },
    },
  );

  if (settings.isLoading) return <LoadingState />;
  if (settings.error) return <ErrorState error={settings.error} onRetry={() => settings.refetch()} />;

  const deleting = toDelete ? providers[toDelete] : undefined;
  const deletingUsers = toDelete ? profilesUsing(settings.data, toDelete) : [];

  return (
    <div className="space-y-6">
      <Callout tone="info" title={t('providers.introTitle')}>
        <p>{t('providers.intro1')}</p>
        <p className="mt-1.5">{t('providers.intro2')}</p>
      </Callout>

      <Card>
        <CardHeader
          icon={<Server className="size-4.5" />}
          title={t('providers.listTitle')}
          description={t('providers.listDescription')}
          actions={
            <Button size="sm" variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setEditing({})}>
              {t('providers.add')}
            </Button>
          }
        />
        {entries.length === 0 ? (
          <CardBody className="flex flex-col items-center gap-3 py-10 text-center">
            <Plug className="size-7 text-fg-subtle" />
            <div className="font-medium text-fg">{t('providers.emptyTitle')}</div>
            <p className="max-w-md text-sm text-fg-muted">{t('providers.emptyText')}</p>
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing({})}>
              {t('providers.add')}
            </Button>
          </CardBody>
        ) : (
          <ul className="divide-y divide-line">
            {entries.map(([id, p]) => (
              <ProviderRow
                key={id}
                id={id}
                provider={p}
                secrets={secrets.data}
                usedBy={profilesUsing(settings.data, id).map((k) => profileLabel(k, settings.data?.agents[k], lang))}
                missingLimits={typesWithoutContext(settings.data, id).map((m) => ({ ...m, label: profileLabel(m.key, settings.data?.agents[m.key], lang) }))}
                onEdit={() => setEditing({ id })}
                onDelete={() => {
                  setDeleteKey(false);
                  setToDelete(id);
                }}
              />
            ))}
          </ul>
        )}
      </Card>

      {editing && settings.data && (
        <ProviderDialog open onClose={() => setEditing(null)} editId={editing.id} settings={settings.data} secrets={secrets.data} />
      )}

      <ConfirmDialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={() => toDelete && del.mutate({ id: toDelete, withKey: deleteKey })}
        loading={del.isPending}
        danger
        title={t('providers.deleteTitle')}
        confirmLabel={t('common.delete')}
        message={
          <div className="space-y-3">
            <p>{rich(t('providers.deleteText'), { name: <strong className="text-fg">{deleting?.label ?? toDelete}</strong> })}</p>
            {deletingUsers.length > 0 && (
              <Callout tone="warning">
                {t('providers.deleteUsedBy', {
                  count: deletingUsers.length,
                  profiles: deletingUsers.map((k) => profileLabel(k, settings.data?.agents[k], lang)).join(', '),
                })}
              </Callout>
            )}
            {deleting?.secret && isSecretSet(secrets.data, deleting.secret) && (
              <Checkbox checked={deleteKey} onChange={setDeleteKey} label={t('providers.deleteKeyToo', { secret: deleting.secret })} />
            )}
          </div>
        }
      />
    </div>
  );
}

function ProviderRow({
  id,
  provider: p,
  secrets,
  usedBy,
  missingLimits,
  onEdit,
  onDelete,
}: {
  id: string;
  provider: ApiProvider;
  secrets: SecretInfo[] | undefined;
  usedBy: string[];
  /** Agent types using a model of this provider whose context window is unknown. */
  missingLimits: Array<{ key: string; model: string; label: string }>;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  const [result, setResult] = useState<TestResult | null>(null);
  const test = useAction(() => rpc('providers.test', { id }), {
    error: t('providers.test.failed'),
    // The server stores the detected APIs on the provider.
    invalidate: [qk.settings],
    onSuccess: setResult,
  });
  const status = keyStatus(p, secrets);
  const apis = providerApis(p);
  const usable = apis ? AGENT_BASES.map((b) => [b, apisCompat(b, apis)] as const).filter(([, c]) => c === 'native' || c === 'translated') : [];
  const noModel = p.kind !== 'http' && !p.defaultModel && p.models.length === 0;
  return (
    <li className="px-5 py-4">
      <div className="flex flex-wrap items-start gap-3">
        <Plug className="mt-0.5 size-4 text-fg-subtle" />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-fg">{p.label}</span>
            <span className="font-mono text-xs text-fg-subtle">{id}</span>
            <KindBadge kind={p.kind} />
            <KeyBadge status={status} />
            {noModel && <Badge tone="amber">{t('compat.noModel')}</Badge>}
          </div>
          <div className="flex items-center gap-1.5 font-mono text-xs break-all text-fg-muted">
            <Globe className="size-3 shrink-0" />
            {p.baseUrl}
          </div>
          {p.secret && p.auth !== 'none' && (
            <div className="flex items-center gap-1.5 text-xs text-fg-subtle">
              <KeyRound className="size-3 shrink-0" />
              <span className="font-mono">{p.secret}</span>
            </div>
          )}
          {(p.models.length > 0 || p.defaultModel) && (
            <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
              <span className="text-xs text-fg-subtle">{t('providers.models')}:</span>
              {Array.from(new Set([...(p.defaultModel ? [p.defaultModel] : []), ...p.models])).map((m) => (
                <span
                  key={m}
                  className={cn('rounded-md px-1.5 py-0.5 font-mono text-[11px]', m === p.defaultModel ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-fg-muted')}
                  title={m === p.defaultModel ? t('providers.defaultModel') : undefined}
                >
                  {m === p.defaultModel && <Star className="mr-0.5 inline size-2.5" />}
                  {m}
                  {p.modelInfo?.[m]?.contextWindow !== undefined && (
                    <span className="ml-1 font-sans text-fg-subtle">· {t('limits.contextShort', { value: formatTokens(p.modelInfo[m].contextWindow) })}</span>
                  )}
                </span>
              ))}
            </div>
          )}
          {p.kind !== 'http' &&
            (apis ? (
              <div className="space-y-1 pt-0.5">
                <ApiChips apis={apis} />
                <p className="text-xs text-fg-muted">
                  {usable.length > 0
                    ? t('compat.usableWith', {
                        agents: usable.map(([b, c]) => (c === 'translated' ? t('compat.viaTranslation', { agent: toolLabel(b) }) : toolLabel(b))).join(', '),
                      })
                    : t('compat.usableWithNone')}
                </p>
              </div>
            ) : (
              <p className="text-xs text-fg-muted">{t('compat.notTestedYet')}</p>
            ))}
          {missingLimits.length > 0 && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              {t('limits.missing', {
                model: Array.from(new Set(missingLimits.map((m) => m.model))).join(', '),
                types: missingLimits.map((m) => m.label).join(', '),
              })}
            </p>
          )}
          <p className="text-xs text-fg-subtle">
            {usedBy.length > 0 ? (
              t('providers.usedBy', { profiles: usedBy.join(', ') })
            ) : p.kind === 'http' ? (
              t('providers.notUsedHttp')
            ) : (
              rich(t('providers.notUsed'), {
                link: (
                  <Link to="/settings/agents" className="text-accent hover:underline">
                    {t('settingsNav.agents')}
                  </Link>
                ),
              })
            )}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" icon={<Zap className="size-3.5" />} loading={test.isPending} onClick={() => test.mutate()}>
            {t('providers.test.button')}
          </Button>
          <Button size="sm" icon={<Pencil className="size-3.5" />} onClick={onEdit}>
            {t('common.edit')}
          </Button>
          <IconButton label={t('common.delete')} icon={<Trash2 className="size-4" />} onClick={onDelete} />
        </div>
      </div>
      {result && (
        <div className="mt-3 ml-7">
          <ProviderTestResult
            result={result}
            kind={p.kind}
            onDismiss={() => setResult(null)}
            limitModels={[...(p.defaultModel ? [p.defaultModel] : []), ...p.models]}
          />
        </div>
      )}
    </li>
  );
}

// ── Add / edit dialog ────────────────────────────────────────────────────────

function ProviderDialog({
  open,
  onClose,
  editId,
  settings,
  secrets,
}: {
  open: boolean;
  onClose: () => void;
  editId?: string;
  settings: Settings;
  secrets: SecretInfo[] | undefined;
}) {
  const t = useT();
  const { lang } = useLanguage();
  const qc = useQueryClient();
  const isNew = !editId;
  const [step, setStep] = useState<'template' | 'form'>(isNew ? 'template' : 'form');
  const [form, setForm] = useState<ProviderForm>(() => formFrom(editId ?? '', editId ? settings.providers[editId]! : BLANK_PROVIDER, isNew));
  const [apiKey, setApiKey] = useState('');
  const [replaceKey, setReplaceKey] = useState(false);
  const [modelInput, setModelInput] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [touched, setTouched] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [limitsValid, setLimitsValid] = useState(true);

  const update = (patch: Partial<ProviderForm>) => setForm((f) => ({ ...f, ...patch }));
  const errors = validateForm(t, form, isNew, settings.providers, true);
  const hasErrors = Object.keys(errors).length > 0 || !limitsValid;
  const secretName = form.secretCustom ? form.secret.trim() : defaultSecretName(form.id);
  const secretInfo = secrets?.find((s) => s.name === secretName && s.set);
  const keyStored = !!secretInfo;
  const needsKey = form.auth !== 'none';
  const prefix = form.envPrefixCustom ? form.envPrefix.trim() : defaultEnvPrefix(form.id);
  const shownErrors: ProviderFormErrors = touched ? errors : { ...(form.id && errors.id ? { id: errors.id } : {}), ...(form.baseUrl && errors.baseUrl ? { baseUrl: errors.baseUrl } : {}) };
  // The connection test needs no model yet – it discovers them.
  const { defaultModel: _modelError, ...testErrors } = errors;
  const isModelKind = form.kind !== 'http';
  const knownModels = Array.from(new Set([...form.models, ...(testResult?.models ?? [])]));

  useEffect(() => {
    setReplaceKey(false);
  }, [secretName]);

  const pickTemplate = (key: string | null) => {
    if (key) {
      const preset = PROVIDER_PRESETS[key]!;
      const id = settings.providers[key] ? '' : key;
      setForm(formFrom(id, preset.provider, true));
      // The preset's secret / prefix names are meaningful – keep them even if the id changes.
      if (preset.provider.secret) setForm((f) => ({ ...f, secret: preset.provider.secret!, secretCustom: true }));
      if (preset.provider.envPrefix) setForm((f) => ({ ...f, envPrefix: preset.provider.envPrefix!, envPrefixCustom: true }));
    } else {
      setForm(formFrom('', BLANK_PROVIDER, true));
    }
    setStep('form');
  };

  const storeKey = async () => {
    const value = apiKey.trim();
    if (!needsKey || !value) return;
    await rpc('secrets.set', { name: secretName, value });
    setApiKey('');
    setReplaceKey(false);
    await qc.invalidateQueries({ queryKey: qk.secrets });
  };

  const runTest = async () => {
    // The id matters too: the key is stored under a secret name derived from it.
    if (Object.keys(testErrors).length > 0) {
      setTouched(true);
      return;
    }
    setTesting(true);
    setTestError(null);
    setTestResult(null);
    try {
      await storeKey();
      const r = await rpc('providers.test', { provider: buildProvider(form) });
      setTestResult(r);
      if (r.ok) {
        setForm((f) => {
          const first = r.models[0];
          // Remember the detected APIs; preselect the first discovered model if none is set.
          const pick = !f.defaultModel && first && f.kind !== 'http';
          return {
            ...f,
            apis: r.apis ?? [],
            // Detected limits; values the user entered stay.
            modelInfo: mergeDetected(f.modelInfo, r.modelInfo),
            ...(pick ? { defaultModel: first, models: f.models.includes(first) ? f.models : [...f.models, first] } : {}),
          };
        });
      }
    } catch (err) {
      setTestError(describeError(err));
    } finally {
      setTesting(false);
    }
  };

  const save = useAction(
    async () => {
      await storeKey();
      return rpc('settings.update', { providers: { ...settings.providers, [form.id]: buildProvider(form) } });
    },
    {
      success: isNew ? t('providers.added', { name: form.label.trim() }) : t('providers.saved', { name: form.label.trim() }),
      error: t('common.saveFailed'),
      invalidate: [qk.setup, qk.secrets],
      onSuccess: (next) => {
        qc.setQueryData(qk.settings, next);
        onClose();
      },
    },
  );

  const addModel = (m: string) => {
    const v = m.trim();
    if (!v) return;
    setForm((f) => (f.models.includes(v) ? f : { ...f, models: [...f.models, v], defaultModel: f.defaultModel || v }));
  };

  const submit = () => {
    setTouched(true);
    if (!hasErrors) save.mutate();
  };

  const busy = save.isPending || testing;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="xl"
      dismissable={!busy}
      title={isNew ? t('providers.dialog.addTitle') : t('providers.dialog.editTitle', { name: settings.providers[editId!]?.label ?? editId! })}
      description={step === 'template' ? t('providers.dialog.templateDescription') : undefined}
      footer={
        step === 'template' ? (
          <Button onClick={onClose}>{t('common.cancel')}</Button>
        ) : (
          <>
            {isNew && (
              <Button variant="ghost" onClick={() => setStep('template')} disabled={busy} className="mr-auto">
                {t('common.back')}
              </Button>
            )}
            <Button onClick={onClose} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button icon={<Zap className="size-4" />} onClick={runTest} loading={testing} disabled={save.isPending}>
              {t('providers.test.button')}
            </Button>
            <Button variant="primary" onClick={submit} loading={save.isPending} disabled={testing || (touched && hasErrors)}>
              {isNew ? t('providers.dialog.create') : t('common.save')}
            </Button>
          </>
        )
      }
    >
      {step === 'template' ? (
        <div className="grid gap-2.5 sm:grid-cols-2">
          {Object.entries(PROVIDER_PRESETS).map(([key, preset]) => (
            <ChoiceCard
              key={key}
              selected={false}
              onSelect={() => pickTemplate(key)}
              icon={<Plug className="size-5" />}
              title={preset.provider.label}
              badge={<KindBadge kind={preset.provider.kind} />}
              description={localize(preset.description, lang)}
            />
          ))}
          <ChoiceCard
            selected={false}
            onSelect={() => pickTemplate(null)}
            icon={<FilePlus2 className="size-5" />}
            title={t('providers.dialog.blank')}
            description={t('providers.dialog.blankDescription')}
          />
        </div>
      ) : (
        <div className="space-y-6">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label={t('providers.form.label')} error={shownErrors.label} hint={t('providers.form.labelHint')}>
              <Input value={form.label} onChange={(e) => update({ label: e.target.value })} invalid={!!shownErrors.label} placeholder="OpenRouter" />
            </Field>
            <Field label={t('providers.form.id')} error={shownErrors.id} hint={isNew ? t('providers.form.idHint') : t('providers.form.idLocked')}>
              <Input
                value={form.id}
                onChange={(e) => update({ id: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })}
                disabled={!isNew}
                invalid={!!shownErrors.id}
                className="font-mono"
                placeholder="my-gateway"
              />
            </Field>
          </div>

          <div>
            <div className="mb-2 text-sm font-medium text-fg">{t('providers.form.kind')}</div>
            <div className="grid gap-2.5 md:grid-cols-3">
              {KINDS.map((k) => (
                <ChoiceCard
                  key={k}
                  selected={form.kind === k}
                  onSelect={() => update({ kind: k })}
                  title={t(`providers.kind.${k}`)}
                  description={k === 'http' ? t('providers.kind.http.description', { prefix: prefix || 'PREFIX' }) : t(`providers.kind.${k}.description`)}
                />
              ))}
            </div>
          </div>

          <Field label={t('providers.form.baseUrl')} error={shownErrors.baseUrl} hint={t(`providers.form.baseUrlHint.${form.kind}`)}>
            <Input
              value={form.baseUrl}
              onChange={(e) => update({ baseUrl: e.target.value, apis: undefined })}
              invalid={!!shownErrors.baseUrl}
              className="font-mono"
              placeholder={form.kind === 'openai' ? 'https://example.com/v1' : 'https://example.com'}
            />
          </Field>

          <div className="grid gap-4 md:grid-cols-2">
            <Field label={t('providers.form.auth')} hint={t(`providers.auth.${form.auth}.hint`)}>
              <Select value={form.auth} onChange={(e) => update({ auth: e.target.value as Auth })}>
                {AUTHS.map((a) => (
                  <option key={a} value={a}>
                    {t(`providers.auth.${a}`)}
                  </option>
                ))}
              </Select>
            </Field>
            {form.auth === 'header' && (
              <Field label={t('providers.form.authHeader')} error={shownErrors.authHeader} hint={t('providers.form.authHeaderHint')}>
                <Input value={form.authHeader} onChange={(e) => update({ authHeader: e.target.value })} invalid={!!shownErrors.authHeader} className="font-mono" placeholder="X-Api-Token" />
              </Field>
            )}
          </div>

          {needsKey && (
            <Field
              label={t('providers.form.apiKey')}
              error={shownErrors.secret}
              hint={rich(t('providers.form.apiKeyHint'), { secret: <code className="rounded bg-surface-2 px-1 font-mono">{secretName || '…'}</code> })}
            >
              {keyStored && !replaceKey ? (
                <div className="flex flex-wrap items-center gap-3 rounded-lg border border-emerald-500/25 bg-emerald-500/5 px-3 py-2">
                  <CircleCheck className="size-4 text-emerald-600" />
                  <span className="text-sm text-fg">{t('providers.form.keySaved')}</span>
                  <span className="font-mono text-xs text-fg-subtle">{secretInfo?.preview ?? '••••'}</span>
                  {secretInfo?.source === 'env' && <span className="text-xs text-fg-subtle">{t('providers.form.keyFromEnv')}</span>}
                  <span className="flex-1" />
                  <Button size="sm" onClick={() => setReplaceKey(true)}>
                    {t('providers.form.replaceKey')}
                  </Button>
                </div>
              ) : (
                <div className="flex gap-2">
                  <SecretInput value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={t('providers.form.apiKeyPlaceholder')} />
                  {replaceKey && (
                    <Button
                      onClick={() => {
                        setReplaceKey(false);
                        setApiKey('');
                      }}
                    >
                      {t('common.cancel')}
                    </Button>
                  )}
                </div>
              )}
            </Field>
          )}

          <Field label={t('providers.form.models')} optional hint={t('providers.form.modelsHint')}>
            <div className="space-y-2">
              {form.models.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {form.models.map((m) => (
                    <span
                      key={m}
                      className={cn(
                        'inline-flex items-center gap-1 rounded-md py-0.5 pr-1 pl-2 font-mono text-xs ring-1 ring-inset',
                        m === form.defaultModel ? 'bg-accent-soft text-accent ring-accent/25' : 'bg-surface-2 text-fg ring-line',
                      )}
                    >
                      {m}
                      <button
                        type="button"
                        title={t('providers.test.setDefault')}
                        aria-label={t('providers.test.setDefault')}
                        onClick={() => update({ defaultModel: m })}
                        className={m === form.defaultModel ? 'text-accent' : 'text-fg-subtle hover:text-fg'}
                      >
                        <Star className={cn('size-3', m === form.defaultModel && 'fill-current')} />
                      </button>
                      <button
                        type="button"
                        aria-label={t('common.remove')}
                        title={t('common.remove')}
                        onClick={() => setForm((f) => ({ ...f, models: f.models.filter((x) => x !== m), defaultModel: f.defaultModel === m ? '' : f.defaultModel }))}
                        className="text-fg-subtle hover:text-fg"
                      >
                        <X className="size-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <div className="flex gap-2">
                <Input
                  value={modelInput}
                  onChange={(e) => setModelInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addModel(modelInput);
                      setModelInput('');
                    }
                  }}
                  className="flex-1 font-mono"
                  placeholder={form.kind === 'anthropic' ? 'claude-sonnet-4-5' : form.kind === 'openai' ? 'gpt-5' : t('providers.form.modelPlaceholder')}
                />
                <Button
                  icon={<Plus className="size-4" />}
                  disabled={!modelInput.trim()}
                  onClick={() => {
                    addModel(modelInput);
                    setModelInput('');
                  }}
                >
                  {t('common.add')}
                </Button>
              </div>
            </div>
          </Field>

          <Field
            label={t('providers.defaultModel')}
            optional={!isModelKind}
            error={shownErrors.defaultModel}
            hint={isModelKind ? (knownModels.length ? t('compat.defaultModelHintRequired') : t('compat.defaultModelHintTest')) : t('providers.form.defaultModelHint')}
          >
            <ModelSelect
              key={knownModels.length}
              value={form.defaultModel}
              onChange={(m) => update({ defaultModel: m })}
              models={knownModels}
              invalid={!!shownErrors.defaultModel}
              allowEmpty={!isModelKind}
            />
          </Field>

          {isModelKind && (
            <div className="space-y-3 rounded-xl border border-line px-4 py-3.5">
              <LimitsIntro />
              <ModelLimitsEditor
                models={[...(form.defaultModel.trim() ? [form.defaultModel.trim()] : []), ...form.models]}
                value={form.modelInfo}
                detected={testResult?.modelInfo}
                onChange={(modelInfo, valid) => {
                  update({ modelInfo });
                  setLimitsValid(valid);
                }}
              />
            </div>
          )}

          {form.kind === 'http' && (
            <Field label={t('providers.form.envPrefix')} error={shownErrors.envPrefix} hint={t('providers.form.envPrefixHint')}>
              <Input
                value={prefix}
                onChange={(e) => update({ envPrefix: e.target.value.toUpperCase(), envPrefixCustom: true })}
                invalid={!!shownErrors.envPrefix}
                className="font-mono"
              />
            </Field>
          )}

          <EnvPreview kind={form.kind} auth={form.auth} prefix={prefix} />

          {(testResult || testError) && (
            <div id="provider-test-result">
              {testError ? (
                <Callout tone="danger" title={t('providers.test.failed')}>
                  {testError}
                </Callout>
              ) : (
                testResult && (
                  <ProviderTestResult
                    result={testResult}
                    kind={form.kind}
                    onDismiss={() => setTestResult(null)}
                    limitModels={[...(form.defaultModel ? [form.defaultModel] : []), ...form.models]}
                    models={form.models}
                    defaultModel={form.defaultModel}
                    onAddModel={addModel}
                    onDefaultModel={(m) => {
                      addModel(m);
                      update({ defaultModel: m });
                    }}
                  />
                )
              )}
            </div>
          )}

          {needsKey && (
            <div className="rounded-xl border border-line">
              <button type="button" onClick={() => setAdvanced((a) => !a)} className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm font-medium text-fg">
                {advanced ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                {t('common.advanced')}
              </button>
              {advanced && (
                <div className="space-y-4 border-t border-line px-4 py-4">
                  <Field label={t('providers.form.secretName')} error={shownErrors.secret} hint={t('providers.form.secretNameHint')}>
                    <Input
                      value={secretName}
                      onChange={(e) => update({ secret: e.target.value.toUpperCase(), secretCustom: true })}
                      invalid={!!shownErrors.secret}
                      className="font-mono"
                    />
                  </Field>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}

function EnvPreview({ kind, auth, prefix }: { kind: ProviderKind; auth: Auth; prefix: string }): ReactNode {
  const t = useT();
  const vars = useMemo(() => providerEnvVars(kind, auth, prefix || 'PREFIX'), [kind, auth, prefix]);
  return (
    <div className="rounded-xl border border-line bg-surface-2/50 px-4 py-3">
      <div className="text-sm font-medium text-fg">{t('providers.env.title')}</div>
      <ul className="mt-2 space-y-1">
        {vars.map((v) => (
          <li key={v} className="font-mono text-xs text-fg">
            {v}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs leading-relaxed text-fg-muted">{t(kind === 'http' ? 'providers.env.hintHttp' : 'providers.env.hintModel')}</p>
    </div>
  );
}
