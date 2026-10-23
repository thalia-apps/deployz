import { expect, test, type Page } from '@playwright/test';

// Diagnostics surface, against the REAL `GET /api/deployments/:id/diagnostics`
// endpoint (previously pointed nowhere real and always rendered fixture
// cards). That endpoint only returns a classification once a deployment's
// state is FAILED. `POST /api/relay/commands/:id/result` now actually
// advances `deployments.state` (previously it never did, so a deployment sat
// at INSTALLING forever and FAILED was unreachable) — so this spec drives a
// real deployment through the relay job workflow to FAILED and asserts the
// real classification, plus proves the "no issues" path (a deployment that
// hasn't failed) end to end.
//
// Diagnostics is folded into the deployment page (ux-guidelines §2):
// `/dashboard/deployments/:id/diagnostics` is a deep link that redirects to
// the deployment page's #infrastructure-check section, and a real failure
// renders as the page's own recovery panel — there is no separate
// Diagnostics page or diagnostic card any more.

const JARGON = /\b(CloudFormation|IAM|ECS|ALB|Lambda|VPC|CFN|RDS)\b/;
import { extractQuickCreateParam } from './simulation/relay-harness.js';
import { makeApplicationDeployable } from './seed-ready-manifest.js';
import { installLinkHeaders } from './install-link.js';

const API_URL = `http://localhost:${process.env.API_PORT ?? 3001}`;

async function signUp(page: Page): Promise<void> {
  const email = `e2e-${crypto.randomUUID().slice(0, 8)}@example.com`;
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill('E2E User');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('super-secret-1');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL('/dashboard');
}

async function seedDeployment(
  page: Page,
): Promise<{
  deploymentId: string;
  applicationId: string;
  installationId: string;
  installLinkId: string;
  enrollmentCode: string;
  relayCredential: string;
}> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const appResponse = await page.request.post(`${API_URL}/api/applications`, {
    data: {
      name: `Globex Portal ${suffix}`,
      githubInstallationId: 'e2e-installation',
      repoFullName: `deployz-demo/globex-portal-${suffix}`,
      repoUrl: `https://github.com/deployz-demo/globex-portal-${suffix}`,
      defaultBranch: 'main',
    },
  });
  const application = (await appResponse.json()) as { id: string };
  await makeApplicationDeployable(page.request, application.id);

  const customerResponse = await page.request.post(`${API_URL}/api/customers`, {
    data: { name: `Globex Inc ${suffix}`, email: `globex-${suffix}@example.com` },
  });
  const customer = (await customerResponse.json()) as { id: string };

  const deploymentResponse = await page.request.post(`${API_URL}/api/deployments`, {
    data: { applicationId: application.id, customerId: customer.id, region: 'us-east-1' },
  });
  const deployment = (await deploymentResponse.json()) as {
    id: string;
    installLinkId: string;
    enrollmentCode: string;
  };
  // DZ-AUDIT-013: fetch the server-minted relay credential from the install page.
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
    // The relay mints its own id; a fresh one per seeded deployment.
    installationId: `inst-${crypto.randomUUID()}`,
    installLinkId: deployment.installLinkId,
    enrollmentCode: deployment.enrollmentCode,
    relayCredential,
  };
}

/**
 * Drives a fresh deployment to FAILED via the real relay job workflow: the
 * relay registers (creating the INSTALL job), then reports the INSTALL
 * itself a failure — the exact sequence `POST
 * /api/relay/commands/:id/result` uses to advance `deployments.state`.
 *
 * This drives the FAILED classification through the INSTALL job rather than
 * a DEPLOY_RELEASE (as an earlier version of this helper did): a release
 * only becomes deployable once a real CodeBuild run reports it READY, which
 * this local/e2e environment has no way to trigger (`enqueue()` no-ops
 * without JOB_QUEUE_URL, and — unlike the analyse endpoint — the release
 * route has no inline fallback), so `POST .../deploy` always 409s here.
 * Mirrors the INSTALL-failure path deployment-progress.spec.ts's own failure
 * test already drives.
 */
async function driveDeploymentToFailed(
  page: Page,
  installationId: string,
  enrollmentCode: string,
  relayCredential: string,
): Promise<void> {
  const authHeaders = { Authorization: `Bearer ${relayCredential}` };

  // Enrollment, not just registration: the installation id a real relay
  // reports is minted inside the CUSTOMER's account, so the control plane has
  // never seen it. The single-use enrollment code is what ties this relay to
  // the vendor's deployment, and it is spent on this call.
  const registerResponse = await page.request.post(`${API_URL}/api/relay/register`, {
    headers: authHeaders,
    data: { installationId, enrollmentCode },
  });
  expect(registerResponse.ok()).toBeTruthy();

  const installCommands = (await (
    await page.request.get(`${API_URL}/api/relay/commands?installationId=${installationId}`, {
      headers: authHeaders,
    })
  ).json()) as { commands: { id: string; type: string }[] };
  const installJob = installCommands.commands.find((command) => command.type === 'INSTALL');
  expect(installJob).toBeDefined();

  const installResultResponse = await page.request.post(
    `${API_URL}/api/relay/commands/${installJob!.id}/result`,
    {
      headers: authHeaders,
      data: {
        success: false,
        error: 'internal: RDS CreateDBInstance timed out after 900s (should never reach the customer)',
        failureCode: 'DATABASE_CREATE_FAILED',
        stackStatus: 'CREATE_FAILED',
      },
    },
  );
  expect(installResultResponse.ok()).toBeTruthy();
}

test('the diagnostics deep link redirects to the infrastructure check, and a non-failed deployment shows the no-issues state', async ({
  page,
}) => {
  await signUp(page);
  const { deploymentId } = await seedDeployment(page);

  await page.goto(`/dashboard/deployments/${deploymentId}/diagnostics`);
  await page.waitForURL(`**/dashboard/deployments/${deploymentId}#infrastructure-check`);

  // A freshly seeded deployment is NOT_INSTALLED: no infrastructure check
  // has run, so the page says there is nothing to check — never a pass.
  await expect(page.getByTestId('infra-check-outcome')).toContainText('Nothing to check yet');
  await expect(page.getByTestId('infra-check-outcome')).toContainText('Not installed yet.');
});

test('diagnostics deep-link copy is jargon-free', async ({ page }) => {
  await signUp(page);
  const { deploymentId } = await seedDeployment(page);

  await page.goto(`/dashboard/deployments/${deploymentId}/diagnostics`);
  await page.waitForURL(`**/dashboard/deployments/${deploymentId}#infrastructure-check`);
  const text = await page.locator('body').innerText();
  expect(text).not.toMatch(JARGON);
});

test('a deployment failed via the relay job workflow shows a real classification in the deployment page recovery panel', async ({
  page,
}) => {
  await signUp(page);
  const { deploymentId, installationId, enrollmentCode, relayCredential } = await seedDeployment(page);
  await driveDeploymentToFailed(page, installationId, enrollmentCode, relayCredential);

  await page.goto(`/dashboard/deployments/${deploymentId}`);

  // No separate Diagnostics page — the failure renders as the deployment
  // page's own recovery panel (ux-guidelines §6).
  await expect(page.getByRole('heading', { name: 'Diagnostics', exact: true })).toHaveCount(0);
  const panel = page.getByTestId('deployment-recovery-panel');
  await expect(panel).toBeVisible();

  // §65: still jargon-free on the failed path, not just the "no issues" path.
  const text = await page.locator('body').innerText();
  expect(text).not.toMatch(JARGON);
});
