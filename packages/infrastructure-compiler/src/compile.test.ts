import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  CAPABILITY_KEYS,
  LARGE_PROFILE,
  MEDIUM_PROFILE,
  SMALL_PROFILE,
  SMALL_V2_PROFILE,
  TASK_FAMILY_SUFFIX_PARAMETER,
  deployzTaskFamily,
  estimateFootprintCost,
} from '@deployz/contracts';
import type { DeployzIR, InfrastructureSizeProfile, IrBinding, IrResource, IrSchedule, IrWorkload } from '@deployz/contracts';

import { compileDeployzInfrastructure, logicalResourceId } from './index.js';

// dynamic-compiler-v2 — capability-compositional, determinism, stable identity
// and stateful safety. The compiler composes the current capabilities from
// DeployzIR into a resolved AWS graph with stable semantic logical ids.

const here = dirname(fileURLToPath(import.meta.url));

// The full postgres template (web + RDS PostgreSQL + Valkey + S3 + ALB),
// pinned byte-for-byte. Phase 4B's MySQL capability must not move a single
// postgres byte — this hash is the proof (see the mysql describe below).
// Moved deliberately since: database AZ placement (DbAz parameters) and
// installation-scoped task families (the Family join and
// `paramTaskFamilySuffix`) and the 300 s web health-check grace, and the
// small-v2 profile (db.t3.micro + gp3), and the IAM role boundary
// (`paramRoleBoundaryArn`), each changed every template.
const POSTGRES_TEMPLATE_HASH_GOLDEN = '880d46f9c816576bb8aa979035561682b930c93d4e92a1dcf128baa773141277';

/** Evaluates the compiled `Family` join for one stack's suffix parameter value. */
function familyFor(family: unknown, suffix: string): string {
  const [separator, parts] = (family as { 'Fn::Join': [string, unknown[]] })['Fn::Join'];
  return parts
    .map((part) => (typeof part === 'string' ? part : (part as { Ref: string }).Ref === TASK_FAMILY_SUFFIX_PARAMETER ? suffix : '?'))
    .join(separator);
}

// ── IR fixtures ──────────────────────────────────────────────────────────────

function makeIr(opts: { postgres: boolean; redis: boolean; workers?: { componentId: string; command: string }[]; dbEngine?: 'postgres' | 'mysql' }): DeployzIR {
  const dbCapability = opts.dbEngine === 'mysql' ? CAPABILITY_KEYS.RDS_MYSQL : CAPABILITY_KEYS.RDS_POSTGRES;
  const dbConfiguration =
    opts.dbEngine === 'mysql'
      ? { engine: 'mysql', engineVersion: '8.0' }
      : opts.postgres
        ? { engine: 'postgres', engineVersion: '16' }
        : {};
  const resources: DeployzIR['resources'] = [];
  if (opts.postgres) {
    resources.push({
      componentId: 'primary-db',
      capabilityKey: dbCapability,
      label: opts.dbEngine === 'mysql' ? 'MySQL database' : 'PostgreSQL database',
      quantity: 1,
      configuration: dbConfiguration,
      lifecycle: 'retain',
      scope: 'REGIONAL',
      envBindings: [],
    });
  }
  if (opts.redis) {
    resources.push({
      componentId: 'cache',
      capabilityKey: CAPABILITY_KEYS.ELASTICACHE_VALKEY,
      label: 'Valkey cache',
      quantity: 1,
      configuration: {},
      lifecycle: 'delete',
      scope: 'REGIONAL',
      envBindings: [],
    });
  }
  resources.push(
    {
      componentId: 'storage',
      capabilityKey: CAPABILITY_KEYS.S3,
      label: 'S3 bucket',
      quantity: 1,
      configuration: {},
      lifecycle: 'retain',
      scope: 'REGIONAL',
      envBindings: [],
    },
    {
      componentId: 'endpoint',
      capabilityKey: CAPABILITY_KEYS.ALB,
      label: 'Application load balancer',
      quantity: 1,
      configuration: {},
      lifecycle: 'delete',
      scope: 'REGIONAL',
      envBindings: [],
    },
  );

  return {
    schemaVersion: 1,
    workloads: [
      {
        componentId: 'web',
        kind: 'web',
        label: 'Web service',
        buildArtifactId: 'app',
        command: null,
        port: 3000,
        public: true,
        healthCheck: { path: '/health', mode: 'explicit' },
        desiredCount: 1,
        compute: {
          provider: 'aws',
          capabilityKey: CAPABILITY_KEYS.ECS_FARGATE_SERVICE,
          cpuUnits: 256,
          memoryMiB: 512,
          sizeLabel: 'Small',
          architecture: null,
        },
        dependencyCapabilityKeys: [
          ...(opts.postgres ? [dbCapability] : []),
          ...(opts.redis ? [CAPABILITY_KEYS.ELASTICACHE_VALKEY] : []),
          CAPABILITY_KEYS.S3,
        ],
      },
      ...(opts.workers ?? []).map((worker) => ({
        componentId: worker.componentId,
        kind: 'worker' as const,
        label: `Worker ${worker.componentId}`,
        buildArtifactId: 'app',
        command: worker.command,
        port: null,
        public: false,
        healthCheck: null,
        desiredCount: 1,
        compute: {
          provider: 'aws' as const,
          capabilityKey: CAPABILITY_KEYS.ECS_FARGATE_SERVICE,
          cpuUnits: 256,
          memoryMiB: 512,
          sizeLabel: 'Small',
          architecture: null,
        },
        dependencyCapabilityKeys: [
          ...(opts.postgres ? [dbCapability] : []),
          ...(opts.redis ? [CAPABILITY_KEYS.ELASTICACHE_VALKEY] : []),
          CAPABILITY_KEYS.S3,
        ],
      })),
    ],
    resources,
    bindings: [],
    ingress: { public: true, capabilityKey: CAPABILITY_KEYS.ALB, targetWorkloadIds: ['web'] },
    schedules: [],
    policies: { allowTopologyChanges: false, defaultRetention: 'retain' },
    metadata: {
      graphSchemaVersion: 1,
      capabilityRegistryVersion: 'phase1-2026-09-25',
      sizeProfileId: 'small-v1',
      region: null,
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('determinism', () => {
  it('equivalent IR compiles to the same template hash twice', () => {
    const a = compileDeployzInfrastructure({ ir: makeIr({ postgres: true, redis: true }), region: null });
    const b = compileDeployzInfrastructure({ ir: makeIr({ postgres: true, redis: true }), region: null });
    expect(a.artifact.templateHash).toBe(b.artifact.templateHash);
    expect(a.artifact.irHash).toBe(b.artifact.irHash);
  });

  it('different topology compiles to a different template hash', () => {
    const stateless = compileDeployzInfrastructure({ ir: makeIr({ postgres: false, redis: false }), region: null });
    const postgres = compileDeployzInfrastructure({ ir: makeIr({ postgres: true, redis: false }), region: null });
    expect(stateless.artifact.templateHash).not.toBe(postgres.artifact.templateHash);
  });
});

describe('stable logical identity', () => {
  it('emits semantic ids, not CDK hashes', () => {
    const { resolvedGraph } = compileDeployzInfrastructure({ ir: makeIr({ postgres: true, redis: true }), region: null });
    const ids = resolvedGraph.resources.map((r) => r.logicalId);
    expect(ids).toContain('PrimaryDbInstance');
    expect(ids).toContain('PrimaryDbMasterSecret');
    expect(ids).toContain('StorageBucket');
    expect(ids).toContain('WebService');
    expect(ids).toContain('EndpointLoadBalancer');
    expect(ids).toContain('CacheReplicationGroup');
    // No CDK auto-hashed ids.
    expect(ids.filter((id) => /[A-F0-9]{8}$/.test(id))).toEqual([]);
  });

  it('every resource maps to a component and capability (ownership)', () => {
    const { ownershipRecords } = compileDeployzInfrastructure({ ir: makeIr({ postgres: true, redis: true }), region: null });
    expect(ownershipRecords.length).toBeGreaterThan(0);
    for (const record of ownershipRecords) {
      expect(record.componentId).toBeTruthy();
      expect(record.capability).toBeTruthy();
      expect(record.logicalResourceId).toBeTruthy();
    }
  });
});

describe('host-checked health check', () => {
  const targetGroup = (ir: DeployzIR) =>
    compileDeployzInfrastructure({ ir, region: null }).resolvedGraph.resources.find((r) => r.logicalId === logicalResourceId('endpoint', 'target-group'))!;

  it('accepts 400 only for a workload that checks the Host header', () => {
    const plain = makeIr({ postgres: false, redis: false });
    expect(targetGroup(plain).properties).not.toHaveProperty('Matcher');

    const checked = makeIr({ postgres: false, redis: false });
    checked.workloads[0] = { ...checked.workloads[0]!, healthCheck: { path: '/health', mode: 'explicit', hostChecked: true } };
    expect(targetGroup(checked).properties['Matcher']).toEqual({ HttpCode: '200,400' });
  });
});

describe('stateful safety', () => {
  it('retains the database, its secrets and the bucket; deletes the app secret', () => {
    const { resolvedGraph } = compileDeployzInfrastructure({ ir: makeIr({ postgres: true, redis: false }), region: null });
    const byId = new Map(resolvedGraph.resources.map((r) => [r.logicalId, r]));

    for (const id of ['PrimaryDbInstance', 'PrimaryDbMasterSecret', 'PrimaryDbUrlSecret', 'PrimaryDbSubnetGroup', 'StorageBucket']) {
      const resource = byId.get(id);
      expect(resource, id).toBeDefined();
      expect(resource!.deletionPolicy, id).toBe('Retain');
      expect(resource!.updateReplacePolicy, id).toBe('Retain');
      expect(resource!.stateful, id).toBe(true);
    }

    const appSecret = byId.get('ApplicationConfigSecret');
    expect(appSecret).toBeDefined();
    expect(appSecret!.deletionPolicy).toBe('Delete');
  });

  it('the valkey cache is stateless (deleted on stack delete)', () => {
    const { resolvedGraph } = compileDeployzInfrastructure({ ir: makeIr({ postgres: false, redis: true }), region: null });
    const cache = resolvedGraph.resources.find((r) => r.logicalId === 'CacheReplicationGroup');
    expect(cache).toBeDefined();
    expect(cache!.stateful).toBe(false);
    expect(cache!.deletionPolicy).toBe('Delete');
  });
});

describe('capability composition', () => {
  it('adding RDS adds only the expected resources, verification entry and output', () => {
    const stateless = compileDeployzInfrastructure({ ir: makeIr({ postgres: false, redis: false }), region: null });
    const withDb = compileDeployzInfrastructure({ ir: makeIr({ postgres: true, redis: false }), region: null });

    const statelessIds = new Set(stateless.resolvedGraph.resources.map((r) => r.logicalId));
    const withDbIds = new Set(withDb.resolvedGraph.resources.map((r) => r.logicalId));

    // Only RDS-related resources are added.
    const addedIds = [...withDbIds].filter((id) => !statelessIds.has(id));
    expect(addedIds.length).toBeGreaterThan(0);
    for (const id of addedIds) {
      const resource = withDb.resolvedGraph.resources.find((r) => r.logicalId === id)!;
      expect(resource.capability).toBe(CAPABILITY_KEYS.RDS_POSTGRES);
      expect(resource.componentId).toBe('primary-db');
    }

    // Verification contract gains exactly 'database'.
    const statelessChecks = new Set(stateless.verificationContract.checks.map((c) => c.check));
    const withDbChecks = withDb.verificationContract.checks.map((c) => c.check).sort();
    expect(withDbChecks).toEqual([...statelessChecks, 'database'].sort());

    // Outputs gain DbHost and DbSecretArn only.
    const statelessOutputs = new Set(stateless.template['Outputs'] ? Object.keys(stateless.template['Outputs'] as Record<string, unknown>) : []);
    const withDbOutputs = Object.keys(withDb.template['Outputs'] as Record<string, unknown>);
    const addedOutputs = withDbOutputs.filter((o) => !statelessOutputs.has(o)).sort();
    expect(addedOutputs).toEqual(['DbHost', 'DbSecretArn']);
  });

  it('adding Redis adds only the expected resources and verification entry', () => {
    const stateless = compileDeployzInfrastructure({ ir: makeIr({ postgres: false, redis: false }), region: null });
    const withRedis = compileDeployzInfrastructure({ ir: makeIr({ postgres: false, redis: true }), region: null });

    const statelessIds = new Set(stateless.resolvedGraph.resources.map((r) => r.logicalId));
    const addedIds = withRedis.resolvedGraph.resources
      .filter((r) => !statelessIds.has(r.logicalId))
      .map((r) => r.logicalId);
    expect(addedIds.length).toBeGreaterThan(0);
    for (const id of addedIds) {
      const resource = withRedis.resolvedGraph.resources.find((r) => r.logicalId === id)!;
      expect(resource.capability).toBe(CAPABILITY_KEYS.ELASTICACHE_VALKEY);
      expect(resource.componentId).toBe('cache');
    }

    const statelessChecks = new Set(stateless.verificationContract.checks.map((c) => c.check));
    const withRedisChecks = withRedis.verificationContract.checks.map((c) => c.check).sort();
    expect(withRedisChecks).toEqual([...statelessChecks, 'cache'].sort());
  });

  it('removing a capability removes its resources', () => {
    const withDb = compileDeployzInfrastructure({ ir: makeIr({ postgres: true, redis: true }), region: null });
    const withoutDb = compileDeployzInfrastructure({ ir: makeIr({ postgres: false, redis: true }), region: null });

    const withDbIds = new Set(withDb.resolvedGraph.resources.map((r) => r.logicalId));
    const withoutDbIds = new Set(withoutDb.resolvedGraph.resources.map((r) => r.logicalId));

    const removedIds = [...withDbIds].filter((id) => !withoutDbIds.has(id));
    expect(removedIds.length).toBeGreaterThan(0);
    for (const id of removedIds) {
      const resource = withDb.resolvedGraph.resources.find((r) => r.logicalId === id)!;
      expect(resource.capability).toBe(CAPABILITY_KEYS.RDS_POSTGRES);
    }

    // No Redis resources were removed.
    const redisIds = new Set(
      withDb.resolvedGraph.resources.filter((r) => r.capability === CAPABILITY_KEYS.ELASTICACHE_VALKEY).map((r) => r.logicalId),
    );
    for (const id of redisIds) {
      expect(withoutDbIds.has(id), `Redis resource ${id} should survive RDS removal`).toBe(true);
    }
  });

  it('unrelated component logical identities remain stable when capabilities change', () => {
    const stateless = compileDeployzInfrastructure({ ir: makeIr({ postgres: false, redis: false }), region: null });
    const full = compileDeployzInfrastructure({ ir: makeIr({ postgres: true, redis: true }), region: null });

    const networkIds = stateless.resolvedGraph.resources
      .filter((r) => r.componentId === 'network')
      .map((r) => r.logicalId)
      .sort();
    const fullNetworkIds = full.resolvedGraph.resources
      .filter((r) => r.componentId === 'network')
      .map((r) => r.logicalId)
      .sort();
    expect(fullNetworkIds).toEqual(networkIds);

    const webIds = stateless.resolvedGraph.resources
      .filter((r) => r.componentId === 'web')
      .map((r) => r.logicalId)
      .sort();
    const fullWebIds = full.resolvedGraph.resources
      .filter((r) => r.componentId === 'web')
      .map((r) => r.logicalId)
      .sort();
    expect(fullWebIds).toEqual(webIds);

    const endpointIds = stateless.resolvedGraph.resources
      .filter((r) => r.componentId === 'endpoint')
      .map((r) => r.logicalId)
      .sort();
    const fullEndpointIds = full.resolvedGraph.resources
      .filter((r) => r.componentId === 'endpoint')
      .map((r) => r.logicalId)
      .sort();
    expect(fullEndpointIds).toEqual(endpointIds);
  });

  it('IR resource ordering does not affect template hash', () => {
    const irA = makeIr({ postgres: true, redis: true });
    const irB: DeployzIR = { ...irA, resources: [...irA.resources].reverse() };
    const a = compileDeployzInfrastructure({ ir: irA, region: null });
    const b = compileDeployzInfrastructure({ ir: irB, region: null });
    expect(a.artifact.templateHash).toBe(b.artifact.templateHash);
  });

  it('every managed resource maps to componentId + capability + resourceRole', () => {
    const { resolvedGraph } = compileDeployzInfrastructure({ ir: makeIr({ postgres: true, redis: true }), region: null });
    for (const r of resolvedGraph.resources) {
      expect(r.componentId).toBeTruthy();
      expect(r.capability).toBeTruthy();
      expect(r.resourceRole).toBeTruthy();
    }
  });

  it('sizing changes affect only relevant resources (database sizing changes only RDS resources)', () => {
    const defaultProfile = compileDeployzInfrastructure({ ir: makeIr({ postgres: true, redis: true }), region: null });

    const biggerDbProfile = compileDeployzInfrastructure({
      ir: makeIr({ postgres: true, redis: true }),
      region: null,
      sizeProfile: {
        label: 'medium-test',
        workload: { cpuUnits: 256, memoryMiB: 512 },
        database: { instanceClass: 'db.r6g.xlarge', storageGb: 100, maxStorageGb: 500 },
        cache: { nodeType: 'cache.t4g.micro', nodeCount: 1 },
      },
    });

    // Network, endpoint, cache, and web resources are unchanged.
    const unchangedComponents = ['network', 'endpoint', 'cache', 'web'];
    for (const componentId of unchangedComponents) {
      const defaultResources = defaultProfile.resolvedGraph.resources
        .filter((r) => r.componentId === componentId)
        .map((r) => JSON.stringify(r.properties))
        .sort();
      const biggerResources = biggerDbProfile.resolvedGraph.resources
        .filter((r) => r.componentId === componentId)
        .map((r) => JSON.stringify(r.properties))
        .sort();
      expect(biggerResources, `component ${componentId} should be unaffected by db sizing`).toEqual(defaultResources);
    }

    // RDS instance properties differ.
    const defaultDbInstance = defaultProfile.resolvedGraph.resources.find((r) => r.logicalId === 'PrimaryDbInstance');
    const biggerDbInstance = biggerDbProfile.resolvedGraph.resources.find((r) => r.logicalId === 'PrimaryDbInstance');
    expect(defaultDbInstance!.properties).not.toEqual(biggerDbInstance!.properties);
  });

  it('no static topology-selection logic (compiler branches on capability presence, not on {postgres,redis} tuple)', () => {
    const source = readFileSync(join(here, 'compile.ts'), 'utf8');
    // No combined tuple branching: the compiler must not branch on the
    // combination of postgres+redis as a single decision. Each capability is
    // resolved independently via resourceByCapability and tested with
    // `!== undefined`.
    expect(source).not.toMatch(/hasDb\s*&&\s*hasRedis/);
    expect(source).not.toMatch(/postgres\s*&&\s*redis/);
    expect(source).not.toMatch(/hasPostgres\s*&&\s*hasRedis/);
    // Confirm independent capability lookup pattern.
    expect(source).toMatch(/resourceByCapability\(ir,\s*CAPABILITY_KEYS\.RDS_POSTGRES\)/);
    expect(source).toMatch(/resourceByCapability\(ir,\s*CAPABILITY_KEYS\.ELASTICACHE_VALKEY\)/);
  });
});

describe('architecture fitness', () => {
  it('the compiler never imports an AWS SDK (no synth-time AWS discovery)', () => {
    for (const file of ['compile.ts', 'cfn-emit.ts', 'derived.ts', 'index.ts', 'schedule-expression.ts']) {
      const source = readFileSync(join(here, file), 'utf8');
      expect(source, file).not.toMatch(/@aws-sdk|aws-sdk/);
      expect(source, file).not.toMatch(/new Date\(|Date\.now\(|Math\.random\(|crypto\.random/);
    }
  });

  it('the verification contract is component/capability-driven (compute/ingress/database/storage/cache)', () => {
    const { verificationContract } = compileDeployzInfrastructure({ ir: makeIr({ postgres: true, redis: true }), region: null });
    const checks = verificationContract.checks.map((c) => c.check).sort();
    expect(checks).toEqual(['cache', 'compute', 'database', 'ingress', 'storage']);
  });

  it('footprint derives from the same frozen intent (pricing categories match capabilities)', () => {
    const { footprint } = compileDeployzInfrastructure({ ir: makeIr({ postgres: true, redis: true }), region: null });
    const services = footprint.resources.map((r) => r.service).sort();
    expect(services).toEqual(['alb', 'elasticache-valkey', 'nat-gateway', 'rds-postgres', 's3']);
  });
});

// ── Multi-workload (Phase 4A): one build artifact, one ECS service per
//    persistent workload (web + workers), each with its own frozen command. ──

describe('multi-workload', () => {
  const ir = makeIr({
    postgres: true,
    redis: true,
    workers: [
      { componentId: 'email-worker', command: 'node dist/workers/email.js' },
      { componentId: 'import-worker', command: 'node dist/workers/import.js' },
    ],
  });
  const compiled = compileDeployzInfrastructure({ ir, region: null });
  const byId = new Map(compiled.resolvedGraph.resources.map((r) => [r.logicalId, r]));

  it('compiles one ECS service, task definition, log group and security group per workload with stable ids', () => {
    for (const componentId of ['web', 'email-worker', 'import-worker']) {
      for (const role of ['service', 'task-definition', 'log-group', 'service-security-group']) {
        const id = logicalResourceId(componentId, role);
        expect(byId.has(id), id).toBe(true);
      }
    }
    // Worker ids are deterministic from componentId + role.
    expect(logicalResourceId('email-worker', 'service')).toBe('EmailWorkerService');
    expect(logicalResourceId('import-worker', 'task-definition')).toBe('ImportWorkerTaskDefinition');
  });

  it('freezes each worker command into its own App container', () => {
    for (const { componentId, command } of [
      { componentId: 'email-worker', command: 'node dist/workers/email.js' },
      { componentId: 'import-worker', command: 'node dist/workers/import.js' },
    ]) {
      const taskDef = byId.get(logicalResourceId(componentId, 'task-definition'))!;
      const app = (taskDef.properties['ContainerDefinitions'] as unknown[])[0] as Record<string, unknown>;
      expect(app['Command']).toEqual(['sh', '-c', command]);
      expect(app).not.toHaveProperty('EntryPoint');
    }
  });

  it('workers get no port mapping, no ALB target and no HTTP health check', () => {
    for (const componentId of ['email-worker', 'import-worker']) {
      const taskDef = byId.get(logicalResourceId(componentId, 'task-definition'))!;
      const app = (taskDef.properties['ContainerDefinitions'] as unknown[])[0] as Record<string, unknown>;
      expect(app).not.toHaveProperty('PortMappings');

      const service = byId.get(logicalResourceId(componentId, 'service'))!;
      expect(service.properties).not.toHaveProperty('LoadBalancers');
      expect(service.properties).not.toHaveProperty('HealthCheckGracePeriodSeconds');
      expect(service.properties['DesiredCount']).toEqual({ Ref: 'paramDesiredCount' });
      // Workers still run on the shared cluster and behind the shared roles.
      expect(service.properties['Cluster']).toEqual({ Ref: logicalResourceId('web', 'cluster') });
      expect(service.dependsOn).not.toContain('EndpointTargetGroup');
    }

    // The ALB wires only the public web workload (the ingress rule attaches
    // to the service SG; the ALB SG is the traffic source).
    const ingress = byId.get('EndpointLoadBalancerToServiceIngress')!;
    expect(ingress.properties['GroupId']).toEqual({
      'Fn::GetAtt': [logicalResourceId('web', 'service-security-group'), 'GroupId'],
    });
    expect(ingress.properties['SourceSecurityGroupId']).toEqual({
      'Fn::GetAtt': [logicalResourceId('endpoint', 'load-balancer-security-group'), 'GroupId'],
    });
  });

  it('the database accepts ingress from every workload service', () => {
    const ingressIds = compiled.resolvedGraph.resources
      .filter((r) => r.componentId === 'primary-db' && r.resourceRole.startsWith('app-service-ingress-'))
      .map((r) => r.resourceRole)
      .sort();
    expect(ingressIds).toEqual([
      'app-service-ingress-email-worker',
      'app-service-ingress-import-worker',
      'app-service-ingress-web',
    ]);
  });

  it('gains one compute verification check per workload; capability checks stay single', () => {
    const checks = compiled.verificationContract.checks;
    const computeComponents = checks.filter((c) => c.check === 'compute').map((c) => c.componentId).sort();
    expect(computeComponents).toEqual(['email-worker', 'import-worker', 'web']);
    expect(checks.filter((c) => c.check === 'database')).toHaveLength(1);
    expect(checks.filter((c) => c.check === 'cache')).toHaveLength(1);
    expect(checks.filter((c) => c.check === 'ingress')).toHaveLength(1);
    expect(checks.filter((c) => c.check === 'storage')).toHaveLength(1);
  });

  it('compiles the migration workload as a one-shot task definition, never a service (Phase 4C)', () => {
    const withMigration: DeployzIR = {
      ...ir,
      workloads: [
        ...ir.workloads,
        {
          componentId: 'migration',
          kind: 'migration',
          label: 'Database migration',
          buildArtifactId: 'app',
          command: 'npx prisma migrate deploy',
          port: null,
          public: false,
          healthCheck: null,
          desiredCount: 1,
          compute: ir.workloads[0]!.compute,
          dependencyCapabilityKeys: [CAPABILITY_KEYS.RDS_POSTGRES],
        },
      ],
    };
    const result = compileDeployzInfrastructure({ ir: withMigration, region: null });
    const ids = result.resolvedGraph.resources.map((r) => r.logicalId);
    // A task definition and a log group exist; a SERVICE never does — a
    // migration is one-shot, proven by its exit code, not by stability.
    expect(ids).toContain('MigrationTaskDefinition');
    expect(ids).toContain('MigrationLogGroup');
    expect(ids).not.toContain('MigrationService');
    expect(ids).not.toContain('MigrationEcsService');
    const byId = new Map(result.resolvedGraph.resources.map((r) => [r.logicalId, r]));
    const taskDef = byId.get('MigrationTaskDefinition')!;
    expect(taskDef.cfnType).toBe('AWS::ECS::TaskDefinition');
    // NO verification check — the verification contract proves services, not
    // one-shot tasks, and relay service discovery must never see a migration.
    expect(taskDef.verificationCheck).toBeUndefined();
    const family = taskDef.properties['Family'];
    expect(familyFor(family, 'a1b2')).toBe(deployzTaskFamily('migration', 'a1b2'));
    // The analyzed command is FROZEN into the container — the relay runs the
    // definition as-is and can never inject a command of its own.
    const app = (taskDef.properties['ContainerDefinitions'] as unknown[])[0] as Record<string, unknown>;
    // A one-shot command replaces the image ENTRYPOINT.
    expect(app['EntryPoint']).toEqual(['sh', '-c']);
    expect(app['Command']).toEqual(['npx prisma migrate deploy']);
    expect(taskDef.properties['ExecutionRoleArn']).toEqual({
      'Fn::GetAtt': [logicalResourceId('web', 'task-execution-role'), 'Arn'],
    });
    // Phase 5: every workload other than web gets its OWN task role — a
    // migration never shares the web workload's queue permissions.
    expect(taskDef.properties['TaskRoleArn']).toEqual({
      'Fn::GetAtt': [logicalResourceId('migration', 'task-role'), 'Arn'],
    });
    expect(ids).toContain('MigrationTaskRole');
    expect(ids).toContain('MigrationTaskRolePolicy');
    // Stateless lifecycle — a task definition update is never destructive.
    expect(taskDef.stateful).toBe(false);
    expect(taskDef.deletionPolicy).toBe('Delete');
    // The verification contract gains NO migration compute check; the
    // ownership records DO carry the task def (it is a managed resource).
    const computeComponents = result.verificationContract.checks.filter((c) => c.check === 'compute').map((c) => c.componentId).sort();
    expect(computeComponents).toEqual(['email-worker', 'import-worker', 'web']);
    expect(result.resolvedGraph.resources.some((r) => r.logicalId === 'MigrationTaskDefinition' && r.verificationCheck !== undefined)).toBe(false);
    // Ownership: exactly one migration record (the task def; the log group is
    // its own component-scoped record).
    expect(result.ownershipRecords.filter((r) => r.componentId === 'migration' && r.logicalResourceId === 'MigrationTaskDefinition')).toHaveLength(1);
    // Other workloads are unaffected.
    expect(ids).toContain('EmailWorkerService');
    // Deterministic: the same IR compiles the same template.
    expect(compileDeployzInfrastructure({ ir: withMigration, region: null }).artifact.templateHash).toBe(result.artifact.templateHash);
  });

  it('a graph WITHOUT a migration workload compiles byte-identically to the pre-4C compiler (golden)', () => {
    const result = compileDeployzInfrastructure({ ir, region: null });
    const ids = result.resolvedGraph.resources.map((r) => r.logicalId);
    expect(ids).not.toContain('MigrationTaskDefinition');
    expect(ids).not.toContain('MigrationEcsService');
    expect(ids).toContain('EmailWorkerService');
  });

  it('compiles deterministically and never collides on logical ids', () => {
    const again = compileDeployzInfrastructure({ ir, region: null });
    expect(again.artifact.templateHash).toBe(compiled.artifact.templateHash);

    const ids = compiled.resolvedGraph.resources.map((r) => r.logicalId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps single-workload logical ids byte-identical with the pre-4A compiler', () => {
    const single = compileDeployzInfrastructure({ ir: makeIr({ postgres: true, redis: true }), region: null });
    const ids = single.resolvedGraph.resources.map((r) => r.logicalId);
    for (const id of ['WebService', 'WebTaskDefinition', 'WebLogGroup', 'WebCluster', 'WebTaskExecutionRole', 'PrimaryDbAppServiceIngressWeb']) {
      expect(ids, id).toContain(id);
    }
  });
});

// ── Phase 4B: RDS MySQL — the SAME relational-database abstraction with a
//    Deployz-pinned engine. Postgres output stays byte-identical. ────────────

describe('mysql database (phase 4b)', () => {
  const mysqlIr = makeIr({ postgres: true, redis: true, dbEngine: 'mysql' });
  const compiled = compileDeployzInfrastructure({ ir: mysqlIr, region: null });
  const byId = new Map(compiled.resolvedGraph.resources.map((r) => [r.logicalId, r]));

  it('the managed database is RDS MySQL on the same stable logical ids', () => {
    const instance = byId.get('PrimaryDbInstance')!;
    expect(instance).toBeDefined();
    expect(instance.cfnType).toBe('AWS::RDS::DBInstance');
    expect(instance.capability).toBe(CAPABILITY_KEYS.RDS_MYSQL);
    expect(instance.stateful).toBe(true);
    expect(instance.deletionPolicy).toBe('Retain');
    expect(instance.purgeStrategy).toBe('require_manual');
    expect(instance.verificationCheck).toBe('database');
    // Deployz-pinned engine policy: version and encryption/backup/deletion
    // protection are identical in shape to the PostgreSQL instance.
    expect(instance.properties['Engine']).toBe('mysql');
    expect(instance.properties['EngineVersion']).toBe('8.0');
    expect(instance.properties['StorageEncrypted']).toBe(true);
    expect(instance.properties['BackupRetentionPeriod']).toBe(7);
    expect(instance.properties['DeletionProtection']).toBe(true);
    expect(instance.properties['PubliclyAccessible']).toBe(false);
  });

  it('managed credentials and the mysql:// URL secret follow the PostgreSQL pattern', () => {
    const masterSecret = byId.get('PrimaryDbMasterSecret')!;
    expect(masterSecret.cfnType).toBe('AWS::SecretsManager::Secret');
    const urlSecret = byId.get('PrimaryDbUrlSecret')!;
    expect(String((urlSecret.properties['SecretString'] as Record<string, unknown>)['Fn::Join']![0])).toBe('');
    const parts = (urlSecret.properties['SecretString'] as Record<string, unknown>)['Fn::Join']![1] as unknown[];
    expect(parts[0]).toContain('mysql://deployz_app:');
    expect(JSON.stringify(parts)).toContain(':3306/deployz');
    // Private networking: app-SG ingress on the mysql port, per workload.
    const ingress = byId.get('PrimaryDbAppServiceIngressWeb')!;
    expect(ingress.properties['FromPort']).toBe(3306);
    expect(ingress.properties['ToPort']).toBe(3306);
    // No parameter group resource exists.
    expect(compiled.resolvedGraph.resources.some((r) => r.cfnType.includes('DBParameterGroup'))).toBe(false);
  });

  it('the URL secret uses the driver scheme the analysis resolved', () => {
    const pymysqlIr: DeployzIR = {
      ...mysqlIr,
      resources: mysqlIr.resources.map((r) =>
        r.componentId === 'primary-db' ? { ...r, configuration: { ...r.configuration, urlScheme: 'mysql+pymysql' } } : r,
      ),
    };
    const urlSecret = compileDeployzInfrastructure({ ir: pymysqlIr, region: null }).resolvedGraph.resources.find((r) => r.logicalId === 'PrimaryDbUrlSecret')!;
    const parts = (urlSecret.properties['SecretString'] as Record<string, unknown>)['Fn::Join']![1] as unknown[];
    expect(parts[0]).toContain('mysql+pymysql://deployz_app:');
  });

  it('app containers get the mysql env aliases and the RDS CA bundle', () => {
    const taskDef = byId.get('WebTaskDefinition')!;
    const app = (taskDef.properties['ContainerDefinitions'] as unknown[])[0] as {
      Environment: Array<{ Name: string; Value?: unknown }>;
      Secrets: Array<{ Name: string }>;
    };
    const envNames = app.Environment.map((entry) => entry.Name);
    // Generic DATABASE_* names always lead (URL parts as env, the URL as a
    // secret) and carry the ENGINE's port, never PostgreSQL's.
    expect(envNames).toContain('DATABASE_HOST');
    expect(app.Environment.find((entry) => entry.Name === 'DATABASE_PORT')?.Value).toBe('3306');
    expect(app.Environment.find((entry) => entry.Name === 'MYSQL_PORT')?.Value).toBe('3306');
    expect(app.Secrets.map((entry) => entry.Name)).toContain('DATABASE_URL');
    // MySQL aliases + the CA bundle under both the neutral and mysql names.
    expect(envNames).toContain('MYSQL_HOST');
    expect(envNames).toContain('MYSQL_PORT');
    expect(envNames).toContain('MYSQL_SSL_CA');
    // Laravel's name: its schema load passes it to the mysql client as --ssl-ca.
    expect(envNames).toContain('MYSQL_ATTR_SSL_CA');
    expect(envNames).toContain('NODE_EXTRA_CA_CERTS');
    expect(app.Secrets.map((entry) => entry.Name)).toContain('MYSQL_URL');
    // Every service (workers included) binds the database — Phase 4A envs
    // are per-workload, so a worker task def carries the same mysql envs.
    const workerDef = byId.get('EmailWorkerTaskDefinition');
    if (workerDef !== undefined) {
      const workerApp = (workerDef.properties['ContainerDefinitions'] as unknown[])[0] as {
        Environment: Array<{ Name: string }>;
      };
      expect(workerApp.Environment.map((e) => e.Name)).toContain('MYSQL_SSL_CA');
    }
  });

  it('verification, footprint and outputs treat mysql exactly like postgres', () => {
    expect(compiled.verificationContract.checks.some((c) => c.check === 'database' && c.logicalId === 'PrimaryDbInstance')).toBe(true);
    const db = compiled.footprint.resources.find((r) => r.id === 'database')!;
    expect(db.service).toBe('rds-mysql');
    expect(db.configuration).toMatchObject({ engine: 'mysql', engineVersion: '8.0' });
    const outputs = compiled.template['Outputs'] as Record<string, unknown>;
    expect(Object.keys(outputs)).toContain('DbHost');
    // The cache and ALB capabilities are untouched by the engine swap.
    expect(byId.has('CacheReplicationGroup')).toBe(true);
    expect(byId.has('EndpointLoadBalancer')).toBe(true);
  });

  it('POSTGRES OUTPUT IS UNAFFECTED — byte-identical template hash (golden)', () => {
    // Same fixture IR the pre-4B compiler produced; the hash pins every
    // postgres template byte against the mysql addition.
    const postgres = compileDeployzInfrastructure({ ir: makeIr({ postgres: true, redis: true }), region: null });
    expect(postgres.artifact.templateHash).toBe(POSTGRES_TEMPLATE_HASH_GOLDEN);
    // And the postgres capability never appears in the mysql graph.
    expect(compiled.resolvedGraph.resources.some((r) => r.capability === CAPABILITY_KEYS.RDS_POSTGRES)).toBe(false);
  });
});

// ── Phase 5 — Async & Scheduled Workloads: queues, per-workload IAM, and ────
//    EventBridge Scheduler. ──────────────────────────────────────────────────

function queueResource(componentId: string, opts: { retention: number; visibility: number }): IrResource {
  return {
    componentId,
    capabilityKey: CAPABILITY_KEYS.SQS,
    label: `Queue ${componentId}`,
    quantity: 1,
    configuration: { queueType: 'standard', messageRetentionSeconds: opts.retention, visibilityTimeoutSeconds: opts.visibility },
    lifecycle: 'delete',
    scope: 'REGIONAL',
    envBindings: [],
  };
}

function irBinding(overrides: Partial<IrBinding> & Pick<IrBinding, 'id' | 'sourceId' | 'targetId'>): IrBinding {
  return { envBindings: [], iamActions: [], ...overrides };
}

const CONSUME_ACTIONS = ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:ChangeMessageVisibility', 'sqs:GetQueueAttributes'];

/**
 * The Phase 5 target topology: web producer -> orders-queue (+ dlq,
 * maxReceiveCount 5) -> worker consumer; worker/web/cleanup bound to MySQL +
 * S3; cleanup scheduled job with its own schedule + schedule DLQ.
 */
function makePhase5Ir(): DeployzIR {
  const base = makeIr({
    postgres: true,
    redis: false,
    dbEngine: 'mysql',
    workers: [{ componentId: 'worker', command: 'node dist/worker.js' }],
  });

  const cleanup: IrWorkload = {
    componentId: 'cleanup',
    kind: 'scheduled-job',
    label: 'Cleanup job',
    buildArtifactId: 'app',
    command: 'node dist/cleanup.js',
    port: null,
    public: false,
    healthCheck: null,
    desiredCount: 1,
    compute: {
      provider: 'aws',
      capabilityKey: CAPABILITY_KEYS.ECS_FARGATE_TASK,
      cpuUnits: 256,
      memoryMiB: 512,
      sizeLabel: 'Small',
      architecture: null,
    },
    dependencyCapabilityKeys: [CAPABILITY_KEYS.RDS_MYSQL, CAPABILITY_KEYS.S3],
  };

  const resources: IrResource[] = [
    ...base.resources,
    queueResource('orders-queue', { retention: 345600, visibility: 120 }),
    queueResource('orders-queue-dlq', { retention: 1209600, visibility: 30 }),
    queueResource('cleanup-schedule-dlq', { retention: 1209600, visibility: 30 }),
  ];

  const bindings: IrBinding[] = [
    irBinding({ id: 'b-web-orders', sourceId: 'web', targetId: 'orders-queue', access: 'produce', iamActions: ['sqs:SendMessage'], envBindings: [{ name: 'ORDERS_QUEUE_URL', kind: 'url' }] }),
    irBinding({ id: 'b-worker-orders', sourceId: 'worker', targetId: 'orders-queue', access: 'consume', iamActions: CONSUME_ACTIONS, envBindings: [{ name: 'ORDERS_QUEUE_URL', kind: 'url' }] }),
    irBinding({ id: 'b-orders-dlq', sourceId: 'orders-queue', targetId: 'orders-queue-dlq', access: 'dead-letter', iamActions: ['sqs:SendMessage'], maxReceiveCount: 5 }),
    irBinding({ id: 'b-worker-dlq', sourceId: 'worker', targetId: 'orders-queue-dlq', access: 'consume', iamActions: CONSUME_ACTIONS, envBindings: [{ name: 'ORDERS_DLQ_URL', kind: 'url' }] }),
    irBinding({ id: 'b-schedule-invoke', sourceId: 'cleanup-schedule', targetId: 'cleanup', access: 'invoke', iamActions: ['ecs:RunTask', 'iam:PassRole'] }),
    irBinding({ id: 'b-schedule-dlq', sourceId: 'cleanup-schedule', targetId: 'cleanup-schedule-dlq', access: 'dead-letter', iamActions: ['sqs:SendMessage'] }),
  ];

  const schedules: IrSchedule[] = [
    {
      id: 'cleanup-schedule',
      capabilityKey: CAPABILITY_KEYS.EVENTBRIDGE_SCHEDULER,
      label: 'Schedule for cleanup',
      expression: { type: 'cron', cron: '0 3 * * *' },
      timezone: 'Europe/Berlin',
      targetWorkloadId: 'cleanup',
      retry: { maximumRetryAttempts: 3, maximumEventAgeSeconds: 3600 },
      deadLetterQueueId: 'cleanup-schedule-dlq',
      enabled: true,
    },
  ];

  return { ...base, workloads: [...base.workloads, cleanup], resources, bindings, schedules };
}

describe('queues (phase 5a)', () => {
  const ir = makePhase5Ir();
  const compiled = compileDeployzInfrastructure({ ir, region: null });
  const byId = new Map(compiled.resolvedGraph.resources.map((r) => [r.logicalId, r]));

  it('compiles a standard SQS queue with no QueueName and a TLS-deny queue policy', () => {
    const queue = byId.get(logicalResourceId('orders-queue', 'queue'))!;
    expect(queue.cfnType).toBe('AWS::SQS::Queue');
    expect(queue.properties).not.toHaveProperty('QueueName');
    expect(queue.properties['MessageRetentionPeriod']).toBe(345600);
    expect(queue.properties['VisibilityTimeout']).toBe(120);
    expect(queue.properties['SqsManagedSseEnabled']).toBe(true);
    expect(queue.stateful).toBe(false);
    expect(queue.deletionPolicy).toBe('Delete');
    expect(queue.verificationCheck).toBe('queue');

    const policy = byId.get(logicalResourceId('orders-queue', 'queue-policy'))!;
    expect(policy.cfnType).toBe('AWS::SQS::QueuePolicy');
    const statement = (policy.properties['PolicyDocument'] as { Statement: unknown[] }).Statement[0] as Record<string, unknown>;
    expect(statement['Effect']).toBe('Deny');
    expect(statement['Condition']).toEqual({ Bool: { 'aws:SecureTransport': 'false' } });
  });

  it('sets RedrivePolicy on the SOURCE queue only, pointing at the DLQ with the bound maxReceiveCount', () => {
    const orders = byId.get(logicalResourceId('orders-queue', 'queue'))!;
    expect(orders.properties['RedrivePolicy']).toEqual({
      deadLetterTargetArn: { 'Fn::GetAtt': [logicalResourceId('orders-queue-dlq', 'queue'), 'Arn'] },
      maxReceiveCount: 5,
    });
    const dlq = byId.get(logicalResourceId('orders-queue-dlq', 'queue'))!;
    expect(dlq.properties).not.toHaveProperty('RedrivePolicy');
  });

  it('rejects a non-standard queue type (fails closed)', () => {
    const fifoIr: DeployzIR = {
      ...ir,
      resources: ir.resources.map((r) => (r.componentId === 'orders-queue' ? { ...r, configuration: { ...r.configuration, queueType: 'fifo' } } : r)),
    };
    expect(() => compileDeployzInfrastructure({ ir: fifoIr, region: null })).toThrow(/unsupported queueType/);
  });
});

describe('per-workload IAM (phase 5)', () => {
  const ir = makePhase5Ir();
  const compiled = compileDeployzInfrastructure({ ir, region: null });
  const byId = new Map(compiled.resolvedGraph.resources.map((r) => [r.logicalId, r]));

  function statements(componentId: string): Array<Record<string, unknown>> {
    const policy = byId.get(logicalResourceId(componentId, 'task-role-policy'))!;
    return (policy.properties['PolicyDocument'] as { Statement: Array<Record<string, unknown>> }).Statement;
  }

  it('every non-web workload gets its own task role + policy', () => {
    for (const componentId of ['worker', 'cleanup']) {
      expect(byId.has(logicalResourceId(componentId, 'task-role'))).toBe(true);
      expect(byId.has(logicalResourceId(componentId, 'task-role-policy'))).toBe(true);
    }
    // The web role/policy is the SAME id the pre-Phase-5 shared role used.
    expect(byId.has(logicalResourceId('web', 'task-role'))).toBe(true);
  });

  it('the producer (web) gets only SendMessage on its queue', () => {
    const sqsStatements = statements('web').filter((s) => (s['Action'] as string[]).some((a) => a.startsWith('sqs:')));
    expect(sqsStatements).toHaveLength(1);
    expect(sqsStatements[0]!['Action']).toEqual(['sqs:SendMessage']);
    expect(sqsStatements[0]!['Resource']).toEqual({ 'Fn::GetAtt': [logicalResourceId('orders-queue', 'queue'), 'Arn'] });
  });

  it('the consumer (worker) gets only the four consume actions, once per queue it consumes', () => {
    const sqsStatements = statements('worker').filter((s) => (s['Action'] as string[]).some((a) => a.startsWith('sqs:')));
    expect(sqsStatements).toHaveLength(2);
    for (const s of sqsStatements) {
      expect(s['Action']).toEqual(CONSUME_ACTIONS);
    }
    const resources = sqsStatements.map((s) => (s['Resource'] as { 'Fn::GetAtt': string[] })['Fn::GetAtt'][0]).sort();
    expect(resources).toEqual([logicalResourceId('orders-queue', 'queue'), logicalResourceId('orders-queue-dlq', 'queue')].sort());
  });

  it('a workload without queue edges has no sqs: action anywhere in its policy', () => {
    // The migration/cleanup workload has no produce/consume edges in this
    // fixture — its policy carries only the baseline S3 + secret statements.
    const cleanupStatements = statements('cleanup');
    expect(cleanupStatements.some((s) => (Array.isArray(s['Action']) ? s['Action'] as string[] : [s['Action'] as string]).some((a) => a.startsWith('sqs:')))).toBe(false);
  });

  it('no IAM statement anywhere has Resource "*" (architecture fitness)', () => {
    const iamPolicies = compiled.resolvedGraph.resources.filter((r) => r.cfnType === 'AWS::IAM::Policy');
    for (const policy of iamPolicies) {
      const stmts = (policy.properties['PolicyDocument'] as { Statement: Array<Record<string, unknown>> }).Statement;
      for (const s of stmts) {
        const resource = s['Resource'];
        const flat = Array.isArray(resource) ? resource : [resource];
        for (const r of flat) {
          expect(r).not.toBe('*');
        }
      }
    }
  });
});

describe('queue env injection (phase 5)', () => {
  const ir = makePhase5Ir();
  const compiled = compileDeployzInfrastructure({ ir, region: null });
  const byId = new Map(compiled.resolvedGraph.resources.map((r) => [r.logicalId, r]));

  function envNames(componentId: string): Array<{ Name: string; Value?: unknown }> {
    const taskDef = byId.get(logicalResourceId(componentId, 'task-definition'))!;
    const app = (taskDef.properties['ContainerDefinitions'] as unknown[])[0] as { Environment: Array<{ Name: string; Value?: unknown }> };
    return app.Environment;
  }

  it('injects the queue URL only into the bound workload, appended after the shared environment', () => {
    const webEnv = envNames('web');
    const orderEntry = webEnv.find((e) => e.Name === 'ORDERS_QUEUE_URL')!;
    expect(orderEntry.Value).toEqual({ Ref: logicalResourceId('orders-queue', 'queue') });
    // It is appended AFTER the shared entries (STORAGE_BUCKET, etc.).
    expect(webEnv.findIndex((e) => e.Name === 'ORDERS_QUEUE_URL')).toBeGreaterThan(webEnv.findIndex((e) => e.Name === 'STORAGE_BUCKET'));

    const workerEnv = envNames('worker');
    expect(workerEnv.map((e) => e.Name)).toContain('ORDERS_QUEUE_URL');
    expect(workerEnv.map((e) => e.Name)).toContain('ORDERS_DLQ_URL');
  });

  it('a workload with no queue edges gets exactly the pre-Phase-5 environment (cleanup has none in this fixture)', () => {
    const cleanupEnv = envNames('cleanup').map((e) => e.Name);
    expect(cleanupEnv.some((n) => n.includes('QUEUE'))).toBe(false);
  });

  it('two different queues bound to the same env name on one workload fails closed', () => {
    const clashIr: DeployzIR = {
      ...ir,
      bindings: [
        ...ir.bindings,
        irBinding({ id: 'b-clash', sourceId: 'worker', targetId: 'orders-queue-dlq', access: 'produce', iamActions: ['sqs:SendMessage'], envBindings: [{ name: 'ORDERS_QUEUE_URL', kind: 'url' }] }),
      ],
    };
    expect(() => compileDeployzInfrastructure({ ir: clashIr, region: null })).toThrow(/binds env "ORDERS_QUEUE_URL" to two different queues/);
  });

  it('an unsupported env binding kind fails closed', () => {
    const badIr: DeployzIR = {
      ...ir,
      bindings: ir.bindings.map((b) => (b.id === 'b-web-orders' ? { ...b, envBindings: [{ name: 'ORDERS_QUEUE_HOST', kind: 'host' as const }] } : b)),
    };
    expect(() => compileDeployzInfrastructure({ ir: badIr, region: null })).toThrow(/env binding kind "host" is not supported/);
  });
});

describe('installation-scoped task families', () => {
  const compiled = compileDeployzInfrastructure({ ir: makePhase5Ir(), region: null });
  const template = compiled.template as {
    Parameters: Record<string, Record<string, unknown>>;
    Resources: Record<string, { Type: string; Properties: Record<string, unknown> }>;
  };

  it('every task definition family carries the installation suffix, so two installations never share one', () => {
    const families = Object.entries(template.Resources)
      .filter(([, resource]) => resource.Type === 'AWS::ECS::TaskDefinition')
      .map(([logicalId, resource]) => [logicalId, resource.Properties['Family']] as const);
    expect(families.length).toBeGreaterThan(1);
    for (const [, family] of families) {
      const a = familyFor(family, 'aaaa1111');
      const b = familyFor(family, 'bbbb2222');
      expect(a).not.toBe(b);
      expect(a).toMatch(/^DeployzApp[A-Za-z0-9]+aaaa1111$/);
    }
  });

  it('the suffix parameter has no default and admits only letters and digits', () => {
    const parameter = template.Parameters[TASK_FAMILY_SUFFIX_PARAMETER]!;
    expect(parameter['Type']).toBe('String');
    expect(parameter).not.toHaveProperty('Default');
    expect(parameter['AllowedPattern']).toBe('^[a-z0-9]+$');
  });
});

describe('scheduled job (phase 5d)', () => {
  const ir = makePhase5Ir();
  const compiled = compileDeployzInfrastructure({ ir, region: null });
  const byId = new Map(compiled.resolvedGraph.resources.map((r) => [r.logicalId, r]));

  it('compiles a frozen-command task definition, no service, no verification check', () => {
    const taskDef = byId.get(logicalResourceId('cleanup', 'task-definition'))!;
    expect(taskDef.cfnType).toBe('AWS::ECS::TaskDefinition');
    expect(familyFor(taskDef.properties['Family'], 'a1b2')).toBe('DeployzAppCleanupa1b2');
    const app = (taskDef.properties['ContainerDefinitions'] as unknown[])[0] as Record<string, unknown>;
    expect(app['EntryPoint']).toEqual(['sh', '-c']);
    expect(app['Command']).toEqual(['node dist/cleanup.js']);
    expect(taskDef.verificationCheck).toBeUndefined();
    expect(byId.has(logicalResourceId('cleanup', 'service'))).toBe(false);
  });

  it('gets its own task role and its own task security group', () => {
    expect(byId.has(logicalResourceId('cleanup', 'task-role'))).toBe(true);
    const taskDef = byId.get(logicalResourceId('cleanup', 'task-definition'))!;
    expect(taskDef.properties['TaskRoleArn']).toEqual({ 'Fn::GetAtt': [logicalResourceId('cleanup', 'task-role'), 'Arn'] });
    const sg = byId.get(logicalResourceId('cleanup', 'task-security-group'))!;
    expect(sg.cfnType).toBe('AWS::EC2::SecurityGroup');
  });

  it('the database accepts ingress from the scheduled job security group', () => {
    const ingress = byId.get(logicalResourceId('primary-db', `app-service-ingress-cleanup`))!;
    expect(ingress.properties['SourceSecurityGroupId']).toEqual({
      'Fn::GetAtt': [logicalResourceId('cleanup', 'task-security-group'), 'GroupId'],
    });
    // Existing workloads keep referencing THEIR service-security-group.
    const webIngress = byId.get(logicalResourceId('primary-db', 'app-service-ingress-web'))!;
    expect(webIngress.properties['SourceSecurityGroupId']).toEqual({
      'Fn::GetAtt': [logicalResourceId('web', 'service-security-group'), 'GroupId'],
    });
  });

  it('gains no compute verification check', () => {
    const computeComponents = compiled.verificationContract.checks.filter((c) => c.check === 'compute').map((c) => c.componentId);
    expect(computeComponents).not.toContain('cleanup');
  });
});

describe('EventBridge Scheduler (phase 5c)', () => {
  const ir = makePhase5Ir();
  const compiled = compileDeployzInfrastructure({ ir, region: null });
  const byId = new Map(compiled.resolvedGraph.resources.map((r) => [r.logicalId, r]));

  it('translates the cron expression and carries the timezone', () => {
    const schedule = byId.get(logicalResourceId('cleanup-schedule', 'schedule'))!;
    expect(schedule.cfnType).toBe('AWS::Scheduler::Schedule');
    expect(schedule.properties['ScheduleExpression']).toBe('cron(0 3 * * ? *)');
    expect(schedule.properties['ScheduleExpressionTimezone']).toBe('Europe/Berlin');
    expect(schedule.verificationCheck).toBe('schedule');
    expect(schedule.properties).not.toHaveProperty('Tags');
  });

  it('carries the retry policy and the DLQ config, and targets the revisionless task definition family', () => {
    const schedule = byId.get(logicalResourceId('cleanup-schedule', 'schedule'))!;
    const target = schedule.properties['Target'] as Record<string, unknown>;
    expect(target['RetryPolicy']).toEqual({ MaximumRetryAttempts: 3, MaximumEventAgeInSeconds: 3600 });
    expect(target['DeadLetterConfig']).toEqual({ Arn: { 'Fn::GetAtt': [logicalResourceId('cleanup-schedule-dlq', 'queue'), 'Arn'] } });
    const ecsParams = target['EcsParameters'] as Record<string, unknown>;
    expect(JSON.stringify(ecsParams['TaskDefinitionArn'])).toContain('DeployzAppCleanup');
    expect(JSON.stringify(ecsParams['TaskDefinitionArn'])).toContain(`{"Ref":"${TASK_FAMILY_SUFFIX_PARAMETER}"}`);
    expect(JSON.stringify(ecsParams['TaskDefinitionArn'])).not.toContain(':*');
    expect(ecsParams['LaunchType']).toBe('FARGATE');
  });

  it('is DISABLED when the schedule is disabled', () => {
    const disabledIr: DeployzIR = { ...ir, schedules: ir.schedules.map((s) => ({ ...s, enabled: false })) };
    const disabled = compileDeployzInfrastructure({ ir: disabledIr, region: null });
    const schedule = disabled.resolvedGraph.resources.find((r) => r.logicalId === logicalResourceId('cleanup-schedule', 'schedule'))!;
    expect(schedule.properties['State']).toBe('DISABLED');
  });

  it('has no ScheduleExpressionTimezone when the schedule has no timezone', () => {
    const noTzIr: DeployzIR = { ...ir, schedules: ir.schedules.map((s) => ({ ...s, timezone: null })) };
    const noTz = compileDeployzInfrastructure({ ir: noTzIr, region: null });
    const schedule = noTz.resolvedGraph.resources.find((r) => r.logicalId === logicalResourceId('cleanup-schedule', 'schedule'))!;
    expect(schedule.properties).not.toHaveProperty('ScheduleExpressionTimezone');
  });

  it('the scheduler role trusts scheduler.amazonaws.com, guarded against the confused deputy', () => {
    const role = byId.get(logicalResourceId('cleanup-schedule', 'scheduler-role'))!;
    const trust = (role.properties['AssumeRolePolicyDocument'] as { Statement: Array<Record<string, unknown>> }).Statement[0]!;
    expect(trust['Principal']).toEqual({ Service: 'scheduler.amazonaws.com' });
    expect(trust['Condition']).toEqual({ StringEquals: { 'aws:SourceAccount': { Ref: 'AWS::AccountId' } } });
  });

  it('RunTask is conditioned on the cluster; PassRole is limited to the job role + execution role, conditioned on PassedToService', () => {
    const policy = byId.get(logicalResourceId('cleanup-schedule', 'scheduler-role-policy'))!;
    const statements = (policy.properties['PolicyDocument'] as { Statement: Array<Record<string, unknown>> }).Statement;

    const runTask = statements.find((s) => s['Action'] === 'ecs:RunTask')!;
    expect(runTask['Condition']).toEqual({ ArnEquals: { 'ecs:cluster': { 'Fn::GetAtt': [logicalResourceId('web', 'cluster'), 'Arn'] } } });
    expect(runTask['Resource']).toHaveLength(2);
    // Only this installation's family: the suffix parameter scopes both ARNs.
    for (const resource of runTask['Resource'] as unknown[]) {
      expect(JSON.stringify(resource)).toContain(`"DeployzAppCleanup",{"Ref":"${TASK_FAMILY_SUFFIX_PARAMETER}"}`);
    }

    const passRole = statements.find((s) => s['Action'] === 'iam:PassRole')!;
    expect(passRole['Condition']).toEqual({ StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } });
    expect(passRole['Resource']).toEqual([
      { 'Fn::GetAtt': [logicalResourceId('cleanup', 'task-role'), 'Arn'] },
      { 'Fn::GetAtt': [logicalResourceId('web', 'task-execution-role'), 'Arn'] },
    ]);

    const sendMessage = statements.find((s) => s['Action'] === 'sqs:SendMessage')!;
    expect(sendMessage['Resource']).toEqual({ 'Fn::GetAtt': [logicalResourceId('cleanup-schedule-dlq', 'queue'), 'Arn'] });

    // Never a wildcard resource.
    for (const s of statements) {
      const flat = Array.isArray(s['Resource']) ? s['Resource'] : [s['Resource']];
      for (const r of flat) expect(r).not.toBe('*');
    }
  });

  it('an unmapped schedule IAM action fails closed', () => {
    const badIr: DeployzIR = {
      ...ir,
      bindings: ir.bindings.map((b) => (b.id === 'b-schedule-dlq' ? { ...b, iamActions: ['s3:PutObject'] } : b)),
    };
    expect(() => compileDeployzInfrastructure({ ir: badIr, region: null })).toThrow(/has no resource mapping/);
  });
});

describe('phase 5 composition (target topology)', () => {
  const ir = makePhase5Ir();
  const compiled = compileDeployzInfrastructure({ ir, region: null });

  // Pinned golden logical ids for the queue/schedule/per-workload-role
  // additions — a stable-identity regression gate for the Phase 5 topology.
  const EXPECTED_NEW_IDS = [
    'OrdersQueueQueue',
    'OrdersQueueQueuePolicy',
    'OrdersQueueDlqQueue',
    'OrdersQueueDlqQueuePolicy',
    'CleanupScheduleDlqQueue',
    'CleanupScheduleDlqQueuePolicy',
    'WorkerTaskRole',
    'WorkerTaskRolePolicy',
    'CleanupTaskRole',
    'CleanupTaskRolePolicy',
    'CleanupTaskDefinition',
    'CleanupTaskSecurityGroup',
    'CleanupLogGroup',
    'CleanupScheduleSchedulerRole',
    'CleanupScheduleSchedulerRolePolicy',
    'CleanupScheduleSchedule',
    'PrimaryDbAppServiceIngressCleanup',
  ];

  it('emits every pinned logical id for the target topology', () => {
    const ids = new Set(compiled.resolvedGraph.resources.map((r) => r.logicalId));
    for (const id of EXPECTED_NEW_IDS) {
      expect(ids.has(id), id).toBe(true);
    }
    expect(new Set(compiled.resolvedGraph.resources.map((r) => r.logicalId)).size).toBe(compiled.resolvedGraph.resources.length);
  });

  it('is deterministic: the same IR compiles to the same template hash twice', () => {
    const again = compileDeployzInfrastructure({ ir: makePhase5Ir(), region: null });
    expect(again.artifact.templateHash).toBe(compiled.artifact.templateHash);
  });

  it('IR resource and binding reordering does not change the template hash', () => {
    const reordered: DeployzIR = {
      ...ir,
      resources: [...ir.resources].reverse(),
      bindings: [...ir.bindings].reverse(),
    };
    const result = compileDeployzInfrastructure({ ir: reordered, region: null });
    expect(result.artifact.templateHash).toBe(compiled.artifact.templateHash);
  });

  it('adding the queue/schedule topology to a plain web+db+s3 IR leaves every unrelated logical id unchanged', () => {
    const plain = compileDeployzInfrastructure({ ir: makeIr({ postgres: true, redis: false, dbEngine: 'mysql' }), region: null });
    const plainIds = new Set(plain.resolvedGraph.resources.map((r) => r.logicalId));
    const fullIds = new Set(compiled.resolvedGraph.resources.map((r) => r.logicalId));

    // Every id the plain (web-only) graph has still exists, UNCHANGED in
    // content, in the full topology — except the shared task-role/policy,
    // which legitimately keeps the SAME id but gains queue statements.
    for (const id of plainIds) {
      expect(fullIds.has(id), id).toBe(true);
      // These legitimately change: the shared task-role-policy gains the
      // producer statement, the web task def gains the ORDERS_QUEUE_URL env
      // entry, and the shared execution-role-policy gains the new
      // workloads' log group Arns.
      if (['WebTaskRolePolicy', 'WebTaskDefinition', 'WebTaskExecutionRolePolicy'].includes(id)) continue;
      const before = JSON.stringify(plain.resolvedGraph.resources.find((r) => r.logicalId === id)!.properties);
      const after = JSON.stringify(compiled.resolvedGraph.resources.find((r) => r.logicalId === id)!.properties);
      expect(after, id).toBe(before);
    }
  });
});

describe('footprint + pricing (phase 5)', () => {
  it('the footprint gains a queue resource per SQS queue and a schedule resource per schedule', () => {
    const { footprint } = compileDeployzInfrastructure({ ir: makePhase5Ir(), region: null });
    const queueResources = footprint.resources.filter((r) => r.category === 'queue');
    expect(queueResources.map((r) => r.id).sort()).toEqual(['cleanup-schedule-dlq', 'orders-queue', 'orders-queue-dlq'].sort());
    expect(queueResources.every((r) => r.service === 'sqs')).toBe(true);

    const scheduleResource = footprint.resources.find((r) => r.id === 'cleanup-schedule')!;
    expect(scheduleResource.category).toBe('other');
    expect(scheduleResource.service).toBe('eventbridge-scheduler');

    const scheduledJobWorkload = footprint.workloads.find((w) => w.id === 'cleanup')!;
    expect(scheduledJobWorkload.label).toBe('Scheduled job');
  });

  it('never invents SQS/EventBridge Scheduler usage volume — the estimate is marked incomplete', () => {
    const { footprint } = compileDeployzInfrastructure({ ir: makePhase5Ir(), region: null });
    const estimate = estimateFootprintCost(footprint);
    expect(estimate.complete).toBe(false);
    const sqsItems = estimate.items.filter((i) => footprint.resources.some((r) => r.service === 'sqs' && r.id === i.resourceId));
    const schedulerItems = estimate.items.filter((i) => footprint.resources.some((r) => r.service === 'eventbridge-scheduler' && r.id === i.resourceId));
    expect(sqsItems.length).toBeGreaterThan(0);
    expect(schedulerItems.length).toBeGreaterThan(0);
    for (const item of [...sqsItems, ...schedulerItems]) {
      expect(item.pricingStatus).toBe('unavailable');
      expect(item.monthlyMin).toBeUndefined();
      expect(item.monthlyMax).toBeUndefined();
    }
  });
});

// ── RDS AZ placement (multi-AZ subnet group) ─────────────────────────────────
// The DB subnet group spans every available AZ: slots 1-2 are the VPC's
// private subnets, slots 3-8 are conditionally created DB-only subnets carved
// from a secondary VPC CIDR block. The relay fills paramDbAz1..paramDbAz8 from
// the region's AZ list; empty parameters collapse to AWS::NoValue.

const DB_VPC_CIDR_BLOCK = '10.1.0.0/20';
const DB_AZ_SLOT_COUNT = 8;
const DB_ONLY_SUBNET_COUNT = DB_AZ_SLOT_COUNT - 2;
const DB_ONLY_SUBNET_CIDRS = [
  '10.1.2.0/24', '10.1.3.0/24', '10.1.4.0/24', '10.1.5.0/24', '10.1.6.0/24', '10.1.7.0/24',
];

function dbSubnetGroupSubnetIds(template: Record<string, unknown>): unknown[] {
  const subnetGroup = (template['Resources'] as Record<string, unknown>)['PrimaryDbSubnetGroup'] as { Properties: { SubnetIds: unknown[] } };
  return subnetGroup.Properties.SubnetIds;
}

describe('rds az placement', () => {
  const ir = makeIr({ postgres: true, redis: true });
  const compiled = compileDeployzInfrastructure({ ir, region: null });
  const template = compiled.template;

  it('compiling the same input twice yields byte-identical output', () => {
    const again = compileDeployzInfrastructure({ ir: makeIr({ postgres: true, redis: true }), region: null });
    expect(JSON.stringify(again.template)).toBe(JSON.stringify(template));
    expect(again.artifact.templateHash).toBe(compiled.artifact.templateHash);
  });

  it('the DB subnet group always keeps both private subnets plus conditional DB-only slots', () => {
    const subnetIds = dbSubnetGroupSubnetIds(template);
    expect(subnetIds[0]).toEqual({ Ref: 'NetworkPrivateSubnet1' });
    expect(subnetIds[1]).toEqual({ Ref: 'NetworkPrivateSubnet2' });
    expect(subnetIds).toHaveLength(2 + DB_ONLY_SUBNET_COUNT);
    for (let i = 3; i <= DB_AZ_SLOT_COUNT; i++) {
      const entry = subnetIds[i - 1] as { 'Fn::If': [string, unknown, unknown] };
      expect(entry['Fn::If'][0]).toBe(`condDbAz${i}`);
      expect(entry['Fn::If'][1]).toEqual({ Ref: `NetworkDbSubnet${i}` });
      expect(entry['Fn::If'][2]).toEqual({ Ref: 'AWS::NoValue' });
    }
  });

  it('emits exactly DB_AZ_SLOT_COUNT - 2 DB-only subnets with non-overlapping CIDRs inside the DB block, in deterministic order', () => {
    const resources = template['Resources'] as Record<string, { Type: string; Properties: Record<string, unknown> }>;
    const dbSubnets = Object.entries(resources)
      .filter(([, r]) => r.Type === 'AWS::EC2::Subnet' && r.Properties['CidrBlock'] !== undefined && String(r.Properties['CidrBlock']).startsWith('10.1.'))
      .sort(([a], [b]) => a.localeCompare(b));

    expect(dbSubnets).toHaveLength(DB_ONLY_SUBNET_COUNT);
    // Stable logical ids in deterministic slot order.
    expect(dbSubnets.map(([id]) => id)).toEqual(
      Array.from({ length: DB_ONLY_SUBNET_COUNT }, (_, i) => `NetworkDbSubnet${i + 3}`),
    );
    // Non-overlapping /24 CIDRs, each inside DB_VPC_CIDR_BLOCK, in slot order.
    const cidrs = dbSubnets.map(([, r]) => r.Properties['CidrBlock'] as string);
    expect(cidrs).toEqual(DB_ONLY_SUBNET_CIDRS);
    for (const cidr of cidrs) {
      const [network, prefix] = cidr.split('/');
      expect(network.startsWith('10.1.')).toBe(true);
      expect(Number(prefix)).toBe(24);
      const thirdOctet = Number(network.split('.')[2]);
      expect(thirdOctet).toBeGreaterThanOrEqual(0);
      expect(thirdOctet).toBeLessThanOrEqual(15);
    }
    // Each DB-only subnet references its AZ parameter and the shared VPC.
    for (let i = 3; i <= DB_AZ_SLOT_COUNT; i++) {
      const subnet = resources[`NetworkDbSubnet${i}`];
      expect(subnet.Properties['AvailabilityZone']).toEqual({ Ref: `paramDbAz${i}` });
      expect(subnet.Properties['VpcId']).toEqual({ Ref: 'NetworkVpc' });
    }
  });

  it('carries the secondary VPC CIDR block resource the DB subnets depend on', () => {
    const resources = template['Resources'] as Record<string, { Type: string; Properties: Record<string, unknown>; DependsOn?: string[] }>;
    const cidrBlock = resources['NetworkDbVpcCidrBlock'];
    expect(cidrBlock).toBeDefined();
    expect(cidrBlock.Type).toBe('AWS::EC2::VPCCidrBlock');
    expect(cidrBlock.Properties['CidrBlock']).toBe(DB_VPC_CIDR_BLOCK);
    expect(cidrBlock.Properties['VpcId']).toEqual({ Ref: 'NetworkVpc' });
    for (let i = 3; i <= DB_AZ_SLOT_COUNT; i++) {
      expect(resources[`NetworkDbSubnet${i}`].DependsOn).toContain('NetworkDbVpcCidrBlock');
    }
  });

  it('empty DbAz parameters produce AWS::NoValue branches and a valid template for any region', () => {
    // All DbAz parameters default to '' — every conditional slot collapses to
    // AWS::NoValue, so the subnet group degrades to the two private subnets.
    const parameters = template['Parameters'] as Record<string, { Default?: unknown }>;
    for (let i = 1; i <= DB_AZ_SLOT_COUNT; i++) {
      expect(parameters[`paramDbAz${i}`]).toBeDefined();
      expect(parameters[`paramDbAz${i}`].Default).toBe('');
    }
    const conditions = template['Conditions'] as Record<string, unknown>;
    expect(Object.keys(conditions)).toHaveLength(DB_ONLY_SUBNET_COUNT + 1);
    for (let i = 3; i <= DB_AZ_SLOT_COUNT; i++) {
      expect(conditions[`condDbAz${i}`]).toEqual({ 'Fn::Not': [{ 'Fn::Equals': [{ Ref: `paramDbAz${i}` }, ''] }] });
    }
    // A region with only 2 AZs leaves slots 3-8 empty: the template is still
    // valid because every slot has an AWS::NoValue branch.
    const twoAzRegion = compileDeployzInfrastructure({ ir, region: 'us-east-2' });
    expect(dbSubnetGroupSubnetIds(twoAzRegion.template)).toEqual(dbSubnetGroupSubnetIds(template));
    expect(twoAzRegion.artifact.templateHash).toBe(compiled.artifact.templateHash);
  });

  it('both PostgreSQL and MySQL get the widened subnet group and neither sets AvailabilityZone', () => {
    const mysql = compileDeployzInfrastructure({ ir: makeIr({ postgres: true, redis: true, dbEngine: 'mysql' }), region: null });
    for (const result of [compiled, mysql]) {
      const subnetIds = dbSubnetGroupSubnetIds(result.template);
      expect(subnetIds).toHaveLength(2 + DB_ONLY_SUBNET_COUNT);
      expect(subnetIds[0]).toEqual({ Ref: 'NetworkPrivateSubnet1' });
      expect(subnetIds[1]).toEqual({ Ref: 'NetworkPrivateSubnet2' });
      const instance = (result.template['Resources'] as Record<string, { Properties: Record<string, unknown> }>)['PrimaryDbInstance'];
      expect(instance.Properties).not.toHaveProperty('AvailabilityZone');
    }
  });

  it('DB-only subnets are isolated: no route table, no NAT gateway, no public IP', () => {
    const resources = template['Resources'] as Record<string, { Type: string; Properties: Record<string, unknown> }>;
    const dbSubnetIds = new Set(Array.from({ length: DB_ONLY_SUBNET_COUNT }, (_, i) => `NetworkDbSubnet${i + 3}`));

    // No route table or route-table association references a DB-only subnet.
    for (const [id, r] of Object.entries(resources)) {
      if (r.Type === 'AWS::EC2::RouteTable' || r.Type === 'AWS::EC2::SubnetRouteTableAssociation' || r.Type === 'AWS::EC2::Route') {
        const props = JSON.stringify(r.Properties);
        for (const dbSubnetId of dbSubnetIds) {
          expect(props, `${id} must not reference ${dbSubnetId}`).not.toContain(dbSubnetId);
        }
      }
      // No public IP association on any subnet.
      if (r.Type === 'AWS::EC2::Subnet' && dbSubnetIds.has(id)) {
        expect(r.Properties['MapPublicIpOnLaunch']).toBe(false);
      }
    }
    // Exactly one NAT gateway exists, and it is referenced only by the two
    // private subnets' routes.
    const natGateways = Object.values(resources).filter((r) => r.Type === 'AWS::EC2::NatGateway');
    expect(natGateways).toHaveLength(1);
    const natRefs = Object.entries(resources)
      .filter(([, r]) => JSON.stringify(r.Properties).includes('NetworkNatGateway'))
      .map(([id]) => id)
      .sort();
    expect(natRefs).toEqual(['NetworkPrivateRoute1', 'NetworkPrivateRoute2']);
  });

  it('preserved invariants: ECS/ALB in exactly two AZs, single NAT gateway, one Single-AZ database', () => {
    const resources = template['Resources'] as Record<string, { Type: string; Properties: Record<string, unknown> }>;

    // ECS service runs in exactly the two private subnets.
    const service = resources['WebService'];
    expect(service.Properties['NetworkConfiguration']).toEqual({
      AwsvpcConfiguration: {
        AssignPublicIp: 'DISABLED',
        SecurityGroups: [{ 'Fn::GetAtt': ['WebServiceSecurityGroup', 'GroupId'] }],
        Subnets: [{ Ref: 'NetworkPrivateSubnet1' }, { Ref: 'NetworkPrivateSubnet2' }],
      },
    });
    // ALB runs in exactly the two public subnets.
    const alb = resources['EndpointLoadBalancer'];
    expect(alb.Properties['Subnets']).toEqual([{ Ref: 'NetworkPublicSubnet1' }, { Ref: 'NetworkPublicSubnet2' }]);
    // Single NAT gateway.
    expect(Object.values(resources).filter((r) => r.Type === 'AWS::EC2::NatGateway')).toHaveLength(1);
    // One Single-AZ database with unchanged size/engine/storage/encryption/
    // security/backups/deletion protection/retention.
    const instances = Object.values(resources).filter((r) => r.Type === 'AWS::RDS::DBInstance');
    expect(instances).toHaveLength(1);
    const db = instances[0]!.Properties;
    expect(db).not.toHaveProperty('AvailabilityZone');
    expect(db['DBInstanceClass']).toBe('db.t3.micro');
    expect(db['Engine']).toBe('postgres');
    expect(db['EngineVersion']).toBe('16');
    expect(db['AllocatedStorage']).toBe('20');
    expect(db['MaxAllocatedStorage']).toBe(100);
    expect(db['StorageEncrypted']).toBe(true);
    expect(db['StorageType']).toBe('gp3');
    expect(db['BackupRetentionPeriod']).toBe(7);
    expect(db['PreferredBackupWindow']).toBe('03:00-05:00');
    expect(db['DeleteAutomatedBackups']).toBe(false);
    expect(db['DeletionProtection']).toBe(true);
    expect(db['PubliclyAccessible']).toBe(false);
    expect(db['VPCSecurityGroups']).toEqual([{ 'Fn::GetAtt': ['PrimaryDbSecurityGroup', 'GroupId'] }]);
    const subnetGroupResource = resources['PrimaryDbSubnetGroup'];
    expect(subnetGroupResource['UpdateReplacePolicy']).toBe('Retain');
    expect(subnetGroupResource['DeletionPolicy']).toBe('Retain');
  });
});

describe('small-v1 frozen profile', () => {
  it('compiles to db.t4g.micro and gp2 when explicitly frozen', () => {
    const { template } = compileDeployzInfrastructure({
      ir: makeIr({ postgres: true, redis: true }),
      region: null,
      sizeProfile: SMALL_PROFILE,
    });
    const resources = template['Resources'] as Record<string, { Type: string; Properties: Record<string, unknown> }>;
    const instances = Object.values(resources).filter((r) => r.Type === 'AWS::RDS::DBInstance');
    expect(instances).toHaveLength(1);
    const db = instances[0]!.Properties;
    expect(db['DBInstanceClass']).toBe('db.t4g.micro');
    expect(db['StorageType']).toBe('gp2');
  });
});

describe('size profiles', () => {
  type Resources = Record<string, { Type: string; Properties: Record<string, unknown> }>;
  const SIZING_KEYS = ['Cpu', 'Memory', 'DBInstanceClass', 'CacheNodeType'];

  // Every workload kind (web, worker, migration, scheduled job) with Valkey and
  // the chosen database engine.
  function sizedIr(engine: 'postgres' | 'mysql'): DeployzIR {
    const withCache = (ir: DeployzIR): DeployzIR => ({
      ...ir,
      resources: [...ir.resources, ...makeIr({ postgres: false, redis: true }).resources.filter((r) => r.componentId === 'cache')],
    });
    const migration: IrWorkload = {
      ...makeIr({ postgres: true, redis: false }).workloads[0]!,
      componentId: 'migration',
      kind: 'migration',
      label: 'Database migration',
      command: 'npx prisma migrate deploy',
      port: null,
      public: false,
      healthCheck: null,
    };
    if (engine === 'mysql') {
      const ir = withCache(makePhase5Ir());
      return { ...ir, workloads: [...ir.workloads, migration] };
    }
    const ir = withCache(makeIr({ postgres: true, redis: true, workers: [{ componentId: 'worker', command: 'node dist/worker.js' }] }));
    return { ...ir, workloads: [...ir.workloads, migration] };
  }

  const compileSized = (engine: 'postgres' | 'mysql', sizeProfile: InfrastructureSizeProfile) =>
    compileDeployzInfrastructure({ ir: sizedIr(engine), region: null, sizeProfile });
  const resourcesOf = (template: Record<string, unknown>) => template['Resources'] as Resources;
  const propertyOf = (template: Record<string, unknown>, type: string, key: string): unknown[] =>
    Object.values(resourcesOf(template))
      .filter((resource) => resource.Type === type)
      .map((resource) => resource.Properties[key]);

  const PINS = [
    { profile: MEDIUM_PROFILE, key: 'medium-v1', cpu: '1024', memory: '2048', dbClass: 'db.t3.medium', cacheNode: 'cache.t4g.small' },
    { profile: LARGE_PROFILE, key: 'large-v1', cpu: '2048', memory: '4096', dbClass: 'db.t3.large', cacheNode: 'cache.t4g.medium' },
  ];

  describe.each(PINS)('$key', ({ profile, cpu, memory, dbClass, cacheNode }) => {
    it.each(['postgres', 'mysql'] as const)('pins task definition, %s instance and cache sizing', (engine) => {
      const { template } = compileSized(engine, profile);
      const taskDefinitions = Object.entries(resourcesOf(template)).filter(([, resource]) => resource.Type === 'AWS::ECS::TaskDefinition');
      const ids = taskDefinitions.map(([id]) => id).sort();
      expect(ids).toEqual(
        (engine === 'mysql'
          ? ['CleanupTaskDefinition', 'MigrationTaskDefinition', 'WebTaskDefinition', 'WorkerTaskDefinition']
          : ['MigrationTaskDefinition', 'WebTaskDefinition', 'WorkerTaskDefinition']
        ).sort(),
      );
      for (const [, taskDefinition] of taskDefinitions) {
        expect(taskDefinition.Properties['Cpu']).toBe(cpu);
        expect(taskDefinition.Properties['Memory']).toBe(memory);
      }
      expect(propertyOf(template, 'AWS::RDS::DBInstance', 'DBInstanceClass')).toEqual([dbClass]);
      expect(propertyOf(template, 'AWS::RDS::DBInstance', 'Engine')).toEqual([engine]);
      expect(propertyOf(template, 'AWS::ElastiCache::ReplicationGroup', 'CacheNodeType')).toEqual([cacheNode]);
    });

    it('the footprint states the same sizing as the template', () => {
      const { footprint } = compileSized('postgres', profile);
      expect(footprint.workloads.map((workload) => workload.compute)).toSatisfy((computes: { cpuUnits: number; memoryMiB: number; sizeLabel: string }[]) =>
        computes.length === 3 && computes.every((c) => c.cpuUnits === Number(cpu) && c.memoryMiB === Number(memory) && c.sizeLabel === profile.label),
      );
      expect(footprint.resources.find((r) => r.id === 'database')!.configuration).toMatchObject({ instanceType: dbClass });
      expect(footprint.resources.find((r) => r.id === 'cache')!.configuration).toMatchObject({ nodeType: cacheNode });
    });

    it.each(['postgres', 'mysql'] as const)('changes only sizing properties against small-v2 (%s): same topology and logical ids', (engine) => {
      const small = compileSized(engine, SMALL_V2_PROFILE);
      const sized = compileSized(engine, profile);
      const smallResources = resourcesOf(small.template);
      const sizedResources = resourcesOf(sized.template);
      expect(Object.keys(sizedResources)).toEqual(Object.keys(smallResources));
      expect(sized.template['Parameters']).toEqual(small.template['Parameters']);
      expect(sized.template['Outputs']).toEqual(small.template['Outputs']);
      expect(sized.resolvedGraph.resources.map((r) => [r.logicalId, r.cfnType])).toEqual(
        small.resolvedGraph.resources.map((r) => [r.logicalId, r.cfnType]),
      );
      const strip = (properties: Record<string, unknown>) => Object.fromEntries(Object.entries(properties).filter(([key]) => !SIZING_KEYS.includes(key)));
      for (const [id, resource] of Object.entries(sizedResources)) {
        expect(resource.Type).toBe(smallResources[id]!.Type);
        expect(strip(resource.Properties), id).toEqual(strip(smallResources[id]!.Properties));
      }
      expect(sized.artifact.templateHash).not.toBe(small.artifact.templateHash);
    });
  });
});

describe('compiler determinism', () => {
  it('produces identical output regardless of region', () => {
    const ir = makeIr({ postgres: true, redis: true });
    const a = compileDeployzInfrastructure({ ir, region: 'us-east-1' });
    const b = compileDeployzInfrastructure({ ir, region: 'eu-west-1' });
    const c = compileDeployzInfrastructure({ ir, region: null });
    expect(a.artifact.templateHash).toBe(b.artifact.templateHash);
    expect(a.artifact.templateHash).toBe(c.artifact.templateHash);
  });
});

describe('app-specific binding aliases', () => {
  type Container = { Environment: Array<{ Name: string; Value?: unknown }>; Secrets: Array<{ Name: string; ValueFrom?: unknown }> };
  const base = makeIr({ postgres: true, redis: true, workers: [{ componentId: 'jobs', command: 'node worker.js' }] });
  const withAliases: DeployzIR = {
    ...base,
    workloads: [
      ...base.workloads,
      {
        componentId: 'migration',
        kind: 'migration',
        label: 'Database migration',
        buildArtifactId: 'app',
        command: 'flask db upgrade',
        port: null,
        public: false,
        healthCheck: null,
        desiredCount: 1,
        compute: base.workloads[0]!.compute,
        dependencyCapabilityKeys: [CAPABILITY_KEYS.RDS_POSTGRES],
      },
    ],
    resources: base.resources.map((resource) => {
      if (resource.componentId === 'primary-db') {
        return {
          ...resource,
          envBindings: [
            { name: 'DATABASE_URL', kind: 'url' as const },
            { name: 'SQLALCHEMY_DATABASE_URI', kind: 'url' as const },
            { name: 'SPRING_DATASOURCE_URL', kind: 'jdbc_url' as const },
            { name: 'DB_HOST', kind: 'host' as const },
            { name: 'DB_PASSWORD', kind: 'password' as const },
            { name: 'PORT', kind: 'port' as const },
          ],
        };
      }
      if (resource.componentId === 'cache') return { ...resource, envBindings: [{ name: 'BACKEND_CACHE_REDIS_URI', kind: 'url' as const }] };
      if (resource.componentId === 'storage') return { ...resource, envBindings: [{ name: 'S3_ATTACHMENTS_BUCKET', kind: 'bucket' as const }] };
      return resource;
    }),
  };
  const result = compileDeployzInfrastructure({ ir: withAliases, region: null });
  const taskDefs = result.resolvedGraph.resources.filter((r) => r.cfnType === 'AWS::ECS::TaskDefinition');
  const appOf = (props: Record<string, unknown>) =>
    (props['ContainerDefinitions'] as Container[]).find((c) => (c as unknown as { Name: string }).Name === 'App')!;

  it('binds every alias on every task definition, the migration included', () => {
    expect(taskDefs.map((r) => r.logicalId).sort()).toEqual(['JobsTaskDefinition', 'MigrationTaskDefinition', 'WebTaskDefinition']);
    for (const taskDef of taskDefs) {
      const app = appOf(taskDef.properties);
      const env = app.Environment.map((e) => e.Name);
      const secrets = app.Secrets.map((s) => s.Name);
      expect(secrets).toContain('SQLALCHEMY_DATABASE_URI');
      expect(secrets).toContain('DB_PASSWORD');
      expect(env).toEqual(expect.arrayContaining(['SPRING_DATASOURCE_URL', 'DB_HOST', 'BACKEND_CACHE_REDIS_URI', 'S3_ATTACHMENTS_BUCKET']));
    }
  });

  it('copies the standard values: URL secret, master password, endpoint, JDBC URL, cache URL, bucket', () => {
    const app = appOf(taskDefs.find((r) => r.logicalId === 'WebTaskDefinition')!.properties);
    const secret = (name: string) => app.Secrets.find((s) => s.Name === name)?.ValueFrom;
    const env = (name: string) => app.Environment.find((e) => e.Name === name)?.Value;
    expect(secret('SQLALCHEMY_DATABASE_URI')).toEqual(secret('DATABASE_URL'));
    expect(secret('DB_PASSWORD')).toEqual(secret('DATABASE_PASSWORD'));
    expect(env('DB_HOST')).toEqual(env('DATABASE_HOST'));
    expect(env('BACKEND_CACHE_REDIS_URI')).toEqual(env('REDIS_URL'));
    expect(env('S3_ATTACHMENTS_BUCKET')).toEqual(env('AWS_S3_BUCKET'));
    expect(JSON.stringify(env('SPRING_DATASOURCE_URL'))).toContain('jdbc:postgresql://');
    expect(JSON.stringify(env('SPRING_DATASOURCE_URL'))).toContain(':5432/deployz?sslmode=require');
  });

  it('never replaces a standard or platform name', () => {
    const app = appOf(taskDefs.find((r) => r.logicalId === 'WebTaskDefinition')!.properties);
    expect(app.Environment.filter((e) => e.Name === 'PORT')).toHaveLength(1);
    expect(app.Secrets.filter((s) => s.Name === 'DATABASE_URL')).toHaveLength(1);
  });

  it('builds a mysql JDBC URL for a mysql database', () => {
    const mysqlBase = makeIr({ postgres: true, redis: false, dbEngine: 'mysql' });
    const mysqlIr: DeployzIR = {
      ...mysqlBase,
      resources: mysqlBase.resources.map((r) =>
        r.componentId === 'primary-db' ? { ...r, envBindings: [{ name: 'SPRING_DATASOURCE_URL', kind: 'jdbc_url' as const }] } : r,
      ),
    };
    const web = compileDeployzInfrastructure({ ir: mysqlIr, region: null }).resolvedGraph.resources.find((r) => r.logicalId === 'WebTaskDefinition')!;
    const value = appOf(web.properties).Environment.find((e) => e.Name === 'SPRING_DATASOURCE_URL')?.Value;
    expect(JSON.stringify(value)).toContain('jdbc:mysql://');
    expect(JSON.stringify(value)).toContain(':3306/deployz?sslMode=REQUIRED');
  });
});

describe('web health-check grace', () => {
  it('gives a load-balanced service 300 s before ALB health checks count, and a worker none', () => {
    const result = compileDeployzInfrastructure({ ir: makeIr({ postgres: true, redis: false, workers: [{ componentId: 'jobs', command: 'node worker.js' }] }), region: null });
    const services = result.resolvedGraph.resources.filter((r) => r.cfnType === 'AWS::ECS::Service');
    const web = services.find((r) => r.logicalId === 'WebService')!;
    const worker = services.find((r) => r.logicalId === 'JobsService')!;
    expect(web.properties['HealthCheckGracePeriodSeconds']).toBe(300);
    expect(worker.properties).not.toHaveProperty('HealthCheckGracePeriodSeconds');
  });
});

describe('IAM role boundary', () => {
  it('gives every role the relay-supplied boundary, and none when the parameter is empty', () => {
    const result = compileDeployzInfrastructure({ ir: makePhase5Ir(), region: null });
    const roles = result.resolvedGraph.resources.filter((r) => r.cfnType === 'AWS::IAM::Role');
    expect(roles.map((r) => r.resourceRole)).toEqual(expect.arrayContaining(['task-execution-role', 'task-role', 'scheduler-role']));
    for (const role of roles) {
      expect(role.properties['PermissionsBoundary'], role.logicalId).toEqual({
        'Fn::If': ['condRoleBoundary', { Ref: 'paramRoleBoundaryArn' }, { Ref: 'AWS::NoValue' }],
      });
    }
    const parameters = result.template['Parameters'] as Record<string, { Default?: unknown }>;
    expect(parameters['paramRoleBoundaryArn']?.Default).toBe('');
    expect((result.template['Conditions'] as Record<string, unknown>)['condRoleBoundary']).toEqual({
      'Fn::Not': [{ 'Fn::Equals': [{ Ref: 'paramRoleBoundaryArn' }, ''] }],
    });
  });
});
