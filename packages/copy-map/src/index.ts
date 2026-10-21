/**
 * @deployz/copy-map — single source of truth for product vocabulary.
 *
 * Every user-facing label, badge variant, and copy string flows from this
 * module. Pages import from here (or from a web-local re-export that mirrors
 * these values) — never hardcode status strings, failure labels, or verdict
 * copy. §46: raw CFN/ECS statuses must be UNREACHABLE at the UI edge; this
 * module is the gate.
 *
 * §65 copy principles (documented below as §65_RULES) govern every label:
 * jargon-free top level, expandable technical detail, no raw AWS/CFN/ECS/IAM
 * terms at the top level.
 */

// ── §65 copy principles ─────────────────────────────────────────────────────

/**
 * The §65 copy rules that govern every user-facing string in Deployz.
 *
 * 1. **Jargon-free top level** — the first thing a user reads must be plain
 *    English. No "CloudFormation", "ECS", "RDS", "IAM", "ALB", "Lambda", "VPC",
 *    or "CFN" at the top level.
 *
 * 2. **Expandable technical detail** — raw service names, exact permission
 *    ARNs, and infrastructure identifiers live behind expandable sections
 *    (`<details>`, collapsible cards, "Technical detail" headings). The user
 *    chooses to see them.
 *
 * 3. **No raw AWS terms at top level** — even when the underlying system is
 *    AWS, the copy describes WHAT happens, not WHICH service does it.
 *    "Deployment failed" not "ECS deployment failed"; "Database unreachable"
 *    not "RDS unavailable".
 *
 * 4. **Honest trust story** — never claim permissions are "tiny" or
 *    "minimal" when they are substantial. Describe the boundary honestly.
 *
 * 5. **Masked secrets** — secrets are write-only. The UI shows "***" or a
 *    masked placeholder; plaintext never appears in API responses, event
 *    payloads, or serialized state.
 */
export const COPY_RULES_65 = {
  JARGON_FREE_TOP_LEVEL: true,
  EXPANDABLE_TECHNICAL_DETAIL: true,
  NO_RAW_AWS_TERMS_AT_TOP_LEVEL: true,
  HONEST_TRUST_STORY: true,
  MASKED_SECRETS: true,
} as const;

/** Regex matching raw AWS/CFN/ECS/IAM terms that must not appear at the top level. */
export const JARGON_PATTERN = /\b(CloudFormation|IAM|ECS|ALB|Lambda|VPC|CFN|RDS)\b/i;

// ── §46 deployment states ───────────────────────────────────────────────────

/** The product-vocabulary deployment states (§46). */
export const DEPLOYMENT_STATES = [
  'NOT_INSTALLED',
  'WAITING_FOR_RELAY',
  'INSTALLING',
  'HEALTHY',
  'UPDATING',
  'UPDATE_AVAILABLE',
  'FAILED',
  'DISCONNECTED',
  'DELETING',
  'DELETED',
] as const;

export type DeploymentState = (typeof DEPLOYMENT_STATES)[number];

/** Human-readable §46 labels — the only user-facing status wording. */
export const DEPLOYMENT_STATE_LABELS: Record<DeploymentState, string> = {
  NOT_INSTALLED: 'Not installed',
  WAITING_FOR_RELAY: 'Waiting for AWS',
  INSTALLING: 'Installing',
  HEALTHY: 'Healthy',
  UPDATING: 'Updating',
  UPDATE_AVAILABLE: 'Update available',
  FAILED: 'Failed',
  DISCONNECTED: 'Disconnected',
  DELETING: 'Deleting',
  DELETED: 'Deleted',
};

/** Badge variant per state (maps to shadcn/ui Badge variants). */
export type DeploymentBadgeVariant =
  | 'default'
  | 'secondary'
  | 'destructive'
  | 'outline'
  | 'success'
  | 'warning'
  | 'info';

export const DEPLOYMENT_STATE_BADGE: Record<DeploymentState, DeploymentBadgeVariant> = {
  NOT_INSTALLED: 'secondary',
  WAITING_FOR_RELAY: 'secondary',
  INSTALLING: 'info',
  HEALTHY: 'success',
  UPDATING: 'info',
  UPDATE_AVAILABLE: 'secondary',
  FAILED: 'destructive',
  DISCONNECTED: 'destructive',
  DELETING: 'info',
  DELETED: 'secondary',
};

/** Look up a human-readable label for a deployment state string. */
export function deploymentStateLabel(state: string): string {
  return DEPLOYMENT_STATE_LABELS[state as DeploymentState] ?? state;
}

// ── Customer deployment rollup ──────────────────────────────────────────────

/**
 * The Customers list answers one question per row: has this customer
 * deployed, and must the vendor act? These six values are that answer — a
 * read-time rollup of the customer's §46 deployment states, not a new
 * persisted lifecycle and never a raw CloudFormation status.
 */
export const CUSTOMER_DEPLOYMENT_STATUSES = [
  'NOT_INSTALLED',
  'INSTALLING',
  'LIVE',
  'NEEDS_ATTENTION',
  'REMOVING',
  'REMOVED',
] as const;

export type CustomerDeploymentRollup = (typeof CUSTOMER_DEPLOYMENT_STATUSES)[number];

export const CUSTOMER_DEPLOYMENT_STATUS_LABELS: Record<CustomerDeploymentRollup, string> = {
  NOT_INSTALLED: 'Not installed',
  INSTALLING: 'Installing',
  LIVE: 'Live',
  NEEDS_ATTENTION: 'Needs attention',
  REMOVING: 'Removing',
  REMOVED: 'Removed',
};

export const CUSTOMER_DEPLOYMENT_STATUS_BADGE: Record<
  CustomerDeploymentRollup,
  DeploymentBadgeVariant
> = {
  NOT_INSTALLED: 'secondary',
  INSTALLING: 'info',
  LIVE: 'success',
  NEEDS_ATTENTION: 'warning',
  REMOVING: 'secondary',
  REMOVED: 'secondary',
};

// ── §40 event families ──────────────────────────────────────────────────────

/** The §40 event families (§65): install/deploy/rollback/config/destroy/health/relay/redis/invitation. */
export const EVENT_FAMILIES = [
  'install',
  'deploy',
  'rollback',
  'config',
  'destroy',
  'health',
  'relay',
  'redis',
  'invitation',
] as const;

export type EventFamily = (typeof EVENT_FAMILIES)[number];

/** First dot-segment of an event type, if it is one of the known families. */
export function eventFamily(eventType: string): EventFamily | null {
  const family = eventType.split('.')[0];
  if (!family) return null;
  return (EVENT_FAMILIES as readonly string[]).includes(family)
    ? (family as EventFamily)
    : null;
}

const FAMILY_LABELS: Record<EventFamily, string> = {
  install: 'Installation',
  deploy: 'Update',
  rollback: 'Rollback',
  config: 'Configuration',
  destroy: 'Teardown',
  health: 'Health',
  relay: 'Helper',
  redis: 'Cache',
  invitation: 'Invitation',
};

/**
 * Specific human-readable labels for the event types emitted by the durable
 * workflows. Unknown types fall back to the family label (§65: jargon-free,
 * never raw).
 */
const EVENT_TYPE_LABELS: Record<string, string> = {
  'install.preflight.region': 'Region check',
  'install.preflight.scp': 'Account policy check',
  'install.relay.contact': 'First check-in from the helper',
  'install.state.installing': 'Installation started',
  'install.relay.health': 'First health report',
  'install.state.healthy': 'Installed and healthy',

  'deploy.preflight': 'Pre-deployment checks',
  'deploy.state.updating': 'Update started',
  'deploy.migration': 'Database migration',
  'deploy.ecs-update': 'New version deployed',
  'deploy.infra-upgrade': 'Infrastructure upgrade',
  'deploy.health': 'Health check after update',
  'deploy.state.healthy': 'Update complete',
  'deploy.state.update-available': 'Update available',

  'rollback.state.updating': 'Rollback started',
  'rollback.disclosure': 'Rollback scope',
  'rollback.restore': 'Previous version restored',
  'rollback.health': 'Health check after rollback',
  'rollback.state.healthy': 'Rolled back and healthy',

  // The API emits only the coarse transition points it records itself
  // (install.requested, deploy.completed, ...). The finer-grained step events
  // above — and the config/redis step vocabulary further below — belong to
  // the durable-workflow layer removed in Phase 13; their labels are kept so
  // event rows recorded while that layer existed still render.
  'install.requested': 'Installation started',
  'install.launched': 'AWS install launched',
  'install.completed': 'Installed and healthy',
  'install.failed': 'Installation failed',
  'install.enrollment.rejected': 'Another helper tried to connect',
  'deploy.requested': 'Update started',
  'deploy.completed': 'Update complete',
  'deploy.failed': 'Update failed',
  'rollback.requested': 'Rollback started',
  'rollback.completed': 'Rolled back',
  'rollback.failed': 'Rollback failed',
  'destroy.requested': 'Removal started',
  'destroy.completed': 'Deployment removed',
  'destroy.failed': 'Removal failed',
  'config.updated': 'Configuration updated',
  'health.reported': 'Health reported',
  'health.degraded': 'Health degraded',
  'health.recovered': 'Back to healthy',
  'relay.reenrollment.requested': 'Reconnect requested',

  'config.validate': 'Configuration checked',
  'config.write': 'Configuration updated',
  'config.health': 'Health check after configuration change',
  'config.state.healthy': 'Configuration applied',

  'redis.provision.started': 'Setting up cache',
  'redis.provision.succeeded': 'Cache ready',
  'redis.provision.failed': 'Cache setup failed',

  // Watchdog/reconciler events (§65: never raw state names).
  'operation.timeout': 'Operation took too long',
  'operation.waiting_for_relay': 'Waiting for AWS connection',
  'operation.requeued': 'Operation resumed after an interruption',

  // Installation invitations (MVP Readiness 2): the vendor-created customer
  // entry points. The deployment outcome itself still reports through the
  // standard install/deploy events — the invitation only opens the door.
  'invitation.created': 'Invitation created',
  'invitation.opened': 'Customer opened the invitation',
  'invitation.regenerated': 'Invitation regenerated',
  'invitation.revoked': 'Invitation revoked',
  'invitation.confirmed': 'Invitation confirmed',
  'invitation.region_selected': 'Region selected',
  'invitation.deployment_created': 'Deployment created',
  'invitation.configuration_delivered': 'Configuration delivered',
};

/** Human-readable label for an event type (§65). */
export function eventTypeLabel(eventType: string): string {
  const specific = EVENT_TYPE_LABELS[eventType];
  if (specific) return specific;
  const family = eventFamily(eventType);
  if (family) return FAMILY_LABELS[family];
  return titleCase(eventType);
}

function titleCase(value: string): string {
  const last = value.split('.').pop() ?? value;
  return last
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── §62 event result labels ─────────────────────────────────────────────────

/**
 * Human-readable label for an event `result` value. The raw result (which may
 * carry a §61 failure code referencing a service) stays behind the expandable
 * payload layer; the top level shows only this jargon-free label (§65).
 */
export function eventResultLabel(result: string | null): string | null {
  if (result === null) return null;
  if (result === 'ok' || result === 'passed') return 'Succeeded';
  if (result === 'skipped') return 'Skipped';
  if (result.startsWith('failed')) return 'Failed';
  return result;
}

// ── §61 failure codes ───────────────────────────────────────────────────────

/** The twenty §61 stable failure codes. */
export const FAILURE_CODES = [
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
] as const;

/** A §61 failure code — exactly the twenty values in `FAILURE_CODES`. */
export type FailureCode = (typeof FAILURE_CODES)[number];

/** Severity drives the color-coded badge: critical (destructive) vs warning. */
export type FailureSeverity = 'critical' | 'warning';

/**
 * §61 recoverability — what kind of intervention (if any) a failure needs.
 * Drives which affordance the diagnostics UI leads with, instead of the
 * one-size-fits-all "retry" hint every code used to get.
 *
 *  - RECONCILE_FIRST: the state may repair itself (relay returning, watchdog
 *    re-offer, transient AWS condition) — wait/check before acting.
 *  - USER_ACTION: the vendor or their customer must change something
 *    (permissions, quota, app configuration) before a retry can succeed.
 *  - DEPLOYZ_ACTION: the fault is on Deployz's side of the boundary —
 *    contact support rather than retrying in a loop.
 *  - TERMINAL: retrying can never succeed as-is (unsupported input).
 */
export type FailureRecoverability =
  | 'RECONCILE_FIRST'
  | 'USER_ACTION'
  | 'DEPLOYZ_ACTION'
  | 'TERMINAL';

/** Recoverability per §61 code. */
export const FAILURE_RECOVERABILITY: Record<FailureCode, FailureRecoverability> = {
  AWS_SCP_BLOCKED: 'USER_ACTION',
  PORT_MISMATCH: 'USER_ACTION',
  REGION_NOT_SUPPORTED: 'TERMINAL',
  QUOTA_EXCEEDED: 'USER_ACTION',
  IMAGE_HEALTH_CHECK_FAILED: 'USER_ACTION',
  MIGRATION_FAILED: 'USER_ACTION',
  RELAY_DISCONNECTED: 'RECONCILE_FIRST',
  ECS_DEPLOYMENT_FAILED: 'USER_ACTION',
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

/** §65 one-liner per recoverability class, shown on the diagnostic card. */
export const RECOVERABILITY_COPY: Record<FailureRecoverability, string> = {
  RECONCILE_FIRST: 'This can be temporary. Retry when the cause clears. If it continues, contact Deployz support.',
  USER_ACTION: 'Needs a change before a retry can succeed — see the fix above.',
  DEPLOYZ_ACTION: 'This needs a fix on the Deployz side — contact support rather than retrying.',
  TERMINAL: 'Retrying will not help until the underlying requirement changes.',
};

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
 * Human-readable §65 copy for every §61 failure code. The label + description
 * are plain English — never raw AWS service names at the top level (§65).
 * The raw code lives behind the expandable technical-detail layer.
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
 * The §61 codes that name the application's own startup/config work — the
 * vendor must fix the app (or its configuration) before a retry can
 * succeed; Deployz and the customer have nothing to do. The single source
 * for both the server's customer-projection flag and any web-side gating.
 */
export const APP_OWNED_STARTUP_FAILURE_CODES: ReadonlySet<FailureCode> = new Set([
  'CONTAINER_START_FAILED',
  'IMAGE_HEALTH_CHECK_FAILED',
  'DATABASE_CONNECTION_FAILED',
  'MIGRATION_FAILED',
  'MISSING_SECRET',
  'PORT_MISMATCH',
]);

/**
 * The §61 codes whose remediation sends the vendor to the Configuration
 * screen. Other failures do not show a Configuration action: changing a
 * value would not fix them. A test keeps this in step with the remediation
 * copy.
 */
export const CONFIGURATION_FAILURE_CODES: ReadonlySet<FailureCode> = new Set([
  'CONTAINER_START_FAILED',
  'MISSING_SECRET',
]);

/** §29 what happened / why / how to fix, per failure code. */
export interface FailureRemediation {
  /** What happened, in the vendor's terms. */
  what: string;
  /** Why it happened. */
  why: string;
  /** The next action the vendor (or their customer) can actually take. */
  fix: string;
}

/**
 * §29 remediation per §61 failure code.
 *
 * The diagnostics endpoint used to answer every failure with the same three
 * hardcoded sentences — "Deployment failed / The deployment did not reach a
 * healthy state / Check the event log for details and retry the deployment" —
 * regardless of what the relay reported. That last line also pointed at an
 * event log the vendor had no way to see. These are per-code, and every fix
 * names something the reader can do.
 *
 * §65 applies as strictly here as anywhere: no CloudFormation, IAM, ECS, ALB,
 * VPC or RDS in this copy. The raw code and the relay's own message sit
 * behind the "Technical detail" disclosure for anyone who wants them.
 */
export const FAILURE_REMEDIATION: Record<FailureCode, FailureRemediation> = {
  AWS_SCP_BLOCKED: {
    what: 'Setup was blocked by a policy in your customer’s cloud organization.',
    why: 'Their organization restricts what can be created in this account or region.',
    fix: 'Ask your customer to allow the Deployz setup in this account, or to choose an account without that restriction, then run the install link again.',
  },
  PORT_MISMATCH: {
    what: 'The application started but nothing answered on the expected port.',
    why: 'The port Deployz was told to route traffic to is not the port the app listens on.',
    fix: 'Check the port on the application’s settings screen against the one your app binds, correct it, and deploy again.',
  },
  REGION_NOT_SUPPORTED: {
    what: 'This deployment cannot run in the region it was created for.',
    why: 'Deployz does not support that region yet.',
    fix: 'Remove this deployment and create it again in a supported region.',
  },
  QUOTA_EXCEEDED: {
    what: 'Your customer’s cloud account hit a resource limit during setup.',
    why: 'The account has reached the maximum it is allowed for one of the resources this deployment needs.',
    fix: 'Ask your customer to request a limit increase from their cloud provider, then deploy again.',
  },
  IMAGE_HEALTH_CHECK_FAILED: {
    what: 'The application started but never reported itself healthy.',
    why: 'The health check endpoint did not return a success response within the startup window.',
    fix: 'Confirm the health check path on the application’s settings screen returns a 200 once the app is ready, then deploy again.',
  },
  MIGRATION_FAILED: {
    what: 'The database migration step failed, so the new version was not started.',
    why: 'The migration command exited with an error.',
    fix: 'Fix the migration in your repository, publish a new release, and deploy it.',
  },
  RELAY_DISCONNECTED: {
    what: 'The helper running in your customer’s cloud account stopped checking in.',
    why: 'It was removed, it lost its credential, or the account can no longer reach Deployz.',
    fix: 'Ask your customer to update the existing connector stack in their AWS account. If they cannot, contact Deployz support.',
  },
  ECS_DEPLOYMENT_FAILED: {
    what: 'The new version could not be rolled out.',
    why: 'The updated application did not reach a running state, so the rollout was stopped.',
    fix: 'Open Technical detail for the reported error, fix it in a new release, and deploy again.',
  },
  AWS_PERMISSION_DENIED: {
    what: 'The helper was refused permission for something this deployment needs.',
    why: 'The permissions granted at install time do not cover this action.',
    fix: 'Ask your customer to re-run the install link so the setup can grant the current permissions.',
  },
  STACK_CREATE_FAILED: {
    what: 'The initial setup in your customer’s account did not complete.',
    why: 'One of the resources being created failed, so the whole setup was rolled back.',
    fix: 'Open Technical detail for the failing resource, then ask your customer to run the install link again.',
  },
  STACK_DELETE_FAILED: {
    what: 'Disconnecting this deployment did not complete.',
    why: 'One of the resources being removed failed, so the removal stopped part-way.',
    fix: 'Open Technical detail for the failing resource, then retry the disconnect. Your data is safe — the database and files are kept.',
  },
  RDS_AZ_CAPACITY: {
    what: "The cloud provider couldn't create the database — not enough capacity in the available zones.",
    why: 'The account has enough quota, but the specific zone or zones where the database would run have no room for a new instance right now.',
    fix: 'Wait for the previous attempt to finish rolling back, then run the install link again. If it keeps failing, contact Deployz support.',
  },
  DATABASE_CREATE_FAILED: {
    what: 'The database could not be created.',
    why: 'The account rejected the database this application requires.',
    fix: 'Check whether your customer’s account limits databases in this region, then run the install link again.',
  },
  DATABASE_CONNECTION_FAILED: {
    what: 'The application started but could not reach its database.',
    why: 'The connection was refused or timed out.',
    fix: 'Confirm the application reads its database settings from the environment Deployz provides, then deploy again.',
  },
  IMAGE_PULL_FAILED: {
    what: 'The application image could not be downloaded into your customer’s account.',
    why: 'The image is missing, or the account is not allowed to download it.',
    fix: 'Contact Deployz support. The image must be made available again before this deployment can continue.',
  },
  CONTAINER_START_FAILED: {
    what: 'The application started and then stopped.',
    why: 'It exited during startup — often a wrong start command or port, a missing required value, or an error before it began serving.',
    fix: "Check the start command, the port and the required values on the Configuration screen, then deploy again. The application's logs are in your customer's cloud account.",
  },
  MISSING_SECRET: {
    what: 'A required secret has no value for this customer.',
    why: 'The application asks for a secret that is not set as a default or an override.',
    fix: 'Set the missing value on the Configuration screen, then deploy again.',
  },
  TEMPLATE_UNAVAILABLE: {
    what: 'The installation template could not be fetched.',
    why: 'The installation template for this region is missing or unreachable from the customer account.',
    fix: 'Contact Deployz support — the regional template needs to be published before installations can proceed in this region.',
  },
  UNSUPPORTED_ARCHITECTURE: {
    what: 'This application cannot be deployed as it is built.',
    why: 'It uses something Deployz does not support.',
    fix: 'Open the application’s readiness screen for the specific change needed, make it, and publish a new release.',
  },
  UNKNOWN: {
    what: 'The deployment failed.',
    why: 'The helper reported a failure without a cause Deployz recognises.',
    fix: 'Open Technical detail for the reported error, then deploy again. If it keeps failing, remove the deployment and create it again.',
  },
  REDIS_PROVISIONING_FAILED: {
    what: 'The cache this application needs could not be set up.',
    why: 'A limit was hit, or the resource was rejected, in your customer’s cloud account while the cache was being created.',
    fix: 'Contact Deployz support. Your customer can also check their cloud account’s service limits for caches in this region.',
  },
  REDIS_CONNECTION_FAILED: {
    what: 'The application started but could not reach its cache.',
    why: 'The connection was refused or timed out.',
    fix: 'Redeploy the application. If it keeps failing, contact Deployz support.',
  },
  DOMAIN_OPERATION_TIMEOUT: {
    what: 'A custom domain change stopped responding and was timed out.',
    why: 'The helper did not finish the domain update within the allowed window.',
    fix: 'Wait for the next automatic check, or press Check now on the custom domain card, to retry. The deployment itself is unaffected.',
  },
  RELAY_STATE_WRITE_FAILED: {
    what: 'Deployz lost track of an install that was still running in your customer’s cloud account.',
    why: 'The Deployz connector could not save its own progress marker.',
    fix: 'Contact Deployz support. The setup may have finished on its own, so check the deployment status first.',
  },
};

/** Badge variant for a severity (maps to shadcn/ui Badge variants). */
export type FailureBadgeVariant = 'destructive' | 'warning';

export const FAILURE_SEVERITY_BADGE: Record<FailureSeverity, FailureBadgeVariant> = {
  critical: 'destructive',
  warning: 'warning',
};

/** Status dot tone class for a severity. */
export const FAILURE_SEVERITY_DOT: Record<FailureSeverity, string> = {
  critical: 'bg-destructive',
  warning: 'bg-amber-500',
};

/**
 * Generic fallback for the why/fix sections when the AI explanation isn't
 * available yet (still §65 jargon-free — never fabricated detail).
 */
export const EXPLANATION_FALLBACK = {
  why: 'The cause is still being narrowed down. The technical detail below shows the signals we have.',
  fix: "If the cause isn't clear from the detail below, contact Deployz support.",
} as const;

/**
 * The §61 code for a stored failure code. A database value with no copy
 * (RDS_UNAVAILABLE, which no code produces) reads as UNKNOWN.
 */
export function knownFailureCode(code: string): FailureCode {
  return (FAILURE_CODES as readonly string[]).includes(code) ? (code as FailureCode) : 'UNKNOWN';
}

/** §65 lookup for a failure code — falls back safely to UNKNOWN copy. */
export function failureCodeCopy(code: string): FailureCopy {
  return FAILURE_CODE_COPY[code as FailureCode] ?? FAILURE_CODE_COPY.UNKNOWN;
}

/** §61 recoverability lookup — falls back to UNKNOWN's class. */
export function failureRecoverability(code: string): FailureRecoverability {
  return FAILURE_RECOVERABILITY[code as FailureCode] ?? FAILURE_RECOVERABILITY.UNKNOWN;
}

/**
 * §65 jargon-free phrase for a raw CloudFormation stack status, for the ONE
 * place a stack status reaches the unauthenticated customer surface
 * (failure.technical on the install page). Vendors keep the raw status;
 * customers get this instead of `ROLLBACK_COMPLETE`.
 */
export function customerStackStatusLabel(rawStatus: string): string {
  if (/^DELETE_FAILED$/.test(rawStatus)) return 'Removal was blocked';
  if (/^UPDATE_ROLLBACK/.test(rawStatus)) return 'Update was rolled back';
  if (/ROLLBACK/.test(rawStatus)) return 'Setup was rolled back';
  if (/FAILED/.test(rawStatus)) return 'Setup did not complete';
  if (/DELETE/.test(rawStatus)) return 'Removal in progress';
  if (/IN_PROGRESS/.test(rawStatus)) return 'Still in progress';
  if (/COMPLETE/.test(rawStatus)) return 'Completed';
  return 'State unavailable';
}

// ── §19 readiness verdicts ──────────────────────────────────────────────────

/** §19 verdict vocabulary: READY / NEEDS_ATTENTION / NOT_COMPATIBLE. */
export const COMPATIBILITY_VERDICTS = [
  'READY',
  'NEEDS_ATTENTION',
  'NOT_COMPATIBLE',
] as const;

export type CompatibilityVerdict = (typeof COMPATIBILITY_VERDICTS)[number];

// ── Semantic readiness states ───────────────────────────────────────────────

/**
 * The semantic readiness vocabulary the UI shows — never a percentage.
 * READY: all required checks pass. ALMOST_READY: only fixable required
 * findings remain. NEEDS_CHANGES: an architectural incompatibility.
 * ANALYSIS_INCOMPLETE: analysis has not completed (pending or failed).
 */
export const READINESS_STATES = [
  'READY',
  'ALMOST_READY',
  'NEEDS_CHANGES',
  'ANALYSIS_INCOMPLETE',
] as const;

export type ReadinessState = (typeof READINESS_STATES)[number];

export interface ReadinessStatePresentation {
  /** Short badge label. */
  label: string;
  /** Visual tone — READY is green (§19). */
  tone: 'ready' | 'attention' | 'incompatible' | 'pending';
}

export const READINESS_STATE_PRESENTATION: Record<ReadinessState, ReadinessStatePresentation> = {
  READY: { label: 'Ready', tone: 'ready' },
  ALMOST_READY: { label: 'Action needed', tone: 'attention' },
  NEEDS_CHANGES: { label: 'Changes needed', tone: 'incompatible' },
  ANALYSIS_INCOMPLETE: { label: 'Checking…', tone: 'pending' },
};

/** Map a persisted §19 verdict onto the semantic readiness state. */
export function readinessStateFromVerdict(verdict: CompatibilityVerdict): ReadinessState {
  if (verdict === 'READY') return 'READY';
  if (verdict === 'NEEDS_ATTENTION') return 'ALMOST_READY';
  return 'NEEDS_CHANGES';
}

/** "2 changes needed before deployment" — a blocked state, never "almost
 *  ready": as long as a required check fails, deployment is blocked. */
export function readinessChangesHeading(count: number): string {
  return `${count} ${count === 1 ? 'change' : 'changes'} needed before deployment`;
}

/** The state headline. Blocked states read out the change count (§65:
 *  never "Almost ready" while deployment is actually blocked). */
export function readinessStateHeading(state: ReadinessState, changesCount: number): string {
  if (state === 'READY') return 'Ready to deploy';
  if (state === 'ANALYSIS_INCOMPLETE') return 'Checking deployment readiness…';
  return readinessChangesHeading(changesCount);
}

/** "4 of 6 checks passed" — a check count, never a percentage. */
export function readinessChecksLabel(passedCount: number, totalCount: number): string {
  return `${passedCount} of ${totalCount} checks passed`;
}

/** Supporting line under a blocked state's heading. */
export function readinessBlockedSummary(
  passedCount: number,
  totalCount: number,
  changesCount: number,
): string {
  return `Your application passed ${passedCount} of ${totalCount} deployment checks. Fix the ${
    changesCount === 1 ? 'item' : 'items'
  } below before deploying.`;
}

/** Supporting line for the READY state. */
export const READINESS_SUPPORT_READY = 'Your application passed all required deployment checks.';

/** Supporting line while the analysis is still running. */
export const READINESS_SUPPORT_RUNNING =
  "We're reading your repository to see if it can be deployed. This usually takes a minute.";

/** Supporting line under the fix-instructions CTA. */
export function readinessFixCtaSupport(issuesCount: number): string {
  return `Creates one prompt to fix ${
    issuesCount === 1 ? 'this 1 issue' : `these ${issuesCount} issues`
  } with your coding agent.`;
}

// ── §65 relay verification checks ───────────────────────────────────────────

/** The relay's infrastructure-verification check names (packages/relay/src/verify.ts). */
export const RELAY_CHECK_NAMES = [
  'stack-exists',
  'stack-complete',
  'stack-tagged',
  'compute',
  'ingress',
  'database',
  'storage',
  'cache',
  'verification-error',
] as const;

export type RelayCheckName = (typeof RELAY_CHECK_NAMES)[number];

export interface RelayCheckCopy {
  /** Plain-English name of what was checked. */
  label: string;
  /** Shown when the check passed. */
  passed: string;
  /** Shown when a REQUIRED check failed: the problem, then what to do. */
  failed: { problem: string; nextAction: string };
  /** Shown when an informational (required: false) check did not pass. */
  notRequired?: string;
}

/**
 * §65 jargon-free copy for each relay verification check. The raw `detail`
 * string the relay reports (e.g. "Stack status CREATE_COMPLETE") stays behind
 * the diagnostics page's "Technical detail" disclosure — this is what shows
 * first.
 */
export const RELAY_CHECK_COPY: Record<RelayCheckName, RelayCheckCopy> = {
  'stack-exists': {
    label: 'Infrastructure present',
    passed: "Found in the customer's AWS account",
    failed: {
      problem: "Deployz could not find this deployment's infrastructure in the customer's AWS account.",
      nextAction: 'Confirm the installation finished and the Deployz connector runs in the same AWS account and region.',
    },
  },
  'stack-complete': {
    label: 'Infrastructure provisioning',
    passed: 'Completed',
    failed: {
      problem: 'The infrastructure setup did not finish successfully.',
      nextAction: 'Check the deployment page for the cause, or retry the installation from there.',
    },
  },
  'stack-tagged': {
    label: 'Installation ownership',
    passed: 'Belongs to this deployment',
    failed: {
      problem: 'The infrastructure found in AWS belongs to a different installation.',
      nextAction: 'Remove the other installation, or install this deployment into a different AWS account or region.',
    },
  },
  compute: {
    label: 'Application service',
    passed: 'Running',
    failed: {
      problem: 'The application service was not created.',
      nextAction: 'Wait for the current operation to finish. If this stays, check the recent activity for the cause.',
    },
  },
  ingress: {
    label: 'Load balancer',
    passed: 'Running',
    failed: {
      problem: 'The load balancer was not created.',
      nextAction: 'Wait for the current operation to finish. If this stays, check the recent activity for the cause.',
    },
  },
  database: {
    label: 'Database',
    passed: 'Available',
    failed: {
      problem: 'The database was not created.',
      nextAction: 'Wait for the current operation to finish. If this stays, check the recent activity for the cause.',
    },
  },
  storage: {
    label: 'Storage',
    passed: 'Available',
    failed: {
      problem: 'The storage bucket was not created.',
      nextAction: 'Wait for the current operation to finish. If this stays, check the recent activity for the cause.',
    },
  },
  cache: {
    label: 'Cache',
    passed: 'Available',
    failed: {
      problem: 'The cache was not created.',
      nextAction: 'Wait for the current operation to finish. If this stays, check the recent activity for the cause.',
    },
    notRequired: 'Not required',
  },
  'verification-error': {
    label: 'Verification',
    passed: 'Completed',
    failed: {
      problem: 'Deployz could not verify the infrastructure on the last check.',
      nextAction: 'Wait for the next check. If this repeats, contact Deployz support.',
    },
  },
};

/** Fallback copy for a relay check name this module does not recognize. */
export const RELAY_CHECK_FALLBACK_COPY: RelayCheckCopy = {
  label: 'Infrastructure check',
  passed: 'Passed',
  failed: {
    problem: "A check on the deployment's infrastructure did not pass.",
    nextAction: 'Wait for the next check. If this stays, check the recent activity for the cause.',
  },
};

/** §65 lookup for a relay check name — falls back safely to the generic copy. */
export function relayCheckCopy(name: string): RelayCheckCopy {
  return RELAY_CHECK_COPY[name as RelayCheckName] ?? RELAY_CHECK_FALLBACK_COPY;
}

// ── Plan components (dynamic infrastructure) ────────────────────────────────

/**
 * Plan component kind labels — the wording a deployment plan uses per kind.
 * The five catalog kinds reuse the wording the plans already carry
 * (INFRASTRUCTURE_COMPONENT_DISPLAY); 'worker', 'queue' and 'schedule' are
 * wire-level kinds until their capabilities are implemented. Group headings
 * live in @deployz/contracts (PLAN_COMPONENT_GROUP_DISPLAY) — the one home.
 */
export const PLAN_COMPONENT_KIND_DISPLAY: Record<string, string> = {
  application: 'Application',
  endpoint: 'Secure endpoint',
  database: 'Database',
  cache: 'Cache',
  storage: 'Storage',
  worker: 'Background worker',
  queue: 'Queue',
  schedule: 'Scheduled job',
};

/** Copy for a release's infrastructure-change statement. */
export const RELEASE_INFRASTRUCTURE_COPY = {
  noChanges: 'No infrastructure changes',
  changedTitle: 'Infrastructure requirements changed',
  changedBody: 'This release needs infrastructure changes. Deployz cannot apply them to an existing deployment. Create a new deployment for each customer that needs this release.',
} as const;

// ── §42 onboarding steps ────────────────────────────────────────────────────

/** The six §42 onboarding steps, in exact order. Success = readiness (§5). */
export const ONBOARDING_STEPS = [
  'Connect GitHub',
  'Choose repository',
  'Analyse',
  'Fix compatibility issues',
  'Create test deployment',
  'Ready for customer deployment',
] as const;

// ── §31 secret mask ─────────────────────────────────────────────────────────

/** The value used to mask secrets in API responses and event payloads (§31). */
export const SECRET_MASK = '***';
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

// ── Release build failures (AI MVP Phase 8) ─────────────────────────────────

/**
 * The plain-English summary of a version build failure, from the failure
 * reason the worker stores ("CodeBuild reported FAILED — POST_BUILD: …").
 * Deterministic and ordered; the raw reason stays available as technical
 * detail. Never names the build service.
 */
export function releaseBuildFailureSummary(reason: string | null): string {
  const text = (reason ?? '').toLowerCase();
  // Before the timeout test: a rate-limited build is not the application's
  // fault and must not read as one. The build already retried on its own.
  if (/rate limit \(http 429\)/.test(text)) {
    return 'The container registry temporarily limited image downloads. Start the build again in a few minutes.';
  }
  if (/timed_out|timed out|timeout/.test(text)) return 'The version build ran out of time.';
  if (/download_source|could not fetch|repo tarball|clone/.test(text)) return 'The build could not fetch the repository.';
  if (/post_build|docker push|denied: requested access|upload_artifacts/.test(text)) {
    return 'The version was built but could not be stored in the image registry.';
  }
  if (/provisioning|install|queued|submitted/.test(text)) return 'The build could not start.';
  // The buildspec's final check says only that no image exists. It names no
  // cause, so the summary must not blame the repository.
  if (/did not produce an image/.test(text)) return 'The image build failed. This message does not show the cause.';
  if (/build:|command_execution_error|docker build|pre_build/.test(text)) {
    return 'The version could not be built from the repository.';
  }
  return 'The version build failed.';
}
