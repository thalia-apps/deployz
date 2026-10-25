import { describe, expect, it } from 'vitest';

import {
  CUSTOMER_DEPLOYMENT_STATUS_BADGE,
  CUSTOMER_DEPLOYMENT_STATUS_LABELS,
  CUSTOMER_DEPLOYMENT_STATUSES,
  JARGON_PATTERN,
} from '@deployz/copy-map';

import type { Customer } from '../src/lib/customers';
import {
  customerDeployment,
  deploymentsByCustomer,
  initialCustomerSelection,
  installLinkDeployment,
  installLinkUrl,
  matchesCustomerSearch,
  matchingCustomerByEmail,
  NEW_CUSTOMER_VALUE,
  singleDeploymentDestination,
} from '../src/lib/customers';
import type { FleetDeployment } from '../src/lib/deployments';

function deploymentStatus(
  stage: string,
  updatedAt = '2026-08-01T00:00:00.000Z',
): FleetDeployment['deploymentStatus'] {
  return { stage, updatedAt } as FleetDeployment['deploymentStatus'];
}

function deployment(overrides: Partial<FleetDeployment> = {}): FleetDeployment {
  return {
    id: 'dep-1',
    customerId: 'cus-1',
    applicationId: 'app-1',
    organizationId: 'org-1',
    region: 'us-east-1',
    state: 'HEALTHY',
    awsAccountId: '1234••••••',
    currentReleaseId: null,
    previousReleaseId: null,
    currentReleaseConfirmedAt: null,
    relayStatus: 'CONNECTED',
    healthStatus: 'HEALTHY',
    desiredState: {},
    observedState: null,
    infraVersion: 'runtime-v1',
    installationId: 'inst-1',
    deploymentType: 'PRODUCTION',
    billingState: 'NOT_STARTED',
    billingStartedAt: null,
    billingStoppedAt: null,
    lastHealthAt: null,
    deletedAt: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    createdBy: null,
    updatedBy: null,
    customerName: 'Acme Corp',
    applicationName: 'MyApp',
    version: '1.4.2',
    attemptNumber: 1,
    bootstrapStackName: null,
    installStartedAt: null,
    installLinkId: 'link-1',
    installLinkToken: 'token-1',
    deploymentStatus: deploymentStatus('READY'),
    ...overrides,
  };
}

function customer(overrides: Partial<Customer> = {}): Customer {
  return {
    id: 'cus-1',
    organizationId: 'org-1',
    name: 'Acme Corp',
    email: 'acme@example.com',
    company: 'Acme Inc',
    externalReference: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('customerDeployment', () => {
  it('rolls an empty deployment list up to NOT_INSTALLED', () => {
    const rollup = customerDeployment([]);
    expect(rollup.status).toBe('NOT_INSTALLED');
    expect(rollup.label).toBe('Not installed');
    expect(rollup.deployment).toBeNull();
    expect(rollup.lastActivityAt).toBeNull();
  });

  it('rolls a NOT_INSTALLED deployment up to NOT_INSTALLED', () => {
    const rollup = customerDeployment([deployment({ state: 'NOT_INSTALLED' })]);
    expect(rollup.status).toBe('NOT_INSTALLED');
  });

  it('rolls a healthy, ready, connected deployment up to LIVE', () => {
    const rollup = customerDeployment([
      deployment({
        state: 'HEALTHY',
        deploymentStatus: deploymentStatus('READY'),
        relayStatus: 'CONNECTED',
        healthStatus: 'HEALTHY',
      }),
    ]);
    expect(rollup.status).toBe('LIVE');
    expect(rollup.label).toBe('Live');
  });

  it('rolls an INSTALLING deployment up to INSTALLING', () => {
    const rollup = customerDeployment([
      deployment({ state: 'INSTALLING', deploymentStatus: deploymentStatus('PROVISIONING') }),
    ]);
    expect(rollup.status).toBe('INSTALLING');
    expect(rollup.label).toBe('Installing');
  });

  it('rolls a WAITING_FOR_RELAY deployment up to INSTALLING', () => {
    const rollup = customerDeployment([
      deployment({
        state: 'WAITING_FOR_RELAY',
        deploymentStatus: deploymentStatus('WAITING_FOR_AWS'),
      }),
    ]);
    expect(rollup.status).toBe('INSTALLING');
  });

  it('rolls a FAILED deployment up to NEEDS_ATTENTION', () => {
    const rollup = customerDeployment([deployment({ state: 'FAILED' })]);
    expect(rollup.status).toBe('NEEDS_ATTENTION');
    expect(rollup.label).toBe('Needs attention');
    expect(rollup.badge).toBe('warning');
  });

  it('rolls a DISCONNECTED deployment up to NEEDS_ATTENTION', () => {
    const rollup = customerDeployment([deployment({ state: 'DISCONNECTED' })]);
    expect(rollup.status).toBe('NEEDS_ATTENTION');
  });

  it('rolls a HEALTHY deployment with a disconnected relay up to NEEDS_ATTENTION', () => {
    // Proves the rollup composes attentionReason rather than reading `state` alone.
    const rollup = customerDeployment([
      deployment({ state: 'HEALTHY', relayStatus: 'DISCONNECTED' }),
    ]);
    expect(rollup.status).toBe('NEEDS_ATTENTION');
  });

  it('rolls a HEALTHY deployment with a failing health check up to NEEDS_ATTENTION', () => {
    const rollup = customerDeployment([
      deployment({ state: 'HEALTHY', healthStatus: 'UNHEALTHY' }),
    ]);
    expect(rollup.status).toBe('NEEDS_ATTENTION');
  });

  // A HEALTHY deployment whose derived stage has not reached READY yet —
  // READY additionally waits on HTTPS — is still live for the customer. Keying
  // the rollup off the stage instead of the §46 state left it reading
  // "Installing" for a deployment that was already serving.
  it('rolls a HEALTHY deployment up to LIVE even before its stage reaches READY', () => {
    const rollup = customerDeployment([
      deployment({ state: 'HEALTHY', deploymentStatus: deploymentStatus('VERIFYING') }),
    ]);
    expect(rollup.status).toBe('LIVE');
    expect(rollup.label).toBe('Live');
  });

  it('rolls a DELETING deployment up to REMOVING, never to Installing', () => {
    const rollup = customerDeployment([deployment({ state: 'DELETING' })]);
    expect(rollup.status).toBe('REMOVING');
    expect(rollup.label).toBe('Removing');
  });

  it('rolls a DELETED deployment up to REMOVED', () => {
    const rollup = customerDeployment([deployment({ state: 'DELETED' })]);
    expect(rollup.status).toBe('REMOVED');
    expect(rollup.label).toBe('Removed');
  });

  it('rolls an UPDATE_AVAILABLE deployment that is ready up to LIVE', () => {
    const rollup = customerDeployment([
      deployment({ state: 'UPDATE_AVAILABLE', deploymentStatus: deploymentStatus('READY') }),
    ]);
    expect(rollup.status).toBe('LIVE');
  });

  it('rolls several deployments up to the most actionable one', () => {
    const live = deployment({
      id: 'dep-live',
      state: 'HEALTHY',
      deploymentStatus: deploymentStatus('READY'),
    });
    const failed = deployment({ id: 'dep-failed', state: 'FAILED' });
    const rollup = customerDeployment([live, failed]);
    expect(rollup.status).toBe('NEEDS_ATTENTION');
    expect(rollup.deployment?.id).toBe('dep-failed');
  });

  it('takes lastActivityAt from the newest deploymentStatus.updatedAt and sorts deployments newest first', () => {
    const oldest = deployment({ id: 'dep-oldest', deploymentStatus: deploymentStatus('READY', '2026-08-01T00:00:00.000Z') });
    const newest = deployment({ id: 'dep-newest', deploymentStatus: deploymentStatus('READY', '2026-08-03T00:00:00.000Z') });
    const middle = deployment({ id: 'dep-middle', deploymentStatus: deploymentStatus('READY', '2026-08-02T00:00:00.000Z') });
    // Fed in out of order on purpose.
    const rollup = customerDeployment([oldest, newest, middle]);
    expect(rollup.lastActivityAt).toBe('2026-08-03T00:00:00.000Z');
    expect(rollup.deployments.map((d) => d.id)).toEqual(['dep-newest', 'dep-middle', 'dep-oldest']);
  });
});

describe('customer deployment status vocabulary (§65 jargon-free)', () => {
  const RAW_CFN_STATUS =
    /\b(CREATE|UPDATE|DELETE|ROLLBACK|REVIEW)(_ROLLBACK)?_(COMPLETE|IN_PROGRESS|FAILED)\b/;

  it('every rollup status has a jargon-free label and a badge variant', () => {
    for (const status of CUSTOMER_DEPLOYMENT_STATUSES) {
      expect(CUSTOMER_DEPLOYMENT_STATUS_LABELS[status], `label for ${status}`).not.toMatch(
        JARGON_PATTERN,
      );
      expect(CUSTOMER_DEPLOYMENT_STATUS_LABELS[status], `label for ${status}`).not.toMatch(
        RAW_CFN_STATUS,
      );
      expect(CUSTOMER_DEPLOYMENT_STATUS_BADGE[status], `badge for ${status}`).toBeDefined();
    }
  });
});

describe('deploymentsByCustomer', () => {
  it('groups by customerId, not by shared contact metadata', () => {
    // Both deployments' customers share a display name — the grouping must
    // still key off the id, the only anchor that cannot move.
    const depA = deployment({ id: 'dep-a', customerId: 'cus-a', customerName: 'Acme Corp' });
    const depB = deployment({ id: 'dep-b', customerId: 'cus-b', customerName: 'Acme Corp' });
    const grouped = deploymentsByCustomer([depA, depB]);
    expect(grouped.size).toBe(2);
    expect(grouped.get('cus-a')).toEqual([depA]);
    expect(grouped.get('cus-b')).toEqual([depB]);
  });
});

describe('singleDeploymentDestination', () => {
  it('returns the deployment when exactly one is not removed', () => {
    const rollup = customerDeployment([deployment({ id: 'dep-1' })]);
    expect(singleDeploymentDestination(rollup)?.id).toBe('dep-1');
  });

  it('returns null when two deployments are not removed', () => {
    const rollup = customerDeployment([
      deployment({ id: 'dep-1' }),
      deployment({ id: 'dep-2' }),
    ]);
    expect(singleDeploymentDestination(rollup)).toBeNull();
  });

  it('returns the live deployment when one is removed and one is live', () => {
    const rollup = customerDeployment([
      deployment({ id: 'dep-removed', state: 'DELETED' }),
      deployment({ id: 'dep-live', state: 'HEALTHY' }),
    ]);
    expect(singleDeploymentDestination(rollup)?.id).toBe('dep-live');
  });

  it('returns the single removed deployment when that is all there is', () => {
    const rollup = customerDeployment([deployment({ id: 'dep-removed', state: 'DELETED' })]);
    expect(singleDeploymentDestination(rollup)?.id).toBe('dep-removed');
  });
});

describe('installLinkUrl', () => {
  it('builds the URL from the deployment\'s existing installLinkId', () => {
    const dep = deployment({ installLinkId: 'abc123', installLinkToken: 'secret456' });
    expect(installLinkUrl(dep, 'https://app.example.com')).toBe(
      'https://app.example.com/install/abc123#secret456',
    );
  });
});

describe('installLinkDeployment', () => {
  it('returns null when every deployment is removed', () => {
    const rollup = customerDeployment([
      deployment({ id: 'dep-1', state: 'DELETED' }),
      deployment({ id: 'dep-2', state: 'DELETED' }),
    ]);
    expect(installLinkDeployment(rollup)).toBeNull();
  });

  it('skips removed deployments and returns the live one', () => {
    const rollup = customerDeployment([
      deployment({ id: 'dep-removed', state: 'DELETED' }),
      deployment({ id: 'dep-live', state: 'HEALTHY' }),
    ]);
    expect(installLinkDeployment(rollup)?.id).toBe('dep-live');
  });
});

describe('matchesCustomerSearch', () => {
  it('matches by name, email and company, case-insensitively and on partial substrings', () => {
    const c = customer({ name: 'Jane Doe', email: 'jane@example.com', company: 'Acme Inc' });
    expect(matchesCustomerSearch(c, 'jane')).toBe(true);
    expect(matchesCustomerSearch(c, 'JANE')).toBe(true);
    expect(matchesCustomerSearch(c, 'example.com')).toBe(true);
    expect(matchesCustomerSearch(c, 'acme')).toBe(true);
    expect(matchesCustomerSearch(c, 'ACME INC')).toBe(true);
  });

  it('matches everything for an empty or whitespace-only search', () => {
    const c = customer();
    expect(matchesCustomerSearch(c, '')).toBe(true);
    expect(matchesCustomerSearch(c, '   ')).toBe(true);
  });

  it('returns false when nothing matches', () => {
    const c = customer({ name: 'Jane Doe', email: 'jane@example.com', company: 'Acme Inc' });
    expect(matchesCustomerSearch(c, 'nonexistent')).toBe(false);
  });

  it('does not throw for a null company, and still matches on name/email', () => {
    const c = customer({ name: 'Jane Doe', email: 'jane@example.com', company: null });
    expect(() => matchesCustomerSearch(c, 'jane')).not.toThrow();
    expect(matchesCustomerSearch(c, 'jane')).toBe(true);
    expect(matchesCustomerSearch(c, 'example.com')).toBe(true);
  });
});

describe('initialCustomerSelection', () => {
  it('preselects the ?customerId= customer when it is in the list', () => {
    const customers = [customer({ id: 'cus-1' }), customer({ id: 'cus-2' })];
    expect(initialCustomerSelection(customers, 'cus-2')).toBe('cus-2');
  });

  it('falls back to the new-customer sentinel for an unknown id', () => {
    const customers = [customer({ id: 'cus-1' })];
    expect(initialCustomerSelection(customers, 'cus-missing')).toBe(NEW_CUSTOMER_VALUE);
  });

  it('falls back to the new-customer sentinel when no id is given', () => {
    const customers = [customer({ id: 'cus-1' })];
    expect(initialCustomerSelection(customers, null)).toBe(NEW_CUSTOMER_VALUE);
  });
});

describe('matchingCustomerByEmail', () => {
  it('matches an existing customer email, trimmed and case-insensitively', () => {
    const customers = [customer({ id: 'cus-1', email: 'jane@example.com' })];
    expect(matchingCustomerByEmail(customers, '  JANE@example.com  ')?.id).toBe('cus-1');
  });

  it('returns null for an empty field or no match', () => {
    const customers = [customer({ id: 'cus-1', email: 'jane@example.com' })];
    expect(matchingCustomerByEmail(customers, '')).toBeNull();
    expect(matchingCustomerByEmail(customers, '   ')).toBeNull();
    expect(matchingCustomerByEmail(customers, 'nobody@example.com')).toBeNull();
  });
});
