import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { INSTALL_SKILL_SCRIPT } from '../agents/skills.ts';
import { GIT_HARDENED_SH, GIT_PUSH_SCRIPT, githubAuthEnv } from './git-auth.ts';

// These tests run the real git: an agent plants hooks and git config in its repository and home directory, and
// cocoond then pushes with the GitHub token in the environment of the command.

let dir: string;
let marker: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cocoon-git-'));
  marker = join(dir, 'token-stolen');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', ...args], {
    cwd,
    env: { PATH: process.env.PATH!, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    encoding: 'utf8',
  });

/** A bare "remote" and a work repository with one commit whose origin is the bare repository. */
function repos() {
  const remote = join(dir, 'remote.git');
  const work = join(dir, 'work');
  mkdirSync(work);
  git(dir, 'init', '--bare', remote);
  git(work, 'init');
  writeFileSync(join(work, 'a.txt'), 'a');
  git(work, 'add', '-A');
  git(work, 'commit', '-m', 'one');
  git(work, 'remote', 'add', 'origin', remote);
  return { remote, work };
}

/** A hook that records that agent-controlled code ran with the token in its environment. */
function hook(path: string, name = 'pre-push') {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, name), `#!/bin/sh\nenv > "${marker}"\n`);
  chmodSync(join(path, name), 0o755);
}

/** Runs the push script like cocoond does (hardened mode as set for a GitHub URL with a token), against a local remote. */
function push(work: string, remote: string, env: Record<string, string>) {
  const hardened = githubAuthEnv('https://github.com/acme/shop', 'ghp_secret');
  return execFileSync('sh', ['-c', GIT_PUSH_SCRIPT], {
    cwd: work,
    env: { PATH: process.env.PATH!, HOME: join(dir, 'home'), BRANCH: 'feature', REMOTE_URL: remote, ...hardened, ...env },
    encoding: 'utf8',
  });
}

const pushed = (remote: string) => git(remote, 'branch', '--list', 'feature').includes('feature');

describe('push with the GitHub token (hardened mode)', () => {
  it('is only switched on together with a token for a GitHub URL', () => {
    expect(githubAuthEnv('https://github.com/acme/shop', 'tok')).toMatchObject({
      COCOON_GIT_HARDEN: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_ASKPASS: '/bin/false',
    });
    expect(githubAuthEnv('https://github.com/acme/shop', undefined)).toEqual({});
    expect(githubAuthEnv('git@github.com:acme/shop.git', 'tok')).toEqual({});
  });

  it('control: without the hardened mode git runs a pre-push hook of the repository', () => {
    const { remote, work } = repos();
    hook(join(work, '.git/hooks'));
    // Plain mode (no token): the legacy command, which runs hooks.
    execFileSync('sh', ['-c', GIT_PUSH_SCRIPT], { cwd: work, env: { PATH: process.env.PATH!, HOME: dir, BRANCH: 'feature', REMOTE_URL: remote }, encoding: 'utf8' });
    expect(existsSync(marker)).toBe(true);
    expect(pushed(remote)).toBe(true);
  });

  it('does not run a pre-push hook in .git/hooks', () => {
    const { remote, work } = repos();
    hook(join(work, '.git/hooks'));
    push(work, remote, {});
    expect(existsSync(marker)).toBe(false);
    expect(pushed(remote)).toBe(true);
  });

  it('ignores core.hooksPath in the repository config', () => {
    const { remote, work } = repos();
    hook(join(dir, 'evil-hooks'));
    git(work, 'config', 'core.hooksPath', join(dir, 'evil-hooks'));
    push(work, remote, {});
    expect(existsSync(marker)).toBe(false);
    expect(pushed(remote)).toBe(true);
  });

  it('ignores ~/.gitconfig (hooksPath, credential helper) of the agent', () => {
    const { remote, work } = repos();
    hook(join(dir, 'evil-hooks'));
    mkdirSync(join(dir, 'home'));
    writeFileSync(
      join(dir, 'home/.gitconfig'),
      `[core]\n\thooksPath = ${join(dir, 'evil-hooks')}\n[credential]\n\thelper = !env > ${marker}; true\n`,
    );
    push(work, remote, {});
    expect(existsSync(marker)).toBe(false);
    expect(pushed(remote)).toBe(true);
  });

  it('pushes to the given URL, not to the pushurl the agent configured', () => {
    const { remote, work } = repos();
    git(work, 'config', 'remote.origin.pushurl', join(dir, 'elsewhere.git'));
    push(work, remote, {});
    expect(pushed(remote)).toBe(true);
    expect(existsSync(join(dir, 'elsewhere.git'))).toBe(false);
  });
});

/** A stand-in for git that prints its arguments, one per line, then runs `cgit push`. */
const ECHO_ARGS = `git() { printf '%s\\n' "$@"; }; cgit push`;

describe('hardened git function', () => {
  const run = (script: string, env: Record<string, string>) =>
    execFileSync('sh', ['-c', `${GIT_HARDENED_SH}\n${script}`], { env: { PATH: process.env.PATH!, HOME: dir, ...env }, encoding: 'utf8' });

  it('overrides what an agent could use to capture the token', () => {
    const shown = run(ECHO_ARGS, { COCOON_GIT_HARDEN: '1', HTTPS_PROXY: 'http://cocoon:t@cocoon-proxy:3128' });
    expect(shown).toContain('core.hooksPath=/dev/null');
    expect(shown).toContain('credential.helper=');
    expect(shown).toContain('core.sshCommand=false');
    expect(shown).toContain('http.sslVerify=true');
    expect(shown).toContain('http.curloptResolve=');
    // The proxy is the sandbox's own one, whatever the repository config says.
    expect(shown).toContain('http.proxy=http://cocoon:t@cocoon-proxy:3128');
  });

  it('is plain git without the hardened mode', () => {
    expect(run(ECHO_ARGS, {}).trim()).toBe('push');
  });
});

describe('scripts that run git with the token', () => {
  it('clone through the hardened function', () => {
    expect(INSTALL_SKILL_SCRIPT).toContain('cgit clone');
    expect(INSTALL_SKILL_SCRIPT).not.toMatch(/(^|[^c])git clone/m);
  });
});
