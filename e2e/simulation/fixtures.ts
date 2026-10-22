/**
 * Playwright test extension for the simulated-infrastructure scenario suite.
 *
 * Mirrors e2e/deployment-progress.spec.ts's and e2e/stack-events.spec.ts's
 * seeding conventions (sign up a vendor, create an application/customer/
 * deployment via the real API), then performs the launched+register
 * handshake and starts a `SimulatedCustomerAccount`-backed relay
 * (./relay-harness.ts) for the chosen scenario — see
 * docs/testing/simulated-e2e.md D1/D2. No browser is
 * needed: every assertion in e2e/scenario-install.spec.ts goes through the
 * real HTTP API, so this fixture only ever uses Playwright's bare
 * `request` (APIRequestContext), never `page`.
 */

import { expect, test as base, type APIRequestContext, type Page } from '@playwright/test';

import { createReadyRelease } from '../seed-ready-manifest.js';
import { extractQuickCreateParam, startSimulatedRelay, type SimulatedRelayHandle } from './relay-harness.js';
import { getScenario } from './scenarios/index.js';
import { installLinkHeaders } from '../install-link.js';

export const API_URL = `http://localhost:${process.env.API_PORT ?? 3001}`;

export interface DeployzApi {
  getDeployment(deploymentId: string): Promise<Record<string, unknown>>;
  /** GET /api/install/:installLinkId — the pre-install public page payload
   *  (plan, quickCreateUrl, ...), distinct from `getInstallStatus` below (the
   *  lifecycle-derived `/status` projection). Added for the redis-failure
   *  scenario: `plan.components` reflects the deployment's frozen manifest
   *  directly, independent of the deployment's current stage — see
   *  e2e/redis.spec.ts's equivalent "will create" assertion. */
  getInstallInfo(installLinkId: string): Promise<Record<string, unknown>>;
  getInstallStatus(installLinkId: string): Promise<Record<string, unknown>>;
  getStackEvents(deploymentId: string): Promise<unknown[]>;
  getInfrastructure(deploymentId: string): Promise<Record<string, unknown>>;
  /** GET /api/deployments/:id/plan?action=install|update|destroy — the
   *  deterministic manifest-derived plan (packages/contracts/src/plan.ts). */
  getPlan(deploymentId: string, action: 'install' | 'update' | 'destroy'): Promise<Record<string, unknown>>;
}

export interface DeployzInstall {
  readonly deploymentId: string;
  readonly installLinkId: string;
  readonly installationId: string;
  readonly enrollmentCode: string;
  /** Absent when the test opted out via `deployzStartRelay: false`
   *  (bootstrap-failure — the relay never registers at all). */
  readonly relay: SimulatedRelayHandle | undefined;
  readonly api: DeployzApi;
}

/**
 * Deploy Links (docs/deploy-links.md) variant of `deployzInstall`: the
 * vendor generates a tokenized deploy link instead of creating the
 * deployment directly, and the customer's launch signal goes through the
 * PUBLIC deploy-link routes (x-deployz-token header) — the same relay then
 * enrolls with the same enrollment code, proving the link is a thin entry
 * point into the ONE pipeline.
 */
export interface DeployzLinkInstall {
  readonly deploymentId: string;
  readonly deployLinkPublicId: string;
  readonly deployLinkToken: string;
  readonly enrollmentCode: string;
  readonly installationId: string;
  readonly relay: SimulatedRelayHandle | undefined;
  readonly api: DeployzApi;
}

/** The raw-`request` API client behind `deployzInstall`/`deployzLinkInstall`
 *  — exported for specs that seed their own deployment through plain
 *  `request` calls (scenario-sweep, scenario-matrix) instead of the
 *  `deployzInstall` fixture. */
export function buildApi(request: APIRequestContext): DeployzApi {
  return {
    async getDeployment(deploymentId) {
      const response = await request.get(`${API_URL}/api/deployments/${deploymentId}`);
      if (!response.ok()) {
        throw new Error(`GET /api/deployments/${deploymentId} -> ${response.status()}`);
      }
      return (await response.json()) as Record<string, unknown>;
    },
    async getInstallInfo(installLinkId) {
      const response = await request.get(`${API_URL}/api/install/${installLinkId}`, {
      headers: await installLinkHeaders(request, installLinkId),
    });
      if (!response.ok()) {
        throw new Error(`GET /api/install/${installLinkId} -> ${response.status()}`);
      }
      return (await response.json()) as Record<string, unknown>;
    },
    async getInstallStatus(installLinkId) {
      const response = await request.get(`${API_URL}/api/install/${installLinkId}/status`);
      if (!response.ok()) {
        throw new Error(`GET /api/install/${installLinkId}/status -> ${response.status()}`);
      }
      return (await response.json()) as Record<string, unknown>;
    },
    async getStackEvents(deploymentId) {
      const response = await request.get(`${API_URL}/api/deployments/${deploymentId}/stack-events`);
      if (!response.ok()) {
        throw new Error(`GET /api/deployments/${deploymentId}/stack-events -> ${response.status()}`);
      }
      const body = (await response.json()) as { events: unknown[] };
      return body.events;
    },
    async getInfrastructure(deploymentId) {
      const response = await request.get(`${API_URL}/api/deployments/${deploymentId}/infrastructure`);
      if (!response.ok()) {
        throw new Error(`GET /api/deployments/${deploymentId}/infrastructure -> ${response.status()}`);
      }
      return (await response.json()) as Record<string, unknown>;
    },
    async getPlan(deploymentId, action) {
      const response = await request.get(`${API_URL}/api/deployments/${deploymentId}/plan?action=${action}`);
      if (!response.ok()) {
        throw new Error(`GET /api/deployments/${deploymentId}/plan?action=${action} -> ${response.status()}`);
      }
      return (await response.json()) as Record<string, unknown>;
    },
  };
}

/** The inventory-expectations subset of GET /api/deployments/:id/infrastructure
 *  (packages/contracts/src/infrastructure.ts) that
 *  `expectPlanMatchesInventory` asserts against. */
interface InventoryExpectationsView {
  expectations: {
    components: Array<{ kind: string; expected: boolean }>;
    missing: string[];
    unexpected: string[];
  } | null;
}

/**
 * Phase 6 expectation gate: asserts that the deployment's persisted
 * inventory matches what the server PLAN says it requires.
 *
 *  - `expectations.missing` and `expectations.unexpected` settle to empty
 *    (the inventory snapshot lands asynchronously via relay heartbeats, so
 *    the emptiness settles like every other poll in this suite).
 *  - Cross-checks the server PLAN (GET /api/deployments/:id/plan) against
 *    the inventory: every install-plan CREATE kind must be reflected as an
 *    EXPECTED kind in the inventory's expectations. Logical component KINDS
 *    only — never raw CloudFormation resource counts.
 *
 * `stage` names the lifecycle checkpoint in every failure message, so a
 * failure carries the missing/unexpected arrays and the plan kinds as
 * actionable evidence rather than a bare boolean.
 */
export async function expectPlanMatchesInventory(
  api: Pick<DeployzApi, 'getInfrastructure' | 'getPlan'>,
  deploymentId: string,
  { stage }: { stage: string },
): Promise<void> {
  const readExpectations = () => api.getInfrastructure(deploymentId) as unknown as Promise<InventoryExpectationsView>;

  await expect
    .poll(
      async () => {
        const { expectations } = await readExpectations();
        return expectations && { missing: expectations.missing, unexpected: expectations.unexpected };
      },
      {
        timeout: 15_000,
        message: `[stage ${stage}] infrastructure expectations must settle with missing and unexpected both empty`,
      },
    )
    .toEqual({ missing: [], unexpected: [] });

  const { expectations } = await readExpectations();
  if (!expectations) {
    throw new Error(`[stage ${stage}] infrastructure expectations became null after settling`);
  }
  const evidence = `[stage ${stage}] deployment ${deploymentId}: missing=${JSON.stringify(expectations.missing)} unexpected=${JSON.stringify(expectations.unexpected)} expectedKinds=${JSON.stringify(expectations.components.filter((entry) => entry.expected).map((entry) => entry.kind))}`;

  const plan = (await api.getPlan(deploymentId, 'install')) as {
    components: Array<{ kind: string; action: string }>;
  };
  const planCreateKinds = plan.components
    .filter((component) => component.action === 'CREATE')
    .map((component) => component.kind);
  // Phase 3's spec-derived plan components include wire-level-only kinds
  // (packages/contracts/src/plan.ts): a 'worker' is an ECS task whose AWS
  // footprint is the application's own service. The inventory models AWS
  // resources, not processes, so a worker is covered by the application
  // expectation rather than by a row of its own.
  const inventoryKinds = planCreateKinds.map((kind) => (kind === 'worker' ? 'application' : kind));
  const expectedKinds = new Set(
    expectations.components.filter((entry) => entry.expected).map((entry) => entry.kind),
  );
  expect(
    inventoryKinds.filter((kind) => !expectedKinds.has(kind)),
    `${evidence} planCreateKinds=${JSON.stringify(planCreateKinds)}`,
  ).toEqual([]);
}

/** A successful INSTALL auto-deploys the application's newest READY release
 *  (the one `seedAppAndCustomer` builds). Waits until that deploy has set the
 *  release pointer, so a test's own deploys start on a settled deployment.
 *  That deploy consumes the first of the scenario's `updateRollouts`.
 *  Returns the auto-deployed release id. */
export async function waitForInstallAutoDeploy(
  api: Pick<DeployzApi, 'getDeployment'>,
  deploymentId: string,
): Promise<string> {
  await expect
    .poll(async () => (await api.getDeployment(deploymentId)).currentReleaseId ?? null, {
      timeout: 15_000,
      message: 'waiting for the post-install auto-deploy to set the release pointer',
    })
    .not.toBeNull();
  return (await api.getDeployment(deploymentId)).currentReleaseId as string;
}

async function signUp(request: APIRequestContext, suffix: string): Promise<void> {
  const email = `e2e-scenario-${suffix}@example.com`;
  const response = await request.post(`${API_URL}/api/auth/sign-up/email`, {
    data: { name: `E2E Scenario Vendor ${suffix}`, email, password: 'super-secret-1' },
  });
  if (!response.ok()) {
    throw new Error(`sign-up failed: ${response.status()} ${await response.text()}`);
  }
}

async function seedAppAndCustomer(
  request: APIRequestContext,
  suffix: string,
  options: { repoFullName?: string; databaseRequired?: boolean } = {},
): Promise<{ applicationId: string; customerId: string }> {
  const repoFullName = options.repoFullName ?? `deployz-demo/scenario-${suffix}`;
  const dbRequired = options.databaseRequired ?? true;
  const appResponse = await request.post(`${API_URL}/api/applications`, {
    data: {
      name: `Scenario App ${suffix}`,
      githubInstallationId: 'e2e-installation',
      repoFullName,
      repoUrl: `https://github.com/${repoFullName}`,
      defaultBranch: 'main',
      databaseRequired: dbRequired,
    },
  });
  if (!appResponse.ok()) {
    throw new Error(`create application failed: ${appResponse.status()} ${await appResponse.text()}`);
  }
  const application = (await appResponse.json()) as { id: string };

  if (options.repoFullName) {
    const analyseResponse = await request.post(`${API_URL}/api/applications/${application.id}/analyse`);
    if (!analyseResponse.ok()) {
      throw new Error(`analyse failed: ${analyseResponse.status()} ${await analyseResponse.text()}`);
    }
  }

  // Phase 2 readiness gate: ensure the test fixture application has a
  // manifest that evaluates to READY. The simulated analysis repo fixtures do
  // not carry a real Dockerfile/start command, so override them.
  // When databaseRequired is false, clear migrationCommand — Deployz rejects
  // a migration command on a stateless application (MANIFEST_NOT_COMPATIBLE).
  const patchResponse = await request.patch(`${API_URL}/api/applications/${application.id}`, {
    data: {
      containerPort: 3000,
      healthPath: '/api/health',
      ...(dbRequired ? { migrationCommand: 'npm run db:migrate' } : { migrationCommand: null }),
      appRoot: '.',
      dockerfilePath: 'Dockerfile',
      buildContext: '.',
      buildCommand: 'npm run build',
      startCommand: 'npm start',
    },
  });
  if (!patchResponse.ok()) {
    throw new Error(`patch application failed: ${patchResponse.status()} ${await patchResponse.text()}`);
  }
  await createReadyRelease(request, application.id);

  const customerResponse = await request.post(`${API_URL}/api/customers`, {
    data: {
      name: `Scenario Customer ${suffix}`,
      email: `scenario-customer-${suffix}@example.com`,
    },
  });
  if (!customerResponse.ok()) {
    throw new Error(`create customer failed: ${customerResponse.status()} ${await customerResponse.text()}`);
  }
  const customer = (await customerResponse.json()) as { id: string };

  return { applicationId: application.id, customerId: customer.id };
}

/** Seeds one real application + customer + deployment for the signed-up
 *  org, then performs the customer's "Deploy to AWS" launch signal — mirrors
 *  seedDeployment in e2e/deployment-progress.spec.ts plus the `/launched`
 *  step from e2e/install.spec.ts.
 *
 *  `repoFullName` is an additive option for the redis-failure scenario: when
 *  given, it also drives the REAL analyser (`POST /api/applications/:id/
 *  analyse`) against that GITHUB_FIXTURE_MODE repo — mirroring
 *  e2e/redis.spec.ts's seedAnalysedApplication — so `redisRequired` (and any
 *  other detected metadata) reflects production analysis instead of a
 *  hand-set flag. The analyse call runs inline (no queue configured
 *  locally), so `analysisStatus` is already COMPLETE by the time it
 *  resolves. */
async function seedAndLaunch(
  request: APIRequestContext,
  suffix: string,
  options: { repoFullName?: string; databaseRequired?: boolean } = {},
): Promise<{ deploymentId: string; installLinkId: string; enrollmentCode: string; relayCredential: string }> {
  const { applicationId, customerId } = await seedAppAndCustomer(request, suffix, options);

  const deploymentResponse = await request.post(`${API_URL}/api/deployments`, {
    data: { applicationId, customerId, region: 'us-east-1' },
  });
  if (!deploymentResponse.ok()) {
    throw new Error(`create deployment failed: ${deploymentResponse.status()} ${await deploymentResponse.text()}`);
  }
  const deployment = (await deploymentResponse.json()) as {
    id: string;
    installLinkId: string;
    enrollmentCode: string;
  };

  const launchResponse = await request.post(
    `${API_URL}/api/install/${deployment.installLinkId}/launched`,
    { data: {} },
  );
  if (!launchResponse.ok()) {
    throw new Error(`launch failed: ${launchResponse.status()} ${await launchResponse.text()}`);
  }

  // DZ-AUDIT-013: fetch the server-minted relay credential from the install page.
  const installResponse = await request.get(`${API_URL}/api/install/${deployment.installLinkId}`, {
      headers: await installLinkHeaders(request, deployment.installLinkId),
    });
  if (!installResponse.ok()) {
    throw new Error(`get install info failed: ${installResponse.status()}`);
  }
  const installBody = (await installResponse.json()) as { quickCreateUrl: string | null; enrollmentCode?: string };
  if (!installBody.quickCreateUrl) {
    throw new Error(`No quickCreateUrl for install ${deployment.installLinkId}`);
  }
  const relayCredential = extractQuickCreateParam(installBody.quickCreateUrl, 'RelayCredential');

  return {
    deploymentId: deployment.id,
    installLinkId: deployment.installLinkId,
    enrollmentCode: deployment.enrollmentCode,
    relayCredential,
  };
}

/**
 * Browser-driven sign-up for the page-based fixture below — mirrors
 * e2e/deployment-progress.spec.ts's and e2e/fleet.spec.ts's own `signUp(page)`
 * helpers exactly (same fields/labels/flow), rather than the API-only
 * `signUp` above, so the vendor's session cookie is the one the browser
 * actually holds.
 */
async function signUpViaBrowser(page: Page, suffix: string): Promise<void> {
  const email = `e2e-scenario-ui-${suffix}@example.com`;
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill(`E2E Scenario UI Vendor ${suffix}`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('super-secret-1');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL('/dashboard');
}

export interface DeployzRelayOptions {
  /** See relay-harness.ts's `StartSimulatedRelayOptions.stopAfterFirstProgress`. */
  readonly stopAfterFirstProgress?: boolean;
  /** See relay-harness.ts's `StartSimulatedRelayOptions.dieDuringDestroy`. */
  readonly dieDuringDestroy?: boolean;
  /** See relay-harness.ts's `StartSimulatedRelayOptions.failConfigureForHostnameRegex`
   *  (Phase 14 custom-domain failure scenarios). */
  readonly failConfigureForHostnameRegex?: string;
}

export const test = base.extend<{
  deployzScenario: string;
  /** Additive option (bootstrap-failure): when false, no relay is ever
   *  started — the deployment never gets past WAITING_FOR_RELAY. */
  deployzStartRelay: boolean;
  /** Additive option (relay-disconnect): extra knobs forwarded verbatim to
   *  `startSimulatedRelay`. */
  deployzRelayOptions: DeployzRelayOptions;
  /** Additive option (redis-failure): when set, the seeded application uses
   *  this GITHUB_FIXTURE_MODE repo and is run through the real analyser
   *  instead of the default synthetic repo name — see `seedAndLaunch`. */
  deployzRepoFullName: string | undefined;
  deployzInstall: DeployzInstall;
  /**
   * Page-based variant of `deployzInstall` for e2e/scenario-ui.spec.ts (Phase
   * E — browser-level UI coverage). Signs the vendor up through the real
   * browser UI (`signUpViaBrowser`, mirroring deployment-progress.spec.ts's
   * `signUp(page)`) instead of the raw API, then seeds the
   * application/customer/deployment and performs launched+register via
   * `page.request` rather than the bare `request` fixture — `seedAndLaunch`
   * and `buildApi` above already take a plain `APIRequestContext`, which
   * `page.request` also is, so no refactor was needed for them to accept it.
   * Using `page.request` (not `request`) is what makes the seeding calls ride
   * the SAME session cookie the browser holds, so the signed-up-in-the-browser
   * org is the one that owns the seeded deployment. Purely additive: the
   * request-based `deployzInstall` above is untouched.
   */
  deployzBrowserInstall: DeployzInstall;
  /** Additive (Deploy Links Phase 9): generate a deploy link via the real
   *  vendor route, then resolve + launch through the public token-header
   *  routes before the simulated relay enrolls with the deployment's
   *  enrollment code. */
  deployzLinkInstall: DeployzLinkInstall;
}>({
  // Playwright "option" fixture — settable per file/describe/test with
  // `test.use({ deployzScenario: '...' })`; defaults to the happy path.
  deployzScenario: ['happy-path', { option: true }],
  deployzStartRelay: [true, { option: true }],
  deployzRelayOptions: [{}, { option: true }],
  deployzRepoFullName: [undefined, { option: true }],

  deployzInstall: async (
    { request, deployzScenario, deployzStartRelay, deployzRelayOptions, deployzRepoFullName },
    use,
  ) => {
    const scenario = getScenario(deployzScenario);
    const suffix = crypto.randomUUID().slice(0, 8);
    await signUp(request, suffix);
    const { deploymentId, installLinkId, enrollmentCode, relayCredential } = await seedAndLaunch(
      request,
      suffix,
      {
        ...(deployzRepoFullName ? { repoFullName: deployzRepoFullName } : {}),
        databaseRequired: scenario.postgres ?? true,
      },
    );

    const installationId = `inst-${suffix}`;
    const relay = deployzStartRelay
      ? startSimulatedRelay({
          scenario,
          apiUrl: API_URL,
          installationId,
          enrollmentCode,
          relayToken: relayCredential,
          ...deployzRelayOptions,
        })
      : undefined;

    try {
      await use({
        deploymentId,
        installLinkId,
        installationId,
        enrollmentCode,
        relay,
        api: buildApi(request),
      });
    } finally {
      relay?.stop();
    }
  },

  deployzBrowserInstall: async (
    { page, deployzScenario, deployzStartRelay, deployzRelayOptions, deployzRepoFullName },
    use,
  ) => {
    const scenario = getScenario(deployzScenario);
    const suffix = crypto.randomUUID().slice(0, 8);
    await signUpViaBrowser(page, suffix);
    const { deploymentId, installLinkId, enrollmentCode, relayCredential } = await seedAndLaunch(
      page.request,
      suffix,
      {
        ...(deployzRepoFullName ? { repoFullName: deployzRepoFullName } : {}),
        databaseRequired: scenario.postgres ?? true,
      },
    );

    // Warm the two routes every scenario-ui.spec.ts test hits (the customer
    // install page and the vendor detail page — plus its diagnostics tab)
    // BEFORE starting the timed simulated relay below: Next.js dev compiles
    // each route lazily on first request, which can take several real
    // seconds — long enough to blow through a scenario's whole timeline
    // (e.g. slow-provision's ~3.5s DATABASE_STORAGE window) if that
    // first-ever compile happened to land inside it. Doing it here, before
    // the relay's clock starts, costs fixture setup time but never the
    // scenario's own timing budget.
    await page.goto(`/install/${installLinkId}`);
    await page.goto(`/dashboard/deployments/${deploymentId}`);
    await page.goto(`/dashboard/deployments/${deploymentId}/diagnostics`);

    const installationId = `inst-${suffix}`;
    const relay = deployzStartRelay
      ? startSimulatedRelay({
          scenario,
          apiUrl: API_URL,
          installationId,
          enrollmentCode,
          relayToken: relayCredential,
          ...deployzRelayOptions,
        })
      : undefined;

    try {
      await use({
        deploymentId,
        installLinkId,
        installationId,
        enrollmentCode,
        relay,
        api: buildApi(page.request),
      });
    } finally {
      relay?.stop();
    }
  },

  deployzLinkInstall: async (
    { request, deployzScenario, deployzStartRelay, deployzRelayOptions },
    use,
  ) => {
    const scenario = getScenario(deployzScenario);
    const suffix = crypto.randomUUID().slice(0, 8);
    await signUp(request, suffix);
    const { applicationId, customerId } = await seedAppAndCustomer(request, suffix, { databaseRequired: scenario.postgres ?? true });

    const generate = await request.post(`${API_URL}/api/customers/${customerId}/deploy-links`, {
      data: { applicationId, region: 'us-east-1' },
    });
    if (!generate.ok()) {
      throw new Error(`generate deploy link failed: ${generate.status()} ${await generate.text()}`);
    }
    const generated = (await generate.json()) as {
      link: { id: string };
      deployment: { id: string; enrollmentCode: string };
      token: string;
    };

    // DZ-AUDIT-013: the deployment's installLinkId is needed to fetch the
    // relay credential from the install page. GET the deployment detail via
    // the signed-up session (the deploy-link response does not include it).
    const deploymentDetail = await request.get(`${API_URL}/api/deployments/${generated.deployment.id}`);
    if (!deploymentDetail.ok()) {
      throw new Error(`get deployment detail failed: ${deploymentDetail.status()}`);
    }
    const { installLinkId } = (await deploymentDetail.json()) as { installLinkId: string };
    const installInfo = await request.get(`${API_URL}/api/install/${installLinkId}`, {
      headers: await installLinkHeaders(request, installLinkId),
    });
    if (!installInfo.ok()) {
      throw new Error(`get install info failed: ${installInfo.status()}`);
    }
    const installBody = (await installInfo.json()) as { quickCreateUrl: string | null };
    if (!installBody.quickCreateUrl) {
      throw new Error(`No quickCreateUrl for install ${installLinkId}`);
    }
    const relayCredential = extractQuickCreateParam(installBody.quickCreateUrl, 'RelayCredential');

    // The customer opens the hosted page and presses "Deploy to AWS": both
    // steps go through the PUBLIC deploy-link routes with the secret in the
    // x-deployz-token header — no session, no install link involved.
    const tokenHeaders = { 'x-deployz-token': generated.token };
    const resolveResponse = await request.get(
      `${API_URL}/api/deploy-links/${generated.link.id}`,
      { headers: tokenHeaders },
    );
    if (!resolveResponse.ok()) {
      throw new Error(`resolve deploy link failed: ${resolveResponse.status()}`);
    }
    const launch = await request.post(
      `${API_URL}/api/deploy-links/${generated.link.id}/launched`,
      { headers: tokenHeaders, data: {} },
    );
    if (!launch.ok()) {
      throw new Error(`deploy-link launch failed: ${launch.status()}`);
    }

    const installationId = `inst-${suffix}`;
    const relay = deployzStartRelay
      ? startSimulatedRelay({
          scenario,
          apiUrl: API_URL,
          installationId,
          enrollmentCode: generated.deployment.enrollmentCode,
          relayToken: relayCredential,
          ...deployzRelayOptions,
        })
      : undefined;

    try {
      await use({
        deploymentId: generated.deployment.id,
        deployLinkPublicId: generated.link.id,
        deployLinkToken: generated.token,
        enrollmentCode: generated.deployment.enrollmentCode,
        installationId,
        relay,
        api: buildApi(request),
      });
    } finally {
      relay?.stop();
    }
  },
});

export { expect } from '@playwright/test';
