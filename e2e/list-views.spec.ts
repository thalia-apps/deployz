import { expect, test, type Page } from '@playwright/test';

// The Customers and Deployments lists, driven through the real UI against
// mocked API responses. Mocking is what lets one fleet hold every status the
// product can show — healthy, failed, progressing, waiting, update available,
// removed, an unknown future status and an unknown region — which the real
// API cannot be walked through in a single test. The pure rules are covered
// by unit tests (apps/web/test/*list*.test.ts); this spec proves the wiring:
// what a vendor sees and clicks, and that the URL carries the view.

const API_URL = `http://localhost:${process.env.API_PORT ?? 3001}`;

interface Fixture {
  id: string;
  customerId: string;
  customerName: string;
  applicationName: string;
  region: string;
  state: string;
  version: string | null;
  updatedAt: string | null;
  step?: string;
  relayStatus?: string;
}

function deployment(fixture: Fixture): Record<string, unknown> {
  return {
    id: fixture.id,
    customerId: fixture.customerId,
    applicationId: `app-${fixture.applicationName}`,
    organizationId: 'org',
    region: fixture.region,
    state: fixture.state,
    awsAccountId: null,
    currentReleaseId: null,
    previousReleaseId: null,
    relayStatus: fixture.relayStatus ?? 'CONNECTED',
    healthStatus: 'HEALTHY',
    components: null,
    installLinkId: `link-${fixture.id}`,
    desiredState: {},
    observedState: null,
    infraVersion: 'v1',
    installationId: `inst-${fixture.id}`,
    deploymentType: 'PRODUCTION',
    billingState: 'NOT_STARTED',
    billingStartedAt: null,
    billingStoppedAt: null,
    lastHealthAt: null,
    deletedAt: null,
    cleanupState: null,
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: fixture.updatedAt ?? 'not-a-date',
    createdBy: null,
    updatedBy: null,
    customerName: fixture.customerName,
    applicationName: fixture.applicationName,
    version: fixture.version,
    relayVersion: null,
    bootstrapVersion: null,
    relayCapabilities: null,
    runningImageDigest: null,
    attemptNumber: 1,
    bootstrapStackName: null,
    installStartedAt: null,
    deploymentStatus: {
      stage: fixture.state === 'FAILED' ? 'FAILED' : fixture.state === 'INSTALLING' ? 'PROVISIONING' : 'READY',
      updatedAt: fixture.updatedAt,
      currentActivity: 'Doing the thing.',
      step: fixture.step ?? 'READY',
      steps: [],
    },
  };
}

const LONG_CUSTOMER = 'The Extraordinarily Long-Named Customer Holdings International Limited';
const LONG_APPLICATION = 'Enterprise Resource Planning And Document Workflow Suite';

const FLEET: Fixture[] = [
  { id: 'd-acme-docs', customerId: 'c-acme', customerName: 'Acme', applicationName: 'Docs', region: 'ap-south-1', state: 'HEALTHY', version: '1.14.2', updatedAt: '2026-09-01T10:00:00Z' },
  { id: 'd-acme-sheets', customerId: 'c-acme', customerName: 'Acme', applicationName: 'Sheets', region: 'us-east-1', state: 'UPDATE_AVAILABLE', version: '2.0.0', updatedAt: '2026-09-04T10:00:00Z' },
  { id: 'd-globex', customerId: 'c-globex', customerName: 'Globex', applicationName: 'Docs', region: 'us-east-1', state: 'FAILED', version: '1.14.1', updatedAt: '2026-08-20T10:00:00Z' },
  { id: 'd-initech', customerId: 'c-initech', customerName: 'Initech', applicationName: 'Sheets', region: 'eu-west-1', state: 'INSTALLING', step: 'APPLICATION', version: '2.0.0', updatedAt: '2026-09-05T10:00:00Z' },
  { id: 'd-hooli', customerId: 'c-hooli', customerName: 'Hooli', applicationName: 'Sheets', region: 'us-east-1', state: 'NOT_INSTALLED', version: null, updatedAt: '2026-09-03T10:00:00Z' },
  { id: 'd-stark', customerId: 'c-stark', customerName: 'Stark', applicationName: 'Docs', region: 'us-east-1', state: 'HEALTHY', relayStatus: 'DISCONNECTED', version: '1.14.2', updatedAt: '2026-09-06T10:00:00Z' },
  { id: 'd-umbrella', customerId: 'c-umbrella', customerName: 'Umbrella', applicationName: 'Docs', region: 'xx-unknown-9', state: 'DELETED', version: '1.0.0', updatedAt: '2026-09-07T10:00:00Z' },
  { id: 'd-future', customerId: 'c-future', customerName: 'Future Co', applicationName: 'Docs', region: 'us-east-1', state: 'HIBERNATING', version: '1.14.2', updatedAt: '2026-09-02T10:00:00Z' },
  { id: 'd-long', customerId: 'c-long', customerName: LONG_CUSTOMER, applicationName: LONG_APPLICATION, region: 'eu-west-1', state: 'HEALTHY', version: null, updatedAt: null },
];

const CUSTOMERS = [
  { id: 'c-acme', name: 'Acme', email: 'ops@acme.example', company: 'Acme Holdings', createdAt: '2026-01-10T00:00:00Z' },
  { id: 'c-globex', name: 'Globex', email: 'it@globex.example', company: null, createdAt: '2026-02-10T00:00:00Z' },
  { id: 'c-initech', name: 'Initech', email: 'bill@initech.example', company: null, createdAt: '2026-03-10T00:00:00Z' },
  { id: 'c-hooli', name: 'Hooli', email: 'gavin@hooli.example', company: null, createdAt: '2026-04-10T00:00:00Z' },
  { id: 'c-stark', name: 'Stark', email: 'tony@stark.example', company: null, createdAt: '2026-05-10T00:00:00Z' },
  { id: 'c-umbrella', name: 'Umbrella', email: 'ops@umbrella.example', company: null, createdAt: '2026-06-10T00:00:00Z' },
  { id: 'c-future', name: 'Future Co', email: 'hi@future.example', company: null, createdAt: '2026-06-20T00:00:00Z' },
  { id: 'c-long', name: LONG_CUSTOMER, email: 'a-remarkably-long-email-address-for-truncation@extraordinarily-long-domain.example', company: null, createdAt: '2026-07-10T00:00:00Z' },
  { id: 'c-wayne', name: 'Wayne', email: 'bruce@wayne.example', company: null, createdAt: '2026-07-20T00:00:00Z' },
].map((customer) => ({ ...customer, organizationId: 'org', externalReference: null, updatedAt: customer.createdAt }));

async function signUp(page: Page): Promise<void> {
  const email = `e2e-lists-${crypto.randomUUID().slice(0, 8)}@example.com`;
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill('E2E Vendor');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('super-secret-1');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL('/dashboard');
}

async function mockApi(page: Page, fleet: Fixture[] = FLEET, customers = CUSTOMERS): Promise<void> {
  await page.route(`${API_URL}/api/deployments*`, (route) =>
    route.fulfill({ json: { deployments: fleet.map(deployment) } }),
  );
  await page.route(`${API_URL}/api/customers*`, (route) => route.fulfill({ json: { customers } }));
}

/** The customer names of the table's body rows, in display order. */
async function rowNames(page: Page, table: 'deployment-list' | 'customer-list'): Promise<string[]> {
  return page.getByTestId(table).locator('tbody tr').locator('td:first-child a').allInnerTexts();
}

/** Waits for the table to show exactly these customers (the list re-renders
 *  after the URL changes, so a single read can see the previous view). */
async function expectRows(
  page: Page,
  table: 'deployment-list' | 'customer-list',
  names: string[],
  options: { anyOrder?: boolean } = {},
): Promise<void> {
  await expect
    .poll(async () => {
      const found = await rowNames(page, table);
      return options.anyOrder ? found.sort() : found;
    })
    .toEqual(options.anyOrder ? [...names].sort() : names);
}

/** The table fits its card: no horizontal scrollbar of its own, none on the page. */
async function expectNoScroll(page: Page, table: 'deployment-list' | 'customer-list'): Promise<void> {
  const overflow = await page.getByTestId(table).evaluate((el) => {
    const container = el.closest('[data-slot=table-container]')!;
    return {
      table: container.scrollWidth - container.clientWidth,
      page: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
  expect(overflow.table).toBeLessThanOrEqual(1);
  expect(overflow.page).toBeLessThanOrEqual(0);
}

/** Waits for the first row's customer. */
async function expectFirstRow(page: Page, table: 'deployment-list' | 'customer-list', name: string): Promise<void> {
  await expect.poll(async () => (await rowNames(page, table))[0]).toBe(name);
}

async function choose(page: Page, label: string, option: string | RegExp): Promise<void> {
  await page.getByRole('combobox', { name: label }).click();
  await page.getByRole('option', { name: option, exact: typeof option === 'string' }).click();
}

test.describe('Deployments list', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test.beforeEach(async ({ page }) => {
    await signUp(page);
    await mockApi(page);
  });

  test('shows precise statuses in operational order, with removed deployments held back', async ({ page }) => {
    await page.goto('/dashboard/deployments');
    const list = page.getByTestId('deployment-list');
    await expect(list).toBeVisible();

    await expect(list.getByRole('columnheader')).toHaveText([
      'Customer',
      'Application',
      'Version',
      'Region',
      'Status',
      'Updated',
    ]);

    // Needs attention first (latest change first), then progressing, waiting,
    // update available, healthy. Umbrella is removed, so it is not listed.
    await expectRows(page, 'deployment-list', [
      'Stark',
      'Future Co',
      'Globex',
      'Initech',
      'Hooli',
      'Acme',
      'Acme',
      'The Extraordinarily Long-Named Customer Holdings International Limited',
    ]);

    const row = (name: string, app?: string) =>
      list.locator('tbody tr').filter({ hasText: name }).filter(app ? { hasText: app } : {});
    await expect(row('Stark')).toContainText('Lost contact');
    await expect(row('Globex')).toContainText('Install failed');
    await expect(row('Future Co')).toContainText('Unknown status');
    await expect(row('Initech')).toContainText('Setting up');
    await expect(row('Hooli')).toContainText('Waiting for customer');
    await expect(row('Acme', 'Sheets')).toContainText('Update available');
    await expect(row('Acme', 'Docs')).toContainText('Live');
    await expect(list).not.toContainText('Umbrella');

    // Internal states never leak.
    const text = await page.locator('body').innerText();
    expect(text).not.toMatch(/\b(NOT_INSTALLED|HIBERNATING|WAITING_FOR_RELAY|CloudFormation|ECS)\b/);
  });

  test('offers grouped status filters, not every lifecycle state', async ({ page }) => {
    await page.goto('/dashboard/deployments');
    await page.getByRole('combobox', { name: 'Filter by status' }).click();
    await expect(page.getByRole('option')).toHaveText([
      'All statuses',
      'Live',
      'In progress',
      'Failed or needs attention',
      'Waiting for customer',
      'Update available',
      'Removed',
    ]);
  });

  test('each status filter updates the rows and the URL, and Clear filters undoes it', async ({ page }) => {
    await page.goto('/dashboard/deployments');
    const list = page.getByTestId('deployment-list');
    await expect(page.getByRole('button', { name: 'Clear filters' })).toHaveCount(0);

    const cases: [string, string, string[]][] = [
      // Live keeps the live deployment with an update available (Acme · Sheets).
      ['Live', 'healthy', ['Acme', 'Acme', 'The Extraordinarily Long-Named Customer Holdings International Limited']],
      ['In progress', 'in-progress', ['Initech']],
      ['Failed or needs attention', 'attention', ['Stark', 'Future Co', 'Globex']],
      ['Waiting for customer', 'waiting', ['Hooli']],
      ['Update available', 'update-available', ['Acme']],
      ['Removed', 'removed', ['Umbrella']],
    ];
    for (const [label, param, names] of cases) {
      await choose(page, 'Filter by status', label);
      await expect(page).toHaveURL(new RegExp(`[?&]status=${param}(&|$)`));
      await expectRows(page, 'deployment-list', names);
    }

    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(page).toHaveURL(/\/dashboard\/deployments$/);
    await expect(list.locator('tbody tr')).toHaveCount(8);
    await expect(page.getByRole('button', { name: 'Clear filters' })).toHaveCount(0);
  });

  test('search is debounced into the URL and covers customer, application, region and status', async ({ page }) => {
    await page.goto('/dashboard/deployments');
    const search = page.getByRole('textbox', { name: 'Search deployments' });

    await search.pressSequentially('glob', { delay: 30 });
    await expect(page).toHaveURL(/[?&]q=glob(&|$)/);
    await expectRows(page, 'deployment-list', ['Globex']);

    await search.fill('mumbai');
    await expect(page).toHaveURL(/[?&]q=mumbai(&|$)/);
    await expectRows(page, 'deployment-list', ['Acme']);

    await search.fill('lost contact');
    await expectRows(page, 'deployment-list', ['Stark']);

    await search.fill('d-hooli');
    await expectRows(page, 'deployment-list', ['Hooli']);
  });

  test('combined filters narrow together, and an empty result explains itself', async ({ page }) => {
    await page.goto('/dashboard/deployments');
    await choose(page, 'Filter by application', 'Docs');
    await choose(page, 'Filter by region', /Mumbai/);
    await choose(page, 'Filter by status', 'Live');
    await expectRows(page, 'deployment-list', ['Acme']);
    await expect(page).toHaveURL(/status=healthy/);
    await expect(page).toHaveURL(/application=Docs/);
    await expect(page).toHaveURL(/region=ap-south-1/);

    await choose(page, 'Filter by status', 'Failed or needs attention');
    await expect(page.getByRole('heading', { name: 'No deployments match these filters.' })).toBeVisible();
    await expect(page.getByTestId('deployment-list')).toHaveCount(0);

    // Two Clear filters buttons (toolbar and empty state) do the same thing.
    await page.getByRole('button', { name: 'Clear filters' }).last().click();
    await expect(page.getByTestId('deployment-list')).toBeVisible();
    await expect(page).toHaveURL(/\/dashboard\/deployments$/);
  });

  test('shows friendly region names with the code, and the bare code for an unknown region', async ({ page }) => {
    await page.goto('/dashboard/deployments');
    const mumbai = page.getByTestId('deployment-list').locator('tbody tr').filter({ hasText: 'Acme' }).filter({ hasText: 'Docs' });
    await expect(mumbai.locator('td').nth(3)).toContainText('Mumbai');
    await expect(mumbai.locator('td').nth(3)).toContainText('ap-south-1');

    await choose(page, 'Filter by status', 'Removed');
    const unknown = page.getByTestId('deployment-list').locator('tbody tr').first();
    await expect(unknown.locator('td').nth(3)).toHaveText('xx-unknown-9');
  });

  test('sorts by header in both directions and shows which way', async ({ page }) => {
    await page.goto('/dashboard/deployments');
    const header = (name: string) => page.getByRole('columnheader', { name });

    // The default order is the Status sort.
    await expect(header('Status')).toHaveAttribute('aria-sort', 'ascending');

    await header('Customer').getByRole('button').click();
    await expect(header('Customer')).toHaveAttribute('aria-sort', 'ascending');
    await expect(page).toHaveURL(/sort=customer&dir=asc/);
    await expectFirstRow(page, 'deployment-list', 'Acme');

    await header('Customer').getByRole('button').click();
    await expect(header('Customer')).toHaveAttribute('aria-sort', 'descending');
    await expect(page).toHaveURL(/sort=customer&dir=desc/);
    await expectFirstRow(page, 'deployment-list', 'The Extraordinarily Long-Named Customer Holdings International Limited');
    await expect(header('Status')).not.toHaveAttribute('aria-sort', /.+/);

    // Updated starts newest first; a row without a timestamp sorts last.
    await header('Updated').getByRole('button').click();
    await expect(page).toHaveURL(/sort=updated&dir=desc/);
    await expectFirstRow(page, 'deployment-list', 'Stark');
    await expect
      .poll(async () => (await rowNames(page, 'deployment-list')).at(-1))
      .toBe('The Extraordinarily Long-Named Customer Holdings International Limited');

    await header('Application').getByRole('button').click();
    await expect(header('Application')).toHaveAttribute('aria-sort', 'ascending');
    await header('Region').getByRole('button').click();
    await expect(header('Region')).toHaveAttribute('aria-sort', 'ascending');

    // Sorting again on Status returns to the default, which leaves no URL trace.
    await header('Status').getByRole('button').click();
    await expect(page).not.toHaveURL(/sort=/);
  });

  test('a sort applies on top of a filter', async ({ page }) => {
    await page.goto('/dashboard/deployments?status=attention');
    await expectRows(page, 'deployment-list', ['Stark', 'Future Co', 'Globex']);
    await page.getByRole('columnheader', { name: 'Customer' }).getByRole('button').click();
    await expectRows(page, 'deployment-list', ['Future Co', 'Globex', 'Stark']);
  });

  test('restores the view when returning from a deployment, and from a shared link', async ({ page }) => {
    await page.goto('/dashboard/deployments');
    await choose(page, 'Filter by status', 'Failed or needs attention');
    await page.getByRole('columnheader', { name: 'Customer' }).getByRole('button').click();
    await expect(page).toHaveURL(/status=attention&sort=customer&dir=asc/);
    const url = page.url();

    await page.getByRole('link', { name: 'Globex' }).click();
    await page.waitForURL(/\/dashboard\/deployments\/d-globex/);
    await page.goBack();
    await expect(page).toHaveURL(url);
    await expectRows(page, 'deployment-list', ['Future Co', 'Globex', 'Stark']);
    await expect(page.getByRole('combobox', { name: 'Filter by status' })).toHaveText('Failed or needs attention');

    // The same link opens the same view.
    await page.goto(url);
    await expectRows(page, 'deployment-list', ['Future Co', 'Globex', 'Stark']);
  });

  test('typing after a filter keeps the filter', async ({ page }) => {
    await page.goto('/dashboard/deployments?status=attention&q=glo');
    await expect(page.getByRole('textbox', { name: 'Search deployments' })).toHaveValue('glo');
    await expectRows(page, 'deployment-list', ['Globex']);
    await page.getByRole('textbox', { name: 'Search deployments' }).fill('stark');
    await expect(page).toHaveURL(/status=attention/);
    await expect(page).toHaveURL(/q=stark/);
  });

  test('ignores a link naming a status, application or sort it does not know', async ({ page }) => {
    await page.goto('/dashboard/deployments?status=BOGUS&application=Nope&region=zz-1&sort=wat');
    await expect(page.getByTestId('deployment-list').locator('tbody tr')).toHaveCount(8);
    await expect(page.getByRole('button', { name: 'Clear filters' })).toHaveCount(0);
  });

  test('truncates long names, keeps the full text as a tooltip, and shows a dash for a missing version and time', async ({ page }) => {
    await page.goto('/dashboard/deployments');
    const row = page.getByTestId('deployment-list').locator('tbody tr').filter({ hasText: 'Extraordinarily' });
    const link = row.getByRole('link', { name: LONG_CUSTOMER });
    await expect(link).toHaveAttribute('title', LONG_CUSTOMER);
    expect(await link.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    expect(await row.evaluate((el) => el.getBoundingClientRect().height)).toBeLessThan(80);
    await expect(row.locator('td').nth(2)).toHaveText('—');
    await expect(row.locator('td').nth(5)).toHaveText('—');
  });

  test('a fleet with only removed deployments points at them instead of an empty table', async ({ page }) => {
    await page.unroute(`${API_URL}/api/deployments*`);
    await mockApi(page, FLEET.filter((fixture) => fixture.state === 'DELETED'));
    await page.goto('/dashboard/deployments');
    await expect(page.getByText('No active deployments.')).toBeVisible();
    await page.getByRole('button', { name: /removed deployment may still have retained resources/ }).click();
    await expect(page).toHaveURL(/status=removed/);
    await expectRows(page, 'deployment-list', ['Umbrella']);
  });

  test('a fleet with no deployments shows the getting-started state, not a filtered one', async ({ page }) => {
    await page.unroute(`${API_URL}/api/deployments*`);
    await mockApi(page, []);
    await page.goto('/dashboard/deployments');
    await expect(page.getByRole('heading', { name: 'No customer deployments yet' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Create deployment' })).toBeVisible();
    await expect(page.getByText('No deployments match these filters.')).toHaveCount(0);
  });
});

test.describe('Customers list', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test.beforeEach(async ({ page }) => {
    await signUp(page);
    await mockApi(page);
  });

  test('one row per customer, with a customer-level summary and applications', async ({ page }) => {
    await page.goto('/dashboard/customers');
    const list = page.getByTestId('customer-list');
    await expect(list).toBeVisible();
    await expect(list.getByRole('columnheader')).toHaveText([
      'Customer',
      'Applications',
      'Deployment summary',
      'Last activity',
      'Created',
      'Actions',
    ]);
    await expect(list.locator('tbody tr')).toHaveCount(CUSTOMERS.length);

    const row = (name: string) => list.locator('tbody tr').filter({ has: page.getByRole('link', { name, exact: true }) });
    // Two deployments, two applications: one row, one summary line.
    await expect(row('Acme').getByTestId('customer-summary')).toHaveText('2 active');
    await expect(row('Acme')).toContainText('Docs');
    await expect(row('Acme')).toContainText('+1');
    await expect(row('Acme')).toContainText('ops@acme.example');
    await expect(row('Globex').getByTestId('customer-summary')).toHaveText('1 needs attention');
    await expect(row('Initech').getByTestId('customer-summary')).toHaveText('Setup pending');
    await expect(row('Hooli').getByTestId('customer-summary')).toHaveText('Setup pending');
    await expect(row('Stark').getByTestId('customer-summary')).toHaveText('1 needs attention');
    await expect(row('Umbrella').getByTestId('customer-summary')).toHaveText('Removed');
    await expect(row('Wayne').getByTestId('customer-summary')).toHaveText('No deployments');
    await expect(row('Future Co').getByTestId('customer-summary')).toHaveText('1 needs attention');

    const text = await page.locator('body').innerText();
    expect(text).not.toMatch(/\b(NOT_INSTALLED|HIBERNATING|CloudFormation|ECS)\b/);
  });

  test('sorts by last activity, newest first, and lets the header change that', async ({ page }) => {
    await page.goto('/dashboard/customers');
    const header = (name: string) => page.getByRole('columnheader', { name });
    await expect(header('Last activity')).toHaveAttribute('aria-sort', 'descending');
    await expectFirstRow(page, 'customer-list', 'Umbrella');
    const names = await rowNames(page, 'customer-list');
    // Umbrella's deployment changed last; a deployment with no usable timestamp counts from when it was created.
    expect(names.slice(0, 3)).toEqual(['Umbrella', 'Stark', 'Initech']);
    expect(names.indexOf('Wayne')).toBeGreaterThan(names.indexOf('Acme'));

    await header('Customer').getByRole('button').click();
    await expect(page).toHaveURL(/sort=customer&dir=asc/);
    await expectFirstRow(page, 'customer-list', 'Acme');
    await header('Customer').getByRole('button').click();
    await expect(header('Customer')).toHaveAttribute('aria-sort', 'descending');
    await expectFirstRow(page, 'customer-list', 'Wayne');

    await header('Created').getByRole('button').click();
    await expect(page).toHaveURL(/sort=created&dir=desc/);
    await expectFirstRow(page, 'customer-list', 'Wayne');
    await header('Created').getByRole('button').click();
    await expectFirstRow(page, 'customer-list', 'Acme');
  });

  test('offers the five deployment states and filters by each', async ({ page }) => {
    await page.goto('/dashboard/customers');
    await page.getByRole('combobox', { name: 'Filter by deployment state' }).click();
    await expect(page.getByRole('option')).toHaveText([
      'All deployment states',
      'Active',
      'Needs attention',
      'Setup pending',
      'No active deployments',
      'Removed',
    ]);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('option')).toHaveCount(0);

    const cases: [string, string, string[]][] = [
      ['Active', 'active', ['Acme', LONG_CUSTOMER]],
      ['Needs attention', 'attention', ['Stark', 'Future Co', 'Globex']],
      ['Setup pending', 'pending', ['Initech', 'Hooli']],
      ['No active deployments', 'none', ['Umbrella', 'Wayne']],
      ['Removed', 'removed', ['Umbrella']],
    ];
    for (const [label, param, names] of cases) {
      await choose(page, 'Filter by deployment state', label);
      await expect(page).toHaveURL(new RegExp(`[?&]state=${param}(&|$)`));
      await expectRows(page, 'customer-list', names, { anyOrder: true });
    }
    await expect(page.getByTestId('customer-count')).toHaveText('1 of 9 customers');
  });

  test('filters by application, searches name and email, and combines them', async ({ page }) => {
    await page.goto('/dashboard/customers');
    await choose(page, 'Filter by application', 'Sheets');
    await expectRows(page, 'customer-list', ['Acme', 'Hooli', 'Initech'], { anyOrder: true });

    await page.getByRole('textbox', { name: 'Search customers' }).fill('bill@init');
    await expect(page).toHaveURL(/q=bill%40init/);
    await expectRows(page, 'customer-list', ['Initech']);

    await page.getByRole('textbox', { name: 'Search customers' }).fill('acme holdings');
    await expectRows(page, 'customer-list', ['Acme']);

    await page.getByRole('textbox', { name: 'Search customers' }).fill('nobody');
    await expect(page.getByRole('heading', { name: 'No customers match these filters.' })).toBeVisible();
    await page.getByRole('button', { name: 'Clear filters' }).last().click();
    await expect(page).toHaveURL(/\/dashboard\/customers$/);
    await expect(page.getByTestId('customer-list').locator('tbody tr')).toHaveCount(CUSTOMERS.length);
    await expect(page.getByRole('textbox', { name: 'Search customers' })).toHaveValue('');
  });

  test('restores the view when returning from a customer', async ({ page }) => {
    await page.goto('/dashboard/customers');
    await choose(page, 'Filter by deployment state', 'Needs attention');
    await page.getByRole('columnheader', { name: 'Customer' }).getByRole('button').click();
    await expect(page).toHaveURL(/state=attention&sort=customer&dir=asc/);
    const url = page.url();
    await page.getByRole('link', { name: 'Globex' }).click();
    await page.waitForURL(/\/dashboard\/customers\/c-globex/);
    await page.goBack();
    await expect(page).toHaveURL(url);
    await expectRows(page, 'customer-list', ['Future Co', 'Globex', 'Stark']);
  });

  test('keeps the row actions the data supports', async ({ page }) => {
    await page.goto('/dashboard/customers');
    await page.getByRole('button', { name: 'Actions for Wayne' }).click();
    await expect(page.getByRole('menuitem', { name: 'Edit customer' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Delete customer' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'View deployment' })).toHaveCount(0);
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Actions for Globex' }).click();
    await expect(page.getByRole('menuitem', { name: 'View deployment' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Delete customer' })).toHaveCount(0);
  });

  test('truncates a long name and email without growing the row', async ({ page }) => {
    await page.goto('/dashboard/customers');
    const row = page.getByTestId('customer-list').locator('tbody tr').filter({ hasText: 'Extraordinarily' });
    expect(await row.evaluate((el) => el.getBoundingClientRect().height)).toBeLessThan(90);
    await expect(row.getByRole('link', { name: LONG_CUSTOMER })).toHaveAttribute('title', LONG_CUSTOMER);
  });

  test('a genuinely empty account gets the first-customer state, not a filtered one', async ({ page }) => {
    await page.unroute(`${API_URL}/api/customers*`);
    await page.route(`${API_URL}/api/customers*`, (route) => route.fulfill({ json: { customers: [] } }));
    await page.goto('/dashboard/customers');
    await expect(page.getByRole('heading', { name: 'Add your first customer' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Invite customer' })).toBeVisible();
    await expect(page.getByText('No customers match these filters.')).toHaveCount(0);
  });
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 375, height: 800 } });

  test.beforeEach(async ({ page }) => {
    await signUp(page);
    await mockApi(page);
  });

  test('the top bar opens the sidebar', async ({ page }) => {
    await page.goto('/dashboard/deployments');
    const open = page.getByRole('button', { name: 'Open sidebar' });
    await expect(open).toBeVisible();
    await open.click();
    await expect(page.getByRole('link', { name: 'Customers' })).toBeVisible();
    await expect(page.getByTestId('org-switcher-trigger')).toBeVisible();
  });

  test('Deployments folds application and updated under the customer instead of dropping them', async ({ page }) => {
    await page.goto('/dashboard/deployments');
    const list = page.getByTestId('deployment-list');
    await expect(list).toBeVisible();
    for (const hidden of ['Application', 'Version', 'Region', 'Updated']) {
      await expect(list.getByRole('columnheader', { name: hidden })).toBeHidden();
    }
    await expect(list.getByRole('columnheader', { name: 'Status' })).toBeVisible();
    const globex = list.locator('tbody tr').filter({ hasText: 'Globex' });
    await expect(globex.locator('p', { hasText: /Docs · \d+ days? ago/ })).toBeVisible();
    await expectNoScroll(page, 'deployment-list');
  });

  test('Customers folds last activity under the summary', async ({ page }) => {
    await page.goto('/dashboard/customers');
    await expect(page.getByTestId('customer-list')).toBeVisible();
    for (const hidden of ['Applications', 'Last activity', 'Created']) {
      await expect(page.getByRole('columnheader', { name: hidden })).toBeHidden();
    }
    const globex = page.getByTestId('customer-list').locator('tbody tr').filter({ hasText: 'Globex' });
    await expect(globex.locator('p', { hasText: /\d+ days? ago/ })).toBeVisible();
    await expectNoScroll(page, 'customer-list');
  });
});

// The table decides its columns from its own width, so a narrow content area
// (a tablet with the sidebar open) drops the same columns a phone does. In
// every case the table fits without its own horizontal scrollbar.
test.describe('table columns follow the space available', () => {
  for (const [name, width, columns] of [
    ['a tablet with the sidebar open', 820, ['Customer', 'Status']],
    ['a laptop', 1024, ['Customer', 'Status', 'Updated']],
    ['a desktop', 1440, ['Customer', 'Application', 'Version', 'Region', 'Status', 'Updated']],
  ] as const) {
    test(`Deployments on ${name}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await signUp(page);
      await mockApi(page);
      await page.goto('/dashboard/deployments');
      await expect(page.getByTestId('deployment-list').getByRole('columnheader')).toHaveText([...columns]);
      await expectNoScroll(page, 'deployment-list');
    });
  }
});
