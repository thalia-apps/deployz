import { describe, expect, it } from 'vitest';

import type { CustomDomainStatus } from '@deployz/contracts';

import { resolveAppUrl, resolveDefaultUrl } from './fleet-row.js';

// Phase 7 — resolveAppUrl is the read-time source of truth for the URL the
// product surfaces (and the relay probes): only an ACTIVE custom domain is
// preferred; every other custom-domain state falls to the default-HTTPS URL
// once it serves, with the bare-ALB endpoint last. These are pure function
// tests — no database, matching the module's own design goal.

const ALB_ENDPOINT = 'http://alb-1.us-east-1.elb.amazonaws.com';
const INSTALLS = [
  {
    type: 'INSTALL',
    state: 'SUCCEEDED',
    result: {
      output: { outputs: { ExportDeployzApplicationPublicEndpoint: 'alb-1.us-east-1.elb.amazonaws.com' } },
    },
  },
] as const;

const DEFAULT_HTTPS = { hostname: 'd-dep-1.deployz.dev', status: 'ACTIVE' };
const CUSTOM = { hostname: 'app.customer.com', status: 'ACTIVE' };

describe('resolveAppUrl — preferred-URL precedence (Phase 7)', () => {
  it('prefers an ACTIVE custom domain over an ACTIVE default HTTPS URL', () => {
    expect(resolveAppUrl(INSTALLS, CUSTOM, DEFAULT_HTTPS)).toBe('https://app.customer.com');
  });

  it('falls to the default HTTPS URL for every non-ACTIVE custom-domain state', () => {
    const states: CustomDomainStatus[] = [
      'PENDING',
      'WAITING_FOR_DNS',
      'CONFIGURING',
      'ERROR',
      'REMOVING',
    ];
    for (const status of states) {
      expect(
        resolveAppUrl(INSTALLS, { hostname: 'app.customer.com', status }, DEFAULT_HTTPS),
        `custom ${status}`,
      ).toBe('https://d-dep-1.deployz.dev');
    }
  });

  it('uses the default HTTPS URL once ACTIVE or CONFIGURING when no custom domain exists', () => {
    for (const status of ['PENDING', 'CONFIGURING', 'ACTIVE', 'ERROR'] as const) {
      const expected = status === 'ACTIVE' || status === 'CONFIGURING'
        ? 'https://d-dep-1.deployz.dev'
        : ALB_ENDPOINT;
      expect(resolveAppUrl(INSTALLS, null, { hostname: 'd-dep-1.deployz.dev', status }), status).toBe(expected);
    }
  });

  it('falls back to the ALB endpoint when neither an ACTIVE custom nor a serving default exists', () => {
    expect(resolveAppUrl(INSTALLS, null, null)).toBe(ALB_ENDPOINT);
    expect(resolveAppUrl(INSTALLS, { hostname: 'app.customer.com', status: 'WAITING_FOR_DNS' }, null)).toBe(
      ALB_ENDPOINT,
    );
    expect(
      resolveAppUrl(INSTALLS, { hostname: 'app.customer.com', status: 'ERROR' }, null),
    ).toBe(ALB_ENDPOINT);
  });

  it('returns null when no HTTPS route and no ALB endpoint exist', () => {
    expect(resolveAppUrl([], null, null)).toBeNull();
    expect(resolveAppUrl([], CUSTOM, null)).toBe('https://app.customer.com');
  });
});

describe('resolveDefaultUrl — canonical Deployz address (Phase 9 completion)', () => {
  it('uses the hostname stored in the default-HTTPS state, whatever its status', () => {
    for (const status of ['PENDING', 'CONFIGURING', 'ACTIVE', 'ERROR'] as const) {
      expect(resolveDefaultUrl({ hostname: 'd-dep-1.deployz.dev', status }), status).toBe(
        'https://d-dep-1.deployz.dev',
      );
    }
  });

  it('is null when no default-HTTPS state exists yet', () => {
    expect(resolveDefaultUrl(null)).toBeNull();
    expect(resolveDefaultUrl(undefined)).toBeNull();
  });
});

describe('resolveAppUrl — relay-reported endpoint', () => {
  it('ignores an endpoint that is not an AWS load balancer hostname', () => {
    for (const endpoint of ['evil.example.com', 'https://evil.example.com/login', 'alb.elb.amazonaws.com.evil.com']) {
      const jobs = [
        { type: 'INSTALL', state: 'SUCCEEDED', result: { output: { outputs: { ExportDeployzApplicationPublicEndpoint: endpoint } } } },
      ] as const;
      expect(resolveAppUrl(jobs, null, null)).toBeNull();
    }
  });
});
