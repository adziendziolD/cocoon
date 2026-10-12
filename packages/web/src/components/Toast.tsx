import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CircleAlert, CircleCheck, Info, X } from 'lucide-react';
import { useT } from '../i18n';
import { cn } from '../lib/cn';

type Kind = 'success' | 'error' | 'info';
interface ToastItem {
  id: number;
  kind: Kind;
  title: string;
  message?: string;
}

interface ToastApi {
  success: (title: string, message?: string) => void;
  error: (title: string, message?: string) => void;
  info: (title: string, message?: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);
let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const t = useT();
  const [items, setItems] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: number) => setItems((all) => all.filter((t) => t.id !== id)), []);

  const push = useCallback(
    (kind: Kind, title: string, message?: string) => {
      const id = nextId++;
      setItems((all) => [...all.slice(-4), { id, kind, title, message }]);
      // Errors stay longer so beginners can read them.
      setTimeout(() => dismiss(id), kind === 'error' ? 10_000 : 4_000);
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      success: (t, m) => push('success', t, m),
      error: (t, m) => push('error', t, m),
      info: (t, m) => push('info', t, m),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      {createPortal(
        <div className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-[min(400px,calc(100vw-2rem))] flex-col gap-2" aria-live="polite">
          {items.map((item) => (
            <div
              key={item.id}
              className={cn(
                'animate-in pointer-events-auto flex items-start gap-3 rounded-xl border bg-surface p-3.5 shadow-lg',
                item.kind === 'error' ? 'border-red-500/30' : item.kind === 'success' ? 'border-emerald-500/30' : 'border-line',
              )}
            >
              {item.kind === 'success' && <CircleCheck className="mt-0.5 size-5 shrink-0 text-emerald-600" />}
              {item.kind === 'error' && <CircleAlert className="mt-0.5 size-5 shrink-0 text-red-600" />}
              {item.kind === 'info' && <Info className="mt-0.5 size-5 shrink-0 text-accent" />}
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-fg">{item.title}</div>
                {item.message && <div className="mt-0.5 text-sm break-words text-fg-muted">{item.message}</div>}
              </div>
              <button onClick={() => dismiss(item.id)} className="text-fg-subtle hover:text-fg" aria-label={t('common.close')}>
                <X className="size-4" />
              </button>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}
