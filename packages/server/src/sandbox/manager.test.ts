import { describe, expect, it, vi } from 'vitest';
import type { EgressManager } from '../egress.ts';
import type { EventBus } from '../events.ts';
import type { SecretsService } from '../secrets.ts';
import type { SettingsService } from '../settings.ts';
import type { SandboxRecord, Store } from '../store.ts';
import type { RuntimeState, SandboxDriver } from './driver.ts';
import { SandboxManager } from './manager.ts';

const sandbox = (id: string, extra: Partial<SandboxRecord> = {}): SandboxRecord =>
  ({ id, name: id, status: 'running', network: 'open', handle: `h-${id}`, ...extra }) as SandboxRecord;

function setup(records: SandboxRecord[], state: (handle: string) => Promise<RuntimeState>, address: () => Promise<string | undefined> = async () => undefined) {
  const saved = new Map<string, SandboxRecord>();
  const store = { sandboxes: () => records, putSandbox: (record: SandboxRecord) => saved.set(record.id, record) } as unknown as Store;
  const driver = { state, address } as unknown as SandboxDriver;
  const bus = { publish: vi.fn() } as unknown as EventBus;
  const manager = new SandboxManager({} as SettingsService, {} as SecretsService, driver, store, bus, {} as EgressManager);
  return { manager, saved };
}

describe('SandboxManager.reconcile', () => {
  it('takes the state the driver reports and the address of running egress sandboxes', async () => {
    const records = [sandbox('a', { network: 'egress' }), sandbox('b'), sandbox('c', { handle: undefined })];
    const { manager, saved } = setup(records, async (handle) => (handle === 'h-a' ? 'running' : 'missing'), async () => '10.0.0.7');
    await manager.reconcile();
    expect(records.map((r) => [r.id, r.status, r.ip])).toEqual([['a', 'running', '10.0.0.7'], ['b', 'missing', undefined], ['c', 'error', undefined]]);
    expect([...saved.keys()]).toEqual(['a', 'b', 'c']);
  });

  it('keeps the stored state of a sandbox the driver fails on, logs it and still reconciles the rest', async () => {
    const records = [sandbox('a'), sandbox('b', { status: 'running' }), sandbox('c')];
    const { manager, saved } = setup(records, async (handle) => {
      if (handle === 'h-b') throw new Error('Docker daemon is starting');
      return 'stopped';
    });
    const log = vi.fn();
    await expect(manager.reconcile(log)).resolves.toBeUndefined();
    expect(records.map((r) => r.status)).toEqual(['stopped', 'running', 'stopped']);
    expect([...saved.keys()]).toEqual(['a', 'c']);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('sandbox b'), expect.objectContaining({ message: 'Docker daemon is starting' }));
  });

  it('leaves the sandbox untouched when only reading its address fails', async () => {
    const records = [sandbox('a', { network: 'egress', status: 'stopped', ip: '10.0.0.1' })];
    const { manager } = setup(records, async () => 'running', async () => {
      throw new Error('inspect failed');
    });
    await manager.reconcile();
    expect(records[0]).toMatchObject({ status: 'stopped', ip: '10.0.0.1' });
  });
});
