import type { ActivityEntry, AgentStatus, CocoonEvent, Language, SandboxStatus, TaskStatus } from '@cocoon/protocol';
import type { EventBus } from './events.ts';
import { isMessageKey, t, type MessageKey } from './i18n.ts';

const MAX_ENTRIES = 500;

type Level = ActivityEntry['level'];
type Params = Record<string, string | number>;

const agentMessages: Partial<Record<AgentStatus, [Level, MessageKey]>> = {
  working: ['info', 'activity.agentWorking'],
  blocked: ['warn', 'activity.agentBlocked'],
  done: ['info', 'activity.agentDone'],
  exited: ['info', 'activity.agentExited'],
};

const sandboxMessages: Partial<Record<SandboxStatus, [Level, MessageKey]>> = {
  creating: ['info', 'activity.sandboxCreating'],
  running: ['info', 'activity.sandboxRunning'],
  stopped: ['info', 'activity.sandboxStopped'],
  error: ['error', 'activity.sandboxError'],
  missing: ['warn', 'activity.sandboxMissing'],
};

const taskMessages: Partial<Record<TaskStatus, [Level, MessageKey]>> = {
  running: ['info', 'activity.taskRunning'],
  review: ['warn', 'activity.taskReview'],
  done: ['info', 'activity.taskDone'],
  failed: ['error', 'activity.taskFailed'],
};

/** Renders an entry's message in the given language (entries store a message key + params). */
export function localizeEntry(entry: ActivityEntry, lang: Language): ActivityEntry {
  return entry.key && isMessageKey(entry.key) ? { ...entry, message: t(entry.key, entry.params, lang) } : entry;
}

/** Human-readable activity log, derived from events plus explicit entries. */
export class ActivityLog {
  private readonly entries: ActivityEntry[] = [];
  private nextId = 1;
  private readonly lastAgentStatus = new Map<string, AgentStatus>();
  private readonly lastSandboxStatus = new Map<string, SandboxStatus>();
  private readonly lastTaskStatus = new Map<string, TaskStatus>();

  constructor(private readonly bus: EventBus) {
    bus.subscribe((event) => this.derive(event));
  }

  add(level: Level, key: MessageKey, params: Params = {}, refs: { sandboxId?: string; agentId?: string } = {}): void {
    const entry: ActivityEntry = { id: this.nextId++, at: new Date().toISOString(), level, key, params, message: t(key, params), ...refs };
    this.entries.unshift(entry);
    this.entries.length = Math.min(this.entries.length, MAX_ENTRIES);
    this.bus.publish({ type: 'activity', entry });
  }

  list(limit: number, lang: Language): ActivityEntry[] {
    return this.entries.slice(0, limit).map((entry) => localizeEntry(entry, lang));
  }

  private derive(event: CocoonEvent): void {
    switch (event.type) {
      case 'agent.updated': {
        const { agent } = event;
        if (this.lastAgentStatus.get(agent.id) === agent.status) return;
        const first = !this.lastAgentStatus.has(agent.id);
        this.lastAgentStatus.set(agent.id, agent.status);
        const params = { kind: agent.kind, id: agent.id };
        const refs = { sandboxId: agent.sandboxId, agentId: agent.id };
        if (first) return this.add('info', 'activity.agentStarted', params, refs);
        if (agent.status === 'exited' && agent.exitCode) {
          return this.add('info', 'activity.agentExitedCode', { ...params, code: agent.exitCode }, refs);
        }
        const msg = agentMessages[agent.status];
        if (msg) this.add(msg[0], msg[1], params, refs);
        return;
      }
      case 'sandbox.updated': {
        const { sandbox } = event;
        if (this.lastSandboxStatus.get(sandbox.id) === sandbox.status) return;
        this.lastSandboxStatus.set(sandbox.id, sandbox.status);
        const msg = sandboxMessages[sandbox.status];
        if (msg) this.add(msg[0], msg[1], { name: sandbox.name, error: sandbox.error ?? '' }, { sandboxId: sandbox.id });
        return;
      }
      case 'agent.removed':
        this.lastAgentStatus.delete(event.agentId);
        return;
      case 'sandbox.deleted':
        this.lastSandboxStatus.delete(event.sandboxId);
        this.add('info', 'activity.sandboxDeleted', { id: event.sandboxId }, { sandboxId: event.sandboxId });
        return;
      case 'task.deleted':
        this.lastTaskStatus.delete(event.taskId);
        return;
      case 'task.updated': {
        const { task } = event;
        const previous = this.lastTaskStatus.get(task.id);
        if (previous === task.status) return;
        this.lastTaskStatus.set(task.id, task.status);
        const refs = { sandboxId: task.sandboxId, agentId: task.agentId };
        if (previous === undefined && task.runs.length === 0 && (task.status === 'backlog' || task.status === 'queued')) {
          return this.add('info', 'activity.taskCreated', { title: task.title }, refs);
        }
        const msg = taskMessages[task.status];
        if (msg) this.add(msg[0], msg[1], { title: task.title, note: task.note ?? '' }, refs);
        return;
      }
      case 'image.build':
        if (event.status === 'succeeded') this.add('info', 'activity.imageBuilt', { kind: event.kind });
        if (event.status === 'failed') this.add('error', 'activity.imageFailed', { kind: event.kind, error: event.error ?? '' });
        return;
      default:
        return;
    }
  }
}
