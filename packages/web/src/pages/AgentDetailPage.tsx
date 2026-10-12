import { useCallback, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { Agent } from '@cocoon/protocol';
import { ArrowRightLeft, Bot, Check, CircleStop, Hand, MessageSquare, Play, RefreshCw, Send, Info, X } from 'lucide-react';
import { qk } from '../api/keys';
import { useAgent, useSandbox, useSettings } from '../api/queries';
import { isNotFound, rpc } from '../api/rpc';
import { useAction } from '../api/useAction';
import { AgentStatusBadge } from '../components/Badge';
import { Button, ButtonLink } from '../components/Button';
import { Card, CardBody, CardHeader, DetailList, PageHeader } from '../components/Card';
import { ConfirmDialog } from '../components/Dialog';
import { EmptyState } from '../components/EmptyState';
import { Checkbox, Textarea } from '../components/Field';
import { InfoTip } from '../components/HelpText';
import { profileLabel } from '../components/SpawnAgentDialog';
import { SwitchAgentDialog } from '../components/SwitchAgentDialog';
import { limitsSummary } from '../components/ModelLimits';
import { ErrorState, LoadingState } from '../components/States';
import { AgentConsole, TerminalStatus } from '../components/AgentConsole';
import type { TerminalState } from '../components/Terminal';
import { useLanguage, useT, type MessageKey } from '../i18n';
import { cn } from '../lib/cn';
import { formatDateTime, formatRelative } from '../lib/format';
import { joinCommand } from '../lib/shellwords';
import { agentStatusMeta } from '../lib/status';

const QUICK_KEYS: Array<{ label: MessageKey | string; keys: string[]; title: MessageKey }> = [
  { label: 'Enter', keys: ['Enter'], title: 'agentDetail.key.enter' },
  { label: 'Esc', keys: ['Escape'], title: 'agentDetail.key.esc' },
  { label: 'agentDetail.key.ctrlC.label', keys: ['C-c'], title: 'agentDetail.key.ctrlC' },
  { label: '↑', keys: ['Up'], title: 'agentDetail.key.up' },
  { label: '↓', keys: ['Down'], title: 'agentDetail.key.down' },
  { label: 'Tab', keys: ['Tab'], title: 'agentDetail.key.tab' },
];

export function AgentDetailPage() {
  const { agentId = '' } = useParams();
  const agent = useAgent(agentId);
  const t = useT();

  if (agent.isLoading) return <LoadingState />;
  if (isNotFound(agent.error) || (!agent.data && !agent.error)) {
    return (
      <EmptyState icon={<Bot className="size-6" />} title={t('agentDetail.notFound')}
        action={
          <ButtonLink to="/agents" variant="primary">
            {t('agentDetail.toAllAgents')}
          </ButtonLink>
        }
      >
        {t('agentDetail.notFoundText')}
      </EmptyState>
    );
  }
  if (agent.error || !agent.data) return <ErrorState error={agent.error} onRetry={() => agent.refetch()} />;
  return <AgentView agent={agent.data} />;
}

function AgentView({ agent }: { agent: Agent }) {
  const navigate = useNavigate();
  const t = useT();
  const { lang } = useLanguage();
  const sandbox = useSandbox(agent.sandboxId);
  const settings = useSettings();
  const [termState, setTermState] = useState<TerminalState>({ kind: 'connecting' });
  const [connectKey, setConnectKey] = useState(0);
  const [confirmKill, setConfirmKill] = useState(false);
  const [switchOpen, setSwitchOpen] = useState(false);
  const meta = agentStatusMeta(t, agent.status);
  const exited = agent.status === 'exited';
  const label = profileLabel(agent.kind, settings.data?.agents[agent.kind], lang);
  const providers = settings.data?.providers ?? {};
  const onTermState = useCallback((s: TerminalState) => setTermState(s), []);

  const keys = useAction((k: string[]) => rpc('agent.send_keys', { agentId: agent.id, keys: k }), { error: t('agentDetail.keysFailed') });
  const kill = useAction(() => rpc('agent.kill', { agentId: agent.id }), {
    success: t('agentDetail.stopped'),
    error: t('agentDetail.stopFailed'),
    invalidate: [qk.agents, qk.agent(agent.id)],
    onSuccess: () => setConfirmKill(false),
  });

  return (
    <>
      <PageHeader
        breadcrumb={
          <span className="flex flex-wrap items-center gap-1.5">
            <Link to="/agents" className="hover:text-fg hover:underline">
              {t('layout.nav.agents')}
            </Link>
            <span>/</span>
            <Link to={`/sandboxes/${agent.sandboxId}/agents`} className="hover:text-fg hover:underline">
              {t('agentDetail.breadcrumbSandbox', { name: sandbox.data?.name ?? agent.sandboxId })}
            </Link>
          </span>
        }
        title={
          <span className="flex flex-wrap items-center gap-3">
            {label}
            <AgentStatusBadge status={agent.status} size="lg" />
          </span>
        }
        description={
          <>
            {meta.explanation}
            {exited &&
              agent.exitCode !== null &&
              ` (${agent.exitCode === 0 ? t('agentDetail.exitCodeOk', { code: agent.exitCode }) : t('agentDetail.exitCode', { code: agent.exitCode })})`}
          </>
        }
        actions={
          <>
            <Button variant={exited ? 'primary' : 'secondary'} icon={exited ? <Play className="size-4" /> : <ArrowRightLeft className="size-4" />} onClick={() => setSwitchOpen(true)}>
              {exited ? t('switch.titleExited') : t('switch.title')}
            </Button>
            {!exited && (
              <Button variant="secondary" icon={<CircleStop className="size-4" />} onClick={() => setConfirmKill(true)}>
                {t('agentDetail.stop')}
              </Button>
            )}
          </>
        }
      />

      {agent.status === 'blocked' && (
        <div className="animate-in mb-5 rounded-2xl border-2 border-amber-400 bg-amber-400/15 p-5 shadow-sm">
          <div className="flex flex-wrap items-start gap-4">
            <div className="rounded-full bg-amber-400 p-2 text-amber-950">
              <Hand className="size-5" />
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="text-base font-semibold text-fg">{t('agentDetail.blockedTitle')}</h2>
              <p className="mt-1 text-sm text-fg-muted">
                {t('agentDetail.blockedText')}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button variant="success" icon={<Check className="size-4" />} loading={keys.isPending && keys.variables?.[0] === 'Enter'} onClick={() => keys.mutate(['Enter'])}>
                  {t('common.yes')}
                </Button>
                <Button variant="secondary" icon={<X className="size-4" />} loading={keys.isPending && keys.variables?.[0] === 'Escape'} onClick={() => keys.mutate(['Escape'])}>
                  {t('agentDetail.noCancel')}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="grid gap-5 xl:grid-cols-[1fr_340px]">
        <Card className="flex min-w-0 flex-col overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2">
            <TerminalStatus state={termState} exited={exited} />
            <span className="flex-1" />
            {!exited && (
              <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} onClick={() => setConnectKey((k) => k + 1)}>
                {t('agentDetail.reconnect')}
              </Button>
            )}
          </div>
          <div className="relative h-[calc(100vh-320px)] min-h-[420px]">
            <AgentConsole agent={agent} sandboxStatus={sandbox.data?.status} connectKey={connectKey} onStateChange={onTermState} />
          </div>
        </Card>

        <div className="space-y-4">
          {!exited && <MessageBox agentId={agent.id} />}
          {!exited && (
            <Card>
              <CardHeader
                title={
                  <span className="flex items-center gap-1.5">
                    {t('agentDetail.sendKeys')}
                    <InfoTip>{t('agentDetail.sendKeysTip')}</InfoTip>
                  </span>
                }
              />
              <CardBody className="grid grid-cols-3 gap-2">
                {QUICK_KEYS.map((k) => (
                  <Button key={k.keys[0]} size="sm" title={t(k.title)} onClick={() => keys.mutate(k.keys)} className="font-mono">
                    {k.label.includes('.') ? t(k.label as MessageKey) : k.label}
                  </Button>
                ))}
              </CardBody>
            </Card>
          )}
          <Card>
            <CardHeader title={t('agentDetail.task')} />
            <CardBody>
              {agent.prompt ? (
                <p className="text-sm whitespace-pre-wrap text-fg">{agent.prompt}</p>
              ) : (
                <p className="text-sm text-fg-muted">{t('agentDetail.noTask')}</p>
              )}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title={t('agentDetail.details')} />
            <CardBody className="py-1">
              <DetailList
                items={[
                  { label: t('agentDetail.started'), value: formatDateTime(agent.createdAt, lang) },
                  { label: t('agentDetail.statusSince'), value: formatRelative(agent.statusChangedAt, Date.now(), lang) },
                  {
                    label: t('agentDetail.statusSource'),
                    value: agent.statusSource === 'hook' ? t('agentDetail.source.hook') : t('agentDetail.source.heuristic'),
                    hint: agent.statusSource === 'hook' ? t('agentDetail.source.hookHint') : t('agentDetail.source.heuristicHint'),
                  },
                  ...(agent.providers.length > 0
                    ? [
                        {
                          label: t('agentDetail.providers'),
                          value: (
                            <span className="flex flex-wrap gap-1.5">
                              {agent.providers.map((id) => (
                                <Link key={id} to="/settings/providers" className="hover:underline">
                                  {providers[id]?.label ?? id}
                                  {providers[id] && <span className="ml-1 text-xs text-fg-subtle">({t(`providers.kind.${providers[id].kind}.short`)})</span>}
                                </Link>
                              ))}
                            </span>
                          ),
                        },
                      ]
                    : []),
                  ...(agent.model ? [{ label: t('agentDetail.model'), value: <span className="font-mono text-xs">{agent.model}</span> }] : []),
                  ...(limitsSummary(t, agent.contextWindow, agent.maxOutputTokens)
                    ? [{ label: t('limits.detailLabel'), value: limitsSummary(t, agent.contextWindow, agent.maxOutputTokens) }]
                    : []),
                  { label: t('agentDetail.command'), value: <span className="font-mono text-xs break-all">{joinCommand(agent.command)}</span> },
                  { label: 'ID', value: <span className="font-mono text-xs">{agent.id}</span> },
                ]}
              />
            </CardBody>
          </Card>
          {exited && (
            <Button variant="primary" className="w-full" icon={<Play className="size-4" />} onClick={() => setSwitchOpen(true)}>
              {t('agentDetail.startNew')}
            </Button>
          )}
          {!exited && (
            <Button variant="ghost" className="w-full" onClick={() => navigate(`/sandboxes/${agent.sandboxId}/changes`)}>
              {t('agentDetail.viewChanges')}
            </Button>
          )}
        </div>
      </div>

      <SwitchAgentDialog agent={agent} open={switchOpen} onClose={() => setSwitchOpen(false)} onSwitched={(next) => navigate(`/agents/${next.id}`)} />

      <ConfirmDialog
        open={confirmKill}
        onClose={() => setConfirmKill(false)}
        onConfirm={() => kill.mutate()}
        loading={kill.isPending}
        danger
        title={t('agentDetail.stopConfirmTitle')}
        confirmLabel={t('agentDetail.stopConfirm')}
        message={t('agentDetail.stopConfirmText')}
      />
    </>
  );
}

function MessageBox({ agentId }: { agentId: string }) {
  const t = useT();
  const [text, setText] = useState('');
  const [submit, setSubmit] = useState(true);
  const send = useAction((v: { text: string; submit: boolean }) => rpc('agent.send_input', { agentId, ...v }), {
    success: t('agentDetail.msg.sent'),
    error: t('agentDetail.msg.failed'),
    onSuccess: () => setText(''),
  });
  const go = () => text.trim() && send.mutate({ text, submit });
  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <MessageSquare className="size-4 text-fg-muted" /> {t('agentDetail.msg.title')}
          </span>
        }
      />
      <CardBody className="space-y-3">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          placeholder={t('agentDetail.msg.placeholder')}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              go();
            }
          }}
        />
        <div className="flex items-center justify-between gap-2">
          <Checkbox checked={submit} onChange={setSubmit} label={t('agentDetail.msg.pressEnter')} />
          <Button variant="primary" size="sm" icon={<Send className="size-3.5" />} disabled={!text.trim()} loading={send.isPending} onClick={go}>
            {t('agentDetail.msg.send')}
          </Button>
        </div>
        <p className={cn('flex items-start gap-1.5 text-xs text-fg-subtle')}>
          <Info className="mt-px size-3 shrink-0" /> {t('agentDetail.msg.hint')}
        </p>
      </CardBody>
    </Card>
  );
}
