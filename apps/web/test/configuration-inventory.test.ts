import { describe, expect, it } from 'vitest';

import { buildInstallPlan, type DeploymentManifest, type DeploymentPlan, type FootprintCostEstimate } from '@deployz/contracts';

import type { Application } from '../src/lib/applications';
import {
  deriveServiceInventory,
  estimateKind,
  formatRowCost,
  summarizeCostItems,
  type CostSummary,
  type InventoryRow,
  type ServiceInventory,
} from '../src/lib/configuration-inventory';
import type { ApplicationReadiness, DetectedApplication, DetectedFact } from '../src/lib/readiness';
import { webWorkersMysqlRedisArchitecture, webWorkersMysqlRedisPlan } from './fixtures/phase4-presentations';

// The Configuration tab's one "Services & resources" table: every AWS
// resource and every cost item lands on exactly one row, unknown prices never
// read as zero.

function manifestWith(overrides: Partial<DeploymentManifest> = {}): DeploymentManifest {
  return {
    schemaVersion: 1,
    application: { root: '.', runtime: 'node', framework: null, dockerfilePath: 'Dockerfile' },
    build: { command: 'npm run build', context: '.' },
    web: { command: 'npm start', port: 3000 },
    health: { path: '/health' },
    database: { postgres: true },
    redis: { required: true, envBindings: [] },
    storage: { required: true, envBindings: [] },
    migration: { command: null },
    worker: { command: null },
    environment: { variables: [] },
    externalServices: [],
    unsupported: [],
    ...overrides,
  };
}

const STANDARD_PLAN = buildInstallPlan({ manifest: manifestWith(), region: 'eu-west-1' });

const fact = <T,>(value: T): DetectedFact<T> => ({ value, source: 'dockerfile', confidence: 'confirmed', evidence: [] });

function detected(): DetectedApplication {
  return {
    analysisVersion: 13,
    runtime: fact('node'),
    framework: fact('fastify'),
    build: fact('npm ci && npm run build --workspace @acme/api -- --mode production --sourcemap false'),
    start: fact('node dist/index.js'),
    network: { port: fact(3000), bindAddress: fact(null) },
    database: { required: true, type: 'postgres', confidence: 'confirmed', evidence: [] },
    redis: { required: true, detected: true, supported: true, confidence: 'confirmed', purposes: [], evidence: [] },
    storage: { persistentLocalRequired: false, objectStorageDetected: true, evidence: [] },
    healthCheck: { detected: true, path: '/health', confidence: 'confirmed', evidence: [] },
    migrations: { detected: false, command: null, tools: [], evidence: [] },
    environmentVariables: [],
  };
}

function application(overrides: Partial<Application> = {}): Application {
  return {
    id: 'app-1',
    organizationId: 'org-1',
    name: 'Demo',
    githubInstallationId: null,
    repoFullName: 'acme/demo',
    repoUrl: 'https://github.com/acme/demo',
    defaultBranch: 'main',
    containerPort: null,
    healthPath: null,
    migrationCommand: null,
    workerCommand: null,
    databaseRequired: true,
    storageRequired: true,
    redisRequired: true,
    defaultSizeProfile: 'small',
    minimumSizeProfile: 'small',
    analysisStatus: 'COMPLETE',
    compatibilityStatus: 'READY',
    compatibilityReason: null,
    detectedMetadata: null,
    createdAt: '2026-09-01T10:00:00Z',
    updatedAt: '2026-09-01T10:00:00Z',
    ...overrides,
  };
}

function readiness(overrides: Partial<ApplicationReadiness> = {}): ApplicationReadiness {
  return {
    analysisStatus: 'COMPLETE',
    state: 'READY',
    requiredCount: 0,
    recommendedCount: 0,
    summary: null,
    failureReason: null,
    findings: [],
    passed: [],
    analyzedCommitSha: 'abc1234',
    detected: detected(),
    requirements: {
      schemaVersion: 1,
      database: { detected: true, effective: true, overridden: false },
      redis: { detected: true, effective: true, overridden: false },
      storage: { detected: true, effective: true, overridden: false },
    },
    deploymentRequirementDrift: [],
    architecture: { groups: [], unresolved: [], externalServices: [] },
    ...overrides,
  };
}

function inventoryFor(plan: DeploymentPlan | null, readinessOverrides: Partial<ApplicationReadiness> = {}, app = application()): ServiceInventory {
  return deriveServiceInventory({ application: app, readiness: readiness(readinessOverrides), plan });
}

function rows(inventory: ServiceInventory): InventoryRow[] {
  return inventory.groups.flatMap((group) => group.rows);
}

function row(inventory: ServiceInventory, id: string): InventoryRow {
  const found = rows(inventory).find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no row ${id}`);
  return found;
}

describe('inventory deduplication', () => {
  it('places every planned AWS resource on exactly one row, under the service that owns it', () => {
    const inventory = inventoryFor(STANDARD_PLAN);
    const placed = rows(inventory).flatMap((entry) => entry.resources.map((resource) => resource.id));

    expect([...placed].sort()).toEqual(STANDARD_PLAN.awsResources.map((resource) => resource.id).sort());
    expect(new Set(placed).size).toBe(placed.length);

    expect(row(inventory, 'web').resources.map((resource) => resource.id)).toEqual([
      'ecs_cluster',
      'ecs_service',
      'iam_roles',
      'log_group',
      'health_alarm',
    ]);
    expect(row(inventory, 'database').resources.map((resource) => resource.id)).toEqual([
      'database',
      'db_subnet_group',
      'db_subnets',
      'database_secrets',
    ]);
    expect(row(inventory, 'redis').resources.map((resource) => resource.id)).toEqual(['cache']);
    expect(row(inventory, 'storage').resources.map((resource) => resource.id)).toEqual(['storage_bucket']);
    expect(row(inventory, 'network').resources.map((resource) => resource.id)).toEqual([
      'vpc',
      'nat_gateway',
      'load_balancer',
      'security_groups',
    ]);
    // The configuration secret belongs to no single service — it stays visible, once.
    expect(row(inventory, 'shared').resources.map((resource) => resource.id)).toEqual(['app_config_secret']);
  });

  it('groups rows in the fixed order and gives build/runtime details their own indented rows', () => {
    const inventory = inventoryFor(STANDARD_PLAN);

    expect(inventory.groups.map((group) => group.label)).toEqual([
      'Application & runtime',
      'Data services',
      'Networking & HTTPS',
    ]);
    const application = inventory.groups[0]!.rows;
    expect(application.slice(0, 6).map((entry) => [entry.id, entry.indent])).toEqual([
      ['web', false],
      ['runtime', true],
      ['build', true],
      ['start', true],
      ['port', true],
      ['health', true],
    ]);
    // Full commands, never abbreviated.
    expect(row(inventory, 'build').configuration).toBe(
      'npm ci && npm run build --workspace @acme/api -- --mode production --sourcemap false',
    );
    expect(row(inventory, 'build').command).toBe(true);
    expect(row(inventory, 'migrations').indent).toBe(true);
    expect(row(inventory, 'port').action).toMatchObject({ kind: 'edit', label: 'Edit port', field: 'containerPort' });
  });

  it('keeps each resource’s own removal policy and marks a service with both as mixed', () => {
    const plan: DeploymentPlan = {
      ...STANDARD_PLAN,
      awsResources: STANDARD_PLAN.awsResources.map((resource) =>
        resource.id === 'database_secrets' ? { ...resource, lifecycle: 'delete' } : resource,
      ),
    };
    const database = row(inventoryFor(plan), 'database');

    expect(database.afterRemoval).toBe('Mixed');
    expect(database.resources.map((resource) => [resource.id, resource.afterRemoval])).toEqual([
      ['database', 'Kept'],
      ['db_subnet_group', 'Kept'],
      ['db_subnets', 'Kept'],
      ['database_secrets', 'Removed'],
    ]);
    expect(row(inventoryFor(STANDARD_PLAN), 'database').afterRemoval).toBe('Kept');
    expect(row(inventoryFor(STANDARD_PLAN), 'redis').afterRemoval).toBe('Removed');
  });

  it('shows nothing before an analysis has completed and no plan exists', () => {
    const inventory = deriveServiceInventory({
      application: application({ analysisStatus: 'ANALYZING' }),
      readiness: readiness({ analysisStatus: 'ANALYZING', detected: null }),
      plan: null,
    });
    expect(inventory.groups).toEqual([]);
  });
});

describe('cost aggregation', () => {
  it('counts each cost item once, and the network row sums the load balancer and the NAT gateway', () => {
    const inventory = inventoryFor(STANDARD_PLAN);
    const estimate = STANDARD_PLAN.costEstimate!;
    const priced = rows(inventory)
      .map((entry) => entry.cost)
      .filter((cost): cost is CostSummary => typeof cost === 'object' && cost !== null);

    const itemMin = estimate.items.reduce((sum, item) => sum + (item.monthlyMin ?? 0), 0);
    expect(priced.reduce((sum, cost) => sum + (cost.min ?? 0), 0)).toBe(itemMin);

    const alb = estimate.items.find((item) => item.resourceId === 'endpoint')!;
    const nat = estimate.items.find((item) => item.resourceId === 'nat-gateway')!;
    expect(row(inventory, 'network').cost).toEqual({
      min: alb.monthlyMin! + nat.monthlyMin!,
      max: alb.monthlyMax! + nat.monthlyMax!,
      usageBased: false,
      unpriced: false,
    });
    expect(formatRowCost(row(inventory, 'storage').cost as CostSummary)).toBe('Usage-based');
    // Detail rows carry no cost of their own.
    expect(row(inventory, 'runtime').cost).toBeNull();
  });

  it('never shows an unknown price as zero', () => {
    const summary = summarizeCostItems([
      { resourceId: 'web', label: 'Web', monthlyMin: 8, monthlyMax: 11, pricingStatus: 'estimated' },
      { resourceId: 'queue', label: 'Queue', pricingStatus: 'unavailable' },
    ])!;
    expect(formatRowCost(summary)).toBe('~$8–11 + unpriced items');
    expect(formatRowCost({ min: null, max: null, usageBased: false, unpriced: true })).toBe('Price unavailable');

    const withoutPlan = inventoryFor(null);
    expect(formatRowCost(row(withoutPlan, 'web').cost as CostSummary)).toBe('Price unavailable');
    expect(row(withoutPlan, 'web').resources).toEqual([]);
  });

  it('prices a planned resource with no cost item as unavailable, and keeps an unassigned item on the shared row', () => {
    const plan: DeploymentPlan = {
      ...STANDARD_PLAN,
      costEstimate: {
        ...STANDARD_PLAN.costEstimate!,
        items: [
          ...STANDARD_PLAN.costEstimate!.items.filter((item) => item.resourceId !== 'cache'),
          { resourceId: 'search', label: 'Search', monthlyMin: 5, monthlyMax: 6, pricingStatus: 'estimated' },
        ],
      },
    };
    const inventory = inventoryFor(plan);

    expect(formatRowCost(row(inventory, 'redis').cost as CostSummary)).toBe('Price unavailable');
    expect(row(inventory, 'shared').cost).toEqual({ min: 5, max: 6, usageBased: false, unpriced: false });
  });

  it('classifies an estimate as complete, baseline plus usage, partial, or unavailable', () => {
    const base: FootprintCostEstimate = {
      currency: 'USD',
      monthlyMin: 20,
      monthlyMax: 30,
      complete: true,
      items: [{ resourceId: 'web', label: 'Web', monthlyMin: 20, monthlyMax: 30, pricingStatus: 'estimated' }],
      usageDependent: [],
    };
    expect(estimateKind(base)).toBe('complete');
    expect(estimateKind({ ...base, usageDependent: ['Outbound internet data transfer'] })).toBe('baseline-plus-usage');
    expect(estimateKind({ ...base, complete: false })).toBe('partial');
    expect(estimateKind({ ...base, monthlyMin: null, monthlyMax: null })).toBe('unavailable');
    expect(estimateKind(null)).toBe('unavailable');
    expect(estimateKind(STANDARD_PLAN.costEstimate)).toBe('baseline-plus-usage');
  });
});

describe('recommended findings on an editable row', () => {
  it('keeps the edit action and offers the fix instructions beside the recommendation', () => {
    const finding = {
      id: 'database-migrations',
      category: 'database',
      title: 'Give Deployz a way to update your database',
      severity: 'recommended',
      blocking: false,
      plainEnglishExplanation: 'This app uses a database.',
      whyItMatters: 'Migrations run on every deploy.',
      technicalEvidence: 'A PostgreSQL library is present.',
      suggestedOutcome: 'Add a migration script.',
      confidence: 'likely',
    } as ApplicationReadiness['findings'][number];
    const database = row(inventoryFor(null, { findings: [finding] }), 'database');
    expect(database.action).toMatchObject({ kind: 'edit', field: 'databaseRequired' });
    expect(database.fixInstructions).toMatchObject({ kind: 'fix', testId: 'readiness-finding-fix-database-migrations' });
  });
});

describe('multiple workloads and detected questions', () => {
  it('gives every workload its own row, with quantity, and matches a compiled MySQL resource by category', () => {
    const inventory = deriveServiceInventory({
      application: application(),
      readiness: { ...readiness({ analysisStatus: 'PENDING', detected: null }), architecture: webWorkersMysqlRedisArchitecture },
      plan: webWorkersMysqlRedisPlan,
    });

    const application_ = inventory.groups.find((group) => group.id === 'application')!;
    expect(application_.rows.map((entry) => entry.label)).toEqual([
      'Web application',
      '2 × Email worker',
      'Jobs worker',
      'Detected component',
      'Shared resources',
    ]);
    const mysql = row(inventory, 'mysql');
    expect(mysql.resources.map((resource) => resource.id)).toEqual(['rds_mysql']);
    expect(formatRowCost(mysql.cost as CostSummary)).toBe('~$14–19');
    expect(mysql.afterRemoval).toBe('Kept');
    // A planned worker without a cost line is unpriced, never free.
    expect(formatRowCost(row(inventory, 'worker-a').cost as CostSummary)).toBe('Price unavailable');
    expect(row(inventory, 'question-0').issues[0]).toMatchObject({ label: 'Blocking' });
    expect(row(inventory, 'question-0').action).toMatchObject({ kind: 'fix', testId: 'architecture-unresolved-fix-mysql-database-0' });
  });

  it('adds a detected but unplanned background worker as not estimated, with its question and finding on one row', () => {
    const inventory = inventoryFor(STANDARD_PLAN, {
      findings: [
        {
          id: 'worker-command',
          category: 'workers',
          title: 'Background job runner',
          severity: 'recommended',
          blocking: false,
          plainEnglishExplanation: 'This app appears to run background jobs.',
          whyItMatters: '',
          technicalEvidence: '',
          suggestedOutcome: 'Process background jobs inside the web process.',
          confidence: 'likely',
        },
      ],
      architecture: {
        groups: [],
        unresolved: [{ kind: 'worker_command', question: 'What command starts the worker?', blocking: false }],
        externalServices: [],
      },
    });
    const worker = row(inventory, 'worker-detected');

    expect(worker).toMatchObject({ cost: 'not-estimated', afterRemoval: 'Not determined', questionIndexes: [0] });
    expect(worker.findingIds).toEqual(['worker-command']);
    expect(worker.issues.map((issue) => [issue.label, issue.text])).toEqual([
      ['Needs input', 'What command starts the worker?'],
      ['Recommended', 'Background job runner: This app appears to run background jobs.'],
    ]);
    expect(rows(inventory).some((entry) => entry.id === 'finding-worker-command')).toBe(false);
    expect(inventory.unestimatedWorkload).toBe(true);
  });

  it('attaches the worker command under a planned worker without repeating its row id', () => {
    const plan = buildInstallPlan({ manifest: manifestWith({ worker: { command: 'node worker.js' } }), region: null });
    const inventory = inventoryFor(plan, {}, application({ workerCommand: 'node worker.js' }));
    const ids = rows(inventory).map((entry) => entry.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(row(inventory, 'worker-command')).toMatchObject({ configuration: 'node worker.js', indent: true, command: true });
  });

  it('gives each worker, queue and schedule its own AWS resources instead of the web row', () => {
    const plan = buildInstallPlan({
      manifest: manifestWith({
        worker: { command: 'node worker.js' },
        queues: [
          {
            id: 'orders-queue',
            envBindings: [{ name: 'ORDERS_QUEUE_URL', kind: 'url' }],
            producers: ['web'],
            consumers: ['worker'],
            source: 'compose.yaml',
          },
        ],
        scheduledJobs: [
          { id: 'tick', command: 'node tick.js', schedule: { type: 'cron', cron: '0 3 * * *' }, timezone: null, source: 'compose.yaml' },
        ],
      }),
      region: null,
    });
    const inventory = inventoryFor(plan, {}, application({ workerCommand: 'node worker.js' }));
    const resourceIds = (id: string) => row(inventory, id).resources.map((resource) => resource.id);

    expect(resourceIds('web')).not.toContain('worker');
    expect(resourceIds('worker')).toEqual(['worker']);
    expect(resourceIds('tick')).toEqual(['tick']);
    expect(resourceIds('orders-queue')).toEqual(['orders-queue']);
    expect(resourceIds('tick-schedule')).toEqual(['tick-schedule']);
    expect(row(inventory, 'orders-queue').cost).toEqual({ min: null, max: null, usageBased: true, unpriced: false });
  });

  it('keeps the saved worker command, and its findings, when the workers have their own names', () => {
    const inventory = deriveServiceInventory({
      application: application({ workerCommand: 'node worker.js' }),
      readiness: readiness({
        findings: [
          {
            id: 'worker-process',
            category: 'workers',
            title: 'Background worker process',
            severity: 'recommended',
            blocking: false,
            plainEnglishExplanation: 'This app declares a background worker process.',
            whyItMatters: '',
            technicalEvidence: '',
            suggestedOutcome: 'No change needed.',
            confidence: 'confirmed',
          },
        ],
      }),
      plan: webWorkersMysqlRedisPlan,
    });
    const command = row(inventory, 'worker-command');

    expect(command).toMatchObject({ configuration: 'node worker.js', indent: true, findingIds: ['worker-process'] });
    expect(command.issues[0]).toMatchObject({ label: 'Recommended' });
  });

  it('lists external services as information: billed separately, no issue, a link to the variables', () => {
    const inventory = inventoryFor(STANDARD_PLAN, {
      architecture: { groups: [], unresolved: [], externalServices: ['stripe', 'openai'] },
    });
    const integrations = inventory.groups.find((group) => group.id === 'integrations')!;

    expect(integrations.rows.map((entry) => [entry.label, entry.cost])).toEqual([
      ['Stripe', 'billed-separately'],
      ['OpenAI', 'billed-separately'],
    ]);
    expect(integrations.rows[0]!.issues).toEqual([]);
    expect(integrations.rows[0]!.action).toMatchObject({ kind: 'link', href: '#environment-variables' });
    expect(inventory.externalServices).toEqual(['Stripe', 'OpenAI']);
  });
});
