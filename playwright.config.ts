import { defineConfig } from '@playwright/test';

import { scrubEnv } from './scripts/e2e-env.mjs';

// Boots the real Fastify API and the real Next.js dev server; the spec drives
// a real Chromium browser through signup → session → API 200. API needs
// @deployz/db built (dist) — run `pnpm build` first (turbo dev dependsOn is
// also wired so `pnpm dev` works standalone).
const webPort = Number(process.env.WEB_PORT ?? 3000);
const apiPort = Number(process.env.API_PORT ?? 3001);

// Second defence layer for the real-AWS guard (scripts/e2e.mjs is the first):
// even a direct `pnpm exec playwright test`, without going through the
// runner, must refuse canary/fresh without the opt-in
// (docs/testing/simulated-e2e.md D3).
const e2eMode = process.env.DEPLOYZ_E2E_MODE ?? 'simulated';
if ((e2eMode === 'canary' || e2eMode === 'fresh') && process.env.DEPLOYZ_E2E_ALLOW_REAL_AWS !== '1') {
  throw new Error(
    'Real AWS E2E is disabled.\nSet DEPLOYZ_E2E_ALLOW_REAL_AWS=1\nonly when intentionally running AWS-backed E2E tests.',
  );
}

// In simulated mode, the API must not inherit real AWS credentials, the job
// queue URL, or SES/email config from the developer's shell — same scrub
// list the runner applies (scripts/e2e-env.mjs), so a direct Playwright
// invocation can't leak them into the API under test either.
const apiEnv = e2eMode === 'simulated' ? scrubEnv(process.env).env : { ...process.env };

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  use: { baseURL: `http://localhost:${webPort}` },
  expect: {
    toHaveScreenshot: {
      // Small tolerance for cross-platform font rasterization; content itself
      // is fully mocked and deterministic (see e2e/visual.spec.ts).
      maxDiffPixelRatio: 0.02,
    },
  },
  webServer: [
    {
      command: 'pnpm --filter @deployz/api dev',
      url: `http://localhost:${apiPort}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      env: {
        ...apiEnv,
        // Fixture mode: the GitHub routes serve the fixture org/repos so the
        // repo-selection E2E renders without a real GitHub App.
        GITHUB_FIXTURE_MODE: 'true',
        // Fixture mode: a canned AI gateway so fix-instructions generation
        // succeeds deterministically in E2E, without a live model.
        AI_FIXTURE_MODE: 'true',
        // Fixture mode: a new release is marked built (READY, fixture digest)
        // immediately instead of enqueuing BUILD_RELEASE, which no-ops locally.
        BUILD_FIXTURE_MODE: 'true',
        // Fixture mode: DNS/HTTPS domain checks pass only for
        // *.deployz-fixture.test names, with no check throttle — lets the
        // custom-domain E2E drive the state machine without real DNS/network.
        DOMAIN_FIXTURE_MODE: 'true',
        // Paddle migration Phase 7 fixture mode: every fresh organization
        // (signup and POST /api/organizations) gets an ACTIVE
        // billing_subscriptions row, so specs that create a PRODUCTION
        // deployment through the real routes exercise the entitlement gate
        // instead of always hitting 402 SUBSCRIPTION_REQUIRED.
        BILLING_FIXTURE_MODE: 'true',
        // Every new user has a verified e-mail, so the invitation specs can
        // accept without an inbox (invitations require a verified e-mail).
        EMAIL_VERIFICATION_FIXTURE_MODE: 'true',
        // Phase 11 default HTTPS under the fixture DNS (opt-in): the existing
        // fixture suite is written against HTTP-only installs, so the
        // automatic default-HTTPS flow stays off unless an operator sets this
        // for a dedicated default-https run.
        DEPLOYZ_DEFAULT_HTTPS_FIXTURE: process.env.DEPLOYZ_DEFAULT_HTTPS_FIXTURE ?? 'false',
        // A published bootstrap template is what turns the install page's
        // "Deploy to AWS" button into a real Quick Create link. The value is
        // a stand-in for the URL `publish:bootstrap` prints; the E2E only
        // asserts the shape of the link built from it.
        BOOTSTRAP_TEMPLATE_URL:
          'https://deployz-templates.s3.us-east-1.amazonaws.com/bootstrap/v1/bootstrap-template-v1.json',
        // A stand-in for the GitHub App's install page, so "Manage GitHub
        // access" renders deterministically in E2E even when the developer's
        // (or CI's) shell has no real value configured.
        GITHUB_APP_INSTALL_URL:
          process.env.GITHUB_APP_INSTALL_URL ?? 'https://github.com/apps/deployz-e2e-fixture',
        // Team Admin env-grant allowlist (docs/admin/team-admin.md): any
        // signed-up account under this test-only domain is a team admin, so
        // e2e/admin.spec.ts can mint admin accounts by email alone.
        TEAM_ADMIN_EMAILS: '*@admin-e2e.deployz.test',
      },
    },
    {
      command: 'pnpm --filter @deployz/web dev',
      url: `http://localhost:${webPort}`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      env: {
        ...process.env,
        // `next dev` reads $PORT, not $WEB_PORT — without this, overriding
        // WEB_PORT to dodge a locally-running dev server silently no-ops:
        // Next keeps binding :3000 while Playwright waits on the isolated
        // port and eventually times out.
        PORT: String(webPort),
        // apps/web/src/lib/api-url.ts falls back to localhost:3001 for both
        // the browser (`NEXT_PUBLIC_API_URL`) and server-side (`API_URL`)
        // origins when these are unset — so overriding only API_PORT left
        // every fetch pointed at the wrong (or no) server instead of the
        // isolated one actually booted above.
        NEXT_PUBLIC_API_URL: `http://localhost:${apiPort}`,
        API_URL: `http://localhost:${apiPort}`,
      },
    },
  ],
});
