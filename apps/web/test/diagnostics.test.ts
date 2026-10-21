import { describe, expect, it } from 'vitest';

import {
  retryCta,
  toDiagnostics,
  type DiagnosticEvent,
} from '../src/lib/diagnostics';

// §14.3 diagnostics plumbing: the API serves the relay's verbatim error as
// `technicalDetail`, and the card's expandable "Technical detail" disclosure
// (DiagnosticCard's EventRows) renders `event.error.message`. The client
// mapping must carry it through — it used to drop it, which left the
// disclosure empty on every failure.

const base = {
  failureCode: 'DATABASE_CREATE_FAILED',
  recoverability: 'USER_ACTION',
  what: 'The database could not be created.',
  why: 'The account rejected the database this application requires.',
  fix: 'Check whether the account limits databases in this region, then run the install link again.',
  events: [{ occurredAt: '2026-09-03T00:00:00.000Z', eventType: 'install.failed', result: 'failed' }],
};

describe('toDiagnostics', () => {
  it('maps an empty (non-failed) response to no cards', () => {
    expect(
      toDiagnostics({
        failureCode: null,
        what: null,
        why: null,
        fix: null,
        events: [],
      }),
    ).toEqual([]);
  });

  it('carries the relay technical detail into the event error message', () => {
    const [diagnostic] = toDiagnostics({
      ...base,
      technicalDetail: 'internal: RDS CreateDBInstance timed out after 900s',
    });
    expect(diagnostic.event.error?.message).toBe('internal: RDS CreateDBInstance timed out after 900s');
  });

  it('leaves the event error absent when no technical detail was served', () => {
    const [diagnostic] = toDiagnostics({ ...base });
    expect((diagnostic.event as DiagnosticEvent).error).toBeUndefined();
  });
});

describe('toDiagnostics — normalised failure context (Phase 6)', () => {
  it('carries the context through, and leaves it null on an older response', () => {
    const context = {
      phase: 'INSTALL',
      attempt: 1,
      failureCode: 'DATABASE_CREATE_FAILED',
      reportedFailureCode: 'STACK_CREATE_FAILED',
      resourceType: 'AWS::RDS::DBInstance',
      message: 'Stack rolled back',
      relevantEvents: [
        { logicalResourceId: 'Database', resourceType: 'AWS::RDS::DBInstance', resourceStatus: 'CREATE_FAILED', reason: 'quota' },
      ],
      applicationVersion: null,
    };
    expect(toDiagnostics({ ...base, context })[0]?.context).toEqual(context);
    expect(toDiagnostics({ ...base })[0]?.context).toBeNull();
  });

  it('carries the spec component identity (phase 3) through when present, and omits it otherwise', () => {
    const context = {
      phase: 'INSTALL',
      attempt: 1,
      failureCode: 'DATABASE_CREATE_FAILED',
      reportedFailureCode: null,
      resourceType: 'AWS::RDS::DBInstance',
      message: null,
      relevantEvents: [],
      applicationVersion: null,
      componentId: 'database',
      componentLabel: 'MySQL',
    };
    expect(toDiagnostics({ ...base, context })[0]?.context).toEqual(context);
    const without = toDiagnostics({ ...base })[0]?.context ?? {};
    expect(without).not.toHaveProperty('componentId');
    expect(without).not.toHaveProperty('componentLabel');
  });
});

describe('toDiagnostics — explanation source and confidence (Phase 7)', () => {
  it('marks deterministic copy as such, and carries the AI confidence (medium when the API sent none)', () => {
    expect(toDiagnostics({ ...base })[0]).toMatchObject({ explanationSource: 'deterministic', confidence: null });
    expect(toDiagnostics({ ...base, source: 'deterministic', confidence: null })[0]).toMatchObject({
      explanationSource: 'deterministic',
      confidence: null,
    });
    expect(toDiagnostics({ ...base, failureCode: 'UNKNOWN', source: 'ai', confidence: 'low' })[0]).toMatchObject({
      explanationSource: 'ai',
      confidence: 'low',
    });
    expect(toDiagnostics({ ...base, failureCode: 'UNKNOWN', source: 'ai' })[0]?.confidence).toBe('medium');
  });
});

describe('toDiagnostics — evidence and retry eligibility', () => {
  it('carries evidence and retry eligibility through, and leaves both null when absent', () => {
    const evidence = {
      container: {
        exitCode: 1,
        stopCode: 'EssentialContainerExited',
        stoppedReason: 'connect ECONNREFUSED 10.0.1.5:5432',
        stoppedTaskCount: 3,
      },
    };
    const retryEligibility = { action: 'RETRY_INSTALL', retryable: true, whoMustAct: 'VENDOR' };
    const [diagnostic] = toDiagnostics({ ...base, evidence, retryEligibility });
    expect(diagnostic.evidence).toEqual(evidence);
    expect(diagnostic.retryEligibility).toEqual(retryEligibility);
    expect(toDiagnostics({ ...base })[0]?.evidence).toBeNull();
    expect(toDiagnostics({ ...base })[0]?.retryEligibility).toBeNull();
  });
});

describe('retryCta', () => {
  it('keeps the legacy retry button when there is no eligibility signal', () => {
    expect(retryCta(null)).toBe('legacy');
  });

  it('maps each eligibility action onto the hero affordance', () => {
    expect(retryCta({ action: 'RETRY_INSTALL', retryable: true, whoMustAct: 'VENDOR' })).toBe('retry');
    expect(retryCta({ action: 'DEPLOY_AGAIN', retryable: true, whoMustAct: 'VENDOR' })).toBe('retry');
    expect(retryCta({ action: 'CONTACT_DEPLOYZ', retryable: false, whoMustAct: 'DEPLOYZ' })).toBe(
      'contact-support',
    );
    expect(retryCta({ action: 'WAIT', retryable: false, whoMustAct: null })).toBe('none');
    expect(retryCta({ action: 'NONE', retryable: false, whoMustAct: null })).toBe('none');
  });
});
