import { describe, expect, it } from 'vitest';

import { buildDestroyPlan, buildInstallPlan, buildUpdatePlan, deploymentPlanSchema, planComponentKindSchema, topologyDriftFor } from './plan.js';
import type { ApplicationGraph } from './application-graph.js';
import { requiredAwsResources, toPlanAwsResource } from './aws-resources.js';
import { estimateFootprintCost } from './pricing.js';
import { resolveDeploymentFootprint } from './footprint.js';
import type { DeploymentManifest } from './manifest.js';
import type { InfrastructureRequirements, Region } from './index.js';

function planAwsResources(profile: InfrastructureRequirements) {
  return requiredAwsResources(profile).map(toPlanAwsResource);
}

/** The footprint + estimate fields every plan now carries, derived the same way the builders do. */
function planExtras(manifest: DeploymentManifest, region: Region | null) {
  const footprint = resolveDeploymentFootprint({ manifest, region });
  return { footprint, costEstimate: estimateFootprintCost(footprint) };
}

function manifestWith(postgres: boolean, redisRequired: boolean): DeploymentManifest {
  return {
    schemaVersion: 1,
    application: { root: '.', runtime: 'node', framework: null, dockerfilePath: 'Dockerfile' },
    build: { command: 'npm run build', context: '.' },
    web: { command: 'npm start', port: 3000 },
    health: { path: '/health' },
    database: { postgres },
    redis: { required: redisRequired, envBindings: [] },
    storage: { required: false, envBindings: [] },
    migration: { command: null },
    worker: { command: null },
    environment: { variables: [] },
    externalServices: [],
    unsupported: [],
  };
}

const POSTGRES_ONLY = manifestWith(true, false);
const POSTGRES_REDIS = manifestWith(true, true);
const STATELESS = manifestWith(false, false);
const STATELESS_REDIS = manifestWith(false, true);

describe('buildInstallPlan', () => {
  it('v1 (postgres, no redis): CREATE application, endpoint, database, storage', () => {
    const plan = buildInstallPlan({ manifest: POSTGRES_ONLY, region: 'us-east-1' });
    expect(plan).toEqual({
      schemaVersion: 1,
      action: 'INSTALL',
      region: 'us-east-1',
      components: [
        { kind: 'application', name: 'Application', action: 'CREATE', lifecycle: 'delete' },
        { kind: 'endpoint', name: 'Secure endpoint', action: 'CREATE', lifecycle: 'delete' },
        { kind: 'database', name: 'Database', action: 'CREATE', lifecycle: 'retain' },
        { kind: 'storage', name: 'Storage', action: 'CREATE', lifecycle: 'retain' },
      ],
      awsResources: planAwsResources({ postgres: true, redis: false }),
      ...planExtras(POSTGRES_ONLY, 'us-east-1'),
      requirementDrift: [],
    });
  });

  it('redis-v1 (postgres + redis): CREATE application, endpoint, database, storage, cache', () => {
    const plan = buildInstallPlan({ manifest: POSTGRES_REDIS, region: 'us-east-1' });
    expect(plan.components).toEqual([
      { kind: 'application', name: 'Application', action: 'CREATE', lifecycle: 'delete' },
      { kind: 'endpoint', name: 'Secure endpoint', action: 'CREATE', lifecycle: 'delete' },
      { kind: 'database', name: 'Database', action: 'CREATE', lifecycle: 'retain' },
      { kind: 'storage', name: 'Storage', action: 'CREATE', lifecycle: 'retain' },
      { kind: 'cache', name: 'Cache', action: 'CREATE', lifecycle: 'delete' },
    ]);
  });

  it('stateless-v1 (neither): CREATE application, endpoint, storage', () => {
    const plan = buildInstallPlan({ manifest: STATELESS, region: null });
    expect(plan.components).toEqual([
      { kind: 'application', name: 'Application', action: 'CREATE', lifecycle: 'delete' },
      { kind: 'endpoint', name: 'Secure endpoint', action: 'CREATE', lifecycle: 'delete' },
      { kind: 'storage', name: 'Storage', action: 'CREATE', lifecycle: 'retain' },
    ]);
    expect(plan.region).toBeNull();
  });

  it('stateless-redis-v1 (redis only): CREATE application, endpoint, storage, cache', () => {
    const plan = buildInstallPlan({ manifest: STATELESS_REDIS, region: 'eu-west-1' });
    expect(plan.components).toEqual([
      { kind: 'application', name: 'Application', action: 'CREATE', lifecycle: 'delete' },
      { kind: 'endpoint', name: 'Secure endpoint', action: 'CREATE', lifecycle: 'delete' },
      { kind: 'storage', name: 'Storage', action: 'CREATE', lifecycle: 'retain' },
      { kind: 'cache', name: 'Cache', action: 'CREATE', lifecycle: 'delete' },
    ]);
  });

  it('is deterministic: two calls deep-equal and stringify identically', () => {
    const a = buildInstallPlan({ manifest: POSTGRES_REDIS, region: 'us-east-1' });
    const b = buildInstallPlan({ manifest: POSTGRES_REDIS, region: 'us-east-1' });
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  describe('workers, queues and schedules', () => {
    const ASYNC: DeploymentManifest = {
      ...STATELESS,
      worker: { command: 'node worker.js' },
      workers: [{ id: 'worker', command: 'node worker.js', source: 'Procfile' }],
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
          id: 'canary-tick',
          command: 'node tick.js',
          schedule: { type: 'cron', cron: '0 3 * * *' },
          timezone: null,
          deadLetter: true,
          source: 'compose.yaml',
        },
      ],
    };

    it('lists the worker, each queue and dead-letter queue, and each schedule as components', () => {
      const plan = buildInstallPlan({ manifest: ASYNC, region: 'us-east-1' });
      expect(deploymentPlanSchema.parse(plan)).toEqual(plan);
      expect(plan.components.map((c) => [c.kind, c.name, c.componentId, c.group, c.action])).toEqual([
        ['application', 'Application', undefined, undefined, 'CREATE'],
        ['endpoint', 'Secure endpoint', undefined, undefined, 'CREATE'],
        ['storage', 'Storage', undefined, undefined, 'CREATE'],
        ['worker', 'Background worker', 'worker', 'application', 'CREATE'],
        ['worker', 'Scheduled job canary-tick', 'canary-tick', 'application', 'CREATE'],
        ['queue', 'Orders queue', 'orders-queue', 'messaging', 'CREATE'],
        ['queue', 'Orders queue dead-letter queue', 'orders-queue-dlq', 'messaging', 'CREATE'],
        ['schedule', 'Schedule for canary-tick', 'canary-tick-schedule', 'messaging', 'CREATE'],
        ['queue', 'Scheduled job canary-tick dead-letter queue', 'canary-tick-schedule-dlq', 'messaging', 'CREATE'],
      ]);
    });

    it('lists the same resources in the AWS resources with plain purposes, after the catalog rows', () => {
      const plan = buildInstallPlan({ manifest: ASYNC, region: 'us-east-1' });
      const catalog = planAwsResources({ postgres: false, redis: false });
      expect(plan.awsResources.slice(0, catalog.length)).toEqual(catalog);
      expect(plan.awsResources.slice(catalog.length).map((r) => [r.id, r.name, r.group, r.componentKind])).toEqual([
        ['worker', 'Background worker (ECS Fargate)', 'compute_networking', 'application'],
        ['canary-tick', 'Scheduled job canary-tick (ECS Fargate task)', 'compute_networking', 'application'],
        ['orders-queue', 'Orders queue (SQS)', 'data', 'queue'],
        ['orders-queue-dlq', 'Orders queue dead-letter queue (SQS)', 'data', 'queue'],
        ['canary-tick-schedule', 'Schedule for canary-tick (EventBridge Scheduler)', 'compute_networking', 'schedule'],
        ['canary-tick-schedule-dlq', 'Scheduled job canary-tick dead-letter queue (SQS)', 'data', 'queue'],
      ]);
      expect(plan.awsResources.every((r) => r.purpose.length > 0)).toBe(true);
    });

    it('a legacy single worker slot is listed as the background worker', () => {
      const plan = buildInstallPlan({ manifest: { ...STATELESS, worker: { command: 'node worker.js' } }, region: null });
      expect(plan.components.map((c) => c.name)).toContain('Background worker');
    });

    it('is deterministic', () => {
      const a = buildInstallPlan({ manifest: ASYNC, region: 'us-east-1' });
      expect(JSON.stringify(a)).toBe(JSON.stringify(buildInstallPlan({ manifest: ASYNC, region: 'us-east-1' })));
    });
  });
});

describe('buildDestroyPlan', () => {
  it('v1 (postgres, no redis): DELETE application/endpoint, RETAIN database/storage', () => {
    const plan = buildDestroyPlan({ manifest: POSTGRES_ONLY, region: 'us-east-1' });
    expect(plan).toEqual({
      schemaVersion: 1,
      action: 'DESTROY',
      region: 'us-east-1',
      components: [
        { kind: 'application', name: 'Application', action: 'DELETE', lifecycle: 'delete' },
        { kind: 'endpoint', name: 'Secure endpoint', action: 'DELETE', lifecycle: 'delete' },
        { kind: 'database', name: 'Database', action: 'RETAIN', lifecycle: 'retain' },
        { kind: 'storage', name: 'Storage', action: 'RETAIN', lifecycle: 'retain' },
      ],
      awsResources: planAwsResources({ postgres: true, redis: false }),
      ...planExtras(POSTGRES_ONLY, 'us-east-1'),
      requirementDrift: [],
    });
  });

  it('redis-v1 (postgres + redis): DELETE application/endpoint/cache, RETAIN database/storage', () => {
    const plan = buildDestroyPlan({ manifest: POSTGRES_REDIS, region: 'us-east-1' });
    expect(plan.components).toEqual([
      { kind: 'application', name: 'Application', action: 'DELETE', lifecycle: 'delete' },
      { kind: 'endpoint', name: 'Secure endpoint', action: 'DELETE', lifecycle: 'delete' },
      { kind: 'database', name: 'Database', action: 'RETAIN', lifecycle: 'retain' },
      { kind: 'storage', name: 'Storage', action: 'RETAIN', lifecycle: 'retain' },
      { kind: 'cache', name: 'Cache', action: 'DELETE', lifecycle: 'delete' },
    ]);
  });

  it('stateless-v1: lists no database/cache and RETAINs only storage', () => {
    const plan = buildDestroyPlan({ manifest: STATELESS, region: 'us-east-1' });
    expect(plan.components.map((component) => component.kind)).not.toContain('database');
    expect(plan.components.map((component) => component.kind)).not.toContain('cache');
    expect(plan.components.filter((component) => component.action === 'RETAIN')).toEqual([
      { kind: 'storage', name: 'Storage', action: 'RETAIN', lifecycle: 'retain' },
    ]);
  });

  it('stateless-redis-v1: DELETE application/endpoint/cache, RETAIN storage', () => {
    const plan = buildDestroyPlan({ manifest: STATELESS_REDIS, region: 'us-east-1' });
    expect(plan.components).toEqual([
      { kind: 'application', name: 'Application', action: 'DELETE', lifecycle: 'delete' },
      { kind: 'endpoint', name: 'Secure endpoint', action: 'DELETE', lifecycle: 'delete' },
      { kind: 'storage', name: 'Storage', action: 'RETAIN', lifecycle: 'retain' },
      { kind: 'cache', name: 'Cache', action: 'DELETE', lifecycle: 'delete' },
    ]);
  });
});

describe('buildUpdatePlan', () => {
  it('application UNCHANGED, no drift, when profiles agree and there is no newer release', () => {
    const plan = buildUpdatePlan({
      deployedManifest: POSTGRES_ONLY,
      desiredManifest: POSTGRES_ONLY,
      region: 'us-east-1',
      newRelease: false,
    });
    expect(plan).toEqual({
      schemaVersion: 1,
      action: 'UPDATE',
      region: 'us-east-1',
      components: [
        { kind: 'application', name: 'Application', action: 'UNCHANGED', lifecycle: 'delete' },
        { kind: 'endpoint', name: 'Secure endpoint', action: 'UNCHANGED', lifecycle: 'delete' },
        { kind: 'database', name: 'Database', action: 'UNCHANGED', lifecycle: 'retain' },
        { kind: 'storage', name: 'Storage', action: 'UNCHANGED', lifecycle: 'retain' },
      ],
      awsResources: planAwsResources({ postgres: true, redis: false }),
      ...planExtras(POSTGRES_ONLY, 'us-east-1'),
      requirementDrift: [],
    });
  });

  it('application UPDATE when a newer release exists; every other component still UNCHANGED', () => {
    const plan = buildUpdatePlan({
      deployedManifest: POSTGRES_REDIS,
      desiredManifest: POSTGRES_REDIS,
      region: 'us-east-1',
      newRelease: true,
    });
    expect(plan.components).toEqual([
      { kind: 'application', name: 'Application', action: 'UPDATE', lifecycle: 'delete' },
      { kind: 'endpoint', name: 'Secure endpoint', action: 'UNCHANGED', lifecycle: 'delete' },
      { kind: 'database', name: 'Database', action: 'UNCHANGED', lifecycle: 'retain' },
      { kind: 'storage', name: 'Storage', action: 'UNCHANGED', lifecycle: 'retain' },
      { kind: 'cache', name: 'Cache', action: 'UNCHANGED', lifecycle: 'delete' },
    ]);
    expect(plan.requirementDrift).toEqual([]);
  });

  it('reports drift, never a CREATE, when the desired profile gained redis', () => {
    const plan = buildUpdatePlan({
      deployedManifest: POSTGRES_ONLY,
      desiredManifest: POSTGRES_REDIS,
      region: 'us-east-1',
      newRelease: false,
    });
    // Deployed profile has no cache component — the plan never invents one.
    expect(plan.components.map((component) => component.kind)).not.toContain('cache');
    expect(plan.requirementDrift).toEqual([{ kind: 'cache', deployed: false, desired: true }]);
  });

  it('reports drift the other direction, when the desired profile lost redis', () => {
    const plan = buildUpdatePlan({
      deployedManifest: POSTGRES_REDIS,
      desiredManifest: POSTGRES_ONLY,
      region: 'us-east-1',
      newRelease: false,
    });
    expect(plan.components.map((component) => component.kind)).toContain('cache');
    expect(plan.requirementDrift).toEqual([{ kind: 'cache', deployed: true, desired: false }]);
  });

  it('is deterministic: two calls deep-equal and stringify identically', () => {
    const input = {
      deployedManifest: POSTGRES_ONLY,
      desiredManifest: POSTGRES_REDIS,
      region: 'us-east-1' as const,
      newRelease: true,
    };
    const a = buildUpdatePlan(input);
    const b = buildUpdatePlan(input);
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('deploymentPlanSchema', () => {
  it('round-trips every plan shape unchanged', () => {
    const plans = [
      buildInstallPlan({ manifest: POSTGRES_REDIS, region: 'us-east-1' }),
      buildInstallPlan({ manifest: STATELESS, region: null }),
      buildDestroyPlan({ manifest: POSTGRES_ONLY, region: 'us-east-1' }),
      buildUpdatePlan({
        deployedManifest: POSTGRES_ONLY,
        desiredManifest: POSTGRES_REDIS,
        region: 'us-east-1',
        newRelease: true,
      }),
    ];
    for (const plan of plans) {
      expect(deploymentPlanSchema.parse(plan)).toEqual(plan);
    }
  });
});

describe('infrastructureChange (optional wire field)', () => {
  const basePlan = buildInstallPlan({ manifest: POSTGRES_ONLY, region: 'us-east-1' });

  it('absent stays absent', () => {
    expect(deploymentPlanSchema.parse(basePlan).infrastructureChange).toBeUndefined();
  });

  it('round-trips status none', () => {
    const plan = { ...basePlan, infrastructureChange: { status: 'none' as const } };
    expect(deploymentPlanSchema.parse(plan)).toEqual(plan);
  });

  it('round-trips status unsupported with a reason', () => {
    const plan = { ...basePlan, infrastructureChange: { status: 'unsupported' as const, reason: 'topology_changed' } };
    expect(deploymentPlanSchema.parse(plan)).toEqual(plan);
  });

  it('rejects unsupported without a reason', () => {
    const plan = { ...basePlan, infrastructureChange: { status: 'unsupported' as const } };
    expect(deploymentPlanSchema.safeParse(plan).success).toBe(false);
  });
});

describe('planComponentKindSchema widening', () => {
  it('accepts the worker, queue and schedule kinds', () => {
    for (const kind of ['worker', 'queue', 'schedule'] as const) {
      expect(planComponentKindSchema.safeParse(kind).success).toBe(true);
    }
  });
});

describe('topologyDriftFor', () => {
  function graph(parts: {
    engine?: 'postgres' | 'mysql';
    workloads?: string[];
    queues?: string[];
    schedules?: string[];
  }): ApplicationGraph {
    return {
      workloads: [{ id: 'web', kind: 'web' }, { id: 'migration', kind: 'migration' }, ...(parts.workloads ?? []).map((id) => ({ id, kind: 'worker' }))],
      resources: [
        ...(parts.engine ? [{ id: 'primary-db', kind: 'relational_database', engine: parts.engine }] : []),
        ...(parts.queues ?? []).map((id) => ({ id, kind: 'queue', engine: null })),
      ],
      schedules: (parts.schedules ?? []).map((id) => ({ id })),
    } as unknown as ApplicationGraph;
  }

  it('reports nothing for identical topology, whatever the migration step does', () => {
    expect(topologyDriftFor(graph({ engine: 'postgres' }), graph({ engine: 'postgres' }))).toEqual([]);
  });

  it('reports a changed engine only when both graphs have a database', () => {
    expect(topologyDriftFor(graph({ engine: 'postgres' }), graph({ engine: 'mysql' }))).toEqual([
      { kind: 'engine', name: 'mysql', deployed: false, desired: true },
    ]);
    expect(topologyDriftFor(graph({}), graph({ engine: 'mysql' }))).toEqual([]);
  });

  it('reports added and removed workloads, queues and schedules by name', () => {
    expect(
      topologyDriftFor(
        graph({ workloads: ['mailer'], queues: ['old'], schedules: ['nightly'] }),
        graph({ workloads: ['indexer'], queues: ['jobs'], schedules: ['nightly', 'weekly'] }),
      ),
    ).toEqual([
      { kind: 'workload', name: 'indexer', deployed: false, desired: true },
      { kind: 'workload', name: 'mailer', deployed: true, desired: false },
      { kind: 'queue', name: 'jobs', deployed: false, desired: true },
      { kind: 'queue', name: 'old', deployed: true, desired: false },
      { kind: 'schedule', name: 'weekly', deployed: false, desired: true },
    ]);
  });
});

describe('package entry', () => {
  // Guards the plan.ts <-> index.ts import order: importing from the
  // package entry (not plan.js directly) must resolve buildInstallPlan to a
  // working function, not undefined from a circular-import ordering bug.
  it('resolves buildInstallPlan through ./index.js', async () => {
    const { buildInstallPlan: buildInstallPlanFromIndex } = await import('./index.js');
    const plan = buildInstallPlanFromIndex({ manifest: POSTGRES_ONLY, region: 'us-east-1' });
    expect(plan.action).toBe('INSTALL');
  });
});
