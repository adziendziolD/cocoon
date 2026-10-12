import type { NetworkMode } from '@cocoon/protocol';
import { ExternalLink, ShieldCheck } from 'lucide-react';
import { useSettings } from '../../../api/queries';
import { Callout } from '../../../components/HelpText';
import { NetworkModeCards, SizePresetCards } from '../../../components/SandboxOptions';
import { ErrorState, LoadingState } from '../../../components/States';
import { useT } from '../../../i18n';
import { SIZE_PRESETS, type SizePresetId } from '../../../lib/runtimes';
import { presetFor } from '../../../lib/sandboxForm';
import { networkModeMeta } from '../../../lib/status';
import { useSaveSettings } from '../../settings/useSaveSettings';
import { useDraftField, useOnboarding } from '../context';
import { StepFrame } from '../StepFrame';

const ALLOWLIST_PREVIEW = 10;

export function DefaultsStep() {
  const t = useT();
  const { next } = useOnboarding();
  const settings = useSettings();
  const current = settings.data?.sandbox;
  const [network, setNetwork] = useDraftField<NetworkMode | null>('defaults.network', null);
  const [size, setSize] = useDraftField<SizePresetId | null>('defaults.size', null);
  const save = useSaveSettings(t('onboarding.defaults.saved'), () => next());

  const currentPreset = presetFor(current?.resources);
  const effNetwork = network ?? current?.network ?? 'egress';
  const effSize = size ?? currentPreset;
  const changed = !!current && (effNetwork !== current.network || (effSize !== undefined && effSize !== currentPreset));

  const goNext = () => {
    if (!current || !changed) return next();
    const preset = SIZE_PRESETS.find((p) => p.id === effSize);
    save.mutate({
      sandbox: {
        network: effNetwork,
        ...(preset && effSize !== currentPreset ? { resources: { ...current.resources, cpus: preset.cpus, memoryMb: preset.memoryMb } } : {}),
      },
    });
  };

  const egress = settings.data?.egress;
  const allowlist = egress?.allowlist ?? [];

  return (
    <StepFrame
      icon={ShieldCheck}
      title={t('onboarding.defaults.title')}
      lead={t('onboarding.defaults.lead')}
      onNext={goNext}
      nextLoading={save.isPending}
      nextLabel={changed ? t('onboarding.defaults.saveNext') : undefined}
      doneBanner={false}
    >
      {settings.isLoading ? (
        <LoadingState />
      ) : settings.error ? (
        <ErrorState error={settings.error} onRetry={() => settings.refetch()} />
      ) : (
        <>
          <section>
            <h2 className="text-base font-semibold text-fg">{t('onboarding.defaults.networkTitle')}</h2>
            <p className="mt-0.5 mb-3 text-sm text-fg-muted">{t('onboarding.defaults.networkText')}</p>
            <NetworkModeCards value={effNetwork} onChange={setNetwork} />
          </section>

          {effNetwork === 'egress' && egress?.credentialProxy !== false ? (
            <Callout tone="success" title={t('onboarding.defaults.keysSafeTitle')}>
              {t('onboarding.defaults.keysSafeText')}
            </Callout>
          ) : effNetwork === 'none' ? (
            <Callout tone="warning" title={t('onboarding.defaults.noneTitle')}>
              {t('onboarding.defaults.noneText')}
            </Callout>
          ) : (
            <Callout tone="warning" title={t('onboarding.defaults.keysExposedTitle')}>
              {effNetwork === 'open' ? t('onboarding.defaults.keysExposedOpen', { mode: networkModeMeta(t, 'egress').short }) : t('onboarding.defaults.keysExposedProxyOff')}
            </Callout>
          )}

          {effNetwork === 'egress' && (
            <section className="rounded-xl border border-line px-4 py-3.5">
              <div className="text-sm font-medium text-fg">{t('onboarding.defaults.allowlistTitle', { count: allowlist.length })}</div>
              <p className="mt-0.5 text-sm text-fg-muted">{t('onboarding.defaults.allowlistText')}</p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {allowlist.slice(0, ALLOWLIST_PREVIEW).map((d) => (
                  <span key={d} className="rounded-full border border-line bg-surface-2 px-2.5 py-0.5 font-mono text-xs text-fg">
                    {d}
                  </span>
                ))}
                {allowlist.length > ALLOWLIST_PREVIEW && (
                  <span className="px-1 py-0.5 text-xs text-fg-muted">{t('onboarding.defaults.allowlistMore', { count: allowlist.length - ALLOWLIST_PREVIEW })}</span>
                )}
              </div>
              <a href="/settings/network" target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline">
                {t('onboarding.defaults.allowlistEdit')} <ExternalLink className="size-3.5" />
              </a>
            </section>
          )}

          <section>
            <h2 className="text-base font-semibold text-fg">{t('onboarding.defaults.sizeTitle')}</h2>
            <p className="mt-0.5 mb-3 text-sm text-fg-muted">{t('wizard.sizeHint')}</p>
            <SizePresetCards value={effSize} onChange={setSize} />
            {!currentPreset && current && size === null && (
              <p className="mt-2 text-xs text-fg-muted">
                {t('onboarding.defaults.customSize', { cpus: current.resources.cpus ?? '–', gb: current.resources.memoryMb ? Math.round(current.resources.memoryMb / 102.4) / 10 : '–' })}
              </p>
            )}
          </section>
          <p className="text-xs text-fg-subtle">{t('onboarding.defaults.laterHint')}</p>
        </>
      )}
    </StepFrame>
  );
}
