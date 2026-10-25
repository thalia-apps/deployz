import { describe, expect, it } from 'vitest';

import { FAILURE_CODES, failureCodeCopy } from '@deployz/copy-map';
import type { CustomerDeploymentStatus, VendorDeploymentStatus } from '@deployz/contracts';

import {
  deriveDeploymentStatus,
  endpointHttpsState,
  endpointStatusForHttpsState,
  mergeComponentState,
  toCustomerDeploymentStatus,
  toPlanHttpsState,
  toVendorDeploymentStatus,
  type DerivationApplication,
  type DerivationDeployment,
  type DerivationDomain,
  type DerivationJob,
  type DeriveDeploymentStatusInput,
} from './deployment-status.js';

// Unified deployment status — the read-time derivation. Every test here
// builds plain object fixtures and calls the pure functions directly: no
// database, no server, matching the module's own design goal (see the file
// header comment in deployment-status.ts).

const NOW = new Date('2026-08-31T12:00:00.000Z');

function makeDeployment(overrides: Partial<DerivationDeployment> = {}): DerivationDeployment {
  return {
    state: 'NOT_INSTALLED',
    relayStatus: 'UNKNOWN',
    healthStatus: 'UNKNOWN',
    enrollmentUsedAt: null,
    relayBoundAt: null,
    lastHealthAt: null,
    currentReleaseId: null,
    currentReleaseConfirmedAt: null,
    // The heartbeat route stamps this verdict from the release evidence; READY needs it to pass.
    observedState: { releaseVerdict: { pass: true, reason: null, notStarted: false } },
    updatedAt: NOW,
    installStartedAt: null,
    stepTimings: null,
    ...overrides,
  };
}

function makeApplication(overrides: Partial<DerivationApplication> = {}): DerivationApplication {
  return { databaseRequired: false, storageRequired: false, redisRequired: false, ...overrides };
}

let jobSequence = 0;
function makeJob(overrides: Partial<DerivationJob> = {}): DerivationJob {
  jobSequence += 1;
  return {
    id: `00000000-0000-0000-0000-${jobSequence.toString().padStart(12, '0')}`,
    type: 'INSTALL',
    state: 'SUCCEEDED',
    failureCode: null,
    result: null,
    lastProgressAt: null,
    startedAt: null,
    finishedAt: null,
    createdAt: NOW,
    ...overrides,
  };
}

function makeDomain(overrides: Partial<DerivationDomain> = {}): DerivationDomain {
  return { hostname: 'app.customer.example.com', status: 'ACTIVE', ...overrides };
}

// The relay provisioning snapshot rides observedState.infraHealth.provisioning
// (see packages/relay/src/provision-progress.ts) — this builds the shape
// deployment-status.ts's readProvisioningSnapshot parses.
function snapshotObservedState(
  categories: Record<string, { status: 'IN_PROGRESS' | 'COMPLETE' | 'FAILED'; startedAt?: string; completedAt?: string }>,
  stackStatus?: string,
): Record<string, unknown> {
  return { infraHealth: { provisioning: { categories, ...(stackStatus ? { stackStatus } : {}) } } };
}

function derive(input: Partial<DeriveDeploymentStatusInput> = {}) {
  return deriveDeploymentStatus({
    deployment: makeDeployment(),
    application: makeApplication(),
    jobs: [],
    domain: null,
    appUrl: null,
    ...input,
  });
}

describe('deriveDeploymentStatus — precedence', () => {
  it('nothing has happened yet → WAITING_FOR_AWS', () => {
    const status = derive();
    expect(status.stage).toBe('WAITING_FOR_AWS');
    expect(status.statusUpdatesUnavailable).toBe(false);
  });

  it('enrollmentUsedAt set, no INSTALL job running yet → CONNECTING', () => {
    const status = derive({
      deployment: makeDeployment({ enrollmentUsedAt: NOW }),
      jobs: [makeJob({ state: 'REQUESTED' })],
    });
    expect(status.stage).toBe('CONNECTING');
  });

  it('relayBoundAt set → CONNECTING even with no enrollmentUsedAt', () => {
    const status = derive({ deployment: makeDeployment({ relayBoundAt: NOW }) });
    expect(status.stage).toBe('CONNECTING');
  });

  it('state INSTALLING alone → CONNECTING', () => {
    const status = derive({ deployment: makeDeployment({ state: 'INSTALLING' }) });
    expect(status.stage).toBe('CONNECTING');
  });

  it('latest INSTALL job RUNNING → PROVISIONING, outranking CONNECTING', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'INSTALLING', enrollmentUsedAt: NOW }),
      jobs: [makeJob({ state: 'RUNNING' })],
    });
    expect(status.stage).toBe('PROVISIONING');
  });

  it('latest INSTALL job WAITING also → PROVISIONING', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'INSTALLING' }),
      jobs: [makeJob({ state: 'WAITING' })],
    });
    expect(status.stage).toBe('PROVISIONING');
  });

  it('everInstalled outranks an in-flight INSTALL job (a later attempt cannot regress a healthy deployment)', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'HEALTHY', healthStatus: 'HEALTHY' }),
      jobs: [makeJob({ state: 'RUNNING' })],
      appUrl: 'https://app.example.com',
      domain: makeDomain(),
    });
    expect(status.stage).toBe('READY');
  });

  it('state FAILED outranks everything else, including everInstalled', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'FAILED', currentReleaseId: 'rel-1' }),
      jobs: [makeJob({ state: 'FAILED', failureCode: 'ECS_DEPLOYMENT_FAILED' })],
    });
    expect(status.stage).toBe('FAILED');
  });
});

describe('deriveDeploymentStatus — the seven spec scenarios', () => {
  it('AWS launched, no relay yet → WAITING_FOR_AWS', () => {
    expect(derive().stage).toBe('WAITING_FOR_AWS');
  });

  it('WAITING_FOR_RELAY (Deploy to AWS pressed, relay not enrolled) is still WAITING_FOR_AWS', () => {
    // The launch signal changes the install page's sub-copy, never the
    // six-stage model — only the relay's first contact moves the stage.
    const status = derive({ deployment: makeDeployment({ state: 'WAITING_FOR_RELAY' }) });
    expect(status.stage).toBe('WAITING_FOR_AWS');
  });

  it('relay registered → CONNECTING', () => {
    const status = derive({ deployment: makeDeployment({ relayBoundAt: NOW }) });
    expect(status.stage).toBe('CONNECTING');
  });

  it('INSTALL running → PROVISIONING', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'INSTALLING' }),
      jobs: [makeJob({ state: 'RUNNING' })],
    });
    expect(status.stage).toBe('PROVISIONING');
  });

  it('install done, health pending → VERIFYING', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'HEALTHY', healthStatus: 'UNKNOWN' }),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
    });
    expect(status.stage).toBe('VERIFYING');
    expect(status.needsDomainSetup).toBe(false);
    expect(status.currentActivity).toBe('Running health checks.');
  });

  it('healthy + https → READY', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'HEALTHY', healthStatus: 'HEALTHY' }),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
      appUrl: 'https://app.example.com',
      domain: makeDomain(),
    });
    expect(status.stage).toBe('READY');
    expect(status.result).toEqual({ url: 'https://app.example.com' });
  });

  it('healthy + http-only → VERIFYING + needsDomainSetup, with the temporary HTTP address exposed', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'HEALTHY', healthStatus: 'HEALTHY' }),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
      appUrl: 'http://alb-123.us-east-1.elb.amazonaws.com',
      domain: null,
    });
    expect(status.stage).toBe('VERIFYING');
    expect(status.needsDomainSetup).toBe(true);
    expect(status.currentActivity).toBe('Waiting for secure domain setup.');
    // Run-time health confirmed the app is reachable over HTTP — the
    // temporary ALB address is real and must be shown, never "no address".
    expect(status.result).toEqual({ url: 'http://alb-123.us-east-1.elb.amazonaws.com' });
  });

  it('an HTTP appUrl is NOT exposed while health is still unverified', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'HEALTHY', healthStatus: 'UNKNOWN' }),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
      appUrl: 'http://alb-123.us-east-1.elb.amazonaws.com',
      domain: null,
    });
    expect(status.stage).toBe('VERIFYING');
    expect(status.needsDomainSetup).toBe(false);
    expect(status.result).toBeNull();
  });

  it('terminal failure → FAILED', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'FAILED' }),
      jobs: [makeJob({ state: 'FAILED', failureCode: 'PORT_MISMATCH' })],
    });
    expect(status.stage).toBe('FAILED');
    expect(status.failure?.code).toBe('PORT_MISMATCH');
  });

  it('an install that never verified → FAILED with the recorded code, not the job outcome', () => {
    const finishedAt = new Date(NOW.getTime() + 1000);
    const status = derive({
      deployment: makeDeployment({ state: 'FAILED' }),
      jobs: [
        makeJob({ state: 'FAILED', failureCode: 'PORT_MISMATCH', createdAt: new Date(NOW.getTime() - 5000), finishedAt: NOW }),
        makeJob({
          result: { installVerification: { failureCode: 'IMAGE_HEALTH_CHECK_FAILED', reason: 'PROBE_FAILED' } },
          finishedAt,
        }),
      ],
    });
    expect(status.stage).toBe('FAILED');
    expect(status.failure?.code).toBe('IMAGE_HEALTH_CHECK_FAILED');
    expect(status.failure?.component).toBe('runtime');
    expect(status.failure?.awsStatus).toBeNull();
  });

  it('a failed deploy after an unverified install owns the failure', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'FAILED' }),
      jobs: [
        makeJob({
          result: { installVerification: { failureCode: 'IMAGE_HEALTH_CHECK_FAILED', reason: 'PROBE_FAILED' } },
          finishedAt: NOW,
        }),
        makeJob({
          type: 'DEPLOY_RELEASE',
          state: 'FAILED',
          failureCode: 'MIGRATION_FAILED',
          createdAt: new Date(NOW.getTime() + 5000),
          finishedAt: new Date(NOW.getTime() + 6000),
        }),
      ],
    });
    expect(status.failure?.code).toBe('MIGRATION_FAILED');
  });

  it('relay outage on an already-healthy deployment → stage retained, statusUpdatesUnavailable', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'HEALTHY', healthStatus: 'HEALTHY', relayStatus: 'DISCONNECTED' }),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
      appUrl: 'https://app.example.com',
      domain: makeDomain(),
    });
    expect(status.stage).toBe('READY');
    expect(status.statusUpdatesUnavailable).toBe(true);
  });
});

describe('relay outage / DISCONNECTED handling', () => {
  it('never regresses stage: a stale relay on a healthy deployment stays VERIFYING/READY, not FAILED or WAITING_FOR_AWS', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'HEALTHY', healthStatus: 'HEALTHY', relayStatus: 'DISCONNECTED' }),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
      appUrl: 'http://alb.example.com',
    });
    expect(status.stage).toBe('VERIFYING');
    expect(status.statusUpdatesUnavailable).toBe(true);
  });

  it('a disconnected relay that has already registered never yields WAITING_FOR_AWS', () => {
    const status = derive({
      deployment: makeDeployment({
        state: 'INSTALLING',
        relayBoundAt: NOW,
        relayStatus: 'DISCONNECTED',
      }),
      jobs: [],
    });
    expect(status.stage).not.toBe('WAITING_FOR_AWS');
    expect(status.stage).toBe('CONNECTING');
    expect(status.statusUpdatesUnavailable).toBe(true);
  });

  it('the never-written DISCONNECTED deployment state is treated defensively as an installed, stale-relay deployment', () => {
    const status = derive({
      deployment: makeDeployment({
        state: 'DISCONNECTED',
        healthStatus: 'HEALTHY',
        relayStatus: 'CONNECTED', // even if relayStatus itself disagrees, deployment.state DISCONNECTED still marks the outage
      }),
      appUrl: 'https://app.example.com',
      domain: makeDomain(),
    });
    expect(status.stage).toBe('READY');
    expect(status.statusUpdatesUnavailable).toBe(true);
  });
});

describe('CloudFormation-complete-but-unverified', () => {
  it('INSTALL SUCCEEDED but healthStatus still UNKNOWN never reaches READY', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'HEALTHY', healthStatus: 'UNKNOWN', currentReleaseId: null }),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
      appUrl: 'https://app.example.com',
      domain: makeDomain(),
    });
    expect(status.stage).toBe('VERIFYING');
  });

  it('a successful INSTALL that left the persisted state INSTALLING derives VERIFYING the same way (runtime verification is the gate)', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'INSTALLING', healthStatus: 'UNKNOWN', currentReleaseId: null }),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
      appUrl: 'http://alb.example.com',
      domain: null,
    });
    expect(status.stage).toBe('VERIFYING');
    // App not confirmed reachable yet — no address is displayed.
    expect(status.result).toBeNull();
  });

  it('the same INSTALLING persisted state with confirmed health exposes the http address but stays VERIFYING (no https)', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'INSTALLING', healthStatus: 'HEALTHY', currentReleaseId: null }),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
      appUrl: 'http://alb.example.com',
      domain: null,
    });
    expect(status.stage).toBe('VERIFYING');
    expect(status.needsDomainSetup).toBe(true);
    expect(toCustomerDeploymentStatus(status).url).toBe('http://alb.example.com');
  });

  it('a SUCCESS (legacy) INSTALL job counts as installed the same as SUCCEEDED', () => {
    // deployment.state deliberately NOT in the ever-installed set, so
    // everInstalled can only come from the job itself — isolating the
    // SUCCESS/SUCCEEDED legacy-state equivalence from the state-based rule.
    const status = derive({
      deployment: makeDeployment({ state: 'NOT_INSTALLED', healthStatus: 'HEALTHY' }),
      jobs: [makeJob({ state: 'SUCCESS' })],
      appUrl: 'https://app.example.com',
      domain: makeDomain(),
    });
    expect(status.stage).toBe('READY');
  });
});

describe('removed flag', () => {
  it('DELETING sets removed without hiding the underlying stage', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'DELETING', healthStatus: 'HEALTHY' }),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
      appUrl: 'https://app.example.com',
      domain: makeDomain(),
    });
    expect(status.removed).toEqual({ state: 'DELETING' });
    expect(status.stage).toBe('READY');
    expect(toCustomerDeploymentStatus(status).removed).toBe(true);
  });

  it('DELETED sets removed the same way', () => {
    const status = derive({ deployment: makeDeployment({ state: 'DELETED' }) });
    expect(status.removed).toEqual({ state: 'DELETED' });
  });

  it('DELETING says it is removing, with no health or TLS activity', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'DELETING', healthStatus: 'UNHEALTHY' }),
      jobs: [makeJob({ state: 'SUCCEEDED' }), makeJob({ type: 'DESTROY', state: 'RUNNING' })],
      appUrl: 'https://app.example.com',
    });
    expect(status.stage).toBe('VERIFYING');
    expect(status.currentActivity).toBe('Removing the deployment.');
    const waitingForTls = derive({
      deployment: makeDeployment({ state: 'DELETING', healthStatus: 'HEALTHY' }),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
      appUrl: 'http://alb.example.com',
    });
    expect(waitingForTls.currentActivity).toBe('Removing the deployment.');
  });

  it('DELETED says it was removed', () => {
    const status = derive({ deployment: makeDeployment({ state: 'DELETED' }) });
    expect(status.currentActivity).toBe('The deployment was removed.');
  });

  it('a removed deployment is never taking longer than usual', () => {
    const startedAt = new Date(NOW.getTime() - 999_999_000);
    const status = derive({
      deployment: makeDeployment({
        state: 'DELETING',
        healthStatus: 'UNHEALTHY',
        stepTimings: { HEALTH_CHECK: { startedAt: startedAt.toISOString() } },
      }),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
      appUrl: 'https://app.example.com',
      now: NOW,
    });
    expect(status.takingLongerThanUsual).toBe(false);
  });

  it('a live deployment has no removed field at all', () => {
    const status = derive({ deployment: makeDeployment({ state: 'HEALTHY', healthStatus: 'HEALTHY' }) });
    expect(status.removed).toBeUndefined();
    expect(toCustomerDeploymentStatus(status).removed).toBe(false);
  });
});

describe('customer projection sanitization', () => {
  function sensitiveScenario() {
    return derive({
      deployment: makeDeployment({ state: 'FAILED', relayStatus: 'CONNECTED', lastHealthAt: NOW }),
      jobs: [
        makeJob({
          state: 'FAILED',
          failureCode: 'DATABASE_CONNECTION_FAILED',
          result: {
            stackStatus: 'CREATE_FAILED',
            // Deliberately planted secrets that must never reach the wire —
            // this is what a raw job.result blob could realistically carry.
            error: 'connection refused to db.internal at 10.0.4.12:5432',
            awsAccountId: '123456789012',
            enrollmentCode: 'SUPER-SECRET-ENROLLMENT-CODE',
            relayToken: 'tok_live_abcdef0123456789',
          },
        }),
      ],
    });
  }

  it('never leaks account ids, enrollment codes, tokens, or raw error text', () => {
    const customer = toCustomerDeploymentStatus(sensitiveScenario());
    const wire = JSON.stringify(customer);
    expect(wire).not.toContain('123456789012');
    expect(wire).not.toContain('SUPER-SECRET-ENROLLMENT-CODE');
    expect(wire).not.toContain('tok_live_abcdef0123456789');
    expect(wire).not.toContain('10.0.4.12');
    expect(wire).not.toContain('connection refused');
    expect(wire).not.toContain('awsAccountId');
    expect(wire).not.toContain('enrollmentCode');
    expect(wire).not.toContain('token');
  });

  it('carries no relay/job block and no vendorMessage', () => {
    const customer = toCustomerDeploymentStatus(sensitiveScenario());
    expect(customer).not.toHaveProperty('relay');
    expect(customer).not.toHaveProperty('job');
    expect(customer).not.toHaveProperty('aws');
    expect(customer).not.toHaveProperty('health');
    expect(JSON.stringify(customer)).not.toContain('vendorMessage');
  });

  it('the stack status reaches failure.technical only as a jargon-free phrase', () => {
    const customer = toCustomerDeploymentStatus(sensitiveScenario());
    // §65: never the raw CloudFormation enum value on the customer surface —
    // customerStackStatusLabel maps it to plain language.
    expect(customer.failure?.technical?.awsStatus).toBe('Setup did not complete');
    // "stackStatus" as a KEY name never appears — it is carried under
    // technical.awsStatus instead.
    expect(JSON.stringify(customer)).not.toContain('stackStatus');
    expect(JSON.stringify(customer)).not.toContain('CREATE_FAILED');
  });

  it('the vendor projection, by contrast, does carry the full operational detail', () => {
    const vendor = toVendorDeploymentStatus(sensitiveScenario());
    expect(vendor.relay).toBeDefined();
    expect(vendor.job).toBeDefined();
    expect(vendor.aws.stackStatus).toBe('CREATE_FAILED');
    expect(vendor.failure?.message).toBeTruthy();
  });

  it('reads stackStatus and checks from the real relay result nesting (result.output.*)', () => {
    // A live relay reports `{ success, output: { stackStatus, checks, ... } }`
    // (see POST /api/relay/commands/:id/result) — verified against a real
    // us-west-2 install. Top-level fields are the fixture/legacy shape.
    const derived = derive({
      deployment: makeDeployment({ state: 'FAILED', relayStatus: 'CONNECTED', lastHealthAt: NOW }),
      application: makeApplication({ databaseRequired: true }),
      jobs: [
        makeJob({
          state: 'FAILED',
          failureCode: 'DATABASE_CREATE_FAILED',
          result: {
            success: false,
            output: {
              stackStatus: 'ROLLBACK_COMPLETE',
              checks: [{ name: 'database', passed: false }],
            },
          },
        }),
      ],
    });
    const vendor = toVendorDeploymentStatus(derived);
    expect(vendor.aws.stackStatus).toBe('ROLLBACK_COMPLETE');
    expect(derived.components.find((c) => c.key === 'database')?.status).toBe('FAILED');
  });
});

// The fields both wire projections carry with the same meaning and are
// expected to always agree on — everything toCustomerDeploymentStatus and
// toVendorDeploymentStatus copy straight through from the shared
// DerivedDeploymentStatus with no per-projection transform. `components` and
// the rest of `failure` are deliberately excluded: those two are filtered/
// redacted differently by design (§65) and are checked separately below.
function sharedProjectionFields(status: CustomerDeploymentStatus | VendorDeploymentStatus) {
  return {
    stage: status.stage,
    updatedAt: status.updatedAt,
    currentActivity: status.currentActivity,
    step: status.step,
    steps: status.steps,
    typicalDurationSeconds: status.typicalDurationSeconds,
    takingLongerThanUsual: status.takingLongerThanUsual,
    statusUpdatesUnavailable: status.statusUpdatesUnavailable,
    needsDomainSetup: status.needsDomainSetup,
    url: status.url,
    failurePresent: status.failure !== null,
    failureComponent: status.failure?.component ?? null,
    failureReference: status.failure?.reference ?? null,
  };
}

describe('vendor and customer projections agree', () => {
  const scenarios: DeriveDeploymentStatusInput[] = [
    { deployment: makeDeployment(), application: makeApplication(), jobs: [], domain: null, appUrl: null },
    {
      deployment: makeDeployment({ relayBoundAt: NOW }),
      application: makeApplication(),
      jobs: [],
      domain: null,
      appUrl: null,
    },
    {
      deployment: makeDeployment({ state: 'INSTALLING' }),
      application: makeApplication(),
      jobs: [makeJob({ state: 'RUNNING' })],
      domain: null,
      appUrl: null,
    },
    {
      deployment: makeDeployment({ state: 'HEALTHY', healthStatus: 'UNKNOWN' }),
      application: makeApplication(),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
      domain: null,
      appUrl: null,
    },
    {
      deployment: makeDeployment({ state: 'HEALTHY', healthStatus: 'HEALTHY' }),
      application: makeApplication({ databaseRequired: true }),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
      domain: makeDomain(),
      appUrl: 'https://app.example.com',
    },
    {
      deployment: makeDeployment({ state: 'FAILED' }),
      application: makeApplication(),
      jobs: [makeJob({ state: 'FAILED', failureCode: 'UNKNOWN' })],
      domain: null,
      appUrl: null,
    },
    {
      deployment: makeDeployment({ state: 'DELETING', healthStatus: 'HEALTHY' }),
      application: makeApplication(),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
      domain: null,
      appUrl: 'http://alb.example.com',
    },
    {
      deployment: makeDeployment({ state: 'HEALTHY', healthStatus: 'HEALTHY', relayStatus: 'DISCONNECTED' }),
      application: makeApplication(),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
      domain: null,
      appUrl: 'https://app.example.com',
    },
    // A failed update over a live release (failed-update semantics).
    {
      deployment: makeDeployment({ state: 'HEALTHY', healthStatus: 'HEALTHY', currentReleaseId: 'rel-1' }),
      application: makeApplication(),
      jobs: [makeJob({ state: 'SUCCEEDED' }), makeJob({ type: 'DEPLOY_RELEASE', state: 'FAILED', failureCode: 'ECS_DEPLOYMENT_FAILED' })],
      domain: null,
      appUrl: 'https://app.example.com',
    },
    // Removed, with retained data.
    {
      deployment: makeDeployment({ state: 'DELETED', currentReleaseId: 'rel-1' }),
      application: makeApplication({ databaseRequired: true }),
      jobs: [makeJob({ state: 'SUCCEEDED' }), makeJob({ type: 'DESTROY', state: 'SUCCEEDED' })],
      domain: null,
      appUrl: null,
    },
    // A destroy that hit DELETE_FAILED.
    {
      deployment: makeDeployment({ state: 'FAILED', currentReleaseId: 'rel-1' }),
      application: makeApplication(),
      jobs: [makeJob({ state: 'SUCCEEDED' }), makeJob({ type: 'DESTROY', state: 'FAILED', failureCode: 'STACK_DELETE_FAILED' })],
      domain: null,
      appUrl: null,
    },
    // Failed while the relay is disconnected.
    {
      deployment: makeDeployment({ state: 'FAILED', relayStatus: 'DISCONNECTED' }),
      application: makeApplication(),
      jobs: [makeJob({ state: 'FAILED', failureCode: 'RELAY_STATE_WRITE_FAILED' })],
      domain: null,
      appUrl: null,
    },
  ];

  it.each(scenarios.map((input, index) => [index, input] as const))(
    'scenario %i: customer and vendor agree on every field they share',
    (_index, input) => {
      const derived = deriveDeploymentStatus(input);
      const customer = toCustomerDeploymentStatus(derived);
      const vendor = toVendorDeploymentStatus(derived);

      expect(sharedProjectionFields(customer)).toEqual(sharedProjectionFields(vendor));

      // The https component is the one entry toCustomerDeploymentStatus never
      // filters out (see its noSignalStages comment) — when the derivation
      // produced one, both projections must report the same status for it.
      const customerHttps = customer.components.find((c) => c.key === 'https');
      const vendorHttps = vendor.components.find((c) => c.key === 'https');
      expect(customerHttps?.status).toBe(vendorHttps?.status);

      // §65: relay identity, job detail, the raw stack status, and the
      // vendor-only stepTimings/failure fields must never reach the
      // unauthenticated customer projection, in any scenario.
      for (const key of ['relay', 'job', 'aws', 'stepTimings'] as const) {
        expect(customer).not.toHaveProperty(key);
      }
      if (customer.failure) {
        expect(customer.failure).not.toHaveProperty('code');
        expect(customer.failure).not.toHaveProperty('message');
      }
    },
  );
});

describe('failure mapping', () => {
  it('every §61 failure code has a non-empty customer message', () => {
    for (const code of FAILURE_CODES) {
      const status = derive({
        deployment: makeDeployment({ state: 'FAILED' }),
        jobs: [makeJob({ state: 'FAILED', failureCode: code })],
      });
      const customer = toCustomerDeploymentStatus(status);
      expect(customer.failure?.customerMessage, `code ${code}`).toBeTruthy();
      expect(customer.failure?.customerMessage.length ?? 0, `code ${code}`).toBeGreaterThan(0);
    }
  });

  it('a stored code with no copy (RDS_UNAVAILABLE) reads as UNKNOWN', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'FAILED' }),
      jobs: [makeJob({ state: 'FAILED', failureCode: 'RDS_UNAVAILABLE' })],
    });
    expect(status.failure?.code).toBe('UNKNOWN');
    expect(toCustomerDeploymentStatus(status).failure?.customerMessage).toBe(
      failureCodeCopy('UNKNOWN').description,
    );
  });

  it('a FAILED job with no classified code falls back to the generic customer message', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'FAILED' }),
      jobs: [makeJob({ state: 'FAILED', failureCode: null })],
    });
    const customer = toCustomerDeploymentStatus(status);
    expect(customer.failure?.customerMessage).toBe('Deployment needs attention.');
    expect(customer.failure?.ownedByApplication).toBe(false);
  });

  it('flags app-owned startup failures on the customer failure object, never the raw code', () => {
    const startup = toCustomerDeploymentStatus(
      derive({
        deployment: makeDeployment({ state: 'FAILED' }),
        jobs: [makeJob({ state: 'FAILED', failureCode: 'CONTAINER_START_FAILED' })],
      }),
    );
    expect(startup.failure?.ownedByApplication).toBe(true);
    expect(JSON.stringify(startup.failure)).not.toContain('CONTAINER_START_FAILED');

    const notAppOwned = toCustomerDeploymentStatus(
      derive({
        deployment: makeDeployment({ state: 'FAILED' }),
        jobs: [makeJob({ state: 'FAILED', failureCode: 'AWS_PERMISSION_DENIED' })],
      }),
    );
    expect(notAppOwned.failure?.ownedByApplication).toBe(false);
  });

  it('reference is DEP- plus the failed job id\'s first 8 hex characters, uppercased', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'FAILED' }),
      jobs: [makeJob({ id: 'abcdef12-0000-0000-0000-000000000000', state: 'FAILED', failureCode: 'UNKNOWN' })],
    });
    expect(status.failure?.reference).toBe('DEP-ABCDEF12');
  });

  it('a failure code maps to a component when one is reliably known', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'FAILED' }),
      jobs: [makeJob({ state: 'FAILED', failureCode: 'REDIS_CONNECTION_FAILED' })],
    });
    expect(status.failure?.component).toBe('redis');
  });

  it('an account/stack-level failure code has no single component', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'FAILED' }),
      jobs: [makeJob({ state: 'FAILED', failureCode: 'AWS_SCP_BLOCKED' })],
    });
    expect(status.failure?.component).toBeNull();
  });
});

describe('mergeComponentState', () => {
  // application/loadBalancer are unconditionally required, so in practice the
  // merge always yields at least those two keys (as UNKNOWN) — null is only
  // reachable if a future caller ever made them optional too. Preserves the
  // exact toFleetRow behavior this was extracted from.
  it('reports application/loadBalancer as UNKNOWN, never null, even with nothing observed', () => {
    expect(mergeComponentState(null, {})).toEqual({ application: 'UNKNOWN', loadBalancer: 'UNKNOWN' });
  });

  it('passes through a reported heartbeat status verbatim', () => {
    const merged = mergeComponentState({ components: { application: 'DEGRADED' } }, {});
    expect(merged?.application).toBe('DEGRADED');
  });

  it('falls back to NOT_PROVISIONED when a required check reports absent', () => {
    const merged = mergeComponentState(
      { infraHealth: { checks: [{ name: 'database', passed: false }] } },
      { databaseRequired: true },
    );
    expect(merged?.database).toBe('NOT_PROVISIONED');
  });

  it('falls back to UNKNOWN when required but never checked either', () => {
    const merged = mergeComponentState({}, { databaseRequired: true });
    expect(merged?.database).toBe('UNKNOWN');
  });

  it('omits an optional component nobody reported or required', () => {
    const merged = mergeComponentState({}, { redisRequired: false });
    expect(merged?.redis).toBeUndefined();
  });
});

describe('component progress list', () => {
  it('an unrequired component is NOT_REQUIRED for the vendor and absent for the customer', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'HEALTHY', healthStatus: 'HEALTHY' }),
      application: makeApplication({ redisRequired: false }),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
      appUrl: 'https://app.example.com',
      domain: makeDomain(),
    });
    const vendor = toVendorDeploymentStatus(status);
    const customer = toCustomerDeploymentStatus(status);
    expect(vendor.components.find((c) => c.key === 'redis')?.status).toBe('NOT_REQUIRED');
    expect(customer.components.find((c) => c.key === 'redis')).toBeUndefined();
  });

  // No stored manifest (derivationApplicationFor returns null booleans, never
  // a guessed false) must render as "not required" for display, not throw —
  // the display layer never treats null as a provisioning decision.
  it('null database/storage/redis requirements (no stored manifest) render as NOT_REQUIRED rather than throwing', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'HEALTHY', healthStatus: 'HEALTHY' }),
      application: makeApplication({ databaseRequired: null, storageRequired: null, redisRequired: null }),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
      appUrl: 'https://app.example.com',
      domain: makeDomain(),
    });
    const vendor = toVendorDeploymentStatus(status);
    expect(vendor.components.find((c) => c.key === 'database')?.status).toBe('NOT_REQUIRED');
    expect(vendor.components.find((c) => c.key === 'storage')?.status).toBe('NOT_REQUIRED');
    expect(vendor.components.find((c) => c.key === 'redis')?.status).toBe('NOT_REQUIRED');
  });

  it('an https ERROR is component-level only and does not fail the whole stage', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'HEALTHY', healthStatus: 'HEALTHY' }),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
      appUrl: 'http://alb.example.com',
      domain: makeDomain({ status: 'ERROR' }),
    });
    expect(status.stage).toBe('VERIFYING');
    expect(status.components.find((c) => c.key === 'https')?.status).toBe('FAILED');
  });

  it('https is omitted entirely before VERIFYING when there is no domain and no domain setup pending', () => {
    const status = derive({ deployment: makeDeployment({ state: 'INSTALLING' }) });
    expect(status.components.find((c) => c.key === 'https')).toBeUndefined();
  });
});

describe('step derivation — one per stage', () => {
  it('WAITING_FOR_AWS → AWS_SETUP', () => {
    expect(derive().step).toBe('AWS_SETUP');
  });

  it('CONNECTING → RELAY_CONNECT', () => {
    const status = derive({ deployment: makeDeployment({ relayBoundAt: NOW }) });
    expect(status.step).toBe('RELAY_CONNECT');
  });

  it('PROVISIONING with no snapshot yet → PREPARING', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'INSTALLING' }),
      jobs: [makeJob({ state: 'RUNNING' })],
    });
    expect(status.stage).toBe('PROVISIONING');
    expect(status.step).toBe('PREPARING');
  });

  it('VERIFYING, health not yet confirmed → HEALTH_CHECK', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'HEALTHY', healthStatus: 'UNKNOWN' }),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
    });
    expect(status.stage).toBe('VERIFYING');
    expect(status.step).toBe('HEALTH_CHECK');
  });

  it('VERIFYING, needsDomainSetup → TLS', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'HEALTHY', healthStatus: 'HEALTHY' }),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
      appUrl: 'http://alb.example.com',
      domain: null,
    });
    expect(status.needsDomainSetup).toBe(true);
    expect(status.step).toBe('TLS');
  });

  it('READY → READY', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'HEALTHY', healthStatus: 'HEALTHY' }),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
      appUrl: 'https://app.example.com',
      domain: makeDomain(),
    });
    expect(status.step).toBe('READY');
  });

  it('FAILED on a non-INSTALL job → APPLICATION (it never touched provisioning)', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'FAILED', currentReleaseId: 'rel-1' }),
      jobs: [makeJob({ type: 'DEPLOY_RELEASE', state: 'FAILED', failureCode: 'IMAGE_PULL_FAILED' })],
    });
    expect(status.step).toBe('APPLICATION');
  });

  it('FAILED DEPLOY_RELEASE with MIGRATION_FAILED names the MIGRATION step', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'FAILED', currentReleaseId: 'rel-1' }),
      application: makeApplication({ migrationCommand: 'npm run db:migrate' }),
      jobs: [makeJob({ type: 'DEPLOY_RELEASE', state: 'FAILED', failureCode: 'MIGRATION_FAILED' })],
    });
    expect(status.steps).toContain('MIGRATION');
    expect(status.step).toBe('MIGRATION');
  });

  it('FAILED first DEPLOY_RELEASE with MIGRATION_FAILED names MIGRATION even when the application row has no migration command', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'FAILED', currentReleaseId: null }),
      application: makeApplication({ migrationCommand: null }),
      jobs: [
        makeJob({ type: 'INSTALL', state: 'SUCCEEDED', payload: { startAfterConfig: true } }),
        makeJob({ type: 'DEPLOY_RELEASE', state: 'FAILED', failureCode: 'MIGRATION_FAILED' }),
      ],
    });
    expect(status.steps).toContain('MIGRATION');
    expect(status.step).toBe('MIGRATION');
  });

  it('a configured first start has not started the application until a deploy succeeds', () => {
    const base = {
      deployment: makeDeployment({ state: 'HEALTHY', healthStatus: 'UNKNOWN', currentReleaseId: null }),
      jobs: [makeJob({ type: 'INSTALL', state: 'SUCCEEDED', payload: { startAfterConfig: true } })],
    };
    expect(derive(base).step).toBe('APPLICATION');
    const started = derive({
      ...base,
      jobs: [...base.jobs, makeJob({ type: 'DEPLOY_RELEASE', state: 'SUCCEEDED' })],
    });
    expect(started.step).toBe('HEALTH_CHECK');
  });

  it('FAILED INSTALL with no snapshot falls back to the FAILURE_COMPONENT map (database)', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'FAILED' }),
      application: makeApplication({ databaseRequired: true }),
      jobs: [makeJob({ type: 'INSTALL', state: 'FAILED', failureCode: 'DATABASE_CREATE_FAILED' })],
    });
    expect(status.step).toBe('DATABASE_STORAGE');
  });

  it('FAILED fallback never names a step outside the applicable list', () => {
    // A REDIS_* failure code on an application whose redisRequired flag has
    // since been turned off: REDIS is not in `steps`, so highlighting it
    // would leave both progress lists with nothing marked. The broadest
    // truthful in-stage step stands in instead.
    const status = derive({
      deployment: makeDeployment({ state: 'FAILED' }),
      application: makeApplication({ redisRequired: false }),
      jobs: [makeJob({ type: 'INSTALL', state: 'FAILED', failureCode: 'REDIS_PROVISIONING_FAILED' })],
    });
    expect(status.steps).not.toContain('REDIS');
    expect(status.step).toBe('PREPARING');
  });

  it('FAILED INSTALL with no snapshot and no classified component falls back to PREPARING', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'FAILED' }),
      jobs: [makeJob({ type: 'INSTALL', state: 'FAILED', failureCode: 'AWS_SCP_BLOCKED' })],
    });
    expect(status.step).toBe('PREPARING');
  });

  it('FAILED INSTALL prefers the snapshot over the FAILURE_COMPONENT map when one is available', () => {
    const status = derive({
      deployment: makeDeployment({
        state: 'FAILED',
        observedState: snapshotObservedState({ network: { status: 'FAILED' } }),
      }),
      jobs: [makeJob({ type: 'INSTALL', state: 'FAILED', failureCode: 'DATABASE_CREATE_FAILED' })],
    });
    // The snapshot says NETWORK never completed — more truthful than the
    // failure code's own component guess.
    expect(status.step).toBe('NETWORK');
  });
});

describe('rollback-window snapshots', () => {
  it('does not regress the step from a rolling-back snapshot — broader PREPARING instead', () => {
    // Observed live: mid-rollback the categories describe teardown, and the
    // forward ladder read them as "network not complete → Creating network".
    const status = derive({
      deployment: makeDeployment({
        state: 'INSTALLING',
        observedState: snapshotObservedState(
          { network: { status: 'IN_PROGRESS' }, database: { status: 'IN_PROGRESS' } },
          'ROLLBACK_IN_PROGRESS',
        ),
      }),
      application: makeApplication({ databaseRequired: true }),
      jobs: [makeJob({ state: 'RUNNING' })],
    });
    expect(status.stage).toBe('PROVISIONING');
    expect(status.step).toBe('PREPARING');
  });

  it('a FAILED category still names the step where the attempt stopped, even mid-rollback', () => {
    const status = derive({
      deployment: makeDeployment({
        state: 'INSTALLING',
        observedState: snapshotObservedState(
          { network: { status: 'IN_PROGRESS' }, application: { status: 'FAILED' } },
          'ROLLBACK_IN_PROGRESS',
        ),
      }),
      jobs: [makeJob({ state: 'RUNNING' })],
    });
    expect(status.step).toBe('APPLICATION');
  });

  it('suppresses takingLongerThanUsual while the stack rolls back', () => {
    const status = derive({
      deployment: makeDeployment({
        state: 'INSTALLING',
        observedState: snapshotObservedState(
          { application: { status: 'FAILED', startedAt: '2026-08-31T10:00:00.000Z' } },
          'ROLLBACK_IN_PROGRESS',
        ),
      }),
      jobs: [makeJob({ state: 'RUNNING' })],
      now: new Date('2026-08-31T11:00:00.000Z'),
    });
    expect(status.takingLongerThanUsual).toBe(false);
  });
});

describe('aws.stackStatus from the live snapshot', () => {
  it('falls back to the snapshot stack status while the INSTALL result is still null', () => {
    const status = derive({
      deployment: makeDeployment({
        state: 'INSTALLING',
        observedState: snapshotObservedState({ network: { status: 'IN_PROGRESS' } }, 'CREATE_IN_PROGRESS'),
      }),
      jobs: [makeJob({ state: 'RUNNING', result: null })],
    });
    expect(status.aws.stackStatus).toBe('CREATE_IN_PROGRESS');
  });

  it('a settled stack job result still wins over a stale snapshot status', () => {
    const status = derive({
      deployment: makeDeployment({
        state: 'HEALTHY',
        healthStatus: 'HEALTHY',
        observedState: snapshotObservedState({ network: { status: 'IN_PROGRESS' } }, 'CREATE_IN_PROGRESS'),
      }),
      jobs: [makeJob({ state: 'SUCCEEDED', result: { output: { stackStatus: 'CREATE_COMPLETE' } } })],
      appUrl: 'https://app.example.com',
      domain: makeDomain(),
    });
    expect(status.aws.stackStatus).toBe('CREATE_COMPLETE');
  });
});

describe('step derivation — snapshot-driven provisioning ladder', () => {
  it('network still in progress → NETWORK', () => {
    const status = derive({
      deployment: makeDeployment({
        state: 'INSTALLING',
        observedState: snapshotObservedState({ network: { status: 'IN_PROGRESS' } }),
      }),
      jobs: [makeJob({ state: 'RUNNING' })],
    });
    expect(status.step).toBe('NETWORK');
  });

  it('network complete, required database still in progress → DATABASE_STORAGE', () => {
    const status = derive({
      deployment: makeDeployment({
        state: 'INSTALLING',
        observedState: snapshotObservedState({
          network: { status: 'COMPLETE', startedAt: 't0', completedAt: 't1' },
          database: { status: 'IN_PROGRESS' },
        }),
      }),
      application: makeApplication({ databaseRequired: true }),
      jobs: [makeJob({ state: 'RUNNING' })],
    });
    expect(status.step).toBe('DATABASE_STORAGE');
  });

  it('DATABASE_STORAGE only counts as complete once EVERY required sub-category is complete', () => {
    const status = derive({
      deployment: makeDeployment({
        state: 'INSTALLING',
        observedState: snapshotObservedState({
          network: { status: 'COMPLETE', completedAt: 't1' },
          database: { status: 'COMPLETE', completedAt: 't2' },
          storage: { status: 'IN_PROGRESS' },
        }),
      }),
      application: makeApplication({ databaseRequired: true, storageRequired: true }),
      jobs: [makeJob({ state: 'RUNNING' })],
    });
    expect(status.step).toBe('DATABASE_STORAGE');
  });

  it('redis required and incomplete (database/storage not required) → REDIS', () => {
    const status = derive({
      deployment: makeDeployment({
        state: 'INSTALLING',
        observedState: snapshotObservedState({
          network: { status: 'COMPLETE', completedAt: 't1' },
          redis: { status: 'IN_PROGRESS' },
        }),
      }),
      application: makeApplication({ redisRequired: true }),
      jobs: [makeJob({ state: 'RUNNING' })],
    });
    expect(status.step).toBe('REDIS');
  });

  it('an unrequired category never gates the ladder, even if the snapshot never reports it', () => {
    const status = derive({
      deployment: makeDeployment({
        state: 'INSTALLING',
        observedState: snapshotObservedState({
          network: { status: 'COMPLETE', completedAt: 't1' },
          application: { status: 'COMPLETE', completedAt: 't2' },
        }),
      }),
      application: makeApplication({ databaseRequired: false, redisRequired: false }),
      jobs: [makeJob({ state: 'RUNNING' })],
    });
    expect(status.step).toBe('APPLICATION');
  });

  it('everything complete → APPLICATION', () => {
    const status = derive({
      deployment: makeDeployment({
        state: 'INSTALLING',
        observedState: snapshotObservedState({
          network: { status: 'COMPLETE', completedAt: 't1' },
          application: { status: 'IN_PROGRESS' },
        }),
      }),
      jobs: [makeJob({ state: 'RUNNING' })],
    });
    expect(status.step).toBe('APPLICATION');
  });

  it('never regresses to a step whose completion is already persisted, even if the snapshot flips its category back', () => {
    // Observed live: the service's security-group rules (network category)
    // were created after the database finished, so the snapshot reported
    // network IN_PROGRESS again while stepTimings already held NETWORK and
    // DATABASE_STORAGE as completed.
    const status = derive({
      deployment: makeDeployment({
        state: 'INSTALLING',
        observedState: snapshotObservedState({
          network: { status: 'IN_PROGRESS', startedAt: 't0' },
          database: { status: 'COMPLETE', startedAt: 't0', completedAt: 't2' },
          application: { status: 'IN_PROGRESS' },
        }),
        stepTimings: {
          NETWORK: { startedAt: 't0', completedAt: 't1' },
          DATABASE_STORAGE: { startedAt: 't0', completedAt: 't2' },
        },
      }),
      application: makeApplication({ databaseRequired: true }),
      jobs: [makeJob({ state: 'RUNNING' })],
    });
    expect(status.step).toBe('APPLICATION');
  });
});

describe('applicable steps list', () => {
  it('REDIS is present only when the application requires it', () => {
    expect(derive({ application: makeApplication({ redisRequired: true }) }).steps).toContain('REDIS');
    expect(derive({ application: makeApplication({ redisRequired: false }) }).steps).not.toContain('REDIS');
  });

  it('DATABASE_STORAGE is present iff database OR storage is required', () => {
    expect(derive({ application: makeApplication() }).steps).not.toContain('DATABASE_STORAGE');
    expect(derive({ application: makeApplication({ databaseRequired: true }) }).steps).toContain('DATABASE_STORAGE');
    expect(derive({ application: makeApplication({ storageRequired: true }) }).steps).toContain('DATABASE_STORAGE');
  });

  it('stateless app with storage: DATABASE_STORAGE driven by storage alone, no database assumption', () => {
    // storageRequired=true, databaseRequired=false, redisRequired=false
    const status = derive({
      application: makeApplication({ databaseRequired: false, redisRequired: false, storageRequired: true }),
    });
    expect(status.steps).toContain('DATABASE_STORAGE');
    expect(status.steps).not.toContain('REDIS');
    // No step derivation assumes a database — only storage drives DATABASE_STORAGE.
    const stepIndex = status.steps.indexOf('DATABASE_STORAGE');
    expect(stepIndex).toBeGreaterThanOrEqual(0);
  });

  it('fully stateless (no database, storage, or redis) omits DATABASE_STORAGE entirely', () => {
    const status = derive({
      application: makeApplication({ databaseRequired: false, storageRequired: false, redisRequired: false }),
    });
    expect(status.steps).not.toContain('DATABASE_STORAGE');
    expect(status.steps).not.toContain('REDIS');
    expect(status.steps).not.toContain('MIGRATION');
  });

  it('is always in canonical order', () => {
    const status = derive({
      application: makeApplication({
        databaseRequired: true,
        redisRequired: true,
        migrationCommand: 'npm run db:migrate',
      }),
    });
    expect(status.steps).toEqual([
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
    ]);
  });

  it('MIGRATION is present only when the application has a migration command', () => {
    expect(derive({ application: makeApplication({ migrationCommand: 'npm run db:migrate' }) }).steps).toContain(
      'MIGRATION',
    );
    expect(derive({ application: makeApplication({ migrationCommand: null }) }).steps).not.toContain('MIGRATION');
    expect(derive({ application: makeApplication() }).steps).not.toContain('MIGRATION');
  });
});

describe('takingLongerThanUsual', () => {
  it('is false while the active step is within its typical range', () => {
    const startedAt = new Date(NOW.getTime() - 100_000); // NETWORK max is 360s
    const status = derive({
      deployment: makeDeployment({
        state: 'INSTALLING',
        observedState: snapshotObservedState({ network: { status: 'IN_PROGRESS', startedAt: startedAt.toISOString() } }),
      }),
      jobs: [makeJob({ state: 'RUNNING' })],
      now: NOW,
    });
    expect(status.step).toBe('NETWORK');
    expect(status.takingLongerThanUsual).toBe(false);
  });

  it('becomes true once elapsed time crosses the step max', () => {
    const startedAt = new Date(NOW.getTime() - 400_000); // past NETWORK's 360s max
    const status = derive({
      deployment: makeDeployment({
        state: 'INSTALLING',
        observedState: snapshotObservedState({ network: { status: 'IN_PROGRESS', startedAt: startedAt.toISOString() } }),
      }),
      jobs: [makeJob({ state: 'RUNNING' })],
      now: NOW,
    });
    expect(status.takingLongerThanUsual).toBe(true);
  });

  it('never changes the stage — a slow step is not a failure', () => {
    const startedAt = new Date(NOW.getTime() - 999_999_000);
    const status = derive({
      deployment: makeDeployment({
        state: 'INSTALLING',
        observedState: snapshotObservedState({ network: { status: 'IN_PROGRESS', startedAt: startedAt.toISOString() } }),
      }),
      jobs: [makeJob({ state: 'RUNNING' })],
      now: NOW,
    });
    expect(status.takingLongerThanUsual).toBe(true);
    expect(status.stage).toBe('PROVISIONING');
  });

  it('is suppressed when statusUpdatesUnavailable — a silent relay cannot support the claim', () => {
    const startedAt = new Date(NOW.getTime() - 400_000);
    const status = derive({
      deployment: makeDeployment({
        state: 'INSTALLING',
        relayStatus: 'DISCONNECTED',
        observedState: snapshotObservedState({ network: { status: 'IN_PROGRESS', startedAt: startedAt.toISOString() } }),
      }),
      jobs: [makeJob({ state: 'RUNNING' })],
      now: NOW,
    });
    expect(status.statusUpdatesUnavailable).toBe(true);
    expect(status.takingLongerThanUsual).toBe(false);
  });

  it('is false at READY (no typical range) even with a very old timestamp', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'HEALTHY', healthStatus: 'HEALTHY' }),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
      appUrl: 'https://app.example.com',
      domain: makeDomain(),
      now: new Date(NOW.getTime() + 999_999_000),
    });
    expect(status.takingLongerThanUsual).toBe(false);
  });

  it('is false at FAILED, even when the active step started long before now', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'FAILED' }),
      jobs: [makeJob({ state: 'FAILED', failureCode: 'UNKNOWN' })],
      now: new Date(NOW.getTime() + 999_999_000),
    });
    expect(status.stage).toBe('FAILED');
    expect(status.takingLongerThanUsual).toBe(false);
  });
});

describe('stepStartedAt resolution ladder', () => {
  it('AWS_SETUP falls back to deployment.installStartedAt', () => {
    const installStartedAt = new Date('2026-08-31T10:00:00.000Z');
    const status = derive({ deployment: makeDeployment({ installStartedAt }) });
    expect(status.step).toBe('AWS_SETUP');
    expect(status.stepStartedAt).toBe(installStartedAt.toISOString());
  });

  it('RELAY_CONNECT prefers enrollmentUsedAt over relayBoundAt', () => {
    const enrollmentUsedAt = new Date('2026-08-31T10:05:00.000Z');
    const relayBoundAt = new Date('2026-08-31T10:01:00.000Z');
    const status = derive({ deployment: makeDeployment({ enrollmentUsedAt, relayBoundAt }) });
    expect(status.step).toBe('RELAY_CONNECT');
    expect(status.stepStartedAt).toBe(enrollmentUsedAt.toISOString());
  });

  it('RELAY_CONNECT falls back to relayBoundAt when enrollmentUsedAt is unset', () => {
    const relayBoundAt = new Date('2026-08-31T10:01:00.000Z');
    const status = derive({ deployment: makeDeployment({ relayBoundAt }) });
    expect(status.stepStartedAt).toBe(relayBoundAt.toISOString());
  });

  it('PREPARING falls back to the latest INSTALL job startedAt, else createdAt', () => {
    const createdAt = new Date('2026-08-31T10:10:00.000Z');
    const startedAt = new Date('2026-08-31T10:12:00.000Z');
    const status = derive({
      deployment: makeDeployment({ state: 'INSTALLING' }),
      jobs: [makeJob({ state: 'RUNNING', createdAt, startedAt })],
    });
    expect(status.step).toBe('PREPARING');
    expect(status.stepStartedAt).toBe(startedAt.toISOString());
  });

  it('PREPARING falls back to createdAt when the INSTALL job has no startedAt', () => {
    const createdAt = new Date('2026-08-31T10:10:00.000Z');
    const status = derive({
      deployment: makeDeployment({ state: 'INSTALLING' }),
      jobs: [makeJob({ state: 'RUNNING', createdAt, startedAt: null })],
    });
    expect(status.stepStartedAt).toBe(createdAt.toISOString());
  });

  it('HEALTH_CHECK falls back to the latest INSTALL job finishedAt', () => {
    const finishedAt = new Date('2026-08-31T10:20:00.000Z');
    const status = derive({
      deployment: makeDeployment({ state: 'HEALTHY', healthStatus: 'UNKNOWN' }),
      jobs: [makeJob({ state: 'SUCCEEDED', finishedAt })],
    });
    expect(status.step).toBe('HEALTH_CHECK');
    expect(status.stepStartedAt).toBe(finishedAt.toISOString());
  });

  it('TLS has no authoritative fallback and stays null', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'HEALTHY', healthStatus: 'HEALTHY' }),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
      appUrl: 'http://alb.example.com',
      domain: null,
    });
    expect(status.step).toBe('TLS');
    expect(status.stepStartedAt).toBeNull();
  });

  it('a persisted step_timings entry always wins over the authoritative fallback', () => {
    const persisted = new Date('2026-08-31T09:00:00.000Z');
    const installStartedAt = new Date('2026-08-31T10:00:00.000Z');
    const status = derive({
      deployment: makeDeployment({
        installStartedAt,
        stepTimings: { AWS_SETUP: { startedAt: persisted.toISOString() } },
      }),
    });
    expect(status.stepStartedAt).toBe(persisted.toISOString());
  });
});

describe('customer/vendor step invariant', () => {
  const scenarios: DeriveDeploymentStatusInput[] = [
    { deployment: makeDeployment(), application: makeApplication(), jobs: [], domain: null, appUrl: null },
    {
      deployment: makeDeployment({ relayBoundAt: NOW }),
      application: makeApplication(),
      jobs: [],
      domain: null,
      appUrl: null,
    },
    {
      deployment: makeDeployment({ state: 'INSTALLING' }),
      application: makeApplication({ databaseRequired: true }),
      jobs: [makeJob({ state: 'RUNNING' })],
      domain: null,
      appUrl: null,
    },
    {
      deployment: makeDeployment({ state: 'HEALTHY', healthStatus: 'HEALTHY' }),
      application: makeApplication(),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
      domain: makeDomain(),
      appUrl: 'https://app.example.com',
    },
    {
      deployment: makeDeployment({ state: 'FAILED' }),
      application: makeApplication(),
      jobs: [makeJob({ state: 'FAILED', failureCode: 'REDIS_CONNECTION_FAILED' })],
      domain: null,
      appUrl: null,
    },
  ];

  it.each(scenarios.map((input, index) => [index, input] as const))(
    'scenario %i: customer.step === vendor.step === derived.step',
    (_index, input) => {
      const derived = deriveDeploymentStatus(input);
      const customer = toCustomerDeploymentStatus(derived);
      const vendor = toVendorDeploymentStatus(derived);
      expect(customer.step).toBe(derived.step);
      expect(vendor.step).toBe(derived.step);
      expect(customer.step).toBe(vendor.step);
      expect(customer.steps).toEqual(vendor.steps);
    },
  );
});

describe('customer projection never carries stepStartedAt/stepTimings', () => {
  it('the wire object has neither key, even though the derivation computed both', () => {
    const status = derive({
      deployment: makeDeployment({
        installStartedAt: NOW,
        stepTimings: { AWS_SETUP: { startedAt: NOW.toISOString() } },
      }),
    });
    const customer = toCustomerDeploymentStatus(status);
    expect(customer).not.toHaveProperty('stepStartedAt');
    expect(customer).not.toHaveProperty('stepTimings');
  });
});

describe('vendor stepTimings projection', () => {
  it('carries the persisted map as an ordered array with computed durations', () => {
    const status = derive({
      deployment: makeDeployment({
        state: 'INSTALLING',
        stepTimings: {
          AWS_SETUP: { startedAt: '2026-08-31T10:00:00.000Z', completedAt: '2026-08-31T10:02:00.000Z' },
          RELAY_CONNECT: { startedAt: '2026-08-31T10:02:00.000Z' },
        },
      }),
      jobs: [makeJob({ state: 'RUNNING' })],
    });
    const vendor = toVendorDeploymentStatus(status);
    expect(vendor.stepTimings).toEqual([
      { step: 'AWS_SETUP', startedAt: '2026-08-31T10:00:00.000Z', completedAt: '2026-08-31T10:02:00.000Z', durationSeconds: 120 },
      { step: 'RELAY_CONNECT', startedAt: '2026-08-31T10:02:00.000Z', completedAt: null, durationSeconds: null },
    ]);
  });
});

// §10.1 layered runtime health — each layer reports what ITS source observed,
// never collapsed into the scalar health status.
describe('layered runtime health (health.layers)', () => {
  function observed(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      infraHealth: { verified: true, checks: [] },
      deploymentRolloutState: 'COMPLETED',
      desiredCount: 2,
      runningCount: 2,
      unhealthyTargetCount: 0,
      pendingTargetCount: 0,
      unknownTargetCount: 0,
      httpProbe: {
        ok: true,
        statusCode: 200,
        latencyMs: 41,
        checkedAt: '2026-09-02T00:00:00.000Z',
        lastSuccessAt: '2026-09-02T00:00:00.000Z',
        lastFailedAt: null,
      },
      ...overrides,
    };
  }

  it('exposes every layer separately when every source reported', () => {
    const status = derive({
      deployment: makeDeployment({
        state: 'HEALTHY',
        healthStatus: 'HEALTHY',
        relayStatus: 'CONNECTED',
        observedState: observed(),
      }),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
    });
    expect(status.health.layers).toEqual({
      infrastructure: 'HEALTHY',
      rollout: 'COMPLETED',
      targets: {
        desiredCount: 2,
        runningCount: 2,
        unhealthyTargetCount: 0,
        pendingTargetCount: 0,
        unknownTargetCount: 0,
      },
      http: {
        ok: true,
        statusCode: 200,
        latencyMs: 41,
        checkedAt: '2026-09-02T00:00:00.000Z',
        lastSuccessAt: '2026-09-02T00:00:00.000Z',
        lastFailedAt: null,
      },
      relay: 'CONNECTED',
    });
    // And the vendor projection carries them verbatim.
    expect(toVendorDeploymentStatus(status).health.layers).toEqual(status.health.layers);
  });

  it('a failing HTTP probe stays a separate layer from healthy ECS/ALB layers', () => {
    const status = derive({
      deployment: makeDeployment({
        state: 'HEALTHY',
        healthStatus: 'HEALTHY',
        relayStatus: 'CONNECTED',
        observedState: observed({
          httpProbe: {
            ok: false,
            statusCode: 503,
            latencyMs: 12,
            checkedAt: '2026-09-02T00:00:01.000Z',
            lastSuccessAt: null,
            lastFailedAt: '2026-09-02T00:00:01.000Z',
          },
        }),
      }),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
    });
    // ECS still reports every target healthy and the rollout completed — the
    // app-level failure is visible only in the http layer, not smeared over
    // the others.
    expect(status.health.layers.rollout).toBe('COMPLETED');
    expect(status.health.layers.targets).toMatchObject({ unhealthyTargetCount: 0 });
    expect(status.health.layers.http).toMatchObject({ ok: false, statusCode: 503 });
    expect(status.health.status).toBe('HEALTHY');
  });

  it('an in-progress rollout is visible even while counts and probe look fine', () => {
    const status = derive({
      deployment: makeDeployment({
        state: 'HEALTHY',
        healthStatus: 'DEGRADED',
        observedState: observed({ deploymentRolloutState: 'IN_PROGRESS' }),
      }),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
    });
    expect(status.health.layers.rollout).toBe('IN_PROGRESS');
  });

  it('absent observations are honest UNKNOWNs, never healthy-looking zeros', () => {
    const status = derive({
      deployment: makeDeployment({ relayStatus: 'UNKNOWN' }),
    });
    expect(status.health.layers).toEqual({
      infrastructure: 'UNKNOWN',
      rollout: null,
      targets: null,
      http: null,
      relay: 'UNKNOWN',
    });
  });

  it('verification failure surfaces as an unhealthy infrastructure layer', () => {
    const status = derive({
      deployment: makeDeployment({
        state: 'HEALTHY',
        healthStatus: 'HEALTHY',
        observedState: observed({ infraHealth: { verified: false, checks: [] } }),
      }),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
    });
    expect(status.health.layers.infrastructure).toBe('UNHEALTHY');
  });
});

// Phase 11 — the Deployz-owned default-HTTPS endpoint. Precedence with a
// customer domain lives in resolveAppUrl (apps/api/src/fleet-row.ts); this
// block locks what the derivation does once that URL is chosen.
describe('deriveDeploymentStatus — default HTTPS (Phase 11)', () => {
  const HTTPS_DEFAULT = 'https://d-dep-1.deployz.dev';
  const HTTP_ALB = 'http://alb-123.us-east-1.elb.amazonaws.com';
  const defaultHttps = (status: string, hostname = 'd-dep-1.deployz.dev') => ({ hostname, status });

  it('healthy + ACTIVE default-HTTPS URL → READY, with the https component READY', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'HEALTHY', healthStatus: 'HEALTHY' }),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
      defaultHttps: defaultHttps('ACTIVE'),
      appUrl: HTTPS_DEFAULT,
    });
    expect(status.stage).toBe('READY');
    expect(status.needsDomainSetup).toBe(false);
    expect(status.result).toEqual({ url: HTTPS_DEFAULT });
    expect(status.components.find((c) => c.key === 'https')?.status).toBe('READY');
  });

  it('healthy + default HTTPS progressing (WAITING_FOR_DNS) holds VERIFYING/TLS with no customer-action nudge', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'HEALTHY', healthStatus: 'HEALTHY' }),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
      defaultHttps: defaultHttps('WAITING_FOR_DNS'),
      appUrl: HTTP_ALB,
    });
    expect(status.stage).toBe('VERIFYING');
    expect(status.step).toBe('TLS');
    // No custom domain is needed — the default HTTPS is progressing on its
    // own, so the "set up a custom domain" copy must not fire.
    expect(status.needsDomainSetup).toBe(false);
    expect(status.currentActivity).toBe('Waiting for a secure address.');
    expect(status.components.find((c) => c.key === 'https')?.status).toBe('IN_PROGRESS');
  });

  it('healthy + default HTTPS stuck PENDING still needs no customer action (it is being driven)', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'HEALTHY', healthStatus: 'HEALTHY' }),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
      defaultHttps: defaultHttps('PENDING'),
      appUrl: HTTP_ALB,
    });
    expect(status.needsDomainSetup).toBe(false);
    expect(status.components.find((c) => c.key === 'https')?.status).toBe('IN_PROGRESS');
  });

  // Phase 5 pin — the CONFIGURING slice of the READY-semantics matrix: the
  // TLS step is the one in progress while the verifier probes, and the
  // progression is automatic (no custom domain anywhere), so the "set up a
  // custom domain" nudge must not fire even while HTTPS is not yet ACTIVE.
  it('healthy + default HTTPS CONFIGURING (verifier probing) holds VERIFYING on the TLS step with no nudge', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'HEALTHY', healthStatus: 'HEALTHY' }),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
      defaultHttps: defaultHttps('CONFIGURING'),
      appUrl: HTTP_ALB,
    });
    expect(status.stage).toBe('VERIFYING');
    expect(status.step).toBe('TLS');
    expect(status.needsDomainSetup).toBe(false);
    expect(status.currentActivity).toBe('Waiting for a secure address.');
    expect(status.components.find((c) => c.key === 'https')?.status).toBe('IN_PROGRESS');
  });

  it('no default HTTPS and no custom domain keeps the customer-action nudge', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'HEALTHY', healthStatus: 'HEALTHY' }),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
      defaultHttps: null,
      appUrl: HTTP_ALB,
    });
    expect(status.needsDomainSetup).toBe(true);
    expect(status.components.find((c) => c.key === 'https')?.status).toBe('PENDING');
  });

  it('a default-HTTPS ERROR leaves the deployment VERIFYING with a failing https component', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'HEALTHY', healthStatus: 'HEALTHY' }),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
      defaultHttps: defaultHttps('ERROR'),
      appUrl: HTTP_ALB,
    });
    expect(status.stage).toBe('VERIFYING');
    expect(status.components.find((c) => c.key === 'https')?.status).toBe('FAILED');
    expect(status.needsDomainSetup).toBe(true);
  });

  it('a customer domain outranks default HTTPS once ACTIVE (its URL is the serving one)', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'HEALTHY', healthStatus: 'HEALTHY' }),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
      domain: makeDomain({ hostname: 'app.customer.com', status: 'ACTIVE' }),
      defaultHttps: defaultHttps('ACTIVE'),
      appUrl: 'https://app.customer.com',
    });
    expect(status.stage).toBe('READY');
    expect(status.result).toEqual({ url: 'https://app.customer.com' });
  });

  it('a customer domain awaiting DNS (custom domain present) keeps needsDomainSetup true even while default HTTPS progresses', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'HEALTHY', healthStatus: 'HEALTHY' }),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
      domain: makeDomain({ hostname: 'app.customer.com', status: 'WAITING_FOR_DNS' }),
      defaultHttps: defaultHttps('PENDING'),
      appUrl: HTTP_ALB,
    });
    expect(status.stage).toBe('VERIFYING');
    expect(status.needsDomainSetup).toBe(true);
    expect(status.step).toBe('TLS');
  });

  it('the https component tracks the default HTTPS machine through WAITING_FOR_DNS and CONFIGURING', () => {
    for (const phase of ['WAITING_FOR_DNS', 'CONFIGURING'] as const) {
      const status = derive({
        deployment: makeDeployment({ state: 'HEALTHY', healthStatus: 'HEALTHY' }),
        jobs: [makeJob({ state: 'SUCCEEDED' })],
        defaultHttps: defaultHttps(phase),
        appUrl: HTTP_ALB,
      });
      expect(status.components.find((c) => c.key === 'https')?.status).toBe('IN_PROGRESS');
    }
  });
});

// Phase 5 — the internal→plan vocabulary mapper (item 2). Pure view-layer
// translation; the internal machine enums stay untouched.
describe('toPlanHttpsState — plan HTTPS vocabulary (Phase 5)', () => {
  it('collapses PENDING and WAITING_FOR_DNS into DNS_PENDING', () => {
    expect(toPlanHttpsState('PENDING')).toBe('DNS_PENDING');
    expect(toPlanHttpsState('WAITING_FOR_DNS')).toBe('DNS_PENDING');
  });

  it('maps CONFIGURING to TLS_PENDING (the cert/listener step)', () => {
    expect(toPlanHttpsState('CONFIGURING')).toBe('TLS_PENDING');
  });

  it('passes VERIFYING, ACTIVE and ERROR through unchanged', () => {
    expect(toPlanHttpsState('VERIFYING')).toBe('VERIFYING');
    expect(toPlanHttpsState('ACTIVE')).toBe('ACTIVE');
    expect(toPlanHttpsState('ERROR')).toBe('ERROR');
  });

  it('returns null when the plan vocabulary has no word for the status', () => {
    // REMOVING teardown and unrecognised values are not plan states.
    expect(toPlanHttpsState('REMOVING')).toBeNull();
    expect(toPlanHttpsState('PROVISIONING')).toBeNull();
    expect(toPlanHttpsState('bogus')).toBeNull();
  });
});

// Phase 8 — custom-domain promotion gating. The machine already sequences the
// domain's own gates (PENDING → WAITING_FOR_DNS after DNS is visible →
// CONFIGURING after the cert is ISSUED → ACTIVE only after a successful HTTPS
// probe); the deployment-status derivation contributes the separate app-health
// gate. These pins lock the separation: domain status, certificate status and
// application health never collapse into each other, and a failing custom
// domain never fails the application while the default URL is healthy.
describe('custom-domain promotion gating (Phase 8)', () => {
  const CUSTOM = { hostname: 'app.customer.com', status: 'ACTIVE' as const };
  const CUSTOM_URL = 'https://app.customer.com';
  const DEFAULT = { hostname: 'd-dep-1.deployz.dev', status: 'ACTIVE' as const };
  const DEFAULT_URL = 'https://d-dep-1.deployz.dev';

  const readyDeployment = (healthStatus: 'HEALTHY' | 'UNHEALTHY' | 'UNKNOWN') =>
    makeDeployment({ state: 'HEALTHY', healthStatus });

  it('an ACTIVE custom domain is the serving URL only while the app is HEALTHY (READY)', () => {
    const status = derive({
      deployment: readyDeployment('HEALTHY'),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
      domain: CUSTOM,
      defaultHttps: DEFAULT,
      appUrl: CUSTOM_URL,
    });
    expect(status.stage).toBe('READY');
    expect(status.result).toEqual({ url: CUSTOM_URL });
  });

  it('a failing app behind an ACTIVE custom domain is VERIFYING, not READY (app health is its own gate)', () => {
    const status = derive({
      deployment: readyDeployment('UNHEALTHY'),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
      domain: CUSTOM,
      defaultHttps: DEFAULT,
      appUrl: CUSTOM_URL,
    });
    // The domain is ACTIVE, but an ACTIVE domain never stands in for a healthy
    // app: the deployment drops to VERIFYING on the health-check step and no
    // address is presented as working.
    expect(status.stage).toBe('VERIFYING');
    expect(status.step).toBe('HEALTH_CHECK');
    expect(status.health.status).toBe('UNHEALTHY');
    expect(status.result).toBeNull();
  });

  it('a failing custom domain (ERROR) never fails the deployment while the default URL is healthy', () => {
    const status = derive({
      deployment: readyDeployment('HEALTHY'),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
      domain: { hostname: 'app.customer.com', status: 'ERROR' },
      defaultHttps: DEFAULT,
      appUrl: DEFAULT_URL,
    });
    // The domain machine reverted the custom URL to non-preferred; the app
    // keeps serving READY behind the default URL, and stays HEALTHY.
    expect(status.stage).toBe('READY');
    expect(status.health.status).toBe('HEALTHY');
    expect(status.result).toEqual({ url: DEFAULT_URL });
    expect(status.components.find((c) => c.key === 'https')?.status).toBe('FAILED');
  });

  it('a domain stuck CONFIGURING on a failed HTTPS probe never stands in for the default URL', () => {
    const status = derive({
      deployment: readyDeployment('HEALTHY'),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
      domain: { hostname: 'app.customer.com', status: 'CONFIGURING' },
      defaultHttps: DEFAULT,
      appUrl: DEFAULT_URL,
    });
    expect(status.stage).toBe('READY');
    expect(status.result).toEqual({ url: DEFAULT_URL });
  });
});

// P0 — the infrastructure inventory's secure-endpoint truth. The load
// balancer's CloudFormation status never decides this; only the domain /
// default-HTTPS machines do, and READY requires one of them ACTIVE.
describe('endpointHttpsState — infrastructure secure endpoint truth', () => {
  const host = 'd-abc.deployz.dev';

  it('is SETTING_UP when no HTTPS machine has started', () => {
    expect(endpointHttpsState(null, null)).toBe('SETTING_UP');
  });

  it('follows the default-HTTPS machine through its intermediate states', () => {
    expect(endpointHttpsState(null, { hostname: host, status: 'PENDING' })).toBe('SETTING_UP');
    expect(endpointHttpsState(null, { hostname: host, status: 'WAITING_FOR_DNS' })).toBe('WAITING_FOR_CERTIFICATE');
    expect(endpointHttpsState(null, { hostname: host, status: 'CONFIGURING' })).toBe('ACTIVATING');
    expect(endpointHttpsState(null, { hostname: host, status: 'ACTIVE' })).toBe('READY');
    expect(endpointHttpsState(null, { hostname: host, status: 'ERROR' })).toBe('FAILED');
    expect(endpointHttpsState(null, { hostname: host, status: 'REMOVING' })).toBe('REMOVING');
  });

  it('never reads READY from a certificate that is issued but not yet verified', () => {
    expect(endpointHttpsState(null, { hostname: host, status: 'CONFIGURING' })).not.toBe('READY');
  });

  it('an ACTIVE custom domain is READY regardless of the default machine; an in-progress one defers to it', () => {
    expect(endpointHttpsState({ hostname: 'app.acme.com', status: 'ACTIVE' }, { hostname: host, status: 'WAITING_FOR_DNS' })).toBe('READY');
    expect(endpointHttpsState({ hostname: 'app.acme.com', status: 'CONFIGURING' }, { hostname: host, status: 'ACTIVE' })).toBe('READY');
    expect(endpointHttpsState({ hostname: 'app.acme.com', status: 'ERROR' }, { hostname: host, status: 'WAITING_FOR_DNS' })).toBe('WAITING_FOR_CERTIFICATE');
    expect(endpointHttpsState({ hostname: 'app.acme.com', status: 'WAITING_FOR_DNS' }, null)).toBe('WAITING_FOR_CERTIFICATE');
    expect(endpointHttpsState({ hostname: 'app.acme.com', status: 'ERROR' }, null)).toBe('FAILED');
  });

  it('maps onto the closed component-status vocabulary', () => {
    expect(endpointStatusForHttpsState('READY')).toBe('ready');
    expect(endpointStatusForHttpsState('FAILED')).toBe('failed');
    expect(endpointStatusForHttpsState('REMOVING')).toBe('deleting');
    for (const state of ['SETTING_UP', 'WAITING_FOR_CERTIFICATE', 'ACTIVATING'] as const) {
      expect(endpointStatusForHttpsState(state)).toBe('provisioning');
    }
  });
});

describe('deriveDeploymentStatus — release evidence', () => {
  const healthy = {
    state: 'HEALTHY',
    healthStatus: 'HEALTHY',
    relayStatus: 'CONNECTED',
  } as const;
  const verdict = (pass: boolean, reason: string | null = null, notStarted = false) => ({
    releaseVerdict: { pass, reason, notStarted },
  });

  it('a healthy relay report without passing evidence is VERIFYING, never READY', () => {
    for (const observedState of [verdict(false, 'PROBE_FAILED'), verdict(false, 'EVIDENCE_MISSING'), {}]) {
      const status = derive({
        deployment: makeDeployment({ ...healthy, observedState }),
        jobs: [makeJob()],
        appUrl: 'https://app.example.com',
      });
      expect(status.stage).toBe('VERIFYING');
    }
  });

  it('a confirmed live deployment stays READY while a day-2 operation rolls out', () => {
    const liveDuringRollout = {
      ...healthy,
      currentReleaseId: 'rel-1',
      currentReleaseConfirmedAt: NOW,
      observedState: verdict(false, 'PROBE_FAILED'),
      stepTimings: { HEALTH_CHECK: { startedAt: new Date(NOW.getTime() - 25 * 60_000).toISOString() } },
    };
    for (const type of ['DEPLOY_RELEASE', 'ROLLBACK', 'RESTART', 'CONFIG_UPDATE'] as const) {
      for (const state of ['QUEUED', 'RUNNING'] as const) {
        const status = derive({
          deployment: makeDeployment({ ...liveDuringRollout, state: 'UPDATING' }),
          jobs: [makeJob(), makeJob({ type, state })],
          appUrl: 'https://app.example.com',
          now: NOW,
        });
        expect(status.stage).toBe('READY');
        expect(status.takingLongerThanUsual).toBe(false);
        expect(toCustomerDeploymentStatus(status).stage).toBe('READY');
      }
    }
  });

  it('a day-2 operation does not mask failing evidence once it settles, before confirmation, or when unhealthy', () => {
    const base = { ...healthy, currentReleaseId: 'rel-1', observedState: verdict(false, 'PROBE_FAILED') };
    const cases = [
      { deployment: { ...base, currentReleaseConfirmedAt: NOW }, job: makeJob({ type: 'DEPLOY_RELEASE', state: 'FAILED' }) },
      { deployment: { ...base, currentReleaseConfirmedAt: null }, job: makeJob({ type: 'DEPLOY_RELEASE', state: 'RUNNING' }) },
      { deployment: { ...base, currentReleaseConfirmedAt: NOW, healthStatus: 'UNHEALTHY' as const }, job: makeJob({ type: 'ROLLBACK', state: 'RUNNING' }) },
    ];
    for (const { deployment, job } of cases) {
      const status = derive({
        deployment: makeDeployment(deployment),
        jobs: [makeJob(), job],
        appUrl: 'https://app.example.com',
      });
      expect(status.stage).toBe('VERIFYING');
    }
  });

  it('flags a connector whose heartbeat carries no release evidence', () => {
    const missing = derive({
      deployment: makeDeployment({ ...healthy, observedState: verdict(false, 'EVIDENCE_MISSING') }),
    });
    expect(missing.connector).toMatchObject({ upgradeRequired: true, reason: 'RELEASE_EVIDENCE_MISSING', updateAvailable: true });
    const failing = derive({
      deployment: makeDeployment({ ...healthy, observedState: verdict(false, 'PROBE_FAILED') }),
    });
    expect(failing.connector).toEqual({ upgradeRequired: false, reason: null, updateAvailable: false, updateUrl: null, updateTemplateUrl: null });
  });

  it('offers a connector update when the reported build differs from the published one', () => {
    const offer = { publishedBuildId: 'newbuild0001', updateUrl: 'https://console/stacks', templateUrl: 'https://tpl/new.json' };
    const outdated = derive({ deployment: makeDeployment({ ...healthy, bootstrapVersion: 'oldbuild0001' }), connectorUpdate: offer });
    expect(outdated.connector).toEqual({
      upgradeRequired: false,
      reason: null,
      updateAvailable: true,
      updateUrl: 'https://console/stacks',
      updateTemplateUrl: 'https://tpl/new.json',
    });
    const unknownBuild = derive({ deployment: makeDeployment({ ...healthy, bootstrapVersion: null }), connectorUpdate: offer });
    expect(unknownBuild.connector.updateAvailable).toBe(true);
    const current = derive({ deployment: makeDeployment({ ...healthy, bootstrapVersion: 'newbuild0001' }), connectorUpdate: offer });
    expect(current.connector).toMatchObject({ updateAvailable: false, updateUrl: null });
    const unknownPublished = derive({
      deployment: makeDeployment({ ...healthy, bootstrapVersion: 'oldbuild0001' }),
      connectorUpdate: { ...offer, publishedBuildId: null },
    });
    expect(unknownPublished.connector.updateAvailable).toBe(false);
  });

  it('reports an intentional zero-task state as not started', () => {
    const status = derive({
      deployment: makeDeployment({ ...healthy, observedState: verdict(false, 'WORKLOAD_NOT_STARTED', true) }),
    });
    expect(status.health.notStarted).toBe(true);
  });

  it('confirms the serving release until a deploy, rollback or restart settles after the evidence', () => {
    const confirmedAt = new Date('2026-08-31T11:00:00.000Z');
    const deployment = makeDeployment({
      ...healthy,
      currentReleaseId: 'release-1',
      currentReleaseConfirmedAt: confirmedAt,
    });
    expect(derive({ deployment, jobs: [makeJob()] }).servingRelease).toEqual({
      releaseId: 'release-1',
      confirmedAt: confirmedAt.toISOString(),
      confirmed: true,
    });

    const failedRollback = makeJob({
      type: 'ROLLBACK',
      state: 'FAILED',
      finishedAt: new Date('2026-08-31T11:30:00.000Z'),
    });
    const afterFailure = derive({ deployment, jobs: [makeJob(), failedRollback] });
    expect(afterFailure.servingRelease).toEqual({ releaseId: 'release-1', confirmedAt: null, confirmed: false });
    // The operation failure, the runtime health and the serving confirmation stay separate facts.
    expect(afterFailure.failure).not.toBeNull();
    expect(afterFailure.health.status).toBe('HEALTHY');

    const reconfirmed = derive({
      deployment: { ...deployment, currentReleaseConfirmedAt: new Date('2026-08-31T11:45:00.000Z') },
      jobs: [makeJob(), failedRollback],
    });
    expect(reconfirmed.servingRelease.confirmed).toBe(true);
  });

  it('has no confirmed release before one is promoted', () => {
    expect(derive({ deployment: makeDeployment({ ...healthy }) }).servingRelease).toEqual({
      releaseId: null,
      confirmedAt: null,
      confirmed: false,
    });
  });
});
