import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BwrapDriver } from './bwrap.ts';
import { DockerDriver } from './docker.ts';
import { selectDriver } from './select.ts';

let dir: string;
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cocoon-select-'));
  Object.defineProperty(process, 'platform', { value: 'linux' });
  // No container engine, bubblewrap works: the situation in which "auto" used to fall back silently.
  vi.spyOn(DockerDriver.prototype, 'check').mockRejectedValue(new Error('no engine'));
  vi.spyOn(BwrapDriver.prototype, 'check').mockResolvedValue();
});
afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('selectDriver and bubblewrap', () => {
  it('does not fall back to bubblewrap silently with "auto"', async () => {
    const err = await selectDriver('auto', { dataDir: dir }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/bubblewrap: not used automatically/);
    expect((err as Error).message).toMatch(/COCOON_BWRAP_HOST_NETWORK=1/);
  });

  it('falls back to bubblewrap with "auto" once the shared host network is accepted', async () => {
    const driver = await selectDriver('auto', { dataDir: dir, bwrapHostNetwork: true });
    expect(driver.kind).toBe('bwrap');
  });

  it('uses bubblewrap when it is chosen explicitly (network "none" only, unless opted in)', async () => {
    const driver = await selectDriver('bwrap', { dataDir: dir });
    expect(driver.kind).toBe('bwrap');
    await expect(driver.create({ sandboxId: 'sb_1', name: 'n', image: '', network: 'egress', runtime: null, resources: {}, workdir: '/workspace', env: {}, toolbox: false })).rejects.toThrow(
      /COCOON_BWRAP_HOST_NETWORK/,
    );
  });
});
