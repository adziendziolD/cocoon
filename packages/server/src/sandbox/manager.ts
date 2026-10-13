import { randomBytes } from 'node:crypto';
import { planRepos, type MethodParams, type RepoSource, type Sandbox, type SandboxRepo } from '@cocoon/protocol';
import { agentNotesScript } from '../agents/notes.ts';
import { CLAUDE_SETTINGS, CODEX_NOTIFY, claudeStateSeed, installHooksScript } from '../agents/hooks.ts';
import { COCOON_DIR, STAGING_DIR, STATUS_DIR, STATUS_BIN, STATUS_SCRIPT, TMUX_CONF, TMUX_CONF_PATH } from '../agents/tmux.ts';
import type { EgressManager } from '../egress.ts';
import { CocoonError, notFound } from '../errors.ts';
import type { EventBus } from '../events.ts';
import { newId } from '../ids.ts';
import type { SecretsService } from '../secrets.ts';
import type { SettingsService } from '../settings.ts';
import { publicSandbox, type SandboxRecord, type Store } from '../store.ts';
import type { ExecOptions, ExecResult, SandboxDriver } from './driver.ts';
import { githubAuthEnv } from './git-auth.ts';
import { t } from '../i18n.ts';

export const BASELINE_TAG = 'cocoon-baseline';

/** Repositories of a sandbox (records from before multi-repo support only have `repo`). */
export function reposOf(record: Pick<SandboxRecord, 'repo' | 'repos'>): SandboxRepo[] {
  if (record.repos?.length) return record.repos;
  return record.repo ? [{ url: record.repo.url, ref: record.repo.ref, path: '' }] : [];
}

/** Lets other services (shared databases) react to the sandbox lifecycle without a circular dependency. */
export interface SandboxHooks {
  /** After the sandbox is running and bootstrapped. Must not throw. */
  created?(record: SandboxRecord, requestedServices: string[] | undefined): Promise<void>;
  /** After a stopped sandbox was started again. Must not throw. */
  started?(record: SandboxRecord): Promise<void>;
  /** Before the sandbox is removed. Must not throw. */
  deleting?(record: SandboxRecord): Promise<void>;
}

export class SandboxManager {
  private hooks: SandboxHooks[] = [];

  constructor(
    private readonly settings: SettingsService,
    private readonly secrets: SecretsService,
    private readonly driver: SandboxDriver,
    private readonly store: Store,
    private readonly bus: EventBus,
    private readonly egress: EgressManager,
  ) {}

  addHooks(hooks: SandboxHooks): void {
    this.hooks.push(hooks);
  }

  list(): Sandbox[] {
    return this.store.sandboxes().map(publicSandbox);
  }

  get(id: string): Sandbox {
    return publicSandbox(this.record(id));
  }

  record(id: string): SandboxRecord {
    const record = this.store.sandbox(id);
    if (!record) throw notFound('Sandbox', id);
    return record;
  }

  update(id: string, patch: Partial<Pick<SandboxRecord, 'pushedBranch' | 'pushedBranches' | 'grants' | 'services' | 'serviceDbs' | 'ports'>>): void {
    this.save(Object.assign(this.record(id), patch));
  }

  /** Public rename / move to another workspace. */
  rename(params: MethodParams<'sandbox.update'>): Sandbox {
    const record = this.record(params.sandboxId);
    if (params.name && params.name !== record.name) {
      if (this.store.sandboxes().some((s) => s.name === params.name)) throw new CocoonError('conflict', t('error.sandboxNameTaken', { name: params.name }));
      record.name = params.name;
    }
    if (params.workspaceId !== undefined) {
      if (params.workspaceId && !this.store.workspace(params.workspaceId)) throw notFound('Workspace', params.workspaceId);
      record.workspaceId = params.workspaceId ?? undefined;
    }
    this.save(record);
    return publicSandbox(record);
  }

  /** Returns the driver handle of a running sandbox, or throws. */
  runningHandle(id: string): string {
    const record = this.record(id);
    if (record.status !== 'running' || !record.handle) {
      throw new CocoonError('conflict', t('error.sandboxNotRunning', { name: record.name, status: record.status }));
    }
    return record.handle;
  }

  /** @param internal fields set by CoCoon (not part of the public API). */
  async create(params: MethodParams<'sandbox.create'>, internal: { taskId?: string } = {}): Promise<Sandbox> {
    const defaults = this.settings.get().sandbox;
    const active = this.store.sandboxes().filter((s) => s.status === 'running' || s.status === 'creating');
    if (active.length >= defaults.maxSandboxes) {
      throw new CocoonError('conflict', t('error.sandboxLimit', { max: defaults.maxSandboxes }));
    }
    const network = params.network ?? defaults.network;
    const sources: RepoSource[] = [...(params.repo ? [params.repo] : []), ...(params.repos ?? [])];
    const repos = planRepos(sources);
    if (new Set(repos.map((r) => r.path)).size !== repos.length) throw new CocoonError('bad_request', t('error.repoPathTaken', { path: repos.find((r, i) => repos.findIndex((o) => o.path === r.path) !== i)?.path ?? '' }));
    if (repos.length && network === 'none') {
      throw new CocoonError('bad_request', t('error.repoNeedsNetwork'));
    }
    if (params.name && this.store.sandboxes().some((s) => s.name === params.name)) {
      throw new CocoonError('conflict', t('error.sandboxNameTaken', { name: params.name }));
    }

    const id = newId('sb');
    const record: SandboxRecord = {
      id,
      name: params.name ?? id,
      image: params.image ?? defaults.image,
      status: 'creating',
      network,
      runtime: params.runtime === undefined ? defaults.runtime : params.runtime,
      resources: { ...defaults.resources, ...params.resources },
      repo: sources[0],
      repos,
      workdir: defaults.workdir,
      createdAt: new Date().toISOString(),
      proxyToken: randomBytes(16).toString('hex'),
      workspaceId: params.workspaceId,
      taskId: internal.taskId,
      services: [],
    };
    if (params.workspaceId && !this.store.workspace(params.workspaceId)) throw notFound('Workspace', params.workspaceId);
    this.save(record);

    try {
      const { handle } = await this.driver.create({
        sandboxId: id,
        name: record.name,
        image: record.image,
        network: record.network,
        runtime: record.runtime,
        resources: record.resources,
        workdir: record.workdir,
        // Agent CLIs come from the read-only toolbox; their self-updaters cannot (and must not) write there.
        env: { DISABLE_AUTOUPDATER: '1', ...(network === 'egress' ? this.egress.sandboxEnv(record) : {}), ...params.env },
        toolbox: true,
      });
      record.handle = handle;
      this.save(record);
      await this.driver.start(handle);
      // Saving the IP updates the proxy policy before the clone goes through it.
      record.ip = network === 'egress' ? await this.driver.address(handle) : undefined;
      this.save(record);
      if (network === 'egress') await this.egress.awaitPolicy();
      await this.bootstrap(handle, record);
      record.status = 'running';
    } catch (err) {
      record.status = 'error';
      record.error = (err as Error).message;
    }
    this.save(record);
    if (record.status === 'error') {
      throw new CocoonError('internal', t('error.sandboxCreateFailed', { error: record.error ?? '' }), { sandbox: publicSandbox(record) });
    }
    for (const hooks of this.hooks) await hooks.created?.(record, params.services);
    return publicSandbox(this.record(id));
  }

  async start(id: string): Promise<Sandbox> {
    const record = this.record(id);
    if (!record.handle) throw new CocoonError('conflict', t('error.sandboxNoContainer', { name: record.name }));
    await this.driver.start(record.handle);
    record.status = 'running';
    record.ip = record.network === 'egress' ? await this.driver.address(record.handle) : undefined;
    delete record.error;
    this.save(record);
    for (const hooks of this.hooks) await hooks.started?.(record);
    return publicSandbox(record);
  }

  async stop(id: string): Promise<Sandbox> {
    const record = this.record(id);
    if (record.handle) await this.driver.stop(record.handle);
    record.status = 'stopped';
    this.save(record);
    return publicSandbox(record);
  }

  async delete(id: string): Promise<void> {
    const record = this.record(id);
    for (const hooks of this.hooks) await hooks.deleting?.(record);
    if (record.handle) await this.driver.remove(record.handle);
    this.store.deleteSandbox(id);
    this.bus.publish({ type: 'sandbox.deleted', sandboxId: id });
  }

  /** Runs a command as the sandbox user in the workspace. */
  async exec(id: string, command: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    const record = this.record(id);
    return this.driver.exec(this.runningHandle(id), command, { workdir: record.workdir, timeoutMs: 60_000, ...opts });
  }

  /** Like exec(['sh','-c',script]) but throws with stderr on non-zero exit. */
  async sh(id: string, script: string, env: Record<string, string> = {}, timeoutMs = 120_000): Promise<string> {
    const res = await this.exec(id, ['sh', '-c', script], { env, timeoutMs });
    if (res.exitCode !== 0) throw new CocoonError('bad_request', (res.stderr || res.stdout).trim() || t('error.exitCode', { code: res.exitCode }));
    return res.stdout;
  }

  /** Syncs stored state with what actually exists in the driver (after a restart). */
  async reconcile(): Promise<void> {
    for (const record of this.store.sandboxes()) {
      if (!record.handle) {
        record.status = 'error';
        record.error ??= t('error.creationInterrupted');
      } else {
        const state = await this.driver.state(record.handle);
        record.status = state;
        if (state === 'running' && record.network === 'egress') record.ip = await this.driver.address(record.handle);
      }
      this.save(record);
    }
  }

  private async bootstrap(handle: string, record: SandboxRecord): Promise<void> {
    const run = async (script: string, env: Record<string, string>, opts: ExecOptions = {}) => {
      const res = await this.driver.exec(handle, ['sh', '-c', script], { env, timeoutMs: 600_000, ...opts });
      if (res.exitCode !== 0) throw new Error(res.stderr.trim() || `exit ${res.exitCode}`);
    };

    // As root: shared CoCoon files (tmux config, status hook script, world-writable status + staging dirs).
    await run(
      `mkdir -p ${COCOON_DIR}/bin ${STATUS_DIR} ${STAGING_DIR} && chmod 1777 ${STATUS_DIR} ${STAGING_DIR}
       printf '%s' "$TMUX_CONF" > ${TMUX_CONF_PATH}
       printf '%s' "$STATUS_SCRIPT" > ${STATUS_BIN} && chmod 755 ${STATUS_BIN}`,
      { TMUX_CONF, STATUS_SCRIPT },
      { user: 'root' },
    );

    const git = this.settings.get().git;
    await run(`git config --global user.name "$NAME" && git config --global user.email "$EMAIL"`, {
      NAME: git.authorName,
      EMAIL: git.authorEmail,
    });
    await run(installHooksScript, { CLAUDE_SETTINGS, CLAUDE_STATE: claudeStateSeed(record.workdir), CODEX_NOTIFY });

    const repos = reposOf(record);
    if (!repos.length) {
      await run(
        `mkdir -p "$WORKDIR" && cd "$WORKDIR" && git init --quiet && git commit --quiet --allow-empty -m baseline && git tag -f ${BASELINE_TAG} HEAD >/dev/null`,
        { WORKDIR: record.workdir },
      );
    }
    for (const repo of repos) await this.clone(handle, record, repo);
    await this.writeRepoNotes(handle, record);
  }

  /** Clones one repository into its folder and tags the baseline for diffs. */
  private async clone(handle: string, record: SandboxRecord, repo: SandboxRepo): Promise<void> {
    const dir = repo.path ? `${record.workdir}/${repo.path}` : record.workdir;
    const res = await this.driver.exec(
      handle,
      [
        'sh',
        '-c',
        `{ [ ! -e "$DIR" ] || [ -z "$(ls -A "$DIR" 2>/dev/null)" ]; } || { echo "$EXISTS" >&2; exit 1; }
         mkdir -p "$(dirname "$DIR")" && git clone --quiet -- "$REPO_URL" "$DIR" && cd "$DIR" && { [ -z "$REPO_REF" ] || git checkout --quiet "$REPO_REF"; } && git tag -f ${BASELINE_TAG} HEAD >/dev/null || exit $?
         # Keep nested repositories out of a repository in the workspace folder itself.
         if [ -n "$REL" ] && [ -d "$WORKDIR/.git" ]; then grep -qxF "/$REL/" "$WORKDIR/.git/info/exclude" 2>/dev/null || echo "/$REL/" >> "$WORKDIR/.git/info/exclude"; fi`,
      ],
      {
        env: {
          DIR: dir,
          REL: repo.path,
          WORKDIR: record.workdir,
          REPO_URL: repo.url,
          REPO_REF: repo.ref ?? '',
          EXISTS: t('error.repoPathTaken', { path: repo.path || '.' }),
          ...githubAuthEnv(repo.url, this.secrets.resolve('GITHUB_TOKEN')),
        },
        timeoutMs: 600_000,
      },
    );
    if (res.exitCode !== 0) throw new CocoonError('bad_request', t('error.repoCloneFailed', { url: repo.url, error: res.stderr.trim() || `exit ${res.exitCode}` }));
  }

  /** Adds another repository to a running sandbox. */
  async addRepo(params: MethodParams<'sandbox.add_repo'>): Promise<Sandbox> {
    const record = this.record(params.sandboxId);
    const handle = this.runningHandle(params.sandboxId);
    if (record.network === 'none') throw new CocoonError('bad_request', t('error.repoNeedsNetwork'));
    const existing = reposOf(record);
    // The workspace folder itself is always taken (a repository or the empty baseline repository lives there).
    const [repo] = planRepos([{ url: params.url, ref: params.ref, path: params.path }], ['.', ...existing.map((r) => r.path)]);
    if (!repo || existing.some((r) => r.path === repo.path)) throw new CocoonError('conflict', t('error.repoPathTaken', { path: repo?.path ?? '' }));
    await this.clone(handle, record, repo);
    const current = this.record(params.sandboxId);
    current.repos = [...reposOf(current), repo];
    current.repo ??= { url: repo.url, ref: repo.ref };
    this.save(current);
    await this.writeRepoNotes(handle, current).catch(() => undefined);
    return publicSandbox(current);
  }

  /** Removes a repository folder from a sandbox. */
  async removeRepo(sandboxId: string, path: string): Promise<Sandbox> {
    const record = this.record(sandboxId);
    const repos = reposOf(record);
    const repo = repos.find((r) => r.path === path);
    if (!repo) throw new CocoonError('not_found', t('error.repoNotFound', { path, repos: repos.map((r) => r.path || '.').join(', ') }));
    if (!repo.path) throw new CocoonError('bad_request', t('error.repoRootRemove'));
    const handle = this.runningHandle(sandboxId);
    await this.sh(sandboxId, 'rm -rf -- "$DIR"', { DIR: `${record.workdir}/${repo.path}` });
    record.repos = repos.filter((r) => r !== repo);
    if (record.repo?.url === repo.url && !record.repos.some((r) => r.url === repo.url)) record.repo = record.repos[0] && { url: record.repos[0].url, ref: record.repos[0].ref };
    if (record.pushedBranches) delete record.pushedBranches[repo.path];
    this.save(record);
    await this.writeRepoNotes(handle, record).catch(() => undefined);
    return publicSandbox(record);
  }

  /** Tells agents about the repository layout when a sandbox has several repositories. */
  private async writeRepoNotes(handle: string, record: SandboxRecord): Promise<void> {
    const repos = reposOf(record);
    const notes =
      repos.length > 1 || repos.some((r) => r.path)
        ? [
            '## Repositories in this workspace (set up by CoCoon)',
            '',
            `The workspace \`${record.workdir}\` contains several independent git repositories – run git commands inside the respective folder and keep changes that belong together consistent across them:`,
            '',
            ...repos.map((r) => `- \`${r.path || '.'}\` – ${r.url}${r.ref ? ` (${r.ref})` : ''}`),
          ].join('\n')
        : '';
    const res = await this.driver.exec(handle, ['sh', '-c', agentNotesScript('repos')], { env: { NOTES: notes }, timeoutMs: 30_000 });
    if (res.exitCode !== 0) throw new Error(res.stderr.trim());
  }

  private save(record: SandboxRecord): void {
    this.store.putSandbox(record);
    this.bus.publish({ type: 'sandbox.updated', sandbox: publicSandbox(record) });
  }
}
