import { expect, test, type Page } from '@playwright/test';

import { createReadyRelease } from './seed-ready-manifest.js';

// Environment-variable ownership (docs/environment-variables.md) over the
// `deployz-demo/env-matrix-app` fixture: one variable of every ownership
// shape. The vendor moves API_BASE_URL from "Set by vendor" to "Set by
// customer"; the old vendor value must then reach no customer and no screen
// may present it as a default. Two customers install with different values
// and each sees only their own.

const API_URL = `http://localhost:${process.env.API_PORT ?? 3001}`;

interface EnvironmentSetting {
  key: string;
  stage: 'build' | 'runtime';
  required: boolean;
  secret: boolean;
  provider: 'deployz' | 'vendor' | 'customer' | 'none';
  label?: string;
}

interface EnvironmentSettingsResponse {
  settings: EnvironmentSetting[] | null;
  variables: { key: string; required: boolean; secret: boolean; classification?: string }[];
}

interface ConfigView {
  customerName: string | null;
  customerOverrides: { key: string; value: string | null; isSecret: boolean }[];
}

async function signUp(page: Page): Promise<void> {
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill('Env Ownership Vendor');
  await page.getByLabel('Email').fill(`e2e-envown-${crypto.randomUUID().slice(0, 8)}@example.com`);
  await page.getByLabel('Password').fill('super-secret-1');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL('/dashboard');
}

async function installAsCustomer(
  page: Page,
  linkId: string,
  customer: { name: string; email: string; apiBaseUrl: string; stripeKey: string },
): Promise<void> {
  await page.goto(`/install/${linkId}`);
  const settings = page.locator('section[aria-labelledby="public-config"]');
  await expect(settings).toBeVisible();
  // Only customer-provided keys are asked; vendor, managed, generated and optional keys never are.
  await expect(page.locator('#API_BASE_URL')).toBeVisible();
  await expect(page.locator('#STRIPE_SECRET_KEY')).toHaveAttribute('type', 'password');
  for (const key of ['DATABASE_URL', 'SESSION_SECRET', 'LOG_LEVEL', 'FEATURE_SIGNUPS', 'NEXT_PUBLIC_BRAND_NAME', 'PORT']) {
    await expect(page.locator(`#${key}`)).toHaveCount(0);
  }
  await expect(page.locator('#API_BASE_URL')).toHaveValue('');
  await page.locator('section[aria-labelledby="public-region"]').getByRole('combobox').click();
  await page.getByRole('option', { name: 'US East (N. Virginia)' }).click();
  await page.locator('#customer-name').fill(customer.name);
  await page.locator('#customer-email').fill(customer.email);
  await page.locator('#STRIPE_SECRET_KEY').fill(customer.stripeKey);

  const continueButton = page.getByRole('button', { name: 'Continue to setup' });
  // A whitespace-only value is no value.
  await page.locator('#API_BASE_URL').fill('   ');
  await page.locator('#API_BASE_URL').blur();
  await expect(settings.getByText('This value is required.')).toBeVisible();
  await expect(continueButton).toBeDisabled();
  await page.locator('#API_BASE_URL').fill(customer.apiBaseUrl);
  await expect(continueButton).toBeEnabled();
  await continueButton.click();
  await page.waitForURL((url) => /\/install\/[0-9a-f-]{36}$/.test(url.pathname) && !url.pathname.endsWith(linkId));
}

test('a key moved from vendor to customer reaches each customer only from that customer', async ({ page }) => {
  test.setTimeout(120_000);
  await signUp(page);
  const appResponse = await page.request.post(`${API_URL}/api/applications`, {
    data: {
      name: `Env Ownership ${crypto.randomUUID().slice(0, 8)}`,
      githubInstallationId: 'e2e-installation',
      repoFullName: 'deployz-demo/env-matrix-app',
      repoUrl: 'https://github.com/deployz-demo/env-matrix-app',
      defaultBranch: 'main',
    },
  });
  expect(appResponse.ok()).toBeTruthy();
  const application = (await appResponse.json()) as { id: string };
  expect((await page.request.post(`${API_URL}/api/applications/${application.id}/analyse`, {})).ok()).toBeTruthy();

  // ── Detection: every ownership shape lands where it belongs. ──────────────
  const detected = (await page.request
    .get(`${API_URL}/api/applications/${application.id}/environment-settings`)
    .then((r) => r.json())) as EnvironmentSettingsResponse;
  const byKey = new Map(detected.variables.map((variable) => [variable.key, variable]));
  // The .env.example sample value never makes the required read optional.
  expect(byKey.get('API_BASE_URL')).toMatchObject({ required: true, classification: 'customer_required' });
  expect(byKey.get('STRIPE_SECRET_KEY')).toMatchObject({ required: true, secret: true, classification: 'customer_required' });
  expect(byKey.get('SESSION_SECRET')).toMatchObject({ classification: 'deployz_generated' });
  expect(byKey.get('DATABASE_URL')).toMatchObject({ classification: 'deployz_managed' });
  expect(byKey.get('LOG_LEVEL')).toMatchObject({ required: false, classification: 'optional' });
  expect(byKey.get('SAMPLE_ONLY_FLAG')).toMatchObject({ required: false, classification: 'unknown' });

  // ── Vendor: accept suggestions, give API_BASE_URL a vendor value. ─────────
  await page.goto(`/dashboard/applications/${application.id}/config#environment-variables`);
  await expect(page.getByTestId('environment-variables-summary')).toContainText('2 need a decision');
  await page.getByTestId('environment-variables-accept-suggestions').click();
  await page.getByTestId('environment-variable-edit-API_BASE_URL').click();
  const vendorValue = 'https://api.vendor.example.com/v1?home=$HOME';
  await page.locator('#env-value-API_BASE_URL').fill(vendorValue);
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('environment-variables-summary')).toContainText('0 need a decision · 0 need a value');
  await expect(page.getByTestId('environment-variable-row-API_BASE_URL')).toContainText(vendorValue);

  // ── Vendor → customer. ────────────────────────────────────────────────────
  await page.getByTestId('environment-variable-edit-API_BASE_URL').click();
  await page.getByTestId('environment-variable-API_BASE_URL-provider').click();
  // Any runtime key can be mapped to a managed value (docs/environment-variables.md),
  // so "Managed by Deployz" stays available; this key goes to the customer.
  await expect(page.getByRole('option', { name: 'Managed by Deployz' })).not.toHaveAttribute('aria-disabled', 'true');
  await page.getByRole('option', { name: 'Set by customer' }).click();
  await page.locator('#env-label-API_BASE_URL').fill('API base URL');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  await expect(page.getByTestId('environment-variable-row-API_BASE_URL')).toContainText('Customer enters it at install');

  // ── Two customers install with different values. ─────────────────────────
  await createReadyRelease(page.request, application.id);
  const linkResponse = await page.request.post(`${API_URL}/api/applications/${application.id}/public-install-links`);
  expect(linkResponse.ok(), await linkResponse.text()).toBeTruthy();
  const link = (await linkResponse.json()) as { id: string };
  const secretA = `sk_test_A_${crypto.randomUUID()}`;
  const secretB = `sk_test_B_${crypto.randomUUID()}`;
  await installAsCustomer(page, link.id, {
    name: 'Customer A',
    email: `a-${crypto.randomUUID().slice(0, 8)}@example.com`,
    apiBaseUrl: 'https://a.customer.example.com',
    stripeKey: secretA,
  });
  await installAsCustomer(page, link.id, {
    name: 'Customer B',
    email: `b-${crypto.randomUUID().slice(0, 8)}@example.com`,
    apiBaseUrl: 'https://b.customer.example.com',
    stripeKey: secretB,
  });

  const deployments = (await page.request
    .get(`${API_URL}/api/deployments?applicationId=${application.id}`)
    .then((r) => r.json())) as { deployments: { customerId: string }[] };
  expect(deployments.deployments).toHaveLength(2);
  const views = await Promise.all(
    deployments.deployments.map(async (deployment) => {
      const response = await page.request.get(
        `${API_URL}/api/applications/${application.id}/config?customerId=${deployment.customerId}`,
      );
      const text = await response.text();
      // A customer secret never appears in a vendor-facing response.
      expect(text).not.toContain(secretA);
      expect(text).not.toContain(secretB);
      return { customerId: deployment.customerId, view: JSON.parse(text) as ConfigView };
    }),
  );
  const overrides = Object.fromEntries(
    views.map(({ view }) => [
      view.customerName,
      Object.fromEntries(view.customerOverrides.map((entry) => [entry.key, entry.isSecret ? 'masked' : entry.value])),
    ]),
  );
  expect(overrides).toEqual({
    'Customer A': { API_BASE_URL: 'https://a.customer.example.com', STRIPE_SECRET_KEY: 'masked' },
    'Customer B': { API_BASE_URL: 'https://b.customer.example.com', STRIPE_SECRET_KEY: 'masked' },
  });

  // The customer view never presents the old vendor value as this customer's default.
  await page.goto(`/dashboard/applications/${application.id}/config?customer=${views[0]!.customerId}#environment-variables`);
  const customerOverrides = page.getByTestId('config-customer-overrides');
  await expect(customerOverrides).toContainText('API_BASE_URL');
  await expect(customerOverrides).not.toContainText(vendorValue);
  expect(await page.locator('body').innerText()).not.toContain(secretA);
});
