import { Link } from 'react-router-dom';
import type { Agent, Sandbox } from '@cocoon/protocol';
import { Bot, ChevronRight, SquareTerminal } from 'lucide-react';
import { useSettings } from '../api/queries';
import { useT } from '../i18n';
import { cn } from '../lib/cn';
import { formatRelative } from '../lib/format';
import { AGENT_STATUS_ORDER } from '../lib/status';
import { AgentStatusBadge } from './Badge';
import { profileLabel } from './SpawnAgentDialog';

export function sortAgents(agents: Agent[]): Agent[] {
  return [...agents].sort(
    (a, b) => (AGENT_STATUS_ORDER[a.status] ?? 9) - (AGENT_STATUS_ORDER[b.status] ?? 9) || b.statusChangedAt.localeCompare(a.statusChangedAt),
  );
}

/** Clickable list of agents. Blocked agents get an amber accent so they stand out. */
export function AgentList({ agents, sandboxes, showSandbox = true }: { agents: Agent[]; sandboxes?: Sandbox[]; showSandbox?: boolean }) {
  const t = useT();
  const settings = useSettings();
  const sbName = (id: string) => sandboxes?.find((s) => s.id === id)?.name ?? id;
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
      {agents.map((a) => {
        const blocked = a.status === 'blocked';
        return (
          <li key={a.id}>
            <Link
              to={`/agents/${a.id}`}
              className={cn('flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-2/70', blocked && 'border-l-4 border-l-amber-500 bg-amber-400/10 hover:bg-amber-400/15')}
            >
              <div className="rounded-lg bg-surface-2 p-2 text-fg-muted">{a.kind === 'shell' ? <SquareTerminal className="size-4" /> : <Bot className="size-4" />}</div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className="font-medium text-fg">{profileLabel(a.kind, settings.data?.agents[a.kind])}</span>
                  {showSandbox && <span className="text-sm text-fg-muted">{t('agentList.inSandbox', { name: sbName(a.sandboxId) })}</span>}
                </div>
                <div className="truncate text-sm text-fg-subtle">{a.prompt ? t('agentList.prompt', { prompt: a.prompt }) : t('agentList.noPrompt')}</div>
              </div>
              <div className="hidden text-right text-xs text-fg-subtle sm:block">{formatRelative(a.statusChangedAt)}</div>
              <AgentStatusBadge status={a.status} />
              <ChevronRight className="size-4 text-fg-subtle" />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
