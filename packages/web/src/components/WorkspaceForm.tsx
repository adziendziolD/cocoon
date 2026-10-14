import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DEFAULT_REVIEW_PROMPT, WORKSPACE_KEY, type MethodParams, type NetworkMode, type Workspace } from '@cocoon/protocol';
import { Boxes, Check, Layers, Workflow as WorkflowIcon, Bot, Square } from 'lucide-react';
import { qk } from '../api/keys';
import { useSettings } from '../api/queries';
import { rpc } from '../api/rpc';
import { useAction } from '../api/useAction';
import { useLanguage, useT, type TFunction } from '../i18n';
import { cn } from '../lib/cn';
import { profileLabel } from '../lib/profiles';
import { hasRepoErrors, repoRowsFrom, reposFromRows, validateRepoRows, type RepoRow } from '../lib/repos';
import { workflowLabel } from '../lib/tasks';
import { setWorkspaceScope, WORKSPACE_COLORS } from '../lib/workspace';
import { Button } from './Button';
import { Dialog } from './Dialog';
import { Checkbox, ChoiceCard, Field, Input, Select, Textarea, Toggle } from './Field';
import { Callout } from './HelpText';
import { RepoRowsEditor } from './RepoRowsEditor';
import { GithubTokenSelect } from './GithubTokenSelect';
import { NetworkModeCards } from './SandboxOptions';

export interface WorkspaceDraft {
  name: string;
  /** '' = derived from the name by the server. */
  key: string;
  review: { enabled: boolean; agentKinds: string[]; prompt: string; agentPushes: boolean; baseBranch: string };
  description: string;
  color: string;
  /** Repositories for the workspace's sandboxes (the older single `repo` shows up as the first row). */
  repos: RepoRow[];
  /** '' = server default network mode. */
  network: NetworkMode | '';
  /** '' = default GITHUB_TOKEN. */
  githubToken: string;
  sandboxMode: 'per-task' | 'shared';
  runMode: 'agent' | 'workflow';
  defaultAgentKind: string;
  defaultWorkflowId: string;
  autoRun: boolean;
  maxParallel: number;
}

export function toWorkspaceDraft(w?: Workspace, index = 0): WorkspaceDraft {
  return {
    name: w?.name ?? '',
    key: w?.key ?? '',
    review: {
      enabled: w?.review?.enabled ?? false,
      agentKinds: w?.review?.agentKinds ?? ['claude-code'],
      prompt: w?.review?.prompt ?? '',
      agentPushes: w?.review?.agentPushes ?? false,
      baseBranch: w?.review?.baseBranch ?? '',
    },
    description: w?.description ?? '',
    color: w?.color ?? WORKSPACE_COLORS[index % WORKSPACE_COLORS.length]!,
    repos: repoRowsFrom(w?.repos, w?.repo),
    network: w?.network ?? '',
    githubToken: w?.githubToken ?? '',
    sandboxMode: w?.sandboxMode ?? 'per-task',
    runMode: w?.defaultWorkflowId ? 'workflow' : 'agent',
    defaultAgentKind: w?.defaultAgentKind ?? 'claude-code',
    defaultWorkflowId: w?.defaultWorkflowId ?? '',
    autoRun: w?.autoRun ?? false,
    maxParallel: w?.maxParallel ?? 2,
  };
}

/** Params for workspace.create / workspace.update. Empty strings clear optional texts. */
export function workspaceParams(d: WorkspaceDraft): MethodParams<'workspace.create'> {
  const repos = reposFromRows(d.repos);
  return {
    name: d.name.trim(),
    key: d.key.trim() || undefined,
    review: {
      enabled: d.review.enabled,
      agentKinds: d.review.agentKinds.length ? d.review.agentKinds : ['claude-code'],
      prompt: d.review.prompt.trim() || undefined,
      agentPushes: d.review.agentPushes,
      baseBranch: d.review.baseBranch.trim() || undefined,
    },
    description: d.description.trim(),
    color: d.color,
    // Always saved as `repos` (null = none); the older single `repo` field is cleared.
    repos: repos.length ? repos : null,
    repo: null,
    network: d.network || undefined,
    githubToken: d.githubToken || null,
    sandboxMode: d.sandboxMode,
    defaultAgentKind: d.defaultAgentKind,
    // '' = no default workflow (an omitted field would keep the old value).
    defaultWorkflowId: d.runMode === 'workflow' ? d.defaultWorkflowId : '',
    autoRun: d.autoRun,
    maxParallel: d.maxParallel,
  };
}

export function validateWorkspace(t: TFunction, d: WorkspaceDraft): Partial<Record<'name' | 'key' | 'repo' | 'workflow' | 'maxParallel' | 'review', string>> {
  const e: Partial<Record<'name' | 'key' | 'repo' | 'workflow' | 'maxParallel' | 'review', string>> = {};
  if (d.key && !WORKSPACE_KEY.test(d.key)) e.key = t('workspaceForm.err.key');
  if (d.review.enabled && !d.review.agentKinds.length) e.review = t('workspaceForm.err.reviewAgents');
  if (!d.name.trim()) e.name = t('workspaceForm.err.name');
  else if (d.name.trim().length > 80) e.name = t('workspaceForm.err.nameLong');
  const repoErrors = validateRepoRows(t, d.repos);
  if (hasRepoErrors(repoErrors)) e.repo = repoErrors.map((x) => x.url ?? x.path).find(Boolean);
  if (d.runMode === 'workflow' && !d.defaultWorkflowId) e.workflow = t('workspaceForm.err.workflow');
  if (!Number.isInteger(d.maxParallel) || d.maxParallel < 1 || d.maxParallel > 20) e.maxParallel = t('workspaceForm.err.maxParallel');
  return e;
}

export function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  const t = useT();
  return (
    <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t('workspaceForm.color')}>
      {WORKSPACE_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          aria-label={c}
          onClick={() => onChange(c)}
          className={cn(
            'flex size-8 items-center justify-center rounded-full ring-offset-2 ring-offset-surface transition-transform hover:scale-110 focus-visible:outline-2 focus-visible:outline-accent',
            value === c && 'ring-2 ring-fg',
          )}
          style={{ backgroundColor: c }}
        >
          {value === c && <Check className="size-4 text-white" />}
        </button>
      ))}
    </div>
  );
}

/** All workspace options. Used in the create/edit dialog and on the workspace's settings tab. */
export function WorkspaceForm({ value: d, onChange, showErrors = true }: { value: WorkspaceDraft; onChange: (patch: Partial<WorkspaceDraft>) => void; showErrors?: boolean }) {
  const t = useT();
  const { lang } = useLanguage();
  const settings = useSettings();
  const errors = showErrors ? validateWorkspace(t, d) : {};
  const agents = Object.entries(settings.data?.agents ?? {});
  const workflows = Object.entries(settings.data?.workflows ?? {});

  return (
    <div className="space-y-6">
      <section className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-[1fr_8rem_auto]">
          <Field label={t('workspaceForm.name')} error={errors.name} hint={t('workspaceForm.nameHint')}>
            <Input value={d.name} onChange={(e) => onChange({ name: e.target.value })} placeholder={t('workspaceForm.namePlaceholder')} maxLength={80} />
          </Field>
          <Field label={t('workspaceForm.key')} optional error={showErrors ? errors.key : undefined} hint={t('workspaceForm.keyHint', { example: `${d.key || 'FD'}-12` })}>
            <Input
              value={d.key}
              onChange={(e) => onChange({ key: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) })}
              placeholder={t('workspaceForm.keyAuto')}
              className="font-mono"
            />
          </Field>
          <Field label={t('workspaceForm.color')}>
            <ColorPicker value={d.color} onChange={(color) => onChange({ color })} />
          </Field>
        </div>
        <Field label={t('workspaceForm.description')} optional>
          <Textarea value={d.description} rows={2} onChange={(e) => onChange({ description: e.target.value })} placeholder={t('workspaceForm.descriptionPlaceholder')} />
        </Field>
      </section>

      <section className="space-y-4">
        <SectionLabel title={t('workspaceForm.repoSection')} text={t('workspaceForm.repoSectionHint')} />
        <RepoRowsEditor rows={d.repos} onChange={(repos) => onChange({ repos })} errors={showErrors ? validateRepoRows(t, d.repos) : []} idPrefix="ws-repo" />
      </section>

      <section className="space-y-3">
        <SectionLabel title={t('workspaceForm.githubToken')} text={t('workspaceForm.githubTokenHint')} />
        <GithubTokenSelect value={d.githubToken} onChange={(githubToken) => onChange({ githubToken })} />
      </section>

      <section className="space-y-3">
        <SectionLabel title={t('workspaceForm.sandboxMode')} text={t('workspaceForm.sandboxModeHint')} />
        <div className="grid gap-2.5 sm:grid-cols-2">
          <ChoiceCard
            selected={d.sandboxMode === 'per-task'}
            onSelect={() => onChange({ sandboxMode: 'per-task' })}
            icon={<Boxes className="size-5" />}
            title={t('workspaceForm.perTask')}
            description={t('workspaceForm.perTaskHint')}
          />
          <ChoiceCard
            selected={d.sandboxMode === 'shared'}
            onSelect={() => onChange({ sandboxMode: 'shared' })}
            icon={<Square className="size-5" />}
            title={t('workspaceForm.shared')}
            description={t('workspaceForm.sharedHint')}
          />
        </div>
      </section>

      <section className="space-y-3">
        <SectionLabel title={t('workspaceForm.network')} text={t('workspaceForm.networkHint')} />
        <Toggle
          checked={d.network === ''}
          onChange={(on) => onChange({ network: on ? '' : (settings.data?.sandbox.network ?? 'egress') })}
          label={t('workspaceForm.networkDefault')}
          description={t('workspaceForm.networkDefaultHint')}
        />
        {d.network !== '' && <NetworkModeCards value={d.network} onChange={(network) => onChange({ network })} defaultMode={settings.data?.sandbox.network} />}
      </section>

      <section className="space-y-3">
        <SectionLabel title={t('workspaceForm.runWith')} text={t('workspaceForm.runWithHint')} />
        <div className="grid gap-2.5 sm:grid-cols-2">
          <ChoiceCard selected={d.runMode === 'agent'} onSelect={() => onChange({ runMode: 'agent' })} icon={<Bot className="size-5" />} title={t('workspaceForm.runAgent')} description={t('workspaceForm.runAgentHint')} />
          <ChoiceCard
            selected={d.runMode === 'workflow'}
            onSelect={() => onChange({ runMode: 'workflow', defaultWorkflowId: d.defaultWorkflowId || workflows[0]?.[0] || '' })}
            icon={<WorkflowIcon className="size-5" />}
            title={t('workspaceForm.runWorkflow')}
            description={t('workspaceForm.runWorkflowHint')}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('workspaceForm.defaultAgent')} hint={d.runMode === 'workflow' ? t('workspaceForm.defaultAgentWorkflowHint') : undefined}>
            <Select value={d.defaultAgentKind} onChange={(e) => onChange({ defaultAgentKind: e.target.value })}>
              {!agents.some(([k]) => k === d.defaultAgentKind) && <option value={d.defaultAgentKind}>{d.defaultAgentKind}</option>}
              {agents.map(([k, p]) => (
                <option key={k} value={k}>
                  {profileLabel(k, p, lang)}
                </option>
              ))}
            </Select>
          </Field>
          {d.runMode === 'workflow' && (
            <Field label={t('workspaceForm.defaultWorkflow')} error={errors.workflow}>
              <Select value={d.defaultWorkflowId} onChange={(e) => onChange({ defaultWorkflowId: e.target.value })}>
                <option value="">{t('workspaceForm.chooseWorkflow')}</option>
                {workflows.map(([id, wf]) => (
                  <option key={id} value={id}>
                    {workflowLabel(id, wf, lang)} ({t('workflowCards.stages', { count: wf.stages.length })})
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>
      </section>

      <ReviewSection value={d} onChange={onChange} error={showErrors ? errors.review : undefined} />

      <section className="space-y-3">
        <SectionLabel title={t('workspaceForm.automation')} />
        <Toggle checked={d.autoRun} onChange={(autoRun) => onChange({ autoRun })} label={t('workspaceForm.autoRun')} description={t('workspaceForm.autoRunHint')} />
        <Field label={t('workspaceForm.maxParallel')} hint={t('workspaceForm.maxParallelHint')} error={errors.maxParallel} className="max-w-xs">
          <Input type="number" min={1} max={20} value={d.maxParallel} onChange={(e) => onChange({ maxParallel: Number(e.target.value) })} />
        </Field>
      </section>
    </div>
  );
}

/** Code review when approving: review agents in the same sandbox, then push + pull request. */
function ReviewSection({ value: d, onChange, error }: { value: WorkspaceDraft; onChange: (patch: Partial<WorkspaceDraft>) => void; error?: string }) {
  const t = useT();
  const { lang } = useLanguage();
  const settings = useSettings();
  const agents = Object.entries(settings.data?.agents ?? {}).filter(([k]) => k !== 'shell');
  const r = d.review;
  const set = (patch: Partial<WorkspaceDraft['review']>) => onChange({ review: { ...r, ...patch } });
  const toggleAgent = (kind: string, on: boolean) => set({ agentKinds: on ? [...r.agentKinds.filter((k) => k !== kind), kind] : r.agentKinds.filter((k) => k !== kind) });
  return (
    <section className="space-y-3">
      <SectionLabel title={t('workspaceForm.review')} text={t('workspaceForm.reviewHint')} />
      <Toggle checked={r.enabled} onChange={(enabled) => set({ enabled })} label={t('workspaceForm.reviewEnabled')} description={t('workspaceForm.reviewEnabledHint')} />
      {r.enabled && (
        <div className="space-y-4 rounded-xl border border-line p-4">
          <Field label={t('workspaceForm.reviewAgents')} hint={t('workspaceForm.reviewAgentsHint')} error={error}>
            <div className="grid gap-2 sm:grid-cols-2">
              {agents.map(([kind, profile]) => (
                <Checkbox
                  key={kind}
                  checked={r.agentKinds.includes(kind)}
                  onChange={(on) => toggleAgent(kind, on)}
                  label={`${r.agentKinds.includes(kind) ? `${r.agentKinds.indexOf(kind) + 1}. ` : ''}${profileLabel(kind, profile, lang)}`}
                />
              ))}
            </div>
          </Field>
          <Toggle checked={r.agentPushes} onChange={(agentPushes) => set({ agentPushes })} label={t('workspaceForm.reviewPushes')} description={t('workspaceForm.reviewPushesHint')} />
          {r.agentPushes && <Callout tone="warning">{t('workspaceForm.reviewTokenWarning')}</Callout>}
          <Field label={t('workspaceForm.reviewBase')} optional hint={t('workspaceForm.reviewBaseHint')} className="max-w-xs">
            <Input value={r.baseBranch} onChange={(e) => set({ baseBranch: e.target.value })} placeholder="main" className="font-mono" />
          </Field>
          <Field label={t('workspaceForm.reviewPrompt')} optional hint={t('workspaceForm.reviewPromptHint')}>
            <Textarea value={r.prompt} rows={5} onChange={(e) => set({ prompt: e.target.value })} placeholder={DEFAULT_REVIEW_PROMPT} className="font-mono text-xs" />
          </Field>
        </div>
      )}
    </section>
  );
}

function SectionLabel({ title, text }: { title: string; text?: string }) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-fg">{title}</h3>
      {text && <p className="mt-0.5 text-xs leading-relaxed text-fg-muted">{text}</p>}
    </div>
  );
}

/** Create (no `workspace`) or edit a workspace. After creating, the new workspace becomes the selected scope. */
export function WorkspaceDialog({ open, onClose, workspace, index = 0 }: { open: boolean; onClose: () => void; workspace?: Workspace; index?: number }) {
  const t = useT();
  const navigate = useNavigate();
  const [draft, setDraft] = useState<WorkspaceDraft>(() => toWorkspaceDraft(workspace, index));
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (open) {
      setDraft(toWorkspaceDraft(workspace, index));
      setTouched(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, workspace?.id]);

  const save = useAction(
    (d: WorkspaceDraft) =>
      workspace ? rpc('workspace.update', { workspaceId: workspace.id, ...workspaceParams(d) }) : rpc('workspace.create', workspaceParams(d)),
    {
      success: (w) => (workspace ? t('workspaceForm.saved') : t('workspaceForm.created', { name: w.name })),
      error: t('common.saveFailed'),
      invalidate: [qk.workspaces],
      onSuccess: (w) => {
        onClose();
        if (!workspace) {
          setWorkspaceScope(w.id);
          navigate(`/workspaces/${w.id}`);
        }
      },
    },
  );
  const errors = validateWorkspace(t, draft);
  const invalid = Object.keys(errors).length > 0;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      dismissable={!save.isPending}
      title={workspace ? t('workspaceForm.editTitle', { name: workspace.name }) : t('workspace.new')}
      description={workspace ? undefined : t('workspaceForm.createIntro')}
      footer={
        <>
          <Button onClick={onClose} disabled={save.isPending}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            icon={<Layers className="size-4" />}
            loading={save.isPending}
            disabled={touched && invalid}
            onClick={() => {
              setTouched(true);
              if (!invalid) save.mutate(draft);
            }}
          >
            {workspace ? t('common.save') : t('workspaceForm.create')}
          </Button>
        </>
      }
    >
      <WorkspaceForm value={draft} onChange={(p) => setDraft((d) => ({ ...d, ...p }))} showErrors={touched || !!draft.name} />
    </Dialog>
  );
}
