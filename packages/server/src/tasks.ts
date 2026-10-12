import { localize, type Agent, type Language, type MethodParams, type Task, type TaskStatus, type WorkflowStage, type Workspace } from '@cocoon/protocol';
import type { AgentManager } from './agents/manager.ts';
import { CocoonError, notFound } from './errors.ts';
import type { EventBus } from './events.ts';
import { currentLanguage, isMessageKey, t, type MessageKey } from './i18n.ts';
import { newId } from './ids.ts';
import type { Notifier } from './notifications.ts';
import type { SandboxManager } from './sandbox/manager.ts';
import type { WorkspaceService as FilesService } from './sandbox/workspace.ts';
import type { SettingsService } from './settings.ts';
import type { Store } from './store.ts';
import { applyPatch, type WorkspaceService } from './workspaces.ts';

const SCHEDULE_INTERVAL_MS = 5000;
const PREVIOUS_OUTPUT_LINES = 80;
const PRIORITY_RANK = { high: 0, normal: 1, low: 2 } as const;

/**
 * Task orchestration: runs tasks as (multi-stage) agents, follows agent status into the task lifecycle
 * (backlog → queued → running → review → done | failed), handles review feedback and auto-runs queued tasks
 * within each workspace's parallelism limit once their dependencies are done.
 */
export class TaskService {
  private timer?: NodeJS.Timeout;
  /** Agents stopped on purpose – their exit must not mark the task as failed. */
  private readonly stopping = new Set<string>();
  private scheduling = false;

  constructor(
    private readonly store: Store,
    private readonly bus: EventBus,
    private readonly settings: SettingsService,
    private readonly workspaces: WorkspaceService,
    private readonly sandboxes: SandboxManager,
    private readonly files: FilesService,
    private readonly agents: AgentManager,
    private readonly notifier: Notifier,
    private readonly log: (msg: string, err?: unknown) => void,
  ) {
    bus.subscribe((event) => {
      if (event.type === 'agent.updated') void this.onAgentUpdated(event.agent);
      if (event.type === 'workspace.updated') void this.schedule();
    });
  }

  // ── queries ────────────────────────────────────────────────────────────────

  /** Tasks with notes in the language of the current request. */
  list(workspaceId?: string): Task[] {
    return this.records(workspaceId).map((task) => localizeTask(task, currentLanguage()));
  }

  get(id: string): Task {
    return localizeTask(this.record(id), currentLanguage());
  }

  private records(workspaceId?: string): Task[] {
    return this.store
      .tasks()
      .filter((task) => !workspaceId || task.workspaceId === workspaceId)
      .sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt));
  }

  private record(id: string): Task {
    const task = this.store.task(id);
    if (!task) throw notFound('Task', id);
    return localizeTask(task, currentLanguage());
  }

  // ── commands ───────────────────────────────────────────────────────────────

  create(params: MethodParams<'task.create'>): Task {
    const workspace = this.workspaces.get(params.workspaceId);
    this.validate(workspace, params);
    const now = new Date().toISOString();
    const status = params.status ?? 'backlog';
    // A deleted default workflow must not break new tasks: fall back to the default agent type.
    const defaultWorkflow = workspace.defaultWorkflowId && this.settings.get().workflows[workspace.defaultWorkflowId] ? workspace.defaultWorkflowId : undefined;
    const task: Task = {
      id: newId('ts'),
      workspaceId: workspace.id,
      title: params.title,
      description: params.description ?? '',
      status,
      priority: params.priority ?? 'normal',
      order: this.nextOrder(workspace.id, status),
      agentKind: params.agentKind ?? (params.workflowId || defaultWorkflow ? undefined : workspace.defaultAgentKind),
      workflowId: params.workflowId || (params.agentKind ? undefined : defaultWorkflow),
      providers: params.providers,
      model: params.model || undefined,
      dependsOn: params.dependsOn ?? [],
      sandboxId: params.sandboxId || undefined,
      stage: 0,
      runs: [],
      attention: false,
      createdAt: now,
      updatedAt: now,
    };
    this.save(task);
    if (status === 'queued') void this.schedule();
    return localizeTask(task, currentLanguage());
  }

  update({ taskId, ...patch }: MethodParams<'task.update'>): Task {
    const task = this.record(taskId);
    const workspace = this.workspaces.get(task.workspaceId);
    this.validate(workspace, { ...patch, taskId });
    const { status, ...fields } = patch;
    Object.assign(task, applyPatch(task, fields));
    for (const key of ['workflowId', 'model', 'sandboxId'] as const) if (fields[key] === null || fields[key] === '') delete task[key];
    if (patch.workflowId) task.agentKind = undefined;
    else if (patch.agentKind) task.workflowId = undefined;
    if (!task.workflowId && !task.agentKind) task.agentKind = workspace.defaultAgentKind;

    if (status && status !== task.status) {
      if (status === 'running' || status === 'review') throw new CocoonError('bad_request', t('error.taskUseStart'));
      if (task.status === 'running') this.stopAgent(task);
      task.status = status;
      task.attention = false;
      if (status === 'backlog' || status === 'queued') {
        // Moving back means starting over with the first stage next time.
        task.stage = 0;
        clearNote(task);
      }
      if (patch.order === undefined) task.order = this.nextOrder(task.workspaceId, status);
    }
    this.save(task);
    void this.schedule();
    return localizeTask(task, currentLanguage());
  }

  async delete(taskId: string): Promise<void> {
    const task = this.record(taskId);
    if (task.status === 'running') this.stopAgent(task);
    this.store.deleteTask(taskId);
    for (const other of this.store.tasks()) {
      if (other.dependsOn.includes(taskId)) {
        other.dependsOn = other.dependsOn.filter((id) => id !== taskId);
        this.save(other);
      }
    }
    this.bus.publish({ type: 'task.deleted', taskId, workspaceId: task.workspaceId });
  }

  start(taskId: string): Task {
    const task = this.record(taskId);
    if (task.status === 'running') throw new CocoonError('conflict', t('error.taskRunning', { title: task.title }));
    const open = task.dependsOn.map((id) => this.store.task(id)).filter((dep): dep is Task => !!dep && dep.status !== 'done');
    if (open.length) throw new CocoonError('conflict', t('error.taskDependencies', { titles: open.map((d) => `„${d.title}“`).join(', ') }));
    if (task.status === 'done' || task.status === 'failed') task.stage = 0;
    this.launch(task);
    return localizeTask(task, currentLanguage());
  }

  approve(taskId: string): Task {
    const task = this.record(taskId);
    if (task.status !== 'review') throw new CocoonError('conflict', t('error.taskNotInReview', { title: task.title }));
    const stages = this.stages(task);
    if (task.stage < stages.length - 1) {
      task.stage += 1;
      this.launch(task);
    } else {
      task.status = 'done';
      task.attention = false;
      clearNote(task);
      task.order = this.nextOrder(task.workspaceId, 'done');
      this.save(task);
      this.notifier.notify('task.done', 'notify.taskDone', { title: task.title }, `/tasks?task=${task.id}`);
      void this.schedule();
    }
    return localizeTask(task, currentLanguage());
  }

  async reject(taskId: string, feedback: string): Promise<Task> {
    const task = this.record(taskId);
    if (task.status !== 'review' && task.status !== 'running') {
      throw new CocoonError('conflict', t('error.taskNotInReview', { title: task.title }));
    }
    const agent = task.agentId ? this.store.agent(task.agentId) : undefined;
    if (agent && agent.status !== 'exited') {
      // The agent is still there: continue the conversation with the feedback.
      await this.agents.sendInput({ agentId: agent.id, text: feedback, submit: true });
      const run = task.runs.at(-1);
      if (run) {
        run.outcome = 'running';
        run.finishedAt = undefined;
      }
      task.status = 'running';
      task.attention = false;
      clearNote(task);
      this.save(task);
    } else {
      this.launch(task, feedback);
    }
    return localizeTask(task, currentLanguage());
  }

  stop(taskId: string): Task {
    const task = this.record(taskId);
    if (task.status === 'running') this.stopAgent(task);
    task.status = 'backlog';
    task.stage = 0;
    task.attention = false;
    clearNote(task);
    task.order = this.nextOrder(task.workspaceId, 'backlog');
    this.save(task);
    void this.schedule();
    return localizeTask(task, currentLanguage());
  }

  /** An agent was replaced (agent.switch): a running task follows the new agent. */
  adoptAgent(previousAgentId: string, next: Agent): void {
    const task = this.store.tasks().find((candidate) => candidate.agentId === previousAgentId && candidate.status === 'running');
    if (!task) return;
    const run = task.runs.at(-1);
    if (run?.outcome === 'running') {
      run.outcome = 'stopped';
      run.finishedAt = new Date().toISOString();
    }
    task.agentId = next.id;
    task.runs.push({ stage: task.stage, stageName: next.kind, agentId: next.id, startedAt: new Date().toISOString(), outcome: 'running' });
    task.attention = false;
    this.save(task);
  }

  /** Workspace deletion: stop all agents of its tasks (the store removes the tasks). */
  stopWorkspace(workspaceId: string): void {
    for (const task of this.records(workspaceId)) if (task.status === 'running') this.stopAgent(task);
  }

  // ── engine ─────────────────────────────────────────────────────────────────

  startEngine(): void {
    // Catch up with agents that changed (or tasks interrupted) while the server was down.
    for (const task of this.store.tasks()) {
      if (task.status !== 'running') continue;
      const agent = task.agentId ? this.store.agent(task.agentId) : undefined;
      const runActive = task.runs.at(-1)?.agentId === task.agentId && task.runs.at(-1)?.outcome === 'running';
      if (!agent || !runActive) this.fail(task, 'note.interrupted');
      else void this.onAgentUpdated(agent);
    }
    this.timer = setInterval(() => void this.schedule(), SCHEDULE_INTERVAL_MS);
    void this.schedule();
  }

  stopEngine(): void {
    clearInterval(this.timer);
  }

  /** Follows the current agent of a running task into the task lifecycle. */
  private async onAgentUpdated(agent: Agent): Promise<void> {
    const task = this.store.tasks().find((candidate) => candidate.agentId === agent.id && candidate.status === 'running');
    if (!task || task.runs.at(-1)?.outcome !== 'running') return;

    const attention = agent.status === 'blocked';
    if (attention !== task.attention) {
      task.attention = attention;
      this.save(task);
    }

    if (agent.status === 'done' || (agent.status === 'exited' && agent.exitCode === 0)) {
      this.finishStage(task);
    } else if (agent.status === 'exited') {
      if (this.stopping.delete(agent.id)) return;
      if (agent.exitCode === null) this.fail(task, 'note.agentGone');
      else this.fail(task, 'note.exitCode', { code: agent.exitCode });
    }
  }

  private finishStage(task: Task): void {
    const run = task.runs.at(-1);
    if (run) {
      run.outcome = 'finished';
      run.finishedAt = new Date().toISOString();
    }
    const stages = this.stages(task);
    const stage = stages[task.stage];
    const last = task.stage >= stages.length - 1;
    if (!last && stage && !stage.approval) {
      task.stage += 1;
      this.launch(task);
      return;
    }
    task.status = 'review';
    task.attention = false;
    clearNote(task);
    task.order = this.nextOrder(task.workspaceId, 'review');
    this.save(task);
    this.notifier.notify('task.review', 'notify.taskReview', { title: task.title }, `/tasks?task=${task.id}`);
  }

  private fail(task: Task, key: MessageKey, params: Record<string, string | number> = {}): void {
    const run = task.runs.at(-1);
    if (run?.outcome === 'running') {
      run.outcome = 'failed';
      run.finishedAt = new Date().toISOString();
    }
    task.status = 'failed';
    task.attention = false;
    setNote(task, key, params);
    task.order = this.nextOrder(task.workspaceId, 'failed');
    this.save(task);
    const lang = this.settings.get().general.language;
    this.notifier.notify('task.failed', 'notify.taskFailed', { title: task.title, note: t(key, params, lang) }, `/tasks?task=${task.id}`);
    void this.schedule();
  }

  /** Marks the task running right away and does the slow part (sandbox, agent) in the background. */
  private launch(task: Task, feedback?: string): void {
    const stage = this.stages(task)[task.stage];
    if (!stage) throw new CocoonError('bad_request', t('error.unknownWorkflow', { id: task.workflowId ?? '' }));
    const lang = currentLanguage();
    task.status = 'running';
    task.attention = false;
    if (task.sandboxId) setNote(task, 'note.startingStage', { stage: localize(stage.name, lang) ?? '' });
    else setNote(task, 'note.preparingSandbox');
    task.order = this.nextOrder(task.workspaceId, 'running');
    this.save(task);

    void (async () => {
      try {
        const previousAgentId = task.runs.at(-1)?.agentId;
        const sandboxId = await this.ensureSandbox(task);
        const prompt = await this.renderPrompt(stage, task, sandboxId, previousAgentId, feedback);
        const agent = await this.agents.spawn({
          sandboxId,
          kind: stage.agentKind,
          prompt,
          providers: task.providers,
          model: task.model,
        });
        const current = this.store.task(task.id);
        if (!current || current.status !== 'running') {
          // Stopped or deleted while starting.
          this.stopping.add(agent.id);
          await this.agents.kill(agent.id).catch(() => undefined);
          return;
        }
        current.agentId = agent.id;
        clearNote(current);
        current.runs.push({
          stage: current.stage,
          stageName: localize(stage.name, lang) ?? '',
          agentId: agent.id,
          startedAt: new Date().toISOString(),
          outcome: 'running',
        });
        this.save(current);
      } catch (err) {
        const current = this.store.task(task.id);
        if (current?.status === 'running') this.fail(current, 'note.failed', { error: (err as Error).message });
      }
    })();
  }

  /** Sandbox for the task: its own, the workspace's shared one, or a fresh one (repo/network from the workspace). */
  private async ensureSandbox(task: Task): Promise<string> {
    const workspace = this.workspaces.get(task.workspaceId);
    const usable = async (id: string | undefined) => {
      const record = id ? this.store.sandbox(id) : undefined;
      if (!record || record.status === 'error' || record.status === 'missing' || record.status === 'creating') return undefined;
      if (record.status === 'stopped') await this.sandboxes.start(record.id);
      return record.id;
    };

    const own = await usable(task.sandboxId);
    if (own) return own;
    if (workspace.sandboxMode === 'shared') {
      const shared = await usable(workspace.sharedSandboxId);
      if (shared) return this.assignSandbox(task, shared);
      const created = await this.createSandbox(workspace, `${slug(workspace.name)}-shared`);
      this.workspaces.update({ workspaceId: workspace.id, sharedSandboxId: created });
      return this.assignSandbox(task, created);
    }
    return this.assignSandbox(task, await this.createSandbox(workspace, slug(task.title), task.id));
  }

  private async createSandbox(workspace: Workspace, baseName: string, taskId?: string): Promise<string> {
    const sandbox = await this.sandboxes.create(
      {
        name: `${baseName}-${Math.random().toString(16).slice(2, 6)}`,
        workspaceId: workspace.id,
        ...(workspace.repos?.length ? { repos: workspace.repos } : { repo: workspace.repo }),
        network: workspace.network,
      },
      { taskId },
    );
    return sandbox.id;
  }

  private assignSandbox(task: Task, sandboxId: string): string {
    const current = this.store.task(task.id);
    if (current) {
      current.sandboxId = sandboxId;
      clearNote(current);
      this.save(current);
    }
    task.sandboxId = sandboxId;
    return sandboxId;
  }

  private async renderPrompt(stage: WorkflowStage, task: Task, sandboxId: string, previousAgentId: string | undefined, feedback?: string): Promise<string> {
    const needs = (name: string) => stage.prompt.includes(`{{${name}}}`);
    const previous = needs('previous.output') && previousAgentId ? await this.agents.read(previousAgentId, PREVIOUS_OUTPUT_LINES).catch(() => '') : '';
    const diff = needs('diff') ? await this.files.diff(sandboxId).then((d) => d.files.join(', ') || '—').catch(() => '—') : '';
    const values: Record<string, string> = {
      'task': task.description ? `${task.title}\n\n${task.description}` : task.title,
      'task.title': task.title,
      'task.description': task.description,
      'previous.output': previous.trim(),
      'diff': diff,
      'feedback': feedback ? `\n\nReview feedback:\n${feedback}` : '',
    };
    let prompt = stage.prompt.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, name: string) => values[name] ?? match);
    // Feedback must reach the agent even if the template has no {{feedback}} placeholder.
    if (feedback && !needs('feedback')) prompt += values.feedback;
    return prompt;
  }

  /** Starts queued tasks whose dependencies are done, up to each auto-run workspace's maxParallel. */
  private async schedule(): Promise<void> {
    if (this.scheduling) return;
    this.scheduling = true;
    try {
      for (const workspace of this.workspaces.list()) {
        if (!workspace.autoRun) continue;
        const tasks = this.records(workspace.id);
        let capacity = workspace.maxParallel - tasks.filter((task) => task.status === 'running').length;
        const ready = tasks
          .filter((task) => task.status === 'queued')
          .filter((task) => task.dependsOn.every((id) => this.store.task(id)?.status === 'done' || !this.store.task(id)))
          .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.order - b.order);
        for (const task of ready) {
          if (capacity <= 0) break;
          try {
            this.launch(task);
            capacity -= 1;
          } catch (err) {
            this.fail(task, 'note.failed', { error: (err as Error).message });
          }
        }
      }
    } catch (err) {
      this.log('task scheduling failed', err);
    } finally {
      this.scheduling = false;
    }
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private stages(task: Task): WorkflowStage[] {
    if (task.workflowId) {
      const workflow = this.settings.get().workflows[task.workflowId];
      if (!workflow) throw new CocoonError('bad_request', t('error.unknownWorkflow', { id: task.workflowId }));
      return workflow.stages;
    }
    const kind = task.agentKind ?? this.workspaces.get(task.workspaceId).defaultAgentKind;
    const profile = this.settings.get().agents[kind];
    const label = localize(profile?.label, currentLanguage()) ?? kind;
    // Shell-like agents execute what they get: only send the description (the command), not the title.
    const shellLike = profile?.promptMode === 'input' && !profile.hooks;
    const prompt = shellLike ? (task.description ? '{{task.description}}' : '{{task.title}}') : '{{task}}{{feedback}}';
    return [{ name: label, agentKind: kind, prompt, approval: false }];
  }

  private validate(workspace: Workspace, params: { workflowId?: string | null; dependsOn?: string[]; taskId?: string }): void {
    if (params.workflowId && !this.settings.get().workflows[params.workflowId]) {
      throw new CocoonError('bad_request', t('error.unknownWorkflow', { id: params.workflowId }));
    }
    for (const id of params.dependsOn ?? []) {
      if (id === params.taskId || this.store.task(id)?.workspaceId !== workspace.id) {
        throw new CocoonError('bad_request', t('error.unknownDependency', { id }));
      }
    }
  }

  private stopAgent(task: Task): void {
    const run = task.runs.at(-1);
    if (run?.outcome === 'running') {
      run.outcome = 'stopped';
      run.finishedAt = new Date().toISOString();
    }
    const agent = task.agentId ? this.store.agent(task.agentId) : undefined;
    if (agent && agent.status !== 'exited') {
      this.stopping.add(agent.id);
      void this.agents.kill(agent.id).catch((err) => this.log(`stopping agent ${agent.id} failed`, err));
    }
  }

  private nextOrder(workspaceId: string, status: TaskStatus): number {
    const orders = this.store.tasks().filter((task) => task.workspaceId === workspaceId && task.status === status).map((task) => task.order);
    return orders.length ? Math.max(...orders) + 1 : 0;
  }

  private save(task: Task): void {
    task.updatedAt = new Date().toISOString();
    this.store.putTask(task);
    this.bus.publish({ type: 'task.updated', task: { ...task, runs: [...task.runs] } });
  }
}

/** Sandbox-name-safe slug, e.g. "Fix login bug!" → "fix-login-bug". */
function slug(text: string): string {
  const base = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
  return base || 'task';
}

function setNote(task: Task, key: MessageKey, params: Record<string, string | number> = {}): void {
  task.noteKey = key;
  task.noteParams = params;
  task.note = t(key, params);
}

function clearNote(task: Task): void {
  task.note = undefined;
  task.noteKey = undefined;
  task.noteParams = undefined;
}

/** Renders the task note in the given language. */
export function localizeTask(task: Task, lang: Language): Task {
  const note = task.noteKey && isMessageKey(task.noteKey) ? t(task.noteKey, task.noteParams, lang) : task.note;
  return { ...task, runs: [...task.runs], note };
}
