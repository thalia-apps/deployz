import { describe, expect, it } from 'vitest';

import { estimateFootprintCost } from './pricing.js';
import {
  deploymentFootprintSchema,
  resolveDeploymentFootprint,
} from './footprint.js';
import { defaultInfrastructureSizeProfile } from './profile.js';
import type { DeploymentFootprint, FootprintResource, FootprintWorkload } from './footprint.js';
import type { DeploymentManifest } from './manifest.js';

function manifestWith(overrides: Partial<DeploymentManifest> = {}): DeploymentManifest {
  return {
    schemaVersion: 1,
    application: { root: '.', runtime: 'node', framework: null, dockerfilePath: 'Dockerfile' },
    build: { command: 'npm run build', context: '.' },
    web: { command: 'npm start', port: 3000 },
    health: { path: '/health' },
    database: { postgres: false },
    redis: { required: false, envBindings: [] },
    storage: { required: false, envBindings: [] },
    migration: { command: null },
    worker: { command: null },
    environment: { variables: [] },
    externalServices: [],
    unsupported: [],
    ...overrides,
  };
}

const STATELESS = manifestWith();
const WITH_POSTGRES = manifestWith({ database: { postgres: true } });
const WITH_POSTGRES_REDIS = manifestWith({ database: { postgres: true }, redis: { required: true, envBindings: [] } });
const WITH_WORKER = manifestWith({ worker: { command: 'npm run worker' } });

describe('resolveDeploymentFootprint', () => {
  it('web workload only: exact resolved compute, no database/cache, always-on resources', () => {
    const footprint = resolveDeploymentFootprint({ manifest: STATELESS, region: 'us-east-1' });
    expect(footprint.version).toBe(1);
    expect(footprint.workloads).toHaveLength(1);
    const web = footprint.workloads[0]!;
    expect(web.id).toBe('web');
    expect(web.role).toBe('web');
    expect(web.quantity).toBe(defaultInfrastructureSizeProfile().workload.desiredCount);
    expect(web.compute).toEqual({
      provider: 'aws',
      service: 'ecs-fargate',
      cpuUnits: 256,
      memoryMiB: 512,
      sizeLabel: 'Small',
    });
    expect(web.lifecycle).toEqual({ persistent: false });
    expect(footprint.resources.map((resource) => resource.id)).toEqual(['storage', 'endpoint', 'nat-gateway']);
    expect(footprint.region).toBe('us-east-1');
  });

  it('compute + PostgreSQL: resolved database sizing and retained lifecycle', () => {
    const footprint = resolveDeploymentFootprint({ manifest: WITH_POSTGRES, region: 'eu-west-1' });
    const database = footprint.resources.find((resource) => resource.id === 'database')!;
    expect(database.category).toBe('database');
    expect(database.service).toBe('rds-postgres');
    expect(database.quantity).toBe(1);
    expect(database.configuration).toEqual({
      engine: 'postgres',
      engineVersion: '16',
      instanceType: 'db.t3.micro',
      storageGb: 20,
      maxStorageGb: 100,
    });
    expect(database.lifecycle).toEqual({ persistent: true, retainOnDelete: true });
  });

  it('compute + PostgreSQL + Redis: cache resource with resolved node type, removed on delete', () => {
    const footprint = resolveDeploymentFootprint({ manifest: WITH_POSTGRES_REDIS, region: null });
    expect(footprint.resources.map((resource) => resource.id)).toEqual([
      'database',
      'cache',
      'storage',
      'endpoint',
      'nat-gateway',
    ]);
    const cache = footprint.resources.find((resource) => resource.id === 'cache')!;
    expect(cache.service).toBe('elasticache-valkey');
    expect(cache.configuration).toEqual({ engine: 'valkey', nodeType: 'cache.t4g.micro', nodes: 1 });
    expect(cache.lifecycle).toEqual({ persistent: false, retainOnDelete: false });
    expect(footprint.region).toBeNull();
  });

  it('no database: no database resource, no engine assumptions in common resources', () => {
    const footprint = resolveDeploymentFootprint({ manifest: STATELESS, region: null });
    expect(footprint.resources.some((resource) => resource.category === 'database')).toBe(false);
  });

  it('a manifest worker command resolves a second workload from the sizing table', () => {
    const footprint = resolveDeploymentFootprint({ manifest: WITH_WORKER, region: null });
    const worker = footprint.workloads.find((workload) => workload.id === 'worker');
    const sizing = defaultInfrastructureSizeProfile().workload;
    expect(worker).toEqual({
      id: 'worker',
      role: 'worker',
      label: 'Background worker',
      quantity: sizing.desiredCount,
      compute: {
        provider: 'aws',
        service: 'ecs-fargate',
        cpuUnits: sizing.cpuUnits,
        memoryMiB: sizing.memoryMiB,
        sizeLabel: defaultInfrastructureSizeProfile().label,
      },
      lifecycle: { persistent: false },
    });
  });

  it('a workers list resolves one footprint workload per declared worker (Phase 4A)', () => {
    const WITH_WORKERS = manifestWith({
      worker: { command: 'npm run email' },
      workers: [
        { id: 'email-worker', command: 'npm run email', source: 'Procfile' },
        { id: 'import-worker', command: 'npm run import', source: 'Procfile' },
      ],
    });
    const footprint = resolveDeploymentFootprint({ manifest: WITH_WORKERS, region: null });
    expect(footprint.workloads.map((workload) => workload.id)).toEqual([
      'web',
      'email-worker',
      'import-worker',
    ]);
    expect(footprint.workloads[1]!.label).toBe('Worker email-worker');
  });

  it('scheduled jobs, queues and schedules resolve usage-billed footprint entries (Phase 5)', () => {
    const footprint = resolveDeploymentFootprint({
      region: null,
      manifest: manifestWith({
        queues: [
          {
            id: 'orders-queue',
            envBindings: [{ name: 'ORDERS_QUEUE_URL', kind: 'url' }],
            producers: ['web'],
            consumers: ['worker'],
            deadLetter: { maxReceiveCount: 3, envBindings: [], producers: [], consumers: [] },
            source: 'compose.yaml',
          },
        ],
        scheduledJobs: [
          {
            id: 'cleanup',
            command: 'node cleanup.js',
            schedule: { type: 'cron', cron: '0 3 * * *' },
            timezone: null,
            source: 'compose.yaml',
          },
        ],
      }),
    });
    expect(footprint.workloads.map((workload) => [workload.id, workload.role])).toEqual([
      ['web', 'web'],
      ['cleanup', 'scheduled-job'],
    ]);
    expect(footprint.resources.slice(-3).map((resource) => [resource.id, resource.service, resource.role])).toEqual([
      ['orders-queue', 'sqs', 'queue'],
      ['orders-queue-dlq', 'sqs', 'queue'],
      ['cleanup-schedule', 'eventbridge-scheduler', 'schedule'],
    ]);
    expect(deploymentFootprintSchema.parse(footprint)).toEqual(footprint);
  });

  it('a manifest database engine of mysql resolves a real rds-mysql footprint row (Phase 4B)', () => {
    const WITH_MYSQL = manifestWith({
      database: { postgres: true, engine: 'mysql' },
    });
    const footprint = resolveDeploymentFootprint({ manifest: WITH_MYSQL, region: null });
    const database = footprint.resources.find((resource) => resource.id === 'database')!;
    expect(database.service).toBe('rds-mysql');
    expect(database.configuration).toMatchObject({ engine: 'mysql', engineVersion: '8.0' });
    expect(database.lifecycle).toEqual({ persistent: true, retainOnDelete: true });
    // A postgres manifest (no engine field) keeps the historical row.
    const postgresFootprint = resolveDeploymentFootprint({ manifest: WITH_POSTGRES, region: null });
    expect(postgresFootprint.resources.find((r) => r.id === 'database')!.service).toBe('rds-postgres');
  });

  it('generatedFrom records the template generation; ids and order are stable', () => {
    const a = resolveDeploymentFootprint({ manifest: WITH_POSTGRES, region: 'us-east-1', infraVersion: 'runtime-v1' });
    const b = resolveDeploymentFootprint({ manifest: WITH_POSTGRES, region: 'us-east-1', infraVersion: 'runtime-v1' });
    expect(a).toEqual(b);
    expect(a.generatedFrom).toEqual({ infraVersion: 'runtime-v1' });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('round-trips through the zod schema; infraVersion defaults to null', () => {
    const footprint = resolveDeploymentFootprint({ manifest: WITH_POSTGRES_REDIS, region: 'us-east-1' });
    expect(deploymentFootprintSchema.parse(footprint)).toEqual(footprint);
    expect(resolveDeploymentFootprint({ manifest: WITH_POSTGRES, region: null }).generatedFrom).toEqual({
      infraVersion: null,
    });
  });
});

// Extensibility: a synthetic fixture with a SQL Server database and a
// scheduler workload — resource types Deployz does not provision —
// must validate against the generic schema and degrade in pricing without
// any PostgreSQL-specific code path. This proves the model (not rendering)
// accepts future engines and roles.
describe('generic model accepts future resource types', () => {
  const sqlServerResource: FootprintResource = {
    id: 'database',
    category: 'database',
    provider: 'aws',
    service: 'rds-sqlserver',
    role: 'database',
    label: 'Database',
    quantity: 1,
    configuration: { engine: 'sqlserver', engineVersion: '2022', instanceType: 'db.t3.micro', storageGb: 20 },
    lifecycle: { persistent: true, retainOnDelete: true },
  };
  const schedulerWorkload: FootprintWorkload = {
    id: 'scheduler',
    role: 'scheduler',
    label: 'Scheduler',
    quantity: 1,
    compute: {
      provider: 'aws',
      service: 'ecs-fargate',
      cpuUnits: 256,
      memoryMiB: 512,
      sizeLabel: 'Small',
    },
    lifecycle: { persistent: false },
  };
  const FUTURE: DeploymentFootprint = {
    version: 1,
    region: 'us-east-1',
    workloads: [
      resolveDeploymentFootprint({ manifest: STATELESS, region: 'us-east-1' }).workloads[0]!,
      schedulerWorkload,
    ],
    resources: [
      sqlServerResource,
      ...resolveDeploymentFootprint({ manifest: STATELESS, region: 'us-east-1' }).resources,
    ],
    generatedFrom: { infraVersion: null },
  };

  it('validates a synthetic SQL Server + scheduler footprint against the generic schema', () => {
    expect(deploymentFootprintSchema.parse(FUTURE)).toEqual(FUTURE);
  });

  it('pricing the synthetic footprint: unknown engine degrades to unavailable, never dropped', () => {
    const estimate = estimateFootprintCost(FUTURE);
    const database = estimate.items.find((item) => item.resourceId === 'database')!;
    expect(database.pricingStatus).toBe('unavailable');
    expect(estimate.complete).toBe(false);
    expect(estimate.items.some((item) => item.resourceId === 'scheduler' && item.pricingStatus === 'estimated')).toBe(
      true,
    );
  });
});
