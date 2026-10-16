import { execFile, execFileSync, spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { promisify } from 'node:util';
import {
  AGENT_TOOLS,
  AgentTool,
  type CocoonUpdateInfo,
  type ImageUpdateInfo,
  type ToolUpdateInfo,
  type UpdateState,
  type UpdateStatus,
  type UpdateTarget,
} from '@cocoon/protocol';
import type { ActivityLog } from './activity.ts';
import type { Config } from './config.ts';
import { CocoonError } from './errors.ts';
import type { EventBus } from './events.ts';
import { t } from './i18n.ts';
import { newId } from './ids.ts';
import {
  buildArgsFor,
  contextHash,
  LABEL_BASE,
  LABEL_CONTEXT,
  variantOf,
  type ContainerImageKind,
  type ImageService,
} from './images.ts';
import type { SandboxDriver } from './sandbox/driver.ts';
import type { Store } from './store.ts';
import { VERSION } from './version.ts';

const run = promisify(execFile);

/** Exit code that asks CoCoon's supervisor (supervisor.ts) to start the server again. */
export const RESTART_EXIT_CODE = 75;

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 60 * 1000;
const STEP_TIMEOUT_MS = 15 * 60 * 1000;

/** Compares dotted versions (1.2.10 > 1.2.9); a prerelease sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const clean = v.trim().replace(/^v/, '').split('+')[0]!;
    const dash = clean.indexOf('-');
    return { core: (dash < 0 ? clean : clean.slice(0, dash)).split('.').map((n) => Number(n) || 0), pre: dash < 0 ? '' : clean.slice(dash + 1) };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < Math.max(x.core.length, y.core.length); i++) {
    const diff = (x.core[i] ?? 0) - (y.core[i] ?? 0);
    if (diff) return Math.sign(diff);
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre.localeCompare(y.pre, 'en', { numeric: true });
}

/** Whether a built image matches what CoCoon would build now. */
export function assessImage(input: {
  exists: boolean;
  labels?: Record<string, string>;
  expectedContext: string;
  /** Digest the registry serves for the base image now (undefined = unknown). */
  remoteBaseDigest?: string;
}): Pick<ImageUpdateInfo, 'state' | 'reason'> {
  if (!input.exists) return { state: 'missing' };
  const labels = input.labels ?? {};
  if (!labels[LABEL_CONTEXT]) return { state: 'unknown', reason: 'untracked' };
  if (labels[LABEL_CONTEXT] !== input.expectedContext) return { state: 'outdated', reason: 'definition' };
  if (input.remoteBaseDigest && labels[LABEL_BASE] && input.remoteBaseDigest !== labels[LABEL_BASE]) return { state: 'outdated', reason: 'base' };
  return { state: 'current' };
}

/** Targets with something to update. Custom images and failed checks are not offered. */
export function availableTargets(status: Pick<UpdateStatus, 'cocoon' | 'tools' | 'images'>): UpdateTarget[] {
  const targets: UpdateTarget[] = [];
  if (status.cocoon.state === 'outdated' && !status.cocoon.blocked) targets.push('cocoon');
  if (status.tools.some((tool) => tool.state === 'outdated')) targets.push('tools');
  if (status.images.some((img) => img.state === 'outdated' || img.reason === 'untracked')) targets.push('images');
  return targets;
}

const message = (err: unknown) => {
  const e = err as { stderr?: string; message?: string };
  return (e.stderr?.trim() || e.message || String(err)).split('\n')[0]!;
};

async function git(dir: string, args: string[], timeout = 60_000): Promise<string> {
  const { stdout } = await run('git', args, {
    cwd: dir,
    timeout,
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
  });
  return stdout.trim();
}

/** Compares CoCoon's git checkout with its upstream branch (after "git fetch" if asked to). */
export async function checkCocoon(dir: string, version: string, opts: { fetch: boolean }): Promise<CocoonUpdateInfo> {
  const info: CocoonUpdateInfo = { state: 'unknown', version, behind: 0, ahead: 0, changes: [] };
  try {
    const top = await git(dir, ['rev-parse', '--show-toplevel']);
    if (realpathSync(top) !== realpathSync(dir)) return { ...info, blocked: 'notGit' };
  } catch {
    return { ...info, blocked: 'notGit' };
  }
  info.commit = await git(dir, ['rev-parse', '--short', 'HEAD']);
  info.branch = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  try {
    info.upstream = await git(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  } catch {
    return { ...info, blocked: 'noUpstream' };
  }
  if (opts.fetch) {
    const remote = await git(dir, ['config', `branch.${info.branch}.remote`]).catch(() => info.upstream!.split('/')[0]!);
    await git(dir, ['fetch', '--quiet', remote], 120_000).catch((err) => (info.error = message(err)));
  }
  const [ahead = 0, behind = 0] = (await git(dir, ['rev-list', '--left-right', '--count', 'HEAD...@{u}'])).split(/\s+/).map(Number);
  info.ahead = ahead;
  info.behind = behind;
  info.latestCommit = await git(dir, ['rev-parse', '--short', '@{u}']);
  info.latestVersion = await git(dir, ['show', '@{u}:package.json'])
    .then((json) => (JSON.parse(json) as { version?: string }).version)
    .catch(() => undefined);
  if (behind > 0) {
    const log = await git(dir, ['log', '--format=%h%x09%s', '-n', '30', 'HEAD..@{u}']);
    info.changes = log
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [commit = '', ...subject] = line.split('\t');
        return { commit, subject: subject.join('\t') };
      });
    if (ahead > 0) info.blocked = 'diverged';
    else if (await git(dir, ['status', '--porcelain', '--untracked-files=no'])) info.blocked = 'dirty';
  }
  info.state = behind > 0 ? 'outdated' : info.error ? 'unknown' : 'current';
  return info;
}

/** Newest version of an npm package (its "latest" dist-tag, which is what "npm install" picks). */
export async function latestNpmVersion(pkg: string): Promise<string> {
  const registry = (process.env.npm_config_registry || 'https://registry.npmjs.org/').replace(/\/?$/, '/');
  const res = await fetch(`${registry}${pkg.replace('/', '%2f')}/latest`, { signal: AbortSignal.timeout(15_000), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`npm registry: HTTP ${res.status}`);
  const { version } = (await res.json()) as { version?: string };
  if (!version) throw new Error('npm registry: no version');
  return version;
}

/** The pnpm that started this server (so an update uses the same one), else pnpm from PATH. */
function pnpmCommand(args: string[]): [string, string[]] {
  const exec = process.env.npm_execpath;
  if (exec && /pnpm/i.test(basename(exec))) return /\.[cm]?js$/.test(exec) ? [process.execPath, [exec, ...args]] : [exec, args];
  return ['pnpm', args];
}

/** Runs a command and streams stdout/stderr line by line. Resolves with the exit code. */
function stream(cmd: string, args: string[], cwd: string, onLine: (line: string) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    // CI=true: pnpm never waits for a confirmation (e.g. when it has to recreate node_modules).
    const child = spawn(cmd, args, { cwd, env: { ...process.env, CI: 'true', GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill('SIGTERM'), STEP_TIMEOUT_MS);
    for (const out of [child.stdout, child.stderr]) {
      let buffer = '';
      out.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) if (line.trim()) onLine(line);
      });
      out.on('end', () => buffer.trim() && onLine(buffer));
    }
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code ?? -1);
    });
  });
}

/**
 * Keeps CoCoon up to date: checks whether CoCoon itself (git), the agent CLIs (npm) and CoCoon's images (Dockerfile and
 * base image) are current, and updates them on request. CoCoon updates itself with git + pnpm and then restarts, if it
 * runs under its supervisor.
 */
export class UpdateService {
  private last?: UpdateStatus;
  private checking?: Promise<UpdateStatus>;
  private running = false;
  private restartRequired = false;
  private restarting = false;
  private notified = '';
  private timers: NodeJS.Timeout[] = [];
  readonly canRestart = process.env.COCOON_SUPERVISED === '1';
  private readonly installedCommit: string | undefined;

  constructor(
    private readonly config: Config,
    private readonly driver: SandboxDriver,
    private readonly images: ImageService,
    private readonly store: Store,
    private readonly bus: EventBus,
    private readonly activity: ActivityLog,
    private readonly onRestart: () => void,
    private readonly log: (msg: string, err?: unknown) => void,
  ) {
    try {
      this.installedCommit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: config.repoDir, stdio: 'pipe', timeout: 5000 }).toString().trim();
    } catch {
      this.installedCommit = undefined;
    }
    images.onFinished(() => {
      if (!this.running && this.last) void this.check({ fetch: false }).catch(() => undefined);
    });
  }

  /** Checks shortly after start and then daily (COCOON_UPDATE_CHECK=0 turns this off). */
  start(): void {
    if (process.env.COCOON_UPDATE_CHECK === '0') return;
    const tick = () =>
      void this.check({ fetch: true })
        .then((status) => this.announce(status))
        .catch((err) => this.log('update check failed', err));
    this.timers.push(setTimeout(tick, FIRST_CHECK_DELAY_MS).unref(), setInterval(tick, CHECK_INTERVAL_MS).unref());
  }

  stop(): void {
    this.timers.forEach(clearTimeout);
  }

  /** Last known status; checks the remotes on the first call or when asked to. */
  async status(refresh = false): Promise<UpdateStatus> {
    if (refresh || !this.last) await this.check({ fetch: true });
    return this.snapshot();
  }

  /** Installed commit of CoCoon, once known. */
  commit(): string | undefined {
    return this.last?.cocoon.commit ?? this.installedCommit;
  }

  /** Starts updating the given targets (default: everything outdated) in the background. */
  async apply(targets?: UpdateTarget[]): Promise<UpdateTarget[]> {
    if (this.running) throw new CocoonError('conflict', t('error.updateRunning'));
    const chosen = targets?.length ? targets : (await this.status()).available;
    if (!chosen.length) return [];
    this.running = true;
    this.publish();
    void this.runUpdate(chosen);
    return chosen;
  }

  restart(): void {
    if (!this.canRestart) throw new CocoonError('bad_request', t('error.restartUnsupported'));
    this.restarting = true;
    this.activity.add('info', 'activity.restarting');
    this.publish();
    // Let the response and the status event go out first.
    setTimeout(() => this.onRestart(), 500).unref();
  }

  private snapshot(): UpdateStatus {
    const base = this.last!;
    return { ...base, running: this.running, restartRequired: this.restartRequired, canRestart: this.canRestart, restarting: this.restarting };
  }

  private publish(): void {
    if (this.last) this.bus.publish({ type: 'update.status', status: this.snapshot() });
  }

  private check(opts: { fetch: boolean }): Promise<UpdateStatus> {
    this.checking ??= this.runCheck(opts).finally(() => (this.checking = undefined));
    return this.checking;
  }

  private async runCheck(opts: { fetch: boolean }): Promise<UpdateStatus> {
    const [cocoon, tools, images] = await Promise.all([
      checkCocoon(this.config.repoDir, VERSION, opts).catch(
        (err): CocoonUpdateInfo => ({ state: 'unknown', version: VERSION, behind: 0, ahead: 0, changes: [], error: message(err) }),
      ),
      this.checkTools(),
      this.checkImages(),
    ]);
    const status = { cocoon, tools, images };
    this.last = {
      ...status,
      checkedAt: new Date().toISOString(),
      available: availableTargets(status),
      running: this.running,
      restartRequired: this.restartRequired,
      canRestart: this.canRestart,
      restarting: this.restarting,
    };
    this.publish();
    return this.last;
  }

  private async checkTools(): Promise<ToolUpdateInfo[]> {
    const toolbox = this.store.toolbox();
    if (!toolbox?.installedAt) return [];
    const versions = await this.images.toolVersions().catch(() => undefined);
    return Promise.all(
      toolbox.tools.flatMap((name) => {
        const parsed = AgentTool.safeParse(name);
        if (!parsed.success) return [];
        const tool = parsed.data;
        const { label, npm } = AGENT_TOOLS[tool];
        const installed = versions?.[npm];
        return [
          latestNpmVersion(npm).then(
            (latest): ToolUpdateInfo => {
              const state: UpdateState = !installed ? 'unknown' : compareVersions(latest, installed) > 0 ? 'outdated' : 'current';
              return { tool, label, npm, installed, latest, state };
            },
            (err): ToolUpdateInfo => ({ tool, label, npm, installed, state: 'unknown', error: message(err) }),
          ),
        ];
      }),
    );
  }

  private async checkImages(): Promise<ImageUpdateInfo[]> {
    if (!this.driver.capabilities.images) return [];
    return Promise.all(
      (['sandbox', 'proxy'] as const).map(async (kind): Promise<ImageUpdateInfo> => {
        const ref = this.images.ref(kind);
        const base = this.images.baseOf(kind);
        if (kind === 'sandbox' && !this.images.managesSandboxImage()) return { kind, ref, state: 'unknown', reason: 'custom' };
        const details = await this.driver.imageDetails(ref);
        const variant = variantOf(details?.labels) ?? 'slim';
        const expectedContext = contextHash(this.images.contextDir(kind), buildArgsFor(kind, variant));
        const remoteBaseDigest = details?.labels?.[LABEL_BASE] && base ? await this.driver.registryDigest(base) : undefined;
        return {
          kind,
          ref,
          base,
          builtAt: details?.createdAt,
          ...(kind === 'sandbox' && details ? { variant } : {}),
          ...assessImage({ exists: Boolean(details), labels: details?.labels, expectedContext, remoteBaseDigest }),
        };
      }),
    );
  }

  /** Activity entry when new updates show up (once per set of updates). */
  private announce(status: UpdateStatus): void {
    const key = status.available.join(',');
    if (key && key !== this.notified) this.activity.add('info', 'activity.updatesAvailable', { items: key });
    this.notified = key;
  }

  private async runUpdate(targets: UpdateTarget[]): Promise<void> {
    let updated = false;
    try {
      // CoCoon first: an update may change the Dockerfiles, so the images are rebuilt from the new ones.
      if (targets.includes('cocoon')) updated = await this.updateCocoon();
      if (targets.includes('images')) {
        for (const img of await this.checkImages()) {
          if (img.state === 'current' || img.reason === 'custom') continue;
          await this.images.build(img.kind as ContainerImageKind, { variant: img.variant, pull: true }).done;
        }
      }
      // Toolboxes from before the sandbox image lost Node.js have none of their own: reinstall them with the rebuilt image.
      const runtimeMissing = targets.includes('images') && this.images.toolboxReady() && !(await this.images.toolboxHasRuntime());
      if (targets.includes('tools') || runtimeMissing) {
        const tools = this.images.installedTools();
        if (tools.length) await this.images.build('agents', { tools, pull: true }).done;
      }
    } catch (err) {
      this.log('update failed', err);
    } finally {
      if (updated) this.restartRequired = true;
      // Check before reporting "done", so nobody sees the status from before the update.
      await this.check({ fetch: false }).catch(() => undefined);
      this.running = false;
      this.publish();
    }
    if (updated && this.canRestart) this.restart();
  }

  /** git merge --ff-only, pnpm install, web build; rolls back to the previous commit if a step fails. */
  private async updateCocoon(): Promise<boolean> {
    const dir = this.config.repoDir;
    const buildId = newId('bd');
    const emit = (status: 'running' | 'succeeded' | 'failed', extra: { line?: string; error?: string } = {}) =>
      this.bus.publish({ type: 'update.progress', buildId, status, ...extra });
    const step = async (label: string, [cmd, args]: [string, string[]]) => {
      emit('running', { line: `$ ${label}` });
      const code = await stream(cmd, args, dir, (line) => emit('running', { line }));
      if (code !== 0) throw new Error(`${label} exited with ${code}`);
    };
    const gitStep = (...args: string[]) => step(`git ${args.join(' ')}`, ['git', args]);
    const pnpm = (...args: string[]) => step(`pnpm ${args.join(' ')}`, pnpmCommand(args));

    emit('running', { line: 'Checking for a new version …' });
    const info = await checkCocoon(dir, VERSION, { fetch: true });
    if (info.blocked) {
      const error = t(`update.blocked.${info.blocked}`);
      emit('failed', { error });
      this.activity.add('error', 'activity.cocoonUpdateFailed', { error });
      return false;
    }
    if (info.state !== 'outdated') {
      emit('succeeded', { line: info.error ?? t('update.upToDate') });
      return false;
    }

    const previous = await git(dir, ['rev-parse', 'HEAD']);
    try {
      await gitStep('merge', '--ff-only', '@{u}');
      await pnpm('install', '--frozen-lockfile');
      await pnpm('build:web');
      emit('succeeded', { line: `Updated to ${info.latestVersion ?? info.version} (${info.latestCommit}).` });
      this.activity.add('info', 'activity.cocoonUpdated', { version: info.latestVersion ?? info.version, commit: info.latestCommit ?? '' });
      return true;
    } catch (err) {
      const error = message(err);
      emit('running', { line: `Update failed – going back to ${previous.slice(0, 7)} …` });
      try {
        await gitStep('reset', '--keep', previous);
        await pnpm('install', '--frozen-lockfile');
        await pnpm('build:web');
      } catch (rollbackError) {
        emit('running', { line: `Rollback failed: ${message(rollbackError)}` });
      }
      emit('failed', { error });
      this.activity.add('error', 'activity.cocoonUpdateFailed', { error });
      return false;
    }
  }
}
