import { useEffect, useMemo, useState } from 'react';
import { localize, SCHEDULE_TEMPLATES, type Schedule, type ScheduleTemplate } from '@cocoon/protocol';
import { ChevronDown, ChevronRight, Clock } from 'lucide-react';
import { useSettings, useWorkspaces } from '../../api/queries';
import { qk } from '../../api/keys';
import { rpc } from '../../api/rpc';
import { useAction } from '../../api/useAction';
import { rich, useLanguage, useT } from '../../i18n';
import { cn } from '../../lib/cn';
import { formatDateTime } from '../../lib/format';
import { profileLabel } from '../../lib/profiles';
import {
  browserTimeZone,
  FREQUENCY_KINDS,
  fromCron,
  HOUR_STEPS,
  previewRuns,
  switchFrequency,
  TEMPLATE_ORDER,
  timeZones,
  toCron,
  WEEK,
  weekdayName,
  type Frequency,
} from '../../lib/schedules';
import { workflowLabel } from '../../lib/tasks';
import { Button } from '../Button';
import { Dialog } from '../Dialog';
import { ChoiceCard, Field, Input, Select, Textarea, Toggle } from '../Field';
import { Callout } from '../HelpText';
import { LoadingState } from '../States';
import { TemplateIcon } from './ScheduleBits';

interface Draft {
  workspaceId: string;
  template: ScheduleTemplate;
  name: string;
  frequency: Frequency;
  timezone: string;
  prompt: string;
  /** '' = the workspace default, 'agent:<kind>' or 'workflow:<id>'. */
  runWith: string;
  enabled: boolean;
  autoClose: boolean;
  skipOverlap: boolean;
  keepRuns: number;
}

function toDraft(s: Schedule): Draft {
  return {
    workspaceId: s.workspaceId,
    template: s.template,
    name: s.name,
    frequency: fromCron(s.cron),
    timezone: s.timezone ?? browserTimeZone(),
    prompt: s.prompt,
    runWith: s.workflowId ? `workflow:${s.workflowId}` : s.agentKind ? `agent:${s.agentKind}` : '',
    enabled: s.enabled,
    autoClose: s.autoClose,
    skipOverlap: s.overlap === 'skip',
    keepRuns: s.keepRuns,
  };
}

/** Create (`schedule` omitted) or edit a scheduled agent. */
export function ScheduleDialog({ open, onClose, schedule, workspaceId }: { open: boolean; onClose: () => void; schedule?: Schedule; workspaceId?: string }) {
  const t = useT();
  const { lang } = useLanguage();
  const settings = useSettings();
  const workspaces = useWorkspaces();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [touched, setTouched] = useState({ name: false, prompt: false });
  const [advanced, setAdvanced] = useState(false);
  const zones = useMemo(() => timeZones(), []);

  useEffect(() => {
    if (!open) return;
    setTouched({ name: !!schedule, prompt: !!schedule });
    setAdvanced(false);
    if (schedule) return setDraft(toDraft(schedule));
    const checks = SCHEDULE_TEMPLATES.checks;
    setDraft({
      workspaceId: workspaceId ?? (workspaces.data?.length === 1 ? workspaces.data[0]!.id : ''),
      template: 'checks',
      name: localize(checks.name, lang) ?? '',
      frequency: fromCron(checks.cron),
      timezone: browserTimeZone(),
      prompt: checks.prompt,
      runWith: '',
      enabled: true,
      autoClose: true,
      skipOverlap: true,
      keepRuns: 10,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, schedule?.id, workspaceId]);

  const save = useAction(
    (d: Draft) => {
      const [mode, id] = d.runWith.split(/:(.*)/);
      const common = {
        name: d.name.trim(),
        cron: toCron(d.frequency),
        timezone: d.timezone,
        template: d.template,
        prompt: d.prompt.trim(),
        agentKind: mode === 'agent' ? id : schedule?.agentKind ? '' : undefined,
        workflowId: mode === 'workflow' ? id : schedule?.workflowId ? '' : undefined,
        enabled: d.enabled,
        autoClose: d.autoClose,
        overlap: d.skipOverlap ? ('skip' as const) : ('always' as const),
        keepRuns: d.keepRuns,
      };
      return schedule ? rpc('schedule.update', { scheduleId: schedule.id, ...common }) : rpc('schedule.create', { workspaceId: d.workspaceId, ...common });
    },
    {
      success: schedule ? t('schedule.saved') : t('schedule.created'),
      error: t('common.saveFailed'),
      invalidate: [qk.schedules],
      onSuccess: onClose,
    },
  );

  const d = draft;
  const set = (patch: Partial<Draft>) => setDraft((x) => (x ? { ...x, ...patch } : x));
  const cron = d ? toCron(d.frequency) : '';
  const preview = useMemo(() => previewRuns(cron, d?.timezone), [cron, d?.timezone]);
  const ws = d ? workspaces.data?.find((w) => w.id === d.workspaceId) : undefined;
  const profiles = Object.entries(settings.data?.agents ?? {});
  const workflows = Object.entries(settings.data?.workflows ?? {});
  const defaultRunWith = ws?.defaultWorkflowId
    ? workflowLabel(ws.defaultWorkflowId, settings.data?.workflows[ws.defaultWorkflowId], lang)
    : profileLabel(ws?.defaultAgentKind ?? 'claude-code', settings.data?.agents[ws?.defaultAgentKind ?? 'claude-code'], lang);
  const shellChosen = d?.runWith.startsWith('agent:') && settings.data?.agents[d.runWith.slice(6)]?.promptMode === 'input' && !settings.data.agents[d.runWith.slice(6)]?.hooks;

  const pickTemplate = (template: ScheduleTemplate) => {
    if (!d) return;
    const preset = template === 'custom' ? undefined : SCHEDULE_TEMPLATES[template];
    set({
      template,
      ...(!touched.name ? { name: preset ? (localize(preset.name, lang) ?? '') : '' } : {}),
      ...(!touched.prompt ? { prompt: preset?.prompt ?? '' } : {}),
      ...(preset && !schedule ? { frequency: fromCron(preset.cron) } : {}),
    });
  };

  const nameError = d && d.name.length > 80 ? t('schedule.err.nameLong') : undefined;
  const invalid = !d || !d.workspaceId || !d.name.trim() || !!nameError || !d.prompt.trim() || !!preview.error || (d.frequency.kind === 'weekly' && !d.frequency.days.length);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      dismissable={!save.isPending}
      title={schedule ? t('schedule.editTitle') : t('schedule.newTitle')}
      description={schedule ? undefined : ws ? rich(t('schedule.newIn'), { workspace: <strong className="text-fg">{ws.name}</strong> }) : t('schedule.newIntro')}
      footer={
        <>
          <Button onClick={onClose} disabled={save.isPending}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" loading={save.isPending} disabled={invalid} onClick={() => d && save.mutate(d)}>
            {schedule ? t('common.save') : t('schedule.create')}
          </Button>
        </>
      }
    >
      {!d || settings.isLoading ? (
        <LoadingState />
      ) : (
        <div className="space-y-5">
          {!schedule && (
            <Field label={t('schedule.template')}>
              <div className="grid gap-2.5 sm:grid-cols-2">
                {TEMPLATE_ORDER.map((tpl) => (
                  <ChoiceCard
                    key={tpl}
                    selected={d.template === tpl}
                    onSelect={() => pickTemplate(tpl)}
                    icon={<TemplateIcon template={tpl} />}
                    title={t(`schedule.template.${tpl}`)}
                    description={t(`schedule.template.${tpl}.hint`)}
                  />
                ))}
              </div>
            </Field>
          )}

          {!schedule && !workspaceId && (
            <Field label={t('taskDialog.workspace')}>
              <Select value={d.workspaceId} onChange={(e) => set({ workspaceId: e.target.value })}>
                <option value="">{t('taskDialog.chooseWorkspace')}</option>
                {workspaces.data?.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          <Field label={t('schedule.name')} error={nameError} hint={t('schedule.nameHint')}>
            <Input value={d.name} invalid={!!nameError} onChange={(e) => (setTouched((x) => ({ ...x, name: true })), set({ name: e.target.value }))} />
          </Field>

          <FrequencyField frequency={d.frequency} onChange={(frequency) => set({ frequency })} timezone={d.timezone} />

          <Field label={t('schedule.timezone')}>
            <Select value={d.timezone} onChange={(e) => set({ timezone: e.target.value })}>
              {(zones.includes(d.timezone) ? zones : [d.timezone, ...zones]).map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </Select>
          </Field>

          <div className="rounded-lg bg-surface-2/70 px-3 py-2 text-sm">
            {preview.error ? (
              <span className="text-red-600 dark:text-red-400">{t('schedule.invalidCron', { error: preview.error })}</span>
            ) : (
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-fg-muted">
                <Clock className="size-4" />
                {t('schedule.nextRuns')}
                {preview.next.map((n) => (
                  <span key={n.toISOString()} className="rounded-md bg-surface px-1.5 py-0.5 font-medium text-fg tabular-nums ring-1 ring-line">
                    {formatDateTime(n.toISOString(), lang)}
                  </span>
                ))}
                {!d.enabled && <span className="text-amber-700 dark:text-amber-400">· {t('schedule.pausedHint')}</span>}
              </span>
            )}
          </div>

          <Field label={t('schedule.prompt')} hint={t('schedule.promptHint')}>
            <Textarea value={d.prompt} rows={10} className="font-mono text-[13px]" onChange={(e) => (setTouched((x) => ({ ...x, prompt: true })), set({ prompt: e.target.value }))} />
          </Field>

          <Field label={t('taskDialog.runWith')} hint={shellChosen ? t('schedule.shellHint') : t('schedule.runWithHint')}>
            <Select value={d.runWith} onChange={(e) => set({ runWith: e.target.value })}>
              <option value="">{t('schedule.runWithDefault', { name: defaultRunWith })}</option>
              <optgroup label={t('taskDialog.modeAgent')}>
                {profiles.map(([kind, p]) => (
                  <option key={kind} value={`agent:${kind}`}>
                    {profileLabel(kind, p, lang)}
                  </option>
                ))}
              </optgroup>
              {workflows.length > 0 && (
                <optgroup label={t('taskDialog.modeWorkflow')}>
                  {workflows.map(([id, wf]) => (
                    <option key={id} value={`workflow:${id}`}>
                      {workflowLabel(id, wf, lang)}
                    </option>
                  ))}
                </optgroup>
              )}
            </Select>
          </Field>

          <div className="space-y-4 rounded-xl border border-line p-4">
            <Toggle checked={d.autoClose} onChange={(autoClose) => set({ autoClose })} label={t('schedule.autoClose')} description={t('schedule.autoCloseHint')} />
            <Toggle checked={d.skipOverlap} onChange={(skipOverlap) => set({ skipOverlap })} label={t('schedule.skipOverlap')} description={t('schedule.skipOverlapHint')} />
            <Toggle checked={d.enabled} onChange={(enabled) => set({ enabled })} label={t('schedule.enabled')} description={t('schedule.enabledHint')} />
          </div>

          <div className="rounded-xl border border-line">
            <button type="button" onClick={() => setAdvanced((a) => !a)} className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm font-medium text-fg">
              {advanced ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
              {t('taskDialog.advanced')}
            </button>
            {advanced && (
              <div className="space-y-5 border-t border-line px-4 py-4">
                <Field label={t('schedule.keepRuns')} hint={t('schedule.keepRunsHint')}>
                  <Input type="number" min={1} max={100} value={d.keepRuns} className="w-28" onChange={(e) => set({ keepRuns: Math.min(100, Math.max(1, Number(e.target.value) || 1)) })} />
                </Field>
                <Field label={t('schedule.cron')} hint={t('schedule.cronHint')}>
                  <Input value={cron} className="font-mono" onChange={(e) => set({ frequency: { kind: 'custom', cron: e.target.value } })} />
                </Field>
              </div>
            )}
          </div>

          {ws?.sandboxMode === 'shared' && <Callout tone="info">{t('schedule.sharedSandboxHint')}</Callout>}
        </div>
      )}
    </Dialog>
  );
}

/** "Every day at 03:00" – segmented choice plus the fields of the chosen kind. */
function FrequencyField({ frequency: f, onChange, timezone }: { frequency: Frequency; onChange: (f: Frequency) => void; timezone: string }) {
  const t = useT();
  const { lang } = useLanguage();
  const time = (value: string, patch: (time: string) => Frequency) => (
    <Input type="time" value={value} className="w-32" onChange={(e) => e.target.value && onChange(patch(e.target.value))} aria-label={t('schedule.time')} />
  );
  return (
    <Field label={t('schedule.when')} hint={t('schedule.whenHint', { timezone })}>
      <div className="space-y-3">
        <div className="inline-flex flex-wrap rounded-lg bg-surface-2 p-1">
          {FREQUENCY_KINDS.map((kind) => (
            <button
              key={kind}
              type="button"
              aria-pressed={f.kind === kind}
              onClick={() => f.kind !== kind && onChange(switchFrequency(f, kind))}
              className={cn('rounded-md px-3 py-1 text-sm font-medium', f.kind === kind ? 'bg-surface text-fg shadow-sm' : 'text-fg-muted hover:text-fg')}
            >
              {t(`schedule.freq.${kind}`)}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm text-fg-muted">
          {f.kind === 'hourly' && (
            <>
              {t('schedule.freq.every')}
              <Select value={f.every} className="w-auto" onChange={(e) => onChange({ ...f, every: Number(e.target.value) })}>
                {HOUR_STEPS.map((n) => (
                  <option key={n} value={n}>
                    {t('schedule.freq.hours', { count: n })}
                  </option>
                ))}
              </Select>
              {t('schedule.freq.atMinute')}
              <Input type="number" min={0} max={59} value={f.minute} className="w-20" onChange={(e) => onChange({ ...f, minute: Math.min(59, Math.max(0, Number(e.target.value) || 0)) })} />
            </>
          )}
          {(f.kind === 'daily' || f.kind === 'weekdays') && (
            <>
              {t('schedule.freq.at')} {time(f.time, (v) => ({ ...f, time: v }))}
            </>
          )}
          {f.kind === 'weekly' && (
            <>
              <span className="inline-flex flex-wrap gap-1">
                {WEEK.map((day) => {
                  const on = f.days.includes(day);
                  return (
                    <button
                      key={day}
                      type="button"
                      aria-pressed={on}
                      onClick={() => onChange({ ...f, days: on ? f.days.filter((x) => x !== day) : [...f.days, day] })}
                      className={cn('h-8 min-w-10 rounded-lg px-2 text-sm font-medium ring-1 ring-inset', on ? 'bg-accent text-white ring-accent' : 'bg-surface text-fg-muted ring-line-strong hover:text-fg')}
                    >
                      {weekdayName(day, lang)}
                    </button>
                  );
                })}
              </span>
              {t('schedule.freq.at')} {time(f.time, (v) => ({ ...f, time: v }))}
            </>
          )}
          {f.kind === 'monthly' && (
            <>
              {t('schedule.freq.onDay')}
              <Select value={f.day} className="w-auto" onChange={(e) => onChange({ ...f, day: Number(e.target.value) })}>
                {Array.from({ length: 28 }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n}.
                  </option>
                ))}
              </Select>
              {t('schedule.freq.at')} {time(f.time, (v) => ({ ...f, time: v }))}
            </>
          )}
          {f.kind === 'custom' && (
            <Input value={f.cron} className="max-w-xs font-mono" placeholder="0 3 * * *" onChange={(e) => onChange({ kind: 'custom', cron: e.target.value })} aria-label={t('schedule.cron')} />
          )}
        </div>
      </div>
    </Field>
  );
}
