import { expect, test, type Page } from '@playwright/test';

import { makeApplicationDeployable } from './seed-ready-manifest.js';

// Deployment sizes (docs/infrastructure-profiles.md): the vendor sets a
// default, overrides it on one invitation, and the customer installs a
// different permitted size. The deployment freezes the customer's choice.

const API_URL = `http://localhost:${process.env.API_PORT ?? 3001}`;

async function signUp(page: Page): Promise<void> {
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill('Size Vendor');
  await page.getByLabel('Email').fill(`e2e-size-${crypto.randomUUID().slice(0, 8)}@example.com`);
  await page.getByLabel('Password').fill('super-secret-1');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL('/dashboard');
}

test('the customer installs its chosen size from an invitation with a vendor override', async ({ page }) => {
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

  // Vendor: Medium by default, Small allowed; this one customer gets a Large recommendation.
  const sizes = await page.request.patch(`${API_URL}/api/applications/${application.id}`, {
    data: { defaultSizeProfile: 'medium', minimumSizeProfile: 'small' },
  });
  expect(sizes.ok(), await sizes.text()).toBeTruthy();
  const customer = (await page.request
    .post(`${API_URL}/api/customers`, { data: { name: `Size Customer ${suffix}`, email: `size-${suffix}@example.com` } })
    .then((response) => response.json())) as { id: string };
  const invitationResponse = await page.request.post(`${API_URL}/api/customers/${customer.id}/invitations`, {
    data: { applicationId: application.id, recommendedSizeProfile: 'large' },
  });
  expect(invitationResponse.ok()).toBeTruthy();
  const invitation = (await invitationResponse.json()) as { id: string; token: string };

  // Customer: the link's recommendation is preselected and labelled.
  await page.goto(`/install/${invitation.id}#${invitation.token}`);
  const sizeSection = page.locator('section[aria-labelledby="public-size"]');
  await expect(sizeSection).toBeVisible();
  await expect(page.locator('#size-large')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('label[for="size-large"]')).toContainText('Vendor recommended');
  await expect(page.locator('#size-small')).toBeVisible();

  await page.locator('section[aria-labelledby="public-region"]').getByRole('combobox').click();
  await page.getByRole('option', { name: 'US East (N. Virginia)' }).click();
  await page.locator('label[for="size-medium"]').click();
  await expect(page.locator('#size-medium')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('selected-size')).toContainText('Medium');

  const continueButton = page.getByRole('button', { name: 'Continue to setup' });
  await expect(continueButton).toBeEnabled();
  await continueButton.click();
  await page.waitForURL((url) => /\/install\/[0-9a-f-]{36}$/.test(url.pathname) && !url.pathname.endsWith(invitation.id));

  // The deployment froze the customer's choice, not the recommendation.
  const { deployments } = (await page.request.get(`${API_URL}/api/deployments`).then((response) => response.json())) as {
    deployments: { id: string; customerId: string }[];
  };
  const deployment = deployments.find((row) => row.customerId === customer.id);
  expect(deployment).toBeDefined();
  const detail = (await page.request.get(`${API_URL}/api/deployments/${deployment!.id}`).then((response) => response.json())) as {
    size: { id: string; profileKey: string } | null;
  };
  expect(detail.size).toMatchObject({ id: 'medium', profileKey: 'medium-v1' });

  await page.goto(`/dashboard/deployments/${deployment!.id}`);
  await expect(page.getByTestId('deployment-size-label')).toHaveText('Size: Medium');
});

test('the vendor sets the recommended and minimum sizes and they persist after a reload', async ({ page }, testInfo) => {
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
  await expect(card.getByTestId('deployment-size-large-compute')).toHaveText('2 vCPU · 4 GiB per service');
  await card.scrollIntoViewIfNeeded();
  await card.screenshot({ path: testInfo.outputPath('size-card-desktop.png') });

  // Default Large, minimum Medium: Small is below the minimum.
  await card.getByLabel('Default size').click();
  await page.getByRole('option', { name: /^Large/ }).click();
  await card.getByLabel('Minimum allowed size').click();
  await page.getByRole('option', { name: /^Medium/ }).click();
  await card.getByRole('button', { name: 'Estimate details' }).click();
  await expect(card.getByTestId('deployment-cost-details')).toContainText('730 hours a month');
  await card.getByTestId('deployment-size-save').click();
  await expect(card.getByText('Saved.')).toBeVisible();
  await expect(card.getByTestId('deployment-size-small')).toContainText('Below minimum');

  await page.reload();
  await expect(card.getByLabel('Default size')).toContainText('Large');
  await expect(card.getByLabel('Minimum allowed size')).toContainText('Medium');
  await expect(card.getByTestId('deployment-size-large')).toContainText('Default');
  await expect(card.getByTestId('deployment-size-small')).toContainText('Below minimum');
  await card.getByLabel('Default size').click();
  await expect(page.getByRole('option', { name: /^Small/ })).toHaveCount(0);
  await page.keyboard.press('Escape');

  await page.setViewportSize({ width: 375, height: 812 });
  await card.scrollIntoViewIfNeeded();
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(375);
  await card.screenshot({ path: testInfo.outputPath('size-card-mobile.png') });
});
