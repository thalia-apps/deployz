/**
 * §19 compatibility rules engine — the deterministic readiness verdict.
 *
 * Since the semantic-readiness MVP, the single source of truth is the
 * readiness report (readiness-report.ts): findings classified REQUIRED vs
 * RECOMMENDED, and a semantic state (READY / ALMOST_READY / NEEDS_CHANGES).
 * This module bridges that report onto the persisted `compatibility_status`
 * enum. Purely deterministic (§20): same input → same verdict, no AI, no ML,
 * no randomness, no external calls.
 *
 * The verdict is the SINGLE SOURCE OF TRUTH. The AI layer only adds
 * human-language explanation and can NEVER flip a deterministic verdict —
 * `evaluateCompatibility` is a pure function, so no downstream caller can
 * change what it returns for a given input.
 */

import type { AnalysisResult } from './analyser.js';
import { buildReadinessReport, verdictFromReadiness } from './readiness-report.js';

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * §19 verdict vocabulary. Mirrors `compatibilityStatusEnum` in packages/db
 * (READY / NEEDS_ATTENTION / NOT_COMPATIBLE) — do not reorder or rename
 * without updating that enum.
 */
export type CompatibilityVerdict = 'READY' | 'NEEDS_ATTENTION' | 'NOT_COMPATIBLE';

/** Severity of a single compatibility issue. */
export type IssueSeverity = 'reject' | 'attention';

/** A single deterministic issue found by the rules engine. */
export interface CompatibilityIssue {
  /** `reject` issues force NOT_COMPATIBLE; `attention` issues force NEEDS_ATTENTION. */
  severity: IssueSeverity;
  /** Stable machine-readable code — the readiness finding id (e.g. 'container-setup'). */
  code: string;
  /** Human-readable, §65 jargon-free description. */
  message: string;
}

/** The §19 verdict plus the issues that produced it. */
export interface CompatibilityResult {
  verdict: CompatibilityVerdict;
  /** Human-readable, §65 jargon-free summary of why this verdict was reached. */
  reason: string;
  /** The REQUIRED readiness findings behind the verdict (empty on READY). */
  issues: CompatibilityIssue[];
}

// ── Rules engine ────────────────────────────────────────────────────────────

/**
 * Evaluate the §19 readiness verdict from an analysis result.
 *
 * Delegates to the semantic readiness report:
 *   - any blocking REQUIRED finding (a required capability gap) →
 *     NOT_COMPATIBLE;
 *   - any other REQUIRED finding (a setting or a repository change) →
 *     NEEDS_ATTENTION;
 *   - otherwise READY. RECOMMENDED findings (migrations for a detected
 *     database, a worker start command) never block READY.
 *
 * This function is PURE — same input → same output, synchronously, with no AI.
 */
export function evaluateCompatibility(result: AnalysisResult): CompatibilityResult {
  const report = buildReadinessReport(result);
  return {
    verdict: verdictFromReadiness(report.state),
    reason: report.summary,
    issues: report.findings
      .filter((f) => f.severity === 'required')
      .map((f) => ({
        severity: f.blocking ? ('reject' as const) : ('attention' as const),
        code: f.id,
        message: f.plainEnglishExplanation,
      })),
  };
}

// ── Verdict persistence ─────────────────────────────────────────────────────

/**
 * The four `applications` columns written by the verdict. Mirrors the
 * packages/db schema (read-only — this module never mutates the schema).
 */
export interface PersistedVerdict {
  /** Analysis ran successfully. */
  analysisStatus: 'COMPLETE';
  /** The deterministic §19 verdict. */
  compatibilityStatus: CompatibilityVerdict;
  /** Human-readable reason for the verdict. */
  compatibilityReason: string;
  /** The flattened detector metadata from `analyseRepo`. */
  detectedMetadata: Record<string, unknown>;
}

/**
 * Injectable DB seam for writing the verdict. The API layer supplies a
 * drizzle-backed implementation; tests supply a mock. Keeps the rules engine
 * framework-agnostic.
 */
export interface VerdictStore {
  update(applicationId: string, values: PersistedVerdict): Promise<void>;
}

/**
 * Compute the §19 verdict and persist it to the `applications` row.
 *
 * The verdict is computed by `evaluateCompatibility` and written verbatim —
 * no layer (including the AI layer) may alter the values between computation
 * and persistence.
 */
export async function persistVerdict(
  applicationId: string,
  result: AnalysisResult,
  db: VerdictStore,
): Promise<void> {
  const verdict = evaluateCompatibility(result);
  await db.update(applicationId, {
    analysisStatus: 'COMPLETE',
    compatibilityStatus: verdict.verdict,
    compatibilityReason: verdict.reason,
    detectedMetadata: result.metadata,
  });
}
