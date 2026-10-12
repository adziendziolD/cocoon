import type { ReactNode } from 'react';
import type { NetworkMode } from '@cocoon/protocol';
import { Globe, ShieldCheck, WifiOff } from 'lucide-react';
import { useT } from '../i18n';
import { useBackend } from '../lib/backend';
import { cn } from '../lib/cn';
import { SIZE_PRESETS, sizePresetDescription, sizePresetLabel, type SizePresetId } from '../lib/runtimes';
import { NETWORK_MODES, networkModeMeta } from '../lib/status';
import { Badge } from './Badge';
import { ChoiceCard } from './Field';

export const NETWORK_ICONS: Record<NetworkMode, ReactNode> = {
  egress: <ShieldCheck className="size-5" />,
  open: <Globe className="size-5" />,
  none: <WifiOff className="size-5" />,
};

/** The three internet-access modes as explained, selectable cards. */
export function NetworkModeCards({ value, onChange, defaultMode }: { value: NetworkMode; onChange: (mode: NetworkMode) => void; defaultMode?: NetworkMode }) {
  const t = useT();
  const { capabilities, name } = useBackend();
  return (
    <div className="space-y-3" role="radiogroup">
      {NETWORK_MODES.map((mode) => (
        <ChoiceCard
          key={mode}
          selected={value === mode}
          onSelect={() => onChange(mode)}
          icon={NETWORK_ICONS[mode]}
          title={networkModeMeta(t, mode).label}
          description={
            mode === 'egress' && !capabilities.enforcedEgress ? (
              <>
                {networkModeMeta(t, mode).description}
                <span className="mt-1.5 block text-xs text-amber-700 dark:text-amber-400">{t('backend.egressNotEnforcedNote', { name: name ?? '' })}</span>
              </>
            ) : (
              networkModeMeta(t, mode).description
            )
          }
          badge={defaultMode === mode ? <Badge tone="accent">{t('common.default')}</Badge> : undefined}
        />
      ))}
    </div>
  );
}

/** Small / Medium / Large size presets as selectable tiles. */
export function SizePresetCards({ value, onChange }: { value: SizePresetId | undefined; onChange: (id: SizePresetId) => void }) {
  const t = useT();
  const { capabilities, name } = useBackend();
  return (
    <div className="space-y-2">
      <div className="grid gap-2.5 sm:grid-cols-3">
        {SIZE_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            aria-pressed={value === p.id}
            onClick={() => onChange(p.id)}
            className={cn(
              'rounded-xl border p-3.5 text-left transition-all focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
              value === p.id ? 'border-accent bg-accent-soft ring-2 ring-accent/30' : 'border-line hover:border-line-strong hover:bg-surface-2/60',
            )}
          >
            <div className="font-medium text-fg">{sizePresetLabel(t, p.id)}</div>
            <div className="mt-1 text-xs leading-relaxed text-fg-muted">{sizePresetDescription(t, p.id)}</div>
          </button>
        ))}
      </div>
      {!capabilities.resourceLimits && <p className="text-xs text-amber-700 dark:text-amber-400">{t('backend.limitsNotEnforcedNote', { name: name ?? '' })}</p>}
    </div>
  );
}
