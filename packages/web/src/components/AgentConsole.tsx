import { useCallback, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Agent, SandboxStatus } from '@cocoon/protocol';
import { Plug, RefreshCw } from 'lucide-react';
import { rpc } from '../api/rpc';
import { useT } from '../i18n';
import { cn } from '../lib/cn';
import { StatusDot } from './Badge';
import { Button } from './Button';
import { LoadingState } from './States';
import { AgentTerminal, describeClose, type TerminalState } from './Terminal';

/**
 * The agent's screen: a live interactive terminal while the agent runs, its last output once it exited.
 * Shows a reconnect bar when the attach socket closes. Fills its (relatively positioned) container.
 * Used on the agent detail page, in cockpit panes and in the task drawer.
 */
export function AgentConsole({
  agent,
  sandboxStatus,
  connectKey = 0,
  onStateChange,
  autoFocus,
  focusSignal,
  fontSize,
  compact,
}: {
  agent: Agent;
  sandboxStatus?: SandboxStatus;
  /** Bump to force a reconnect from outside. */
  connectKey?: number;
  onStateChange?: (s: TerminalState) => void;
  autoFocus?: boolean;
  focusSignal?: number;
  fontSize?: number;
  /** Smaller reconnect bar for small panes. */
  compact?: boolean;
}) {
  const t = useT();
  const [state, setState] = useState<TerminalState>({ kind: 'connecting' });
  const [retry, setRetry] = useState(0);
  const onState = useCallback(
    (s: TerminalState) => {
      setState(s);
      onStateChange?.(s);
    },
    [onStateChange],
  );

  if (agent.status === 'exited') return <ExitedOutput agentId={agent.id} />;

  return (
    <div className="absolute inset-0">
      <AgentTerminal
        agentId={agent.id}
        connectKey={connectKey + retry}
        onStateChange={onState}
        autoFocus={autoFocus}
        focusSignal={focusSignal}
        fontSize={fontSize}
      />
      {state.kind === 'closed' && (
        <div
          className={cn(
            'absolute inset-x-0 bottom-0 flex flex-wrap items-center gap-3 border-t border-white/10 bg-gray-900/95 text-gray-200',
            compact ? 'px-3 py-2 text-xs' : 'px-4 py-3 text-sm',
          )}
        >
          <Plug className="size-4 text-amber-400" />
          <span className="min-w-0 flex-1">
            {t('agentDetail.terminalClosed', { reason: describeClose(state, t) })}
            {sandboxStatus && sandboxStatus !== 'running' && ` – ${t('agentDetail.sandboxNotRunning')}`}
          </span>
          <Button size="sm" variant="primary" icon={<RefreshCw className="size-3.5" />} onClick={() => setRetry((k) => k + 1)}>
            {t('agentDetail.reconnect')}
          </Button>
        </div>
      )}
    </div>
  );
}

/** Small "live / connecting / closed" indicator for a terminal. */
export function TerminalStatus({ state, exited, short }: { state: TerminalState; exited: boolean; short?: boolean }) {
  const t = useT();
  if (exited) return <span className="text-sm text-fg-muted">{t('agentDetail.term.readOnly')}</span>;
  const m =
    state.kind === 'open'
      ? { tone: 'green' as const, text: t('agentDetail.term.live') }
      : state.kind === 'connecting'
        ? { tone: 'amber' as const, text: t('agentDetail.term.connecting') }
        : { tone: 'red' as const, text: t('agentDetail.term.closed') };
  return (
    <span className="flex items-center gap-2 text-sm text-fg-muted" title={m.text}>
      <StatusDot tone={m.tone} animated={state.kind === 'connecting'} />
      {!short && m.text}
    </span>
  );
}

export function ExitedOutput({ agentId }: { agentId: string }) {
  const t = useT();
  const out = useQuery({ queryKey: ['agent.read', agentId], queryFn: () => rpc('agent.read', { agentId, lines: 2000 }), retry: false });
  return (
    <div className="absolute inset-0 overflow-auto bg-[#0b0e14] p-4">
      {out.isLoading ? (
        <LoadingState className="text-gray-400" />
      ) : out.error ? (
        <p className="text-sm text-gray-400">{t('agentDetail.outputGone')}</p>
      ) : (
        <pre className="font-mono text-[13px] leading-snug whitespace-pre-wrap text-gray-200">{out.data?.text || t('agentDetail.noOutput')}</pre>
      )}
    </div>
  );
}
