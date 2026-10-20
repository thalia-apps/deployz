import { describe, expect, it } from 'vitest';

import { ApiRequestError } from '../src/lib/api-client';
import {
  DeploymentActionError,
  actionErrorMessage,
  createDeploymentErrorMessage,
  existingTestDeploymentId,
  matchesRememberedCustomer,
  readinessFindingMessages,
  type RememberedCustomer,
} from '../src/lib/deployments';

describe('readinessFindingMessages', () => {
  it('lists the blocking findings a readiness rejection carries, in order', () => {
    expect(
      readinessFindingMessages({
        findings: [
          { id: 'required-env-vars-missing', severity: 'error', message: 'This app requires environment variables that have no value yet: FOO.' },
          { id: 'migration-command-missing', severity: 'warning', message: 'No migration command.' },
          { id: 'port-missing', severity: 'error', message: 'The application port is unknown.' },
        ],
      }),
    ).toEqual([
      'This app requires environment variables that have no value yet: FOO.',
      'The application port is unknown.',
    ]);
  });

  it('is empty for errors without findings', () => {
    expect(readinessFindingMessages(undefined)).toEqual([]);
    expect(readinessFindingMessages({ findings: 'nope' })).toEqual([]);
    expect(readinessFindingMessages([{ path: 'region', message: 'Required' }])).toEqual([]);
  });
});

const REMEMBERED: RememberedCustomer = {
  id: 'cust-1',
  name: 'Canary 20260902',
  email: 'canary@example.com',
};

describe('matchesRememberedCustomer', () => {
  it('returns false when nothing is remembered yet', () => {
    expect(matchesRememberedCustomer(null, REMEMBERED.name, REMEMBERED.email)).toBe(false);
  });

  it('reuses the remembered customer when the retry carries the same name and email', () => {
    expect(matchesRememberedCustomer(REMEMBERED, REMEMBERED.name, REMEMBERED.email)).toBe(true);
  });

  it('does not reuse the remembered customer when the name changed', () => {
    expect(matchesRememberedCustomer(REMEMBERED, 'Someone Else', REMEMBERED.email)).toBe(false);
  });

  it('does not reuse the remembered customer when the email changed', () => {
    expect(matchesRememberedCustomer(REMEMBERED, REMEMBERED.name, 'other@example.com')).toBe(
      false,
    );
  });
});

describe('actionErrorMessage', () => {
  it('explains a busy deployment', () => {
    expect(actionErrorMessage(new DeploymentActionError(409, 'DEPLOYMENT_BUSY'), 'fallback')).toBe(
      'Another operation is already running on this deployment. Wait for it to finish, then try again.',
    );
  });

  it('explains an unavailable release', () => {
    expect(
      actionErrorMessage(new DeploymentActionError(409, 'RELEASE_UNAVAILABLE'), 'fallback'),
    ).toBe(
      'This version can no longer be deployed because its build is no longer available. Create a new release to deploy it again.',
    );
  });

  it('points a refused action at the offline connector', () => {
    for (const code of ['RELAY_DISCONNECTED', 'RELAY_NOT_CONNECTED']) {
      expect(actionErrorMessage(new DeploymentActionError(409, code), 'fallback'), code).toBe(
        "Deployz can't reach this deployment's connector. Ask the customer to reconnect it, then try again.",
      );
    }
  });

  it('explains a deploy refused for an infrastructure change', () => {
    expect(actionErrorMessage(new DeploymentActionError(409, 'INFRASTRUCTURE_CHANGE_REQUIRED'), 'fallback')).toBe(
      "This application's infrastructure changed (database, cache, database engine, workers, queues or schedules), and an existing deployment cannot get these changes. Create a new deployment for this customer, or change the requirements back.",
    );
  });

  it('falls back for any other error', () => {
    expect(actionErrorMessage(new DeploymentActionError(500, 'REQUEST_FAILED'), 'fallback')).toBe(
      'fallback',
    );
    expect(actionErrorMessage(new Error('nope'), 'fallback')).toBe('fallback');
  });
});

describe('createDeploymentErrorMessage (Paddle migration Phase 7)', () => {
  it('sends a blocked production deployment to checkout (Phase 8)', () => {
    expect(
      createDeploymentErrorMessage(
        new ApiRequestError('SUBSCRIPTION_REQUIRED', 'A production deployment needs an active Deployz subscription.', {
          subscriptionStatus: null,
        }),
      ),
    ).toBe(
      'This is your first customer deployment, so it starts your subscription. Continue to checkout below.',
    );
  });

  it('explains an existing test deployment conflict', () => {
    expect(
      createDeploymentErrorMessage(
        new ApiRequestError(
          'TEST_DEPLOYMENT_EXISTS',
          'This application already has a test deployment. Remove it before you create another.',
          { deploymentId: 'dep-1' },
        ),
      ),
    ).toBe('This application already has a test deployment.');
  });

  it('falls back to the server message for any other error', () => {
    expect(createDeploymentErrorMessage(new ApiRequestError('MANIFEST_NOT_COMPATIBLE', 'Not compatible.'))).toBe(
      'Not compatible.',
    );
    expect(createDeploymentErrorMessage(new Error('nope'))).toBe(
      'Something went wrong. Try again in a moment.',
    );
  });
});

describe('existingTestDeploymentId', () => {
  it('reads the conflicting deployment id off a TEST_DEPLOYMENT_EXISTS 409', () => {
    expect(
      existingTestDeploymentId(
        new ApiRequestError('TEST_DEPLOYMENT_EXISTS', 'This application already has a test deployment.', {
          deploymentId: 'dep-1',
        }),
      ),
    ).toBe('dep-1');
  });

  it('is null for any other error, or when the server sent no deploymentId', () => {
    expect(
      existingTestDeploymentId(new ApiRequestError('TEST_DEPLOYMENT_EXISTS', 'no details')),
    ).toBeNull();
    expect(
      existingTestDeploymentId(new ApiRequestError('SUBSCRIPTION_REQUIRED', 'blocked', { subscriptionStatus: null })),
    ).toBeNull();
    expect(existingTestDeploymentId(new Error('nope'))).toBeNull();
  });
});
