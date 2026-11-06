import { expect, test, type Page } from '@playwright/test';

import { makeApplicationDeployable } from './seed-ready-manifest.js';

// Deployment sizes (docs/infrastructure-profiles.md): the pilot offers Small
// only (SELECTABLE_SIZE_TIERS). The deployment freezes the customer's choice.

const API_URL = `http://localhost:${process.env.API_PORT ?? 3001}`;

async function signUp(page: Page): Promise<void> {
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill('Size Vendor');
  await page.getByLabel('Email').fill(`e2e-size-${crypto.randomUUID().slice(0, 8)}@example.com`);
  await page.getByLabel('Password').fill('super-secret-1');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL('/dashboard');
}

test('the customer installs Small from an invitation and Medium and Large are not offered', async ({ page }) => {
  test.setTimeout(120_000);
  await signUp(page);
  const suffix = crypto.randomUUID().slice(0, 8);
  const appResponse = await page.request.post(`${API_URL}/api/applications`, {
    data: {
      name: `Size App ${suffix}`,
      githubInstallationId: 'e2e-installation',
      repoFullName: 'deployz-demo/express-api',
      repoUrl: 'https://github.com/deployz-demo/express-api',
      defaultBranch: 'main',
    },
  });
  expect(appResponse.ok()).toBeTruthy();
  const application = (await appResponse.json()) as { id: string };
  expect((await page.request.post(`${API_URL}/api/applications/${application.id}/analyse`, {})).ok()).toBeTruthy();
  await makeApplicationDeployable(page.request, application.id);

  const customer = (await page.request
    .post(`${API_URL}/api/customers`, { data: { name: `Size Customer ${suffix}`, email: `size-${suffix}@example.com` } })
    .then((response) => response.json())) as { id: string };
  const invitationResponse = await page.request.post(`${API_URL}/api/customers/${customer.id}/invitations`, {
    data: { applicationId: application.id },
  });
  expect(invitationResponse.ok()).toBeTruthy();
  const invitation = (await invitationResponse.json()) as { id: string; token: string };

  await page.goto(`/install/${invitation.id}#${invitation.token}`);
  await expect(page.locator('section[aria-labelledby="public-size"]')).toBeVisible();
  await expect(page.locator('#size-small')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('#size-medium')).toHaveCount(0);
  await expect(page.locator('#size-large')).toHaveCount(0);

  await page.locator('section[aria-labelledby="public-region"]').getByRole('combobox').click();
  await page.getByRole('option', { name: 'US East (N. Virginia)' }).click();
  await expect(page.getByTestId('selected-size')).toContainText('Small');

  const continueButton = page.getByRole('button', { name: 'Continue to setup' });
  await expect(continueButton).toBeEnabled();
  await continueButton.click();
  await page.waitForURL((url) => /\/install\/[0-9a-f-]{36}$/.test(url.pathname) && !url.pathname.endsWith(invitation.id));

  const { deployments } = (await page.request.get(`${API_URL}/api/deployments`).then((response) => response.json())) as {
    deployments: { id: string; customerId: string }[];
  };
  const deployment = deployments.find((row) => row.customerId === customer.id);
  expect(deployment).toBeDefined();
  const detail = (await page.request.get(`${API_URL}/api/deployments/${deployment!.id}`).then((response) => response.json())) as {
    size: { id: string; profileKey: string } | null;
  };
  expect(detail.size).toMatchObject({ id: 'small', profileKey: 'small-v2' });

  await page.goto(`/dashboard/deployments/${deployment!.id}`);
  await expect(page.getByTestId('deployment-size-label')).toHaveText('Size: Small');
});

test('the vendor sizes card offers Small only and keeps its estimate after a reload', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await signUp(page);
  const appResponse = await page.request.post(`${API_URL}/api/applications`, {
    data: {
      name: `Size Config ${crypto.randomUUID().slice(0, 8)}`,
      githubInstallationId: 'e2e-installation',
      repoFullName: 'deployz-demo/express-api',
      repoUrl: 'https://github.com/deployz-demo/express-api',
      defaultBranch: 'main',
    },
  });
  expect(appResponse.ok()).toBeTruthy();
  const application = (await appResponse.json()) as { id: string };
  expect((await page.request.post(`${API_URL}/api/applications/${application.id}/analyse`, {})).ok()).toBeTruthy();

  await page.goto(`/dashboard/applications/${application.id}/config#deployment-size`);
  const card = page.getByTestId('deployment-size');
  await expect(page.getByTestId('config-tab-sizes')).toHaveAttribute('aria-selected', 'true');
  await expect(card.getByTestId('deployment-size-small')).toContainText('Default');
  await expect(card.getByTestId('deployment-size-small-cost')).toHaveText(/^~\$\d+–\d+\/month/);
  await expect(card.getByTestId('deployment-size-medium')).toHaveCount(0);
  await expect(card.getByTestId('deployment-size-large')).toHaveCount(0);
  await card.scrollIntoViewIfNeeded();
  await card.screenshot({ path: testInfo.outputPath('size-card-desktop.png') });
  await card.getByRole('button', { name: 'Estimate details' }).click();
  await expect(card.getByTestId('deployment-cost-details')).toContainText('730 hours a month');

  await page.setViewportSize({ width: 375, height: 812 });
  await card.scrollIntoViewIfNeeded();
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(375);
  await card.screenshot({ path: testInfo.outputPath('size-card-mobile.png') });
});
