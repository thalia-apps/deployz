// One place that says what a deployment's status means to the vendor, so the
// Deployments badge, its status filter, the default sort and the Customers
// summary cannot drift apart.
//
// Two layers, kept apart on purpose:
//  - the precise status of ONE deployment (`deploymentDisplayStatus`): a
//    specific label such as "Starting application" or "Lost contact", and the
//    coarse filter group it belongs to;
//  - the customer-level bucket a deployment counts toward
//    (`customerBucket`), which the Customers list aggregates.
// Both are derived at read time from the §46 `state` and the columns the fleet
// API already returns. Nothing here is persisted and no raw AWS status reaches
// a label.

import { everInstalled, relayWaitingStuck, type DeploymentBadgeVariant } from '@/lib/deployment-vocabulary';
import type { FleetDeployment } from '@/lib/deployments';
import { attentionReason } from '@/lib/home-state';

const DAY_TWO_JOB_TYPES = new Set(['DEPLOY_RELEASE', 'ROLLBACK', 'RESTART', 'CONFIG_UPDATE']);

// ── Filter groups ───────────────────────────────────────────────────────────

/** Ordered by operational priority — a group's index is its default-sort rank:
 *  what needs the vendor first, removed last. */
export const STATUS_GROUPS = [
  'attention',
  'in-progress',
  'waiting',
  'update-available',
  'healthy',
  'removed',
] as const;

export type StatusGroup = (typeof STATUS_GROUPS)[number];

export const STATUS_GROUP_LABELS: Record<StatusGroup, string> = {
  attention: 'Failed or needs attention',
  'in-progress': 'In progress',
  waiting: 'Waiting for customer',
  'update-available': 'Update available',
  healthy: 'Live',
  removed: 'Removed',
};

/** The order the status filter lists its options in. */
export const STATUS_FILTER_GROUPS: readonly StatusGroup[] = [
  'healthy',
  'in-progress',
  'attention',
  'waiting',
  'update-available',
  'removed',
];

export function isStatusGroup(value: string): value is StatusGroup {
  return (STATUS_GROUPS as readonly string[]).includes(value);
}

export function statusGroupRank(group: StatusGroup): number {
  return STATUS_GROUPS.indexOf(group);
}

// ── Precise per-deployment status ───────────────────────────────────────────

export interface DeploymentDisplayStatus {
  group: StatusGroup;
  label: string;
  badge: DeploymentBadgeVariant;
}

/**
 * Which kind of "failed" a FAILED deployment reads as (ux-guidelines §5): a
 * removal (the latest job is DESTROY), an update on a deployment that was
 * already live (a day-2 job on one that completed at least one install), or
 * the first install itself. Never guessed from anything but the job the
 * server attached to this status.
 */
function failedStatus(deployment: FleetDeployment): DeploymentDisplayStatus {
  const jobType = deployment.deploymentStatus?.job?.type;
  if (jobType === 'DESTROY') {
    return { group: 'attention', label: 'Removal failed', badge: 'destructive' };
  }
  if (
    jobType &&
    DAY_TWO_JOB_TYPES.has(jobType) &&
    everInstalled(deployment.state, deployment.currentReleaseId)
  ) {
    return { group: 'attention', label: 'Update failed', badge: 'destructive' };
  }
  return { group: 'attention', label: 'Install failed', badge: 'destructive' };
}

// Same precedence as the detail page's hero (lib/deployment-hero.ts), so the
// badge and the headline never tell two stories: a failed operation first
// (Failed outranks Needs attention, ux-guidelines §5), then the connector,
// then measured health, which overrides any in-flight operation label.
function attentionStatus(deployment: FleetDeployment): DeploymentDisplayStatus {
  if (deployment.state === 'FAILED') return failedStatus(deployment);
  // The latest day-2 attempt failed while the previous release still serves.
  if (deployment.deploymentStatus?.failure) {
    return { group: 'attention', label: 'Update failed', badge: 'destructive' };
  }
  // Nothing writes state DISCONNECTED today (the liveness sweep sets
  // relayStatus). Kept like the API's defensive branch in
  // deriveDeploymentStatus, because the value stays in the state enum.
  if (deployment.state === 'DISCONNECTED') {
    return { group: 'attention', label: 'Needs attention · Disconnected', badge: 'destructive' };
  }
  if (deployment.relayStatus === 'DISCONNECTED') {
    return { group: 'attention', label: 'Needs attention · Lost contact', badge: 'destructive' };
  }
  if (deployment.healthStatus === 'UNHEALTHY') {
    return { group: 'attention', label: 'Needs attention · Not responding', badge: 'destructive' };
  }
  return { group: 'attention', label: 'Needs attention · Degraded', badge: 'warning' };
}

/**
 * The precise status one deployment row shows, and the group the status
 * filter puts it under. The §46 `state` is the anchor; attention is the one
 * overlay on top (a HEALTHY deployment whose relay went quiet reads "Needs
 * attention · Lost contact"). A state this build does not know is surfaced
 * as attention rather than hidden or passed off as live.
 */
export function deploymentDisplayStatus(deployment: FleetDeployment): DeploymentDisplayStatus {
  // Removal first: a deployment on its way out is neither live nor failing.
  if (deployment.state === 'DELETED') {
    return { group: 'removed', label: 'Removed', badge: 'secondary' };
  }
  if (deployment.state === 'DELETING') {
    return { group: 'in-progress', label: 'Removing', badge: 'info' };
  }
  if (attentionReason(deployment) !== null) return attentionStatus(deployment);

  switch (deployment.state as string) {
    case 'NOT_INSTALLED':
      return { group: 'waiting', label: 'Waiting for customer', badge: 'secondary' };
    case 'WAITING_FOR_RELAY':
      // Past the staleness window the detail page shows the stuck guidance;
      // the list carries the same cue so it does not read as normal progress.
      return relayWaitingStuck(deployment.installStartedAt)
        ? { group: 'in-progress', label: 'Setting up · Slow to connect', badge: 'warning' }
        : { group: 'in-progress', label: 'Setting up', badge: 'info' };
    case 'INSTALLING':
      return { group: 'in-progress', label: 'Setting up', badge: 'info' };
    case 'UPDATING':
      return { group: 'in-progress', label: 'Updating', badge: 'info' };
    case 'UPDATE_AVAILABLE':
      return { group: 'update-available', label: 'Live', badge: 'success' };
    case 'HEALTHY':
      if (deployment.deploymentStatus?.health?.notStarted) {
        return { group: 'in-progress', label: 'Not started', badge: 'secondary' };
      }
      return { group: 'healthy', label: 'Live', badge: 'success' };
    default:
      return { group: 'attention', label: 'Needs attention · Unknown status', badge: 'warning' };
  }
}

// ── Customer-level buckets ──────────────────────────────────────────────────

export const CUSTOMER_BUCKETS = ['active', 'attention', 'pending', 'removing', 'removed'] as const;

export type CustomerBucket = (typeof CUSTOMER_BUCKETS)[number];

/**
 * What one deployment counts as on the Customers list. Derived from the same
 * classification the Deployments list uses, so a customer whose deployment
 * reads "Failed" there is "needs attention" here. A live app being updated is
 * still active; setup that has not finished — including one the customer has
 * not started — is pending.
 */
export function customerBucket(deployment: FleetDeployment): CustomerBucket {
  if (deployment.state === 'DELETED') return 'removed';
  if (deployment.state === 'DELETING') return 'removing';
  const { group } = deploymentDisplayStatus(deployment);
  if (group === 'attention') return 'attention';
  if (group === 'healthy' || group === 'update-available') return 'active';
  if (deployment.state === 'UPDATING') return 'active';
  return 'pending';
}

/** The badge each bucket's count wears in the Customers summary. */
export const CUSTOMER_BUCKET_BADGE: Record<CustomerBucket, DeploymentBadgeVariant> = {
  active: 'success',
  attention: 'warning',
  pending: 'secondary',
  removing: 'secondary',
  removed: 'secondary',
};
