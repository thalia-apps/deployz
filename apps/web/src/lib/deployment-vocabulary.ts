/**
 * §46 product vocabulary + §65 copy mapping for the fleet surfaces.
 *
 * The UI must use the 9 product-language deployment states (§46) and
 * human-readable event labels (§65) — NEVER raw AWS/CFN/ECS/ALB lifecycle
 * terms at the top level. This module is the single source of truth for the
 * state → label/badge and event-type → label mappings, so a copy sweep
 * (todo 34) can migrate it into packages/copy-map without touching pages.
 */

import type { JobState, JobType } from '@deployz/contracts';

import { TONE_DOT } from '@/lib/status-tone';

// ── §46 deployment states ─────────────────────────────────────────────────

/** The 10 product-vocabulary deployment states (§46). Mirrors the contracts enum. */
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

/** Badge variant per state (maps to the shadcn/ui Badge variants). */
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

export function deploymentStateLabel(state: string): string {
  return DEPLOYMENT_STATE_LABELS[state as DeploymentState] ?? state;
}

// ── Measured runtime health ─────────────────────────────────────────────────

import type { ComponentState as WireComponentState, HealthStatus as WireHealthStatus } from './deployments';

export type HealthStatus = WireHealthStatus;
export type ComponentState = WireComponentState;

/**
 * Per-component labels. A component is infrastructure, not the deployment
 * itself, so "unknown" reads differently: the relay has not reported an
 * observation for it — "Not reporting" — and a required one the verifier
 * found no AWS resource for is "Not provisioned". Components an application
 * does not require are omitted entirely.
 */
export const COMPONENT_STATE_LABEL: Record<ComponentState, string> = {
  HEALTHY: 'Healthy',
  DEGRADED: 'Degraded',
  UNHEALTHY: 'Unhealthy',
  UNKNOWN: 'Not reporting',
  NOT_PROVISIONED: 'Not provisioned',
};

/** Status dot color per component state — paired with the label, never color alone. */
export const COMPONENT_STATE_DOT: Record<ComponentState, string> = {
  HEALTHY: TONE_DOT.positive,
  DEGRADED: TONE_DOT.attention,
  UNHEALTHY: TONE_DOT.negative,
  UNKNOWN: TONE_DOT.neutral,
  NOT_PROVISIONED: TONE_DOT.neutral,
};

/** Measured-health labels — the only user-facing wording for health. */
export const HEALTH_STATUS_LABEL: Record<HealthStatus, string> = {
  HEALTHY: 'Healthy',
  DEGRADED: 'Degraded',
  UNHEALTHY: 'Unhealthy',
  UNKNOWN: 'Health unknown',
};

export const HEALTH_STATUS_BADGE: Record<
  HealthStatus,
  'success' | 'warning' | 'destructive' | 'secondary'
> = {
  HEALTHY: 'success',
  DEGRADED: 'warning',
  UNHEALTHY: 'destructive',
  UNKNOWN: 'secondary',
};

/**
 * Status dot color per measured-health value — the one place a raw palette
 * color (amber for DEGRADED) is allowed, because "degraded" has no semantic
 * theme token. Paired with the text label; never color alone.
 */
export const HEALTH_STATUS_DOT: Record<HealthStatus, string> = {
  UNKNOWN: TONE_DOT.neutral,
  HEALTHY: TONE_DOT.positive,
  DEGRADED: TONE_DOT.attention,
  UNHEALTHY: TONE_DOT.negative,
};

/**
 * Whether the deployment carries a running application whose health is worth
 * reporting. Not-installed/deleted deployments have nothing running to
 * measure. FAILED splits on whether an install ever completed: a failed
 * FIRST install left nothing running ("Health unknown" would read as
 * "running, we just don't know how"), while a failed day-2 operation on a
 * previously installed deployment leaves the application serving — hiding
 * its health there would be the opposite lie (observed live: a failed
 * deploy-update flipped the page to "nothing running" while the app kept
 * answering behind the ALB).
 */
export function showHealthBadge(
  state: DeploymentState,
  currentReleaseId: string | null = null,
): boolean {
  if (state === 'NOT_INSTALLED' || state === 'WAITING_FOR_RELAY' || state === 'DELETED') {
    return false;
  }
  if (state === 'FAILED') return everInstalled(state, currentReleaseId);
  return true;
}

/**
 * Whether the deployment has per-component infrastructure worth listing.
 *
 * Not the same split as `showHealthBadge`: a FAILED deployment shows its
 * infrastructure even when no release ever ran, because the resource
 * snapshot of a failed first install is exactly what a vendor debugging the
 * failure needs (the stack may have created real resources before rolling
 * back). Only deployments nothing has ever tried to provision — or that have
 * been removed — hide the rows.
 */
export function showInfrastructureRows(
  state: DeploymentState,
  _currentReleaseId: string | null = null,
): boolean {
  if (state === 'NOT_INSTALLED' || state === 'WAITING_FOR_RELAY' || state === 'DELETED') {
    return false;
  }
  return true;
}

// ── Relay connectivity + capability gating ─────────────────────────────────

import type { RelayCapabilities, RelayStatus as WireRelayStatus } from './deployments';

export type RelayStatus = WireRelayStatus;

/** Relay connectivity labels, shared by the fleet list and detail page. */
export const RELAY_STATUS_LABEL: Record<RelayStatus, string> = {
  CONNECTED: 'Deployz connector online',
  DISCONNECTED: 'Deployz connector offline',
  UNKNOWN: 'Deployz connector not connected yet',
};

/** The connector's status where the row is already labelled "Deployz connector". */
export const CONNECTOR_STATUS_LABEL: Record<RelayStatus, string> = {
  CONNECTED: 'Online',
  DISCONNECTED: 'Offline',
  UNKNOWN: 'Not connected yet',
};

/** Day-2 actions gated on the installed relay advertising the capability. */
export type DeploymentAction = 'deploy' | 'rollback' | 'restart' | 'configUpdate' | 'disconnect';

const ACTION_CAPABILITY: Record<DeploymentAction, keyof RelayCapabilities> = {
  deploy: 'deployRelease',
  rollback: 'rollback',
  restart: 'restart',
  configUpdate: 'configUpdate',
  disconnect: 'destroy',
};

/**
 * Whether the installed relay advertised the capability an action needs.
 * Null capabilities (pre-capability relay) supports nothing — an enabled
 * button over a stub executor is worse than a disabled one.
 */
export function actionSupported(
  capabilities: RelayCapabilities | null,
  action: DeploymentAction,
): boolean {
  return capabilities !== null && capabilities[ACTION_CAPABILITY[action]] === true;
}

export const UNSUPPORTED_ACTION_COPY =
  'This action is not supported by the currently installed Deployz connector.';

/**
 * Whether `state` denotes a deployment that has completed at least one
 * install — as opposed to one that never has, either because it hasn't been
 * installed yet or because its only install attempt failed before a release
 * ever ran. `currentReleaseId` is the signal: the API only ever sets it once
 * a release has actually deployed, so a FAILED deployment that still carries
 * one failed later, after having run — not during its first install.
 *
 * Deploy/rollback/restart/config all act on a running application, so they
 * make no sense to offer here even when the relay has reported capabilities
 * (it can connect and advertise capabilities before an install completes).
 * Disconnect is deliberately NOT gated by this — a deployment that failed to
 * ever come up must still be removable.
 */
export function everInstalled(state: DeploymentState, currentReleaseId: string | null): boolean {
  if (state === 'NOT_INSTALLED' || state === 'WAITING_FOR_RELAY') return false;
  if (state === 'FAILED') return currentReleaseId !== null;
  return true;
}

export const NOT_YET_RUNNING_ACTION_COPY =
  "This deployment hasn't completed an install yet, so these actions aren't available.";

export const REMOVING_ACTION_COPY =
  'These actions are unavailable while this deployment is being removed.';

export const REMOVED_ACTION_COPY = 'This deployment has been removed, so these actions no longer apply.';

export const BUSY_ACTION_COPY =
  'Other actions become available when this operation finishes.';

/**
 * Why the day-2 actions are gated on a relay that is not currently
 * connected. The relay must fetch the queued job, so a relay that has never
 * connected (UNKNOWN) or has gone stale (DISCONNECTED — the API's liveness
 * sweep flips this after RELAY_STALE_AFTER_MS) would leave the action
 * REQUESTED until the watchdog fails it. Mirrors the API's
 * requireDeployableState refusals (RELAY_NOT_CONNECTED / RELAY_DISCONNECTED)
 * so the disabled button and the server-side refusal can never disagree.
 */
export const RELAY_UNREACHABLE_ACTION_COPY: Record<Exclude<RelayStatus, 'CONNECTED'>, string> = {
  UNKNOWN: "The Deployz connector has not connected to this deployment, so these actions aren't available.",
  DISCONNECTED: "The Deployz connector is offline, so these actions aren't available until it reconnects.",
};

/**
 * Why the day-2 actions are unavailable, or null when they are not.
 *
 * Order mirrors the API's refusals in call order (apps/api/src/server.ts):
 * a deployment being removed (or already gone) is gated by its own
 * lifecycle; one that never completed an install by that; then the relay's
 * liveness (`requireDeployableState` → RELAY_DISCONNECTED /
 * RELAY_NOT_CONNECTED); then an operation that owns the deployment
 * (`requireDeploymentIdle` → DEPLOYMENT_BUSY); and only last the connector's
 * capabilities. Reporting a lifecycle reason sent vendors to check a
 * connector that supports every action, and reporting a capability reason
 * for an offline (or busy) relay sent them to check a connector that is
 * simply not there.
 *
 * `busy` is whether a mutating job currently owns the deployment, which the
 * API decides from the job table (requireDeploymentIdle), not from `state` —
 * so callers pass it rather than having it inferred from a state value that
 * can lag behind.
 */
export function actionsUnavailableReason(input: {
  state: string;
  everRan: boolean;
  relayStatus: RelayStatus;
  busy?: boolean;
  anyCapabilityGatedOff: boolean;
}): string | null {
  if (input.state === 'DELETED') return REMOVED_ACTION_COPY;
  if (input.state === 'DELETING') return REMOVING_ACTION_COPY;
  if (!input.everRan) return NOT_YET_RUNNING_ACTION_COPY;
  if (input.relayStatus !== 'CONNECTED') return RELAY_UNREACHABLE_ACTION_COPY[input.relayStatus];
  if (input.busy) return BUSY_ACTION_COPY;
  return input.anyCapabilityGatedOff ? UNSUPPORTED_ACTION_COPY : null;
}

// ── §39 job vocabulary ──────────────────────────────────────────────────────

/** Human-readable §39 job type labels — the vendor progress card's "Latest
 *  job" row, never the raw enum value. */
export const JOB_TYPE_LABEL: Record<JobType, string> = {
  INSTALL: 'Install',
  DEPLOY_RELEASE: 'Deploy update',
  ROLLBACK: 'Rollback',
  RESTART: 'Restart',
  CONFIG_UPDATE: 'Configuration update',
  DESTROY: 'Remove deployment',
  MIGRATION: 'Database migration',
  INFRA_UPGRADE: 'Infrastructure upgrade',
  HEALTH_REPORT: 'Health report',
  PREFLIGHT: 'Pre-flight check',
  HEALTH_CHECK: 'Health check',
  CONFIGURE_DOMAIN: 'Domain setup',
  REMOVE_DOMAIN: 'Domain removal',
  PURGE: 'Resource purge',
};

/** Human-readable §39 job state labels, cased for prose rather than the raw
 *  enum shout. SUCCEEDED/SUCCESS are the same product-facing outcome. */
export const JOB_STATE_LABEL: Record<JobState, string> = {
  REQUESTED: 'Requested',
  QUEUED: 'Queued',
  WAITING: 'Waiting',
  RUNNING: 'Running',
  SUCCEEDED: 'Succeeded',
  SUCCESS: 'Succeeded',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
};

// ── Pre-relay install lifecycle (WAITING_FOR_RELAY) ────────────────────────

/**
 * Mirrors RELAY_STALE_AFTER_MS in @deployz/contracts — the API computes
 * `relayStuck` with the same window. The web app mirrors wire constants
 * locally rather than importing the contracts package.
 */
export const RELAY_STALE_AFTER_MS = 15 * 60 * 1000;

/**
 * Whether a WAITING_FOR_RELAY deployment has been waiting past the relay
 * staleness window. Never a failure — the bootstrap stack may still be
 * running, or may have failed before the connector started.
 */
export function relayWaitingStuck(
  installStartedAt: string | null,
  now: number = Date.now(),
): boolean {
  if (installStartedAt === null) return false;
  return now - Date.parse(installStartedAt) > RELAY_STALE_AFTER_MS;
}

/** Guidance shown on both the install page and the dashboard when stuck.
 *  §65: jargon-free on the customer install page — never names
 *  CloudFormation; "the setup in your AWS account" is all the customer (or
 *  vendor) needs to make sense of the wait. */
export const RELAY_STUCK_GUIDANCE =
  'Deployz has not connected to AWS yet. The setup in your AWS account may still be running, or it may have failed before the connector started.';

/**
 * The §24 component view in install-page display order, with customer
 * labels. The dashboard keeps its own ordering; this one reads top-down as
 * application first, cache last.
 */
export const INSTALL_COMPONENT_LABELS: readonly (readonly [key: string, label: string])[] = [
  ['application', 'Application'],
  ['loadBalancer', 'Load balancer'],
  ['database', 'Database'],
  ['storage', 'Storage'],
  ['redis', 'Redis cache'],
];

// ── Infrastructure inventory vocabulary ─────────────────────────────────────

import type {
  FleetDeploymentDetail,
  InfrastructureComponent,
  InfrastructureComponentKind,
  InfrastructureComponentStatus,
  InfrastructureExpectations,
  InfrastructureHttpsState,
  InfrastructureLifecycle,
  InfrastructureResponse,
  InfrastructureSummaryStatus,
} from './deployments';

/** Friendly labels for each logical infrastructure component kind. */
export const INFRASTRUCTURE_COMPONENT_NAME: Record<InfrastructureComponentKind, string> = {
  application: 'Application',
  database: 'Database',
  storage: 'Storage',
  cache: 'Cache',
  endpoint: 'Secure endpoint',
  network: 'Network',
  monitoring: 'Monitoring',
  container_registry: 'Container registry',
  other: 'Supporting resources',
};

/** Plain-English purpose for each logical infrastructure component kind. */
export const INFRASTRUCTURE_COMPONENT_PURPOSE: Record<InfrastructureComponentKind, string> = {
  application: 'Runs your application',
  database: 'Stores persistent application data',
  storage: 'Stores uploaded files',
  cache: 'Speeds up application requests',
  endpoint: 'Provides HTTPS access',
  network: 'Isolates application infrastructure',
  monitoring: 'Collects logs and health information',
  container_registry: 'Stores application images',
  other: 'Configuration secrets and other supporting resources',
};

export type InfrastructureStatusBadgeVariant =
  | 'success'
  | 'secondary'
  | 'destructive'
  | 'info'
  | 'warning';

/** Badge variant per component status — paired with the label, never color alone. */
export const INFRASTRUCTURE_STATUS_BADGE: Record<
  InfrastructureComponentStatus,
  InfrastructureStatusBadgeVariant
> = {
  pending: 'secondary',
  provisioning: 'info',
  ready: 'success',
  updating: 'info',
  deleting: 'info',
  failed: 'destructive',
  retained: 'secondary',
  removed: 'secondary',
  unknown: 'secondary',
};

/** Human-readable label per component status. */
export const INFRASTRUCTURE_STATUS_LABEL: Record<InfrastructureComponentStatus, string> = {
  pending: 'Pending',
  provisioning: 'Provisioning',
  ready: 'Ready',
  updating: 'Updating',
  deleting: 'Deleting',
  failed: 'Failed',
  retained: 'Retained',
  removed: 'Removed',
  unknown: 'Unknown',
};

/** Human-readable label per HTTPS provisioning state (`endpoint` component only). */
export const INFRASTRUCTURE_HTTPS_STATE_LABEL: Record<InfrastructureHttpsState, string> = {
  SETTING_UP: 'Setting up',
  WAITING_FOR_CERTIFICATE: 'Waiting for certificate',
  ACTIVATING: 'Activating HTTPS',
  READY: 'Ready',
  FAILED: 'Failed',
  REMOVING: 'Removing',
};

/** The HTTPS states that mean "being set up" — never true of a deployment being removed. */
const HTTPS_SET_UP_STATES: ReadonlySet<InfrastructureHttpsState> = new Set([
  'SETTING_UP',
  'WAITING_FOR_CERTIFICATE',
  'ACTIVATING',
]);

/**
 * The label to show on an infrastructure component's badge. The `endpoint`
 * component's `status` enum only ever says provisioning/ready/failed/
 * deleting — when the API has applied the truthful HTTPS state, that state
 * is the more specific, accurate label; every other component (and older
 * responses that omit `httpsState`) keeps the plain status label.
 */
export function infrastructureComponentStatusLabel(
  component: Pick<InfrastructureComponent, 'status' | 'httpsState'>,
  deploymentState?: string,
): string {
  if (deploymentState === 'DELETING' && component.httpsState && HTTPS_SET_UP_STATES.has(component.httpsState)) {
    return INFRASTRUCTURE_HTTPS_STATE_LABEL.REMOVING;
  }
  if (component.httpsState) {
    return INFRASTRUCTURE_HTTPS_STATE_LABEL[component.httpsState];
  }
  return INFRASTRUCTURE_STATUS_LABEL[component.status];
}

/**
 * The resources to list and count for a component. The inventory keeps the
 * rows of an earlier, rolled-back attempt; while the deployment exists, the
 * ones CloudFormation already deleted are history, not infrastructure. A
 * removed deployment keeps the full record.
 */
export function visibleResources<T extends { status: string }>(
  resources: readonly T[],
  deploymentState: string,
): T[] {
  if (deploymentState === 'DELETED') return [...resources];
  return resources.filter((resource) => resource.status !== 'DELETE_COMPLETE');
}

export type PurgeProgress = 'running' | 'complete' | null;

const ACTIVE_PURGE_JOB_STATES = new Set(['REQUESTED', 'QUEUED', 'WAITING', 'RUNNING']);

/**
 * Where "Delete retained data" stands for a removed deployment: `running`
 * while the latest PURGE job is active, `complete` once a purge verified that
 * nothing is left, otherwise null.
 */
export function purgeProgress(
  detail: Pick<FleetDeploymentDetail, 'state' | 'cleanupState' | 'jobs'>,
): PurgeProgress {
  if (detail.state !== 'DELETED') return null;
  const latest = detail.jobs
    .filter((job) => job.type === 'PURGE')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (latest && ACTIVE_PURGE_JOB_STATES.has(latest.state)) return 'running';
  return detail.cleanupState === 'COMPLETE' ? 'complete' : null;
}

/** "Database and Storage stay until you delete them" / "Storage stays until you delete it". */
export function retainedUntilDeletedSentence(names: string[]): string {
  const joined =
    names.length <= 2
      ? names.join(' and ')
      : `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
  return names.length === 1
    ? `${joined} stays until you delete it`
    : `${joined} stay until you delete them`;
}

/**
 * A component's operational status while the deployment exists. A resource
 * that CloudFormation kept (DELETE_SKIPPED, e.g. the bucket of a failed first
 * attempt) makes the API roll the whole component up to 'retained', even
 * when its current resources run. Retention is a removal policy (shown from
 * `lifecycle`), never a health state — so a component with current resources
 * reads as ready until the deployment is removed.
 */
export function operationalComponentStatus(
  component: Pick<InfrastructureComponent, 'status' | 'resources'>,
  deploymentState: string,
  purge: PurgeProgress = null,
): InfrastructureComponentStatus {
  if (purge && component.status === 'retained') {
    return purge === 'running' ? 'deleting' : 'removed';
  }
  if (deploymentState === 'DELETING' && (component.status === 'provisioning' || component.status === 'pending')) {
    return 'deleting';
  }
  if (component.status !== 'retained' || deploymentState === 'DELETED' || deploymentState === 'DELETING') {
    return component.status;
  }
  return visibleResources(component.resources, deploymentState).some(
    (resource) => resource.status !== 'DELETE_SKIPPED',
  )
    ? 'ready'
    : 'retained';
}

/** The summary status with the same operational reading as the components. */
export function operationalSummaryStatus(
  data: Pick<InfrastructureResponse, 'summary' | 'components'>,
  deploymentState: string,
  purge: PurgeProgress = null,
): InfrastructureSummaryStatus {
  if (purge === 'running' && data.summary.status === 'retained') return 'deleting';
  if (deploymentState === 'DELETING' && data.summary.status === 'provisioning') return 'deleting';
  if (data.summary.status !== 'retained' || deploymentState === 'DELETED' || deploymentState === 'DELETING') {
    return data.summary.status;
  }
  return data.components.every(
    (component) => operationalComponentStatus(component, deploymentState) !== 'retained',
  )
    ? 'healthy'
    : 'retained';
}

/**
 * The catalog kinds the manifest does not require and the inventory does not
 * have — rendered as "Not required" rows. Driven entirely by the API's
 * requirement-vs-inventory comparison (Phase 6); the page never re-derives
 * infrastructure intent itself (docs/ui-system.md).
 */
export function infrastructureNotRequiredKinds(
  expectations: Pick<InfrastructureExpectations, 'components'> | null,
): InfrastructureComponentKind[] {
  return (expectations?.components ?? [])
    .filter((component) => !component.expected && !component.present)
    .map((component) => component.kind);
}

/**
 * The catalog kinds the manifest requires but the inventory does not have —
 * rendered as "Missing" rows. Only meaningful once the deployment is past
 * the install phase: a component the relay has not created yet is normal
 * mid-install, not missing.
 */
export function infrastructureMissingKinds(
  expectations: Pick<InfrastructureExpectations, 'missing'> | null,
  state: DeploymentState,
): InfrastructureComponentKind[] {
  if (state === 'INSTALLING' || state === 'NOT_INSTALLED') return [];
  return expectations?.missing ?? [];
}

/** Plain-English lifecycle copy shown under each component. */
export const INFRASTRUCTURE_LIFECYCLE_LABEL: Record<InfrastructureLifecycle, string> = {
  retain: 'Retained when deployment is removed. AWS charges may continue until this resource is deleted.',
  delete: 'Removed automatically when the deployment is deleted.',
  snapshot: 'A snapshot is kept when the deployment is deleted.',
  conditional: 'Retention depends on the deployment\'s configuration.',
};

/** Human-readable label per summary status. */
export const INFRASTRUCTURE_SUMMARY_STATUS_LABEL: Record<InfrastructureSummaryStatus, string> = {
  healthy: 'Healthy',
  provisioning: 'Provisioning',
  updating: 'Updating',
  degraded: 'Degraded',
  failed: 'Failed',
  deleting: 'Deleting',
  retained: 'Retained',
  unknown: 'Unknown',
};

/** Badge variant per summary status — paired with the label, never color alone. */
export const INFRASTRUCTURE_SUMMARY_STATUS_BADGE: Record<
  InfrastructureSummaryStatus,
  InfrastructureStatusBadgeVariant
> = {
  healthy: 'success',
  provisioning: 'info',
  updating: 'info',
  degraded: 'warning',
  failed: 'destructive',
  deleting: 'info',
  retained: 'secondary',
  unknown: 'secondary',
};

// ── §65 event-type labels (§40 families) ──────────────────────────────────

/** The §40 event families (§65). Mirrors @deployz/copy-map verbatim. */
export const EVENT_FAMILIES = [
  'install',
  'deploy',
  'rollback',
  'config',
  'destroy',
  'health',
  'relay',
  'redis',
  'deploy_link',
  'invitation',
] as const;

export type EventFamily = (typeof EVENT_FAMILIES)[number];

/** First dot-segment of an event type, if it is one of the families. */
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
  deploy_link: 'Deploy link',
  invitation: 'Invitation',
};

/**
 * Specific human-readable labels for the event types emitted by the durable
 * workflows (todos 13, 17, 18). Unknown types fall back to the family label
 * (§65: jargon-free, never raw).
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
  'install.retry.requested': 'Installation retried',
  'install_link.opened': 'Customer opened the install link',
  'deployment.created': 'Deployment created',
  'application.preflight_evaluated': 'Pre-deployment checks',
  'relay.connected': 'Deployz connector connected',
  'default_https.certificate_requested': 'HTTPS certificate requested',
  'default_https.certificate_issued': 'HTTPS certificate issued',
  'default_https.dns_created': 'Application address created',
  'default_https.active': 'HTTPS active',
  'deploy.requested': 'Update started',
  'deploy.completed': 'Update complete',
  'deploy.failed': 'Update failed',
  'rollback.requested': 'Rollback started',
  'rollback.completed': 'Rolled back',
  'rollback.failed': 'Rollback failed',
  'restart.requested': 'Restart started',
  'restart.completed': 'Restarted',
  'restart.failed': 'Restart failed',
  'destroy.requested': 'Removal started',
  'destroy.completed': 'Deployment removed',
  'destroy.failed': 'Removal failed',
  'deployment.reconciled': 'Running version corrected from AWS',
  'deployment.state_recovered': 'Running and healthy — failure cleared',
  'deployment.install_not_verified': 'App never became healthy',
  'config.updated': 'Configuration updated',
  'config.failed': 'Configuration update failed',
  'health.reported': 'Health reported',
  'health.degraded': 'Health degraded',
  'health.unhealthy': 'Health critical',
  'health.recovered': 'Back to healthy',
  'ecs.rollout_failed': 'Deployment rollout failed',
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

  // Deploy Links (docs/deploy-links.md): vendor-minted customer entry
  // points. The deployment outcome itself still reports through the standard
  // install/deploy events — the link only opens the door.
  'deploy_link.created': 'Deploy link created',
  'deploy_link.opened': 'Customer opened the deploy link',
  'deploy_link.launched': 'Customer started the deployment',
  'deploy_link.retry.requested': 'Customer retried the deployment',
  'deploy_link.revoked': 'Deploy link revoked',
  'deploy_link.regenerated': 'Deploy link regenerated',

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

// ── §62 event result labels ───────────────────────────────────────────────

/**
 * Human-readable label for an event `result` value. The raw result (which may
 * carry a §61 failure code referencing a service) stays behind the expandable
 * payload layer; the top level shows only this jargon-free label (§65).
 */
export function eventResultLabel(result: string | null): string | null {
  if (result === null) return null;
  // A historical request is a fact, not ongoing state — the event-type
  // label already says what happened, so no badge at all beats a "Pending"
  // that reads as in-progress forever.
  if (result === 'pending') return null;
  if (result === 'ok' || result === 'passed' || result === 'success') return 'Succeeded';
  if (result === 'skipped') return 'Skipped';
  if (isFailureResult(result)) return 'Failed';
  return result;
}

/** The API writes event results as 'success'/'failure'; older writers used
 *  'failed…'-prefixed codes. Both families mean the event failed. */
function isFailureResult(result: string): boolean {
  return result === 'failure' || result.startsWith('failed');
}

/**
 * The human-readable failure reason to show at the top level of a failed
 * event, if it carries one. Previously this text only ever reached the
 * customer inside the collapsed JSON payload disclosure — a vendor debugging
 * a stuck deployment had to know to open every event to find it. `null` when
 * the event did not fail, or failed without a non-empty `payload.error`
 * string worth surfacing.
 */
export function eventFailureReason(
  result: string | null,
  payload: Record<string, unknown>,
): string | null {
  if (result === null || !isFailureResult(result)) return null;
  const error = payload['error'];
  return typeof error === 'string' && error.trim().length > 0 ? error : null;
}
