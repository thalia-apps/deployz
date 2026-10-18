import { expect, test, type Page } from '@playwright/test';

// The homepage ("Overview") renders one of two states from real organization
// data: the onboarding checklist until a customer deployment exists, then a
// compact summary and at most three next steps. Each state below is reached
// by seeding real rows through the API with the browser's session cookie, or
// by rewriting the real API response where a state cannot be seeded locally.

import { makeApplicationDeployable } from './seed-ready-manifest.js';

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

async function seedApplication(page: Page): Promise<{ id: string; name: string }> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const response = await page.request.post(`${API_URL}/api/applications`, {
    data: {
      name: `Acme Analytics ${suffix}`,
      githubInstallationId: 'e2e-installation',
      repoFullName: `deployz-demo/acme-analytics-${suffix}`,
      repoUrl: `https://github.com/deployz-demo/acme-analytics-${suffix}`,
      defaultBranch: 'main',
    },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { id: string; name: string };
}

async function seedDeployment(
  page: Page,
  applicationId: string,
): Promise<{ id: string; customerName: string }> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const customerResponse = await page.request.post(`${API_URL}/api/customers`, {
    data: { name: `Acme Corp ${suffix}`, email: `acme-${suffix}@example.com` },
  });
  expect(customerResponse.ok()).toBeTruthy();
  const customer = (await customerResponse.json()) as { id: string; name: string };

  await makeApplicationDeployable(page.request, applicationId);
  const deploymentResponse = await page.request.post(`${API_URL}/api/deployments`, {
    data: { applicationId, customerId: customer.id, region: 'us-east-1' },
  });
  expect(deploymentResponse.ok()).toBeTruthy();
  const deployment = (await deploymentResponse.json()) as { id: string };
  return { id: deployment.id, customerName: customer.name };
}

/** Rewrites the real deployments response, one patch per deployment id. */
async function patchDeployments(
  page: Page,
  patches: Record<string, Record<string, unknown>>,
): Promise<void> {
  await page.route(`${API_URL}/api/deployments*`, async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { deployments: Record<string, unknown>[] };
    for (const row of body.deployments) Object.assign(row, patches[row['id'] as string] ?? {});
    await route.fulfill({ json: body });
  });
}

/** The value and label of one summary metric, read from its link. */
function metric(page: Page, label: string) {
  return page.getByTestId('overview-summary').getByRole('link', { name: new RegExp(`${label}$`) });
}

test('a new workspace shows the checklist with only the next action', async ({ page }) => {
  await signUp(page);

  await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();
  const steps = page.getByTestId('setup-progress').getByRole('listitem');
  await expect(steps).toHaveCount(3);
  await expect(steps.nth(0)).toHaveAttribute('aria-current', 'step');
  await expect(steps.nth(0)).toContainText('Add application');
  await expect(steps.nth(1)).toContainText('Review configuration');
  await expect(steps.nth(1)).toContainText('Pending');
  await expect(steps.nth(2)).toContainText('Create deployment');
  await expect(steps.nth(2)).toContainText('Pending');

  // Only the current step exposes an action; no header CTA competes with it.
  await expect(page.getByRole('main').getByRole('link')).toHaveCount(1);
  await page.getByRole('link', { name: 'Add application' }).click();
  await page.waitForURL('**/dashboard/applications');
});

test('a connected application moves the checklist to Review configuration', async ({ page }) => {
  await signUp(page);
  const application = await seedApplication(page);

  await page.goto('/dashboard');
  const steps = page.getByTestId('setup-progress').getByRole('listitem');
  await expect(steps.nth(0)).toContainText('Done');
  await expect(steps.nth(1)).toHaveAttribute('aria-current', 'step');
  await expect(page.getByTestId('overview-summary')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Create deployment' })).toHaveCount(0);
  await expect(page.getByRole('main').getByRole('link')).toHaveCount(1);
  await expect(page.getByRole('main').getByRole('link')).toHaveAttribute(
    'href',
    new RegExp(`/dashboard/applications/${application.id}`),
  );
});

test('a ready application guides the vendor to the first deployment', async ({ page }) => {
  await signUp(page);
  const application = await seedApplication(page);
  await page.route(`${API_URL}/api/applications`, async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { applications: Record<string, unknown>[] };
    for (const row of body.applications) {
      row['analysisStatus'] = 'COMPLETE';
      row['compatibilityStatus'] = 'READY';
    }
    await route.fulfill({ json: body });
  });

  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: 'Create your first deployment' })).toBeVisible();
  const steps = page.getByTestId('setup-progress').getByRole('listitem');
  await expect(steps.nth(2)).toHaveAttribute('aria-current', 'step');
  await expect(page.getByRole('link', { name: 'Create deployment' })).toHaveCount(1);
  await page.getByRole('link', { name: 'Create deployment' }).click();
  // The existing creation flow, with its own readiness checks.
  await page.waitForURL(`**/dashboard/deployments/new?applicationId=${application.id}`);
});

test('a deployment awaiting its customer shows in the summary and next steps', async ({ page }) => {
  await signUp(page);
  const application = await seedApplication(page);
  const deployment = await seedDeployment(page, application.id);

  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();
  await expect(metric(page, 'Awaiting customer')).toHaveText('1Awaiting customer');
  await expect(metric(page, 'Live')).toHaveText('0Live');
  await expect(page.getByTestId('next-steps')).toContainText('1 customer hasn’t completed setup');

  await page.getByRole('link', { name: 'View pending setups' }).click();
  await page.waitForURL('**/dashboard/deployments?status=waiting');
  await expect(page.getByTestId('deployment-list')).toContainText(deployment.customerName);
});

test('attention is grouped into one next step and every metric links to its filtered view', async ({ page }) => {
  await signUp(page);
  const application = await seedApplication(page);
  const failedA = await seedDeployment(page, application.id);
  const failedB = await seedDeployment(page, application.id);
  const live = await seedDeployment(page, application.id);
  const updating = await seedDeployment(page, application.id);
  await patchDeployments(page, {
    [failedA.id]: { state: 'FAILED' },
    [failedB.id]: { state: 'FAILED' },
    [live.id]: { state: 'HEALTHY', healthStatus: 'HEALTHY', relayStatus: 'CONNECTED' },
    [updating.id]: { state: 'UPDATING' },
  });

  await page.goto('/dashboard');
  await expect(metric(page, 'Need attention')).toHaveText('2Need attention');
  await expect(metric(page, 'Live')).toHaveText('1Live');
  await expect(metric(page, 'Deploying')).toHaveText('1Deploying');
  await expect(metric(page, 'Awaiting customer')).toHaveText('0Awaiting customer');

  // Red only for a nonzero attention count.
  await expect(metric(page, 'Need attention').locator('span').first()).toHaveClass(/text-destructive/);
  await expect(metric(page, 'Awaiting customer').locator('span').first()).not.toHaveClass(/text-destructive/);

  const rows = page.getByTestId('next-steps').getByRole('listitem');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('2 deployments need attention');
  await expect(page.getByText('All deployments healthy')).toHaveCount(0);

  for (const [label, status] of [
    ['Live', 'healthy'],
    ['Need attention', 'attention'],
    ['Deploying', 'in-progress'],
    ['Awaiting customer', 'waiting'],
  ] as const) {
    await expect(metric(page, label)).toHaveAttribute('href', `/dashboard/deployments?status=${status}`);
  }

  await page.getByRole('link', { name: 'Review deployments' }).click();
  await page.waitForURL('**/dashboard/deployments?status=attention');
  const list = page.getByTestId('deployment-list');
  await expect(list).toContainText(failedA.customerName);
  await expect(list).toContainText(failedB.customerName);
  await expect(list).not.toContainText(live.customerName);
});

test('a healthy fleet says so, and only when every deployment reports healthy', async ({ page }) => {
  await signUp(page);
  const application = await seedApplication(page);
  const a = await seedDeployment(page, application.id);
  const b = await seedDeployment(page, application.id);
  const healthy = { state: 'HEALTHY', healthStatus: 'HEALTHY', relayStatus: 'CONNECTED' };
  await patchDeployments(page, { [a.id]: healthy, [b.id]: healthy });

  await page.goto('/dashboard');
  await expect(metric(page, 'Live')).toHaveText('2Live');
  await expect(page.getByText('All deployments healthy')).toBeVisible();
  await expect(page.getByText('Nothing needs your attention.')).toBeVisible();
  await expect(page.getByTestId('next-steps')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Create deployment' })).toBeVisible();
});

test('a deployment without a health report is never called healthy', async ({ page }) => {
  await signUp(page);
  const application = await seedApplication(page);
  const a = await seedDeployment(page, application.id);
  const b = await seedDeployment(page, application.id);
  await patchDeployments(page, {
    [a.id]: { state: 'HEALTHY', healthStatus: 'HEALTHY', relayStatus: 'CONNECTED' },
    [b.id]: { state: 'HEALTHY', healthStatus: 'UNKNOWN', relayStatus: 'CONNECTED' },
  });

  await page.goto('/dashboard');
  await expect(page.getByText('Nothing needs your attention.')).toBeVisible();
  await expect(page.getByText('1 deployment has not reported its health yet.')).toBeVisible();
  await expect(page.getByText('All deployments healthy')).toHaveCount(0);
});

test('a failed load shows an error with retry, never zero counts', async ({ page }) => {
  await signUp(page);
  await page.route(`${API_URL}/api/deployments*`, (route) => route.fulfill({ status: 500, json: {} }));

  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: 'Something went wrong' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(page.getByTestId('overview-summary')).toHaveCount(0);
  await expect(page.getByTestId('setup-progress')).toHaveCount(0);
});

test('the loading state holds the layout and claims nothing', async ({ page }) => {
  await signUp(page);
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`${API_URL}/api/deployments*`, async (route) => {
    await held;
    await route.continue();
  });

  await page.goto('/dashboard');
  await expect(page.getByTestId('home-loading')).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();
  await expect(page.getByText(/^0$/)).toHaveCount(0);
  release();
  await expect(page.getByTestId('home-loading')).toHaveCount(0);
});

test('one workspace never sees another workspace’s deployments', async ({ page, browser }) => {
  await signUp(page);
  const application = await seedApplication(page);
  await seedDeployment(page, application.id);
  await page.goto('/dashboard');
  await expect(metric(page, 'Awaiting customer')).toHaveText('1Awaiting customer');

  const other = await browser.newContext();
  const otherPage = await other.newPage();
  await signUp(otherPage);
  await expect(otherPage.getByTestId('setup-progress')).toBeVisible();
  await expect(otherPage.getByTestId('overview-summary')).toHaveCount(0);
  await other.close();
});

test('the summary and next steps are reachable by keyboard', async ({ page }) => {
  await signUp(page);
  const application = await seedApplication(page);
  await seedDeployment(page, application.id);
  await page.goto('/dashboard');
  await expect(page.getByTestId('overview-summary')).toBeVisible();

  const reachable = new Set<string>();
  for (let i = 0; i < 40; i += 1) {
    await page.keyboard.press('Tab');
    const name = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? '');
    reachable.add(name);
  }
  for (const name of ['Create deployment', '0Live', '0Need attention', '0Deploying', '1Awaiting customer', 'View pending setups']) {
    expect(reachable).toContain(name);
  }
});

test('homepage top-level copy is jargon-free', async ({ page }) => {
  await signUp(page);
  const application = await seedApplication(page);
  await seedDeployment(page, application.id);

  await page.goto('/dashboard');
  await expect(page.getByTestId('overview-summary')).toBeVisible();
  const text = await page.locator('body').innerText();
  expect(text).not.toMatch(JARGON);
});

test('the homepage fits a phone without sideways scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 720 });
  await signUp(page);
  const application = await seedApplication(page);
  await seedDeployment(page, application.id);
  await seedDeployment(page, application.id);

  await page.goto('/dashboard');
  await expect(page.getByTestId('overview-summary')).toBeVisible();
  await expect(page.getByRole('link', { name: 'View pending setups' })).toBeVisible();
  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflows).toBe(false);
});

test('the deployments page is reachable from the homepage nav', async ({ page }) => {
  await signUp(page);

  await page
    .getByRole('navigation', { name: 'Dashboard' })
    .getByRole('link', { name: 'Deployments' })
    .click();
  await page.waitForURL('**/dashboard/deployments');
  await expect(page.getByRole('heading', { name: 'Deployments', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Create deployment' })).toBeVisible();
});
