import { Check, ClipboardCheck, Hand, MessageSquareReply, X } from 'lucide-react';
import { rpc } from '../../api/rpc';
import { useAction } from '../../api/useAction';
import { useSettings } from '../../api/queries';
import { useAppDialogs } from '../../components/AppDialogs';
import { Button } from '../../components/Button';
import { useOpenTask, useTaskActions } from '../../components/tasks/useTaskActions';
import { useLanguage, useT } from '../../i18n';
import { cn } from '../../lib/cn';
import { formatRelative } from '../../lib/format';
import { profileLabel } from '../../lib/profiles';
import { attentionItems, useCockpit, useCockpitActions, type AttentionItem } from './context';

/** "Waiting for you": blocked agents and tasks in review, with one-click answers. */
export function AttentionList({ compact, emptyText }: { compact?: boolean; emptyText?: string }) {
  const t = useT();
  const data = useCockpit();
  const items = attentionItems(data);
  if (!items.length) {
    return <p className={cn('text-fg-subtle', compact ? 'px-2 py-1.5 text-xs' : 'px-1 py-4 text-sm')}>{emptyText ?? t('cockpit.attention.empty')}</p>;
  }
  return (
    <ul className={cn(compact ? 'space-y-1' : 'space-y-2')}>
      {items.map((item) => (
        <AttentionRow key={item.id} item={item} compact={compact} />
      ))}
    </ul>
  );
}

function AttentionRow({ item, compact }: { item: AttentionItem; compact?: boolean }) {
  const t = useT();
  const { lang } = useLanguage();
  const settings = useSettings();
  const data = useCockpit();
  const { focusAgent, shownAgents } = useCockpitActions();
  const openTask = useOpenTask();
  const dialogs = useAppDialogs();
  const { approve } = useTaskActions();
  const keys = useAction((v: { agentId: string; keys: string[] }) => rpc('agent.send_keys', v), { error: t('agentDetail.keysFailed') });

  if (item.kind === 'agent') {
    const a = item.agent;
    const sandbox = data.sandboxById.get(a.sandboxId);
    return (
      <li className={cn('rounded-lg border border-amber-400/60 bg-amber-400/10', compact ? 'p-1.5' : 'p-2.5')}>
        <button type="button" onClick={() => focusAgent(a.id)} className="flex w-full items-start gap-2 text-left" title={t('cockpit.attention.focus')}>
          <Hand className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <span className="min-w-0 flex-1">
            <span className={cn('block truncate font-medium text-fg', compact ? 'text-xs' : 'text-sm')}>{item.task?.title ?? profileLabel(a.kind, settings.data?.agents[a.kind], lang)}</span>
            <span className="block truncate text-[11px] text-fg-muted">
              {item.task ? `${profileLabel(a.kind, settings.data?.agents[a.kind], lang)} · ` : ''}
              {sandbox?.name ?? a.sandboxId} · {formatRelative(item.since, Date.now(), lang)}
            </span>
          </span>
          {shownAgents.has(a.id) && <span className="mt-0.5 size-1.5 shrink-0 rounded-full bg-accent" title={t('cockpit.rail.shown')} />}
        </button>
        <div className="mt-1.5 flex gap-1 pl-5">
          <Button size="sm" variant="success" className="h-6 px-2" icon={<Check className="size-3" />} onClick={() => keys.mutate({ agentId: a.id, keys: ['Enter'] })} title={t('cockpit.pane.yesHint')}>
            {t('common.yes')}
          </Button>
          <Button size="sm" className="h-6 px-2" icon={<X className="size-3" />} onClick={() => keys.mutate({ agentId: a.id, keys: ['Escape'] })} title={t('cockpit.pane.noHint')}>
            {t('common.no')}
          </Button>
        </div>
      </li>
    );
  }

  const task = item.task;
  return (
    <li className={cn('rounded-lg border border-line bg-surface', compact ? 'p-1.5' : 'p-2.5')}>
      <button type="button" onClick={() => openTask(task.id)} className="flex w-full items-start gap-2 text-left" title={t('cockpit.attention.openTask')}>
        <ClipboardCheck className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
        <span className="min-w-0 flex-1">
          <span className={cn('block truncate font-medium text-fg', compact ? 'text-xs' : 'text-sm')}>{task.title}</span>
          <span className="block truncate text-[11px] text-fg-muted">
            {t('cockpit.attention.review')} · {formatRelative(item.since, Date.now(), lang)}
          </span>
        </span>
      </button>
      <div className="mt-1.5 flex flex-wrap gap-1 pl-5">
        <Button size="sm" variant="success" className="h-6 px-2" icon={<Check className="size-3" />} loading={approve.isPending} onClick={() => approve.mutate(task.id)}>
          {t('taskCard.approve')}
        </Button>
        <Button size="sm" className="h-6 px-2" icon={<MessageSquareReply className="size-3" />} onClick={() => dialogs.reject(task)}>
          {t('cockpit.attention.changes')}
        </Button>
        {item.agent && item.agent.status !== 'exited' && (
          <Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => focusAgent(item.agent!.id)}>
            {t('cockpit.attention.show')}
          </Button>
        )}
      </div>
    </li>
  );
}
