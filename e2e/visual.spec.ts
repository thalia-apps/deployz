import { expect, test, type Page } from '@playwright/test';

// Visual regression for a small set of canonical dashboard pages
// (docs/ui-system.md). Every screen renders from fully mocked API responses
// with fixed ids, names and timestamps, so the only pixel input is the UI
// itself. The sidebar's org name (derived from the signup email) is masked.
// Regenerate with: pnpm exec playwright test e2e/visual.spec.ts --update-snapshots

const API_URL = `http://localhost:${process.env.API_PORT ?? 3001}`;

// Fixed clock — every rendered date derives from these strings.
const CREATED_AT = '2025-09-12T10:00:00Z';
const UPDATED_AT = '2025-09-12T11:30:00Z';

interface DeploymentFixture {
  id: string;
  customerId: string;
  applicationId: string;
  organizationId: string;
  region: string;
  state: string;
  awsAccountId: string | null;
  currentReleaseId: string | null;
  previousReleaseId: string | null;
  relayStatus: string;
  healthStatus: string;
  components: Record<string, string> | null;
  installLinkId: string;
  desiredState: Record<string, unknown>;
  observedState: Record<string, unknown> | null;
  infraVersion: string;
  installationId: string;
  deploymentType: string;
  billingState: string;
  billingStartedAt: string | null;
  billingStoppedAt: string | null;
  lastHealthAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  updatedBy: string | null;
  customerName: string;
  applicationName: string;
  version: string | null;
  [key: string]: unknown;
}

function deployment(overrides: Partial<DeploymentFixture>): DeploymentFixture {
  return {
    id: 'vis-dep-1',
    customerId: 'vis-cust-1',
    applicationId: 'vis-app-1',
    organizationId: 'vis-org',
    region: 'us-east-1',
    state: 'HEALTHY',
    awsAccountId: '123456789012',
    currentReleaseId: 'vis-rel-2',
    previousReleaseId: 'vis-rel-1',
    relayStatus: 'CONNECTED',
    healthStatus: 'HEALTHY',
    components: { application: 'HEALTHY', database: 'HEALTHY', loadBalancer: 'HEALTHY' },
    installLinkId: 'vis-install-link',
    desiredState: {},
    observedState: null,
    infraVersion: 'v1',
    installationId: 'vis-installation',
    deploymentType: 'PRODUCTION',
    billingState: 'NOT_STARTED',
    billingStartedAt: null,
    billingStoppedAt: null,
    lastHealthAt: '2025-09-12T11:29:30Z',
    deletedAt: null,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    createdBy: null,
    updatedBy: null,
    customerName: 'Acme',
    applicationName: 'Documenso',
    version: '1.14.2',
    deploymentStatus: vendorStatus(overrides.state === 'FAILED' ? FAILED_STATUS : {}),
    ...overrides,
  };
}

// The derived progress projection the API now returns with every fleet row
// (see toVendorDeploymentStatus). Fixed timestamps like everything else here;
// the relative-time renders it feeds are additionally masked, since they
// drift with the real clock.
function vendorStatus(overrides: Record<string, unknown>): Record<string, unknown> {
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
    health: { status: 'HEALTHY' },
    url: 'https://docs.acme.example',
    failure: null,
    ...overrides,
  };
}

const FAILED_STATUS = {
  stage: 'FAILED',
  currentActivity: 'The PostgreSQL database could not be created.',
  step: 'DATABASE_STORAGE',
  components: [
    { key: 'runtime', label: 'Application runtime', status: 'PENDING' },
    { key: 'database', label: 'PostgreSQL database', status: 'FAILED' },
    { key: 'storage', label: 'Storage', status: 'NOT_REQUIRED' },
    { key: 'redis', label: 'Redis', status: 'NOT_REQUIRED' },
  ],
  health: { status: 'UNKNOWN' },
  url: null,
  failure: {
    code: 'DATABASE_CREATE_FAILED',
    component: 'database',
    reference: 'DEP-VIS00001',
    message: 'The PostgreSQL database could not be created.',
    awsStatus: 'CREATE_FAILED',
  },
};

const READY_APPLICATION = {
  id: 'vis-app-1',
  name: 'Documenso',
  repoFullName: 'acme/documenso',
  repoUrl: 'https://github.com/acme/documenso',
  defaultBranch: 'main',
  analysisStatus: 'COMPLETE',
  compatibilityStatus: 'READY',
  databaseRequired: true,
  healthPath: '/health',
  detectedMetadata: { hasDockerfile: true },
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
};

const CAPABILITIES = {
  deployRelease: true,
  rollback: true,
  restart: true,
  configUpdate: true,
  destroy: true,
};

const EVENTS = [
  {
    occurredAt: CREATED_AT,
    eventType: 'install.completed',
    actorType: 'relay',
    result: 'success',
    previousState: 'INSTALLING',
    requestedState: 'HEALTHY',
    payload: {},
  },
  {
    occurredAt: UPDATED_AT,
    eventType: 'deploy.completed',
    actorType: 'relay',
    result: 'success',
    previousState: 'UPDATING',
    requestedState: 'HEALTHY',
    payload: {},
  },
];

const RELEASES = [
  { id: 'vis-rel-2', version: '1.14.2', gitSha: '53ae8f100000000000000000000000deadbeef', createdAt: UPDATED_AT },
  { id: 'vis-rel-1', version: '1.14.1', gitSha: '41bd7c200000000000000000000000deadbeef', createdAt: CREATED_AT },
];

// The §59 resource inventory GET /api/deployments/:id/infrastructure returns
// (packages/contracts/src/infrastructure.ts's infrastructureResponseSchema).
// A few realistic components — the detail page fetches this unconditionally,
// so every deployment detail screenshot needs it mocked.
const INFRASTRUCTURE = {
  provider: 'aws',
  region: 'us-east-1',
  stackStatus: 'CREATE_COMPLETE',
  connectionState: 'connected',
  snapshotState: 'fresh',
  summary: { status: 'healthy', componentCount: 3, technicalResourceCount: 3 },
  components: [
    {
      kind: 'application',
      name: 'Application',
      purpose: 'Runs your application',
      status: 'ready',
      awsService: 'ECS',
      region: 'us-east-1',
      lifecycle: 'delete',
      resources: [
        {
          logicalId: 'Service',
          physicalId: 'arn:aws:ecs:us-east-1:123456789012:service/vis-service',
          type: 'AWS::ECS::Service',
          status: 'CREATE_COMPLETE',
          statusReason: null,
        },
      ],
    },
    {
      kind: 'database',
      name: 'Database',
      purpose: 'Stores persistent application data',
      status: 'ready',
      awsService: 'RDS',
      region: 'us-east-1',
      lifecycle: 'retain',
      resources: [
        {
          logicalId: 'Database',
          physicalId: 'vis-db-instance',
          type: 'AWS::RDS::DBInstance',
          status: 'CREATE_COMPLETE',
          statusReason: null,
        },
      ],
    },
    {
      kind: 'endpoint',
      name: 'Secure endpoint',
      purpose: 'Provides HTTPS access',
      status: 'ready',
      awsService: 'ELB',
      region: 'us-east-1',
      lifecycle: 'delete',
      resources: [
        {
          logicalId: 'LoadBalancer',
          physicalId: 'vis-alb',
          type: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
          status: 'CREATE_COMPLETE',
          statusReason: null,
        },
      ],
    },
  ],
  lastUpdatedAt: UPDATED_AT,
  disconnectWarning: null,
};

// GET /api/deployments/:id/stack-events returns (vendorStackEventSchema in
// packages/contracts/src/index.ts). Rendered inside a default-collapsed
// disclosure (InfrastructureEvents), so this only affects the trigger row.
const STACK_EVENTS = [
  {
    id: 1,
    eventAt: CREATED_AT,
    logicalResourceId: 'Service',
    resourceType: 'AWS::ECS::Service',
    resourceStatus: 'CREATE_COMPLETE',
    resourceStatusReason: null,
  },
  {
    id: 2,
    eventAt: UPDATED_AT,
    logicalResourceId: 'Database',
    resourceType: 'AWS::RDS::DBInstance',
    resourceStatus: 'CREATE_COMPLETE',
    resourceStatusReason: null,
  },
];

async function signUp(page: Page): Promise<void> {
  const email = `visual-${crypto.randomUUID().slice(0, 8)}@example.com`;
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill('E2E User');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('super-secret-1');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL('/dashboard');
}

async function mockFleet(page: Page, deployments: DeploymentFixture[]): Promise<void> {
  // Glob: the fleet list fetcher appends ?includeDeleted=true (CANARY-012),
  // and the exact-URL pattern would miss it, falling through to the real
  // (empty) API and rendering the empty state instead of the mocked rows.
  await page.route(`${API_URL}/api/deployments*`, (route) =>
    route.fulfill({ json: { deployments } }),
  );
  await page.route(`${API_URL}/api/applications`, (route) =>
    route.fulfill({
      json: { applications: deployments.length === 0 ? [] : [READY_APPLICATION] },
    }),
  );
}

/**
 * The job list a deployment in this state really carries. UPDATING is set by
 * the API at the moment it creates the deploy job, so an UPDATING deployment
 * with no active job is not a state that exists — and the detail page reads
 * the job list, not `state`, to decide which actions an in-flight operation
 * has taken over.
 */
function jobsFor(state: string): Record<string, unknown>[] {
  if (state !== 'UPDATING') return [];
  return [
    {
      id: 'vis-job-1',
      deploymentId: 'vis-dep-1',
      type: 'DEPLOY_RELEASE',
      state: 'RUNNING',
      idempotencyKey: 'vis-dep-1:DEPLOY_RELEASE:vis-rel-2',
      payload: {},
      result: null,
      requestedBy: null,
      failureCode: null,
      createdAt: UPDATED_AT,
      startedAt: UPDATED_AT,
      lastProgressAt: UPDATED_AT,
      finishedAt: null,
    },
  ];
}

async function mockDetail(page: Page, detail: DeploymentFixture): Promise<void> {
  await page.route(`${API_URL}/api/deployments/${detail.id}`, (route) =>
    route.fulfill({
      json: {
        ...detail,
        jobs: jobsFor(detail.state),
        customDomain: null,
        appUrl: 'http://acme-alb.us-east-1.elb.amazonaws.com',
        relayCapabilities: CAPABILITIES,
      },
    }),
  );
  await page.route(`${API_URL}/api/deployments/${detail.id}/events`, (route) =>
    route.fulfill({ json: { events: EVENTS } }),
  );
  await page.route(`${API_URL}/api/applications/${detail.applicationId}/releases`, (route) =>
    route.fulfill({ json: { releases: RELEASES } }),
  );
  await page.route(`${API_URL}/api/deployments/${detail.id}/infrastructure`, (route) =>
    route.fulfill({ json: INFRASTRUCTURE }),
  );
  await page.route(`${API_URL}/api/deployments/${detail.id}/stack-events`, (route) =>
    route.fulfill({ json: { events: STACK_EVENTS } }),
  );
}

test.describe('dashboard visual regression', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('home — first-time setup', async ({ page }) => {
    await signUp(page);
    await mockFleet(page, []);
    await page.goto('/dashboard');
    await expect(page.getByRole('link', { name: 'Add application' })).toBeVisible();
    await expect(page).toHaveScreenshot('home-setup.png', {
      mask: [page.getByTestId('org-name'), page.getByTestId('deployment-updated'), page.getByTestId('customer-activity')],
    });
  });

  test('home — operational', async ({ page }) => {
    await signUp(page);
    await mockFleet(page, [
      deployment({ id: 'vis-dep-1', customerName: 'Acme', state: 'HEALTHY' }),
      deployment({
        id: 'vis-dep-2',
        customerId: 'vis-cust-2',
        customerName: 'Globex',
        state: 'HEALTHY',
        region: 'eu-west-1',
        version: '1.14.1',
      }),
      deployment({
        id: 'vis-dep-3',
        customerId: 'vis-cust-3',
        customerName: 'Initech',
        state: 'UPDATING',
      }),
    ]);
    await page.goto('/dashboard');
    await expect(page.getByTestId('overview-summary')).toBeVisible();
    await expect(page).toHaveScreenshot('home-operational.png', {
      mask: [page.getByTestId('org-name'), page.getByTestId('deployment-updated'), page.getByTestId('customer-activity')],
    });
  });

  test('home — needs attention', async ({ page }) => {
    await signUp(page);
    await mockFleet(page, [
      deployment({ customerName: 'Acme', state: 'HEALTHY' }),
      deployment({
        id: 'vis-dep-2',
        customerId: 'vis-cust-2',
        customerName: 'Globex',
        state: 'FAILED',
        healthStatus: 'UNHEALTHY',
        region: 'eu-west-1',
        version: '1.14.1',
      }),
    ]);
    await page.goto('/dashboard');
    await expect(page.getByTestId('next-steps')).toContainText('1 deployment needs attention');
    await expect(page).toHaveScreenshot('home-attention.png', {
      mask: [page.getByTestId('org-name'), page.getByTestId('deployment-updated'), page.getByTestId('customer-activity')],
    });
  });

  test('deployments list', async ({ page }) => {
    await signUp(page);
    await mockFleet(page, [
      deployment({ customerName: 'Acme', state: 'HEALTHY' }),
      deployment({
        id: 'vis-dep-2',
        customerId: 'vis-cust-2',
        customerName: 'Globex',
        state: 'FAILED',
        healthStatus: 'UNHEALTHY',
        relayStatus: 'DISCONNECTED',
        region: 'eu-west-1',
        version: '1.14.1',
      }),
      deployment({
        id: 'vis-dep-3',
        customerId: 'vis-cust-3',
        customerName: 'Initech',
        state: 'UPDATING',
      }),
    ]);
    await page.goto('/dashboard/deployments');
    await expect(page.getByTestId('deployment-list')).toBeVisible();
    await expect(page).toHaveScreenshot('deployments-list.png', {
      mask: [page.getByTestId('org-name'), page.getByTestId('deployment-updated'), page.getByTestId('customer-activity')],
    });
  });

  for (const [name, overrides] of [
    ['healthy', { state: 'HEALTHY' } as const],
    ['failed', { state: 'FAILED', healthStatus: 'UNHEALTHY' } as const],
    ['updating', { state: 'UPDATING' } as const],
  ] as const) {
    test(`deployment detail — ${name}`, async ({ page }) => {
      const detail = deployment(overrides);
      await signUp(page);
      await mockFleet(page, [detail]);
      await mockDetail(page, detail);
      await page.goto(`/dashboard/deployments/${detail.id}`);
      await expect(page.getByRole('heading', { name: 'Documenso' })).toBeVisible();
      await expect(page).toHaveScreenshot(`detail-${name}.png`, {
        mask: [page.getByTestId('org-name'), page.getByTestId('deployment-updated'), page.getByTestId('customer-activity')],
      });
    });
  }

  test('mobile home — operational', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await signUp(page);
    await mockFleet(page, [
      deployment({ customerName: 'Acme', state: 'HEALTHY' }),
      deployment({
        id: 'vis-dep-2',
        customerId: 'vis-cust-2',
        customerName: 'Globex',
        state: 'UPDATING',
      }),
    ]);
    await page.goto('/dashboard');
    await expect(page.getByTestId('overview-summary')).toBeVisible();
    await expect(page).toHaveScreenshot('home-operational-mobile.png', {
      mask: [page.getByTestId('org-name'), page.getByTestId('deployment-updated'), page.getByTestId('customer-activity')],
    });
  });
});

test.describe('auth visual regression', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('sign in', async ({ page }) => {
    await page.goto('/sign-in');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expect(page).toHaveScreenshot('auth-sign-in.png');
  });

  test('sign up', async ({ page }) => {
    await page.goto('/sign-up');
    await expect(page.getByRole('heading', { name: 'Sign up' })).toBeVisible();
    await expect(page).toHaveScreenshot('auth-sign-up.png');
  });
});
