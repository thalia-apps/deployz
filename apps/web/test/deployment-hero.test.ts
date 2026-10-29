import { describe, expect, it } from 'vitest';

import type { VendorDeploymentStatus } from '@deployz/contracts';

import { canRetryFirstInstall, deriveHero, operationInFlight, showApplicationUrl, statusPollSettled, type HeroInput } from '../src/lib/deployment-hero';
import { REMOVED_PROGRESS } from '../src/lib/deployment-progress';
import type { DeploymentJob } from '../src/lib/deployments';

// The hero chooses words for what the server already derived — these tests
// pin the state → headline mapping, in particular that a failed update on a
// live deployment never reads as the deployment being down.

function status(overrides: Partial<VendorDeploymentStatus> = {}): VendorDeploymentStatus {
  return {
    stage: 'READY',
    updatedAt: '2026-09-01T00:00:00.000Z',
    currentActivity: 'Live and healthy.',
    step: 'READY',
    steps: ['AWS_SETUP', 'RELAY_CONNECT', 'PREPARING', 'NETWORK', 'APPLICATION', 'HEALTH_CHECK', 'TLS', 'READY'],
    typicalDurationSeconds: null,
    takingLongerThanUsual: false,
    stepStartedAt: null,
    stepTimings: [],
    statusUpdatesUnavailable: false,
    needsDomainSetup: false,
    components: [],
    relay: { connected: true, lastSeenAt: null },
    job: null,
    aws: { stackStatus: null },
    health: {
      status: 'HEALTHY',
      layers: { infrastructure: 'UNKNOWN', rollout: null, targets: null, http: null, relay: 'CONNECTED' },
      notStarted: false,
    },
    servingRelease: { releaseId: null, confirmedAt: null, confirmed: false },
    connector: { upgradeRequired: false, reason: null, updateAvailable: false, updateUrl: null, updateTemplateUrl: null, installedBuildId: null, publishedBuildId: null, stackState: 'UNKNOWN' as const, observedAt: null },
    url: 'https://app.example.com',
    failure: null,
    ...overrides,
  };
}

function job(overrides: Partial<DeploymentJob>): DeploymentJob {
  return {
    id: 'job-1',
    deploymentId: 'dep-1',
    type: 'DEPLOY_RELEASE',
    state: 'FAILED',
    idempotencyKey: 'k',
    payload: {},
    result: null,
    requestedBy: null,
    failureCode: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    startedAt: null,
    lastProgressAt: null,
    finishedAt: null,
    ...overrides,
  };
}

function input(overrides: Partial<HeroInput> = {}): HeroInput {
  return {
    state: 'HEALTHY',
    currentReleaseId: 'rel-1',
    version: '1.2.0',
    cleanupState: null,
    customerName: 'Acme',
    relayStatus: 'CONNECTED',
    jobs: [],
    deploymentStatus: status(),
    ...overrides,
  };
}

const FAILURE = {
  code: 'ECS_DEPLOYMENT_FAILED' as const,
  component: 'runtime',
  reference: 'DEP-ABCDEF01',
  message: 'The new version could not be rolled out.',
  awsStatus: null,
};

describe('deriveHero', () => {
  it('a not-installed deployment waits for the customer', () => {
    const hero = deriveHero(
      input({
        state: 'NOT_INSTALLED',
        currentReleaseId: null,
        version: null,
        deploymentStatus: status({ stage: 'WAITING_FOR_AWS', health: { ...status().health, status: 'UNKNOWN' }, url: null }),
      }),
    );
    expect(hero.kind).toBe('not-installed');
    expect(hero.title).toBe('Waiting for your customer to install');
    expect(hero.description).toContain('Acme');
  });

  it('an in-flight install shows the deploying headline with the step list', () => {
    const hero = deriveHero(
      input({
        state: 'INSTALLING',
        currentReleaseId: null,
        version: null,
        deploymentStatus: status({
          stage: 'PROVISIONING',
          currentActivity: 'Creating the database and storage.',
          health: { ...status().health, status: 'UNKNOWN' },
          url: null,
        }),
      }),
    );
    expect(hero.kind).toBe('installing');
    expect(hero.title).toBe('Deploying');
    expect(hero.description).toBe('Creating the database and storage.');
    expect(hero.showSteps).toBe(true);
  });

  it('READY is live, naming the running release', () => {
    const hero = deriveHero(input());
    expect(hero.kind).toBe('live');
    expect(hero.tone).toBe('success');
    expect(hero.title).toBe('Your application is live');
    expect(hero.description).toContain('v1.2.0');
    expect(hero.showSteps).toBe(false);
  });

  it('a healthy HTTP-only deployment nudges toward a custom domain only when the customer must act', () => {
    const nudged = deriveHero(
      input({
        deploymentStatus: status({ stage: 'VERIFYING', needsDomainSetup: true, url: 'http://alb.example' }),
      }),
    );
    expect(nudged.kind).toBe('live');
    expect(nudged.description).toContain('temporary address');
    expect(nudged.description).toContain('custom domain');

    // A secure address being brought up on its own asks nothing of anyone.
    const automatic = deriveHero(
      input({
        deploymentStatus: status({ stage: 'VERIFYING', needsDomainSetup: false, url: 'http://alb.example' }),
      }),
    );
    expect(automatic.kind).toBe('live');
    expect(automatic.description).toContain('temporary address');
    expect(automatic.description).not.toContain('custom domain');
  });

  it('says nothing about addresses once the app is on an HTTPS URL', () => {
    const hero = deriveHero(input({ deploymentStatus: status({ url: 'https://app.example.com' }) }));
    expect(hero.description).toBe('Release v1.2.0 is running and passing health checks.');
  });

  it('does not double the v prefix when the release name already carries one', () => {
    const hero = deriveHero(input({ version: 'v0.2.2-e2e-0904' }));
    expect(hero.description).toBe('Release v0.2.2-e2e-0904 is running and passing health checks.');
  });

  it('UPDATE_AVAILABLE is still live, with a newer release to deploy', () => {
    const hero = deriveHero(input({ state: 'UPDATE_AVAILABLE' }));
    expect(hero.kind).toBe('live');
    expect(hero.description).toContain('newer release');
  });

  it('a first install that failed is a failed deployment, not a failed update', () => {
    const hero = deriveHero(
      input({
        state: 'FAILED',
        currentReleaseId: null,
        version: null,
        jobs: [job({ type: 'INSTALL', failureCode: 'DATABASE_CREATE_FAILED' })],
        deploymentStatus: status({
          stage: 'FAILED',
          health: { ...status().health, status: 'UNKNOWN' },
          url: null,
          failure: { ...FAILURE, code: 'DATABASE_CREATE_FAILED', message: 'The database could not be created.' },
        }),
      }),
    );
    expect(hero.kind).toBe('install-failed');
    expect(hero.title).toBe('Install failed');
    expect(hero.description).toBe('The database could not be created.');
    expect(hero.liveReleaseNote).toBeNull();
  });

  it('reads "Application couldn\'t start" for an app-owned startup failure', () => {
    const hero = deriveHero(
      input({
        state: 'FAILED',
        currentReleaseId: null,
        version: null,
        jobs: [job({ type: 'INSTALL', failureCode: 'CONTAINER_START_FAILED' })],
        deploymentStatus: status({
          stage: 'FAILED',
          health: { ...status().health, status: 'UNKNOWN' },
          url: null,
          failure: { ...FAILURE, code: 'CONTAINER_START_FAILED', message: 'The application stopped shortly after starting.' },
        }),
      }),
    );
    expect(hero.kind).toBe('install-failed');
    expect(hero.title).toBe("Application couldn't start");
  });

  it('keeps "Deployment failed" for a non-startup first-install failure', () => {
    const hero = deriveHero(
      input({
        state: 'FAILED',
        currentReleaseId: null,
        version: null,
        jobs: [job({ type: 'INSTALL', failureCode: 'STACK_CREATE_FAILED' })],
        deploymentStatus: status({
          stage: 'FAILED',
          health: { ...status().health, status: 'UNKNOWN' },
          url: null,
          failure: { ...FAILURE, code: 'STACK_CREATE_FAILED', message: 'The initial setup could not complete.' },
        }),
      }),
    );
    expect(hero.kind).toBe('install-failed');
    expect(hero.title).toBe('Install failed');
  });

  it('a failed update on a live stage says the previous release is unaffected', () => {
    const hero = deriveHero(
      input({
        state: 'UPDATE_AVAILABLE',
        jobs: [job({ type: 'DEPLOY_RELEASE' })],
        deploymentStatus: status({ failure: FAILURE }),
      }),
    );
    expect(hero.kind).toBe('operation-failed');
    expect(hero.title).toBe('Update failed');
    expect(hero.description).toBe('The new version could not be rolled out.');
    expect(hero.liveReleaseNote).toBe('Release v1.2.0 is still live and unaffected.');
    expect(hero.failedJobType).toBe('DEPLOY_RELEASE');
  });

  it('a failed update never calls the running release unaffected while its health checks fail', () => {
    const hero = deriveHero(
      input({
        state: 'UPDATE_AVAILABLE',
        jobs: [job({ type: 'DEPLOY_RELEASE' })],
        deploymentStatus: status({
          failure: FAILURE,
          health: { ...status().health, status: 'UNHEALTHY' },
        }),
      }),
    );
    expect(hero.title).toBe('Update failed');
    expect(hero.liveReleaseNote).toBe(
      'Release v1.2.0 is still the running release, but its health checks are failing.',
    );
  });

  it('a deployment at zero tasks reads as not started, in a neutral tone', () => {
    const hero = deriveHero(
      input({
        deploymentStatus: status({ health: { ...status().health, status: 'UNHEALTHY', notStarted: true } }),
      }),
    );
    expect(hero).toMatchObject({ kind: 'not-started', tone: 'neutral', title: 'Your application is not started' });
  });

  it('a failed rollback and a failed restart are named for what they were', () => {
    expect(
      deriveHero(input({ jobs: [job({ type: 'ROLLBACK' })], deploymentStatus: status({ failure: FAILURE }) })).title,
    ).toBe('Rollback failed');
    expect(
      deriveHero(input({ jobs: [job({ type: 'RESTART' })], deploymentStatus: status({ failure: FAILURE }) })).title,
    ).toBe('Restart failed');
  });

  it('UPDATING names the running operation and keeps the live release in view', () => {
    const hero = deriveHero(
      input({
        state: 'UPDATING',
        jobs: [job({ type: 'DEPLOY_RELEASE', state: 'RUNNING' })],
      }),
    );
    expect(hero.kind).toBe('updating');
    expect(hero.title).toBe('Updating your application');
    expect(hero.description).toContain('Release v1.2.0');
    expect(hero.showSteps).toBe(false);
  });

  it('a live deployment whose relay went quiet reports lost contact, never failure', () => {
    const hero = deriveHero(
      input({ relayStatus: 'DISCONNECTED', deploymentStatus: status({ statusUpdatesUnavailable: true }) }),
    );
    expect(hero.kind).toBe('lost-contact');
    expect(hero.tone).toBe('warning');
  });

  it('runtime health drives unhealthy and degraded headlines', () => {
    expect(
      deriveHero(input({ deploymentStatus: status({ stage: 'VERIFYING', health: { ...status().health, status: 'UNHEALTHY' } }) }))
        .kind,
    ).toBe('unhealthy');
    expect(
      deriveHero(input({ deploymentStatus: status({ stage: 'VERIFYING', health: { ...status().health, status: 'DEGRADED' } }) }))
        .kind,
    ).toBe('degraded');
  });

  it('VERIFYING without a health signal is still verifying', () => {
    const hero = deriveHero(
      input({
        deploymentStatus: status({
          stage: 'VERIFYING',
          currentActivity: 'Running health checks.',
          health: { ...status().health, status: 'UNKNOWN' },
          url: null,
        }),
      }),
    );
    expect(hero.kind).toBe('installing');
    expect(hero.title).toBe('Verifying your application');
    expect(hero.description).toBe('Running health checks.');
  });

  it('DELETING is removal in progress, never a failure', () => {
    const hero = deriveHero(input({ state: 'DELETING' }));
    expect(hero.kind).toBe('deleting');
    expect(hero.tone).toBe('progress');
    expect(hero.title).toBe(REMOVED_PROGRESS.DELETING.title);
  });

  it('DELETED with an active PURGE job reads as deleting retained data, then as removed', () => {
    const running = deriveHero(
      input({ state: 'DELETED', cleanupState: 'SKIPPED_RELAY_OFFLINE', jobs: [job({ type: 'PURGE', state: 'RUNNING' })] }),
    );
    expect(running.kind).toBe('deleting');
    expect(running.tone).toBe('progress');
    expect(running.title).toBe('Deleting retained data');
    const done = deriveHero(
      input({ state: 'DELETED', cleanupState: 'COMPLETE', jobs: [job({ type: 'PURGE', state: 'SUCCEEDED' })] }),
    );
    expect(done.kind).toBe('deleted');
    expect(done.description).not.toContain('may still exist');
  });

  it('DELETED explains what is left behind per cleanup state', () => {
    expect(deriveHero(input({ state: 'DELETED', cleanupState: 'COMPLETE' })).description).toContain(
      'removed everything',
    );
    expect(deriveHero(input({ state: 'DELETED', cleanupState: 'SKIPPED_RELAY_OFFLINE' })).description).toContain(
      'may still exist',
    );
    expect(deriveHero(input({ state: 'DELETED', cleanupState: null })).description).toContain(
      'listed under Infrastructure',
    );
  });

  it('a failed removal is named as such', () => {
    const hero = deriveHero(
      input({
        state: 'FAILED',
        jobs: [job({ type: 'DESTROY', failureCode: 'STACK_DELETE_FAILED' })],
        deploymentStatus: status({ stage: 'FAILED', failure: { ...FAILURE, message: 'Removal was blocked.' } }),
      }),
    );
    expect(hero.kind).toBe('removal-failed');
    expect(hero.title).toBe('Removal failed');
  });
});

describe('operationInFlight', () => {
  it('is null when nothing mutating is running', () => {
    expect(operationInFlight([])).toBeNull();
    expect(operationInFlight([job({ type: 'INSTALL', state: 'SUCCEEDED' })])).toBeNull();
    // Health and domain work never owns the deployment.
    expect(operationInFlight([job({ type: 'HEALTH_REPORT', state: 'RUNNING' })])).toBeNull();
    expect(operationInFlight([job({ type: 'CONFIGURE_DOMAIN', state: 'RUNNING' })])).toBeNull();
  });

  it('names the running operation for every type the API refuses to run alongside', () => {
    for (const type of [
      'INSTALL',
      'DEPLOY_RELEASE',
      'ROLLBACK',
      'RESTART',
      'CONFIG_UPDATE',
      'DESTROY',
      'MIGRATION',
      'INFRA_UPGRADE',
    ]) {
      expect(operationInFlight([job({ type, state: 'RUNNING' })])?.type, type).toBe(type);
    }
  });

  it('counts a job the relay has not picked up yet', () => {
    for (const state of ['REQUESTED', 'QUEUED', 'WAITING']) {
      expect(operationInFlight([job({ type: 'DESTROY', state })])).not.toBeNull();
    }
  });
});

describe('statusPollSettled', () => {
  it('keeps the fast poll while an update runs on a live deployment', () => {
    for (const type of ['DEPLOY_RELEASE', 'ROLLBACK', 'RESTART', 'CONFIG_UPDATE']) {
      expect(statusPollSettled({ deploymentStatus: status({ stage: 'READY' }), jobs: [job({ type, state: 'RUNNING' })] }), type).toBe(false);
    }
  });

  it('slows down once the live deployment is idle', () => {
    expect(statusPollSettled({ deploymentStatus: status({ stage: 'READY' }), jobs: [job({ type: 'DEPLOY_RELEASE', state: 'SUCCEEDED' })] })).toBe(true);
    expect(statusPollSettled({ deploymentStatus: status({ stage: 'FAILED' }), jobs: [] })).toBe(true);
  });

  it('never slows down before a terminal stage', () => {
    expect(statusPollSettled({ deploymentStatus: status({ stage: 'VERIFYING' }), jobs: [] })).toBe(false);
  });
});

describe('canRetryFirstInstall', () => {
  it('offers retry for a failed, never-installed deployment', () => {
    expect(canRetryFirstInstall('FAILED', false, null)).toBe(true);
    // A stuck INSTALL is the very thing retry recovers from.
    expect(canRetryFirstInstall('FAILED', false, job({ type: 'INSTALL', state: 'RUNNING' }))).toBe(true);
  });

  it('does not offer retry while a DESTROY runs, after a successful install, or in another state', () => {
    expect(canRetryFirstInstall('FAILED', false, job({ type: 'DESTROY', state: 'RUNNING' }))).toBe(false);
    expect(canRetryFirstInstall('FAILED', true, null)).toBe(false);
    expect(canRetryFirstInstall('HEALTHY', false, null)).toBe(false);
  });
});

describe('canRetryFirstInstall with an offline connector', () => {
  it('offers the recovery even when the API reports an earlier install', () => {
    expect(canRetryFirstInstall('FAILED', true, null, true)).toBe(true);
  });

  it('still refuses while a DESTROY runs or outside a failed deployment', () => {
    expect(canRetryFirstInstall('FAILED', true, job({ type: 'DESTROY', state: 'RUNNING' }), true)).toBe(false);
    expect(canRetryFirstInstall('HEALTHY', true, null, true)).toBe(false);
  });
});

describe('showApplicationUrl', () => {
  it('shows the address unless the install failed or the deployment is going away', () => {
    expect(showApplicationUrl('live', 'https://x.test')).toBe(true);
    expect(showApplicationUrl('operation-failed', 'https://x.test')).toBe(true);
    expect(showApplicationUrl('install-failed', 'http://alb.test')).toBe(false);
    expect(showApplicationUrl('deleting', 'https://x.test')).toBe(false);
    expect(showApplicationUrl('live', null)).toBe(false);
  });
});
