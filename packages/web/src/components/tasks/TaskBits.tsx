import { Fragment } from 'react';
import { localize, type TaskPriority, type TaskStatus, type Workflow } from '@cocoon/protocol';
import { ArrowDown, ChevronRight, Flag, Hand, Workflow as WorkflowIcon } from 'lucide-react';
import { useLanguage, useT } from '../../i18n';
import { cn } from '../../lib/cn';
import { profileLabel } from '../../lib/profiles';
import { taskStatusMeta, workflowLabel } from '../../lib/tasks';
import { useSettings } from '../../api/queries';
import { Badge, StatusDot } from '../Badge';
import { ChoiceCard } from '../Field';

export function TaskStatusBadge({ status, className }: { status: TaskStatus; className?: string }) {
  const t = useT();
  const m = taskStatusMeta(t, status);
  return (
    <Badge tone={m.tone} title={m.explanation} className={className}>
      <StatusDot tone={m.tone} animated={m.animated} />
      {m.label}
    </Badge>
  );
}

export function PriorityIcon({ priority, className }: { priority: TaskPriority; className?: string }) {
  const t = useT();
  if (priority === 'normal') return null;
  return priority === 'high' ? (
    <Flag className={cn('size-3.5 shrink-0 fill-red-500 text-red-500', className)} aria-label={t('task.priority.high')} />
  ) : (
    <ArrowDown className={cn('size-3.5 shrink-0 text-fg-subtle', className)} aria-label={t('task.priority.low')} />
  );
}

/** "Plan ✋ → Build → Review" – the stages of a workflow as chips. `current` highlights a stage. */
export function StageChips({ workflow, current, small }: { workflow: Workflow; current?: number; small?: boolean }) {
  const t = useT();
  const { lang } = useLanguage();
  const settings = useSettings();
  return (
    <span className="flex flex-wrap items-center gap-1">
      {workflow.stages.map((s, i) => (
        <Fragment key={i}>
          {i > 0 && <ChevronRight className="size-3 text-fg-subtle" />}
          <span
            title={`${profileLabel(s.agentKind, settings.data?.agents[s.agentKind], lang)}${s.approval ? ` · ${t('workflowCards.approval')}` : ''}`}
            className={cn(
              'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 ring-1 ring-inset',
              small ? 'text-[11px]' : 'text-xs',
              current === i
                ? 'bg-accent-soft font-semibold text-accent ring-accent/30'
                : current !== undefined && i < current
                  ? 'bg-emerald-500/10 text-emerald-700 ring-emerald-500/20 dark:text-emerald-300'
                  : 'bg-surface-2 text-fg-muted ring-line',
            )}
          >
            {localize(s.name, lang)}
            {s.approval && <Hand className="size-3" />}
          </span>
        </Fragment>
      ))}
    </span>
  );
}

/** Workflows from settings as selectable cards with their stages. */
export function WorkflowCards({ workflows, value, onChange }: { workflows: Array<[string, Workflow]>; value: string; onChange: (id: string) => void }) {
  const { lang } = useLanguage();
  return (
    <div className="grid gap-2.5">
      {workflows.map(([id, wf]) => (
        <ChoiceCard
          key={id}
          selected={value === id}
          onSelect={() => onChange(id)}
          icon={<WorkflowIcon className="size-5" />}
          title={workflowLabel(id, wf, lang)}
          description={
            <span className="block space-y-2">
              {localize(wf.description, lang) && <span className="block">{localize(wf.description, lang)}</span>}
              <StageChips workflow={wf} />
            </span>
          }
        />
      ))}
    </div>
  );
}
