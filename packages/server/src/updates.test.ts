import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { baseImage, contextHash, LABEL_BASE, LABEL_CONTEXT } from './images.ts';
import { assessImage, availableTargets, checkCocoon, compareVersions } from './updates.ts';

describe('compareVersions', () => {
  it('compares numerically, not as text', () => {
    expect(compareVersions('2.1.296', '2.1.287')).toBe(1);
    expect(compareVersions('0.162.1', '0.99.0')).toBe(1);
    expect(compareVersions('1.2.10', '1.2.9')).toBe(1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('v1.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.0', '1.0.1')).toBe(-1);
  });

  it('sorts a prerelease before its release', () => {
    expect(compareVersions('1.0.0-beta.2', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBe(1);
    expect(compareVersions('1.0.0-beta.10', '1.0.0-beta.9')).toBe(1);
  });
});

describe('assessImage', () => {
  const labels = { [LABEL_CONTEXT]: 'abc', [LABEL_BASE]: 'sha256:1' };

  it('reports missing and untracked images', () => {
    expect(assessImage({ exists: false, expectedContext: 'abc' })).toEqual({ state: 'missing' });
    expect(assessImage({ exists: true, labels: {}, expectedContext: 'abc' })).toEqual({ state: 'unknown', reason: 'untracked' });
  });

  it('detects a changed Dockerfile', () => {
    expect(assessImage({ exists: true, labels, expectedContext: 'def' })).toEqual({ state: 'outdated', reason: 'definition' });
  });

  it('detects a newer base image only when the registry digest is known', () => {
    expect(assessImage({ exists: true, labels, expectedContext: 'abc', remoteBaseDigest: 'sha256:2' })).toEqual({ state: 'outdated', reason: 'base' });
    expect(assessImage({ exists: true, labels, expectedContext: 'abc', remoteBaseDigest: 'sha256:1' })).toEqual({ state: 'current' });
    expect(assessImage({ exists: true, labels, expectedContext: 'abc' })).toEqual({ state: 'current' });
  });
});

describe('availableTargets', () => {
  const cocoon = { state: 'current' as const, version: '1.0.0', behind: 0, ahead: 0, changes: [] };

  it('offers only what can be updated', () => {
    expect(availableTargets({ cocoon, tools: [], images: [] })).toEqual([]);
    expect(
      availableTargets({
        cocoon: { ...cocoon, state: 'outdated', behind: 2 },
        tools: [{ tool: 'codex', label: 'Codex', npm: '@openai/codex', installed: '1.0.0', latest: '1.1.0', state: 'outdated' }],
        images: [{ kind: 'proxy', ref: 'cocoon/egress-proxy:latest', state: 'unknown', reason: 'untracked' }],
      }),
    ).toEqual(['cocoon', 'tools', 'images']);
  });

  it('skips a blocked CoCoon update and custom images', () => {
    expect(
      availableTargets({
        cocoon: { ...cocoon, state: 'outdated', behind: 1, blocked: 'dirty' },
        tools: [],
        images: [{ kind: 'sandbox', ref: 'me/custom', state: 'unknown', reason: 'custom' }],
      }),
    ).toEqual([]);
  });
});

describe('baseImage', () => {
  it('spells out Docker Hub references', () => {
    expect(baseImage('FROM docker.io/library/node:24-alpine\nRUN x')).toBe('docker.io/library/node:24-alpine');
    expect(baseImage('FROM node:24-bookworm-slim')).toBe('docker.io/library/node:24-bookworm-slim');
    expect(baseImage('FROM bitnami/redis:7')).toBe('docker.io/bitnami/redis:7');
    expect(baseImage('FROM ghcr.io/acme/base:1')).toBe('ghcr.io/acme/base:1');
  });

  it('uses the final stage and ignores flags', () => {
    expect(baseImage('FROM node:24 AS build\nRUN x\nFROM --platform=linux/amd64 node:24-slim\n')).toBe('docker.io/library/node:24-slim');
    expect(baseImage('ARG V\nFROM node:${V}')).toBeUndefined();
  });
});

describe('contextHash', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
  const dir = () => {
    const d = mkdtempSync(join(tmpdir(), 'cocoon-ctx-'));
    dirs.push(d);
    return d;
  };

  it('changes with the files and build arguments, but not with tests', () => {
    const d = dir();
    writeFileSync(join(d, 'Dockerfile'), 'FROM node:24');
    const first = contextHash(d, { TOOLCHAIN: 'slim' });
    expect(contextHash(d, { TOOLCHAIN: 'slim' })).toBe(first);
    expect(contextHash(d, { TOOLCHAIN: 'full' })).not.toBe(first);
    writeFileSync(join(d, 'proxy.test.mjs'), 'test');
    expect(contextHash(d, { TOOLCHAIN: 'slim' })).toBe(first);
    writeFileSync(join(d, 'Dockerfile'), 'FROM node:26');
    expect(contextHash(d, { TOOLCHAIN: 'slim' })).not.toBe(first);
  });
});

describe('checkCocoon', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', ...args], { cwd, stdio: 'pipe' })
      .toString()
      .trim();
  const commit = (cwd: string, file: string, content: string, msg: string) => {
    writeFileSync(join(cwd, file), content);
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-q', '-m', msg);
  };

  /** An "upstream" repository and a clone of it (the CoCoon installation). */
  function setup() {
    const root = mkdtempSync(join(tmpdir(), 'cocoon-git-'));
    dirs.push(root);
    const upstream = join(root, 'upstream');
    const clone = join(root, 'clone');
    execFileSync('mkdir', [upstream]);
    git(upstream, 'init', '-q');
    commit(upstream, 'package.json', JSON.stringify({ version: '1.0.0' }), 'first');
    git(root, 'clone', '-q', upstream, clone);
    return { root, upstream, clone };
  }

  it('is current right after cloning', async () => {
    const { clone } = setup();
    const info = await checkCocoon(clone, '1.0.0', { fetch: true });
    expect(info).toMatchObject({ state: 'current', behind: 0, ahead: 0, branch: 'main', upstream: 'origin/main', latestVersion: '1.0.0' });
    expect(info.blocked).toBeUndefined();
  });

  it('lists new upstream commits after fetching', async () => {
    const { upstream, clone } = setup();
    commit(upstream, 'package.json', JSON.stringify({ version: '1.1.0' }), 'Add feature');
    commit(upstream, 'b.txt', 'b', 'Fix bug');
    expect((await checkCocoon(clone, '1.0.0', { fetch: false })).state).toBe('current');
    const info = await checkCocoon(clone, '1.0.0', { fetch: true });
    expect(info).toMatchObject({ state: 'outdated', behind: 2, ahead: 0, latestVersion: '1.1.0' });
    expect(info.changes.map((c) => c.subject)).toEqual(['Fix bug', 'Add feature']);
    expect(info.blocked).toBeUndefined();
  });

  it('blocks the update for local changes or diverged history', async () => {
    const { upstream, clone } = setup();
    commit(upstream, 'b.txt', 'b', 'upstream change');
    writeFileSync(join(clone, 'package.json'), 'local edit');
    expect((await checkCocoon(clone, '1.0.0', { fetch: true })).blocked).toBe('dirty');
    git(clone, 'checkout', '-q', '--', 'package.json');
    // Untracked files do not matter.
    writeFileSync(join(clone, 'notes.txt'), 'x');
    expect((await checkCocoon(clone, '1.0.0', { fetch: false })).blocked).toBeUndefined();
    commit(clone, 'c.txt', 'c', 'local commit');
    expect(await checkCocoon(clone, '1.0.0', { fetch: false })).toMatchObject({ blocked: 'diverged', ahead: 1, behind: 1 });
  });

  it('reports installations that cannot update themselves', async () => {
    const { root, clone } = setup();
    git(clone, 'checkout', '-q', '-b', 'local-only');
    expect((await checkCocoon(clone, '1.0.0', { fetch: false })).blocked).toBe('noUpstream');
    const plain = join(root, 'plain');
    execFileSync('mkdir', [plain]);
    expect(await checkCocoon(plain, '1.0.0', { fetch: false })).toMatchObject({ blocked: 'notGit', state: 'unknown' });
  });
});
