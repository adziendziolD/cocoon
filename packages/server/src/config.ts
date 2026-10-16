import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_TOOLBOX_IMAGE } from './sandbox/driver.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export type Config = ReturnType<typeof loadConfig>;

/** Process-level configuration from the environment. Everything else lives in editable settings. */
export function loadConfig(env = process.env) {
  const token = env.COCOON_TOKEN || undefined;
  if (token && (token === 'change-me' || token.length < 16)) {
    throw new Error('COCOON_TOKEN must be a random secret of at least 16 characters (or unset it to auto-generate one)');
  }
  return {
    token,
    host: env.COCOON_HOST ?? '127.0.0.1',
    port: Number(env.COCOON_PORT ?? 7420),
    publicUrl: env.COCOON_PUBLIC_URL,
    dataDir: resolve(env.COCOON_DATA_DIR ?? resolve(repoRoot, '.data')),
    dockerSocket: env.DOCKER_SOCKET,
    /** Isolation backend: auto | docker | podman | bwrap. */
    driver: (env.COCOON_DRIVER ?? 'auto') as 'auto' | 'docker' | 'podman' | 'bwrap',
    /** Ports of the egress proxy process (bubblewrap driver): forward proxy, credential proxy = port + 1. */
    proxyPort: Number(env.COCOON_PROXY_PORT ?? 7431),
    /** CoCoon's own installation (a git clone, updated by the update service). */
    repoDir: repoRoot,
    /** Port forwarding (sandbox servers reachable from outside). COCOON_PORTS=0 turns it off. */
    ports: {
      enabled: env.COCOON_PORTS !== '0',
      previewRange: env.COCOON_PORTS_PREVIEW_RANGE ?? '7500-7549',
      shareRange: env.COCOON_PORTS_SHARE_RANGE ?? '7550-7599',
      /** Address shared ports are published on; empty = sharing disabled. */
      shareBind: env.COCOON_PORTS_SHARE_BIND ?? '0.0.0.0',
      /** Wildcard domain for previews (p<port>-<sandbox>.<domain>); default: *.localhost on the CoCoon port. */
      previewDomain: env.COCOON_PREVIEW_DOMAIN || undefined,
    },
    imagesDir: resolve(env.COCOON_IMAGES_DIR ?? resolve(repoRoot, 'images')),
    /** Image the agent toolbox (agent CLIs + Node.js) is installed with (Docker/Podman). */
    toolboxImage: env.COCOON_TOOLBOX_IMAGE || DEFAULT_TOOLBOX_IMAGE,
    webDir: resolve(env.COCOON_WEB_DIR ?? resolve(repoRoot, 'packages/web/dist')),
    /** Initial settings on first start (later edited via UI/API). */
    seedSettings: env.COCOON_CONFIG ? (JSON.parse(readFileSync(resolve(env.COCOON_CONFIG), 'utf8')) as unknown) : undefined,
  };
}
