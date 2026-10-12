import { useEffect, useState } from 'react';
import type { Task, Workspace } from '@cocoon/protocol';
import { Hand, Minus, Plus, Zap } from 'lucide-react';
import { qk } from '../../api/keys';
import { rpc } from '../../api/rpc';
import { useAction } from '../../api/useAction';
import { useT } from '../../i18n';
import { cn } from '../../lib/cn';
import { InfoTip } from '../HelpText';

/** Workspace header for boards: auto-run switch, parallel limit and live counts. */
export function AutomationBar({ workspace, tasks, compact }: { workspace: Workspace; tasks: Task[]; compact?: boolean }) {
  const t = useT();
  const [max, setMax] = useState(workspace.maxParallel);
  useEffect(() => setMax(workspace.maxParallel), [workspace.maxParallel]);

  const update = useAction((patch: { autoRun?: boolean; maxParallel?: number }) => rpc('workspace.update', { workspaceId: workspace.id, ...patch }), {
    error: t('common.saveFailed'),
    invalidate: [qk.workspaces],
  });

  // Debounce the stepper so clicking +/+/+ sends one request.
  useEffect(() => {
    if (max === workspace.maxParallel) return;
    const id = setTimeout(() => update.mutate({ maxParallel: max }), 600);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [max]);

  const running = tasks.filter((x) => x.status === 'running').length;
  const queued = tasks.filter((x) => x.status === 'queued').length;
  const review = tasks.filter((x) => x.status === 'review').length;
  const attention = tasks.filter((x) => x.attention && x.status === 'running').length;
  const on = workspace.autoRun;

  return (
    <div className={cn('flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-line bg-surface', compact ? 'px-3 py-1.5 text-xs' : 'px-4 py-2.5 text-sm')}>
      <label className="flex cursor-pointer items-center gap-2">
        <button
          type="button"
          role="switch"
          aria-checked={on}
          disabled={update.isPending}
          onClick={() => update.mutate({ autoRun: !on })}
          className={cn('relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-60', on ? 'bg-accent' : 'bg-line-strong')}
        >
          <span className={cn('inline-block size-4 rounded-full bg-white shadow transition-transform', on ? 'translate-x-4.5' : 'translate-x-0.5')} />
        </button>
        <Zap className={cn('size-4', on ? 'text-accent' : 'text-fg-subtle')} />
        <span className="font-medium text-fg">{t('automation.autoRun')}</span>
        {!compact && <InfoTip>{t('workspaceForm.autoRunHint')}</InfoTip>}
      </label>
      <div className="flex items-center gap-2" title={t('workspaceForm.maxParallelHint')}>
        <span className="text-fg-muted">{t('automation.parallel')}</span>
        <div className="inline-flex items-center rounded-lg ring-1 ring-line-strong ring-inset">
          <button type="button" className="p-1 text-fg-muted hover:text-fg disabled:opacity-40" disabled={max <= 1} onClick={() => setMax((m) => Math.max(1, m - 1))} aria-label="-">
            <Minus className="size-3.5" />
          </button>
          <span className="w-6 text-center font-medium text-fg tabular-nums">{max}</span>
          <button type="button" className="p-1 text-fg-muted hover:text-fg disabled:opacity-40" disabled={max >= 20} onClick={() => setMax((m) => Math.min(20, m + 1))} aria-label="+">
            <Plus className="size-3.5" />
          </button>
        </div>
      </div>
      <span className="flex-1" />
      <span className="text-fg-muted">
        {t('automation.counts', { running, max: workspace.maxParallel, queued })}
      </span>
      {review > 0 && <span className="font-medium text-amber-700 dark:text-amber-400">{t('automation.review', { count: review })}</span>}
      {attention > 0 && (
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-400 px-2 py-0.5 text-xs font-semibold text-amber-950">
          <Hand className="size-3" /> {t('automation.attention', { count: attention })}
        </span>
      )}
    </div>
  );
}
