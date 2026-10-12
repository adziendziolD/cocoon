import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'images/egress-proxy/*.test.mjs'],
    exclude: ['**/node_modules/**', 'packages/web/**'],
    environment: 'node',
    // Unit tests only: no Docker, network or running server.
    testTimeout: 5000,
  },
});
