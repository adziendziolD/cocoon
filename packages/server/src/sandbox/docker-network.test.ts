import { describe, expect, it } from 'vitest';
import { DockerDriver } from './docker.ts';

// Parallel callers (attach to several sandboxes, service start) race between "does it exist?" and "create/connect".
// The Docker client is faked; no networks or containers are touched.

const failure = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

function driverWith(docker: unknown) {
  const driver = new DockerDriver('docker');
  Object.defineProperty(driver, 'docker', { value: docker });
  return driver;
}

/** A client whose inspect results are stale: by the time create/connect run, someone else was faster. */
function racingDocker(opts: { createError?: Error; connectError?: Error }) {
  const calls: string[] = [];
  const docker = {
    getNetwork: (name: string) => ({
      inspect: async () => {
        calls.push(`inspect ${name}`);
        throw failure(404, 'no such network');
      },
      connect: async () => {
        calls.push(`connect ${name}`);
        if (opts.connectError) throw opts.connectError;
      },
    }),
    createNetwork: async () => {
      calls.push('create');
      if (opts.createError) throw opts.createError;
    },
    getContainer: () => ({ inspect: async () => ({ NetworkSettings: { Networks: {} } }) }),
  };
  return { driver: driverWith(docker), calls };
}

describe('ensureInternalNetwork', () => {
  it.each([
    ['Docker: 409 conflict', failure(409, 'network with name cocoon-svc-x-net already exists')],
    ['409 with another text', failure(409, 'conflict')],
    ['Podman: network name already used', failure(500, 'network name cocoon-svc-x-net already used: network already exists')],
  ])('treats a network that a parallel call created first as success (%s)', async (_name, createError) => {
    const { driver, calls } = racingDocker({ createError });
    await expect(driver.ensureInternalNetwork('cocoon-svc-x-net')).resolves.toBeUndefined();
    expect(calls).toContain('create');
  });

  it('still fails on other errors', async () => {
    const { driver } = racingDocker({ createError: failure(500, 'cannot connect to the daemon') });
    await expect(driver.ensureInternalNetwork('cocoon-svc-x-net')).rejects.toThrow(/daemon/);
  });

  it('survives two parallel calls', async () => {
    let created = false;
    const driver = driverWith({
      getNetwork: () => ({
        inspect: async () => {
          if (!created) throw failure(404, 'no such network');
        },
      }),
      createNetwork: async () => {
        await new Promise((r) => setTimeout(r, 1));
        if (created) throw failure(409, 'network with name x already exists');
        created = true;
      },
    });
    await expect(Promise.all([driver.ensureInternalNetwork('x'), driver.ensureInternalNetwork('x')])).resolves.toBeDefined();
  });
});

describe('connectNetwork', () => {
  it.each([
    ['Docker', failure(403, 'endpoint with name cocoon-sb-1 already exists in network cocoon-svc-x-net')],
    ['Docker, 409', failure(409, 'container is already connected to network cocoon-svc-x-net')],
    ['Podman', failure(500, 'container abc is already connected to network cocoon-svc-x-net')],
  ])('treats a connection that a parallel call made first as success (%s)', async (_name, connectError) => {
    const { driver, calls } = racingDocker({ connectError });
    await expect(driver.connectNetwork('cocoon-sb-1', 'cocoon-svc-x-net', 'x')).resolves.toBeUndefined();
    expect(calls).toContain('connect cocoon-svc-x-net');
  });

  it('still fails on other errors', async () => {
    const { driver } = racingDocker({ connectError: failure(404, 'no such container') });
    await expect(driver.connectNetwork('cocoon-sb-1', 'cocoon-svc-x-net')).rejects.toThrow(/no such container/);
  });
});
