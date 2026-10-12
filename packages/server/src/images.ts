import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_TOOLS, type AgentTool, type ImageInfo, type ImageKind } from '@cocoon/protocol';
import type { Config } from './config.ts';
import { CocoonError } from './errors.ts';
import type { EventBus } from './events.ts';
import { newId } from './ids.ts';
import type { SandboxDriver } from './sandbox/driver.ts';
import type { SettingsService } from './settings.ts';
import type { Store } from './store.ts';

export const DEFAULT_SANDBOX_IMAGE = 'cocoon/sandbox:latest';
export const PROXY_IMAGE = 'cocoon/egress-proxy:latest';

export type ContainerImageKind = Exclude<ImageKind, 'agents'>;

const contextDirs: Record<ContainerImageKind, string> = { sandbox: 'sandbox', proxy: 'egress-proxy' };

/** Image labels CoCoon sets on its own builds, so update checks can tell whether an image is current. */
export const LABEL_CONTEXT = 'cocoon.context';
export const LABEL_VARIANT = 'cocoon.variant';
export const LABEL_BASE = 'cocoon.base';

/**
 * Fingerprint of a build: every file of the build directory (tests excluded, they are not copied into the image)
 * plus the build arguments. Changes when CoCoon's Dockerfile or the files copied into the image change.
 */
export function contextHash(dir: string, buildArgs: Record<string, string>): string {
  const hash = createHash('sha256');
  for (const name of readdirSync(dir).filter((n) => !/\.test\.[cm]?[jt]s$/.test(n)).sort()) {
    hash.update(`${name}\0`).update(readFileSync(join(dir, name))).update('\0');
  }
  hash.update(JSON.stringify(Object.entries(buildArgs).sort(([a], [b]) => a.localeCompare(b))));
  return hash.digest('hex').slice(0, 16);
}

/** Base image of a Dockerfile (the last FROM, i.e. the final stage), with Docker Hub's implicit prefix spelled out. */
export function baseImage(dockerfile: string): string | undefined {
  const froms = [...dockerfile.matchAll(/^\s*FROM\s+(?:--\S+\s+)*(\S+)/gim)].map((m) => m[1]!);
  const ref = froms.at(-1);
  if (!ref || ref.includes('$') || ref === 'scratch') return undefined;
  const first = ref.split('/')[0]!;
  if (ref.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost')) return ref;
  return `docker.io/${ref.includes('/') ? ref : `library/${ref}`}`;
}

export function buildArgsFor(kind: ContainerImageKind, variant: 'slim' | 'full' = 'slim'): Record<string, string> {
  // Agent CLIs live in the toolbox, so the base image stays small.
  return kind === 'sandbox' ? { TOOLCHAIN: variant, AGENTS: '' } : {};
}

/** Installed by default on first start: the common agents plus the ones that work well with local models. */
export const DEFAULT_TOOLS: AgentTool[] = ['claude-code', 'codex', 'opencode', 'pi'];

export interface BuildOptions {
  variant?: 'slim' | 'full';
  tools?: AgentTool[];
  /** Pull the base image first, so the build uses its newest version. */
  pull?: boolean;
}

/**
 * Builds the bundled images (sandbox base, egress proxy) and installs the agent toolbox (agent CLIs shared read-only by
 * all sandboxes), reporting progress as "image.build" events.
 */
export class ImageService {
  private readonly building = new Map<ImageKind, { buildId: string; done: Promise<boolean> }>();
  private readonly finishedListeners: ((kind: ImageKind, ok: boolean) => void)[] = [];

  constructor(
    private readonly driver: SandboxDriver,
    private readonly config: Config,
    private readonly settings: SettingsService,
    private readonly store: Store,
    private readonly bus: EventBus,
  ) {}

  ref(kind: ImageKind): string {
    if (kind === 'proxy') return PROXY_IMAGE;
    if (kind === 'agents') return this.driver.kind === 'bwrap' ? 'agents' : 'volume:cocoon-agents';
    return this.settings.get().sandbox.image;
  }

  async exists(ref: string): Promise<boolean> {
    return Boolean(await this.driver.imageDetails(ref));
  }

  /** Build directory of one of CoCoon's images. */
  contextDir(kind: ContainerImageKind): string {
    return join(this.config.imagesDir, contextDirs[kind]);
  }

  /** Base image the Dockerfile of an image starts from. */
  baseOf(kind: ContainerImageKind): string | undefined {
    try {
      return baseImage(readFileSync(join(this.contextDir(kind), 'Dockerfile'), 'utf8'));
    } catch {
      return undefined;
    }
  }

  /** Whether the configured sandbox image is one CoCoon builds itself (not a custom image). */
  managesSandboxImage(): boolean {
    return this.settings.get().sandbox.image.startsWith('cocoon/sandbox:');
  }

  /** Installed version per npm package of the toolbox; read from the toolbox once and then remembered. */
  async toolVersions(): Promise<Record<string, string> | undefined> {
    const toolbox = this.store.toolbox();
    if (!toolbox?.installedAt) return undefined;
    if (toolbox.versions) return toolbox.versions;
    const versions = await this.driver.toolVersions(this.settings.get().sandbox.image);
    if (Object.keys(versions).length) this.store.putToolbox({ ...toolbox, versions });
    return versions;
  }

  /** Whether the agent toolbox has been installed. */
  toolboxReady(): boolean {
    return Boolean(this.store.toolbox()?.installedAt);
  }

  async status(): Promise<ImageInfo[]> {
    const toolbox = this.store.toolbox();
    const agents: ImageInfo = {
      kind: 'agents',
      ref: this.ref('agents'),
      exists: Boolean(toolbox?.installedAt),
      createdAt: toolbox?.installedAt,
      building: this.building.has('agents'),
      tools: toolbox?.tools,
      versions: toolbox?.versions,
    };
    if (!this.driver.capabilities.images) return [agents];
    const images = await Promise.all(
      (['sandbox', 'proxy'] as const).map(async (kind): Promise<ImageInfo> => {
        const ref = this.ref(kind);
        const details = await this.driver.imageDetails(ref);
        return {
          kind,
          ref,
          building: this.building.has(kind),
          exists: Boolean(details),
          createdAt: details?.createdAt,
          sizeMb: details?.sizeMb,
        };
      }),
    );
    return [...images, agents];
  }

  onFinished(listener: (kind: ImageKind, ok: boolean) => void): void {
    this.finishedListeners.push(listener);
  }

  /** Starts a build (or returns the running one). Resolves `done` with success. */
  build(kind: ImageKind, opts: BuildOptions = {}): { buildId: string; done: Promise<boolean> } {
    const running = this.building.get(kind);
    if (running) return running;
    if (kind !== 'agents' && !this.driver.capabilities.images) {
      throw new CocoonError('bad_request', `${this.driver.name} does not use container images`);
    }

    const buildId = newId('bd');
    const emit = (status: 'running' | 'succeeded' | 'failed', extra: { line?: string; error?: string } = {}) =>
      this.bus.publish({ type: 'image.build', buildId, kind, status, ...extra });
    const onOutput = (line: string) => emit('running', { line });

    const done = (async () => {
      try {
        if (kind === 'agents') {
          const tools = opts.tools?.length ? opts.tools : DEFAULT_TOOLS;
          emit('running', { line: `Installing ${tools.map((tool) => AGENT_TOOLS[tool].label).join(', ')} into the agent toolbox …` });
          const image = this.settings.get().sandbox.image;
          await this.driver.installTools(tools.map((tool) => AGENT_TOOLS[tool].npm), image, onOutput);
          const versions = await this.driver.toolVersions(image).catch(() => undefined);
          this.store.putToolbox({ tools, installedAt: new Date().toISOString(), versions });
        } else {
          // Never overwrite a custom image the user configured; only (re)build CoCoon's own sandbox tags.
          const configured = this.settings.get().sandbox.image;
          const tag = kind === 'proxy' ? PROXY_IMAGE : this.managesSandboxImage() ? configured : DEFAULT_SANDBOX_IMAGE;
          const variant = opts.variant ?? 'slim';
          const buildArgs = buildArgsFor(kind, variant);
          const base = this.baseOf(kind);
          if (base && (opts.pull || !(await this.driver.imageDetails(base)))) {
            emit('running', { line: `Pulling ${base} …` });
            // Offline or registry trouble: build with the local base image (if any) instead of failing.
            await this.driver.pullImage(base).catch((err) => emit('running', { line: `Pull failed, using the local image: ${(err as Error).message}` }));
          }
          const baseDigest = base ? (await this.driver.imageDetails(base))?.digests?.[0] : undefined;
          emit('running', { line: `Building ${tag} …` });
          const contextDir = this.contextDir(kind);
          await this.driver.buildImage(contextDir, tag, buildArgs, onOutput, {
            [LABEL_CONTEXT]: contextHash(contextDir, buildArgs),
            ...(kind === 'sandbox' ? { [LABEL_VARIANT]: variant } : {}),
            ...(baseDigest ? { [LABEL_BASE]: baseDigest } : {}),
          });
        }
        emit('succeeded');
        return true;
      } catch (err) {
        emit('failed', { error: (err as Error).message });
        return false;
      } finally {
        this.building.delete(kind);
      }
    })();

    const handle = { buildId, done };
    this.building.set(kind, handle);
    void done.then((ok) => this.finishedListeners.forEach((listener) => listener(kind, ok)));
    return handle;
  }
}
