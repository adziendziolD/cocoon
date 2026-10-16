import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Duplex, Readable } from 'node:stream';
import type { DriverCapabilities, DriverKind, NetworkMode, Resources } from '@cocoon/protocol';

/** Where the shared agent toolbox (agent CLIs) is mounted read-only inside every sandbox. */
export const TOOLBOX_PATH = '/opt/agents';
export const SANDBOX_PATH = `${TOOLBOX_PATH}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;

/** Name → version of the packages in a global node_modules directory (the toolbox's lib/node_modules). */
export function readToolVersions(dir: string): Record<string, string> {
  const versions: Record<string, string> = {};
  const scan = (base: string, scope: string) => {
    let names: string[];
    try {
      names = readdirSync(base);
    } catch {
      return;
    }
    for (const name of names) {
      if (!scope && name.startsWith('@')) {
        scan(join(base, name), `${name}/`);
        continue;
      }
      try {
        const { version } = JSON.parse(readFileSync(join(base, name, 'package.json'), 'utf8')) as { version?: unknown };
        if (typeof version === 'string') versions[scope + name] = version;
      } catch {
        // not a package
      }
    }
  };
  scan(dir, '');
  return versions;
}

/** readToolVersions() as a standalone Node.js program that prints JSON (runs inside a container). */
export const READ_TOOL_VERSIONS_JS = `const fs=require('fs'),path=require('path');const out={};
const scan=(base,scope)=>{let names;try{names=fs.readdirSync(base)}catch{return}
for(const name of names){if(!scope&&name.startsWith('@')){scan(path.join(base,name),name+'/');continue}
try{const v=JSON.parse(fs.readFileSync(path.join(base,name,'package.json'),'utf8')).version;if(typeof v==='string')out[scope+name]=v}catch{}}};
scan(process.argv[1],'');console.log(JSON.stringify(out));`;

/**
 * Image the Docker/Podman driver installs the toolbox with. Its Node.js runtime (node, npm, npx, corepack) is copied into
 * the toolbox, so sandbox images need no Node.js of their own. Same distribution as CoCoon's sandbox image (glibc), so
 * native binaries npm picks for the agent CLIs run there. COCOON_TOOLBOX_IMAGE overrides it (e.g. for musl-based images).
 */
export const DEFAULT_TOOLBOX_IMAGE = 'docker.io/library/node:24-bookworm-slim';

/**
 * Shell script (npm packages as arguments): replaces the content of the toolbox directory (env TOOLBOX_DIR, default
 * TOOLBOX_PATH) with the Node.js runtime found on PATH plus the given agent CLIs.
 */
export const INSTALL_TOOLBOX_SCRIPT = `set -e
T="\${TOOLBOX_DIR:-${TOOLBOX_PATH}}"
rm -rf "$T"/* "$T/.npm-cache"
mkdir -p "$T/bin" "$T/lib/node_modules"
cp "$(command -v node)" "$T/bin/node"
root=$(npm root -g)
for pkg in npm corepack; do [ ! -d "$root/$pkg" ] || cp -R "$root/$pkg" "$T/lib/node_modules/$pkg"; done
[ ! -d "$T/lib/node_modules/npm" ] || { ln -s ../lib/node_modules/npm/bin/npm-cli.js "$T/bin/npm"; ln -s ../lib/node_modules/npm/bin/npx-cli.js "$T/bin/npx"; }
[ ! -d "$T/lib/node_modules/corepack" ] || ln -s ../lib/node_modules/corepack/dist/corepack.js "$T/bin/corepack"
export PATH="$T/bin:$PATH" npm_config_cache="$T/.npm-cache"
npm install -g --prefix "$T" --no-fund --no-audit --loglevel=http "$@"
rm -rf "$T/.npm-cache"
ls "$T/bin"`;

/** Node.js of the toolbox, or (toolboxes installed before it had one) the image's own – for commands run in a sandbox image. */
export const TOOLBOX_NODE = `N=${TOOLBOX_PATH}/bin/node; [ -x "$N" ] || N=node`;

/** Parses `node --version` output ("v24.1.0") into "24.1.0"; undefined for anything else. */
export function parseNodeVersion(output: string): string | undefined {
  return /^v?(\d+\.\d+\.\d+\S*)\s*$/.exec(output.trim())?.[1];
}

export interface SandboxSpec {
  sandboxId: string;
  name: string;
  image: string;
  network: NetworkMode;
  runtime: string | null;
  resources: Resources;
  workdir: string;
  env: Record<string, string>;
  /** Mount the agent toolbox at TOOLBOX_PATH. */
  toolbox: boolean;
}

export type RuntimeState = 'running' | 'stopped' | 'missing';

export interface ExecOptions {
  env?: Record<string, string>;
  workdir?: string;
  timeoutMs?: number;
  /** Defaults to the sandbox user. */
  user?: string;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface TtySession {
  /** Raw terminal byte stream (stdin in, stdout out). */
  stream: Duplex;
  resize(cols: number, rows: number): Promise<void>;
  close(): void;
}

export interface ImageDetails {
  createdAt?: string;
  sizeMb?: number;
  labels?: Record<string, string>;
  /** Registry digests the image was pulled with ("sha256:…"). */
  digests?: string[];
}

/**
 * Isolation backend. CoCoon only talks to sandboxes through this interface.
 * Implementations: Docker / Podman (containers, optional gVisor or Kata/Firecracker runtimes) and bubblewrap (lightweight
 * process sandboxes without images or a daemon).
 */
export interface SandboxDriver {
  readonly kind: DriverKind;
  readonly name: string;
  readonly capabilities: DriverCapabilities;
  /** Fails if the backend is not usable (e.g. daemon not running, bwrap missing). */
  check(): Promise<void>;
  info(): Promise<{ version?: string; runtimes: string[] }>;

  create(spec: SandboxSpec): Promise<{ handle: string }>;
  start(handle: string): Promise<void>;
  stop(handle: string): Promise<void>;
  remove(handle: string): Promise<void>;
  state(handle: string): Promise<RuntimeState>;
  /** Address on the internal egress network, if any (container drivers). */
  address(handle: string): Promise<string | undefined>;
  exec(handle: string, command: string[], opts?: ExecOptions): Promise<ExecResult>;
  attachTty(handle: string, command: string[], size: { cols: number; rows: number }): Promise<TtySession>;
  /** Extracts a tar archive into a directory inside the sandbox. */
  putArchive(handle: string, dir: string, tar: Buffer): Promise<void>;
  /** Streams a file or directory from the sandbox as tar. */
  getArchive(handle: string, path: string): Promise<Readable>;

  /**
   * Installs npm packages plus the Node.js runtime that runs them into the shared agent toolbox (replacing its previous
   * content). `image`: container drivers install with this image (see DEFAULT_TOOLBOX_IMAGE).
   */
  installTools(packages: string[], image: string, onOutput: (line: string) => void): Promise<void>;
  /** Installed version per npm package in the toolbox (empty if not installed). `image`: the sandbox image. */
  toolVersions(image: string): Promise<Record<string, string>>;
  /** Node.js version in the toolbox ("24.1.0"), undefined if the toolbox has none. `image`: the sandbox image. */
  toolboxRuntime(image: string): Promise<string | undefined>;

  /** Container image details, or undefined if missing / not applicable. */
  imageDetails(ref: string): Promise<ImageDetails | undefined>;
  buildImage(
    contextDir: string,
    tag: string,
    buildArgs: Record<string, string>,
    onOutput: (line: string) => void,
    labels?: Record<string, string>,
  ): Promise<void>;
  /** Pulls an image from its registry. */
  pullImage(ref: string, onOutput?: (line: string) => void): Promise<void>;
  /** Digest ("sha256:…") the registry currently serves for a tag, or undefined if unknown (offline, not supported). */
  registryDigest(ref: string): Promise<string | undefined>;
}
