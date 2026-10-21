import { relayCheckCopy } from '@deployz/copy-map';

import type { FailureCode, FailureRecoverability } from './diagnostic-vocabulary';

// Diagnostics data access. Wired to the real
// `GET /api/deployments/:id/diagnostics` endpoint, which returns a single
// what/why/fix object (null fields when the deployment isn't FAILED) plus
// the recent event log — reshaped here into the card list the UI renders.
// §65 vocabulary at the top level — raw AWS/ECS terms only inside the
// expandable technical detail. Code-driven ONLY: no diagnostic bundles, no
// log export (S3).

import { readSignal } from '@/lib/api-client';
import { apiUrl } from '@/lib/api-url';
import { RELAY_STALE_AFTER_MS, type RelayStatus } from '@/lib/deployment-vocabulary';

// ── Wire shapes ────────────────────────────────────────────────────────────

/** One raw event from the deployment's event log (§40), as diagnostic context. */
export interface DiagnosticEvent {
  source: string;
  action?: string;
  signal?: string;
  error?: {
    code?: string;
    message?: string;
    statusCode?: number;
  };
  context?: Record<string, string | number | boolean>;
}

/** The plain-English explanation, when the deployment has actually failed. */
export interface DiagnosticExplanation {
  what: string;
  why: string;
  fix: string;
}

/**
 * One classified diagnostic: the deterministic §61 code, the structured event
 * that produced it (rendered behind the expandable layer), and the what/why/fix
 * explanation — all code-driven (no bundles, no log export).
 */
/** One failed resource from the normalised failure context (Phase 6). */
export interface DiagnosticFailedResource {
  logicalResourceId: string;
  resourceType: string;
  resourceStatus: string;
  reason: string | null;
}

/** The API's normalised failure context — phase, codes, blamed resource, failed events. */
export interface DiagnosticContext {
  phase: string;
  attempt: number | null;
  failureCode: string;
  reportedFailureCode: string | null;
  resourceType: string | null;
  message: string | null;
  relevantEvents: DiagnosticFailedResource[];
  applicationVersion: string | null;
  /** Spec component identity of the blamed resource (phase 3) — absent when
   *  the deployment's frozen spec does not map it, never guessed. */
  componentId?: string | undefined;
  componentLabel?: string | undefined;
}

export type DiagnosticConfidence = 'high' | 'medium' | 'low';

/** Container stop evidence the relay observed (Phase 1), redacted before it reaches the wire. */
export interface ContainerEvidence {
  exitCode: number | null;
  stopCode: string | null;
  stoppedReason: string | null;
  stoppedTaskCount: number | null;
}

/** Structured startup evidence attached to a failed install; null when the relay sent none. */
export interface DiagnosticEvidence {
  container: ContainerEvidence | null;
}

/** The manual-retry action the API derived for the latest failure (Phase 2). */
export type RetryEligibilityAction =
  | 'RETRY_INSTALL'
  | 'DEPLOY_AGAIN'
  | 'CONTACT_DEPLOYZ'
  | 'WAIT'
  | 'NONE';

export interface RetryEligibility {
  action: RetryEligibilityAction;
  retryable: boolean;
  whoMustAct: 'VENDOR' | 'DEPLOYZ' | null;
}

export interface Diagnostic {
  failureCode: FailureCode;
  /** Where the what/why/fix text came from. */
  explanationSource: 'deterministic' | 'ai';
  /** How sure the model was; null for deterministic copy. */
  confidence: DiagnosticConfidence | null;
  /** The normalised context, for the technical layer. Null on older API responses. */
  context: DiagnosticContext | null;
  /** §61 recoverability class — which affordance the card leads with. */
  recoverability: FailureRecoverability | null;
  /** Structured container evidence; null when the relay observed none. */
  evidence: DiagnosticEvidence | null;
  /** The manual-retry signal; null when there is no failed job. */
  retryEligibility: RetryEligibility | null;
  event: DiagnosticEvent;
  explanation: DiagnosticExplanation | null;
  occurredAt: string;
}

interface DiagnosticsApiResponse {
  failureCode: string | null;
  recoverability?: string | null;
  what: string | null;
  why: string | null;
  fix: string | null;
  /**
   * What the relay said, verbatim (the failed job's error text). The API
   * serves it for exactly the §65 "Technical detail" disclosure — the web
   * client must not drop it on the floor.
   */
  technicalDetail?: string | null;
  context?: DiagnosticContext | null;
  source?: 'deterministic' | 'ai';
  confidence?: DiagnosticConfidence | null;
  /** Structured container evidence (Phase 1), redacted. Null when the relay sent none. */
  evidence?: DiagnosticEvidence | null;
  /** Manual-retry eligibility (Phase 2); null when there is no failed job. */
  retryEligibility?: RetryEligibility | null;
  events: Array<{
    occurredAt: string;
    eventType: string;
    result: string | null;
  }>;
}

// ── Response mapping ─────────────────────────────────────────────────────────

/**
 * Map the diagnostics endpoint's response onto the card list the UI renders.
 * Exported so the mapping is unit-testable without a fetch seam — the fetch
 * helper below is a thin wrapper over it.
 *
 * A healthy or non-failed deployment gets `failureCode: null`, which maps to
 * an empty list (the "no issues" state).
 */
export function toDiagnostics(body: DiagnosticsApiResponse): Diagnostic[] {
  if (!body.failureCode) return [];

  const latestEvent = body.events[body.events.length - 1];
  return [
    {
      failureCode: body.failureCode as FailureCode,
      explanationSource: body.source ?? 'deterministic',
      confidence: body.source === 'ai' ? (body.confidence ?? 'medium') : null,
      context: body.context ?? null,
      recoverability: (body.recoverability as FailureRecoverability | undefined) ?? null,
      evidence: body.evidence ?? null,
      retryEligibility: body.retryEligibility ?? null,
      occurredAt: latestEvent?.occurredAt ?? new Date().toISOString(),
      event: {
        source: 'deployment',
        ...(latestEvent ? { action: latestEvent.eventType } : {}),
        // §14.3/§65: the relay's verbatim error text belongs inside the card's
        // expandable "Technical detail" layer, exactly where the raw code and
        // message live. It used to be dropped here, leaving the disclosure
        // empty on every failure.
        ...(typeof body.technicalDetail === 'string' && body.technicalDetail.length > 0
          ? { error: { message: body.technicalDetail } }
          : {}),
      },
      explanation:
        body.what && body.why && body.fix
          ? { what: body.what, why: body.why, fix: body.fix }
          : null,
    },
  ];
}

// ── Fetch helper ────────────────────────────────────────────────────────────

/**
 * Fetch a deployment's diagnostics. The API returns a single what/why/fix
 * classification for the deployment (not one per event).
 */
export async function fetchDiagnostics(id: string): Promise<Diagnostic[]> {
  const response = await fetch(`${apiUrl}/api/deployments/${encodeURIComponent(id)}/diagnostics`, {
    credentials: 'include',
    cache: 'no-store',
    signal: readSignal(),
  });
  if (!response.ok) throw new Error(`Diagnostics request failed (${response.status})`);
  const body = (await response.json()) as DiagnosticsApiResponse;
  return toDiagnostics(body);
}

// ── Startup evidence + retry presentation helpers ───────────────────────────

/** How the vendor hero's retry area should present, from the API's eligibility. */
export type RetryCtaKind = 'retry' | 'contact-support' | 'none' | 'legacy';

/**
 * Map retryEligibility onto the hero's retry affordance. Null (no fetch yet, or
 * no failed job) keeps the existing "Retry deployment" button; the action value
 * then upgrades/replaces it: CONTACT_DEPLOYZ → a quiet support pointer,
 * RETRY_INSTALL/DEPLOY_AGAIN → the retry button, WAIT/NONE → nothing. The API
 * returns WAIT only for a deployment with a running release, where the day-2
 * actions are the controls and the heartbeat self-heal runs.
 */
export function retryCta(eligibility: RetryEligibility | null): RetryCtaKind {
  if (eligibility === null) return 'legacy';
  switch (eligibility.action) {
    case 'CONTACT_DEPLOYZ':
      return 'contact-support';
    case 'RETRY_INSTALL':
    case 'DEPLOY_AGAIN':
      return 'retry';
    case 'WAIT':
    case 'NONE':
      return 'none';
  }
}

// ── Relay-observed infrastructure checks ─────────────────────────────────────

/** One check as the relay observed it (verify.js emits {name, passed, detail}). */
export interface InfraCheck {
  name: string;
  passed: boolean;
  detail: string;
  /** `false` marks an informational observation — its failure is not an issue. */
  required?: boolean;
}

/** Whether a check represents an actual problem (informational checks never do). */
export function infraCheckIsIssue(check: InfraCheck): boolean {
  return !check.passed && check.required !== false;
}

export function infraCheckLabel(name: string): string {
  return relayCheckCopy(name).label;
}

/** How one relay check should present: matches its passed/required state. */
export type InfraCheckOutcome = 'passed' | 'issue' | 'not_required';

/** The §65 plain-English presentation of one relay check. */
export interface InfraCheckPresentation {
  label: string;
  outcome: InfraCheckOutcome;
  /** Compact status text — never the raw `detail` string. */
  statusText: string;
  /** The plain-English problem, present only when `outcome` is 'issue'. */
  problem: string | null;
  /** What to do next, present only when `outcome` is 'issue'. */
  nextAction: string | null;
}

/** Maps one relay check onto its §65 plain-English presentation. */
export function infraCheckPresentation(check: InfraCheck): InfraCheckPresentation {
  const copy = relayCheckCopy(check.name);
  if (check.passed) {
    return { label: copy.label, outcome: 'passed', statusText: copy.passed, problem: null, nextAction: null };
  }
  if (check.required === false) {
    return {
      label: copy.label,
      outcome: 'not_required',
      statusText: copy.notRequired ?? 'Not required',
      problem: null,
      nextAction: null,
    };
  }
  return {
    label: copy.label,
    outcome: 'issue',
    statusText: 'Needs attention',
    problem: copy.failed.problem,
    nextAction: copy.failed.nextAction,
  };
}

/**
 * The outcome of the latest relay infrastructure check, for the diagnostics
 * headline. 'unavailable' when no check has reported — never a pass. A
 * report is stale once the relay is not connected or has not reported
 * within RELAY_STALE_AFTER_MS (the API's own liveness window).
 */
export type InfraCheckReport =
  | { kind: 'unavailable' }
  | { kind: 'issues'; issues: InfraCheck[]; stale: boolean }
  | { kind: 'stale' }
  | { kind: 'passed' };

export function infraCheckReport(
  checks: readonly InfraCheck[],
  lastReportAt: string | null,
  relayStatus: RelayStatus,
  now: number = Date.now(),
): InfraCheckReport {
  if (checks.length === 0) return { kind: 'unavailable' };
  const reportedAt = lastReportAt ? Date.parse(lastReportAt) : Number.NaN;
  const stale =
    relayStatus !== 'CONNECTED' || !Number.isFinite(reportedAt) || now - reportedAt > RELAY_STALE_AFTER_MS;
  const issues = checks.filter((check) => infraCheckIsIssue(check));
  if (issues.length > 0) return { kind: 'issues', issues, stale };
  return stale ? { kind: 'stale' } : { kind: 'passed' };
}

/** Reads the relay's infrastructure checks out of observedState, if any. */
export function readInfraChecks(
  observedState: Record<string, unknown> | null,
): InfraCheck[] {
  const checks = (observedState as { infraHealth?: { checks?: unknown } } | null)?.infraHealth
    ?.checks;
  if (!Array.isArray(checks)) return [];
  return checks.flatMap((check) => {
    if (
      typeof check === 'object' &&
      check !== null &&
      'name' in check &&
      typeof (check as { name: unknown }).name === 'string' &&
      'passed' in check &&
      typeof (check as { passed: unknown }).passed === 'boolean' &&
      'detail' in check &&
      typeof (check as { detail: unknown }).detail === 'string'
    ) {
      return [check as InfraCheck];
    }
    return [];
  });
}

/** "3 minutes ago" style relative time for the last relay report. */
export function relativeTime(iso: string | null, now: Date = new Date()): string | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  const seconds = Math.max(0, Math.round((now.getTime() - then) / 1000));
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'} ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

// ── Redis provisioning truth ─────────────────────────────────────────────────

/**
 * Provisioning states for a Redis-requiring deployment. "Required and
 * detected" is not "provisioned": only the relay's cache check observing an
 * actual ElastiCache resource in AWS says the cache exists.
 */
export type RedisProvisioningStatus = 'HEALTHY' | 'UNHEALTHY' | 'NOT_PROVISIONED' | 'NOT_REPORTING';

export const REDIS_STATUS_LABEL: Record<RedisProvisioningStatus, string> = {
  HEALTHY: 'Healthy',
  UNHEALTHY: 'Unhealthy',
  NOT_PROVISIONED: 'Not provisioned',
  NOT_REPORTING: 'Not reporting',
};

/**
 * Derives Redis provisioning from observed AWS resources, never from
 * application analysis. Null when the application does not require Redis
 * (no row at all).
 */
export function redisProvisioningStatus(
  componentStatus: string | undefined,
  infraChecks: readonly InfraCheck[],
): RedisProvisioningStatus | null {
  if (componentStatus === undefined) return null;
  const cacheCheck = infraChecks.find((check) => check.name === 'cache');
  if (!cacheCheck) return 'NOT_REPORTING';
  if (!cacheCheck.passed) return 'NOT_PROVISIONED';
  if (componentStatus === 'UNHEALTHY' || componentStatus === 'DEGRADED') return 'UNHEALTHY';
  if (componentStatus === 'UNKNOWN') return 'NOT_REPORTING';
  return 'HEALTHY';
}
