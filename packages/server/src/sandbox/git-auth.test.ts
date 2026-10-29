import { describe, expect, it } from 'vitest';
import { githubAuthEnv, parseGithubRepo } from './git-auth.ts';

describe('parseGithubRepo', () => {
  it.each([
    ['https://github.com/acme/shop', 'acme', 'shop'],
    ['https://github.com/acme/shop.git', 'acme', 'shop'],
    ['https://github.com/acme/shop/', 'acme', 'shop'],
    ['http://github.com/acme/shop', 'acme', 'shop'],
    ['https://x-access-token:abc@github.com/acme/shop.git', 'acme', 'shop'],
    ['git@github.com:acme/shop.git', 'acme', 'shop'],
    ['ssh://git@github.com/acme/shop', 'acme', 'shop'],
    ['https://GitHub.com/Acme/Shop', 'Acme', 'Shop'],
  ])('recognises %s', (url, owner, repo) => {
    expect(parseGithubRepo(url)).toEqual({ owner, repo });
  });

  it.each([
    'https://evil.example/github.com/acme/shop',
    'https://github.com.evil.example/acme/shop',
    'https://notgithub.com/acme/shop',
    'https://evil.example/?u=github.com/acme/shop',
    'https://gitlab.com/acme/shop',
    'git@gitlab.com:acme/shop.git',
    'https://github.com/acme',
    '',
  ])('does not take %j for a GitHub repository', (url) => {
    expect(parseGithubRepo(url)).toBeUndefined();
  });
});

describe('githubAuthEnv', () => {
  it('only sends the token to github.com over https', () => {
    expect(githubAuthEnv('https://github.com/acme/shop', 'tok').GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraheader');
    expect(githubAuthEnv('https://evil.example/github.com/acme/shop', 'tok')).toEqual({});
    expect(githubAuthEnv('https://github.com/acme/shop', undefined)).toEqual({});
  });
});
