import { useState } from 'react';
import type { ProviderKind } from '@cocoon/protocol';
import { Check, CircleAlert, CircleCheck, Plus, Star, X } from 'lucide-react';
import { useT } from '../i18n';
import { cn } from '../lib/cn';
import type { TestResult } from '../lib/providers';
import { Badge } from './Badge';
import { ProviderCompat } from './CompatBits';
import { Input } from './Field';
import { formatTokens } from '../lib/modelLimits';
import { limitsSummary } from './ModelLimits';

export function KindBadge({ kind }: { kind: ProviderKind }) {
  const t = useT();
  return <Badge tone={kind === 'anthropic' ? 'amber' : kind === 'openai' ? 'green' : 'blue'}>{t(`providers.kind.${kind}.short`)}</Badge>;
}

export function KeyBadge({ status }: { status: 'none' | 'set' | 'missing' }) {
  const t = useT();
  if (status === 'set') return <Badge tone="green">{t('providers.key.set')}</Badge>;
  if (status === 'missing') return <Badge tone="amber">{t('providers.key.missing')}</Badge>;
  return <Badge tone="gray">{t('providers.key.none')}</Badge>;
}

/** Result of providers.test: success/failure, message and (optionally pickable) discovered models. */
export function ProviderTestResult({
  result,
  onDismiss,
  models,
  defaultModel,
  onAddModel,
  onDefaultModel,
  kind,
  limitModels,
}: {
  result: TestResult;
  /** Models whose detected context window / answer length should be listed (e.g. the provider's models). */
  limitModels?: string[];
  /** Provider kind: model providers (not http) also get the detected APIs and the agent compatibility matrix. */
  kind?: ProviderKind;
  onDismiss?: () => void;
  models?: string[];
  defaultModel?: string;
  onAddModel?: (m: string) => void;
  onDefaultModel?: (m: string) => void;
}) {
  const t = useT();
  const [filter, setFilter] = useState('');
  const found = result.models.filter((m) => m.toLowerCase().includes(filter.toLowerCase()));
  const shown = found.slice(0, 80);
  const info = result.modelInfo ?? {};
  const ctx = (m: string) => {
    const cw = info[m]?.contextWindow;
    return cw !== undefined ? <span className="ml-1 text-fg-subtle" title={t('limits.contextShort', { value: formatTokens(cw) })}>· {formatTokens(cw)}</span> : null;
  };
  const detected = (limitModels ? Array.from(new Set(limitModels)) : [])
    .map((m) => [m, limitsSummary(t, info[m]?.contextWindow, info[m]?.maxOutputTokens)] as const)
    .filter((x): x is readonly [string, string] => !!x[1]);
  return (
    <div className={cn('rounded-xl border px-4 py-3 text-sm', result.ok ? 'border-emerald-500/25 bg-emerald-500/5' : 'border-red-500/30 bg-red-500/5')}>
      <div className="flex items-start gap-2.5">
        {result.ok ? <CircleCheck className="mt-0.5 size-4.5 shrink-0 text-emerald-600" /> : <CircleAlert className="mt-0.5 size-4.5 shrink-0 text-red-600" />}
        <div className="min-w-0 flex-1">
          <div className="font-medium text-fg">
            {result.ok ? t('providers.test.ok') : t('providers.test.error')}
            {result.status !== undefined && <span className="ml-2 font-mono text-xs font-normal text-fg-subtle">HTTP {result.status}</span>}
          </div>
          <div className="mt-0.5 break-words text-fg-muted">{result.message}</div>
        </div>
        {onDismiss && (
          <button type="button" onClick={onDismiss} className="text-fg-subtle hover:text-fg" aria-label={t('common.close')}>
            <X className="size-4" />
          </button>
        )}
      </div>
      {result.ok && kind && kind !== 'http' && <ProviderCompat apis={result.apis ?? []} className="mt-3" />}
      {result.ok && kind !== 'http' && limitModels && limitModels.length > 0 && (
        <div className="mt-3 text-xs text-fg-muted">
          {detected.length > 0 ? (
            <>
              <span>{t('limits.detected')}</span>
              <ul className="mt-1 space-y-0.5">
                {detected.map(([m, summary]) => (
                  <li key={m}>
                    <span className="font-mono text-fg">{m}</span> – {summary}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            t('limits.detectedNone')
          )}
        </div>
      )}
      {result.models.length > 0 && (
        <div className="mt-3 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-fg-muted">
              {onAddModel ? t('providers.test.modelsPick', { count: result.models.length }) : t('providers.test.modelsFound', { count: result.models.length })}
            </span>
            {result.models.length > 12 && (
              <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t('providers.test.filter')} className="h-7 w-48 text-xs" />
            )}
          </div>
          <div className="flex max-h-48 flex-wrap gap-1.5 overflow-y-auto">
            {shown.map((m) => {
              const added = models?.includes(m);
              const isDefault = defaultModel === m;
              return (
                <span key={m} className={cn('inline-flex items-center rounded-md font-mono text-[11px] ring-1 ring-inset', added ? 'bg-accent-soft text-accent ring-accent/25' : 'bg-surface text-fg-muted ring-line')}>
                  {onAddModel ? (
                    <button type="button" className="px-1.5 py-0.5 hover:text-fg" title={added ? undefined : t('providers.test.addModel')} onClick={() => !added && onAddModel(m)}>
                      {added ? <Check className="mr-0.5 inline size-2.5" /> : <Plus className="mr-0.5 inline size-2.5" />}
                      {m}
                      {ctx(m)}
                    </button>
                  ) : (
                    <span className="px-1.5 py-0.5">
                      {m}
                      {ctx(m)}
                    </span>
                  )}
                  {onDefaultModel && (
                    <button
                      type="button"
                      className={cn('border-l border-line px-1 py-0.5', isDefault ? 'text-accent' : 'text-fg-subtle hover:text-fg')}
                      title={t('providers.test.setDefault')}
                      aria-label={t('providers.test.setDefault')}
                      onClick={() => onDefaultModel(m)}
                    >
                      <Star className={cn('size-2.5', isDefault && 'fill-current')} />
                    </button>
                  )}
                </span>
              );
            })}
            {found.length > shown.length && <span className="text-xs text-fg-subtle">{t('providers.test.more', { count: found.length - shown.length })}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
