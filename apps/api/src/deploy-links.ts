import crypto from 'node:crypto';

import { and, desc, eq } from 'drizzle-orm';

import {
  DEFAULT_PENDING_SECRET_TTL_MS,
  estimateFootprintCost,
  type DeploymentType,
  type InfrastructureSizeTier,
  type Region,
} from '@deployz/contracts';
import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { assertProductionDeploymentAllowed } from './billing-entitlements.js';
import {
  NO_OP_TEMPLATE_PUBLISHER,
  compileDeploymentIntent,
  compilerArtifactPublishInput,
  type TemplatePublisher,
} from './compiler-artifact.js';
import { planChangedError, planFingerprint, resolveSizeSelection, type LinkSizing } from './deployment-size.js';
import { env } from './env.js';
import { ApiError, NotFoundError } from './errors.js';
import { recordEvent } from './events.js';
import type { PendingSecretStore, SecretCipher } from './pending-secrets.js';
import { newestDeployableRelease, releaseRequiredError } from './install-parameters.js';
import { requirePreflightReady, runApplicationPreflight } from './preflight.js';
import { hashRelayToken, mintEnrollmentCode, mintRelayCredential, verifyRelayToken } from './relay-store.js';

// Deploy Links — a vendor-generated, tokenized entry point. Each link pre-
// creates one deployment (deployments.source = 'deploy_link') through the
// SAME creation logic as the vendor manual flow (createDeploymentRecord, also
// called by POST /api/deployments), then records a deploy_links row keyed to
// it. The customer presents the link's public uuid + secret token (header
// `x-deployz-token`) at the public resolve route; the token authorizes only
// this one deployment flow and never becomes a session.

/** How long a freshly minted (or regenerated) link stays valid. */
export const DEFAULT_DEPLOY_LINK_TTL_DAYS = 30;

// Re-using the install-page throttle window: an 'opened' write per open would
// flood event_logs on a polling page, but a 60s cadence still records each
// visit that is more than a minute apart.
const LAST_USED_THROTTLE_MS = 60_000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DeployLinkRow = typeof schema.deployLinks.$inferSelect;
type ApplicationRow = typeof schema.applications.$inferSelect;
type CustomerRow = typeof schema.customers.$inferSelect;
type DeploymentRow = typeof schema.deployments.$inferSelect;
type DeploymentSource = (typeof schema.deployments.$inferInsert)['source'];

/** A fresh 32-byte hex secret. Stored only as its sha256 (see tokenHash). */
export function mintDeployLinkToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

function linkExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + DEFAULT_DEPLOY_LINK_TTL_DAYS * 24 * 60 * 60 * 1000);
}

/** A non-uuid id would raise a Postgres error and surface as a 500 — map to 404 instead. */
function requireUuidId(id: string): void {
  if (!UUID_PATTERN.test(id)) {
    throw new NotFoundError('Resource not found');
  }
}

// ── Ownership-scoped loaders (IDOR guards) ──────────────────────────────────
// Same rules as server.ts: a link/deployment/customer of another org 404s,
// never 403s, so cross-tenant existence never leaks.

export async function loadOwnedApplication(
  db: RuntimeDb,
  id: string,
  organizationId: string,
): Promise<ApplicationRow> {
  requireUuidId(id);
  const rows = await db
    .select()
    .from(schema.applications)
    .where(and(eq(schema.applications.id, id), eq(schema.applications.organizationId, organizationId)))
    .limit(1);
  if (rows.length === 0) {
    throw new NotFoundError('Application not found');
  }
  return rows[0]!;
}

export async function loadOwnedCustomer(db: RuntimeDb, id: string, organizationId: string): Promise<CustomerRow> {
  requireUuidId(id);
  const rows = await db
    .select()
    .from(schema.customers)
    .where(and(eq(schema.customers.id, id), eq(schema.customers.organizationId, organizationId)))
    .limit(1);
  if (rows.length === 0) {
    throw new NotFoundError('Customer not found');
  }
  return rows[0]!;
}

async function loadOwnedLink(db: RuntimeDb, id: string, organizationId: string): Promise<DeployLinkRow> {
  requireUuidId(id);
  const rows = await db
    .select()
    .from(schema.deployLinks)
    .where(and(eq(schema.deployLinks.id, id), eq(schema.deployLinks.organizationId, organizationId)))
    .limit(1);
  if (rows.length === 0) {
    throw new NotFoundError('Deploy link not found');
  }
  return rows[0]!;
}

// ── Shared deployment creation (also used by POST /api/deployments) ────────

export interface CreateDeploymentParams {
  organizationId: string;
  applicationId: string;
  customerId: string;
  region: Region;
  deploymentType: DeploymentType;
  createdBy: string | null;
  updatedBy: string | null;
  source: DeploymentSource;
  /** Public install link origin (source 'public_link' only): the link + confirm key. */
  publicInstallLinkId?: string;
  confirmKey?: string;
  /** The chosen size; absent = the link recommendation, else the application default. */
  sizeProfile?: InfrastructureSizeTier;
  /** The sizing frozen on the public install link (source 'public_link' only). */
  linkSizing?: LinkSizing;
  /** The plan fingerprint the customer approved; the compiled plan must match it. */
  approvedPlanFingerprint?: string;
}

export interface CreatedDeployment {
  deployment: DeploymentRow;
  application: ApplicationRow;
}

/**
 * DEPLOY-027 (Phase 4) materialization deps. Optional so callers that do not
 * care about secret delivery (unit tests, fixtures) can omit them and rely on
 * a no-op fallback.
 */
export interface MaterializationDeps {
  readonly pendingSecrets: PendingSecretStore;
  readonly cipher: SecretCipher;
}

/**
 * Compiler-v2 deps. Optional so callers that do not care about artifact
 * publication (unit tests, fixtures) can omit them and rely on a no-op
 * fallback; production funnels pass the real S3 publisher.
 */
export interface CompilerDeps {
  readonly templatePublisher?: TemplatePublisher;
}

/**
 * The POST /api/deployments creation body, extracted so the manual route and
 * the deploy-link flow run ONE implementation: org-scoped 404s, the manifest
 * readiness gates, and the insert (state NOT_INSTALLED, fresh enrollment
 * code, final manifest as desiredState). Callers keep their own deployable-
 * region gates for route ordering; the check inside is the shared backstop
 * every creation path funnels through.
 */
export async function createDeploymentRecord(
  db: RuntimeDb,
  params: CreateDeploymentParams,
  compilerDeps?: CompilerDeps,
): Promise<CreatedDeployment> {
  const application = await loadOwnedApplication(db, params.applicationId, params.organizationId);
  await loadOwnedCustomer(db, params.customerId, params.organizationId);
  const { profile: sizeProfile } = resolveSizeSelection(application, params.sizeProfile, params.linkSizing);
  // Fail-closed backstop: a Region whose bootstrap artifacts are not
  // confirmed published never reaches a deployment row, so it can never
  // reach the relay or CloudFormation — even if a future caller forgets its
  // own pre-load gate.
  if (!env.deployableAwsRegions.includes(params.region)) {
    throw new ApiError(
      422,
      'REGION_NOT_SUPPORTED',
      `Region ${params.region} is not available for installation yet.`,
    );
  }
  // The one preflight every path into provisioning runs — the manifest gate
  // against THIS customer's configuration plus the readiness report's
  // remaining findings. Generated secrets are never minted on the control
  // plane (#186): the relay mints them inside the customer's account after
  // install, and the preflight counts them as auto-provided.
  const { manifest, result } = await runApplicationPreflight(db, application, params.customerId);
  const actor =
    params.createdBy !== null
      ? { actorType: 'user' as const, actorId: params.createdBy }
      : { actorType: 'system' as const, actorId: 'deployment-creation' };
  // The preflight gate itself is the funnel event (result: pass|blocked).
  // A blocked evaluation writes nothing and the caller throws — for the
  // deploy-link flow that happens inside its tx, which rolls this event back
  // (no deployment exists to attach it to); the manual flow persists it.
  if (!result.ready) {
    await recordEvent(db, {
      organizationId: params.organizationId,
      eventType: 'application.preflight_evaluated',
      ...actor,
      customerId: params.customerId,
      payload: {
        schemaVersion: 1,
        applicationId: params.applicationId,
        result: 'blocked',
        blockingCount: result.blockers.length,
        warningCount: result.warnings.length,
      },
    });
  }
  requirePreflightReady(result);
  // Refuse up front what the INSTALL would refuse later: without a built
  // release there is no image to run.
  if (!(await newestDeployableRelease(db, params.applicationId))) throw releaseRequiredError();
  // Compiler-v2 provisioning intent: freeze the manifest into a completed
  // DeploymentSpecV2 and publish the compiled template BEFORE the DB write.
  // A compile or publish failure throws here — inside the caller's tx where
  // one exists — so no row can exist without its artifact (fail closed; an
  // orphaned content-addressed object is harmless).
  const { spec, template, templateHash } = compileDeploymentIntent({
    manifest,
    region: params.region,
    sizeProfile,
    templateBucketPrefix: env.templateBucketPrefix,
  });
  // The customer approved one exact plan. The compiled stack must be that
  // plan, else the caller's transaction rolls back and nothing is created.
  if (params.approvedPlanFingerprint !== undefined) {
    const footprint = spec.footprint;
    const fingerprint =
      footprint && params.publicInstallLinkId !== undefined
        ? planFingerprint({
            linkId: params.publicInstallLinkId,
            region: params.region,
            profile: sizeProfile,
            footprint,
            costEstimate: estimateFootprintCost(footprint),
          })
        : null;
    if (fingerprint !== params.approvedPlanFingerprint) throw planChangedError();
  }
  const publisher = compilerDeps?.templatePublisher ?? NO_OP_TEMPLATE_PUBLISHER;
  await publisher.publishTemplate(
    compilerArtifactPublishInput(
      params.region,
      templateHash,
      JSON.stringify(template),
      env.templateBucketPrefix,
    ),
  );
  const relayCredential = mintRelayCredential();
  const [row] = await db
    .insert(schema.deployments)
    .values({
      customerId: params.customerId,
      applicationId: params.applicationId,
      organizationId: params.organizationId,
      region: params.region,
      state: 'NOT_INSTALLED',
      source: params.source,
      specV2: spec,
      // Frozen desired state: the canonical manifest PLUS the immutable
      // infrastructure-size profile this deployment was created with. The
      // profile reference is written once and never mutated — a different
      // size is a NEW deployment, not an edit here.
      desiredState: {
        manifest,
        infrastructureProfile: {
          id: sizeProfile.id,
          version: sizeProfile.version,
        },
      },
      enrollmentCode: mintEnrollmentCode(),
      // Invitation lifecycle: every newly issued link is time-limited (30
      // days). Links created before this column existed keep NULL = no limit,
      // so in-flight installations are untouched.
      installLinkExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      // DZ-AUDIT-013: server-established relay credential stored alongside
      // its hash. Delivered through the Quick Create URL and NULLed after
      // the relay's first successful registration.
      relayCredential,
      relayTokenHash: hashRelayToken(relayCredential),
      deploymentType: params.deploymentType,
      createdBy: params.createdBy,
      updatedBy: params.updatedBy,
      ...(params.publicInstallLinkId !== undefined ? { publicInstallLinkId: params.publicInstallLinkId } : {}),
      ...(params.confirmKey !== undefined ? { confirmKey: params.confirmKey } : {}),
    })
    .returning();
  await recordEvent(db, {
    organizationId: params.organizationId,
    eventType: 'application.preflight_evaluated',
    ...actor,
    deploymentId: row!.id,
    customerId: params.customerId,
    payload: {
      schemaVersion: 1,
      applicationId: params.applicationId,
      result: 'pass',
      blockingCount: result.blockers.length,
      warningCount: result.warnings.length,
    },
  });
  // Funnel event: the deployment record now exists. `source` is exactly what
  // the insert above wrote to deployments.source, so funnel queries can
  // attribute origin without a join.
  await recordEvent(db, {
    organizationId: params.organizationId,
    eventType: 'deployment.created',
    ...actor,
    deploymentId: row!.id,
    customerId: params.customerId,
    payload: {
      schemaVersion: 1,
      source: params.source,
    },
  });
  return { deployment: row!, application };
}

/**
 * Reads every staged row for the new deployment's scope, decrypts each
 * with its stored context, re-encrypts with the deployment-scoped context,
 * and upserts the resulting bound row. Called from every deployment-creation
 * path (manual POST /api/deployments, deploy-link, public-install confirm,
 * billing-checkout completion) AFTER the tx that creates the deployment
 * commits — running this inside the tx deadlocks PGlite's single connection.
 */
export async function materializePendingSecretsForDeployment(
  deps: MaterializationDeps,
  deployment: { organizationId: string; id: string; applicationId: string; customerId: string },
): Promise<void> {
  const rows = await deps.pendingSecrets.materializeForDeployment(deployment);
  if (rows.length === 0) return;
  // A key that already has a bound row is left alone, so a retried
  // materialization never rewrites the row the relay may already have read.
  const alreadyBound = new Set(
    (await deps.pendingSecrets.listBoundForDeployment(deployment.id)).map((row) => row.key),
  );
  const expiresAt = new Date(Date.now() + DEFAULT_PENDING_SECRET_TTL_MS);
  for (const { key, plaintext } of rows) {
    if (alreadyBound.has(key)) continue;
    const boundContext: Record<string, string> = {
      organizationId: deployment.organizationId,
      applicationId: deployment.applicationId,
      deploymentId: deployment.id,
      key,
      customerId: deployment.customerId,
    };
    const { ciphertext } = await deps.cipher.encrypt(plaintext, boundContext);
    await deps.pendingSecrets.upsertBound({
      organizationId: deployment.organizationId,
      applicationId: deployment.applicationId,
      deploymentId: deployment.id,
      key,
      ciphertext,
      encryptionContext: boundContext,
      expiresAt,
    });
  }
}

// ── Link lifecycle ──────────────────────────────────────────────────────────

export interface CreateDeployLinkParams {
  organizationId: string;
  userId: string;
  customerId: string;
  applicationId: string;
  region: Region;
  sizeProfile?: InfrastructureSizeTier;
}

export async function createDeployLink(
  db: RuntimeDb,
  params: CreateDeployLinkParams,
  materialization?: MaterializationDeps,
  compilerDeps?: CompilerDeps,
): Promise<{ link: DeployLinkRow; deployment: DeploymentRow; application: ApplicationRow; token: string }> {
  // Same fail-closed gate as POST /api/deployments: a link may only target a
  // region whose bootstrap artifacts are CONFIRMED published.
  if (!env.deployableAwsRegions.includes(params.region)) {
    throw new ApiError(
      422,
      'REGION_NOT_SUPPORTED',
      `Region ${params.region} is not available for installation yet.`,
    );
  }
  // Paddle migration Phase 7 — a deploy link always creates a PRODUCTION
  // deployment, so it needs an ACTIVE subscription just like the manual
  // flow. Checked before createDeploymentRecord and before the deploy_links
  // row exists.
  await assertProductionDeploymentAllowed(db, params.organizationId, env.billingEnforcementPaused);

  const token = mintDeployLinkToken();
  const result = await db.transaction(async (tx) => {
    const { deployment, application } = await createDeploymentRecord(
      tx,
      {
        organizationId: params.organizationId,
        customerId: params.customerId,
        applicationId: params.applicationId,
        region: params.region,
        deploymentType: 'PRODUCTION',
        createdBy: params.userId,
        updatedBy: params.userId,
        source: 'deploy_link',
        ...(params.sizeProfile !== undefined ? { sizeProfile: params.sizeProfile } : {}),
      },
      compilerDeps,
    );
    const [link] = await tx
      .insert(schema.deployLinks)
      .values({
        organizationId: params.organizationId,
        customerId: deployment.customerId,
        applicationId: deployment.applicationId,
        deploymentId: deployment.id,
        tokenHash: hashRelayToken(token),
        expiresAt: linkExpiry(),
        createdBy: params.userId,
      })
      .returning();
    await recordEvent(tx, {
      organizationId: params.organizationId,
      eventType: 'deploy_link.created',
      actorType: 'user',
      actorId: params.userId,
      deploymentId: deployment.id,
      customerId: deployment.customerId,
      payload: { applicationId: deployment.applicationId, linkId: link!.id },
    });
    return { link: link!, deployment, application };
  });
  // DEPLOY-027 (Phase 4): the materialization hook runs OUTSIDE the
  // transaction so the pending-secrets store's drizzle queries do not contend
  // with the connection the tx already holds (PGlite is single-connection).
  // The secrets are encrypted ciphertext — a commit failure here leaves a
  // staged row that the next createDeploymentRecord would re-materialize.
  if (materialization !== undefined) {
    await materializePendingSecretsForDeployment(materialization, {
      organizationId: params.organizationId,
      id: result.deployment.id,
      applicationId: params.applicationId,
      customerId: params.customerId,
    });
  }
  return { ...result, token };
}

export async function revokeDeployLink(
  db: RuntimeDb,
  params: { organizationId: string; userId: string; linkId: string },
): Promise<DeployLinkRow> {
  const link = await loadOwnedLink(db, params.linkId, params.organizationId);
  // Idempotent: revoking an already-revoked link returns its current state.
  if (link.revokedAt !== null) {
    return link;
  }
  const [updated] = await db
    .update(schema.deployLinks)
    .set({ revokedAt: new Date() })
    .where(and(eq(schema.deployLinks.id, params.linkId), eq(schema.deployLinks.organizationId, params.organizationId)))
    .returning();
  await recordEvent(db, {
    organizationId: params.organizationId,
    eventType: 'deploy_link.revoked',
    actorType: 'user',
    actorId: params.userId,
    deploymentId: link.deploymentId,
    customerId: link.customerId,
  });
  return updated!;
}

export async function regenerateDeployLink(
  db: RuntimeDb,
  params: { organizationId: string; userId: string; linkId: string },
): Promise<{ link: DeployLinkRow; token: string }> {
  const link = await loadOwnedLink(db, params.linkId, params.organizationId);
  const deployments = await db
    .select({ state: schema.deployments.state })
    .from(schema.deployments)
    .where(eq(schema.deployments.id, link.deploymentId))
    .limit(1);
  if (deployments.length === 0 || deployments[0]!.state !== 'NOT_INSTALLED') {
    throw new ApiError(
      409,
      'DEPLOYMENT_ALREADY_STARTED',
      'This deploy link can no longer be regenerated because its deployment has already started.',
    );
  }
  const token = mintDeployLinkToken();
  const [updated] = await db
    .update(schema.deployLinks)
    .set({
      tokenHash: hashRelayToken(token),
      // Regeneration revives the link: a fresh secret, a fresh expiry, and a
      // clean usage history (revokedAt cleared so a revoked link is reusable).
      expiresAt: linkExpiry(),
      lastUsedAt: null,
      revokedAt: null,
    })
    .where(and(eq(schema.deployLinks.id, params.linkId), eq(schema.deployLinks.organizationId, params.organizationId)))
    .returning();
  await recordEvent(db, {
    organizationId: params.organizationId,
    eventType: 'deploy_link.regenerated',
    actorType: 'user',
    actorId: params.userId,
    deploymentId: link.deploymentId,
    customerId: link.customerId,
  });
  return { link: updated!, token };
}

export interface ResolvedDeployLink {
  link: DeployLinkRow;
  deployment: DeploymentRow;
  application: ApplicationRow;
  customer: CustomerRow;
}

/**
 * Resolve the public link: verify the secret token against the stored hash
 * and return what the customer page needs. Malformed/unknown id and a
 * missing/mismatched token are all the same 404 — the caller can never learn
 * which of the three failed.
 */
export async function resolveDeployLink(
  db: RuntimeDb,
  publicId: string,
  token: string | undefined,
): Promise<ResolvedDeployLink> {
  requireUuidId(publicId);
  const rows = await db
    .select({
      link: schema.deployLinks,
      deployment: schema.deployments,
      application: schema.applications,
      customer: schema.customers,
    })
    .from(schema.deployLinks)
    .innerJoin(schema.deployments, eq(schema.deployLinks.deploymentId, schema.deployments.id))
    .innerJoin(schema.applications, eq(schema.deployLinks.applicationId, schema.applications.id))
    .innerJoin(schema.customers, eq(schema.deployLinks.customerId, schema.customers.id))
    .where(eq(schema.deployLinks.id, publicId))
    .limit(1);
  if (rows.length === 0) {
    throw new NotFoundError('Deploy link not found');
  }
  const row = rows[0]!;
  if (token === undefined || !verifyRelayToken(row.link.tokenHash, token)) {
    throw new NotFoundError('Deploy link not found');
  }
  if (row.link.revokedAt !== null) {
    throw new ApiError(410, 'DEPLOY_LINK_REVOKED', 'This deploy link has been revoked.');
  }
  if (row.link.expiresAt.getTime() < Date.now()) {
    throw new ApiError(410, 'DEPLOY_LINK_EXPIRED', 'This deploy link has expired.');
  }
  if (row.deployment.state === 'DELETED') {
    throw new NotFoundError('Deploy link not found');
  }
  // The opened marker/event is throttled: a page that polls (or a tab that
  // reloads) within the window does not rewrite last_used_at or spam the log.
  const lastUsedAt = row.link.lastUsedAt;
  if (lastUsedAt === null || Date.now() - lastUsedAt.getTime() >= LAST_USED_THROTTLE_MS) {
    await db
      .update(schema.deployLinks)
      .set({ lastUsedAt: new Date() })
      .where(eq(schema.deployLinks.id, row.link.id));
    await recordEvent(db, {
      organizationId: row.link.organizationId,
      eventType: 'deploy_link.opened',
      actorType: 'system',
      actorId: `deploy-link:${publicId}`,
      deploymentId: row.deployment.id,
      customerId: row.customer.id,
    });
  }
  return row;
}

export async function listDeployLinks(
  db: RuntimeDb,
  organizationId: string,
  customerId: string,
): Promise<{ link: DeployLinkRow; deployment: DeploymentRow; application: ApplicationRow }[]> {
  return db
    .select({
      link: schema.deployLinks,
      deployment: schema.deployments,
      application: schema.applications,
    })
    .from(schema.deployLinks)
    .innerJoin(schema.deployments, eq(schema.deployLinks.deploymentId, schema.deployments.id))
    .innerJoin(schema.applications, eq(schema.deployLinks.applicationId, schema.applications.id))
    .where(
      and(eq(schema.deployLinks.organizationId, organizationId), eq(schema.deployLinks.customerId, customerId)),
    )
    .orderBy(desc(schema.deployLinks.createdAt));
}
