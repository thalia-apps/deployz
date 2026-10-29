import { expect, test, type Page } from '@playwright/test';

// The Customers screen, against the REAL API. It answers three questions per
// row — who is this customer, have they deployed, what should I do next — so
// these tests assert on the answers: identity grouped in one column, a
// vendor-friendly deployment status with no raw AWS wording, and actions that
// only appear when the row's data supports them.
//
// The data-safety tests are the important ones: editing a customer's name and
// email must leave their install link and deployment untouched, and removing a
// customer must be refused while they still have a deployment.

import { makeApplicationDeployable } from './seed-ready-manifest.js';

const API_URL = `http://localhost:${process.env.API_PORT ?? 3001}`;

// Raw AWS service terms that must NOT appear in rendered top-level copy.
const JARGON = /\b(CloudFormation|IAM|ECS|ALB|Lambda|VPC|CFN)\b/;
// Raw CloudFormation lifecycle statuses, which must never reach this screen.
const RAW_STATUS = /\b(CREATE|UPDATE|DELETE|ROLLBACK|REVIEW)(_ROLLBACK)?_(COMPLETE|IN_PROGRESS|FAILED)\b/;

async function signUp(page: Page): Promise<void> {
  const email = `e2e-customers-${crypto.randomUUID().slice(0, 8)}@example.com`;
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill('E2E Vendor');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('super-secret-1');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL('/dashboard');
}

interface SeededCustomer {
  id: string;
  name: string;
  email: string;
  company: string | null;
}

async function seedCustomer(
  page: Page,
  overrides: { name?: string; email?: string; company?: string | null } = {},
): Promise<SeededCustomer> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const response = await page.request.post(`${API_URL}/api/customers`, {
    data: {
      name: overrides.name ?? `Acme Corp ${suffix}`,
      email: overrides.email ?? `acme-${suffix}@example.com`,
      company: overrides.company ?? null,
    },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as SeededCustomer;
}

async function seedApplication(page: Page): Promise<string> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const response = await page.request.post(`${API_URL}/api/applications`, {
    data: {
      name: `Acme Analytics ${suffix}`,
      githubInstallationId: 'e2e-installation',
      repoFullName: `deployz-demo/acme-analytics-${suffix}`,
      repoUrl: `https://github.com/deployz-demo/acme-analytics-${suffix}`,
      defaultBranch: 'main',
    },
  });
  expect(response.ok()).toBeTruthy();
  const application = (await response.json()) as { id: string };
  await makeApplicationDeployable(page.request, application.id);
  return application.id;
}

async function seedDeployment(
  page: Page,
  applicationId: string,
  customerId: string,
): Promise<{ id: string; installLinkId: string; installLinkToken: string }> {
  const response = await page.request.post(`${API_URL}/api/deployments`, {
    data: { applicationId, customerId, region: 'us-east-1' },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as {
    id: string;
    installLinkId: string;
    installLinkToken: string;
  };
}

test('the empty state invites the first customer', async ({ page }) => {
  await signUp(page);
  await page.goto('/dashboard/customers');

  await expect(page.getByRole('heading', { name: 'Customers', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Add your first customer' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Invite customer' })).toBeVisible();
});

test('a customer row groups name and email, and shows a vendor-friendly deployment status', async ({
  page,
}) => {
  await signUp(page);
  const customer = await seedCustomer(page, { company: 'Acme Holdings' });
  const applicationId = await seedApplication(page);
  await seedDeployment(page, applicationId, customer.id);

  await page.goto('/dashboard/customers');
  const list = page.getByTestId('customer-list');
  await expect(list).toBeVisible();

  // Identity is one column: the name links to the customer and the email sits
  // beneath it as muted text — there is no separate Email or Company column.
  const row = list.getByRole('row').filter({ hasText: customer.name });
  await expect(row.getByRole('link', { name: customer.name })).toBeVisible();
  await expect(row.getByText(customer.email)).toBeVisible();
  await expect(list.getByRole('columnheader', { name: 'Email' })).toHaveCount(0);
  await expect(list.getByRole('columnheader', { name: 'Company' })).toHaveCount(0);

  // The row says one thing about the customer: their deployment summary. A
  // deployment nobody has installed yet is "Setup pending", never a lifecycle
  // state or an AWS status.
  await expect(row.getByTestId('customer-summary')).toHaveText('Setup pending');

  const body = await page.locator('body').innerText();
  expect(body).not.toMatch(JARGON);
  expect(body).not.toMatch(RAW_STATUS);
});

test('search filters by name, by email and by company, and says so when nothing matches', async ({
  page,
}) => {
  await signUp(page);
  const first = await seedCustomer(page, {
    name: 'Northwind Trading',
    email: 'ops@northwind.example',
    company: 'Northwind Group',
  });
  const second = await seedCustomer(page, {
    name: 'Contoso Retail',
    email: 'admin@contoso.example',
    company: 'Contoso Ltd',
  });

  await page.goto('/dashboard/customers');
  const list = page.getByTestId('customer-list');
  await expect(list).toBeVisible();
  const search = page.getByLabel('Search customers');

  await search.fill('northwind trading');
  await expect(list.getByText(first.name)).toBeVisible();
  await expect(list.getByText(second.name)).toHaveCount(0);

  await search.fill('admin@contoso');
  await expect(list.getByText(second.name)).toBeVisible();
  await expect(list.getByText(first.name)).toHaveCount(0);

  await search.fill('Contoso Ltd');
  await expect(list.getByText(second.name)).toBeVisible();

  await search.fill('nobody-by-that-name');
  await expect(page.getByText('No customers match these filters.')).toBeVisible();

  await search.fill('');
  await expect(list.getByText(first.name)).toBeVisible();
  await expect(list.getByText(second.name)).toBeVisible();
});

test('the customer name opens the customer page, which shows the install link', async ({
  page,
}) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await signUp(page);
  const customer = await seedCustomer(page, { company: 'Acme Holdings' });
  const applicationId = await seedApplication(page);
  const deployment = await seedDeployment(page, applicationId, customer.id);

  await page.goto('/dashboard/customers');
  await page.getByRole('link', { name: customer.name }).click();
  await page.waitForURL(`/dashboard/customers/${customer.id}`);

  await expect(page.getByRole('heading', { name: customer.name })).toBeVisible();
  await expect(page.getByText(customer.email)).toBeVisible();
  await expect(page.getByText('Acme Holdings')).toBeVisible();
  await page.getByRole('button', { name: 'Copy install link' }).click();
  const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboardText).toBe(
    `${new URL(page.url()).origin}/install/${deployment.installLinkId}#${deployment.installLinkToken}`,
  );
  await expect(page.getByRole('link', { name: 'View deployment' })).toHaveAttribute(
    'href',
    `/dashboard/deployments/${deployment.id}`,
  );

  const body = await page.locator('body').innerText();
  expect(body).not.toMatch(JARGON);
  expect(body).not.toMatch(RAW_STATUS);
});

test('editing name, email and company leaves the install link, the deployment and the customer id untouched', async ({
  page,
}) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await signUp(page);
  const customer = await seedCustomer(page);
  const applicationId = await seedApplication(page);
  const deployment = await seedDeployment(page, applicationId, customer.id);

  await page.goto(`/dashboard/customers/${customer.id}`);
  await page.getByRole('button', { name: 'Copy install link' }).click();
  const installLink = `${new URL(page.url()).origin}/install/${deployment.installLinkId}#${deployment.installLinkToken}`;
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(installLink);

  await page.getByRole('button', { name: 'Edit customer' }).click();
  const dialog = page.getByTestId('edit-customer-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Name').fill('Renamed Customer');
  await dialog.getByLabel('Email').fill('renamed@example.com');
  await dialog.getByLabel('Company (optional)').fill('Renamed Holdings');
  await dialog.getByRole('button', { name: 'Save changes' }).click();

  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Renamed Customer' })).toBeVisible();
  await expect(page.getByText('renamed@example.com')).toBeVisible();
  await expect(page.getByText('Renamed Holdings')).toBeVisible();

  // The identity anchor and everything hung off it are unchanged: same
  // customer id, same install link, same deployment, still owned by them.
  const stored = await page.request.get(`${API_URL}/api/customers/${customer.id}`);
  expect(stored.ok()).toBeTruthy();
  expect((await stored.json()) as { id: string }).toMatchObject({
    id: customer.id,
    name: 'Renamed Customer',
    email: 'renamed@example.com',
    company: 'Renamed Holdings',
  });

  const after = await page.request.get(`${API_URL}/api/deployments/${deployment.id}`);
  expect(after.ok()).toBeTruthy();
  const detail = (await after.json()) as {
    id: string;
    customerId: string;
    installLinkId: string;
    state: string;
  };
  expect(detail.id).toBe(deployment.id);
  expect(detail.customerId).toBe(customer.id);
  expect(detail.installLinkId).toBe(deployment.installLinkId);
  expect(detail.state).toBe('NOT_INSTALLED');

  await page.getByRole('button', { name: 'Copy install link' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(installLink);
});

test('the row menu only offers what the row supports, and a customer with a deployment cannot be deleted', async ({
  page,
}) => {
  await signUp(page);
  const withoutDeployment = await seedCustomer(page, { name: 'Solo Customer' });
  const withDeployment = await seedCustomer(page, { name: 'Deployed Customer' });
  const applicationId = await seedApplication(page);
  await seedDeployment(page, applicationId, withDeployment.id);

  await page.goto('/dashboard/customers');
  const list = page.getByTestId('customer-list');
  await expect(list).toBeVisible();

  // A customer with no deployment has no deployment to view, but can be
  // removed.
  await page.getByRole('button', { name: `Actions for ${withoutDeployment.name}` }).click();
  await expect(page.getByRole('menuitem', { name: 'View deployment' })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: 'Edit customer' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Delete customer' })).toBeVisible();
  await page.keyboard.press('Escape');

  // A customer with a deployment gets the deployment link, and is not
  // offered a delete the API would refuse.
  await page.getByRole('button', { name: `Actions for ${withDeployment.name}` }).click();
  await expect(page.getByRole('menuitem', { name: 'View deployment' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Delete customer' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  // The API refuses it too, so the guard does not depend on the menu.
  const refused = await page.request.delete(`${API_URL}/api/customers/${withDeployment.id}`);
  expect(refused.status()).toBe(409);
  expect((await refused.json()) as { error: { code: string } }).toMatchObject({
    error: { code: 'CUSTOMER_HAS_DEPLOYMENTS' },
  });
});

test('deleting a customer with no deployment asks for confirmation first', async ({ page }) => {
  await signUp(page);
  const customer = await seedCustomer(page, { name: 'Removable Customer' });

  await page.goto('/dashboard/customers');
  await expect(page.getByTestId('customer-list')).toBeVisible();

  await page.getByRole('button', { name: `Actions for ${customer.name}` }).click();
  await page.getByRole('menuitem', { name: 'Delete customer' }).click();

  const confirm = page.getByTestId('delete-customer-dialog');
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText('Nothing is removed from any AWS account');

  // Cancelling keeps the customer.
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toHaveCount(0);
  await expect(page.getByTestId('customer-list').getByText(customer.name)).toBeVisible();

  await page.getByRole('button', { name: `Actions for ${customer.name}` }).click();
  await page.getByRole('menuitem', { name: 'Delete customer' }).click();
  await page.getByTestId('delete-customer-dialog')
    .getByRole('button', { name: 'Remove customer' })
    .click();

  // Scoped to the list: the success toast repeats the customer's name.
  await expect(page.getByTestId('delete-customer-dialog')).toHaveCount(0);
  await expect(page.getByTestId('customer-list').getByText(customer.name)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Add your first customer' })).toBeVisible();

  const gone = await page.request.get(`${API_URL}/api/customers/${customer.id}`);
  expect(gone.status()).toBe(404);
});

test('the create-installation flow captures a company and offers the install link to copy', async ({
  page,
}) => {
  await signUp(page);
  const applicationId = await seedApplication(page);
  const suffix = crypto.randomUUID().slice(0, 8);

  await page.goto(`/dashboard/deployments/new?applicationId=${applicationId}`);
  await page.getByLabel('Customer name').fill(`New Customer ${suffix}`);
  await page.getByLabel('Customer email').fill(`new-customer-${suffix}@example.com`);
  await page.getByLabel('Company (optional)').fill('New Holdings');
  await page.getByRole('button', { name: 'Invite customer' }).click();

  await expect(page.getByText('Invitation created')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy link' })).toBeVisible();

  await page.goto('/dashboard/customers');
  const row = page
    .getByTestId('customer-list')
    .getByRole('row')
    .filter({ hasText: `New Customer ${suffix}` });
  await row.getByRole('link', { name: `New Customer ${suffix}` }).click();
  await page.waitForURL(/\/dashboard\/customers\/[0-9a-f-]{36}$/);
  await expect(page.getByText('New Holdings')).toBeVisible();
});

test('Invite customer from the customer page preselects the customer and creates an invitation', async ({
  page,
}) => {
  await signUp(page);
  const customer = await seedCustomer(page);
  const applicationId = await seedApplication(page);
  await seedDeployment(page, applicationId, customer.id);

  await page.goto(`/dashboard/customers/${customer.id}`);
  // The invitation dialog is opened in place — the customer is already
  // bound to this page's route, so it asks only for the application.
  await page.getByRole('button', { name: 'Invite customer' }).first().click();

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Invite customer' })).toBeVisible();

  await dialog.getByRole('combobox').filter({ hasText: 'Select an application' }).click();
  await page.getByRole('option').first().click();
  await dialog.getByRole('button', { name: 'Create invitation' }).click();

  await expect(dialog.getByRole('heading', { name: 'Invitation created' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Copy link' })).toBeVisible();

  const customersResponse = await page.request.get(`${API_URL}/api/customers`);
  expect(customersResponse.ok()).toBeTruthy();
  const { customers } = (await customersResponse.json()) as { customers: { email: string }[] };
  expect(customers.filter((c) => c.email === customer.email)).toHaveLength(1);

  // An invitation names the customer + application but creates no deployment
  // — only the customer's own confirmation does that.
  const invitationsResponse = await page.request.get(
    `${API_URL}/api/customers/${customer.id}/invitations`,
  );
  expect(invitationsResponse.ok()).toBeTruthy();
  const { invitations } = (await invitationsResponse.json()) as { invitations: { status: string }[] };
  expect(invitations.filter((invitation) => invitation.status === 'active')).toHaveLength(1);

  const deploymentsResponse = await page.request.get(`${API_URL}/api/deployments`);
  expect(deploymentsResponse.ok()).toBeTruthy();
  const { deployments } = (await deploymentsResponse.json()) as {
    deployments: { customerId: string }[];
  };
  expect(deployments.filter((d) => d.customerId === customer.id)).toHaveLength(1);
});

test('a revoked invitation shows no expiry date', async ({ page }) => {
  await signUp(page);
  const customer = await seedCustomer(page);
  const applicationId = await seedApplication(page);
  const created = await page.request.post(`${API_URL}/api/customers/${customer.id}/invitations`, {
    data: { applicationId },
  });
  expect(created.ok()).toBeTruthy();
  const invitation = (await created.json()) as { id: string };

  await page.goto(`/dashboard/customers/${customer.id}`);
  await expect(page.getByText('Expires')).toBeVisible();

  const revoked = await page.request.post(`${API_URL}/api/public-install-links/${invitation.id}/revoke`);
  expect(revoked.ok()).toBeTruthy();
  await page.reload();

  await expect(page.getByText('Revoked', { exact: true })).toBeVisible();
  await expect(page.getByText('Expires')).toHaveCount(0);
});
