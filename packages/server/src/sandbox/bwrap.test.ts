import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SandboxSpec } from './driver.ts';

interface Spawned {
  cmd: string;
  argv: string[];
  /** bwrap options handed over on fd 3. */
  options: string[];
  stdin: Buffer[];
}
const spawned: Spawned[] = [];

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (cmd: string, argv: string[]) => {
      const entry: Spawned = { cmd, argv, options: [], stdin: [] };
      spawned.push(entry);
      const fd3 = new PassThrough();
      const chunks: Buffer[] = [];
      fd3.on('data', (c: Buffer) => chunks.push(c));
      fd3.on('end', () => (entry.options = Buffer.concat(chunks).toString().split('\0').slice(0, -1)));
      const stdin = new PassThrough();
      stdin.on('data', (c: Buffer) => entry.stdin.push(c));
      const child = Object.assign(new EventEmitter(), {
        stdin,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdio: [stdin, null, null, fd3],
      });
      // Finish like a successful command once the options and the input have been handed over.
      setImmediate(() => child.emit('close', 0));
      return child;
    },
  };
});

const { BwrapDriver } = await import('./bwrap.ts');

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cocoon-bwrap-'));
  spawned.length = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const spec = (network: SandboxSpec['network'] = 'none'): SandboxSpec => ({
  sandboxId: 'sb_abc123',
  name: 'test',
  image: '',
  network,
  runtime: null,
  resources: {},
  workdir: '/workspace',
  env: {},
  toolbox: false,
});

async function driver(network: SandboxSpec['network'] = 'none') {
  const d = new BwrapDriver(dir);
  await d.create(spec(network));
  return d;
}

describe('bwrap network modes (egress is not enforced, the sandbox would share the host network)', () => {
  it.each(['egress', 'open'] as const)('refuses "%s" sandboxes without the host-network opt-in', async (network) => {
    const d = new BwrapDriver(dir);
    await expect(d.create(spec(network))).rejects.toThrow(/COCOON_BWRAP_HOST_NETWORK/);
  });

  it('allows "none" and isolates it in its own network namespace', async () => {
    const d = await driver('none');
    await d.exec('sb_abc123', ['true']);
    expect(spawned[0]!.options).toContain('--unshare-net');
  });

  it.each(['egress', 'open'] as const)('creates "%s" sandboxes with the opt-in, sharing the host network', async (network) => {
    const d = new BwrapDriver(dir, { allowHostNetwork: true });
    await d.create(spec(network));
    await d.exec('sb_abc123', ['true']);
    expect(spawned[0]!.options).not.toContain('--unshare-net');
  });

  it('does not start or run commands in sandboxes with network that were created before the opt-in was required', async () => {
    await new BwrapDriver(dir, { allowHostNetwork: true }).create(spec('egress'));
    const d = new BwrapDriver(dir);
    await expect(d.start('sb_abc123')).rejects.toThrow(/COCOON_BWRAP_HOST_NETWORK/);
    await expect(d.exec('sb_abc123', ['true'])).rejects.toThrow(/COCOON_BWRAP_HOST_NETWORK/);
    expect(spawned).toEqual([]);
  });
});

describe('bwrap archives (a host tar would follow symlinks planted by the agent)', () => {
  it('extracts with tar inside the sandbox, never with a host tar', async () => {
    const d = await driver();
    await d.putArchive('sb_abc123', '/opt/cocoon/staging', Buffer.from('tar-bytes'));
    expect(spawned.map((s) => s.cmd)).toEqual(['bwrap']);
    const [call] = spawned;
    // The command after "--" runs inside bwrap: sh → mkdir + tar into the sandbox path.
    expect(call!.argv.slice(0, 3)).toEqual(['--args', '3', '--']);
    expect(call!.argv).toContain('/opt/cocoon/staging');
    expect(call!.argv.join(' ')).toContain('tar -x -C');
    expect(Buffer.concat(call!.stdin).toString()).toBe('tar-bytes');
    // Writes go through the sandbox mount, not through a host path.
    expect(call!.options.join(' ')).toContain(`${dir}/sandboxes/sb_abc123/cocoon /opt/cocoon`);
    expect(call!.options).toContain('--cap-drop');
  });

  it('reads with tar inside the sandbox', async () => {
    const d = await driver();
    await d.getArchive('sb_abc123', 'src');
    const cmds = spawned.map((s) => s.argv.slice(s.argv.indexOf('--') + 1));
    expect(spawned.every((s) => s.cmd === 'bwrap')).toBe(true);
    expect(cmds).toEqual([
      ['test', '-e', '/workspace/src'],
      ['tar', '-c', '-C', '/workspace', 'src'],
    ]);
  });

  it('only reaches the writable sandbox mounts', async () => {
    const d = await driver();
    await expect(d.getArchive('sb_abc123', '/etc/passwd')).rejects.toThrow();
    await expect(d.getArchive('sb_abc123', '/workspace/../etc/passwd')).rejects.toThrow();
    await expect(d.putArchive('sb_abc123', '/usr/local', Buffer.alloc(0))).rejects.toThrow();
    expect(spawned).toEqual([]);
  });
});
