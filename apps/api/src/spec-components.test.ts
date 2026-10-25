import { describe, expect, it } from 'vitest';

import { CAPABILITY_KEYS, type DeploymentManifest, type DeploymentOwnershipRecord, type IrWorkload } from '@deployz/contracts';

import { compileDeploymentIntent } from './compiler-artifact.js';
import {
  planComponentsFromSpec,
  specComponentIdentityByLogicalId,
  specComponentsForStatus,
} from './spec-components.js';
import type { StackEventLike } from './customer-activity.js';

// Spec-derived presentation (Phase 3) — the additive component identity the
// status payloads, plans and diagnostics carry when a deployment has a frozen
// compiled spec. Pure fixtures, no DB: compileDeploymentIntent is the same
// pure creation path the API uses.

const POSTGRES_MANIFEST: DeploymentManifest = {
  schemaVersion: 1,
  application: { root: '.', runtime: 'node', framework: 'express', dockerfilePath: 'Dockerfile' },
  build: { command: 'npm run build', context: '.' },
  web: { command: 'npm start', port: 3000 },
  health: { path: '/health' },
  database: { postgres: true },
  redis: { required: false, envBindings: [] },
  storage: { required: false, envBindings: [] },
  migration: { command: null },
  worker: { command: null },
  environment: { variables: [] },
  externalServices: [],
  unsupported: [],
};

const { spec } = compileDeploymentIntent({ manifest: POSTGRES_MANIFEST, region: 'us-east-1' });
// The spec row as stored — a plain JSON value the API re-parses defensively.
const specRow = spec as unknown as Record<string, unknown>;

function event(overrides: Partial<StackEventLike> & Pick<StackEventLike, 'logicalResourceId' | 'resourceStatus'>): StackEventLike {
  return {
    eventAt: new Date('2026-09-18T10:00:00.000Z'),
    resourceType: 'AWS::IAM::Role',
    resourceStatusReason: null,
    ...overrides,
  };
}

/** A COMPLETE event for each resource of one component the stack always creates. */
function completeEventsFor(
  records: readonly DeploymentOwnershipRecord[],
  componentId: string,
  except: string | null = null,
): StackEventLike[] {
  return records
    .filter((record) => record.componentId === componentId && record.conditional === false && record.logicalResourceId !== except)
    .map((record) => event({ logicalResourceId: record.logicalResourceId, resourceStatus: 'CREATE_COMPLETE' }));
}

describe('specComponentsForStatus', () => {
  it('is undefined without a spec, and for an uncompiled spec', () => {
    expect(specComponentsForStatus(null, [], [])).toBeUndefined();
    expect(specComponentsForStatus({}, [], [])).toBeUndefined();
  });

  it('maps event logical ids through ownership records, buckets unknown ids under "other", and never drops them', () => {
    const entries = specComponentsForStatus(
      specRow,
      [],
      [
        ...completeEventsFor(spec.ownershipRecords ?? [], 'primary-db', 'PrimaryDbInstance'),
        event({ logicalResourceId: 'WebService', resourceType: 'AWS::ECS::Service', resourceStatus: 'CREATE_IN_PROGRESS' }),
        event({ logicalResourceId: 'PrimaryDbInstance', resourceType: 'AWS::RDS::DBInstance', resourceStatus: 'CREATE_COMPLETE' }),
        event({ logicalResourceId: 'MysteryResource', resourceType: 'AWS::IAM::Policy', resourceStatus: 'CREATE_IN_PROGRESS' }),
      ],
    );
    expect(entries).toEqual([
      { componentId: 'web', label: 'Web service', state: 'IN_PROGRESS' },
      { componentId: 'primary-db', label: 'PostgreSQL database', state: 'COMPLETE' },
      // The bucket's raw resource type never reaches the customer wire.
      { componentId: 'other', label: 'Other resources', state: 'IN_PROGRESS' },
    ]);
  });

  it('labels supporting infrastructure plainly, never "Other", next to the "Other resources" bucket', () => {
    const others = (spec.ownershipRecords ?? []).filter((record) => record.componentKind === 'other');
    expect(others.length).toBeGreaterThan(0);
    const identity = specComponentIdentityByLogicalId(specRow);
    for (const record of others) {
      expect(identity?.get(record.logicalResourceId)?.label).toBe('Supporting infrastructure');
    }
  });

  it('a resource whose latest event is COMPLETE is complete, despite its earlier IN_PROGRESS event', () => {
    const entries = specComponentsForStatus(
      specRow,
      [],
      [
        ...completeEventsFor(spec.ownershipRecords ?? [], 'primary-db', 'PrimaryDbInstance'),
        event({
          logicalResourceId: 'PrimaryDbInstance',
          resourceType: 'AWS::RDS::DBInstance',
          resourceStatus: 'CREATE_COMPLETE',
          eventAt: new Date('2026-09-18T10:05:00.000Z'),
        }),
        event({ logicalResourceId: 'WebService', resourceType: 'AWS::ECS::Service', resourceStatus: 'CREATE_IN_PROGRESS' }),
        event({
          logicalResourceId: 'PrimaryDbInstance',
          resourceType: 'AWS::RDS::DBInstance',
          resourceStatus: 'CREATE_IN_PROGRESS',
          eventAt: new Date('2026-09-18T10:01:00.000Z'),
        }),
      ],
    );
    expect(entries?.find((entry) => entry.componentId === 'primary-db')?.state).toBe('COMPLETE');
    expect(entries?.find((entry) => entry.componentId === 'web')?.state).toBe('IN_PROGRESS');
  });

  it('stays in progress until every resource the stack always creates has completed', () => {
    const records = spec.ownershipRecords ?? [];
    const required = records.filter((record) => record.componentId === 'web' && record.conditional === false);
    expect(required.length).toBeGreaterThan(1);
    const started = completeEventsFor(records, 'web').slice(0, -1);
    expect(specComponentsForStatus(specRow, [], started)?.find((entry) => entry.componentId === 'web')?.state).toBe(
      'IN_PROGRESS',
    );
    expect(
      specComponentsForStatus(specRow, [], completeEventsFor(records, 'web'))?.find((entry) => entry.componentId === 'web')
        ?.state,
    ).toBe('COMPLETE');
  });

  it('ignores conditional DB subnets that a 3-AZ region never creates', () => {
    const records = spec.ownershipRecords ?? [];
    const conditional = records.filter((record) => record.componentId === 'network' && record.conditional === true);
    expect(conditional.map((record) => record.logicalResourceId)).toEqual(
      Array.from({ length: 6 }, (_, i) => `NetworkDbSubnet${i + 3}`),
    );
    const entries = specComponentsForStatus(specRow, [], completeEventsFor(records, 'network'));
    expect(entries?.find((entry) => entry.componentId === 'network')?.state).toBe('COMPLETE');
  });

  it('judges a spec frozen before the conditional flag on the events seen, as before', () => {
    const legacyRow = {
      ...specRow,
      ownershipRecords: (spec.ownershipRecords ?? []).map(({ conditional: _conditional, ...record }) => record),
    };
    const events = [
      event({ logicalResourceId: 'WebTaskDefinition', resourceStatus: 'CREATE_COMPLETE' }),
    ];
    expect(specComponentsForStatus(legacyRow, [], events)?.find((entry) => entry.componentId === 'web')?.state).toBe(
      'COMPLETE',
    );
  });

  it('a genuine failure wins FAILED; cancellation debris never does', () => {
    const failed = specComponentsForStatus(
      specRow,
      [],
      [
        event({ logicalResourceId: 'WebService', resourceType: 'AWS::ECS::Service', resourceStatus: 'CREATE_COMPLETE' }),
        event({ logicalResourceId: 'WebService', resourceType: 'AWS::ECS::Service', resourceStatus: 'UPDATE_FAILED' }),
      ],
    );
    expect(failed?.find((entry) => entry.componentId === 'web')?.state).toBe('FAILED');

    const debris = specComponentsForStatus(
      specRow,
      [],
      [
        ...completeEventsFor(spec.ownershipRecords ?? [], 'web', 'WebService'),
        event({ logicalResourceId: 'WebService', resourceType: 'AWS::ECS::Service', resourceStatus: 'CREATE_COMPLETE' }),
        event({
          logicalResourceId: 'WebService',
          resourceType: 'AWS::ECS::Service',
          resourceStatus: 'UPDATE_FAILED',
          resourceStatusReason: 'Resource update cancelled',
        }),
      ],
    );
    expect(debris?.find((entry) => entry.componentId === 'web')?.state).toBe('COMPLETE');
  });

  it('components the legacy list already report fill in where events said nothing; NOT_REQUIRED stays out', () => {
    const entries = specComponentsForStatus(
      specRow,
      [
        { key: 'runtime', label: 'Application runtime', status: 'READY' },
        { key: 'database', label: 'PostgreSQL database', status: 'IN_PROGRESS' },
        { key: 'storage', label: 'Storage', status: 'NOT_REQUIRED' },
      ],
      [],
    );
    expect(entries).toEqual([
      { componentId: 'web', label: 'Web service', state: 'COMPLETE' },
      { componentId: 'primary-db', label: 'PostgreSQL database', state: 'IN_PROGRESS' },
    ]);
  });

  it('event activity outranks the legacy state for the same component', () => {
    const entries = specComponentsForStatus(
      specRow,
      [{ key: 'runtime', label: 'Application runtime', status: 'PENDING' }],
      [
        ...completeEventsFor(spec.ownershipRecords ?? [], 'web', 'WebService'),
        event({ logicalResourceId: 'WebService', resourceType: 'AWS::ECS::Service', resourceStatus: 'CREATE_COMPLETE' }),
      ],
    );
    expect(entries).toEqual([{ componentId: 'web', label: 'Web service', state: 'COMPLETE' }]);
  });
});

describe('planComponentsFromSpec', () => {
  it('names a worker by its own label, so the plan never lists "Application" twice', () => {
    const { spec: workerSpec } = compileDeploymentIntent({
      manifest: { ...POSTGRES_MANIFEST, worker: { command: 'node worker.js' } },
      region: 'us-east-1',
    });
    const names = planComponentsFromSpec(workerSpec, 'destroy', false).map((entry) => entry.name);
    expect(names.filter((name) => name === 'Application')).toHaveLength(1);
    expect(names).toContain('Background worker');
  });

  it('keeps the plan builder wording and actions for the catalog kinds, and adds componentId/group', () => {
    expect(planComponentsFromSpec(spec, 'install', false)).toEqual([
      { kind: 'application', name: 'Application', action: 'CREATE', lifecycle: 'delete', componentId: 'web', group: 'application' },
      { kind: 'endpoint', name: 'Secure endpoint', action: 'CREATE', lifecycle: 'delete', componentId: 'endpoint', group: 'edge' },
      { kind: 'database', name: 'Database', action: 'CREATE', lifecycle: 'retain', componentId: 'primary-db', group: 'data' },
      { kind: 'storage', name: 'Storage', action: 'CREATE', lifecycle: 'retain', componentId: 'storage', group: 'storage' },
    ]);
    expect(planComponentsFromSpec(spec, 'destroy', false).map((entry) => entry.action)).toEqual([
      'DELETE',
      'DELETE',
      'RETAIN',
      'RETAIN',
    ]);
    expect(planComponentsFromSpec(spec, 'update', true).map((entry) => entry.action)).toEqual([
      'UPDATE',
      'UNCHANGED',
      'UNCHANGED',
      'UNCHANGED',
    ]);
    expect(planComponentsFromSpec(spec, 'update', false).map((entry) => entry.action)).toEqual([
      'UNCHANGED',
      'UNCHANGED',
      'UNCHANGED',
      'UNCHANGED',
    ]);
  });

  it('keeps distinct IR labels for wire-level kinds; catalog parity overrides still apply', () => {
    // The cache catalog kind keeps the builder's wording (legacy parity).
    const redisSpec = compileDeploymentIntent({
      manifest: { ...POSTGRES_MANIFEST, redis: { required: true, envBindings: [] } },
      region: 'us-east-1',
    }).spec;
    expect(
      planComponentsFromSpec(redisSpec, 'install', false).map((entry) => [entry.kind, entry.name]),
    ).toContainEqual(['cache', 'Cache']);

    // Wire-level worker kinds keep the IR label verbatim — two workers stay
    // distinct instead of collapsing into the generic "Background worker".
    const web = spec.ir.workloads[0]!;
    const worker = (componentId: string, label: string): IrWorkload => ({
      ...web,
      componentId,
      kind: 'worker',
      label,
      command: 'node worker.js',
      port: null,
      public: false,
      healthCheck: null,
      compute: { ...web.compute, capabilityKey: CAPABILITY_KEYS.ECS_FARGATE_TASK },
    });
    const twoWorkers = {
      ...spec,
      ir: { ...spec.ir, workloads: [web, worker('worker-a', 'Email worker'), worker('worker-b', 'Jobs worker')] },
    };
    expect(
      planComponentsFromSpec(twoWorkers, 'install', false)
        .filter((entry) => entry.kind === 'worker')
        .map((entry) => entry.name),
    ).toEqual(['Email worker', 'Jobs worker']);
  });
});

describe('specComponentIdentityByLogicalId', () => {
  it('resolves the blamed logical id and is null without a spec', () => {
    expect(specComponentIdentityByLogicalId(specRow)!.get('PrimaryDbInstance')).toEqual({
      componentId: 'primary-db',
      label: 'PostgreSQL database',
    });
    expect(specComponentIdentityByLogicalId(null)).toBeNull();
  });
});
