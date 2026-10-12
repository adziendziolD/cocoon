import { Dialog } from '../../components/Dialog';
import { useT, type MessageKey } from '../../i18n';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD = isMac ? '⌃⌥' : 'Ctrl+Alt+';

const ROWS: Array<{ keys: string; label: MessageKey }> = [
  { keys: `${MOD}← ↑ → ↓`, label: 'cockpit.keys.move' },
  { keys: `${MOD}1 … 9`, label: 'cockpit.keys.jump' },
  { keys: `${MOD}Enter`, label: 'cockpit.keys.maximize' },
  { keys: `${MOD}D`, label: 'cockpit.keys.split' },
  { keys: `${MOD}W`, label: 'cockpit.keys.close' },
  { keys: `${MOD}G`, label: 'cockpit.keys.grid' },
  { keys: `${MOD}B`, label: 'cockpit.keys.broadcast' },
  { keys: '?', label: 'cockpit.keys.help' },
];

export function ShortcutHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  return (
    <Dialog open={open} onClose={onClose} size="sm" title={t('cockpit.keys.title')} description={t('cockpit.keys.intro')}>
      <dl className="divide-y divide-line">
        {ROWS.map((r) => (
          <div key={r.label} className="flex items-center justify-between gap-4 py-2 text-sm">
            <dt className="text-fg-muted">{t(r.label)}</dt>
            <dd>
              <kbd className="rounded-md border border-line-strong bg-surface-2 px-1.5 py-0.5 font-mono text-xs whitespace-nowrap text-fg">{r.keys}</kbd>
            </dd>
          </div>
        ))}
      </dl>
      {isMac && <p className="mt-3 text-xs text-fg-subtle">{t('cockpit.keys.mac')}</p>}
    </Dialog>
  );
}
