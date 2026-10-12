import { Link } from 'react-router-dom';
import type { ActivityEntry, Sandbox } from '@cocoon/protocol';
import { CircleAlert, Info, TriangleAlert } from 'lucide-react';
import { useT } from '../i18n';
import { formatDateTime, formatRelative } from '../lib/format';

const LEVEL = {
  info: <Info className="size-4 text-blue-500" />,
  warn: <TriangleAlert className="size-4 text-amber-500" />,
  error: <CircleAlert className="size-4 text-red-500" />,
};

export function ActivityList({ entries, sandboxes, compact }: { entries: ActivityEntry[]; sandboxes?: Sandbox[]; compact?: boolean }) {
  const t = useT();
  const sbName = (id: string) => sandboxes?.find((s) => s.id === id)?.name;
  return (
    <ul className="divide-y divide-line">
      {entries.map((e) => (
        <li key={e.id} className={compact ? 'flex gap-3 px-4 py-2.5' : 'flex gap-3 px-5 py-3'}>
          <div className="mt-0.5 shrink-0">{LEVEL[e.level] ?? LEVEL.info}</div>
          <div className="min-w-0 flex-1">
            <div className="text-sm break-words text-fg">{e.message}</div>
            <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-fg-subtle">
              <span title={formatDateTime(e.at)}>{formatRelative(e.at)}</span>
              {e.sandboxId && (
                <Link to={`/sandboxes/${e.sandboxId}`} className="hover:text-accent hover:underline">
                  {t('activity.sandboxLink', { name: sbName(e.sandboxId) ?? e.sandboxId })}
                </Link>
              )}
              {e.agentId && (
                <Link to={`/agents/${e.agentId}`} className="hover:text-accent hover:underline">
                  {t('activity.viewAgent')}
                </Link>
              )}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
