import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EgressManager } from '../egress.ts';
import type { EventBus } from '../events.ts';
import { DockerDriver } from '../sandbox/docker.ts';
import type { SandboxManager } from '../sandbox/manager.ts';
import type { SandboxRecord, ServiceRecord, Store } from '../store.ts';
import { ENGINES } from './engines.ts';
import { ServiceManager } from './manager.ts';

// Network isolation of managed services: every service gets its own internal network that only the sandboxes with the
// service join, and mock services (WireMock, Mailpit) serve one workspace. Docker is faked: no containers are touched.

const SHARED = 'cocoon-internal';
const notFound = () => Object.assign(new Error('not found'), { statusCode: 404 });

function fakeDocker(legacy: string[] = []) {
  /** network → attached containers */
  const networks = new Map<string, Set<string>>([[SHARED, new Set(['sb-a-container', 'sb-b-container', 'sb-c-container'])]]);
  const containers = new Map<string, { running: boolean }>([
    ['sb-a-container', { running: true }],
    ['sb-b-container', { running: true }],
    ['sb-c-container', { running: true }],
  ]);
  const log: string[] = [];
  const created: any[] = [];
  const aliases = new Map<string, string[]>();
  for (const name of legacy) {
    containers.set(name, { running: true });
    networks.get(SHARED)!.add(name);
  }
  const nets = (container: string) => Object.fromEntries([...networks].filter(([, members]) => members.has(container)).map(([n]) => [n, { IPAddress: '10.0.0.2' }]));
  const container = (name: string) => ({
    id: name,
    inspect: async () => {
      if (!containers.has(name)) throw notFound();
      return { State: { Running: containers.get(name)!.running }, NetworkSettings: { Networks: nets(name), Ports: { '5432/tcp': [{ HostPort: '32771' }], '8080/tcp': [{ HostPort: '32768' }], '1025/tcp': [{ HostPort: '32769' }], '8025/tcp': [{ HostPort: '32770' }] } } };
    },
    start: async () => void (containers.get(name)!.running = true),
    remove: async () => void containers.delete(name),
  });
  const docker = {
    getNetwork: (name: string) => ({
      inspect: async () => {
        if (!networks.has(name)) throw notFound();
        return { Containers: Object.fromEntries([...networks.get(name)!].map((c) => [c, {}])) };
      },
      connect: async (opts: { Container: string; EndpointConfig?: { Aliases: string[] } }) => {
        networks.get(name)!.add(opts.Container);
        if (opts.EndpointConfig) aliases.set(`${name}/${opts.Container}`, opts.EndpointConfig.Aliases);
        log.push(`connect ${opts.Container} ${name}`);
      },
      disconnect: async (opts: { Container: string }) => {
        networks.get(name)!.delete(opts.Container);
        log.push(`disconnect ${opts.Container} ${name}`);
      },
      remove: async () => {
        networks.delete(name);
        log.push(`remove ${name}`);
      },
    }),
    createNetwork: async (opts: { Name: string; Internal: boolean }) => {
      expect(opts.Internal).toBe(true);
      networks.set(opts.Name, new Set());
      log.push(`create ${opts.Name}`);
    },
    getContainer: (name: string) => container(name),
    createContainer: async (opts: { name: string }) => {
      created.push(opts);
      containers.set(opts.name, { running: false });
      return container(opts.name);
    },
    getImage: () => ({ inspect: async () => ({ Created: '', Size: 1, Config: {}, RepoDigests: [] }) }),
    listImages: async () => [],
    getVolume: () => ({ remove: async () => undefined }),
  };
  const driver = new DockerDriver('docker');
  Object.defineProperty(driver, 'docker', { value: docker });
  return { driver, networks, log, created, aliases };
}

const sandbox = (id: string, workspaceId?: string, extra: Partial<SandboxRecord> = {}): SandboxRecord =>
  ({ id, handle: `${id}-container`, status: 'running', network: 'egress', proxyToken: 't', workspaceId, services: [], serviceDbs: {}, ...extra }) as SandboxRecord;

const mock = (id: string, kind: 'wiremock' | 'mailpit' = 'wiremock', extra: Partial<ServiceRecord> = {}): ServiceRecord =>
  ({ id, kind, mode: 'managed', attach: 'all', createdAt: '', adminPassword: 'admin', desired: 'running', autoStop: false, ...extra }) as ServiceRecord;

function setup(services: ServiceRecord[], sandboxes: SandboxRecord[], docker = fakeDocker()) {
  const svc = new Map(services.map((s) => [s.id, s]));
  const sbs = new Map(sandboxes.map((s) => [s.id, s]));
  const store = {
    services: () => [...svc.values()],
    service: (id: string) => svc.get(id),
    putService: (r: ServiceRecord) => svc.set(r.id, r),
    deleteService: (id: string) => svc.delete(id),
    retainedService: () => undefined,
    deleteRetainedService: () => undefined,
    putRetainedService: () => undefined,
    sandboxes: () => [...sbs.values()],
    workspace: () => ({}),
  } as unknown as Store;
  let hooks: any;
  const sandboxManager = {
    addHooks: (h: unknown) => (hooks = h),
    record: (id: string) => sbs.get(id)!,
    update: (id: string, patch: Partial<SandboxRecord>) => sbs.set(id, { ...sbs.get(id)!, ...patch }),
    exec: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
    sh: vi.fn(async () => ''),
  } as unknown as SandboxManager;
  const egress = { setRelaySource: vi.fn(), writePolicy: vi.fn(), noProxy: () => '' } as unknown as EgressManager;
  const log = vi.fn();
  const manager = new ServiceManager(docker.driver, store, { publish: vi.fn() } as unknown as EventBus, sandboxManager, egress, log);
  return { manager, docker, hooks: () => hooks, svc, sbs, log };
}

beforeEach(() => {
  vi.spyOn(ENGINES.wiremock, 'test').mockResolvedValue('WireMock');
  vi.spyOn(ENGINES.mailpit, 'test').mockResolvedValue('Mailpit');
});
afterEach(() => vi.restoreAllMocks());

describe('per-service networks', () => {
  it('puts a new service on its own network instead of the one all sandboxes share', async () => {
    const { manager, docker } = setup([mock('wiremock')], [sandbox('sb-a', 'ws1', { services: ['wiremock'] })]);
    await manager.startService('wiremock');
    expect(docker.log).toContain('create cocoon-svc-wiremock-net');
    expect(docker.networks.get('cocoon-svc-wiremock-net')).toContain('cocoon-svc-wiremock');
    expect(docker.networks.get(SHARED)).not.toContain('cocoon-svc-wiremock');
    expect(docker.aliases.get('cocoon-svc-wiremock-net/cocoon-svc-wiremock')).toEqual(['wiremock']);
    // Only the sandbox that has the service joins its network.
    expect([...docker.networks.get('cocoon-svc-wiremock-net')!].sort()).toEqual(['cocoon-svc-wiremock', 'sb-a-container']);
  });

  it('moves a service from before this change off the shared network, sandboxes first', async () => {
    const docker = fakeDocker(['cocoon-svc-wiremock']);
    const { manager } = setup([mock('wiremock')], [sandbox('sb-a', 'ws1', { services: ['wiremock'] })], docker);
    await manager.startService('wiremock');
    expect(docker.log).toEqual([
      'create cocoon-svc-wiremock-net',
      'connect cocoon-svc-wiremock cocoon-svc-wiremock-net',
      'connect sb-a-container cocoon-svc-wiremock-net',
      'disconnect cocoon-svc-wiremock cocoon-internal',
    ]);
    expect(docker.networks.get(SHARED)).not.toContain('cocoon-svc-wiremock');
    expect(docker.networks.get('cocoon-svc-wiremock-net')).toContain('sb-a-container');
  });

  it('connects a sandbox to the service network on attach and disconnects it on detach', async () => {
    const { manager, docker } = setup([mock('mails', 'mailpit')], [sandbox('sb-a', 'ws1'), sandbox('sb-b', 'ws1')]);
    await manager.startService('mails');
    await manager.attach('sb-a', 'mails');
    expect([...docker.networks.get('cocoon-svc-mails-net')!].sort()).toEqual(['cocoon-svc-mails', 'sb-a-container']);
    await manager.detach('sb-a', 'mails');
    expect([...docker.networks.get('cocoon-svc-mails-net')!]).toEqual(['cocoon-svc-mails']);
  });

  it('removes the network with the service', async () => {
    const { manager, docker } = setup([mock('wiremock')], [sandbox('sb-a', 'ws1')]);
    await manager.startService('wiremock');
    await manager.remove('wiremock', true);
    expect(docker.log).toContain('remove cocoon-svc-wiremock-net');
    expect(docker.networks.has('cocoon-svc-wiremock-net')).toBe(false);
  });
});

describe('mock services serve one workspace', () => {
  it('refuses a sandbox of another workspace once the first one has attached', async () => {
    const { manager, svc, docker } = setup([mock('wiremock')], [sandbox('sb-a', 'ws1'), sandbox('sb-b', 'ws2'), sandbox('sb-c', 'ws1')]);
    await manager.startService('wiremock');
    await manager.attach('sb-a', 'wiremock');
    expect(svc.get('wiremock')!.workspaceId).toBe('ws1');
    await expect(manager.attach('sb-b', 'wiremock')).rejects.toThrow(/anderen Workspace|another workspace/);
    await manager.attach('sb-c', 'wiremock');
    // The refused sandbox never joined the network of the service.
    expect([...docker.networks.get('cocoon-svc-wiremock-net')!].sort()).toEqual(['cocoon-svc-wiremock', 'sb-a-container', 'sb-c-container']);
  });

  it('does not attach another workspace automatically (new sandbox, or a service added later)', async () => {
    const owner = mock('wiremock', 'wiremock', { workspaceId: 'ws1' });
    const { manager, hooks, sbs } = setup([owner], [sandbox('sb-a', 'ws1'), sandbox('sb-b', 'ws2')]);
    await manager.startService('wiremock');
    await hooks().created(sbs.get('sb-b'), undefined);
    expect(sbs.get('sb-b')!.services).toEqual([]);
    await hooks().created(sbs.get('sb-a'), undefined);
    expect(sbs.get('sb-a')!.services).toEqual(['wiremock']);
  });

  it('takes no new workspace while a service from before this change is attached to others', async () => {
    const { manager } = setup([mock('mails', 'mailpit')], [sandbox('sb-a', 'ws1', { services: ['mails'] }), sandbox('sb-b', 'ws2', { services: ['mails'] }), sandbox('sb-c', 'ws3')]);
    await manager.startService('mails');
    await expect(manager.attach('sb-c', 'mails')).rejects.toThrow();
  });

  it('keeps databases open to every workspace (they isolate per sandbox user)', async () => {
    const postgres = { id: 'postgres', kind: 'postgres', mode: 'managed', attach: 'all', createdAt: '', adminPassword: 'x', desired: 'running' } as ServiceRecord;
    const { manager, svc } = setup([postgres], [sandbox('sb-a', 'ws1'), sandbox('sb-b', 'ws2')]);
    vi.spyOn(ENGINES.postgres, 'test').mockResolvedValue('PostgreSQL');
    vi.spyOn(ENGINES.postgres, 'provision').mockResolvedValue();
    await manager.startService('postgres');
    await manager.attach('sb-a', 'postgres');
    await manager.attach('sb-b', 'postgres');
    expect(svc.get('postgres')!.workspaceId).toBeUndefined();
  });

  it('a scope given when adding the service is kept', async () => {
    const { manager, svc } = setup([], []);
    await manager.add({ kind: 'wiremock', workspaceId: 'ws9', attach: 'manual', attachExisting: false, mode: 'managed' } as never);
    expect(svc.get('wiremock')!.workspaceId).toBe('ws9');
  });
});
