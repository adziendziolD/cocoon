import { useState } from 'react';
import type { ActivityEntry } from '@cocoon/protocol';
import { Activity } from 'lucide-react';
import { useActivity, useSandboxes } from '../api/queries';
import { ActivityList } from '../components/ActivityList';
import { Card, PageHeader } from '../components/Card';
import { EmptyState } from '../components/EmptyState';
import { ErrorState, LoadingState } from '../components/States';
import { useT, type MessageKey } from '../i18n';
import { cn } from '../lib/cn';

type Level = 'all' | ActivityEntry['level'];
const LEVELS: Array<{ id: Level; label: MessageKey }> = [
  { id: 'all', label: 'activityPage.filter.all' },
  { id: 'info', label: 'activityPage.filter.info' },
  { id: 'warn', label: 'activityPage.filter.warn' },
  { id: 'error', label: 'activityPage.filter.error' },
];

export function ActivityPage() {
  const t = useT();
  const activity = useActivity();
  const sandboxes = useSandboxes();
  const [level, setLevel] = useState<Level>('all');
  const entries = (activity.data ?? []).filter((e) => level === 'all' || e.level === level);

  return (
    <>
      <PageHeader title={t('activityPage.title')} description={t('activityPage.description')} />
      <div className="mb-4 flex gap-2">
        {LEVELS.map((l) => (
          <button
            key={l.id}
            onClick={() => setLevel(l.id)}
            className={cn(
              'rounded-full border px-3 py-1 text-sm',
              level === l.id ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-surface text-fg-muted hover:text-fg',
            )}
          >
            {t(l.label)}
          </button>
        ))}
      </div>
      {activity.isLoading ? (
        <LoadingState />
      ) : activity.error ? (
        <ErrorState error={activity.error} onRetry={() => activity.refetch()} />
      ) : entries.length === 0 ? (
        <EmptyState icon={<Activity className="size-6" />} title={t('activityPage.empty')}>
          {level === 'all' ? t('activityPage.emptyAll') : t('activityPage.emptyFilter')}
        </EmptyState>
      ) : (
        <Card>
          <ActivityList entries={entries} sandboxes={sandboxes.data} />
        </Card>
      )}
    </>
  );
}
