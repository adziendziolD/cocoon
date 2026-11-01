import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { INSTALL_SKILL_SCRIPT } from './skills.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cocoon-skills-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('INSTALL_SKILL_SCRIPT input checks', () => {
  const install = (env: Record<string, string>) => {
    const home = join(dir, 'home');
    mkdirSync(home, { recursive: true });
    return spawnSync('sh', ['-c', INSTALL_SKILL_SCRIPT], {
      env: { PATH: process.env.PATH ?? '', HOME: home, SKILLS_DIR: '.claude/skills', SKILL_URL: 'file:///nonexistent', SKILL_REF: '', SKILL_PATH: '', SKILL_NAME: 'my-skill', ...env },
      encoding: 'utf8',
    });
  };

  it.each([
    { SKILL_PATH: '../outside' },
    { SKILL_PATH: 'a/../../outside' },
    { SKILL_PATH: '/etc' },
    { SKILL_NAME: '..' },
    { SKILL_NAME: '../evil' },
    { SKILL_NAME: 'a/b' },
    { SKILL_NAME: '' },
    { SKILLS_DIR: '../../etc' },
    { SKILLS_DIR: '/etc' },
  ] as Record<string, string>[])('refuses %j before touching anything', (env) => {
    const res = install(env);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('invalid skill name or path');
    expect(existsSync(join(dir, 'home/.claude'))).toBe(false);
  });

  it('installs a skill from a repository with a plain path and name', () => {
    const repo = join(dir, 'repo');
    mkdirSync(join(repo, 'skills/my-skill'), { recursive: true });
    writeFileSync(join(repo, 'skills/my-skill/SKILL.md'), '# skill');
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stdio: 'ignore' });
    git('init', '--quiet');
    git('add', '.');
    git('commit', '--quiet', '-m', 'init');
    const res = install({ SKILL_URL: `file://${repo}`, SKILL_PATH: 'skills/my-skill' });
    expect(res.stderr).toBe('');
    expect(res.status).toBe(0);
    expect(existsSync(join(dir, 'home/.claude/skills/my-skill/SKILL.md'))).toBe(true);
  });
});
