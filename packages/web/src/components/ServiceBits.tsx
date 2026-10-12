import { useState } from 'react';
import type { ServiceStatus } from '@cocoon/protocol';
import { Check, Copy, Eye, EyeOff } from 'lucide-react';
import { useT } from '../i18n';
import { cn } from '../lib/cn';
import { maskSecret, serviceStatusMeta } from '../lib/services';
import { Badge, StatusDot } from './Badge';
import { copyToClipboard } from './CodeBlock';

export function ServiceStatusBadge({ status }: { status: ServiceStatus }) {
  const t = useT();
  const meta = serviceStatusMeta(t, status);
  return (
    <Badge tone={meta.tone} title={meta.explanation}>
      <StatusDot tone={meta.tone} animated={meta.animated} />
      {meta.label}
    </Badge>
  );
}

/** Small copy button for light backgrounds. */
export function InlineCopy({ text, className }: { text: string; className?: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title={t('common.copy')}
      aria-label={t('common.copy')}
      onClick={async () => {
        if (await copyToClipboard(text)) {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }
      }}
      className={cn('shrink-0 rounded-md p-1 text-fg-subtle hover:bg-surface-2 hover:text-fg', copied && 'text-emerald-600', className)}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </button>
  );
}

/**
 * A value (URL, password) shown in monospace with copy button. If `secret` is given, it is masked until revealed;
 * copying always copies the real value.
 */
export function SecretValue({ value, secret, mask }: { value: string; secret?: string; mask?: boolean }) {
  const t = useT();
  const [show, setShow] = useState(false);
  const hidden = !show && (mask || !!secret);
  const shown = hidden ? (mask ? '••••••••' : maskSecret(value, secret)) : value;
  return (
    <div className="flex min-w-0 items-center gap-1 rounded-lg bg-surface-2/70 py-1 pr-1 pl-2.5">
      <code className="min-w-0 flex-1 font-mono text-[12.5px] break-all text-fg">{shown}</code>
      {(mask || secret) && (
        <button
          type="button"
          onClick={() => setShow((s) => !s)}
          title={show ? t('common.hide') : t('common.show')}
          aria-label={show ? t('common.hide') : t('common.show')}
          className="shrink-0 rounded-md p-1 text-fg-subtle hover:bg-surface-2 hover:text-fg"
        >
          {show ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
        </button>
      )}
      <InlineCopy text={value} />
    </div>
  );
}
