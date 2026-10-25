import { expect, test, type Page } from '@playwright/test';

// Todo 15 — GitHub App repo-selection. The API runs with GITHUB_FIXTURE_MODE
// (see playwright.config.ts), so the fixture org + repos render without a real
// GitHub App. The "Connect GitHub" empty state is exercised by intercepting
// the installations fetch and returning an empty list.

async function signUp(page: Page): Promise<void> {
  const email = `e2e-${crypto.randomUUID().slice(0, 8)}@example.com`;
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill('E2E User');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('super-secret-1');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL('/dashboard');
}

test('applications page lists the fixture installation and its repositories', async ({ page }) => {
  await signUp(page);
  await page.goto('/dashboard/applications');

  await expect(page.getByRole('heading', { name: 'Applications', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Add your first application' })).toBeVisible();
  await expect(page.getByRole('searchbox', { name: 'Search repositories' })).toBeVisible();

  // The fixture org's installation + both §216 fixture repos.
  await expect(page.getByText('deployz-demo', { exact: true })).toBeVisible();
  await expect(page.getByText('express-api', { exact: true })).toBeVisible();
  await expect(page.getByText('legacy-redis', { exact: true })).toBeVisible();
});

test('says so when the GitHub App setup did not link an installation', async ({ page }) => {
  await signUp(page);
  await page.goto('/dashboard/applications?github=failed');
  await expect(page.getByText('GitHub was not connected')).toBeVisible();

  await page.goto('/dashboard/applications?github=connected');
  await expect(page.getByRole('heading', { name: 'Applications', exact: true })).toBeVisible();
  await expect(page.getByText('GitHub was not connected')).toHaveCount(0);
});

test('shows the Connect GitHub empty state when there are no installations', async ({ page }) => {
  await signUp(page);

  await page.route('**/api/github/installations', (route) =>
    route.fulfill({ json: { installations: [], connectUrl: null } }),
  );

  await page.goto('/dashboard/applications');

  await expect(page.getByRole('heading', { name: 'Connect your code' })).toBeVisible();
  await expect(page.getByText('Connect GitHub', { exact: true })).toBeVisible();
  // The honest empty state never fabricates a repo list.
  await expect(page.getByText('express-api', { exact: true })).toHaveCount(0);
});

test('applications page renders for a fresh org without a real App', async ({ page }) => {
  await signUp(page);
  await page.goto('/dashboard/applications');
  // Fixture mode returns the demo installation, so the repo surface renders —
  // but the page header + shell are always present.
  await expect(page.getByRole('heading', { name: 'Applications', exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Dashboard' })).toBeVisible();
});

// Regression: a repository listing GitHub can't answer for used to reject the
// whole panel, so "Add application" led to "Something went wrong" with no
// Connect GitHub button — no way to add an application, and no way to repair
// the connection either.
test('keeps the repo picker usable when GitHub will not list repositories', async ({ page }) => {
  await signUp(page);

  await page.route('**/api/github/installations', (route) =>
    route.fulfill({
      json: {
        installations: [
          { id: 'fixture-install-1', accountLogin: 'deployz-demo', accountType: 'Organization' },
        ],
        connectUrl: 'https://github.com/apps/deployz-demo/installations/new',
      },
    }),
  );
  await page.route('**/api/github/repos*', (route) =>
    route.fulfill({
      status: 502,
      json: { error: { code: 'GITHUB_REPO_LIST_FAILED', message: 'Failed to list repositories' } },
    }),
  );

  await page.goto('/dashboard/applications');

  // The account is still listed, the failure is named for what it is, and the
  // way back to GitHub is still on the page.
  await expect(page.getByText('deployz-demo', { exact: true })).toBeVisible();
  await expect(page.getByTestId('repos-unavailable-fixture-install-1')).toBeVisible();
  await expect(page.getByTestId('github-manage')).toBeVisible();
  await expect(page.getByTestId('github-error')).toHaveCount(0);
  // A failure is never dressed up as an account with nothing in it.
  await expect(page.getByText('No repositories to show.', { exact: true })).toHaveCount(0);
});

test('offers a retry when the installation list itself is unreachable', async ({ page }) => {
  await signUp(page);

  await page.route('**/api/github/installations', (route) => route.fulfill({ status: 500, json: {} }));

  await page.goto('/dashboard/applications');

  await expect(page.getByTestId('github-error')).toBeVisible();
  await expect(page.getByTestId('github-retry')).toBeVisible();

  // Retrying re-runs the load rather than reloading the page.
  await page.unroute('**/api/github/installations');
  await page.route('**/api/github/installations', (route) =>
    route.fulfill({ json: { installations: [], connectUrl: null } }),
  );
  await page.getByTestId('github-retry').click();
  await expect(page.getByRole('heading', { name: 'Connect your code' })).toBeVisible();
});
