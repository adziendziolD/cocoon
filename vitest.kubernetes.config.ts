import { defineConfig } from 'vitest/config';

/**
 * Tests against a real CoCoon in a local Kubernetes cluster (kind): `pnpm test:kubernetes`. The setup builds the
 * cocoond image from the working tree and deploys it (tests/kubernetes/setup.sh). Besides the Kubernetes-specific
 * tests, the backend-independent integration tests run against the cluster too.
 */
export default defineConfig({
  test: {
    include: ['tests/kubernetes/**/*.it.test.ts', 'tests/integration/{sandbox,ports,repos,tasks,schedules,review}.it.test.ts'],
    environment: 'node',
    globalSetup: ['tests/kubernetes/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 1_200_000,
  },
});
