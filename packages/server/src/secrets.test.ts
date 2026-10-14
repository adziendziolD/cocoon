import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mask, SecretsService } from './secrets.ts';
import type { SecretRecord, Store } from './store.ts';

/** In-memory stand-in for the parts of Store the secrets service uses. */
function fakeStore(initial: Record<string, string> = {}) {
  const secrets: Record<string, SecretRecord> = Object.fromEntries(
    Object.entries(initial).map(([name, value]) => [name, { value, updatedAt: '2026-01-01T00:00:00.000Z' }]),
  );
  const store = {
    secrets: () => secrets,
    putSecret: (name: string, record: SecretRecord | undefined) => {
      if (record) secrets[name] = record;
      else delete secrets[name];
    },
  };
  return { store: store as unknown as Store, secrets };
}

const PASTED = 'sk-ant-api03-abcdef\n  ghijkl';

describe('SecretsService whitespace normalization', () => {
  const touched = ['GITHUB_TOKEN', 'CUSTOM_API_KEY', 'MY_SETTING', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'GEMINI_API_KEY'];
  beforeEach(() => {
    for (const name of touched) vi.stubEnv(name, '');
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GITHUB_TOKEN'])(
    'set() strips all whitespace from the known credential %s',
    (name) => {
      const { store, secrets } = fakeStore();
      new SecretsService(store).set(name, `  ${PASTED}\t\r\n`);
      expect(secrets[name]!.value).toBe('sk-ant-api03-abcdefghijkl');
    },
  );

  it.each(['CUSTOM_API_KEY', 'LITELLM_KEY', 'SENTRY_AUTH_TOKEN'])('set() strips all whitespace from *_KEY / *_TOKEN names like %s', (name) => {
    const { store, secrets } = fakeStore();
    new SecretsService(store).set(name, 'abc def\n  ghi');
    expect(secrets[name]!.value).toBe('abcdefghi');
  });

  it('set() only trims other names and keeps inner whitespace', () => {
    const { store, secrets } = fakeStore();
    const service = new SecretsService(store);
    service.set('MY_SETTING', '  hello  world \n');
    service.set('KEYRING', ' a b ');
    service.set('TOKEN_URL', ' https://x/y z ');
    expect(secrets.MY_SETTING!.value).toBe('hello  world');
    expect(secrets.KEYRING!.value).toBe('a b');
    expect(secrets.TOKEN_URL!.value).toBe('https://x/y z');
  });

  it('resolve() normalizes values that were stored before normalization existed', () => {
    const { store } = fakeStore({ GITHUB_TOKEN: 'ghp_abc\n  def', CUSTOM_API_KEY: ' k e y ', MY_SETTING: '  two words  ' });
    const service = new SecretsService(store);
    expect(service.resolve('GITHUB_TOKEN')).toBe('ghp_abcdef');
    expect(service.resolve('CUSTOM_API_KEY')).toBe('key');
    expect(service.resolve('MY_SETTING')).toBe('two words');
  });

  it('resolve() falls back to the environment, normalized as well', () => {
    vi.stubEnv('CUSTOM_API_KEY', 'env-key\n  part2');
    vi.stubEnv('MY_SETTING', ' spaced value ');
    const service = new SecretsService(fakeStore().store);
    expect(service.resolve('CUSTOM_API_KEY')).toBe('env-keypart2');
    expect(service.resolve('MY_SETTING')).toBe('spaced value');
  });

  it('resolve() prefers stored values and treats empty env vars as unset', () => {
    vi.stubEnv('GITHUB_TOKEN', 'from-env');
    expect(new SecretsService(fakeStore({ GITHUB_TOKEN: 'stored' }).store).resolve('GITHUB_TOKEN')).toBe('stored');
    expect(new SecretsService(fakeStore().store).resolve('MY_SETTING')).toBeUndefined();
  });

  it('notifies listeners on set and delete', () => {
    const { store, secrets } = fakeStore();
    const service = new SecretsService(store);
    const listener = vi.fn();
    service.onChange(listener);
    service.set('MY_SETTING', 'x');
    service.delete('MY_SETTING');
    expect(listener).toHaveBeenCalledTimes(2);
    expect(secrets).not.toHaveProperty('MY_SETTING');
  });

  it('lists known secrets plus stored ones with masked previews', () => {
    const { store } = fakeStore({ CUSTOM_API_KEY: 'sk-1234567890abcdef' });
    const list = new SecretsService(store).list();
    expect(list.find((s) => s.name === 'ANTHROPIC_API_KEY')).toEqual({ name: 'ANTHROPIC_API_KEY', set: false });
    expect(list.find((s) => s.name === 'CUSTOM_API_KEY')).toMatchObject({ set: true, source: 'store', preview: 'sk-1234…cdef' });
    expect(JSON.stringify(list)).not.toContain('sk-1234567890abcdef');
  });
});

describe('mask', () => {
  it('hides short values completely and shows only prefix and suffix of long ones', () => {
    expect(mask('')).toBe('••••');
    expect(mask('123456789012')).toBe('••••');
    expect(mask('1234567890123')).toBe('12345…0123');
    expect(mask('sk-ant-api03-verylongsecret')).toBe('sk-ant-…cret');
  });
});

describe('SecretsService.githubToken', () => {
  beforeEach(() => vi.stubEnv('GITHUB_TOKEN', ''));
  afterEach(() => vi.unstubAllEnvs());

  function service(tokens: Record<string, string>, workspaceToken?: string) {
    const { store } = fakeStore(tokens);
    (store as unknown as { workspace: (id: string) => unknown }).workspace = (id) => (id === 'ws' ? { githubToken: workspaceToken } : undefined);
    return new SecretsService(store);
  }
  const tokens = { GITHUB_TOKEN: 'default', GITHUB_TOKEN_PRIVATE: 'private', GITHUB_TOKEN_COMPANY: 'company' };

  it('prefers the sandbox token, then the workspace token, then the default', () => {
    const s = service(tokens, 'GITHUB_TOKEN_COMPANY');
    expect(s.githubToken({ githubToken: 'GITHUB_TOKEN_PRIVATE', workspaceId: 'ws' })).toBe('private');
    expect(s.githubToken({ workspaceId: 'ws' })).toBe('company');
    expect(s.githubToken({})).toBe('default');
  });

  it('never falls back to another account when the chosen token is gone', () => {
    const s = service({ GITHUB_TOKEN: 'default' }, 'GITHUB_TOKEN_COMPANY');
    expect(s.githubToken({ workspaceId: 'ws' })).toBeUndefined();
    expect(s.githubToken({ githubToken: 'GITHUB_TOKEN_PRIVATE' })).toBeUndefined();
  });
});
