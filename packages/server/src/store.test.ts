import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from './store.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cocoon-store-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});


describe('Store: persistence', () => {
  it('starts empty without a state file', () => {
    expect(new Store(dir).sandboxes()).toEqual([]);
  });

  it('keeps the previous version as state.json.bak (mode 0600)', () => {
    const store = new Store(dir);
    store.putLayout('a', { tabs: [] } as never);
    store.putLayout('b', { tabs: [] } as never);
    const bak = JSON.parse(readFileSync(join(dir, 'state.json.bak'), 'utf8'));
    expect(Object.keys(bak.layouts)).toEqual(['a']);
    expect(Object.keys(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).layouts)).toEqual(['a', 'b']);
    expect(statSync(join(dir, 'state.json.bak')).mode & 0o777).toBe(0o600);
    expect(existsSync(join(dir, 'state.json.tmp'))).toBe(false);
  });

  it('falls back to the backup when state.json is empty or truncated', () => {
    const store = new Store(dir);
    store.putLayout('a', { tabs: [] } as never);
    store.putLayout('b', { tabs: [] } as never);
    writeFileSync(join(dir, 'state.json'), '');
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const restored = new Store(dir);
    expect(restored.layout('a')).toBeDefined();
    expect(restored.layout('b')).toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('unreadable'));
  });

  it('still fails when neither file can be read', () => {
    writeFileSync(join(dir, 'state.json'), '{');
    expect(() => new Store(dir)).toThrow();
  });

  it('restores the backup when state.json is missing (crash between the two renames)', () => {
    const store = new Store(dir);
    store.putLayout('a', { tabs: [] } as never);
    store.putLayout('b', { tabs: [] } as never);
    rmSync(join(dir, 'state.json'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(new Store(dir).layout('a')).toBeDefined();
  });
});

describe('Store: secrets at rest', () => {
  const read = () => readFileSync(join(dir, 'state.json'), 'utf8');
  const API_KEY = 'sk-ant-api03-supersecretvalue';

  it('writes secrets encrypted and reads them back', () => {
    const store = new Store(dir);
    store.putSecret('ANTHROPIC_API_KEY', { value: API_KEY, updatedAt: '2026-01-01T00:00:00.000Z' });
    expect(read()).not.toContain(API_KEY);
    expect(JSON.parse(read()).secrets.ANTHROPIC_API_KEY.enc).toMatch(/^v1:/);
    expect(JSON.parse(read()).secrets.ANTHROPIC_API_KEY.value).toBeUndefined();
    expect(new Store(dir).secrets().ANTHROPIC_API_KEY).toEqual({ value: API_KEY, updatedAt: '2026-01-01T00:00:00.000Z' });
  });

  it('migrates a plaintext state.json (and its .bak) on start', () => {
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ secrets: { GITHUB_TOKEN: { value: 'ghp_plaintext', updatedAt: '2025-12-01T00:00:00.000Z' } } }));
    const store = new Store(dir);
    expect(store.secrets().GITHUB_TOKEN).toEqual({ value: 'ghp_plaintext', updatedAt: '2025-12-01T00:00:00.000Z' });
    expect(read()).not.toContain('ghp_plaintext');
    expect(readFileSync(join(dir, 'state.json.bak'), 'utf8')).not.toContain('ghp_plaintext');
    expect(new Store(dir).secrets().GITHUB_TOKEN?.value).toBe('ghp_plaintext');
  });

  it('reads encrypted and plaintext entries side by side', () => {
    new Store(dir).putSecret('A_KEY', { value: 'aaa', updatedAt: 't1' });
    const state = JSON.parse(read());
    state.secrets.B_KEY = { value: 'bbb', updatedAt: 't2' };
    writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
    const store = new Store(dir);
    expect(store.secrets().A_KEY?.value).toBe('aaa');
    expect(store.secrets().B_KEY?.value).toBe('bbb');
    expect(read()).not.toContain('bbb');
  });

  it('binds a blob to its secret name', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    new Store(dir).putSecret('A_KEY', { value: 'aaa', updatedAt: 't1' });
    const state = JSON.parse(read());
    state.secrets.B_KEY = state.secrets.A_KEY;
    writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
    const copy = new Store(dir);
    expect(copy.secrets().A_KEY?.value).toBe('aaa');
    expect(copy.secrets().B_KEY).toBeUndefined();
  });

  it('keeps undecryptable secrets in the file instead of dropping them', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    new Store(dir).putSecret('A_KEY', { value: 'aaa', updatedAt: 't1' });
    const blob = JSON.parse(read()).secrets.A_KEY.enc;
    rmSync(join(dir, 'env.key'));
    const store = new Store(dir);
    expect(store.secrets().A_KEY).toBeUndefined();
    store.putSecret('OTHER_KEY', { value: 'ooo', updatedAt: 't2' });
    expect(JSON.parse(read()).secrets.A_KEY.enc).toBe(blob);
  });
});
