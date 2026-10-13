import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { profileAdapter, type Sandbox, type Task, type TaskPriority, type Workspace } from '@cocoon/protocol';
import { Bot, ChevronDown, ChevronRight, Lightbulb, ListPlus, Inbox, Search, Workflow as WorkflowIcon } from 'lucide-react';
import { useDefaultModels, useSandboxes, useSettings, useTasks, useWorkspaces } from '../../api/queries';
import { rpc } from '../../api/rpc';
import { useAction } from '../../api/useAction';
import { rich, useT } from '../../i18n';
import { cn } from '../../lib/cn';
import { PRIORITIES, sortByOrder } from '../../lib/tasks';
import { AgentTypeCards } from '../AgentTypeCards';
import { Button } from '../Button';
import { Dialog } from '../Dialog';
import { Checkbox, Field, Input, Select, Textarea } from '../Field';
import { Callout } from '../HelpText';
import { LoadingState } from '../States';
import { WorkspaceDot } from '../WorkspaceSwitcher';
import { PriorityIcon, TaskStatusBadge, WorkflowCards } from './TaskBits';
import { useStoreTask } from './useTaskActions';

interface Draft {
  workspaceId: string;
  title: string;
  description: string;
  priority: TaskPriority;
  mode: 'agent' | 'workflow';
  agentKind: string;
  workflowId: string;
  /** null = use the agent type's providers. */
  providers: string[] | null;
  model: string;
  dependsOn: string[];
  /** '' = a new sandbox for this task (or the workspace's shared one). */
  sandboxId: string;
}

/** Sandboxes of a workspace a task can work in (not the private sandbox of another task). */
function sandboxChoices(sandboxes: Sandbox[] | undefined, workspaceId: string, taskId?: string): Sandbox[] {
  return (sandboxes ?? [])
    .filter((s) => s.workspaceId === workspaceId && (s.status === 'running' || s.status === 'stopped') && (!s.taskId || s.taskId === taskId))
    .sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || b.createdAt.localeCompare(a.createdAt));
}

/** Preselection for a new task: a running sandbox of the workspace, unless every task gets its own on purpose (shared mode picks itself). */
function defaultSandbox(sandboxes: Sandbox[] | undefined, ws: Workspace | undefined): string {
  if (!ws || ws.sandboxMode === 'shared') return '';
  return sandboxChoices(sandboxes, ws.id).find((s) => s.status === 'running')?.id ?? '';
}

/**
 * Create a task (`task` omitted) or edit one. `workspaceId` preselects the workspace;
 * without it the user picks one. `initialStatus` decides the default submit button.
 */
export function TaskDialog({
  open,
  onClose,
  task,
  workspaceId,
  initialStatus = 'backlog',
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  task?: Task;
  workspaceId?: string;
  initialStatus?: 'backlog' | 'queued';
  onCreated?: (task: Task) => void;
}) {
  const t = useT();
  const settings = useSettings();
  const workspaces = useWorkspaces();
  const tasks = useTasks();
  const sandboxes = useSandboxes();
  const store = useStoreTask();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [tips, setTips] = useState(false);
  const [depFilter, setDepFilter] = useState('');

  const profiles = useMemo(() => Object.entries(settings.data?.agents ?? {}), [settings.data]);
  const workflows = useMemo(() => Object.entries(settings.data?.workflows ?? {}), [settings.data]);
  const allProviders = settings.data?.providers ?? {};

  useEffect(() => {
    if (!open || !settings.data) return;
    setAdvanced(!!task && (!!task.providers?.length || !!task.model));
    setDepFilter('');
    if (task) {
      setDraft({
        workspaceId: task.workspaceId,
        title: task.title,
        description: task.description,
        priority: task.priority,
        mode: task.workflowId ? 'workflow' : 'agent',
        agentKind: task.agentKind ?? 'claude-code',
        workflowId: task.workflowId ?? '',
        providers: task.providers ?? null,
        model: task.model ?? '',
        dependsOn: [...task.dependsOn],
        sandboxId: task.sandboxId ?? '',
      });
      return;
    }
    const wsId = workspaceId ?? (workspaces.data?.length === 1 ? workspaces.data[0]!.id : '');
    const ws = workspaces.data?.find((w) => w.id === wsId);
    const firstAgent = profiles.find(([k]) => k !== 'shell')?.[0] ?? profiles[0]?.[0] ?? 'claude-code';
    const defaultWf = ws?.defaultWorkflowId && settings.data.workflows[ws.defaultWorkflowId] ? ws.defaultWorkflowId : '';
    setDraft({
      workspaceId: wsId,
      title: '',
      description: '',
      priority: 'normal',
      mode: defaultWf ? 'workflow' : 'agent',
      agentKind: ws?.defaultAgentKind && settings.data.agents[ws.defaultAgentKind] ? ws.defaultAgentKind : firstAgent,
      workflowId: defaultWf || workflows[0]?.[0] || '',
      providers: null,
      model: '',
      dependsOn: [],
      sandboxId: defaultSandbox(sandboxes.data, ws),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, task?.id, workspaceId, !!settings.data]);

  const save = useAction(
    async (v: { draft: Draft; status: 'backlog' | 'queued' }) => {
      const d = v.draft;
      const common = {
        title: d.title.trim(),
        description: d.description.trim(),
        priority: d.priority,
        agentKind: d.agentKind,
        // '' clears the workflow when switching an existing task back to a single agent.
        workflowId: d.mode === 'workflow' ? d.workflowId : task?.workflowId ? '' : undefined,
        providers: d.providers ?? undefined,
        model: d.model.trim() || undefined,
        dependsOn: d.dependsOn,
        // '' clears a chosen sandbox when editing; a new task simply gets none.
        sandboxId: d.sandboxId || (task?.sandboxId ? '' : undefined),
      };
      return task ? rpc('task.update', { taskId: task.id, ...common }) : rpc('task.create', { workspaceId: d.workspaceId, status: v.status, ...common });
    },
    {
      success: (_r, v) => (task ? t('taskDialog.saved') : v.status === 'queued' ? t('taskDialog.createdQueued') : t('taskDialog.createdBacklog')),
      error: t('common.saveFailed'),
      onSuccess: (created) => {
        store(created);
        onClose();
        if (!task) onCreated?.(created);
      },
    },
  );

  const d = draft;
  const set = (patch: Partial<Draft>) => setDraft((x) => (x ? { ...x, ...patch } : x));
  const ws = d ? workspaces.data?.find((w) => w.id === d.workspaceId) : undefined;
  const profile = d ? settings.data?.agents[d.agentKind] : undefined;
  const effectiveProviders = d?.providers ?? profile?.providers ?? [];
  const vendorModels = useDefaultModels(profile ? profileAdapter(profile) : undefined, effectiveProviders.length === 0);
  const modelSuggestions = Array.from(new Set(effectiveProviders.length ? effectiveProviders.flatMap((id) => allProviders[id]?.models ?? []) : (vendorModels.data?.models ?? [])));

  // Possible dependencies: other tasks of the workspace that do not (directly) depend on this one.
  const depCandidates = useMemo(() => {
    if (!d) return [];
    const q = depFilter.trim().toLowerCase();
    return (tasks.data ?? [])
      .filter((x) => x.workspaceId === d.workspaceId && x.id !== task?.id && !(task && x.dependsOn.includes(task.id)))
      .filter((x) => !q || x.title.toLowerCase().includes(q) || d.dependsOn.includes(x.id))
      .sort((a, b) => Number(a.status === 'done') - Number(b.status === 'done') || sortByOrder(a, b));
  }, [tasks.data, d, task, depFilter]);

  const titleError = d && d.title.length > 200 ? t('taskDialog.err.titleLong') : undefined;
  const invalid = !d || !d.title.trim() || !!titleError || !d.workspaceId || (d.mode === 'workflow' && !d.workflowId) || (d.mode === 'agent' && !d.agentKind);
  const submit = (status: 'backlog' | 'queued') => d && !invalid && save.mutate({ draft: d, status });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      dismissable={!save.isPending}
      title={task ? t('taskDialog.editTitle') : t('taskDialog.newTitle')}
      description={task ? undefined : ws ? rich(t('taskDialog.newIn'), { workspace: <strong className="text-fg">{ws.name}</strong> }) : t('taskDialog.newIntro')}
      footer={
        task ? (
          <>
            <Button onClick={onClose} disabled={save.isPending}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" loading={save.isPending} disabled={invalid} onClick={() => submit('backlog')}>
              {t('common.save')}
            </Button>
          </>
        ) : (
          <>
            <Button onClick={onClose} disabled={save.isPending} className="mr-auto">
              {t('common.cancel')}
            </Button>
            <Button
              variant={initialStatus === 'backlog' ? 'primary' : 'secondary'}
              icon={<Inbox className="size-4" />}
              loading={save.isPending && save.variables?.status === 'backlog'}
              disabled={invalid || save.isPending}
              onClick={() => submit('backlog')}
              title={t('taskDialog.toBacklogHint')}
            >
              {t('taskDialog.toBacklog')}
            </Button>
            <Button
              variant={initialStatus === 'queued' ? 'primary' : 'secondary'}
              icon={<ListPlus className="size-4" />}
              loading={save.isPending && save.variables?.status === 'queued'}
              disabled={invalid || save.isPending}
              onClick={() => submit('queued')}
              title={t('taskDialog.toQueueHint')}
            >
              {t('taskDialog.toQueue')}
            </Button>
          </>
        )
      }
    >
      {!d || settings.isLoading ? (
        <LoadingState />
      ) : (
        <div className="space-y-5">
          {!task && !workspaceId && (
            <Field label={t('taskDialog.workspace')}>
              {workspaces.data?.length ? (
                <Select
                  value={d.workspaceId}
                  onChange={(e) =>
                    set({ workspaceId: e.target.value, dependsOn: [], sandboxId: defaultSandbox(sandboxes.data, workspaces.data?.find((w) => w.id === e.target.value)) })
                  }
                >
                  <option value="">{t('taskDialog.chooseWorkspace')}</option>
                  {workspaces.data.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </Select>
              ) : (
                <Callout tone="warning">
                  {rich(t('taskDialog.noWorkspace'), {
                    link: (
                      <Link to="/workspaces" onClick={onClose} className="text-accent hover:underline">
                        {t('layout.nav.workspaces')}
                      </Link>
                    ),
                  })}
                </Callout>
              )}
            </Field>
          )}

          <Field label={t('taskDialog.title')} error={titleError}>
            <Input
              value={d.title}
              onChange={(e) => set({ title: e.target.value })}
              placeholder={t('taskDialog.titlePlaceholder')}
              invalid={!!titleError}
              onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && submit(initialStatus)}
            />
          </Field>

          <Field
            label={t('taskDialog.description')}
            hint={
              <button type="button" onClick={() => setTips((x) => !x)} className="inline-flex items-center gap-1 text-accent hover:underline">
                <Lightbulb className="size-3.5" /> {tips ? t('taskDialog.hideTips') : t('taskDialog.showTips')}
              </button>
            }
          >
            <Textarea
              value={d.description}
              rows={6}
              onChange={(e) => set({ description: e.target.value })}
              placeholder={t('taskDialog.descriptionPlaceholder')}
              onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && submit(initialStatus)}
            />
          </Field>
          {tips && (
            <Callout tone="tip" title={t('taskDialog.tipsTitle')}>
              <ul className="list-disc space-y-0.5 pl-4">
                <li>{t('taskDialog.tip1')}</li>
                <li>{t('taskDialog.tip2')}</li>
                <li>{t('taskDialog.tip3')}</li>
                <li>{t('taskDialog.tip4')}</li>
              </ul>
            </Callout>
          )}

          <Field label={t('taskDialog.priority')}>
            <div className="inline-flex rounded-lg bg-surface-2 p-1">
              {PRIORITIES.map((p) => (
                <button
                  key={p}
                  type="button"
                  aria-pressed={d.priority === p}
                  onClick={() => set({ priority: p })}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-sm font-medium',
                    d.priority === p ? 'bg-surface text-fg shadow-sm' : 'text-fg-muted hover:text-fg',
                  )}
                >
                  <PriorityIcon priority={p} />
                  {t(`task.priority.${p}`)}
                </button>
              ))}
            </div>
          </Field>

          {d.workspaceId && <SandboxField draft={d} set={set} workspace={ws} sandboxes={sandboxChoices(sandboxes.data, d.workspaceId, task?.id)} />}

          <div>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-medium text-fg">{t('taskDialog.runWith')}</span>
              <div className="inline-flex rounded-lg bg-surface-2 p-1">
                {(['agent', 'workflow'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    aria-pressed={d.mode === m}
                    onClick={() => set({ mode: m })}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-sm font-medium',
                      d.mode === m ? 'bg-surface text-fg shadow-sm' : 'text-fg-muted hover:text-fg',
                    )}
                  >
                    {m === 'agent' ? <Bot className="size-4" /> : <WorkflowIcon className="size-4" />}
                    {m === 'agent' ? t('taskDialog.modeAgent') : t('taskDialog.modeWorkflow')}
                  </button>
                ))}
              </div>
            </div>
            <p className="mb-3 text-xs text-fg-muted">{d.mode === 'agent' ? t('taskDialog.modeAgentHint') : t('taskDialog.modeWorkflowHint')}</p>
            {d.mode === 'agent' ? (
              <AgentTypeCards profiles={profiles} providers={allProviders} value={d.agentKind} onChange={(agentKind) => set({ agentKind, providers: null, model: '' })} />
            ) : workflows.length ? (
              <WorkflowCards workflows={workflows} value={d.workflowId} onChange={(workflowId) => set({ workflowId })} />
            ) : (
              <Callout tone="info">
                {rich(t('taskDialog.noWorkflows'), {
                  link: (
                    <Link to="/settings/workflows" onClick={onClose} className="text-accent hover:underline">
                      {t('settingsNav.workflows')}
                    </Link>
                  ),
                })}
              </Callout>
            )}
          </div>

          <div className="rounded-xl border border-line">
            <button type="button" onClick={() => setAdvanced((a) => !a)} className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm font-medium text-fg">
              {advanced ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
              {t('taskDialog.advanced')}
              {d.dependsOn.length > 0 && <span className="font-normal text-fg-muted">· {t('taskDialog.depCount', { count: d.dependsOn.length })}</span>}
            </button>
            {advanced && (
              <div className="space-y-5 border-t border-line px-4 py-4">
                <Field label={t('taskDialog.dependsOn')} hint={t('taskDialog.dependsOnHint')}>
                  {depCandidates.length === 0 && !depFilter ? (
                    <p className="text-sm text-fg-muted">{t('taskDialog.noOtherTasks')}</p>
                  ) : (
                    <div className="space-y-2">
                      {(tasks.data?.filter((x) => x.workspaceId === d.workspaceId).length ?? 0) > 8 && (
                        <div className="relative">
                          <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-fg-subtle" />
                          <Input value={depFilter} onChange={(e) => setDepFilter(e.target.value)} placeholder={t('taskDialog.searchTasks')} className="pl-8" />
                        </div>
                      )}
                      <ul className="max-h-48 divide-y divide-line overflow-y-auto rounded-lg border border-line">
                        {depCandidates.map((x) => (
                          <li key={x.id} className="flex items-center gap-2 px-3 py-1.5">
                            <Checkbox
                              checked={d.dependsOn.includes(x.id)}
                              onChange={(on) => set({ dependsOn: on ? [...d.dependsOn, x.id] : d.dependsOn.filter((id) => id !== x.id) })}
                              label={x.title}
                            />
                            <span className="flex-1" />
                            <TaskStatusBadge status={x.status} />
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </Field>

                {Object.keys(allProviders).length > 0 && (
                  <Field label={t('spawn.providers')} hint={t('taskDialog.providersHint')}>
                    <div className="grid gap-2 rounded-lg border border-line p-3 sm:grid-cols-2">
                      {Object.entries(allProviders).map(([id, p]) => (
                        <Checkbox
                          key={id}
                          checked={effectiveProviders.includes(id)}
                          onChange={(on) => set({ providers: on ? [...effectiveProviders, id] : effectiveProviders.filter((x) => x !== id) })}
                          label={p.label}
                          description={t(`providers.kind.${p.kind}.short`)}
                        />
                      ))}
                    </div>
                    {d.providers && (
                      <button type="button" className="mt-1 text-xs text-accent hover:underline" onClick={() => set({ providers: null })}>
                        {t('spawn.resetToProfile')}
                      </button>
                    )}
                  </Field>
                )}
                <Field label={t('spawn.modelField')} optional hint={t('taskDialog.modelHint')}>
                  <Input value={d.model} onChange={(e) => set({ model: e.target.value })} list="task-model-suggestions" className="font-mono" placeholder={profile?.model ?? ''} />
                  <datalist id="task-model-suggestions">
                    {modelSuggestions.map((m) => (
                      <option key={m} value={m} />
                    ))}
                  </datalist>
                </Field>
              </div>
            )}
          </div>

          {!task && ws && (
            <p className="flex items-start gap-2 text-xs text-fg-muted">
              <WorkspaceDot workspace={ws} className="mt-0.5 size-2" />
              {ws.autoRun ? t('taskDialog.autoRunOn', { count: ws.maxParallel }) : t('taskDialog.autoRunOff')}
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}

/** Where the task's agent works: a new sandbox for the task (the workspace's shared one) or an existing sandbox. */
function SandboxField({
  draft: d,
  set,
  workspace,
  sandboxes,
}: {
  draft: Draft;
  set: (patch: Partial<Draft>) => void;
  workspace: Workspace | undefined;
  sandboxes: Sandbox[];
}) {
  const t = useT();
  const shared = workspace?.sandboxMode === 'shared';
  const hint = d.sandboxId ? t('taskDialog.sandboxExistingHint') : shared ? t('taskDialog.sandboxSharedHint') : t('taskDialog.sandboxNewHint');
  return (
    <Field label={t('taskDialog.sandbox')} hint={hint}>
      <Select value={d.sandboxId} onChange={(e) => set({ sandboxId: e.target.value })}>
        <option value="">{shared ? t('taskDialog.sandboxShared') : t('taskDialog.sandboxNew')}</option>
        {sandboxes.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name} ({s.status === 'running' ? t('taskDialog.sandboxRunning') : t('taskDialog.sandboxStopped')})
          </option>
        ))}
      </Select>
    </Field>
  );
}
