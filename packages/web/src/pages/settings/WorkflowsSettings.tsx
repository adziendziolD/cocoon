import { useEffect, useMemo, useRef, useState } from 'react';
import { localize, WORKFLOW_ID, type AgentProfile, type Language, type LocalizedText, type Workflow } from '@cocoon/protocol';
import { ArrowDown, ArrowRight, ArrowUp, Copy, GitBranch, Hand, Plus, RotateCcw, Save, Trash2, Undo2, UserCheck } from 'lucide-react';
import { useSettings } from '../../api/queries';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Card, CardBody, CardHeader } from '../../components/Card';
import { ConfirmDialog, Dialog } from '../../components/Dialog';
import { Field, Input, Select, Textarea, Toggle } from '../../components/Field';
import { Callout } from '../../components/HelpText';
import { ErrorState, LoadingState } from '../../components/States';
import { rich, useLanguage, useT, type MessageKey, type TFunction } from '../../i18n';
import { cn } from '../../lib/cn';
import { profileLabel } from '../../lib/profiles';
import { useResetSettings, useSaveSettings } from './useSaveSettings';

interface StageDraft {
  /** Local id for React keys and textarea refs; not saved. */
  uid: string;
  /** Built-in stages carry texts in both languages; once edited, the field becomes a plain string. */
  name: LocalizedText;
  agentKind: string;
  prompt: string;
  approval: boolean;
}

interface WorkflowDraft {
  label: LocalizedText;
  description: LocalizedText;
  stages: StageDraft[];
}

type Drafts = Record<string, WorkflowDraft>;

let uidCounter = 0;
const nextUid = () => `s${++uidCounter}`;

const PLACEHOLDERS: Array<{ token: string; hint: MessageKey }> = [
  { token: '{{task}}', hint: 'workflows.ph.task' },
  { token: '{{task.title}}', hint: 'workflows.ph.title' },
  { token: '{{task.description}}', hint: 'workflows.ph.description' },
  { token: '{{previous.output}}', hint: 'workflows.ph.previous' },
  { token: '{{diff}}', hint: 'workflows.ph.diff' },
  { token: '{{feedback}}', hint: 'workflows.ph.feedback' },
];

const text = (v: LocalizedText | undefined, lang: Language) => localize(v, lang) ?? '';
const trimText = (v: LocalizedText): LocalizedText => (typeof v === 'string' ? v.trim() : v);

function toDraft(w: Workflow): WorkflowDraft {
  return {
    label: w.label,
    description: w.description ?? '',
    stages: w.stages.map((s) => ({ uid: nextUid(), name: s.name, agentKind: s.agentKind, prompt: s.prompt, approval: s.approval })),
  };
}

function fromDraft(d: WorkflowDraft): Workflow {
  return {
    label: trimText(d.label),
    description: typeof d.description === 'string' ? d.description.trim() || undefined : d.description,
    stages: d.stages.map((s) => ({ name: trimText(s.name), agentKind: s.agentKind, prompt: s.prompt, approval: s.approval })),
  };
}

const draftsFrom = (workflows: Record<string, Workflow>): Drafts => Object.fromEntries(Object.entries(workflows).map(([k, w]) => [k, toDraft(w)]));
/** Comparable form without the local stage ids. */
const comparable = (drafts: Drafts | null) => (drafts ? JSON.stringify(Object.entries(drafts).map(([k, d]) => [k, fromDraft(d)])) : '');

function validate(t: TFunction, d: WorkflowDraft, lang: Language): string | undefined {
  if (!text(d.label, lang).trim()) return t('workflows.err.label');
  if (d.stages.length === 0) return t('workflows.err.noStages');
  for (const [i, s] of d.stages.entries()) {
    const n = i + 1;
    if (!text(s.name, lang).trim()) return t('workflows.err.stageName', { n });
    if (!s.agentKind) return t('workflows.err.stageAgent', { n });
    if (!s.prompt.trim()) return t('workflows.err.stagePrompt', { n });
  }
  return undefined;
}

function uniqueId(base: string, taken: Record<string, unknown>): string {
  const stem = base.slice(0, 34).replace(/-+$/, '');
  let id = `${stem}-copy`;
  for (let i = 2; taken[id]; i++) id = `${stem}-copy-${i}`;
  return id;
}

export function WorkflowsSettings() {
  const t = useT();
  const { lang } = useLanguage();
  const settings = useSettings();
  const [drafts, setDrafts] = useState<Drafts | null>(null);
  const [selected, setSelected] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [toDelete, setToDelete] = useState<string | null>(null);

  // `baseline` is the server state the current edits started from.
  const [baseline, setBaseline] = useState<Drafts | null>(null);
  const serverDrafts = useMemo(() => (settings.data ? draftsFrom(settings.data.workflows) : null), [settings.data]);
  const dirty = !!drafts && !!baseline && comparable(drafts) !== comparable(baseline);

  const resync = (next: Drafts | null) => {
    setDrafts(next);
    setBaseline(next);
  };

  // Follow server changes (e.g. from another browser tab) as long as the user has no unsaved edits.
  useEffect(() => {
    if (serverDrafts && !dirty) resync(serverDrafts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverDrafts]);

  useEffect(() => {
    if (drafts && (!selected || !drafts[selected])) setSelected(Object.keys(drafts)[0] ?? '');
  }, [drafts, selected]);

  const save = useSaveSettings(t('workflows.saved'), (next) => resync(draftsFrom(next.workflows)));
  const reset = useResetSettings((next) => {
    resync(draftsFrom(next.workflows));
    setConfirmReset(false);
  });

  if (settings.isLoading || !drafts) return settings.error ? <ErrorState error={settings.error} onRetry={() => settings.refetch()} /> : <LoadingState />;

  const agents = settings.data?.agents ?? {};
  const errors = Object.fromEntries(Object.entries(drafts).map(([k, d]) => [k, validate(t, d, lang)]));
  const hasErrors = Object.values(errors).some(Boolean);
  const firstError = Object.entries(errors).find(([, e]) => e);
  const draft = drafts[selected];
  const update = (patch: Partial<WorkflowDraft>) => setDrafts((all) => (all && selected && all[selected] ? { ...all, [selected]: { ...all[selected], ...patch } } : all));

  const addWorkflow = (id: string, w: WorkflowDraft) => {
    setDrafts((all) => ({ ...all, [id]: w }));
    setSelected(id);
  };

  const duplicate = () => {
    if (!draft) return;
    const id = uniqueId(selected, drafts);
    addWorkflow(id, {
      label: t('workflows.copyLabel', { name: text(draft.label, lang) || selected }),
      description: draft.description,
      stages: draft.stages.map((s) => ({ ...s, uid: nextUid() })),
    });
  };

  return (
    <div className="space-y-5">
      <Callout tone="info" title={t('workflows.introTitle')}>
        {rich(t('workflows.intro'), {
          fresh: <strong>{t('workflows.introFresh')}</strong>,
          approval: <strong>{t('workflows.introApproval')}</strong>,
        })}
      </Callout>

      <div className="grid gap-5 xl:grid-cols-[260px_1fr]">
        <div className="space-y-2">
          {Object.entries(drafts).map(([id, d]) => (
            <button
              key={id}
              onClick={() => setSelected(id)}
              className={cn(
                'flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-colors',
                id === selected ? 'border-accent bg-accent-soft' : 'border-line bg-surface hover:border-line-strong',
                errors[id] && 'border-red-500/50',
              )}
            >
              <GitBranch className="mt-0.5 size-4 text-fg-muted" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-fg">{text(d.label, lang) || id}</div>
                <div className="truncate font-mono text-xs text-fg-subtle">{id}</div>
                <div className="mt-0.5 text-xs text-fg-muted">{t('workflows.stageCount', { count: d.stages.length })}</div>
              </div>
              {!baseline?.[id] && <Badge tone="accent">{t('workflows.new')}</Badge>}
            </button>
          ))}
          <Button className="w-full" icon={<Plus className="size-4" />} onClick={() => setAddOpen(true)}>
            {t('workflows.newWorkflow')}
          </Button>
          <Button variant="ghost" className="w-full" icon={<RotateCcw className="size-4" />} onClick={() => setConfirmReset(true)}>
            {t('workflows.resetDefaults')}
          </Button>
        </div>

        {draft ? (
          <WorkflowForm
            key={selected}
            id={selected}
            draft={draft}
            error={errors[selected]}
            agents={agents}
            onChange={update}
            onDuplicate={duplicate}
            onDelete={() => setToDelete(selected)}
          />
        ) : (
          <Card>
            <CardBody className="text-sm text-fg-muted">{t('workflows.none')}</CardBody>
          </Card>
        )}
      </div>

      {dirty && (
        <div className="sticky bottom-4 z-10 flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 shadow-lg">
          <span className="flex-1 text-sm text-fg">
            {firstError ? (
              <>
                {t('workflows.fixErrors')}{' '}
                <button type="button" className="text-accent hover:underline" onClick={() => setSelected(firstError[0])}>
                  {text(drafts[firstError[0]]?.label, lang) || firstError[0]}: {firstError[1]}
                </button>
              </>
            ) : (
              t('common.unsavedChanges')
            )}
          </span>
          <Button icon={<Undo2 className="size-4" />} onClick={() => resync(serverDrafts)}>
            {t('common.discard')}
          </Button>
          <Button
            variant="primary"
            icon={<Save className="size-4" />}
            disabled={hasErrors}
            loading={save.isPending}
            onClick={() => save.mutate({ workflows: Object.fromEntries(Object.entries(drafts).map(([k, d]) => [k, fromDraft(d)])) })}
          >
            {t('common.save')}
          </Button>
        </div>
      )}

      <AddWorkflowDialog open={addOpen} onClose={() => setAddOpen(false)} existing={drafts} agents={agents} onAdd={addWorkflow} />
      <ConfirmDialog
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        onConfirm={() => reset.mutate('workflows')}
        loading={reset.isPending}
        danger
        title={t('workflows.resetTitle')}
        confirmLabel={t('workflows.reset')}
        message={t('workflows.resetText')}
      />
      <ConfirmDialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={() => {
          setDrafts((all) => {
            if (!all || !toDelete) return all;
            const { [toDelete]: _removed, ...rest } = all;
            return rest;
          });
          setToDelete(null);
        }}
        danger
        title={t('workflows.deleteTitle')}
        confirmLabel={t('common.delete')}
        message={rich(t('workflows.deleteText'), {
          name: <strong className="text-fg">{toDelete && (text(drafts[toDelete]?.label, lang) || toDelete)}</strong>,
        })}
      />
    </div>
  );
}

/** "Plan → Build → Review → you" preview; stages that wait for approval get a small hand icon. */
function FlowPreview({ stages }: { stages: StageDraft[] }) {
  const t = useT();
  const { lang } = useLanguage();
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {stages.map((s, i) => (
        <span key={s.uid} className="flex items-center gap-1.5">
          <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2.5 py-1 text-xs font-medium text-fg ring-1 ring-inset ring-line">
            <span className="text-fg-subtle">{i + 1}</span>
            {text(s.name, lang) || t('workflows.stageFallback', { n: i + 1 })}
            {s.approval && i < stages.length - 1 && <Hand className="size-3 text-amber-600 dark:text-amber-400" aria-label={t('workflows.flow.pauses')} />}
          </span>
          <ArrowRight className="size-3.5 text-fg-subtle" />
        </span>
      ))}
      <span className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2.5 py-1 text-xs font-medium text-accent ring-1 ring-inset ring-accent/25">
        <UserCheck className="size-3" />
        {t('workflows.flow.review')}
      </span>
    </div>
  );
}

function WorkflowForm({
  id,
  draft: d,
  error,
  agents,
  onChange,
  onDuplicate,
  onDelete,
}: {
  id: string;
  draft: WorkflowDraft;
  error?: string;
  agents: Record<string, AgentProfile>;
  onChange: (patch: Partial<WorkflowDraft>) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  const { lang } = useLanguage();
  const textareas = useRef(new Map<string, HTMLTextAreaElement>());

  const setStage = (uid: string, patch: Partial<StageDraft>) => onChange({ stages: d.stages.map((s) => (s.uid === uid ? { ...s, ...patch } : s)) });
  const move = (index: number, delta: number) => {
    const stages = [...d.stages];
    const [s] = stages.splice(index, 1);
    stages.splice(index + delta, 0, s!);
    onChange({ stages });
  };
  const addStage = () => {
    const kind = d.stages.at(-1)?.agentKind ?? (agents['claude-code'] ? 'claude-code' : (Object.keys(agents)[0] ?? ''));
    onChange({ stages: [...d.stages, { uid: nextUid(), name: '', agentKind: kind, prompt: '{{task}}', approval: false }] });
  };

  const insert = (stage: StageDraft, token: string) => {
    const el = textareas.current.get(stage.uid);
    const start = el?.selectionStart ?? stage.prompt.length;
    const end = el?.selectionEnd ?? stage.prompt.length;
    setStage(stage.uid, { prompt: stage.prompt.slice(0, start) + token + stage.prompt.slice(end) });
    requestAnimationFrame(() => {
      const ta = textareas.current.get(stage.uid);
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(start + token.length, start + token.length);
    });
  };

  return (
    <Card>
      <CardHeader
        title={text(d.label, lang) || id}
        description={<span className="font-mono text-xs">{id}</span>}
        actions={
          <>
            <Button size="sm" variant="ghost" icon={<Copy className="size-3.5" />} onClick={onDuplicate}>
              {t('workflows.duplicate')}
            </Button>
            <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={onDelete}>
              {t('common.delete')}
            </Button>
          </>
        }
      />
      <CardBody className="space-y-5">
        {error && <Callout tone="danger">{error}</Callout>}
        <div className="grid gap-4 md:grid-cols-2">
          <Field label={t('workflows.form.label')} hint={t('workflows.form.labelHint')}>
            <Input value={text(d.label, lang)} onChange={(e) => onChange({ label: e.target.value })} invalid={!text(d.label, lang).trim()} />
          </Field>
          <Field label={t('workflows.form.description')} optional hint={t('workflows.form.descriptionHint')}>
            <Input value={text(d.description, lang)} onChange={(e) => onChange({ description: e.target.value })} />
          </Field>
        </div>

        <div>
          <div className="mb-2 text-sm font-medium text-fg">{t('workflows.flow.title')}</div>
          <FlowPreview stages={d.stages} />
        </div>

        <div className="rounded-xl border border-line bg-surface-2/40 p-4">
          <div className="text-sm font-medium text-fg">{t('workflows.ph.heading')}</div>
          <p className="mt-0.5 text-xs text-fg-muted">{t('workflows.ph.intro')}</p>
          <dl className="mt-3 grid gap-x-4 gap-y-1.5 text-xs sm:grid-cols-[auto_1fr]">
            {PLACEHOLDERS.map((p) => (
              <div key={p.token} className="contents">
                <dt>
                  <code className="rounded bg-surface px-1 font-mono text-fg ring-1 ring-inset ring-line">{p.token}</code>
                </dt>
                <dd className="text-fg-muted">{t(p.hint)}</dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="space-y-3">
          <div className="text-sm font-medium text-fg">{t('workflows.stages')}</div>
          {d.stages.length === 0 && <p className="text-sm text-fg-muted">{t('workflows.err.noStages')}</p>}
          <ol className="space-y-3">
            {d.stages.map((s, i) => {
              const last = i === d.stages.length - 1;
              const unknownAgent = !!s.agentKind && !agents[s.agentKind];
              return (
                <li key={s.uid} className="rounded-xl border border-line p-4">
                  <div className="mb-3 flex flex-wrap items-center gap-2">
                    <span className="flex size-6 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent">{i + 1}</span>
                    <span className="flex-1 text-sm font-medium text-fg">{text(s.name, lang) || t('workflows.stageFallback', { n: i + 1 })}</span>
                    <Button size="sm" variant="ghost" icon={<ArrowUp className="size-3.5" />} disabled={i === 0} onClick={() => move(i, -1)} aria-label={t('workflows.moveUp')} title={t('workflows.moveUp')} />
                    <Button size="sm" variant="ghost" icon={<ArrowDown className="size-3.5" />} disabled={last} onClick={() => move(i, 1)} aria-label={t('workflows.moveDown')} title={t('workflows.moveDown')} />
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<Trash2 className="size-3.5" />}
                      onClick={() => onChange({ stages: d.stages.filter((x) => x.uid !== s.uid) })}
                      aria-label={t('workflows.removeStage')}
                      title={t('workflows.removeStage')}
                    />
                  </div>
                  <div className="space-y-4">
                    <div className="grid gap-4 md:grid-cols-2">
                      <Field label={t('workflows.stage.name')} error={!text(s.name, lang).trim() ? t('workflows.stage.nameMissing') : undefined}>
                        <Input
                          value={text(s.name, lang)}
                          onChange={(e) => setStage(s.uid, { name: e.target.value })}
                          placeholder={t('workflows.stage.namePlaceholder')}
                          invalid={!text(s.name, lang).trim()}
                        />
                      </Field>
                      <Field
                        label={t('workflows.stage.agent')}
                        error={!s.agentKind ? t('workflows.stage.agentMissing') : undefined}
                        hint={unknownAgent ? undefined : t('workflows.stage.agentHint')}
                      >
                        <Select value={s.agentKind} onChange={(e) => setStage(s.uid, { agentKind: e.target.value })}>
                          {!s.agentKind && <option value="">{t('workflows.stage.agentPick')}</option>}
                          {Object.entries(agents).map(([kind, p]) => (
                            <option key={kind} value={kind}>
                              {profileLabel(kind, p, lang)}
                            </option>
                          ))}
                          {unknownAgent && <option value={s.agentKind}>{t('workflows.stage.agentUnknownOption', { kind: s.agentKind })}</option>}
                        </Select>
                      </Field>
                    </div>
                    {unknownAgent && <Callout tone="warning">{t('workflows.stage.agentUnknown', { kind: s.agentKind })}</Callout>}
                    <Field label={t('workflows.stage.prompt')} error={!s.prompt.trim() ? t('workflows.stage.promptMissing') : undefined} hint={t('workflows.stage.promptHint')}>
                      <Textarea
                        ref={(el) => {
                          if (el) textareas.current.set(s.uid, el);
                          else textareas.current.delete(s.uid);
                        }}
                        value={s.prompt}
                        onChange={(e) => setStage(s.uid, { prompt: e.target.value })}
                        rows={5}
                        className="font-mono text-xs"
                        spellCheck={false}
                      />
                    </Field>
                    <div className="-mt-2 flex flex-wrap items-center gap-1.5">
                      <span className="text-xs text-fg-subtle">{t('workflows.ph.insert')}</span>
                      {PLACEHOLDERS.map((p) => (
                        <button
                          key={p.token}
                          type="button"
                          title={t(p.hint)}
                          // Keep the textarea's selection: don't steal focus on mousedown.
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => insert(s, p.token)}
                          className="inline-flex items-center gap-0.5 rounded-md bg-surface px-1.5 py-0.5 font-mono text-[11px] text-fg-muted ring-1 ring-inset ring-line hover:bg-surface-2 hover:text-fg"
                        >
                          <Plus className="size-2.5" />
                          {p.token}
                        </button>
                      ))}
                    </div>
                    <Toggle
                      checked={last || s.approval}
                      disabled={last}
                      onChange={(approval) => setStage(s.uid, { approval })}
                      label={t('workflows.stage.approval')}
                      description={last ? t('workflows.stage.approvalLast') : t('workflows.stage.approvalHint')}
                    />
                  </div>
                </li>
              );
            })}
          </ol>
          <Button icon={<Plus className="size-4" />} onClick={addStage}>
            {t('workflows.addStage')}
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

function AddWorkflowDialog({
  open,
  onClose,
  existing,
  agents,
  onAdd,
}: {
  open: boolean;
  onClose: () => void;
  existing: Drafts;
  agents: Record<string, AgentProfile>;
  onAdd: (id: string, w: WorkflowDraft) => void;
}) {
  const t = useT();
  const { lang } = useLanguage();
  const [id, setId] = useState('');
  const [template, setTemplate] = useState('blank');
  useEffect(() => {
    if (open) {
      setId('');
      setTemplate('blank');
    }
  }, [open]);
  const idErr = id && !WORKFLOW_ID.test(id) ? t('workflows.add.idFormat') : existing[id] ? t('workflows.add.idTaken') : undefined;

  const submit = () => {
    if (!id || idErr) return;
    const source = template.startsWith('copy:') ? existing[template.slice(5)] : undefined;
    const w: WorkflowDraft = source
      ? { label: source.label, description: source.description, stages: source.stages.map((s) => ({ ...s, uid: nextUid() })) }
      : {
          label: id,
          description: '',
          stages: [
            {
              uid: nextUid(),
              name: t('workflows.add.blankStage'),
              agentKind: agents['claude-code'] ? 'claude-code' : (Object.keys(agents)[0] ?? 'claude-code'),
              prompt: '{{task}}{{feedback}}',
              approval: false,
            },
          ],
        };
    onAdd(id, w);
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="sm"
      title={t('workflows.newWorkflow')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={submit} disabled={!id || !!idErr}>
            {t('workflows.add.create')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={t('workflows.add.id')} error={idErr} hint={t('workflows.add.idHint')}>
          <Input
            value={id}
            onChange={(e) => setId(e.target.value.toLowerCase())}
            className="font-mono"
            placeholder="bugfix"
            invalid={!!idErr}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
        </Field>
        <Field label={t('workflows.add.template')}>
          <Select value={template} onChange={(e) => setTemplate(e.target.value)}>
            <option value="blank">{t('workflows.add.blank')}</option>
            {Object.entries(existing).map(([k, d]) => (
              <option key={k} value={`copy:${k}`}>
                {t('workflows.add.copyOf', { name: text(d.label, lang) || k })}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </Dialog>
  );
}
