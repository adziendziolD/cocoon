import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Bot, Check, Database, ChevronDown, ChevronRight, Hourglass, LayoutDashboard, Minus, PartyPopper, Settings, Terminal } from 'lucide-react';
import { useAgents, useImages, useSandboxes, useSecrets, useSettings } from '../../../api/queries';
import { AgentStatusBadge } from '../../../components/Badge';
import { Button } from '../../../components/Button';
import { CodeBlock } from '../../../components/CodeBlock';
import { rich, useLanguage, useT } from '../../../i18n';
import { useBackend } from '../../../lib/backend';
import { cn } from '../../../lib/cn';
import { profileLabel } from '../../../lib/profiles';
import { usableModelProviders } from '../../../lib/providers';
import { sizePresetLabel } from '../../../lib/runtimes';
import { presetFor } from '../../../lib/sandboxForm';
import { isSecretSet, secretLabel } from '../../../lib/secrets';
import { networkModeMeta } from '../../../lib/status';
import { useDraftField, useOnboarding } from '../context';
import { useCompleteOnboarding } from '../lifecycle';
import { useKeyVerdicts } from '../keyChecks';
import { StepFrame } from '../StepFrame';

export function DoneStep() {
  const t = useT();
  const { lang } = useLanguage();
  const { status } = useOnboarding();
  const settings = useSettings();
  const secrets = useSecrets();
  const sandboxes = useSandboxes();
  const agents = useAgents();
  const images = useImages();
  const keyVerdicts = useKeyVerdicts();
  const [sandboxId] = useDraftField<string | null>('sandbox.id', null);
  const [agentId] = useDraftField<string | null>('agent.id', null);

  const agent = agents.data?.find((a) => a.id === agentId);
  const sandbox = sandboxes.data?.find((s) => s.id === (agent?.sandboxId ?? sandboxId)) ?? sandboxes.data?.[0];
  const finish = useCompleteOnboarding();
  const go = (to: 'agent' | 'dashboard') => finish.mutate(to === 'agent' && agent ? `/agents/${agent.id}` : '/');

  const access = [
    ...(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY'] as const)
      .filter((s) => isSecretSet(secrets.data, s) && (s === 'CLAUDE_CODE_OAUTH_TOKEN' || keyVerdicts[s] !== 'rejected'))
      .map((s) => secretLabel(s, lang)),
    ...usableModelProviders(settings.data, secrets.data).map(([, p]) => p.label),
  ];
  const backend = useBackend();
  const preparing = !!images.data?.some((i) => (i.kind === 'sandbox' || i.kind === 'agents') && i.building);
  const defaults = settings.data?.sandbox;
  const preset = presetFor(defaults?.resources);
  const origin = window.location.origin;

  return (
    <StepFrame
      icon={PartyPopper}
      title={t('onboarding.done.title')}
      lead={t('onboarding.done.lead')}
      doneBanner={false}
      onNext={() => go(agent ? 'agent' : 'dashboard')}
      nextLoading={finish.isPending}
      nextLabel={agent ? t('onboarding.done.toAgent') : t('onboarding.done.toDashboard')}
      actions={
        agent ? (
          <Button variant="ghost" icon={<LayoutDashboard className="size-4" />} onClick={() => go('dashboard')} disabled={finish.isPending}>
            {t('onboarding.done.toDashboard')}
          </Button>
        ) : undefined
      }
    >
      <section>
        <h2 className="mb-2 text-base font-semibold text-fg">{t('onboarding.done.summaryTitle')}</h2>
        <ul className="divide-y divide-line rounded-xl border border-line">
          <SummaryRow ok={status.system === 'done'} pending={preparing} label={t('onboarding.step.system')}>
            {status.system === 'done' ? t('onboarding.done.systemOk', { name: backend.name ?? '–' }) : preparing ? t('onboarding.done.systemBuilding') : t('onboarding.done.systemOpen')}
          </SummaryRow>
          <SummaryRow ok={access.length > 0} label={t('onboarding.step.ai')}>
            {access.length ? access.join(', ') : t('onboarding.done.none')}
          </SummaryRow>
          <SummaryRow ok={status.github === 'done'} optional label={t('onboarding.step.github')}>
            {status.github === 'done' ? t('onboarding.done.githubOk') : t('onboarding.done.githubSkipped')}
          </SummaryRow>
          <SummaryRow ok label={t('onboarding.step.defaults')}>
            {defaults ? t('onboarding.done.defaults', { network: networkModeMeta(t, defaults.network).short, size: preset ? sizePresetLabel(t, preset) : t('onboarding.sandbox.customSize') }) : '–'}
          </SummaryRow>
          <SummaryRow ok={!!sandbox} label={t('onboarding.step.sandbox')}>
            {sandbox ? sandbox.name : t('onboarding.done.none')}
          </SummaryRow>
          <SummaryRow ok={!!agent || status.agent === 'done'} label={t('onboarding.step.agent')}>
            {agent ? (
              <span className="inline-flex flex-wrap items-center gap-2">
                {profileLabel(agent.kind, settings.data?.agents[agent.kind], lang)} <AgentStatusBadge status={agent.status} />
              </span>
            ) : status.agent === 'done' ? (
              t('onboarding.done.agentsExist', { count: agents.data?.length ?? 0 })
            ) : (
              t('onboarding.done.none')
            )}
          </SummaryRow>
        </ul>
      </section>

      <section>
        <h2 className="mb-2 text-base font-semibold text-fg">{t('onboarding.done.nextTitle')}</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <Tip icon={<Bot className="size-5" />} title={t('onboarding.done.tipWatchTitle')}>
            {t('onboarding.done.tipWatchText')}
          </Tip>
          <Tip icon={<Hourglass className="size-5" />} title={t('onboarding.done.tipBlockedTitle')} highlight>
            {rich(t('onboarding.done.tipBlockedText'), { status: <AgentStatusBadge status="blocked" /> })}
          </Tip>
          <Tip icon={<Settings className="size-5" />} title={t('onboarding.done.tipSettingsTitle')}>
            {t('onboarding.done.tipSettingsText')}
          </Tip>
        </div>
      </section>

      <p className="flex items-start gap-2 rounded-xl border border-line bg-surface-2/40 px-4 py-3 text-sm text-fg-muted">
        <Database className="mt-0.5 size-4 shrink-0 text-accent" />
        <span>
          {rich(t('onboarding.done.servicesTip'), {
            link: (
              <Link to="/settings/services" target="_blank" rel="noreferrer" className="font-medium text-accent hover:underline">
                {t('onboarding.done.servicesLink')}
              </Link>
            ),
          })}
        </span>
      </p>

      <PowerUserTips origin={origin} />
    </StepFrame>
  );
}

function SummaryRow({ ok, pending, optional, label, children }: { ok: boolean; pending?: boolean; optional?: boolean; label: string; children: ReactNode }) {
  return (
    <li className="flex items-center gap-3 px-4 py-2.5">
      <span
        className={cn(
          'flex size-6 shrink-0 items-center justify-center rounded-full',
          ok ? 'bg-emerald-500 text-white' : pending ? 'bg-blue-500/15 text-blue-600' : optional ? 'bg-surface-2 text-fg-subtle' : 'bg-amber-400/20 text-amber-700',
        )}
      >
        {ok ? <Check className="size-3.5" /> : pending ? <Hourglass className="size-3.5" /> : <Minus className="size-3.5" />}
      </span>
      <span className="w-36 shrink-0 text-sm text-fg-muted">{label}</span>
      <span className="min-w-0 flex-1 text-sm text-fg">{children}</span>
    </li>
  );
}

function Tip({ icon, title, children, highlight }: { icon: ReactNode; title: string; children: ReactNode; highlight?: boolean }) {
  return (
    <div className={cn('rounded-xl border p-4', highlight ? 'border-amber-400/60 bg-amber-400/10' : 'border-line bg-surface-2/40')}>
      <div className={cn('mb-2', highlight ? 'text-amber-600 dark:text-amber-400' : 'text-accent')}>{icon}</div>
      <div className="font-medium text-fg">{title}</div>
      <div className="mt-1 text-sm leading-relaxed text-fg-muted">{children}</div>
    </div>
  );
}

function PowerUserTips({ origin }: { origin: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <section className="rounded-xl border border-line">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-medium text-fg">
        {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        <Terminal className="size-4 text-fg-muted" />
        {t('onboarding.done.powerTitle')}
        <span className="font-normal text-fg-subtle">{t('onboarding.done.powerHint')}</span>
      </button>
      {open && (
        <div className="space-y-4 border-t border-line px-4 py-4">
          <p className="text-sm text-fg-muted">
            {rich(t('onboarding.done.powerToken'), {
              link: (
                <Link to="/settings/access" target="_blank" rel="noreferrer" className="font-medium text-accent hover:underline">
                  {t('onboarding.done.powerTokenLink')}
                </Link>
              ),
            })}
          </p>
          <CodeBlock
            title={t('onboarding.done.cliTitle')}
            code={`export COCOON_URL=${origin}
export COCOON_TOKEN=<TOKEN>

pnpm cocoon sandbox ls
pnpm cocoon agent spawn <sandbox-id> claude-code -p "${t('access.cli.examplePrompt')}"`}
          />
          <CodeBlock title={t('onboarding.done.mcpTitle')} code={`claude mcp add --transport http cocoon ${origin}/mcp --header "Authorization: Bearer <TOKEN>"`} />
        </div>
      )}
    </section>
  );
}
