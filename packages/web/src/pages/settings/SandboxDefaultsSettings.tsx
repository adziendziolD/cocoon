import { useState } from 'react';
import { SandboxVariant, type DriverKind, type ImageInfo, type NetworkMode, type Settings } from '@cocoon/protocol';
import { Boxes, RotateCcw } from 'lucide-react';
import { useImages, useSettings, useSystemInfo } from '../../api/queries';
import { Badge } from '../../components/Badge';
import { BuildImageButton, BuildLog, imageLabel } from '../../components/BuildLog';
import { Button } from '../../components/Button';
import { Card, CardBody, CardHeader } from '../../components/Card';
import { CodeBlock } from '../../components/CodeBlock';
import { ConfirmDialog } from '../../components/Dialog';
import { Field, Input, Select } from '../../components/Field';
import { ToolboxPicker } from '../../components/ToolboxPicker';
import { Callout } from '../../components/HelpText';
import { SaveBar } from '../../components/SaveBar';
import { ErrorState, LoadingState } from '../../components/States';
import { formatDateTime, formatNumber } from '../../lib/format';
import { rich, useT } from '../../i18n';
import { backendDescription, backendLabel, useBackend } from '../../lib/backend';
import { cn } from '../../lib/cn';
import { runtimeInfo } from '../../lib/runtimes';
import { NETWORK_MODES, networkModeMeta } from '../../lib/status';
import { useDraft } from '../../lib/useDraft';
import { useResetSettings, useSaveSettings } from './useSaveSettings';

type SandboxSettings = Settings['sandbox'];

const num = (v: string) => (v === '' ? undefined : Number(v));

export function SandboxDefaultsSettings() {
  const t = useT();
  const settings = useSettings();
  const info = useSystemInfo();
  const { capabilities } = useBackend();
  const { draft, setDraft, dirty, reset } = useDraft<SandboxSettings>(settings.data?.sandbox);
  const [confirmReset, setConfirmReset] = useState(false);
  const save = useSaveSettings(t('sandboxDefaults.saved'), (s) => reset(s.sandbox));
  const resetSection = useResetSettings((s) => {
    reset(s.sandbox);
    setConfirmReset(false);
  });

  if (settings.error) return <ErrorState error={settings.error} onRetry={() => settings.refetch()} />;
  if (!draft) return <LoadingState />;

  const set = <K extends keyof SandboxSettings>(k: K, v: SandboxSettings[K]) => setDraft({ ...draft, [k]: v });
  const setRes = (k: keyof SandboxSettings['resources'], v: number | undefined) => setDraft({ ...draft, resources: { ...draft.resources, [k]: v } });
  const runtimes = info.data?.runtimes ?? [];

  return (
    <div className="space-y-6">
      <BackendCard />

      <Card>
        <CardHeader
          title={t('sandboxDefaults.title')}
          description={t('sandboxDefaults.description')}
          actions={
            <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" />} onClick={() => setConfirmReset(true)}>
              {t('sandboxDefaults.resetButton')}
            </Button>
          }
        />
        <CardBody className="space-y-5">
          <Field label={t('sandboxDefaults.network')} hint={networkModeMeta(t, draft.network).description}>
            <Select value={draft.network} onChange={(e) => set('network', e.target.value as NetworkMode)}>
              {NETWORK_MODES.map((m) => (
                <option key={m} value={m}>
                  {networkModeMeta(t, m).label}
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label={t('sandboxDefaults.cpus')} hint={t('sandboxDefaults.cpusHint')}>
              <Input type="number" min={0.5} step={0.5} value={draft.resources.cpus ?? ''} onChange={(e) => setRes('cpus', num(e.target.value))} />
            </Field>
            <Field label={t('sandboxDefaults.memory')} hint={t('sandboxDefaults.memoryHint')}>
              <Input type="number" min={256} step={256} value={draft.resources.memoryMb ?? ''} onChange={(e) => setRes('memoryMb', num(e.target.value))} />
            </Field>
            <Field label={t('sandboxDefaults.pids')} hint={t('sandboxDefaults.pidsHint')}>
              <Input type="number" min={64} step={64} value={draft.resources.pids ?? ''} onChange={(e) => setRes('pids', num(e.target.value))} />
            </Field>
          </div>
          {!capabilities.resourceLimits && <p className="-mt-2 text-xs text-amber-700 dark:text-amber-400">{t('backend.noResourceLimitsShort')}</p>}
          {capabilities.runtimes && (
            <Field label={t('sandboxDefaults.runtime')} hint={runtimeInfo(t, draft.runtime).description}>
              <Select value={draft.runtime ?? ''} onChange={(e) => set('runtime', e.target.value || null)}>
                <option value="">{runtimeInfo(t, null).label}</option>
                {runtimes
                  .filter((r) => r !== 'runc')
                  .map((r) => (
                    <option key={r} value={r}>
                      {runtimeInfo(t, r).label}
                    </option>
                  ))}
                {draft.runtime && !runtimes.includes(draft.runtime) && (
                  <option value={draft.runtime}>{t('sandboxDefaults.runtimeNotFound', { runtime: draft.runtime })}</option>
                )}
              </Select>
            </Field>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            {capabilities.images && (
              <Field label={t('sandboxDefaults.image')} hint={t('sandboxDefaults.imageHint')}>
                <Input value={draft.image} onChange={(e) => set('image', e.target.value)} className="font-mono" />
              </Field>
            )}
            <Field label={t('sandboxDefaults.maxSandboxes')} hint={t('sandboxDefaults.maxSandboxesHint')}>
              <Input type="number" min={1} value={draft.maxSandboxes} onChange={(e) => set('maxSandboxes', Number(e.target.value) || 1)} />
            </Field>
          </div>
          <Field label={t('sandboxDefaults.workdir')} hint={t('sandboxDefaults.workdirHint')}>
            <Input value={draft.workdir} onChange={(e) => set('workdir', e.target.value)} className="font-mono" />
          </Field>
        </CardBody>
      </Card>

      <SaveBar visible={dirty} onSave={() => save.mutate({ sandbox: draft })} onDiscard={() => reset()} saving={save.isPending} />

      <ImagesCard />

      <ConfirmDialog
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        onConfirm={() => resetSection.mutate('sandbox')}
        loading={resetSection.isPending}
        title={t('sandboxDefaults.reset.title')}
        confirmLabel={t('sandboxDefaults.reset.confirm')}
        message={t('sandboxDefaults.reset.message')}
      />
    </div>
  );
}

const BACKENDS: DriverKind[] = ['docker', 'podman', 'bwrap'];

/** Which isolation technology the server uses, what it means and how to switch. */
function BackendCard() {
  const t = useT();
  const { info, kind, name, capabilities } = useBackend();
  const code = (c: string) => <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-xs text-fg">{c}</code>;
  return (
    <Card>
      <CardHeader title={t('backend.title')} description={t('backend.description')} />
      <CardBody className="space-y-4">
        {info.isLoading ? (
          <LoadingState />
        ) : info.error ? (
          <ErrorState error={info.error} onRetry={() => info.refetch()} />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Boxes className="size-5 text-accent" />
              <span className="font-medium text-fg">{t('backend.current', { name: name ?? '–' })}</span>
              {info.data?.dockerVersion && <Badge tone="gray">{t('backend.version', { version: info.data.dockerVersion })}</Badge>}
            </div>
            <ul className="space-y-2">
              {BACKENDS.map((b) => (
                <li
                  key={b}
                  className={cn('rounded-lg border px-3 py-2 text-sm', b === kind ? 'border-accent bg-accent-soft' : 'border-line')}
                >
                  <span className="font-medium text-fg">{backendLabel(b)}</span>
                  {b === kind && (
                    <Badge tone="accent" className="ml-2">
                      {t('backend.active')}
                    </Badge>
                  )}
                  <span className="text-fg-muted"> – {backendDescription(t, b)}</span>
                </li>
              ))}
            </ul>
            {!capabilities.resourceLimits && <Callout tone="warning">{t('backend.noResourceLimits')}</Callout>}
            {!capabilities.enforcedEgress && <Callout tone="warning">{t('backend.noEnforcedEgress')}</Callout>}
            <details className="group text-sm">
              <summary className="cursor-pointer font-medium text-fg-muted hover:text-fg">{t('backend.switchTitle')}</summary>
              <div className="mt-2 space-y-2 text-fg-muted">
                <p>{rich(t('backend.switchText'), { env: code('COCOON_DRIVER') })}</p>
                <CodeBlock code={'COCOON_DRIVER=auto     # ' + t('backend.switchAuto') + '\nCOCOON_DRIVER=docker\nCOCOON_DRIVER=podman\nCOCOON_DRIVER=bwrap'} />
              </div>
            </details>
          </>
        )}
      </CardBody>
    </Card>
  );
}

function ImagesCard() {
  const t = useT();
  const images = useImages();
  const { capabilities } = useBackend();
  const builtVariant = images.data?.find((i) => i.kind === 'sandbox')?.variant;
  const [chosenVariant, setVariant] = useState<SandboxVariant>();
  // Rebuilding keeps the variant of the current image unless another one is picked.
  const variant = chosenVariant ?? builtVariant ?? 'slim';
  const containerImages = (images.data ?? []).filter((i) => i.kind !== 'agents');
  const toolbox = images.data?.find((i) => i.kind === 'agents');
  return (
    <Card>
      <CardHeader
        title={t('sandboxDefaults.images.title')}
        description={capabilities.images ? t('sandboxDefaults.images.description') : t('sandboxDefaults.images.descriptionNoImages')}
      />
      <CardBody className="space-y-5">
        {images.isLoading ? (
          <LoadingState />
        ) : images.error ? (
          <ErrorState error={images.error} onRetry={() => images.refetch()} />
        ) : (
          <div className="space-y-4">
            {capabilities.images && (
              <>
                <Field label={t('sandboxDefaults.images.variant')} hint={t('sandboxDefaults.images.variantHint')}>
                  <VariantTiles value={variant} onChange={setVariant} />
                </Field>
                {containerImages.map((img) => (
                  <div key={img.kind} className="rounded-xl border border-line p-4">
                    <div className="flex flex-wrap items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-fg">{imageLabel(t, img.kind)}</span>
                          <ImageBadge img={img} />
                        </div>
                        <div className="mt-0.5 font-mono text-xs text-fg-subtle">{img.ref}</div>
                        {img.exists && (
                          <div className="mt-1 text-xs text-fg-muted">
                            {img.sizeMb !== undefined && `${formatNumber(Math.round(img.sizeMb))} MB · `}
                            {t('sandboxDefaults.images.built', { date: formatDateTime(img.createdAt) })}
                          </div>
                        )}
                        <p className="mt-1 text-sm text-fg-muted">
                          {img.kind === 'sandbox' ? t('sandboxDefaults.images.sandboxDescription') : t('sandboxDefaults.images.proxyDescription')}
                        </p>
                      </div>
                      <BuildImageButton
                        kind={img.kind}
                        sandboxVariant={variant}
                        variant={img.exists ? 'secondary' : 'primary'}
                        label={img.exists ? t('sandboxDefaults.images.rebuild') : t('sandboxDefaults.images.build')}
                      />
                    </div>
                    <BuildLog kind={img.kind} className="mt-3" />
                  </div>
                ))}
              </>
            )}
            <ToolboxEntry img={toolbox} />
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function VariantTiles({ value, onChange }: { value: SandboxVariant; onChange: (variant: SandboxVariant) => void }) {
  const t = useT();
  return (
    <div className="grid gap-2.5 sm:grid-cols-3" role="radiogroup">
      {SandboxVariant.options.map((v) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          onClick={() => onChange(v)}
          className={cn(
            'rounded-xl border p-3.5 text-left transition-all focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
            value === v ? 'border-accent bg-accent-soft ring-2 ring-accent/30' : 'border-line hover:border-line-strong hover:bg-surface-2/60',
          )}
        >
          <div className="font-medium text-fg">{t(`sandboxDefaults.images.variant.${v}`)}</div>
          <div className="mt-1 text-xs leading-relaxed text-fg-muted">{t(`sandboxDefaults.images.variant.${v}Hint`)}</div>
        </button>
      ))}
    </div>
  );
}

function ImageBadge({ img }: { img: Pick<ImageInfo, 'building' | 'exists'> }) {
  const t = useT();
  if (img.building) return <Badge tone="blue">{t('sandboxDefaults.images.building')}</Badge>;
  if (img.exists) return <Badge tone="green">{t('sandboxDefaults.images.exists')}</Badge>;
  return <Badge tone="amber">{t('sandboxDefaults.images.missing')}</Badge>;
}

/** The shared agent toolbox (agent CLIs), mounted read-only into every sandbox. */
function ToolboxEntry({ img }: { img: ImageInfo | undefined }) {
  const t = useT();
  const { capabilities } = useBackend();
  const exists = !!img?.exists;
  return (
    <div className="rounded-xl border border-line p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-fg">{t('sandboxDefaults.toolbox.title')}</span>
        <ImageBadge img={{ building: !!img?.building, exists }} />
        {img?.createdAt && exists && <span className="text-xs text-fg-muted">{t('sandboxDefaults.toolbox.installed', { date: formatDateTime(img.createdAt) })}</span>}
        {img?.runtime && exists && <span className="text-xs text-fg-muted">· {t('sandboxDefaults.toolbox.runtime', { version: img.runtime })}</span>}
      </div>
      {img?.ref && <div className="mt-0.5 font-mono text-xs text-fg-subtle">{img.ref}</div>}
      <p className="mt-1 mb-3 text-sm text-fg-muted">{t('sandboxDefaults.toolbox.description')}</p>
      {exists && !img?.runtime && capabilities.images && !img?.building && (
        <Callout tone="warning" className="mb-3">
          {t('sandboxDefaults.toolbox.noRuntime')}
        </Callout>
      )}
      <ToolboxPicker />
    </div>
  );
}
