import { describe, expect, it } from 'vitest';
import { normalizeProxyHost, normalizeRepoUrl, parseDotenv } from './env.ts';
import { repoFolderName } from './models.ts';
import { parseReport } from './schedules.ts';
import { parseSkillSource } from './skills.ts';
import { cutAtAny, stripCodeFence, stripInlineComment, trimTrailing } from './strings.ts';

describe('string helpers', () => {
  it('trimTrailing removes only the given character at the end', () => {
    expect(trimTrailing('a/b///', '/')).toBe('a/b');
    expect(trimTrailing('///', '/')).toBe('');
    expect(trimTrailing('', '/')).toBe('');
    expect(trimTrailing('/a', '/')).toBe('/a');
  });

  it('cutAtAny cuts at the first of the characters', () => {
    expect(cutAtAny('https://h/x?a=1#f', '?#')).toBe('https://h/x');
    expect(cutAtAny('https://h/x#f?a=1', '?#')).toBe('https://h/x');
    expect(cutAtAny('plain', '?#')).toBe('plain');
    expect(cutAtAny('?x', '?#')).toBe('');
  });

  it('stripInlineComment removes " # comment" but not a # inside a word', () => {
    expect(stripInlineComment('value   # comment')).toBe('value');
    expect(stripInlineComment('value\t#c')).toBe('value');
    expect(stripInlineComment('a#b')).toBe('a#b');
    expect(stripInlineComment('#x')).toBe('#x');
    expect(stripInlineComment('a#b c # d # e')).toBe('a#b c');
  });

  it('stripCodeFence removes a Markdown fence around JSON, with or without "json"', () => {
    expect(stripCodeFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripCodeFence('  ```\n{"a":1}\n```  ')).toBe('{"a":1}');
    expect(stripCodeFence('{"a":1}')).toBe('{"a":1}');
    expect(stripCodeFence('```json{"a":1}')).toBe('{"a":1}');
  });
});

describe('callers keep their results', () => {
  it('normalizes repository URLs', () => {
    expect(normalizeRepoUrl('https://GitHub.com/Acme/Shop.git/')).toBe('github.com/Acme/Shop');
    expect(normalizeRepoUrl('git@github.com:acme/shop.git')).toBe('github.com/acme/shop');
    expect(normalizeRepoUrl('https://host.example:8443/a/b?x=1#y')).toBe('host.example/a/b');
    expect(normalizeProxyHost('API.Stripe.com/')).toBe('api.stripe.com');
  });

  it('derives folder names and skill sources', () => {
    expect(repoFolderName('https://github.com/acme/shop.git/?x=1')).toBe('shop');
    expect(parseSkillSource('https://github.com/acme/skills/')).toMatchObject({ url: 'https://github.com/acme/skills' });
  });

  it('reads .env comments and scheduled-run reports in a fence', () => {
    expect(parseDotenv('A=1 # one\nB=two#three\n').vars).toEqual([
      { name: 'A', value: '1' },
      { name: 'B', value: 'two#three' },
    ]);
    expect(parseReport('```json\n{"status":"ok","summary":"fine"}\n```')).toMatchObject({ status: 'ok', summary: 'fine' });
  });
});

describe('no quadratic backtracking on long input', () => {
  // These strings blocked the event loop for minutes with the previous regular expressions (quadratic time).
  const n = 300_000;
  const fast = (what: string, run: () => unknown) => {
    const start = performance.now();
    run();
    expect(performance.now() - start, what).toBeLessThan(500);
  };

  it('repository URLs and folder names', () => {
    fast('normalizeRepoUrl', () => normalizeRepoUrl(`https://h/${'/'.repeat(n)}x`));
    fast('normalizeRepoUrl #', () => normalizeRepoUrl(`${'#'.repeat(n)}\n`));
    fast('repoFolderName', () => repoFolderName(`${'/'.repeat(n)}x`));
    fast('repoFolderName #', () => repoFolderName(`${'#'.repeat(n)}\n`));
    fast('normalizeProxyHost', () => normalizeProxyHost(`${'/'.repeat(n)}x`));
  });

  it('skill sources, reports and .env files', () => {
    fast('parseSkillSource', () => parseSkillSource(`acme/skills${'/'.repeat(n)}x`));
    fast('parseReport', () => parseReport(`${' '.repeat(n)}x`));
    fast('parseDotenv', () => parseDotenv(`A=b${' '.repeat(n)}x`));
  });
});
