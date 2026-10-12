import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ADAPTERS,
  AgentAdapter,
  AgentTool,
  DEFAULT_PROFILES,
  KNOWN_SECRETS,
  localize,
  profileAdapter,
  profileTool,
  type AgentProfile,
  type ApiProvider,
  type Language,
  type LocalizedText,
} from '@cocoon/protocol';
import { Bot, ChevronDown, ChevronRight, Plug, Plus, RotateCcw, Save, Sparkles, SquareTerminal, Trash2, Undo2 } from 'lucide-react';
import { useImages, useSecrets, useSettings } from '../../api/queries';
import { apiLabel, CompatBadge, InstallToolButton } from '../../components/CompatBits';
import { ModelSelect } from '../../components/ModelSelect';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Card, CardBody, CardHeader } from '../../components/Card';
import { ConfirmDialog, Dialog } from '../../components/Dialog';
import { Checkbox, ChoiceCard, Field, Input, Select, Textarea } from '../../components/Field';
import { Callout, InfoTip } from '../../components/HelpText';
import { fromRows, KeyValueEditor, toRows, type KeyValueRow } from '../../components/KeyValueEditor';
import { ErrorState, LoadingState } from '../../components/States';
import { rich, useLanguage, useT, type TFunction } from '../../i18n';
import { cn } from '../../lib/cn';
import { secretLabel } from '../../lib/secrets';
import { providerProfile, providerProfileKey } from '../../lib/providers';
import { isModelProvider, providerCompat, recommendedBase, toolLabel, toolState, type Compat } from '../../lib/compat';
import { joinCommand, splitCommand } from '../../lib/shellwords';
import { useResetSettings, useSaveSettings } from './useSaveSettings';
import { LimitsIntro, limitsPairError, limitsSummary, TokenInput } from '../../components/ModelLimits';
import { effectiveLimits, MIN_CONTEXT, MIN_OUTPUT, parseTokens, profileModel, tokensText } from '../../lib/modelLimits';

interface ProfileDraft {
  /** Built-in profiles carry texts in both languages; once edited, the field becomes a plain string. */
  label: LocalizedText;
  description: LocalizedText;
  commandText: string;
  promptMode: 'arg' | 'input';
  secrets: string[];
  hooks: '' | 'claude-code' | 'codex';
  env: KeyValueRow[];
  workingPatterns: string;
  blockedPatterns: string;
  idleForeground: string;
  providers: string[];
  model: string;
  /** '' = derived from the command. */
  adapter: '' | AgentAdapter;
  tool: '' | AgentTool;
  promptFlag: string;
  /** Context window / answer length as typed ('' = from the model). */
  contextWindow: string;
  maxOutputTokens: string;
}

const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;
const lines = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean);

function toDraft(p: AgentProfile): ProfileDraft {
  return {
    label: p.label ?? '',
    description: p.description ?? '',
    commandText: joinCommand(p.command),
    promptMode: p.promptMode,
    secrets: [...p.secrets],
    hooks: p.hooks ?? '',
    env: toRows(p.env),
    workingPatterns: p.workingPatterns.join('\n'),
    blockedPatterns: p.blockedPatterns.join('\n'),
    idleForeground: (p.idleForeground ?? []).join('\n'),
    providers: [...(p.providers ?? [])],
    model: p.model ?? '',
    adapter: p.adapter ?? '',
    tool: p.tool ?? '',
    promptFlag: p.promptFlag ?? '',
    contextWindow: tokensText(p.contextWindow),
    maxOutputTokens: tokensText(p.maxOutputTokens),
  };
}

function fromDraft(d: ProfileDraft): AgentProfile {
  const idle = lines(d.idleForeground);
  return {
    label: typeof d.label === 'string' ? d.label.trim() || undefined : d.label,
    description: typeof d.description === 'string' ? d.description.trim() || undefined : d.description,
    command: splitCommand(d.commandText),
    promptMode: d.promptMode,
    secrets: d.secrets,
    env: fromRows(d.env),
    hooks: d.hooks || undefined,
    workingPatterns: lines(d.workingPatterns),
    blockedPatterns: lines(d.blockedPatterns),
    idleForeground: idle.length ? idle : undefined,
    providers: d.providers,
    model: d.model.trim() || undefined,
    adapter: d.adapter || undefined,
    tool: d.tool || undefined,
    promptFlag: d.promptFlag.trim() || undefined,
    contextWindow: parseTokens(d.contextWindow),
    maxOutputTokens: parseTokens(d.maxOutputTokens),
  };
}

function validate(t: TFunction, d: ProfileDraft): string | undefined {
  if (splitCommand(d.commandText).length === 0) return t('profiles.err.command');
  const limitsError = limitsPairError(t, d.contextWindow, d.maxOutputTokens);
  if (limitsError) return `${t('limits.title')}: ${limitsError}`;
  for (const p of [...lines(d.workingPatterns), ...lines(d.blockedPatterns)]) {
    try {
      new RegExp(p);
    } catch {
      return t('profiles.err.pattern', { pattern: p });
    }
  }
  return undefined;
}

/** Ready-made suggestion: Claude Code without permission prompts – fine because it runs inside a sandbox. */
const CLAUDE_AUTONOMOUS: AgentProfile = {
  ...DEFAULT_PROFILES['claude-code']!,
  label: { de: 'Claude Code (autonom)', en: 'Claude Code (autonomous)' },
  description: {
    de: 'Claude Code ohne Rückfragen: führt Befehle und Änderungen direkt aus. Sicher, weil er in der abgeschotteten Sandbox arbeitet.',
    en: "Claude Code without asking: runs commands and makes changes right away. Safe, because it works inside the isolated sandbox.",
  },
  command: ['claude', '--dangerously-skip-permissions'],
};
const AUTONOMOUS_KEY = 'claude-code-autonom';

const text = (v: LocalizedText | undefined, lang: Language) => localize(v, lang) ?? '';

type Drafts = Record<string, ProfileDraft>;
const draftsFrom = (agents: Record<string, AgentProfile>): Drafts => Object.fromEntries(Object.entries(agents).map(([k, p]) => [k, toDraft(p)]));

export function AgentProfilesSettings() {
  const t = useT();
  const { lang } = useLanguage();
  const settings = useSettings();
  const secrets = useSecrets();
  const images = useImages();
  const [drafts, setDrafts] = useState<Drafts | null>(null);
  const [selected, setSelected] = useState<string>('');
  const [addOpen, setAddOpen] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [toDelete, setToDelete] = useState<string | null>(null);

  // `baseline` is the server state the current edits started from.
  const [baseline, setBaseline] = useState<Drafts | null>(null);
  const serverDrafts = useMemo(() => (settings.data ? draftsFrom(settings.data.agents) : null), [settings.data]);
  const dirty = !!drafts && !!baseline && JSON.stringify(drafts) !== JSON.stringify(baseline);

  const resync = (next: Drafts | null) => {
    setDrafts(next);
    setBaseline(next);
  };

  // Follow server changes (e.g. from another browser tab) as long as the user has no unsaved edits.
  useEffect(() => {
    if (serverDrafts && !dirty) resync(serverDrafts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverDrafts]);

  useEffect(() => {
    if (drafts && (!selected || !drafts[selected])) setSelected(Object.keys(drafts)[0] ?? '');
  }, [drafts, selected]);

  const save = useSaveSettings(t('profiles.saved'), (next) => resync(draftsFrom(next.agents)));
  const reset = useResetSettings((next) => {
    resync(draftsFrom(next.agents));
    setConfirmReset(false);
  });

  if (settings.isLoading || !drafts) return settings.error ? <ErrorState error={settings.error} onRetry={() => settings.refetch()} /> : <LoadingState />;

  const errors = Object.fromEntries(Object.entries(drafts).map(([k, d]) => [k, validate(t, d)]));
  const hasErrors = Object.values(errors).some(Boolean);
  const draft = drafts[selected];
  const update = (patch: Partial<ProfileDraft>) => setDrafts((all) => (all && selected ? { ...all, [selected]: { ...all[selected]!, ...patch } } : all));

  const addProfile = (key: string, profile: AgentProfile) => {
    setDrafts((all) => ({ ...all, [key]: toDraft(profile) }));
    setSelected(key);
  };

  const providers = settings.data?.providers ?? {};
  // Provider keys are wired in via "API providers", not as plain secrets – keep them out of the checkbox list.
  const providerSecrets = new Set(Object.values(providers).flatMap((p) => (p.secret ? [p.secret] : [])));
  const secretNames = Array.from(
    new Set([...Object.keys(KNOWN_SECRETS), ...(secrets.data ?? []).map((s) => s.name).filter((n) => !providerSecrets.has(n)), ...(draft?.secrets ?? [])]),
  );
  // Providers no agent type uses yet: suggest the best compatible agent for them.
  const suggestions = Object.entries(providers).flatMap(([id, p]) => {
    if (!isModelProvider(p)) return [];
    if (Object.values(drafts).some((d) => d.providers.includes(id))) return [];
    const base = recommendedBase(p, images.data);
    if (!base) return [];
    const key = providerProfileKey(base, id);
    return drafts[key] ? [] : [{ id, provider: p, base, key, compat: providerCompat(base, p) }];
  });

  return (
    <div className="space-y-5">
      <Callout tone="info">
        {rich(t('profiles.intro'), { program: <strong>{t('profiles.introProgram')}</strong>, credentials: <strong>{t('profiles.introCredentials')}</strong> })}
      </Callout>

      {!drafts[AUTONOMOUS_KEY] && (
        <Card className="border-accent/30 bg-accent-soft/40">
          <CardBody className="flex flex-wrap items-start gap-4">
            <Sparkles className="mt-0.5 size-5 text-accent" />
            <div className="min-w-0 flex-1">
              <div className="font-medium text-fg">{t('profiles.suggestion', { name: text(CLAUDE_AUTONOMOUS.label, lang) })}</div>
              <p className="mt-0.5 text-sm text-fg-muted">
                {rich(t('profiles.autonomousText'), { flag: <code className="rounded bg-surface px-1 font-mono text-xs">--dangerously-skip-permissions</code> })}
              </p>
            </div>
            <Button variant="primary" size="sm" icon={<Plus className="size-3.5" />} onClick={() => addProfile(AUTONOMOUS_KEY, CLAUDE_AUTONOMOUS)}>
              {t('common.add')}
            </Button>
          </CardBody>
        </Card>
      )}

      {suggestions.map((sug) => {
        const profile = providerProfile(sug.base, sug.id, sug.provider);
        return (
          <Card key={sug.key} className="border-accent/30 bg-accent-soft/40">
            <CardBody className="flex flex-wrap items-start gap-4">
              <Plug className="mt-0.5 size-5 text-accent" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 font-medium text-fg">
                  {t('profiles.suggestion', { name: text(profile.label, lang) })}
                  <CompatBadge level={sug.compat} />
                </div>
                <p className="mt-0.5 text-sm text-fg-muted">{t('compat.profileSuggestion', { agent: toolLabel(sug.base), provider: sug.provider.label })}</p>
              </div>
              <Button variant="primary" size="sm" icon={<Plus className="size-3.5" />} onClick={() => addProfile(sug.key, profile)}>
                {t('common.add')}
              </Button>
            </CardBody>
          </Card>
        );
      })}

      <div className="grid gap-5 xl:grid-cols-[260px_1fr]">
        <div className="space-y-2">
          {Object.entries(drafts).map(([key, d]) => (
            <button
              key={key}
              onClick={() => setSelected(key)}
              className={cn(
                'flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-colors',
                key === selected ? 'border-accent bg-accent-soft' : 'border-line bg-surface hover:border-line-strong',
                errors[key] && 'border-red-500/50',
              )}
            >
              {key === 'shell' ? <SquareTerminal className="mt-0.5 size-4 text-fg-muted" /> : <Bot className="mt-0.5 size-4 text-fg-muted" />}
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-fg">{text(d.label, lang) || key}</div>
                <div className="truncate font-mono text-xs text-fg-subtle">{key}</div>
              </div>
              {d.providers.length > 0 && <Plug className="mt-0.5 size-3.5 text-accent" aria-label={t('profiles.providers')} />}
              {!baseline?.[key] && <Badge tone="accent">{t('profiles.new')}</Badge>}
            </button>
          ))}
          <Button className="w-full" icon={<Plus className="size-4" />} onClick={() => setAddOpen(true)}>
            {t('profiles.newType')}
          </Button>
          <Button variant="ghost" className="w-full" icon={<RotateCcw className="size-4" />} onClick={() => setConfirmReset(true)}>
            {t('profiles.resetDefaults')}
          </Button>
        </div>

        {draft ? (
          <ProfileForm
            key={selected}
            id={selected}
            draft={draft}
            error={errors[selected]}
            secretNames={secretNames}
            providers={providers}
            onChange={update}
            onDelete={() => setToDelete(selected)}
          />
        ) : (
          <Card>
            <CardBody className="text-sm text-fg-muted">{t('profiles.none')}</CardBody>
          </Card>
        )}
      </div>

      {dirty && (
        <div className="sticky bottom-4 z-10 flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 shadow-lg">
          <span className="flex-1 text-sm text-fg">{hasErrors ? t('profiles.fixErrors') : t('common.unsavedChanges')}</span>
          <Button icon={<Undo2 className="size-4" />} onClick={() => resync(serverDrafts)}>
            {t('common.discard')}
          </Button>
          <Button
            variant="primary"
            icon={<Save className="size-4" />}
            disabled={hasErrors}
            loading={save.isPending}
            onClick={() => save.mutate({ agents: Object.fromEntries(Object.entries(drafts).map(([k, d]) => [k, fromDraft(d)])) })}
          >
            {t('common.save')}
          </Button>
        </div>
      )}

      <AddProfileDialog open={addOpen} onClose={() => setAddOpen(false)} existing={drafts} onAdd={addProfile} />
      <ConfirmDialog
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        onConfirm={() => reset.mutate('agents')}
        loading={reset.isPending}
        danger
        title={t('profiles.resetTitle')}
        confirmLabel={t('profiles.reset')}
        message={t('profiles.resetText')}
      />
      <ConfirmDialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={() => {
          setDrafts((all) => {
            if (!all || !toDelete) return all;
            const { [toDelete]: _removed, ...rest } = all;
            return rest;
          });
          setToDelete(null);
        }}
        danger
        title={t('profiles.removeTitle')}
        confirmLabel={t('common.remove')}
        message={rich(t('profiles.removeText'), {
          name: <strong className="text-fg">{toDelete && (text(drafts[toDelete]?.label, lang) || toDelete)}</strong>,
        })}
      />
    </div>
  );
}

function ProfileForm({
  id,
  draft: d,
  error,
  secretNames,
  providers,
  onChange,
  onDelete,
}: {
  id: string;
  draft: ProfileDraft;
  error?: string;
  secretNames: string[];
  providers: Record<string, ApiProvider>;
  onChange: (patch: Partial<ProfileDraft>) => void;
  onDelete: () => void;
}) {
  const t = useT();
  const { lang } = useLanguage();
  const [advanced, setAdvanced] = useState(() => !!d.contextWindow || !!d.maxOutputTokens);
  const providerEntries = Object.entries(providers);
  const selectedProviders = d.providers.map((pid) => providers[pid]).filter((p): p is ApiProvider => !!p);
  const modelSuggestions = Array.from(new Set(selectedProviders.flatMap((p) => [...(p.defaultModel ? [p.defaultModel] : []), ...p.models])));
  const defaultModel = selectedProviders.find((p) => p.defaultModel)?.defaultModel;
  const missingProviders = d.providers.filter((pid) => !providers[pid]);
  const parsed = splitCommand(d.commandText);
  const images = useImages();
  const derivedTool = profileTool({ command: parsed.length ? parsed : [''] });
  const tool = d.tool || derivedTool;
  const derivedAdapter = profileAdapter({ tool: d.tool || undefined, command: parsed.length ? parsed : [''] });
  const adapter = d.adapter || derivedAdapter;
  const adapterInfo = ADAPTERS[adapter];
  const adapterName = (a: AgentAdapter) => (a === 'generic' ? t('profiles.adapter.generic') : toolLabel(a));
  const missingTool = tool && toolState({ tool, command: parsed.length ? parsed : [''] }, images.data) === 'missing';
  const compatFor = (p: ApiProvider): Compat | undefined => (isModelProvider(p) ? providerCompat(adapter, p) : undefined);
  const effectiveCompat = (p: ApiProvider): Compat | undefined => (adapterInfo.customProviders ? compatFor(p) : isModelProvider(p) ? 'incompatible' : undefined);
  // Limits of the model this type uses (without the type's own overrides) – shown as placeholders.
  const limitsModel = profileModel({ providers: d.providers, model: d.model.trim() || undefined }, providers);
  const modelLimits = effectiveLimits({ providers, providerIds: limitsModel.providerIds, model: limitsModel.model });
  const modelLimitsText = limitsSummary(t, modelLimits.contextWindow, modelLimits.maxOutputTokens);
  const typedContext = parseTokens(d.contextWindow);
  const outputPlaceholder = String(
    effectiveLimits({
      start: typedContext !== undefined && !Number.isNaN(typedContext) && typedContext >= MIN_CONTEXT ? { contextWindow: typedContext } : undefined,
      providers,
      providerIds: limitsModel.providerIds,
      model: limitsModel.model,
    }).maxOutputTokens ?? '',
  );
  const limitsError = limitsPairError(t, d.contextWindow, d.maxOutputTokens);
  return (
    <Card>
      <CardHeader
        title={text(d.label, lang) || id}
        description={<span className="font-mono text-xs">{id}</span>}
        actions={
          <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={onDelete}>
            {t('common.remove')}
          </Button>
        }
      />
      <CardBody className="space-y-5">
        {error && <Callout tone="danger">{error}</Callout>}
        <div className="grid gap-4 md:grid-cols-2">
          <Field label={t('profiles.form.label')} hint={t('profiles.form.labelHint')}>
            <Input value={text(d.label, lang)} onChange={(e) => onChange({ label: e.target.value })} placeholder={id} />
          </Field>
          <Field label={t('profiles.form.description')} optional hint={t('profiles.form.descriptionHint')}>
            <Input value={text(d.description, lang)} onChange={(e) => onChange({ description: e.target.value })} />
          </Field>
        </div>

        <Field
          label={t('profiles.form.command')}
          error={parsed.length === 0 ? t('profiles.err.command') : undefined}
          hint={
            <>
              {t('profiles.form.commandHint')}
              {parsed.length > 1 && (
                <span className="mt-1 block">
                  {t('profiles.form.becomes')}{' '}
                  {parsed.map((p, i) => (
                    <code key={i} className="mr-1 rounded bg-surface-2 px-1 font-mono">
                      {p}
                    </code>
                  ))}
                </span>
              )}
            </>
          }
        >
          <Input value={d.commandText} onChange={(e) => onChange({ commandText: e.target.value })} className="font-mono" invalid={parsed.length === 0} placeholder="claude" />
        </Field>

        <div>
          <div className="mb-2 text-sm font-medium text-fg">{t('profiles.form.promptMode')}</div>
          <div className="grid gap-2.5 md:grid-cols-2">
            <ChoiceCard
              selected={d.promptMode === 'arg'}
              onSelect={() => onChange({ promptMode: 'arg' })}
              title={t('profiles.form.promptArg')}
              description={t('profiles.form.promptArgHint')}
            />
            <ChoiceCard
              selected={d.promptMode === 'input'}
              onSelect={() => onChange({ promptMode: 'input' })}
              title={t('profiles.form.promptInput')}
              description={t('profiles.form.promptInputHint')}
            />
          </div>
        </div>

        <div className="space-y-4 rounded-xl border border-line p-4">
          <div>
            <div className="text-sm font-medium text-fg">{t('profiles.adapter.title')}</div>
            <p className="mt-1 text-xs leading-relaxed text-fg-muted">{t('profiles.adapter.intro')}</p>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label={t('profiles.adapter.label')} hint={t('profiles.adapter.hint')}>
              <Select value={d.adapter} onChange={(e) => onChange({ adapter: e.target.value as ProfileDraft['adapter'] })}>
                <option value="">{t('profiles.adapter.auto', { adapter: adapterName(derivedAdapter) })}</option>
                {AgentAdapter.options.map((a) => (
                  <option key={a} value={a}>
                    {adapterName(a)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('profiles.tool.label')} hint={t('profiles.tool.hint')}>
              <Select value={d.tool} onChange={(e) => onChange({ tool: e.target.value as ProfileDraft['tool'] })}>
                <option value="">{derivedTool ? t('profiles.tool.auto', { tool: toolLabel(derivedTool) }) : t('profiles.tool.autoNone')}</option>
                {AgentTool.options.map((x) => (
                  <option key={x} value={x}>
                    {toolLabel(x)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <p className="text-xs leading-relaxed text-fg-muted">
            {!adapterInfo.customProviders
              ? t('profiles.adapter.noCustom', { adapter: adapterName(adapter) })
              : t('profiles.adapter.speaks', {
                  adapter: adapterName(adapter),
                  apis: adapterInfo.native.map((a) => apiLabel(t, a)).join(', ') || '–',
                }) + (adapterInfo.translated.length ? ' ' + t('profiles.adapter.translates', { apis: adapterInfo.translated.map((a) => apiLabel(t, a)).join(', ') }) : '')}
          </p>
          {missingTool && tool && (
            <Callout tone="warning" action={<InstallToolButton tool={tool} size="sm" />}>
              {t('profiles.tool.missing', { tool: toolLabel(tool) })}
            </Callout>
          )}
        </div>

        <div className="space-y-4 rounded-xl border border-line p-4">
          <div>
            <div className="flex items-center gap-2 text-sm font-medium text-fg">
              <Plug className="size-4 text-fg-muted" />
              {t('profiles.providers')}
            </div>
            <p className="mt-1 text-xs leading-relaxed text-fg-muted">{t('profiles.providersHint')}</p>
          </div>
          {providerEntries.length === 0 ? (
            <p className="text-sm text-fg-muted">
              {rich(t('profiles.noProviders'), {
                link: (
                  <Link to="/settings/providers" className="text-accent hover:underline">
                    {t('settingsNav.providers')}
                  </Link>
                ),
              })}
            </p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {providerEntries.map(([pid, p]) => (
                <Checkbox
                  key={pid}
                  checked={d.providers.includes(pid)}
                  onChange={(on) => onChange({ providers: on ? [...d.providers, pid] : d.providers.filter((x) => x !== pid) })}
                  label={
                    <span className="flex flex-wrap items-center gap-1.5">
                      {p.label}
                      {effectiveCompat(p) && <CompatBadge level={effectiveCompat(p)!} />}
                    </span>
                  }
                  description={t(`providers.kind.${p.kind}.short`)}
                />
              ))}
            </div>
          )}
          {selectedProviders.some((p) => effectiveCompat(p) === 'incompatible') && (
            <Callout tone="warning">{adapterInfo.customProviders ? t('profiles.compat.incompatible', { adapter: adapterName(adapter) }) : t('profiles.adapter.noCustom', { adapter: adapterName(adapter) })}</Callout>
          )}
          {selectedProviders.some((p) => effectiveCompat(p) === 'translated') && <p className="text-xs text-fg-muted">{t('profiles.compat.translated', { adapter: adapterName(adapter) })}</p>}
          {selectedProviders.some((p) => effectiveCompat(p) === 'unknown') && <p className="text-xs text-fg-muted">{t('profiles.compat.unknown')}</p>}
          {missingProviders.length > 0 && (
            <Callout tone="warning">
              {t('profiles.missingProviders', { ids: missingProviders.join(', ') })}{' '}
              <button type="button" className="text-accent hover:underline" onClick={() => onChange({ providers: d.providers.filter((x) => providers[x]) })}>
                {t('common.remove')}
              </button>
            </Callout>
          )}
          <Field label={t('profiles.model')} optional hint={defaultModel ? t('profiles.modelHintDefault', { model: defaultModel }) : t('profiles.modelHint')}>
            <ModelSelect
              key={modelSuggestions.join(',')}
              value={d.model}
              onChange={(model) => onChange({ model })}
              models={modelSuggestions}
              allowEmpty
              emptyLabel={defaultModel ? t('compat.model.providerDefault', { model: defaultModel }) : t('compat.model.default')}
              placeholder={defaultModel ?? ''}
            />
          </Field>
        </div>

        <Field label={t('profiles.form.secrets')} hint={t('profiles.form.secretsHint')}>
          <div className="grid gap-2 rounded-lg border border-line p-3 sm:grid-cols-2">
            {secretNames.map((name) => (
              <Checkbox
                key={name}
                checked={d.secrets.includes(name)}
                onChange={(on) => onChange({ secrets: on ? [...d.secrets, name] : d.secrets.filter((s) => s !== name) })}
                label={secretLabel(name, lang)}
                description={KNOWN_SECRETS[name] ? name : undefined}
              />
            ))}
          </div>
        </Field>

        <Field
          label={
            <span className="flex items-center gap-1.5">
              {t('profiles.form.hooks')}
              <InfoTip>{t('profiles.form.hooksTip')}</InfoTip>
            </span>
          }
          hint={t('profiles.form.hooksHint')}
        >
          <Select value={d.hooks} onChange={(e) => onChange({ hooks: e.target.value as ProfileDraft['hooks'] })}>
            <option value="">{t('profiles.form.hooksNone')}</option>
            <option value="claude-code">Claude Code</option>
            <option value="codex">OpenAI Codex</option>
          </Select>
        </Field>

        <Field label={t('profiles.form.env')} optional hint={t('profiles.form.envHint')}>
          <KeyValueEditor rows={d.env} onChange={(env) => onChange({ env })} />
        </Field>

        <div className="rounded-xl border border-line">
          <button type="button" onClick={() => setAdvanced((a) => !a)} className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-medium text-fg">
            {advanced ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
            {t('profiles.form.advanced')}
          </button>
          {advanced && (
            <div className="space-y-4 border-t border-line px-4 py-4">
              <div className="space-y-3 rounded-lg border border-line p-3">
                <LimitsIntro />
                <p className="text-xs leading-relaxed text-fg-muted">{t('limits.profile.intro')}</p>
                {limitsModel.model && (
                  <p className="text-xs text-fg-muted">
                    {modelLimitsText
                      ? t('limits.profile.fromModel', { model: limitsModel.model, summary: modelLimitsText })
                      : t('limits.profile.modelUnknown', { model: limitsModel.model })}
                  </p>
                )}
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label={t('limits.contextLabel')} optional hint={t('limits.contextHint')}>
                    <TokenInput
                      value={d.contextWindow}
                      onChange={(contextWindow) => onChange({ contextWindow })}
                      min={MIN_CONTEXT}
                      placeholder={modelLimits.contextWindow !== undefined ? String(modelLimits.contextWindow) : ''}
                    />
                  </Field>
                  <Field label={t('limits.outputLabel')} optional hint={t('limits.outputHint')}>
                    <TokenInput value={d.maxOutputTokens} onChange={(maxOutputTokens) => onChange({ maxOutputTokens })} min={MIN_OUTPUT} placeholder={outputPlaceholder} />
                  </Field>
                </div>
                {limitsError && <p className="text-xs text-red-600 dark:text-red-400">{limitsError}</p>}
              </div>
              <Field label={t('profiles.promptFlag.label')} optional hint={t('profiles.promptFlag.hint')}>
                <Input value={d.promptFlag} onChange={(e) => onChange({ promptFlag: e.target.value })} className="font-mono" placeholder="--prompt" disabled={d.promptMode !== 'arg'} />
              </Field>
              <p className="text-sm text-fg-muted">
                {t('profiles.form.patternsIntro')}
              </p>
              <Field label={t('profiles.form.working')} hint={t('profiles.form.workingHint')}>
                <Textarea value={d.workingPatterns} onChange={(e) => onChange({ workingPatterns: e.target.value })} rows={3} className="font-mono text-xs" />
              </Field>
              <Field label={t('profiles.form.blocked')} hint={t('profiles.form.blockedHint')}>
                <Textarea value={d.blockedPatterns} onChange={(e) => onChange({ blockedPatterns: e.target.value })} rows={4} className="font-mono text-xs" />
              </Field>
              <Field label={t('profiles.form.idle')} optional hint={t('profiles.form.idleHint')}>
                <Textarea value={d.idleForeground} onChange={(e) => onChange({ idleForeground: e.target.value })} rows={2} className="font-mono text-xs" />
              </Field>
            </div>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

function AddProfileDialog({ open, onClose, existing, onAdd }: { open: boolean; onClose: () => void; existing: Drafts; onAdd: (key: string, p: AgentProfile) => void }) {
  const t = useT();
  const { lang } = useLanguage();
  const [key, setKey] = useState('');
  const [template, setTemplate] = useState('blank');
  useEffect(() => {
    if (open) {
      setKey('');
      setTemplate('blank');
    }
  }, [open]);
  const keyErr = key && !KEY_RE.test(key) ? t('profiles.add.keyFormat') : existing[key] ? t('profiles.add.keyTaken') : undefined;

  const submit = () => {
    if (!key || keyErr) return;
    let profile: AgentProfile;
    if (template === 'autonomous') profile = CLAUDE_AUTONOMOUS;
    else if (template.startsWith('copy:')) profile = fromDraft(existing[template.slice(5)]!);
    else profile = { command: ['bash', '-l'], promptMode: 'input', secrets: [], env: {}, providers: [], workingPatterns: [], blockedPatterns: [], label: '' };
    onAdd(key, profile);
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="sm"
      title={t('profiles.newType')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={submit} disabled={!key || !!keyErr}>
            {t('profiles.add.create')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={t('profiles.add.key')} error={keyErr} hint={t('profiles.add.keyHint')}>
          <Input value={key} onChange={(e) => setKey(e.target.value.toLowerCase())} className="font-mono" placeholder={t('profiles.add.keyPlaceholder')} invalid={!!keyErr} onKeyDown={(e) => e.key === 'Enter' && submit()} />
        </Field>
        <Field label={t('profiles.add.template')}>
          <Select value={template} onChange={(e) => setTemplate(e.target.value)}>
            <option value="blank">{t('profiles.add.blank')}</option>
            <option value="autonomous">{text(CLAUDE_AUTONOMOUS.label, lang)}</option>
            {Object.entries(existing).map(([k, d]) => (
              <option key={k} value={`copy:${k}`}>
                {t('profiles.add.copyOf', { name: text(d.label, lang) || k })}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </Dialog>
  );
}
