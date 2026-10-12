import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
    imagesDir: resolve(env.COCOON_IMAGES_DIR ?? resolve(repoRoot, 'images')),
    webDir: resolve(env.COCOON_WEB_DIR ?? resolve(repoRoot, 'packages/web/dist')),
    /** Initial settings on first start (later edited via UI/API). */
    seedSettings: env.COCOON_CONFIG ? (JSON.parse(readFileSync(resolve(env.COCOON_CONFIG), 'utf8')) as unknown) : undefined,
  };
}
