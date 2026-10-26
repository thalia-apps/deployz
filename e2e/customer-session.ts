import { expect, type APIRequestContext } from '@playwright/test';

const API_URL = `http://localhost:${process.env.API_PORT ?? 3001}`;

/**
 * Signs a browser context in as the deployment's owner, as the emailed code
 * does (docs/customer-access.md). Pass `page.request` so the session cookie
 * lands in the page's browser context. Simulated E2E runs the API with
 * EMAIL_VERIFICATION_FIXTURE_MODE, which returns the code in the response.
 */
export async function signInAsCustomer(
  request: APIRequestContext,
  installLinkId: string,
  email: string,
): Promise<void> {
  const requested = await request.post(`${API_URL}/api/customer/sign-in/code`, { data: { installLinkId, email } });
  expect(requested.status()).toBe(202);
  const { fixtureCode } = (await requested.json()) as { fixtureCode?: string };
  expect(fixtureCode, `no code was sent to ${email}`).toMatch(/^\d{8}$/);
  const verified = await request.post(`${API_URL}/api/customer/sign-in/verify`, {
    data: { installLinkId, code: fixtureCode },
  });
  expect(verified.ok(), await verified.text()).toBeTruthy();
}
