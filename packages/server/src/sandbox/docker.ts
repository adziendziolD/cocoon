import { readdirSync } from 'node:fs';
import { PassThrough, type Readable } from 'node:stream';
import Docker from 'dockerode';
import type { DriverCapabilities } from '@cocoon/protocol';
import { CocoonError } from '../errors.ts';
import { t } from '../i18n.ts';
import { scoped } from '../instance.ts';
import {
  INSTALL_TOOLBOX_SCRIPT,
  parseNodeVersion,
  READ_TOOL_VERSIONS_JS,
  SANDBOX_PATH,
  TOOLBOX_NODE,
  TOOLBOX_PATH,
  type ExecOptions,
  type ExecResult,
  type ImageDetails,
  type RuntimeState,
  type SandboxDriver,
  type SandboxSpec,
  type TtySession,
} from './driver.ts';

export const INTERNAL_NETWORK = scoped('cocoon-internal');
/**
 * Podman only: the egress proxy's way out. Podman's default network has no DNS, and the DNS server of the internal
 * network does not forward external names – the proxy needs a non-internal network with DNS to resolve upstream hosts.
 */
export const EGRESS_NETWORK = scoped('cocoon-egress');
export const TOOLBOX_VOLUME = scoped('cocoon-agents');
const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;

/**
 * Docker or Podman (via its Docker-compatible API). Podman runs without a daemon and rootless; differences are handled here:
 * the host is reachable as host.containers.internal (added automatically) and container root maps to the calling user.
 */
export class DockerDriver implements SandboxDriver {
  readonly name: string;
  readonly docker: Docker;
  readonly capabilities: DriverCapabilities = { images: true, resourceLimits: true, enforcedEgress: true, runtimes: true };

  constructor(
    readonly kind: 'docker' | 'podman',
    readonly socketPath?: string,
  ) {
    this.docker = new Docker(socketPath ? { socketPath } : undefined);
    this.name = kind;
  }

  /** Hostname under which containers reach the host. */
  get hostAlias(): string {
    return this.kind === 'podman' ? 'host.containers.internal' : 'host.docker.internal';
  }

  async check(): Promise<void> {
    await this.docker.ping();
  }

  async info(): Promise<{ version?: string; runtimes: string[] }> {
    const info = (await this.docker.info()) as { ServerVersion?: string; Runtimes?: Record<string, unknown> };
    const version = (await this.docker.version().catch(() => undefined)) as { Version?: string } | undefined;
    return { version: version?.Version ?? info.ServerVersion, runtimes: Object.keys(info.Runtimes ?? {}) };
  }

  async create(spec: SandboxSpec): Promise<{ handle: string }> {
    const { cpus, memoryMb, pids } = spec.resources;
    if (!(await this.imageDetails(spec.image))) throw new CocoonError('bad_request', t('error.imageMissing', { image: spec.image }));
    const network = spec.network === 'none' ? 'none' : spec.network === 'open' ? 'bridge' : INTERNAL_NETWORK;
    const container = await this.docker.createContainer({
      name: `cocoon-${spec.sandboxId}`,
      Image: spec.image,
      Cmd: ['sleep', 'infinity'],
      WorkingDir: spec.workdir,
      Env: Object.entries({ PATH: SANDBOX_PATH, ...spec.env }).map(([k, v]) => `${k}=${v}`),
      Labels: { 'cocoon.sandbox': spec.sandboxId, 'cocoon.name': spec.name },
      HostConfig: {
        Init: true,
        Runtime: spec.runtime ?? undefined,
        NetworkMode: network,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        PidsLimit: pids,
        Memory: memoryMb ? memoryMb * 1024 * 1024 : undefined,
        MemorySwap: memoryMb ? memoryMb * 1024 * 1024 : undefined,
        NanoCpus: cpus ? Math.round(cpus * 1e9) : undefined,
        // exec: some agent CLIs (e.g. OpenCode) unpack native libraries into /tmp.
        Tmpfs: { '/tmp': 'rw,exec,nosuid,nodev,size=512m' },
        RestartPolicy: { Name: 'unless-stopped' },
        // Podman adds host.containers.internal by itself.
        ExtraHosts: spec.network === 'open' && this.kind === 'docker' ? ['host.docker.internal:host-gateway'] : undefined,
        Mounts: spec.toolbox ? [{ Type: 'volume', Source: TOOLBOX_VOLUME, Target: TOOLBOX_PATH, ReadOnly: true }] : undefined,
      },
    });
    return { handle: container.id };
  }

  async start(handle: string): Promise<void> {
    await ignoreStatus(304, () => this.docker.getContainer(handle).start());
  }

  async stop(handle: string): Promise<void> {
    await ignoreStatus(304, () => this.docker.getContainer(handle).stop({ t: 5 }));
  }

  async remove(handle: string): Promise<void> {
    await ignoreStatus(404, () => this.docker.getContainer(handle).remove({ force: true, v: true }));
  }

  async state(handle: string): Promise<RuntimeState> {
    try {
      const info = await this.docker.getContainer(handle).inspect();
      return info.State.Running ? 'running' : 'stopped';
    } catch (err) {
      if (statusOf(err) === 404) return 'missing';
      throw err;
    }
  }

  async address(handle: string): Promise<string | undefined> {
    const info = await this.docker.getContainer(handle).inspect();
    return info.NetworkSettings.Networks[INTERNAL_NETWORK]?.IPAddress || undefined;
  }

  async exec(handle: string, command: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    const exec = await this.docker.getContainer(handle).exec({
      Cmd: command,
      AttachStdout: true,
      AttachStderr: true,
      Env: opts.env ? Object.entries(opts.env).map(([k, v]) => `${k}=${v}`) : undefined,
      WorkingDir: opts.workdir,
      User: opts.user,
    });
    const stream = await exec.start({ hijack: true, stdin: false });
    const stdout = collect();
    const stderr = collect();
    this.docker.modem.demuxStream(stream, stdout.sink, stderr.sink);

    await new Promise<void>((resolve, reject) => {
      const timer = opts.timeoutMs
        ? setTimeout(() => {
            stream.destroy();
            reject(new CocoonError('timeout', t('error.timeout', { ms: opts.timeoutMs ?? 0 })));
          }, opts.timeoutMs)
        : undefined;
      stream.on('end', () => (clearTimeout(timer), resolve()));
      stream.on('close', () => (clearTimeout(timer), resolve()));
      stream.on('error', (err) => (clearTimeout(timer), reject(err)));
    });

    const info = await exec.inspect();
    return { exitCode: info.ExitCode ?? -1, stdout: stdout.text(), stderr: stderr.text() };
  }

  async attachTty(handle: string, command: string[], size: { cols: number; rows: number }): Promise<TtySession> {
    const exec = await this.docker.getContainer(handle).exec({
      Cmd: command,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      Env: ['TERM=xterm-256color'],
    });
    const stream = await exec.start({ hijack: true, stdin: true, Tty: true });
    const resize = async (cols: number, rows: number) => {
      await exec.resize({ w: cols, h: rows }).catch(() => undefined);
    };
    await resize(size.cols, size.rows);
    return { stream, resize, close: () => stream.destroy() };
  }

  async putArchive(handle: string, dir: string, tar: Buffer): Promise<void> {
    await this.docker.getContainer(handle).putArchive(tar, { path: dir });
  }

  async getArchive(handle: string, path: string): Promise<Readable> {
    try {
      return (await this.docker.getContainer(handle).getArchive({ path })) as Readable;
    } catch (err) {
      if (statusOf(err) === 404) throw new CocoonError('not_found', t('error.pathNotFound', { path }));
      throw err;
    }
  }

  /** Installs Node.js and the agent CLIs into the toolbox volume, in a throwaway container of the installer image. */
  async installTools(packages: string[], image: string, onOutput: (line: string) => void): Promise<void> {
    if (!(await this.imageDetails(image))) throw new CocoonError('bad_request', t('error.imageMissing', { image }));
    const code = await this.runWithToolbox(image, ['sh', '-c', INSTALL_TOOLBOX_SCRIPT, 'sh', ...packages], { writable: true, network: true }, onOutput);
    if (code !== 0) throw new Error(`npm install exited with ${code}`);
  }

  async toolVersions(image: string): Promise<Record<string, string>> {
    if (!(await this.imageDetails(image))) return {};
    let output = '';
    const script = `${TOOLBOX_NODE}; exec "$N" -e "$1" "$2"`;
    const code = await this.runWithToolbox(image, ['sh', '-c', script, 'sh', READ_TOOL_VERSIONS_JS, `${TOOLBOX_PATH}/lib/node_modules`], {}, (line) => (output += line));
    if (code !== 0) throw new Error(`reading the toolbox versions exited with ${code}`);
    return JSON.parse(output) as Record<string, string>;
  }

  async toolboxRuntime(image: string): Promise<string | undefined> {
    if (!(await this.imageDetails(image))) return undefined;
    let output = '';
    const code = await this.runWithToolbox(image, ['sh', '-c', `[ -x ${TOOLBOX_PATH}/bin/node ] && exec ${TOOLBOX_PATH}/bin/node --version`], {}, (line) => (output += line));
    return code === 0 ? parseNodeVersion(output) : undefined;
  }

  /** Runs a command in a throwaway container with the toolbox volume mounted; streams its output line by line. */
  private async runWithToolbox(
    image: string,
    cmd: string[],
    opts: { writable?: boolean; network?: boolean },
    onOutput: (line: string) => void,
  ): Promise<number> {
    const container = await this.docker.createContainer({
      Image: image,
      User: opts.writable ? '0:0' : undefined,
      Cmd: cmd,
      Labels: { 'cocoon.managed': 'true' },
      HostConfig: {
        NetworkMode: opts.network ? 'bridge' : 'none',
        Mounts: [{ Type: 'volume', Source: TOOLBOX_VOLUME, Target: TOOLBOX_PATH, ReadOnly: !opts.writable }],
      },
    });
    try {
      const stream = await container.attach({ stream: true, stdout: true, stderr: true });
      const out = new PassThrough();
      this.docker.modem.demuxStream(stream, out, out);
      let buffer = '';
      out.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) if (line.trim()) onOutput(line);
      });
      await container.start();
      const { StatusCode } = (await container.wait()) as { StatusCode: number };
      if (buffer.trim()) onOutput(buffer);
      return StatusCode;
    } finally {
      await container.remove({ force: true }).catch(() => undefined);
    }
  }

  /** Pulls an image from its registry. */
  async pullImage(ref: string, onOutput: (line: string) => void = () => undefined): Promise<void> {
    const stream = await this.docker.pull(ref);
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(
        stream,
        (err: Error | null) => (err ? reject(err) : resolve()),
        (event: { status?: string; progress?: string; error?: string }) => {
          const line = [event.status, event.progress, event.error].filter(Boolean).join(' ');
          if (line) onOutput(line);
        },
      );
    });
  }

  /** Connects a container to the internal network (where shared services live), if not already connected. */
  async connectInternal(handle: string): Promise<void> {
    const info = await this.docker.getContainer(handle).inspect();
    if (info.NetworkSettings.Networks[INTERNAL_NETWORK]) return;
    await this.docker.getNetwork(INTERNAL_NETWORK).connect({ Container: handle });
  }

  async imageDetails(ref: string): Promise<ImageDetails | undefined> {
    try {
      const info = await this.docker.getImage(ref).inspect();
      // With the containerd image store, inspect reports the compressed size; the image list has the unpacked size.
      const [listed] = await this.docker.listImages({ filters: { reference: [ref] } }).catch(() => []);
      const bytes = Math.max(listed?.Size ?? 0, info.Size);
      return {
        createdAt: info.Created,
        sizeMb: Math.round(bytes / 1024 / 1024),
        labels: info.Config?.Labels ?? undefined,
        digests: (info.RepoDigests ?? []).map((d) => d.slice(d.indexOf('@') + 1)),
      };
    } catch {
      return undefined;
    }
  }

  async registryDigest(ref: string): Promise<string | undefined> {
    try {
      const info = (await this.docker.getImage(ref).distribution()) as { Descriptor?: { digest?: string } };
      return info.Descriptor?.digest;
    } catch {
      return undefined;
    }
  }

  async buildImage(
    contextDir: string,
    tag: string,
    buildArgs: Record<string, string>,
    onOutput: (line: string) => void,
    labels?: Record<string, string>,
  ): Promise<void> {
    const stream = await this.docker.buildImage(
      { context: contextDir, src: readdirSync(contextDir) },
      { t: tag, buildargs: buildArgs, rm: true, ...(labels ? { labels } : {}) },
    );
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(
        stream,
        (err: Error | null, output: { error?: string }[]) => {
          const failure = err?.message ?? output?.find((o) => o.error)?.error;
          if (failure) reject(new Error(failure));
          else resolve();
        },
        (event: { stream?: string; status?: string; error?: string }) => {
          const line = (event.stream ?? event.status ?? event.error ?? '').trimEnd();
          if (line) onOutput(line);
        },
      );
    });
  }
}

function collect() {
  const chunks: Buffer[] = [];
  let size = 0;
  const sink = new PassThrough();
  sink.on('data', (chunk: Buffer) => {
    if (size >= MAX_OUTPUT_BYTES) return;
    chunks.push(chunk);
    size += chunk.length;
  });
  return { sink, text: () => Buffer.concat(chunks).toString('utf8') };
}

export function statusOf(err: unknown): number | undefined {
  return (err as { statusCode?: number })?.statusCode;
}

export async function ignoreStatus(status: number, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (statusOf(err) !== status) throw err;
  }
}
