import type { ReactNode } from 'react';
import { profileTool, type AgentProfile, type ApiProvider } from '@cocoon/protocol';
import { Bot, Download, Plug, SquareTerminal } from 'lucide-react';
import { useImages } from '../api/queries';
import { useLanguage, useT } from '../i18n';
import { isModelProvider, profileCompat, toolLabel, toolState } from '../lib/compat';
import { profileDescription, profileLabel } from '../lib/profiles';
import { Badge } from './Badge';
import { BuildLog } from './BuildLog';
import { CompatBadge, compatProblem, InstallToolButton } from './CompatBits';
import { ChoiceCard } from './Field';

/** Model an agent type will use: its own, else the default of its first model provider. */
export function profileModel(profile: AgentProfile, providers: Record<string, ApiProvider>): string | undefined {
  if (profile.model) return profile.model;
  const p = profile.providers.map((id) => providers[id]).find(isModelProvider);
  return p?.defaultModel ?? p?.models[0];
}

/**
 * Agent types as selectable cards with provider, model, compatibility and toolbox state.
 * Cards whose CLI is not installed or that can't use their provider are disabled with the reason
 * (and, for missing CLIs, an "install" action). `disabledReason` adds caller-specific reasons.
 */
export function AgentTypeCards({
  profiles,
  providers,
  value,
  onChange,
  disabledReason,
  extraBadge,
}: {
  profiles: Array<[string, AgentProfile]>;
  providers: Record<string, ApiProvider>;
  value: string;
  onChange: (kind: string) => void;
  disabledReason?: (kind: string, profile: AgentProfile) => string | undefined;
  extraBadge?: (kind: string, profile: AgentProfile) => ReactNode;
}) {
  const t = useT();
  const { lang } = useLanguage();
  const images = useImages();
  let anyMissing = false;
  return (
    <div className="space-y-3">
      <div className="grid gap-2.5 sm:grid-cols-2">
        {profiles.map(([k, p]) => {
          const label = profileLabel(k, p, lang);
          const compat = profileCompat(p, providers);
          const tool = profileTool(p);
          const missing = toolState(p, images.data) === 'missing';
          if (missing) anyMissing = true;
          const reason =
            disabledReason?.(k, p) ?? (missing && tool ? t('compat.reason.notInstalled', { tool: toolLabel(tool) }) : compatProblem(t, compat, providers, label));
          const model = profileModel(p, providers);
          const modelProviders = p.providers.filter((id) => !providers[id] || isModelProvider(providers[id]));
          return (
            <div key={k} className="flex flex-col gap-1.5">
              <ChoiceCard
                selected={value === k}
                onSelect={() => onChange(k)}
                disabled={!!reason}
                icon={k === 'shell' ? <SquareTerminal className="size-5" /> : <Bot className="size-5" />}
                title={label}
                badge={
                  <>
                    {compat.level !== 'none' && <CompatBadge level={compat.level} />}
                    {missing && <Badge tone="amber">{t('compat.tool.missing')}</Badge>}
                    {extraBadge?.(k, p)}
                  </>
                }
                description={
                  <>
                    {profileDescription(p, lang) || <span className="font-mono text-xs">{p.command.join(' ')}</span>}
                    {(modelProviders.length > 0 || p.model) && (
                      <span className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
                        {modelProviders.length > 0 && (
                          <Badge tone="accent">
                            <Plug className="size-3" />
                            {modelProviders.map((id) => providers[id]?.label ?? id).join(', ')}
                          </Badge>
                        )}
                        {model && <code className="rounded bg-surface-2 px-1 font-mono text-[11px] text-fg-muted">{model}</code>}
                      </span>
                    )}
                    {reason && <span className="mt-1.5 block text-xs font-medium text-amber-700 dark:text-amber-400">{reason}</span>}
                  </>
                }
              />
              {missing && tool && (
                <div className="flex items-center gap-2 pl-1">
                  <Download className="size-3.5 text-fg-subtle" />
                  <InstallToolButton tool={tool} size="sm" />
                </div>
              )}
            </div>
          );
        })}
      </div>
      {anyMissing && <BuildLog kind="agents" />}
    </div>
  );
}
