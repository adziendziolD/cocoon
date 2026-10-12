import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import type { MethodParams, NetworkMode } from '@cocoon/protocol';
import { ArrowLeft, ArrowRight, Box, ChevronDown, ChevronRight, GlobeLock, Loader2 } from 'lucide-react';
import { qk } from '../api/keys';
import { useSandboxes, useSecrets, useServices, useSettings, useSystemInfo, useWorkspaces } from '../api/queries';
import { serviceLabel, serviceStatusMeta } from '../lib/services';
import { rpc } from '../api/rpc';
import { useAction } from '../api/useAction';
import { useT, type MessageKey } from '../i18n';
import { cn } from '../lib/cn';
import { runtimeInfo, SIZE_PRESETS, sizePresetLabel, type SizePresetId } from '../lib/runtimes';
import { nameFromRepo, presetFor, SANDBOX_NAME_RE } from '../lib/sandboxForm';
import { hasRepoErrors, hasRepoRows, plannedPaths, repoDir, repoRowsFrom, reposFromRows, validateRepoRows, type RepoRow } from '../lib/repos';
import { isSecretSet } from '../lib/secrets';
import { networkModeMeta } from '../lib/status';
import { Button } from './Button';
import { Dialog } from './Dialog';
import { Checkbox, Field, Input, Select } from './Field';
import { Callout } from './HelpText';
import { fromRows, KeyValueEditor, type KeyValueRow } from './KeyValueEditor';
import { RepoRowsEditor } from './RepoRowsEditor';
import { NetworkModeCards, SizePresetCards } from './SandboxOptions';

const STEPS: MessageKey[] = ['wizard.step.project', 'wizard.step.network', 'wizard.step.size'];

interface FormState {
  name: string;
  nameTouched: boolean;
  /** Repository rows; one row = the classic single repository in the project folder itself. */
  repos: RepoRow[];
  network: NetworkMode;
  size: SizePresetId;
  image: string;
  runtime: string;
  env: KeyValueRow[];
  /** '' = unassigned. */
  workspaceId: string;
  /** Explicit service choices; services not listed use their default (attach "all"). */
  services: Record<string, boolean>;
}

export function CreateSandboxWizard({ open, onClose, defaultWorkspaceId }: { open: boolean; onClose: () => void; defaultWorkspaceId?: string }) {
  const t = useT();
  const navigate = useNavigate();
  const settings = useSettings();
  const info = useSystemInfo();
  const secrets = useSecrets();
  const sandboxes = useSandboxes();
  const workspaces = useWorkspaces();
  const services = useServices();
  const [step, setStep] = useState(0);
  const [advanced, setAdvanced] = useState(false);
  const [form, setForm] = useState<FormState>(() => initialForm());

  function initialForm(): FormState {
    const s = settings.data?.sandbox;
    const preset = presetFor(s?.resources) ?? 'medium';
    const ws = workspaces.data?.find((w) => w.id === defaultWorkspaceId);
    return {
      name: '',
      nameTouched: false,
      repos: repoRowsFrom(ws?.repos, ws?.repo),
      network: ws?.network ?? s?.network ?? 'egress',
      size: preset,
      image: '',
      runtime: '',
      env: [],
      workspaceId: ws?.id ?? '',
      services: {},
    };
  }

  // Reset whenever the wizard is opened.
  useEffect(() => {
    if (open) {
      setStep(0);
      setAdvanced(false);
      setForm(initialForm());
      create.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));

  const create = useAction(
    (params: MethodParams<'sandbox.create'>) => rpc('sandbox.create', params),
    {
      success: (s) => t('wizard.created', { name: s.name }),
      error: t('wizard.createFailed'),
      invalidate: [qk.sandboxes, qk.setup],
      onSuccess: (s) => {
        onClose();
        navigate(`/sandboxes/${s.id}`);
      },
    },
  );

  const nameError = form.name && !SANDBOX_NAME_RE.test(form.name) ? t('wizard.nameError') : undefined;
  const repoErrors = validateRepoRows(t, form.repos);
  const repoError = hasRepoErrors(repoErrors);
  const withRepo = hasRepoRows(form.repos);
  const maxReached = settings.data && sandboxes.data && sandboxes.data.length >= settings.data.sandbox.maxSandboxes;
  const runtimes = info.data?.runtimes ?? [];
  const capabilities = info.data?.capabilities;
  const preset = SIZE_PRESETS.find((p) => p.id === form.size)!;
  const defaultRuntime = settings.data?.sandbox.runtime ?? null;

  const allServices = services.data ?? [];
  const serviceChecked = (id: string, attach: 'all' | 'manual') => form.services[id] ?? attach === 'all';
  const chosenServices = form.network === 'none' ? [] : allServices.filter((x) => serviceChecked(x.id, x.attach));

  const canNext = step === 0 ? !nameError && !repoError : true;

  const submit = () => {
    const env = fromRows(form.env);
    const repos = reposFromRows(form.repos);
    create.mutate({
      name: form.name.trim() || undefined,
      // One repository: the classic `repo` (cloned into the project folder itself); several: `repos`, each in its own folder.
      ...(repos.length === 1 ? { repo: repos[0] } : repos.length > 1 ? { repos } : {}),
      network: form.network,
      resources: { cpus: preset.cpus, memoryMb: preset.memoryMb },
      image: capabilities?.images === false ? undefined : form.image.trim() || undefined,
      runtime: capabilities?.runtimes === false || form.runtime === '' ? undefined : form.runtime === '__default' ? null : form.runtime,
      env: Object.keys(env).length ? env : undefined,
      workspaceId: form.workspaceId || undefined,
      services: allServices.length ? chosenServices.map((x) => x.id) : undefined,
    });
  };

  const summary = useMemo<Array<[string, ReactNode]>>(
    () => [
      [t('wizard.summary.name'), form.name.trim() || t('wizard.summary.nameAuto')],
      [t('wizard.summary.project'), <RepoSummary key="repos" rows={form.repos} />],
      ...(form.workspaceId ? [[t('wizard.workspaceLabel'), workspaces.data?.find((w) => w.id === form.workspaceId)?.name ?? form.workspaceId] as [string, ReactNode]] : []),
      [t('wizard.summary.internet'), networkModeMeta(t, form.network).short],
      [t('wizard.summary.size'), t('wizard.summary.sizeValue', { label: sizePresetLabel(t, preset.id), cpus: preset.cpus, gb: preset.memoryMb / 1024 })],
      ...(allServices.length
        ? [[t('wizard.summary.services'), chosenServices.map((x) => serviceLabel(x, allServices)).join(', ') || t('wizard.summary.servicesNone')] as [string, ReactNode]]
        : []),
    ],
    [form, preset, t, workspaces.data, allServices, chosenServices],
  );

  if (create.isPending) {
    return (
      <Dialog open={open} onClose={onClose} title={t('wizard.creatingTitle')} dismissable={false} size="md">
        <div className="flex flex-col items-center py-6 text-center">
          <Loader2 className="size-10 animate-spin text-accent" />
          <p className="mt-4 font-medium text-fg">{t('wizard.creatingWait')}</p>
          <p className="mt-1.5 max-w-sm text-sm text-fg-muted">
            {withRepo ? t('wizard.creatingWithRepo') : t('wizard.creatingEmpty')}
          </p>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={t('wizard.title')}
      description={t('wizard.description')}
      footer={
        <>
          {step > 0 && (
            <Button icon={<ArrowLeft className="size-4" />} onClick={() => setStep(step - 1)} className="mr-auto">
              {t('common.back')}
            </Button>
          )}
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          {step < STEPS.length - 1 ? (
            <Button variant="primary" onClick={() => setStep(step + 1)} disabled={!canNext}>
              {t('common.next')} <ArrowRight className="size-4" />
            </Button>
          ) : (
            <Button variant="primary" icon={<Box className="size-4" />} onClick={submit} disabled={!!nameError || repoError}>
              {t('wizard.submit')}
            </Button>
          )}
        </>
      }
    >
      <Stepper step={step} onStep={(i) => i < step && setStep(i)} />

      {maxReached && (
        <Callout tone="warning" className="mb-4" title={t('wizard.maxReachedTitle')}>
          {t('wizard.maxReached', { count: sandboxes.data!.length, max: settings.data!.sandbox.maxSandboxes })}
        </Callout>
      )}

      {step === 0 && (
        <div className="space-y-5">
          <RepoRowsEditor
            rows={form.repos}
            errors={repoErrors}
            urlHint={t('wizard.repoHint')}
            onChange={(repos) =>
              setForm((f) => ({ ...f, repos, name: f.nameTouched || repos[0]?.url === f.repos[0]?.url ? f.name : nameFromRepo(repos[0]?.url ?? '') }))
            }
          />
          {withRepo && !isSecretSet(secrets.data, 'GITHUB_TOKEN') && (
            <Callout tone="tip">{t('wizard.privateRepoTip')}</Callout>
          )}
          {!!workspaces.data?.length && (
            <Field label={t('wizard.workspaceLabel')} optional htmlFor="workspace" hint={t('wizard.workspaceHint')}>
              <Select
                id="workspace"
                value={form.workspaceId}
                onChange={(e) => {
                  const ws = workspaces.data?.find((w) => w.id === e.target.value);
                  // Take over the workspace's repository and network as a starting point.
                  setForm((f) => ({
                    ...f,
                    workspaceId: e.target.value,
                    repos: hasRepoRows(f.repos) ? f.repos : repoRowsFrom(ws?.repos, ws?.repo),
                    network: ws?.network ?? f.network,
                  }));
                }}
              >
                <option value="">{t('workspace.unassigned')}</option>
                {workspaces.data.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label={t('wizard.nameLabel')} optional htmlFor="name" error={nameError} hint={t('wizard.nameHint')}>
            <Input id="name" value={form.name} invalid={!!nameError} placeholder={t('wizard.namePlaceholder')} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value, nameTouched: true }))} />
          </Field>
        </div>
      )}

      {step === 1 && (
        <div className="space-y-3">
          <p className="text-sm text-fg-muted">{t('wizard.networkIntro')}</p>
          <NetworkModeCards value={form.network} onChange={(m) => set('network', m)} defaultMode={settings.data?.sandbox.network} />
          {form.network === 'none' && withRepo && (
            <Callout tone="warning" title={t('wizard.networkConflictTitle')}>
              {t('wizard.networkConflict', { egress: networkModeMeta(t, 'egress').short })}
            </Callout>
          )}
          {form.network === 'egress' && (
            <p className="flex items-center gap-1.5 text-xs text-fg-muted">
              <GlobeLock className="size-3.5" /> {t('wizard.egressHint')}
            </p>
          )}
          {allServices.length > 0 && (
            <div className="mt-2 rounded-xl border border-line px-4 py-3">
              <div className="text-sm font-medium text-fg">{t('wizard.services.title')}</div>
              <p className="mt-0.5 mb-2.5 text-xs text-fg-muted">{form.network === 'none' ? t('wizard.services.noNetwork') : t('wizard.services.hint')}</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {allServices.map((x) => (
                  <Checkbox
                    key={x.id}
                    disabled={form.network === 'none'}
                    checked={form.network !== 'none' && serviceChecked(x.id, x.attach)}
                    onChange={(v) => setForm((f) => ({ ...f, services: { ...f.services, [x.id]: v } }))}
                    label={serviceLabel(x, allServices)}
                    description={x.status !== 'running' ? t('wizard.services.notRunning', { status: serviceStatusMeta(t, x.status).label }) : undefined}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {step === 2 && (
        <div className="space-y-5">
          <div>
            <div className="mb-2 text-sm font-medium text-fg">{t('wizard.sizeLabel')}</div>
            <SizePresetCards value={form.size} onChange={(id) => set('size', id)} />
            <p className="mt-2 text-xs text-fg-muted">{t('wizard.sizeHint')}</p>
          </div>

          <div className="rounded-xl border border-line">
            <button type="button" onClick={() => setAdvanced((a) => !a)} className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-medium text-fg">
              {advanced ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
              {t('common.advanced')}
              <span className="font-normal text-fg-muted">{t('wizard.advancedWarning')}</span>
            </button>
            {advanced && (
              <div className="space-y-4 border-t border-line px-4 py-4">
                {capabilities?.images !== false && (
                  <Field label={t('wizard.imageLabel')} optional hint={t('wizard.imageHint', { image: settings.data?.sandbox.image ?? 'cocoon/sandbox:latest' })}>
                    <Input value={form.image} onChange={(e) => set('image', e.target.value)} placeholder={settings.data?.sandbox.image} />
                  </Field>
                )}
                {capabilities?.runtimes !== false && (
                  <Field label={t('wizard.runtimeLabel')} hint={runtimeInfo(t, form.runtime === '' ? defaultRuntime : form.runtime === '__default' ? null : form.runtime).description}>
                    <Select value={form.runtime} onChange={(e) => set('runtime', e.target.value)}>
                      <option value="">{t('wizard.runtimeServerDefault', { runtime: runtimeInfo(t, defaultRuntime).label })}</option>
                      <option value="__default">{runtimeInfo(t, null).label}</option>
                      {runtimes
                        .filter((r) => r !== 'runc')
                        .map((r) => (
                          <option key={r} value={r}>
                            {runtimeInfo(t, r).label}
                          </option>
                        ))}
                    </Select>
                  </Field>
                )}
                <Field label={t('wizard.envLabel')} optional hint={t('wizard.envHint')}>
                  <KeyValueEditor rows={form.env} onChange={(env) => set('env', env)} />
                </Field>
              </div>
            )}
          </div>

          <div className="rounded-xl bg-surface-2/70 px-4 py-3">
            <div className="mb-1.5 text-xs font-medium tracking-wide text-fg-subtle uppercase">{t('wizard.summary')}</div>
            <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1 text-sm">
              {summary.map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-fg-muted">{k}</dt>
                  <dd className="truncate text-fg">{v}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      )}
    </Dialog>
  );
}

/** Summary of the repositories: "leerer Ordner", one URL, or folder ← URL per repository. */
function RepoSummary({ rows }: { rows: RepoRow[] }) {
  const t = useT();
  const filled = rows.filter((r) => r.url.trim());
  const paths = plannedPaths(rows).filter((p) => p !== undefined);
  if (!filled.length) return <>{t('wizard.summary.emptyFolder')}</>;
  const label = (r: RepoRow) => `${r.url.trim()}${r.ref.trim() ? ` (${r.ref.trim()})` : ''}`;
  if (filled.length === 1) return <>{label(filled[0]!)}</>;
  return (
    <ul className="space-y-0.5">
      {filled.map((r, i) => (
        <li key={i} className="truncate">
          <span className="font-mono text-[13px]">{repoDir(paths[i] ?? '')}</span> <span className="text-fg-muted">← {label(r)}</span>
        </li>
      ))}
    </ul>
  );
}

function Stepper({ step, onStep }: { step: number; onStep: (i: number) => void }) {
  const t = useT();
  return (
    <ol className="mb-5 flex items-center gap-2">
      {STEPS.map((label, i) => (
        <li key={label} className="flex flex-1 items-center gap-2">
          <button
            type="button"
            onClick={() => onStep(i)}
            className={cn('flex items-center gap-2 text-sm', i <= step ? 'text-fg' : 'text-fg-subtle', i < step && 'cursor-pointer hover:underline')}
          >
            <span
              className={cn(
                'flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                i < step ? 'bg-accent text-accent-fg' : i === step ? 'bg-accent-soft text-accent ring-2 ring-accent' : 'bg-surface-2 text-fg-subtle',
              )}
            >
              {i + 1}
            </span>
            <span className="hidden font-medium sm:inline">{t(label)}</span>
          </button>
          {i < STEPS.length - 1 && <span className={cn('h-px flex-1', i < step ? 'bg-accent' : 'bg-line')} />}
        </li>
      ))}
    </ol>
  );
}
