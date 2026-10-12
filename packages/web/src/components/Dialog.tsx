import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { rich, useT } from '../i18n';
import { cn } from '../lib/cn';
import { Button } from './Button';
import { Input } from './Field';

const SIZES = { sm: 'max-w-md', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' };

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: keyof typeof SIZES;
  /** Prevent closing via backdrop/Escape (e.g. while a request runs). */
  dismissable?: boolean;
}

export function Dialog({ open, onClose, title, description, children, footer, size = 'md', dismissable = true }: DialogProps) {
  const t = useT();
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dismissable) onClose();
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // Focus the first form field (or the panel) for keyboard users.
    const t = setTimeout(() => {
      const el = panelRef.current?.querySelector<HTMLElement>('[data-autofocus], input:not([type=hidden]):not([disabled]), textarea, select');
      (el ?? panelRef.current)?.focus();
    }, 10);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
      clearTimeout(t);
    };
  }, [open, dismissable, onClose]);

  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:p-8">
      <div className="fixed inset-0 bg-black/40 backdrop-blur-[2px]" onClick={() => dismissable && onClose()} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cn('animate-in relative my-auto w-full rounded-2xl border border-line bg-surface shadow-2xl outline-none', SIZES[size])}
      >
        <div className="flex items-start gap-3 px-6 pt-5 pb-3">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-lg font-semibold text-fg">
              {title}
            </h2>
            {description && <div className="mt-1 text-sm text-fg-muted">{description}</div>}
          </div>
          {dismissable && (
            <button onClick={onClose} className="rounded-md p-1 text-fg-subtle hover:bg-surface-2 hover:text-fg" aria-label={t('common.close')}>
              <X className="size-5" />
            </button>
          )}
        </div>
        {children && <div className="px-6 pb-4">{children}</div>}
        {footer && <div className="flex flex-wrap justify-end gap-2 rounded-b-2xl border-t border-line bg-surface-2/60 px-6 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: ReactNode;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  loading?: boolean;
  /** If set, the user must type this text to enable the confirm button. */
  typeToConfirm?: string;
}

export function ConfirmDialog({ open, onClose, onConfirm, title, message, confirmLabel, danger, loading, typeToConfirm }: ConfirmDialogProps) {
  const t = useT();
  const [typed, setTyped] = useState('');
  useEffect(() => {
    if (open) setTyped('');
  }, [open]);
  const blocked = typeToConfirm !== undefined && typed.trim() !== typeToConfirm;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      dismissable={!loading}
      footer={
        <>
          <Button onClick={onClose} disabled={loading}>
            {t('common.cancel')}
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={loading} disabled={blocked} data-autofocus={typeToConfirm ? undefined : true}>
            {confirmLabel ?? t('common.confirm')}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm text-fg-muted">
        <div>{message}</div>
        {typeToConfirm !== undefined && (
          <div>
            <label className="mb-1.5 block text-sm text-fg">
              {rich(t('common.typeToConfirm'), {
                text: <span className="rounded bg-surface-2 px-1.5 py-0.5 font-mono font-semibold">{typeToConfirm}</span>,
              })}
            </label>
            <Input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !blocked && onConfirm()}
              autoComplete="off"
            />
          </div>
        )}
      </div>
    </Dialog>
  );
}
