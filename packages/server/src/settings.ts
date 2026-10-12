import { DEFAULT_PROFILES, Settings, type MethodParams } from '@cocoon/protocol';
import type { EventBus } from './events.ts';
import type { Store } from './store.ts';

type Section = keyof Settings;

/** Runtime-editable server settings (persisted in the store, seeded from the optional config file). */
export class SettingsService {
  private current: Settings;

  constructor(
    private readonly store: Store,
    private readonly bus: EventBus,
    seed: unknown,
  ) {
    const seedObject = (seed ?? {}) as { agents?: Record<string, unknown> };
    // Seed profiles extend the built-in ones instead of replacing them.
    this.current = Settings.parse(store.settings() ?? { ...seedObject, agents: { ...DEFAULT_PROFILES, ...seedObject.agents } });
    this.addNewDefaultProfiles();
    store.putSettings(this.current);
  }

  /** New built-in agent types reach existing installs once; agent types the user deleted stay deleted. */
  private addNewDefaultProfiles(): void {
    const seen = new Set(this.current.general.defaultProfilesSeen ?? Object.keys(this.current.agents));
    const added = Object.entries(DEFAULT_PROFILES).filter(([kind]) => !seen.has(kind) && !this.current.agents[kind]);
    this.current = {
      ...this.current,
      agents: { ...this.current.agents, ...Object.fromEntries(added) },
      general: { ...this.current.general, defaultProfilesSeen: [...new Set([...seen, ...Object.keys(DEFAULT_PROFILES)])] },
    };
  }

  get(): Settings {
    return this.current;
  }

  update(patch: MethodParams<'settings.update'>): Settings {
    const next = structuredClone(this.current) as Record<Section, unknown>;
    for (const [section, value] of Object.entries(patch) as [Section, unknown][]) {
      if (value === undefined) continue;
      next[section] = section === 'agents' || section === 'providers' || section === 'workflows' ? value : { ...(next[section] as object), ...(value as object) };
    }
    // Resource limits are merged per field, so changing only the CPUs keeps the memory limit.
    if (patch.sandbox?.resources) {
      (next.sandbox as Settings['sandbox']).resources = { ...this.current.sandbox.resources, ...patch.sandbox.resources };
    }
    return this.replace(Settings.parse(next));
  }

  reset(section?: Section): Settings {
    if (!section) return this.replace(Settings.parse({}));
    const defaults = Settings.parse({});
    return this.replace({ ...this.current, [section]: defaults[section] });
  }

  private replace(settings: Settings): Settings {
    this.current = settings;
    this.store.putSettings(settings);
    this.bus.publish({ type: 'settings.updated', settings });
    return settings;
  }
}
