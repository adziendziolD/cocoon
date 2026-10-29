import { ADAPTERS, AGENT_TOOLS, DEFAULT_MODEL_FLAG, defaultMaxOutput, localize, parseSkillSource, profileAdapter, profileTool, type Agent, type AgentAdapter, type AgentProfile, type AgentStatus, type ApiStyle, type MethodParams, type MethodResult } from '@cocoon/protocol';
import { currentLanguage } from '../i18n.ts';
import type { ServiceManager } from '../services/manager.ts';
import type { EnvService } from '../env.ts';
import { PROXIED_SECRETS, placeholderFor, type EgressManager } from '../egress.ts';
import { GIT_CREDENTIAL_HELPER_SCRIPT } from '../sandbox/git-auth.ts';
import { containerReachableUrl, envPrefixFor, providerRoute, providerUrls, translatedRoute, type ProviderService } from '../providers.ts';
import { CocoonError, notFound } from '../errors.ts';
import type { EventBus } from '../events.ts';
import { newId } from '../ids.ts';
import { DockerDriver } from '../sandbox/docker.ts';
import type { SandboxDriver, TtySession } from '../sandbox/driver.ts';
import { BASELINE_TAG, reposOf, type SandboxManager } from '../sandbox/manager.ts';
import type { SecretsService } from '../secrets.ts';
import type { SettingsService } from '../settings.ts';
import { publicAgent, type AgentRecord, type SandboxRecord, type Store } from '../store.ts';
import { singleFileTar } from '../sandbox/tar.ts';
import { CODEX_TRUST_SCRIPT, MERGE_CONFIG_SCRIPT, wireEndpoint, type ConfigFile } from './adapters.ts';
import { approveClaudeKeyScript } from './hooks.ts';
import { INSTALL_SKILL_SCRIPT, skillsDirFor } from './skills.ts';
import { githubAuthEnv } from '../sandbox/git-auth.ts';

/** uid of the sandbox user in CoCoon's images and in bubblewrap sandboxes. */
const SANDBOX_UID = 1000;
import { StatusDetector, type Observation } from './status.ts';
import * as tmux from './tmux.ts';
import { t } from '../i18n.ts';

const SNAPSHOT_LINES = 60;

export class AgentManager {
  private readonly detectors = new Map<string, StatusDetector>();
  private timer?: NodeJS.Timeout;
  private polling = false;

  constructor(
    private readonly settings: SettingsService,
    private readonly secrets: SecretsService,
    private readonly providers: ProviderService,
    private readonly driver: SandboxDriver,
    private readonly sandboxes: SandboxManager,
    private readonly store: Store,
    private readonly bus: EventBus,
    private readonly egress: EgressManager,
    private readonly services: ServiceManager,
    private readonly envs: EnvService,
    private readonly log: (msg: string, err?: unknown) => void,
  ) {}

  kinds(): string[] {
    return Object.keys(this.settings.get().agents);
  }

  list(sandboxId?: string): Agent[] {
    return this.store
      .agents()
      .filter((a) => !sandboxId || a.sandboxId === sandboxId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(publicAgent);
  }

  get(id: string): Agent {
    return publicAgent(this.record(id));
  }

  async spawn(params: MethodParams<'agent.spawn'>): Promise<Agent> {
    const profile = this.profile(params.kind);
    const handle = this.sandboxes.runningHandle(params.sandboxId);
    const sandbox = this.sandboxes.record(params.sandboxId);

    const id = newId('ag');
    await this.ensureTool(handle, profile);
    // Current .env files, and the credential proxy knows the routes of proxied variables.
    await this.envs.prepare(sandbox.id);
    const providerIds = params.providers ?? profile.providers;
    const wiring = await this.wireProviders(profile, providerIds, params.model ?? profile.model, sandbox, {
      contextWindow: params.contextWindow ?? profile.contextWindow,
      maxOutputTokens: params.maxOutputTokens ?? profile.maxOutputTokens,
    });
    const promptArgs = params.prompt && profile.promptMode === 'arg' ? [...(profile.promptFlag ? [profile.promptFlag] : []), params.prompt] : [];
    const command = [...profile.command, ...wiring.args, ...(params.args ?? []), ...promptArgs];
    if (wiring.files.length) {
      await this.driver.exec(handle, ['sh', '-c', MERGE_CONFIG_SCRIPT], { env: { COCOON_CONFIG_FILES: JSON.stringify(wiring.files) } });
    }
    await this.installSkills(handle, profile, wiring.adapter, sandbox);
    if (wiring.adapter === 'codex') {
      // The sandbox workspace is the agent's own – skip Codex' "Trust this folder?" dialog.
      // Every repository folder is its own Codex project.
      for (const dir of [sandbox.workdir, ...reposOf(sandbox).filter((r) => r.path).map((r) => `${sandbox.workdir}/${r.path}`)]) {
        await this.driver.exec(handle, ['sh', '-c', CODEX_TRUST_SCRIPT], { env: { WD: dir } });
      }
    }

    // Precedence (later wins): workspace → repository → sandbox variables, agent type, credentials/provider wiring, explicit.
    const env: Record<string, string> = {
      ...this.envs.injectedEnv(sandbox),
      ...profile.env,
      ...this.secretEnv(profile, sandbox, wiring.kinds, wiring.grants),
      ...wiring.env,
      ...(await this.services.agentEnv(sandbox.id)),
      COCOON_AGENT_ID: id,
      COCOON_SANDBOX_ID: sandbox.id,
      ...params.env,
    };
    if (wiring.grants.size) {
      const grants = [...new Set([...(sandbox.grants ?? []), ...wiring.grants])];
      if (grants.length !== (sandbox.grants ?? []).length) {
        this.sandboxes.update(sandbox.id, { grants });
        if (sandbox.network === 'egress') await this.egress.awaitPolicy();
      }
    }

    if (profile.hooks === 'claude-code' && env.ANTHROPIC_API_KEY && env.ANTHROPIC_API_KEY !== 'cocoon-no-key') {
      await this.driver.exec(handle, ['sh', '-c', approveClaudeKeyScript], { env: { KEY_TAIL: env.ANTHROPIC_API_KEY.slice(-20) } });
    }

    // Agents with a GitHub token can push with plain git.
    if (env.GITHUB_TOKEN) await this.driver.exec(handle, ['sh', '-c', GIT_CREDENTIAL_HELPER_SCRIPT]).catch(() => undefined);
    const envFile = `${tmux.STAGING_DIR}/env-${id}`;
    await this.driver.putArchive(
      handle,
      tmux.STAGING_DIR,
      singleFileTar(`env-${id}`, Buffer.from(tmux.envFileContent(env)), { uid: SANDBOX_UID, gid: SANDBOX_UID, mode: 0o600 }),
    );
    const res = await this.driver.exec(handle, tmux.newSession({ name: id, cwd: sandbox.workdir, command, envFile }));
    if (res.exitCode !== 0) throw new CocoonError('internal', t('error.agentStartFailed', { error: res.stderr.trim() }));

    const now = new Date().toISOString();
    const record: AgentRecord = {
      id,
      sandboxId: sandbox.id,
      kind: params.kind,
      command: promptArgs.length ? command.slice(0, -promptArgs.length) : command,
      prompt: params.prompt,
      providers: providerIds,
      model: wiring.model,
      contextWindow: wiring.contextWindow,
      maxOutputTokens: wiring.maxOutputTokens,
      status: 'idle',
      statusSource: 'heuristic',
      exitCode: null,
      createdAt: now,
      statusChangedAt: now,
    };
    this.detectors.set(id, new StatusDetector(profile, Boolean(params.prompt), this.settings.get().status.idleAfterMs));
    this.save(record);

    if (params.prompt && profile.promptMode === 'input') {
      await this.sendInput({ agentId: id, text: params.prompt, submit: true });
    }
    return publicAgent(record);
  }

  async sendInput({ agentId, text, submit = true }: MethodParams<'agent.send_input'>): Promise<void> {
    const handle = this.liveHandle(agentId);
    if (text) await this.tmuxOrThrow(handle, tmux.sendLiteral(agentId, text));
    if (submit) await this.tmuxOrThrow(handle, tmux.sendKeys(agentId, ['Enter']));
    this.detectors.get(agentId)?.arm();
  }

  async sendKeys(agentId: string, keys: string[]): Promise<void> {
    await this.tmuxOrThrow(this.liveHandle(agentId), tmux.sendKeys(agentId, keys));
    // Answering a prompt (Enter, y, Escape …) continues the task: its next quiet period means "done".
    this.detectors.get(agentId)?.arm();
  }

  async read(agentId: string, lines: number): Promise<string> {
    const record = this.record(agentId);
    const handle = this.sandboxes.runningHandle(record.sandboxId);
    return this.tmuxOrThrow(handle, tmux.capture(agentId, lines));
  }

  async wait({ agentId, until, timeoutMs }: MethodParams<'agent.wait'>): Promise<MethodResult<'agent.wait'>> {
    const targets = new Set<AgentStatus>(until ?? ['done', 'blocked', 'exited']);
    const current = this.get(agentId);
    if (targets.has(current.status)) return { agent: current, timedOut: false };

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        unsubscribe();
        // The sandbox may be gone meanwhile (the store removes its agents): report the last known state.
        let agent: Agent;
        try {
          agent = this.get(agentId);
        } catch {
          agent = { ...current, status: 'exited' };
        }
        resolve({ agent, timedOut: true });
      }, timeoutMs ?? 300_000);
      const unsubscribe = this.bus.subscribe((event) => {
        const agent =
          event.type === 'agent.updated' && event.agent.id === agentId ? event.agent
          : event.type === 'sandbox.deleted' && event.sandboxId === current.sandboxId ? { ...current, status: 'exited' as const }
          : undefined;
        if (agent && targets.has(agent.status)) {
          clearTimeout(timer);
          unsubscribe();
          resolve({ agent, timedOut: false });
        }
      });
    });
  }

  async kill(agentId: string): Promise<void> {
    const record = this.record(agentId);
    if (record.status !== 'exited') {
      const sandbox = this.store.sandbox(record.sandboxId);
      if (sandbox?.status === 'running' && sandbox.handle) await this.driver.exec(sandbox.handle, tmux.killSession(agentId));
    }
    this.setStatus(record, { status: 'exited', source: record.statusSource }, record.exitCode);
  }

  /**
   * Starts another agent in the same sandbox, optionally handing over the previous agent's task, changed files and last
   * output. `beforeStop` runs after the new agent exists and before the previous one is stopped (e.g. to move a task).
   */
  async switchAgent(params: MethodParams<'agent.switch'>, beforeStop?: (previous: Agent, next: Agent) => void): Promise<Agent> {
    const previous = this.record(params.agentId);
    let prompt = params.prompt?.trim() ?? '';
    if (params.handover !== false) {
      const handle = this.sandboxes.runningHandle(previous.sandboxId);
      const lastOutput = previous.status === 'exited' ? '' : await this.read(previous.id, 60).catch(() => '');
      const sandbox = this.sandboxes.record(previous.sandboxId);
      const repos = reposOf(sandbox);
      // One "git diff --stat" per repository; with several repositories each block is headed by its folder.
      const dirs = repos.length > 1 ? repos.map((r) => `${r.path}=${sandbox.workdir}/${r.path}`) : [`=${sandbox.workdir}${repos[0]?.path ? `/${repos[0].path}` : ''}`];
      const changes = await this.driver
        .exec(
          handle,
          [
            'sh',
            '-c',
            `for entry in "$@"; do name="\${entry%%=*}"; dir="\${entry#*=}"; out=$(cd "$dir" 2>/dev/null && git add -A >/dev/null 2>&1 && git diff --cached --stat ${BASELINE_TAG} 2>/dev/null | tail -20); [ -n "$out" ] && { [ -n "$name" ] && echo "[$name]"; echo "$out"; }; done`,
            'sh',
            ...dirs,
          ],
          { timeoutMs: 20_000 },
        )
        .then((r) => r.stdout.trim())
        .catch(() => '');
      prompt = [
        `You are taking over work in this ${repos.length > 1 ? 'workspace' : 'repository'} from another coding agent (${previous.kind}).`,
        previous.prompt ? `Original task:\n${previous.prompt}` : '',
        changes ? `Changes made so far (git diff --stat against the starting point):\n${changes}` : 'No files have been changed yet.',
        lastOutput.trim() ? `Last terminal output of the previous agent:\n\`\`\`\n${lastOutput.trim().slice(-4000)}\n\`\`\`` : '',
        prompt ? `Additional instructions:\n${prompt}` : 'Review the current state and continue the task.',
      ]
        .filter(Boolean)
        .join('\n\n');
    }
    const next = await this.spawn({
      sandboxId: previous.sandboxId,
      kind: params.kind,
      prompt: prompt || undefined,
      providers: params.providers,
      model: params.model,
      contextWindow: params.contextWindow,
      maxOutputTokens: params.maxOutputTokens,
    });
    beforeStop?.(publicAgent(previous), next);
    if (params.stopPrevious !== false && previous.status !== 'exited') await this.kill(previous.id).catch(() => undefined);
    return next;
  }

  async attach(agentId: string, size: { cols: number; rows: number }): Promise<TtySession> {
    return this.driver.attachTty(this.liveHandle(agentId), tmux.attach(agentId), size);
  }

  start(): void {
    const { idleAfterMs, pollIntervalMs } = this.settings.get().status;
    for (const record of this.store.agents()) {
      if (record.status !== 'exited' && !this.detectors.has(record.id)) {
        this.detectors.set(record.id, new StatusDetector(this.profileOrShell(record.kind), false, idleAfterMs, record.status));
      }
    }
    this.timer = setInterval(() => void this.poll(), pollIntervalMs);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /** Fails early with a helpful message if the agent CLI is not available in the sandbox. */
  private async ensureTool(handle: string, profile: AgentProfile): Promise<void> {
    const bin = profile.command[0];
    if (!bin) return;
    const res = await this.driver.exec(handle, ['sh', '-c', 'command -v "$1" >/dev/null', 'sh', bin], { timeoutMs: 10_000 });
    if (res.exitCode === 0) return;
    const tool = profileTool(profile);
    throw new CocoonError('bad_request', t('error.toolMissing', { tool: tool ? AGENT_TOOLS[tool].label : bin }));
  }

  /** Keys go through the credential proxy for every sandbox with network access (unless switched off). */
  private viaProxy(sandbox: SandboxRecord): boolean {
    return sandbox.network !== 'none' && this.settings.get().egress.credentialProxy;
  }

  /**
   * Secrets for the agent. In egress mode with credential proxy enabled, proxied API keys are replaced by
   * placeholders plus a base URL pointing at the proxy, so the real key never enters the sandbox.
   * Default Anthropic/OpenAI keys are skipped when a custom provider of that kind is wired in.
   */
  private secretEnv(profile: AgentProfile, sandbox: SandboxRecord, providerKinds: Set<string>, grants: Set<string>): Record<string, string> {
    const useProxy = this.viaProxy(sandbox);
    const env: Record<string, string> = {};
    for (const name of profile.secrets) {
      // A custom model provider replaces the default Anthropic/OpenAI credentials of the agent.
      if (providerKinds.size && ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY'].includes(name)) continue;
      // GITHUB_TOKEN inside the sandbox is the token chosen for this sandbox / workspace.
      const value = name === 'GITHUB_TOKEN' ? this.secrets.githubToken(sandbox) : this.secrets.resolve(name);
      if (!value) continue;
      const proxied = useProxy ? PROXIED_SECRETS[name] : undefined;
      if (proxied) {
        env[name] = placeholderFor(sandbox.proxyToken, name);
        env[proxied.baseUrlEnv] = `${this.egress.credentialUrl(sandbox, proxied.route)}${proxied.basePath}`;
        grants.add(proxied.route);
      } else {
        env[name] = value;
      }
    }
    return env;
  }

  /**
   * Env vars (and CLI args) wiring custom API providers into an agent:
   * anthropic → ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY | ANTHROPIC_AUTH_TOKEN (+ ANTHROPIC_MODEL),
   * openai → OPENAI_BASE_URL + OPENAI_API_KEY (+ OPENAI_MODEL), http → <PREFIX>_BASE_URL + <PREFIX>_API_KEY.
   * Through the credential proxy the agent only gets the proxy URL and a placeholder key.
   */
  /**
   * Wires the agent's providers in: http-kind providers as <PREFIX>_BASE_URL/_API_KEY, and the first model provider
   * through the agent's adapter (start parameters, env, config files). Picks the API style the agent speaks natively,
   * or lets the proxy translate from a chat-only endpoint; a model is required.
   */
  private async wireProviders(
    profile: AgentProfile,
    ids: string[],
    requestedModel: string | undefined,
    sandbox: SandboxRecord,
    limits: { contextWindow?: number; maxOutputTokens?: number } = {},
  ) {
    const useProxy = this.viaProxy(sandbox);
    const hostAlias = this.driver instanceof DockerDriver ? this.driver.hostAlias : undefined;
    const adapter = profileAdapter(profile);
    const info = ADAPTERS[adapter];
    const env: Record<string, string> = {};
    const args: string[] = [];
    const files: ConfigFile[] = [];
    const kinds = new Set<string>();
    const grants = new Set<string>();
    let model: string | undefined = requestedModel;
    let contextWindow = limits.contextWindow;
    let maxOutputTokens = limits.maxOutputTokens;

    for (const id of ids) {
      const provider = this.providers.get(id);
      const key = this.providers.key(provider);
      const keyValue = key && provider.secret ? (useProxy ? placeholderFor(sandbox.proxyToken, provider.secret) : key) : undefined;

      if (provider.kind === 'http') {
        const prefix = envPrefixFor(id, provider);
        env[`${prefix}_BASE_URL`] = useProxy ? this.egress.credentialUrl(sandbox, providerRoute(id)) : containerReachableUrl(provider.baseUrl, hostAlias);
        if (keyValue) env[`${prefix}_API_KEY`] = keyValue;
        if (useProxy) grants.add(providerRoute(id));
        continue;
      }
      if (kinds.size) continue; // one model provider per agent
      if (!info.customProviders) throw new CocoonError('bad_request', t('error.adapterNoProviders', { agent: profileLabel(profile, adapter) }));
      kinds.add(provider.kind);

      // Which API style: native if the endpoint offers one, else translation from chat in the proxy.
      const detected = await this.providers.apisOf(id).catch(() => [] as ApiStyle[]);
      const apis: ApiStyle[] = detected.length ? detected : provider.kind === 'anthropic' ? ['messages'] : ['chat', 'responses'];
      const preference: ApiStyle[] = provider.kind === 'anthropic' ? ['messages', 'chat', 'responses'] : ['chat', 'responses', 'messages'];
      let style = preference.find((candidate) => info.native.includes(candidate) && apis.includes(candidate));
      let translate = false;
      if (!style && info.translated.includes('chat') && apis.includes('chat')) {
        style = info.native[0];
        translate = true;
      }
      if (!style) {
        throw new CocoonError('bad_request', t('error.providerIncompatible', { agent: profileLabel(profile, adapter), provider: provider.label, apis: apis.join(', ') || '—' }));
      }
      if (translate && !useProxy) throw new CocoonError('bad_request', t('error.translationNeedsProxy', { agent: profileLabel(profile, adapter) }));

      model ??= profile.model ?? provider.defaultModel ?? provider.models[0];
      if (!model) model = (await this.providers.testAndRemember(id).catch(() => undefined))?.models[0];
      if (!model) throw new CocoonError('bad_request', t('error.modelRequired', { provider: provider.label }));

      // Limits: start/agent-type overrides, else what is known about the model; answer length defaults to a quarter.
      contextWindow ??= provider.modelInfo?.[model]?.contextWindow;
      maxOutputTokens ??= provider.modelInfo?.[model]?.maxOutputTokens ?? (contextWindow ? defaultMaxOutput(contextWindow) : undefined);

      const { root, v1Suffix } = providerUrls(provider);
      const route = translate ? translatedRoute(id, style) : providerRoute(id);
      let baseUrl: string;
      if (useProxy) {
        grants.add(route);
        const routeBase = this.egress.credentialUrl(sandbox, route);
        baseUrl = style === 'messages' ? routeBase : `${routeBase}${translate ? '/v1' : v1Suffix}`;
      } else {
        baseUrl = containerReachableUrl(style === 'messages' ? root : `${root}${v1Suffix}`, hostAlias);
      }
      const wiring = wireEndpoint(adapter, {
        label: provider.label,
        style,
        baseUrl,
        key: keyValue ?? 'none',
        keyHeader: provider.auth === 'x-api-key' ? 'x-api-key' : 'bearer',
        model,
        contextWindow,
        maxOutputTokens,
      });
      Object.assign(env, wiring.env);
      args.push(...wiring.args);
      files.push(...wiring.files);
    }
    if (model && !kinds.size) {
      env.COCOON_MODEL = model;
      // Default credentials (no custom provider): select the model through the CLI's own flag.
      const flag = DEFAULT_MODEL_FLAG[adapter];
      const set = (arg: string) => arg === '--model' || arg.startsWith('--model=') || arg === flag || (!!flag && arg.startsWith(`${flag}=`));
      if (flag && !profile.command.some(set)) args.push(flag, model);
    }
    if (adapter === 'codex') {
      // Codex' own command sandbox needs bubblewrap inside the container; CoCoon already isolates the agent.
      if (!profile.command.some((arg) => arg === '--sandbox' || arg === '-s')) args.unshift('--sandbox', 'danger-full-access');
    }

    return { env, args, files, kinds, grants, model, adapter, contextWindow, maxOutputTokens };
  }

  /** Installs the agent type's skills (GitHub references) into the skills folder of its CLI. */
  private async installSkills(handle: string, profile: AgentProfile, adapter: AgentAdapter, sandbox: SandboxRecord): Promise<void> {
    if (!profile.skills.length) return;
    const dir = skillsDirFor(adapter);
    if (!dir) return;
    const sources = profile.skills.map((skill) => {
      const source = parseSkillSource(skill);
      if (!source) throw new CocoonError('bad_request', t('error.skillInvalid', { skill }));
      return source;
    });
    if (sandbox.network === 'none') throw new CocoonError('bad_request', t('error.skillNeedsNetwork'));
    const token = this.secrets.githubToken(sandbox);
    for (const [i, source] of sources.entries()) {
      const res = await this.driver.exec(handle, ['sh', '-c', INSTALL_SKILL_SCRIPT], {
        env: { SKILLS_DIR: dir, SKILL_URL: source.url, SKILL_REF: source.ref ?? '', SKILL_PATH: source.path ?? '', SKILL_NAME: source.name, ...githubAuthEnv(source.url, token) },
        timeoutMs: 120_000,
      });
      if (res.exitCode !== 0) throw new CocoonError('bad_request', t('error.skillInstallFailed', { skill: profile.skills[i] ?? source.url, error: res.stderr.trim() || `exit ${res.exitCode}` }));
    }
  }

  /** One snapshot exec per sandbox with live agents; updates status and emits events on change. */
  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const live = this.store.agents().filter((a) => a.status !== 'exited');
      const bySandbox = Map.groupBy(live, (a) => a.sandboxId);
      await Promise.all(
        [...bySandbox].map(async ([sandboxId, agents]) => {
          const sandbox = this.store.sandbox(sandboxId);
          if (!sandbox || sandbox.status !== 'running' || !sandbox.handle) {
            // A stopped sandbox loses its tmux server, so its agents are gone.
            for (const agent of agents) this.setStatus(agent, { status: 'exited', source: 'heuristic' }, agent.exitCode);
            return;
          }
          let snapshots: Map<string, tmux.SessionSnapshot>;
          try {
            const res = await this.driver.exec(sandbox.handle, tmux.snapshotAll(SNAPSHOT_LINES), { timeoutMs: 10_000 });
            snapshots = tmux.parseSnapshot(res.stdout);
          } catch (err) {
            this.log(`status poll failed for ${sandboxId}`, err);
            for (const agent of agents) this.setStatus(agent, { status: 'unknown', source: 'heuristic' }, agent.exitCode);
            return;
          }
          for (const agent of agents) {
            const snap = snapshots.get(agent.id);
            if (!snap) this.setStatus(agent, { status: 'exited', source: 'heuristic' }, agent.exitCode);
            else if (snap.dead) this.setStatus(agent, { status: 'exited', source: 'heuristic' }, snap.exitCode);
            else {
              const observation = this.detectors.get(agent.id)?.observe(snap.screen, snap.foreground, snap.reported);
              this.setStatus(agent, observation ?? { status: 'unknown', source: 'heuristic' }, null);
            }
          }
        }),
      );
    } finally {
      this.polling = false;
    }
  }

  private setStatus(record: AgentRecord, { status, source }: { status: AgentStatus; source: Observation['source'] }, exitCode: number | null): void {
    if (record.status === status && record.exitCode === exitCode && record.statusSource === source) return;
    record.status = status;
    record.statusSource = source;
    record.exitCode = exitCode;
    record.statusChangedAt = new Date().toISOString();
    if (status === 'exited') this.detectors.delete(record.id);
    this.save(record);
  }

  private save(record: AgentRecord): void {
    this.store.putAgent(record);
    this.bus.publish({ type: 'agent.updated', agent: publicAgent(record) });
  }

  private liveHandle(agentId: string): string {
    const record = this.record(agentId);
    if (record.status === 'exited') throw new CocoonError('conflict', t('error.agentExited', { id: agentId }));
    return this.sandboxes.runningHandle(record.sandboxId);
  }

  private async tmuxOrThrow(handle: string, command: string[]): Promise<string> {
    const res = await this.driver.exec(handle, command, { timeoutMs: 10_000 });
    if (res.exitCode !== 0) throw new CocoonError('internal', `tmux: ${res.stderr.trim()}`);
    return res.stdout;
  }

  private record(id: string): AgentRecord {
    const record = this.store.agent(id);
    if (!record) throw notFound('Agent', id);
    return record;
  }

  profile(kind: string): AgentProfile {
    const profile = this.settings.get().agents[kind];
    if (!profile) throw new CocoonError('bad_request', t('error.unknownAgentKind', { kind, available: this.kinds().join(', ') }));
    return profile;
  }

  private profileOrShell(kind: string): AgentProfile {
    const agents = this.settings.get().agents;
    return agents[kind] ?? agents.shell ?? { command: ['sh'], promptMode: 'input', secrets: [], env: {}, providers: [], skills: [], workingPatterns: [], blockedPatterns: [] };
  }
}

function profileLabel(profile: AgentProfile, adapter: AgentAdapter): string {
  return localize(profile.label, currentLanguage()) ?? adapter;
}
