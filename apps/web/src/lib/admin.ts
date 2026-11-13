// Team Admin data access — typed wrappers over `/api/admin/*`
// (docs/admin/team-admin.md, apps/api/src/admin/{routes,queries}.ts). Wire
// shapes here mirror the API's query results field-for-field; no fixture
// fallback, no client-side re-derivation of state the server already
// computed. §65: raw AWS/CFN detail stays in the fields explicitly named
// "technical"/"raw" below — pages must keep it behind a disclosure.

import type { JobState, JobType, VendorDeploymentStatus } from '@deployz/contracts';

import { apiRequest } from '@/lib/api-client';
import type { DeploymentState } from '@/lib/deployment-vocabulary';
import type {
  DeploymentType,
  HealthStatus,
  InfrastructureResponse,
  RelayCapabilities,
  RelayStatus,
} from '@/lib/deployments';
import type { OrgRole, SubscriptionStatus } from '@/lib/organization-vocabulary';
import type { ReleaseStatus } from '@/lib/releases';

// ── Shared wire shapes ───────────────────────────────────────────────────────

/** `deriveConnectionState` in apps/api/src/admin/queries.ts — the per-deployment
 *  AWS/relay connectivity ladder, distinct from the coarser vendor-level
 *  `VendorConnection` below. */
export type ConnectionState = 'CONNECTED' | 'DEGRADED' | 'DISCONNECTED' | 'BOOTSTRAP_INCOMPLETE' | 'UNKNOWN';

/** Vendor-list connection summary — the worst relay status across the
 *  vendor's non-NOT_INSTALLED/non-DELETED deployments, or NONE if it has none. */
export type VendorConnection = 'CONNECTED' | 'DISCONNECTED' | 'NONE' | 'UNKNOWN';

export interface AdminEventLogRow {
  id: number;
  occurredAt: string;
  actorType: string;
  actorId: string;
  organizationId: string;
  customerId: string | null;
  deploymentId: string | null;
  jobId: string | null;
  releaseId: string | null;
  eventType: string;
  previousState: string | null;
  requestedState: string | null;
  result: string | null;
  payload: Record<string, unknown>;
}

export interface AdminDeploymentSummary {
  id: string;
  organizationId: string;
  organizationName: string;
  applicationName: string;
  customerName: string;
  awsAccountId: string | null;
  region: string;
  version: string | null;
  state: DeploymentState;
  healthStatus: HealthStatus;
  relayStatus: RelayStatus;
  updatedAt: string;
}

export interface AdminJobListRow {
  id: string;
  deploymentId: string;
  organizationId: string;
  organizationName: string;
  customerName: string;
  applicationName: string;
  type: JobType;
  state: JobState;
  stuck: boolean;
  failureCode: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  retries: number | null;
  /** Redacted, truncated job-result error text. */
  errorDetail: string | null;
}

// ── Overview ────────────────────────────────────────────────────────────────

export type AdminOverviewDays = 7 | 30 | 90;

/** `pilotInsights` (apps/api/src/admin/queries.ts `PilotInsights`) — the
 *  MVP funnel read model over the trailing `days` window. Rates are 0..1;
 *  null means the window has too little data for the metric. */
export interface AdminPilotInsights {
  window: { days: AdminOverviewDays; from: string; to: string };
  funnel: {
    applicationsCreated: number;
    analysisCompleted: number;
    preflightPassed: number;
    awsLaunched: number;
    relayConnected: number;
    healthy: number;
  };
  quality: {
    installSuccessRate: number | null;
    retryRate: number | null;
    medianTimeToHealthyMs: number | null;
    p90TimeToHealthyMs: number | null;
    sampleSize: number;
  };
  failures: { code: string; count: number; affectedDeployments: number }[];
  deployLinks: {
    created: number;
    opened: number;
    launched: number;
    relayConnected: number;
    healthy: number;
  };
  support: {
    healthyWithoutSupport: number;
    requiredSupportIntervention: number;
    supportSessions: number;
  };
}

export interface AdminOverview {
  counts: {
    failedDeployments: number;
    unhealthyDeployments: number;
    stuckJobs: number;
    disconnectedRelays: number;
    inProgressDeployments: number;
  };
  recentFailures: AdminDeploymentSummary[];
  stuckJobs: AdminJobListRow[];
  disconnectedConnections: AdminDeploymentSummary[];
  pilotInsights: AdminPilotInsights;
}

export function fetchAdminOverview(days: AdminOverviewDays = 30): Promise<AdminOverview> {
  return apiRequest<AdminOverview>(`/api/admin/overview?days=${days}`);
}

// ── Vendors ─────────────────────────────────────────────────────────────────

export interface AdminVendorListRow {
  organizationId: string;
  name: string;
  slug: string;
  subscriptionStatus: SubscriptionStatus | null;
  createdAt: string;
  ownerEmail: string | null;
  ownerName: string | null;
  applicationCount: number;
  deploymentCount: number;
  connection: VendorConnection;
  hasFailedDeployment: boolean;
  lastActivityAt: string | null;
}

export type VendorListFilter = 'failed' | 'disconnected';

export async function fetchAdminVendors(params: {
  q?: string | undefined;
  filter?: VendorListFilter | undefined;
} = {}): Promise<AdminVendorListRow[]> {
  const query = new URLSearchParams();
  if (params.q) query.set('q', params.q);
  if (params.filter) query.set('filter', params.filter);
  const suffix = query.toString();
  const body = await apiRequest<{ vendors: AdminVendorListRow[] }>(
    `/api/admin/vendors${suffix ? `?${suffix}` : ''}`,
  );
  return body.vendors;
}

export interface AdminVendorApplication {
  id: string;
  name: string;
  repoFullName: string;
  analysisStatus: string;
  compatibilityStatus: string | null;
  latestRelease: { id: string; version: string; releaseStatus: ReleaseStatus } | null;
  deploymentCount: number;
}

export interface AdminVendorDeploymentRow {
  id: string;
  customerName: string;
  applicationName: string;
  version: string | null;
  region: string;
  state: DeploymentState;
  healthStatus: HealthStatus;
  relayStatus: RelayStatus;
  appUrl: string | null;
  domain: string | null;
  updatedAt: string;
}

export interface AdminVendorConnectionRow {
  deploymentId: string;
  customerName: string;
  awsAccountId: string | null;
  region: string;
  relayStatus: RelayStatus;
  lastHealthAt: string | null;
  relayVersion: string | null;
  bootstrapVersion: string | null;
  state: DeploymentState;
}

/** Paddle migration Phase 14 — the billing facts an admin needs at a glance. */
export interface AdminVendorBilling {
  /** PRODUCTION deployments whose billing_state is ACTIVE. */
  activeProductionDeployments: number;
  /** The admin-set pooled allowance (organization.included_production_deployments). */
  includedProductionDeployments: number;
  /** max(active - included, 0); Polar is told max(this, 1). */
  billableDeploymentQuantity: number;
  /** What Polar held after the last reconciliation that updated it; null when never pushed. */
  providerDeploymentQuantity: number | null;
  providerQuantityAsOf: string | null;
  /** Display run-rate ($49 + max(billable, 1) × $19); null while evaluating or canceled. */
  monthlyRateDollars: number | null;
  subscription: {
    providerSubscriptionId: string;
    currentPeriodEnd: string | null;
    lastReconciledAt: string | null;
  } | null;
  recentReconciliations: {
    id: string;
    expected: number;
    provider: number | null;
    action: string;
    status: 'SUCCEEDED' | 'FAILED' | 'SKIPPED';
    error: string | null;
    createdAt: string;
  }[];
}

export interface AdminVendorDetail {
  organization: { id: string; name: string; slug: string; subscriptionStatus: SubscriptionStatus | null; createdAt: string };
  billing: AdminVendorBilling;
  members: { userId: string; name: string; email: string; role: OrgRole }[];
  applications: AdminVendorApplication[];
  deployments: AdminVendorDeploymentRow[];
  connections: AdminVendorConnectionRow[];
  recentEvents: AdminEventLogRow[];
}

export function fetchAdminVendor(id: string): Promise<AdminVendorDetail> {
  return apiRequest<AdminVendorDetail>(`/api/admin/vendors/${encodeURIComponent(id)}`);
}

// ── Deployments ─────────────────────────────────────────────────────────────

export type DeploymentListFilter =
  | 'active'
  | 'failed'
  | 'unhealthy'
  | 'stuck'
  | 'deleting'
  | 'disconnected';

export interface AdminDeploymentListRow extends AdminDeploymentSummary {
  stuck: boolean;
}

export async function fetchAdminDeployments(params: {
  q?: string | undefined;
  filter?: DeploymentListFilter | undefined;
} = {}): Promise<AdminDeploymentListRow[]> {
  const query = new URLSearchParams();
  if (params.q) query.set('q', params.q);
  if (params.filter) query.set('filter', params.filter);
  const suffix = query.toString();
  const body = await apiRequest<{ deployments: AdminDeploymentListRow[] }>(
    `/api/admin/deployments${suffix ? `?${suffix}` : ''}`,
  );
  return body.deployments;
}

/** A §39 job row as it appears on the deployment detail's `jobs` array —
 *  the raw job row plus the admin-only `stuck`/`normalizedError`/`errorDetail`. */
export interface AdminDeploymentJob {
  id: string;
  deploymentId: string;
  type: JobType;
  state: JobState;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  requestedBy: string | null;
  failureCode: string | null;
  createdAt: string;
  startedAt: string | null;
  lastProgressAt: string | null;
  finishedAt: string | null;
  stuck: boolean;
  normalizedError: string | null;
  errorDetail: string | null;
}

export interface AdminReleaseHistoryEntry {
  id: string;
  type: JobType;
  state: JobState;
  createdAt: string;
  finishedAt: string | null;
  failureCode: string | null;
  release: { releaseId: string | null; version: string | null };
}

export interface AdminReleaseRow {
  id: string;
  applicationId: string;
  version: string;
  releaseStatus: 'BUILDING' | 'READY' | 'FAILED';
  failureReason: string | null;
  createdAt: string;
}

export interface AdminConnectionDiagnostics {
  awsAccountId: string | null;
  region: string;
  relayStatus: RelayStatus;
  lastHealthAt: string | null;
  relayVersion: string | null;
  bootstrapVersion: string | null;
  bootstrapStackName: string | null;
  installationId: string | null;
  attemptNumber: number;
  cleanupState: 'SKIPPED_RELAY_OFFLINE' | 'PURGE_FAILED' | 'COMPLETE' | 'CONFIRMED_BY_OWNER' | null;
  state: DeploymentState;
  /** True only when the relay is CONNECTED and its last heartbeat is fresh —
   *  the plain-language "can Deployz reach this account right now" signal. */
  communicationPossible: boolean;
}

export interface AdminVendorStackEvent {
  id: number;
  deploymentId: string;
  jobId: string | null;
  providerEventId: string;
  eventAt: string;
  logicalResourceId: string;
  resourceType: string;
  resourceStatus: string;
  resourceStatusReason: string | null;
}

/** `GET /api/admin/deployments/:id` — the fleet row (masked account id, merged
 *  component state, relay capabilities) plus the full command-center detail. */
export interface AdminDeploymentDetail {
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
  installLinkId: string;
  infraVersion: string;
  installationId: string | null;
  deploymentType: DeploymentType;
  lastHealthAt: string | null;
  deletedAt: string | null;
  cleanupState: 'SKIPPED_RELAY_OFFLINE' | 'PURGE_FAILED' | 'COMPLETE' | 'CONFIRMED_BY_OWNER' | null;
  createdAt: string;
  updatedAt: string;
  customerName: string;
  applicationName: string;
  version: string | null;
  relayVersion: string | null;
  bootstrapVersion: string | null;
  relayCapabilities: RelayCapabilities | null;
  attemptNumber: number;
  bootstrapStackName: string | null;
  installStartedAt: string | null;
  jobs: AdminDeploymentJob[];
  customDomain: { hostname: string; status: string } | null;
  appUrl: string | null;
  deploymentStatus: VendorDeploymentStatus;
  vendor: { organizationId: string; name: string };
  customer: { id: string; name: string; email: string };
  application: { id: string; name: string; repoFullName: string };
  releases: AdminReleaseRow[];
  releaseHistory: AdminReleaseHistoryEntry[];
  infrastructure: InfrastructureResponse;
  recentEvents: AdminEventLogRow[];
  recentStackEvents: AdminVendorStackEvent[];
  connection: AdminConnectionDiagnostics;
}

export function fetchAdminDeployment(id: string): Promise<AdminDeploymentDetail> {
  return apiRequest<AdminDeploymentDetail>(`/api/admin/deployments/${encodeURIComponent(id)}`);
}

/**
 * Mirrors RELAY_STALE_AFTER_MS in @deployz/contracts — apps/api/src/admin/
 * queries.ts's `deriveConnectionState` enforces the same window. The web app
 * mirrors wire constants locally rather than importing the contracts
 * package's runtime, matching deployment-vocabulary.ts's RELAY_STALE_AFTER_MS.
 */
export const ADMIN_RELAY_STALE_AFTER_MS = 15 * 60 * 1000;

/**
 * Client-side mirror of `deriveConnectionState` (apps/api/src/admin/
 * queries.ts) — the deployment-detail and connection-detail responses carry
 * the raw signals but not this derived label, so the diagnostics card
 * derives it the same way the connections list already did server-side.
 */
export function deriveConnectionState(
  connection: Pick<AdminConnectionDiagnostics, 'relayStatus' | 'lastHealthAt' | 'installationId' | 'state'>,
  now: number = Date.now(),
): ConnectionState {
  if (connection.relayStatus === 'DISCONNECTED') return 'DISCONNECTED';
  if (connection.relayStatus === 'CONNECTED') {
    const fresh =
      connection.lastHealthAt !== null && now - Date.parse(connection.lastHealthAt) <= ADMIN_RELAY_STALE_AFTER_MS;
    return fresh ? 'CONNECTED' : 'DEGRADED';
  }
  if (connection.installationId === null || connection.state === 'WAITING_FOR_RELAY') return 'BOOTSTRAP_INCOMPLETE';
  return 'UNKNOWN';
}

// ── Recovery actions (§ team-admin.md "Supported admin actions") ───────────
//
// Thin wrappers over the concurrently-shipped recovery endpoints. Each
// requires a human reason for risky operations and writes an `admin.*` audit
// event server-side; the web layer only submits and reports the result.

export interface AdminJobActionResult {
  jobId: string;
  state: string;
}

/** Phase 14 — runs the same reconciliation the safety job runs, on demand. */
export function reconcileVendorBillingAdmin(
  vendorId: string,
  reason?: string,
): Promise<{ status: 'SUCCEEDED' | 'FAILED' | 'SKIPPED'; action: string; expected: number; provider: number | null; reason?: string }> {
  return apiRequest(`/api/admin/vendors/${encodeURIComponent(vendorId)}/reconcile-billing`, {
    method: 'POST',
    body: reason ? { reason } : {},
  });
}

/** The result of updating a vendor's pooled "included production
 *  deployments" allowance — the allowance itself is always saved; the
 *  provider (Polar) side is best-effort and reported separately via
 *  `reconciliation`, which is null when there was nothing to reconcile
 *  (unchanged value, or no subscription). */
export interface AdminIncludedDeploymentsResult {
  organizationId: string;
  activeProductionDeployments: number;
  previous: { includedProductionDeployments: number; billableDeploymentQuantity: number };
  current: { includedProductionDeployments: number; billableDeploymentQuantity: number };
  changed: boolean;
  reconciliation: {
    status: 'SUCCEEDED' | 'FAILED' | 'SKIPPED';
    action: 'NONE' | 'QUANTITY_UPDATED' | 'ITEM_REMOVED' | 'ITEM_ADDED' | 'SKIPPED';
    active: number;
    included: number;
    expected: number;
    provider: number | null;
    reason?: string;
  } | null;
}

export function updateIncludedDeploymentsAdmin(
  vendorId: string,
  includedProductionDeployments: number,
  reason: string,
): Promise<AdminIncludedDeploymentsResult> {
  return apiRequest<AdminIncludedDeploymentsResult>(
    `/api/admin/vendors/${encodeURIComponent(vendorId)}/included-deployments`,
    { method: 'POST', body: { includedProductionDeployments, reason } },
  );
}

export function retryInstallAdmin(
  deploymentId: string,
  reason?: string,
): Promise<AdminJobActionResult> {
  return apiRequest<AdminJobActionResult>(
    `/api/admin/deployments/${encodeURIComponent(deploymentId)}/retry-install`,
    { method: 'POST', body: reason ? { reason } : {} },
  );
}

export function rollbackAdmin(
  deploymentId: string,
  releaseId: string,
  reason: string,
): Promise<AdminJobActionResult> {
  return apiRequest<AdminJobActionResult>(
    `/api/admin/deployments/${encodeURIComponent(deploymentId)}/rollback`,
    { method: 'POST', body: { releaseId, reason } },
  );
}

export function forceCompleteDestroyAdmin(deploymentId: string, reason: string): Promise<void> {
  return apiRequest<void>(
    `/api/admin/deployments/${encodeURIComponent(deploymentId)}/force-complete-destroy`,
    { method: 'POST', body: { reason } },
  );
}

export function relayResetAdmin(deploymentId: string, reason: string): Promise<void> {
  return apiRequest<void>(`/api/admin/deployments/${encodeURIComponent(deploymentId)}/relay-reset`, {
    method: 'POST',
    body: { reason },
  });
}

// ── Jobs ─────────────────────────────────────────────────────────────────────

export type JobListFilter = 'queued' | 'running' | 'failed' | 'stuck';

export async function fetchAdminJobs(params: {
  q?: string | undefined;
  filter?: JobListFilter | undefined;
} = {}): Promise<AdminJobListRow[]> {
  const query = new URLSearchParams();
  if (params.q) query.set('q', params.q);
  if (params.filter) query.set('filter', params.filter);
  const suffix = query.toString();
  const body = await apiRequest<{ jobs: AdminJobListRow[] }>(
    `/api/admin/jobs${suffix ? `?${suffix}` : ''}`,
  );
  return body.jobs;
}

export interface AdminJobTimelineEntry {
  at: string;
  type: 'job' | 'event';
  label: string;
  result?: string | null;
}

export interface AdminJobStackEvents {
  firstEventAt: string | null;
  lastEventAt: string | null;
  count: number;
  recent: AdminVendorStackEvent[];
}

export interface AdminJobDetail {
  id: string;
  deploymentId: string;
  type: JobType;
  state: JobState;
  stuck: boolean;
  failureCode: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  errorDetail: string | null;
  payload: unknown;
  vendor: { organizationId: string; name: string };
  customer: { id: string; name: string; email: string } | null;
  application: { id: string; name: string; repoFullName: string } | null;
  deployment: { id: string; state: DeploymentState; relayStatus: RelayStatus } | null;
  timeline: AdminJobTimelineEntry[];
  stackEvents: AdminJobStackEvents;
}

export function fetchAdminJob(id: string): Promise<AdminJobDetail> {
  return apiRequest<AdminJobDetail>(`/api/admin/jobs/${encodeURIComponent(id)}`);
}

// ── Connections ─────────────────────────────────────────────────────────────

export interface AdminConnectionListRow {
  deploymentId: string;
  organizationId: string;
  organizationName: string;
  customerName: string;
  awsAccountId: string | null;
  region: string;
  connectionState: ConnectionState;
  relayStatus: RelayStatus;
  lastHealthAt: string | null;
  relayVersion: string | null;
  bootstrapVersion: string | null;
  state: DeploymentState;
  /** Other live deployments sharing this AWS account (excludes this row). */
  accountDeploymentCount: number;
}

export async function fetchAdminConnections(params: {
  q?: string | undefined;
  filter?: ConnectionState | undefined;
} = {}): Promise<AdminConnectionListRow[]> {
  const query = new URLSearchParams();
  if (params.q) query.set('q', params.q);
  if (params.filter) query.set('filter', params.filter);
  const suffix = query.toString();
  const body = await apiRequest<{ connections: AdminConnectionListRow[] }>(
    `/api/admin/connections${suffix ? `?${suffix}` : ''}`,
  );
  return body.connections;
}

export interface AdminConnectionJobRow {
  id: string;
  type: JobType;
  state: JobState;
  stuck: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface AdminConnectionDetail {
  deployment: {
    id: string;
    organizationId: string;
    organizationName: string;
    customerName: string;
    applicationName: string;
    state: DeploymentState;
    healthStatus: HealthStatus;
  };
  connection: AdminConnectionDiagnostics;
  jobs: AdminConnectionJobRow[];
}

export function fetchAdminConnection(deploymentId: string): Promise<AdminConnectionDetail> {
  return apiRequest<AdminConnectionDetail>(
    `/api/admin/connections/${encodeURIComponent(deploymentId)}`,
  );
}

// ── Search ───────────────────────────────────────────────────────────────────

export interface AdminSearchResults {
  vendors: { id: string; name: string; slug: string }[];
  applications: { id: string; name: string; repoFullName: string; organizationId: string; organizationName: string }[];
  customers: { id: string; name: string; email: string; organizationId: string; organizationName: string }[];
  deployments: {
    id: string;
    organizationId: string;
    organizationName: string;
    applicationName: string;
    customerName: string;
    awsAccountId: string | null;
    state: DeploymentState;
  }[];
  jobs: { id: string; type: JobType; state: JobState; deploymentId: string; organizationId: string; organizationName: string }[];
}

export function fetchAdminSearch(q: string): Promise<AdminSearchResults> {
  return apiRequest<AdminSearchResults>(`/api/admin/search?q=${encodeURIComponent(q)}`);
}

export function adminSearchIsEmpty(results: AdminSearchResults): boolean {
  return (
    results.vendors.length === 0 &&
    results.applications.length === 0 &&
    results.customers.length === 0 &&
    results.deployments.length === 0 &&
    results.jobs.length === 0
  );
}

// ── Audit log ───────────────────────────────────────────────────────────────

export interface AdminAuditLogParams {
  actor?: string | undefined;
  action?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  before?: number | undefined;
}

export interface AdminAuditLogResult {
  events: AdminEventLogRow[];
  nextBefore: number | null;
}

export async function fetchAdminAuditLog(params: AdminAuditLogParams = {}): Promise<AdminAuditLogResult> {
  const query = new URLSearchParams();
  if (params.actor) query.set('actor', params.actor);
  if (params.action) query.set('action', params.action);
  if (params.from) query.set('from', params.from);
  if (params.to) query.set('to', params.to);
  if (params.before !== undefined) query.set('before', String(params.before));
  const suffix = query.toString();
  return apiRequest<AdminAuditLogResult>(`/api/admin/audit-log${suffix ? `?${suffix}` : ''}`);
}

// ── View as Vendor (support session) ────────────────────────────────────────

export interface SupportSessionResult {
  organizationId: string;
  organizationName: string;
}

export function startSupportSession(vendorId: string): Promise<SupportSessionResult> {
  return apiRequest<SupportSessionResult>(
    `/api/admin/vendors/${encodeURIComponent(vendorId)}/support-session`,
    { method: 'POST' },
  );
}

export function endSupportSession(): Promise<void> {
  return apiRequest<void>('/api/admin/support-session', { method: 'DELETE' });
}
