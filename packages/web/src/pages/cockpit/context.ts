import { createContext, useContext, useMemo } from 'react';
import type { Agent, Sandbox, Task, Workspace } from '@cocoon/protocol';
import { useAgents, useSandboxes, useTasks, useWorkspaces } from '../../api/queries';
import { AGENT_STATUS_ORDER } from '../../lib/status';
import { agentInScope, sandboxInScope, taskInScope, type WorkspaceScope } from '../../lib/workspace';

/** Live data of the cockpit, indexed for fast lookups by panes and the rail. */
export interface CockpitData {
  scope: WorkspaceScope;
  workspace?: Workspace;
  workspaces: Workspace[];
  agents: Agent[];
  sandboxes: Sandbox[];
  tasks: Task[];
  agentById: Map<string, Agent>;
  sandboxById: Map<string, Sandbox>;
  /** Task an agent works (or worked) for. */
  taskByAgent: Map<string, Task>;
  /** Agents in scope that are still running (not exited), attention first. */
  liveAgents: Agent[];
  loaded: boolean;
}

export function useCockpitData(scope: WorkspaceScope, workspace: Workspace | undefined): CockpitData {
  const agents = useAgents();
  const sandboxes = useSandboxes();
  const tasks = useTasks();
  const workspaces = useWorkspaces();
  return useMemo(() => {
    const sbAll = sandboxes.data ?? [];
    const sbs = sbAll.filter((s) => sandboxInScope(s, scope));
    const ags = (agents.data ?? []).filter((a) => agentInScope(a, sbAll, scope));
    const ts = (tasks.data ?? []).filter((x) => taskInScope(x, scope));
    const taskByAgent = new Map<string, Task>();
    for (const task of tasks.data ?? []) {
      for (const r of task.runs) taskByAgent.set(r.agentId, task);
      if (task.agentId) taskByAgent.set(task.agentId, task);
    }
    const liveAgents = ags
      .filter((a) => a.status !== 'exited')
      .sort((a, b) => (AGENT_STATUS_ORDER[a.status] ?? 9) - (AGENT_STATUS_ORDER[b.status] ?? 9) || a.createdAt.localeCompare(b.createdAt));
    return {
      scope,
      workspace,
      workspaces: workspaces.data ?? [],
      agents: ags,
      sandboxes: sbs,
      tasks: ts,
      agentById: new Map((agents.data ?? []).map((a) => [a.id, a])),
      sandboxById: new Map(sbAll.map((s) => [s.id, s])),
      taskByAgent,
      liveAgents,
      loaded: agents.isSuccess && sandboxes.isSuccess,
    };
  }, [agents.data, sandboxes.data, tasks.data, workspaces.data, scope, workspace, agents.isSuccess, sandboxes.isSuccess]);
}

export interface CockpitActions {
  /** Shows an agent: focuses its pane if visible, otherwise puts it into the focused (or an empty) pane. */
  focusAgent: (agentId: string) => void;
  /** Agent ids currently shown in a pane. */
  shownAgents: Set<string>;
}

export const CockpitDataContext = createContext<CockpitData | null>(null);
export const CockpitActionsContext = createContext<CockpitActions>({ focusAgent: () => {}, shownAgents: new Set() });

export function useCockpit(): CockpitData {
  const ctx = useContext(CockpitDataContext);
  if (!ctx) throw new Error('useCockpit outside cockpit');
  return ctx;
}

export const useCockpitActions = () => useContext(CockpitActionsContext);

export type AttentionItem =
  | { kind: 'agent'; id: string; agent: Agent; task?: Task; since: string }
  | { kind: 'review'; id: string; task: Task; agent?: Agent; since: string };

/** Everything waiting for a human in scope: blocked agents (oldest first), then tasks in review. */
export function attentionItems(d: CockpitData): AttentionItem[] {
  const items: AttentionItem[] = [];
  const seen = new Set<string>();
  for (const a of d.agents) {
    if (a.status !== 'blocked') continue;
    seen.add(a.id);
    items.push({ kind: 'agent', id: `a:${a.id}`, agent: a, task: d.taskByAgent.get(a.id), since: a.statusChangedAt });
  }
  for (const task of d.tasks) {
    if (task.status === 'running' && task.attention && task.agentId && !seen.has(task.agentId)) {
      const agent = d.agentById.get(task.agentId);
      if (agent) items.push({ kind: 'agent', id: `a:${agent.id}`, agent, task, since: task.updatedAt });
    }
  }
  items.sort((a, b) => a.since.localeCompare(b.since));
  const reviews = d.tasks
    .filter((x) => x.status === 'review')
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
    .map<AttentionItem>((task) => ({ kind: 'review', id: `t:${task.id}`, task, agent: task.agentId ? d.agentById.get(task.agentId) : undefined, since: task.updatedAt }));
  return [...items, ...reviews];
}
