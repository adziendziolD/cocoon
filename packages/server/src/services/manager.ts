import { randomBytes } from 'node:crypto';
import {
  SERVICE_IDLE_MINUTES,
  SERVICE_KINDS,
  type MethodParams,
  type ServiceAdminCredentials,
  type ServiceConnection,
  type ServiceInfo,
  type ServiceKind,
  type ServiceStatus,
} from '@cocoon/protocol';
import { agentNotesScript } from '../agents/notes.ts';
import { COCOON_DIR } from '../agents/tmux.ts';
import { PROXY_HOST, type EgressManager, type Relay } from '../egress.ts';
import { CocoonError, notFound } from '../errors.ts';
import type { EventBus } from '../events.ts';
import { t } from '../i18n.ts';
import { scoped } from '../instance.ts';
import { DockerDriver, ignoreStatus, INTERNAL_NETWORK, statusOf } from '../sandbox/docker.ts';
import type { SandboxDriver } from '../sandbox/driver.ts';
import type { SandboxManager } from '../sandbox/manager.ts';
import type { SandboxRecord, SandboxServiceDb, ServiceRecord, Store } from '../store.ts';
import { ENGINES, type AdminConn, type SandboxConn } from './engines.ts';

const CONTAINER_PREFIX = scoped('cocoon-svc') + '-';
const RELAY_BASE_PORT = 20000;
const READY_TIMEOUT_MS = 120_000;
/** Idle time before a managed service is paused (COCOON_SERVICE_IDLE_MINUTES overrides the default). */
const IDLE_MS = (Number(process.env.COCOON_SERVICE_IDLE_MINUTES) || SERVICE_IDLE_MINUTES) * 60_000;
const IDLE_CHECK_MS = Math.min(60_000, Math.max(5_000, IDLE_MS / 4));
export const SERVICES_ENV_FILE = `${COCOON_DIR}/services.env`;


interface Runtime {
  status: ServiceStatus;
  error?: string;
  version?: string;
  hostPorts: Record<string, number>;
}

/** Readable message; connection errors to "localhost" arrive as AggregateError (one error per IPv4/IPv6 address). */
const errorText = (err: unknown): string => {
  if (err instanceof AggregateError && err.errors.length) return [...new Set(err.errors.map((e) => errorText(e)))].join('; ');
  const e = err as { message?: string; code?: string };
  return e?.message || e?.code || String(err);
};

/** Identifier-safe per-sandbox name for databases, users and prefixes. */
export const sandboxDbName = (sandboxId: string) => sandboxId.toLowerCase().replace(/[^a-z0-9_]/g, '_');

const envKey = (serviceId: string) => serviceId.toUpperCase().replace(/[^A-Z0-9]/g, '_');
const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * Shared services (databases, mocks): runs managed containers or connects to external servers, gives every
 * attached sandbox its own database/user and hands the connection to agents (env vars + instruction files).
 */
export class ServiceManager {
  private readonly runtime = new Map<string, Runtime>();
  private readonly starting = new Map<string, Promise<void>>();
  /** Since when a running managed service has had no running sandbox using it. */
  private readonly idleSince = new Map<string, number>();
  private idleTimer?: NodeJS.Timeout;
  private readonly docker?: DockerDriver;

  constructor(
    driver: SandboxDriver,
    private readonly store: Store,
    private readonly bus: EventBus,
    private readonly sandboxes: SandboxManager,
    private readonly egress: EgressManager,
    private readonly log: (msg: string, err?: unknown) => void,
  ) {
    this.docker = driver instanceof DockerDriver ? driver : undefined;
    egress.setRelaySource(() => this.relays());
    sandboxes.addHooks({
      created: (record, requested) => this.onSandboxCreated(record, requested),
      started: (record) => this.wake(record),
      deleting: (record) => this.onSandboxDeleting(record),
    });
  }

  /** Brings managed services up after a server start. */
  async start(): Promise<void> {
    for (const record of this.store.services()) {
      if (record.mode === 'external') void this.check(record.id);
      // Paused services stay paused until a sandbox needs them.
      else if (record.desired !== 'stopped' && (!this.autoStops(record) || this.inUse(record.id))) void this.ensureRunning(record.id).catch(() => undefined);
      else void this.refreshContainerState(record);
    }
    this.idleTimer = setInterval(() => void this.checkIdle().catch((err) => this.log('services: idle check failed', err)), IDLE_CHECK_MS);
    this.idleTimer.unref();
  }

  /**
   * Pauses managed services no running sandbox has used for SERVICE_IDLE_MINUTES, and wakes paused services
   * that a running sandbox needs (e.g. a sandbox started from the terminal).
   */
  private async checkIdle(): Promise<void> {
    for (const record of this.store.services()) {
      if (record.mode !== 'managed' || record.desired === 'stopped') continue;
      const status = this.runtime.get(record.id)?.status;
      if (this.inUse(record.id)) {
        this.idleSince.delete(record.id);
        if (status === 'idle') void this.ensureRunning(record.id).catch((err) => this.log(`service ${record.id}: wake failed`, err));
        continue;
      }
      if (status !== 'running' || !this.autoStops(record) || this.starting.has(record.id)) continue;
      const since = this.idleSince.get(record.id) ?? Date.now();
      this.idleSince.set(record.id, since);
      if (Date.now() - since < IDLE_MS) continue;
      await this.pause(record);
    }
  }

  private async pause(record: ServiceRecord): Promise<void> {
    if (!this.docker) return;
    await ignoreStatus(304, () => this.docker!.docker.getContainer(this.containerName(record.id)).stop({ t: 10 })).catch((err) => {
      if (statusOf(err) !== 404) throw err;
    });
    this.idleSince.delete(record.id);
    this.setRuntime(record, { status: 'idle', hostPorts: {}, error: undefined });
  }

  /** Starts the paused services of a sandbox that was started again (in the background). */
  private async wake(sandbox: SandboxRecord): Promise<void> {
    for (const serviceId of sandbox.services ?? []) {
      const record = this.store.service(serviceId);
      if (record?.mode === 'managed' && record.desired !== 'stopped') void this.ensureRunning(serviceId).catch((err) => this.log(`service ${serviceId}: wake failed`, err));
    }
  }

  private autoStops(record: ServiceRecord): boolean {
    return record.mode === 'managed' && record.autoStop !== false;
  }

  /** Whether a running (or starting) sandbox has this service attached. */
  private inUse(serviceId: string): boolean {
    return this.store.sandboxes().some((s) => (s.status === 'running' || s.status === 'creating') && s.services?.includes(serviceId));
  }

  list(): ServiceInfo[] {
    return this.store.services().map((r) => this.info(r));
  }

  async add(input: MethodParams<'services.add'>): Promise<ServiceInfo> {
    const params = { ...input, mode: input.mode ?? 'managed', attach: input.attach ?? 'all', attachExisting: input.attachExisting ?? true };
    const kind = SERVICE_KINDS[params.kind];
    if (params.mode === 'managed' && !this.docker) throw new CocoonError('bad_request', t('error.serviceNeedsContainers'));
    if (params.mode === 'external' && kind.category === 'mock') throw new CocoonError('bad_request', t('error.serviceMockManagedOnly'));
    if (params.mode === 'external' && !params.host) throw new CocoonError('bad_request', t('error.serviceHostRequired'));
    const id = params.id ?? this.freeId(params.kind);
    if (this.store.service(id)) throw new CocoonError('conflict', t('error.serviceIdTaken', { id }));
    if (params.image && !kind.images.some((i) => i.ref === params.image) && !/^[\w./:@-]+$/.test(params.image)) {
      throw new CocoonError('bad_request', t('error.invalidImage', { image: params.image }));
    }
    const record: ServiceRecord = {
      id,
      kind: params.kind,
      label: params.label,
      mode: params.mode,
      attach: params.attach,
      autoStop: params.mode === 'managed' ? (params.autoStop ?? true) : undefined,
      createdAt: new Date().toISOString(),
      ...(params.mode === 'managed'
        ? { image: params.image ?? kind.images[0]!.ref, memoryMb: params.memoryMb, adminPassword: randomBytes(18).toString('hex'), desired: 'running' as const }
        : {
            host: params.host,
            port: params.port ?? kind.port,
            adminUser: params.adminUser ?? kind.defaultAdminUser,
            adminPassword: params.adminPassword,
            tls: params.tls,
            relayPort: this.freeRelayPort(),
          }),
    };
    this.store.putService(record);
    this.egress.writePolicy();
    this.publish(record);

    if (record.mode === 'external') {
      const result = await this.check(id);
      if (!result.ok) {
        this.store.deleteService(id);
        this.runtime.delete(id);
        this.egress.writePolicy();
        this.bus.publish({ type: 'service.removed', serviceId: id });
        throw new CocoonError('bad_request', t('error.serviceConnectFailed', { error: result.error ?? '' }));
      }
    }
    // Managed: pull + start in the background (progress via service.updated), then attach to existing sandboxes.
    void (async () => {
      try {
        await this.ensureRunning(id);
        if (record.attach === 'all' && params.attachExisting) await this.attachToAll(id);
      } catch (err) {
        this.log(`service ${id}: ${(err as Error).message}`);
      }
    })();
    return this.info(record);
  }

  async update(params: MethodParams<'services.update'>): Promise<ServiceInfo> {
    const record = this.record(params.serviceId);
    if (params.label !== undefined) record.label = params.label ?? undefined;
    if (params.attach) record.attach = params.attach;
    if (params.autoStop !== undefined && record.mode === 'managed') record.autoStop = params.autoStop;
    if (record.mode === 'external') {
      if (params.host !== undefined) record.host = params.host;
      if (params.port !== undefined) record.port = params.port;
      if (params.adminUser !== undefined) record.adminUser = params.adminUser || undefined;
      if (params.adminPassword !== undefined) record.adminPassword = params.adminPassword || undefined;
      if (params.tls !== undefined) record.tls = params.tls;
    }
    this.store.putService(record);
    this.egress.writePolicy();
    if (record.mode === 'external') await this.check(record.id);
    this.publish(record);
    return this.info(record);
  }

  async remove(serviceId: string, deleteData: boolean): Promise<void> {
    const record = this.record(serviceId);
    // Best effort: drop the sandbox databases first (needs the service to be reachable).
    for (const sandbox of this.attachedSandboxes(serviceId)) {
      await this.detach(sandbox.id, serviceId).catch((err) => this.log(`service ${serviceId}: detach ${sandbox.id} failed`, err));
    }
    if (record.mode === 'managed' && this.docker) {
      await ignoreStatus(404, () => this.docker!.docker.getContainer(this.containerName(serviceId)).remove({ force: true }));
      if (deleteData) await ignoreStatus(404, () => this.docker!.docker.getVolume(this.volumeName(serviceId)).remove());
    }
    this.store.deleteService(serviceId);
    this.runtime.delete(serviceId);
    this.egress.writePolicy();
    this.bus.publish({ type: 'service.removed', serviceId });
  }

  async startService(serviceId: string): Promise<ServiceInfo> {
    const record = this.record(serviceId);
    if (record.mode === 'managed') {
      record.desired = 'running';
      this.store.putService(record);
      await this.ensureRunning(serviceId);
    } else await this.check(serviceId);
    return this.info(this.record(serviceId));
  }

  async stopService(serviceId: string): Promise<ServiceInfo> {
    const record = this.record(serviceId);
    if (record.mode !== 'managed' || !this.docker) throw new CocoonError('bad_request', t('error.serviceNotManaged'));
    record.desired = 'stopped';
    this.store.putService(record);
    await ignoreStatus(304, () => this.docker!.docker.getContainer(this.containerName(serviceId)).stop({ t: 10 })).catch((err) => {
      if (statusOf(err) !== 404) throw err;
    });
    this.setRuntime(record, { status: 'stopped', error: undefined });
    return this.info(record);
  }

  /** Checks the admin connection and updates the status. */
  async check(serviceId: string): Promise<{ ok: boolean; version?: string; error?: string }> {
    const record = this.record(serviceId);
    try {
      const version = await ENGINES[record.kind].test(this.adminConn(record));
      this.setRuntime(record, { status: 'running', version, error: undefined });
      return { ok: true, version };
    } catch (err) {
      const error = errorText(err);
      this.setRuntime(record, { status: record.mode === 'managed' && this.runtime.get(serviceId)?.status === 'stopped' ? 'stopped' : 'error', error });
      return { ok: false, error };
    }
  }

  credentials(serviceId: string): ServiceAdminCredentials {
    const record = this.record(serviceId);
    const admin = this.adminConn(record);
    const kind = SERVICE_KINDS[record.kind];
    const auth = admin.user || admin.password ? `${encodeURIComponent(admin.user ?? '')}:${encodeURIComponent(admin.password ?? '')}@` : '';
    const scheme = { postgres: 'postgresql', mysql: 'mysql', mongodb: 'mongodb', redis: 'redis', wiremock: 'http', mailpit: 'smtp' }[record.kind];
    const suffix = record.kind === 'mongodb' ? '/?authSource=admin' : record.kind === 'wiremock' ? '/__admin' : '';
    return {
      host: admin.host,
      port: admin.port,
      user: kind.externalAuth ? admin.user : undefined,
      password: kind.externalAuth ? admin.password : undefined,
      url: `${scheme}://${kind.externalAuth ? auth : ''}${admin.host}:${admin.port}${suffix}`,
    };
  }

  // ── per sandbox ──────────────────────────────────────────────────────────────

  connections(sandboxId: string): ServiceConnection[] {
    const sandbox = this.sandboxes.record(sandboxId);
    return (sandbox.services ?? []).flatMap((serviceId) => {
      const record = this.store.service(serviceId);
      const db = sandbox.serviceDbs?.[serviceId];
      if (!record || !db) return [];
      return [this.connection(record, sandbox, db)];
    });
  }

  async attach(sandboxId: string, serviceId: string): Promise<ServiceConnection> {
    const record = this.record(serviceId);
    let sandbox = this.sandboxes.record(sandboxId);
    if (sandbox.network === 'none') throw new CocoonError('bad_request', t('error.serviceNoNetwork'));
    await this.ensureRunning(serviceId);
    if (this.docker && sandbox.handle && sandbox.network === 'open') await this.docker.connectInternal(sandbox.handle);

    const db: SandboxServiceDb = sandbox.serviceDbs?.[serviceId] ?? { name: sandboxDbName(sandbox.id), password: randomBytes(16).toString('hex') };
    try {
      await ENGINES[record.kind].provision(this.adminConn(record), db.name, db.password);
      delete db.error;
    } catch (err) {
      db.error = errorText(err);
    }
    sandbox = this.sandboxes.record(sandboxId);
    this.sandboxes.update(sandboxId, {
      services: [...new Set([...(sandbox.services ?? []), serviceId])],
      serviceDbs: { ...sandbox.serviceDbs, [serviceId]: db },
    });
    this.publish(record);
    if (db.error) throw new CocoonError('internal', t('error.serviceProvisionFailed', { service: this.label(record), error: db.error }));
    await this.writeSandboxFiles(sandboxId).catch((err) => this.log(`services: writing env into ${sandboxId} failed`, err));
    return this.connection(record, this.sandboxes.record(sandboxId), db);
  }

  async detach(sandboxId: string, serviceId: string): Promise<void> {
    const sandbox = this.sandboxes.record(sandboxId);
    const record = this.store.service(serviceId);
    const db = sandbox.serviceDbs?.[serviceId];
    if (record && db) {
      if (record.desired !== 'stopped') await this.ensureRunning(serviceId).catch(() => undefined); // a paused service is woken for the cleanup
      await Promise.resolve().then(() => ENGINES[record.kind].deprovision(this.adminConn(record), db.name)).catch((err) => this.log(`service ${serviceId}: cleanup for ${sandboxId} failed`, err));
    }
    const { [serviceId]: _removed, ...rest } = sandbox.serviceDbs ?? {};
    this.sandboxes.update(sandboxId, { services: (sandbox.services ?? []).filter((id) => id !== serviceId), serviceDbs: rest });
    if (record) this.publish(record);
    await this.writeSandboxFiles(sandboxId).catch(() => undefined);
  }

  async reset(sandboxId: string, serviceId: string): Promise<ServiceConnection> {
    const record = this.record(serviceId);
    const sandbox = this.sandboxes.record(sandboxId);
    const db = sandbox.serviceDbs?.[serviceId];
    if (!db) throw new CocoonError('bad_request', t('error.serviceNotAttached', { service: this.label(record) }));
    await this.ensureRunning(serviceId);
    await ENGINES[record.kind].reset(this.adminConn(record), db.name, db.password);
    return this.connection(record, sandbox, db);
  }

  /**
   * Env vars for an agent. Retries provisioning for services that failed earlier (e.g. the service was still
   * starting when the sandbox was created) and refreshes the env file + agent instructions in the sandbox.
   */
  async agentEnv(sandboxId: string): Promise<Record<string, string>> {
    const sandbox = this.sandboxes.record(sandboxId);
    if (!sandbox.services?.length) return {};
    for (const serviceId of sandbox.services) {
      if (!this.store.service(serviceId)) continue;
      const db = sandbox.serviceDbs?.[serviceId];
      // Paused services are started before the agent so it finds them ready.
      if (db && !db.error) await this.ensureRunning(serviceId).catch((err) => this.log(`service ${serviceId}: start failed`, err));
      else await this.attach(sandboxId, serviceId).catch((err) => this.log(`services: attach ${serviceId} to ${sandboxId} failed`, err));
    }
    await this.writeSandboxFiles(sandboxId).catch((err) => this.log(`services: writing env into ${sandboxId} failed`, err));
    return this.envFor(this.sandboxes.record(sandboxId));
  }

  // ── internals ────────────────────────────────────────────────────────────────

  private async onSandboxCreated(record: SandboxRecord, requested: string[] | undefined): Promise<void> {
    if (record.network === 'none') return;
    const ids = (requested ?? this.store.services().filter((s) => s.attach === 'all').map((s) => s.id)).filter((id) => this.store.service(id));
    for (const serviceId of ids) {
      await this.attach(record.id, serviceId).catch((err) => {
        // Remember the selection; agentEnv() retries.
        const current = this.sandboxes.record(record.id);
        const db = current.serviceDbs?.[serviceId] ?? { name: sandboxDbName(record.id), password: randomBytes(16).toString('hex') };
        db.error = (err as Error).message;
        this.sandboxes.update(record.id, {
          services: [...new Set([...(current.services ?? []), serviceId])],
          serviceDbs: { ...current.serviceDbs, [serviceId]: db },
        });
      });
    }
  }

  private async onSandboxDeleting(record: SandboxRecord): Promise<void> {
    for (const serviceId of record.services ?? []) {
      const service = this.store.service(serviceId);
      const db = record.serviceDbs?.[serviceId];
      if (!service || !db) continue;
      if (service.desired !== 'stopped') await this.ensureRunning(serviceId).catch(() => undefined); // a paused service is woken for the cleanup
      await Promise.resolve().then(() => ENGINES[service.kind].deprovision(this.adminConn(service), db.name)).catch((err) => this.log(`service ${serviceId}: cleanup for ${record.id} failed`, err));
      this.publish(service, record.id);
    }
  }

  private async attachToAll(serviceId: string): Promise<void> {
    for (const sandbox of this.store.sandboxes()) {
      if (sandbox.network === 'none' || sandbox.status === 'error' || sandbox.services?.includes(serviceId)) continue;
      await this.attach(sandbox.id, serviceId).catch((err) => this.log(`service ${serviceId}: attach to ${sandbox.id} failed`, err));
    }
  }

  /** Starts a managed service (pulling its image if needed) and waits until it accepts connections. */
  private ensureRunning(serviceId: string): Promise<void> {
    const record = this.record(serviceId);
    if (record.mode === 'external') {
      return this.check(serviceId).then((r) => {
        if (!r.ok) throw new CocoonError('internal', t('error.serviceUnavailable', { service: this.label(record), error: r.error ?? '' }));
      });
    }
    if (this.runtime.get(serviceId)?.status === 'running') return Promise.resolve();
    let pending = this.starting.get(serviceId);
    if (!pending) {
      pending = this.startContainer(record).finally(() => this.starting.delete(serviceId));
      this.starting.set(serviceId, pending);
    }
    return pending;
  }

  private async startContainer(record: ServiceRecord): Promise<void> {
    if (!this.docker) {
      this.setRuntime(record, { status: 'unsupported', error: t('error.serviceNeedsContainers') });
      throw new CocoonError('bad_request', t('error.serviceNeedsContainers'));
    }
    const docker = this.docker.docker;
    const engine = ENGINES[record.kind];
    const spec = engine.container(record.adminPassword ?? '');
    const name = this.containerName(record.id);
    try {
      let container = docker.getContainer(name);
      let exists = true;
      try {
        await container.inspect();
      } catch (err) {
        if (statusOf(err) !== 404) throw err;
        exists = false;
      }
      if (!exists) {
        const image = record.image ?? SERVICE_KINDS[record.kind].images[0]!.ref;
        if (!(await this.docker.imageDetails(image))) {
          this.setRuntime(record, { status: 'pulling', error: undefined });
          await this.docker.pullImage(image);
        }
        this.setRuntime(record, { status: 'starting', error: undefined });
        const portKey = (p: number) => `${p}/tcp`;
        container = await docker.createContainer({
          name,
          Image: image,
          Env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
          Cmd: spec.cmd,
          Labels: { 'cocoon.managed': 'true', 'cocoon.service': record.id },
          ExposedPorts: Object.fromEntries(spec.ports.map((p) => [portKey(p), {}])),
          HostConfig: {
            NetworkMode: 'bridge',
            // Only the CoCoon server (and database tools on it) reach the service from outside its networks.
            PortBindings: Object.fromEntries(spec.ports.map((p) => [portKey(p), [{ HostIp: '127.0.0.1', HostPort: '' }]])),
            Mounts: [{ Type: 'volume', Source: this.volumeName(record.id), Target: spec.dataPath }],
            Memory: (record.memoryMb ?? 1024) * 1024 * 1024,
            RestartPolicy: { Name: 'unless-stopped' },
            SecurityOpt: ['no-new-privileges'],
          },
        });
        // Sandboxes reach the service by its id on the internal network.
        await docker.getNetwork(INTERNAL_NETWORK).connect({ Container: container.id, EndpointConfig: { Aliases: [record.id] } });
      } else this.setRuntime(record, { status: 'starting', error: undefined });
      await ignoreStatus(304, () => container.start());
      await this.refreshContainerState(record);

      const deadline = Date.now() + READY_TIMEOUT_MS;
      let lastError = '';
      while (Date.now() < deadline) {
        try {
          // Docker may report the published ports only a moment after the start.
          if (!this.runtime.get(record.id)?.hostPorts[SERVICE_KINDS[record.kind].port]) await this.refreshContainerState(record);
          const version = await engine.test(this.adminConn(record));
          this.setRuntime(record, { status: 'running', version, error: undefined });
          return;
        } catch (err) {
          lastError = errorText(err);
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
      }
      throw new Error(t('error.serviceNotReady', { error: lastError }));
    } catch (err) {
      this.setRuntime(record, { status: 'error', error: (err as Error).message });
      throw err;
    }
  }

  private async refreshContainerState(record: ServiceRecord): Promise<void> {
    if (!this.docker) return void this.setRuntime(record, { status: 'unsupported' });
    try {
      const info = await this.docker.docker.getContainer(this.containerName(record.id)).inspect();
      const hostPorts: Record<string, number> = {};
      for (const [key, bindings] of Object.entries(info.NetworkSettings.Ports ?? {})) {
        const hostPort = Number(bindings?.[0]?.HostPort);
        if (hostPort) hostPorts[key.split('/')[0]!] = hostPort;
      }
      const current = this.runtime.get(record.id);
      const stoppedStatus = record.desired !== 'stopped' && this.autoStops(record) ? 'idle' : 'stopped';
      this.setRuntime(record, { hostPorts, status: info.State.Running ? (current?.status === 'running' ? 'running' : 'starting') : stoppedStatus });
    } catch (err) {
      if (statusOf(err) !== 404) throw err;
      this.setRuntime(record, { status: record.desired !== 'stopped' && this.autoStops(record) ? 'idle' : 'stopped', hostPorts: {} });
    }
  }

  private adminConn(record: ServiceRecord): AdminConn {
    const kind = SERVICE_KINDS[record.kind];
    if (record.mode === 'external') {
      return { host: record.host ?? 'localhost', port: record.port ?? kind.port, user: record.adminUser, password: record.adminPassword, tls: record.tls };
    }
    const hostPorts = this.runtime.get(record.id)?.hostPorts ?? {};
    const port = hostPorts[kind.port];
    // Never fall back to the default port: that could hit an unrelated server on the host.
    if (!port) throw new CocoonError('conflict', t('error.serviceUnavailable', { service: this.label(record), error: 'no published port' }));
    const ports = Object.fromEntries(Object.entries(hostPorts).map(([k, v]) => [Number(k), v]));
    return { host: '127.0.0.1', port, user: kind.defaultAdminUser, password: record.adminPassword, ports };
  }

  /** Address of a service as seen from inside a sandbox. */
  private sandboxAddress(record: ServiceRecord): { host: string; port: number; ports?: Record<number, number> } {
    const kind = SERVICE_KINDS[record.kind];
    if (record.mode === 'managed') return { host: record.id, port: kind.port };
    // bubblewrap shares the host network; container sandboxes go through the proxy relay.
    if (!this.docker || !record.relayPort) return { host: record.host ?? 'localhost', port: record.port ?? kind.port };
    return { host: PROXY_HOST, port: record.relayPort };
  }

  private connection(record: ServiceRecord, sandbox: SandboxRecord, db: SandboxServiceDb): ServiceConnection {
    const conn = this.sandboxConn(record, db);
    const built = ENGINES[record.kind].connection(conn);
    return {
      serviceId: record.id,
      kind: record.kind,
      label: this.label(record),
      host: conn.host,
      port: conn.port,
      database: built.database,
      user: built.user,
      password: SERVICE_KINDS[record.kind].isolation === 'database' ? db.password : undefined,
      url: built.url,
      env: this.envFor(sandbox, record.id),
      error: db.error,
    };
  }

  private sandboxConn(record: ServiceRecord, db: SandboxServiceDb): SandboxConn {
    const address = this.sandboxAddress(record);
    return { ...address, name: db.name, password: db.password, tls: record.tls };
  }

  /**
   * Env vars of all (or one) attached services. The first service of each kind gets the standard names
   * (DATABASE_URL, MONGODB_URI, …); every service also gets COCOON_<ID>_URL.
   */
  private envFor(sandbox: SandboxRecord, only?: string): Record<string, string> {
    const env: Record<string, string> = {};
    const seenKinds = new Set<ServiceKind>();
    let databaseUrlTaken = false;
    const hosts = new Set<string>();
    const ids = sandbox.services ?? [];
    const ordered = [...ids].sort((a, b) => Number(this.store.service(b)?.kind === 'postgres') - Number(this.store.service(a)?.kind === 'postgres'));
    for (const serviceId of ordered) {
      const record = this.store.service(serviceId);
      const db = sandbox.serviceDbs?.[serviceId];
      if (!record || !db || db.error) continue;
      const built = ENGINES[record.kind].connection(this.sandboxConn(record, db));
      const first = !seenKinds.has(record.kind);
      seenKinds.add(record.kind);
      const claimsDatabaseUrl = !databaseUrlTaken && (record.kind === 'postgres' || record.kind === 'mysql');
      if (claimsDatabaseUrl) databaseUrlTaken = true;
      if (only && only !== serviceId) continue;
      if (first) Object.assign(env, built.env);
      env[`COCOON_${envKey(serviceId)}_URL`] = built.url;
      if (claimsDatabaseUrl) env.DATABASE_URL = built.url;
      hosts.add(this.sandboxAddress(record).host);
    }
    // "Restricted" sandboxes send HTTP through the egress proxy, which would block the service hosts.
    if (!only && hosts.size && sandbox.network === 'egress') env.NO_PROXY = env.no_proxy = this.egress.noProxy(sandbox, [...hosts]);
    return env;
  }

  /** Writes /opt/cocoon/services.env (sourced by shells) and the agent instruction files into a running sandbox. */
  private async writeSandboxFiles(sandboxId: string): Promise<void> {
    const sandbox = this.sandboxes.record(sandboxId);
    if (sandbox.status !== 'running') return;
    const env = this.envFor(sandbox);
    const envFile = Object.entries(env).map(([k, v]) => `export ${k}=${shellQuote(v)}\n`).join('');
    // /opt/cocoon belongs to root; the file only holds this sandbox's own throwaway credentials.
    const res = await this.sandboxes.exec(sandboxId, ['sh', '-c', `printf '%s' "$CONTENT" > ${SERVICES_ENV_FILE} && chmod 644 ${SERVICES_ENV_FILE}`], {
      env: { CONTENT: envFile },
      user: 'root',
    });
    if (res.exitCode !== 0) throw new Error(res.stderr.trim());

    const notes = this.instructions(sandbox);
    const script = `
      line='[ -f ${SERVICES_ENV_FILE} ] && . ${SERVICES_ENV_FILE}'
      for rc in "$HOME/.bashrc" "$HOME/.profile"; do grep -qF "$line" "$rc" 2>/dev/null || printf '\\n%s\\n' "$line" >> "$rc"; done
      ${agentNotesScript('services')}`;
    await this.sandboxes.sh(sandboxId, script, { NOTES: notes });
  }

  private instructions(sandbox: SandboxRecord): string {
    const lines: string[] = [];
    const seenKinds = new Set<ServiceKind>();
    for (const serviceId of sandbox.services ?? []) {
      const record = this.store.service(serviceId);
      const db = sandbox.serviceDbs?.[serviceId];
      if (!record || !db || db.error) continue;
      const first = !seenKinds.has(record.kind);
      seenKinds.add(record.kind);
      const mainEnv = first ? SERVICE_KINDS[record.kind].env[0]! : `COCOON_${envKey(serviceId)}_URL`;
      lines.push(ENGINES[record.kind].instructions(this.sandboxConn(record, db), mainEnv));
    }
    if (!lines.length) return '';
    return [
      '## Shared test services (provided by CoCoon)',
      '',
      `These services run outside this sandbox and are meant for development and tests. Credentials are in the environment (also in \`${SERVICES_ENV_FILE}\`).`,
      '',
      ...lines,
      ...(['postgres', 'mysql', 'redis'] as const).some((kind) => seenKinds.has(kind))
        ? ['', 'If `psql`, `mysql` or `redis-cli` are missing, the sandbox runs the slim image (database clients come with the `db` and `full` variants): connect with a client library of the project’s language instead.']
        : [],
      '',
      'Never print or commit these credentials. To start over with an empty database, drop your own objects (or ask the user to reset it in CoCoon).',
    ].join('\n');
  }

  private relays(): Relay[] {
    if (!this.docker) return [];
    return this.store
      .services()
      .filter((r) => r.mode === 'external' && r.relayPort)
      .map((r) => ({ listen: r.relayPort!, host: this.egress.reachableHost(r.host ?? 'localhost'), port: r.port ?? SERVICE_KINDS[r.kind].port }));
  }

  private info(record: ServiceRecord): ServiceInfo {
    const rt = this.runtime.get(record.id);
    const { adminPassword, desired: _d, relayPort: _r, ...service } = record;
    const webPort = record.kind === 'mailpit' ? rt?.hostPorts['8025'] : undefined;
    return {
      ...service,
      status: rt?.status ?? (record.mode === 'managed' && !this.docker ? 'unsupported' : 'starting'),
      error: rt?.error,
      version: rt?.version,
      hasAdminPassword: Boolean(adminPassword),
      hostPorts: rt?.hostPorts ?? {},
      webUrl: webPort ? `http://127.0.0.1:${webPort}` : undefined,
      sandboxes: this.attachedSandboxes(record.id).map((s) => s.id),
    };
  }

  private attachedSandboxes(serviceId: string): SandboxRecord[] {
    return this.store.sandboxes().filter((s) => s.services?.includes(serviceId));
  }

  private setRuntime(record: ServiceRecord, patch: Partial<Runtime>): void {
    const current = this.runtime.get(record.id) ?? { status: 'starting' as ServiceStatus, hostPorts: {} };
    const next = { ...current, ...patch };
    for (const key of Object.keys(patch) as (keyof Runtime)[]) if (patch[key] === undefined) delete next[key];
    next.hostPorts ??= {};
    this.runtime.set(record.id, next);
    if (this.store.service(record.id)) this.publish(record);
  }

  private publish(record: ServiceRecord, excludeSandbox?: string): void {
    const info = this.info(record);
    if (excludeSandbox) info.sandboxes = info.sandboxes.filter((id) => id !== excludeSandbox);
    this.bus.publish({ type: 'service.updated', service: info });
  }

  private record(id: string): ServiceRecord {
    const record = this.store.service(id);
    if (!record) throw notFound('Service', id);
    return record;
  }

  private label(record: ServiceRecord): string {
    return record.label || SERVICE_KINDS[record.kind].label;
  }

  private freeId(kind: ServiceKind): string {
    if (!this.store.service(kind)) return kind;
    for (let n = 2; ; n++) if (!this.store.service(`${kind}-${n}`)) return `${kind}-${n}`;
  }

  private freeRelayPort(): number {
    const used = new Set(this.store.services().map((s) => s.relayPort));
    let port = RELAY_BASE_PORT;
    while (used.has(port)) port++;
    return port;
  }

  private containerName(id: string): string {
    return `${CONTAINER_PREFIX}${id}`;
  }

  private volumeName(id: string): string {
    return `${CONTAINER_PREFIX}${id}-data`;
  }
}
