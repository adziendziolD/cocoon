import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { Agent } from '@cocoon/protocol';
import {
  ArrowLeftRight,
  ArrowRightLeft,
  Bell,
  Check,
  CircleStop,
  Columns2,
  ExternalLink,
  Ghost,
  KanbanSquare,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  PauseCircle,
  Play,
  Rows2,
  X,
} from 'lucide-react';
import { qk } from '../../api/keys';
import { useSettings } from '../../api/queries';
import { rpc } from '../../api/rpc';
import { useAction } from '../../api/useAction';
import { AgentConsole } from '../../components/AgentConsole';
import { AgentStatusBadge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { ConfirmDialog } from '../../components/Dialog';
import { MenuItem, MenuSeparator, Popover } from '../../components/Popover';
import { SwitchAgentDialog } from '../../components/SwitchAgentDialog';
import { limitsSummary } from '../../components/ModelLimits';
import { AutomationBar } from '../../components/tasks/AutomationBar';
import { TaskBoard } from '../../components/tasks/TaskBoard';
import { useOpenTask } from '../../components/tasks/useTaskActions';
import { useLanguage, useT } from '../../i18n';
import { cn } from '../../lib/cn';
import { profileLabel } from '../../lib/profiles';
import { AgentPickerList, type PickResult } from './AgentPicker';
import { AttentionList } from './AttentionList';
import { AGENT_DRAG_TYPE } from './CockpitRail';
import { useCockpit } from './context';
import type { Direction, PaneNode } from './layoutTree';

export interface PaneProps {
  pane: PaneNode;
  focused: boolean;
  maximized: boolean;
  selected: boolean;
  /** Allowed to open a live terminal (visible and under the cap). */
  live: boolean;
  focusSignal?: number;
  dense: boolean;
  canClose: boolean;
  onFocus: () => void;
  onToggleSelect: () => void;
  onMaximize: () => void;
  onSplit: (dir: Direction) => void;
  onClose: () => void;
  onPick: (r: PickResult) => void;
}

const ICON = 'size-3.5';

/** One tile of the cockpit: a header with context and quick actions, and the view (terminal, board, attention, picker). */
export function Pane(props: PaneProps) {
  const { pane, focused, maximized, onFocus, onPick } = props;
  const t = useT();
  const data = useCockpit();
  const [dragOver, setDragOver] = useState(false);
  const [switchOpen, setSwitchOpen] = useState(false);
  const agent = pane.view === 'agent' && pane.agentId ? data.agentById.get(pane.agentId) : undefined;
  const openSwitch = () => setSwitchOpen(true);

  return (
    <div
      className={cn(
        'flex h-full flex-col overflow-hidden rounded-lg border bg-surface transition-shadow',
        focused ? 'border-accent ring-2 ring-accent/40' : agent?.status === 'blocked' ? 'border-amber-400' : 'border-line',
        dragOver && 'ring-4 ring-accent/50',
      )}
      onMouseDownCapture={onFocus}
      onFocusCapture={onFocus}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(AGENT_DRAG_TYPE)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        if (!dragOver) setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false);
      }}
      onDrop={(e) => {
        const id = e.dataTransfer.getData(AGENT_DRAG_TYPE);
        setDragOver(false);
        if (id) {
          e.preventDefault();
          onPick({ view: 'agent', agentId: id });
        }
      }}
      data-pane-id={pane.id}
    >
      <PaneHeader {...props} agent={agent} onSwitch={openSwitch} />
      <div className="relative min-h-0 flex-1">
        {pane.view === 'agent' ? (
          <AgentView {...props} agent={agent} onSwitch={openSwitch} />
        ) : pane.view === 'board' ? (
          <BoardView />
        ) : pane.view === 'attention' ? (
          <div className="absolute inset-0 overflow-y-auto p-2">
            <AttentionList emptyText={t('cockpit.attention.emptyLong')} />
          </div>
        ) : (
          <EmptyView onPick={onPick} />
        )}
        {dragOver && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-accent/10 text-sm font-medium text-accent">{t('cockpit.pane.dropHere')}</div>
        )}
      </div>
      {maximized && <span className="sr-only">{t('cockpit.pane.maximized')}</span>}
      {agent && (
        <SwitchAgentDialog agent={agent} open={switchOpen} onClose={() => setSwitchOpen(false)} onSwitched={(next) => onPick({ view: 'agent', agentId: next.id })} />
      )}
    </div>
  );
}

function PaneHeader({ pane, agent, focused, maximized, selected, dense, canClose, onToggleSelect, onMaximize, onSplit, onClose, onPick, onSwitch }: PaneProps & { agent?: Agent; onSwitch: () => void }) {
  const t = useT();
  const { lang } = useLanguage();
  const settings = useSettings();
  const data = useCockpit();
  const openTask = useOpenTask();
  const [confirmStop, setConfirmStop] = useState(false);
  const task = agent ? data.taskByAgent.get(agent.id) : undefined;
  const sandbox = agent ? data.sandboxById.get(agent.sandboxId) : undefined;
  const alive = agent && agent.status !== 'exited';
  const blocked = agent?.status === 'blocked';
  const limits = agent ? limitsSummary(t, agent.contextWindow, agent.maxOutputTokens) : undefined;
  const details = agent ? [agent.model, limits].filter(Boolean).join(' · ') : '';

  const keys = useAction((k: string[]) => rpc('agent.send_keys', { agentId: agent!.id, keys: k }), { error: t('agentDetail.keysFailed') });
  const kill = useAction(() => rpc('agent.kill', { agentId: agent!.id }), {
    success: t('agentDetail.stopped'),
    error: t('agentDetail.stopFailed'),
    invalidate: [qk.agents],
    onSuccess: () => setConfirmStop(false),
  });

  let title: ReactNode;
  if (pane.view === 'agent') {
    title = agent ? (
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="shrink-0 font-medium text-fg" title={details || undefined}>
          {profileLabel(agent.kind, settings.data?.agents[agent.kind], lang)}
        </span>
        {!dense && sandbox && <span className="truncate text-fg-subtle">· {sandbox.name}</span>}
        {task && (
          <button type="button" onClick={() => openTask(task.id)} className="truncate text-fg-muted hover:text-fg hover:underline" title={t('cockpit.pane.openTask')}>
            · {task.title}
          </button>
        )}
      </span>
    ) : (
      <span className="text-fg-muted">{t('cockpit.pane.agentGone')}</span>
    );
  } else {
    title = (
      <span className="flex items-center gap-1.5 font-medium text-fg">
        {pane.view === 'board' ? <KanbanSquare className={ICON} /> : pane.view === 'attention' ? <Bell className={ICON} /> : null}
        {t(`cockpit.view.${pane.view}`)}
      </span>
    );
  }

  return (
    <div className={cn('flex h-8 shrink-0 items-center gap-1.5 border-b px-1.5 text-xs', focused ? 'border-accent/30 bg-accent-soft/60' : 'border-line bg-surface-2/60', blocked && 'bg-amber-400/20')}>
      {pane.view === 'agent' && alive && (
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelect}
          className="size-3.5 shrink-0 accent-[var(--color-accent)]"
          title={t('cockpit.pane.selectBroadcast')}
          aria-label={t('cockpit.pane.selectBroadcast')}
        />
      )}
      <div className="min-w-0 flex-1 truncate">{title}</div>
      {agent && !dense && !blocked && <AgentStatusBadge status={agent.status} />}
      {blocked && (
        <>
          <Button size="sm" variant="success" className="h-6 px-2" icon={<Check className="size-3" />} onClick={() => keys.mutate(['Enter'])} title={t('cockpit.pane.yesHint')}>
            {t('common.yes')}
          </Button>
          <Button size="sm" className="h-6 px-2" icon={<X className="size-3" />} onClick={() => keys.mutate(['Escape'])} title={t('cockpit.pane.noHint')}>
            {t('common.no')}
          </Button>
        </>
      )}
      {alive && !blocked && !dense && (
        <>
          <HeaderBtn label={t('cockpit.pane.escHint')} onClick={() => keys.mutate(['Escape'])}>
            <span className="font-mono text-[10px]">Esc</span>
          </HeaderBtn>
          <HeaderBtn label={t('agentDetail.key.ctrlC')} onClick={() => keys.mutate(['C-c'])}>
            <span className="font-mono text-[10px]">^C</span>
          </HeaderBtn>
        </>
      )}
      <Popover
        align="right"
        trigger={({ toggle }) => (
          <HeaderBtn label={t('cockpit.pane.swap')} onClick={toggle}>
            <ArrowLeftRight className={ICON} />
          </HeaderBtn>
        )}
        panelClassName="w-80"
      >
        {(close) => (
          <AgentPickerList
            currentAgentId={pane.agentId}
            onPick={(r) => {
              close();
              onPick(r);
            }}
          />
        )}
      </Popover>
      <HeaderBtn label={maximized ? t('cockpit.pane.restore') : t('cockpit.pane.maximize')} onClick={onMaximize}>
        {maximized ? <Minimize2 className={ICON} /> : <Maximize2 className={ICON} />}
      </HeaderBtn>
      <Popover
        align="right"
        trigger={({ toggle }) => (
          <HeaderBtn label={t('cockpit.pane.more')} onClick={toggle}>
            <MoreHorizontal className={ICON} />
          </HeaderBtn>
        )}
      >
        {(close) => (
          <>
            {agent && details && (
              <>
                <div className="max-w-72 px-2.5 py-1.5 text-xs text-fg-muted">
                  {agent.model && <div className="truncate font-mono text-fg">{agent.model}</div>}
                  {limits && <div>{limits}</div>}
                </div>
                <MenuSeparator />
              </>
            )}
            <MenuItem icon={<Columns2 className="size-4" />} hint="⌃⌥D" onClick={() => (close(), onSplit('row'))}>
              {t('cockpit.pane.splitRight')}
            </MenuItem>
            <MenuItem icon={<Rows2 className="size-4" />} onClick={() => (close(), onSplit('column'))}>
              {t('cockpit.pane.splitDown')}
            </MenuItem>
            {agent && (
              <>
                <MenuSeparator />
                <Link to={`/agents/${agent.id}`} onClick={close} className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm text-fg hover:bg-surface-2">
                  <ExternalLink className="size-4" /> {t('cockpit.pane.openDetail')}
                </Link>
                <MenuItem icon={alive ? <ArrowRightLeft className="size-4" /> : <Play className="size-4" />} onClick={() => (close(), onSwitch())}>
                  {alive ? t('switch.title') : t('switch.titleExited')}
                </MenuItem>
                {alive && (
                  <MenuItem danger icon={<CircleStop className="size-4" />} onClick={() => (close(), setConfirmStop(true))}>
                    {t('agentDetail.stop')}
                  </MenuItem>
                )}
              </>
            )}
            {canClose && (
              <>
                <MenuSeparator />
                <MenuItem icon={<X className="size-4" />} hint="⌃⌥W" onClick={() => (close(), onClose())}>
                  {t('cockpit.pane.close')}
                </MenuItem>
              </>
            )}
          </>
        )}
      </Popover>
      {canClose && (
        <HeaderBtn label={t('cockpit.pane.close')} onClick={onClose}>
          <X className={ICON} />
        </HeaderBtn>
      )}
      <ConfirmDialog
        open={confirmStop}
        onClose={() => setConfirmStop(false)}
        onConfirm={() => kill.mutate()}
        loading={kill.isPending}
        danger
        title={t('agentDetail.stopConfirmTitle')}
        confirmLabel={t('agentDetail.stopConfirm')}
        message={t('agentDetail.stopConfirmText')}
      />
    </div>
  );
}

function HeaderBtn({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} title={label} aria-label={label} className="flex h-6 min-w-6 shrink-0 items-center justify-center rounded-md px-1 text-fg-muted hover:bg-surface hover:text-fg">
      {children}
    </button>
  );
}

function AgentView({ pane, agent, live, focusSignal, dense, onPick, onMaximize, onSwitch }: PaneProps & { agent?: Agent; onSwitch: () => void }) {
  const t = useT();
  const data = useCockpit();
  if (!agent) {
    return (
      <Placeholder icon={<Ghost className="size-6" />} title={data.loaded ? t('cockpit.pane.agentGone') : t('common.loading')}>
        {data.loaded && (
          <>
            <p>{t('cockpit.pane.agentGoneText')}</p>
            <div className="mt-3 w-full max-w-xs text-left">
              <AgentPickerList onPick={onPick} limit={5} showViews={false} />
            </div>
          </>
        )}
      </Placeholder>
    );
  }
  if (agent.status !== 'exited' && !live) {
    return (
      <Placeholder icon={<PauseCircle className="size-6" />} title={t('cockpit.pane.pausedTitle')}>
        <p>{t('cockpit.pane.pausedText')}</p>
        <Button size="sm" className="mt-3" onClick={onMaximize}>
          {t('cockpit.pane.maximize')}
        </Button>
      </Placeholder>
    );
  }
  return (
    <div className="absolute inset-0 bg-[#0b0e14]">
      <AgentConsole
        key={pane.agentId}
        agent={agent}
        sandboxStatus={data.sandboxById.get(agent.sandboxId)?.status}
        autoFocus={false}
        focusSignal={focusSignal}
        fontSize={dense ? 12 : 13}
        compact
      />
      {agent.status === 'exited' && (
        <div className="absolute inset-x-0 bottom-0 flex items-center gap-2 border-t border-white/10 bg-gray-900/95 px-3 py-2 text-xs text-gray-200">
          <span className="flex-1">{t('cockpit.pane.exited')}</span>
          <Button size="sm" variant="primary" icon={<Play className="size-3" />} onClick={onSwitch}>
            {t('switch.startExitedShort')}
          </Button>
          <Popover
            align="right"
            side="top"
            panelClassName="w-80"
            trigger={({ toggle }) => (
              <Button size="sm" onClick={toggle}>
                {t('cockpit.pane.replace')}
              </Button>
            )}
          >
            {(close) => (
              <AgentPickerList
                onPick={(r) => {
                  close();
                  onPick(r);
                }}
              />
            )}
          </Popover>
        </div>
      )}
    </div>
  );
}

function BoardView() {
  const data = useCockpit();
  return (
    <div className="absolute inset-0 flex flex-col gap-2 overflow-hidden p-2">
      {data.workspace && <AutomationBar workspace={data.workspace} tasks={data.tasks} compact />}
      <div className="min-h-0 flex-1">
        <TaskBoard tasks={data.tasks} allTasks={data.tasks} workspaceId={data.workspace?.id} compact showWorkspace={!data.workspace} />
      </div>
    </div>
  );
}

function EmptyView({ onPick }: { onPick: (r: PickResult) => void }) {
  const t = useT();
  return (
    <div className="absolute inset-0 overflow-y-auto p-4">
      <div className="mx-auto max-w-sm">
        <h3 className="text-sm font-semibold text-fg">{t('cockpit.empty.title')}</h3>
        <p className="mt-0.5 mb-3 text-xs text-fg-muted">{t('cockpit.empty.text')}</p>
        <AgentPickerList onPick={onPick} limit={8} />
      </div>
    </div>
  );
}

function Placeholder({ icon, title, children }: { icon: ReactNode; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center overflow-y-auto p-4 text-center text-sm text-fg-muted">
      <div className="mb-2 rounded-full bg-surface-2 p-2.5 text-fg-subtle">{icon}</div>
      <div className="font-medium text-fg">{title}</div>
      <div className="mt-1 flex w-full flex-col items-center text-xs">{children}</div>
    </div>
  );
}
