import { useEffect, useState } from 'react';
import { DEFAULT_PROFILES, type AgentTool } from '@cocoon/protocol';
import { useImages } from '../api/queries';
import { useLanguage, useT } from '../i18n';
import { cn } from '../lib/cn';
import { installedTools, TOOL_ORDER, toolboxImage, toolLabel } from '../lib/compat';
import { profileDescription } from '../lib/profiles';
import { Badge } from './Badge';
import { BuildImageButton, BuildLog } from './BuildLog';

/** Preselection when nothing is installed yet: the agents most people start with. */
const DEFAULT_TOOLS: AgentTool[] = ['claude-code', 'codex', 'opencode', 'pi'];

/**
 * Choose which agent CLIs live in the shared toolbox and install / update them.
 * Installed tools are preselected; the build installs exactly the selected ones.
 */
export function ToolboxPicker({ className, compact, primary }: { className?: string; compact?: boolean; primary?: boolean }) {
  const t = useT();
  const { lang } = useLanguage();
  const images = useImages();
  const installed = installedTools(images.data);
  const exists = !!toolboxImage(images.data)?.exists;
  const [selected, setSelected] = useState<AgentTool[] | null>(null);

  // Preselect once the toolbox state is known (and again after a build changed it, unless the user is choosing).
  const installedKey = installed?.join(',');
  useEffect(() => {
    if (!images.data) return;
    setSelected(installed && installed.length > 0 ? installed : DEFAULT_TOOLS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [installedKey, !!images.data]);

  const sel = selected ?? [];
  const toggle = (tool: AgentTool, on: boolean) => setSelected((cur) => (on ? [...(cur ?? []), tool] : (cur ?? []).filter((x) => x !== tool)));
  const unchanged = !!installed && exists && sel.length === installed.length && sel.every((x) => installed.includes(x));
  const removing = (installed ?? []).filter((x) => !sel.includes(x));

  return (
    <div className={cn('space-y-3', className)}>
      <div className={cn('grid gap-2', !compact && 'sm:grid-cols-2')}>
        {TOOL_ORDER.map((tool) => {
          const on = sel.includes(tool);
          const isInstalled = installed?.includes(tool);
          return (
            <label
              key={tool}
              className={cn(
                'flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 transition-colors',
                on ? 'border-accent/40 bg-accent-soft/40' : 'border-line hover:border-line-strong',
              )}
            >
              <input type="checkbox" checked={on} onChange={(e) => toggle(tool, e.target.checked)} className="mt-0.5 size-4 rounded accent-[var(--color-accent)]" />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-fg">
                  {toolLabel(tool)}
                  {isInstalled && <Badge tone="green">{t('toolbox.installed')}</Badge>}
                </span>
                <span className="mt-0.5 block text-xs leading-relaxed text-fg-muted">{profileDescription(DEFAULT_PROFILES[tool], lang)}</span>
              </span>
            </label>
          );
        })}
      </div>
      {sel.length === 0 && <p className="text-xs text-amber-700 dark:text-amber-400">{t('sandboxDefaults.toolbox.noneSelected')}</p>}
      {removing.length > 0 && sel.length > 0 && (
        <p className="text-xs text-amber-700 dark:text-amber-400">{t('toolbox.removing', { tools: removing.map(toolLabel).join(', ') })}</p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <BuildImageButton
          kind="agents"
          tools={sel}
          disabled={sel.length === 0}
          variant={primary || !exists ? 'primary' : 'secondary'}
          label={exists ? t('toolbox.installSelected') : t('toolbox.installSelectedFirst')}
        />
        {unchanged && <span className="text-xs text-fg-subtle">{t('toolbox.updateHint')}</span>}
      </div>
      <BuildLog kind="agents" />
    </div>
  );
}
