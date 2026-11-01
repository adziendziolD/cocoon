import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BlockedTargetError, isPrivateAddress, postJson } from './outbound.ts';
import { Notifier } from './notifications.ts';
import type { EventBus } from './events.ts';
import type { SettingsService } from './settings.ts';
import type { Store } from './store.ts';

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1', '127.1.2.3', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '224.0.0.1',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '64:ff9b::7f00:1', 'ff02::1', '[::1]',
  ])('blocks %s', (ip) => expect(isPrivateAddress(ip)).toBe(true));

  it.each(['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '100.63.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])('allows %s', (ip) => expect(isPrivateAddress(ip)).toBe(false));
});

describe('postJson', () => {
  const servers: Server[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
    vi.unstubAllEnvs();
  });

  async function receiver(handler: Parameters<typeof createServer>[1] = (_req, res) => res.end('ok')) {
    const hits: string[] = [];
    const server = createServer((req, res) => {
      hits.push(req.url ?? '');
      (handler as (req: unknown, res: unknown) => void)(req, res);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { port: (server.address() as AddressInfo).port, hits };
  }

  it('refuses loopback targets given as IP or as a name that resolves to loopback', async () => {
    const { port, hits } = await receiver();
    await expect(postJson(`http://127.0.0.1:${port}/hook`, {})).rejects.toBeInstanceOf(BlockedTargetError);
    await expect(postJson(`http://[::1]:${port}/hook`, {})).rejects.toBeInstanceOf(BlockedTargetError);
    await expect(postJson(`http://localhost:${port}/hook`, {})).rejects.toBeInstanceOf(BlockedTargetError);
    await expect(postJson('http://169.254.169.254/latest/meta-data', {})).rejects.toBeInstanceOf(BlockedTargetError);
    expect(hits).toEqual([]);
  });

  it('rejects other schemes', async () => {
    await expect(postJson('file:///etc/passwd', {})).rejects.toThrow(/http/);
  });

  it('posts to a private target when explicitly allowed, and does not follow redirects', async () => {
    const { port, hits } = await receiver((req, res) => {
      if (req.url === '/redirect') return void res.writeHead(302, { location: '/internal' }).end();
      res.end('ok');
    });
    expect(await postJson(`http://127.0.0.1:${port}/hook`, { a: 1 }, { allowPrivate: true })).toBe(200);
    expect(await postJson(`http://127.0.0.1:${port}/redirect`, {}, { allowPrivate: true })).toBe(302);
    expect(hits).toEqual(['/hook', '/redirect']);
  });

  it('gives up on a receiver that keeps the response open', async () => {
    const { port } = await receiver((_req, res) => void res.writeHead(200, { 'content-length': '10' }).write('x'));
    await expect(postJson(`http://127.0.0.1:${port}/hook`, {}, { allowPrivate: true, timeoutMs: 100 })).rejects.toThrow();
  });

  it('honours COCOON_ALLOW_PRIVATE_WEBHOOKS', async () => {
    const { port } = await receiver();
    vi.stubEnv('COCOON_ALLOW_PRIVATE_WEBHOOKS', '1');
    expect(await postJson(`http://127.0.0.1:${port}/hook`, {})).toBe(200);
  });
});

describe('Notifier webhook target', () => {
  it('reports a blocked webhook target on test and sends nothing', async () => {
    const hits: string[] = [];
    const server = createServer((req, res) => {
      hits.push(req.url ?? '');
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
      const settings = { get: () => ({ notifications: { webhookUrl: url, events: [] }, general: { language: 'en' } }) } as unknown as SettingsService;
      const notifier = new Notifier(settings, {} as Store, { subscribe: () => {} } as unknown as EventBus, undefined, () => {});
      const result = await notifier.test();
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/private networks/);
      expect(hits).toEqual([]);
    } finally {
      server.close();
    }
  });
});
