import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import {
  DEFAULT_APPLICATION_STACK_NAME,
  DEFAULT_BOOTSTRAP_STACK_NAME,
  DESTROY_PENDING_STALE_AFTER_MS,
  deploymentStateAfterFailedJob,
  PACKAGE_NAME,
  REGION_LABELS,
  SUPPORTED_AWS_REGIONS,
  applicationSchema,
  releaseImageTag,
  applicationStackNameForInstallation,
  billingCheckoutIntentStatusSchema,
  billingProviderSchema,
  billingReconciliationStatusSchema,
  billingSubscriptionSchema,
  billingSubscriptionStatusSchema,
  bootstrapStackName,
  bootstrapTemplateBucketName,
  componentProgressStatusSchema,
  customDomainStatusSchema,
  customerDeploymentStatusSchema,
  customerSchema,
  deploymentJobSchema,
  deploymentSchema,
  deploymentStageSchema,
  deploymentStepSchema,
  DEPLOYMENT_STEP_ORDER,
  TYPICAL_STEP_DURATION_SECONDS,
  errorEnvelopeSchema,
  eventLogSchema,
  failureCodeSchema,
  healthComponentsSchema,
  isSupportedRegion,
  organizationSchema,
  regionSchema,
  relayCommandProgressSchema,
  relayStackEventSchema,
  releaseSchema,
  resolveBootstrapTemplate,
  userSchema,
  vendorDeploymentStatusSchema,
  vendorStackEventSchema,
} from './index.js';

describe('@deployz/contracts scaffold', () => {
  it('exports the package name placeholder', () => {
    expect(PACKAGE_NAME).toBe('@deployz/contracts');
  });
});

// Parity law: every contracts enum is EXACTLY the live db pgEnum vocabulary.
// The parity test lives in packages/db/src/contracts-parity.test.ts with the
// reverse orientation (db enums vs contracts schemas), so the two packages
// keep a single dependency direction (db -> contracts) and the task graph
// stays acyclic.

describe('failureCodeSchema (§61 stable taxonomy)', () => {
  it('rejects a code outside the taxonomy', () => {
    expect(() => failureCodeSchema.parse('NOT_A_REAL_CODE')).toThrow(ZodError);
  });

  it('parses every real §61 code', () => {
    for (const code of failureCodeSchema.options) {
      expect(failureCodeSchema.parse(code)).toBe(code);
    }
  });

  // Redis MVP task 3: the two new codes must be present in the contracts
  // mirror explicitly, not merely covered by the generic parity loop above.
  it('includes the two Redis failure codes', () => {
    expect(failureCodeSchema.options).toContain('REDIS_PROVISIONING_FAILED');
    expect(failureCodeSchema.options).toContain('REDIS_CONNECTION_FAILED');
  });

  // CANARY-006: the relay's own state-persistence failure is a Deployz-side
  // fault, not a customer resource failure — it needs its own code so it
  // stops being reported as STACK_CREATE_FAILED.
  it('includes the relay state-write failure code', () => {
    expect(failureCodeSchema.options).toContain('RELAY_STATE_WRITE_FAILED');
  });

  // RDS AZ placement: RDS reporting no capacity for the requested instance
  // class needs its own code so it stops being reported as the generic
  // DATABASE_CREATE_FAILED.
  it('includes the RDS AZ-capacity failure code', () => {
    expect(failureCodeSchema.options).toContain('RDS_AZ_CAPACITY');
  });
});

describe('billing enums (Paddle migration Phase 3)', () => {
  it('billingProviderSchema accepts PADDLE only', () => {
    expect(billingProviderSchema.options).toEqual(['PADDLE']);
  });

  it('billingSubscriptionStatusSchema accepts the four subscription states', () => {
    expect(billingSubscriptionStatusSchema.options).toEqual([
      'ACTIVE',
      'PAST_DUE',
      'PAUSED',
      'CANCELED',
    ]);
  });

  it('billingReconciliationStatusSchema accepts the three reconciliation outcomes', () => {
    expect(billingReconciliationStatusSchema.options).toEqual(['SUCCEEDED', 'FAILED', 'SKIPPED']);
  });

  it('billingCheckoutIntentStatusSchema accepts the four checkout intent states', () => {
    expect(billingCheckoutIntentStatusSchema.options).toEqual([
      'PENDING',
      'COMPLETED',
      'FAILED',
      'EXPIRED',
    ]);
  });
});

// Round-trip law: a db row (Date objects) crosses the wire as JSON, so the
// contract must parse the JSON form back to EXACTLY the wire object — wire
// types are ISO strings, not Dates.
describe('core-object round-trip (db row -> JSON -> schema.parse -> wire)', () => {
  const created = new Date('2026-08-01T09:00:00.000Z');
  const updated = new Date('2026-08-02T10:30:00.000Z');

  const cases: Array<[string, object, { parse: (input: unknown) => unknown }]> = [
    [
      'Organization',
      {
        id: 'org_01JABC',
        name: 'ada',
        slug: 'ada-12345678',
        logo: null,
        metadata: null,
        createdAt: created,
        updatedAt: updated,
      },
      organizationSchema,
    ],
    [
      'BillingSubscription',
      {
        id: crypto.randomUUID(),
        organizationId: 'org_01JABC',
        provider: 'PADDLE',
        providerCustomerId: 'ctm_01JABC',
        providerSubscriptionId: 'sub_01JABC',
        status: 'ACTIVE',
        currentPeriodStart: created,
        currentPeriodEnd: updated,
        scheduledChangeAction: null,
        scheduledChangeAt: null,
        lastProviderEventAt: updated,
        lastReconciledAt: null,
        createdAt: created,
        updatedAt: updated,
      },
      billingSubscriptionSchema,
    ],
    [
      'User',
      {
        id: 'user_01JABC',
        name: 'Ada',
        email: 'ada@example.com',
        emailVerified: false,
        image: null,
        createdAt: created,
        updatedAt: updated,
      },
      userSchema,
    ],
    [
      'Application',
      {
        id: crypto.randomUUID(),
        organizationId: 'org_01JABC',
        name: 'shop',
        githubInstallationId: null,
        repoFullName: 'acme/shop',
        repoUrl: 'https://github.com/acme/shop',
        defaultBranch: 'main',
        containerPort: null,
        healthPath: null,
        migrationCommand: null,
        workerCommand: null,
        databaseRequired: false,
        storageRequired: false,
        redisRequired: false,
        analysisStatus: 'COMPLETE',
        compatibilityStatus: 'READY',
        compatibilityReason: null,
        detectedMetadata: { framework: 'nextjs', port: 3000 },
        createdAt: created,
        updatedAt: updated,
        createdBy: null,
        updatedBy: null,
      },
      applicationSchema,
    ],
    [
      'Release',
      {
        id: crypto.randomUUID(),
        applicationId: crypto.randomUUID(),
        version: '1.4.2',
        gitSha: '0123456789abcdef',
        imageDigest: 'sha256:deadbeef',
        migrationCommand: null,
        buildStatus: 'PENDING',
        releaseStatus: 'READY',
        createdAt: created,
        updatedAt: updated,
        createdBy: null,
        updatedBy: null,
      },
      releaseSchema,
    ],
    [
      'Customer',
      {
        id: crypto.randomUUID(),
        organizationId: 'org_01JABC',
        name: 'Customer Co',
        email: 'ops@customer.co',
        company: 'Customer Co Ltd',
        externalReference: null,
        createdAt: created,
        updatedAt: updated,
      },
      customerSchema,
    ],
    [
      'Deployment',
      {
        id: crypto.randomUUID(),
        customerId: crypto.randomUUID(),
        applicationId: crypto.randomUUID(),
        organizationId: 'org_01JABC',
        region: 'us-east-1',
        state: 'HEALTHY',
        awsAccountId: null,
        currentReleaseId: null,
        previousReleaseId: null,
        relayStatus: 'CONNECTED',
        healthStatus: 'HEALTHY',
        desiredState: { image: 'shop:1.4.2' },
        observedState: null,
        stepTimings: null,
        infraVersion: 'runtime-v1',
        installationId: 'inst_01JABC',
        deploymentType: 'PRODUCTION',
        billingState: 'NOT_STARTED',
        billingStartedAt: null,
        billingStoppedAt: null,
        lastHealthAt: updated,
        deletedAt: null,
        cleanupState: null,
        createdAt: created,
        updatedAt: updated,
        createdBy: null,
        updatedBy: null,
      },
      deploymentSchema,
    ],
    [
      'DeploymentJob',
      {
        id: crypto.randomUUID(),
        deploymentId: crypto.randomUUID(),
        type: 'INSTALL',
        state: 'SUCCEEDED',
        idempotencyKey: 'install-01JABC',
        payload: { releaseId: 'abc' },
        result: { ok: true },
        failureCode: null,
        requestedBy: 'user_01JABC',
        startedAt: created,
        finishedAt: updated,
        createdAt: created,
        updatedAt: updated,
        createdBy: null,
        updatedBy: null,
      },
      deploymentJobSchema,
    ],
    [
      'EventLog',
      {
        id: 42,
        occurredAt: created,
        actorType: 'user',
        actorId: 'user_01JABC',
        organizationId: 'org_01JABC',
        customerId: crypto.randomUUID(),
        deploymentId: crypto.randomUUID(),
        jobId: null,
        releaseId: null,
        eventType: 'install.requested',
        previousState: null,
        requestedState: 'NOT_INSTALLED',
        result: null,
        payload: {},
      },
      eventLogSchema,
    ],
  ];

  for (const [name, row, schema] of cases) {
    it(`${name}: JSON wire form parses back to itself`, () => {
      const wire = JSON.parse(JSON.stringify(row)) as unknown;
      expect(schema.parse(wire)).toStrictEqual(wire);
    });
  }
});

describe('errorEnvelopeSchema', () => {
  it('parses a minimal envelope (details optional)', () => {
    const envelope = { error: { code: 'UNAUTHORIZED', message: 'Authentication required' } };
    expect(errorEnvelopeSchema.parse(envelope)).toStrictEqual(envelope);
  });

  it('parses an envelope carrying details', () => {
    const envelope = {
      error: { code: 'PORT_MISMATCH', message: 'Port 8080 is not exposed', details: { port: 8080 } },
    };
    expect(errorEnvelopeSchema.parse(envelope)).toStrictEqual(envelope);
  });

  it('rejects an envelope without a message', () => {
    expect(() => errorEnvelopeSchema.parse({ error: { code: 'UNAUTHORIZED' } })).toThrow(ZodError);
  });
});

describe('stack name constants', () => {
  it('names the application stack', () => {
    expect(DEFAULT_APPLICATION_STACK_NAME).toBe('deployz-app');
  });

  it('does not collide with the bootstrap stack name', () => {
    expect(DEFAULT_APPLICATION_STACK_NAME).not.toBe(DEFAULT_BOOTSTRAP_STACK_NAME);
  });
});

// The §32 supported-region source is the SINGLE canonical list every consumer
// derives from — API/UI validation, bootstrap publishing and the install-link
// resolver. It must stay exactly the 17-region allowlist the db enum already
// locks (regionSchema parity is asserted above); these tests lock the derived
// behavior on top of it.
describe('SUPPORTED_AWS_REGIONS / REGION_LABELS / isSupportedRegion', () => {
  it('keeps the 17-region allowlist', () => {
    expect(SUPPORTED_AWS_REGIONS).toHaveLength(17);
    expect(SUPPORTED_AWS_REGIONS).toContain('us-east-1');
    expect(SUPPORTED_AWS_REGIONS).toContain('us-east-2');
  });

  it('regionSchema is derived from the canonical list (no drift)', () => {
    expect([...regionSchema.options].sort()).toEqual([...SUPPORTED_AWS_REGIONS].sort());
  });

  it('labels every supported region', () => {
    for (const region of SUPPORTED_AWS_REGIONS) {
      expect(REGION_LABELS[region]).toBeDefined();
      expect(REGION_LABELS[region].length).toBeGreaterThan(0);
    }
  });

  it('isSupportedRegion accepts only allowlisted regions', () => {
    expect(isSupportedRegion('us-east-2')).toBe(true);
    expect(isSupportedRegion('eu-west-1')).toBe(true);
    expect(isSupportedRegion('mars-1')).toBe(false);
    expect(isSupportedRegion('')).toBe(false);
  });
});

describe('bootstrapTemplateBucketName', () => {
  it('derives the deterministic regional bucket name', () => {
    expect(bootstrapTemplateBucketName('us-east-1')).toBe('deployz-templates-us-east-1');
    expect(bootstrapTemplateBucketName('us-east-2')).toBe('deployz-templates-us-east-2');
  });

  it('honours a non-production prefix', () => {
    expect(bootstrapTemplateBucketName('us-east-1', 'deployz-staging-templates')).toBe(
      'deployz-staging-templates-us-east-1',
    );
  });
});

describe('resolveBootstrapTemplate', () => {
  it('resolves the regional template URL for a supported region', () => {
    const url = resolveBootstrapTemplate('us-east-2');
    expect(url).toBe(
      'https://deployz-templates-us-east-2.s3.us-east-2.amazonaws.com/bootstrap/v1/bootstrap-template-v1.json',
    );
  });

  it('never resolves an unsupported region (fails closed)', () => {
    expect(resolveBootstrapTemplate('mars-1')).toBeUndefined();
    expect(resolveBootstrapTemplate('us-gov-west-1')).toBeUndefined();
  });

  it('does not resolve a supported-but-unpublished region (fails closed)', () => {
    expect(resolveBootstrapTemplate('us-east-2', { deployableRegions: ['us-east-1'] })).toBeUndefined();
  });

  it('honors the legacy URL for us-east-1 only', () => {
    const legacy = 'https://legacy-bucket.s3.us-east-1.amazonaws.com/bootstrap/v1/bootstrap-template-v1.json';
    expect(resolveBootstrapTemplate('us-east-1', { legacyUrl: legacy })).toBe(legacy);
  });

  it('never lets the legacy URL fall back across regions (no cross-region link)', () => {
    const legacy = 'https://legacy-bucket.s3.us-east-1.amazonaws.com/bootstrap/v1/bootstrap-template-v1.json';
    // us-east-2 must resolve to ITS OWN bucket, not the legacy us-east-1 one.
    expect(resolveBootstrapTemplate('us-east-2', { legacyUrl: legacy })).toBe(
      'https://deployz-templates-us-east-2.s3.us-east-2.amazonaws.com/bootstrap/v1/bootstrap-template-v1.json',
    );
  });

  it('does not fall back to a legacy URL for us-east-1 when the legacy URL is absent', () => {
    expect(resolveBootstrapTemplate('us-east-1')).toBe(
      'https://deployz-templates-us-east-1.s3.us-east-1.amazonaws.com/bootstrap/v1/bootstrap-template-v1.json',
    );
  });

  it('resolves a legacy URL for us-east-1 even when the deployable set is empty', () => {
    // The legacy URL IS the confirmation that us-east-1 is published, so it
    // must not be gated behind the deployable set.
    const legacy = 'https://legacy-bucket.s3.us-east-1.amazonaws.com/bootstrap/v1/bootstrap-template-v1.json';
    expect(resolveBootstrapTemplate('us-east-1', { legacyUrl: legacy, deployableRegions: [] })).toBe(legacy);
  });
});

describe('bootstrapStackName', () => {
  const deploymentId = '1b2e3d4f-5678-4abc-9def-0123456789ab';

  it('derives a readable slug + short-id name for the first attempt', () => {
    expect(bootstrapStackName({ appName: 'Documenso', deploymentId })).toBe(
      'deployz-bootstrap-documenso-1b2e3d4f',
    );
  });

  it('gives two deployments of the same app different names', () => {
    const other = 'ffffffff-0000-4abc-9def-0123456789ab';
    expect(bootstrapStackName({ appName: 'Documenso', deploymentId: other })).not.toBe(
      bootstrapStackName({ appName: 'Documenso', deploymentId }),
    );
  });

  it('appends a fresh attempt suffix from attempt 1 on', () => {
    const first = bootstrapStackName({ appName: 'Documenso', deploymentId, attempt: 0 });
    const retry = bootstrapStackName({ appName: 'Documenso', deploymentId, attempt: 1 });
    expect(first).toBe('deployz-bootstrap-documenso-1b2e3d4f');
    expect(retry).toBe('deployz-bootstrap-documenso-1b2e3d4f-r1');
    expect(bootstrapStackName({ appName: 'Documenso', deploymentId, attempt: 2 })).toBe(
      'deployz-bootstrap-documenso-1b2e3d4f-r2',
    );
  });

  it('is deterministic for the same inputs', () => {
    expect(bootstrapStackName({ appName: 'Documenso', deploymentId, attempt: 1 })).toBe(
      bootstrapStackName({ appName: 'Documenso', deploymentId, attempt: 1 }),
    );
  });

  it('collapses symbols and whitespace in the application name', () => {
    expect(bootstrapStackName({ appName: 'My App!! (v2)', deploymentId })).toBe(
      'deployz-bootstrap-my-app-v2-1b2e3d4f',
    );
  });

  it('caps the slug so the name stays under the CFN 128-char limit', () => {
    const name = bootstrapStackName({ appName: 'a'.repeat(200), deploymentId, attempt: 12 });
    expect(name.length).toBeLessThan(128);
    expect(name).toMatch(/^deployz-bootstrap-a{24}-1b2e3d4f-r12$/);
  });

  it('omits an empty slug rather than emitting a double hyphen', () => {
    expect(bootstrapStackName({ appName: '!!!', deploymentId })).toBe(
      'deployz-bootstrap-1b2e3d4f',
    );
  });

  it('only emits CFN-legal stack-name characters', () => {
    const name = bootstrapStackName({ appName: 'Ünïcødé App 42%', deploymentId, attempt: 3 });
    expect(name).toMatch(/^[a-zA-Z0-9-]+$/);
  });
});

describe('applicationStackNameForInstallation', () => {
  it('derives the app stack name from the installation id', () => {
    expect(
      applicationStackNameForInstallation('9F3AB2C1-1234-4abc-9def-0123456789ab'),
    ).toBe('deployz-app-9f3ab2c1');
  });

  it('gives two installations different app stack names', () => {
    expect(applicationStackNameForInstallation('aaaaaaaa-0000-0000-0000-000000000000')).not.toBe(
      applicationStackNameForInstallation('bbbbbbbb-0000-0000-0000-000000000000'),
    );
  });

  it('keeps only CFN-legal characters from the installation id', () => {
    expect(applicationStackNameForInstallation('i-1a_2b!3c')).toBe('deployz-app-i1a2b3c');
  });

  it('falls back to the default when no installation id is known', () => {
    expect(applicationStackNameForInstallation('')).toBe(DEFAULT_APPLICATION_STACK_NAME);
  });
});

describe('healthComponentsSchema', () => {
  it('accepts a redis component', () => {
    expect(healthComponentsSchema.parse({ redis: 'HEALTHY' })).toStrictEqual({
      redis: 'HEALTHY',
    });
  });

  it('accepts a workload-id key (Phase 4A per-workload health)', () => {
    expect(healthComponentsSchema.parse({ web: 'HEALTHY', 'email-worker': 'DEGRADED' })).toStrictEqual({
      web: 'HEALTHY',
      'email-worker': 'DEGRADED',
    });
  });

  it('still rejects an invalid status on any key', () => {
    expect(() => healthComponentsSchema.parse({ queue: 'FINE' })).toThrow(ZodError);
  });
});

describe('DESTROY_PENDING_STALE_AFTER_MS', () => {
  it('is the 60-minute escape-hatch threshold', () => {
    expect(DESTROY_PENDING_STALE_AFTER_MS).toBe(60 * 60 * 1000);
  });
});

// Unified deployment status — schema-level checks. The derivation itself
// (every stage/precedence rule) is unit-tested in
// apps/api/src/deployment-status.test.ts; this only checks the wire shapes.
describe('deploymentStageSchema', () => {
  it('is exactly the six documented stages', () => {
    expect([...deploymentStageSchema.options].sort()).toEqual(
      ['CONNECTING', 'FAILED', 'PROVISIONING', 'READY', 'VERIFYING', 'WAITING_FOR_AWS'].sort(),
    );
  });
});

describe('componentProgressStatusSchema', () => {
  it('is exactly the five documented statuses', () => {
    expect([...componentProgressStatusSchema.options].sort()).toEqual(
      ['FAILED', 'IN_PROGRESS', 'NOT_REQUIRED', 'PENDING', 'READY'].sort(),
    );
  });
});

describe('deploymentStepSchema', () => {
  it('is exactly the eleven documented steps', () => {
    expect([...deploymentStepSchema.options].sort()).toEqual(
      [
        'AWS_SETUP',
        'RELAY_CONNECT',
        'PREPARING',
        'NETWORK',
        'DATABASE_STORAGE',
        'REDIS',
        'MIGRATION',
        'APPLICATION',
        'HEALTH_CHECK',
        'TLS',
        'READY',
      ].sort(),
    );
  });

  it('DEPLOYMENT_STEP_ORDER carries every step exactly once, TLS after HEALTH_CHECK', () => {
    expect([...DEPLOYMENT_STEP_ORDER].sort()).toEqual([...deploymentStepSchema.options].sort());
    expect(DEPLOYMENT_STEP_ORDER.indexOf('TLS')).toBeGreaterThan(DEPLOYMENT_STEP_ORDER.indexOf('HEALTH_CHECK'));
  });

  it('MIGRATION sits between the cache (REDIS) and the application', () => {
    expect(DEPLOYMENT_STEP_ORDER.indexOf('MIGRATION')).toBeGreaterThan(DEPLOYMENT_STEP_ORDER.indexOf('REDIS'));
    expect(DEPLOYMENT_STEP_ORDER.indexOf('APPLICATION')).toBeGreaterThan(DEPLOYMENT_STEP_ORDER.indexOf('MIGRATION'));
  });

  it('TYPICAL_STEP_DURATION_SECONDS covers every step, null only for TLS/READY', () => {
    for (const step of DEPLOYMENT_STEP_ORDER) {
      const range = TYPICAL_STEP_DURATION_SECONDS[step];
      if (step === 'TLS' || step === 'READY') {
        expect(range).toBeNull();
      } else {
        expect(range).not.toBeNull();
        expect(range!.min).toBeLessThanOrEqual(range!.max);
      }
    }
  });
});

describe('customerDeploymentStatusSchema', () => {
  const minimal = {
    stage: 'WAITING_FOR_AWS',
    updatedAt: '2026-08-31T12:00:00.000Z',
    currentActivity: 'Waiting for AWS setup to start.',
    step: 'AWS_SETUP',
    steps: ['AWS_SETUP', 'RELAY_CONNECT', 'PREPARING', 'NETWORK', 'APPLICATION', 'HEALTH_CHECK', 'TLS', 'READY'],
    typicalDurationSeconds: { min: 60, max: 300 },
    takingLongerThanUsual: false,
    removed: false,
    statusUpdatesUnavailable: false,
    needsDomainSetup: false,
    components: [],
    url: null,
    failure: null,
  };

  it('parses the minimal (no-failure) shape', () => {
    expect(customerDeploymentStatusSchema.parse(minimal)).toStrictEqual(minimal);
  });

  it('parses a failure with a technical block', () => {
    const withFailure = {
      ...minimal,
      stage: 'FAILED',
      failure: {
        ownedByApplication: true,
        customerActionRequired: false,
        customerMessage: 'The application image could not be downloaded.',
        component: 'runtime',
        reference: 'DEP-ABCDEF12',
        technical: { stage: 'INSTALL', component: 'runtime', awsStatus: 'CREATE_FAILED' },
      },
    };
    expect(customerDeploymentStatusSchema.parse(withFailure)).toStrictEqual(withFailure);
    // The flags are required and plain booleans — false for every failure the
    // application's own startup/config work did not cause, true when a
    // customer-side change must precede any retry.
    const notAppOwned = {
      ...withFailure,
      failure: { ...withFailure.failure, ownedByApplication: false, customerActionRequired: true },
    };
    expect(customerDeploymentStatusSchema.parse(notAppOwned)).toStrictEqual(notAppOwned);
  });

  it('rejects a relay/job/aws field leaking onto the customer shape', () => {
    expect(() => customerDeploymentStatusSchema.parse({ ...minimal, relay: { connected: true } })).toThrow(
      ZodError,
    );
    expect(() => customerDeploymentStatusSchema.parse({ ...minimal, job: null })).toThrow(ZodError);
  });

  it('rejects stepTimings leaking onto the customer shape', () => {
    expect(() => customerDeploymentStatusSchema.parse({ ...minimal, stepTimings: [] })).toThrow(ZodError);
  });

  // The additive specComponents field (phase 3) round-trips when present and
  // stays absent otherwise — never empty-by-guess.
  it('parses specComponents when present, and its absence', () => {
    const withSpecComponents = {
      ...minimal,
      specComponents: [
        { componentId: 'web', label: 'Web service', state: 'IN_PROGRESS' },
        { componentId: 'other', label: 'Other resources', state: 'COMPLETE', detail: '2 supporting resources' },
      ],
    };
    expect(customerDeploymentStatusSchema.parse(withSpecComponents)).toStrictEqual(withSpecComponents);
    expect(customerDeploymentStatusSchema.parse(minimal).specComponents).toBeUndefined();
  });

  it('rejects an unknown specComponents state and extra keys (strict)', () => {
    expect(() =>
      customerDeploymentStatusSchema.parse({
        ...minimal,
        specComponents: [{ componentId: 'web', label: 'Web service', state: 'QUANTUM' }],
      }),
    ).toThrow(ZodError);
    expect(() =>
      customerDeploymentStatusSchema.parse({
        ...minimal,
        specComponents: [{ componentId: 'web', label: 'Web service', state: 'PENDING', extra: true }],
      }),
    ).toThrow(ZodError);
  });

  // The live-provisioning fields are optional: the web app and the API
  // deploy separately, so a response omitting them (today's shape) and one
  // carrying them (once the API ships this) must both parse.
  it('parses without the four live-provisioning fields (today\'s shape)', () => {
    expect(customerDeploymentStatusSchema.parse(minimal)).toStrictEqual(minimal);
  });

  it('parses with the four live-provisioning fields populated', () => {
    const withLive = {
      ...minimal,
      stage: 'PROVISIONING',
      currentActivity: 'Creating the private network.',
      step: 'NETWORK',
      stepStartedAt: '2026-08-31T12:00:00.000Z',
      recentActivity: [
        { key: 'network', at: '2026-08-31T12:00:00.000Z', message: 'Creating the private network.', state: 'IN_PROGRESS' },
      ],
      provisioningIssue: { message: 'AWS could not create the database. Deployz is cleaning up and will show the result here shortly.' },
      technicalDetails: {
        reference: 'DEP-ABCDEF12',
        facts: [{ label: 'Stack name', value: 'stack-1' }],
        events: [
          {
            at: '2026-08-31T12:00:00.000Z',
            logicalResourceId: 'Vpc',
            resourceType: 'AWS::EC2::VPC',
            resourceStatus: 'CREATE_IN_PROGRESS',
            resourceStatusReason: null,
          },
        ],
      },
    };
    expect(customerDeploymentStatusSchema.parse(withLive)).toStrictEqual(withLive);
  });

  it('stepStartedAt also accepts an explicit null', () => {
    expect(customerDeploymentStatusSchema.parse({ ...minimal, stepStartedAt: null }).stepStartedAt).toBeNull();
  });

  it('parses awsSummary, an explicit null awsSummary, and its absence', () => {
    const withSummary = {
      ...minimal,
      stage: 'READY',
      awsSummary: { applicationStackName: 'deployz-app-1a2b3c4d', region: 'us-east-1', releaseVersion: 'v1.0.0' },
    };
    expect(customerDeploymentStatusSchema.parse(withSummary)).toStrictEqual(withSummary);

    const nullRelease = {
      ...withSummary,
      awsSummary: { ...withSummary.awsSummary, releaseVersion: null },
    };
    expect(customerDeploymentStatusSchema.parse(nullRelease)).toStrictEqual(nullRelease);

    expect(customerDeploymentStatusSchema.parse(minimal).awsSummary).toBeUndefined();
    expect(customerDeploymentStatusSchema.parse({ ...minimal, awsSummary: null }).awsSummary).toBeNull();
  });

  it('rejects extra keys inside awsSummary (strict)', () => {
    expect(() =>
      customerDeploymentStatusSchema.parse({
        ...minimal,
        awsSummary: {
          applicationStackName: 'deployz-app-1a2b3c4d',
          region: 'us-east-1',
          releaseVersion: null,
          stackStatus: 'CREATE_COMPLETE',
        },
      }),
    ).toThrow(ZodError);
  });
});

describe('vendorDeploymentStatusSchema', () => {
  it('parses the full operational shape, including a NOT_REQUIRED component', () => {
    const vendor = {
      stage: 'VERIFYING',
      updatedAt: '2026-08-31T12:00:00.000Z',
      currentActivity: 'Running health checks.',
      step: 'HEALTH_CHECK',
      steps: ['AWS_SETUP', 'RELAY_CONNECT', 'PREPARING', 'NETWORK', 'APPLICATION', 'HEALTH_CHECK', 'TLS', 'READY'],
      typicalDurationSeconds: { min: 60, max: 600 },
      takingLongerThanUsual: false,
      stepStartedAt: '2026-08-31T11:55:00.000Z',
      stepTimings: [
        { step: 'AWS_SETUP' as const, startedAt: '2026-08-31T11:00:00.000Z', completedAt: '2026-08-31T11:02:00.000Z', durationSeconds: 120 },
        { step: 'HEALTH_CHECK' as const, startedAt: '2026-08-31T11:55:00.000Z', completedAt: null, durationSeconds: null },
      ],
      statusUpdatesUnavailable: false,
      needsDomainSetup: false,
      components: [{ key: 'redis', label: 'Redis', status: 'NOT_REQUIRED' as const }],
      relay: { connected: true, lastSeenAt: '2026-08-31T11:59:00.000Z' },
      job: { type: 'INSTALL' as const, status: 'SUCCEEDED' as const },
      aws: { stackStatus: 'CREATE_COMPLETE' },
      health: {
        status: 'UNKNOWN' as const,
        layers: {
          infrastructure: 'UNKNOWN' as const,
          rollout: null,
          targets: null,
          http: null,
          relay: 'UNKNOWN' as const,
        },
        notStarted: false,
      },
      servingRelease: {
        releaseId: '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
        confirmedAt: '2026-08-31T11:58:00.000Z',
        confirmed: true,
      },
      connector: { upgradeRequired: false, reason: null, updateAvailable: false, updateUrl: null, updateTemplateUrl: null },
      url: null,
      failure: null,
    };
    expect(vendorDeploymentStatusSchema.parse(vendor)).toStrictEqual(vendor);

    const unconfirmed = {
      ...vendor,
      health: { ...vendor.health, notStarted: true },
      servingRelease: { releaseId: null, confirmedAt: null, confirmed: false },
      connector: {
        upgradeRequired: true,
        reason: 'RELEASE_EVIDENCE_MISSING' as const,
        updateAvailable: true,
        updateUrl: 'https://us-east-1.console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks',
        updateTemplateUrl: 'https://deployz-templates-us-east-1.s3.us-east-1.amazonaws.com/bootstrap/v1/versions/abc123def456/bootstrap-template-v1.json',
      },
    };
    expect(vendorDeploymentStatusSchema.parse(unconfirmed)).toStrictEqual(unconfirmed);
    expect(() => vendorDeploymentStatusSchema.parse({ ...vendor, connector: { ...vendor.connector, upgradeRequired: true, reason: 'OTHER' } })).toThrow(ZodError);

    // The additive specComponents field (phase 3) round-trips when present;
    // the parse above already proves its absence parses.
    const withSpecComponents = {
      ...vendor,
      specComponents: [{ componentId: 'web', label: 'Web service', state: 'COMPLETE' }],
    };
    expect(vendorDeploymentStatusSchema.parse(withSpecComponents)).toStrictEqual(withSpecComponents);
  });

  it('has no removed field — vendor screens read removal from the surrounding row state instead', () => {
    expect('removed' in vendorDeploymentStatusSchema.shape).toBe(false);
  });
});

describe('relayCommandProgressSchema', () => {
  const event = {
    eventId: 'evt-1',
    timestamp: '2026-08-31T12:00:00.000Z',
    logicalResourceId: 'AppDatabase',
    resourceType: 'AWS::RDS::DBInstance',
    resourceStatus: 'CREATE_IN_PROGRESS',
    resourceStatusReason: 'Resource creation Initiated',
  };
  const progress = {
    commandId: 'cmd-1',
    installationId: 'inst-1',
    stackName: 'deployz-app-abcd1234',
    events: [event],
  };

  it('parses a valid payload', () => {
    expect(relayCommandProgressSchema.parse(progress)).toStrictEqual(progress);
  });

  it('rejects more than 50 events', () => {
    const tooMany = { ...progress, events: Array.from({ length: 51 }, () => event) };
    expect(() => relayCommandProgressSchema.parse(tooMany)).toThrow(ZodError);
  });

  it('rejects a resourceStatus longer than 64 characters', () => {
    const longStatus = { ...event, resourceStatus: 'A'.repeat(65) };
    expect(() => relayStackEventSchema.parse(longStatus)).toThrow(ZodError);
  });
});

describe('vendorStackEventSchema', () => {
  it('round-trips a deployment_stack_events row shape', () => {
    const row = {
      id: 1,
      eventAt: '2026-08-31T12:00:00.000Z',
      logicalResourceId: 'AppDatabase',
      resourceType: 'AWS::RDS::DBInstance',
      resourceStatus: 'CREATE_IN_PROGRESS',
      resourceStatusReason: null,
    };
    expect(vendorStackEventSchema.parse(row)).toStrictEqual(row);
  });
});

// customDomainStatusSchema already exists above; this just confirms the
// values httpsComponentStatus (apps/api/src/deployment-status.ts) switches
// on are exactly what the db enum can hold.
describe('customDomainStatusSchema (used by the https component mapping)', () => {
  it('is exactly the six documented statuses', () => {
    expect([...customDomainStatusSchema.options].sort()).toEqual(
      ['ACTIVE', 'CONFIGURING', 'ERROR', 'PENDING', 'REMOVING', 'WAITING_FOR_DNS'].sort(),
    );
  });
});


// A failed day-2 operation must not mark a deployment with a running release
// as FAILED — shared settlement rule for the relay result route and the
// stuck-job watchdog.
describe('deploymentStateAfterFailedJob', () => {
  it('keeps a deployment with a running release live on a failed day-2 op', () => {
    for (const jobType of ['DEPLOY_RELEASE', 'ROLLBACK', 'RESTART'] as const) {
      expect(
        deploymentStateAfterFailedJob({ jobType, hasCurrentRelease: true, newerReadyReleaseExists: true }),
      ).toBe('UPDATE_AVAILABLE');
      expect(
        deploymentStateAfterFailedJob({ jobType, hasCurrentRelease: true, newerReadyReleaseExists: false }),
      ).toBe('HEALTHY');
      // Nothing ever ran: the failure IS the deployment failing.
      expect(
        deploymentStateAfterFailedJob({ jobType, hasCurrentRelease: false, newerReadyReleaseExists: false }),
      ).toBe('FAILED');
    }
  });

  it('never touches the deployment state for CONFIG_UPDATE or PURGE failures', () => {
    for (const jobType of ['CONFIG_UPDATE', 'PURGE'] as const) {
      expect(
        deploymentStateAfterFailedJob({ jobType, hasCurrentRelease: true, newerReadyReleaseExists: true }),
      ).toBeNull();
    }
  });

  it('fails the deployment for INSTALL and DESTROY', () => {
    for (const jobType of ['INSTALL', 'DESTROY'] as const) {
      expect(
        deploymentStateAfterFailedJob({ jobType, hasCurrentRelease: true, newerReadyReleaseExists: false }),
      ).toBe('FAILED');
    }
  });
});

describe('releaseImageTag', () => {
  it('namespaces the tag by application, so two applications can share a version', () => {
    expect(releaseImageTag('app-1', 'v1.0.0')).toBe('app-1-v1.0.0');
    expect(releaseImageTag('app-2', 'v1.0.0')).not.toBe(releaseImageTag('app-1', 'v1.0.0'));
  });
});
