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
