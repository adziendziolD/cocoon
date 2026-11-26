import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { Duplex, PassThrough, type Readable } from 'node:stream';
import {
  ApiException,
  AppsV1Api,
  CoreV1Api,
  Exec,
  KubeConfig,
  Log,
  NetworkingV1Api,
  NodeV1Api,
  VersionApi,
  type V1NetworkPolicy,
  type V1Pod,
  type V1PodSpec,
  type V1StatefulSet,
  type V1Status,
} from '@kubernetes/client-node';
import type { DriverCapabilities } from '@cocoon/protocol';
import { AGENT_UID, COCOON_DIR } from '../agents/tmux.ts';
import { CocoonError } from '../errors.ts';
import { t } from '../i18n.ts';
import { collect } from './docker.ts';
import {
  INSTALL_TOOLBOX_SCRIPT,
  parseNodeVersion,
  READ_TOOL_VERSIONS_JS,
  SANDBOX_PATH,
  TOOLBOX_NODE,
  TOOLBOX_PATH,
  type ExecOptions,
  type ExecResult,
  type ImageDetails,
  type RuntimeState,
  type SandboxDriver,
  type SandboxSpec,
  type TtySession,
} from './driver.ts';

export const TOOLBOX_CLAIM = 'cocoon-agents';
/** Label of every sandbox pod: its network mode, which the network policies select on. */
export const NETWORK_LABEL = 'cocoon.dev/network';
const SANDBOX_LABEL = 'cocoon.dev/sandbox';
const MANAGED = { 'app.kubernetes.io/managed-by': 'cocoon' };
/** Home of the sandbox user in the sandbox image; kept on the sandbox's volume. */
const HOME = '/home/agent';
const CONTAINER = 'sandbox';
const NAMESPACE_FILE = '/var/run/secrets/kubernetes.io/serviceaccount/namespace';
/** Image pull, volume provisioning and attach all happen before a pod runs. */
const START_TIMEOUT_MS = 10 * 60_000;

export interface KubernetesOptions {
  /** Namespace the sandboxes live in (must exist; cocoond needs the rights of deploy/kubernetes/base/rbac.yaml there). */
  namespace: string;
  /** StorageClass of the sandbox volumes (ReadWriteOnce); unset = the cluster's default. */
  storageClass?: string;
  /** Size of a sandbox volume, e.g. "20Gi". */
  workspaceSize: string;
  /** StorageClass of the shared agent toolbox: must support ReadWriteMany; unset = the cluster's default. */
  toolboxStorageClass?: string;
  /** "key=value": sandboxes only run on nodes with this label, and tolerate a taint with the same key and value. */
  sandboxNodes?: string;
  /** Name of the Service in front of cocoond (in cocoond's namespace); sandboxes reach the egress proxy through it. */
  service: string;
  /** Labels of the cocoond pod: the only pods sandboxes may talk to, and that may talk to sandboxes. */
  controlLabels: Record<string, string>;
  /** Ports of the egress proxy in the cocoond pod (forward, credentials). */
  proxyPorts: number[];
  /** Image for the start-up check (has Node.js): the toolbox installer image. */
  probeImage: string;
}

const REQUIREMENTS =
  'CoCoon on Kubernetes needs: (1) cocoond running in the cluster with the rights of deploy/kubernetes/base/rbac.yaml, ' +
  '(2) a network plugin (CNI) that enforces NetworkPolicies, e.g. Calico or Cilium, on EKS the VPC CNI with enableNetworkPolicy, ' +
  '(3) a StorageClass with ReadWriteMany for the agent toolbox (COCOON_K8S_TOOLBOX_STORAGE_CLASS), ' +
  '(4) a StorageClass with ReadWriteOnce for the sandbox volumes (COCOON_K8S_STORAGE_CLASS or the default class). See docs/KUBERNETES.md.';

/** Kubernetes object name of a sandbox ("sb_1a2b" → "cocoon-sb-1a2b"). */
export const sandboxName = (sandboxId: string) => `cocoon-${sandboxId.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * Shell lines that set the environment and directory of an exec. They travel on stdin, not in the command: the command
 * of a Kubernetes exec is part of the request URL, which ends up in API server audit logs, and env values hold secrets.
 */
export function execPreamble(opts: Pick<ExecOptions, 'env' | 'workdir'>): string {
  const lines = Object.entries(opts.env ?? {}).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`invalid environment variable name "${key}"`);
    return `export ${key}=${quote(value)}`;
  });
  if (opts.workdir) lines.push(`cd ${quote(opts.workdir)}`);
  return lines.join('\n');
}

/** Reads the preamble (length line, then that many bytes) from stdin, then runs the command without stdin. */
const WITH_PREAMBLE = ['sh', '-c', 'IFS= read -r n && eval "$(head -c "$n")" && exec "$@" </dev/null', 'sh'];

function nodePlacement(sandboxNodes?: string): Pick<V1PodSpec, 'nodeSelector' | 'tolerations'> {
  if (!sandboxNodes) return {};
  const [key = '', value = ''] = sandboxNodes.split('=');
  return { nodeSelector: { [key]: value }, tolerations: [{ key, operator: 'Equal', value, effect: 'NoSchedule' }] };
}

/** What every pod in the sandbox namespace has: no API token, no root, no capabilities ("restricted" pod security). */
function hardened(opts: KubernetesOptions): Pick<V1PodSpec, 'automountServiceAccountToken' | 'enableServiceLinks' | 'securityContext' | 'nodeSelector' | 'tolerations'> {
  return {
    automountServiceAccountToken: false,
    enableServiceLinks: false,
    securityContext: {
      runAsUser: AGENT_UID,
      runAsGroup: AGENT_UID,
      runAsNonRoot: true,
      fsGroup: AGENT_UID,
      fsGroupChangePolicy: 'OnRootMismatch',
      seccompProfile: { type: 'RuntimeDefault' },
    },
    ...nodePlacement(opts.sandboxNodes),
  };
}

const CONTAINER_SECURITY = { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } };

/**
 * A sandbox is a StatefulSet with one pod and one volume. Stopping scales it to 0: the volume (workspace, home,
 * CoCoon's files) stays, everything else in the container file system is gone, unlike with Docker.
 */
export function sandboxStatefulSet(spec: SandboxSpec, opts: KubernetesOptions): V1StatefulSet {
  const name = sandboxName(spec.sandboxId);
  const labels = { ...MANAGED, [SANDBOX_LABEL]: spec.sandboxId, [NETWORK_LABEL]: spec.network };
  const { cpus, memoryMb } = spec.resources;
  const limits: Record<string, string> = {};
  if (cpus) limits.cpu = `${Math.round(cpus * 1000)}m`;
  if (memoryMb) limits.memory = `${memoryMb}Mi`;
  return {
    metadata: { name, labels, annotations: { 'cocoon.dev/name': spec.name } },
    spec: {
      replicas: 0,
      serviceName: name,
      selector: { matchLabels: { [SANDBOX_LABEL]: spec.sandboxId } },
      template: {
        metadata: { labels },
        spec: {
          ...hardened(opts),
          // The pause container is PID 1 and reaps what tmux and the agents leave behind (Docker: --init).
          shareProcessNamespace: true,
          terminationGracePeriodSeconds: 5,
          runtimeClassName: spec.runtime ?? undefined,
          initContainers: [
            {
              // Folders of the volume, and on first start the home directory of the image.
              name: 'volume',
              image: spec.image,
              imagePullPolicy: 'IfNotPresent',
              command: ['sh', '-c', `cd /data && mkdir -p workspace cocoon && { [ -d home ] || { mkdir home.new && { cp -a ${HOME}/. home.new/ 2>/dev/null || true; } && mv home.new home; }; }`],
              securityContext: CONTAINER_SECURITY,
              volumeMounts: [{ name: 'data', mountPath: '/data' }],
            },
          ],
          containers: [
            {
              name: CONTAINER,
              image: spec.image,
              imagePullPolicy: 'IfNotPresent',
              command: ['sleep', 'infinity'],
              workingDir: spec.workdir,
              env: Object.entries({ PATH: SANDBOX_PATH, ...spec.env }).map(([key, value]) => ({ name: key, value })),
              // Low requests: sandboxes idle most of the time, the limits are what counts.
              resources: { limits, requests: { cpu: '50m', memory: `${Math.min(memoryMb ?? 256, 256)}Mi` } },
              securityContext: CONTAINER_SECURITY,
              volumeMounts: [
                { name: 'data', mountPath: spec.workdir, subPath: 'workspace' },
                { name: 'data', mountPath: HOME, subPath: 'home' },
                { name: 'data', mountPath: COCOON_DIR, subPath: 'cocoon' },
                { name: 'tmp', mountPath: '/tmp' },
                ...(spec.toolbox ? [{ name: 'toolbox', mountPath: TOOLBOX_PATH, readOnly: true }] : []),
              ],
            },
          ],
          volumes: [
            { name: 'data', persistentVolumeClaim: { claimName: name } },
            // In memory like Docker's tmpfs: a full /tmp is "no space left", not an evicted pod.
            { name: 'tmp', emptyDir: { medium: 'Memory', sizeLimit: '512Mi' } },
            ...(spec.toolbox ? [{ name: 'toolbox', persistentVolumeClaim: { claimName: TOOLBOX_CLAIM, readOnly: true } }] : []),
          ],
        },
      },
    },
  };
}

/** Private, link-local and carrier-NAT ranges: the cluster, its nodes, the cloud metadata service. */
const INTERNAL_RANGES = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '100.64.0.0/10'];

/**
 * The network modes as NetworkPolicies on the sandbox namespace. A pod always has a network in Kubernetes, so "none"
 * is the default-deny policy and nothing else; all of this only holds with a network plugin that enforces policies.
 */
export function networkPolicies(opts: KubernetesOptions, controlNamespace: string): V1NetworkPolicy[] {
  const control = [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': controlNamespace } }, podSelector: { matchLabels: opts.controlLabels } }];
  const withNetwork = { matchExpressions: [{ key: NETWORK_LABEL, operator: 'In', values: ['egress', 'open'] }] };
  const policy = (name: string, spec: V1NetworkPolicy['spec']): V1NetworkPolicy => ({ metadata: { name, labels: MANAGED }, spec });
  return [
    policy('cocoon-default-deny', { podSelector: {}, policyTypes: ['Ingress', 'Egress'] }),
    // Previews: cocoond connects to servers in sandboxes.
    policy('cocoon-from-control', { podSelector: withNetwork, policyTypes: ['Ingress'], ingress: [{ _from: control }] }),
    policy('cocoon-to-proxy', {
      podSelector: withNetwork,
      policyTypes: ['Egress'],
      egress: [{ to: control, ports: opts.proxyPorts.map((port) => ({ protocol: 'TCP', port })) }],
    }),
    policy('cocoon-open', {
      podSelector: { matchLabels: { [NETWORK_LABEL]: 'open' } },
      policyTypes: ['Egress'],
      egress: [
        { to: [{ ipBlock: { cidr: '0.0.0.0/0', except: INTERNAL_RANGES } }] },
        {
          to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } }, podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } } }],
          ports: [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }],
        },
      ],
    }),
  ];
}

/** Exits 0 once a connection to the API server fails (policies are enforced), 1 if it keeps working. */
const PROBE_JS = `const net=require('net');let n=0;const go=()=>{const s=net.connect({host:process.argv[1],port:Number(process.argv[2])});s.setTimeout(2000);
s.on('connect',()=>{s.destroy();if(++n>=10)process.exit(1);setTimeout(go,1500)});s.on('timeout',()=>{s.destroy();process.exit(0)});s.on('error',()=>process.exit(0))};go()`;

const statusOf = (err: unknown) => (err instanceof ApiException ? err.code : undefined);

async function ignore(status: number, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (statusOf(err) !== status) throw err;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Why a pod is not running yet, in the words of Kubernetes (image pull errors, unschedulable, volume not bound). */
function pendingReason(pod: V1Pod | undefined): string {
  const statuses = [...(pod?.status?.initContainerStatuses ?? []), ...(pod?.status?.containerStatuses ?? [])];
  const waiting = statuses.map((s) => s.state?.waiting).find((w) => w && w.reason !== 'PodInitializing' && w.reason !== 'ContainerCreating');
  if (waiting) return [waiting.reason, waiting.message].filter(Boolean).join(': ');
  const condition = pod?.status?.conditions?.find((c) => c.status === 'False' && c.message);
  return condition ? `${condition.reason}: ${condition.message}` : `phase ${pod?.status?.phase ?? 'unknown'}`;
}

/**
 * Kubernetes: every sandbox is a pod with its own volume in one namespace, cocoond runs in the same cluster. The network
 * modes are NetworkPolicies, the egress proxy runs in the cocoond pod. Images come from a registry (nothing is built).
 */
export class KubernetesDriver implements SandboxDriver {
  readonly kind = 'kubernetes' as const;
  readonly name = 'kubernetes';
  readonly capabilities: DriverCapabilities = { images: true, resourceLimits: true, enforcedEgress: true, runtimes: true };
  /** Cluster IP of cocoond's Service (set by check()): where sandboxes find the egress proxy. */
  controlHost = '';
  private readonly config = new KubeConfig();
  private core!: CoreV1Api;
  private apps!: AppsV1Api;

  constructor(private readonly opts: KubernetesOptions) {}

  private get namespace(): string {
    return this.opts.namespace;
  }

  async check(): Promise<void> {
    const apiHost = process.env.KUBERNETES_SERVICE_HOST;
    if (!apiHost) throw new Error(`cocoond does not run in a Kubernetes cluster. ${REQUIREMENTS}`);
    this.config.loadFromCluster();
    this.core = this.config.makeApiClient(CoreV1Api);
    this.apps = this.config.makeApiClient(AppsV1Api);
    const controlNamespace = readFileSync(NAMESPACE_FILE, 'utf8').trim();
    try {
      this.controlHost = (await this.core.readNamespacedService({ name: this.opts.service, namespace: controlNamespace })).spec?.clusterIP ?? '';
      if (!this.controlHost || this.controlHost === 'None') throw new Error(`Service ${this.opts.service} has no cluster IP`);
      const net = this.config.makeApiClient(NetworkingV1Api);
      for (const body of networkPolicies(this.opts, controlNamespace)) {
        const name = body.metadata!.name!;
        await net.createNamespacedNetworkPolicy({ namespace: this.namespace, body }).catch(async (err) => {
          if (statusOf(err) !== 409) throw err;
          await net.replaceNamespacedNetworkPolicy({ name, namespace: this.namespace, body });
        });
      }
      await ignore(409, () =>
        this.core.createNamespacedPersistentVolumeClaim({
          namespace: this.namespace,
          body: {
            metadata: { name: TOOLBOX_CLAIM, labels: MANAGED },
            spec: { accessModes: ['ReadWriteMany'], storageClassName: this.opts.toolboxStorageClass, resources: { requests: { storage: '5Gi' } } },
          },
        }),
      );
      // Pods of an earlier run that was interrupted.
      await this.core.deleteCollectionNamespacedPod({ namespace: this.namespace, labelSelector: 'cocoon.dev/run' });
    } catch (err) {
      throw new Error(`${(err as Error).message.split('\n')[0]}. ${REQUIREMENTS}`);
    }
    // One pod checks both: it only starts if the toolbox volume could be provisioned, and it must not reach the API server.
    let code: number;
    try {
      code = await this.runPod(this.opts.probeImage, ['node', '-e', PROBE_JS, apiHost, process.env.KUBERNETES_SERVICE_PORT ?? '443'], { network: 'none', timeoutMs: 5 * 60_000 });
    } catch (err) {
      throw new Error(`the start-up check pod did not run (${(err as Error).message}). ${REQUIREMENTS}`);
    }
    if (code !== 0) {
      throw new Error(`NetworkPolicies are not enforced in this cluster: a sandbox without network reached the API server. Every sandbox could reach every pod. ${REQUIREMENTS}`);
    }
  }

  async info(): Promise<{ version?: string; runtimes: string[] }> {
    const version = await this.config.makeApiClient(VersionApi).getCode().catch(() => undefined);
    // Listing RuntimeClasses needs a cluster-wide right; without it no runtime is offered.
    const classes = await this.config.makeApiClient(NodeV1Api).listRuntimeClass().catch(() => undefined);
    return { version: version?.gitVersion, runtimes: (classes?.items ?? []).map((c) => c.metadata?.name ?? '').filter(Boolean) };
  }

  async create(spec: SandboxSpec): Promise<{ handle: string }> {
    const body = sandboxStatefulSet(spec, this.opts);
    const name = body.metadata!.name!;
    await this.core.createNamespacedPersistentVolumeClaim({
      namespace: this.namespace,
      body: {
        metadata: { name, labels: body.metadata!.labels },
        spec: { accessModes: ['ReadWriteOnce'], storageClassName: this.opts.storageClass, resources: { requests: { storage: this.opts.workspaceSize } } },
      },
    });
    await this.apps.createNamespacedStatefulSet({ namespace: this.namespace, body });
    return { handle: name };
  }

  async start(handle: string): Promise<void> {
    await this.scale(handle, 1);
    const deadline = Date.now() + START_TIMEOUT_MS;
    let pod: V1Pod | undefined;
    while (Date.now() < deadline) {
      pod = await this.pod(handle);
      if (pod?.status?.containerStatuses?.some((s) => s.name === CONTAINER && s.ready)) return;
      await sleep(1000);
    }
    throw new Error(`sandbox pod did not start: ${pendingReason(pod)}`);
  }

  async stop(handle: string): Promise<void> {
    await ignore(404, () => this.scale(handle, 0));
    // Wait until the pod is gone, so its volume is free for the next start.
    for (let i = 0; i < 240 && (await this.pod(handle)); i++) await sleep(250);
  }

  async remove(handle: string): Promise<void> {
    await ignore(404, () => this.apps.deleteNamespacedStatefulSet({ name: handle, namespace: this.namespace }));
    await ignore(404, () => this.core.deleteNamespacedPod({ name: `${handle}-0`, namespace: this.namespace, gracePeriodSeconds: 0 }));
    await ignore(404, () => this.core.deleteNamespacedPersistentVolumeClaim({ name: handle, namespace: this.namespace }));
  }

  async state(handle: string): Promise<RuntimeState> {
    try {
      const set = await this.apps.readNamespacedStatefulSet({ name: handle, namespace: this.namespace });
      if (!set.spec?.replicas) return 'stopped';
    } catch (err) {
      if (statusOf(err) === 404) return 'missing';
      throw err;
    }
    const pod = await this.pod(handle);
    return pod?.status?.containerStatuses?.some((s) => s.name === CONTAINER && s.ready) ? 'running' : 'stopped';
  }

  async address(handle: string): Promise<string | undefined> {
    return (await this.pod(handle))?.status?.podIP || undefined;
  }

  /** `opts.user` is ignored: a Kubernetes exec always runs as the container's user, and sandbox pods have no root. */
  async exec(handle: string, command: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    const stdout = collect();
    const stderr = collect();
    const preamble = execPreamble(opts);
    const { exited, close } = await this.run(handle, preamble ? [...WITH_PREAMBLE, ...command] : command, {
      stdout: stdout.sink,
      stderr: stderr.sink,
      stdin: preamble ? `${Buffer.byteLength(preamble)}\n${preamble}` : undefined,
    });
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      if (!opts.timeoutMs) return;
      timer = setTimeout(() => {
        close();
        reject(new CocoonError('timeout', t('error.timeout', { ms: opts.timeoutMs ?? 0 })));
      }, opts.timeoutMs);
    });
    try {
      const exitCode = await Promise.race([exited, timeout]);
      return { exitCode, stdout: stdout.text(), stderr: stderr.text() };
    } finally {
      clearTimeout(timer);
    }
  }

  async attachTty(handle: string, command: string[], size: { cols: number; rows: number }): Promise<TtySession> {
    // The client library reads the terminal size from the output stream and follows its "resize" events.
    const output = Object.assign(new PassThrough(), { columns: size.cols, rows: size.rows });
    const input = new PassThrough();
    const { close } = await this.run(handle, ['env', 'TERM=xterm-256color', ...command], { stdout: output, stdin: input, tty: true });
    // Node.js accepts its own streams here; the types only know web streams.
    const stream = Duplex.from({ writable: input, readable: output } as never);
    return {
      stream,
      resize: async (cols, rows) => {
        Object.assign(output, { columns: cols, rows });
        output.emit('resize');
      },
      close: () => {
        close();
        stream.destroy();
      },
    };
  }

  async putArchive(handle: string, dir: string, tar: Buffer): Promise<void> {
    const stderr = collect();
    const stdin = new PassThrough();
    const { exited } = await this.run(handle, ['sh', '-c', 'mkdir -p -- "$1" && exec tar -x -C "$1" --no-same-owner', 'sh', dir], { stderr: stderr.sink, stdin });
    stdin.end(tar);
    const code = await exited;
    if (code !== 0) throw new Error(`tar: ${stderr.text().trim() || `exit code ${code}`}`);
  }

  async getArchive(handle: string, path: string): Promise<Readable> {
    const probe = await this.exec(handle, ['test', '-e', path], { timeoutMs: 10_000 });
    if (probe.exitCode !== 0) throw new CocoonError('not_found', t('error.pathNotFound', { path }));
    const stderr = collect();
    const out = new PassThrough();
    const { exited, close } = await this.run(handle, ['tar', '-c', '-C', posix.dirname(path), posix.basename(path)], { stdout: out, stderr: stderr.sink, keepOpen: true });
    // An error instead of a clean end if tar fails: otherwise a truncated archive would look complete.
    void exited.then((code) => (code === 0 ? out.end() : out.destroy(new Error(`tar: ${stderr.text().trim() || `exit code ${code}`}`))));
    out.on('close', close);
    return out;
  }

  /** Installs Node.js and the agent CLIs into the toolbox volume, in a throwaway pod of the installer image. */
  async installTools(packages: string[], image: string, onOutput: (line: string) => void): Promise<void> {
    const code = await this.runPod(image, ['sh', '-c', INSTALL_TOOLBOX_SCRIPT, 'sh', ...packages], { network: 'open', writable: true, onOutput, timeoutMs: 30 * 60_000 });
    if (code !== 0) throw new Error(`npm install exited with ${code}`);
  }

  async toolVersions(image: string): Promise<Record<string, string>> {
    let output = '';
    const script = `${TOOLBOX_NODE}; exec "$N" -e "$1" "$2"`;
    const code = await this.runPod(image, ['sh', '-c', script, 'sh', READ_TOOL_VERSIONS_JS, `${TOOLBOX_PATH}/lib/node_modules`], { network: 'none', onOutput: (line) => (output += line) });
    if (code !== 0) throw new Error(`reading the toolbox versions exited with ${code}`);
    return JSON.parse(output) as Record<string, string>;
  }

  async toolboxRuntime(image: string): Promise<string | undefined> {
    let output = '';
    const code = await this.runPod(image, ['sh', '-c', `[ -x ${TOOLBOX_PATH}/bin/node ] && exec ${TOOLBOX_PATH}/bin/node --version`], { network: 'none', onOutput: (line) => (output += line) });
    return code === 0 ? parseNodeVersion(output) : undefined;
  }

  /** The nodes pull images themselves; whether an image exists only shows when a pod starts. */
  async imageDetails(): Promise<ImageDetails | undefined> {
    return {};
  }

  async buildImage(_contextDir: string, tag: string): Promise<void> {
    throw new Error(`Kubernetes cannot build images. Build ${tag} elsewhere, push it to a registry the cluster can pull from, and set that image in the settings.`);
  }

  async pullImage(): Promise<void> {
    // Done by the node when a pod starts.
  }

  async registryDigest(): Promise<string | undefined> {
    return undefined;
  }

  private async pod(handle: string): Promise<V1Pod | undefined> {
    try {
      return await this.core.readNamespacedPod({ name: `${handle}-0`, namespace: this.namespace });
    } catch (err) {
      if (statusOf(err) === 404) return undefined;
      throw err;
    }
  }

  private async scale(handle: string, replicas: number): Promise<void> {
    await this.apps.replaceNamespacedStatefulSetScale({ name: handle, namespace: this.namespace, body: { metadata: { name: handle, namespace: this.namespace }, spec: { replicas } } });
  }

  /** Runs a command in the sandbox container. `exited` resolves with the exit code (-1 if the connection broke). */
  private async run(
    handle: string,
    command: string[],
    io: { stdout?: PassThrough; stderr?: PassThrough; stdin?: PassThrough | string; tty?: boolean; keepOpen?: boolean },
  ): Promise<{ exited: Promise<number>; close: () => void }> {
    let stdin: PassThrough | null = null;
    if (typeof io.stdin === 'string') {
      // Never ended: with the older exec protocol, the end of stdin closes the whole connection.
      stdin = new PassThrough();
      stdin.write(io.stdin);
    } else if (io.stdin) stdin = io.stdin;
    let finish: (code: number) => void = () => undefined;
    const exited = new Promise<number>((resolve) => (finish = resolve));
    const socket = await new Exec(this.config).exec(this.namespace, `${handle}-0`, CONTAINER, command, io.stdout ?? null, io.stderr ?? null, stdin, io.tty ?? false, (status: V1Status) => {
      const cause = status.details?.causes?.find((c) => c.reason === 'ExitCode');
      finish(status.status === 'Success' ? 0 : cause ? Number(cause.message) : -1);
    });
    socket.on('close', () => finish(-1));
    socket.on('error', () => finish(-1));
    return { exited, close: () => socket.close() };
  }

  /**
   * Runs a command in a throwaway pod with the toolbox volume mounted, streams its output line by line and returns the
   * exit code. Throws if the pod does not get to run (image, volume, scheduling).
   */
  private async runPod(
    image: string,
    command: string[],
    opts: { network: 'none' | 'open'; writable?: boolean; onOutput?: (line: string) => void; timeoutMs?: number },
  ): Promise<number> {
    const created = await this.core.createNamespacedPod({
      namespace: this.namespace,
      body: {
        metadata: { generateName: 'cocoon-run-', labels: { ...MANAGED, 'cocoon.dev/run': 'true', [NETWORK_LABEL]: opts.network } },
        spec: {
          ...hardened(this.opts),
          restartPolicy: 'Never',
          terminationGracePeriodSeconds: 0,
          containers: [
            {
              name: 'run',
              image,
              imagePullPolicy: 'IfNotPresent',
              command,
              // npm wants a writable home.
              env: [{ name: 'HOME', value: '/tmp' }],
              securityContext: CONTAINER_SECURITY,
              volumeMounts: [{ name: 'toolbox', mountPath: TOOLBOX_PATH, readOnly: !opts.writable }, { name: 'tmp', mountPath: '/tmp' }],
            },
          ],
          volumes: [{ name: 'toolbox', persistentVolumeClaim: { claimName: TOOLBOX_CLAIM, readOnly: !opts.writable } }, { name: 'tmp', emptyDir: {} }],
        },
      },
    });
    const name = created.metadata!.name!;
    const read = () => this.core.readNamespacedPod({ name, namespace: this.namespace });
    try {
      const deadline = Date.now() + (opts.timeoutMs ?? START_TIMEOUT_MS);
      let pod = await read();
      while (!pod.status?.phase || pod.status.phase === 'Pending') {
        if (Date.now() > deadline) throw new Error(pendingReason(pod));
        await sleep(1000);
        pod = await read();
      }
      const lines = new PassThrough();
      let buffer = '';
      lines.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const parts = buffer.split('\n');
        buffer = parts.pop() ?? '';
        for (const line of parts) if (line.trim()) opts.onOutput?.(line);
      });
      const ended = new Promise((resolve) => lines.on('end', resolve).on('error', resolve));
      await new Log(this.config).log(this.namespace, name, 'run', lines, { follow: true });
      await ended;
      if (buffer.trim()) opts.onOutput?.(buffer);
      for (;;) {
        const exitCode = (await read()).status?.containerStatuses?.[0]?.state?.terminated?.exitCode;
        if (exitCode !== undefined) return exitCode;
        if (Date.now() > deadline) throw new Error('pod did not finish in time');
        await sleep(500);
      }
    } finally {
      await this.core.deleteNamespacedPod({ name, namespace: this.namespace, gracePeriodSeconds: 0 }).catch(() => undefined);
    }
  }
}
