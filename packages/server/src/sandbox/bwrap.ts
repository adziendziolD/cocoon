import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, posix } from 'node:path';
import { Duplex, type Readable } from 'node:stream';
import { promisify } from 'node:util';
import type { DriverCapabilities, NetworkMode } from '@cocoon/protocol';
import { COCOON_DIR, TMUX_CONF, TMUX_CONF_PATH } from '../agents/tmux.ts';
import { CocoonError } from '../errors.ts';
import { t } from '../i18n.ts';
import {
  INSTALL_TOOLBOX_SCRIPT,
  parseNodeVersion,
  readToolVersions,
  SANDBOX_PATH,
  TOOLBOX_PATH,
  type ExecOptions,
  type ExecResult,
  type ImageDetails,
  type RuntimeState,
  type SandboxDriver,
  type SandboxSpec,
  type TtySession,
} from './driver.ts';

const run = promisify(execFile);
const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;
const SANDBOX_UID = '1000';
const HOME = '/home/agent';

/** Host paths that are made visible read-only inside every sandbox (if they exist). */
const SYSTEM_PATHS = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/lib32', '/opt/homebrew'];
const SYSTEM_ETC = [
  '/etc/ssl', '/etc/pki', '/etc/ca-certificates', '/etc/resolv.conf', '/etc/hosts', '/etc/nsswitch.conf', '/etc/localtime',
  '/etc/alternatives', '/etc/ld.so.cache', '/etc/ld.so.conf', '/etc/ld.so.conf.d', '/etc/crypto-policies', '/etc/terminfo',
  '/etc/gitconfig', '/etc/mime.types',
];

interface Meta {
  name: string;
  network: NetworkMode;
  workdir: string;
  env: Record<string, string>;
  toolbox: boolean;
}

/**
 * Lightweight sandboxes with bubblewrap (Linux): no daemon, no images, start in milliseconds.
 * Each sandbox is a directory (workspace, home, tmp, /opt/cocoon) on the host; the host system is mounted read-only and
 * processes run in their own user/pid/ipc/uts (and, for "none", network) namespaces without capabilities.
 * A long-running "keeper" (tmux server) per sandbox keeps agents alive across control-plane restarts.
 * Trade-offs: shares the host kernel and installed tools, no resource limits, and no enforced egress: only the "none"
 * network mode gets its own network namespace. Sandboxes with network ("egress", "open") share the host's network
 * (localhost services, CoCoon itself, cloud metadata) and merely get the egress proxy configured, so they are refused
 * unless the operator opted in (`allowHostNetwork`, COCOON_BWRAP_HOST_NETWORK=1).
 */
export class BwrapDriver implements SandboxDriver {
  readonly kind = 'bwrap' as const;
  readonly name = 'bubblewrap';
  readonly capabilities: DriverCapabilities = { images: false, resourceLimits: false, enforcedEgress: false, runtimes: false };
  private readonly root: string;
  readonly toolboxDir: string;

  constructor(
    dataDir: string,
    private readonly opts: { allowHostNetwork?: boolean } = {},
  ) {
    this.root = join(dataDir, 'sandboxes');
    this.toolboxDir = join(dataDir, 'agents');
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  async check(): Promise<void> {
    if (process.platform !== 'linux') throw new Error('bubblewrap sandboxes require Linux');
    await run('bwrap', ['--unshare-user', '--ro-bind', '/', '/', 'true']).catch((err: Error) => {
      throw new Error(`bubblewrap is not usable (${err.message}). Install it (e.g. apt install bubblewrap) and allow unprivileged user namespaces.`);
    });
  }

  async info(): Promise<{ version?: string; runtimes: string[] }> {
    const { stdout } = await run('bwrap', ['--version']).catch(() => ({ stdout: '' }));
    return { version: stdout.trim().replace(/^bubblewrap\s*/, '') || undefined, runtimes: [] };
  }

  async create(spec: SandboxSpec): Promise<{ handle: string }> {
    this.requireNetworkAllowed(spec.network);
    const dir = join(this.root, spec.sandboxId);
    for (const sub of ['workspace', 'home', 'cocoon', 'tmp', 'etc']) mkdirSync(join(dir, sub), { recursive: true, mode: 0o755 });
    writeFileSync(join(dir, 'etc/passwd'), `root:x:0:0:root:/root:/bin/sh\nagent:x:${SANDBOX_UID}:${SANDBOX_UID}:agent:${HOME}:/bin/bash\n`);
    writeFileSync(join(dir, 'etc/group'), `root:x:0:\nagent:x:${SANDBOX_UID}:\n`);
    // The keeper's tmux server reads its config at start – before the sandbox bootstrap runs.
    writeFileSync(join(dir, 'cocoon', basename(TMUX_CONF_PATH)), TMUX_CONF);
    const meta: Meta = { name: spec.name, network: spec.network, workdir: spec.workdir, env: spec.env, toolbox: spec.toolbox };
    writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
    return { handle: spec.sandboxId };
  }

  async start(handle: string): Promise<void> {
    if ((await this.state(handle)) === 'running') return;
    const dir = this.dir(handle);
    const payload = argsPayload(this.args(handle, { keeper: true })); // before spawning: refuses sandboxes that may not run
    const keeper = spawn('bwrap', ['--args', '3', '--', 'tmux', '-L', 'cocoon', '-f', TMUX_CONF_PATH, '-D'], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
    });
    (keeper.stdio[3] as NodeJS.WritableStream).end(payload);
    keeper.unref();
    if (!keeper.pid) throw new Error('could not start sandbox keeper');
    writeFileSync(join(dir, 'keeper.pid'), String(keeper.pid));
    // Wait until the tmux server listens, so agents can be spawned right away.
    const socket = join(dir, 'tmp', `tmux-${SANDBOX_UID}`, 'cocoon');
    for (let i = 0; i < 50 && !existsSync(socket); i++) await new Promise((r) => setTimeout(r, 100));
  }

  async stop(handle: string): Promise<void> {
    const pid = this.keeperPid(handle);
    if (pid) {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        // already gone
      }
    }
  }

  async remove(handle: string): Promise<void> {
    await this.stop(handle);
    const dir = this.dir(handle, false);
    if (dir.startsWith(this.root + '/')) rmSync(dir, { recursive: true, force: true });
  }

  async state(handle: string): Promise<RuntimeState> {
    if (!existsSync(join(this.dir(handle, false), 'meta.json'))) return 'missing';
    return this.keeperPid(handle) ? 'running' : 'stopped';
  }

  async address(): Promise<string | undefined> {
    return undefined;
  }

  async exec(handle: string, command: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    const child = this.spawnIn(handle, command, opts);
    const stdout = collect(child.stdout!);
    const stderr = collect(child.stderr!);
    const exitCode = await new Promise<number>((resolvePromise, reject) => {
      const timer = opts.timeoutMs
        ? setTimeout(() => {
            child.kill('SIGKILL');
            reject(new CocoonError('timeout', t('error.timeout', { ms: opts.timeoutMs ?? 0 })));
          }, opts.timeoutMs)
        : undefined;
      child.on('error', (err) => (clearTimeout(timer), reject(err)));
      child.on('close', (code) => (clearTimeout(timer), resolvePromise(code ?? -1)));
    });
    return { exitCode, stdout: stdout(), stderr: stderr() };
  }

  async attachTty(handle: string, command: string[], size: { cols: number; rows: number }): Promise<TtySession> {
    const pty = await import('@lydell/node-pty');
    // node-pty cannot pass extra file descriptors: hand the arguments over in a private file that the shell
    // opens as fd 3 and deletes before bwrap starts.
    const argsFile = join(this.dir(handle), `.args-${randomBytes(6).toString('hex')}`);
    writeFileSync(argsFile, argsPayload(this.args(handle, { tty: true })), { mode: 0o600 });
    const term = pty.spawn('/bin/sh', ['-c', 'exec 3< "$1"; rm -f "$1"; shift; exec bwrap --args 3 -- "$@"', 'sh', argsFile, ...command], {
      name: 'xterm-256color',
      cols: size.cols,
      rows: size.rows,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    });
    const stream = new Duplex({
      read() {},
      write(chunk: Buffer, _encoding, callback) {
        term.write(chunk.toString('utf8'));
        callback();
      },
      destroy(err, callback) {
        term.kill();
        callback(err);
      },
    });
    term.onData((data) => stream.push(Buffer.from(data, 'utf8')));
    term.onExit(() => stream.push(null));
    return {
      stream,
      resize: async (cols, rows) => term.resize(cols, rows),
      close: () => term.kill(),
    };
  }

  /**
   * Both archive operations run `tar` inside the sandbox (same mounts, user and namespaces as the agent), never on the
   * host: the agent owns the writable mounts and can plant symlinks there, which a host-side tar would follow out of the
   * sandbox (to write or read arbitrary host files with cocoond's privileges). Inside, symlinks can only lead to the
   * sandbox's own files.
   */
  async putArchive(handle: string, dir: string, tar: Buffer): Promise<void> {
    const target = this.sandboxPath(handle, dir);
    const child = this.spawnIn(handle, ['sh', '-c', 'mkdir -p -- "$1" && exec tar -x -C "$1" --no-same-owner', 'sh', target], { stdin: true });
    const stderr = collect(child.stderr!);
    child.stdin!.on('error', () => undefined); // tar may exit before reading everything; the exit code reports it
    child.stdin!.end(tar);
    const code = await new Promise<number>((resolvePromise, reject) => {
      child.on('error', reject);
      child.on('close', (c) => resolvePromise(c ?? -1));
    });
    if (code !== 0) throw new Error(`tar: ${stderr().trim()}`);
  }

  async getArchive(handle: string, path: string): Promise<Readable> {
    const source = this.sandboxPath(handle, path);
    const probe = await this.exec(handle, ['test', '-e', source], { timeoutMs: 10_000 });
    if (probe.exitCode !== 0) throw new CocoonError('not_found', t('error.pathNotFound', { path }));
    return this.spawnIn(handle, ['tar', '-c', '-C', posix.dirname(source), posix.basename(source)]).stdout!;
  }

  /** Installs the host's Node.js and the agent CLIs into <dataDir>/agents (mounted read-only into sandboxes). */
  async installTools(packages: string[], _image: string, onOutput: (line: string) => void): Promise<void> {
    mkdirSync(this.toolboxDir, { recursive: true });
    // The Node.js running CoCoon (and the npm next to it) comes first, even if it is not on PATH.
    const path = [dirname(process.execPath), process.env.PATH ?? '/usr/bin:/bin'].join(':');
    const child = spawn('sh', ['-c', INSTALL_TOOLBOX_SCRIPT, 'sh', ...packages], {
      env: { ...process.env, PATH: path, TOOLBOX_DIR: this.toolboxDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const stream of [child.stdout, child.stderr]) {
      let buffer = '';
      stream.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) if (line.trim()) onOutput(line);
      });
    }
    const code = await new Promise<number>((r, reject) => {
      child.on('error', reject);
      child.on('close', (c) => r(c ?? -1));
    });
    if (code !== 0) throw new Error(`npm install exited with ${code}`);
  }

  async toolVersions(): Promise<Record<string, string>> {
    return readToolVersions(join(this.toolboxDir, 'lib', 'node_modules'));
  }

  async toolboxRuntime(): Promise<string | undefined> {
    const node = join(this.toolboxDir, 'bin', 'node');
    if (!existsSync(node)) return undefined;
    const { stdout } = await run(node, ['--version'], { timeout: 10_000 }).catch(() => ({ stdout: '' }));
    return parseNodeVersion(stdout);
  }

  async imageDetails(): Promise<ImageDetails | undefined> {
    return undefined;
  }

  async buildImage(): Promise<void> {
    throw new CocoonError('bad_request', 'bubblewrap sandboxes do not use images');
  }

  async pullImage(): Promise<void> {
    throw new CocoonError('bad_request', 'bubblewrap sandboxes do not use images');
  }

  async registryDigest(): Promise<string | undefined> {
    return undefined;
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private dir(handle: string, mustExist = true): string {
    if (!/^sb_[a-f0-9]+$/.test(handle)) throw new CocoonError('bad_request', `invalid sandbox handle ${handle}`);
    const dir = join(this.root, handle);
    if (mustExist && !existsSync(dir)) throw new CocoonError('not_found', t('error.notFound', { what: 'Sandbox', id: handle }));
    return dir;
  }

  /** Egress cannot be enforced without a network namespace of its own: refuse network modes that share the host's. */
  private requireNetworkAllowed(network: NetworkMode): void {
    if (network !== 'none' && !this.opts.allowHostNetwork) throw new CocoonError('bad_request', t('error.bwrapHostNetwork'));
  }

  private meta(handle: string): Meta {
    return JSON.parse(readFileSync(join(this.dir(handle), 'meta.json'), 'utf8')) as Meta;
  }

  /** Runs a command in a fresh bwrap of the sandbox; stderr is piped, stdin only if asked for. */
  private spawnIn(handle: string, command: string[], opts: ExecOptions & { stdin?: boolean } = {}) {
    const payload = argsPayload(this.args(handle, opts)); // before spawning: refuses sandboxes that may not run
    const child = spawn('bwrap', ['--args', '3', '--', ...command], { stdio: [opts.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe', 'pipe'] });
    (child.stdio[3] as NodeJS.WritableStream).end(payload);
    return child;
  }

  /** Normalised absolute sandbox path; only the writable sandbox mounts are reachable. */
  private sandboxPath(handle: string, insidePath: string): string {
    const { workdir } = this.meta(handle);
    const normalized = posix.normalize(insidePath.startsWith('/') ? insidePath : posix.join(workdir, insidePath));
    if ([workdir, HOME, COCOON_DIR, '/tmp'].some((mount) => normalized === mount || normalized.startsWith(`${mount}/`))) return normalized;
    throw new CocoonError('bad_request', t('error.pathNotFound', { path: insidePath }));
  }

  private keeperPid(handle: string): number | undefined {
    try {
      const pid = Number(readFileSync(join(this.dir(handle, false), 'keeper.pid'), 'utf8'));
      process.kill(pid, 0);
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      return cmdline.includes('bwrap') ? pid : undefined;
    } catch {
      return undefined;
    }
  }

  private args(handle: string, opts: ExecOptions & { tty?: boolean; keeper?: boolean } = {}): string[] {
    const dir = this.dir(handle);
    const meta = this.meta(handle);
    this.requireNetworkAllowed(meta.network);
    const root = opts.user === 'root' || opts.user === '0' || opts.user === '0:0';
    const args = [
      '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup-try',
      ...(meta.network === 'none' ? ['--unshare-net'] : []),
      '--uid', root ? '0' : SANDBOX_UID, '--gid', root ? '0' : SANDBOX_UID,
      '--hostname', meta.name.slice(0, 63),
      '--cap-drop', 'ALL',
      ...SYSTEM_PATHS.flatMap((p) => ['--ro-bind-try', p, p]),
      ...SYSTEM_ETC.flatMap((p) => ['--ro-bind-try', p, p]),
      '--ro-bind', join(dir, 'etc/passwd'), '/etc/passwd',
      '--ro-bind', join(dir, 'etc/group'), '/etc/group',
      '--proc', '/proc', '--dev', '/dev',
      '--bind', join(dir, 'workspace'), meta.workdir,
      '--bind', join(dir, 'home'), HOME,
      '--bind', join(dir, 'cocoon'), COCOON_DIR,
      '--bind', join(dir, 'tmp'), '/tmp',
      ...(meta.toolbox && existsSync(this.toolboxDir) ? ['--ro-bind', this.toolboxDir, TOOLBOX_PATH] : []),
      '--chdir', opts.workdir ?? meta.workdir,
      '--clearenv',
    ];
    const env = {
      HOME: root ? '/root' : HOME,
      USER: root ? 'root' : 'agent',
      LOGNAME: root ? 'root' : 'agent',
      PATH: SANDBOX_PATH,
      TERM: 'xterm-256color',
      LANG: 'C.UTF-8',
      ...meta.env,
      ...opts.env,
    };
    for (const [key, value] of Object.entries(env)) args.push('--setenv', key, value);
    // Non-interactive commands get their own session (no access to a controlling terminal) and die with cocoond.
    if (!opts.tty && !opts.keeper) args.push('--new-session', '--die-with-parent');
    return args;
  }
}

/**
 * bwrap options as a NUL-separated payload for `bwrap --args FD`, so the sandbox environment (e.g. the proxy token)
 * does not show up in the host's process list. The command itself stays on the command line (bwrap requires it there);
 * agent secrets are passed via a private env file instead (see agents/tmux.ts).
 */
function argsPayload(args: string[]): string {
  return args.map((arg) => `${arg}\0`).join('');
}

function collect(stream: Readable): () => string {
  const chunks: Buffer[] = [];
  let size = 0;
  stream.on('data', (chunk: Buffer) => {
    if (size >= MAX_OUTPUT_BYTES) return;
    chunks.push(chunk);
    size += chunk.length;
  });
  return () => Buffer.concat(chunks).toString('utf8');
}
