import type { MethodParams } from '@cocoon/protocol';
import { ArrowLeft, Box, FolderGit2, FolderPlus, Loader2 } from 'lucide-react';
import { qk } from '../../../api/keys';
import { useImages, useSandboxes, useSecrets, useSettings } from '../../../api/queries';
import { describeError, rpc } from '../../../api/rpc';
import { useAction } from '../../../api/useAction';
import { SandboxStatusBadge } from '../../../components/Badge';
import { Button } from '../../../components/Button';
import { ChoiceCard, Field, Input } from '../../../components/Field';
import { Callout } from '../../../components/HelpText';
import { LoadingState } from '../../../components/States';
import { useT } from '../../../i18n';
import { useBackend } from '../../../lib/backend';
import { sizePresetLabel } from '../../../lib/runtimes';
import { isRepoUrl, nameFromRepo, presetFor, SANDBOX_NAME_RE } from '../../../lib/sandboxForm';
import { isSecretSet } from '../../../lib/secrets';
import { networkModeMeta } from '../../../lib/status';
import { useDraftField, useOnboarding } from '../context';
import { StepFrame } from '../StepFrame';

export function SandboxStep() {
  const t = useT();
  const { next, goTo } = useOnboarding();
  const settings = useSettings();
  const secrets = useSecrets();
  const sandboxes = useSandboxes();
  const images = useImages();
  const [mode, setMode] = useDraftField<'new' | 'existing' | null>('sandbox.mode', null);
  const [repoUrl, setRepoUrl] = useDraftField('sandbox.repoUrl', '');
  const [repoRef, setRepoRef] = useDraftField('sandbox.repoRef', '');
  const [name, setName] = useDraftField('sandbox.name', '');
  const [nameTouched, setNameTouched] = useDraftField('sandbox.nameTouched', false);
  const [selectedId, setSelectedId] = useDraftField<string | null>('sandbox.id', null);

  const list = sandboxes.data ?? [];
  const effMode = mode ?? (list.length > 0 ? 'existing' : 'new');
  const selected = list.find((s) => s.id === selectedId) ?? (effMode === 'existing' ? list[0] : undefined);
  const image = images.data?.find((i) => i.kind === 'sandbox');
  const { capabilities } = useBackend();
  // bubblewrap uses no images, so there is nothing to wait for.
  const imageMissing = capabilities.images && !!images.data && !image?.exists;
  const defaults = settings.data?.sandbox;
  const preset = presetFor(defaults?.resources);

  const nameError = name && !SANDBOX_NAME_RE.test(name) ? t('wizard.nameError') : undefined;
  const repoError = repoUrl.trim() && !isRepoUrl(repoUrl) ? t('wizard.repoError') : undefined;
  const maxReached = !!defaults && list.length >= defaults.maxSandboxes;

  const create = useAction((params: MethodParams<'sandbox.create'>) => rpc('sandbox.create', params), {
    success: (s) => t('wizard.created', { name: s.name }),
    error: t('wizard.createFailed'),
    invalidate: [qk.sandboxes, qk.setup, qk.images],
    onSuccess: (s) => {
      setSelectedId(s.id);
      setMode('existing');
      next();
    },
  });

  const submit = () => {
    if (effMode === 'existing') {
      if (!selected) return;
      setSelectedId(selected.id);
      return next();
    }
    if (nameError || repoError || imageMissing || maxReached) return;
    create.mutate({
      name: name.trim() || undefined,
      repo: repoUrl.trim() ? { url: repoUrl.trim(), ref: repoRef.trim() || undefined } : undefined,
    });
  };

  if (create.isPending) {
    return (
      <StepFrame icon={Box} title={t('onboarding.sandbox.creatingTitle')} doneBanner={false} hideBack>
        <div className="flex flex-col items-center py-8 text-center" role="status" aria-live="polite">
          <Loader2 className="size-10 animate-spin text-accent" />
          <p className="mt-4 font-medium text-fg">{t('wizard.creatingWait')}</p>
          <p className="mt-1.5 max-w-md text-sm text-fg-muted">{repoUrl.trim() ? t('wizard.creatingWithRepo') : t('wizard.creatingEmpty')}</p>
        </div>
      </StepFrame>
    );
  }

  const createError = create.error;
  const nextDisabled = effMode === 'existing' ? !selected : !!nameError || !!repoError || imageMissing || maxReached;

  return (
    <StepFrame
      icon={Box}
      title={t('onboarding.sandbox.title')}
      lead={t('onboarding.sandbox.lead')}
      onNext={submit}
      nextDisabled={nextDisabled}
      nextLabel={effMode === 'existing' ? t('onboarding.sandbox.useExisting') : t('wizard.submit')}
      nextIcon={effMode === 'new' ? <Box className="size-4" /> : undefined}
      doneBanner={false}
    >
      {sandboxes.isLoading ? (
        <LoadingState />
      ) : (
        <>
          {list.length > 0 && (
            <div className="grid gap-2.5 sm:grid-cols-2">
              <ChoiceCard
                selected={effMode === 'existing'}
                onSelect={() => setMode('existing')}
                icon={<FolderGit2 className="size-5" />}
                title={t('onboarding.sandbox.modeExisting')}
                description={t('onboarding.sandbox.modeExistingText', { count: list.length })}
              />
              <ChoiceCard selected={effMode === 'new'} onSelect={() => setMode('new')} icon={<FolderPlus className="size-5" />} title={t('onboarding.sandbox.modeNew')} description={t('onboarding.sandbox.modeNewText')} />
            </div>
          )}

          {effMode === 'existing' && list.length > 0 && (
            <div className="space-y-2" role="radiogroup" aria-label={t('onboarding.sandbox.modeExisting')}>
              {list.map((s) => (
                <ChoiceCard
                  key={s.id}
                  selected={selected?.id === s.id}
                  onSelect={() => setSelectedId(s.id)}
                  title={s.name}
                  badge={<SandboxStatusBadge status={s.status} />}
                  description={s.repo?.url ?? t('wizard.summary.emptyFolder')}
                />
              ))}
            </div>
          )}

          {effMode === 'new' && (
            <>
              {imageMissing && (
                <Callout
                  tone="warning"
                  title={image?.building ? t('onboarding.sandbox.imageBuildingTitle') : t('onboarding.sandbox.imageMissingTitle')}
                  action={
                    <Button size="sm" icon={<ArrowLeft className="size-3.5" />} onClick={() => goTo('system')}>
                      {t('onboarding.sandbox.toSystem')}
                    </Button>
                  }
                >
                  {image?.building ? t('onboarding.sandbox.imageBuildingText') : t('onboarding.sandbox.imageMissingText')}
                </Callout>
              )}
              {maxReached && (
                <Callout tone="warning" title={t('wizard.maxReachedTitle')}>
                  {t('wizard.maxReached', { count: list.length, max: defaults!.maxSandboxes })}
                </Callout>
              )}
              <p className="text-sm leading-relaxed text-fg-muted">{t('onboarding.sandbox.repoExplain')}</p>
              <Field label={t('wizard.repoLabel')} optional htmlFor="ob-repo" error={repoError} hint={t('onboarding.sandbox.repoHint')}>
                <Input
                  id="ob-repo"
                  value={repoUrl}
                  placeholder={t('wizard.repoPlaceholder')}
                  invalid={!!repoError}
                  inputMode="url"
                  onChange={(e) => {
                    setRepoUrl(e.target.value);
                    if (!nameTouched) setName(nameFromRepo(e.target.value));
                  }}
                />
              </Field>
              {repoUrl.trim() && (
                <Field label={t('wizard.branchLabel')} optional htmlFor="ob-ref" hint={t('wizard.branchHint')}>
                  <Input id="ob-ref" value={repoRef} onChange={(e) => setRepoRef(e.target.value)} placeholder="main" />
                </Field>
              )}
              {repoUrl.trim() && !isSecretSet(secrets.data, 'GITHUB_TOKEN') && <Callout tone="tip">{t('wizard.privateRepoTip')}</Callout>}
              {repoUrl.trim() && defaults?.network === 'none' && (
                <Callout tone="warning" title={t('wizard.networkConflictTitle')}>
                  {t('onboarding.sandbox.networkConflict')}
                </Callout>
              )}
              <Field label={t('wizard.nameLabel')} optional htmlFor="ob-name" error={nameError} hint={t('wizard.nameHint')}>
                <Input
                  id="ob-name"
                  value={name}
                  invalid={!!nameError}
                  placeholder={t('wizard.namePlaceholder')}
                  onChange={(e) => {
                    setName(e.target.value);
                    setNameTouched(true);
                  }}
                />
              </Field>
              {defaults && (
                <p className="text-xs text-fg-muted">
                  {t('onboarding.sandbox.defaultsLine', {
                    network: networkModeMeta(t, defaults.network).short,
                    size: preset ? sizePresetLabel(t, preset) : t('onboarding.sandbox.customSize'),
                  })}
                </p>
              )}
              {createError && (
                <Callout
                  tone="danger"
                  title={t('wizard.createFailed')}
                  action={
                    imageMissing ? (
                      <Button size="sm" icon={<ArrowLeft className="size-3.5" />} onClick={() => goTo('system')}>
                        {t('onboarding.sandbox.toSystem')}
                      </Button>
                    ) : undefined
                  }
                >
                  <p>{describeError(createError)}</p>
                  <p className="mt-1">{imageMissing ? t('onboarding.sandbox.errorImage') : t('onboarding.sandbox.errorGeneric')}</p>
                </Callout>
              )}
            </>
          )}
        </>
      )}
    </StepFrame>
  );
}
