import { expect, test, type Page } from '@playwright/test';

import { createReadyRelease } from './seed-ready-manifest.js';

// CANARY-004: the create-deployment form (§12/§41 screen 12) used to swallow
// every /api/deployments failure behind a fixed "Try again in a moment" and
// re-created the customer on every retry. With the invitation-first flow,
// the vendor creates an invitation (no manifest validation), and the customer
// confirms (manifest validation happens here). This test verifies that when
// the customer tries to confirm an invitation for an incompatible application,
// the error is shown and the customer is not duplicated on retry.

const API_URL = `http://localhost:${process.env.API_PORT ?? 3001}`;

async function signUp(page: Page): Promise<void> {
  const email = `e2e-canary004-${crypto.randomUUID().slice(0, 8)}@example.com`;
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill('E2E Canary Vendor');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('super-secret-1');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL('/dashboard');
}

/** Mirrors e2e/redis.spec.ts's `seedAnalysedApplication`. */
async function seedNotCompatibleApplication(page: Page, suffix: string): Promise<string> {
  const appResponse = await page.request.post(`${API_URL}/api/applications`, {
    data: {
      name: `Canary Test ${suffix}`,
      githubInstallationId: 'e2e-installation',
      repoFullName: 'deployz-demo/legacy-redis',
      repoUrl: 'https://github.com/deployz-demo/legacy-redis',
      defaultBranch: 'main',
    },
  });
  expect(appResponse.ok()).toBeTruthy();
  const application = (await appResponse.json()) as { id: string };

  const analyseResponse = await page.request.post(
    `${API_URL}/api/applications/${application.id}/analyse`,
  );
  expect(analyseResponse.ok()).toBeTruthy();

  return application.id;
}

async function seedCustomer(page: Page, suffix: string): Promise<string> {
  const response = await page.request.post(`${API_URL}/api/customers`, {
    data: {
      name: `Canary Customer ${suffix}`,
      email: `canary-customer-${suffix}@example.com`,
    },
  });
  expect(response.ok()).toBeTruthy();
  const customer = (await response.json()) as { id: string };
  return customer.id;
}

test('a MANIFEST_NOT_COMPATIBLE rejection at customer confirm shows the server reason and does not duplicate the customer on retry', async ({
  page,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const customerEmail = `canary-customer-${suffix}@example.com`;

  await signUp(page);
  const applicationId = await seedNotCompatibleApplication(page, suffix);
  const customerId = await seedCustomer(page, suffix);
  // The public install page 410s the whole surface (RELEASE_NOT_PUBLISHED)
  // when there is no release at all, rather than rendering a degraded form
  // — unlike the vendor's own create-deployment page, it has no "no release
  // yet" state to show. A release must exist before the incompatibility
  // (legacy-redis's unsupported Redis Stack dependency) is even reachable.
  await createReadyRelease(page.request, applicationId);

  // Vendor creates invitation (no manifest validation at this point)
  const invitationResponse = await page.request.post(
    `${API_URL}/api/customers/${customerId}/invitations`,
    {
      data: {
        applicationId,
      },
    },
  );
  expect(invitationResponse.ok()).toBeTruthy();
  const invitation = (await invitationResponse.json()) as { id: string; token: string };

  // Customer opens invitation with token in URL fragment
  await page.goto(`/install/${invitation.id}#${invitation.token}`);

  // Wait for the page to load and resolve the invitation
  await expect(page.getByRole('heading', { name: /Install/ })).toBeVisible();
  await expect(page.getByText('Release 0.1.0')).toBeVisible();

  // Select a region (explicit choice required). The trigger has no
  // accessible name (see final report), so it is scoped by its section
  // instead of matched by role name.
  await page.locator('section[aria-labelledby="public-region"]').getByRole('combobox').click();
  await page.getByRole('option', { name: 'US East (N. Virginia)' }).click();

  const submit = page.getByRole('button', { name: 'Continue to setup' });
  await expect(submit).toBeEnabled();
  await submit.click();

  // Manifest validation happens at confirm time, against the real API — the
  // customer-facing message is deliberately generic (no vendor-internal
  // readiness details or dashboard links are shown to a customer).
  // Scoped to the form: Next.js's own route announcer also carries
  // role="alert" and would otherwise make this locator ambiguous.
  const alert = page.locator('form [role="alert"]');
  await expect(alert).toContainText(
    'This application cannot be installed in its current state. Contact your software provider.',
  );

  // Retry with the same customer: the API rejects again (the manifest is
  // still NOT_COMPATIBLE), but the customer row should not be duplicated.
  await submit.click();
  await expect(alert).toContainText(
    'This application cannot be installed in its current state. Contact your software provider.',
  );

  const customersResponse = await page.request.get(`${API_URL}/api/customers`);
  expect(customersResponse.ok()).toBeTruthy();
  const { customers } = (await customersResponse.json()) as {
    customers: { email: string }[];
  };
  expect(customers.filter((customer) => customer.email === customerEmail)).toHaveLength(1);
});
