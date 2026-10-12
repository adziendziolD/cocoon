import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { SetupStep } from '@cocoon/protocol';
import { Box, Check, KeyRound, Play, Plug, Wand2 } from 'lucide-react';
import { useImages, useSandboxes, useSetupStatus } from '../api/queries';
import { useT, type MessageKey } from '../i18n';
import { useBackend } from '../lib/backend';
import { cn } from '../lib/cn';
import { useStartOnboarding } from '../pages/onboarding/lifecycle';
import { useOpenCreateSandbox } from './Layout';
import { BackendHelp } from './BackendHelp';
import { BuildImageButton, BuildLog } from './BuildLog';
import { buttonClasses, Button } from './Button';
import { ToolboxPicker } from './ToolboxPicker';
import { Card, CardHeader } from './Card';

const EXPLAIN: Record<SetupStep['id'], MessageKey> = {
  docker: 'setup.explain.docker',
  image: 'setup.explain.image',
  proxy: 'setup.explain.proxy',
  credentials: 'setup.explain.credentials',
  sandbox: 'setup.explain.sandbox',
  agent: 'setup.explain.agent',
};

/** First-time setup guide driven by `system.setup_status`. Hidden once everything is done. */
export function SetupChecklist() {
  const setup = useSetupStatus();
  const t = useT();
  const startOnboarding = useStartOnboarding();
  if (!setup.data || setup.data.complete) return null;
  const steps = setup.data.steps;
  const doneCount = steps.filter((s) => s.done).length;
  const firstOpen = steps.find((s) => !s.done)?.id;

  return (
    <Card className="mb-8 overflow-hidden">
      <CardHeader
        title={t('setup.title')}
        description={t('setup.description')}
        actions={
          <div className="flex items-center gap-3">
            <div className="h-2 w-32 overflow-hidden rounded-full bg-surface-2">
              <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${(doneCount / steps.length) * 100}%` }} />
            </div>
            <span className="text-sm text-fg-muted">
              {t('setup.progress', { done: doneCount, total: steps.length })}
            </span>
            <Button size="sm" variant="primary" icon={<Wand2 className="size-3.5" />} onClick={startOnboarding}>
              {t('onboarding.run')}
            </Button>
          </div>
        }
      />
      <ol className="divide-y divide-line">
        {steps.map((step, i) => (
          <StepRow key={step.id} step={step} index={i} active={step.id === firstOpen} />
        ))}
      </ol>
    </Card>
  );
}

function StepRow({ step, index, active }: { step: SetupStep; index: number; active: boolean }) {
  const t = useT();
  return (
    <li className={cn('flex gap-4 px-5 py-4', active && 'bg-accent-soft/50')}>
      <div
        className={cn(
          'flex size-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold',
          step.done ? 'bg-emerald-500 text-white' : active ? 'bg-accent text-accent-fg' : 'bg-surface-2 text-fg-subtle',
        )}
      >
        {step.done ? <Check className="size-4" /> : index + 1}
      </div>
      <div className="min-w-0 flex-1">
        <div className={cn('font-medium', step.done ? 'text-fg-muted line-through decoration-fg-subtle/50' : 'text-fg')}>{step.title}</div>
        {!step.done && (
          <>
            <p className="mt-0.5 text-sm text-fg-muted">{t(EXPLAIN[step.id])}</p>
            {step.detail && <p className="mt-1 text-sm text-fg-subtle">{step.detail}</p>}
            {active && <div className="mt-3">{<StepAction id={step.id} />}</div>}
          </>
        )}
      </div>
    </li>
  );
}

function StepAction({ id }: { id: SetupStep['id'] }): ReactNode {
  const openCreate = useOpenCreateSandbox();
  const sandboxes = useSandboxes();
  const images = useImages();
  const { capabilities } = useBackend();
  const t = useT();
  switch (id) {
    case 'docker':
      return (
        <div className="space-y-2">
          <p className="text-sm text-fg-muted">{t('setup.dockerAction')}</p>
          <details>
            <summary className="cursor-pointer text-sm font-medium text-accent hover:underline">{t('setup.showHelp')}</summary>
            <BackendHelp className="mt-2" />
          </details>
        </div>
      );
    case 'image': {
      const sandboxImage = images.data?.find((i) => i.kind === 'sandbox');
      const toolbox = images.data?.find((i) => i.kind === 'agents');
      const needSandbox = capabilities.images && !sandboxImage?.exists;
      return (
        <div className="space-y-3">
          {needSandbox && <BuildImageButton kind="sandbox" label={t('setup.buildSandbox')} />}
          {capabilities.images && <BuildLog kind="sandbox" />}
          {!toolbox?.exists && (
            <div>
              <div className="mb-2 text-sm font-medium text-fg">{t('toolbox.pickTitle')}</div>
              <ToolboxPicker primary={!needSandbox} />
            </div>
          )}
        </div>
      );
    }
    case 'proxy':
      if (!capabilities.images) return <p className="text-sm text-fg-muted">{t('setup.proxyAutoAction')}</p>;
      return (
        <div className="space-y-3">
          <BuildImageButton kind="proxy" label={t('setup.buildProxy')} />
          <BuildLog kind="proxy" />
        </div>
      );
    case 'credentials':
      return (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            <Link to="/settings/secrets" className={buttonClasses('primary')}>
              <KeyRound className="size-4" /> {t('setup.addKey')}
            </Link>
            <Link to="/settings/providers" className={buttonClasses('secondary')}>
              <Plug className="size-4" /> {t('setup.addProvider')}
            </Link>
          </div>
          <p className="text-xs text-fg-subtle">{t('setup.providerNote')}</p>
        </div>
      );
    case 'sandbox':
      return (
        <Button variant="primary" icon={<Box className="size-4" />} onClick={openCreate}>
          {t('setup.createSandbox')}
        </Button>
      );
    case 'agent': {
      const first = sandboxes.data?.find((s) => s.status === 'running') ?? sandboxes.data?.[0];
      return (
        <Link to={first ? `/sandboxes/${first.id}/agents` : '/sandboxes'} className={buttonClasses('primary')}>
          <Play className="size-4" /> {first ? t('setup.startAgentIn', { name: first.name }) : t('setup.toSandboxes')}
        </Link>
      );
    }
  }
}
