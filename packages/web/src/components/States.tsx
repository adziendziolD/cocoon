import { Loader2, RefreshCw, ServerCrash } from 'lucide-react';
import { describeError } from '../api/rpc';
import { useT } from '../i18n';
import { cn } from '../lib/cn';
import { Button } from './Button';

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('size-4 animate-spin text-fg-subtle', className)} />;
}

export function LoadingState({ label, className }: { label?: string; className?: string }) {
  const t = useT();
  return (
    <div className={cn('flex items-center justify-center gap-2 py-10 text-sm text-fg-muted', className)}>
      <Spinner />
      {label ?? t('common.loading')}
    </div>
  );
}

export function ErrorState({ error, onRetry, title, className }: { error: unknown; onRetry?: () => void; title?: string; className?: string }) {
  const t = useT();
  return (
    <div className={cn('flex flex-col items-center gap-2 rounded-xl border border-red-500/25 bg-red-500/5 px-6 py-8 text-center', className)}>
      <ServerCrash className="size-6 text-red-500" />
      <div className="font-medium text-fg">{title ?? t('common.loadFailed')}</div>
      <div className="max-w-lg text-sm text-fg-muted">{describeError(error)}</div>
      {onRetry && (
        <Button size="sm" onClick={onRetry} icon={<RefreshCw className="size-3.5" />} className="mt-2">
          {t('common.retry')}
        </Button>
      )}
    </div>
  );
}
