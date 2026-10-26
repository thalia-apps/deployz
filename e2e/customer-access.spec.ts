import crypto from 'node:crypto';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { makeApplicationDeployable } from './seed-ready-manifest.js';

// The customer page behind an emailed code (docs/customer-access.md): an
// anonymous visitor sees only who sent the link; the owner email gets a code
// and then the page with "Connect AWS account"; another email gets nothing.

const API_URL = `http://localhost:${process.env.API_PORT ?? 3001}`;

async function seedDeployment(request: APIRequestContext): Promise<{ installLinkId: string; customerEmail: string }> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const signUp = await request.post(`${API_URL}/api/auth/sign-up/email`, {
    data: { name: `Access Vendor ${suffix}`, email: `e2e-access-${suffix}@example.com`, password: 'super-secret-1' },
  });
  expect(signUp.ok()).toBeTruthy();
  const appResponse = await request.post(`${API_URL}/api/applications`, {
    data: {
      name: `Access App ${suffix}`,
      githubInstallationId: 'e2e-installation',
      repoFullName: `deployz-demo/access-app-${suffix}`,
      repoUrl: `https://github.com/deployz-demo/access-app-${suffix}`,
      defaultBranch: 'main',
    },
  });
  expect(appResponse.ok()).toBeTruthy();
  const application = (await appResponse.json()) as { id: string };
  await makeApplicationDeployable(request, application.id);
  const customerEmail = `owner-${suffix}@example.com`;
  const customerResponse = await request.post(`${API_URL}/api/customers`, {
    data: { name: `Owner Co ${suffix}`, email: customerEmail },
  });
  expect(customerResponse.ok()).toBeTruthy();
  const customer = (await customerResponse.json()) as { id: string };
  const deploymentResponse = await request.post(`${API_URL}/api/deployments`, {
    data: { applicationId: application.id, customerId: customer.id, region: 'us-east-1' },
  });
  expect(deploymentResponse.ok()).toBeTruthy();
  const deployment = (await deploymentResponse.json()) as { installLinkId: string };
  return { installLinkId: deployment.installLinkId, customerEmail };
}

/**
 * Passes the code request through and keeps its JSON body. Playwright cannot
 * read this cross-origin fetch body from a response event, so the test
 * routes the request and reads the body it forwards.
 */
async function captureCodeResponse(page: Page): Promise<() => Record<string, unknown> | null> {
  let body: Record<string, unknown> | null = null;
  await page.route('**/api/customer/sign-in/code', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch();
    body = (await response.json()) as Record<string, unknown>;
    await route.fulfill({ response, json: body });
  });
  return () => body;
}

test('the owner verifies the email before the page offers Connect AWS account, and can sign out', async ({
  page,
  request,
}) => {
  const { installLinkId, customerEmail } = await seedDeployment(request);

  await page.goto(`/install/${installLinkId}`);
  await expect(page.getByText('Verify your email')).toBeVisible();
  await expect(page.getByText(/^Published by /)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Connect AWS account' })).toHaveCount(0);

  const codeBody = await captureCodeResponse(page);
  await page.getByLabel('Email').fill(customerEmail);
  await page.getByRole('button', { name: 'Send code' }).click();
  await expect(page.getByLabel('Code')).toBeVisible();
  const fixtureCode = String(codeBody()?.['fixtureCode']);

  await page.getByLabel('Code').fill(fixtureCode);
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByText(`Signed in as ${customerEmail}`)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Connect AWS account' })).toBeVisible();

  // A reload keeps the session: it lives in a cookie, not in the page.
  await page.reload();
  await expect(page.getByRole('link', { name: 'Connect AWS account' })).toBeVisible();

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByText('Verify your email')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Connect AWS account' })).toHaveCount(0);
});

test('another email gets the same answer and no access', async ({ page, request }) => {
  const { installLinkId } = await seedDeployment(request);

  await page.goto(`/install/${installLinkId}`);
  const codeBody = await captureCodeResponse(page);
  await page.getByLabel('Email').fill('someone-else@example.com');
  await page.getByRole('button', { name: 'Send code' }).click();
  await expect(page.getByText('If someone-else@example.com has access')).toBeVisible();
  expect(codeBody()).toEqual({ accepted: true });

  await page.getByLabel('Code').fill('12345678');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText(/not correct or has expired/)).toBeVisible();

  const status = await page.request.get(`${API_URL}/api/install/${installLinkId}/status`);
  expect(status.status()).toBe(404);
});
