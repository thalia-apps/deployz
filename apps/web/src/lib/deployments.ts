import type { DeploymentPlan, InfrastructureSizeTier, VendorDeploymentStatus } from '@deployz/contracts';

import type { DeploymentState } from './deployment-vocabulary';
import type { CustomDomainStatus } from './domains';

// Fleet-surface data access. Wired to the real `/api/deployments` endpoints.
// No fixture fallback: a 404/error is a real failure, not a loading state
// (an empty list is the genuine empty state, handled by the caller). §46
// vocabulary only — no raw AWS/CFN/ECS terms at the top level (M14:
// deployment health only).

import { apiRequest, ApiRequestError, errorMessage, readSignal } from '@/lib/api-client';
import type { SubscriptionStatus } from '@/lib/organization-vocabulary';
import { apiUrl } from '@/lib/api-url';

// ── Wire shapes ────────────────────────────────────────────────────────────

export type RelayStatus = 'CONNECTED' | 'DISCONNECTED' | 'UNKNOWN';
export type HealthStatus = 'UNKNOWN' | 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY';
export type DeploymentType = 'TEST' | 'PRODUCTION';
export type DeploymentBillingState = 'NOT_STARTED' | 'ACTIVE' | 'STOPPED';
/** A required component the verifier found no AWS resource for. */
export type ComponentState = HealthStatus | 'NOT_PROVISIONED';

/** What the installed relay can execute. Null = relay never reported
 *  capabilities (pre-capability build) — the UI treats that as nothing
 *  supported. */
export interface RelayCapabilities {
  deployRelease: boolean;
  rollback: boolean;
  restart: boolean;
  configUpdate: boolean;
  destroy: boolean;
  domainManagement: boolean;
}

/** §24 the components a relay reports on. Absent = not required. */
export interface HealthComponents {
  application?: ComponentState;
  database?: ComponentState;
  storage?: ComponentState;
  loadBalancer?: ComponentState;
  /** Present only when the application requires a managed Redis cache. */
  redis?: ComponentState;
}

/**
 * A deployment row exactly as `GET /api/deployments` returns it: the raw
 * `deployments` table columns (§38) plus the joined display fields the UI
 * needs (§23/§24) — customer/application name and current version. The AWS
 * account id arrives already masked by the API.
 */
export interface FleetDeployment {
  id: string;
  customerId: string;
  applicationId: string;
  organizationId: string;
  region: string;
  state: DeploymentState;
  awsAccountId: string | null;
  currentReleaseId: string | null;
  previousReleaseId: string | null;
  relayStatus: RelayStatus;
  healthStatus: HealthStatus;
  /** Per-component health as last reported. Null until the relay reports. */
  components: HealthComponents | null;
  /** The public install link id — never the relay's installation id. */
  installLinkId: string;
  /** When the install link stops starting new installs; null = no limit. */
  installLinkExpiresAt: string | null;
  desiredState: Record<string, unknown>;
  observedState: Record<string, unknown> | null;
  infraVersion: string;
  installationId: string;
  deploymentType: DeploymentType;
  billingState: DeploymentBillingState;
  billingStartedAt: string | null;
  billingStoppedAt: string | null;
  lastHealthAt: string | null;
  deletedAt: string | null;
  /** What the control plane knows about AWS leftovers at disconnect. */
  cleanupState: 'SKIPPED_RELAY_OFFLINE' | 'PURGE_FAILED' | 'COMPLETE' | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  updatedBy: string | null;
  customerName: string;
  applicationName: string;
  /** Current release version, or null if no release has been deployed yet. */
  version: string | null;
  /** Version of the installed relay, once it has reported it. */
  relayVersion: string | null;
  /** Version of the customer's bootstrap stack, once the relay reported it. */
  bootstrapVersion: string | null;
  /** Capabilities advertised by the installed relay; null = unknown. */
  relayCapabilities: RelayCapabilities | null;
  /** Digest the relay last observed running in ECS; null = not observed. */
  runningImageDigest: string | null;
  /** Install-attempt counter; bumped by each retry. */
  attemptNumber: number;
  /** The expected bootstrap stack name once an attempt has launched. */
  bootstrapStackName: string | null;
  /** When the customer launched the current install attempt. */
  installStartedAt: string | null;
  /** The read-time derived stage/progress projection (vendor detail) — the
   *  single source both fleet surfaces render "where is this deployment
   *  right now" from, so the list and detail pages can never disagree. */
  deploymentStatus: VendorDeploymentStatus;
}

/** A §39 deployment job, as returned in the deployment-detail `jobs` array. */
export interface DeploymentJob {
  id: string;
  deploymentId: string;
  type: string;
  state: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  requestedBy: string | null;
  failureCode: string | null;
  createdAt: string;
  startedAt: string | null;
  /** Last progress signal (relay acknowledgement, heartbeat, result). */
  lastProgressAt: string | null;
  finishedAt: string | null;
}

/** `GET /api/deployments/:id` — the fleet row plus its job history. */
export interface FleetDeploymentDetail extends FleetDeployment {
  jobs: DeploymentJob[];
  /** Compact custom-domain summary for the detail page, or null if none is attached. */
  customDomain: { hostname: string; status: CustomDomainStatus } | null;
  /** The deployment's public application URL, or null if it has none yet. */
  appUrl: string | null;
  /** The permanent Deployz address (`https://d-<id>…`) once the default-HTTPS
   *  state exists (any status), else null. Canonical from the moment the
   *  machine starts; whether it serves is `appUrl`'s job. Null when the
   *  machine has not started — a stale cached payload can fall back to the
   *  client-side projection. */
  defaultUrl: string | null;
  /** The size frozen at creation. Absent on payloads cached before the field existed. */
  size?: { id: string; label: string; profileKey: string } | null;
}

// ── Infrastructure inventory (Lane 3 composed component view) ───────────────

export type InfrastructureComponentKind =
  | 'application'
  | 'database'
  | 'storage'
  | 'cache'
  | 'endpoint'
  | 'network'
  | 'monitoring'
  | 'container_registry'
  | 'other';

export type InfrastructureComponentStatus =
  | 'pending'
  | 'provisioning'
  | 'ready'
  | 'updating'
  | 'deleting'
  | 'failed'
  | 'retained'
  | 'removed'
  | 'unknown';

export type InfrastructureLifecycle = 'delete' | 'retain' | 'snapshot' | 'conditional';

/** The truthful HTTPS provisioning state for the `endpoint` component, when
 *  the API applied it. Present only on `endpoint` and only when the API
 *  applied the HTTPS truth — older responses and E2E fixtures omit it. */
export type InfrastructureHttpsState =
  | 'SETTING_UP'
  | 'WAITING_FOR_CERTIFICATE'
  | 'ACTIVATING'
  | 'READY'
  | 'FAILED'
  | 'REMOVING';

export type InfrastructureConnectionState = 'connected' | 'disconnected';
export type InfrastructureSnapshotState = 'fresh' | 'stale' | 'none';

export type InfrastructureSummaryStatus =
  | 'healthy'
  | 'provisioning'
  | 'updating'
  | 'degraded'
  | 'failed'
  | 'deleting'
  | 'retained'
  | 'unknown';

export interface InfrastructureResource {
  logicalId: string;
  physicalId: string | null;
  type: string;
  status: string;
  statusReason: string | null;
}

export interface InfrastructureComponent {
  kind: InfrastructureComponentKind;
  name: string;
  purpose: string;
  status: InfrastructureComponentStatus;
  awsService: string;
  region: string;
  lifecycle: InfrastructureLifecycle;
  resources: InfrastructureResource[];
  /** Present only on the `endpoint` component, and only when the API
   *  applied the HTTPS truth. */
  httpsState?: InfrastructureHttpsState;
  /** The Deployz-owned HTTPS machine's own status, apart from a custom domain's. */
  defaultHttpsStatus?: string;
}

export interface InfrastructureSummary {
  status: InfrastructureSummaryStatus;
  componentCount: number;
  technicalResourceCount: number;
}

export interface InfrastructureDisconnectWarning {
  lastVerifiedAt: string;
}

/** One catalog kind's requirement-vs-inventory comparison (Phase 6). */
export interface InfrastructureExpectationComponent {
  kind: InfrastructureComponentKind;
  /** Whether this deployment's manifest requires the component. */
  expected: boolean;
  /** Whether the inventory has a non-removed component of this kind. */
  present: boolean;
}

/** The server-side comparison of what the stored manifest requires against
 *  what the inventory shows. Null when the deployment has no valid stored
 *  manifest to compare against. A report only, never an auto-repair. */
export interface InfrastructureExpectations {
  schemaVersion: 1;
  /** The five catalog kinds, in catalog order. */
  components: InfrastructureExpectationComponent[];
  /** expected && !present. */
  missing: InfrastructureComponentKind[];
  /** !expected && present among the five catalog kinds. */
  unexpected: InfrastructureComponentKind[];
}

export interface InfrastructureResponse {
  provider: 'aws';
  region: string;
  stackStatus: string | null;
  connectionState: InfrastructureConnectionState;
  snapshotState: InfrastructureSnapshotState;
  summary: InfrastructureSummary;
  components: InfrastructureComponent[];
  lastUpdatedAt: string | null;
  disconnectWarning: InfrastructureDisconnectWarning | null;
  expectations: InfrastructureExpectations | null;
}

/** A single §40 activity-feed event. */
export interface ActivityEvent {
  occurredAt: string;
  eventType: string;
  actorType: string;
  result: string | null;
  previousState: string | null;
  requestedState: string | null;
  payload: Record<string, unknown>;
}

// ── Fetch helpers ──────────────────────────────────────────────────────────

/** A failed deployment fetch that knows WHICH HTTP status failed. */
export class DeploymentRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'DeploymentRequestError';
  }
}

/** True when the error is a 404 — the deployment doesn't exist or is hidden
 *  from this caller, which is a different screen from a transient failure. */
export function isDeploymentNotFound(error: unknown): boolean {
  return error instanceof DeploymentRequestError && error.status === 404;
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    credentials: 'include',
    cache: 'no-store',
    signal: readSignal(),
  });
  if (!response.ok) {
    throw new DeploymentRequestError(`Deployments request failed (${response.status})`, response.status);
  }
  return (await response.json()) as T;
}

/** Fetch the fleet's deployments (§23). */
export async function fetchDeployments(
  options: { includeDeleted?: boolean } = {},
): Promise<FleetDeployment[]> {
  // The API leaves DELETED deployments out of the fleet by default (§63);
  // the list opts back in so removed deployments with retained resources
  // stay reachable for purge (CANARY-012).
  const body = await getJson<{ deployments?: FleetDeployment[] }>(
    options.includeDeleted ? '/api/deployments?includeDeleted=true' : '/api/deployments',
  );
  return body.deployments ?? [];
}

/** Fetch one application's deployments (used to check for a test deployment, §25 bulk deploy). */
export async function fetchDeploymentsForApplication(
  applicationId: string,
): Promise<FleetDeployment[]> {
  const body = await getJson<{ deployments?: FleetDeployment[] }>(
    `/api/deployments?applicationId=${encodeURIComponent(applicationId)}`,
  );
  return body.deployments ?? [];
}

/** Fetch one customer's deployments, keyed by the immutable customer id.
 *  Removed ones are included so the customer page can still say what happened. */
export async function fetchDeploymentsForCustomer(
  customerId: string,
): Promise<FleetDeployment[]> {
  const body = await getJson<{ deployments?: FleetDeployment[] }>(
    `/api/deployments?customerId=${encodeURIComponent(customerId)}&includeDeleted=true`,
  );
  return body.deployments ?? [];
}

/** Fetch one deployment detail (§24). */
export function fetchDeployment(id: string): Promise<FleetDeploymentDetail> {
  return getJson<FleetDeploymentDetail>(`/api/deployments/${encodeURIComponent(id)}`);
}

/** Fetch the composed infrastructure inventory for a deployment (Lane 3). */
export function fetchDeploymentInfrastructure(id: string): Promise<InfrastructureResponse> {
  return getJson<InfrastructureResponse>(`/api/deployments/${encodeURIComponent(id)}/infrastructure`);
}

/**
 * Fetch the deterministic plan for one action on this deployment (Phase 4).
 * Plan-driven surfaces (the disconnect and deploy-update dialogs) render
 * this instead of deriving infrastructure intent themselves.
 */
export function fetchDeploymentPlan(
  id: string,
  action: 'install' | 'update' | 'destroy',
): Promise<DeploymentPlan> {
  return getJson<DeploymentPlan>(`/api/deployments/${encodeURIComponent(id)}/plan?action=${action}`);
}

/** Fetch a deployment's activity feed (§40). */
export async function fetchDeploymentEvents(id: string): Promise<ActivityEvent[]> {
  const body = await getJson<{ events?: ActivityEvent[] }>(
    `/api/deployments/${encodeURIComponent(id)}/events`,
  );
  return body.events ?? [];
}

// ── Action triggers (§24, §25, §27, §63) ────────────────────────────────────

/** A failed action that knows WHICH status and error code came back. */
export class DeploymentActionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`Deployment action failed (${status})`);
    this.name = 'DeploymentActionError';
  }
}

/**
 * User-facing message for a failed action. A DEPLOYMENT_BUSY 409 is not a
 * transient fault — "try again in a moment" sent people into a retry loop
 * against the busy gate; say what is actually happening instead.
 */
export function actionErrorMessage(caught: unknown, fallback: string): string {
  // No answer from the API (network failure): the request may still have
  // been received, so do not invite a blind retry. The page refreshes the
  // deployment and shows the real outcome.
  if (caught instanceof TypeError || caught instanceof DOMException) {
    return "We couldn't confirm that this request was received. Check the deployment status before you try again.";
  }
  if (caught instanceof DeploymentActionError && caught.code === 'DEPLOYMENT_BUSY') {
    return 'Another operation is already running on this deployment. Wait for it to finish, then try again.';
  }
  if (caught instanceof DeploymentActionError && caught.code === 'RELEASE_UNAVAILABLE') {
    return 'This version can no longer be deployed because its build is no longer available. Create a new release to deploy it again.';
  }
  if (caught instanceof DeploymentActionError && caught.code === 'RELEASE_NOT_PUBLISHED') {
    return 'This application has no built release yet. Build a release on the Releases page, then try again.';
  }
  if (
    caught instanceof DeploymentActionError &&
    (caught.code === 'RELAY_DISCONNECTED' || caught.code === 'RELAY_NOT_CONNECTED')
  ) {
    return "Deployz can't reach this deployment's connector. Ask the customer to reconnect it, then try again.";
  }
  if (caught instanceof DeploymentActionError && caught.code === 'INFRASTRUCTURE_CHANGE_REQUIRED') {
    return "This application's infrastructure changed (database, cache, database engine, workers, queues or schedules), and an existing deployment cannot get these changes. Create a new deployment for this customer, or change the requirements back.";
  }
  return fallback;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    const envelope = payload as { error?: { code?: string } } | null;
    throw new DeploymentActionError(response.status, envelope?.error?.code ?? 'REQUEST_FAILED');
  }
  return (await response.json()) as T;
}

export interface JobResult {
  jobId: string;
  state: string;
}

/** §24 "Deploy Update" — POST /api/deployments/:id/deploy. */
export function deployRelease(deploymentId: string, releaseId: string): Promise<JobResult> {
  return postJson<JobResult>(`/api/deployments/${encodeURIComponent(deploymentId)}/deploy`, {
    releaseId,
  });
}

/** §24/§27 "Rollback" — POST /api/deployments/:id/rollback. */
export function rollbackDeployment(deploymentId: string, releaseId: string): Promise<JobResult> {
  return postJson<JobResult>(`/api/deployments/${encodeURIComponent(deploymentId)}/rollback`, {
    releaseId,
  });
}

/** §24 "Restart application" — POST /api/deployments/:id/restart. */
export function restartDeployment(deploymentId: string): Promise<JobResult> {
  return postJson<JobResult>(`/api/deployments/${encodeURIComponent(deploymentId)}/restart`, {});
}

/**
 * Recovery for a failed FIRST install — POST /api/deployments/:id/retry-install.
 * The relay is authorized to clean up the failed stack and its orphaned
 * blockers before recreating; refused once any install has succeeded.
 */
export function retryInstall(deploymentId: string): Promise<JobResult> {
  return postJson<JobResult>(
    `/api/deployments/${encodeURIComponent(deploymentId)}/retry-install`,
    {},
  );
}

/** §24/§63 "Disconnect Deployment" — POST /api/deployments/:id/destroy. */
export function destroyDeployment(
  deploymentId: string,
  finalSnapshot?: boolean,
): Promise<JobResult> {
  return postJson<JobResult>(`/api/deployments/${encodeURIComponent(deploymentId)}/destroy`, {
    finalSnapshot: finalSnapshot ?? false,
  });
}

/**
 * Mirrors DESTROY_PENDING_STALE_AFTER_MS in @deployz/contracts — the API's
 * force-complete gate enforces the same value. The web app mirrors wire
 * constants locally rather than importing the contracts package (the web
 * image stages no workspace packages beyond copy-map).
 */
export const DESTROY_PENDING_STALE_AFTER_MS = 60 * 60 * 1000;

export interface ForceCompleteResult {
  state: string;
  cleanupState: string;
}

/**
 * Settle a disconnect whose relay went offline mid-delete. Control-plane
 * only: the API refuses it unless the DESTROY has been pending past
 * DESTROY_PENDING_STALE_AFTER_MS on a relay the sweep confirmed offline, and
 * the deployment keeps the "resources may remain" warning afterwards.
 */
export function forceCompleteDisconnect(
  deploymentId: string,
): Promise<ForceCompleteResult> {
  return postJson<ForceCompleteResult>(
    `/api/deployments/${encodeURIComponent(deploymentId)}/disconnect/force-complete`,
    {},
  );
}

/** §24 "Retry HTTPS setup" — POST /api/deployments/:id/default-https/retry. */
export function retryDefaultHttps(deploymentId: string): Promise<{ status: 'retrying' }> {
  return postJson<{ status: 'retrying' }>(
    `/api/deployments/${encodeURIComponent(deploymentId)}/default-https/retry`,
    {},
  );
}

/**
 * P2 "Permanently remove retained AWS resources" — POST
 * /api/deployments/:id/purge. Eligible only for a DELETED deployment whose
 * cleanup is not COMPLETE; the relay re-verifies ownership of every
 * resource before deleting it, and a successful purge clears the
 * retained-resources warning.
 */
export function purgeDeployment(deploymentId: string): Promise<JobResult> {
  return postJson<JobResult>(`/api/deployments/${encodeURIComponent(deploymentId)}/purge`, {});
}

/**
 * §14 clear the relay binding and mint a fresh enrollment code.
 *
 * The recovery path when a customer has to install again: the binding is
 * single-use, so something has to be able to clear it, and that something is
 * a deliberate vendor action rather than anyone who has the link.
 */
export function resetRelay(deploymentId: string): Promise<{ installLinkId: string }> {
  return postJson<{ installLinkId: string }>(
    `/api/deployments/${encodeURIComponent(deploymentId)}/relay/reset`,
    {},
  );
}

// ── Create installation (§12, §41 screen 12) ─────────────────────────

export interface CreateCustomerInput {
  name: string;
  email: string;
  company?: string | null;
  externalReference?: string | null;
}

export interface CustomerRecord {
  id: string;
  organizationId: string;
  name: string;
  email: string;
  company: string | null;
  externalReference: string | null;
  createdAt: string;
}

/** §37 create customer — POST /api/customers. Routed through `apiRequest`
 *  (not `postJson`) so a failure carries the server's message (§65) rather
 *  than just a status/code. */
export function createCustomerRecord(input: CreateCustomerInput): Promise<CustomerRecord> {
  return apiRequest<CustomerRecord>('/api/customers', {
    method: 'POST',
    body: {
      name: input.name,
      email: input.email,
      company: input.company ?? null,
      externalReference: input.externalReference ?? null,
    },
  });
}

/** A customer already created by an earlier failed create-deployment
 *  attempt (§12 screen 12) — kept so a retry can reuse it instead of
 *  inserting a duplicate customer row (CANARY-004). */
export interface RememberedCustomer {
  id: string;
  name: string;
  email: string;
}

/** True when `remembered` was created for the same trimmed name/email the
 *  form now carries, so the retry should reuse its id rather than calling
 *  `createCustomerRecord` again. */
export function matchesRememberedCustomer(
  remembered: RememberedCustomer | null,
  name: string,
  email: string,
): remembered is RememberedCustomer {
  return remembered !== null && remembered.name === name && remembered.email === email;
}

export interface CreateDeploymentInput {
  applicationId: string;
  customerId: string;
  region: string;
  deploymentType?: DeploymentType;
  sizeProfile?: InfrastructureSizeTier;
}

/** The raw `deployments` insert result — no joined display fields (unlike FleetDeployment). */
export interface DeploymentRecord {
  id: string;
  customerId: string;
  applicationId: string;
  organizationId: string;
  region: string;
  state: DeploymentState;
  /** The public install link id. The relay's own id is minted in the customer's account. */
  installLinkId: string;
  deploymentType: DeploymentType;
  createdAt: string;
}

/** §12/§38 create deployment — POST /api/deployments. Stays NOT_INSTALLED
 * until the customer approves the AWS CloudFormation stack and the relay
 * first registers. Routed through `apiRequest` so a readiness rejection
 * (e.g. MANIFEST_NOT_COMPATIBLE) surfaces its real message instead of a
 * generic one. */
export function createDeploymentRecord(input: CreateDeploymentInput): Promise<DeploymentRecord> {
  return apiRequest<DeploymentRecord>('/api/deployments', {
    method: 'POST',
    body: {
      applicationId: input.applicationId,
      customerId: input.customerId,
      region: input.region,
      deploymentType: input.deploymentType ?? 'PRODUCTION',
      ...(input.sizeProfile ? { sizeProfile: input.sizeProfile } : {}),
    },
  });
}

/**
 * The blocking findings a readiness rejection (MANIFEST_NOT_COMPATIBLE /
 * MANIFEST_NEEDS_CONFIGURATION) carries in its `details`. The creation gate
 * evaluates the manifest with this customer's configuration, so it can name
 * a gap — a required variable with no value yet — that the application's
 * readiness page, which has no customer, does not show. Without these lines
 * the vendor is sent to a page that says "Ready to deploy".
 */
export function readinessFindingMessages(details: unknown): string[] {
  const findings = (details as { findings?: unknown } | null)?.findings;
  if (!Array.isArray(findings)) return [];
  return findings.flatMap((finding) => {
    const entry = finding as { severity?: unknown; message?: unknown };
    return entry.severity === 'error' && typeof entry.message === 'string' ? [entry.message] : [];
  });
}

/**
 * The message for a failed create-deployment attempt (Paddle migration
 * Phase 7 — free evaluation entitlements). `SUBSCRIPTION_REQUIRED` and
 * `TEST_DEPLOYMENT_EXISTS` get vendor-facing copy this phase owns; every
 * other error keeps the server's own message (already jargon-free, §65).
 * Phase 8: the subscription message introduces the checkout card the
 * creation screen shows next to it.
 */
export function createDeploymentErrorMessage(caught: unknown): string {
  if (caught instanceof ApiRequestError) {
    if (caught.code === 'SUBSCRIPTION_REQUIRED') {
      // Phase 13: the next step depends on WHY there is no active
      // subscription — buying again is only right when there is nothing to
      // fix. The creation screen shows the matching action below this line.
      switch (blockedSubscriptionStatus(caught)) {
        case 'PAST_DUE':
          return 'Your last payment did not go through. Update your payment details to add this customer deployment.';
        case 'PAUSED':
          return 'Your subscription is paused. Resume it to add this customer deployment.';
        case 'CANCELED':
          return 'Your subscription has ended. Start a new one to add this customer deployment.';
        default:
          return 'This is your first customer deployment, so it starts your subscription. Continue to checkout below.';
      }
    }
    if (caught.code === 'TEST_DEPLOYMENT_EXISTS') {
      return 'This application already has a test deployment.';
    }
  }
  return errorMessage(caught);
}

/**
 * The subscription status a `SUBSCRIPTION_REQUIRED` 402 carries in its
 * details (Phase 7 puts it there) — `null` for evaluation, and null for any
 * other error, so callers can branch without re-checking the code.
 */
export function blockedSubscriptionStatus(caught: unknown): SubscriptionStatus | null {
  if (!(caught instanceof ApiRequestError) || caught.code !== 'SUBSCRIPTION_REQUIRED') return null;
  const status = (caught.details as { subscriptionStatus?: unknown } | null)?.subscriptionStatus;
  return status === 'PAST_DUE' || status === 'PAUSED' || status === 'CANCELED' || status === 'ACTIVE'
    ? status
    : null;
}

/**
 * The existing TEST deployment's id from a `TEST_DEPLOYMENT_EXISTS` 409's
 * details, so the error can link to it — null for any other error, or when
 * the server did not send one.
 */
export function existingTestDeploymentId(caught: unknown): string | null {
  if (!(caught instanceof ApiRequestError) || caught.code !== 'TEST_DEPLOYMENT_EXISTS') {
    return null;
  }
  const deploymentId = (caught.details as { deploymentId?: unknown } | null)?.deploymentId;
  return typeof deploymentId === 'string' ? deploymentId : null;
}
