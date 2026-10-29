import * as schema from '@deployz/db/schema';

import { mergeComponentState } from './deployment-status.js';
import type { CustomDomainRow } from './domains.js';
import { deriveHealthStatus } from './relay-liveness.js';

// Extracted from server.ts (§23/§24 fleet row + app-url resolution) so both
// the vendor fleet/deployment-detail routes and Team Admin's cross-tenant
// deployment queries (apps/api/src/admin/queries.ts) can compose the exact
// same view without admin code importing server.ts (which would create a
// registration cycle: server.ts registers the admin routes).

export type DeploymentRow = typeof schema.deployments.$inferSelect;
export type DeploymentJobRow = typeof schema.deploymentJobs.$inferSelect;

// Relay enrollment material never crosses into a dashboard response: the
// enrollment code re-opens enrollment, the relay credential authenticates the
// relay and the token hash is a credential.
export function withoutRelayMaterial(deployment: DeploymentRow) {
  const {
    enrollmentCode: _enrollmentCode,
    relayCredential: _relayCredential,
    relayTokenHash: _relayTokenHash,
    ...rest
  } = deployment;
  return rest;
}

// §24 AWS accounts are shown, never in full — the control plane still stores
// the real id, but nothing outside it should ever see more than a hint of it.
export function maskAwsAccountId(awsAccountId: string | null): string | null {
  if (!awsAccountId) return null;
  if (awsAccountId.length <= 4) return '•'.repeat(awsAccountId.length);
  return `${awsAccountId.slice(0, 4)}${'•'.repeat(awsAccountId.length - 4)}`;
}

// §23/§24 fleet row shape: the raw deployments row plus the display fields
// the UI needs (customer/application name, current version) that only exist
// via a join.
export function toFleetRow(row: {
  deployment: DeploymentRow;
  customerName: string;
  applicationName: string;
  version: string | null;
  /** Whether the application requires a managed database. */
  databaseRequired?: boolean | null;
  /** Whether the application requires object storage. */
  storageRequired?: boolean | null;
  /** Whether the application requires a managed Redis cache. */
  redisRequired?: boolean | null;
}) {
  // §28 liveness is the persisted column: the heartbeat writes CONNECTED,
  // the worker's scheduled sweep writes DISCONNECTED — every screen that
  // renders a deployment reads the same value with no per-read derivation
  // that could disagree with what the sweep last persisted.
  const relayStatus = row.deployment.relayStatus;
  // §24 per-component state, merged from the relay's heartbeat and
  // verification checks — shared with the deployment-status stage
  // derivation (apps/api/src/deployment-status.ts) so the two can never
  // disagree about a component's merged state.
  const componentView = mergeComponentState(row.deployment.observedState, row);
  return {
    ...withoutRelayMaterial(row.deployment),
    awsAccountId: maskAwsAccountId(row.deployment.awsAccountId),
    relayStatus,
    healthStatus: deriveHealthStatus(row.deployment.healthStatus, relayStatus),
    components: componentView,
    // The digest the relay last observed running in ECS, raw. Null when the
    // relay could not observe it — never a guess from the release pointer.
    runningImageDigest:
      (row.deployment.observedState as { runningImageDigest?: string | null } | null)
        ?.runningImageDigest ?? null,
    customerName: row.customerName,
    applicationName: row.applicationName,
    version: row.version,
  };
}

const ALB_ENDPOINT_PATTERN = /^(https?:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)*\.elb\.amazonaws\.com\/?$/i;

/** The hostname a completed INSTALL job's CDK output reports the ALB at. The
 *  relay reports it, so only an AWS load balancer hostname is accepted. */
export function albEndpointFromResult(result: DeploymentJobRow['result']): string | null {
  if (!result || typeof result !== 'object') return null;
  const output = (result as Record<string, unknown>).output;
  if (!output || typeof output !== 'object') return null;
  const outputs = (output as Record<string, unknown>).outputs;
  if (!outputs || typeof outputs !== 'object') return null;
  // The output key is CDK-generated from the application stack's construct
  // name (`Export<StackName>PublicEndpoint`), so a stack rename renames it —
  // as the Redis stack already did. Match the stable suffix instead of one
  // literal name.
  const key = Object.keys(outputs).find((k) => k.endsWith('PublicEndpoint'));
  const endpoint = key === undefined ? undefined : (outputs as Record<string, unknown>)[key];
  return typeof endpoint === 'string' && ALB_ENDPOINT_PATTERN.test(endpoint) ? endpoint : null;
}

/**
 * The deployment-detail page's first-class application URL — the plan's
 * precedence (Phase 7): a custom domain is preferred ONLY once it is ACTIVE
 * (ACTIVE requires a successful HTTPS probe, so it is healthy by
 * construction — no second health check here). Every other custom-domain
 * state (PENDING, WAITING_FOR_DNS, CONFIGURING, ERROR, removed) falls to the
 * Phase 11 default-HTTPS endpoint (Deployz-owned hostname) once that is
 * ACTIVE or CONFIGURING; otherwise the latest successful INSTALL job's ALB
 * endpoint; otherwise null. `jobs` must be ascending by createdAt.
 */
export function resolveAppUrl(
  jobs: ReadonlyArray<Pick<DeploymentJobRow, 'type' | 'state' | 'result'>>,
  domain: Pick<CustomDomainRow, 'hostname' | 'status'> | null,
  defaultHttps?: Pick<{ hostname: string; status: string }, 'hostname' | 'status'> | null,
): string | null {
  if (domain?.status === 'ACTIVE') {
    return `https://${domain.hostname}`;
  }
  if (defaultHttps?.status === 'ACTIVE' || defaultHttps?.status === 'CONFIGURING') {
    return `https://${defaultHttps.hostname}`;
  }
  const installs = jobs.filter(
    (j) => j.type === 'INSTALL' && (j.state === 'SUCCEEDED' || j.state === 'SUCCESS'),
  );
  const endpoint = albEndpointFromResult(installs[installs.length - 1]?.result ?? null);
  if (!endpoint) return null;
  return endpoint.startsWith('http://') || endpoint.startsWith('https://') ? endpoint : `http://${endpoint}`;
}

/**
 * The deployment's permanent Deployz address (Phase 9 completion): `https://`
 * + the default-HTTPS hostname whenever a default-HTTPS state exists — ANY
 * status, because the URL is canonical from the moment the machine starts;
 * whether it actually SERVES is `appUrl`'s job, never this field's. The
 * hostname comes from the stored state (single source of truth — parseDefaultHttps
 * requires it), so no hostname-minting helper is needed here. Null when the
 * machine has never started, so a view keeps its own projection as fallback.
 * Pure field derivation — it must never gate appUrl/url exposure.
 */
export function resolveDefaultUrl(defaultHttps: { hostname: string } | null | undefined): string | null {
  return defaultHttps?.hostname ? `https://${defaultHttps.hostname}` : null;
}
