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
  child: any;
}
const spawned: Spawned[] = [];
/** How the next spawned commands end: exit code and what they print on stderr/stdout. */
let outcome: (entry: Spawned) => { code?: number; stderr?: string; stdout?: string } = () => ({});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (cmd: string, argv: string[]) => {
      const entry: Spawned = { cmd, argv, options: [], stdin: [], child: undefined };
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
        kill: vi.fn(),
      });
      entry.child = child;
      // Finish like a successful command once the options and the input have been handed over.
      setImmediate(() => {
        const { code = 0, stderr, stdout } = outcome(entry);
        if (stdout) child.stdout.write(stdout);
        if (stderr) child.stderr.write(stderr);
        child.emit('close', code);
      });
      return child;
    },
  };
});

const { BwrapDriver } = await import('./bwrap.ts');

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cocoon-bwrap-'));
  spawned.length = 0;
  outcome = () => ({});
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

describe('bwrap file transfers need no host network', () => {
  it('upload and download work for sandboxes with network without the opt-in, and run without a network', async () => {
    await new BwrapDriver(dir, { allowHostNetwork: true }).create(spec('egress'));
    const d = new BwrapDriver(dir); // the opt-in is gone (or was never set on this server)
    await d.putArchive('sb_abc123', '/workspace', Buffer.from('tar-bytes'));
    const download = await d.getArchive('sb_abc123', 'src');
    await new Promise((r) => download.on('end', r).resume());
    expect(spawned).toHaveLength(3); // tar -x, test -e, tar -c
    for (const call of spawned) expect(call.options).toContain('--unshare-net');
    // Running commands still needs the opt-in.
    await expect(d.exec('sb_abc123', ['true'])).rejects.toThrow(/COCOON_BWRAP_HOST_NETWORK/);
  });
});

describe('bwrap download stream', () => {
  it('reads stderr so that a chatty tar cannot block on a full pipe', async () => {
    const d = await driver();
    await d.getArchive('sb_abc123', 'src');
    const tar = spawned.find((s) => s.argv.includes('tar'))!;
    expect(tar.child.stderr.readableFlowing).toBe(true);
  });

  it('delivers the archive and ends normally when tar succeeds', async () => {
    outcome = (e) => (e.argv.includes('tar') ? { stdout: 'archive-bytes' } : {});
    const d = await driver();
    const stream = await d.getArchive('sb_abc123', 'src');
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('archive-bytes');
  });

  it('ends with an error instead of a silently truncated archive when tar fails', async () => {
    outcome = (e) => (e.argv.includes('tar') ? { code: 2, stdout: 'partial', stderr: 'tar: src/x: Cannot open: Permission denied' } : {});
    const d = await driver();
    const stream = await d.getArchive('sb_abc123', 'src');
    const read = async () => {
      for await (const _ of stream);
    };
    await expect(read()).rejects.toThrow(/tar: .*Permission denied/);
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
