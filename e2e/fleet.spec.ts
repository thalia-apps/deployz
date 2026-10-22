import { expect, test, type Page } from '@playwright/test';
import { extractQuickCreateParam } from './simulation/relay-harness.js';

// §23 fleet dashboard + §24 deployment detail + activity feed, against the
// REAL API (no fixture fallback — a 404 now renders a real not-found/error
// state rather than fabricated data). Seeds a real application, customer, and
// deployment via direct API calls (through the browser's session cookie, so
// requests are attributed to the signed-up org) before asserting on the UI.
// §46 vocabulary: the top-level copy uses the 9 product-language states,
// never raw AWS/CFN/ECS/ALB terms (M14: deployment health only).

import { makeApplicationDeployable } from './seed-ready-manifest.js';
import { installLinkHeaders } from './install-link.js';

const API_URL = `http://localhost:${process.env.API_PORT ?? 3001}`;

// Raw AWS service terms that must NOT appear in rendered top-level copy.
const JARGON = /\b(CloudFormation|IAM|ECS|ALB|Lambda|VPC|CFN)\b/;

async function signUp(page: Page): Promise<void> {
  const email = `e2e-${crypto.randomUUID().slice(0, 8)}@example.com`;
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill('E2E User');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('super-secret-1');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL('/dashboard');
}

/** Seeds one real application + customer + deployment for the signed-up org. */
async function seedDeployment(page: Page): Promise<{
  deploymentId: string;
  applicationId: string;
  installationId: string;
  installLinkId: string;
  enrollmentCode: string;
  relayCredential: string;
  applicationName: string;
  customerName: string;
}> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const appResponse = await page.request.post(`${API_URL}/api/applications`, {
    data: {
      name: `Acme Analytics ${suffix}`,
      githubInstallationId: 'e2e-installation',
      repoFullName: `deployz-demo/acme-analytics-${suffix}`,
      repoUrl: `https://github.com/deployz-demo/acme-analytics-${suffix}`,
      defaultBranch: 'main',
    },
  });
  expect(appResponse.ok()).toBeTruthy();
  const application = (await appResponse.json()) as { id: string; name: string };
  await makeApplicationDeployable(page.request, application.id);

  const customerResponse = await page.request.post(`${API_URL}/api/customers`, {
    data: { name: `Acme Corp ${suffix}`, email: `acme-${suffix}@example.com` },
  });
  expect(customerResponse.ok()).toBeTruthy();
  const customer = (await customerResponse.json()) as { id: string; name: string };

  const deploymentResponse = await page.request.post(`${API_URL}/api/deployments`, {
    data: { applicationId: application.id, customerId: customer.id, region: 'us-east-1' },
  });
  expect(deploymentResponse.ok()).toBeTruthy();
  const deployment = (await deploymentResponse.json()) as {
    id: string;
    installLinkId: string;
    enrollmentCode: string;
  };

  // DZ-AUDIT-013: the server-minted relay credential rides the Quick Create URL.
  const installResponse = await page.request.get(`${API_URL}/api/install/${deployment.installLinkId}`, {
      headers: await installLinkHeaders(page.request, deployment.installLinkId),
    });
  expect(installResponse.ok()).toBeTruthy();
  const installData = (await installResponse.json()) as { quickCreateUrl: string | null };
  expect(installData.quickCreateUrl).not.toBeNull();
  const relayCredential = extractQuickCreateParam(installData.quickCreateUrl!, 'RelayCredential');

  return {
    deploymentId: deployment.id,
    applicationId: application.id,
    // The relay mints its own id inside the customer's account; a fresh one
    // per seeded deployment stands in for that here.
    installationId: `inst-${crypto.randomUUID()}`,
    installLinkId: deployment.installLinkId,
    enrollmentCode: deployment.enrollmentCode,
    relayCredential,
    applicationName: application.name,
    customerName: customer.name,
  };
}

/**
 * Drives a fresh deployment to HEALTHY via the real relay job workflow: the
 * relay registers (creating the INSTALL job) and reports it a success —
 * the exact sequence `POST /api/relay/commands/:id/result` now uses to
 * advance `deployments.state` (previously it never did, so a deployment sat
 * at INSTALLING forever and was never §25 bulk-deployable).
 */
async function driveDeploymentToHealthy(
  page: Page,
  installationId: string,
  enrollmentCode: string,
  relayCredential: string,
  /** Capabilities the relay advertises, for tests that assert a gated action. */
  capabilities?: Record<string, boolean>,
): Promise<void> {
  const authHeaders = { Authorization: `Bearer ${relayCredential}` };

  // Enrollment, not just registration: the installation id a real relay
  // reports is minted inside the CUSTOMER's account, so the control plane has
  // never seen it. The single-use enrollment code is what ties this relay to
  // the vendor's deployment, and it is spent on this call.
  const registerResponse = await page.request.post(`${API_URL}/api/relay/register`, {
    headers: authHeaders,
    data: { installationId, enrollmentCode, ...(capabilities ? { capabilities } : {}) },
  });
  expect(registerResponse.ok()).toBeTruthy();

  const commandsResponse = await page.request.get(
    `${API_URL}/api/relay/commands?installationId=${installationId}`,
    { headers: authHeaders },
  );
  const { commands } = (await commandsResponse.json()) as { commands: { id: string; type: string }[] };
  const installJob = commands.find((command) => command.type === 'INSTALL');
  expect(installJob).toBeDefined();

  const resultResponse = await page.request.post(
    `${API_URL}/api/relay/commands/${installJob!.id}/result`,
    { headers: authHeaders, data: { success: true } },
  );
  expect(resultResponse.ok()).toBeTruthy();

  // Phase 1.3 honesty gate: a successful INSTALL alone keeps the deployment
  // at INSTALLING — only the relay's runtime-health heartbeat (which is what
  // a real relay sends every poll) earns HEALTHY. Send that heartbeat here,
  // exactly as the real relay would.
  const healthResponse = await page.request.post(`${API_URL}/api/relay/health`, {
    headers: authHeaders,
    data: {
      installationId,
      observedState: {},
      healthStatus: 'HEALTHY',
      components: { application: 'HEALTHY' },
    },
  });
  expect(healthResponse.ok()).toBeTruthy();

  // A successful INSTALL queues the deploy of the newest READY release. The
  // relay runs it next, so no operation still owns the deployment.
  const followUpResponse = await page.request.get(
    `${API_URL}/api/relay/commands?installationId=${installationId}`,
    { headers: authHeaders },
  );
  const followUp = (await followUpResponse.json()) as { commands: { id: string; type: string }[] };
  const autoDeployJob = followUp.commands.find((command) => command.type === 'DEPLOY_RELEASE');
  expect(autoDeployJob).toBeDefined();
  const autoDeployResult = await page.request.post(
    `${API_URL}/api/relay/commands/${autoDeployJob!.id}/result`,
    { headers: authHeaders, data: { success: true } },
  );
  expect(autoDeployResult.ok()).toBeTruthy();
}

test('fleet dashboard shows the §43 empty state for a fresh org', async ({ page }) => {
  await page.route(`${API_URL}/api/deployments`, (route) =>
    route.fulfill({ json: { deployments: [] } }),
  );
  await signUp(page);
  await page.goto('/dashboard/deployments');

  await expect(page.getByRole('heading', { name: 'Deployments', exact: true })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'No customer deployments yet' }),
  ).toBeVisible();
});

test('fleet dashboard top-level copy is jargon-free', async ({ page }) => {
  await page.route(`${API_URL}/api/deployments`, (route) =>
    route.fulfill({ json: { deployments: [] } }),
  );
  await signUp(page);
  await page.goto('/dashboard/deployments');

  const text = await page.locator('body').innerText();
  expect(text).not.toMatch(JARGON);
});

test('fleet dashboard lists a real deployment with Customer/Version/Region/Status (§23)', async ({
  page,
}) => {
  await signUp(page);
  const { applicationName, customerName } = await seedDeployment(page);

  await page.goto('/dashboard/deployments');
  await expect(page.getByTestId('deployment-list')).toBeVisible();
  await expect(page.getByText(customerName, { exact: true })).toBeVisible();
  // The application is named twice in the DOM (a column, and a subline for
  // narrow screens); only one is displayed at any width.
  await expect(page.getByText(applicationName, { exact: true }).locator('visible=true')).toHaveCount(1);
  await expect(page.getByText('us-east-1', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Waiting for customer', { exact: true })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Updated' })).toBeVisible();
});

test('deployment detail page renders the §24 overview, infrastructure rows, and actions', async ({
  page,
}) => {
  await signUp(page);
  const { deploymentId, applicationName, customerName } = await seedDeployment(page);

  await page.goto(`/dashboard/deployments/${deploymentId}`);

  await expect(page.getByRole('heading', { name: applicationName })).toBeVisible();
  await expect(page.getByText(customerName, { exact: true }).first()).toBeVisible();

  // The hero says what to do next for a deployment nobody has installed.
  const hero = page.locator('section[aria-labelledby="deployment-progress"]');
  await expect(hero.locator('[aria-live="polite"]')).toHaveText(
    'Waiting for your customer to install',
  );
  await expect(page.getByRole('heading', { name: 'Install link' })).toBeVisible();

  // Actions are contextual: day-2 actions (deploy/rollback/restart/config)
  // act on a running application, so they are not offered before an
  // install. Remove deployment lives behind the overflow menu and is
  // capability-gated (a deployment with no relay ever connected has no
  // reported capabilities, so it is disabled).
  await expect(page.getByRole('button', { name: 'Deploy Update' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Configuration' })).toHaveCount(0);
  await page.getByRole('button', { name: 'More actions' }).click();
  await expect(page.getByRole('menuitem', { name: 'Rollback' })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: 'Remove deployment' })).toBeDisabled();
  await page.keyboard.press('Escape');

  // §24 infrastructure. A deployment nobody has installed has no observed
  // health, so the honest render is the empty state — not four green rows all
  // showing the same column default, which is what this used to assert.
  // (showInfrastructureRows gates the whole section on the deployment being
  // past the pre-install states — see apps/web/src/lib/deployment-vocabulary.ts.)
  // Scoped to the infrastructure section: the preflight card above it
  // legitimately lists "Database" as a passed check.
  const infrastructure = page.locator('section[aria-labelledby="infrastructure"]');
  await expect(infrastructure.getByText('Not installed yet.')).toBeVisible();
  await expect(infrastructure.getByText('Deployz connector', { exact: true })).toBeVisible();
  await expect(infrastructure.getByText('Database', { exact: true })).toHaveCount(0);
});

test('infrastructure rows appear only for the components the relay reports', async ({ page }) => {
  await signUp(page);
  const { deploymentId, installationId, enrollmentCode, relayCredential } = await seedDeployment(page);
  await driveDeploymentToHealthy(page, installationId, enrollmentCode, relayCredential);

  // The Infrastructure section (apps/web/src/components/infrastructure-section.tsx)
  // renders from the persisted resource inventory (§59), not from the
  // `components` health map — a resource only becomes a row once the relay's
  // ListStackResources read is persisted via persistDeploymentResourceSnapshot
  // (packages/db/src/deployment-resources-persist.ts). The template always
  // creates the S3 bucket (storage is unconditional in the catalog — see
  // requiredInfrastructureComponents), so the seeded inventory includes it;
  // this application has no Redis cache, so only that reads "Not required".
  const health = await page.request.post(`${API_URL}/api/relay/health`, {
    headers: { Authorization: `Bearer ${relayCredential}` },
    data: {
      installationId,
      healthStatus: 'HEALTHY',
      components: { application: 'HEALTHY', database: 'HEALTHY', loadBalancer: 'HEALTHY' },
      observedState: {
        infraHealth: {
          inventory: {
            stackId: `arn:aws:cloudformation:us-east-1:123456789012:stack/e2e-${crypto.randomUUID().slice(0, 8)}/${crypto.randomUUID()}`,
            observedAt: new Date().toISOString(),
            resources: [
              {
                logicalId: 'WebService',
                type: 'AWS::ECS::Service',
                status: 'CREATE_COMPLETE',
                physicalId: 'arn:aws:ecs:us-east-1:123456789012:service/e2e-app',
              },
              {
                logicalId: 'Database',
                type: 'AWS::RDS::DBInstance',
                status: 'CREATE_COMPLETE',
                physicalId: 'e2e-db-instance',
              },
              {
                logicalId: 'LoadBalancer',
                type: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
                status: 'CREATE_COMPLETE',
                physicalId: 'e2e-alb',
              },
              {
                logicalId: 'Bucket',
                type: 'AWS::S3::Bucket',
                status: 'CREATE_COMPLETE',
                physicalId: 'e2e-app-bucket',
              },
            ],
          },
        },
      },
    },
  });
  expect(health.ok()).toBeTruthy();

  await page.goto(`/dashboard/deployments/${deploymentId}`);
  // Scoped to the Infrastructure section — the hero elsewhere on the page
  // renders its own derived component list and must not be conflated with
  // the inventory-backed rows asserted here.
  const infraSection = page.locator('section[aria-labelledby="infrastructure"]');
  await expect(infraSection.getByText('Application', { exact: true })).toBeVisible();
  await expect(infraSection.getByText('Database', { exact: true })).toBeVisible();
  await expect(infraSection.getByText('Secure endpoint', { exact: true })).toBeVisible();
  await expect(infraSection.getByText('Storage', { exact: true })).toBeVisible();
  // No cache resource was reported and the application does not require
  // one, so it reads "Not required" — never a missing or failed row.
  await expect(infraSection.getByText('Cache', { exact: true })).toBeVisible();
  await expect(infraSection.getByText('Not required', { exact: true })).toHaveCount(1);
  // The resource-level inventory stays behind its own disclosure.
  await expect(infraSection.getByText('ECS', { exact: true })).toHaveCount(0);
  await infraSection.getByRole('button', { name: /View components and \d+ AWS resources?/ }).click();
  await expect(infraSection.getByText('Runs your application', { exact: true })).toBeVisible();
});

test('deployment detail top-level copy is jargon-free', async ({ page }) => {
  await signUp(page);
  const { deploymentId } = await seedDeployment(page);

  await page.goto(`/dashboard/deployments/${deploymentId}`);
  const text = await page.locator('body').innerText();
  expect(text).not.toMatch(JARGON);
});

test('rollback is offered, disabled, until a previous successful release exists', async ({
  page,
}) => {
  await signUp(page);
  const { deploymentId, installationId, enrollmentCode, relayCredential } = await seedDeployment(page);
  await driveDeploymentToHealthy(page, installationId, enrollmentCode, relayCredential);

  await page.goto(`/dashboard/deployments/${deploymentId}`);
  // A freshly installed deployment has no previous release, so Rollback is
  // disabled in the overflow menu and says why. Reaching a rollback-eligible
  // state takes TWO successful relay DEPLOY_RELEASE jobs — the §26 migration
  // warning itself is exercised by e2e/scenario-ui.spec.ts.
  await page.getByRole('button', { name: 'More actions' }).click();
  const rollback = page.getByRole('menuitem', { name: /Rollback/ });
  await expect(rollback).toBeDisabled();
  await expect(rollback).toContainText('No previous successful release to roll back to.');
});

test('disconnect requires typing the customer name to confirm (§63)', async ({ page }) => {
  await signUp(page);
  const { deploymentId, customerName, installationId, enrollmentCode, relayCredential } =
    await seedDeployment(page);

  // Disconnect is gated twice (see `canDisconnect` in the detail page): on
  // the relay advertising the capability, and on no other operation owning
  // the deployment — the API refuses a destroy while an install or a day-2
  // job is active (requireDeploymentIdle), so the button is disabled rather
  // than buying the vendor a confirmation dialog and a 409. Driving the
  // install to completion satisfies both: the relay reports its
  // capabilities on registration, and the INSTALL job settles.
  await driveDeploymentToHealthy(page, installationId, enrollmentCode, relayCredential, {
    deployRelease: true,
    rollback: true,
    restart: true,
    configUpdate: true,
    destroy: true,
    domainManagement: true,
  });

  await page.goto(`/dashboard/deployments/${deploymentId}`);
  // Destructive actions live behind the overflow menu, never beside the
  // primary action.
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Remove deployment' }).click();

  const confirmButton = page.getByRole('button', { name: 'Remove deployment' }).last();
  await expect(confirmButton).toBeDisabled();

  await page.getByLabel(`Type ${customerName} to confirm`).fill(customerName);
  await expect(confirmButton).toBeEnabled();
});

// The bulk-deploy half of this flow was covered here until commit 2600428
// dropped the inert bulk controls from the list page ("bulk deploy is not
// MVP scope" — see the page's own comment), so the test now ends at the §22
// fleet state those controls existed to clear.
test('a new release marks a HEALTHY deployment "Update available" on the fleet list', async ({
  page,
}) => {
  await signUp(page);
  const { applicationId, installationId, enrollmentCode, customerName, relayCredential } =
    await seedDeployment(page);
  await driveDeploymentToHealthy(page, installationId, enrollmentCode, relayCredential);

  const releaseResponse = await page.request.post(
    `${API_URL}/api/applications/${applicationId}/releases`,
    { data: { version: '1.0.0', gitSha: 'e2e00000000000000000000000000000deadbeef' } },
  );
  expect(releaseResponse.ok()).toBeTruthy();

  await page.goto('/dashboard/deployments');
  const row = page.locator('[data-testid="deployment-list"] tbody tr', { hasText: customerName });
  // Publishing that release put this healthy deployment behind, which is what
  // §22/§25 mean by "update available". Nothing wrote it before, so the fleet
  // could never show it.
  await expect(row.getByText('Update available', { exact: true })).toBeVisible();
});
