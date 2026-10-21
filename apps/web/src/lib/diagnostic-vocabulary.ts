import { TONE_DOT } from '@/lib/status-tone';

/**
 * §61 failure-code vocabulary + §65 copy mapping for the diagnostics surface.
 *
 * The UI must render each failure in what/why/fix form with a jargon-free top
 * level (§65) — NEVER raw AWS/ECS/CFN/IAM terms. This module is the web-local
 * mirror of the code → label/description/severity mapping; it deliberately
 * does NOT value-import @deployz/copy-map (a value import pulls the package
 * into every route's module graph and inflates next-dev compilation), and
 * copy-map-parity.test.ts fails when the mirror drifts from the package.
 *
 * The §61 codes mirror `failureCodeEnum` (packages/db) and the classifier's
 * `FAILURE_CODES` (packages/cdk) verbatim, following the same web-local
 * pattern as `deployment-vocabulary.ts` (todo 19).
 */

// ── §61 failure codes ───────────────────────────────────────────────────────

/** The twenty §61 stable failure codes (mirrors copy-map verbatim). */
export const FAILURE_CODES = [
  'AWS_SCP_BLOCKED',
  'PORT_MISMATCH',
  'REGION_NOT_SUPPORTED',
  'QUOTA_EXCEEDED',
  'IMAGE_HEALTH_CHECK_FAILED',
  'MIGRATION_FAILED',
  'RELAY_DISCONNECTED',
  'ECS_DEPLOYMENT_FAILED',
  'RDS_UNAVAILABLE',
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
] as const;

/** A §61 failure code — exactly the twenty values in `FAILURE_CODES`. */
export type FailureCode = (typeof FAILURE_CODES)[number];

// ── §65 labels + descriptions ───────────────────────────────────────────────

/** Severity drives the color-coded badge: critical (destructive) vs warning. */
export type FailureSeverity = 'critical' | 'warning';

/** The §65 top-level copy for one failure code. */
export interface FailureCopy {
  /** Short, jargon-free label (e.g. "Cloud policy blocks this"). */
  label: string;
  /** One jargon-free sentence summarizing the failure. */
  description: string;
  /** Color-coded severity. */
  severity: FailureSeverity;
}

/**
 * Human-readable §65 copy for every §61 failure code — a web-local mirror of
 * @deployz/copy-map's FAILURE_CODE_COPY (current values; the parity test
 * fails on drift). The label + description are plain English — never raw AWS
 * service names at the top level (§65). The raw code lives behind the
 * expandable technical-detail layer.
 */
export const FAILURE_CODE_COPY: Record<FailureCode, FailureCopy> = {
  AWS_SCP_BLOCKED: {
    label: 'Cloud policy blocks this',
    description: "A policy in your organization's cloud account is blocking the setup.",
    severity: 'critical',
  },
  PORT_MISMATCH: {
    label: 'Port conflict',
    description:
      'Your app listens on one port, but the service expects another. The vendor needs to correct it before deployment can continue.',
    severity: 'warning',
  },
  REGION_NOT_SUPPORTED: {
    label: 'Region not supported',
    description: "The chosen region isn't one we can deploy to yet.",
    severity: 'warning',
  },
  QUOTA_EXCEEDED: {
    label: 'Account limit reached',
    description: 'Your cloud account has hit a resource limit.',
    severity: 'warning',
  },
  IMAGE_HEALTH_CHECK_FAILED: {
    label: 'Health check failing',
    description:
      "The app started, but its health check isn't passing. The vendor needs to fix the application before deployment can continue.",
    severity: 'warning',
  },
  MIGRATION_FAILED: {
    label: 'Migration failed',
    description:
      "A database migration step didn't finish successfully. The vendor needs to fix the application before deployment can continue.",
    severity: 'critical',
  },
  RELAY_DISCONNECTED: {
    label: 'Helper disconnected',
    description: 'The helper in your cloud account is no longer checking in.',
    severity: 'critical',
  },
  ECS_DEPLOYMENT_FAILED: {
    label: 'Deployment failed',
    description: "The new version couldn't be rolled out.",
    severity: 'critical',
  },
  RDS_UNAVAILABLE: {
    label: 'Database unreachable',
    description: "The database isn't reachable right now.",
    severity: 'critical',
  },
  AWS_PERMISSION_DENIED: {
    label: 'Permission denied',
    description: "Your cloud account doesn't allow this action.",
    severity: 'critical',
  },
  STACK_CREATE_FAILED: {
    label: 'Setup failed',
    description: "The initial setup couldn't complete.",
    severity: 'critical',
  },
  STACK_DELETE_FAILED: {
    label: 'Disconnect failed',
    description: "The removal couldn't complete. Your data is safe.",
    severity: 'critical',
  },
  RDS_AZ_CAPACITY: {
    label: 'Database capacity unavailable',
    description:
      "The cloud provider doesn't have enough capacity for the database in the available zones. Retry after the previous attempt is fully rolled back.",
    severity: 'warning',
  },
  DATABASE_CREATE_FAILED: {
    label: 'Database setup failed',
    description: "The database couldn't be created.",
    severity: 'critical',
  },
  DATABASE_CONNECTION_FAILED: {
    label: 'Database connection failed',
    description:
      "The app can't reach the database. The vendor needs to fix the application before deployment can continue.",
    severity: 'critical',
  },
  IMAGE_PULL_FAILED: {
    label: 'Image pull failed',
    description: "The app image couldn't be loaded.",
    severity: 'critical',
  },
  CONTAINER_START_FAILED: {
    label: 'App failed to start',
    description:
      'The application stopped shortly after starting. The vendor needs to fix the application before deployment can continue.',
    severity: 'critical',
  },
  MISSING_SECRET: {
    label: 'Missing secret',
    description:
      'A required secret is not configured. The vendor needs to set it before deployment can continue.',
    severity: 'warning',
  },
  TEMPLATE_UNAVAILABLE: {
    label: 'Installation template unavailable',
    description: "The installation template couldn't be fetched from the cloud region.",
    severity: 'critical',
  },
  UNSUPPORTED_ARCHITECTURE: {
    label: 'Unsupported architecture',
    description: "This app's architecture isn't supported yet.",
    severity: 'warning',
  },
  UNKNOWN: {
    label: 'Unknown issue',
    description: "Something failed and we couldn't pin down the cause.",
    severity: 'critical',
  },
  REDIS_PROVISIONING_FAILED: {
    label: 'Cache setup failed',
    description: "The cache this application needs couldn't be set up.",
    severity: 'critical',
  },
  REDIS_CONNECTION_FAILED: {
    label: "App can't reach its cache",
    description: "The app started, but it can't reach its cache.",
    severity: 'critical',
  },
  DOMAIN_OPERATION_TIMEOUT: {
    label: 'Custom domain update timed out',
    description: 'The custom domain change did not finish in time. It can be retried.',
    severity: 'warning',
  },
  RELAY_STATE_WRITE_FAILED: {
    label: 'Deployz lost track of the install',
    description: 'The Deployz connector could not save its progress, even though setup was still running.',
    severity: 'critical',
  },
};

/**
 * Generic fallback for the why/fix sections when the AI explanation isn't
 * available yet (still §65 jargon-free — never fabricated detail).
 */
export const EXPLANATION_FALLBACK = {
  why: 'The cause is still being narrowed down. The technical detail below shows the signals we have.',
  fix: "If the cause isn't clear from the detail below, contact Deployz support.",
} as const;

// ── Presentation helpers ────────────────────────────────────────────────────

/** Badge variant for a severity (maps to the shadcn/ui Badge variants). */
export type FailureBadgeVariant = 'destructive' | 'warning';

export const FAILURE_SEVERITY_BADGE: Record<FailureSeverity, FailureBadgeVariant> = {
  critical: 'destructive',
  warning: 'warning',
};

/** Status dot tone class for a severity. */
export const FAILURE_SEVERITY_DOT: Record<FailureSeverity, string> = {
  critical: TONE_DOT.negative,
  warning: TONE_DOT.attention,
};

/** §65 lookup for a failure code — falls back safely to UNKNOWN copy. */
export function failureCodeCopy(code: string): FailureCopy {
  return FAILURE_CODE_COPY[code as FailureCode] ?? FAILURE_CODE_COPY.UNKNOWN;
}

// ── App-owned startup failures ──────────────────────────────────────────────

/**
 * The §61 codes that name the application's own startup/config work — the
 * vendor must fix the app before a retry can succeed; Deployz and the customer
 * have nothing to do. The vendor detail hero and the customer install card
 * both headline these as "Application couldn't start".
 */
export const APP_OWNED_STARTUP_FAILURE_CODES = [
  'CONTAINER_START_FAILED',
  'IMAGE_HEALTH_CHECK_FAILED',
  'DATABASE_CONNECTION_FAILED',
  'MIGRATION_FAILED',
  'MISSING_SECRET',
  'PORT_MISMATCH',
] as const satisfies readonly FailureCode[];

/** An app-owned startup failure code. */
export type AppOwnedStartupFailureCode = (typeof APP_OWNED_STARTUP_FAILURE_CODES)[number];

/** True when a failure code names the application's own startup. */
export function isAppOwnedStartupFailure(
  code: string | null | undefined,
): code is AppOwnedStartupFailureCode {
  return (
    code !== null &&
    code !== undefined &&
    (APP_OWNED_STARTUP_FAILURE_CODES as readonly string[]).includes(code)
  );
}

/**
 * The §61 codes whose fix is on the Configuration screen (mirrors copy-map
 * verbatim). The deployment page offers the Configuration action after a
 * failure only for these codes.
 */
export const CONFIGURATION_FAILURE_CODES = [
  'CONTAINER_START_FAILED',
  'MISSING_SECRET',
] as const satisfies readonly FailureCode[];

/** True when a failure code is fixed on the Configuration screen. */
export function isConfigurationFailure(code: string): boolean {
  return (CONFIGURATION_FAILURE_CODES as readonly string[]).includes(code);
}

/** §65 headline for a failed first install whose app could not start. */
export const STARTUP_FAILURE_TITLE = "Application couldn't start";

/** §65 reassurance on the customer card — the vendor owns this, not them. */
export const STARTUP_FAILURE_CUSTOMER_NOTE = 'No action is required from you.';

// ── §61 recoverability (mirrors @deployz/copy-map verbatim) ─────────────────

/** §61 recoverability — what kind of intervention (if any) a failure needs. */
export type FailureRecoverability =
  | 'RECONCILE_FIRST'
  | 'USER_ACTION'
  | 'DEPLOYZ_ACTION'
  | 'TERMINAL';

/** Recoverability per §61 code (mirrors @deployz/copy-map verbatim). */
export const FAILURE_RECOVERABILITY: Record<FailureCode, FailureRecoverability> = {
  AWS_SCP_BLOCKED: 'USER_ACTION',
  PORT_MISMATCH: 'USER_ACTION',
  REGION_NOT_SUPPORTED: 'TERMINAL',
  QUOTA_EXCEEDED: 'USER_ACTION',
  IMAGE_HEALTH_CHECK_FAILED: 'USER_ACTION',
  MIGRATION_FAILED: 'USER_ACTION',
  RELAY_DISCONNECTED: 'RECONCILE_FIRST',
  ECS_DEPLOYMENT_FAILED: 'USER_ACTION',
  RDS_UNAVAILABLE: 'RECONCILE_FIRST',
  AWS_PERMISSION_DENIED: 'USER_ACTION',
  STACK_CREATE_FAILED: 'USER_ACTION',
  STACK_DELETE_FAILED: 'USER_ACTION',
  RDS_AZ_CAPACITY: 'USER_ACTION',
  DATABASE_CREATE_FAILED: 'USER_ACTION',
  DATABASE_CONNECTION_FAILED: 'RECONCILE_FIRST',
  IMAGE_PULL_FAILED: 'DEPLOYZ_ACTION',
  CONTAINER_START_FAILED: 'USER_ACTION',
  MISSING_SECRET: 'USER_ACTION',
  TEMPLATE_UNAVAILABLE: 'DEPLOYZ_ACTION',
  UNSUPPORTED_ARCHITECTURE: 'TERMINAL',
  UNKNOWN: 'RECONCILE_FIRST',
  REDIS_PROVISIONING_FAILED: 'DEPLOYZ_ACTION',
  REDIS_CONNECTION_FAILED: 'RECONCILE_FIRST',
  DOMAIN_OPERATION_TIMEOUT: 'RECONCILE_FIRST',
  RELAY_STATE_WRITE_FAILED: 'DEPLOYZ_ACTION',
};

/** §65 one-liner per recoverability class (mirrors @deployz/copy-map verbatim). */
export const RECOVERABILITY_COPY: Record<FailureRecoverability, string> = {
  RECONCILE_FIRST: 'This can be temporary. Retry when the cause clears. If it continues, contact Deployz support.',
  USER_ACTION: 'Needs a change before a retry can succeed — see the fix above.',
  DEPLOYZ_ACTION: 'This needs a fix on the Deployz side — contact support rather than retrying.',
  TERMINAL: 'Retrying will not help until the underlying requirement changes.',
};

// ── AI explanation confidence (AI MVP Phase 7) ──────────────────────────────

/**
 * How the diagnostic card frames an AI-written explanation. High confidence
 * reads like deterministic copy; anything lower is presented as a reading,
 * never a verdict. Null means no hedge line.
 */
export const AI_CONFIDENCE_COPY = {
  high: null,
  medium: 'Deployz is fairly sure of this reading. Check the technical detail before acting on it.',
  low: 'Deployz could not determine the exact cause. This is its best reading of the most relevant failure — treat it as a lead, not a verdict.',
} as const;

/** Shown beside an AI-written explanation so the vendor knows its origin. */
export const AI_EXPLANATION_SOURCE_NOTE = 'Explained by Deployz from the failure signals.';
