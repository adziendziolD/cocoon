import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

export interface TabDef<T extends string> {
  id: T;
  label: ReactNode;
  icon?: ReactNode;
  count?: number;
  /** Highlight count in amber (e.g. blocked agents). */
  attention?: boolean;
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: TabDef<T>[]; value: T; onChange: (id: T) => void }) {
  return (
    <div className="mb-5 flex gap-1 overflow-x-auto border-b border-line" role="tablist">
      {tabs.map((t) => {
        const active = t.id === value;
        return (
          <button
            key={t.id}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.id)}
            className={cn(
              '-mb-px flex items-center gap-2 border-b-2 px-3.5 py-2.5 text-sm font-medium whitespace-nowrap transition-colors',
              active ? 'border-accent text-fg' : 'border-transparent text-fg-muted hover:border-line-strong hover:text-fg',
            )}
          >
            {t.icon}
            {t.label}
            {t.count !== undefined && t.count > 0 && (
              <span
                className={cn(
                  'rounded-full px-1.5 py-px text-xs',
                  t.attention ? 'bg-amber-400 font-semibold text-amber-950' : 'bg-surface-2 text-fg-muted',
                )}
              >
                {t.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
