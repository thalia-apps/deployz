import {
  APP_OWNED_STARTUP_FAILURE_CODES,
  FAILURE_REMEDIATION,
  customerStackStatusLabel,
  failureCodeCopy,
  failureRecoverability,
  knownFailureCode,
  type FailureCode,
} from '@deployz/copy-map';
import {
  DEPLOYMENT_STEP_ORDER,
  INFRASTRUCTURE_COMPONENTS,
  TYPICAL_STEP_DURATION_SECONDS,
  workloadServicesFromSpec,
  type ComponentProgress,
  type ComponentProgressStatus,
  type CustomDomainStatus,
  type CustomerDeploymentStatus,
  type DeploymentStage,
  type DeploymentSpecV2,
  type DeploymentState,
  type DeploymentStep,
  type HealthStatus,
  type HealthTargets,
  type HttpProbe,
  type InfrastructureComponentStatus,
  type InfrastructureHttpsState,
  type JobState,
  type JobType,
  type RelayStatus,
  type RuntimeHealthLayers,
  type VendorDeploymentStatus,
  type FailureCode as StoredFailureCode,
} from '@deployz/contracts';

import type { ConnectorUpdateOffer } from './connector-update.js';
import { readInstallVerification } from './install-verification.js';

// Unified deployment status — the read-time derivation described in
// packages/contracts/src/index.ts above customerDeploymentStatusSchema.
// Everything below is pure: given the same inputs it always returns the
// same DerivedDeploymentStatus, and nothing here reads a clock except the
// documented now() fallback for `updatedAt`. That purity is what makes the
// six-stage model unit-testable without a database and safe to call once
// per row in a list endpoint.

// ---------------------------------------------------------------------------
// §24 per-component merge — extracted from toFleetRow (server.ts), which
// still calls this. The relay's verification checks say what SHOULD exist
// (observedState.infraHealth.checks); its heartbeat says what is OBSERVED
// (observedState.components). Combining the two is what lets a screen say
// "Not provisioned" (required, verification found nothing) instead of "Not
// reporting" (no observation at all). Kept as ONE implementation so the
// fleet dashboard and the new stage derivation can never disagree about a
// component's merged state.
// ---------------------------------------------------------------------------

/** Whether each optional component is required, per the owning application. */
export interface ComponentRequirements {
  databaseRequired?: boolean | null;
  storageRequired?: boolean | null;
  redisRequired?: boolean | null;
  /**
   * Phase 4A: the persistent workload ids the deployment's frozen spec
   * proves (one `compute` check each — `web`, `email-worker`, …). Null/absent
   * keeps the legacy single-application seat.
   */
  workloads?: readonly string[] | null;
}

/** Merged per-component state: HEALTHY/DEGRADED/UNHEALTHY/UNKNOWN/NOT_PROVISIONED. */
export type MergedComponentState = Record<string, string>;

const COMPONENT_REQUIREMENT_KEYS = ['loadBalancer', 'database', 'storage', 'redis'] as const;

// The verification check name each merged infra component key corresponds to
// — used to fall back to NOT_PROVISIONED/UNKNOWN when the heartbeat never
// reported the component at all. Sourced from the shared component catalog
// (checkName) rather than a second literal table; the application kind has no
// entry here because its seats are per-workload (Phase 4A), each verifying
// through its own `compute` check.
const COMPONENT_KEY_BY_KIND: Record<
  Exclude<(typeof INFRASTRUCTURE_COMPONENTS)[number]['kind'], 'application'>,
  (typeof COMPONENT_REQUIREMENT_KEYS)[number]
> = {
  endpoint: 'loadBalancer',
  database: 'database',
  cache: 'redis',
  storage: 'storage',
};

const VERIFY_CHECK_BY_COMPONENT: Record<(typeof COMPONENT_REQUIREMENT_KEYS)[number], string> =
  Object.fromEntries(
    INFRASTRUCTURE_COMPONENTS.filter((c) => c.kind !== 'application').map(
      (c) => [COMPONENT_KEY_BY_KIND[c.kind as Exclude<(typeof INFRASTRUCTURE_COMPONENTS)[number]['kind'], 'application'>], c.checkName],
    ),
  ) as Record<(typeof COMPONENT_REQUIREMENT_KEYS)[number], string>;

/**
 * Seat-key mappings for a workload id. The web workload keeps BOTH historical
 * keys — `application` in the merged-state map (toFleetRow consumers) and
 * `runtime` in the progress list (existing consumers + failure mapping) — so
 * single-workload deployments render exactly as they always did; every
 * additional workload sits under its own id in both spaces.
 */
function workloadMergedKey(workloadId: string): string {
  return workloadId === 'web' ? 'application' : workloadId;
}

function workloadProgressKey(workloadId: string): string {
  return workloadId === 'web' ? 'runtime' : workloadId;
}

/** Display name for a workload's component seat. */
export function workloadComponentLabel(workloadId: string): string {
  return workloadId === 'web' ? COMPONENT_LABELS['runtime']! : `Worker ${workloadId}`;
}

/** The workload seats to derive: the spec's list, else the legacy single web seat. */
function workloadSeats(workloads: readonly string[] | null | undefined): readonly string[] {
  return workloads === null || workloads === undefined || workloads.length === 0 ? ['web'] : workloads;
}

/**
 * Merge a deployment's observed heartbeat components with its verification
 * checks into one per-key state map, or null when nothing is known yet.
 *   reported          → that state (HEALTHY/DEGRADED/UNHEALTHY/UNKNOWN)
 *   check says absent → NOT_PROVISIONED
 *   otherwise         → UNKNOWN when required, omitted when not
 * Each workload gets its own seat (Phase 4A), read from the heartbeat's
 * per-workload entry (or, for the web workload, the legacy `application`
 * entry an older relay reported) and verified through its own `compute` check.
 */
export function mergeComponentState(
  observedState: Record<string, unknown> | null | undefined,
  requirements: ComponentRequirements,
): MergedComponentState | null {
  const observed = observedState as
    | {
        components?: Record<string, unknown>;
        infraHealth?: { checks?: { name?: string; passed?: boolean; component?: string }[] };
      }
    | null
    | undefined;
  const components: Record<string, string> = {};
  for (const [key, value] of Object.entries(observed?.components ?? {})) {
    if (typeof value === 'string') components[key] = value;
  }
  const infraChecks = observed?.infraHealth?.checks ?? [];
  const componentRequirements: Record<(typeof COMPONENT_REQUIREMENT_KEYS)[number], boolean> = {
    loadBalancer: true,
    database: requirements.databaseRequired ?? false,
    storage: requirements.storageRequired ?? false,
    redis: requirements.redisRequired ?? false,
  };

  // Per-workload seats: observed heartbeat value first, then the workload's
  // own compute check, then UNKNOWN (a workload is always required).
  for (const workloadId of workloadSeats(requirements.workloads)) {
    const seat = workloadMergedKey(workloadId);
    if (components[seat] !== undefined) continue;
    const observedValue = components[workloadId] ?? (workloadId === 'web' ? components['application'] : undefined);
    if (observedValue !== undefined) {
      components[seat] = observedValue;
      continue;
    }
    const check = infraChecks.find(
      (candidate) =>
        candidate.name === 'compute' &&
        // A compute check with no workload component is the legacy single
        // application check — it can only ever speak for the web workload.
        (candidate.component === workloadId || (workloadId === 'web' && candidate.component === undefined)),
    );
    components[seat] = check?.passed === false ? 'NOT_PROVISIONED' : 'UNKNOWN';
  }

  for (const key of COMPONENT_REQUIREMENT_KEYS) {
    if (components[key] !== undefined) continue;
    if (!componentRequirements[key]) continue;
    const check = infraChecks.find((candidate) => candidate.name === VERIFY_CHECK_BY_COMPONENT[key]);
    components[key] = check?.passed === false ? 'NOT_PROVISIONED' : 'UNKNOWN';
  }
  return Object.keys(components).length > 0 ? components : null;
}

// ---------------------------------------------------------------------------
// Derivation input — deliberately its own plain-object shape rather than the
// Drizzle row types server.ts uses. A db row satisfies this structurally (so
// server.ts can pass its query results straight through), but this module
// never imports @deployz/db: that is what keeps deriveDeploymentStatus
// callable from a unit test with a handful of object literals and no
// database.
// ---------------------------------------------------------------------------

export interface DerivationDeployment {
  state: DeploymentState;
  relayStatus: RelayStatus;
  /** STORED health, never the relay-disconnect-masked display value — see deriveDeploymentStatus. */
  healthStatus: HealthStatus;
  enrollmentUsedAt: Date | null;
  relayBoundAt: Date | null;
  lastHealthAt: Date | null;
  currentReleaseId: string | null;
  /** When relay evidence last confirmed `currentReleaseId` is serving — see servingReleaseFor. */
  currentReleaseConfirmedAt: Date | null;
  /** Build id the connector reports (deployments.bootstrap_version); null for a connector that never reported one. */
  bootstrapVersion?: string | null;
  observedState: Record<string, unknown> | null;
  updatedAt: Date;
  /** When the customer launched the CloudFormation Quick Create — the AWS_SETUP step's authoritative start. */
  installStartedAt: Date | null;
  /** Persisted write-once step timestamps (deployments.step_timings) — see apps/api/src/step-timings.ts. */
  stepTimings: Record<string, { startedAt: string; completedAt?: string }> | null;
}

export interface DerivationApplication {
  databaseRequired?: boolean | null;
  storageRequired?: boolean | null;
  redisRequired?: boolean | null;
  /** When set, the deploy ladder carries the MIGRATION step (before the application). */
  migrationCommand?: string | null;
  /**
   * Phase 4A: the persistent workload ids this deployment's frozen spec
   * proves — one component seat each. Null (an uncompiled spec, or an
   * unprojected row) falls back to the single legacy web seat.
   */
  workloads?: readonly string[] | null;
}

export interface DerivationJob {
  id: string;
  type: JobType;
  state: JobState;
  failureCode: StoredFailureCode | null;
  result: Record<string, unknown> | null;
  payload?: unknown;
  lastProgressAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
}

export interface DerivationDomain {
  hostname: string;
  status: CustomDomainStatus;
}

/** Phase 11 — the deployment's Deployz-owned HTTPS endpoint (parsed from
 *  `deployments.default_https` by the caller). Status mirrors the custom-
 *  domain vocabulary. */
export interface DerivationDefaultHttps {
  hostname: string;
  status: string;
}

export interface DeriveDeploymentStatusInput {
  deployment: DerivationDeployment;
  application: DerivationApplication;
  /** This deployment's jobs — at minimum every INSTALL job, the latest job overall, and the latest FAILED job. */
  jobs: DerivationJob[];
  domain: DerivationDomain | null;
  /** Phase 11 Deployz-owned HTTPS endpoint, or null when not configured. */
  defaultHttps?: DerivationDefaultHttps | null;
  /** The connector update the customer may approve, or null when none can be offered (see connector-update.ts). */
  connectorUpdate?: ConnectorUpdateOffer | null;
  /**
   * resolveAppUrl(jobs, domain) — https when a custom domain is ACTIVE (its
   * only preferred state), else the default-HTTPS URL once ACTIVE/CONFIGURING,
   * else http for a bare ALB, else null. Exposed to the customer only once
   * runtime health confirms the app is reachable (READY, or VERIFYING with
   * healthStatus HEALTHY) — never from a stack that merely finished creating.
   */
  appUrl: string | null;
  /**
   * The second (and only other) documented clock exception, alongside the
   * existing `updatedAt` fallback below — used SOLELY to compare against a
   * step's `stepStartedAt` for `takingLongerThanUsual`. Defaults to
   * `new Date()`; tests inject a fixed value so the slow-step boundary is
   * deterministic.
   */
  now?: Date;
}

// ---------------------------------------------------------------------------
// Internal derived object — NOT exposed verbatim on any public wire. Both
// projections are pure views over this.
// ---------------------------------------------------------------------------

export interface DerivedFailure {
  code: FailureCode | null;
  component: string | null;
  reference: string;
  customerMessage: string;
  vendorMessage: string;
  awsStatus: string | null;
  /** Type of the job that failed — not necessarily the latest job, which may
   * be a later health/preflight job that has nothing to do with the failure. */
  jobType: string | null;
}

/** One entry of the vendor-only `stepTimings` list — see deploymentSchema in @deployz/contracts. */
export interface StepTimingEntry {
  step: DeploymentStep;
  startedAt: string;
  completedAt: string | null;
  durationSeconds: number | null;
}

export interface DerivedDeploymentStatus {
  stage: DeploymentStage;
  updatedAt: string;
  currentActivity: string;
  step: DeploymentStep;
  /** Applicable steps for this deployment, in canonical order (REDIS/DATABASE_STORAGE only when required). */
  steps: DeploymentStep[];
  /** When the active step started, per the resolution ladder — null when nothing authoritative is known yet. */
  stepStartedAt: string | null;
  typicalDurationSeconds: { min: number; max: number } | null;
  takingLongerThanUsual: boolean;
  /** Completed + active steps only, in canonical order — the vendor-only timing list. */
  stepTimings: StepTimingEntry[];
  /**
   * INTERNAL ONLY — never exposed on either wire projection. A per-step
   * completedAt sourced from the relay provisioning snapshot, when that
   * snapshot marks the category COMPLETE. Read by apps/api/src/
   * step-timings.ts (advanceStepTimings) to prefer a precise completion
   * time over "whenever the next step started" for the four
   * snapshot-backed steps (NETWORK/DATABASE_STORAGE/REDIS/APPLICATION).
   */
  stepSnapshotCompletedAt: Partial<Record<DeploymentStep, string>>;
  removed?: { state: 'DELETING' | 'DELETED' };
  statusUpdatesUnavailable: boolean;
  needsDomainSetup: boolean;
  components: ComponentProgress[];
  relay: { connected: boolean; lastSeenAt: string | null };
  job: { type: JobType; status: JobState } | null;
  aws: { stackStatus: string | null };
  /**
   * `notStarted`: every workload is intentionally at zero tasks (a configured
   * first start still waiting) — a runtime condition, not an outage.
   */
  health: { status: HealthStatus; layers: RuntimeHealthLayers; notStarted: boolean };
  /** Which release is serving and whether relay evidence confirms it — separate from health and from `failure`. */
  servingRelease: ServingRelease;
  /** The connector sends no release evidence, so it can neither promote a release nor verify readiness. */
  connector: {
    upgradeRequired: boolean;
    reason: 'RELEASE_EVIDENCE_MISSING' | null;
    updateAvailable: boolean;
    updateUrl: string | null;
    updateTemplateUrl: string | null;
  };
  result: { url: string } | null;
  failure: DerivedFailure | null;
}

export interface ServingRelease {
  releaseId: string | null;
  confirmedAt: string | null;
  confirmed: boolean;
}

// The verdict the heartbeat route stamps into observedState.releaseVerdict
// after evaluating THAT heartbeat's release evidence (server.ts).
interface StoredReleaseVerdict {
  pass: boolean;
  reason: string | null;
  notStarted: boolean;
}

function readReleaseVerdict(observedState: Record<string, unknown> | null | undefined): StoredReleaseVerdict | null {
  const raw = observedState?.['releaseVerdict'] as Partial<StoredReleaseVerdict> | null | undefined;
  if (raw === undefined || raw === null || typeof raw.pass !== 'boolean') return null;
  return { pass: raw.pass, reason: raw.reason ?? null, notStarted: raw.notStarted === true };
}

/**
 * The current release counts as confirmed only while no deploy, rollback or
 * restart has settled after the evidence that confirmed it: such an operation
 * may have changed what runs, so only newer evidence re-confirms.
 */
function servingReleaseFor(deployment: DerivationDeployment, jobs: readonly DerivationJob[]): ServingRelease {
  const confirmedAt = deployment.currentReleaseConfirmedAt;
  const confirmed =
    deployment.currentReleaseId !== null &&
    confirmedAt !== null &&
    !jobs.some(
      (job) =>
        (job.type === 'DEPLOY_RELEASE' || job.type === 'ROLLBACK' || job.type === 'RESTART') &&
        job.finishedAt !== null &&
        job.finishedAt > confirmedAt,
    );
  return {
    releaseId: deployment.currentReleaseId,
    confirmedAt: confirmed ? confirmedAt!.toISOString() : null,
    confirmed,
  };
}

// ---------------------------------------------------------------------------
// Failure mapping — every §61 failure code gets a (component, customer copy)
// entry. customerMessage reuses copy-map's already-vetted §65 jargon-free
// description instead of a second hand-written sentence per code, so the
// two copies can never drift; vendorMessage reuses the "what happened"
// clause of the existing §29 remediation copy for the same reason.
// ---------------------------------------------------------------------------

// component is null when no single component reliably explains the failure
// (an account-level or stack-level failure, not one piece of the app).
const FAILURE_COMPONENT: Record<FailureCode, string | null> = {
  AWS_SCP_BLOCKED: null,
  PORT_MISMATCH: 'runtime',
  REGION_NOT_SUPPORTED: null,
  QUOTA_EXCEEDED: null,
  IMAGE_HEALTH_CHECK_FAILED: 'runtime',
  MIGRATION_FAILED: 'database',
  RELAY_DISCONNECTED: null,
  ECS_DEPLOYMENT_FAILED: 'runtime',
  AWS_PERMISSION_DENIED: null,
  STACK_CREATE_FAILED: null,
  STACK_DELETE_FAILED: null,
  RDS_AZ_CAPACITY: 'database',
  DATABASE_CREATE_FAILED: 'database',
  DATABASE_CONNECTION_FAILED: 'database',
  IMAGE_PULL_FAILED: 'runtime',
  CONTAINER_START_FAILED: 'runtime',
  MISSING_SECRET: 'runtime',
  TEMPLATE_UNAVAILABLE: null,
  UNSUPPORTED_ARCHITECTURE: 'runtime',
  UNKNOWN: null,
  REDIS_PROVISIONING_FAILED: 'redis',
  REDIS_CONNECTION_FAILED: 'redis',
  DOMAIN_OPERATION_TIMEOUT: 'domain',
  RELAY_STATE_WRITE_FAILED: null,
};

interface FailureEntry {
  component: string | null;
  customerMessage: string;
  vendorMessage: string;
}

function failureEntryFor(stored: StoredFailureCode | null): FailureEntry {
  // A job can fail with no classified code at all (the relay sent something
  // failureCodeSchema does not recognise, or nothing). That is not the same
  // as the taxonomy's own UNKNOWN value, which still has real copy — this is
  // the last-resort generic message for when there is no code to look up.
  if (stored === null) {
    return {
      component: null,
      customerMessage: 'Deployment needs attention.',
      vendorMessage: 'The deployment failed without a classified cause.',
    };
  }
  const code = knownFailureCode(stored);
  return {
    component: FAILURE_COMPONENT[code],
    customerMessage: failureCodeCopy(code).description,
    vendorMessage: FAILURE_REMEDIATION[code].what,
  };
}

// ---------------------------------------------------------------------------
// Component progress list
// ---------------------------------------------------------------------------

const COMPONENT_LABELS: Record<string, string> = {
  runtime: 'Application runtime',
  database: 'PostgreSQL database',
  storage: 'Storage',
  redis: 'Redis',
  https: 'Secure access (HTTPS)',
};

// result.checks[] entries name the AWS-side check, not the product-facing
// component — this is the same key space verifyCheckByComponent above maps
// FROM, minus loadBalancer/ingress (which has no ComponentProgress entry of
// its own). A `compute` check names its own workload via `component`
// (Phase 4A); the component-less legacy compute check maps to the runtime seat.
const CHECK_NAME_TO_COMPONENT: Record<string, string> = {
  compute: 'runtime',
  database: 'database',
  storage: 'storage',
  cache: 'redis',
};

function failedCheckComponents(result: Record<string, unknown> | null | undefined): Set<string> {
  const source = unwrapJobResult(result) ?? result;
  const checks =
    (source as { checks?: { name?: string; passed?: boolean; component?: string }[] } | null | undefined)?.checks ??
    [];
  const out = new Set<string>();
  for (const check of checks) {
    if (check.passed === false && check.name) {
      if (check.name === 'compute') {
        out.add(check.component !== undefined ? workloadProgressKey(check.component) : 'runtime');
        continue;
      }
      const component = CHECK_NAME_TO_COMPONENT[check.name];
      if (component) out.add(component);
    }
  }
  return out;
}

/**
 * Maps one merged component's raw state to a ComponentProgress status, given
 * whether it is required and the overall stage. Deliberately never returns
 * READY without a positive HEALTHY signal — an UNKNOWN/absent component only
 * ever reaches PENDING, never READY, however far the deployment has otherwise
 * progressed (see the "no positive signal" branch below).
 */
function statusFromMerged(
  mergedValue: string | undefined,
  required: boolean,
  stage: DeploymentStage,
): ComponentProgressStatus {
  if (!required) return 'NOT_REQUIRED';
  if (mergedValue === 'HEALTHY') return 'READY';
  if (mergedValue === 'DEGRADED') return 'IN_PROGRESS';
  if (mergedValue === 'UNHEALTHY') return stage === 'FAILED' ? 'FAILED' : 'IN_PROGRESS';
  if (mergedValue === 'NOT_PROVISIONED') {
    if (stage === 'FAILED') return 'FAILED';
    return stage === 'PROVISIONING' ? 'IN_PROGRESS' : 'PENDING';
  }
  // mergedValue is undefined or 'UNKNOWN': no positive signal yet.
  if (stage === 'PROVISIONING') return 'IN_PROGRESS';
  if (stage === 'WAITING_FOR_AWS' || stage === 'CONNECTING') return 'PENDING';
  // VERIFYING/READY/FAILED with no signal on this specific component: the
  // vendor projection keeps PENDING (still useful operationally); the
  // customer projection drops it below — showing a "pending" step this late
  // would read as stalled progress with nothing behind it.
  return 'PENDING';
}

// ---------------------------------------------------------------------------
// Phase 5 — plan HTTPS vocabulary. The internal machines speak
// DefaultHttpsStatus/CustomDomainStatus (PENDING/WAITING_FOR_DNS/CONFIGURING/
// ACTIVE/ERROR/REMOVING); the plan (docs/networking-and-https.md)
// presents DNS_PENDING/TLS_PENDING/VERIFYING/ACTIVE/ERROR. This is the
// read-time translation a status/view payload calls before product copy —
// exported now (and unit-tested) so the Phase 9 UI-payload integration can
// reuse it without touching the internal enums.
// ---------------------------------------------------------------------------

/** The plan's HTTPS-state vocabulary for a deployment's secure address. */
export type PlanHttpsState = 'DNS_PENDING' | 'TLS_PENDING' | 'VERIFYING' | 'ACTIVE' | 'ERROR';

const PLAN_HTTPS_STATE_BY_INTERNAL: Record<string, PlanHttpsState | undefined> = {
  PENDING: 'DNS_PENDING',
  WAITING_FOR_DNS: 'DNS_PENDING',
  CONFIGURING: 'TLS_PENDING',
  VERIFYING: 'VERIFYING',
  ACTIVE: 'ACTIVE',
  ERROR: 'ERROR',
};

/** Maps one internal HTTPS status to the plan vocabulary, or null when the
 *  plan has no word for it (REMOVING teardown, unrecognised values). */
export function toPlanHttpsState(status: string): PlanHttpsState | null {
  return PLAN_HTTPS_STATE_BY_INTERNAL[status] ?? null;
}

function httpsComponentStatus(
  domain: DerivationDomain | null,
  needsDomainSetup: boolean,
  defaultHttps: DerivationDefaultHttps | null,
): ComponentProgressStatus | null {
  if (domain) {
    switch (domain.status) {
      case 'ACTIVE':
        return 'READY';
      case 'ERROR':
        // Component-level only — an HTTPS setup failure never fails the
        // whole deployment; the app itself may be perfectly healthy.
        return 'FAILED';
      case 'PENDING':
      case 'WAITING_FOR_DNS':
      case 'CONFIGURING':
      case 'REMOVING':
        return 'IN_PROGRESS';
      default:
        return 'IN_PROGRESS';
    }
  }
  if (defaultHttps) {
    switch (defaultHttps.status) {
      case 'ACTIVE':
        return 'READY';
      case 'ERROR':
        return 'FAILED';
      case 'PENDING':
      case 'WAITING_FOR_DNS':
      case 'CONFIGURING':
      case 'REMOVING':
        return 'IN_PROGRESS';
      default:
        return 'IN_PROGRESS';
    }
  }
  return needsDomainSetup ? 'PENDING' : null;
}

/**
 * The secure-endpoint truth for the infrastructure inventory's `endpoint`
 * component. CloudFormation marks the load balancer complete long before
 * HTTPS works, so the inventory route overlays the same domain / default-
 * HTTPS machine state `httpsComponentStatus` reads: READY only once a
 * custom domain or the Deployz-owned address is ACTIVE (a successful HTTPS
 * probe), never inferred from timing or from the listener existing.
 */
export function endpointHttpsState(
  domain: DerivationDomain | null,
  defaultHttps: DerivationDefaultHttps | null,
): InfrastructureHttpsState {
  if (domain?.status === 'ACTIVE' || defaultHttps?.status === 'ACTIVE') return 'READY';
  const status = defaultHttps?.status ?? domain?.status ?? null;
  switch (status) {
    case 'PENDING':
      return 'SETTING_UP';
    case 'WAITING_FOR_DNS':
      return 'WAITING_FOR_CERTIFICATE';
    case 'CONFIGURING':
      return 'ACTIVATING';
    case 'ERROR':
      return 'FAILED';
    case 'REMOVING':
      return 'REMOVING';
    default:
      return 'SETTING_UP';
  }
}

/**
 * CloudFormation logical ids of the ECS services that receive public
 * ingress, from the frozen spec. Empty when there is no compiled spec or no
 * public workload — nothing is then required of the inventory.
 */
export function primaryServiceLogicalIds(spec: DeploymentSpecV2 | null): string[] {
  if (spec === null || !spec.ir.ingress.public) return [];
  const publicIds = new Set(spec.ir.ingress.targetWorkloadIds);
  return (workloadServicesFromSpec(spec) ?? [])
    .filter((workload) => publicIds.has(workload.id))
    .map((workload) => workload.serviceLogicalId);
}

/** The closed component-status vocabulary an HTTPS state maps onto. */
export function endpointStatusForHttpsState(state: InfrastructureHttpsState): InfrastructureComponentStatus {
  switch (state) {
    case 'READY':
      return 'ready';
    case 'FAILED':
      return 'failed';
    case 'REMOVING':
      return 'deleting';
    default:
      return 'provisioning';
  }
}

function buildComponents(params: {
  stage: DeploymentStage;
  observedState: Record<string, unknown> | null;
  application: DerivationApplication;
  domain: DerivationDomain | null;
  needsDomainSetup: boolean;
  defaultHttps: DerivationDefaultHttps | null;
  failureResult: Record<string, unknown> | null | undefined;
}): ComponentProgress[] {
  const merged = mergeComponentState(params.observedState, params.application) ?? {};
  const failedChecks = params.stage === 'FAILED' ? failedCheckComponents(params.failureResult) : new Set<string>();

  const components: ComponentProgress[] = [];
  const push = (key: string, label: string, mergedKey: string, required: boolean): void => {
    let status = statusFromMerged(merged[mergedKey], required, params.stage);
    if (required && params.stage === 'FAILED' && failedChecks.has(key)) {
      status = 'FAILED';
    }
    components.push({ key, label, status });
  };

  // One seat per persistent workload (Phase 4A): the web workload keeps the
  // historical `runtime` progress seat; every additional workload sits under
  // its own id. An unprojected row keeps the single legacy web seat.
  for (const workloadId of workloadSeats(params.application.workloads)) {
    push(
      workloadProgressKey(workloadId),
      workloadComponentLabel(workloadId),
      workloadMergedKey(workloadId),
      true,
    );
  }
  push('database', COMPONENT_LABELS['database']!, 'database', params.application.databaseRequired ?? false);
  push('storage', COMPONENT_LABELS['storage']!, 'storage', params.application.storageRequired ?? false);
  push('redis', COMPONENT_LABELS['redis']!, 'redis', params.application.redisRequired ?? false);

  const httpsStatus = httpsComponentStatus(params.domain, params.needsDomainSetup, params.defaultHttps);
  if (httpsStatus !== null) {
    components.push({ key: 'https', label: COMPONENT_LABELS.https!, status: httpsStatus });
  }

  return components;
}

// ---------------------------------------------------------------------------
// Job helpers
// ---------------------------------------------------------------------------

function latestBy<T>(items: T[], keyFn: (item: T) => Date | null): T | undefined {
  let best: T | undefined;
  let bestTime = -Infinity;
  for (const item of items) {
    const time = keyFn(item)?.getTime();
    if (time !== undefined && time >= bestTime) {
      best = item;
      bestTime = time;
    }
  }
  return best;
}

function latestJob(jobs: DerivationJob[]): DerivationJob | undefined {
  return latestBy(jobs, (job) => job.createdAt);
}

function latestOfType(jobs: DerivationJob[], type: JobType): DerivationJob | undefined {
  return latestBy(
    jobs.filter((job) => job.type === type),
    (job) => job.createdAt,
  );
}

/**
 * The job whose failure explains a FAILED deployment. An install that never
 * verified has no failed job: the control plane records the classified code on
 * the settled job its window was measured from. That record wins unless a
 * job failed after that job settled.
 */
function latestFailedJob(jobs: DerivationJob[]): DerivationJob | undefined {
  const failed = latestBy(
    jobs.filter((job) => job.state === 'FAILED'),
    (job) => job.createdAt,
  );
  const unverified = latestBy(
    jobs.filter((job) => SUCCEEDED_JOB_STATES.has(job.state) && readInstallVerification(job.result) !== null),
    (job) => job.finishedAt ?? job.createdAt,
  );
  const record = unverified ? readInstallVerification(unverified.result) : null;
  if (!unverified || !record || (failed && failed.createdAt >= (unverified.finishedAt ?? unverified.createdAt))) {
    return failed;
  }
  return { ...unverified, state: 'FAILED', failureCode: record.failureCode, result: null };
}

/**
 * The relay reports a settled job as `{ success, error, output }`, so its
 * fields live under `output` on the wire (the same nesting
 * albEndpointFromResult in server.ts unwraps); tests and older rows carry
 * them at the top level. Accept both.
 */
function unwrapJobResult(result: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!result || typeof result !== 'object') return null;
  const output = (result as { output?: unknown }).output;
  return output && typeof output === 'object' ? (output as Record<string, unknown>) : result;
}

function extractStackStatus(result: Record<string, unknown> | null | undefined): string | null {
  const nested = unwrapJobResult(result)?.stackStatus;
  if (typeof nested === 'string') return nested;
  const top = result?.stackStatus;
  return typeof top === 'string' ? top : null;
}

function buildFailure(job: DerivationJob | undefined, entry: FailureEntry): DerivedFailure {
  return {
    code: job?.failureCode ? knownFailureCode(job.failureCode) : null,
    component: entry.component,
    // First 8 hex chars of the failed job's id — a uuid's leading segment is
    // exactly 8 hex characters, so no dash-stripping is needed. Falls back
    // to a fixed placeholder in the (should-not-happen) case where the
    // caller's job set omitted the FAILED job the deployment's own state
    // says exists.
    reference: job ? `DEP-${job.id.slice(0, 8).toUpperCase()}` : 'DEP-UNKNOWN',
    customerMessage: entry.customerMessage,
    vendorMessage: entry.vendorMessage,
    awsStatus: extractStackStatus(job?.result),
    jobType: job?.type ?? null,
  };
}

// ---------------------------------------------------------------------------
// Timestamp helper
// ---------------------------------------------------------------------------

function maxDate(...dates: (Date | null | undefined)[]): Date | null {
  let best: Date | null = null;
  for (const date of dates) {
    if (date instanceof Date && (best === null || date.getTime() > best.getTime())) {
      best = date;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Relay provisioning snapshot — the mid-PROVISIONING truth `observedState.
// infraHealth.provisioning` carries once a relay reports one (see
// packages/relay/src/provision-progress.ts). Absent entirely on older
// relays and on every heartbeat before the CFN stack exists, so every read
// here is defensive: an unrecognised shape is treated exactly like "no
// snapshot yet", never as an error.
// ---------------------------------------------------------------------------

type ProvisioningCategoryKey = 'network' | 'database' | 'storage' | 'redis' | 'application';
const PROVISIONING_CATEGORY_KEYS: readonly ProvisioningCategoryKey[] = [
  'network',
  'database',
  'storage',
  'redis',
  'application',
];
const PROVISIONING_CATEGORY_STATUSES = new Set(['IN_PROGRESS', 'COMPLETE', 'FAILED']);

interface ProvisioningCategory {
  status: 'IN_PROGRESS' | 'COMPLETE' | 'FAILED';
  startedAt?: string;
  completedAt?: string;
}
type ProvisioningSnapshot = Partial<Record<ProvisioningCategoryKey, ProvisioningCategory>>;

/** The live CloudFormation stack status the snapshot carries, if any — the
 *  only stack-status signal that exists while the INSTALL job has no result
 *  yet (see `aws.stackStatus` below). */
function readSnapshotStackStatus(observedState: Record<string, unknown> | null | undefined): string | null {
  const infraHealth = (observedState as { infraHealth?: unknown } | null | undefined)?.infraHealth;
  const provisioning = (infraHealth as { provisioning?: unknown } | null | undefined)?.provisioning;
  const stackStatus = (provisioning as { stackStatus?: unknown } | null | undefined)?.stackStatus;
  return typeof stackStatus === 'string' ? stackStatus : null;
}

function readProvisioningSnapshot(observedState: Record<string, unknown> | null | undefined): ProvisioningSnapshot | null {
  const infraHealth = (observedState as { infraHealth?: unknown } | null | undefined)?.infraHealth;
  const provisioning = (infraHealth as { provisioning?: unknown } | null | undefined)?.provisioning;
  const categories = (provisioning as { categories?: unknown } | null | undefined)?.categories;
  if (categories === null || typeof categories !== 'object') return null;

  const snapshot: ProvisioningSnapshot = {};
  for (const key of PROVISIONING_CATEGORY_KEYS) {
    const raw = (categories as Record<string, unknown>)[key];
    if (raw === null || typeof raw !== 'object') continue;
    const status = (raw as { status?: unknown }).status;
    if (typeof status !== 'string' || !PROVISIONING_CATEGORY_STATUSES.has(status)) continue;
    const startedAt = (raw as { startedAt?: unknown }).startedAt;
    const completedAt = (raw as { completedAt?: unknown }).completedAt;
    snapshot[key] = {
      status: status as ProvisioningCategory['status'],
      ...(typeof startedAt === 'string' ? { startedAt } : {}),
      ...(typeof completedAt === 'string' ? { completedAt } : {}),
    };
  }
  return Object.keys(snapshot).length > 0 ? snapshot : null;
}

/**
 * Which snapshot categories back a given step's timing — DATABASE_STORAGE
 * merges `database`+`storage`, restricted to whichever the application
 * actually requires (an unrequired component never gates the merged step).
 */
function categoryKeysForStep(step: DeploymentStep, application: DerivationApplication): ProvisioningCategoryKey[] {
  switch (step) {
    case 'NETWORK':
      return ['network'];
    case 'DATABASE_STORAGE': {
      const keys: ProvisioningCategoryKey[] = [];
      if (application.databaseRequired) keys.push('database');
      if (application.storageRequired) keys.push('storage');
      return keys;
    }
    case 'REDIS':
      return ['redis'];
    case 'APPLICATION':
      return ['application'];
    default:
      return [];
  }
}

/** Earliest known start across a step's backing categories, or null if none reported one yet. */
function snapshotStartedAt(
  snapshot: ProvisioningSnapshot | null,
  step: DeploymentStep,
  application: DerivationApplication,
): string | null {
  const dates = categoryKeysForStep(step, application)
    .map((key) => snapshot?.[key]?.startedAt)
    .filter((date): date is string => typeof date === 'string');
  return dates.length > 0 ? dates.reduce((min, date) => (date < min ? date : min)) : null;
}

/** Latest known completion across a step's backing categories, only once ALL of them are COMPLETE. */
function snapshotCompletedAt(
  snapshot: ProvisioningSnapshot | null,
  step: DeploymentStep,
  application: DerivationApplication,
): string | null {
  const keys = categoryKeysForStep(step, application);
  if (keys.length === 0) return null;
  const categories = keys.map((key) => snapshot?.[key]);
  if (categories.some((category) => category === undefined || category.status !== 'COMPLETE')) return null;
  const completions = categories
    .map((category) => category!.completedAt)
    .filter((date): date is string => typeof date === 'string');
  return completions.length === categories.length
    ? completions.reduce((max, date) => (date > max ? date : max))
    : null;
}

/**
 * The active PROVISIONING sub-step per the snapshot: first of NETWORK,
 * DATABASE_STORAGE (iff required), REDIS (iff required), APPLICATION whose
 * merged category is not COMPLETE. Returns null when there is no snapshot
 * at all — the caller decides the fallback (PREPARING for an in-flight
 * install, the FAILURE_COMPONENT map for a failed one).
 *
 * A step whose completion is already persisted in the write-once
 * `stepTimings` stays complete whatever a later snapshot says: a category
 * can flip back to IN_PROGRESS after it was reported COMPLETE (observed
 * live: the ECS service's security-group rules — "network" resources —
 * were created minutes after the database, and the step visibly regressed
 * from "Database & storage" to "Creating network"). The ladder only ever
 * moves forward.
 */
function provisioningLadderStep(
  snapshot: ProvisioningSnapshot | null,
  application: DerivationApplication,
  persisted: DerivationDeployment['stepTimings'],
): DeploymentStep | null {
  if (!snapshot) return null;
  const complete = (step: DeploymentStep): boolean =>
    persisted?.[step]?.completedAt !== undefined || snapshotCompletedAt(snapshot, step, application) !== null;

  if (!complete('NETWORK')) return 'NETWORK';
  const databaseStorageRequired = (application.databaseRequired ?? false) || (application.storageRequired ?? false);
  if (databaseStorageRequired && !complete('DATABASE_STORAGE')) return 'DATABASE_STORAGE';
  if ((application.redisRequired ?? false) && !complete('REDIS')) return 'REDIS';
  return 'APPLICATION';
}

/**
 * The step whose backing category the snapshot marks FAILED, if any — in
 * canonical order, so a multi-category failure names the earliest step.
 * The only ladder question that stays answerable while a stack rolls back.
 */
function snapshotFailedStep(
  snapshot: ProvisioningSnapshot | null,
  application: DerivationApplication,
): DeploymentStep | null {
  if (!snapshot) return null;
  for (const step of ['NETWORK', 'DATABASE_STORAGE', 'REDIS', 'APPLICATION'] as const) {
    const failed = categoryKeysForStep(step, application).some(
      (key) => snapshot[key]?.status === 'FAILED',
    );
    if (failed) return step;
  }
  return null;
}

/** Applicable steps for this deployment, in canonical order — REDIS/DATABASE_STORAGE only when required, MIGRATION only for apps with a migration command. */
function applicableSteps(application: DerivationApplication, migrationFailed = false): DeploymentStep[] {
  const databaseStorageRequired = (application.databaseRequired ?? false) || (application.storageRequired ?? false);
  // The migration command can be frozen with the release rather than set on
  // the application row, so a MIGRATION_FAILED job proves the step applies.
  const migrationConfigured =
    migrationFailed || (typeof application.migrationCommand === 'string' && application.migrationCommand.length > 0);
  return DEPLOYMENT_STEP_ORDER.filter((step) => {
    if (step === 'DATABASE_STORAGE') return databaseStorageRequired;
    if (step === 'REDIS') return application.redisRequired ?? false;
    if (step === 'MIGRATION') return migrationConfigured;
    return true;
  });
}

/**
 * stepStartedAt resolution ladder (first non-null wins):
 *   1. persisted deployments.step_timings[step].startedAt
 *   2. an authoritative fallback specific to the step
 *   3. null (and, per deriveDeploymentStatus, no slow-step flag either)
 */
function resolveStepStartedAt(
  step: DeploymentStep,
  params: {
    persisted: Record<string, { startedAt: string; completedAt?: string }> | null;
    deployment: DerivationDeployment;
    jobs: DerivationJob[];
    application: DerivationApplication;
    snapshot: ProvisioningSnapshot | null;
  },
): string | null {
  const persistedStartedAt = params.persisted?.[step]?.startedAt;
  if (persistedStartedAt) return persistedStartedAt;

  switch (step) {
    case 'AWS_SETUP':
      return params.deployment.installStartedAt?.toISOString() ?? null;
    case 'RELAY_CONNECT':
      return (params.deployment.enrollmentUsedAt ?? params.deployment.relayBoundAt)?.toISOString() ?? null;
    case 'PREPARING': {
      const installJob = latestOfType(params.jobs, 'INSTALL');
      const at = installJob?.startedAt ?? installJob?.createdAt ?? null;
      return at?.toISOString() ?? null;
    }
    case 'NETWORK':
    case 'DATABASE_STORAGE':
    case 'REDIS':
    case 'APPLICATION':
      return snapshotStartedAt(params.snapshot, step, params.application);
    case 'HEALTH_CHECK':
      return latestOfType(params.jobs, 'INSTALL')?.finishedAt?.toISOString() ?? null;
    case 'MIGRATION':
    case 'TLS':
    case 'READY':
      return null;
  }
}

/** The vendor-only `stepTimings` list: completed + active steps from the persisted map, in canonical order. */
function buildStepTimings(
  persisted: Record<string, { startedAt: string; completedAt?: string }> | null,
): StepTimingEntry[] {
  if (!persisted) return [];
  const entries: StepTimingEntry[] = [];
  for (const step of DEPLOYMENT_STEP_ORDER) {
    const record = persisted[step];
    if (!record) continue;
    const durationSeconds = record.completedAt
      ? Math.round((new Date(record.completedAt).getTime() - new Date(record.startedAt).getTime()) / 1000)
      : null;
    entries.push({ step, startedAt: record.startedAt, completedAt: record.completedAt ?? null, durationSeconds });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// currentActivity copy per stage. Deliberately short, vendor-grade sentences
// — the customer projection uses the SAME text (§65: no separate customer
// vocabulary needed here, none of this mentions AWS/CFN/ECS by name).
// ---------------------------------------------------------------------------

const STAGE_ACTIVITY: Record<'WAITING_FOR_AWS' | 'CONNECTING' | 'PROVISIONING' | 'READY', string> = {
  WAITING_FOR_AWS: 'Waiting for AWS setup to start.',
  CONNECTING: "Connecting to the customer's cloud account.",
  PROVISIONING: "Creating infrastructure in the customer's cloud account.",
  READY: 'Live and healthy.',
};

// Step-aware PROVISIONING copy — replaces the generic STAGE_ACTIVITY.PROVISIONING
// sentence once the active sub-step is known, so the install page can say what
// is actually happening instead of a single catch-all "creating infrastructure".
const PROVISIONING_STEP_ACTIVITY: Record<'PREPARING' | 'NETWORK' | 'DATABASE_STORAGE' | 'REDIS' | 'APPLICATION', string> = {
  PREPARING: 'Preparing the deployment.',
  NETWORK: 'Creating the network.',
  DATABASE_STORAGE: 'Creating the database and storage.',
  REDIS: 'Creating the Redis cache.',
  APPLICATION: 'Starting the application.',
};

const EVER_INSTALLED_STATES = new Set<DeploymentState>(['HEALTHY', 'UPDATING', 'UPDATE_AVAILABLE']);
const REMOVED_STATES = new Set<DeploymentState>(['DELETING', 'DELETED']);
const PROVISIONING_JOB_STATES = new Set<JobState>(['RUNNING', 'WAITING']);
const SUCCEEDED_JOB_STATES = new Set<JobState>(['SUCCEEDED', 'SUCCESS']);
const IN_FLIGHT_JOB_STATES = new Set<JobState>(['REQUESTED', 'QUEUED', 'WAITING', 'RUNNING']);
const DAY_TWO_JOB_TYPES = new Set<JobType>(['DEPLOY_RELEASE', 'ROLLBACK', 'RESTART', 'CONFIG_UPDATE']);

// ---------------------------------------------------------------------------
// §10.1 layered runtime health — read from the SAME observedState the relay's
// heartbeat persists, with each layer derived from its own source. The five
// layers deliberately stay apart: verification says whether the STACK is
// right, rollout state what ECS is doing, target counts what the ALB sees,
// httpProbe what the APPLICATION answers, and relayStatus whether the relay
// is even connected. A failing app must never be reported through the ALB
// layer, and vice versa.
// ---------------------------------------------------------------------------

const ROLLOUT_STATES: ReadonlySet<string> = new Set(['COMPLETED', 'IN_PROGRESS', 'FAILED']);
const RELAY_STATUSES: ReadonlySet<string> = new Set(['CONNECTED', 'DISCONNECTED', 'UNKNOWN']);

/** The ALB/ECS counts the heartbeat reported, or null when it reported none. */
function readHealthTargets(observedState: Record<string, unknown> | null): HealthTargets | null {
  if (!observedState) return null;
  const o = observedState;
  const hasRuntimeHealth =
    'desiredCount' in o || 'runningCount' in o || 'unhealthyTargetCount' in o;
  if (!hasRuntimeHealth) return null;
  const numberOrNull = (value: unknown): number | null => (typeof value === 'number' ? value : null);
  return {
    desiredCount: numberOrNull(o['desiredCount']),
    runningCount: numberOrNull(o['runningCount']),
    unhealthyTargetCount: numberOrNull(o['unhealthyTargetCount']),
    pendingTargetCount: numberOrNull(o['pendingTargetCount']),
    unknownTargetCount: numberOrNull(o['unknownTargetCount']),
  };
}

/** The relay's HTTP probe record, defensively narrowed to the wire shape. */
function readHttpProbe(observedState: Record<string, unknown> | null): HttpProbe | null {
  const raw = observedState?.['httpProbe'];
  if (raw === null || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  if (typeof record['ok'] !== 'boolean' || typeof record['checkedAt'] !== 'string') return null;
  const numberOrNull = (value: unknown): number | null => (typeof value === 'number' ? value : null);
  const stringOrNullish = (value: unknown): string | null | undefined =>
    typeof value === 'string' ? value : value === null ? null : undefined;
  return {
    ok: record['ok'],
    statusCode: numberOrNull(record['statusCode']),
    latencyMs: numberOrNull(record['latencyMs']),
    checkedAt: record['checkedAt'],
    ...(stringOrNullish(record['error']) !== undefined ? { error: record['error'] as string } : {}),
    ...(stringOrNullish(record['lastSuccessAt']) !== undefined
      ? { lastSuccessAt: stringOrNullish(record['lastSuccessAt']) }
      : {}),
    ...(stringOrNullish(record['lastFailedAt']) !== undefined
      ? { lastFailedAt: stringOrNullish(record['lastFailedAt']) }
      : {}),
  };
}

/**
 * Builds the five §10.1 layers from the persisted heartbeat's observedState
 * plus the persisted relay liveness column. Always returns a complete object
 * — every layer has an honest "unknown" answer when its source said nothing.
 */
function buildHealthLayers(
  relayStatus: RelayStatus,
  observedState: Record<string, unknown> | null,
): RuntimeHealthLayers {
  const infraHealth = observedState?.['infraHealth'];
  const verified =
    infraHealth !== null && typeof infraHealth === 'object'
      ? (infraHealth as Record<string, unknown>)['verified']
      : undefined;
  const rawRollout = observedState?.['deploymentRolloutState'];
  return {
    infrastructure:
      typeof verified === 'boolean' ? (verified ? 'HEALTHY' : 'UNHEALTHY') : 'UNKNOWN',
    rollout: typeof rawRollout === 'string' && ROLLOUT_STATES.has(rawRollout)
      ? (rawRollout as RuntimeHealthLayers['rollout'])
      : null,
    targets: readHealthTargets(observedState),
    http: readHttpProbe(observedState),
    relay: RELAY_STATUSES.has(relayStatus) ? (relayStatus as RuntimeHealthLayers['relay']) : 'UNKNOWN',
  };
}

/**
 * The pure read-time derivation. Precedence (exact, first match wins):
 *   1. state FAILED                              → FAILED
 *   2. everInstalled                              → READY or VERIFYING
 *   3. latest INSTALL job RUNNING/WAITING          → PROVISIONING
 *   4. relay registered (enrollment/bind/INSTALLING) → CONNECTING
 *   5. otherwise                                   → WAITING_FOR_AWS
 * `removed` is set separately (state DELETING/DELETED) and does not change
 * which of the above stages is computed — a removed deployment still carries
 * whatever stage it last earned, so both projections can render "removed"
 * chrome around a real last-known stage instead of a placeholder.
 */
function connectorStatus(
  upgradeRequired: boolean,
  deployment: Pick<DerivationDeployment, 'bootstrapVersion'>,
  offer: ConnectorUpdateOffer | null,
): DerivedDeploymentStatus['connector'] {
  const newerBuild =
    offer?.publishedBuildId != null && (deployment.bootstrapVersion ?? null) !== offer.publishedBuildId;
  const updateAvailable = upgradeRequired || newerBuild;
  return {
    upgradeRequired,
    reason: upgradeRequired ? 'RELEASE_EVIDENCE_MISSING' : null,
    updateAvailable,
    updateUrl: updateAvailable ? (offer?.updateUrl ?? null) : null,
    updateTemplateUrl: updateAvailable ? (offer?.templateUrl ?? null) : null,
  };
}

export function deriveDeploymentStatus(input: DeriveDeploymentStatusInput): DerivedDeploymentStatus {
  const { deployment, application, jobs, domain, defaultHttps = null, connectorUpdate = null, appUrl, now = new Date() } = input;

  // deployments.state 'DISCONNECTED' is a valid enum value that nothing in
  // this codebase currently writes (the persisted liveness sweep flips
  // relayStatus, not state). Handled defensively rather than assumed
  // unreachable: if it is ever written, treat it exactly like the relay
  // outage it would represent — retain the last confirmed stage instead of
  // regressing, same as a merely-stale relay does below.
  const everInstalled =
    deployment.state === 'DISCONNECTED' ||
    EVER_INSTALLED_STATES.has(deployment.state) ||
    deployment.currentReleaseId !== null ||
    jobs.some((job) => job.type === 'INSTALL' && SUCCEEDED_JOB_STATES.has(job.state));
  const httpsUrl = appUrl !== null && appUrl.startsWith('https://');
  const releaseVerdict = readReleaseVerdict(deployment.observedState);
  // A rollout in progress fails every heartbeat's release evidence, but a
  // release already confirmed serving keeps serving (a failed update keeps
  // the previous release live), so a running day-2 job does not undo READY.
  const dayTwoInFlight =
    deployment.currentReleaseConfirmedAt !== null &&
    jobs.some((job) => DAY_TWO_JOB_TYPES.has(job.type) && IN_FLIGHT_JOB_STATES.has(job.state));
  const statusUpdatesUnavailable = deployment.relayStatus === 'DISCONNECTED' || deployment.state === 'DISCONNECTED';

  let stage: DeploymentStage;
  let needsDomainSetup = false;
  let currentActivity: string;

  const latestFailed = latestFailedJob(jobs);
  const awaitingFirstStart =
    deployment.currentReleaseId === null &&
    jobs.some(
      (job) =>
        job.type === 'INSTALL' &&
        SUCCEEDED_JOB_STATES.has(job.state) &&
        (job.payload as Record<string, unknown> | null | undefined)?.['startAfterConfig'] === true,
    ) &&
    !jobs.some(
      (job) => (job.type === 'DEPLOY_RELEASE' || job.type === 'ROLLBACK') && SUCCEEDED_JOB_STATES.has(job.state),
    );
  const installJobState = latestOfType(jobs, 'INSTALL')?.state;
  const failureEntry = deployment.state === 'FAILED' ? failureEntryFor(latestFailed?.failureCode ?? null) : undefined;

  if (deployment.state === 'FAILED') {
    stage = 'FAILED';
    currentActivity = failureEntry!.vendorMessage;
  } else if (everInstalled) {
    // The STORED healthStatus, never relay-liveness.ts's disconnect-masked
    // display value: masking exists so a screen doesn't claim to know
    // current health during an outage, but the STAGE must retain whatever
    // was last confirmed — regressing a deployment's stage because the
    // relay went quiet would read as the deployment breaking, when nothing
    // about the deployment itself changed.
    if (deployment.healthStatus === 'HEALTHY' && httpsUrl && (releaseVerdict?.pass === true || dayTwoInFlight)) {
      stage = 'READY';
      currentActivity = STAGE_ACTIVITY.READY;
    } else {
      stage = 'VERIFYING';
      if (deployment.healthStatus !== 'HEALTHY' || (httpsUrl && releaseVerdict?.pass !== true)) {
        currentActivity = 'Running health checks.';
      } else {
        // Healthy but not yet on an HTTPS URL. needsDomainSetup is reserved
        // for the cases where the CUSTOMER must act (they added a custom
        // domain that needs DNS, or nothing automatic is going to produce a
        // secure address). While the Phase 11 default HTTPS is progressing
        // on its own, no customer action is required.
        const httpsProgressing =
          (defaultHttps !== null &&
            (defaultHttps.status === 'PENDING' ||
              defaultHttps.status === 'WAITING_FOR_DNS' ||
              defaultHttps.status === 'CONFIGURING')) ||
          (domain !== null &&
            (domain.status === 'PENDING' ||
              domain.status === 'WAITING_FOR_DNS' ||
              domain.status === 'CONFIGURING'));
        needsDomainSetup =
          domain !== null || !httpsProgressing;
        currentActivity = needsDomainSetup
          ? 'Waiting for secure domain setup.'
          : 'Waiting for a secure address.';
      }
    }
  } else if (installJobState !== undefined && PROVISIONING_JOB_STATES.has(installJobState)) {
    stage = 'PROVISIONING';
    currentActivity = STAGE_ACTIVITY.PROVISIONING;
  } else if (
    deployment.enrollmentUsedAt !== null ||
    deployment.relayBoundAt !== null ||
    deployment.state === 'INSTALLING'
  ) {
    stage = 'CONNECTING';
    currentActivity = STAGE_ACTIVITY.CONNECTING;
  } else {
    // NOT_INSTALLED (link not launched) and WAITING_FOR_RELAY (customer
    // pressed Deploy to AWS, no relay yet) both land here: the spec's
    // WAITING_FOR_AWS covers everything before the relay's first contact,
    // and the install page distinguishes the two sub-states with the
    // launch-signal fields, not with a different stage.
    stage = 'WAITING_FOR_AWS';
    currentActivity = STAGE_ACTIVITY.WAITING_FOR_AWS;
  }

  // ── Step derivation (a read-time sub-step of `stage`, never persisted) ──
  const snapshot = readProvisioningSnapshot(deployment.observedState);
  const snapshotStackStatus = readSnapshotStackStatus(deployment.observedState);
  // A rolling-back (or deleting) stack still reports a snapshot, but its
  // categories describe resources being torn down, not created — feeding
  // them to the forward ladder made the step visibly REGRESS mid-rollback
  // (observed live: "Creating the network" while CloudFormation deleted it).
  // The one snapshot fact that stays truthful through a rollback is a
  // category that FAILED — that is where the attempt actually stopped.
  const snapshotRollingBack =
    snapshotStackStatus !== null && /ROLLBACK|DELETE/.test(snapshotStackStatus);
  const failedCategoryStep = snapshotFailedStep(snapshot, application);
  let step: DeploymentStep;
  switch (stage) {
    case 'WAITING_FOR_AWS':
      step = 'AWS_SETUP';
      break;
    case 'CONNECTING':
      step = 'RELAY_CONNECT';
      break;
    case 'PROVISIONING':
      step =
        failedCategoryStep ??
        (snapshotRollingBack
          ? 'PREPARING'
          : (provisioningLadderStep(snapshot, application, deployment.stepTimings) ?? 'PREPARING'));
      currentActivity = PROVISIONING_STEP_ACTIVITY[step as keyof typeof PROVISIONING_STEP_ACTIVITY];
      break;
    case 'VERIFYING':
      // A healthy app not yet behind an HTTPS URL is still on the TLS step
      // (a customer domain awaiting DNS, or the Phase 11 default endpoint
      // being brought up). An unhealthy app — or one already behind its
      // HTTPS URL with a health problem — reports the health-check step.
      step = deployment.healthStatus === 'HEALTHY' && !httpsUrl ? 'TLS' : 'HEALTH_CHECK';
      // A configured first start (DEPLOY-009) has no task yet: the
      // application is still to be started, so it is not past that step.
      if (awaitingFirstStart) step = 'APPLICATION';
      break;
    case 'READY':
      step = 'READY';
      break;
    case 'FAILED': {
      // INSTALL failures locate the step from the snapshot first (the most
      // truthful answer to "what was it doing"); only when no snapshot can
      // say does the failure's classified component stand in. A failed
      // job of any OTHER type (DEPLOY_RELEASE, RESTART, ...) never touched
      // provisioning at all, so it is attributed to APPLICATION uniformly.
      if (latestFailed?.type === 'INSTALL') {
        const ladderStep =
          failedCategoryStep ??
          (snapshotRollingBack ? null : provisioningLadderStep(snapshot, application, deployment.stepTimings));
        if (ladderStep) {
          step = ladderStep;
        } else {
          const component = failureEntry?.component ?? null;
          step =
            component === 'database'
              ? 'DATABASE_STORAGE'
              : component === 'redis'
                ? 'REDIS'
                : component === 'runtime'
                  ? 'APPLICATION'
                  : 'PREPARING';
        }
      } else {
        // A failed job of any other type (DEPLOY_RELEASE, RESTART, ...)
        // never touched provisioning; a MIGRATION_FAILED deploy names the
        // migration step, everything else is attributed to APPLICATION.
        step = latestFailed?.failureCode === 'MIGRATION_FAILED' ? 'MIGRATION' : 'APPLICATION';
      }
      break;
    }
  }

  const steps = applicableSteps(
    application,
    stage === 'FAILED' && latestFailed?.type !== 'INSTALL' && latestFailed?.failureCode === 'MIGRATION_FAILED',
  );
  if (!steps.includes(step)) {
    // The failure-component fallback above can name a step the application's
    // current flags exclude (a REDIS_* failure code after redisRequired was
    // turned off, say). A step outside the applicable list would leave both
    // progress lists with nothing to highlight, so fall back to the broadest
    // truthful in-stage step instead.
    step = 'PREPARING';
  }
  const stepStartedAt = resolveStepStartedAt(step, { persisted: deployment.stepTimings, deployment, jobs, application, snapshot });
  const typicalDurationSeconds = TYPICAL_STEP_DURATION_SECONDS[step];
  // A silent relay cannot support "AWS is still working" — statusUpdatesUnavailable
  // suppresses the flag exactly like it suppresses every other live signal.
  // A rolling-back stack is not "still working" toward the step completing,
  // so the reassuring slow-step nudge is suppressed there too.
  const takingLongerThanUsual =
    typicalDurationSeconds !== null &&
    stepStartedAt !== null &&
    now.getTime() - new Date(stepStartedAt).getTime() > typicalDurationSeconds.max * 1000 &&
    stage !== 'READY' &&
    stage !== 'FAILED' &&
    !snapshotRollingBack &&
    !statusUpdatesUnavailable;
  const stepTimings = buildStepTimings(deployment.stepTimings);
  const stepSnapshotCompletedAt: Partial<Record<DeploymentStep, string>> = {};
  for (const snapshotStep of ['NETWORK', 'DATABASE_STORAGE', 'REDIS', 'APPLICATION'] as const) {
    const completedAt = snapshotCompletedAt(snapshot, snapshotStep, application);
    if (completedAt) stepSnapshotCompletedAt[snapshotStep] = completedAt;
  }

  const components = buildComponents({
    stage,
    observedState: deployment.observedState,
    application,
    domain,
    needsDomainSetup,
    defaultHttps,
    failureResult: latestFailed?.result,
  });

  const latest = latestJob(jobs);
  // aws.stackStatus reflects the last CREATE/DELETE the customer's account
  // actually ran — DEPLOY_RELEASE/ROLLBACK/etc. never touch the stack, so
  // only INSTALL and DESTROY are candidates.
  const latestStackJob = latestBy(
    jobs.filter((job) => job.type === 'INSTALL' || job.type === 'DESTROY'),
    (job) => job.createdAt,
  );

  // A failed day-2 operation (deploy/rollback/restart) leaves the deployment
  // in a live state — the previous release keeps serving — so the stage is
  // READY/VERIFYING, not FAILED. The failure still has to reach the screen:
  // surface it while the most recent day-2 attempt is the failed one (a
  // running retry or a later success clears it, and a removed deployment has
  // no update to report on).
  const latestDayTwo = latestBy(
    jobs.filter((job) => job.type === 'DEPLOY_RELEASE' || job.type === 'ROLLBACK' || job.type === 'RESTART'),
    (job) => job.createdAt,
  );
  // A failed configuration update surfaces the same way while the latest
  // configuration attempt is the failed one; a failed release update wins.
  const latestConfigUpdate = latestBy(
    jobs.filter((job) => job.type === 'CONFIG_UPDATE'),
    (job) => job.createdAt,
  );
  const dayTwoFailure =
    stage !== 'FAILED' && everInstalled && !REMOVED_STATES.has(deployment.state)
      ? latestDayTwo?.state === 'FAILED'
        ? latestDayTwo
        : latestConfigUpdate?.state === 'FAILED'
          ? latestConfigUpdate
          : undefined
      : undefined;

  const updatedAt =
    maxDate(deployment.updatedAt, deployment.lastHealthAt, latest?.lastProgressAt, latest?.finishedAt) ?? new Date();

  return {
    stage,
    updatedAt: updatedAt.toISOString(),
    currentActivity,
    step,
    steps,
    stepStartedAt,
    typicalDurationSeconds,
    takingLongerThanUsual,
    stepTimings,
    stepSnapshotCompletedAt,
    ...(REMOVED_STATES.has(deployment.state) ? { removed: { state: deployment.state as 'DELETING' | 'DELETED' } } : {}),
    statusUpdatesUnavailable,
    needsDomainSetup,
    components,
    relay: {
      connected: deployment.relayStatus === 'CONNECTED',
      // No dedicated "last seen" column exists yet — the last health report
      // is the freshest signal this module has of the relay actually being
      // there, so it stands in for it.
      lastSeenAt: deployment.lastHealthAt?.toISOString() ?? null,
    },
    job: latest ? { type: latest.type, status: latest.state } : null,
    // A settled INSTALL/DESTROY result is the definitive answer; while one is
    // still running its result is null, and the relay snapshot's live status
    // (CREATE_IN_PROGRESS et al.) is the only stack-status signal there is.
    aws: {
      stackStatus:
        extractStackStatus(latestStackJob?.result) ?? readSnapshotStackStatus(deployment.observedState),
    },
    health: {
      status: deployment.healthStatus,
      // §10.1: the five layers, each from its own source — never collapsed
      // into the scalar `status` above.
      layers: buildHealthLayers(deployment.relayStatus, deployment.observedState),
      notStarted: releaseVerdict?.notStarted === true,
    },
    servingRelease: servingReleaseFor(deployment, jobs),
    connector: connectorStatus(releaseVerdict?.reason === 'EVIDENCE_MISSING', deployment, connectorUpdate),
    // Runtime-verified reachability is the gate for exposing an address:
    // READY's https URL always, and the temporary HTTP ALB endpoint once a
    // VERIFYING deployment's health status confirms the app is actually
    // serving. An appUrl that merely EXISTS (stack complete, health still
    // UNKNOWN) is never presented as a working address.
    result:
      stage === 'READY' && appUrl
        ? { url: appUrl }
        : stage === 'VERIFYING' && deployment.healthStatus === 'HEALTHY' && appUrl
          ? { url: appUrl }
          : null,
    failure:
      stage === 'FAILED'
        ? buildFailure(latestFailed, failureEntry!)
        : dayTwoFailure
          ? buildFailure(dayTwoFailure, failureEntryFor(dayTwoFailure.failureCode ?? null))
          : null,
  };
}

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

/**
 * The unauthenticated customer projection. Strips relay identity, job
 * detail, and the raw stack status (except the one word failure.technical
 * carries); components with no positive signal this late in the lifecycle
 * are dropped rather than shown as a stalled-looking PENDING step (see
 * statusFromMerged) — https is exempt because its own PENDING IS the
 * positive signal ("domain setup is next").
 *
 * `live` is the optional live-provisioning projection from apps/api/src/
 * customer-activity.ts (buildCustomerLiveProgress) — a read-time-only
 * addition layered on top of the same `derived` object, never a new input to
 * the stage/step/failure derivation above. Omitted, the output is byte-for-
 * byte what this function has always returned (the web app and the API
 * deploy separately, so callers must keep working without it).
 */
export function toCustomerDeploymentStatus(
  derived: DerivedDeploymentStatus,
  live?: {
    currentActivity?: string;
    recentActivity: CustomerDeploymentStatus['recentActivity'];
    provisioningIssue: CustomerDeploymentStatus['provisioningIssue'];
    cleanup: CustomerDeploymentStatus['cleanup'];
    technicalDetails: CustomerDeploymentStatus['technicalDetails'];
  },
): CustomerDeploymentStatus {
  const noSignalStages: DeploymentStage[] = ['VERIFYING', 'READY', 'FAILED'];
  const components = derived.components.filter((component) => {
    if (component.status === 'NOT_REQUIRED') return false;
    if (component.key === 'https') return true;
    return !(component.status === 'PENDING' && noSignalStages.includes(derived.stage));
  });

  return {
    stage: derived.stage,
    updatedAt: derived.updatedAt,
    currentActivity: live?.currentActivity ?? derived.currentActivity,
    step: derived.step,
    steps: derived.steps,
    typicalDurationSeconds: derived.typicalDurationSeconds,
    takingLongerThanUsual: derived.takingLongerThanUsual,
    removed: derived.removed !== undefined,
    statusUpdatesUnavailable: derived.statusUpdatesUnavailable,
    needsDomainSetup: derived.needsDomainSetup,
    components,
    url: derived.result?.url ?? null,
    ...(live
      ? {
          stepStartedAt: derived.stepStartedAt,
          recentActivity: live.recentActivity,
          provisioningIssue: live.provisioningIssue,
          cleanup: live.cleanup,
          technicalDetails: live.technicalDetails,
        }
      : {}),
    failure: derived.failure
      ? {
          // §65: the raw §61 code never reaches the unauthenticated
          // customer surface — only the derived, jargon-free fact that the
          // application's own startup/config work is what failed.
          ownedByApplication:
            derived.failure.code !== null && APP_OWNED_STARTUP_FAILURE_CODES.has(derived.failure.code),
          // §61 USER_ACTION failures that are not the application's own
          // startup work need a change in the customer's AWS account or
          // inputs before a retry can succeed — the page then shows an
          // actionable next step instead of the default "no action" copy.
          customerActionRequired:
            derived.failure.code !== null &&
            !APP_OWNED_STARTUP_FAILURE_CODES.has(derived.failure.code) &&
            failureRecoverability(derived.failure.code) === 'USER_ACTION',
          customerMessage: derived.failure.customerMessage,
          component: derived.failure.component,
          reference: derived.failure.reference,
          technical: {
            // "Which stage of the pipeline failed" (INSTALL, DEPLOY_RELEASE,
            // ...) — a job type, not an AWS service name, so it stays inside
            // §65's rules while still being useful to a customer's own ops
            // team relaying this to a vendor's support. The FAILED job's own
            // type, not the latest job's — a later health/preflight job must
            // not relabel the failure.
            stage: derived.failure.jobType ?? 'UNKNOWN',
            component: derived.failure.component,
            // §65: never the raw CloudFormation status in the customer
            // projection's own fields — a jargon-free phrase instead. The
            // vendor projection keeps the raw status. The customer page's
            // collapsed "View raw AWS events" disclosure is the one deliberate
            // exception (docs/decisions/README.md).
            awsStatus: derived.failure.awsStatus
              ? customerStackStatusLabel(derived.failure.awsStatus)
              : null,
          },
        }
      : null,
  };
}

/** The authenticated vendor projection — full operational detail. */
export function toVendorDeploymentStatus(
  derived: DerivedDeploymentStatus,
): VendorDeploymentStatus & Pick<DerivedDeploymentStatus, 'servingRelease' | 'connector'> {
  return {
    stage: derived.stage,
    updatedAt: derived.updatedAt,
    currentActivity: derived.currentActivity,
    step: derived.step,
    steps: derived.steps,
    typicalDurationSeconds: derived.typicalDurationSeconds,
    takingLongerThanUsual: derived.takingLongerThanUsual,
    stepStartedAt: derived.stepStartedAt,
    stepTimings: derived.stepTimings,
    statusUpdatesUnavailable: derived.statusUpdatesUnavailable,
    needsDomainSetup: derived.needsDomainSetup,
    components: derived.components,
    relay: derived.relay,
    job: derived.job,
    aws: derived.aws,
    health: derived.health,
    servingRelease: derived.servingRelease,
    connector: derived.connector,
    url: derived.result?.url ?? null,
    failure: derived.failure
      ? {
          code: derived.failure.code,
          component: derived.failure.component,
          reference: derived.failure.reference,
          message: derived.failure.vendorMessage,
          awsStatus: derived.failure.awsStatus,
        }
      : null,
  };
}
