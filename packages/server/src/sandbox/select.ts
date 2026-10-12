import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { BwrapDriver } from './bwrap.ts';
import { DockerDriver } from './docker.ts';
import type { SandboxDriver } from './driver.ts';

export type DriverChoice = 'auto' | 'docker' | 'podman' | 'bwrap';

/** Candidate Podman API sockets: rootless, rootful, and Podman machine on macOS/Windows. */
function podmanSockets(): string[] {
  const uid = process.getuid?.();
  const sockets = [
    process.env.XDG_RUNTIME_DIR && `${process.env.XDG_RUNTIME_DIR}/podman/podman.sock`,
    uid !== undefined && `/run/user/${uid}/podman/podman.sock`,
    '/run/podman/podman.sock',
  ].filter((s): s is string => Boolean(s));
  try {
    const machine = execFileSync('podman', ['machine', 'inspect', '--format', '{{.ConnectionInfo.PodmanSocket.Path}}'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    }).trim();
    if (machine) sockets.push(...machine.split('\n'));
  } catch {
    // no podman CLI / machine
  }
  return sockets;
}

const dockerSocket = () => ['/var/run/docker.sock', `${process.env.HOME}/.docker/run/docker.sock`].find((s) => existsSync(s));

/**
 * Picks the isolation backend. "auto": explicit DOCKER_SOCKET → Podman socket → Docker socket → bubblewrap (Linux).
 */
export async function selectDriver(choice: DriverChoice, opts: { socket?: string; dataDir: string }): Promise<SandboxDriver> {
  const candidates: SandboxDriver[] = [];
  if (choice === 'docker') candidates.push(new DockerDriver('docker', opts.socket ?? dockerSocket()));
  else if (choice === 'podman') candidates.push(...(opts.socket ? [opts.socket] : podmanSockets()).map((s) => new DockerDriver('podman', s)));
  else if (choice === 'bwrap') candidates.push(new BwrapDriver(opts.dataDir));
  else {
    if (opts.socket) candidates.push(new DockerDriver(opts.socket.includes('podman') ? 'podman' : 'docker', opts.socket));
    candidates.push(...podmanSockets().filter((s) => existsSync(s)).map((s) => new DockerDriver('podman', s)));
    const docker = dockerSocket();
    if (docker) candidates.push(new DockerDriver('docker', docker));
    if (process.platform === 'linux') candidates.push(new BwrapDriver(opts.dataDir));
  }

  const errors: string[] = [];
  for (const driver of candidates) {
    try {
      await driver.check();
      return driver;
    } catch (err) {
      errors.push(`${driver.name}: ${(err as Error).message}`);
    }
  }
  throw new Error(errors.length ? errors.join('\n') : `no usable sandbox backend for COCOON_DRIVER=${choice}`);
}
