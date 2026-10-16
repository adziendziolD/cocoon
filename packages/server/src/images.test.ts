import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { baseImage, buildArgsFor, LABEL_CONTEXT, LABEL_VARIANT, variantOf } from './images.ts';
import { INSTALL_TOOLBOX_SCRIPT, parseNodeVersion, readToolVersions } from './sandbox/driver.ts';

const dockerfile = readFileSync(resolve(import.meta.dirname, '../../../images/sandbox/Dockerfile'), 'utf8');

describe('sandbox image', () => {
  it('starts from plain Debian, without Node.js', () => {
    expect(baseImage(dockerfile)).toBe('docker.io/library/debian:bookworm-slim');
    expect(dockerfile).not.toMatch(/^\s*FROM\s+\S*node/im);
  });

  it('installs database clients, compilers and Python only in their variants', () => {
    const variants = Object.fromEntries([...dockerfile.matchAll(/^\s*(\w+)\) extra="([^"]*)"/gm)].map((m) => [m[1], m[2]!.split(/\s+/).filter(Boolean)]));
    expect(variants.slim).toEqual([]);
    expect(variants.db).toEqual(['postgresql-client', 'mariadb-client', 'redis-tools']);
    expect(variants.full).toEqual(expect.arrayContaining([...variants.db!, 'build-essential', 'python3']));
    const always = /apt-get install -y --no-install-recommends ([^;]*)\$extra/.exec(dockerfile)?.[1] ?? '';
    expect(always.split(/\s+/)).toEqual(expect.arrayContaining(['git', 'tmux', 'ripgrep', 'ca-certificates']));
    expect(always).not.toMatch(/postgresql|mariadb|redis|python|build-essential/);
  });

  it('keeps the toolbox on PATH, also for login shells', () => {
    expect(dockerfile).toMatch(/ENV PATH=\/opt\/agents\/bin:/);
    expect(dockerfile).toContain('/etc/profile.d/');
  });

  it('passes the variant as build argument', () => {
    expect(buildArgsFor('sandbox')).toEqual({ TOOLCHAIN: 'slim', AGENTS: '' });
    expect(buildArgsFor('sandbox', 'db')).toEqual({ TOOLCHAIN: 'db', AGENTS: '' });
    expect(buildArgsFor('proxy')).toEqual({});
  });
});

describe('variantOf', () => {
  it('reads the variant of CoCoon builds only', () => {
    expect(variantOf(undefined)).toBeUndefined();
    expect(variantOf({ [LABEL_VARIANT]: 'full' })).toBeUndefined();
    expect(variantOf({ [LABEL_CONTEXT]: 'abc', [LABEL_VARIANT]: 'db' })).toBe('db');
    expect(variantOf({ [LABEL_CONTEXT]: 'abc', [LABEL_VARIANT]: 'full' })).toBe('full');
    expect(variantOf({ [LABEL_CONTEXT]: 'abc' })).toBe('slim');
    expect(variantOf({ [LABEL_CONTEXT]: 'abc', [LABEL_VARIANT]: 'huge' })).toBe('slim');
  });
});

describe('parseNodeVersion', () => {
  it('accepts node --version output only', () => {
    expect(parseNodeVersion('v24.21.0\n')).toBe('24.21.0');
    expect(parseNodeVersion('25.0.0-rc.1')).toBe('25.0.0-rc.1');
    expect(parseNodeVersion('')).toBeUndefined();
    expect(parseNodeVersion('sh: node: not found')).toBeUndefined();
  });
});

describe('INSTALL_TOOLBOX_SCRIPT', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cocoon-toolbox-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('puts Node.js, npm and the agent CLIs into the toolbox, replacing what was there', () => {
    const toolbox = join(dir, 'agents');
    mkdirSync(toolbox);
    writeFileSync(join(toolbox, 'stale'), '');
    // A local package stands in for an agent CLI, so the test needs no network.
    const pkg = join(dir, 'fake-agent');
    mkdirSync(pkg);
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'fake-agent', version: '1.2.3', bin: { 'fake-agent': 'cli.js' } }));
    writeFileSync(join(pkg, 'cli.js'), '#!/usr/bin/env node\nconsole.log(`fake ${process.version}`);\n');
    chmodSync(join(pkg, 'cli.js'), 0o755);

    const env = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}`, TOOLBOX_DIR: toolbox, npm_config_update_notifier: 'false' };
    execFileSync('sh', ['-c', INSTALL_TOOLBOX_SCRIPT, 'sh', '--offline', '--install-links', pkg], { env, stdio: 'pipe', timeout: 120_000 });

    expect(existsSync(join(toolbox, 'stale'))).toBe(false);
    expect(existsSync(join(toolbox, '.npm-cache'))).toBe(false);
    const node = join(toolbox, 'bin', 'node');
    expect(parseNodeVersion(execFileSync(node, ['--version'], { encoding: 'utf8' }))).toBe(process.versions.node);
    // Only the toolbox on PATH: the CLI's "#!/usr/bin/env node" finds the toolbox's Node.js.
    const sandboxEnv = { PATH: `${join(toolbox, 'bin')}:/usr/bin:/bin`, HOME: dir };
    expect(execFileSync('fake-agent', [], { env: sandboxEnv, encoding: 'utf8' }).trim()).toBe(`fake ${process.version}`);
    expect(execFileSync('npm', ['--version'], { env: sandboxEnv, encoding: 'utf8' }).trim()).toMatch(/^\d+\.\d+\.\d+/);
    const versions = readToolVersions(join(toolbox, 'lib', 'node_modules'));
    expect(versions['fake-agent']).toBe('1.2.3');
    expect(versions.npm).toMatch(/^\d+\./);
  }, 120_000);
});
