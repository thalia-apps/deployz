import { defineConfig } from 'vitest/config';

// The harness's pure parts and its small test containers. No test builds a
// repository image.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'fixtures/*.test.ts', 'recipes/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
