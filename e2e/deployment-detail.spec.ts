import { expect, test, type Page } from '@playwright/test';

// Per-state coverage of the vendor deployment detail page, rendered from
// fully mocked API responses (the same technique as e2e/visual.spec.ts) so
// every meaningful state is reachable without driving a relay to it. The
// live-relay specs (fleet, deployment-progress, scenario-ui, stack-events)
// prove the states a real install actually passes through; this file proves
// the rest — a failed update over a live release, DELETING, a removed
// deployment with retained resources, a relay that went quiet, and the
// degraded-fetch and long-name edges.
//
// Set QA_SCREENSHOTS=1 to also write a desktop screenshot per state under
// test-results/deployment-detail (useful when reviewing a UI change by eye).

const API_URL = `http://localhost:${process.env.API_PORT ?? 3001}`;
const SCREENSHOTS = process.env.QA_SCREENSHOTS === '1';
const OUT = 'test-results/deployment-detail';

const CREATED_AT = '2025-09-06T10:00:00Z';
const UPDATED_AT = '2025-09-12T11:30:00Z';

const defaultHealth = {
  status: 'HEALTHY',
  layers: { infrastructure: 'HEALTHY', rollout: 'COMPLETED', targets: null, http: null, relay: 'CONNECTED' },
};

function vendorStatus(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    stage: 'READY',
    updatedAt: UPDATED_AT,
    currentActivity: 'Live and healthy.',
    step: 'READY',
    steps: ['AWS_SETUP', 'RELAY_CONNECT', 'PREPARING', 'NETWORK', 'DATABASE_STORAGE', 'APPLICATION', 'HEALTH_CHECK', 'TLS', 'READY'],
    typicalDurationSeconds: null,
    takingLongerThanUsual: false,
    stepStartedAt: null,
    stepTimings: [],
    statusUpdatesUnavailable: false,
    needsDomainSetup: false,
    components: [
      { key: 'runtime', label: 'Application runtime', status: 'READY' },
      { key: 'database', label: 'PostgreSQL database', status: 'READY' },
      { key: 'storage', label: 'Storage', status: 'NOT_REQUIRED' },
      { key: 'redis', label: 'Redis', status: 'NOT_REQUIRED' },
      { key: 'https', label: 'Secure access (HTTPS)', status: 'READY' },
    ],
    relay: { connected: true, lastSeenAt: UPDATED_AT },
    job: { type: 'INSTALL', status: 'SUCCEEDED' },
    aws: { stackStatus: 'CREATE_COMPLETE' },
    servingRelease: { releaseId: null, confirmedAt: UPDATED_AT, confirmed: true },
    connector: { upgradeRequired: false, reason: null, updateAvailable: false, updateUrl: null, updateTemplateUrl: null },
    url: 'https://docs.acme.example',
    failure: null,
    ...overrides,
    health: { notStarted: false, ...((overrides.health as object | undefined) ?? defaultHealth) },
  };
}

function job(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'aaaaaaaa-0000-0000-0000-000000000001',
    deploymentId: 'qa-dep',
    type: 'INSTALL',
    state: 'SUCCEEDED',
    idempotencyKey: 'k',
    payload: {},
    result: null,
    requestedBy: null,
    failureCode: null,
    createdAt: CREATED_AT,
    startedAt: CREATED_AT,
    lastProgressAt: CREATED_AT,
    finishedAt: CREATED_AT,
    ...overrides,
  };
}

function detail(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'qa-dep',
    customerId: 'qa-cust',
    applicationId: 'qa-app',
    organizationId: 'qa-org',
    region: 'us-east-2',
    state: 'HEALTHY',
    awsAccountId: '1234••••••',
    currentReleaseId: 'rel-2',
    previousReleaseId: 'rel-1',
    relayStatus: 'CONNECTED',
    healthStatus: 'HEALTHY',
    components: { application: 'HEALTHY', database: 'HEALTHY', loadBalancer: 'HEALTHY' },
    installLinkId: 'qa-install-link',
    desiredState: {},
    observedState: null,
    infraVersion: 'v1',
    installationId: 'qa-installation',
    deploymentType: 'PRODUCTION',
    billingState: 'NOT_STARTED',
    billingStartedAt: null,
    billingStoppedAt: null,
    lastHealthAt: UPDATED_AT,
    deletedAt: null,
    cleanupState: null,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    createdBy: null,
    updatedBy: null,
    customerName: 'Acme Corp',
    applicationName: 'Documenso',
    version: '1.14.2',
    relayVersion: '0.9.3',
    bootstrapVersion: 'v1',
    relayCapabilities: {
      deployRelease: true,
      rollback: true,
      restart: true,
      configUpdate: true,
      destroy: true,
      domainManagement: true,
    },
    runningImageDigest: null,
    attemptNumber: 1,
    bootstrapStackName: 'deployz-connector-qa',
    installStartedAt: CREATED_AT,
    deploymentStatus: vendorStatus(),
    jobs: [job({})],
    customDomain: { hostname: 'docs.acme.example', status: 'active' },
    appUrl: 'https://docs.acme.example',
    ...overrides,
  };
}

const component = (kind: string, name: string, status: string, lifecycle = 'delete', service = 'ECS') => ({
  kind,
  name,
  purpose: 'Test purpose',
  status,
  awsService: service,
  region: 'us-east-2',
  lifecycle,
  resources: [
    {
      logicalId: `${name.replace(/\s/g, '')}Resource`,
      physicalId: `arn:aws:${service.toLowerCase()}:us-east-2:123456789012:${kind}/qa-${kind}`,
      type: `AWS::${service}::Thing`,
      status: 'CREATE_COMPLETE',
      statusReason: null,
    },
  ],
});

// Phase 6: the server's expected-vs-present comparison for the default
// component list — a postgres deployment with neither storage nor Redis.
const DEFAULT_EXPECTATIONS = {
  schemaVersion: 1,
  components: [
    { kind: 'application', expected: true, present: true },
    { kind: 'endpoint', expected: true, present: true },
    { kind: 'database', expected: true, present: true },
    { kind: 'storage', expected: false, present: false },
    { kind: 'cache', expected: false, present: false },
  ],
  missing: [],
  unexpected: [],
};

function infra(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: 'aws',
    region: 'us-east-2',
    stackStatus: 'CREATE_COMPLETE',
    connectionState: 'connected',
    snapshotState: 'fresh',
    summary: { status: 'healthy', componentCount: 4, technicalResourceCount: 8 },
    components: [
      component('application', 'Application', 'ready'),
      component('database', 'Database', 'ready', 'retain', 'RDS'),
      component('endpoint', 'Secure endpoint', 'ready', 'delete', 'ELB'),
      component('network', 'Network', 'ready', 'delete', 'VPC'),
    ],
    lastUpdatedAt: UPDATED_AT,
    disconnectWarning: null,
    expectations: DEFAULT_EXPECTATIONS,
    ...overrides,
  };
}

function planComponent(kind: string, name: string, action: string, lifecycle: 'delete' | 'retain') {
  return { kind, name, action, lifecycle };
}

// Deterministic plans (Phase 4) for the same postgres/no-redis fixture as
// DEFAULT_EXPECTATIONS above — the disconnect and deploy-update dialogs
// render these instead of deriving infrastructure intent themselves.
const DESTROY_PLAN = {
  schemaVersion: 1,
  action: 'DESTROY',
  region: 'us-east-2',
  components: [
    planComponent('application', 'Application', 'DELETE', 'delete'),
    planComponent('endpoint', 'Secure endpoint', 'DELETE', 'delete'),
    planComponent('database', 'Database', 'RETAIN', 'retain'),
    planComponent('storage', 'Storage', 'RETAIN', 'retain'),
  ],
  requirementDrift: [],
};

const UPDATE_PLAN_NO_DRIFT = {
  schemaVersion: 1,
  action: 'UPDATE',
  region: 'us-east-2',
  components: [
    planComponent('application', 'Application', 'UNCHANGED', 'delete'),
    planComponent('endpoint', 'Secure endpoint', 'UNCHANGED', 'delete'),
    planComponent('database', 'Database', 'UNCHANGED', 'retain'),
    planComponent('storage', 'Storage', 'UNCHANGED', 'retain'),
  ],
  requirementDrift: [],
};

const EVENTS = [
  { occurredAt: '2025-09-12T07:24:00Z', eventType: 'install.requested', actorType: 'user', result: null, previousState: 'NOT_INSTALLED', requestedState: 'INSTALLING', payload: {} },
  { occurredAt: '2025-09-12T07:28:00Z', eventType: 'install.launched', actorType: 'user', result: 'success', previousState: null, requestedState: null, payload: {} },
  { occurredAt: '2025-09-12T07:30:00Z', eventType: 'install.completed', actorType: 'relay', result: 'success', previousState: 'INSTALLING', requestedState: 'HEALTHY', payload: {} },
  { occurredAt: '2025-09-12T07:31:00Z', eventType: 'health.reported', actorType: 'relay', result: 'success', previousState: null, requestedState: null, payload: {} },
  { occurredAt: '2025-09-12T09:10:00Z', eventType: 'deploy.requested', actorType: 'user', result: null, previousState: 'HEALTHY', requestedState: 'UPDATING', payload: {} },
  { occurredAt: '2025-09-12T09:14:00Z', eventType: 'deploy.completed', actorType: 'relay', result: 'success', previousState: 'UPDATING', requestedState: 'HEALTHY', payload: {} },
  { occurredAt: '2025-09-12T11:30:00Z', eventType: 'health.reported', actorType: 'relay', result: 'success', previousState: null, requestedState: null, payload: {} },
];

const FAILED_EVENTS = [
  EVENTS[0]!,
  EVENTS[1]!,
  {
    occurredAt: '2025-09-12T07:40:00Z',
    eventType: 'install.failed',
    actorType: 'relay',
    result: 'failure',
    previousState: 'INSTALLING',
    requestedState: 'FAILED',
    payload: {
      failureCode: 'DATABASE_CREATE_FAILED',
      error: 'Stack rolled back: AWS::RDS::DBInstance ApplicationDatabase CREATE_FAILED (Resource handler returned message: Invalid storage size)',
    },
  },
];

const RELEASES = [
  { id: 'rel-3', version: '1.15.0', status: 'READY', failureReason: null, createdAt: '2025-09-13T09:00:00Z' },
  { id: 'rel-2', version: '1.14.2', status: 'READY', failureReason: null, createdAt: UPDATED_AT },
  { id: 'rel-1', version: '1.14.1', status: 'READY', failureReason: null, createdAt: CREATED_AT },
];

async function signUp(page: Page): Promise<void> {
  const email = `qa-${crypto.randomUUID().slice(0, 8)}@example.com`;
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill('QA Vendor');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('super-secret-1');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL('/dashboard');
}

// Raw AWS service terms that must not reach the top level of vendor copy.
const JARGON = /\b(CloudFormation|IAM|ECS|ALB|Lambda|VPC|CFN|RDS)\b/;

const LONG_HOSTNAME =
  'enterprise-document-signing-platform.consolidated-international-holdings.example.com';
const LONG_URL = `https://${LONG_HOSTNAME}/very/long/path/that/keeps/going`;

const STACK_EVENTS = [
  {
    id: 1,
    eventAt: CREATED_AT,
    logicalResourceId: 'ApplicationDatabase',
    resourceType: 'AWS::RDS::DBInstance',
    resourceStatus: 'CREATE_COMPLETE',
    resourceStatusReason: null,
  },
];

const NOT_INSTALLED = detail({
  state: 'NOT_INSTALLED',
  currentReleaseId: null,
  previousReleaseId: null,
  version: null,
  awsAccountId: null,
  relayStatus: 'UNKNOWN',
  healthStatus: 'UNKNOWN',
  lastHealthAt: null,
  relayCapabilities: null,
  appUrl: null,
  customDomain: null,
  jobs: [],
  deploymentStatus: vendorStatus({
    stage: 'WAITING_FOR_AWS',
    currentActivity: 'Waiting for AWS setup to start.',
    step: 'AWS_SETUP',
    components: [
      { key: 'runtime', label: 'Application runtime', status: 'PENDING' },
      { key: 'database', label: 'PostgreSQL database', status: 'PENDING' },
      { key: 'storage', label: 'Storage', status: 'NOT_REQUIRED' },
      { key: 'redis', label: 'Redis', status: 'NOT_REQUIRED' },
    ],
    relay: { connected: false, lastSeenAt: null },
    job: null,
    aws: { stackStatus: null },
    health: {
      status: 'UNKNOWN',
      layers: { infrastructure: 'UNKNOWN', rollout: null, targets: null, http: null, relay: 'UNKNOWN' },
    },
    url: null,
  }),
});

const DEPLOYING = detail({
  state: 'INSTALLING',
  currentReleaseId: null,
  previousReleaseId: null,
  version: null,
  healthStatus: 'UNKNOWN',
  appUrl: null,
  customDomain: null,
  jobs: [job({ state: 'RUNNING', finishedAt: null })],
  deploymentStatus: vendorStatus({
    stage: 'PROVISIONING',
    currentActivity: 'Creating the database and storage.',
    step: 'DATABASE_STORAGE',
    steps: ['AWS_SETUP', 'RELAY_CONNECT', 'PREPARING', 'NETWORK', 'DATABASE_STORAGE', 'REDIS', 'APPLICATION', 'HEALTH_CHECK', 'TLS', 'READY'],
    typicalDurationSeconds: { min: 180, max: 720 },
    stepStartedAt: new Date(Date.now() - 95_000).toISOString(),
    stepTimings: [
      { step: 'AWS_SETUP', startedAt: CREATED_AT, completedAt: CREATED_AT, durationSeconds: 142 },
      { step: 'RELAY_CONNECT', startedAt: CREATED_AT, completedAt: CREATED_AT, durationSeconds: 61 },
      { step: 'PREPARING', startedAt: CREATED_AT, completedAt: CREATED_AT, durationSeconds: 33 },
      { step: 'NETWORK', startedAt: CREATED_AT, completedAt: CREATED_AT, durationSeconds: 184 },
    ],
    components: [
      { key: 'runtime', label: 'Application runtime', status: 'PENDING' },
      { key: 'database', label: 'PostgreSQL database', status: 'IN_PROGRESS' },
      { key: 'storage', label: 'Storage', status: 'IN_PROGRESS' },
      { key: 'redis', label: 'Redis', status: 'PENDING' },
    ],
    job: { type: 'INSTALL', status: 'RUNNING' },
    health: {
      status: 'UNKNOWN',
      layers: { infrastructure: 'UNKNOWN', rollout: null, targets: null, http: null, relay: 'CONNECTED' },
    },
    url: null,
  }),
});

const FAILED_INSTALL = detail({
  state: 'FAILED',
  currentReleaseId: null,
  previousReleaseId: null,
  version: null,
  healthStatus: 'UNKNOWN',
  appUrl: null,
  customDomain: null,
  jobs: [job({ state: 'FAILED', failureCode: 'DATABASE_CREATE_FAILED' })],
  deploymentStatus: vendorStatus({
    stage: 'FAILED',
    currentActivity: 'The database could not be created.',
    step: 'DATABASE_STORAGE',
    components: [
      { key: 'runtime', label: 'Application runtime', status: 'PENDING' },
      { key: 'database', label: 'PostgreSQL database', status: 'FAILED' },
      { key: 'storage', label: 'Storage', status: 'NOT_REQUIRED' },
      { key: 'redis', label: 'Redis', status: 'NOT_REQUIRED' },
    ],
    job: { type: 'INSTALL', status: 'FAILED' },
    health: {
      status: 'UNKNOWN',
      layers: { infrastructure: 'UNKNOWN', rollout: null, targets: null, http: null, relay: 'CONNECTED' },
    },
    url: null,
    failure: {
      code: 'DATABASE_CREATE_FAILED',
      component: 'database',
      reference: 'DEP-AAAAAAAA',
      message: 'The database could not be created.',
      awsStatus: 'ROLLBACK_COMPLETE',
    },
  }),
});

const FAILED_UPDATE = detail({
  state: 'UPDATE_AVAILABLE',
  previousReleaseId: null,
  jobs: [
    job({}),
    job({
      id: 'bbbbbbbb-0000-0000-0000-000000000002',
      type: 'DEPLOY_RELEASE',
      state: 'FAILED',
      failureCode: 'ECS_DEPLOYMENT_FAILED',
      createdAt: UPDATED_AT,
      startedAt: UPDATED_AT,
      finishedAt: UPDATED_AT,
    }),
  ],
  deploymentStatus: vendorStatus({
    job: { type: 'DEPLOY_RELEASE', status: 'FAILED' },
    failure: {
      code: 'ECS_DEPLOYMENT_FAILED',
      component: 'runtime',
      reference: 'DEP-BBBBBBBB',
      message: 'The new version could not be rolled out.',
      awsStatus: null,
    },
  }),
});

interface Mocks {
  detail: Record<string, unknown>;
  infra?: Record<string, unknown> | 'error';
  events?: unknown[] | 'error';
  destroyPlan?: Record<string, unknown>;
  updatePlan?: Record<string, unknown>;
}

/** Mounts the page for one mocked state and returns its main landmarks. */
async function open(page: Page, mocks: Mocks) {
  await page.route(`${API_URL}/api/deployments/qa-dep`, (route) =>
    route.fulfill({ json: mocks.detail }),
  );
  await page.route(`${API_URL}/api/deployments/qa-dep/events`, (route) =>
    mocks.events === 'error'
      ? route.fulfill({ status: 500, json: { error: { code: 'INTERNAL' } } })
      : route.fulfill({ json: { events: mocks.events ?? EVENTS } }),
  );
  await page.route(`${API_URL}/api/applications/qa-app/releases`, (route) =>
    route.fulfill({ json: { releases: RELEASES } }),
  );
  await page.route(`${API_URL}/api/deployments/qa-dep/infrastructure`, (route) =>
    mocks.infra === 'error'
      ? route.fulfill({ status: 500, json: { error: { code: 'INTERNAL' } } })
      : route.fulfill({ json: mocks.infra ?? infra() }),
  );
  await page.route(`${API_URL}/api/deployments/qa-dep/stack-events`, (route) =>
    route.fulfill({ json: { events: STACK_EVENTS } }),
  );
  await page.route(`${API_URL}/api/deployments/qa-dep/plan?action=destroy`, (route) =>
    route.fulfill({ json: mocks.destroyPlan ?? DESTROY_PLAN }),
  );
  await page.route(`${API_URL}/api/deployments/qa-dep/plan?action=update`, (route) =>
    route.fulfill({ json: mocks.updatePlan ?? UPDATE_PLAN_NO_DRIFT }),
  );

  await page.goto('/dashboard/deployments/qa-dep');
  const hero = page.locator('section[aria-labelledby="deployment-progress"]');
  // The headline is a plain heading for most states, and the §6 recovery
  // panel's AlertTitle (FailurePanel) for a destructive/warning tone —
  // never both at once.
  await expect(hero.locator('[aria-live="polite"]')).toBeVisible({ timeout: 30_000 });
  return {
    hero,
    headline: hero.locator('[aria-live="polite"]'),
    actions: page.locator('section[aria-labelledby="actions"]'),
    infrastructure: page.locator('section[aria-labelledby="infrastructure"]'),
    activity: page.locator('section[aria-labelledby="activity"]'),
    overview: page.locator('section[aria-labelledby="overview"]'),
  };
}

async function shoot(page: Page, name: string): Promise<void> {
  if (SCREENSHOTS) await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
}

// A generous ceiling, set at the file level rather than with
// `test.setTimeout()` inside a body, so it also covers the beforeEach hook:
// the first test of the run pays the dev server's cold compile of /sign-up,
// /dashboard and the detail route, which alone can exceed the plain 60s
// default (see e2e/scenario-ui.spec.ts's own note on this).
test.describe.configure({ timeout: 90_000 });

// Every test drives a real signed-up vendor session — a clean org per test,
// with the routes above meaning none of them ever reaches a real deployment.
test.beforeEach(async ({ page }) => {
  await signUp(page);
  await page.setViewportSize({ width: 1280, height: 900 });
});

test('waiting for the customer: the hero says what to do next and offers no day-2 actions', async ({
  page,
}) => {
  const { headline, hero, actions, infrastructure, activity } = await open(page, {
    detail: NOT_INSTALLED,
    infra: infra({
      snapshotState: 'none',
      summary: { status: 'unknown', componentCount: 0, technicalResourceCount: 0 },
      components: [],
    }),
    events: [],
  });

  await expect(headline).toHaveText('Waiting for your customer to install');
  await expect(hero).toContainText('Send Acme Corp the install link below.');
  await expect(page.getByRole('heading', { name: 'Install link' })).toBeVisible();
  // Deploy/Configuration act on a running application — not offered at all.
  await expect(actions.getByRole('button', { name: 'Deploy Update' })).toHaveCount(0);
  await expect(actions.getByRole('button', { name: 'Configuration' })).toHaveCount(0);
  await expect(actions.getByRole('link', { name: 'View Diagnostics' })).toHaveCount(0);
  await expect(infrastructure).toContainText('Not installed yet.');
  await expect(activity).toContainText('No activity yet.');
  // Nothing was installed and no relay ever connected, so the deployment can
  // still be removed (the API deletes it without a relay job).
  await actions.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Remove deployment' }).click();
  const removePanel = page.getByTestId('disconnect-panel');
  await expect(removePanel).toContainText('Nothing is installed yet');
  await expect(removePanel).not.toContainText('Will be retained');
  await page.keyboard.press('Escape');
  await shoot(page, 'not-installed');
});

test('deploying: the hero shows the phase, the step list and per-step timing, and gates day-2 actions', async ({
  page,
}) => {
  const { headline, hero, actions, infrastructure } = await open(page, {
    detail: DEPLOYING,
    infra: infra({
      summary: { status: 'provisioning', componentCount: 3, technicalResourceCount: 5 },
      components: [
        component('application', 'Application', 'pending'),
        component('database', 'Database', 'provisioning', 'retain', 'RDS'),
        component('network', 'Network', 'ready', 'delete', 'VPC'),
      ],
    }),
    events: EVENTS.slice(0, 2),
  });

  await expect(headline).toHaveText('Deploying');
  await expect(hero).toContainText('Creating the database and storage.');
  // Completed steps collapse into "N steps done" (ux-guidelines §9) — expand
  // it to see the process-order history and per-step timing.
  await hero.getByTestId('step-list-done-toggle').click();
  await expect(hero.getByText('Network created')).toBeVisible();
  await expect(hero.getByText('Creating database & storage')).toBeVisible();
  // The next step is named, not itemized.
  await expect(hero.getByText('Next: Redis cache')).toBeVisible();
  await expect(hero).toContainText('Typical: 3–12 minutes');
  expect(await hero.innerText()).not.toContain('%');
  // Completed steps carry their recorded durations (the API's stepTimings) —
  // the per-step history is not silently dropped once a step finishes.
  await expect(hero.getByText('2m 22s')).toBeVisible(); // AWS_SETUP (142s)
  await expect(hero.getByText('1m 1s')).toBeVisible(); // RELAY_CONNECT (61s)
  await expect(hero.getByText('33s')).toBeVisible(); // PREPARING (33s)
  await expect(hero.getByText('3m 4s')).toBeVisible(); // NETWORK (184s)
  // Nothing that mutates a half-created stack is offered mid-install.
  await expect(actions.getByRole('button', { name: 'Deploy Update' })).toHaveCount(0);
  await expect(infrastructure).toContainText('Some services are still being set up.');
  await shoot(page, 'deploying');
});

test('a slow install names the stuck step instead of a typical range', async ({ page }) => {
  const { headline, hero } = await open(page, {
    detail: {
      ...DEPLOYING,
      deploymentStatus: {
        ...(DEPLOYING.deploymentStatus as Record<string, unknown>),
        takingLongerThanUsual: true,
        aws: { stackStatus: 'CREATE_IN_PROGRESS' },
      },
    },
    infra: infra({
      summary: { status: 'provisioning', componentCount: 3, technicalResourceCount: 5 },
      components: [
        component('application', 'Application', 'pending'),
        component('database', 'Database', 'provisioning', 'retain', 'RDS'),
        component('network', 'Network', 'ready', 'delete', 'VPC'),
      ],
    }),
  });

  await expect(headline).toHaveText('Deploying');
  // takingLongerThanUsual replaces the typical-duration line on the active
  // step; the raw stack status stays vendor-visible in the nudge.
  await expect(hero).toContainText('Taking longer than usual · AWS: CREATE_IN_PROGRESS');
  expect(await hero.innerText()).not.toContain('Typical');
  await shoot(page, 'deploying-slow');
});

test('live: the address is the primary action, and the metadata stays compact', async ({ page }) => {
  const { headline, hero, actions, overview, infrastructure } = await open(page, {
    detail: detail(),
  });

  await expect(headline).toHaveText('Your application is live');
  await expect(hero).toContainText('Release v1.14.2 is running and passing health checks.');
  await expect(hero.getByRole('link', { name: 'Open application' })).toHaveAttribute(
    'href',
    'https://docs.acme.example',
  );
  await expect(actions.getByRole('button', { name: 'Deploy Update' })).toBeEnabled();
  await expect(actions.getByRole('link', { name: 'Configuration' })).toBeVisible();
  // Region reads as a place, not an AWS identifier, and the account id is
  // not on the default view at all.
  await expect(overview).toContainText('US East (Ohio)');
  expect(await overview.innerText()).not.toContain('1234');
  await expect(infrastructure).toContainText('All required services are ready.');
  await shoot(page, 'live');
});

test('deploy-update dialog: Infrastructure reads unchanged and no drift alert for the happy path', async ({
  page,
}) => {
  const { actions } = await open(page, { detail: detail() });

  await actions.getByRole('button', { name: 'Deploy Update' }).click();
  const panel = page.getByTestId('deploy-update-panel');
  await expect(panel.getByText('Infrastructure', { exact: true })).toBeVisible();
  await expect(panel.getByText('Unchanged', { exact: true })).toBeVisible();
  await expect(page.getByTestId('requirement-drift-alert')).toHaveCount(0);
  await page.keyboard.press('Escape');
});

test('deploy-update dialog: drift replaces the unchanged copy with a warning', async ({ page }) => {
  const { actions } = await open(page, {
    detail: detail(),
    updatePlan: {
      ...UPDATE_PLAN_NO_DRIFT,
      requirementDrift: [{ kind: 'cache', deployed: false, desired: true }],
    },
  });

  await actions.getByRole('button', { name: 'Deploy Update' }).click();
  const panel = page.getByTestId('deploy-update-panel');
  await expect(page.getByTestId('requirement-drift-alert')).toBeVisible();
  await expect(panel.getByText('Unchanged', { exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
});

test('live over a temporary address: the hero nudges toward a custom domain and only unused services read Not required', async ({
  page,
}) => {
  const { headline, hero, infrastructure } = await open(page, {
    detail: detail({
      customDomain: null,
      appUrl: 'http://deployz-alb-1a2b3c4d.us-east-2.elb.amazonaws.com',
      deploymentStatus: vendorStatus({
        stage: 'VERIFYING',
        step: 'TLS',
        needsDomainSetup: true,
        url: 'http://deployz-alb-1a2b3c4d.us-east-2.elb.amazonaws.com',
      }),
    }),
    infra: infra({
      summary: { status: 'healthy', componentCount: 5, technicalResourceCount: 9 },
      components: [
        component('application', 'Application', 'ready'),
        component('database', 'Database', 'ready', 'retain', 'RDS'),
        component('cache', 'Cache', 'ready', 'retain', 'ElastiCache'),
        component('endpoint', 'Secure endpoint', 'ready', 'delete', 'ELB'),
        component('network', 'Network', 'ready', 'delete', 'VPC'),
      ],
      expectations: {
        schemaVersion: 1,
        components: [
          { kind: 'application', expected: true, present: true },
          { kind: 'endpoint', expected: true, present: true },
          { kind: 'database', expected: true, present: true },
          { kind: 'storage', expected: false, present: false },
          { kind: 'cache', expected: false, present: true },
        ],
        missing: [],
        unexpected: ['cache'],
      },
    }),
  });

  await expect(headline).toHaveText('Your application is live');
  await expect(hero).toContainText('Add a custom domain to serve it over HTTPS.');
  // A provisioned cache is a real row (present but not required — no special
  // copy); only storage, which this application does not require, reads
  // "Not required".
  await expect(infrastructure.getByText('Cache', { exact: true })).toBeVisible();
  await expect(infrastructure.getByText('Not required', { exact: true })).toHaveCount(1);
  await shoot(page, 'live-temporary-address');
});

test('live while a secure address is being set up: no nudge to do work nobody needs to do', async ({
  page,
}) => {
  // Phase 11 brings up HTTPS without the customer touching DNS, and the API
  // signals that by leaving needsDomainSetup false while it progresses.
  const { headline, hero } = await open(page, {
    detail: detail({
      customDomain: null,
      appUrl: 'http://deployz-alb-1a2b3c4d.us-east-2.elb.amazonaws.com',
      deploymentStatus: vendorStatus({
        stage: 'VERIFYING',
        step: 'TLS',
        currentActivity: 'Waiting for a secure address.',
        needsDomainSetup: false,
        url: 'http://deployz-alb-1a2b3c4d.us-east-2.elb.amazonaws.com',
      }),
    }),
  });

  await expect(headline).toHaveText('Your application is live');
  await expect(hero).toContainText('A secure address is being set up.');
  expect(await hero.innerText()).not.toContain('Add a custom domain');
  await shoot(page, 'live-securing-address');
});

test('the secure endpoint row follows the HTTPS truth, never the load balancer alone', async ({ page }) => {
  // P0: CloudFormation reports the load balancer complete long before the
  // certificate is issued. The API overlays the HTTPS machine state on the
  // endpoint component; the row must say so instead of "Ready".
  const { infrastructure } = await open(page, {
    detail: detail({
      customDomain: null,
      appUrl: 'http://deployz-alb-1a2b3c4d.us-east-2.elb.amazonaws.com',
      deploymentStatus: vendorStatus({
        stage: 'VERIFYING',
        step: 'TLS',
        currentActivity: 'Waiting for a secure address.',
        needsDomainSetup: false,
        url: 'http://deployz-alb-1a2b3c4d.us-east-2.elb.amazonaws.com',
      }),
    }),
    infra: infra({
      summary: { status: 'provisioning', componentCount: 4, technicalResourceCount: 8 },
      components: [
        component('application', 'Application', 'ready'),
        component('database', 'Database', 'ready', 'retain', 'RDS'),
        {
          ...component('endpoint', 'Secure endpoint', 'provisioning', 'delete', 'ELB'),
          httpsState: 'WAITING_FOR_CERTIFICATE',
        },
        component('network', 'Network', 'ready', 'delete', 'VPC'),
      ],
    }),
  });

  await expect(infrastructure.getByText('Secure endpoint', { exact: true })).toBeVisible();
  await expect(infrastructure.getByText('Waiting for certificate', { exact: true })).toBeVisible();
  await expect(infrastructure.getByText('Ready', { exact: true })).toHaveCount(3);
});

test('failed first install: retry is the primary action and the raw AWS reason stays in the disclosure', async ({
  page,
}) => {
  const { headline, hero, actions, infrastructure, activity } = await open(page, {
    detail: FAILED_INSTALL,
    infra: infra({
      snapshotState: 'none',
      summary: { status: 'failed', componentCount: 0, technicalResourceCount: 0 },
      components: [],
    }),
    events: FAILED_EVENTS,
  });

  await expect(headline).toHaveText('Install failed');
  await expect(hero).toContainText('The database could not be created.');
  // The failure reference is an identifier: under the page's Technical details.
  await expect(hero).not.toContainText('DEP-AAAAAAAA');
  await page.getByTestId('technical-details').last().getByRole('button', { name: 'Technical details' }).click();
  await expect(page.getByText('DEP-AAAAAAAA')).toBeVisible();
  await expect(actions.getByRole('button', { name: 'Retry deployment' })).toBeEnabled();
  await expect(infrastructure).toContainText(
    "This deployment isn't running.",
  );

  // The activity feed's top level carries the classified, jargon-free
  // summary; the relay's raw error only appears once the row is expanded.
  await expect(activity).toContainText("The database couldn't be created.");
  expect(await activity.innerText()).not.toMatch(JARGON);
  await activity.locator('[data-testid="activity-feed"] button').first().click();
  await expect(activity).toContainText('AWS::RDS::DBInstance');
  await shoot(page, 'failed-install');
});

test('failed install: the raw failure status stays behind Technical details', async ({ page }) => {
  const { hero } = await open(page, { detail: FAILED_INSTALL });

  // The API's failure.awsStatus (ROLLBACK_COMPLETE) must not leak into the
  // hero — the recovery panel carries only the classified message; the raw
  // status and the failure reference move to Technical details.
  expect(await hero.innerText()).not.toContain('ROLLBACK_COMPLETE');
  await page.getByTestId('technical-details').last().getByRole('button', { name: 'Technical details' }).click();
  await expect(page.getByText('Failure status')).toBeVisible();
  await expect(page.getByText('ROLLBACK_COMPLETE')).toBeVisible();
  await shoot(page, 'failed-install-advanced');
});

test('failed update: the running release is named as still live, and the address stays reachable', async ({
  page,
}) => {
  const { headline, hero, actions } = await open(page, {
    detail: FAILED_UPDATE,
    events: [
      ...EVENTS,
      {
        occurredAt: '2025-09-12T12:06:00Z',
        eventType: 'deploy.failed',
        actorType: 'relay',
        result: 'failure',
        previousState: 'UPDATING',
        requestedState: 'UPDATE_AVAILABLE',
        payload: { failureCode: 'ECS_DEPLOYMENT_FAILED', error: 'circuit breaker triggered' },
      },
    ],
  });

  await expect(headline).toHaveText('Update failed');
  await expect(hero).toContainText('The new version could not be rolled out.');
  await expect(hero).toContainText('Release v1.14.2 is still live and unaffected.');
  // Never presented as down: the address is still offered, and retrying the
  // update is the primary action.
  await expect(hero.getByRole('link', { name: 'Open application' })).toBeVisible();
  await expect(actions.getByRole('button', { name: 'Retry update' })).toBeEnabled();
  await shoot(page, 'failed-update');
});

test('updating: the running operation is named, and other actions say why they are unavailable', async ({
  page,
}) => {
  const { headline, hero, actions } = await open(page, {
    detail: detail({
      state: 'UPDATING',
      jobs: [
        job({}),
        job({
          id: 'cccccccc-0000-0000-0000-000000000003',
          type: 'DEPLOY_RELEASE',
          state: 'RUNNING',
          createdAt: new Date(Date.now() - 200_000).toISOString(),
          startedAt: new Date(Date.now() - 180_000).toISOString(),
          finishedAt: null,
        }),
      ],
      deploymentStatus: vendorStatus({ job: { type: 'DEPLOY_RELEASE', status: 'RUNNING' } }),
    }),
  });

  await expect(headline).toHaveText('Updating your application');
  await expect(hero).toContainText('Release v1.14.2 stays live until the new version passes');
  await expect(hero).toContainText('Deploy update · Running');
  await expect(actions.getByRole('button', { name: 'Deploy Update' })).toBeDisabled();
  await expect(actions).toContainText(
    'Other actions become available when this operation finishes.',
  );
  // Disconnect is refused by the API while another operation owns the
  // deployment (requireDeploymentIdle), so it is disabled rather than
  // offering the vendor a confirmation dialog and a 409.
  await actions.getByRole('button', { name: 'More actions' }).click();
  await expect(page.getByRole('menuitem', { name: 'Remove deployment' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await shoot(page, 'updating');
});

test('deleting: cleanup progress, never a failure', async ({ page }) => {
  const { headline, hero, infrastructure } = await open(page, {
    detail: detail({
      state: 'DELETING',
      jobs: [
        job({}),
        job({
          id: 'dddddddd-0000-0000-0000-000000000004',
          type: 'DESTROY',
          state: 'RUNNING',
          createdAt: UPDATED_AT,
          finishedAt: null,
        }),
      ],
      deploymentStatus: vendorStatus({ job: { type: 'DESTROY', status: 'RUNNING' } }),
    }),
    infra: infra({
      summary: { status: 'deleting', componentCount: 4, technicalResourceCount: 8 },
      components: [
        component('application', 'Application', 'deleting'),
        component('database', 'Database', 'retained', 'retain', 'RDS'),
        component('storage', 'Storage', 'retained', 'snapshot', 'S3'),
        component('network', 'Network', 'deleting', 'delete', 'VPC'),
      ],
    }),
  });

  await expect(headline).toHaveText('Removing deployment');
  expect(await hero.innerText()).not.toContain('failed');
  await expect(hero).toContainText('Anything Deployz kept is listed under Infrastructure.');
  // Per-service removal progress, in product words.
  await expect(hero.getByText('Snapshot retained')).toBeVisible();
  await expect(infrastructure).toContainText('Services are being removed.');
  await shoot(page, 'deleting');
});

test('removed with retained resources: the outcome, the warning, and the purge action', async ({
  page,
}) => {
  const { headline, hero, actions } = await open(page, {
    detail: detail({
      state: 'DELETED',
      deletedAt: UPDATED_AT,
      appUrl: null,
      customDomain: null,
      deploymentStatus: vendorStatus({ job: { type: 'DESTROY', status: 'SUCCEEDED' }, url: null }),
    }),
    infra: infra({
      snapshotState: 'stale',
      summary: { status: 'retained', componentCount: 2, technicalResourceCount: 2 },
      components: [
        component('database', 'Database', 'retained', 'retain', 'RDS'),
        component('storage', 'Storage', 'retained', 'retain', 'S3'),
      ],
    }),
  });

  await expect(headline).toHaveText('Deployment removed');
  await expect(hero).toContainText('Retained resources remain in the customer AWS account');
  await expect(
    hero.getByRole('button', { name: 'Delete retained data' }),
  ).toBeVisible();
  // Nothing left to act on.
  await expect(actions.getByRole('button', { name: 'Deploy Update' })).toHaveCount(0);
  await expect(actions.getByRole('button', { name: 'More actions' })).toHaveCount(0);
  await shoot(page, 'removed-retained');
});

test('relay gone quiet: lost contact, not failure, with the last confirmed state', async ({
  page,
}) => {
  const { headline, hero, overview, infrastructure } = await open(page, {
    detail: detail({
      relayStatus: 'DISCONNECTED',
      healthStatus: 'UNKNOWN',
      deploymentStatus: vendorStatus({
        statusUpdatesUnavailable: true,
        relay: { connected: false, lastSeenAt: CREATED_AT },
      }),
    }),
    infra: infra({
      connectionState: 'disconnected',
      snapshotState: 'stale',
      disconnectWarning: { lastVerifiedAt: CREATED_AT },
    }),
  });

  await expect(headline).toHaveText('Lost contact with this deployment');
  await expect(hero).toContainText('Your application may still be running');
  await expect(hero).toContainText('Status updates unavailable');
  await expect(infrastructure).toContainText('Showing the last verified state');
  await expect(infrastructure).toContainText('Last known:');
  await expect(hero.getByText('HTTPS active', { exact: true })).toHaveCount(0);
  await expect(overview).toContainText('Last confirmed v1.14.2');
  await expect(overview).not.toContainText('Verifying…');
  await shoot(page, 'lost-contact');
});

test('failing health checks: the hero says the application is not responding', async ({ page }) => {
  const { headline, hero } = await open(page, {
    detail: detail({
      healthStatus: 'UNHEALTHY',
      deploymentStatus: vendorStatus({
        stage: 'VERIFYING',
        health: {
          status: 'UNHEALTHY',
          layers: {
            infrastructure: 'HEALTHY',
            rollout: 'COMPLETED',
            targets: null,
            http: null,
            relay: 'CONNECTED',
          },
        },
      }),
    }),
  });

  await expect(headline).toHaveText('Your application is not responding');
  await expect(hero).toContainText('Health checks are failing.');
  await shoot(page, 'unhealthy');
});

test('a failed infrastructure fetch warns in its own section and never becomes "not found"', async ({
  page,
}) => {
  const { headline, infrastructure } = await open(page, { detail: detail(), infra: 'error' });

  await expect(headline).toHaveText('Your application is live');
  await expect(page.getByRole('heading', { name: 'Deployment not found' })).toHaveCount(0);
  await expect(infrastructure).toContainText('Infrastructure details unavailable');
  await expect(infrastructure).toContainText('The deployment is unaffected.');
  // The connector's own connectivity is known without the inventory.
  await expect(infrastructure.getByText('Deployz connector')).toBeVisible();
  await shoot(page, 'infrastructure-error');
});

test('a failed activity fetch degrades only the activity section', async ({ page }) => {
  const { headline, activity, infrastructure } = await open(page, {
    detail: detail(),
    events: 'error',
  });

  await expect(headline).toHaveText('Your application is live');
  await expect(activity).toContainText('Activity unavailable.');
  await expect(infrastructure).toContainText('All required services are ready.');
  await shoot(page, 'activity-error');
});

test('activity is newest first, capped at five, and expands to the full history', async ({
  page,
}) => {
  const { activity } = await open(page, { detail: detail() });

  const rows = activity.locator('[data-testid="activity-feed"] > li');
  await expect(rows).toHaveCount(5);
  // EVENTS is authored oldest-first, exactly as the API returns it.
  await expect(rows.first()).toContainText('Health reported');
  await expect(rows.last()).toContainText('Installed and healthy');

  await activity.getByRole('button', { name: `View full activity (${EVENTS.length})` }).click();
  await expect(rows).toHaveCount(EVENTS.length);
  await expect(rows.last()).toContainText('Installation started');
  await shoot(page, 'activity-expanded');
});

test('destructive and rare actions live behind the overflow menu', async ({ page }) => {
  const { actions } = await open(page, { detail: detail() });

  await expect(actions.getByRole('button', { name: 'Remove deployment' })).toHaveCount(0);
  await actions.getByRole('button', { name: 'More actions' }).click();
  await expect(page.getByRole('menuitem', { name: 'Restart' })).toBeEnabled();
  await expect(page.getByRole('menuitem', { name: 'Rollback to v1.14.1' })).toBeEnabled();
  await expect(page.getByRole('menuitem', { name: 'Remove deployment' })).toBeEnabled();

  // The disconnect panel renders the deterministic destroy plan (Phase 4),
  // not a derivation from the resource inventory — Application and Secure
  // endpoint are deleted, Database and Storage are retained (DESTROY_PLAN).
  await page.getByRole('menuitem', { name: 'Remove deployment' }).click();
  const disconnectPanel = page.getByTestId('disconnect-panel');
  const willBeRemoved = disconnectPanel.locator('text=Will be removed').locator('..');
  await expect(willBeRemoved.getByText('Application', { exact: true })).toBeVisible();
  await expect(willBeRemoved.getByText('Secure endpoint', { exact: true })).toBeVisible();
  const willBeRetained = disconnectPanel.locator('text=Will be retained').locator('..');
  await expect(willBeRetained.getByText('Database', { exact: true })).toBeVisible();
  await expect(willBeRetained.getByText('Storage', { exact: true })).toBeVisible();
  // The dialog says what happens to the retained data and the connector, in
  // the same terms as the customer's removed page.
  await expect(willBeRetained.getByText(/Delete retained data removes them later/)).toBeVisible();
  await expect(disconnectPanel.getByText(/connector stays in your customer's AWS account until they delete its stack/)).toBeVisible();
  await disconnectPanel.getByRole('textbox').fill('Acme Corp');
  await page.keyboard.press('Escape');
  // A dialog opened from the menu hands focus back to the menu button, so a
  // keyboard user keeps their place.
  await expect(actions.getByRole('button', { name: 'More actions' })).toBeFocused();
  // A cancelled confirmation is not kept: reopening asks for the name again.
  await actions.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Remove deployment' }).click();
  await expect(disconnectPanel.getByRole('textbox')).toHaveValue('');
  await expect(disconnectPanel.getByRole('button', { name: 'Remove deployment' })).toBeDisabled();
  await page.keyboard.press('Escape');
});

test('AWS identifiers and the raw event feed stay inside Technical details', async ({ page }) => {
  await open(page, { detail: detail() });

  expect(await page.locator('body').innerText()).not.toContain('deployz-connector-qa');
  await expect(page.getByRole('button', { name: /Infrastructure events/ })).toHaveCount(0);

  await page.getByRole('button', { name: 'Technical details' }).click();
  await expect(page.getByText('deployz-connector-qa')).toBeVisible();
  await expect(page.getByRole('button', { name: /Infrastructure events/ })).toBeVisible();
});

test('the resource inventory opens from the infrastructure summary', async ({ page }) => {
  const { infrastructure } = await open(page, { detail: detail() });

  await expect(infrastructure.getByText('Runs your application')).toHaveCount(0);
  await infrastructure.getByRole('button', { name: 'View components and 4 AWS resources' }).click();
  await expect(infrastructure.getByText('Runs your application')).toBeVisible();
  await expect(infrastructure.getByText('Stores persistent application data')).toBeVisible();
});

test('a missing deployment is the only thing that renders "not found"', async ({ page }) => {
  await page.route(`${API_URL}/api/deployments/missing-dep`, (route) =>
    route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND' } } }),
  );
  await page.goto('/dashboard/deployments/missing-dep');
  await expect(page.getByRole('heading', { name: 'Deployment not found' })).toBeVisible();
});

test('the loading state is a skeleton, never a flash of an error', async ({ page }) => {
  await page.route(`${API_URL}/api/deployments/qa-dep`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    await route.fulfill({ json: detail() });
  });
  // `commit`, not the default `load`: the point is to observe the page while
  // its own fetch is still in flight, and awaiting `load` would blow past it.
  await page.goto('/dashboard/deployments/qa-dep', { waitUntil: 'commit' });
  await expect(page.getByTestId('detail-loading')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'Something went wrong' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Deployment not found' })).toHaveCount(0);
});

test('long names and URLs do not push the page sideways on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const { headline } = await open(page, {
    detail: detail({
      applicationName:
        'Enterprise Document Signing Platform Extended Edition For Regulated Industries',
      customerName: 'Consolidated International Holdings and Subsidiaries Group Limited',
      appUrl: LONG_URL,
      customDomain: { hostname: LONG_HOSTNAME, status: 'active' },
      deploymentStatus: vendorStatus({ url: LONG_URL }),
    }),
  });

  await expect(headline).toHaveText('Your application is live');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await shoot(page, 'long-names-mobile');
});

test('the live state fits a phone without sideways scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const { hero } = await open(page, { detail: detail() });

  await expect(hero.getByRole('link', { name: 'Open application' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
});

test('update available: the status badge and the update stay separate, and Deploy update names its target', async ({
  page,
}) => {
  const { actions } = await open(page, { detail: detail({ state: 'UPDATE_AVAILABLE' }) });

  await expect(page.getByTestId('update-available')).toHaveText('Update available: v1.15.0');
  await expect(page.getByTestId('deployment-status-badge')).toHaveText('Live');
  const deploy = actions.getByRole('button', { name: 'Deploy update to v1.15.0' });
  await expect(deploy).toBeEnabled();
  // The update is the one primary action; Configuration and Diagnostics stay secondary.
  await expect(actions.getByRole('button').first()).toHaveText('Deploy update to v1.15.0');
  await expect(actions.getByRole('button', { name: 'More actions' })).toBeVisible();
  await shoot(page, 'update-available');
});

test('healthy without an update: one status badge, and each fact appears once', async ({ page }) => {
  const { overview, hero } = await open(page, { detail: detail() });

  await expect(page.getByTestId('deployment-status-badge')).toHaveText('Live');
  await expect(page.getByTestId('update-available')).toHaveCount(0);
  await expect(overview).toContainText('Acme Corp');
  await expect(overview).toContainText('v1.14.2');
  // The address and the custom domain live only in the hero's access block.
  expect(await overview.innerText()).not.toContain('docs.acme.example');
  await expect(hero.getByText('HTTPS active', { exact: true })).toBeVisible();
  await expect(hero.getByRole('button', { name: 'Copy URL' })).toBeVisible();
});

// Diagnostics is folded into the deployment page (ux-guidelines §2); the
// /diagnostics route is now a deep link that redirects to the
// #infrastructure-check section, opened by default.
async function openDiagnostics(page: Page, deployment: Record<string, unknown>) {
  await page.route(`${API_URL}/api/deployments/qa-dep`, (route) => route.fulfill({ json: deployment }));
  await page.route(`${API_URL}/api/deployments/qa-dep/diagnostics`, (route) =>
    route.fulfill({
      json: { failureCode: null, recoverability: null, what: null, why: null, fix: null, events: [] },
    }),
  );
  await page.goto('/dashboard/deployments/qa-dep/diagnostics');
  await page.waitForURL(/#infrastructure-check$/);
  const outcome = page.getByTestId('infra-check-outcome');
  await expect(outcome).toBeVisible({ timeout: 30_000 });
  return outcome;
}

const CHECKS = [
  { name: 'stack-exists', passed: true, detail: 'Stack "deployz-app-qa" found' },
  { name: 'stack-complete', passed: true, detail: 'Stack status CREATE_COMPLETE' },
  { name: 'compute', passed: true, detail: 'Found a complete ECS service' },
  { name: 'cache', passed: false, required: false, detail: 'No cache cluster in the stack' },
];

test('diagnostics: a fresh passing check leads with the outcome and hides raw details', async ({ page }) => {
  const outcome = await openDiagnostics(
    page,
    detail({ lastHealthAt: new Date().toISOString(), observedState: { infraHealth: { checks: CHECKS } } }),
  );

  await expect(outcome).toContainText('No issues found in the latest infrastructure check.');
  await expect(outcome).toContainText('Application health is shown above.');
  await expect(page.getByRole('row', { name: /Cache/ })).toContainText('Not required');
  await expect(page.getByTestId('relay-report-technical')).toHaveCount(0);
  expect(await page.locator('section[aria-labelledby="infra-check"]').innerText()).not.toMatch(JARGON);
  await page.getByRole('button', { name: 'Raw check output' }).click();
  await expect(page.getByTestId('relay-report-technical')).toContainText('CREATE_COMPLETE');
  await shoot(page, 'diagnostics-passed');
});

test('diagnostics: an old report is out of date, never a fresh pass', async ({ page }) => {
  const outcome = await openDiagnostics(page, detail({ observedState: { infraHealth: { checks: CHECKS } } }));

  await expect(outcome).toContainText('The latest infrastructure check is out of date.');
  await expect(outcome).not.toContainText('No issues found');
});

test('diagnostics: a failing check shows the problem and the next step first', async ({ page }) => {
  const outcome = await openDiagnostics(
    page,
    detail({
      lastHealthAt: new Date().toISOString(),
      observedState: {
        infraHealth: { checks: [...CHECKS, { name: 'ingress', passed: false, detail: 'No load balancer' }] },
      },
    }),
  );

  await expect(outcome).toContainText('1 issue found in the latest infrastructure check.');
  await expect(outcome).toContainText('The load balancer was not created.');
  await expect(page.getByRole('row', { name: /Load balancer/ })).toContainText('Needs attention');
  await shoot(page, 'diagnostics-issue');
});

test('diagnostics: no completed check says so instead of passing', async ({ page }) => {
  const outcome = await openDiagnostics(page, detail({ observedState: null }));

  await expect(outcome).toContainText('No infrastructure check has completed yet');
  await expect(page.getByRole('table')).toHaveCount(0);
});

test('diagnostics fits a phone without sideways scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openDiagnostics(
    page,
    detail({ lastHealthAt: new Date().toISOString(), observedState: { infraHealth: { checks: CHECKS } } }),
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await shoot(page, 'diagnostics-mobile');
});

test('update available fits a phone without sideways scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await open(page, { detail: detail({ state: 'UPDATE_AVAILABLE' }) });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await shoot(page, 'update-available-mobile');
});
