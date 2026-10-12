import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

export function EmptyState({ icon, title, children, action, className }: { icon?: ReactNode; title: ReactNode; children?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center rounded-xl border border-dashed border-line-strong px-6 py-10 text-center', className)}>
      {icon && <div className="mb-3 rounded-full bg-surface-2 p-3 text-fg-muted">{icon}</div>}
      <h3 className="text-base font-semibold text-fg">{title}</h3>
      {children && <div className="mt-1.5 max-w-md text-sm leading-relaxed text-fg-muted">{children}</div>}
      {action && <div className="mt-5 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}
