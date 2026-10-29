import { expect, test, type Page } from '@playwright/test';
import { fetchInstallCredentials } from './simulation/relay-harness.js';

// Phase 5: the unified deployment-status derivation (apps/api/src/
// deployment-status.ts) exposed to three surfaces — the public customer
// install page, the vendor deployment-detail page, and the raw
// `GET /api/install/:installLinkId/status` API — that must NEVER disagree
// (the projection-consistency invariant in the status contract). This spec
// drives a SIMULATED relay over the real HTTP protocol (register / commands /
// result / health), exactly as a real relay would, mirroring the
// seed/relay conventions already established in custom-domain.spec.ts,
// app-url.spec.ts and fleet.spec.ts.

import { makeApplicationDeployable } from './seed-ready-manifest.js';
import { signInAsCustomer } from './customer-session.js';
import { sessionCookieHeader } from './install-link.js';

const API_URL = `http://localhost:${process.env.API_PORT ?? 3001}`;

// Raw AWS service terms that must NOT appear in customer-facing copy.
const JARGON = /\b(CloudFormation|IAM|ECS|ALB|Lambda|VPC)\b/;

interface RelayCommand {
  id: string;
  type: string;
}

interface CustomerStatus {
  stage: string;
  updatedAt: string;
  currentActivity: string;
  step: string;
  steps: string[];
  typicalDurationSeconds: { min: number; max: number } | null;
  takingLongerThanUsual: boolean;
  removed: boolean;
  statusUpdatesUnavailable: boolean;
  needsDomainSetup: boolean;
  components: { key: string; label: string; status: string }[];
  url: string | null;
  failure: {
    customerMessage: string;
    component: string | null;
    reference: string;
    technical: { stage: string; component: string | null; awsStatus: string | null } | null;
  } | null;
}

async function signUp(page: Page): Promise<void> {
  const email = `e2e-progress-${crypto.randomUUID().slice(0, 8)}@example.com`;
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill('E2E Progress Vendor');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('super-secret-1');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL('/dashboard');
}

/** Seeds one real application + customer + deployment for the signed-up org. */
async function seedDeployment(
  page: Page,
  suffix: string,
): Promise<{
  deploymentId: string;
  installLinkId: string;
  applicationName: string;
  installationId: string;
  enrollmentCode: string;
  customerEmail: string;
}> {
  const appResponse = await page.request.post(`${API_URL}/api/applications`, {
    data: {
      name: `Progress App ${suffix}`,
      githubInstallationId: 'e2e-installation',
      repoFullName: `deployz-demo/progress-${suffix}`,
      repoUrl: `https://github.com/deployz-demo/progress-${suffix}`,
      defaultBranch: 'main',
      // A database-requiring app exercises the DATABASE_STORAGE step (see
      // the provisioning-snapshot round trip in the happy-path test below).
      databaseRequired: true,
    },
  });
  expect(appResponse.ok()).toBeTruthy();
  const application = (await appResponse.json()) as { id: string; name: string };
  await makeApplicationDeployable(page.request, application.id);

  const customerResponse = await page.request.post(`${API_URL}/api/customers`, {
    data: { name: `Progress Customer ${suffix}`, email: `progress-customer-${suffix}@example.com` },
  });
  expect(customerResponse.ok()).toBeTruthy();
  const customer = (await customerResponse.json()) as { id: string };

  const deploymentResponse = await page.request.post(`${API_URL}/api/deployments`, {
    data: { applicationId: application.id, customerId: customer.id, region: 'us-east-1' },
  });
  expect(deploymentResponse.ok()).toBeTruthy();
  const deployment = (await deploymentResponse.json()) as {
    id: string;
    installLinkId: string;
  };

  const { enrollmentCode } = await fetchInstallCredentials(
    API_URL,
    deployment.installLinkId,
    await sessionCookieHeader(page.request),
  );

  return {
    deploymentId: deployment.id,
    installLinkId: deployment.installLinkId,
    applicationName: application.name,
    installationId: `inst-${suffix}`,
    enrollmentCode,
    customerEmail: `progress-customer-${suffix}@example.com`,
  };
}

async function fetchStatus(page: Page, installLinkId: string): Promise<CustomerStatus> {
  const response = await page.request.get(`${API_URL}/api/install/${installLinkId}/status`);
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as CustomerStatus;
}

async function fetchRelayCommands(
  page: Page,
  installationId: string,
  relayAuth: Record<string, string>,
): Promise<RelayCommand[]> {
  const response = await page.request.get(
    `${API_URL}/api/relay/commands?installationId=${installationId}`,
    { headers: relayAuth },
  );
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as { commands: RelayCommand[] };
  return body.commands;
}

async function postRelayResult(
  page: Page,
  jobId: string,
  relayAuth: Record<string, string>,
  data: Record<string, unknown>,
): Promise<void> {
  const response = await page.request.post(`${API_URL}/api/relay/commands/${jobId}/result`, {
    headers: relayAuth,
    data,
  });
  expect(response.ok()).toBeTruthy();
}

/**
 * Polls the status API for `stage`, then re-fetches both the customer install
 * page and the vendor deployment-detail page from fresh navigations (both
 * routes derive their own server truth per request — see InstallPage's
 * `force-dynamic` and the detail page's fetch-on-mount) and asserts they show
 * the matching customer headline / vendor stage label. This is the
 * three-surface consistency invariant under test.
 */
async function expectStageEverywhere(
  page: Page,
  opts: {
    installLinkId: string;
    deploymentId: string;
    stage: string;
    customerHeading: string | RegExp;
    vendorLabel: string;
  },
): Promise<void> {
  await expect
    .poll(async () => (await fetchStatus(page, opts.installLinkId)).stage, {
      timeout: 15_000,
      message: `waiting for status API stage ${opts.stage}`,
    })
    .toBe(opts.stage);

  await page.goto(`/install/${opts.installLinkId}`);
  await expect(page.getByRole('heading', { name: opts.customerHeading })).toBeVisible({
    timeout: 15_000,
  });

  await page.goto(`/dashboard/deployments/${opts.deploymentId}`);
  const progressCard = page.locator('section[aria-labelledby="deployment-progress"]');
  // The vendor headline sits in the hero's one `aria-live` element — targeted
  // directly rather than by text, since a status row can carry the same
  // word and turn a plain text search into a strict-mode multi-match failure.
  await expect(progressCard.locator('[aria-live="polite"]')).toHaveText(opts.vendorLabel, {
    timeout: 15_000,
  });
}

test('happy path: WAITING_FOR_AWS -> CONNECTING -> PROVISIONING -> VERIFYING -> READY agree on all three surfaces', async ({
  page,
}) => {
  // Many relay round trips and a full custom-domain cycle — the default 60s
  // budget is too tight (see custom-domain.spec.ts's own override).
  test.setTimeout(120_000);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);

  const suffix = crypto.randomUUID().slice(0, 8);
  await signUp(page);
  const { deploymentId, installLinkId, installationId, enrollmentCode } = await seedDeployment(
    page,
    suffix,
  );
  // DZ-AUDIT-013: the relay presents the server-minted credential from the
  // Quick Create URL (a real relay reads it from the stack's secret).
  const { relayCredential } = await fetchInstallCredentials(API_URL, installLinkId, await sessionCookieHeader(page.request));
  const relayAuth = { Authorization: `Bearer ${relayCredential}` };

  // ── 1. Freshly seeded: nothing has enrolled yet.
  await expectStageEverywhere(page, {
    installLinkId,
    deploymentId,
    stage: 'WAITING_FOR_AWS',
    // The customer has not launched the install yet: the customer card says
    // what to do (press Deploy to AWS) and the vendor hero says what to do
    // (send the link) — neither claims AWS is working.
    // The pre-launch page (nothing in AWS yet) leads with the deploy
    // invitation, not a progress headline.
    customerHeading: /^Deploy .* to your AWS account$/,
    vendorLabel: 'Waiting for your customer to install',
  });
  await page.goto(`/install/${installLinkId}`);
  await expect(page.getByRole('link', { name: 'Connect AWS account' })).toBeVisible();

  // ── 2. Relay registers (spends the enrollment code, creates the INSTALL
  // job in REQUESTED state).
  const registerResponse = await page.request.post(`${API_URL}/api/relay/register`, {
    headers: relayAuth,
    data: { installationId, enrollmentCode, awsAccountId: '123456789012' },
  });
  expect(registerResponse.ok()).toBeTruthy();

  await expectStageEverywhere(page, {
    installLinkId,
    deploymentId,
    stage: 'CONNECTING',
    customerHeading: 'Connecting your AWS account',
    vendorLabel: 'Connecting to AWS',
  });
  // The enrollment code is spent — running the setup again would fail after
  // the customer already approved a stack, so the CTA is gone entirely.
  await page.goto(`/install/${installLinkId}`);
  await expect(page.getByRole('link', { name: 'Connect AWS account' })).toHaveCount(0);

  // ── 3. Relay polls for commands: the queued INSTALL job flips to RUNNING.
  const round1 = await fetchRelayCommands(page, installationId, relayAuth);
  const installJob = round1.find((command) => command.type === 'INSTALL');
  expect(installJob).toBeDefined();

  await expectStageEverywhere(page, {
    installLinkId,
    deploymentId,
    stage: 'PROVISIONING',
    customerHeading: 'Creating application infrastructure',
    vendorLabel: 'Deploying',
  });

  // ── 3b. A relay heartbeat reports a mid-PROVISIONING snapshot: the network
  // has finished, the database is still being created. The step derivation
  // (apps/api/src/deployment-status.ts) reads this straight off
  // observedState.infraHealth.provisioning — the richer-steps feature under
  // test — and advances the step from PREPARING to DATABASE_STORAGE.
  const provisioningObservedAt = Date.now();
  const networkStartedAt = new Date(provisioningObservedAt - 5 * 60_000).toISOString();
  const networkCompletedAt = new Date(provisioningObservedAt - 3 * 60_000).toISOString();
  const databaseStartedAt = new Date(provisioningObservedAt - 60_000).toISOString();
  const provisioningSnapshotResponse = await page.request.post(`${API_URL}/api/relay/health`, {
    headers: relayAuth,
    data: {
      installationId,
      observedState: {
        infraHealth: {
          provisioning: {
            stackStatus: 'CREATE_IN_PROGRESS',
            observedAt: new Date(provisioningObservedAt).toISOString(),
            categories: {
              network: { status: 'COMPLETE', startedAt: networkStartedAt, completedAt: networkCompletedAt },
              database: { status: 'IN_PROGRESS', startedAt: databaseStartedAt },
            },
          },
        },
      },
    },
  });
  expect(provisioningSnapshotResponse.ok()).toBeTruthy();

  await expect
    .poll(async () => (await fetchStatus(page, installLinkId)).step, {
      timeout: 15_000,
      message: 'waiting for the derived step to advance to DATABASE_STORAGE',
    })
    .toBe('DATABASE_STORAGE');

  // Customer and vendor agree on the same active-step label, and the
  // customer sees the step's typical-duration nudge — never a percentage or
  // a countdown.
  await page.goto(`/install/${installLinkId}`);
  await expect(page.getByText('Creating database & storage')).toBeVisible();
  await expect(page.getByText(/Usually takes/)).toBeVisible();
  const installPageText = await page.locator('body').innerText();
  expect(installPageText).not.toContain('%');
  expect(installPageText.toLowerCase()).not.toContain('remaining');

  await page.goto(`/dashboard/deployments/${deploymentId}`);
  const stepProgressCard = page.locator('section[aria-labelledby="deployment-progress"]');
  await expect(stepProgressCard.getByText('Creating database & storage')).toBeVisible();

  // A reload re-derives the same step from the same persisted signals.
  await page.reload();
  await expect(stepProgressCard.getByText('Creating database & storage')).toBeVisible();

  // ── 4. Relay reports the INSTALL a success, with the ALB endpoint output
  // that resolveAppUrl uses for the (still HTTP-only) app URL.
  const albEndpoint = `deployz-alb-${suffix}.us-east-1.elb.amazonaws.com`;
  await postRelayResult(page, installJob!.id, relayAuth, {
    success: true,
    output: { outputs: { ExportDeployzApplicationPublicEndpoint: albEndpoint } },
  });

  await expectStageEverywhere(page, {
    installLinkId,
    deploymentId,
    stage: 'VERIFYING',
    customerHeading: 'Checking your application',
    vendorLabel: 'Verifying your application',
  });
  const verifyingStatus = await fetchStatus(page, installLinkId);
  expect(verifyingStatus.needsDomainSetup).toBe(false);

  // ── 5. Relay heartbeat reports the app healthy. Still VERIFYING — the app
  // is only reachable over HTTP so far — but now with the domain-setup nudge.
  // Healthy now means evidence: every workload of the frozen spec runs one
  // digest at full capacity, the web targets are healthy, and a fresh probe
  // succeeded.
  const commandsResponse = await page.request.get(
    `${API_URL}/api/relay/commands?installationId=${installationId}`,
    { headers: relayAuth },
  );
  expect(commandsResponse.ok()).toBeTruthy();
  const { deployment: deploymentMeta } = (await commandsResponse.json()) as {
    deployment: { workloads: { id: string; serviceLogicalId: string }[] };
  };
  const checkedAt = new Date().toISOString();
  const healthResponse = await page.request.post(`${API_URL}/api/relay/health`, {
    headers: relayAuth,
    data: {
      installationId,
      healthStatus: 'HEALTHY',
      observedState: {
        releaseEvidence: {
          version: 1,
          observedAt: checkedAt,
          services: deploymentMeta.workloads.map((workload) => ({
            workloadId: workload.id,
            serviceLogicalId: workload.serviceLogicalId,
            observed: true,
            desiredCount: 1,
            runningCount: 1,
            rolloutState: 'COMPLETED',
            runningDigests: ['sha256:progress'],
            targets:
              workload.id === 'web' ? { healthy: 1, unhealthy: 0, pending: 0, unknown: 0 } : null,
          })),
          httpProbe: { ok: true, status: 200, checkedAt },
        },
      },
    },
  });
  expect(healthResponse.ok()).toBeTruthy();

  // Still VERIFYING on the wire, but the app is confirmed healthy and
  // reachable, so the vendor hero already reads as live (with the
  // custom-domain nudge in its description).
  await expectStageEverywhere(page, {
    installLinkId,
    deploymentId,
    stage: 'VERIFYING',
    customerHeading: 'Checking your application',
    vendorLabel: 'Your application is live',
  });
  const healthyHttpOnlyStatus = await fetchStatus(page, installLinkId);
  expect(healthyHttpOnlyStatus.needsDomainSetup).toBe(true);
  await page.goto(`/install/${installLinkId}`);
  await expect(page.getByText(/Set up a custom domain below for a secure address/)).toBeVisible();

  // ── 6. Drive a custom domain to ACTIVE (the fixture DNS/HTTPS flow — see
  // custom-domain.spec.ts). READY requires an https:// URL, and the base
  // install alone is always HTTP-only, so this is the only path to READY.
  const hostname = `app.${suffix}.deployz-fixture.test`;
  const card = page.getByTestId('custom-domain-card');
  await expect(card.getByRole('button', { name: 'Set up custom domain' })).toBeVisible();
  await card.getByRole('button', { name: 'Set up custom domain' }).click();
  const addPanel = page.getByTestId('add-domain-panel');
  await addPanel.getByLabel('Domain').fill(hostname);
  await addPanel.getByRole('button', { name: 'Add domain' }).click();
  await expect(card.getByText('Setting up', { exact: true })).toBeVisible();

  const domainRound1 = await fetchRelayCommands(page, installationId, relayAuth);
  const configureJob1 = domainRound1.find((command) => command.type === 'CONFIGURE_DOMAIN');
  expect(configureJob1).toBeDefined();
  await postRelayResult(page, configureJob1!.id, relayAuth, {
    success: true,
    output: {
      certificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/e2e-progress',
      certificateStatus: 'PENDING_VALIDATION',
      validationName: `_e2e.app.${suffix}.deployz-fixture.test`,
      validationValue: '_e2e.acm-validations.aws.deployz-fixture.test',
      routingTarget: 'e2e-alb.deployz-fixture.test',
      httpsConfigured: false,
    },
  });
  await expect(card.getByText('Waiting for DNS', { exact: true })).toBeVisible({ timeout: 10_000 });

  await card.getByRole('button', { name: 'Check now' }).click();
  let domainRound2: RelayCommand[] = [];
  await expect
    .poll(
      async () => {
        domainRound2 = await fetchRelayCommands(page, installationId, relayAuth);
        return domainRound2.filter((command) => command.type === 'CONFIGURE_DOMAIN').length;
      },
      { timeout: 10_000, message: 'waiting for relay round 2 CONFIGURE_DOMAIN job' },
    )
    .toBe(1);
  const configureJob2 = domainRound2.find((command) => command.type === 'CONFIGURE_DOMAIN')!;
  await postRelayResult(page, configureJob2.id, relayAuth, {
    success: true,
    output: {
      certificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/e2e-progress',
      certificateStatus: 'ISSUED',
      routingTarget: 'e2e-alb.deployz-fixture.test',
      httpsConfigured: true,
    },
  });
  await expect(card.getByText('Connecting', { exact: true })).toBeVisible({ timeout: 10_000 });

  await card.getByRole('button', { name: 'Check now' }).click();
  await expect(card.getByText('Active', { exact: true })).toBeVisible({ timeout: 10_000 });

  // ── 7. All three surfaces now agree on READY with the https:// URL.
  await expectStageEverywhere(page, {
    installLinkId,
    deploymentId,
    stage: 'READY',
    customerHeading: 'Your application is ready',
    vendorLabel: 'Your application is live',
  });
  const readyStatus = await fetchStatus(page, installLinkId);
  expect(readyStatus.url).toBe(`https://${hostname}`);
  await page.goto(`/install/${installLinkId}`);
  await expect(page.getByRole('link', { name: 'Open application' })).toHaveAttribute(
    'href',
    `https://${hostname}`,
  );
});

test('failure path: a failed INSTALL shows a customer-safe message with no jargon or leaked credentials', async ({
  page,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8);
  await signUp(page);
  const { deploymentId, installLinkId, installationId, enrollmentCode } = await seedDeployment(
    page,
    suffix,
  );
  const { relayCredential } = await fetchInstallCredentials(API_URL, installLinkId, await sessionCookieHeader(page.request));
  const relayAuth = { Authorization: `Bearer ${relayCredential}` };

  const registerResponse = await page.request.post(`${API_URL}/api/relay/register`, {
    headers: relayAuth,
    data: { installationId, enrollmentCode },
  });
  expect(registerResponse.ok()).toBeTruthy();

  const commands = await fetchRelayCommands(page, installationId, relayAuth);
  const installJob = commands.find((command) => command.type === 'INSTALL');
  expect(installJob).toBeDefined();

  await postRelayResult(page, installJob!.id, relayAuth, {
    success: false,
    failureCode: 'DATABASE_CREATE_FAILED',
    stackStatus: 'CREATE_FAILED',
    error: 'internal: RDS CreateDBInstance timed out after 900s (should never reach the customer)',
  });

  await expect
    .poll(async () => (await fetchStatus(page, installLinkId)).stage, { timeout: 15_000 })
    .toBe('FAILED');

  await page.goto(`/install/${installLinkId}`);
  await expect(page.getByRole('heading', { name: 'Deployment failed' })).toBeVisible();
  await expect(page.getByText('What happened', { exact: true })).toBeVisible();
  await expect(page.getByText("The database couldn't be created.")).toBeVisible();

  const bodyText = await page.locator('body').innerText();
  expect(bodyText).not.toMatch(JARGON);

  // Technical details are collapsed by default. §65 keeps the raw
  // CloudFormation enum off the customer surface even when expanded — the
  // panel shows the jargon-free phrase (customerStackStatusLabel) instead.
  const reference = page.getByText(/^DEP-[0-9A-F]{8}$/);
  await expect(reference).toHaveCount(0);
  await expect(page.getByText('CREATE_FAILED', { exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: 'Technical details' }).click();
  await expect(reference).toBeVisible();
  await expect(page.getByText('Infrastructure', { exact: true })).toBeVisible();
  await expect(page.getByText('Setup did not complete', { exact: true })).toBeVisible();
  await expect(page.getByText('CREATE_FAILED', { exact: true })).toHaveCount(0);

  // No enrollment code, relay bearer token, or the leaked internal error
  // string ever reach the DOM — the customer projection strips all of it.
  const html = await page.content();
  expect(html).not.toContain(enrollmentCode);
  expect(html).not.toContain('e2e-progress-fail');
  expect(html).not.toContain('RDS CreateDBInstance');

  // Vendor detail: the failed headline + the gated retry action. Targeted at
  // the hero's one `aria-live` element rather than by text.
  await page.goto(`/dashboard/deployments/${deploymentId}`);
  const progressCard = page.locator('section[aria-labelledby="deployment-progress"]');
  await expect(progressCard.locator('[aria-live="polite"]')).toHaveText('Install failed');
  await expect(page.getByRole('button', { name: 'Retry deployment' })).toBeVisible();
});

test('refresh and reopen: a mid-flow stage renders identically from server truth', async ({
  page,
  browser,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8);
  await signUp(page);
  const { installLinkId, installationId, enrollmentCode, customerEmail } = await seedDeployment(page, suffix);
  const { relayCredential } = await fetchInstallCredentials(API_URL, installLinkId, await sessionCookieHeader(page.request));
  const relayAuth = { Authorization: `Bearer ${relayCredential}` };

  const registerResponse = await page.request.post(`${API_URL}/api/relay/register`, {
    headers: relayAuth,
    data: { installationId, enrollmentCode },
  });
  expect(registerResponse.ok()).toBeTruthy();
  const commands = await fetchRelayCommands(page, installationId, relayAuth);
  expect(commands.find((command) => command.type === 'INSTALL')).toBeDefined();

  await expect
    .poll(async () => (await fetchStatus(page, installLinkId)).stage, { timeout: 15_000 })
    .toBe('PROVISIONING');

  await page.goto(`/install/${installLinkId}`);
  await expect(
    page.getByRole('heading', { name: 'Creating application infrastructure' }),
  ).toBeVisible();

  // A plain reload re-runs the server component: same stage, no regression.
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Creating application infrastructure' }),
  ).toBeVisible();

  // A brand-new browser context (no client-side state at all), signed in as
  // the owner, sees the exact same server-derived stage.
  const freshContext = await browser.newContext();
  const freshPage = await freshContext.newPage();
  await signInAsCustomer(freshPage.request, installLinkId, customerEmail);
  await freshPage.goto(`/install/${installLinkId}`);
  await expect(
    freshPage.getByRole('heading', { name: 'Creating application infrastructure' }),
  ).toBeVisible();
  await freshContext.close();
});

test('status API: 404s on unknown/malformed ids, and a live one matches the customer wire shape', async ({
  request,
}) => {
  const unknown = await request.get(`${API_URL}/api/install/${crypto.randomUUID()}/status`);
  expect(unknown.status()).toBe(404);

  const malformed = await request.get(`${API_URL}/api/install/not-a-real-id/status`);
  expect(malformed.status()).toBe(404);

  // A real deployment, seeded through the vendor's API session, which the
  // status route also accepts (docs/customer-access.md).
  const suffix = crypto.randomUUID().slice(0, 8);
  const email = `e2e-progress-api-${suffix}@example.com`;
  const signUpResponse = await request.post(`${API_URL}/api/auth/sign-up/email`, {
    data: { name: `Progress API Vendor ${suffix}`, email, password: 'super-secret-1' },
  });
  expect(signUpResponse.ok()).toBeTruthy();
  const appResponse = await request.post(`${API_URL}/api/applications`, {
    data: {
      name: `Progress API App ${suffix}`,
      githubInstallationId: 'e2e-installation',
      repoFullName: `deployz-demo/progress-api-${suffix}`,
      repoUrl: `https://github.com/deployz-demo/progress-api-${suffix}`,
      defaultBranch: 'main',
    },
  });
  expect(appResponse.ok()).toBeTruthy();
  const application = (await appResponse.json()) as { id: string };
  await makeApplicationDeployable(request, application.id);
  const customerResponse = await request.post(`${API_URL}/api/customers`, {
    data: { name: `Progress API Customer ${suffix}`, email: `progress-api-customer-${suffix}@example.com` },
  });
  expect(customerResponse.ok()).toBeTruthy();
  const customer = (await customerResponse.json()) as { id: string };
  const deploymentResponse = await request.post(`${API_URL}/api/deployments`, {
    data: { applicationId: application.id, customerId: customer.id, region: 'us-east-1' },
  });
  expect(deploymentResponse.ok()).toBeTruthy();
  const deployment = (await deploymentResponse.json()) as { installLinkId: string };

  const liveResponse = await request.get(`${API_URL}/api/install/${deployment.installLinkId}/status`);
  expect(liveResponse.ok()).toBeTruthy();
  const body = (await liveResponse.json()) as Record<string, unknown>;

  const SIX_STAGES = ['WAITING_FOR_AWS', 'CONNECTING', 'PROVISIONING', 'VERIFYING', 'READY', 'FAILED'];
  expect(SIX_STAGES).toContain(body['stage']);
  expect(typeof body['updatedAt']).toBe('string');
  expect(typeof body['currentActivity']).toBe('string');
  expect(typeof body['removed']).toBe('boolean');
  expect(typeof body['statusUpdatesUnavailable']).toBe('boolean');
  expect(typeof body['needsDomainSetup']).toBe('boolean');
  expect(Array.isArray(body['components'])).toBe(true);
  expect(body['url']).toBeNull();
  expect(body['failure']).toBeNull();

  // Never any relay/job/account identity on this customer projection.
  const serialized = JSON.stringify(body);
  for (const forbidden of ['awsAccountId', 'enrollmentCode', 'installationId', 'relayTokenHash', 'token']) {
    expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
  }
});

test('consistency under relay silence: a confirmed stage never regresses on reload', async ({
  page,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8);
  await signUp(page);
  const { installLinkId, installationId, enrollmentCode } = await seedDeployment(page, suffix);
  const { relayCredential } = await fetchInstallCredentials(API_URL, installLinkId, await sessionCookieHeader(page.request));
  const relayAuth = { Authorization: `Bearer ${relayCredential}` };

  const registerResponse = await page.request.post(`${API_URL}/api/relay/register`, {
    headers: relayAuth,
    data: { installationId, enrollmentCode },
  });
  expect(registerResponse.ok()).toBeTruthy();
  const commands = await fetchRelayCommands(page, installationId, relayAuth);
  const installJob = commands.find((command) => command.type === 'INSTALL');
  expect(installJob).toBeDefined();

  const albEndpoint = `deployz-alb-${suffix}.us-east-1.elb.amazonaws.com`;
  await postRelayResult(page, installJob!.id, relayAuth, {
    success: true,
    output: { outputs: { ExportDeployzApplicationPublicEndpoint: albEndpoint } },
  });

  await expect
    .poll(async () => (await fetchStatus(page, installLinkId)).stage, { timeout: 15_000 })
    .toBe('VERIFYING');

  await page.goto(`/install/${installLinkId}`);
  await expect(page.getByRole('heading', { name: 'Checking your application' })).toBeVisible();

  // No further relay activity at all — reload a few times and confirm the
  // confirmed VERIFYING stage holds. It must never fall back to
  // WAITING_FOR_AWS/CONNECTING just because nothing new has happened.
  for (let i = 0; i < 3; i++) {
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Checking your application' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Setting up your AWS connection' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Connecting your AWS account' })).toHaveCount(0);
  }

  const finalStatus = await fetchStatus(page, installLinkId);
  expect(finalStatus.stage).toBe('VERIFYING');
});
