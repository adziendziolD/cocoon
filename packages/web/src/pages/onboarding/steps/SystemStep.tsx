import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CircleCheck, CircleDashed, RefreshCw, Stethoscope } from 'lucide-react';
import { useBuild } from '../../../api/builds';
import { qk } from '../../../api/keys';
import { rpc } from '../../../api/rpc';
import { BuildImageButton, BuildLog } from '../../../components/BuildLog';
import { Button } from '../../../components/Button';
import { ToolboxPicker } from '../../../components/ToolboxPicker';
import { BackendHelp } from '../../../components/BackendHelp';
import { Callout } from '../../../components/HelpText';
import { ErrorState, LoadingState } from '../../../components/States';
import { useT } from '../../../i18n';
import { agentToolLabel, backendDescription, useBackend } from '../../../lib/backend';
import { formatNumber } from '../../../lib/format';
import { useOnboarding } from '../context';
import { CheckIcon, StepFrame, type CheckState } from '../StepFrame';

/** Polls faster than the dashboard while this step is open, so the checklist feels live. */
function useLiveSetup() {
  const setup = useQuery({ queryKey: qk.setup, queryFn: () => rpc('system.setup_status'), refetchInterval: 4000 });
  const images = useQuery({ queryKey: qk.images, queryFn: () => rpc('image.status'), refetchInterval: 4000 });
  return { setup, images };
}

export function SystemStep() {
  const t = useT();
  const { next } = useOnboarding();
  const { setup, images } = useLiveSetup();
  const backend = useBackend();
  const caps = backend.capabilities;
  const sandboxBuild = useBuild('sandbox');
  const proxyBuild = useBuild('proxy');
  const agentsBuild = useBuild('agents');

  const steps = setup.data?.steps ?? [];
  const backendStep = steps.find((s) => s.id === 'docker');
  const imageStep = steps.find((s) => s.id === 'image');
  const proxy = steps.find((s) => s.id === 'proxy');
  const sandboxImage = images.data?.find((i) => i.kind === 'sandbox');
  const proxyImage = images.data?.find((i) => i.kind === 'proxy');
  const toolbox = images.data?.find((i) => i.kind === 'agents');
  const backendOk = !!backendStep?.done;
  const backendName = backend.name ?? t('onboarding.system.backendFallbackName');
  const backendVersion = backend.info.data?.dockerVersion;

  const sandboxBuilding = caps.images && (!!sandboxImage?.building || sandboxBuild?.status === 'running');
  const toolboxBuilding = !!toolbox?.building || agentsBuild?.status === 'running';
  const imageBuilding = sandboxBuilding || toolboxBuilding;
  const sandboxOk = !caps.images || (images.data ? !!sandboxImage?.exists : !!imageStep?.done);
  const toolboxOk = images.data ? !!toolbox?.exists : !!imageStep?.done;
  const imageState: CheckState = !backendOk ? 'waiting' : sandboxOk && toolboxOk ? 'ok' : imageBuilding ? 'working' : 'error';
  const proxyBuilding = caps.images && (!!proxyImage?.building || proxyBuild?.status === 'running');
  const proxyState: CheckState = !backendOk ? 'waiting' : proxy?.done ? 'ok' : proxyBuilding ? 'working' : 'error';
  const allOk = backendOk && imageState === 'ok' && proxyState === 'ok';

  const refresh = () => {
    void setup.refetch();
    void images.refetch();
    void backend.info.refetch();
  };

  return (
    <StepFrame
      icon={Stethoscope}
      title={t('onboarding.system.title')}
      lead={t('onboarding.system.lead')}
      onNext={next}
      nextLabel={setup.data && !backendOk ? t('onboarding.system.continueAnyway') : undefined}
      footerHint={!setup.data ? undefined : !backendOk ? t('onboarding.system.hintBackend') : imageBuilding ? t('onboarding.system.hintBuilding') : undefined}
      actions={
        <Button variant="ghost" icon={<RefreshCw className={setup.isFetching ? 'size-4 animate-spin' : 'size-4'} />} onClick={refresh}>
          {t('onboarding.system.recheck')}
        </Button>
      }
    >
      {setup.isLoading ? (
        <LoadingState label={t('onboarding.system.checking')} />
      ) : setup.error ? (
        <ErrorState error={setup.error} onRetry={refresh} />
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line">
          <CheckRow
            state={backendOk ? 'ok' : 'error'}
            title={backend.name ? t('onboarding.system.backendNamed', { name: backend.name }) : t('onboarding.system.backend')}
            text={
              backendOk ? (
                <>
                  {backendVersion
                    ? t('onboarding.system.backendOk', { name: backendName, version: backendVersion })
                    : t('onboarding.system.backendOkNoVersion', { name: backendName })}
                  {backend.kind && <span className="mt-0.5 block text-xs text-fg-subtle">{backendDescription(t, backend.kind)}</span>}
                </>
              ) : (
                t('setup.explain.docker')
              )
            }
          >
            {!backendOk && <BackendHelp />}
          </CheckRow>

          <CheckRow
            state={imageState}
            title={t('onboarding.system.image')}
            text={
              imageState === 'ok'
                ? t('onboarding.system.imageAllOk')
                : imageState === 'waiting'
                  ? t('onboarding.system.waitingForBackend')
                  : caps.images
                    ? t('onboarding.system.imageIntro')
                    : t('onboarding.system.imageIntroNoImages')
            }
          >
            {backendOk && (
              <div className="space-y-3">
                {caps.images && (
                  <SubItem
                    ok={sandboxOk}
                    title={t('onboarding.system.imageSandbox')}
                    text={
                      sandboxOk
                        ? t('onboarding.system.imageOk', { size: sandboxImage?.sizeMb ? `${formatNumber(Math.round(sandboxImage.sizeMb))} MB` : (sandboxImage?.ref ?? '') })
                        : sandboxBuilding
                          ? t('onboarding.system.imageBuilding')
                          : t('onboarding.system.imageMissing')
                    }
                  >
                    {!sandboxOk && !sandboxBuilding && <BuildImageButton kind="sandbox" label={t('setup.buildSandbox')} />}
                    <BuildLog kind="sandbox" />
                  </SubItem>
                )}
                <SubItem
                  ok={toolboxOk}
                  title={t('build.image.agents')}
                  text={
                    toolboxOk
                      ? t('onboarding.system.toolboxOk', { tools: (toolbox?.tools ?? []).map(agentToolLabel).join(', ') || '–' })
                      : toolboxBuilding
                        ? t('onboarding.system.toolboxBuilding')
                        : t('onboarding.system.toolboxMissing')
                  }
                >
                  {toolboxOk ? (
                    <details className="text-sm">
                      <summary className="cursor-pointer font-medium text-accent hover:underline">{t('toolbox.more')}</summary>
                      <ToolboxPicker className="mt-2" />
                    </details>
                  ) : (
                    <ToolboxPicker primary={!caps.images || sandboxOk} />
                  )}
                </SubItem>
                {imageBuilding && (
                  <Callout tone="tip" title={t('onboarding.system.continueTitle')}>
                    {t('onboarding.system.continueText')}
                  </Callout>
                )}
              </div>
            )}
          </CheckRow>

          <CheckRow
            state={proxyState}
            title={t('onboarding.system.proxy')}
            text={proxyState === 'ok' ? t('onboarding.system.proxyOk') : proxyState === 'waiting' ? t('onboarding.system.waitingForBackend') : t('setup.explain.proxy')}
          >
            {backendOk && proxyState !== 'ok' && (
              <div className="space-y-3">
                {caps.images ? (
                  <>
                    {!proxyBuilding && (
                      <>
                        <p className="text-sm text-fg-muted">{t('onboarding.system.proxyMissing')}</p>
                        <BuildImageButton kind="proxy" label={t('setup.buildProxy')} variant="secondary" />
                      </>
                    )}
                    <BuildLog kind="proxy" />
                  </>
                ) : (
                  <p className="text-sm text-fg-muted">{t('onboarding.system.proxyMissingNoImage')}</p>
                )}
              </div>
            )}
          </CheckRow>
        </ul>
      )}
      {allOk && <Callout tone="success" title={t('onboarding.system.allOkTitle')}>{t('onboarding.system.allOkText')}</Callout>}
    </StepFrame>
  );
}

function SubItem({ ok, title, text, children }: { ok: boolean; title: string; text: ReactNode; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-line px-3 py-2.5">
      <div className="flex items-center gap-2 text-sm font-medium text-fg">
        {ok ? <CircleCheck className="size-4 text-emerald-600" /> : <CircleDashed className="size-4 text-fg-subtle" />}
        {title}
      </div>
      <p className="mt-0.5 text-sm leading-relaxed text-fg-muted">{text}</p>
      {children && <div className="mt-2 space-y-2 empty:hidden">{children}</div>}
    </div>
  );
}

function CheckRow({ state, title, text, children }: { state: CheckState; title: string; text: ReactNode; children?: ReactNode }) {
  return (
    <li className="flex gap-4 px-4 py-4">
      <CheckIcon state={state} />
      <div className="min-w-0 flex-1">
        <div className="font-medium text-fg">{title}</div>
        <div className="mt-0.5 text-sm leading-relaxed text-fg-muted">{text}</div>
        {children && <div className="mt-3">{children}</div>}
      </div>
    </li>
  );
}
