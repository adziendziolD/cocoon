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
 * Picks the isolation backend. "auto": explicit DOCKER_SOCKET → Podman socket → Docker socket. bubblewrap (Linux) is
 * not picked silently: it cannot enforce egress (sandboxes with network share the host's network), so "auto" only
 * falls back to it when the operator opted in with `bwrapHostNetwork`; COCOON_DRIVER=bwrap chooses it explicitly.
 */
export async function selectDriver(
  choice: DriverChoice,
  opts: { socket?: string; dataDir: string; bwrapHostNetwork?: boolean },
): Promise<SandboxDriver> {
  const bwrap = () => new BwrapDriver(opts.dataDir, { allowHostNetwork: opts.bwrapHostNetwork });
  const candidates: SandboxDriver[] = [];
  if (choice === 'docker') candidates.push(new DockerDriver('docker', opts.socket ?? dockerSocket()));
  else if (choice === 'podman') candidates.push(...(opts.socket ? [opts.socket] : podmanSockets()).map((s) => new DockerDriver('podman', s)));
  else if (choice === 'bwrap') candidates.push(bwrap());
  else {
    if (opts.socket) candidates.push(new DockerDriver(opts.socket.includes('podman') ? 'podman' : 'docker', opts.socket));
    candidates.push(...podmanSockets().filter((s) => existsSync(s)).map((s) => new DockerDriver('podman', s)));
    const docker = dockerSocket();
    if (docker) candidates.push(new DockerDriver('docker', docker));
    if (process.platform === 'linux' && opts.bwrapHostNetwork) candidates.push(bwrap());
  }

  const errors: string[] = [];
  if (choice === 'auto' && process.platform === 'linux' && !opts.bwrapHostNetwork) {
    errors.push(
      'bubblewrap: not used automatically because it cannot enforce egress (sandboxes with network share the host network). ' +
        'Set COCOON_DRIVER=bwrap to use it (network mode "none" only), or additionally COCOON_BWRAP_HOST_NETWORK=1 to accept the shared host network.',
    );
  }
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
