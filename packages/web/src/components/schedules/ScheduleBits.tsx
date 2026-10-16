import type { ReactNode } from 'react';
import type { ScheduleTemplate, TaskReport } from '@cocoon/protocol';
import { CalendarClock, ListChecks, PackageSearch, PenLine, ShieldCheck } from 'lucide-react';
import { useT } from '../../i18n';
import { Badge } from '../Badge';

const ICONS: Record<ScheduleTemplate, typeof ListChecks> = { checks: ListChecks, dependencies: PackageSearch, security: ShieldCheck, custom: PenLine };

export function TemplateIcon({ template, className = 'size-5' }: { template: ScheduleTemplate | undefined; className?: string }) {
  const Icon = template ? ICONS[template] : CalendarClock;
  return <Icon className={className} />;
}

/** Result of a scheduled run according to its agent's report. */
export function ReportBadge({ report }: { report: TaskReport }) {
  const t = useT();
  const tone = report.status === 'ok' ? 'green' : report.status === 'action_needed' ? 'amber' : 'gray';
  return <Badge tone={tone}>{t(`schedule.report.${report.status}`)}</Badge>;
}

/** Small "scheduled" marker for task cards. */
export function ScheduledTag({ name, children }: { name?: string; children?: ReactNode }) {
  const t = useT();
  return (
    <span className="inline-flex min-w-0 items-center gap-1 text-xs text-fg-muted" title={name ? t('schedule.runOf', { name }) : t('schedule.runOfDeleted')}>
      <CalendarClock className="size-3.5 shrink-0" />
      <span className="truncate">{name ?? t('schedule.scheduled')}</span>
      {children}
    </span>
  );
}
