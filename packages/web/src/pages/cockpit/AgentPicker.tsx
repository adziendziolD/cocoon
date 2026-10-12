import { useState, type ReactNode } from 'react';
import type { Agent } from '@cocoon/protocol';
import { Bell, Bot, KanbanSquare, Search, Square, SquareTerminal } from 'lucide-react';
import { useSettings } from '../../api/queries';
import { StatusDot } from '../../components/Badge';
import { Input } from '../../components/Field';
import { useLanguage, useT } from '../../i18n';
import { cn } from '../../lib/cn';
import { profileLabel } from '../../lib/profiles';
import { agentStatusMeta } from '../../lib/status';
import { useCockpit, useCockpitActions } from './context';
import type { PaneView } from './layoutTree';

export type PickResult = { view: 'agent'; agentId: string } | { view: Exclude<PaneView, 'agent'> };

/** List of agents (live first, not-yet-shown first) plus the tool views, for choosing a pane's content. */
export function AgentPickerList({ onPick, currentAgentId, showViews = true, limit }: { onPick: (r: PickResult) => void; currentAgentId?: string; showViews?: boolean; limit?: number }) {
  const t = useT();
  const data = useCockpit();
  const { shownAgents } = useCockpitActions();
  const [q, setQ] = useState('');
  const settings = useSettings();
  const { lang } = useLanguage();
  const query = q.trim().toLowerCase();
  const matches = (a: Agent) => {
    if (!query) return true;
    const label = profileLabel(a.kind, settings.data?.agents[a.kind], lang).toLowerCase();
    const sb = data.sandboxById.get(a.sandboxId)?.name.toLowerCase() ?? '';
    const task = data.taskByAgent.get(a.id)?.title.toLowerCase() ?? '';
    return label.includes(query) || sb.includes(query) || task.includes(query);
  };
  const agents = [...data.liveAgents].filter(matches).sort((a, b) => Number(shownAgents.has(a.id)) - Number(shownAgents.has(b.id)));
  const shown = limit ? agents.slice(0, limit) : agents;

  return (
    <div className="space-y-1.5">
      {data.liveAgents.length > 6 && (
        <div className="relative">
          <Search className="pointer-events-none absolute top-2 left-2.5 size-4 text-fg-subtle" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('cockpit.picker.search')} className="h-8 pl-8 text-xs" autoFocus />
        </div>
      )}
      {shown.length === 0 ? (
        <p className="px-2 py-1.5 text-xs text-fg-subtle">{query ? t('cockpit.picker.noMatch') : t('cockpit.picker.noAgents')}</p>
      ) : (
        <ul className="max-h-72 space-y-0.5 overflow-y-auto">
          {shown.map((a) => (
            <li key={a.id}>
              <AgentOption agent={a} active={a.id === currentAgentId} shown={shownAgents.has(a.id)} onClick={() => onPick({ view: 'agent', agentId: a.id })} />
            </li>
          ))}
        </ul>
      )}
      {showViews && (
        <div className="grid grid-cols-3 gap-1 border-t border-line pt-1.5">
          <ViewOption icon={<KanbanSquare className="size-4" />} label={t('cockpit.view.board')} onClick={() => onPick({ view: 'board' })} />
          <ViewOption icon={<Bell className="size-4" />} label={t('cockpit.view.attention')} onClick={() => onPick({ view: 'attention' })} />
          <ViewOption icon={<Square className="size-4" />} label={t('cockpit.view.empty')} onClick={() => onPick({ view: 'empty' })} />
        </div>
      )}
    </div>
  );
}

function AgentOption({ agent, active, shown, onClick }: { agent: Agent; active: boolean; shown: boolean; onClick: () => void }) {
  const t = useT();
  const { lang } = useLanguage();
  const settings = useSettings();
  const data = useCockpit();
  const meta = agentStatusMeta(t, agent.status);
  const task = data.taskByAgent.get(agent.id);
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left',
        active ? 'bg-accent-soft' : agent.status === 'blocked' ? 'bg-amber-400/10 hover:bg-amber-400/20' : 'hover:bg-surface-2',
      )}
    >
      <StatusDot tone={meta.tone} animated={meta.animated} />
      {agent.kind === 'shell' ? <SquareTerminal className="size-3.5 shrink-0 text-fg-subtle" /> : <Bot className="size-3.5 shrink-0 text-fg-subtle" />}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-fg">{task?.title ?? profileLabel(agent.kind, settings.data?.agents[agent.kind], lang)}</span>
        <span className="block truncate text-[11px] text-fg-muted">
          {task ? `${profileLabel(agent.kind, settings.data?.agents[agent.kind], lang)} · ` : ''}
          {data.sandboxById.get(agent.sandboxId)?.name ?? agent.sandboxId} · {meta.label}
        </span>
      </span>
      {shown && <span className="text-[10px] text-fg-subtle">{t('cockpit.picker.shown')}</span>}
    </button>
  );
}

function ViewOption({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex flex-col items-center gap-1 rounded-lg px-1 py-1.5 text-[11px] text-fg-muted hover:bg-surface-2 hover:text-fg">
      {icon}
      <span className="truncate">{label}</span>
    </button>
  );
}
