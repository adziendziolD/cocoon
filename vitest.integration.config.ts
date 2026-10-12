import { defineConfig } from 'vitest/config';

/**
 * Integration tests against a real CoCoon server with Docker (or Podman): sandboxes, agents, egress/credential proxy,
 * several repositories, shared services. Run with `pnpm test:integration`; they start their own server instance
 * (COCOON_INSTANCE) and leave a running CoCoon on the same host alone.
 */
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.it.test.ts'],
    environment: 'node',
    globalSetup: ['tests/integration/global-setup.ts'],
    // One server, real containers: run files one after another.
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 1_200_000,
  },
});
