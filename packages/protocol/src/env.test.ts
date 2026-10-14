import { describe, expect, it } from 'vitest';
import { defaultBaseUrlEnv, isReservedEnvName, normalizeProxyHost, proxyHostUrl, normalizeRepoUrl, parseDotenv, renderDotenv, validEnvFilePath } from './env.ts';

describe('parseDotenv', () => {
  it('parses plain, exported, quoted and commented values', () => {
    const { vars, errors } = parseDotenv(
      [
        '# comment',
        '',
        'PLAIN=value',
        'export EXPORTED = spaced value  ',
        'SINGLE=\'literal $HOME \\n # not a comment\'',
        'DOUBLE="line1\\nline2 \\"q\\" \\\\"',
        'TRAILING=value # a comment',
        'EMPTY=',
        'URL=postgres://u:p@db:5432/app?sslmode=disable#frag',
      ].join('\n'),
    );
    expect(errors).toEqual([]);
    expect(Object.fromEntries(vars.map((v) => [v.name, v.value]))).toEqual({
      PLAIN: 'value',
      EXPORTED: 'spaced value',
      SINGLE: 'literal $HOME \\n # not a comment',
      DOUBLE: 'line1\nline2 "q" \\',
      TRAILING: 'value',
      EMPTY: '',
      URL: 'postgres://u:p@db:5432/app?sslmode=disable#frag',
    });
  });

  it('supports multi-line double-quoted values and CRLF', () => {
    const { vars, errors } = parseDotenv('KEY="-----BEGIN-----\r\nabc\r\n-----END-----"\r\nNEXT=1\r\n');
    expect(errors).toEqual([]);
    expect(vars).toEqual([
      { name: 'KEY', value: '-----BEGIN-----\nabc\n-----END-----' },
      { name: 'NEXT', value: '1' },
    ]);
  });

  it('lets later duplicates win and strips a BOM', () => {
    expect(parseDotenv('﻿A=1\nA=2').vars).toEqual([{ name: 'A', value: '2' }]);
  });

  it('reports problems by line without echoing values', () => {
    const { vars, errors } = parseDotenv('GOOD=1\nnot a pair secret-value\n1BAD=x\nOPEN="never closed secret\nAFTER=2');
    expect(vars.map((v) => v.name)).toEqual(['GOOD', 'AFTER']);
    expect(errors.map((e) => e.line)).toEqual([2, 3, 4]);
    expect(JSON.stringify(errors)).not.toContain('secret');
  });
});

describe('renderDotenv', () => {
  it('round-trips awkward values through parseDotenv', () => {
    const vars = [
      { name: 'A', value: 'simple-value_1.2/3:4' },
      { name: 'B', value: 'has space and $dollar' },
      { name: 'C', value: "it's quoted" },
      { name: 'D', value: 'multi\nline\\value "x"' },
      { name: 'E', value: '' },
      { name: 'F', value: 'a # not a comment' },
    ];
    expect(parseDotenv(renderDotenv(vars)).vars).toEqual(vars);
  });

  it('starts with the header', () => {
    expect(renderDotenv([{ name: 'A', value: '1' }], '# header')).toBe('# header\nA=1\n');
  });
});

describe('normalizeRepoUrl', () => {
  it.each([
    'https://github.com/Acme/App.git',
    'https://user:token@GitHub.com/Acme/App/',
    'git@github.com:Acme/App.git',
    'ssh://git@github.com:22/Acme/App.git',
    'github.com/Acme/App',
    'https://github.com/Acme/App.git#main',
  ])('%s → github.com/Acme/App', (url) => {
    expect(normalizeRepoUrl(url)).toBe('github.com/Acme/App');
  });

  it('keeps different repositories apart', () => {
    expect(normalizeRepoUrl('https://github.com/acme/app')).not.toBe(normalizeRepoUrl('https://github.com/acme/api'));
    // Ports are dropped: the same repository is reachable over ssh (22) and https (443) alike.
    expect(normalizeRepoUrl('https://gitlab.example.com:8443/group/sub/app.git')).toBe('gitlab.example.com/group/sub/app');
  });
});

describe('names and paths', () => {
  it('reserves CoCoon and proxy variables', () => {
    for (const name of ['COCOON_AGENT_ID', 'HTTPS_PROXY', 'no_proxy']) expect(isReservedEnvName(name)).toBe(true);
    for (const name of ['STRIPE_KEY', 'PROXY_MODE']) expect(isReservedEnvName(name)).toBe(false);
  });

  it('accepts safe .env paths only', () => {
    for (const ok of ['.env', '.env.local', 'config/.env', 'apps/web/.env.test']) expect(validEnvFilePath(ok), ok).toBe(true);
    for (const bad of ['', '/etc/passwd', '../x', 'a/../b', './x', '.git/config', 'a/.git/x', 'x y', '!x', 'a//b', '*.env', '#x']) expect(validEnvFilePath(bad), bad).toBe(false);
  });

  it('normalizes proxy hosts', () => {
    expect(normalizeProxyHost('https://API.Stripe.com/')).toBe('api.stripe.com');
    expect(normalizeProxyHost('api.internal:8443')).toBe('api.internal:8443');
    expect(normalizeProxyHost('HTTP://localhost:9000/')).toBe('http://localhost:9000');
    expect(proxyHostUrl('api.stripe.com')).toBe('https://api.stripe.com');
    expect(proxyHostUrl('http://localhost:9000')).toBe('http://localhost:9000');
    for (const bad of ['a b.com', 'x.com/path', 'ftp://x.com', 'x.com:99999', 'https://u:p@x.com', '-x.com', '']) expect(normalizeProxyHost(bad), bad).toBeUndefined();
  });

  it('derives the base-URL variable', () => {
    expect(defaultBaseUrlEnv('STRIPE_API_KEY')).toBe('STRIPE_BASE_URL');
    expect(defaultBaseUrlEnv('SENTRY_AUTH_TOKEN')).toBe('SENTRY_AUTH_BASE_URL');
    expect(defaultBaseUrlEnv('TOKEN')).toBe('TOKEN_BASE_URL');
  });
});
