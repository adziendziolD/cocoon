import { ADAPTERS, type AgentTool, type ApiProvider, type ApiStyle } from '@cocoon/protocol';
import { Check, HelpCircle, Repeat, X } from 'lucide-react';
import { useImages } from '../api/queries';
import { useT, type TFunction } from '../i18n';
import { cn } from '../lib/cn';
import { AGENT_BASES, API_STYLES, apisCompat, installedTools, toolLabel, type Compat, type ProfileCompat } from '../lib/compat';
import { Badge } from './Badge';
import { BuildImageButton } from './BuildLog';

const COMPAT_TONE = { native: 'green', translated: 'blue', incompatible: 'red', unknown: 'gray' } as const;

/** "✓ direkt", "✓ über Übersetzung", "✗ nicht kompatibel", "? ungetestet". */
export function CompatBadge({ level, className }: { level: Compat; className?: string }) {
  const t = useT();
  const Icon = level === 'native' ? Check : level === 'translated' ? Repeat : level === 'incompatible' ? X : HelpCircle;
  return (
    <Badge tone={COMPAT_TONE[level]} className={className} title={t(`compat.${level}.hint`)}>
      <Icon className="size-3" />
      {t(`compat.${level}`)}
    </Badge>
  );
}

export const apiLabel = (t: TFunction, api: ApiStyle) => t(`compat.api.${api}`);

/** Detected APIs as chips: "Chat-API ✓  Responses-API ✗  Anthropic-API ✗". */
export function ApiChips({ apis, className }: { apis: ApiStyle[]; className?: string }) {
  const t = useT();
  return (
    <div className={cn('flex flex-wrap gap-1.5', className)}>
      {API_STYLES.map((api) => {
        const ok = apis.includes(api);
        return (
          <span
            key={api}
            title={t(`compat.api.${api}.hint`)}
            className={cn(
              'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
              ok ? 'bg-emerald-500/10 text-emerald-700 ring-emerald-500/25 dark:text-emerald-300' : 'bg-surface-2 text-fg-subtle ring-line',
            )}
          >
            {t(`compat.api.${api}`)}
            {ok ? <Check className="size-3" /> : <X className="size-3" />}
          </span>
        );
      })}
    </div>
  );
}

/** Which agents can use a provider with the given APIs (✓ direkt / ✓ über Übersetzung / ✗). */
export function ProviderCompatMatrix({ apis, className }: { apis: ApiStyle[] | undefined; className?: string }) {
  const t = useT();
  const images = useImages();
  const installed = installedTools(images.data);
  const known = !!apis && apis.length > 0;
  const rows = AGENT_BASES.map((base) => ({ base, compat: known ? apisCompat(base, apis) : ADAPTERS[base].customProviders ? ('unknown' as Compat) : ('incompatible' as Compat) }));
  const anyTranslated = rows.some((r) => r.compat === 'translated');
  return (
    <div className={cn('rounded-xl border border-line bg-surface px-4 py-3', className)}>
      <div className="text-sm font-medium text-fg">{t('compat.matrixTitle')}</div>
      <ul className="mt-2 grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
        {rows.map(({ base, compat }) => (
          <li key={base} className="flex items-center gap-2 text-sm">
            <span className="min-w-0 flex-1 truncate text-fg">
              {toolLabel(base)}
              {installed && !installed.includes(base) && <span className="ml-1.5 text-xs text-fg-subtle">({t('compat.tool.missing')})</span>}
            </span>
            <CompatBadge level={compat} />
          </li>
        ))}
      </ul>
      {!known && <p className="mt-2 text-xs text-fg-muted">{t('compat.matrix.unknownNote')}</p>}
      {anyTranslated && <p className="mt-2 text-xs leading-relaxed text-fg-muted">{t('compat.matrix.translatedNote')}</p>}
      {known && <p className="mt-1 text-xs text-fg-subtle">{t('compat.matrix.geminiNote')}</p>}
    </div>
  );
}

/** Detected APIs plus the compatibility matrix (shown after a connection test). */
export function ProviderCompat({ apis, className }: { apis: ApiStyle[]; className?: string }) {
  const t = useT();
  return (
    <div className={cn('space-y-3', className)}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-fg-muted">{t('compat.apisTitle')}</span>
        {apis.length > 0 ? <ApiChips apis={apis} /> : <span className="text-xs text-fg-subtle">{t('compat.apisNone')}</span>}
      </div>
      <ProviderCompatMatrix apis={apis} />
    </div>
  );
}

/** Explanation why an agent type can't use its provider (undefined = it can, or it's unknown). */
export function compatProblem(t: TFunction, pc: ProfileCompat, providers: Record<string, ApiProvider>, agentLabel: string): string | undefined {
  if (pc.level !== 'incompatible') return undefined;
  const p = pc.providerId ? providers[pc.providerId] : undefined;
  if (pc.noCustomProviders) return t('compat.reason.noCustom', { agent: agentLabel });
  return t('compat.reason.incompatible', {
    provider: p?.label ?? pc.providerId ?? '',
    apis: (p?.apis ?? []).map((a) => apiLabel(t, a)).join(', ') || '–',
  });
}

/** Installs one more agent CLI into the toolbox (keeps the ones already installed). */
export function InstallToolButton({ tool, size }: { tool: AgentTool; size?: 'sm' }) {
  const t = useT();
  const images = useImages();
  const current = installedTools(images.data) ?? [];
  return (
    <BuildImageButton
      kind="agents"
      tools={Array.from(new Set([...current, tool]))}
      variant="secondary"
      size={size}
      label={t('compat.tool.install', { tool: toolLabel(tool) })}
    />
  );
}
