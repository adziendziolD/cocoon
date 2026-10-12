import { useState } from 'react';
import type { AgentStatus } from '@cocoon/protocol';
import { Bot } from 'lucide-react';
import { useAgents, useSandboxes } from '../api/queries';
import { AgentList, sortAgents } from '../components/AgentList';
import { StatusDot } from '../components/Badge';
import { ButtonLink } from '../components/Button';
import { PageHeader } from '../components/Card';
import { EmptyState } from '../components/EmptyState';
import { ErrorState, LoadingState } from '../components/States';
import { useT, type TFunction } from '../i18n';
import { cn } from '../lib/cn';
import { agentStatusMeta } from '../lib/status';

type Filter = 'all' | 'active' | AgentStatus;
const FILTERS: Filter[] = ['active', 'blocked', 'working', 'done', 'idle', 'exited', 'all'];

function filterLabel(t: TFunction, f: Filter): string {
  if (f === 'active') return t('agentsPage.filter.active');
  if (f === 'all') return t('agentsPage.filter.all');
  return agentStatusMeta(t, f).label;
}

export function AgentsPage() {
  const t = useT();
  const agents = useAgents();
  const sandboxes = useSandboxes();
  const [filter, setFilter] = useState<Filter>('active');
  const all = agents.data ?? [];
  const count = (f: Filter) => (f === 'all' ? all.length : f === 'active' ? all.filter((a) => a.status !== 'exited').length : all.filter((a) => a.status === f).length);
  const shown = sortAgents(all.filter((a) => (filter === 'all' ? true : filter === 'active' ? a.status !== 'exited' : a.status === filter)));

  return (
    <>
      <PageHeader title={t('agentsPage.title')} description={t('agentsPage.description')} />

      <div className="mb-4 flex flex-wrap gap-2">
        {FILTERS.map((id) => {
          const f = { id, label: filterLabel(t, id) };
          const n = count(id);
          const meta = id === 'all' || id === 'active' ? undefined : agentStatusMeta(t, id);
          return (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={cn(
                'flex items-center gap-2 rounded-full border px-3 py-1 text-sm transition-colors',
                filter === f.id ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-surface text-fg-muted hover:border-line-strong hover:text-fg',
                f.id === 'blocked' && n > 0 && filter !== f.id && 'border-amber-400 bg-amber-400/10 text-amber-800 dark:text-amber-300',
              )}
            >
              {meta && <StatusDot tone={meta.tone} />}
              {f.label}
              <span className="text-xs opacity-70">{n}</span>
            </button>
          );
        })}
      </div>

      {agents.isLoading ? (
        <LoadingState />
      ) : agents.error ? (
        <ErrorState error={agents.error} onRetry={() => agents.refetch()} />
      ) : all.length === 0 ? (
        <EmptyState icon={<Bot className="size-6" />} title={t('agentsPage.emptyTitle')}
          action={
            <ButtonLink to="/sandboxes" variant="primary">
              {t('agentsPage.toSandboxes')}
            </ButtonLink>
          }
        >
          {t('agentsPage.emptyText')}
        </EmptyState>
      ) : shown.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line-strong px-4 py-8 text-center text-sm text-fg-muted">{t('agentsPage.noneWithStatus')}</p>
      ) : (
        <AgentList agents={shown} sandboxes={sandboxes.data} />
      )}
    </>
  );
}
