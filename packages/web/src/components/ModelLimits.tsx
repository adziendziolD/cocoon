import { useEffect, useState } from 'react';
import { defaultMaxOutput, type ApiProvider, type ModelInfo } from '@cocoon/protocol';
import { Gauge, RotateCcw } from 'lucide-react';
import { useT, type TFunction } from '../i18n';
import { cn } from '../lib/cn';
import { formatTokens, MIN_CONTEXT, MIN_OUTPUT, parseTokens, tokenError, tokensText, type LimitSource } from '../lib/modelLimits';
import { Badge } from './Badge';
import { Button } from './Button';
import { Input } from './Field';

/** "Kontext: 128k · Antwort: 32k" (or only the known part); undefined if nothing is known. */
export function limitsSummary(t: TFunction, contextWindow: number | undefined, maxOutputTokens: number | undefined): string | undefined {
  if (contextWindow !== undefined && maxOutputTokens !== undefined) return t('limits.summary', { context: formatTokens(contextWindow), answer: formatTokens(maxOutputTokens) });
  if (contextWindow !== undefined) return t('limits.summaryContext', { context: formatTokens(contextWindow) });
  if (maxOutputTokens !== undefined) return t('limits.summaryAnswer', { answer: formatTokens(maxOutputTokens) });
  return undefined;
}

export const limitSourceLabel = (t: TFunction, source: LimitSource) => t(`limits.source.${source}`);

/** Badge for where a model's limits come from. */
export function LimitSourceBadge({ source }: { source: ModelInfo['source'] }) {
  const t = useT();
  if (source === 'user') return <Badge tone="blue" title={t('limits.badge.userHint')}>{t('limits.badge.user')}</Badge>;
  if (source === 'detected') return <Badge tone="green" title={t('limits.badge.detectedHint')}>{t('limits.badge.detected')}</Badge>;
  return null;
}

/** Text field for a token count; accepts "131072" or "128k" and shows "≈ 128k" next to it. */
export function TokenInput({
  value,
  onChange,
  placeholder,
  min,
  className,
  id,
  'aria-label': ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  min: number;
  className?: string;
  id?: string;
  'aria-label'?: string;
}) {
  const t = useT();
  const parsed = parseTokens(value);
  const err = tokenError(value, min);
  return (
    <div className={cn('relative', className)}>
      <Input
        id={id}
        aria-label={ariaLabel}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        inputMode="numeric"
        invalid={!!err}
        placeholder={placeholder}
        className="pr-16 font-mono"
      />
      {parsed !== undefined && !err && (
        <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-xs text-fg-subtle">{t('limits.approx', { value: formatTokens(parsed) })}</span>
      )}
    </div>
  );
}

/** Error text of a token field (undefined = valid). */
export function tokenFieldError(t: TFunction, value: string, min: number): string | undefined {
  const e = tokenError(value, min);
  return e === 'format' ? t('limits.err.format') : e === 'min' ? t('limits.err.min', { min }) : undefined;
}

/** Error for a context window / answer length pair (field errors first, then answer ≥ context). */
export function limitsPairError(t: TFunction, context: string, output: string): string | undefined {
  const e = tokenFieldError(t, context, MIN_CONTEXT) ?? tokenFieldError(t, output, MIN_OUTPUT);
  if (e) return e;
  const c = parseTokens(context);
  const o = parseTokens(output);
  return c !== undefined && o !== undefined && o >= c ? t('limits.err.outputTooBig') : undefined;
}

interface RowText {
  context: string;
  output: string;
}

const rowText = (info: ModelInfo | undefined): RowText => ({ context: tokensText(info?.contextWindow), output: tokensText(info?.maxOutputTokens) });

/**
 * Per-model context window / answer length table (provider settings, onboarding).
 * Edited values are stored with `source: 'user'`; "reset" drops them (falling back to `detected`, if known).
 * `onChange` gets the new modelInfo and whether all fields are valid.
 */
export function ModelLimitsEditor({
  models,
  value,
  detected,
  onChange,
}: {
  models: string[];
  value: Record<string, ModelInfo> | undefined;
  /** Limits the last connection test reported (fallback for "reset"). */
  detected?: Record<string, ModelInfo>;
  onChange: (next: Record<string, ModelInfo> | undefined, valid: boolean) => void;
}) {
  const t = useT();
  const list = Array.from(new Set(models.filter(Boolean)));
  const [text, setText] = useState<Record<string, RowText>>(() => Object.fromEntries(list.map((m) => [m, rowText(value?.[m])])));

  // Follow outside changes (e.g. values detected by a connection test) without clobbering what's being typed.
  useEffect(() => {
    setText((prev) => {
      const next: Record<string, RowText> = {};
      for (const m of list) {
        const cur = prev[m];
        const info = value?.[m];
        const same = cur && parseTokens(cur.context) === info?.contextWindow && parseTokens(cur.output) === info?.maxOutputTokens;
        const typing = cur && (tokenError(cur.context, MIN_CONTEXT) || tokenError(cur.output, MIN_OUTPUT));
        next[m] = cur && (same || typing) ? cur : rowText(info);
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, list.join('\n')]);

  const allValid = (rows: Record<string, RowText>) => list.every((m) => !limitsPairError(t, rows[m]?.context ?? '', rows[m]?.output ?? ''));

  const edit = (model: string, patch: Partial<RowText>) => {
    const row = { ...(text[model] ?? rowText(value?.[model])), ...patch };
    const rows = { ...text, [model]: row };
    setText(rows);
    const c = parseTokens(row.context);
    const o = parseTokens(row.output);
    const prev = value?.[model];
    const contextWindow = c === undefined ? undefined : Number.isNaN(c) || c < MIN_CONTEXT ? prev?.contextWindow : c;
    const maxOutputTokens = o === undefined ? undefined : Number.isNaN(o) || o < MIN_OUTPUT ? prev?.maxOutputTokens : o;
    const next = { ...(value ?? {}) };
    if (contextWindow === undefined && maxOutputTokens === undefined) delete next[model];
    else next[model] = { ...(contextWindow !== undefined ? { contextWindow } : {}), ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}), source: 'user' };
    onChange(Object.keys(next).length ? next : undefined, allValid(rows));
  };

  const reset = (model: string) => {
    const next = { ...(value ?? {}) };
    const d = detected?.[model];
    if (d && (d.contextWindow !== undefined || d.maxOutputTokens !== undefined)) next[model] = { ...d, source: 'detected' };
    else delete next[model];
    const rows = { ...text, [model]: rowText(next[model]) };
    setText(rows);
    onChange(Object.keys(next).length ? next : undefined, allValid(rows));
  };

  if (list.length === 0) return <p className="text-sm text-fg-muted">{t('limits.noModels')}</p>;

  return (
    <div className="space-y-2">
      <div className="hidden gap-2 px-1 text-xs font-medium text-fg-muted sm:grid sm:grid-cols-[minmax(0,1fr)_10rem_10rem_5.5rem]">
        <span>{t('limits.model')}</span>
        <span>{t('limits.contextLabel')}</span>
        <span>{t('limits.outputLabel')}</span>
        <span />
      </div>
      {list.map((m) => {
        const info = value?.[m];
        const row = text[m] ?? rowText(info);
        const ctx = parseTokens(row.context);
        const error = limitsPairError(t, row.context, row.output);
        return (
          <div key={m} className="rounded-lg border border-line bg-surface px-3 py-2">
            <div className="grid items-center gap-2 sm:grid-cols-[minmax(0,1fr)_10rem_10rem_5.5rem]">
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <span className="truncate font-mono text-xs text-fg" title={m}>
                  {m}
                </span>
                <LimitSourceBadge source={info?.source} />
              </div>
              <TokenInput value={row.context} onChange={(context) => edit(m, { context })} min={MIN_CONTEXT} placeholder={t('limits.unknown')} aria-label={`${t('limits.contextLabel')} – ${m}`} />
              <TokenInput
                value={row.output}
                onChange={(output) => edit(m, { output })}
                min={MIN_OUTPUT}
                placeholder={ctx !== undefined && !Number.isNaN(ctx) && ctx >= MIN_CONTEXT ? String(defaultMaxOutput(ctx)) : ''}
                aria-label={`${t('limits.outputLabel')} – ${m}`}
              />
              <div>
                {info?.source === 'user' && (
                  <button type="button" onClick={() => reset(m)} title={t('limits.resetHint')} className="inline-flex items-center gap-1 text-xs text-accent hover:underline">
                    <RotateCcw className="size-3" /> {t('limits.reset')}
                  </button>
                )}
              </div>
            </div>
            {error && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>}
          </div>
        );
      })}
      <p className="text-xs leading-relaxed text-fg-muted">
        {t('limits.contextHint')} {t('limits.outputHint')}
      </p>
    </div>
  );
}

/** Heading with the one-line explanation why limits matter. */
export function LimitsIntro({ className }: { className?: string }) {
  const t = useT();
  return (
    <div className={className}>
      <div className="flex items-center gap-2 text-sm font-medium text-fg">
        <Gauge className="size-4 text-fg-muted" />
        {t('limits.title')}
      </div>
      <p className="mt-1 text-xs leading-relaxed text-fg-muted">{t('limits.why')}</p>
    </div>
  );
}

/** Standalone card for a saved provider: edit limits of its models and save them right away (onboarding). */
export function ProviderLimitsCard({
  provider,
  detected,
  saving,
  onSave,
}: {
  provider: ApiProvider;
  detected?: Record<string, ModelInfo>;
  saving: boolean;
  onSave: (modelInfo: Record<string, ModelInfo> | undefined) => void;
}) {
  const t = useT();
  const models = Array.from(new Set([...(provider.defaultModel ? [provider.defaultModel] : []), ...provider.models]));
  const [draft, setDraft] = useState(provider.modelInfo);
  const [valid, setValid] = useState(true);
  useEffect(() => setDraft(provider.modelInfo), [provider.modelInfo]);
  const changed = JSON.stringify(draft ?? {}) !== JSON.stringify(provider.modelInfo ?? {});
  return (
    <div className="space-y-3 rounded-xl border border-line bg-surface px-4 py-3.5">
      <LimitsIntro />
      <ModelLimitsEditor
        models={models}
        value={draft}
        detected={detected}
        onChange={(next, ok) => {
          setDraft(next);
          setValid(ok);
        }}
      />
      {models.length > 0 && (
        <Button size="sm" onClick={() => onSave(draft)} loading={saving} disabled={!changed || !valid}>
          {t('limits.save')}
        </Button>
      )}
    </div>
  );
}
