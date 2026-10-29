import { expect, test, type Page } from '@playwright/test';
import { fetchInstallCredentials } from './simulation/relay-harness.js';

// Task 10: fixture-mode e2e for the CloudFormation progress-events feature.
// Drives the relay's new stack-event progress ingest
// (`POST /api/relay/commands/:jobId/progress`) over the real HTTP protocol,
// exactly as deployment-progress.spec.ts drives register/commands/result —
// this file clones that model's setup helpers rather than inventing a new
// path, and adds only what the new endpoints/UI need: posting a raw event
// batch and reading it back from the vendor `GET .../stack-events` route and
// the vendor-only "Infrastructure events" disclosure
// (apps/web/src/components/infrastructure-events.tsx).

import { makeApplicationDeployable } from './seed-ready-manifest.js';
import { sessionCookieHeader } from './install-link.js';

const API_URL = `http://localhost:${process.env.API_PORT ?? 3001}`;

// Raw AWS service terms that must NOT appear in customer-facing copy.
const JARGON = /\b(CloudFormation|IAM|ECS|ALB|Lambda|VPC)\b/;

test.describe.configure({ mode: 'serial' });

interface RelayCommand {
  id: string;
  type: string;
}

interface CustomerStatus {
  stage: string;
}

interface StackEventInput {
  eventId: string;
  timestamp: string;
  logicalResourceId: string;
  resourceType: string;
  resourceStatus: string;
  resourceStatusReason?: string;
}

async function signUp(page: Page): Promise<void> {
  const email = `e2e-stack-events-${crypto.randomUUID().slice(0, 8)}@example.com`;
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill('E2E Stack Events Vendor');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('super-secret-1');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL('/dashboard');
}

/** Seeds one real application + customer + deployment for the signed-up org
 *  (mirrors deployment-progress.spec.ts's seedDeployment). databaseRequired
 *  is on so an RDS progress event lands in a real DATABASE_STORAGE step. */
async function seedDeployment(
  page: Page,
  suffix: string,
): Promise<{
  deploymentId: string;
  installLinkId: string;
  installationId: string;
  enrollmentCode: string;
}> {
  const appResponse = await page.request.post(`${API_URL}/api/applications`, {
    data: {
      name: `Stack Events App ${suffix}`,
      githubInstallationId: 'e2e-installation',
      repoFullName: `deployz-demo/stack-events-${suffix}`,
      repoUrl: `https://github.com/deployz-demo/stack-events-${suffix}`,
      defaultBranch: 'main',
      databaseRequired: true,
    },
  });
  expect(appResponse.ok()).toBeTruthy();
  const application = (await appResponse.json()) as { id: string };
  await makeApplicationDeployable(page.request, application.id);

  const customerResponse = await page.request.post(`${API_URL}/api/customers`, {
    data: { name: `Stack Events Customer ${suffix}`, email: `stack-events-customer-${suffix}@example.com` },
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
    installationId: `inst-${suffix}`,
    enrollmentCode,
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

/** POSTs a stack-event progress batch (the wire shape relayCommandProgressSchema
 *  validates — see packages/contracts/src/index.ts) and returns `{accepted}`. */
async function postRelayProgress(
  page: Page,
  jobId: string,
  relayAuth: Record<string, string>,
  data: { commandId: string; installationId: string; stackName: string; events: StackEventInput[] },
): Promise<{ accepted: number }> {
  const response = await page.request.post(`${API_URL}/api/relay/commands/${jobId}/progress`, {
    headers: relayAuth,
    data,
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { accepted: number };
}

/** Reads back the vendor diagnostics feed (session-authenticated). */
async function fetchVendorStackEvents(page: Page, deploymentId: string): Promise<unknown[]> {
  const response = await page.request.get(`${API_URL}/api/deployments/${deploymentId}/stack-events`);
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as { events: unknown[] };
  return body.events;
}

/** Five subnet events under one logical network — this is the "five raw
 *  resources fold into one phase row" fixture for scenario 2. */
function subnetEvents(idPrefix: string, resourceStatus: string): StackEventInput[] {
  const logicalIds = ['PublicSubnet1', 'PublicSubnet2', 'PublicSubnet3', 'PrivateSubnet1', 'PrivateSubnet2'];
  return logicalIds.map((logicalResourceId, index) => ({
    eventId: `${idPrefix}-${logicalResourceId}`,
    timestamp: new Date(Date.now() + index).toISOString(),
    logicalResourceId,
    resourceType: 'AWS::EC2::Subnet',
    resourceStatus,
  }));
}

function rdsEvent(idPrefix: string, resourceStatus: string, resourceStatusReason?: string): StackEventInput {
  return {
    eventId: `${idPrefix}-ApplicationDatabase`,
    timestamp: new Date().toISOString(),
    logicalResourceId: 'ApplicationDatabase',
    resourceType: 'AWS::RDS::DBInstance',
    resourceStatus,
    ...(resourceStatusReason ? { resourceStatusReason } : {}),
  };
}

function stackEvent(idPrefix: string, stackName: string, resourceStatus: string): StackEventInput {
  return {
    eventId: `${idPrefix}-stack`,
    timestamp: new Date().toISOString(),
    logicalResourceId: stackName,
    resourceType: 'AWS::CloudFormation::Stack',
    resourceStatus,
  };
}

test('progress events: a batch ingest shows one active phase, expands to raw events, dedupes, and persists across reload', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const suffix = crypto.randomUUID().slice(0, 8);
  const stackName = `deployz-stack-events-${suffix}`;
  await signUp(page);
  const { deploymentId, installLinkId, installationId, enrollmentCode } = await seedDeployment(page, suffix);
  // DZ-AUDIT-013: the relay presents the server-minted credential from the Quick Create URL.
  const { relayCredential } = await fetchInstallCredentials(API_URL, installLinkId, await sessionCookieHeader(page.request));
  const relayAuth = { Authorization: `Bearer ${relayCredential}` };

  // ── 1. Register the relay and fetch the INSTALL command — flips the job
  // to RUNNING, same as deployment-progress.spec.ts's happy path.
  const registerResponse = await page.request.post(`${API_URL}/api/relay/register`, {
    headers: relayAuth,
    data: { installationId, enrollmentCode },
  });
  expect(registerResponse.ok()).toBeTruthy();
  const commands = await fetchRelayCommands(page, installationId, relayAuth);
  const installJob = commands.find((command) => command.type === 'INSTALL');
  expect(installJob).toBeDefined();

  await expect
    .poll(async () => (await fetchStatus(page, installLinkId)).stage, { timeout: 15_000 })
    .toBe('PROVISIONING');

  // ── 2. POST a progress batch: 5 subnet + 1 RDS + the stack itself, all
  // CREATE_IN_PROGRESS (7 events).
  const batch = [
    ...subnetEvents(`${suffix}-b1`, 'CREATE_IN_PROGRESS'),
    rdsEvent(`${suffix}-b1`, 'CREATE_IN_PROGRESS'),
    stackEvent(`${suffix}-b1`, stackName, 'CREATE_IN_PROGRESS'),
  ];
  const firstPost = await postRelayProgress(page, installJob!.id, relayAuth, {
    commandId: installJob!.id,
    installationId,
    stackName,
    events: batch,
  });
  expect(firstPost.accepted).toBe(7);

  // Vendor detail page: one NETWORK phase row is active — never a
  // per-resource row outside the collapsed disclosure.
  await page.goto(`/dashboard/deployments/${deploymentId}`);
  const progressCard = page.locator('section[aria-labelledby="deployment-progress"]');
  await expect(progressCard.getByText('Creating network')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('PublicSubnet1')).toHaveCount(0);

  // Expand "Infrastructure events" — the raw per-resource rows only live
  // inside this collapsed disclosure, itself inside the collapsed Advanced
  // details section.
  await page.getByRole('button', { name: 'Technical details' }).click();
  const eventsTrigger = page.getByRole('button', { name: /Infrastructure events \(7\)/ });
  await expect(eventsTrigger).toBeVisible({ timeout: 15_000 });
  await eventsTrigger.click();
  await expect(page.getByText('PublicSubnet1')).toBeVisible();
  await expect(page.getByText('ApplicationDatabase')).toBeVisible();

  // ── 3. Customer install page: the step list reflects the same ingested
  // NETWORK progress (not just the coarse PROVISIONING heading). The
  // infrastructure rung's label follows its own state — "Creating
  // infrastructure" — and the NETWORK substep under it carries the same
  // active/sr-only state pattern, so it reads "Creating network (in
  // progress)". No raw AWS jargon anywhere.
  await page.goto(`/install/${installLinkId}`);
  await expect(
    page.getByRole('heading', { name: 'Creating application infrastructure' }),
  ).toBeVisible();
  await expect(page.getByText('Creating infrastructure (in progress)')).toBeVisible();
  await page.getByRole('button', { name: 'Deployment details' }).click();
  await expect(page.getByText('Creating network (in progress)')).toBeVisible();
  await page.getByRole('button', { name: 'Deployment details' }).click();
  const installPageText = await page.locator('body').innerText();
  expect(installPageText).not.toMatch(JARGON);

  // ── 4. Re-POST the identical batch: nothing new is accepted, and the
  // vendor's stored row count doesn't grow.
  const secondPost = await postRelayProgress(page, installJob!.id, relayAuth, {
    commandId: installJob!.id,
    installationId,
    stackName,
    events: batch,
  });
  expect(secondPost.accepted).toBe(0);
  const storedEvents = await fetchVendorStackEvents(page, deploymentId);
  expect(storedEvents).toHaveLength(7);

  // ── 5. Refresh persistence on both surfaces.
  await page.goto(`/dashboard/deployments/${deploymentId}`);
  await expect(progressCard.getByText('Creating network')).toBeVisible({ timeout: 15_000 });
  await page.reload();
  await expect(progressCard.getByText('Creating network')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Technical details' }).click();
  await expect(page.getByRole('button', { name: /Infrastructure events \(7\)/ })).toBeVisible({
    timeout: 15_000,
  });

  await page.goto(`/install/${installLinkId}`);
  await expect(
    page.getByRole('heading', { name: 'Creating application infrastructure' }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Creating application infrastructure' }),
  ).toBeVisible();
});

test('failure path: a genuine CREATE_FAILED stack event stays behind the technical disclosures while the customer sees the friendly failure', async ({
  page,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const stackName = `deployz-stack-events-fail-${suffix}`;
  const rawReason = 'Instance class db.t3.micro is not supported in this Availability Zone';
  await signUp(page);
  const { deploymentId, installLinkId, installationId, enrollmentCode } = await seedDeployment(page, suffix);
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

  // A genuine resource failure (not a cancellation echo) plus the stack
  // rolling back.
  const failureBatch = [
    rdsEvent(`${suffix}-fail`, 'CREATE_FAILED', rawReason),
    stackEvent(`${suffix}-fail`, stackName, 'ROLLBACK_IN_PROGRESS'),
  ];
  const progressPost = await postRelayProgress(page, installJob!.id, relayAuth, {
    commandId: installJob!.id,
    installationId,
    stackName,
    events: failureBatch,
  });
  expect(progressPost.accepted).toBe(2);

  await postRelayResult(page, installJob!.id, relayAuth, {
    success: false,
    failureCode: 'DATABASE_CREATE_FAILED',
    stackStatus: 'ROLLBACK_COMPLETE',
    error: 'internal: RDS CreateDBInstance failed (should never reach the customer)',
  });

  await expect
    .poll(async () => (await fetchStatus(page, installLinkId)).stage, { timeout: 15_000 })
    .toBe('FAILED');

  // Customer: friendly failure copy, no jargon, no raw reason leaked.
  await page.goto(`/install/${installLinkId}`);
  await expect(page.getByRole('heading', { name: 'Deployment failed' })).toBeVisible();
  await expect(page.getByText("The database couldn't be created.")).toBeVisible();
  const bodyText = await page.locator('body').innerText();
  expect(bodyText).not.toMatch(JARGON);
  await expect(page.getByText('ROLLBACK_COMPLETE', { exact: true })).toHaveCount(0);
  // The raw CloudFormation reason reaches the customer page only inside the
  // collapsed "Technical details" disclosure (and the live-activity feed is
  // hidden on a terminal stage anyway), so it is never visible here.
  await expect(page.getByText(rawReason)).toBeHidden();

  // Technical details are collapsed by default. §65 keeps the raw
  // CloudFormation enum off the customer surface even when expanded — the
  // panel shows the jargon-free phrase (customerStackStatusLabel) instead.
  await page.getByRole('button', { name: 'Technical details' }).click();
  await expect(page.getByText('Setup was rolled back', { exact: true })).toBeVisible();
  await expect(page.getByText('ROLLBACK_COMPLETE', { exact: true })).toHaveCount(0);

  // Vendor: the raw reason lives in the Infrastructure events disclosure.
  await page.goto(`/dashboard/deployments/${deploymentId}`);
  const progressCard = page.locator('section[aria-labelledby="deployment-progress"]');
  await expect(progressCard.locator('[aria-live="polite"]')).toHaveText('Install failed');
  await page.locator('#technical-details').getByRole('button', { name: 'Technical details' }).click();
  const eventsTrigger = page.getByRole('button', { name: /Infrastructure events \(2\)/ });
  await expect(eventsTrigger).toBeVisible({ timeout: 15_000 });
  await eventsTrigger.click();
  await expect(page.getByText(rawReason)).toBeVisible();
  await expect(page.getByText('CREATE_FAILED', { exact: true })).toBeVisible();
});

test('success path: CloudFormation completion alone advances to VERIFYING, never READY', async ({ page }) => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const stackName = `deployz-stack-events-ok-${suffix}`;
  await signUp(page);
  const { deploymentId, installLinkId, installationId, enrollmentCode } = await seedDeployment(page, suffix);
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

  // Every resource, and the stack itself, reaches CREATE_COMPLETE.
  const completeBatch = [
    ...subnetEvents(`${suffix}-ok`, 'CREATE_COMPLETE'),
    rdsEvent(`${suffix}-ok`, 'CREATE_COMPLETE'),
    stackEvent(`${suffix}-ok`, stackName, 'CREATE_COMPLETE'),
  ];
  const progressPost = await postRelayProgress(page, installJob!.id, relayAuth, {
    commandId: installJob!.id,
    installationId,
    stackName,
    events: completeBatch,
  });
  expect(progressPost.accepted).toBe(7);

  const albEndpoint = `deployz-alb-${suffix}.us-east-1.elb.amazonaws.com`;
  await postRelayResult(page, installJob!.id, relayAuth, {
    success: true,
    output: { outputs: { ExportDeployzApplicationPublicEndpoint: albEndpoint } },
  });

  // CloudFormation reporting done, plus a successful INSTALL result, is
  // still not enough for READY — health/domain checks gate that separately.
  await expect
    .poll(async () => (await fetchStatus(page, installLinkId)).stage, { timeout: 15_000 })
    .toBe('VERIFYING');
  const status = await fetchStatus(page, installLinkId);
  expect(status.stage).not.toBe('READY');

  await page.goto(`/install/${installLinkId}`);
  await expect(page.getByRole('heading', { name: 'Checking your application' })).toBeVisible();

  await page.goto(`/dashboard/deployments/${deploymentId}`);
  const progressCard = page.locator('section[aria-labelledby="deployment-progress"]');
  await expect(progressCard.locator('[aria-live="polite"]')).toHaveText('Verifying your application', {
    timeout: 15_000,
  });
});
