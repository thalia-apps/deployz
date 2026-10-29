import { expect, test } from '@playwright/test';

const API_URL = `http://localhost:${process.env.API_PORT ?? 3001}`;

// U7 end-to-end: browser signup on the Next.js UI sets a session cookie (from
// the Fastify API); the Next.js SERVER then honors that cookie when it calls
// the API — proving cross-surface session sharing without any client tricks.
// The proof renders in the dashboard shell: the server-side layout resolves
// the session via fetchMe() and shows the user identity + tenant name.
test('signup via the web UI lands authenticated and the API honors the session server-side', async ({
  page,
}) => {
  const email = `e2e-${crypto.randomUUID().slice(0, 8)}@example.com`;

  await page.goto('/sign-up');
  await page.getByLabel('Name').fill('E2E User');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('super-secret-1');
  await page.getByRole('button', { name: 'Create account' }).click();

  await page.waitForURL('/dashboard');
  // User identity lives in the sidebar footer now: the trigger shows the
  // name and the account menu carries the session email, settings, sign-out.
  const footer = page.locator('[data-sidebar="footer"]');
  await expect(footer.getByTestId('user-menu-trigger')).toContainText('E2E User');
  await footer.getByTestId('user-menu-trigger').click();
  await expect(page.getByTestId('user-menu-email')).toHaveText(email);
  await expect(page.getByRole('menuitem', { name: 'Settings' })).toHaveAttribute(
    'href',
    '/dashboard/settings/profile',
  );
  await expect(page.getByRole('menuitem', { name: 'Sign out' })).toBeVisible();
  // Tenant provisioning proof: the org name derives from the email local part.
  await expect(page.getByTestId('org-name')).toHaveText(email.split('@')[0] ?? '');
});

// The login half of U7: an account created straight against the API signs in
// through the web form and the same server-side session proof holds.
test('signin via the web form honors an existing account', async ({ page, request }) => {
  const email = `e2e-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const password = 'super-secret-1';
  const created = await request.post(
    `${API_URL}/api/auth/sign-up/email`,
    { data: { name: 'E2E User', email, password } },
  );
  expect(created.ok()).toBeTruthy();

  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await page.waitForURL('/dashboard');
  await page.locator('[data-sidebar="footer"]').getByTestId('user-menu-trigger').click();
  await expect(page.getByTestId('user-menu-email')).toHaveText(email);
});

// The reset e-mail is not readable from the browser suite, so the token step is
// covered by the API test (apps/api/src/auth.test.ts). This journey proves the
// pages, the link on the sign-in page and the answer that never reveals whether
// an address has an account.
test('forgot password answers the same for an unknown address and links to the reset page', async ({
  page,
}) => {
  await page.goto('/sign-in');
  await page.getByRole('link', { name: 'Forgot password?' }).click();
  await page.waitForURL('/forgot-password');

  await page.getByLabel('Email').fill(`nobody-${crypto.randomUUID().slice(0, 8)}@example.com`);
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByRole('status')).toContainText(
    'If an account uses this email address, we sent a link to reset the password.',
  );

  await page.goto('/reset-password');
  await expect(page.getByText('This reset link is not valid.')).toBeVisible();

  await page.goto('/reset-password?token=not-a-real-token');
  await page.getByLabel('New password').fill('another-secret-1');
  await page.getByRole('button', { name: 'Reset password' }).click();
  await expect(page.getByText('Invalid token')).toBeVisible();
});
