import { describe, expect, it } from 'vitest';

import {
  APP_OWNED_STARTUP_FAILURE_CODES,
  EXPLANATION_FALLBACK,
  FAILURE_CODE_COPY,
  FAILURE_CODES,
  FAILURE_SEVERITY_BADGE,
  FAILURE_SEVERITY_DOT,
  STARTUP_FAILURE_CUSTOMER_NOTE,
  STARTUP_FAILURE_TITLE,
  failureCodeCopy,
  isAppOwnedStartupFailure,
} from '../src/lib/diagnostic-vocabulary';

// Locks the §61/§65 guardrail for the diagnostics surface: the failure-code
// vocabulary is exactly the ten §61 codes, and every top-level label,
// description, and fallback string is jargon-free — no raw AWS/ECS/CFN/IAM
// terms reach the UI edge (the raw code lives behind the expandable layer).

const JARGON = /\b(CloudFormation|IAM|ECS|ALB|Lambda|VPC|CFN|RDS)\b/i;

describe('§61 failure codes', () => {
  it('defines exactly the twenty-three §61 taxonomy codes', () => {
    expect(FAILURE_CODES).toEqual([
      'AWS_SCP_BLOCKED',
      'PORT_MISMATCH',
      'REGION_NOT_SUPPORTED',
      'QUOTA_EXCEEDED',
      'IMAGE_HEALTH_CHECK_FAILED',
      'MIGRATION_FAILED',
      'RELAY_DISCONNECTED',
      'ECS_DEPLOYMENT_FAILED',
      'AWS_PERMISSION_DENIED',
      'STACK_CREATE_FAILED',
      'STACK_DELETE_FAILED',
      'RDS_AZ_CAPACITY',
      'DATABASE_CREATE_FAILED',
      'DATABASE_CONNECTION_FAILED',
      'IMAGE_PULL_FAILED',
      'CONTAINER_START_FAILED',
      'MISSING_SECRET',
      'TEMPLATE_UNAVAILABLE',
      'UNSUPPORTED_ARCHITECTURE',
      'UNKNOWN',
      'REDIS_PROVISIONING_FAILED',
      'REDIS_CONNECTION_FAILED',
      'DOMAIN_OPERATION_TIMEOUT',
      'RELAY_STATE_WRITE_FAILED',
    ]);
  });

  it('maps every code to non-empty, jargon-free label and description', () => {
    for (const code of FAILURE_CODES) {
      const copy = FAILURE_CODE_COPY[code];
      expect(copy.label, `label for ${code}`).toBeTruthy();
      expect(copy.description, `description for ${code}`).toBeTruthy();
      expect(copy.label, `label for ${code}`).not.toMatch(JARGON);
      expect(copy.description, `description for ${code}`).not.toMatch(JARGON);
    }
  });

  it('keeps raw service names out of even the sensitive codes', () => {
    expect(FAILURE_CODE_COPY.AWS_SCP_BLOCKED.label).toBe('Cloud policy blocks this');
    expect(FAILURE_CODE_COPY.PORT_MISMATCH.label).toBe('Port conflict');
    expect(FAILURE_CODE_COPY.ECS_DEPLOYMENT_FAILED.label).toBe('Deployment failed');
    expect(FAILURE_CODE_COPY.RELAY_DISCONNECTED.label).toBe('Helper disconnected');
  });

  it('maps the two Redis MVP codes to plain-English, jargon-free copy', () => {
    expect(FAILURE_CODE_COPY.REDIS_PROVISIONING_FAILED.label).toBe('Cache setup failed');
    expect(FAILURE_CODE_COPY.REDIS_CONNECTION_FAILED.label).toBe("App can't reach its cache");
    for (const code of ['REDIS_PROVISIONING_FAILED', 'REDIS_CONNECTION_FAILED'] as const) {
      expect(FAILURE_CODE_COPY[code].label).not.toMatch(/ElastiCache|Valkey/i);
      expect(FAILURE_CODE_COPY[code].description).not.toMatch(/ElastiCache|Valkey/i);
    }
  });

  it('exposes a valid severity + badge + dot mapping per code', () => {
    for (const code of FAILURE_CODES) {
      const { severity } = FAILURE_CODE_COPY[code];
      expect(['critical', 'warning']).toContain(severity);
      expect(FAILURE_SEVERITY_BADGE[severity]).toBeTruthy();
      expect(FAILURE_SEVERITY_DOT[severity]).toBeTruthy();
    }
  });

  it('maps critical codes to the destructive badge', () => {
    for (const code of FAILURE_CODES) {
      if (FAILURE_CODE_COPY[code].severity === 'critical') {
        expect(FAILURE_SEVERITY_BADGE[FAILURE_CODE_COPY[code].severity]).toBe('destructive');
      }
    }
  });

  it('falls back to UNKNOWN copy for an unrecognized code', () => {
    expect(failureCodeCopy('SOME_UNLISTED_CODE').label).toBe(FAILURE_CODE_COPY.UNKNOWN.label);
  });
});

describe('§65 explanation fallback copy', () => {
  it('is jargon-free for when the AI explanation is unavailable', () => {
    expect(EXPLANATION_FALLBACK.why).not.toMatch(JARGON);
    expect(EXPLANATION_FALLBACK.fix).not.toMatch(JARGON);
  });
});

describe('app-owned startup failures', () => {
  it('names exactly the six startup/config codes the vendor owns', () => {
    expect([...APP_OWNED_STARTUP_FAILURE_CODES].sort()).toEqual(
      [
        'CONTAINER_START_FAILED',
        'IMAGE_HEALTH_CHECK_FAILED',
        'DATABASE_CONNECTION_FAILED',
        'MIGRATION_FAILED',
        'MISSING_SECRET',
        'PORT_MISMATCH',
      ].sort(),
    );
  });

  it('flags only those six codes, never null or infrastructure codes', () => {
    for (const code of APP_OWNED_STARTUP_FAILURE_CODES) {
      expect(isAppOwnedStartupFailure(code), code).toBe(true);
    }
    expect(isAppOwnedStartupFailure('DATABASE_CREATE_FAILED')).toBe(false);
    expect(isAppOwnedStartupFailure('IMAGE_PULL_FAILED')).toBe(false);
    expect(isAppOwnedStartupFailure('ECS_DEPLOYMENT_FAILED')).toBe(false);
    expect(isAppOwnedStartupFailure('STACK_CREATE_FAILED')).toBe(false);
    expect(isAppOwnedStartupFailure('RDS_UNAVAILABLE')).toBe(false);
    expect(isAppOwnedStartupFailure(null)).toBe(false);
    expect(isAppOwnedStartupFailure(undefined)).toBe(false);
    expect(isAppOwnedStartupFailure('SOME_UNLISTED_CODE')).toBe(false);
  });

  it('carries the vendor hero + customer card title/note copy', () => {
    expect(STARTUP_FAILURE_TITLE).toBe("Application couldn't start");
    expect(STARTUP_FAILURE_CUSTOMER_NOTE).toBe('No action is required from you.');
  });
});
