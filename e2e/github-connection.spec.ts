import { expect, test, type Page } from '@playwright/test';

import { createReadyRelease } from './seed-ready-manifest.js';

const API_URL = `http://localhost:${process.env.API_PORT ?? 3001}`;

// GitHub disconnect and reconnect (docs/architecture.md "GitHub connection").
// The API runs in GITHUB_FIXTURE_MODE, where the fixture installation's
// connection status is kept per organization, so each test's fresh
// organization disconnects only itself.

async function signUpWithApplication(page: Page): Promise<string> {
  const email = `e2e-${crypto.randomUUID().slice(0, 8)}@example.com`;
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill('E2E User');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('super-secret-1');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL('/dashboard');
  await page.goto('/dashboard/applications');
  await page.getByRole('button', { name: 'Select' }).first().click();
  await page.waitForURL(/\/dashboard\/applications\/[0-9a-f-]{36}$/);
  return page.url().match(/\/dashboard\/applications\/([0-9a-f-]{36})/)![1]!;
}

test('an owner disconnects and reconnects GitHub without losing the application', async ({ page }) => {
  // One flow across five dashboard pages; each can compile cold under next dev.
  test.setTimeout(180_000);
  const applicationId = await signUpWithApplication(page);
  await createReadyRelease(page.request, applicationId);

  await page.goto('/dashboard/settings');
  const connection = page.getByTestId('github-connection-fixture-install-1');
  await expect(connection.getByText('deployz-demo', { exact: true })).toBeVisible();
  await expect(connection.getByTestId('github-connection-status')).toHaveText('Connected');
  await expect(connection.getByText('Used by 1 application.')).toBeVisible();
  await expect(connection.getByTestId('github-manage-access')).toHaveAttribute(
    'href',
    'https://github.com/organizations/deployz-demo/settings/installations/fixture-install-1',
  );

  await connection.getByTestId('github-disconnect').click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog.getByRole('heading', { name: 'Disconnect GitHub?' })).toBeVisible();
  await expect(dialog.getByTestId('github-disconnect-affected')).toHaveText('1 application uses this connection.');
  await expect(dialog.getByText('Existing applications, releases, and running customer deployments will remain intact.')).toBeVisible();
  await dialog.getByTestId('github-disconnect-confirm').click();
  await expect(dialog).toHaveCount(0);
  await expect(connection.getByTestId('github-connection-status')).toHaveText('Disconnected');

  // The status persists across a refresh.
  await page.reload();
  await expect(page.getByTestId('github-connection-fixture-install-1').getByTestId('github-connection-status')).toHaveText(
    'Disconnected',
  );

  // New GitHub-dependent work is refused; the existing release stays.
  const analyse = await page.request.post(`${API_URL}/api/applications/${applicationId}/analyse`);
  expect(analyse.status()).toBe(409);
  expect(await analyse.json()).toMatchObject({ error: { code: 'GITHUB_NOT_CONNECTED' } });
  const release = await page.request.post(`${API_URL}/api/applications/${applicationId}/releases`, {
    data: { version: '2.0.0', gitSha: 'b'.repeat(40) },
  });
  expect(release.status()).toBe(409);
  const { releases } = (await (await page.request.get(`${API_URL}/api/applications/${applicationId}/releases`)).json()) as {
    releases: { status: string }[];
  };
  expect(releases.map((row) => row.status)).toContain('READY');

  // The picker offers no repositories from a disconnected connection.
  await page.goto('/dashboard/applications/new');
  await expect(page.getByTestId('github-inactive')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Select' })).toHaveCount(0);

  // The application page says why and offers the reconnect in place.
  await page.goto(`/dashboard/applications/${applicationId}/config#settings`);
  await expect(page.getByTestId('repository-connection-status')).toHaveText('Disconnected');
  const alert = page.getByTestId('repository-access-alert');
  await expect(alert).toContainText('Analysis and new release builds are paused.');
  await alert.getByTestId('repository-reconnect').click();
  await expect(page.getByTestId('repository-connection-status')).toHaveText('Connected');
  await expect(page.getByTestId('repository-access-alert')).toHaveCount(0);

  const again = await page.request.post(`${API_URL}/api/applications/${applicationId}/analyse`);
  expect(again.status()).toBe(202);
  await page.goto('/dashboard/settings');
  await expect(page.getByTestId('github-connection-fixture-install-1').getByTestId('github-connection-status')).toHaveText(
    'Connected',
  );
});

test('a member sees the GitHub connection but cannot change it', async ({ page }) => {
  await signUpWithApplication(page);
  await page.route('**/api/github/installations', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), canConnect: false } });
  });

  await page.goto('/dashboard/settings');
  const connection = page.getByTestId('github-connection-fixture-install-1');
  await expect(connection.getByTestId('github-connection-status')).toHaveText('Connected');
  await expect(connection.getByTestId('github-disconnect')).toHaveCount(0);
  await expect(page.getByText('Only an owner or admin can change the GitHub connection.')).toBeVisible();
});

test('a failed GitHub return is shown on the page that started it', async ({ page }) => {
  await signUpWithApplication(page);
  await page.goto('/dashboard/settings?github=failed');
  await expect(page.getByTestId('github-return-failure')).toContainText('GitHub was not connected');
});
