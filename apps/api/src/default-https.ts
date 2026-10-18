/**
 * Default-HTTPS state machine — Deployz-owned secure address for every
 * deployment (Phase 11). Reuses the relay's CONFIGURE_DOMAIN / REMOVE_DOMAIN
 * executors and job vocabulary (packages/relay/src/domain.ts) with a
 * Deployz-owned hostname (`d-<deploymentId>.deployz.dev`) whose DNS lives in a
 * Deployz-controlled zone: the CONTROL PLANE writes the ACM validation CNAME
 * and the ALB routing CNAME itself through the deployment-keyed Cloudflare
 * DNS client (apps/api/src/cloudflare-records.ts), so the customer never owns
 * or configures a domain.
 *
 * State is persisted in `deployments.default_https` — deliberately separate
 * from `custom_domains` (customer DNS). Statuses mirror the custom-domain
 * machine so the same relay outcomes drive it:
 *
 *   PENDING          a CONFIGURE_DOMAIN job is (or will be) requesting the cert
 *   WAITING_FOR_DNS  cert requested; validation + routing records written
 *   CONFIGURING      cert issued + 443 listener wired; HTTPS being probed
 *   ACTIVE           HTTPS verified reachable — the deployment's URL
 *   ERROR            last attempt failed; terminal — explicit vendor retry required
 *   REMOVING         destroy/remove in progress
 *
 * Driver cadence: the relay heartbeat (~5 min, the same existing background
 * cadence the custom-domain auto-check rides) plus one immediate kick after a
 * successful INSTALL result. All transitions are idempotent.
 *
 * The certificate is requested while the INSTALL is still running, so ACM
 * validation overlaps stack creation. Until the install settles, the relay
 * only requests and describes the certificate (it defers the 443 listener),
 * the control plane writes the validation CNAME as soon as it is known, and
 * the routing CNAME follows once the load balancer exists. Waiting for the
 * stack in that window consumes none of the configure budget below.
 */

import { and, desc, eq, inArray, isNull, like } from 'drizzle-orm';

import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import type { CloudflareDnsClient } from './cloudflare-records.js';
import type { HttpsProbeResult } from './domain-check.js';
import { createOrReuseJob } from './jobs.js';

// ── State shape ──────────────────────────────────────────────────────────────

export type DefaultHttpsStatus =
  | 'PENDING'
  | 'WAITING_FOR_DNS'
  | 'CONFIGURING'
  | 'ACTIVE'
  | 'ERROR'
  | 'REMOVING';

export interface DefaultHttpsState {
  /** The Deployz-owned hostname this deployment is issued for. */
  hostname: string;
  status: DefaultHttpsStatus;
  certificateArn?: string;
  validationName?: string;
  validationValue?: string;
  /** The ALB's DNS name the routing CNAME points at. */
  routingTarget?: string;
  checkCycle: number;
  lastError: string | null;
  /** ISO timestamp of the last DNS-reconciliation attempt (success or failure). */
  lastDnsCheckAt?: string;
  /** Phase 12 watchdog — configure attempts counted within the current
   *  budget: fresh configure cycles minted plus unavailable DNS-write
   *  failures since the last timeout/ERROR recovery. A rate-limited attempt
   *  is never counted (Cloudflare said stop; no progress was made). The
   *  budget is elapsed time: DEFAULT_HTTPS_CONFIGURE_BUDGET_MS after the
   *  first counted attempt (`configureStartedAt`) the machine times out to
   *  ERROR with DEFAULT_DNS_TIMEOUT. ERROR is terminal (DZ-AUDIT-008); the
   *  vendor retries explicitly via the retry route, which resets this to 0
   *  and so starts a new budget. Absent = 0. */
  configureAttempts?: number;
  /** ISO time the first attempt of the current budget was counted. */
  configureStartedAt?: string;
}

/**
 * Phase 2 default-hostname model — the deterministic `d-<id>.deployz.dev`
 * helpers. Pure and side-effect free: no DNS/provider I/O here, so these can
 * (and do) back the state machine, the URL resolver and mutation guards alike.
 *
 * A default hostname is `d-<deploymentId>.<zone>` where the deployment id is
 * normalized to lower-case and must be DNS-safe (`[a-z0-9-]+` — never
 * customer-controlled, so anything else is a programming error worth
 * throwing over). Production zone/prefix are the defaults; the optional
 * config override exists for tests and the E2E fixture namespace.
 */

/** The default HTTPS apex in production — a Deployz-registered domain. */
export const DEFAULT_HTTPS_APEX = 'deployz.dev';

/** The apex used under DNS fixture mode (E2E), mirroring
 *  createFixtureDomainCheckDeps's `.deployz-fixture.test` namespace. */
export const DEFAULT_HTTPS_FIXTURE_APEX = 'deployz-fixture.test';

export interface DefaultHostnameConfig {
  /** Hostname label prefix (default `d-`). */
  prefix?: string;
  /** Registrable zone the hostname is minted under (default `deployz.dev`). */
  zone?: string;
}

export const DEFAULT_HOSTNAME_PREFIX = 'd-';

const DNS_SAFE_ID = /^[a-z0-9-]+$/;

function normalizedDeploymentId(deploymentId: string): string {
  const normalized = deploymentId.toLowerCase();
  if (!DNS_SAFE_ID.test(normalized)) {
    throw new Error(`Invalid deployment id for a default hostname: ${JSON.stringify(deploymentId)}`);
  }
  return normalized;
}

/** The deterministic default hostname for a deployment: `d-<id>.deployz.dev`. */
export function getDefaultDeploymentHostname(
  deploymentId: string,
  config: DefaultHostnameConfig = {},
): string {
  const prefix = config.prefix ?? DEFAULT_HOSTNAME_PREFIX;
  const zone = config.zone ?? DEFAULT_HTTPS_APEX;
  return `${prefix}${normalizedDeploymentId(deploymentId)}.${zone}`;
}

/** The default HTTPS URL for a deployment: `https://d-<id>.deployz.dev`. */
export function getDefaultDeploymentUrl(deploymentId: string, config?: DefaultHostnameConfig): string {
  return `https://${getDefaultDeploymentHostname(deploymentId, config)}`;
}

/** Exact-match guard: true iff `hostname` equals the default hostname of some
 *  valid deployment id (case-insensitive; the zone/prefix must match). */
export function isDefaultDeploymentHostname(hostname: string, config: DefaultHostnameConfig = {}): boolean {
  const prefix = config.prefix ?? DEFAULT_HOSTNAME_PREFIX;
  const zone = config.zone ?? DEFAULT_HTTPS_APEX;
  const lower = hostname.toLowerCase();
  if (!lower.startsWith(prefix) || !lower.endsWith(`.${zone}`)) return false;
  const id = lower.slice(prefix.length, -(`.${zone}`.length));
  return DNS_SAFE_ID.test(id) && id.length > 0;
}

/** Hostnames the default-HTTPS mutation guard must never touch: they are the
 *  marketing site, the dashboard, and the control-plane hosts. */
export const RESERVED_DEFAULT_HOSTNAMES = [
  'deployz.dev',
  'app.deployz.dev',
  'www.deployz.dev',
  'api.deployz.dev',
  'admin.deployz.dev',
] as const;

/** Throws unless `hostname` is a mutable default hostname — i.e. it passes
 *  isDefaultDeploymentHostname AND is not a reserved Deployz hostname. Pure;
 *  call before any provider mutation. */
export function assertMutableDefaultHostname(
  hostname: string,
  config: DefaultHostnameConfig = {},
): void {
  if (!isDefaultDeploymentHostname(hostname, config)) {
    throw new Error(`Refusing to mutate ${JSON.stringify(hostname)}: not a default deployment hostname.`);
  }
  if (RESERVED_DEFAULT_HOSTNAMES.includes(hostname.toLowerCase() as (typeof RESERVED_DEFAULT_HOSTNAMES)[number])) {
    throw new Error(`Refusing to mutate ${JSON.stringify(hostname)}: reserved Deployz hostname.`);
  }
}

// Deployment ids are uuids (lowercased by the hostname model). Only names that
// carry a real uuid may ever be treated as owning a live deployment row.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The deployment id embedded in a default hostname (`d-<id>.<zone>`), or
 *  null when the name is not a well-formed `d-<uuid>.<zone>` hostname (wrong
 *  prefix/zone, a reserved or non-uuid id). Pure — the parse gate the purge
 *  orphan reconciliation deletes through: unparseable names are skipped,
 *  never deleted. */
export function parseDefaultDeploymentId(
  hostname: string,
  config: DefaultHostnameConfig = {},
): string | null {
  const prefix = config.prefix ?? DEFAULT_HOSTNAME_PREFIX;
  const zone = config.zone ?? DEFAULT_HTTPS_APEX;
  const lower = hostname.toLowerCase();
  if (!lower.startsWith(prefix) || !lower.endsWith(`.${zone}`)) return null;
  const id = lower.slice(prefix.length, -(`.${zone}`.length));
  return UUID_RE.test(id) ? id : null;
}

/** The candidate URLs a deployment can serve, resolved by the plan's
 *  precedence (Phase 7 wires this into resolveAppUrl's replacement). */
export interface DefaultUrls {
  /** The permanent default-HTTPS URL (`https://d-<id>.deployz.dev`). */
  defaultUrl: string;
  /** The custom-domain URL once one exists (else null/undefined). */
  customUrl?: string | null;
  /** Whether the custom domain is ACTIVE and healthy enough to serve. */
  customHealthy?: boolean;
}

/** The plan's URL model: the custom URL serves ONLY when it is ACTIVE and
 *  healthy; every other state (none, pending, failed, removed) falls back to
 *  the deployment's permanent default URL. */
export function resolvePreferredPublicUrl(urls: DefaultUrls): string {
  return urls.customUrl && urls.customHealthy ? urls.customUrl : urls.defaultUrl;
}

/** Back-compat seam used by the default-HTTPS state machine (hostname minted
 *  when a PENDING state is first created). Wraps the Phase 2 helper with the
 *  state machine's prefix and apex as the zone. */
export function defaultHttpsHostname(deploymentId: string, apex: string, prefix: string): string {
  return getDefaultDeploymentHostname(deploymentId, { prefix, zone: apex });
}

const DEFAULT_HTTPS_STATUSES: ReadonlySet<string> = new Set([
  'PENDING',
  'WAITING_FOR_DNS',
  'CONFIGURING',
  'ACTIVE',
  'ERROR',
  'REMOVING',
]);

/** Narrow a persisted `deployments.default_https` jsonb value to the state
 *  shape, or null for anything unrecognisable. Pure — callable from the
 *  read-time status derivation. */
export function parseDefaultHttps(raw: unknown): DefaultHttpsState | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record['hostname'] !== 'string' || typeof record['status'] !== 'string') return null;
  if (!DEFAULT_HTTPS_STATUSES.has(record['status'])) return null;
  const readString = (key: string): string | undefined => {
    const value = record[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  };
  const certificateArn = readString('certificateArn');
  const validationName = readString('validationName');
  const validationValue = readString('validationValue');
  const routingTarget = readString('routingTarget');
  const lastDnsCheckAt = readString('lastDnsCheckAt');
  const configureStartedAt = readString('configureStartedAt');
  const lastError = typeof record['lastError'] === 'string' ? record['lastError'] : null;
  return {
    hostname: record['hostname'],
    status: record['status'] as DefaultHttpsStatus,
    ...(certificateArn ? { certificateArn } : {}),
    ...(validationName ? { validationName } : {}),
    ...(validationValue ? { validationValue } : {}),
    ...(routingTarget ? { routingTarget } : {}),
    checkCycle: typeof record['checkCycle'] === 'number' ? record['checkCycle'] : 0,
    lastError,
    configureAttempts: typeof record['configureAttempts'] === 'number' ? record['configureAttempts'] : 0,
    ...(lastDnsCheckAt ? { lastDnsCheckAt } : {}),
    ...(configureStartedAt ? { configureStartedAt } : {}),
  };
}

// ── Job identity ─────────────────────────────────────────────────────────────

/** Job idempotency keys for the default-HTTPS machine are namespaced so a
 *  result can be told apart from a custom-domain job of the SAME relay type
 *  (custom keys embed the custom_domains row's uuid instead). */
const JOB_KEY_PREFIX = 'default-https';

export function isDefaultHttpsJob(job: { idempotencyKey: string }): boolean {
  return job.idempotencyKey.includes(`:${JOB_KEY_PREFIX}:`);
}

function configureJobPrefix(deploymentId: string): string {
  return `${deploymentId}:CONFIGURE_DOMAIN:${JOB_KEY_PREFIX}:`;
}

function removeJobPrefix(deploymentId: string): string {
  return `${deploymentId}:REMOVE_DOMAIN:${JOB_KEY_PREFIX}:`;
}

// ── Persistence ──────────────────────────────────────────────────────────────

function stateToRecord(state: DefaultHttpsState): Record<string, unknown> {
  return {
    hostname: state.hostname,
    status: state.status,
    ...(state.certificateArn ? { certificateArn: state.certificateArn } : {}),
    ...(state.validationName ? { validationName: state.validationName } : {}),
    ...(state.validationValue ? { validationValue: state.validationValue } : {}),
    ...(state.routingTarget ? { routingTarget: state.routingTarget } : {}),
    checkCycle: state.checkCycle,
    lastError: state.lastError,
    configureAttempts: state.configureAttempts ?? 0,
    ...(state.lastDnsCheckAt ? { lastDnsCheckAt: state.lastDnsCheckAt } : {}),
    ...(state.configureStartedAt ? { configureStartedAt: state.configureStartedAt } : {}),
  };
}

async function persistState(db: RuntimeDb, deploymentId: string, state: DefaultHttpsState): Promise<void> {
  await db
    .update(schema.deployments)
    .set({ defaultHttps: stateToRecord(state) })
    .where(eq(schema.deployments.id, deploymentId));
}

/** Load the deployment's current default-HTTPS state (always the freshest
 *  row — a caller-held copy can be stale across its own writes). */
async function reloadState(db: RuntimeDb, deploymentId: string): Promise<DefaultHttpsState | null> {
  const rows = await db
    .select({ defaultHttps: schema.deployments.defaultHttps })
    .from(schema.deployments)
    .where(eq(schema.deployments.id, deploymentId))
    .limit(1);
  return parseDefaultHttps(rows[0]?.defaultHttps ?? null);
}

/** The newest job of the given type whose key is under this machine's prefix. */
async function newestMachineJob(
  db: RuntimeDb,
  deploymentId: string,
  type: 'CONFIGURE_DOMAIN' | 'REMOVE_DOMAIN',
  prefix: string,
): Promise<typeof schema.deploymentJobs.$inferSelect | undefined> {
  const jobs = await db
    .select()
    .from(schema.deploymentJobs)
    .where(
      and(
        eq(schema.deploymentJobs.deploymentId, deploymentId),
        eq(schema.deploymentJobs.type, type),
        like(schema.deploymentJobs.idempotencyKey, `${prefix}%`),
      ),
    )
    .orderBy(desc(schema.deploymentJobs.createdAt))
    .limit(1);
  return jobs[0];
}

const IN_FLIGHT_JOB_STATES = new Set(['REQUESTED', 'QUEUED', 'RUNNING']);

/**
 * Ensures exactly one live CONFIGURE_DOMAIN job chases this deployment's
 * default HTTPS toward its next state — the same cycle bookkeeping as the
 * custom-domain `ensureConfigureJob`. A finished job at the current cycle
 * (or an explicit force) bumps the cycle so the relay sees a fresh
 * idempotency key instead of replaying a stale one. Returns whether a new
 * job row was created (the Phase 12 watchdog counts only real attempts — an
 * in-flight or already-finished job that gets reused is not one).
 */
export async function ensureDefaultHttpsConfigureJob(
  db: RuntimeDb,
  deployment: { id: string },
  state: DefaultHttpsState,
  opts?: { forceNewCycle?: boolean; deferListener?: boolean },
): Promise<boolean> {
  const prefix = configureJobPrefix(deployment.id);
  const newest = await newestMachineJob(db, deployment.id, 'CONFIGURE_DOMAIN', prefix);
  if (newest && IN_FLIGHT_JOB_STATES.has(newest.state)) {
    return false;
  }
  // A state reset to cycle 0 must not collide with older jobs that still own
  // those keys: the next cycle is always above every existing cycle.
  const existing = await db
    .select({ idempotencyKey: schema.deploymentJobs.idempotencyKey })
    .from(schema.deploymentJobs)
    .where(
      and(
        eq(schema.deploymentJobs.deploymentId, deployment.id),
        eq(schema.deploymentJobs.type, 'CONFIGURE_DOMAIN'),
        like(schema.deploymentJobs.idempotencyKey, `${prefix}%`),
      ),
    );
  const maxCycle = existing.reduce(
    (max, row) => Math.max(max, Number(row.idempotencyKey.slice(prefix.length))),
    -1,
  );
  const shouldBump = opts?.forceNewCycle === true || maxCycle >= state.checkCycle;
  const cycle = shouldBump ? Math.max(state.checkCycle, maxCycle) + 1 : state.checkCycle;
  if (shouldBump) {
    await db
      .update(schema.deployments)
      .set({ defaultHttps: { ...stateToRecord(state), checkCycle: cycle } })
      .where(eq(schema.deployments.id, deployment.id));
    state.checkCycle = cycle;
  }
  const { created } = await createOrReuseJob(db, {
    deploymentId: deployment.id,
    type: 'CONFIGURE_DOMAIN',
    idempotencyKey: `${prefix}${cycle}`,
    payload: {
      hostname: state.hostname,
      domainId: deployment.id,
      ...(state.certificateArn ? { certificateArn: state.certificateArn } : {}),
      ...(opts?.deferListener ? { deferListener: true } : {}),
    },
    requestedBy: null,
  });
  return created;
}

/**
 * Marks the default-HTTPS machine REMOVING and ensures one live
 * REMOVE_DOMAIN job (the destroy route's analog of `removeCustomDomain`).
 * A repeat call reuses the in-flight job — never a retry storm.
 */
export async function beginDefaultHttpsRemoval(
  db: RuntimeDb,
  deployment: { id: string },
  state: DefaultHttpsState,
): Promise<void> {
  const prefix = removeJobPrefix(deployment.id);
  const newest = await newestMachineJob(db, deployment.id, 'REMOVE_DOMAIN', prefix);
  if (newest && IN_FLIGHT_JOB_STATES.has(newest.state)) {
    return;
  }
  const shouldBump = state.status !== 'REMOVING' || newest?.state === 'FAILED';
  const cycle = shouldBump ? state.checkCycle + 1 : state.checkCycle;
  if (state.status !== 'REMOVING' || shouldBump) {
    const updated: DefaultHttpsState = { ...state, status: 'REMOVING', checkCycle: cycle, lastError: null };
    await db
      .update(schema.deployments)
      .set({ defaultHttps: stateToRecord(updated) })
      .where(eq(schema.deployments.id, deployment.id));
    state.status = 'REMOVING';
    state.checkCycle = cycle;
  }
  await createOrReuseJob(db, {
    deploymentId: deployment.id,
    type: 'REMOVE_DOMAIN',
    idempotencyKey: `${prefix}${cycle}`,
    payload: {
      hostname: state.hostname,
      domainId: deployment.id,
      ...(state.certificateArn ? { certificateArn: state.certificateArn } : {}),
    },
    requestedBy: null,
  });
}

// ── Result application ───────────────────────────────────────────────────────

/**
 * Applies one relay job result to the deployment's default-HTTPS state.
 * Called from the relay result route ONLY for jobs whose idempotency key
 * is this machine's (`isDefaultHttpsJob`), in the same transaction that
 * finishes the job row.
 */
export async function applyDefaultHttpsJobResult(
  tx: RuntimeDb,
  deploymentId: string,
  job: { type: string },
  body: { success?: boolean; error?: string; output?: Record<string, unknown>; failureCode?: string },
): Promise<void> {
  const state = await reloadState(tx, deploymentId);
  if (!state) {
    return;
  }
  const isSuccess = body.success !== false;

  if (job.type === 'REMOVE_DOMAIN') {
    if (isSuccess) {
      await tx.update(schema.deployments).set({ defaultHttps: null }).where(eq(schema.deployments.id, deploymentId));
    } else if (state.status === 'REMOVING') {
      await persistState(tx, deploymentId, { ...state, lastError: 'REMOVE_FAILED' });
    }
    return;
  }

  // CONFIGURE_DOMAIN
  if (state.status === 'REMOVING') {
    // A stale configure outcome no longer applies once removal has started.
    return;
  }
  if (!isSuccess) {
    if (state.status === 'ACTIVE') {
      // A late/stale configure failure must never knock a live endpoint
      // offline — it is already serving traffic.
      return;
    }
    const lastError = body.failureCode === 'AWS_PERMISSION_DENIED' ? 'AWS_PERMISSION_DENIED' : 'CONFIGURE_FAILED';
    await persistState(tx, deploymentId, { ...state, status: 'ERROR', lastError });
    return;
  }

  const output = body.output ?? {};
  const update: DefaultHttpsState = { ...state };
  let changed = false;
  for (const field of ['certificateArn', 'validationName', 'validationValue', 'routingTarget'] as const) {
    const value = output[field];
    if (typeof value === 'string' && value.length > 0 && value !== update[field]) {
      update[field] = value;
      changed = true;
    }
  }
  const validationKnown = Boolean(update.validationName && update.validationValue);

  let nextStatus: DefaultHttpsStatus | undefined;
  if (state.status === 'PENDING' && validationKnown) {
    nextStatus = 'WAITING_FOR_DNS';
  }
  const statusForHttpsCheck = nextStatus ?? state.status;
  if (
    output.certificateStatus === 'ISSUED' &&
    output.httpsConfigured === true &&
    (statusForHttpsCheck === 'PENDING' || statusForHttpsCheck === 'WAITING_FOR_DNS')
  ) {
    nextStatus = 'CONFIGURING';
  }
  if (nextStatus) {
    update.status = nextStatus;
    update.lastError = null;
    changed = true;
  }
  if (changed) {
    await persistState(tx, deploymentId, update);
  }
}

// ── Driver ───────────────────────────────────────────────────────────────────

export interface DefaultHttpsDeps {
  /** Off switch: default HTTPS runs only when the control plane is configured
   *  with the Cloudflare deployz.dev zone, or under DNS fixture mode. */
  enabled: boolean;
  /** The DNS apex the deployz hostname is minted under. */
  apex: string;
  /** Hostname label prefix of this control plane (`d-` in production). Each
   *  plane that shares the zone mints, lists and sweeps only its own prefix. */
  prefix: string;
  /** Deployment-keyed DNS client (Cloudflare in production; the fixture
   *  provider under E2E; the no-op writer when off). */
  dns: CloudflareDnsClient;
  /** HTTPS reachability probe — the same seam runDomainCheck uses. A failed
   *  probe carries the reason, which the machine persists as lastError so a
   *  stuck CONFIGURING says WHY instead of a single catch-all code. */
  probeHttps: (hostname: string) => Promise<HttpsProbeResult>;
  /** Clock seam (epoch ms); tests inject it. Defaults to `Date.now`. */
  now?: () => number;
  /** Least time between two DNS attempts. Production keeps the default; only
   *  the simulated E2E fixture lowers it. */
  minAttemptIntervalMs?: number;
}

/** Whether the relay has claimed (and not yet settled) this deployment's INSTALL. */
async function hasRunningInstall(db: RuntimeDb, deploymentId: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.deploymentJobs.id })
    .from(schema.deploymentJobs)
    .where(
      and(
        eq(schema.deploymentJobs.deploymentId, deploymentId),
        eq(schema.deploymentJobs.type, 'INSTALL'),
        eq(schema.deploymentJobs.state, 'RUNNING'),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

const EVER_INSTALLED_STATES = new Set<string>(['HEALTHY', 'UPDATING', 'UPDATE_AVAILABLE']);

/** Deployment states with no ALB/relay to serve HTTPS — same gating the
 *  custom-domain machine applies. */
const NOT_RUNNING_STATES = new Set<string>(['FAILED', 'DELETING', 'DELETED', 'NOT_INSTALLED', 'WAITING_FOR_RELAY']);

/**
 * Phase 12 watchdog — how long the machine may spend configuring before it
 * gives up with `DEFAULT_DNS_TIMEOUT`, counted from the first attempt. ACM
 * DNS validation can take up to 30 minutes. This is elapsed time, not an
 * attempt count, so the relay heartbeat interval does not change it.
 */
export const DEFAULT_HTTPS_CONFIGURE_BUDGET_MS = 30 * 60_000;

/** The least time between two DNS reconciliation attempts. */
export const DEFAULT_HTTPS_MIN_ATTEMPT_INTERVAL_MS = 60_000;

/** Counts one attempt; the first attempt of a budget starts its clock. */
function countAttempt(state: DefaultHttpsState, nowMs: number): DefaultHttpsState {
  const attempts = state.configureAttempts ?? 0;
  return {
    ...state,
    configureAttempts: attempts + 1,
    configureStartedAt:
      attempts === 0 || !state.configureStartedAt
        ? new Date(nowMs).toISOString()
        : state.configureStartedAt,
  };
}

/** Whether the elapsed-time budget is used up. A rate-limited machine is
 *  Cloudflare's to unblock, so it keeps waiting. */
function configureBudgetExhausted(state: DefaultHttpsState, nowMs: number): boolean {
  if ((state.configureAttempts ?? 0) === 0 || !state.configureStartedAt) return false;
  if (state.lastError === 'CLOUDFLARE_RATE_LIMITED') return false;
  return nowMs - Date.parse(state.configureStartedAt) >= DEFAULT_HTTPS_CONFIGURE_BUDGET_MS;
}

/** Whether a DNS-write failure is Cloudflare telling us to slow down (429).
 *  Duck-typed on the error code so the real CloudflareDnsError, legacy
 *  writers and test fakes that mirror the taxonomy all classify the same. */
function isCloudflareRateLimited(error: unknown): boolean {
  return (error as { code?: unknown } | null | undefined)?.code === 'CLOUDFLARE_RATE_LIMITED';
}

/**
 * Drives the deployment's default HTTPS one step forward. Idempotent and
 * safe to call on every relay heartbeat (plus once after a successful
 * INSTALL result): any in-flight job blocks a duplicate, every write is an
 * upsert, and the state machine's own statuses gate the transitions.
 */
export async function runDefaultHttpsCheck(
  db: RuntimeDb,
  deployment: {
    id: string;
    state: (typeof schema.deployments.$inferSelect)['state'];
    currentReleaseId?: string | null;
  },
  deps: DefaultHttpsDeps,
): Promise<void> {
  if (!deps.enabled) {
    return;
  }
  // A failed day-2 operation with a current release keeps serving behind its
  // ALB, so HTTPS keeps being driven exactly like the custom-domain check.
  const notRunning =
    NOT_RUNNING_STATES.has(deployment.state) &&
    !(deployment.state === 'FAILED' && (deployment.currentReleaseId ?? null) !== null);
  // An authorized, running INSTALL starts the certificate early (see the
  // header). Before the relay claims the INSTALL nothing is authorized yet.
  const installing = deployment.state === 'INSTALLING' && (await hasRunningInstall(db, deployment.id));
  if (!installing && (notRunning || !EVER_INSTALLED_STATES.has(deployment.state))) {
    return;
  }
  const now = deps.now ?? Date.now;
  // While the stack is still being created, waiting is not a configure
  // attempt: the budget clock starts at the first attempt after the install
  // settles, so a long install cannot use up the budget.
  const countConfigureAttempt = (value: DefaultHttpsState): DefaultHttpsState =>
    installing ? value : countAttempt(value, now());
  const state = await reloadState(db, deployment.id);

  if (!state) {
    // Nothing requested yet. The default URL is permanent (Phase 7): it keeps
    // reconciling even while a custom domain serves — a custom domain can
    // later fail or be removed, and the default is the always-present
    // fallback, so it must never be disabled while a custom domain exists.
    const initial: DefaultHttpsState = {
      hostname: defaultHttpsHostname(deployment.id, deps.apex, deps.prefix),
      status: 'PENDING',
      checkCycle: 0,
      lastError: null,
    };
    await persistState(db, deployment.id, initial);
    const created = await ensureDefaultHttpsConfigureJob(db, deployment, initial, { deferListener: installing });
    if (created && !installing) {
      // Phase 12 watchdog: the very first configure request is a configure
      // attempt too — count it against the budget (unit parity: a machine
      // that mints its initial job and then stalls owes the same accounting
      // as one that stalls later).
      await persistState(db, deployment.id, countAttempt(initial, now()));
    }
    return;
  }

  let working: DefaultHttpsState = state;
  while (working.status !== 'ACTIVE' && working.status !== 'REMOVING' && working.status !== 'ERROR') {
    // Phase 12 watchdog: a pre-ACTIVE machine that has used its whole
    // configure budget (DEFAULT_HTTPS_CONFIGURE_BUDGET_MS since its first
    // attempt) without reaching ACTIVE stops minting and reports
    // DEFAULT_DNS_TIMEOUT. ERROR is terminal (DZ-AUDIT-008); the vendor
    // retries explicitly. CONFIGURING is exempt: it spends no budget (the
    // probe is not a configure attempt).
    if (
      (working.status === 'PENDING' || working.status === 'WAITING_FOR_DNS') &&
      configureBudgetExhausted(working, now())
    ) {
      await persistState(db, deployment.id, {
        ...working,
        status: 'ERROR',
        lastError: 'DEFAULT_DNS_TIMEOUT',
      });
      return;
    }
    switch (working.status) {
      case 'PENDING': {
        const created = await ensureDefaultHttpsConfigureJob(db, deployment, working, { deferListener: installing });
        if (created) {
          await persistState(db, deployment.id, countConfigureAttempt(working));
        }
        return;
      }
      case 'WAITING_FOR_DNS': {
        // At most one attempt per interval, however often the relay checks in.
        if (
          working.lastDnsCheckAt &&
          now() - Date.parse(working.lastDnsCheckAt) <
            (deps.minAttemptIntervalMs ?? DEFAULT_HTTPS_MIN_ATTEMPT_INTERVAL_MS)
        ) {
          return;
        }
        if (!working.validationName || !working.validationValue) {
          // The cert was requested but the relay has not yet reported the
          // validation record — nudge it to describe the cert again.
          const created = await ensureDefaultHttpsConfigureJob(db, deployment, working, {
            forceNewCycle: true,
            deferListener: installing,
          });
          if (created) {
            await persistState(db, deployment.id, {
              ...countConfigureAttempt(working),
              lastDnsCheckAt: new Date(now()).toISOString(),
            });
          }
          return;
        }
        const attemptedAt = new Date(now()).toISOString();
        try {
          // The validation CNAME must stay unproxied for ACM's DNS-01 probe;
          // the routing CNAME is the proxied default record. The validation
          // record is written as soon as it is known; the routing record
          // waits for the load balancer.
          await deps.dns.upsertDefaultValidationRecord(
            deployment.id,
            working.validationName,
            working.validationValue,
          );
          if (working.routingTarget) {
            await deps.dns.upsertDefaultDeploymentRecord(deployment.id, working.routingTarget);
          }
        } catch (error) {
          // A DNS failure only touches default-HTTPS state: no AWS job is
          // enqueued and no infrastructure is recreated — the next driver
          // pass retries the reconciliation.
          const rateLimited = isCloudflareRateLimited(error);
          const failed: DefaultHttpsState = {
            ...working,
            // Phase 12: a RATE-LIMITED attempt made no progress (Cloudflare
            // said stop) and is not counted — it is stored distinctly and
            // retried on a later pass. Temporary / unavailable failures are
            // counted and the budget bounds them. The minimum attempt
            // interval is the backoff — no sleeper is added.
            lastError: rateLimited ? 'CLOUDFLARE_RATE_LIMITED' : 'DNS_WRITE_FAILED',
            lastDnsCheckAt: attemptedAt,
          };
          const next = rateLimited ? failed : countConfigureAttempt(failed);
          if (!rateLimited && configureBudgetExhausted(next, now())) {
            next.status = 'ERROR';
            next.lastError = 'DEFAULT_DNS_TIMEOUT';
          }
          await persistState(db, deployment.id, next);
          return;
        }
        working = { ...working, lastError: null, lastDnsCheckAt: attemptedAt };
        await persistState(db, deployment.id, working);
        // DNS is in place — nudge the relay to re-describe the cert, learn
        // the load balancer and wire the 443 listener once ACM issues it.
        const created = await ensureDefaultHttpsConfigureJob(db, deployment, working, {
          forceNewCycle: true,
          deferListener: installing,
        });
        if (created) {
          await persistState(db, deployment.id, countConfigureAttempt(working));
        }
        return;
      }
      case 'CONFIGURING': {
        const probe = await deps.probeHttps(working.hostname);
        if (probe.ok) {
          working = { ...working, status: 'ACTIVE', lastError: null };
          await persistState(db, deployment.id, working);
        } else {
          // Stay CONFIGURING and say why: a distinguishing reason beats the
          // single HTTPS_NOT_REACHABLE the boolean probe could express.
          await persistState(db, deployment.id, { ...working, lastError: probe.reason });
        }
        return;
      }
      default: {
        // ERROR (terminal: DZ-AUDIT-008) or any other unexpected status
        // — nothing to do here. The vendor retries explicitly.
        return;
      }
    }
  }
}

// ── Purge orphan reconciliation (Phase 11) ───────────────────────────────────

export interface OrphanedDefaultRecordReconciliation {
  /** Routing CNAMEs deleted because no live deployment owns them. */
  deleted: number;
  /** Records skipped: names that do not parse to a live deployment's uuid,
   *  or a deployment row that still exists (deletedAt IS NULL). */
  kept: number;
}

/**
 * Purge-time orphan reconciliation (Phase 11). Lists the zone's `d-*` routing
 * CNAMEs and deletes any whose deployment no longer exists — `deletedAt` set,
 * or the row gone entirely. Every name is parsed to a `d-<uuid>.<zone>`
 * deployment id first (parseDefaultDeploymentId); names that fail the parse
 * (reserved hostnames, wrong zone, non-uuid ids — structurally `app.deployz.dev`
 * and friends) are SKIPPED and never reach a delete call. Idempotent: a second
 * pass after a successful one has nothing left to delete; a record that is
 * already missing deletes as a no-op. Failure is state-only — errors propagate
 * so the caller logs and continues on the next purge pass; no DB row is
 * written by this function.
 */
export async function reconcileOrphanedDefaultRecords(
  db: RuntimeDb,
  dns: CloudflareDnsClient,
  config: DefaultHostnameConfig = {},
): Promise<OrphanedDefaultRecordReconciliation> {
  const records = await dns.listDefaultRecords();
  let deleted = 0;
  let kept = 0;
  const candidateIds: string[] = [];
  for (const record of records) {
    const id = parseDefaultDeploymentId(record.name, config);
    if (!id) {
      kept += 1;
      continue;
    }
    candidateIds.push(id);
  }
  if (candidateIds.length === 0) {
    return { deleted, kept };
  }
  const liveRows = await db
    .select({ id: schema.deployments.id })
    .from(schema.deployments)
    .where(and(inArray(schema.deployments.id, candidateIds), isNull(schema.deployments.deletedAt)));
  const live = new Set(liveRows.map((row) => row.id));
  for (const id of candidateIds) {
    if (live.has(id)) {
      kept += 1;
      continue;
    }
    await dns.deleteDefaultDeploymentRecord(id);
    deleted += 1;
  }
  return { deleted, kept };
}
