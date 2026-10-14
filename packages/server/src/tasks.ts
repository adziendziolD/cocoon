import { GIT_CREDENTIAL_HELPER_SCRIPT } from './sandbox/git-auth.ts';
import { DEFAULT_REVIEW_PROMPT, localize, type Agent, type Language, type MethodParams, type ReviewResult, type Task, type TaskStatus, type WorkflowStage, type Workspace } from '@cocoon/protocol';
import type { AgentManager } from './agents/manager.ts';
import { CocoonError, notFound } from './errors.ts';
import type { EventBus } from './events.ts';
import { currentLanguage, isMessageKey, t, type MessageKey } from './i18n.ts';
import { newId } from './ids.ts';
import type { Notifier } from './notifications.ts';
import type { SecretsService } from './secrets.ts';
import { reposOf, type SandboxManager } from './sandbox/manager.ts';
import type { WorkspaceService as FilesService } from './sandbox/workspace.ts';
import type { SettingsService } from './settings.ts';
import type { Store } from './store.ts';
import { applyPatch, withHandle, type WorkspaceService } from './workspaces.ts';

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
    private readonly secrets?: SecretsService,
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
      number: this.workspaces.allocateTaskNumber(workspace.id),
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
      reviews: [],
      pullRequests: [],
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

  async approve(taskId: string): Promise<Task> {
    const task = this.record(taskId);
    if (task.status !== 'review') throw new CocoonError('conflict', t('error.taskNotInReview', { title: task.title }));
    const stages = this.stages(task);
    if (task.stage < stages.length - 1) {
      task.stage += 1;
      this.launch(task);
    } else if (this.reviewConfig(task) && task.reviewStep === undefined) {
      // Code review first; pushing and the pull request follow when all review agents approve.
      task.reviewStep = 0;
      task.reviews = [];
      this.launchReview(task);
    } else {
      // Fails (task stays in review) if the work cannot be pushed, e.g. without a GitHub token.
      const published = await this.publishOwnSandbox(task);
      this.stopTaskAgents(task);
      task.status = 'done';
      task.attention = false;
      if (published) setNote(task, published.key, published.params);
      else clearNote(task);
      task.order = this.nextOrder(task.workspaceId, 'done');
      this.save(task);
      this.notifier.notify('task.done', 'notify.taskDone', { title: task.title }, `/tasks?task=${task.id}`);
      void this.schedule();
    }
    return localizeTask(task, currentLanguage());
  }

  /**
   * A sandbox created for this task alone is done once the task is approved: commit everything, push it to a task branch
   * and remove the sandbox. Shared or hand-picked sandboxes and sandboxes without a repository stay untouched.
   */
  private async publishOwnSandbox(task: Task): Promise<{ key: MessageKey; params: Record<string, string> } | undefined> {
    const sandbox = task.sandboxId ? this.store.sandbox(task.sandboxId) : undefined;
    if (!sandbox || sandbox.taskId !== task.id || !reposOf(sandbox).length) return undefined;
    const branch = task.branch ?? `cocoon/${slug(task.title)}-${task.id.slice(-4)}`;
    if (sandbox.status !== 'running') await this.sandboxes.start(sandbox.id);
    let pushed: string[];
    try {
      ({ pushed } = await this.files.publish(sandbox.id, task.title, branch));
    } catch (err) {
      throw new CocoonError('bad_request', t('error.taskPublishFailed', { error: (err as Error).message }));
    }
    if (task.status === 'running' || task.agentId) this.stopAgent(task);
    await this.sandboxes.delete(sandbox.id);
    delete task.sandboxId;
    return pushed.length
      ? { key: 'note.published', params: { branch, repos: pushed.map((p) => p || '.').join(', ') } }
      : { key: 'note.publishedNothing', params: {} };
  }

  // ── code review ────────────────────────────────────────────────────────────

  private reviewConfig(task: Task) {
    const review = this.store.workspace(task.workspaceId)?.review;
    return review?.enabled && review.agentKinds.length ? review : undefined;
  }

  /**
   * Where review agent number `step` writes its verdict: inside the workspace folder (agents such as Claude Code may only
   * write there without asking), in .cocoon/ which is excluded from every repository, so it is never committed.
   */
  private reviewFile(task: Task, step: number): string {
    const workdir = (task.sandboxId && this.store.sandbox(task.sandboxId)?.workdir) || '/workspace';
    return `${workdir}/.cocoon/review/${task.id}-${step}.json`;
  }

  /** Starts review agent number task.reviewStep in the task's sandbox. */
  private launchReview(task: Task): void {
    const review = this.reviewConfig(task);
    const step = task.reviewStep ?? 0;
    const kind = review?.agentKinds[step];
    if (!review || !kind || !task.sandboxId) return void this.fail(task, 'note.reviewNoSandbox');
    const last = step === review.agentKinds.length - 1;
    task.status = 'running';
    task.attention = false;
    setNote(task, 'note.reviewing', { step: step + 1, total: review.agentKinds.length });
    task.order = this.nextOrder(task.workspaceId, 'running');
    this.save(task);

    void (async () => {
      try {
        const sandboxId = task.sandboxId!;
        const sandbox = this.store.sandbox(sandboxId);
        if (sandbox?.status === 'stopped') await this.sandboxes.start(sandboxId);
        const file = this.reviewFile(task, step);
        const pushes = review.agentPushes && last;
        const token = pushes ? this.secrets?.resolve('GITHUB_TOKEN') : undefined;
        if (pushes && !token) {
          // Do not let the agent find out the hard way: it was supposed to push, but there is nothing to push with.
          const current = this.store.task(task.id);
          if (!current) return;
          current.reviewStep = undefined;
          current.stage = this.stages(current).length - 1;
          current.status = 'review';
          setNote(current, 'note.reviewNoToken');
          current.order = this.nextOrder(current.workspaceId, 'review');
          this.save(current);
          return;
        }
        // Fresh verdict file; .cocoon/ stays out of every repository (also the workspace folder's own one).
        await this.sandboxes.sh(
          sandboxId,
          `mkdir -p "$(dirname "$FILE")" && rm -f "$FILE"
           for d in "$WORKDIR" "$WORKDIR"/*/; do
             [ -d "$d/.git" ] || continue
             grep -qxF '/.cocoon/' "$d/.git/info/exclude" 2>/dev/null || echo '/.cocoon/' >> "$d/.git/info/exclude"
           done
           ${GIT_CREDENTIAL_HELPER_SCRIPT}`,
          { FILE: file, WORKDIR: sandbox?.workdir ?? '/workspace' },
        );
        const stage: WorkflowStage = {
          name: { de: 'Code-Review', en: 'Code review' },
          agentKind: kind,
          prompt: `${review.prompt?.trim() || DEFAULT_REVIEW_PROMPT}\n\n${reviewResultInstructions(file, last && Boolean(token), task, review.baseBranch)}`,
          approval: false,
        };
        const prompt = await this.renderPrompt(stage, task, sandboxId, task.agentId);
        const agent = await this.agents.spawn({
          sandboxId,
          kind,
          prompt,
          // Only the pushing reviewer gets the token; the others get it removed even if their agent type normally has it.
          env: token ? { GITHUB_TOKEN: token, GH_TOKEN: token } : { GITHUB_TOKEN: '', GH_TOKEN: '' },
        });
        const current = this.store.task(task.id);
        if (!current || current.status !== 'running' || current.reviewStep !== step) {
          this.stopping.add(agent.id);
          await this.agents.kill(agent.id).catch(() => undefined);
          return;
        }
        current.agentId = agent.id;
        current.runs.push({ stage: current.stage, stageName: localize(stage.name, currentLanguage()) ?? '', agentId: agent.id, startedAt: new Date().toISOString(), outcome: 'running' });
        this.save(current);
      } catch (err) {
        const current = this.store.task(task.id);
        if (current?.status === 'running') {
          current.reviewStep = undefined;
          this.fail(current, 'note.failed', { error: (err as Error).message });
        }
      }
    })();
  }

  /** A review agent is done: read its verdict, continue with the next reviewer, or publish. */
  private async finishReview(task: Task): Promise<void> {
    const review = this.reviewConfig(task);
    const step = task.reviewStep ?? 0;
    const agentId = task.agentId ?? '';
    const raw = task.sandboxId
      ? await this.sandboxes.sh(task.sandboxId, 'cat "$FILE" 2>/dev/null || true', { FILE: this.reviewFile(task, step) }).catch(() => '')
      : '';
    const result = parseVerdict(raw, agentId, review?.agentKinds[step] ?? '');
    const { pullRequest: _pr, ...stored } = result;
    task.reviews = [...(task.reviews ?? []).filter((r) => r.agentId !== agentId), stored];
    if (result.verdict !== 'approved') {
      // Back to the user: "Request changes" sends it to the working agent, "Approve" reviews again.
      task.reviewStep = undefined;
      task.stage = this.stages(task).length - 1;
      task.status = 'review';
      task.attention = false;
      setNote(task, result.verdict === 'missing' ? 'note.reviewNoResult' : 'note.reviewChanges', { summary: result.summary ?? '' });
      task.order = this.nextOrder(task.workspaceId, 'review');
      this.save(task);
      this.notifier.notify('task.review', 'notify.taskReview', { title: task.title }, `/tasks?task=${task.id}`);
      return;
    }
    if (review && step < review.agentKinds.length - 1) {
      task.reviewStep = step + 1;
      this.launchReview(task);
      return;
    }
    // All reviewers approved: push, open the pull request(s), clean up.
    task.reviewStep = undefined;
    try {
      const published = await this.publishReviewed(task, result.pullRequest);
      task.status = 'done';
      task.attention = false;
      setNote(task, published.key, published.params);
      task.order = this.nextOrder(task.workspaceId, 'done');
      this.save(task);
      this.notifier.notify('task.done', 'notify.taskDone', { title: task.title }, `/tasks?task=${task.id}`);
      void this.schedule();
    } catch (err) {
      task.stage = this.stages(task).length - 1;
      task.status = 'review';
      setNote(task, 'note.reviewPublishFailed', { error: (err as Error).message });
      task.order = this.nextOrder(task.workspaceId, 'review');
      this.save(task);
    }
  }

  /** After an approved review: commit + push the task branch, open a pull request per pushed repository, remove an own sandbox. */
  private async publishReviewed(task: Task, agentPullRequest?: string): Promise<{ key: MessageKey; params: Record<string, string> }> {
    const sandbox = task.sandboxId ? this.store.sandbox(task.sandboxId) : undefined;
    if (!sandbox || !task.branch) return { key: 'note.publishedNothing', params: {} };
    const workspace = this.store.workspace(task.workspaceId);
    const { pushed } = await this.files.publish(sandbox.id, `${task.handle ?? ''}: ${task.title}`.replace(/^: /, ''), task.branch);
    const body = [
      task.description,
      ...(task.reviews ?? []).map((r) => `**Review (${r.agentKind}):** ${r.summary ?? r.verdict}`),
      '',
      `_Created by CoCoon for task ${task.handle ?? task.id}._`,
    ]
      .filter((line, i) => line || i > 0)
      .join('\n\n');
    const prs: { repo: string; url: string }[] = [];
    for (const repo of pushed) {
      if (agentPullRequest && pushed.length === 1) {
        prs.push({ repo, url: agentPullRequest });
        continue;
      }
      const pr = await this.files.ensurePullRequest({
        sandboxId: sandbox.id,
        branch: task.branch,
        title: `${task.handle ? `${task.handle}: ` : ''}${task.title}`,
        body,
        base: workspace?.review?.baseBranch,
        repo,
      });
      if (pr) prs.push({ repo, url: pr.url });
    }
    task.pullRequests = prs;
    const own = sandbox.taskId === task.id;
    if (own) {
      this.stopAgent(task);
      await this.sandboxes.delete(sandbox.id);
      delete task.sandboxId;
    }
    if (!pushed.length) return { key: own ? 'note.publishedNothing' : 'note.reviewApprovedNothing', params: {} };
    if (!prs.length) return { key: own ? 'note.published' : 'note.reviewPushed', params: { branch: task.branch, repos: pushed.map((p) => p || '.').join(', ') } };
    return {
      key: own ? 'note.prOpenedRemoved' : 'note.prOpened',
      params: { branch: task.branch, urls: prs.map((p) => p.url).join(', ') },
    };
  }

  async reject(taskId: string, feedback: string): Promise<Task> {
    const task = this.record(taskId);
    if (task.status !== 'review' && task.status !== 'running') {
      throw new CocoonError('conflict', t('error.taskNotInReview', { title: task.title }));
    }
    if (task.reviewStep !== undefined) {
      // Feedback during the code review goes to the working agent, not the reviewer.
      if (task.status === 'running') this.stopAgent(task);
      task.reviewStep = undefined;
      task.stage = this.stages(task).length - 1;
      this.launch(task, feedback);
      return localizeTask(task, currentLanguage());
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
    task.reviewStep = undefined;
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
    if (task.reviewStep !== undefined) return void this.finishReview(task);
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
    task.reviewStep = undefined;
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
      // The shared sandbox, else one that already exists in the workspace (running first), else a new one.
      const existing = this.store
        .sandboxes()
        .filter((s) => s.workspaceId === workspace.id && !s.taskId && (s.status === 'running' || s.status === 'stopped'))
        .sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || b.createdAt.localeCompare(a.createdAt));
      const shared = (await usable(workspace.sharedSandboxId)) ?? (await usable(existing[0]?.id));
      if (shared) {
        if (shared !== workspace.sharedSandboxId) this.workspaces.update({ workspaceId: workspace.id, sharedSandboxId: shared });
        return this.assignSandbox(task, shared);
      }
      const created = await this.createSandbox(workspace, `${slug(workspace.name)}-shared`);
      this.workspaces.update({ workspaceId: workspace.id, sharedSandboxId: created });
      return this.assignSandbox(task, created);
    }
    const created = await this.createSandbox(workspace, slug(task.title), task.id);
    // A sandbox for this task alone works on the task branch from the start.
    if (task.branch) await this.files.checkoutBranch(created, task.branch).catch((err) => this.log(`checking out ${task.branch} failed`, err));
    return this.assignSandbox(task, created);
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
      'task.key': task.handle ?? task.title,
      'task.branch': task.branch ?? '',
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

  /** The task is finished and confirmed: no agent of any of its stages keeps running. */
  private stopTaskAgents(task: Task): void {
    for (const id of new Set([...task.runs.map((run) => run.agentId), ...(task.agentId ? [task.agentId] : [])])) {
      const agent = this.store.agent(id);
      if (!agent || agent.status === 'exited') continue;
      this.stopping.add(id);
      void this.agents.kill(id).catch((err) => this.log(`stopping agent ${id} failed`, err));
    }
  }

  private nextOrder(workspaceId: string, status: TaskStatus): number {
    const orders = this.store.tasks().filter((task) => task.workspaceId === workspaceId && task.status === status).map((task) => task.order);
    return orders.length ? Math.max(...orders) + 1 : 0;
  }

  private save(task: Task): void {
    const named = withHandle(task, this.store.workspace(task.workspaceId)?.key);
    task.handle = named.handle;
    task.branch = named.branch;
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
  // Tasks saved before reviews/pull requests existed have no such fields.
  return { ...task, runs: [...task.runs], reviews: task.reviews ?? [], pullRequests: task.pullRequests ?? [], note };
}


/** What a review agent has to do at the end: the verdict file, and pushing + the pull request when it may. */
function reviewResultInstructions(file: string, publish: boolean, task: Task, baseBranch: string | undefined): string {
  const base = baseBranch || "the repository's default branch";
  const lines = [
    'Commit the fixes you make yourself: `git add -A && git commit -m "Review fixes: <short summary>"` (in each repository folder you changed).',
    'When you are done, write your result as JSON to ' + file + ' (create the folder if needed; it is excluded from git):',
    '{"verdict": "approved" or "changes_requested", "summary": "a few sentences: what you checked, what you fixed, what still needs to change"}',
    'Use "changes_requested" if anything important is still wrong that you did not fix yourself.',
  ];
  if (publish) {
    lines.push(
      `If your verdict is "approved": commit all changes, push them with \`git push origin HEAD:${task.branch}\` and open a pull request from ${task.branch} into ${base}. ` +
        'Use the GitHub API with the token in $GITHUB_TOKEN (or `gh` if it is installed). Title: "' + `${task.handle ?? ''}: ${task.title}`.replace(/^: /, '') + '". ' +
        'Add the URL of the pull request to the JSON as "pullRequest". With several repositories, do it for each one that changed.',
    );
  } else {
    lines.push('Do not push and do not open a pull request – CoCoon does that after the review.');
  }
  return lines.join('\n');
}

/** Verdict JSON of a review agent; anything unreadable counts as "missing". */
export function parseVerdict(raw: string, agentId: string, agentKind: string): ReviewResult & { pullRequest?: string } {
  const at = new Date().toISOString();
  try {
    const json = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')) as { verdict?: unknown; summary?: unknown; pullRequest?: unknown };
    const verdict = json.verdict === 'approved' || json.verdict === 'changes_requested' ? json.verdict : 'missing';
    const summary = typeof json.summary === 'string' ? json.summary.slice(0, 4000) : undefined;
    const pullRequest = typeof json.pullRequest === 'string' && /^https:\/\//.test(json.pullRequest) ? json.pullRequest : undefined;
    return { agentId, agentKind, verdict, summary, at, ...(pullRequest ? { pullRequest } : {}) };
  } catch {
    return { agentId, agentKind, verdict: 'missing', at };
  }
}
