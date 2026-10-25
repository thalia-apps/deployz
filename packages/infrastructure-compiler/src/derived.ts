import type {
  DeploymentFootprint,
  DeployzIR,
  FootprintResource,
  FootprintWorkload,
  InfrastructureSizeProfile,
  Region,
} from '@deployz/contracts';
import {
  CACHE_ENGINE,
  CAPABILITY_KEYS,
  DATABASE_ENGINE,
  DATABASE_ENGINE_VERSION,
  FOOTPRINT_SCHEMA_VERSION,
  FOOTPRINT_SERVICE_DISPLAY,
  INFRASTRUCTURE_COMPONENT_DISPLAY,
} from '@deployz/contracts';

import type {
  OwnershipRecord,
  ResolvedAwsGraph,
  VerificationCheck,
  VerificationContract,
} from './resolved-graph.js';

// Derived outputs of the compiler — footprint, verification contract, and
// ownership records. All three read the SAME resolved graph, so provisioning
// intent, pricing, verification and ownership can never disagree.

/** The deployment footprint, derived from the resolved IR + size profile. */
export function deriveFootprint(input: {
  ir: DeployzIR;
  region: Region | null;
  profile: InfrastructureSizeProfile;
}): DeploymentFootprint {
  const { ir, region, profile } = input;
  // One managed database per deployment — PostgreSQL or (Phase 4B) MySQL.
  // The engine/engineVersion displayed come from the IR resource's resolved
  // configuration, so footprint and template can never disagree.
  const dbResource = ir.resources.find(
    (r) => r.capabilityKey === CAPABILITY_KEYS.RDS_POSTGRES || r.capabilityKey === CAPABILITY_KEYS.RDS_MYSQL,
  );
  const hasRedis = ir.resources.some((r) => r.capabilityKey === CAPABILITY_KEYS.ELASTICACHE_VALKEY);

  const workloadLabel = (kind: string): string =>
    kind === 'web' ? 'Web application' : kind === 'worker' ? 'Background worker' : kind === 'scheduled-job' ? 'Scheduled job' : kind === 'migration' ? 'Database migration' : kind;

  const workloads: FootprintWorkload[] = ir.workloads.map((w) => ({
    id: w.componentId,
    role: w.kind,
    label: workloadLabel(w.kind),
    quantity: w.desiredCount,
    compute: {
      provider: 'aws',
      service: 'ecs-fargate',
      cpuUnits: profile.workload.cpuUnits,
      memoryMiB: profile.workload.memoryMiB,
      sizeLabel: profile.label,
    },
    lifecycle: { persistent: false },
  }));

  const resources: FootprintResource[] = [];
  if (dbResource !== undefined) {
    const configuration = dbResource.configuration as {
      engine?: unknown;
      engineVersion?: unknown;
      instanceType?: unknown;
      storageGb?: unknown;
      maxStorageGb?: unknown;
    };
    resources.push({
      id: 'database',
      category: 'database',
      provider: 'aws',
      service: dbResource.capabilityKey === CAPABILITY_KEYS.RDS_MYSQL ? 'rds-mysql' : 'rds-postgres',
      role: 'database',
      label: INFRASTRUCTURE_COMPONENT_DISPLAY.database.name,
      quantity: 1,
      configuration: {
        engine: configuration.engine ?? DATABASE_ENGINE,
        engineVersion: configuration.engineVersion ?? DATABASE_ENGINE_VERSION,
        instanceType: profile.database.instanceClass,
        storageGb: profile.database.storageGb,
        maxStorageGb: profile.database.maxStorageGb,
      },
      lifecycle: { persistent: true, retainOnDelete: true },
    });
  }
  if (hasRedis) {
    resources.push({
      id: 'cache',
      category: 'cache',
      provider: 'aws',
      service: 'elasticache-valkey',
      role: 'cache',
      label: INFRASTRUCTURE_COMPONENT_DISPLAY.cache.name,
      quantity: 1,
      configuration: { engine: CACHE_ENGINE, nodeType: profile.cache.nodeType, nodes: profile.cache.nodeCount },
      lifecycle: { persistent: false, retainOnDelete: false },
    });
  }
  resources.push(
    {
      id: 'storage',
      category: 'storage',
      provider: 'aws',
      service: 's3',
      role: 'storage',
      label: INFRASTRUCTURE_COMPONENT_DISPLAY.storage.name,
      quantity: 1,
      configuration: {},
      lifecycle: { persistent: true, retainOnDelete: true },
    },
    {
      id: 'endpoint',
      category: 'network',
      provider: 'aws',
      service: 'alb',
      role: 'endpoint',
      label: INFRASTRUCTURE_COMPONENT_DISPLAY.endpoint.name,
      quantity: 1,
      configuration: {},
      lifecycle: { persistent: false, retainOnDelete: false },
    },
    {
      id: 'nat-gateway',
      category: 'network',
      provider: 'aws',
      service: 'nat-gateway',
      role: 'network',
      label: FOOTPRINT_SERVICE_DISPLAY['nat-gateway']!,
      quantity: 1,
      configuration: {},
      lifecycle: { persistent: false, retainOnDelete: false },
    },
  );

  // Phase 5A/5C — one footprint resource per queue and per schedule. Both are
  // usage-billed (no request/invocation volume is ever invented; see
  // estimateFootprintCost, which marks them unavailable/incomplete via their
  // service key having no baseline pricing adapter).
  for (const q of ir.resources.filter((r) => r.capabilityKey === CAPABILITY_KEYS.SQS)) {
    resources.push({
      id: q.componentId,
      category: 'queue',
      provider: 'aws',
      service: 'sqs',
      role: 'queue',
      label: q.label,
      quantity: q.quantity,
      configuration: q.configuration,
      lifecycle: { persistent: false, retainOnDelete: false },
    });
  }
  for (const s of ir.schedules) {
    resources.push({
      id: s.id,
      category: 'other',
      provider: 'aws',
      service: 'eventbridge-scheduler',
      role: 'schedule',
      label: s.label,
      quantity: 1,
      configuration: {},
      lifecycle: { persistent: false, retainOnDelete: false },
    });
  }

  return {
    version: FOOTPRINT_SCHEMA_VERSION,
    region,
    workloads,
    resources,
    generatedFrom: { infraVersion: 'dynamic-compiler-v2' },
  };
}

/** The compiler-emitted verification contract — component/capability-driven. */
export function deriveVerificationContract(graph: ResolvedAwsGraph): VerificationContract {
  const checks: VerificationCheck[] = graph.resources
    .filter((r) => r.verificationCheck !== undefined)
    .map((r) => ({
      componentId: r.componentId,
      componentKind: r.componentKind,
      capability: r.capability,
      check: r.verificationCheck!,
      primaryResourceType: r.cfnType,
      logicalId: r.logicalId,
    }));
  return { checks };
}

/** Ownership records — installation → … → purge strategy, one per resource. */
export function deriveOwnershipRecords(graph: ResolvedAwsGraph): readonly OwnershipRecord[] {
  return graph.resources.map((r) => ({
    componentId: r.componentId,
    componentKind: r.componentKind,
    capability: r.capability,
    logicalResourceId: r.logicalId,
    physicalResourceId: null,
    stateful: r.stateful,
    retention: r.retention,
    purgeStrategy: r.purgeStrategy,
    conditional: r.conditional ?? false,
  }));
}
