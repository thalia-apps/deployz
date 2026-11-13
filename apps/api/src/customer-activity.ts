/**
 * Customer-facing live-provisioning projection — turns raw CloudFormation
 * stack events, and the other real timestamped facts the API already
 * derives elsewhere, into the jargon-free copy the public install page shows
 * while a deployment provisions. Pure and synchronous: no DB, no clock (the
 * caller passes real timestamps in; nothing here reads the current time).
 *
 * Stack events stay strictly progress/diagnostics (see packages/db/src/
 * schema/stack-events.ts) — this module never derives stage/step/failure
 * from them, it only describes, in customer words, what the derivation
 * elsewhere (apps/api/src/deployment-status.ts) already decided is
 * happening.
 */

import type {
  CustomerActivityItem,
  CustomerTechnicalDetails,
  DeploymentStage,
  DeploymentStep,
  RuntimeHealthLayers,
} from '@deployz/contracts';

import { CANCELLED_REASONS, INSTALL_FAILURE_STACK_STATUSES, isDeletePhase } from './stack-event-progress.js';

export interface StackEventLike {
  readonly eventAt: Date;
  readonly logicalResourceId: string;
  readonly resourceType: string;
  readonly resourceStatus: string;
  readonly resourceStatusReason: string | null;
}

// ---------------------------------------------------------------------------
// Noun allowlist. Every other CloudFormation resource type is noise and is
// dropped: IAM roles/policies, Lambda permissions, log groups, routes, route
// table/subnet associations, security-group (ingress) rules, task
// definitions, DB subnet groups, cache subnet groups, listener rules, custom
// resources, wait conditions, and the target group (folded into the load
// balancer's own noun below — it never earns a separate customer-facing
// line).
//
// Checked against the real per-customer template (packages/cdk/src/
// application/application-stack.ts, verified against packages/cdk/test/
// application-stack.test.ts's resource assertions): the application stack
// never creates an AWS::CertificateManager::Certificate (HTTPS is issued by
// the relay calling ACM directly by ARN — see apps/api/src/default-https.ts)
// and never creates an AWS::ECR::Repository (that is Deployz's own pipeline
// stack, not a per-customer resource) or an RDS/ElastiCache cluster variant
// (only DBInstance / ReplicationGroup). Those types are deliberately left
// out of this allowlist rather than carried in "just in case" — an allowlist
// entry for a type that can never appear is dead weight.
// ---------------------------------------------------------------------------

type Noun =
  | 'infrastructure'
  | 'network'
  | 'network-zones'
  | 'outbound-internet'
  | 'database'
  | 'file-storage'
  | 'cache'
  | 'secure-credentials'
  | 'application-environment'
  | 'load-balancer'
  | 'application-service';

const NOUN_LABEL: Record<Noun, string> = {
  infrastructure: 'infrastructure',
  network: 'private network',
  'network-zones': 'network zones',
  'outbound-internet': 'outbound internet access',
  database: 'database',
  'file-storage': 'file storage',
  cache: 'cache',
  'secure-credentials': 'secure credentials',
  'application-environment': 'application environment',
  'load-balancer': 'load balancer',
  'application-service': 'application service',
};

// Exact resource-type match — not a prefix table like stack-event-progress.ts's
// categorizeResourceType — because a customer noun is specific enough that
// folding, say, an ElastiCache subnet group into "cache" would misreport a
// subnet-group problem as a cache failure.
const NOUN_BY_RESOURCE_TYPE: Readonly<Record<string, Noun>> = {
  'AWS::EC2::VPC': 'network',
  'AWS::EC2::Subnet': 'network-zones',
  'AWS::EC2::NatGateway': 'outbound-internet',
  'AWS::RDS::DBInstance': 'database',
  'AWS::S3::Bucket': 'file-storage',
  'AWS::ElastiCache::ReplicationGroup': 'cache',
  'AWS::SecretsManager::Secret': 'secure-credentials',
  'AWS::ECS::Cluster': 'application-environment',
  'AWS::ElasticLoadBalancingV2::LoadBalancer': 'load-balancer',
  'AWS::ECS::Service': 'application-service',
};

// The CDK application stack is a single flat stack (no nested stacks), so
// every event of this type is the root stack's own event — no stack-name
// parameter is needed to tell them apart.
const ROOT_STACK_TYPE = 'AWS::CloudFormation::Stack';

function nounFor(resourceType: string): Noun | null {
  if (resourceType === ROOT_STACK_TYPE) return 'infrastructure';
  return NOUN_BY_RESOURCE_TYPE[resourceType] ?? null;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * The spec-component fallback map (apps/api/src/spec-components.ts) extends
 * the noun allowlist: an event whose logical id maps to a frozen spec
 * component is translated as "{Component label}: {friendly verb}" instead of
 * being dropped. With a spec, a logical id the map does not know lands in one
 * generic line so it never silently disappears; without a spec, allowlist
 * noise is dropped exactly as before.
 */

/** A FAILED event whose reason is boilerplate rollback cancellation — never
 *  the genuine cause of anything. Same test stack-event-progress.ts applies. */
function isCancelledDebris(event: StackEventLike): boolean {
  return (
    event.resourceStatus.endsWith('_FAILED') &&
    event.resourceStatusReason !== null &&
    CANCELLED_REASONS.has(event.resourceStatusReason.trim())
  );
}

// ---------------------------------------------------------------------------
// translateStackEvents — dedupe-by-noun, newest first, max 5.
// ---------------------------------------------------------------------------

type ActivityState = CustomerActivityItem['state'];

interface NounAggregate {
  state: ActivityState;
  at: Date;
  /** The newest contributing per-resource event — drives the exact wording
   *  (create vs. update vs. delete-phase, the ECS "Initiated" sub-message). */
  latestEvent: StackEventLike;
}

/** A resource's latest non-debris event, or null when every event for it was
 *  cancellation debris. */
function latestMeaningfulEvent(events: readonly StackEventLike[]): StackEventLike | null {
  let latest: StackEventLike | null = null;
  for (const event of events) {
    if (isCancelledDebris(event)) continue;
    if (!latest || event.eventAt > latest.eventAt) latest = event;
  }
  return latest;
}

interface EventGroup {
  noun: Noun | null;
  componentLabel: string | null;
  byResource: Map<string, StackEventLike[]>;
}

function groupEvents(
  events: readonly StackEventLike[],
  labelByLogicalId?: ReadonlyMap<string, string> | null,
): Map<string, EventGroup> {
  const groups = new Map<string, EventGroup>();
  const add = (key: string, noun: Noun | null, componentLabel: string | null, event: StackEventLike): void => {
    let group = groups.get(key);
    if (!group) {
      group = { noun, componentLabel, byResource: new Map() };
      groups.set(key, group);
    }
    let resourceEvents = group.byResource.get(event.logicalResourceId);
    if (!resourceEvents) {
      resourceEvents = [];
      group.byResource.set(event.logicalResourceId, resourceEvents);
    }
    resourceEvents.push(event);
  };
  for (const event of events) {
    const noun = nounFor(event.resourceType);
    if (noun) {
      add(noun, noun, null, event); // the allowlist wins; spec fallbacks only see non-allowlist types
      continue;
    }
    const componentLabel = labelByLogicalId?.get(event.logicalResourceId);
    if (componentLabel) {
      add(`component:${componentLabel}`, null, componentLabel, event);
      continue;
    }
    if (labelByLogicalId) add('deployment-resources', null, null, event);
    // else: no spec — allowlist noise, dropped
  }
  return groups;
}

/** Per group: each resource's latest non-debris event, aggregated — any
 *  genuine failure wins FAILED, else any in-progress wins IN_PROGRESS, else
 *  COMPLETE. `at` is the newest contributing event's time. */
function aggregateGroup(byResource: ReadonlyMap<string, StackEventLike[]>): NounAggregate | null {
  let anyFailed = false;
  let anyInProgress = false;
  let allComplete = true;
  let newest: StackEventLike | null = null;

  for (const resourceEvents of byResource.values()) {
    const latest = latestMeaningfulEvent(resourceEvents);
    if (!latest) continue;
    if (!newest || latest.eventAt > newest.eventAt) newest = latest;
    const status = latest.resourceStatus;
    if (status.endsWith('_FAILED')) anyFailed = true;
    else if (status.endsWith('_IN_PROGRESS')) anyInProgress = true;
    if (!status.endsWith('_COMPLETE')) allComplete = false;
  }

  if (!newest) return null;
  const state: ActivityState = anyFailed ? 'FAILED' : anyInProgress ? 'IN_PROGRESS' : allComplete ? 'COMPLETE' : 'IN_PROGRESS';
  return { state, at: newest.eventAt, latestEvent: newest };
}

function messageFor(noun: Noun, aggregate: NounAggregate): string {
  const { state, latestEvent } = aggregate;
  const label = NOUN_LABEL[noun];
  const status = latestEvent.resourceStatus;
  const deletePhase = isDeletePhase(status);

  if (noun === 'infrastructure') {
    if (state === 'FAILED') return 'Could not set up your infrastructure.';
    if (deletePhase) {
      return state === 'COMPLETE' ? 'Infrastructure was removed.' : 'Undoing the changes after a problem.';
    }
    return state === 'COMPLETE' ? 'Infrastructure is ready.' : 'Started setting up your infrastructure.';
  }

  if (noun === 'application-service') {
    if (state === 'FAILED') return `Could not ${deletePhase ? 'remove' : 'create'} the application service.`;
    if (state === 'COMPLETE') return deletePhase ? 'Application service was removed.' : 'Application is running.';
    if (!deletePhase && latestEvent.resourceStatusReason?.trim() === 'Resource creation Initiated') {
      return 'Starting the application. Waiting for it to become healthy.';
    }
    return deletePhase ? 'Removing the application service.' : 'Creating the application service.';
  }

  if (state === 'FAILED') {
    const verb = deletePhase ? 'remove' : status.startsWith('UPDATE_') ? 'update' : 'create';
    return `Could not ${verb} the ${label}.`;
  }
  if (state === 'COMPLETE') {
    return deletePhase ? `${capitalize(label)} was removed.` : `${capitalize(label)} is ready.`;
  }
  if (deletePhase) return `Removing the ${label}.`;
  const verb = status.startsWith('UPDATE_') ? 'Updating' : 'Creating';
  return `${verb} the ${label}.`;
}

/** Spec-component wording — "{Component label}: {friendly verb}". */
function componentMessage(componentLabel: string, aggregate: NounAggregate): string {
  const { state, latestEvent } = aggregate;
  const status = latestEvent.resourceStatus;
  const deletePhase = isDeletePhase(status);
  if (state === 'FAILED') {
    const verb = deletePhase ? 'remove' : status.startsWith('UPDATE_') ? 'update' : 'create';
    return `${componentLabel}: could not ${verb}`;
  }
  if (state === 'COMPLETE') return deletePhase ? `${componentLabel}: removed` : `${componentLabel}: resources created`;
  if (deletePhase) return `${componentLabel}: removing`;
  return `${componentLabel}: ${status.startsWith('UPDATE_') ? 'updating' : 'creating'}`;
}

const GENERIC_ACTIVITY_MESSAGE = 'Working on deployment resources.';

/** Real, meaningful AWS provisioning events translated into customer copy —
 *  newest first, deduplicated, max 5. Never invents progress: a group with no
 *  non-debris event contributes nothing. The noun allowlist is consulted
 *  first; a frozen spec's component labels (labelByLogicalId) extend it. */
export function translateStackEvents(
  events: readonly StackEventLike[],
  labelByLogicalId?: ReadonlyMap<string, string> | null,
): CustomerActivityItem[] {
  const items: CustomerActivityItem[] = [];
  for (const [key, group] of groupEvents(events, labelByLogicalId)) {
    const aggregate = aggregateGroup(group.byResource);
    if (!aggregate) continue;
    items.push({
      key,
      at: aggregate.at.toISOString(),
      message:
        group.noun !== null
          ? messageFor(group.noun, aggregate)
          : group.componentLabel !== null
            ? componentMessage(group.componentLabel, aggregate)
            : GENERIC_ACTIVITY_MESSAGE,
      state: aggregate.state,
    });
  }
  items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return items.slice(0, 5);
}

// ---------------------------------------------------------------------------
// findProvisioningIssue — the earliest genuine resource failure.
// ---------------------------------------------------------------------------

/** The earliest genuine (non-debris) `*_FAILED` event — the root stack's own
 *  summary event is used only when no resource-level cause exists, since the
 *  stack's own failure event is usually just "the following resource(s)
 *  failed", redundant with (and less specific than) the resource's own. */
function earliestGenuineFailure(events: readonly StackEventLike[]): StackEventLike | null {
  const genuine = events.filter((event) => event.resourceStatus.endsWith('_FAILED') && !isCancelledDebris(event));
  if (genuine.length === 0) return null;
  const resourceLevel = genuine.filter((event) => event.resourceType !== ROOT_STACK_TYPE);
  const candidates = resourceLevel.length > 0 ? resourceLevel : genuine;
  return candidates.reduce((earliest, event) => (event.eventAt < earliest.eventAt ? event : earliest));
}

function issueMessage(failure: StackEventLike): string {
  if (failure.resourceType === ROOT_STACK_TYPE) {
    return 'AWS could not set up your infrastructure. Deployz is cleaning up and will show the result here shortly.';
  }
  const noun = nounFor(failure.resourceType);
  const label = noun ? NOUN_LABEL[noun] : 'a required resource';
  const verb = failure.resourceStatus.startsWith('UPDATE_')
    ? 'update'
    : failure.resourceStatus.startsWith('DELETE_')
      ? 'remove'
      : 'create';
  return `AWS could not ${verb} the ${label}. Deployz is cleaning up and will show the result here shortly.`;
}

/** The friendly, accurate provisioning-issue message, set as soon as AWS
 *  reports a genuine resource failure — well before the job itself settles
 *  to FAILED (a rollback can take many minutes). Never a raw AWS reason. */
export function findProvisioningIssue(events: readonly StackEventLike[]): { message: string } | null {
  const failure = earliestGenuineFailure(events);
  return failure ? { message: issueMessage(failure) } : null;
}

// ---------------------------------------------------------------------------
// buildCustomerLiveProgress — the active-step live view, from real state only.
// ---------------------------------------------------------------------------

export interface CustomerLiveProgress {
  currentActivity?: string;
  recentActivity: CustomerActivityItem[];
  provisioningIssue: { message: string } | null;
  technicalDetails: CustomerTechnicalDetails | null;
  /** Cleanup of a failed install — null unless the stage is FAILED. */
  cleanup: 'IN_PROGRESS' | 'COMPLETE' | 'RETAINED' | null;
}

/** The HTTPS state machine driving TLS — a custom domain (apps/api/src/
 *  domains.ts) or, when there is none, the Deployz-owned default endpoint
 *  (apps/api/src/default-https.ts). Both use the same status vocabulary. */
export interface LiveHttpsState {
  hostname: string;
  status: string;
  lastError: string | null;
  /** custom_domains.last_checked_at / deployments.default_https.lastDnsCheckAt. */
  lastCheckedAt: string | null;
  /** True for the Deployz-owned default address: the customer owns no domain, so its copy never mentions one. */
  deployzOwned?: boolean;
}

export interface BuildCustomerLiveProgressInput {
  stage: DeploymentStage;
  step: DeploymentStep;
  /** Raw stack events of the latest INSTALL job, any order — only read for
   *  PROVISIONING/FAILED. */
  events: readonly StackEventLike[];
  /** logicalResourceId → spec component label, from the deployment's frozen
   *  spec (apps/api/src/spec-components.ts). Null when there is no spec —
   *  allowlist noise is then dropped exactly as before. */
  componentLabelByLogicalId?: ReadonlyMap<string, string> | null;
  /** The latest INSTALL job's id, for the DEP-<id> technical reference. Null
   *  when no INSTALL job exists yet. */
  installJobId: string | null;
  /** deployments.step_timings, as deployment-status.ts reads it. */
  stepTimings: Record<string, { startedAt: string; completedAt?: string }> | null;
  /** derived.health.layers — HEALTH_CHECK's real runtime signal. */
  health: RuntimeHealthLayers;
  /** Whichever HTTPS state machine is currently serving this deployment. */
  https: LiveHttpsState | null;
  /** derived.needsDomainSetup — TLS's "customer must act" gate. */
  needsDomainSetup: boolean;
  /** True when the customer has pressed Deploy to AWS (installStartedAt is
   *  set). Before that, nothing in AWS is being created. */
  launched: boolean;
  /** deployments.cleanup_state — COMPLETE means a later verified purge
   *  removed every retained resource, which outranks anything the stack
   *  status implies. Null on an ordinary failed install (no purge ran). */
  cleanupState?: 'SKIPPED_RELAY_OFFLINE' | 'PURGE_FAILED' | 'COMPLETE' | 'CONFIRMED_BY_OWNER' | null;
}

function jobReference(jobId: string | null): string {
  // Same first-8-hex-chars convention as deployment-status.ts's buildFailure.
  return jobId ? `DEP-${jobId.slice(0, 8).toUpperCase()}` : 'DEP-UNKNOWN';
}

function rootStackEvent(events: readonly StackEventLike[]): StackEventLike | null {
  let latest: StackEventLike | null = null;
  for (const event of events) {
    if (event.resourceType !== ROOT_STACK_TYPE) continue;
    if (!latest || event.eventAt > latest.eventAt) latest = event;
  }
  return latest;
}

function newestEvent(events: readonly StackEventLike[]): StackEventLike | null {
  let latest: StackEventLike | null = null;
  for (const event of events) {
    if (!latest || event.eventAt > latest.eventAt) latest = event;
  }
  return latest;
}

function rawEventsForTechnicalDetails(events: readonly StackEventLike[]): CustomerTechnicalDetails['events'] {
  return [...events]
    .sort((a, b) => b.eventAt.getTime() - a.eventAt.getTime())
    .slice(0, 8)
    .map((event) => ({
      at: event.eventAt.toISOString(),
      logicalResourceId: event.logicalResourceId,
      resourceType: event.resourceType,
      resourceStatus: event.resourceStatus,
      resourceStatusReason: event.resourceStatusReason,
    }));
}

function buildProvisioningProgress(input: BuildCustomerLiveProgressInput): CustomerLiveProgress {
  const recentActivity = translateStackEvents(input.events, input.componentLabelByLogicalId);
  const newestInProgress = recentActivity.find((item) => item.state === 'IN_PROGRESS');
  const provisioningIssue = findProvisioningIssue(input.events);
  const stack = rootStackEvent(input.events);
  const newest = newestEvent(input.events);

  const facts: CustomerTechnicalDetails['facts'] = [];
  if (stack) {
    facts.push({ label: 'Stack name', value: stack.logicalResourceId });
    facts.push({ label: 'Stack status', value: stack.resourceStatus });
    if (stack.resourceStatusReason) facts.push({ label: 'Status reason', value: stack.resourceStatusReason });
  }
  if (newest) facts.push({ label: 'Last AWS event', value: newest.eventAt.toISOString() });

  return {
    ...(newestInProgress ? { currentActivity: newestInProgress.message } : {}),
    recentActivity,
    provisioningIssue,
    cleanup: null,
    technicalDetails:
      input.events.length > 0
        ? { reference: jobReference(input.installJobId), facts: facts.slice(0, 12), events: rawEventsForTechnicalDetails(input.events) }
        : null,
  };
}

function buildFailedProgress(input: BuildCustomerLiveProgressInput): CustomerLiveProgress {
  const failure = earliestGenuineFailure(input.events);
  const stack = rootStackEvent(input.events);
  const newest = newestEvent(input.events);

  // Cleanup is deliberately separate from the failed lifecycle: a
  // rolling-back stack is still removing the failed attempt's resources
  // (IN_PROGRESS), a terminal failed status means some resources may
  // intentionally remain (RETAINED), and only a later verified purge
  // (cleanupState COMPLETE) proves everything was removed.
  let cleanup: CustomerLiveProgress['cleanup'] = null;
  if (stack && (stack.resourceStatus === 'ROLLBACK_IN_PROGRESS' || stack.resourceStatus === 'DELETE_IN_PROGRESS')) {
    cleanup = 'IN_PROGRESS';
  } else if (stack && INSTALL_FAILURE_STACK_STATUSES.has(stack.resourceStatus)) {
    cleanup = 'RETAINED';
  }
  if (input.cleanupState === 'COMPLETE') {
    cleanup = 'COMPLETE';
  }

  const facts: CustomerTechnicalDetails['facts'] = [];
  if (stack) {
    facts.push({ label: 'Stack name', value: stack.logicalResourceId });
    facts.push({ label: 'Stack status', value: stack.resourceStatus });
  }
  if (failure) {
    facts.push({ label: 'Failed resource', value: failure.logicalResourceId });
    facts.push({ label: 'Failed status', value: failure.resourceStatus });
    if (failure.resourceStatusReason) facts.push({ label: 'Status reason', value: failure.resourceStatusReason });
  }
  if (newest) facts.push({ label: 'Last AWS event', value: newest.eventAt.toISOString() });

  return {
    recentActivity: [],
    provisioningIssue: null,
    cleanup,
    technicalDetails:
      input.events.length > 0
        ? { reference: jobReference(input.installJobId), facts: facts.slice(0, 12), events: rawEventsForTechnicalDetails(input.events) }
        : null,
  };
}

const STEP_COMPLETE_MESSAGE: Partial<Record<DeploymentStep, string>> = {
  NETWORK: 'Network is ready.',
  DATABASE_STORAGE: 'Database and storage are ready.',
  REDIS: 'Cache is ready.',
  APPLICATION: 'Application started.',
  HEALTH_CHECK: 'Application passed health checks.',
};

function stepCompletionActivity(
  stepTimings: BuildCustomerLiveProgressInput['stepTimings'],
  steps: readonly DeploymentStep[],
): CustomerActivityItem[] {
  if (!stepTimings) return [];
  const items: CustomerActivityItem[] = [];
  for (const step of steps) {
    const completedAt = stepTimings[step]?.completedAt;
    const message = STEP_COMPLETE_MESSAGE[step];
    if (completedAt && message) {
      items.push({ key: `step-${step.toLowerCase()}`, at: completedAt, message, state: 'COMPLETE' });
    }
  }
  return items;
}

/** The ALB/ECS healthy-target count the layers imply, or null when the
 *  layers said nothing usable — runningCount minus every non-healthy bucket
 *  the heartbeat reported. */
function healthyTargetCount(targets: RuntimeHealthLayers['targets']): number | null {
  if (!targets || targets.runningCount === null) return null;
  const unhealthy = targets.unhealthyTargetCount ?? 0;
  const pending = targets.pendingTargetCount ?? 0;
  const unknown = targets.unknownTargetCount ?? 0;
  return Math.max(targets.runningCount - unhealthy - pending - unknown, 0);
}

function buildHealthCheckProgress(input: BuildCustomerLiveProgressInput): CustomerLiveProgress {
  const { health } = input;
  let currentActivity: string | undefined;
  if (health.rollout === 'IN_PROGRESS') {
    currentActivity = 'Starting the application.';
  } else if (health.targets && (health.targets.runningCount ?? 0) > 0 && (healthyTargetCount(health.targets) ?? 0) <= 0) {
    currentActivity = 'Waiting for the application to become healthy.';
  }

  const recentActivity = stepCompletionActivity(input.stepTimings, ['APPLICATION', 'REDIS', 'DATABASE_STORAGE', 'NETWORK'])
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, 5);

  const facts: CustomerTechnicalDetails['facts'] = [
    { label: 'Rollout state', value: health.rollout ?? 'UNKNOWN' },
    { label: 'Running tasks', value: health.targets?.runningCount != null ? String(health.targets.runningCount) : 'unknown' },
    { label: 'Desired tasks', value: health.targets?.desiredCount != null ? String(health.targets.desiredCount) : 'unknown' },
  ];
  if (health.targets) {
    const healthy = healthyTargetCount(health.targets);
    facts.push({
      label: 'Healthy targets',
      value: `${healthy ?? 'unknown'} / ${health.targets.runningCount ?? 'unknown'}`,
    });
  }
  if (health.http) {
    facts.push({ label: 'Probe status', value: health.http.ok ? 'OK' : (health.http.error ?? 'failed') });
  }

  return {
    ...(currentActivity ? { currentActivity } : {}),
    recentActivity,
    provisioningIssue: null,
    cleanup: null,
    technicalDetails: { reference: jobReference(input.installJobId), facts: facts.slice(0, 12), events: [] },
  };
}

// PENDING → cert requested; WAITING_FOR_DNS → validation + routing records
// being written, waiting on ACM; CONFIGURING → cert issued, 443 listener
// wired, HTTPS being probed (see apps/api/src/default-https.ts's state-
// machine header and apps/api/src/domains.ts's mirrored custom-domain one).
const TLS_STATUS_MESSAGE: Readonly<Record<string, string>> = {
  PENDING: 'Requesting the HTTPS certificate.',
  WAITING_FOR_DNS: 'Validating the domain. Waiting for AWS certificate validation.',
  CONFIGURING: 'Attaching the certificate. Waiting for the HTTPS endpoint.',
};

// The Deployz-owned default address has no customer domain to validate; the
// same machine states read as certificate issuance.
const DEFAULT_ADDRESS_TLS_STATUS_MESSAGE: Readonly<Record<string, string>> = {
  ...TLS_STATUS_MESSAGE,
  WAITING_FOR_DNS: 'Waiting for AWS to issue the HTTPS certificate.',
};

function buildTlsProgress(input: BuildCustomerLiveProgressInput): CustomerLiveProgress {
  const { https, needsDomainSetup } = input;
  // needsDomainSetup means the CUSTOMER must act next (their own domain
  // awaiting DNS, or nothing automatic will produce a secure address) — the
  // existing "Waiting for secure domain setup." text already says that.
  const statusMessages = https?.deployzOwned ? DEFAULT_ADDRESS_TLS_STATUS_MESSAGE : TLS_STATUS_MESSAGE;
  const currentActivity = !needsDomainSetup && https ? statusMessages[https.status] : undefined;

  const items = stepCompletionActivity(input.stepTimings, ['HEALTH_CHECK']);
  if (https?.lastCheckedAt) {
    items.push({ key: 'domain-check', at: https.lastCheckedAt, message: https.deployzOwned ? 'Checked the HTTPS certificate status.' : 'Checked the domain records.', state: 'COMPLETE' });
  }
  const recentActivity = items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, 5);

  const facts: CustomerTechnicalDetails['facts'] = [];
  if (https) {
    facts.push({ label: 'Hostname', value: https.hostname });
    facts.push({ label: 'HTTPS status', value: https.status });
    if (https.lastError) facts.push({ label: 'Last error', value: https.lastError });
    if (https.lastCheckedAt) facts.push({ label: 'Last DNS check', value: https.lastCheckedAt });
  }

  return {
    ...(currentActivity ? { currentActivity } : {}),
    recentActivity,
    provisioningIssue: null,
    cleanup: null,
    technicalDetails: facts.length > 0 ? { reference: jobReference(input.installJobId), facts: facts.slice(0, 12), events: [] } : null,
  };
}

/**
 * The active-step live view, built from real state only — never invented
 * progress. WAITING_FOR_AWS / CONNECTING / READY (and any VERIFYING step
 * other than HEALTH_CHECK/TLS) report nothing: empty recentActivity, no
 * issue, no technical detail, and no currentActivity override, so the
 * existing stage copy stands unchanged.
 */
export function buildCustomerLiveProgress(input: BuildCustomerLiveProgressInput): CustomerLiveProgress {
  const empty: CustomerLiveProgress = { recentActivity: [], provisioningIssue: null, cleanup: null, technicalDetails: null };
  if (input.stage === 'PROVISIONING') return buildProvisioningProgress(input);
  if (input.stage === 'FAILED') return buildFailedProgress(input);
  if (input.stage === 'VERIFYING' && input.step === 'HEALTH_CHECK') return buildHealthCheckProgress(input);
  if (input.stage === 'VERIFYING' && input.step === 'TLS') return buildTlsProgress(input);
  // No relay is connected in these two stages, so AWS reports no events to
  // Deployz. The shared activity text is written for the vendor; this is the
  // customer's wording of the same state.
  if (input.stage === 'WAITING_FOR_AWS' && input.launched) {
    return { ...empty, currentActivity: 'AWS is creating the Deployz connector in your account.' };
  }
  if (input.stage === 'CONNECTING') {
    return { ...empty, currentActivity: 'The connector is ready. Deployz is preparing the deployment.' };
  }
  return empty;
}
