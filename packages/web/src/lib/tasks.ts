import { localize, type Language, type Settings, type Task, type TaskPriority, type TaskStatus, type Workflow } from '@cocoon/protocol';
import type { TFunction } from '../i18n';
import { profileLabel } from './profiles';
import type { Tone } from './status';

export const TASK_COLUMNS: TaskStatus[] = ['backlog', 'queued', 'running', 'review', 'done', 'failed'];

const TASK_TONE: Record<TaskStatus, { tone: Tone; animated?: boolean }> = {
  backlog: { tone: 'gray' },
  queued: { tone: 'accent' },
  running: { tone: 'blue', animated: true },
  review: { tone: 'amber' },
  done: { tone: 'green' },
  failed: { tone: 'red' },
};

export function taskStatusMeta(t: TFunction, status: TaskStatus): { label: string; tone: Tone; animated?: boolean; explanation: string } {
  const s = status in TASK_TONE ? status : 'backlog';
  return { ...TASK_TONE[s], label: t(`task.status.${s}`), explanation: t(`task.status.${s}.explanation`) };
}

export const PRIORITIES: TaskPriority[] = ['high', 'normal', 'low'];
export const PRIORITY_TONE: Record<TaskPriority, Tone> = { high: 'red', normal: 'gray', low: 'slate' };

export function workflowLabel(id: string, wf: Workflow | undefined, lang: Language): string {
  return localize(wf?.label, lang) || id;
}

export function stageLabel(wf: Workflow | undefined, stage: number, lang: Language): string {
  return localize(wf?.stages[stage]?.name, lang) || String(stage + 1);
}

/** "Claude Code" or "2/3 Build" – what a task runs with and where it stands. */
export function taskRunLabel(task: Task, settings: Settings | undefined, lang: Language): { kind: 'agent' | 'workflow'; label: string; stage?: string } {
  if (task.workflowId) {
    const wf = settings?.workflows[task.workflowId];
    const total = wf?.stages.length ?? 0;
    const stage = total ? `${Math.min(task.stage + 1, total)}/${total} ${stageLabel(wf, task.stage, lang)}` : undefined;
    return { kind: 'workflow', label: workflowLabel(task.workflowId, wf, lang), stage };
  }
  const kind = task.agentKind ?? 'claude-code';
  return { kind: 'agent', label: profileLabel(kind, settings?.agents[kind], lang) };
}

/** Dependencies that are not done yet (they keep the task from starting). */
export function openDependencies(task: Task, all: Task[] | undefined): Task[] {
  if (!task.dependsOn.length || !all) return [];
  return task.dependsOn.map((id) => all.find((x) => x.id === id)).filter((d): d is Task => !!d && d.status !== 'done');
}

export const sortByOrder = (a: Task, b: Task) => a.order - b.order || a.createdAt.localeCompare(b.createdAt);

/** Order value for inserting at `index` into a column (list sorted by order, without the moved task). */
export function orderAt(column: Task[], index: number): number {
  const before = column[index - 1];
  const after = column[index];
  if (!before && !after) return 1000;
  if (!before) return after!.order - 1000;
  if (!after) return before.order + 1000;
  return (before.order + after.order) / 2;
}

/** Smallest gap between two orders that still leaves room for a card (midpoints halve it with every insert). */
const MIN_ORDER_GAP = 1e-3;

/** Whether `orderAt(column, index)` still finds a value strictly between the neighbours. */
export function hasRoomAt(column: Task[], index: number): boolean {
  const before = column[index - 1];
  const after = column[index];
  return !before || !after || after.order - before.order > MIN_ORDER_GAP;
}

/** The column with evenly spaced orders (1000, 2000, …), for when repeated inserts used up the gaps. */
export function renumbered(column: Task[]): Task[] {
  return column.map((task, i) => ({ ...task, order: (i + 1) * 1000 }));
}

/** What dropping a task of status `from` onto column `to` does. */
export type MoveKind = 'reorder' | 'update' | 'start' | 'stop' | 'approve' | 'markFinished' | 'forbidden';

export function moveKind(from: TaskStatus, to: TaskStatus): MoveKind {
  if (from === to) return 'reorder';
  if (to === 'running') return from === 'backlog' || from === 'queued' || from === 'failed' ? 'start' : 'forbidden';
  if (from === 'running') return to === 'backlog' ? 'stop' : 'forbidden';
  if (to === 'review') return from === 'failed' ? 'markFinished' : 'forbidden';
  if (from === 'review' && to === 'done') return 'approve';
  return 'update';
}

/** Tasks needing a human: agent blocked, or result waiting for review. */
export const needsAttention = (task: Task): boolean => task.attention || task.status === 'review';
