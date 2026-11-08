import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_TOOLBOX_IMAGE } from './sandbox/driver.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export type Config = ReturnType<typeof loadConfig>;

/** A positive number from the environment, or the default. Anything else is a configuration error. */
function positive(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

/**
 * COCOON_TRUST_PROXY: how many reverse proxies stand in front of CoCoon (a number), or the addresses of those proxies.
 * Only then is X-Forwarded-For believed, which the sign-in throttle needs to tell clients apart. Off by default: without a
 * proxy, a client could forge the header and escape the throttle. The result is Fastify's `trustProxy` option.
 */
export function parseTrustProxy(raw: string | undefined): false | string[] | ((address: string, hop: number) => boolean) {
  const value = raw?.trim();
  if (!value || value === '0' || value.toLowerCase() === 'false') return false;
  if (/^\d{1,2}$/.test(value)) {
    const hops = Number(value);
    return (_address, hop) => hop < hops;
  }
  return value.split(',').map((address) => address.trim()).filter(Boolean);
}

/** Process-level configuration from the environment. Everything else lives in editable settings. */
export function loadConfig(env = process.env) {
  const token = env.COCOON_TOKEN || undefined;
  if (token && (token === 'change-me' || token.length < 16)) {
    throw new Error('COCOON_TOKEN must be a random secret of at least 16 characters (or unset it to auto-generate one)');
  }
  return {
    token,
    /** Password sign-in of users: how long a session lives. */
    auth: {
      /** A session ends after this long without activity ... */
      sessionIdleMs: positive(env, 'COCOON_SESSION_IDLE_MINUTES', 8 * 60) * 60_000,
      /** ... and after this long in any case. */
      sessionMaxMs: positive(env, 'COCOON_SESSION_MAX_HOURS', 7 * 24) * 3_600_000,
    },
    trustProxy: parseTrustProxy(env.COCOON_TRUST_PROXY),
    host: env.COCOON_HOST ?? '127.0.0.1',
    port: Number(env.COCOON_PORT ?? 7420),
    publicUrl: env.COCOON_PUBLIC_URL,
    dataDir: resolve(env.COCOON_DATA_DIR ?? resolve(repoRoot, '.data')),
    dockerSocket: env.DOCKER_SOCKET,
    /** Isolation backend: auto | docker | podman | bwrap. */
    driver: (env.COCOON_DRIVER ?? 'auto') as 'auto' | 'docker' | 'podman' | 'bwrap',
    /** bubblewrap cannot enforce egress: only with this opt-in may its sandboxes use "egress"/"open" (shared host network) or be picked by "auto". */
    bwrapHostNetwork: env.COCOON_BWRAP_HOST_NETWORK === '1',
    /** Ports of the egress proxy process (bubblewrap driver): forward proxy, credential proxy = port + 1. */
    proxyPort: Number(env.COCOON_PROXY_PORT ?? 7431),
    /** CoCoon's own installation (a git clone, updated by the update service). */
    repoDir: repoRoot,
    /** Port forwarding (sandbox servers reachable from outside). COCOON_PORTS=0 turns it off. */
    ports: {
      enabled: env.COCOON_PORTS !== '0',
      previewRange: env.COCOON_PORTS_PREVIEW_RANGE ?? '7500-7549',
      shareRange: env.COCOON_PORTS_SHARE_RANGE ?? '7550-7599',
      /** Address shared ports are published on (no authentication on those ports); empty = sharing disabled, the default. */
      shareBind: env.COCOON_PORTS_SHARE_BIND ?? '',
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
