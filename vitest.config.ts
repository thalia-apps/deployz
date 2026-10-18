import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Vitest 3 projects: each workspace package is a project rooted at its
    // own directory. Per-package overrides (e.g. jsdom for apps/web) arrive
    // with later todos via a vitest.config.ts inside that package.
    projects: ['packages/*', 'apps/*', 'scripts/version-canary', 'scripts/repository-compatibility', 'scripts/repository-deployment', 'scripts/jev-eval', 'scripts/remediation-benchmark', 'scripts/run-and-check'],
  },
});
