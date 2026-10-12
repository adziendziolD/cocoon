import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../lib/cn';

/**
 * Minimal click-to-open popover (menus, pickers). Rendered in a portal with fixed positioning, so it is never
 * clipped by scrolling/overflow containers (e.g. cockpit panes). Closes on outside click, Escape, scroll and resize.
 * `children` may be a function receiving `close`.
 */
export function Popover({
  trigger,
  children,
  align = 'left',
  side = 'bottom',
  className,
  panelClassName,
}: {
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
  align?: 'left' | 'right';
  side?: 'bottom' | 'top';
  className?: string;
  panelClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden' });
  const ref = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !ref.current || !panelRef.current) return;
    const r = ref.current.getBoundingClientRect();
    const p = panelRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let top = side === 'top' ? r.top - p.height - 6 : r.bottom + 6;
    // Flip when there is not enough room.
    if (side === 'bottom' && top + p.height > vh - 8 && r.top - p.height - 6 > 8) top = r.top - p.height - 6;
    if (side === 'top' && top < 8) top = r.bottom + 6;
    let left = align === 'right' ? r.right - p.width : r.left;
    left = Math.max(8, Math.min(left, vw - p.width - 8));
    setStyle({ top: Math.max(8, top), left, maxHeight: vh - 16 });
  }, [open, align, side]);

  useEffect(() => {
    if (!open) return;
    const inside = (n: EventTarget | null) => !!n && ((ref.current?.contains(n as Node) ?? false) || (panelRef.current?.contains(n as Node) ?? false));
    const onDown = (e: MouseEvent) => {
      if (!inside(e.target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onScroll = (e: Event) => {
      if (!inside(e.target)) setOpen(false);
    };
    const onResize = () => setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);

  useEffect(() => {
    if (!open) setStyle({ visibility: 'hidden' });
  }, [open]);

  const close = () => setOpen(false);
  return (
    <div ref={ref} className={cn('relative inline-flex', className)}>
      {trigger({ open, toggle: () => setOpen((o) => !o) })}
      {open &&
        createPortal(
          <div
            ref={panelRef}
            style={{ position: 'fixed', ...style }}
            className={cn('animate-in z-[55] min-w-56 overflow-y-auto rounded-xl border border-line bg-surface p-1.5 text-left shadow-xl', panelClassName)}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {typeof children === 'function' ? children(close) : children}
          </div>,
          document.body,
        )}
    </div>
  );
}

export function MenuItem({
  onClick,
  children,
  icon,
  active,
  danger,
  disabled,
  hint,
}: {
  onClick: () => void;
  children: ReactNode;
  icon?: ReactNode;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
  hint?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors disabled:opacity-50',
        active ? 'bg-accent-soft text-accent' : danger ? 'text-red-600 hover:bg-red-500/10 dark:text-red-400' : 'text-fg hover:bg-surface-2',
      )}
    >
      {icon && <span className="flex size-4 shrink-0 items-center justify-center">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint && <span className="shrink-0 text-xs text-fg-subtle">{hint}</span>}
    </button>
  );
}

export const MenuSeparator = () => <div className="my-1 h-px bg-line" />;
