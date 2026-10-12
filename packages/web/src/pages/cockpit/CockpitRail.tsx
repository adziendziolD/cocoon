import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Agent, Sandbox, Workspace } from '@cocoon/protocol';
import { Bot, Box, ChevronDown, ChevronRight, Eye, Hand, Inbox, PanelLeftClose, SquareTerminal } from 'lucide-react';
import { useSettings } from '../../api/queries';
import { StatusDot } from '../../components/Badge';
import { Checkbox } from '../../components/Field';
import { WorkspaceDot } from '../../components/WorkspaceSwitcher';
import { useLanguage, useT } from '../../i18n';
import { cn } from '../../lib/cn';
import { profileLabel } from '../../lib/profiles';
import { agentStatusMeta, AGENT_STATUS_ORDER } from '../../lib/status';
import { AttentionList } from './AttentionList';
import { attentionItems, useCockpit, useCockpitActions } from './context';

export const AGENT_DRAG_TYPE = 'application/x-cocoon-agent';

/** Left rail: attention queue on top, then Workspace → Sandbox → Agent tree. Agents can be dragged onto panes. */
export function CockpitRail({ onCollapse }: { onCollapse: () => void }) {
  const t = useT();
  const data = useCockpit();
  const [showExited, setShowExited] = useState(false);
  const attention = attentionItems(data).length;

  // Group: workspace (or unassigned) → sandboxes → agents.
  const groups: Array<{ key: string; workspace?: Workspace; sandboxes: Sandbox[] }> = [];
  const wsList = data.workspace ? [data.workspace] : data.scope === 'unassigned' ? [] : data.workspaces;
  for (const w of wsList) groups.push({ key: w.id, workspace: w, sandboxes: data.sandboxes.filter((s) => s.workspaceId === w.id) });
  if (data.scope === 'all' || data.scope === 'unassigned') {
    const known = new Set(data.workspaces.map((w) => w.id));
    groups.push({ key: '_none', sandboxes: data.sandboxes.filter((s) => !s.workspaceId || !known.has(s.workspaceId)) });
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className="flex-1 text-xs font-semibold tracking-wide text-fg-subtle uppercase">{t('cockpit.rail.title')}</span>
        <button type="button" onClick={onCollapse} className="rounded-md p-1 text-fg-subtle hover:bg-surface-2 hover:text-fg" aria-label={t('cockpit.rail.collapse')} title={t('cockpit.rail.collapse')}>
          <PanelLeftClose className="size-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <section className={cn('border-b border-line p-2', attention > 0 && 'bg-amber-400/5')}>
          <div className="mb-1.5 flex items-center gap-1.5 px-1 text-xs font-semibold text-fg">
            <Hand className={cn('size-3.5', attention ? 'text-amber-600 dark:text-amber-400' : 'text-fg-subtle')} />
            {t('cockpit.attention.title')}
            {attention > 0 && <span className="rounded-full bg-amber-400 px-1.5 text-[11px] font-semibold text-amber-950">{attention}</span>}
          </div>
          <AttentionList compact />
        </section>

        <section className="p-2">
          {!data.loaded ? (
            <p className="px-2 py-2 text-xs text-fg-subtle">{t('common.loading')}</p>
          ) : groups.every((g) => g.sandboxes.length === 0) ? (
            <div className="px-2 py-3 text-xs leading-relaxed text-fg-muted">
              {t('cockpit.rail.empty')}{' '}
              <Link to="/tasks" className="text-accent hover:underline">
                {t('layout.nav.tasks')}
              </Link>
            </div>
          ) : (
            groups.map((g) => <WorkspaceGroup key={g.key} workspace={g.workspace} sandboxes={g.sandboxes} showExited={showExited} single={groups.length === 1} />)
          )}
        </section>
      </div>
      <div className="border-t border-line px-3 py-2">
        <Checkbox checked={showExited} onChange={setShowExited} label={<span className="text-xs">{t('cockpit.rail.showExited')}</span>} />
      </div>
    </div>
  );
}

function WorkspaceGroup({ workspace, sandboxes, showExited, single }: { workspace?: Workspace; sandboxes: Sandbox[]; showExited: boolean; single: boolean }) {
  const t = useT();
  const data = useCockpit();
  const [open, setOpen] = useState(true);
  if (!sandboxes.length && !single) return null;
  const blocked = data.agents.filter((a) => a.status === 'blocked' && sandboxes.some((s) => s.id === a.sandboxId)).length;
  return (
    <div className="mb-1">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs font-semibold text-fg hover:bg-surface-2">
        {open ? <ChevronDown className="size-3.5 text-fg-subtle" /> : <ChevronRight className="size-3.5 text-fg-subtle" />}
        {workspace ? <WorkspaceDot workspace={workspace} className="size-2" /> : <Inbox className="size-3.5 text-fg-subtle" />}
        <span className="flex-1 truncate">{workspace?.name ?? t('workspace.unassigned')}</span>
        {blocked > 0 && <span className="rounded-full bg-amber-400 px-1.5 text-[11px] text-amber-950">{blocked}</span>}
      </button>
      {open && (
        <div className="ml-2 border-l border-line pl-1.5">
          {sandboxes.length === 0 && <p className="px-2 py-1 text-[11px] text-fg-subtle">{t('cockpit.rail.noSandboxes')}</p>}
          {sandboxes.map((s) => (
            <SandboxNode key={s.id} sandbox={s} showExited={showExited} />
          ))}
        </div>
      )}
    </div>
  );
}

function SandboxNode({ sandbox, showExited }: { sandbox: Sandbox; showExited: boolean }) {
  const t = useT();
  const data = useCockpit();
  const [open, setOpen] = useState(true);
  const agents = data.agents
    .filter((a) => a.sandboxId === sandbox.id && (showExited || a.status !== 'exited'))
    .sort((a, b) => (AGENT_STATUS_ORDER[a.status] ?? 9) - (AGENT_STATUS_ORDER[b.status] ?? 9));
  const tone = sandbox.status === 'running' ? 'green' : sandbox.status === 'creating' ? 'blue' : sandbox.status === 'stopped' ? 'slate' : 'red';
  return (
    <div>
      <div className="group flex items-center gap-1 rounded-md px-1 py-0.5 hover:bg-surface-2">
        <button type="button" onClick={() => setOpen((o) => !o)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-xs text-fg-muted">
          {open ? <ChevronDown className="size-3 text-fg-subtle" /> : <ChevronRight className="size-3 text-fg-subtle" />}
          <Box className="size-3.5 shrink-0 text-fg-subtle" />
          <span className="truncate">{sandbox.name}</span>
          <StatusDot tone={tone} animated={sandbox.status === 'creating'} className="size-1.5" />
        </button>
        <Link to={`/sandboxes/${sandbox.id}`} className="hidden text-[11px] text-fg-subtle group-hover:inline hover:text-fg hover:underline">
          {t('cockpit.rail.open')}
        </Link>
      </div>
      {open && (
        <ul className="ml-3">
          {agents.length === 0 && <li className="px-2 py-0.5 text-[11px] text-fg-subtle">{t('cockpit.rail.noAgents')}</li>}
          {agents.map((a) => (
            <AgentNode key={a.id} agent={a} />
          ))}
        </ul>
      )}
    </div>
  );
}

function AgentNode({ agent }: { agent: Agent }) {
  const t = useT();
  const { lang } = useLanguage();
  const settings = useSettings();
  const data = useCockpit();
  const { focusAgent, shownAgents } = useCockpitActions();
  const meta = agentStatusMeta(t, agent.status);
  const task = data.taskByAgent.get(agent.id);
  const shown = shownAgents.has(agent.id);
  const blocked = agent.status === 'blocked';
  return (
    <li>
      <button
        type="button"
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(AGENT_DRAG_TYPE, agent.id);
          e.dataTransfer.setData('text/plain', agent.id);
          e.dataTransfer.effectAllowed = 'copyMove';
        }}
        onClick={() => focusAgent(agent.id)}
        title={`${meta.label} – ${t('cockpit.rail.agentHint')}`}
        className={cn(
          'flex w-full cursor-grab items-center gap-1.5 rounded-md px-1.5 py-1 text-left active:cursor-grabbing',
          blocked ? 'bg-amber-400/15 hover:bg-amber-400/25' : 'hover:bg-surface-2',
          agent.status === 'exited' && 'opacity-60',
        )}
      >
        <StatusDot tone={meta.tone} animated={meta.animated} />
        {agent.kind === 'shell' ? <SquareTerminal className="size-3.5 shrink-0 text-fg-subtle" /> : <Bot className="size-3.5 shrink-0 text-fg-subtle" />}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium text-fg">{profileLabel(agent.kind, settings.data?.agents[agent.kind], lang)}</span>
          {task && <span className="block truncate text-[11px] text-fg-muted">{task.title}</span>}
        </span>
        {blocked && <span className="text-[10px] font-semibold text-amber-700 dark:text-amber-300">{meta.label}</span>}
        {shown && <Eye className="size-3 shrink-0 text-accent" aria-label={t('cockpit.rail.shown')} />}
      </button>
    </li>
  );
}
