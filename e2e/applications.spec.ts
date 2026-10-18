import { expect, test, type Page } from '@playwright/test';

import { createReadyRelease } from './seed-ready-manifest.js';

const API_URL = `http://localhost:${process.env.API_PORT ?? 3001}`;

// §42 application management lifecycle: list, edit, delete, delete-blocked,
// and cross-org isolation. Runs against the REAL API in GITHUB_FIXTURE_MODE
// (see playwright.config.ts), so the fixture repo deployz-demo/express-api is
// available for every Select action.

/** The card itself, not its name link or its status badge. */
const APP_CARD = /^app-card-[0-9a-f-]{36}$/;

async function signUp(page: Page): Promise<void> {
  const email = `e2e-${crypto.randomUUID().slice(0, 8)}@example.com`;
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill('E2E User');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('super-secret-1');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL('/dashboard');
}

test('application list shows existing applications', async ({ page }) => {
  await signUp(page);
  await page.goto('/dashboard/applications');

  // Choose the first available repo — this creates a real Application.
  await page.getByRole('button', { name: 'Select' }).first().click();
  await page.waitForURL(/\/dashboard\/applications\/[0-9a-f-]{36}$/);

  // Go back to the list — the newly-created app should appear as a card.
  await page.goto('/dashboard/applications');
  // Anchored: an unanchored /app-card-/ also matches app-card-name-* and
  // app-card-badge-*, which is three elements for one application.
  await expect(page.getByTestId(APP_CARD)).toBeVisible();
});

// The repo picker is inline only while the org has no applications (§42
// onboarding). Once an application exists the list becomes the subject of
// the page and every further addition goes through /dashboard/applications/new
// — which is what makes it discoverable that a vendor can connect more than
// one repository.
test('the first application is added inline; later ones through Add application', async ({
  page,
}) => {
  await signUp(page);
  await page.goto('/dashboard/applications');

  // Empty org: the picker is inline, so Select is clickable without any reveal.
  await expect(page.getByRole('heading', { name: 'Add your first application' })).toBeVisible();
  await expect(page.getByTestId('add-application-section')).toBeVisible();
  await expect(page.getByTestId('add-application-button')).toHaveCount(0);
  await page.getByRole('button', { name: 'Select' }).first().click();
  await page.waitForURL(/\/dashboard\/applications\/[0-9a-f-]{36}$/);

  // With one application the list is the page, and the picker is gone.
  await page.goto('/dashboard/applications');
  await expect(page.getByTestId(APP_CARD)).toBeVisible();
  await expect(page.getByTestId('add-application-section')).toHaveCount(0);
  await expect(page.getByTestId('repo-search')).toHaveCount(0);

  // Add application is its own page with the same picker and a way back.
  await page.getByTestId('add-application-button').click();
  await page.waitForURL('/dashboard/applications/new');
  await expect(page.getByRole('heading', { name: 'Add application' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Select' }).first()).toBeVisible();
  await page.getByRole('link', { name: 'Applications' }).first().click();
  await page.waitForURL('/dashboard/applications');
});

test('clicking an application row opens the application', async ({ page }) => {
  await signUp(page);
  await page.goto('/dashboard/applications');
  await page.getByRole('button', { name: 'Select' }).first().click();
  await page.waitForURL(/\/dashboard\/applications\/[0-9a-f-]{36}$/);
  const appUrl = page.url();

  await page.goto('/dashboard/applications');
  // The repository cell, not the name link: the whole row is clickable.
  await page.getByTestId(APP_CARD).getByText('deployz-demo/express-api').click();
  await page.waitForURL(appUrl);
});

test('search filters the repository list as you type', async ({ page }) => {
  await signUp(page);
  await page.goto('/dashboard/applications');

  const search = page.getByRole('searchbox', { name: 'Search repositories' });
  await expect(page.getByTestId('repo-row-deployz-demo/express-api')).toBeVisible();
  await expect(page.getByTestId('repo-row-deployz-demo/monorepo')).toBeVisible();

  // Case-insensitive, no Search button to press.
  await search.fill('MONO');
  await expect(page.getByTestId('repo-row-deployz-demo/monorepo')).toBeVisible();
  await expect(page.getByTestId('repo-row-deployz-demo/express-api')).toHaveCount(0);

  // The description counts too.
  await search.fill('prisma');
  await expect(page.getByTestId('repo-row-deployz-demo/nextjs-prisma')).toBeVisible();
  await expect(page.getByTestId('repo-row-deployz-demo/monorepo')).toHaveCount(0);

  await search.fill('');
  await expect(page.getByTestId('repo-row-deployz-demo/express-api')).toBeVisible();
});

test('a search with no matches explains how to grant GitHub access', async ({ page }) => {
  await signUp(page);
  await page.goto('/dashboard/applications');

  await page.getByRole('searchbox', { name: 'Search repositories' }).fill('no-such-repo');

  const empty = page.getByTestId('repo-search-empty');
  await expect(empty.getByRole('heading', { name: 'No repositories found' })).toBeVisible();
  await expect(empty.getByTestId('github-manage')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Select' })).toHaveCount(0);
});

// One application per repository: a repository that is already added shows
// as such and opens its application, instead of offering Select again and
// creating a second application with its own releases and deployments.
test('an already-added repository cannot be selected again', async ({ page }) => {
  await signUp(page);
  await page.goto('/dashboard/applications');
  await page.getByTestId('repo-row-deployz-demo/express-api').getByRole('button').click();
  await page.waitForURL(/\/dashboard\/applications\/[0-9a-f-]{36}$/);
  const appUrl = page.url();

  await page.goto('/dashboard/applications/new');
  const added = page.getByTestId('repo-row-deployz-demo/express-api');
  await expect(added.getByRole('link', { name: /Added/ })).toBeVisible();
  await expect(added.getByRole('button')).toHaveCount(0);
  // Every other repository is still selectable.
  await expect(page.getByTestId('repo-row-deployz-demo/monorepo').getByRole('button')).toBeVisible();

  await added.getByRole('link').click();
  await page.waitForURL(appUrl);
});

test('editing application details persists the change', async ({ page }) => {
  await signUp(page);
  await page.goto('/dashboard/applications');
  await page.getByRole('button', { name: 'Select' }).first().click();
  await page.waitForURL(/\/dashboard\/applications\/[0-9a-f-]{36}$/);

  // The readiness table lives on the Configuration tab.
  await page.getByRole('tab', { name: 'Configuration' }).click();
  await page.waitForURL('**/config');

  // Edit the containerPort field from the readiness table.
  await page.getByTestId('readiness-setting-edit-port').click();
  const dialog = page.getByTestId('edit-dialog-containerPort');
  await expect(dialog).toBeVisible();
  await dialog.locator('input').fill('8080');
  await dialog.getByRole('button', { name: 'Save' }).click();

  // The table now shows the overridden value.
  await expect(page.getByTestId('readiness-setting-port')).toContainText('8080');

  // Reload and verify the value persisted.
  await page.reload();
  await expect(page.getByTestId('readiness-setting-port')).toContainText('8080');
});

test('deleting an application removes it from the list', async ({ page }) => {
  await signUp(page);
  await page.goto('/dashboard/applications');
  await page.getByRole('button', { name: 'Select' }).first().click();
  await page.waitForURL(/\/dashboard\/applications\/[0-9a-f-]{36}$/);

  // The fixture repo is deployz-demo/express-api — it appears as muted text
  // on the detail page.
  const repoFullName = 'deployz-demo/express-api';

  // The danger zone lives on the Configuration tab's Settings tab.
  await page.getByRole('tab', { name: 'Configuration' }).click();
  await page.waitForURL('**/config');
  await page.getByTestId('config-tab-settings').click();

  // Open the danger-zone dialog, type the repo name, and confirm deletion.
  await page.getByTestId('delete-app-trigger').click();
  await page.getByTestId('delete-app-confirm').fill(repoFullName);
  await page.getByTestId('delete-app-button').click();

  // After deletion the app list should show no card for this app.
  await page.waitForURL('/dashboard/applications');
  await expect(page.getByTestId(APP_CARD)).toHaveCount(0);
});

test('delete is blocked when the application has a deployment', async ({ page }) => {
  await signUp(page);
  await page.goto('/dashboard/applications');
  await page.getByRole('button', { name: 'Select' }).first().click();
  await page.waitForURL(/\/dashboard\/applications\/[0-9a-f-]{36}$/);

  // Capture the application id from the URL.
  const appId = page.url().match(/\/dashboard\/applications\/([0-9a-f-]{36})/)![1]!;

  // Create a customer + deployment via direct API calls using the session cookie.
  const cookies = await page.context().cookies();
  const cookie = cookies.map(c => `${c.name}=${c.value}`).join('; ');

  const customerRes = await page.request.post(`${API_URL}/api/customers`, {
    data: { name: 'Test Customer', email: 'test@example.com' },
    headers: { cookie },
  });
  const customer = await customerRes.json();
  await createReadyRelease(page.request, appId);

  await page.request.post(`${API_URL}/api/deployments`, {
    data: { applicationId: appId, customerId: customer.id, region: 'us-east-1' },
    headers: { cookie },
  });

  // Now try to delete — the 409 should block it. The danger zone lives
  // on the Configuration tab's Settings tab.
  const repoFullName = 'deployz-demo/express-api';
  await page.getByRole('tab', { name: 'Configuration' }).click();
  await page.waitForURL('**/config');
  await page.getByTestId('config-tab-settings').click();
  await page.getByTestId('delete-app-trigger').click();
  await page.getByTestId('delete-app-confirm').fill(repoFullName);
  await page.getByTestId('delete-app-button').click();

  // Expect an error message indicating the delete was blocked.
  // Asserted against the server's own message, which is the copy the vendor
  // reads. The literal this replaced said "cannot delete" and had drifted
  // from the product's wording months before anyone noticed.
  await expect(page.getByText(/cannot be removed/i)).toBeVisible();
});

test('cross-org isolation: cannot PATCH or DELETE another org\'s application', async ({
  browser,
}) => {
  // Org A: sign up, choose a repo, capture the app id.
  const orgAContext = await browser.newContext();
  const orgAPage = await orgAContext.newPage();
  await signUp(orgAPage);
  await orgAPage.goto('/dashboard/applications');
  await orgAPage.getByRole('button', { name: 'Select' }).first().click();
  await orgAPage.waitForURL(/\/dashboard\/applications\/[0-9a-f-]{36}$/);
  const appId = orgAPage.url().match(/\/dashboard\/applications\/([0-9a-f-]{36}$)/)![1]!;

  // Org B: sign up in a separate context, get its cookie.
  const orgBContext = await browser.newContext();
  const orgBPage = await orgBContext.newPage();
  await signUp(orgBPage);

  const orgBCookies = await orgBContext.cookies();
  const orgBCookie = orgBCookies.map(c => `${c.name}=${c.value}`).join('; ');

  // Org B tries to PATCH org A's application — expect 404.
  const patchRes = await orgBPage.request.patch(`${API_URL}/api/applications/${appId}`, {
    data: { name: 'hacked' },
    headers: { cookie: orgBCookie, 'content-type': 'application/json' },
  });
  expect(patchRes.status()).toBe(404);

  // Org B tries to DELETE org A's application — expect 404.
  const deleteRes = await orgBPage.request.delete(
    `${API_URL}/api/applications/${appId}`,
    { headers: { cookie: orgBCookie } },
  );
  expect(deleteRes.status()).toBe(404);

  await orgAContext.close();
  await orgBContext.close();
});