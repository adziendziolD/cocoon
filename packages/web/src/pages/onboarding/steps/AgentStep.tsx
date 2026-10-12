import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Bot, ExternalLink, Play } from 'lucide-react';
import { qk } from '../../../api/keys';
import { useAgent, useAgents, useSandboxes, useSecrets, useSettings } from '../../../api/queries';
import { rpc } from '../../../api/rpc';
import { useAction } from '../../../api/useAction';
import { launchModel, useLaunchInfo } from '../../../components/AgentLaunchFields';
import { AgentTypeCards } from '../../../components/AgentTypeCards';
import { AgentStatusBadge } from '../../../components/Badge';
import { Button, buttonClasses } from '../../../components/Button';
import { Field, Textarea } from '../../../components/Field';
import { Callout } from '../../../components/HelpText';
import { LoadingState } from '../../../components/States';
import { rich, useLanguage, useT, type MessageKey } from '../../../i18n';
import { isShellProfile, profileLabel } from '../../../lib/profiles';
import { checkProfileSecrets, secretLabel } from '../../../lib/secrets';
import { agentStatusMeta } from '../../../lib/status';
import { useDraftField, useOnboarding } from '../context';
import { StepFrame } from '../StepFrame';

const EXAMPLES: Array<{ label: MessageKey; prompt: MessageKey }> = [
  { label: 'onboarding.agent.example1', prompt: 'onboarding.agent.example1Prompt' },
  { label: 'onboarding.agent.example2', prompt: 'onboarding.agent.example2Prompt' },
  { label: 'onboarding.agent.example3', prompt: 'onboarding.agent.example3Prompt' },
];

export function AgentStep() {
  const t = useT();
  const { lang } = useLanguage();
  const { next, goTo, status } = useOnboarding();
  const settings = useSettings();
  const secrets = useSecrets();
  const sandboxes = useSandboxes();
  const agents = useAgents();
  const [sandboxId] = useDraftField<string | null>('sandbox.id', null);
  const [kind, setKind] = useDraftField('agent.kind', '');
  const [prompt, setPrompt] = useDraftField('agent.prompt', '');
  const [agentId, setAgentId] = useDraftField<string | null>('agent.id', null);

  const list = sandboxes.data ?? [];
  const sandbox = list.find((s) => s.id === sandboxId) ?? list.find((s) => s.status === 'running') ?? list[0];
  const providers = settings.data?.providers ?? {};
  const profiles = useMemo(() => Object.entries(settings.data?.agents ?? {}), [settings.data]);

  const reasonFor = (_kind: string, p: (typeof profiles)[number][1]): string | undefined => {
    const check = checkProfileSecrets(p, secrets.data, providers);
    if (check.ok && check.unknownProviders.length === 0) return undefined;
    if (check.missingAnyOf) return t('onboarding.agent.needs', { keys: check.anyOf.map((s) => secretLabel(s, lang)).join(` ${t('common.or')} `) });
    if (check.missingProviderKeys.length) return t('onboarding.agent.needsProviderKey', { provider: check.missingProviderKeys.map((m) => m.label).join(', ') });
    return t('onboarding.agent.unknownProvider', { ids: check.unknownProviders.join(', ') });
  };
  const someDisabled = profiles.some(([k, p]) => !!reasonFor(k, p));
  // Nothing is preselected: the user picks the agent explicitly (a stale choice from the draft is dropped).
  const choice = { kind: kind && settings.data?.agents[kind] ? kind : '', providers: null, model: '' };
  const info = useLaunchInfo(choice);

  const profile = choice.kind ? settings.data?.agents[choice.kind] : undefined;
  const isShell = isShellProfile(kind, profile);
  const running = sandbox?.status === 'running';

  const start = useAction(() => rpc('sandbox.start', { sandboxId: sandbox!.id }), {
    success: t('onboarding.agent.sandboxStarted'),
    error: t('startStop.startFailed'),
    invalidate: [qk.sandboxes],
  });
  const spawn = useAction(() => rpc('agent.spawn', { sandboxId: sandbox!.id, kind: choice.kind, prompt: prompt.trim() || undefined, model: launchModel(choice, info) }), {
    success: t('spawn.started'),
    error: t('spawn.failed'),
    invalidate: [qk.agents, qk.setup],
    onSuccess: (agent) => setAgentId(agent.id),
  });

  if (agentId) return <AgentStarted agentId={agentId} onAnother={() => setAgentId(null)} />;

  const canStart = !!sandbox && running && !!profile && !reasonFor(choice.kind, profile) && !info.problem;
  const existingAgents = agents.data?.length ?? 0;

  return (
    <StepFrame
      icon={Bot}
      title={t('onboarding.agent.title')}
      lead={sandbox ? rich(t('onboarding.agent.lead'), { sandbox: <strong className="text-fg">{sandbox.name}</strong> }) : t('onboarding.agent.leadNoSandbox')}
      onNext={() => spawn.mutate()}
      nextDisabled={!canStart}
      footerHint={sandbox && !profile ? t('launch.pickAgent') : sandbox && profile && info.problem ? info.problem : undefined}
      nextLoading={spawn.isPending}
      nextLabel={t('onboarding.agent.start')}
      nextIcon={<Play className="size-4" />}
      actions={
        <Button variant="ghost" onClick={next} disabled={spawn.isPending}>
          {status.agent === 'done' ? t('onboarding.agent.skipHasAgents') : t('onboarding.agent.skip')}
        </Button>
      }
      doneBanner={
        existingAgents > 0 ? (
          <Callout tone="success" title={t('onboarding.alreadyDone')}>
            {t('onboarding.agent.alreadyText', { count: existingAgents })}
          </Callout>
        ) : (
          false
        )
      }
    >
      {sandboxes.isLoading || settings.isLoading ? (
        <LoadingState />
      ) : !sandbox ? (
        <Callout
          tone="warning"
          title={t('onboarding.agent.noSandboxTitle')}
          action={
            <Button size="sm" icon={<ArrowLeft className="size-3.5" />} onClick={() => goTo('sandbox')}>
              {t('onboarding.agent.toSandbox')}
            </Button>
          }
        >
          {t('onboarding.agent.noSandboxText')}
        </Callout>
      ) : (
        <>
          {!running && (
            <Callout
              tone="warning"
              title={t('spawn.notRunning')}
              action={
                <Button size="sm" variant="primary" icon={<Play className="size-3.5" />} loading={start.isPending || sandbox.status === 'creating'} onClick={() => start.mutate()}>
                  {t('onboarding.agent.startSandbox')}
                </Button>
              }
            >
              {t('onboarding.agent.notRunningText')}
            </Callout>
          )}

          <section>
            <h2 className="mb-2 text-sm font-medium text-fg">{t('spawn.whichAgent')}</h2>
            <p className="mb-3 text-sm text-fg-muted">{t('onboarding.agent.pickExplicit')}</p>
            <AgentTypeCards profiles={profiles} providers={providers} value={choice.kind} onChange={setKind} disabledReason={reasonFor} />
            {someDisabled && (
              <Callout
                tone="tip"
                className="mt-3"
                action={
                  <Button size="sm" icon={<ArrowLeft className="size-3.5" />} onClick={() => goTo('ai')}>
                    {t('onboarding.agent.toAi')}
                  </Button>
                }
              >
                {t('onboarding.agent.disabledExplain')}
              </Callout>
            )}
          </section>

          {profile && (
            <Field label={isShell ? t('spawn.command') : t('spawn.whatToDo')} optional hint={isShell ? t('spawn.commandHint') : t('onboarding.agent.promptHint')} htmlFor="ob-prompt">
              <Textarea
                id="ob-prompt"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={isShell ? 2 : 4}
                className={isShell ? 'font-mono' : undefined}
                placeholder={isShell ? 'ls -la' : t('spawn.promptPlaceholder')}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canStart) {
                    e.preventDefault();
                    spawn.mutate();
                  }
                }}
              />
              {!isShell && (
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <span className="text-xs text-fg-subtle">{t('onboarding.agent.examples')}</span>
                  {EXAMPLES.map((ex) => (
                    <button
                      key={ex.label}
                      type="button"
                      onClick={() => setPrompt(t(ex.prompt))}
                      className="rounded-full border border-line bg-surface px-3 py-1 text-xs font-medium text-fg-muted transition-colors hover:border-accent/40 hover:bg-accent-soft hover:text-accent focus-visible:outline-2 focus-visible:outline-accent"
                    >
                      {t(ex.label)}
                    </button>
                  ))}
                </div>
              )}
            </Field>
          )}
          {profile && !isShell && <p className="text-xs text-fg-subtle">{t('onboarding.agent.blockedHint')}</p>}
        </>
      )}
    </StepFrame>
  );
}

/** Live status of the agent started in this step (updated via agent.updated events). */
function AgentStarted({ agentId, onAnother }: { agentId: string; onAnother: () => void }) {
  const t = useT();
  const { lang } = useLanguage();
  const { next } = useOnboarding();
  const agent = useAgent(agentId);
  const settings = useSettings();
  const a = agent.data;
  const meta = a ? agentStatusMeta(t, a.status) : undefined;

  return (
    <StepFrame icon={Bot} title={t('onboarding.agent.startedTitle')} lead={t('onboarding.agent.startedLead')} onNext={next} doneBanner={false}>
      {agent.isLoading ? (
        <LoadingState />
      ) : !a ? (
        <Callout tone="warning" title={t('onboarding.agent.goneTitle')} action={<Button size="sm" onClick={onAnother}>{t('onboarding.agent.startAnother')}</Button>}>
          {t('onboarding.agent.goneText')}
        </Callout>
      ) : (
        <div className="rounded-xl border border-line bg-surface-2/40 p-4" aria-live="polite">
          <div className="flex flex-wrap items-center gap-3">
            <Bot className="size-5 text-accent" />
            <span className="font-medium text-fg">{profileLabel(a.kind, settings.data?.agents[a.kind], lang)}</span>
            <AgentStatusBadge status={a.status} size="lg" />
            <span className="flex-1" />
            <Link to={`/agents/${a.id}`} target="_blank" rel="noreferrer" className={buttonClasses('secondary', 'sm')}>
              {t('onboarding.agent.open')} <ExternalLink className="size-3.5" />
            </Link>
          </div>
          {meta && <p className="mt-2 text-sm text-fg-muted">{meta.explanation}</p>}
          {a.prompt && <p className="mt-3 border-l-2 border-line pl-3 text-sm text-fg-muted italic">{a.prompt}</p>}
          {a.status === 'blocked' && (
            <Callout tone="warning" className="mt-3" title={t('agentDetail.blockedTitle')}>
              {t('onboarding.agent.blockedNow')}
            </Callout>
          )}
        </div>
      )}
      <p className="text-sm text-fg-muted">{t('onboarding.agent.startedNext')}</p>
    </StepFrame>
  );
}
