import { useState, type ReactNode } from 'react';
import { CircleAlert, CircleCheck, CircleHelp, Info, TriangleAlert } from 'lucide-react';
import { useT } from '../i18n';
import { cn } from '../lib/cn';

type CalloutTone = 'info' | 'warning' | 'danger' | 'success' | 'tip';

const CALLOUT: Record<CalloutTone, { cls: string; icon: ReactNode }> = {
  info: { cls: 'border-blue-500/20 bg-blue-500/5', icon: <Info className="size-4.5 text-blue-600 dark:text-blue-400" /> },
  tip: { cls: 'border-accent/20 bg-accent-soft', icon: <CircleHelp className="size-4.5 text-accent" /> },
  warning: { cls: 'border-amber-500/40 bg-amber-400/10', icon: <TriangleAlert className="size-4.5 text-amber-600 dark:text-amber-400" /> },
  danger: { cls: 'border-red-500/30 bg-red-500/5', icon: <CircleAlert className="size-4.5 text-red-600 dark:text-red-400" /> },
  success: { cls: 'border-emerald-500/25 bg-emerald-500/5', icon: <CircleCheck className="size-4.5 text-emerald-600 dark:text-emerald-400" /> },
};

/** Inline explanation box. Used everywhere to explain concepts in plain words. */
export function Callout({ tone = 'info', title, children, action, className }: { tone?: CalloutTone; title?: ReactNode; children?: ReactNode; action?: ReactNode; className?: string }) {
  const c = CALLOUT[tone];
  return (
    <div className={cn('flex gap-3 rounded-xl border px-4 py-3 text-sm', c.cls, className)}>
      <div className="mt-0.5 shrink-0">{c.icon}</div>
      <div className="min-w-0 flex-1">
        {title && <div className="font-medium text-fg">{title}</div>}
        {children && <div className={cn('leading-relaxed text-fg-muted', !!title && 'mt-0.5')}>{children}</div>}
        {action && <div className="mt-2.5 flex flex-wrap gap-2">{action}</div>}
      </div>
    </div>
  );
}

/** Small "?" with a hover/focus tooltip for short explanations. */
export function InfoTip({ children, className }: { children: ReactNode; className?: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <span className={cn('relative inline-flex align-middle', className)}>
      <button
        type="button"
        className="text-fg-subtle hover:text-fg-muted focus:text-fg-muted focus:outline-none"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen((o) => !o)}
        aria-label={t('common.explanation')}
      >
        <CircleHelp className="size-3.5" />
      </button>
      {open && (
        <span className="absolute bottom-full left-1/2 z-40 mb-2 w-64 -translate-x-1/2 rounded-lg bg-gray-900 px-3 py-2 text-xs leading-relaxed font-normal text-white shadow-lg dark:bg-gray-700">
          {children}
        </span>
      )}
    </span>
  );
}
