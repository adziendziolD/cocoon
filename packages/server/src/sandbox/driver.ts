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

  /** Installs npm packages into the shared agent toolbox (replacing its previous content). */
  installTools(packages: string[], image: string, onOutput: (line: string) => void): Promise<void>;
  /** Installed version per npm package in the toolbox (empty if not installed). */
  toolVersions(image: string): Promise<Record<string, string>>;

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
