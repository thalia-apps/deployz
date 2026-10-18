import { expect, test } from '@playwright/test';

// Todo 5 smoke assertions: the shell renders the auth pages, gates
// /dashboard for anonymous visitors, and shows an authenticated user the
// first-run homepage (no fake deployment data anywhere).

const API_URL = `http://localhost:${process.env.API_PORT ?? 3001}`;

test('sign-in page renders', async ({ page }) => {
  await page.goto('/sign-in');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByLabel('Email')).toBeVisible();
  await expect(page.getByLabel('Password')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
});

test('sign-up page renders', async ({ page }) => {
  await page.goto('/sign-up');
  await expect(page.getByRole('heading', { name: 'Sign up' })).toBeVisible();
  await expect(page.getByLabel('Name')).toBeVisible();
  await expect(page.getByLabel('Email')).toBeVisible();
  await expect(page.getByLabel('Password')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create account' })).toBeVisible();
});

test('unauthenticated visit to /dashboard redirects to /sign-in', async ({ page }) => {
  await page.goto('/dashboard');
  // The destination rides along so signing in lands where the visitor was
  // going, instead of dropping everyone on the dashboard home.
  await page.waitForURL(/\/sign-in\?callbackUrl=%2Fdashboard/);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});

test('authenticated user reaches the homepage and sees the first-run state', async ({ page }) => {
  // A fresh org has no applications and no deployments; the API returns
  // empty lists. The mocks make that the source of truth even if a prior
  // test created rows in the shared PGlite database.
  await page.route('**/api/deployments', (route) =>
    route.fulfill({ json: { deployments: [] } }),
  );
  await page.route('**/api/applications', (route) =>
    route.fulfill({ json: { applications: [] } }),
  );

  const email = `e2e-${crypto.randomUUID().slice(0, 8)}@example.com`;

  await page.goto('/sign-up');
  await page.getByLabel('Name').fill('E2E User');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('super-secret-1');
  await page.getByRole('button', { name: 'Create account' }).click();

  await page.waitForURL('/dashboard');
  await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Add application' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Dashboard' })).toBeVisible();
});

test('renaming the organization via §41 settings persists to the real API (regression: CORS blocked PATCH)', async ({
  page,
}) => {
  const email = `e2e-${crypto.randomUUID().slice(0, 8)}@example.com`;
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill('E2E User');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('super-secret-1');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL('/dashboard');

  await page.goto('/dashboard/settings');
  const newName = `Renamed Org ${crypto.randomUUID().slice(0, 8)}`;
  await page.getByLabel('Organization name').fill(newName);
  await page.getByRole('button', { name: 'Update Organization' }).click();
  await expect(page.getByRole('status')).toHaveText('Saved.');

  // Previously the API's CORS config only allowed GET,HEAD,POST, so the
  // browser blocked the PATCH preflight and the rename silently failed in the
  // browser. This reads the name back through the real API to prove the
  // write actually landed.
  const readBack = await page.request.get(`${API_URL}/api/organization`);
  expect(readBack.ok()).toBeTruthy();
  const organization = (await readBack.json()) as { name: string };
  expect(organization.name).toBe(newName);
});
