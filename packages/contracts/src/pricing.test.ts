import { describe, expect, it } from 'vitest';

import { estimateFootprintCost, footprintCostEstimateSchema } from './pricing.js';
import { resolveDeploymentFootprint } from './footprint.js';
import { LARGE_PROFILE, MEDIUM_PROFILE, SMALL_PROFILE } from './profile.js';
import type { FootprintResource } from './footprint.js';
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
const WITH_POSTGRES_REDIS = manifestWith({ database: { postgres: true }, redis: { required: true, envBindings: [] } });

function unknownServiceResource(id: string): FootprintResource {
  return {
    id,
    category: 'other',
    provider: 'aws',
    service: `future-${id}`,
    role: 'other',
    label: id,
    quantity: 1,
    configuration: {},
    lifecycle: { persistent: false, retainOnDelete: false },
  };
}

describe('estimateFootprintCost', () => {
  it('prices a supported footprint: items, rounded total, usage-dependent list', () => {
    const estimate = estimateFootprintCost(
      resolveDeploymentFootprint({ manifest: WITH_POSTGRES_REDIS, region: 'us-east-1' }),
    );
    expect(estimate.currency).toBe('USD');
    // web 8–11, database 14–19, alb 15–25, nat 30–40; cache excluded below.
    const web = estimate.items.find((item) => item.resourceId === 'web')!;
    expect(web).toEqual({
      resourceId: 'web',
      label: 'Web application',
      monthlyMin: 8,
      monthlyMax: 11,
      pricingStatus: 'estimated',
    });
    const cache = estimate.items.find((item) => item.resourceId === 'cache')!;
    expect(cache.pricingStatus).toBe('estimated');
    expect(cache.monthlyMin).toBe(12);
    expect(cache.monthlyMax).toBe(15);
    // web 8–11 + cache 12–15 + database 14–19 + alb 15–25 + nat 30–40:
    // min 79 -> 75; max 110 -> 110
    expect(estimate.monthlyMin).toBe(75);
    expect(estimate.monthlyMax).toBe(110);
    expect(estimate.complete).toBe(true);
    expect(estimate.usageDependent).toContain('Files stored in S3 and data transfer');
    expect(estimate).toEqual(footprintCostEstimateSchema.parse(estimate));
  });

  it('prices every published size from its own sizing', () => {
    const itemRange = (profile: typeof MEDIUM_PROFILE, id: string) => {
      const estimate = estimateFootprintCost(
        resolveDeploymentFootprint({ manifest: WITH_POSTGRES_REDIS, region: 'us-east-1', profile }),
      );
      const item = estimate.items.find((entry) => entry.resourceId === id)!;
      expect(estimate.complete).toBe(true);
      return [item.monthlyMin, item.monthlyMax];
    };
    expect(itemRange(SMALL_PROFILE, 'database')).toEqual([14, 19]);
    expect(itemRange(MEDIUM_PROFILE, 'web')).toEqual([33, 40]);
    expect(itemRange(MEDIUM_PROFILE, 'database')).toEqual([50, 60]);
    expect(itemRange(MEDIUM_PROFILE, 'cache')).toEqual([18, 24]);
    expect(itemRange(LARGE_PROFILE, 'web')).toEqual([68, 80]);
    expect(itemRange(LARGE_PROFILE, 'database')).toEqual([100, 115]);
    expect(itemRange(LARGE_PROFILE, 'cache')).toEqual([36, 45]);
  });

  it('prices a MySQL database like the same RDS instance class', () => {
    const estimate = estimateFootprintCost(
      resolveDeploymentFootprint({
        manifest: manifestWith({ database: { postgres: true, engine: 'mysql' } }),
        region: 'us-east-1',
        profile: MEDIUM_PROFILE,
      }),
    );
    const database = estimate.items.find((item) => item.resourceId === 'database')!;
    expect(database).toMatchObject({ label: 'MySQL', monthlyMin: 50, monthlyMax: 60, pricingStatus: 'estimated' });
  });

  it('a size with no pricing range is unavailable, never a guess', () => {
    const footprint = resolveDeploymentFootprint({ manifest: STATELESS, region: 'us-east-1' });
    const odd = {
      ...footprint,
      workloads: footprint.workloads.map((workload) => ({ ...workload, compute: { ...workload.compute, cpuUnits: 4096, memoryMiB: 8192 } })),
    };
    const estimate = estimateFootprintCost(odd);
    expect(estimate.items.find((item) => item.resourceId === 'web')!.pricingStatus).toBe('unavailable');
    expect(estimate.complete).toBe(false);
  });

  it('a stateless deployment still estimates (workload + endpoint + NAT)', () => {
    const estimate = estimateFootprintCost(resolveDeploymentFootprint({ manifest: STATELESS, region: 'us-east-1' }));
    expect(estimate.monthlyMin).toBe(50); // 8+15+30=53 -> floor5 50
    expect(estimate.monthlyMax).toBe(80); // 11+25+40=76 -> ceil5 80
  });

  it('region-aware: sa-east-1 multiplies the baseline', () => {
    const us = estimateFootprintCost(resolveDeploymentFootprint({ manifest: STATELESS, region: 'us-east-1' }));
    const br = estimateFootprintCost(resolveDeploymentFootprint({ manifest: STATELESS, region: 'sa-east-1' }));
    const webUs = us.items.find((item) => item.resourceId === 'web')!;
    const webBr = br.items.find((item) => item.resourceId === 'web')!;
    expect(webBr.monthlyMin).toBe(Math.round(webUs.monthlyMin! * 1.5));
    expect(br.monthlyMax).toBeGreaterThan(us.monthlyMax!);
  });

  it('a null region falls back to the baseline factor', () => {
    const baseline = estimateFootprintCost(resolveDeploymentFootprint({ manifest: STATELESS, region: 'us-east-1' }));
    const unknown = estimateFootprintCost(resolveDeploymentFootprint({ manifest: STATELESS, region: null }));
    expect(unknown.monthlyMin).toBe(baseline.monthlyMin);
    expect(unknown.monthlyMax).toBe(baseline.monthlyMax);
  });

  it('partial availability: one unknown service is listed unavailable, total incomplete but present', () => {
    const footprint = resolveDeploymentFootprint({ manifest: STATELESS, region: 'us-east-1' });
    const estimate = estimateFootprintCost({
      ...footprint,
      resources: [...footprint.resources, unknownServiceResource('search')],
    });
    const search = estimate.items.find((item) => item.resourceId === 'search')!;
    expect(search).toEqual({ resourceId: 'search', label: 'search', pricingStatus: 'unavailable' });
    expect(estimate.complete).toBe(false);
    expect(estimate.monthlyMin).not.toBeNull();
    expect(estimate.monthlyMax).not.toBeNull();
  });

  it('complete unavailability: totals null, every material item listed', () => {
    const estimate = estimateFootprintCost({
      version: 1,
      region: null,
      workloads: [],
      resources: [unknownServiceResource('a'), unknownServiceResource('b')],
      generatedFrom: { infraVersion: null },
    });
    expect(estimate.monthlyMin).toBeNull();
    expect(estimate.monthlyMax).toBeNull();
    expect(estimate.complete).toBe(false);
    expect(estimate.items).toHaveLength(2);
    expect(estimate.items.every((item) => item.pricingStatus === 'unavailable')).toBe(true);
  });

  it('usage-only footprint: null totals, usage-based items, still complete', () => {
    const estimate = estimateFootprintCost({
      version: 1,
      region: null,
      workloads: [],
      resources: [
        {
          id: 'storage',
          category: 'storage',
          provider: 'aws',
          service: 's3',
          role: 'storage',
          label: 'Storage',
          quantity: 1,
          configuration: {},
          lifecycle: { persistent: true, retainOnDelete: true },
        },
      ],
      generatedFrom: { infraVersion: null },
    });
    expect(estimate.monthlyMin).toBeNull();
    expect(estimate.monthlyMax).toBeNull();
    expect(estimate.complete).toBe(true);
    expect(estimate.items[0]!.pricingStatus).toBe('usage_based');
    expect(estimate.usageDependent.length).toBeGreaterThan(0);
  });

  it('prices only service workloads; migration and scheduled-job tasks are usage based', () => {
    const base = resolveDeploymentFootprint({ manifest: STATELESS, region: 'us-east-1' });
    const web = base.workloads[0]!;
    const oneShot = (id: string, role: string, label: string) => ({ ...web, id, role, label });
    const withTasks = {
      ...base,
      workloads: [web, oneShot('migration', 'migration', 'Database migration'), oneShot('job', 'scheduled-job', 'Scheduled job')],
    };
    const estimate = estimateFootprintCost(withTasks);
    const baseline = estimateFootprintCost(base);
    expect(estimate.monthlyMin).toBe(baseline.monthlyMin);
    expect(estimate.monthlyMax).toBe(baseline.monthlyMax);
    const usageBased = (items: typeof estimate.items) =>
      items.filter((item) => item.pricingStatus === 'usage_based').map((item) => item.resourceId);
    expect(usageBased(estimate.items)).toEqual(['migration', 'job', ...usageBased(baseline.items)]);
    expect(estimate.usageDependent).toContain('One-off tasks such as migrations and scheduled jobs');
  });

  it('queues and schedules are usage based and keep the estimate complete', () => {
    const base = resolveDeploymentFootprint({ manifest: STATELESS, region: 'us-east-1' });
    const resource = (id: string, role: string, service: string) => ({
      id,
      category: 'queue' as const,
      provider: 'aws' as const,
      service,
      role,
      label: id,
      quantity: 1,
      configuration: {},
      lifecycle: { persistent: false, retainOnDelete: false },
    });
    const estimate = estimateFootprintCost({
      ...base,
      resources: [...base.resources, resource('orders-queue', 'queue', 'sqs'), resource('tick-schedule', 'schedule', 'eventbridge-scheduler')],
    });
    const baseline = estimateFootprintCost(base);
    expect(estimate.complete).toBe(baseline.complete);
    expect(estimate.monthlyMin).toBe(baseline.monthlyMin);
    expect(estimate.monthlyMax).toBe(baseline.monthlyMax);
    expect(
      estimate.items.filter((item) => ['orders-queue', 'tick-schedule'].includes(item.resourceId)).map((item) => item.pricingStatus),
    ).toEqual(['usage_based', 'usage_based']);
  });

  it('never throws, whatever the footprint contains', () => {
    expect(() =>
      estimateFootprintCost({
        version: 1,
        region: null,
        workloads: [],
        resources: [],
        generatedFrom: { infraVersion: null },
      }),
    ).not.toThrow();
    expect(() =>
      estimateFootprintCost({ version: 1, region: null, workloads: [], resources: [unknownServiceResource('x')], generatedFrom: { infraVersion: null } }),
    ).not.toThrow();
  });
});
