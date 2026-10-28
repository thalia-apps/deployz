import { expect, test, type Page } from '@playwright/test';

// §48 billing display, against the REAL `GET /api/billing/summary` endpoint
// (previously pointed at a nonexistent /api/billing and always rendered
// fixture data). A fresh org has base-only billing: Platform $49, no
// deployment lines, Monthly total $49. §65: all top-level copy is
// jargon-free (no "Stripe", "meter event", "proration").

const JARGON = /\b(Stripe|Paddle|meter event|proration|usage record|metered)\b/i;

async function signUp(page: Page): Promise<void> {
  const email = `e2e-${crypto.randomUUID().slice(0, 8)}@example.com`;
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill('E2E User');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('super-secret-1');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL('/dashboard');
}

// The simulated E2E runner sets BILLING_FIXTURE_MODE, which gives every new
// organization an ACTIVE subscription — so a fresh org here lands on the
// subscribed branch of the page, not the evaluation one.
test('billing page renders the §48 base-only breakdown for a fresh org', async ({ page }) => {
  await signUp(page);
  await page.goto('/dashboard/settings/billing');

  await expect(page.getByRole('heading', { name: 'Billing' })).toBeVisible();
  await expect(page.getByText('Platform', { exact: true })).toBeVisible();
  await expect(page.getByText('$49', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Monthly total')).toBeVisible();
  await expect(page.getByText('No customer deployments are live yet.')).toBeVisible();
});

test('billing is reachable from the dashboard nav (§41 screen 17)', async ({ page }) => {
  await signUp(page);
  await page.goto('/dashboard');
  await page.getByRole('navigation', { name: 'Dashboard' }).getByRole('link', { name: 'Billing' }).click();
  await page.waitForURL('**/dashboard/settings/billing');
  await expect(page.getByRole('heading', { name: 'Billing' })).toBeVisible();
});

test('billing page top-level copy is jargon-free (§65)', async ({ page }) => {
  await signUp(page);
  await page.goto('/dashboard/settings/billing');

  const text = await page.locator('body').innerText();
  expect(text).not.toMatch(JARGON);
});

const API_URL = `http://localhost:${process.env.API_PORT ?? 3001}`;

async function setSubscription(page: Page, status: 'CANCELED' | 'PAST_DUE' | null): Promise<void> {
  const response = await page.request.post(`${API_URL}/internal/fixture/billing/subscription`, {
    data: { status },
  });
  expect(response.ok()).toBeTruthy();
}

// The Plan card follows the subscription status. Simulated runs have no
// billing provider, so the subscribe button is replaced by a plain line.
test('evaluation shows the price and says subscriptions are not available here', async ({ page }) => {
  await signUp(page);
  await setSubscription(page, null);
  await page.goto('/dashboard/settings/billing');

  const plan = page.getByTestId('billing-plan');
  await expect(page.getByTestId('billing-status')).toHaveText('Evaluating');
  await expect(plan.getByText('You are evaluating Deployz — free')).toBeVisible();
  await expect(page.getByTestId('billing-price')).toContainText('$49');
  await expect(page.getByTestId('billing-price')).toContainText('+ $19/month');
  await expect(plan.getByText('Subscriptions are not available yet.')).toBeVisible();
  await expect(page.getByText('Monthly total')).toHaveCount(0);
});

test('a canceled subscription offers a restart, not a monthly total', async ({ page }) => {
  await signUp(page);
  await setSubscription(page, 'CANCELED');
  await page.goto('/dashboard/settings/billing');

  await expect(page.getByTestId('billing-status')).toHaveText('Canceled');
  // The app-wide CANCELED banner carries the same title; check the Plan card.
  await expect(page.getByTestId('billing-plan').getByText('Your subscription has ended')).toBeVisible();
  await expect(page.getByText('Monthly total')).toHaveCount(0);
});

test('a past-due subscription leads with updating the payment details', async ({ page }) => {
  await signUp(page);
  await setSubscription(page, 'PAST_DUE');
  await page.goto('/dashboard/settings/billing');

  const plan = page.getByTestId('billing-plan');
  await expect(plan.getByText('Your last payment did not go through')).toBeVisible();
  await expect(plan.getByTestId('manage-billing-updatePaymentMethod')).toBeVisible();
  await expect(page.getByText('Monthly total')).toBeVisible();
});
