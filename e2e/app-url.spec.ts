import { expect, test, type Page } from '@playwright/test';

// The deployment-detail page's first-class "Application URL" row, driven by
// the real relay job workflow: a successful INSTALL result carrying the ALB
// endpoint output makes `GET /api/deployments/:id` resolve `appUrl`, which
// the page renders as a link plus a copy button. Mirrors the
// signUp/seed/relay conventions in diagnostics.spec.ts.

import { makeApplicationDeployable } from './seed-ready-manifest.js';
import { fetchInstallCredentials } from './simulation/relay-harness.js';
import { installLinkToken } from './install-link.js';

const API_URL = `http://localhost:${process.env.API_PORT ?? 3001}`;

async function signUp(page: Page): Promise<void> {
  const email = `e2e-appurl-${crypto.randomUUID().slice(0, 8)}@example.com`;
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill('E2E App URL User');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('super-secret-1');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL('/dashboard');
}

async function seedDeployment(
  page: Page,
): Promise<{
  deploymentId: string;
  installLinkId: string;
  installationId: string;
  enrollmentCode: string;
}> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const appResponse = await page.request.post(`${API_URL}/api/applications`, {
    data: {
      name: `App URL Portal ${suffix}`,
      githubInstallationId: 'e2e-installation',
      repoFullName: `deployz-demo/app-url-portal-${suffix}`,
      repoUrl: `https://github.com/deployz-demo/app-url-portal-${suffix}`,
      defaultBranch: 'main',
    },
  });
  expect(appResponse.ok()).toBeTruthy();
  const application = (await appResponse.json()) as { id: string };
  await makeApplicationDeployable(page.request, application.id);

  const customerResponse = await page.request.post(`${API_URL}/api/customers`, {
    data: { name: `App URL Customer ${suffix}`, email: `app-url-${suffix}@example.com` },
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
    enrollmentCode: string;
  };

  return {
    deploymentId: deployment.id,
    installLinkId: deployment.installLinkId,
    installationId: `inst-${crypto.randomUUID()}`,
    enrollmentCode: deployment.enrollmentCode,
  };
}

test('before any successful INSTALL, the detail page has no Application URL row', async ({ page }) => {
  await signUp(page);
  const { deploymentId } = await seedDeployment(page);

  await page.goto(`/dashboard/deployments/${deploymentId}`);
  await expect(page.getByText('Application URL')).toHaveCount(0);
});

test('a successful INSTALL with an ALB endpoint shows a working link and copy button', async ({
  page,
}) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);

  await signUp(page);
  const { deploymentId, installLinkId, installationId, enrollmentCode } =
    await seedDeployment(page);
  // DZ-AUDIT-013: the relay presents the server-minted credential from the
  // Quick Create URL (a real relay reads it from the stack's secret), not an
  // arbitrary bearer token.
  const { relayCredential } = await fetchInstallCredentials(API_URL, installLinkId, await installLinkToken(page.request, installLinkId));
  const authHeaders = { Authorization: `Bearer ${relayCredential}` };

  const registerResponse = await page.request.post(`${API_URL}/api/relay/register`, {
    headers: authHeaders,
    data: { installationId, enrollmentCode },
  });
  expect(registerResponse.ok()).toBeTruthy();

  const commands = (await (
    await page.request.get(`${API_URL}/api/relay/commands?installationId=${installationId}`, {
      headers: authHeaders,
    })
  ).json()) as { commands: { id: string; type: string }[] };
  const installJob = commands.commands.find((command) => command.type === 'INSTALL');
  expect(installJob).toBeDefined();

  const endpoint = `deployz-alb-${crypto.randomUUID().slice(0, 8)}.us-east-1.elb.amazonaws.com`;
  const resultResponse = await page.request.post(
    `${API_URL}/api/relay/commands/${installJob!.id}/result`,
    {
      headers: authHeaders,
      data: {
        success: true,
        output: { outputs: { ExportDeployzApplicationPublicEndpoint: endpoint } },
      },
    },
  );
  expect(resultResponse.ok()).toBeTruthy();

  await page.goto(`/dashboard/deployments/${deploymentId}`);
  const link = page.getByRole('link', { name: new RegExp(endpoint) });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', `http://${endpoint}`);
  await expect(link).toHaveAttribute('target', '_blank');

  await page.getByRole('button', { name: 'Copy' }).click();
  await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();
  const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboardText).toBe(`http://${endpoint}`);
});
