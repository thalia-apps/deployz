import { describe, expect, it } from 'vitest';

import {
  deploymentOwnershipRecordSchema,
  deployzTaskFamily,
  migrationTaskFromSpec,
  oneShotContainerCommand,
  oneShotTasksFromSpec,
  requirementsFromSpec,
  resourceChecksFromSpec,
  taskFamilySuffix,
  taskFamilySuffixForSpec,
  workloadContainerCommand,
  workloadServicesFromSpec,
  type DeploymentSpecV2,
} from './deployment-spec-v2.js';

/** The spec helpers only read the compiled fields and the IR workload kinds. */
function specWith(
  contract: unknown,
  ownershipRecords?: unknown,
  workloads: ReadonlyArray<{ componentId: string; kind: string }> = [],
): DeploymentSpecV2 {
  return { verificationContract: contract, ownershipRecords, ir: { workloads } } as unknown as DeploymentSpecV2;
}

function taskRecord(componentId: string, logicalResourceId: string): Record<string, unknown> {
  return { componentId, componentKind: 'application', capability: 'aws.ecs-fargate-service', logicalResourceId, physicalResourceId: null, stateful: false, retention: 'delete', purgeStrategy: null };
}

describe('workloadServicesFromSpec', () => {
  it('maps one compute check per workload to its service logical id', () => {
    const spec = specWith({
      checks: [
        { componentId: 'web', componentKind: 'application', capability: 'aws.ecs-fargate-service', check: 'compute', primaryResourceType: 'AWS::ECS::Service', logicalId: 'WebService' },
        { componentId: 'endpoint', componentKind: 'endpoint', capability: 'aws.alb', check: 'ingress', primaryResourceType: 'AWS::ElasticLoadBalancingV2::LoadBalancer', logicalId: 'EndpointLoadBalancer' },
        { componentId: 'email-worker', componentKind: 'application', capability: 'aws.ecs-fargate-service', check: 'compute', primaryResourceType: 'AWS::ECS::Service', logicalId: 'EmailWorkerService' },
      ],
    });
    expect(workloadServicesFromSpec(spec)).toEqual([
      { id: 'web', serviceLogicalId: 'WebService' },
      { id: 'email-worker', serviceLogicalId: 'EmailWorkerService' },
    ]);
    expect(requirementsFromSpec(spec)).toEqual({ databaseRequired: false, redisRequired: false });
  });

  it('is null on an uncompiled spec', () => {
    expect(workloadServicesFromSpec(specWith(null))).toBeNull();
  });
});

describe('migrationTaskFromSpec', () => {
  it('finds the one-shot migration task definition among the ownership records', () => {
    const spec = specWith(
      {
        checks: [
          { componentId: 'web', componentKind: 'application', capability: 'aws.ecs-fargate-service', check: 'compute', primaryResourceType: 'AWS::ECS::Service', logicalId: 'WebService' },
        ],
      },
      [
        { componentId: 'web', componentKind: 'application', capability: 'aws.ecs-fargate-service', logicalResourceId: 'WebService', physicalResourceId: null, stateful: false, retention: 'delete', purgeStrategy: null },
        { componentId: 'migration', componentKind: 'application', capability: 'aws.ecs-fargate-service', logicalResourceId: 'MigrationTaskDefinition', physicalResourceId: null, stateful: false, retention: 'delete', purgeStrategy: null },
      ],
      [
        { componentId: 'web', kind: 'web' },
        { componentId: 'migration', kind: 'migration' },
      ],
    );
    expect(migrationTaskFromSpec(spec, '')).toEqual({
      id: 'migration',
      taskLogicalId: 'MigrationTaskDefinition',
      family: 'DeployzAppMigration',
    });
  });

  it('is null when the spec has no migration workload or is uncompiled', () => {
    const noMigration = specWith(
      { checks: [] },
      [{ componentId: 'web', componentKind: 'application', capability: 'aws.ecs-fargate-service', logicalResourceId: 'WebService', physicalResourceId: null, stateful: false, retention: 'delete', purgeStrategy: null }],
    );
    expect(migrationTaskFromSpec(noMigration, '')).toBeNull();
    expect(migrationTaskFromSpec(specWith(null, null), '')).toBeNull();
  });

  it('never mistakes a scheduled job (also a one-shot task definition) for the migration', () => {
    const spec = specWith(
      { checks: [] },
      [taskRecord('cleanup', 'CleanupTaskDefinition'), taskRecord('migration', 'MigrationTaskDefinition')],
      [
        { componentId: 'cleanup', kind: 'scheduled-job' },
        { componentId: 'migration', kind: 'migration' },
      ],
    );
    expect(migrationTaskFromSpec(spec, '')?.id).toBe('migration');
    expect(oneShotTasksFromSpec(spec, 'scheduled-job', '')).toEqual([
      { id: 'cleanup', taskLogicalId: 'CleanupTaskDefinition', family: 'DeployzAppCleanup' },
    ]);
    const jobOnly = specWith({ checks: [] }, [taskRecord('cleanup', 'CleanupTaskDefinition')], [{ componentId: 'cleanup', kind: 'scheduled-job' }]);
    expect(migrationTaskFromSpec(jobOnly, '')).toBeNull();
  });

  it('the family mirrors the compiler Family field (golden parity)', () => {
    expect(deployzTaskFamily('migration', '')).toBe('DeployzAppMigration');
    expect(deployzTaskFamily('web', '')).toBe('DeployzAppWeb');
    expect(deployzTaskFamily('email-worker', '')).toBe('DeployzAppEmailWorker');
    expect(deployzTaskFamily('migration', 'a1b2c3')).toBe('DeployzAppMigrationa1b2c3');
  });
});

describe('task-family suffix', () => {
  const INSTALLATION = '9F3AB2C1-1234-4abc-9def-0123456789ab';
  const compiledBy = (compilerVersion: string | null) => ({ compilerVersion }) as unknown as DeploymentSpecV2;

  it('is the installation id letters and digits, lower-cased — unique per installation', () => {
    expect(taskFamilySuffix(INSTALLATION)).toBe('9f3ab2c112344abc9def0123456789ab');
    expect(taskFamilySuffix('aaaaaaaa-0000-0000-0000-000000000000')).not.toBe(
      taskFamilySuffix('aaaaaaaa-0000-0000-0000-000000000001'),
    );
  });

  it('keeps the shared names of an artifact compiled before installation-scoped families', () => {
    expect(taskFamilySuffixForSpec(compiledBy('dynamic-compiler-v2-1'), INSTALLATION)).toBe('');
    expect(taskFamilySuffixForSpec(compiledBy('dynamic-compiler-v2-2'), INSTALLATION)).toBe('');
    expect(taskFamilySuffixForSpec(compiledBy(null), null)).toBe('');
  });

  it('scopes every newer artifact to its installation, and names nothing without one', () => {
    expect(taskFamilySuffixForSpec(compiledBy('dynamic-compiler-v2-3'), INSTALLATION)).toBe(taskFamilySuffix(INSTALLATION));
    expect(taskFamilySuffixForSpec(compiledBy('dynamic-compiler-v2-3'), null)).toBeNull();
    expect(taskFamilySuffixForSpec(compiledBy('dynamic-compiler-v2-3'), '---')).toBeNull();
  });

  it('two installations of the same spec name different one-shot families', () => {
    const spec = specWith({ checks: [] }, [taskRecord('migration', 'MigrationTaskDefinition')], [
      { componentId: 'migration', kind: 'migration' },
    ]);
    const a = migrationTaskFromSpec(spec, taskFamilySuffix('aaaaaaaa-0000'))!.family;
    const b = migrationTaskFromSpec(spec, taskFamilySuffix('bbbbbbbb-0000'))!.family;
    expect(a).toBe('DeployzAppMigrationaaaaaaaa0000');
    expect(b).toBe('DeployzAppMigrationbbbbbbbb0000');
    // Still the relay's trust-boundary shape, so relays already in customer
    // accounts accept the scoped names.
    for (const family of [a, b]) expect(family).toMatch(/^DeployzApp[A-Za-z0-9]+$/);
  });
});

describe('resourceChecksFromSpec', () => {
  it('carries only the checks outside the fixed catalog', () => {
    const spec = specWith({
      checks: [
        { componentId: 'web', componentKind: 'application', capability: 'aws.ecs-fargate-service', check: 'compute', primaryResourceType: 'AWS::ECS::Service', logicalId: 'WebService' },
        { componentId: 'endpoint', componentKind: 'endpoint', capability: 'aws.alb', check: 'ingress', primaryResourceType: 'AWS::ElasticLoadBalancingV2::LoadBalancer', logicalId: 'EndpointLoadBalancer' },
        { componentId: 'jobs', componentKind: 'queue', capability: 'aws.sqs-queue', check: 'queue', primaryResourceType: 'AWS::SQS::Queue', logicalId: 'JobsQueue' },
        { componentId: 'cleanup', componentKind: 'application', capability: 'aws.scheduler-schedule', check: 'schedule', primaryResourceType: 'AWS::Scheduler::Schedule', logicalId: 'CleanupSchedule' },
      ],
    });
    expect(resourceChecksFromSpec(spec)).toEqual([
      { componentId: 'jobs', check: 'queue', logicalId: 'JobsQueue', resourceType: 'AWS::SQS::Queue' },
      { componentId: 'cleanup', check: 'schedule', logicalId: 'CleanupSchedule', resourceType: 'AWS::Scheduler::Schedule' },
    ]);
  });

  it('is empty on an uncompiled spec or a spec with only catalog checks', () => {
    expect(resourceChecksFromSpec(specWith(null))).toEqual([]);
    expect(
      resourceChecksFromSpec(
        specWith({
          checks: [{ componentId: 'web', componentKind: 'application', capability: 'aws.ecs-fargate-service', check: 'compute', primaryResourceType: 'AWS::ECS::Service', logicalId: 'WebService' }],
        }),
      ),
    ).toEqual([]);
  });
});

describe('container commands', () => {
  it('a one-shot command replaces the image ENTRYPOINT with sh -c, and a worker command stays an argument list', () => {
    expect(oneShotContainerCommand('npm run db:migrate')).toEqual({ entryPoint: ['sh', '-c'], command: ['npm run db:migrate'] });
    expect(workloadContainerCommand('node worker.js')).toEqual(['sh', '-c', 'node worker.js']);
  });
});

describe('deploymentOwnershipRecordSchema', () => {
  it('parses a record frozen before the conditional flag, and one that carries it', () => {
    const legacy = taskRecord('web', 'WebService');
    expect(deploymentOwnershipRecordSchema.parse(legacy)).toEqual(legacy);
    expect(deploymentOwnershipRecordSchema.parse({ ...legacy, conditional: true }).conditional).toBe(true);
  });
});
