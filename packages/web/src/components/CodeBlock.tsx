import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { useT } from '../i18n';
import { cn } from '../lib/cn';

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for non-secure contexts (plain http on a LAN IP).
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

export function CopyButton({ text, label, className }: { text: string; label?: string; className?: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        if (await copyToClipboard(text)) {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }
      }}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors',
        copied ? 'text-emerald-500' : 'text-gray-400 hover:bg-white/10 hover:text-white',
        className,
      )}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {copied ? t('common.copied') : (label ?? t('common.copy'))}
    </button>
  );
}

/** Dark code/command block with a copy button. */
export function CodeBlock({ code, className, title }: { code: string; className?: string; title?: string }) {
  return (
    <div className={cn('overflow-hidden rounded-xl bg-gray-950 ring-1 ring-white/10', className)}>
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-1.5">
        <span className="text-xs text-gray-400">{title ?? ''}</span>
        <CopyButton text={code} />
      </div>
      <pre className="overflow-x-auto px-4 py-3 font-mono text-[13px] leading-relaxed text-gray-100">
        <code>{code}</code>
      </pre>
    </div>
  );
}
