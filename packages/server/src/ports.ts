import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import type { PortMode, SandboxPort } from '@cocoon/protocol';
import type { ActivityLog } from './activity.ts';
import { agentNotesScript } from './agents/notes.ts';
import type { Config } from './config.ts';
import { CocoonError } from './errors.ts';
import type { EventBus } from './events.ts';
import { PROXY_IMAGE } from './images.ts';
import { scoped } from './instance.ts';
import { t } from './i18n.ts';
import { DockerDriver, INTERNAL_NETWORK, statusOf } from './sandbox/docker.ts';
import type { SandboxDriver } from './sandbox/driver.ts';
import type { SandboxManager } from './sandbox/manager.ts';
import type { OpenPort, SandboxRecord, Store } from './store.ts';

export const GATEWAY_CONTAINER = scoped('cocoon-ports');
const POLL_MS = 3000;
const LINK_TTL_MS = 2 * 60 * 1000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** After the first use a link keeps working briefly (reloads, browser prefetch/duplicate navigation) and yields the same session. */
const LINK_GRACE_MS = 30 * 1000;
export const PREVIEW_COOKIE = 'cocoon_preview';

export type Listening = { port: number; address: 'all' | 'loopback' };

/**
 * Listening TCP ports from /proc/net/tcp + /proc/net/tcp6 (state 0A). A port bound to any non-loopback address counts as "all".
 * Addresses are hex in host byte order (little-endian), so 127.x.x.x ends in "7F". Docker's embedded DNS (127.0.0.11) is skipped.
 */
export function parseListening(procNet: string): Listening[] {
  const ports = new Map<number, Listening['address']>();
  for (const line of procNet.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4 || fields[3] !== '0A' || !fields[1]?.includes(':')) continue;
    const [hexAddr = '', hexPort = ''] = fields[1].split(':');
    const port = parseInt(hexPort, 16);
    if (!Number.isInteger(port) || port <= 0) continue;
    const addr = hexAddr.toUpperCase();
    if (addr === '0B00007F') continue;
    const v4 = addr.length === 8 ? addr : addr.startsWith('0000000000000000FFFF0000') ? addr.slice(24) : undefined;
    const loopback = v4 !== undefined ? v4.endsWith('7F') : addr === '00000000000000000000000001000000';
    const address = loopback ? 'loopback' : 'all';
    if (ports.get(port) !== 'all') ports.set(port, address);
  }
  return [...ports].map(([port, address]) => ({ port, address })).sort((a, b) => a.port - b.port);
}

/** "7500-7549,7600" → [7500, …, 7549, 7600] */
export function parseRange(spec: string): number[] {
  const ports: number[] = [];
  for (const part of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [from, to = from] = part.split('-').map(Number);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from! < 1 || to! > 65535 || to! < from!) throw new Error(`invalid port range "${part}"`);
    for (let p = from!; p <= to!; p++) ports.push(p);
  }
  return ports;
}

/** Preview host name for a sandbox port: p5173-<hex id>.<suffix>. Sandbox ids are "sb_<hex>" – underscores are not valid in host names. */
export const previewLabel = (sandboxId: string, port: number) => `p${port}-${sandboxId.replace(/^sb_/, '')}`;

export function parsePreviewHost(host: string | undefined, suffix: string): { sandboxId: string; port: number } | undefined {
  const name = (host ?? '').toLowerCase().replace(/:\d+$/, '');
  const match = /^p(\d{1,5})-([a-f0-9]+)\.(.+)$/.exec(name);
  if (!match || match[3] !== suffix.toLowerCase()) return undefined;
  return { sandboxId: `sb_${match[2]}`, port: Number(match[1]) };
}

/** Origin of a CoCoon opened from another machine (where *.localhost would point to the wrong host); undefined for local use. */
function remoteOrigin(origin: string): string | undefined {
  try {
    const url = new URL(origin);
    if (!/^https?:$/.test(url.protocol) || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.hostname.endsWith('.localhost')) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

/** Path-based preview: /preview/p<port>-<id>/<rest> (for setups without wildcard host names, e.g. behind Tailscale Serve). */
export function parsePreviewPath(url: string | undefined): { sandboxId: string; port: number; prefix: string; rest: string } | undefined {
  const match = /^\/preview\/(p(\d{1,5})-([a-f0-9]+))(\/[^?#]*)?(\?[^#]*)?/i.exec(url ?? '');
  if (!match) return undefined;
  return { sandboxId: `sb_${match[3]!.toLowerCase()}`, port: Number(match[2]), prefix: `/preview/${match[1]}`, rest: `${match[4] ?? '/'}${match[5] ?? ''}` };
}

/** First non-internal IPv4 address of the host (for "shared" URLs). */
function lanAddress(): string {
  for (const list of Object.values(networkInterfaces())) {
    for (const entry of list ?? []) if (entry.family === 'IPv4' && !entry.internal) return entry.address;
  }
  return 'localhost';
}

/**
 * Port forwarding: detects listening ports in sandboxes, opens them through a gateway container (two published host
 * port ranges: 127.0.0.1 for previews, the share bind address for shared ports) and serves authenticated previews.
 */
export class PortService {
  readonly enabled: boolean;
  private readonly previewPorts: number[];
  private readonly sharePorts: number[];
  private readonly dir: string;
  private readonly listening = new Map<string, Listening[]>();
  private readonly links = new Map<string, { sandboxId: string; port: number; expires: number; session?: string; graceUntil?: number }>();
  private readonly sessions = new Map<string, { host: string; expires: number }>();
  private timer?: NodeJS.Timeout;
  private polling = false;

  constructor(
    private readonly config: Config,
    private readonly driver: SandboxDriver,
    private readonly store: Store,
    private readonly sandboxes: SandboxManager,
    private readonly bus: EventBus,
    private readonly activity: ActivityLog,
    private readonly log: (msg: string, err?: unknown) => void,
  ) {
    this.enabled = config.ports.enabled && driver instanceof DockerDriver;
    this.previewPorts = parseRange(config.ports.previewRange);
    this.sharePorts = config.ports.shareBind ? parseRange(config.ports.shareRange) : [];
    this.dir = join(store.dataDir, 'ports');
    if (!this.enabled) return;
    mkdirSync(this.dir, { recursive: true, mode: 0o755 });
    sandboxes.addHooks({
      created: async (record) => {
        await this.writeNotes(record).catch((err) => this.log('writing port notes failed', err));
      },
      deleting: async (record) => {
        this.listening.delete(record.id);
        await this.writeMapping(record.id).catch((err) => this.log('port mapping failed', err));
      },
    });
    bus.subscribe((event) => {
      if (event.type === 'sandbox.updated') void this.writeMapping().catch((err) => this.log('port mapping failed', err));
    });
  }

  get shareEnabled(): boolean {
    return this.enabled && this.sharePorts.length > 0;
  }

  get previewSuffix(): string {
    return this.config.ports.previewDomain ?? 'localhost';
  }

  /** Starts the gateway and the port detection. */
  async start(): Promise<void> {
    if (!this.enabled) return;
    await this.ensureGateway();
    await this.writeMapping();
    this.timer = setInterval(() => void this.poll(), POLL_MS);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  list(sandboxId: string): SandboxPort[] {
    const record = this.sandboxes.record(sandboxId);
    const listening = this.listening.get(sandboxId) ?? [];
    const opened = new Map((record.ports ?? []).map((p) => [p.port, p]));
    const numbers = [...new Set([...listening.map((l) => l.port), ...opened.keys()])].sort((a, b) => a - b);
    return numbers.map((port) => {
      const live = listening.find((l) => l.port === port);
      const open = opened.get(port);
      return {
        port,
        listening: Boolean(live),
        address: live?.address,
        opened: open && {
          mode: open.mode,
          name: open.name,
          openedAt: open.openedAt,
          hostPort: open.hostPort,
          url: open.mode === 'shared' ? `http://${this.shareHost()}:${open.hostPort}` : undefined,
        },
      };
    });
  }

  async open(sandboxId: string, port: number, mode: PortMode, name?: string): Promise<SandboxPort> {
    this.assertEnabled();
    const record = this.sandboxes.record(sandboxId);
    if (record.network === 'none') throw new CocoonError('bad_request', t('error.portNoNetwork'));
    if (mode === 'shared' && !this.sharePorts.length) throw new CocoonError('bad_request', t('error.portShareDisabled'));
    const ports = (record.ports ?? []).filter((p) => p.port !== port);
    const existing = record.ports?.find((p) => p.port === port);
    const hostPort = existing?.mode === mode ? existing.hostPort : this.allocate(mode);
    const entry: OpenPort = { port, mode, hostPort, name: name ?? existing?.name, openedAt: existing?.mode === mode ? existing.openedAt : new Date().toISOString() };
    this.sandboxes.update(sandboxId, { ports: [...ports, entry] });
    await this.writeMapping();
    if (existing?.mode !== mode) this.activity.add(mode === 'shared' ? 'warn' : 'info', mode === 'shared' ? 'activity.portShared' : 'activity.portOpened', { port, sandbox: record.name }, { sandboxId });
    this.publish(sandboxId);
    return this.list(sandboxId).find((p) => p.port === port)!;
  }

  async close(sandboxId: string, port: number): Promise<void> {
    const record = this.sandboxes.record(sandboxId);
    if (!record.ports?.some((p) => p.port === port)) throw new CocoonError('not_found', t('error.portNotOpen', { port }));
    this.sandboxes.update(sandboxId, { ports: record.ports.filter((p) => p.port !== port) });
    await this.writeMapping();
    this.activity.add('info', 'activity.portClosed', { port, sandbox: record.name }, { sandboxId });
    this.publish(sandboxId);
  }

  /** Short-lived link (single use, plus a brief grace period) that logs a browser in to this preview only. */
  previewLink(sandboxId: string, port: number, origin?: string): { url: string; expiresAt: string } {
    this.assertEnabled();
    const record = this.sandboxes.record(sandboxId);
    if (!record.ports?.some((p) => p.port === port)) throw new CocoonError('not_found', t('error.portNotOpen', { port }));
    this.prune();
    const token = randomBytes(24).toString('base64url');
    const expires = Date.now() + LINK_TTL_MS;
    this.links.set(token, { sandboxId, port, expires });
    const label = previewLabel(sandboxId, port);
    const remote = origin && !this.config.ports.previewDomain ? remoteOrigin(origin) : undefined;
    if (remote) return { url: `${remote}/preview/${label}/?cocoon_preview=${token}`, expiresAt: new Date(expires).toISOString() };
    const host = `${label}.${this.previewSuffix}`;
    const base = this.config.ports.previewDomain ? `https://${host}` : `http://${host}:${this.config.port}`;
    return { url: `${base}/?cocoon_preview=${token}`, expiresAt: new Date(expires).toISOString() };
  }

  /**
   * Exchanges a link token for a session id (cookie value) bound to the preview host. A token is consumed by its first
   * use but may be repeated for a short grace period (same session); a request for the wrong host does not consume it.
   */
  redeem(token: string, host: string): string | undefined {
    return this.redeemFor(token, parsePreviewHost(host, this.previewSuffix));
  }

  redeemFor(token: string, target: { sandboxId: string; port: number } | undefined): string | undefined {
    const link = this.links.get(token);
    const now = Date.now();
    if (!link || !target || target.sandboxId !== link.sandboxId || target.port !== link.port) return undefined;
    if (link.session) {
      if ((link.graceUntil ?? 0) >= now && this.sessions.has(link.session)) return link.session;
      this.links.delete(token);
      return undefined;
    }
    if (link.expires < now) {
      this.links.delete(token);
      return undefined;
    }
    const session = randomBytes(24).toString('base64url');
    this.sessions.set(session, { host: previewLabel(link.sandboxId, link.port), expires: now + SESSION_TTL_MS });
    link.session = session;
    link.graceUntil = now + LINK_GRACE_MS;
    return session;
  }

  /** Why a link token was rejected (for the error page and the log). */
  linkProblem(token: string, target: { sandboxId: string; port: number } | undefined): 'unknown-token' | 'wrong-host' | 'expired' {
    const link = this.links.get(token);
    if (!link) return 'unknown-token';
    if (!target || target.sandboxId !== link.sandboxId || target.port !== link.port) return 'wrong-host';
    return 'expired';
  }

  /** Gateway port a preview request may be proxied to, if the session is valid for this host and the port is opened. */
  previewTarget(host: string, session: string | undefined): number | undefined {
    return this.previewTargetFor(parsePreviewHost(host, this.previewSuffix), session);
  }

  previewTargetFor(target: { sandboxId: string; port: number } | undefined, session: string | undefined): number | undefined {
    const entry = session ? this.sessions.get(session) : undefined;
    if (!target || !entry || entry.expires < Date.now() || entry.host !== previewLabel(target.sandboxId, target.port)) return undefined;
    return this.store.sandbox(target.sandboxId)?.ports?.find((p) => p.port === target.port)?.hostPort;
  }

  isPreviewHost(host: string | undefined): boolean {
    return this.enabled && Boolean(parsePreviewHost(host, this.previewSuffix));
  }

  /** Preview a request belongs to: by host name (p<port>-<id>.<suffix>) or by path (/preview/p<port>-<id>/). */
  previewRoute(host: string | undefined, url: string | undefined): { sandboxId: string; port: number; prefix: string; rest: string } | undefined {
    if (!this.enabled) return undefined;
    const byHost = parsePreviewHost(host, this.previewSuffix);
    if (byHost) return { ...byHost, prefix: '', rest: url ?? '/' };
    return parsePreviewPath(url);
  }

  private assertEnabled(): void {
    if (!this.enabled) throw new CocoonError('bad_request', t('error.portsUnavailable', { name: this.driver.name }));
  }

  private shareHost(): string {
    const bind = this.config.ports.shareBind;
    return !bind || bind === '0.0.0.0' ? lanAddress() : bind;
  }

  private allocate(mode: PortMode): number {
    const range = mode === 'shared' ? this.sharePorts : this.previewPorts;
    const used = new Set(this.store.sandboxes().flatMap((s) => (s.ports ?? []).map((p) => p.hostPort)));
    const free = range.find((p) => !used.has(p));
    if (free === undefined) throw new CocoonError('conflict', t('error.portRangeFull', { range: mode === 'shared' ? this.config.ports.shareRange : this.config.ports.previewRange }));
    return free;
  }

  private prune(): void {
    const now = Date.now();
    for (const [k, v] of this.links) if (v.expires < now && (v.graceUntil ?? 0) < now) this.links.delete(k);
    for (const [k, v] of this.sessions) if (v.expires < now) this.sessions.delete(k);
  }

  private publish(sandboxId: string): void {
    if (this.store.sandbox(sandboxId)) this.bus.publish({ type: 'ports.updated', sandboxId, ports: this.list(sandboxId) });
  }

  /** Reads the listening ports of all running sandboxes and reports changes. */
  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const running = this.store.sandboxes().filter((s) => s.status === 'running' && s.handle);
      await Promise.all(
        running.map(async (record) => {
          const res = await this.driver.exec(record.handle!, ['sh', '-c', 'cat /proc/net/tcp /proc/net/tcp6 2>/dev/null'], { timeoutMs: 5000 }).catch(() => undefined);
          if (!res) return;
          const next = parseListening(res.stdout);
          const prev = this.listening.get(record.id);
          this.listening.set(record.id, next);
          if (JSON.stringify(prev ?? []) !== JSON.stringify(next)) this.publish(record.id);
        }),
      );
      for (const id of this.listening.keys()) if (!running.some((s) => s.id === id)) this.listening.delete(id);
    } finally {
      this.polling = false;
    }
  }

  /** Writes host port → sandbox address for every opened port of a running sandbox (read by the gateway). */
  async writeMapping(without?: string): Promise<void> {
    if (!this.enabled) return;
    const mapping: Record<string, { host: string; port: number }> = {};
    for (const record of this.store.sandboxes()) {
      if (record.id === without || record.status !== 'running' || !record.handle || !record.ports?.length) continue;
      const host = await this.address(record).catch(() => undefined);
      if (!host) continue;
      for (const p of record.ports) mapping[String(p.hostPort)] = { host, port: p.port };
    }
    const file = join(this.dir, 'ports.json');
    writeFileSync(`${file}.tmp`, JSON.stringify(mapping), { mode: 0o644 });
    renameSync(`${file}.tmp`, file);
  }

  /** Address of a sandbox on a network the gateway is attached to: the internal network, else the default bridge. */
  private async address(record: SandboxRecord): Promise<string | undefined> {
    const docker = (this.driver as DockerDriver).docker;
    const networks = (await docker.getContainer(record.handle!).inspect()).NetworkSettings.Networks;
    return networks[INTERNAL_NETWORK]?.IPAddress || Object.values(networks).find((n) => n.IPAddress)?.IPAddress || undefined;
  }

  private async writeNotes(record: SandboxRecord): Promise<void> {
    if (!record.handle || record.network === 'none') return;
    const notes = [
      '## Servers and ports (CoCoon)',
      'Servers you start in this sandbox can be opened by the user in the browser (CoCoon detects listening ports).',
      'Bind them to 0.0.0.0 – servers that listen on 127.0.0.1/localhost only cannot be reached from outside, e.g.',
      '`npm run dev -- --host 0.0.0.0`, `python -m http.server --bind 0.0.0.0`, `uvicorn app:app --host 0.0.0.0`.',
      'Tell the user which port your server uses.',
    ].join('\n');
    await this.driver.exec(record.handle, ['sh', '-c', agentNotesScript('ports')], { env: { NOTES: notes } });
  }

  /** Creates (or recreates after a config change) the gateway container that publishes the port ranges. */
  private async ensureGateway(): Promise<void> {
    const driver = this.driver as DockerDriver;
    const docker = driver.docker;
    const script = join(this.config.imagesDir, 'port-gateway', 'gateway.mjs');
    const wanted = JSON.stringify({
      preview: this.config.ports.previewRange,
      share: this.sharePorts.length ? this.config.ports.shareRange : '',
      bind: this.config.ports.shareBind,
      script: createHash('sha256').update(readFileSync(script)).digest('hex').slice(0, 12),
    });
    const container = docker.getContainer(GATEWAY_CONTAINER);
    try {
      const info = await container.inspect();
      if (info.Config.Labels?.['cocoon.ports'] === wanted) {
        if (!info.State.Running) await container.start();
        return;
      }
      await container.remove({ force: true });
    } catch (err) {
      if (statusOf(err) !== 404) throw err;
    }
    const bindings: Record<string, { HostIp: string; HostPort: string }[]> = {};
    for (const p of this.previewPorts) bindings[`${p}/tcp`] = [{ HostIp: '127.0.0.1', HostPort: String(p) }];
    for (const p of this.sharePorts) bindings[`${p}/tcp`] = [{ HostIp: this.config.ports.shareBind, HostPort: String(p) }];
    const podman = driver.kind === 'podman';
    const created = await docker.createContainer({
      name: GATEWAY_CONTAINER,
      Image: PROXY_IMAGE,
      Cmd: ['node', '/app/gateway.mjs'],
      User: podman ? '0:0' : `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
      Env: [`PORTS_LISTEN=${[this.config.ports.previewRange, ...(this.sharePorts.length ? [this.config.ports.shareRange] : [])].join(',')}`, 'PORTS_MAP=/ports/ports.json'],
      Labels: { 'cocoon.managed': 'true', 'cocoon.ports': wanted },
      ExposedPorts: Object.fromEntries(Object.keys(bindings).map((k) => [k, {}])),
      HostConfig: {
        NetworkMode: 'bridge',
        PortBindings: bindings,
        Binds: [`${this.dir}:/ports:ro`, `${script}:/app/gateway.mjs:ro`],
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        ReadonlyRootfs: true,
        Memory: 128 * 1024 * 1024,
        RestartPolicy: { Name: 'unless-stopped' },
      },
    });
    await docker.getNetwork(INTERNAL_NETWORK).connect({ Container: created.id });
    await created.start();
  }
}
