import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import { z } from 'zod';

import { mintedEnvKeys } from '@deployz/analysis';
import {
  REGION_LABELS,
  SUPPORTED_AWS_REGIONS,
  buildInstallPlan,
  customerInputRows,
  evaluateEnvironmentSetup,
  infrastructureSizeTierSchema,
  isSupportedRegion,
  resolveStoredInfrastructureSizeProfile,
  sizeTierMeetsMinimum,
  type DeploymentManifest,
  type DeploymentPlan,
  type EnvVariableClassification,
  type EnvironmentSetting,
  type InfrastructureSizeTier,
  type Region,
} from '@deployz/contracts';
import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { createConfigStore, createRelaySecretWriter, createScopeDeploymentsFinder, type ConfigDeps, setConfig } from './config.js';
import { assertProductionDeploymentAllowed } from './billing-entitlements.js';
import { compileDeploymentIntent } from './compiler-artifact.js';
import { createDeploymentRecord, loadOwnedApplication, loadOwnedCustomer, materializePendingSecretsForDeployment, mintDeployLinkToken } from './deploy-links.js';
import {
  assertSizeSettingsValid,
  planFingerprint,
  resolveSizeSelection,
  sizeOptions,
  sizingBounds,
  type LinkSizing,
} from './deployment-size.js';
import { env } from './env.js';
import { ApiError, NotFoundError } from './errors.js';
import { readEnvironmentSettings } from './environment-setup.js';
import { recordEvent } from './events.js';
import { requirePreflightReady, runApplicationPreflight } from './preflight.js';
import { createReleaseRecord, ensureBuildConfigurationReady } from './releases.js';
import { createDrizzlePendingSecretStore } from './pending-secrets.js';
import { hashRelayToken, verifyRelayToken } from './relay-store.js';

// Public Install Links — the customer-side installation review surface. A
// link is vendor-published and credential-free: anyone holding the opaque
// uuid may review the offer (GET) and confirm an installation (POST), so the
// vendor stops that by disabling or revoking the link, never by hiding the id.
//
// The resolve projection is deliberately small: application name, publisher
// name, the newest published release, the deployable regions, the inputs the
// customer may/must supply, and the same INSTALL plan the install page
// serves. No secrets, no manifest JSON, no template URLs, no CloudFormation
// parameters, and no internal ids — the opaque link id is the only
// identifier this surface ever sees or returns (the confirm response's
// installLinkId excepted: it is the customer's own handle into the existing
// /install flow, which owns everything after this point).

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How long a freshly minted targeted invitation stays valid. */
export const DEFAULT_INVITATION_TTL_DAYS = 30;

// The invitation.opened event is throttled in memory — the schema has no
// last-used column to throttle on (deploy-links.ts writes last_used_at; here
// an in-memory Map keyed by link id stands in). Same 60s cadence as
// deploy-links.ts's LAST_USED_THROTTLE_MS: a page that polls or reloads
// within the window does not flood event_logs.
const OPENED_THROTTLE_MS = 60_000;
const lastOpenedAtByLinkId = new Map<string, number>();

export type PublicInstallLinkRow = typeof schema.publicInstallLinks.$inferSelect;
type ApplicationRow = typeof schema.applications.$inferSelect;

/** One input the confirm body may (optional) or must (required) supply. */
export interface PublicInstallInput {
  readonly key: string;
  readonly required: boolean;
  readonly secret: boolean;
  readonly classification?: EnvVariableClassification;
  readonly purpose?: 'internal_secret' | 'external_credential' | 'infrastructure_binding' | 'optional_configuration' | 'unknown';
  /** Vendor-authored, customer-facing (docs/environment-variables.md: provider 'customer' only). */
  readonly label?: string;
  readonly help?: string;
}

// The confirm body — strict at every level so hostile keys (databaseRequired
// and friends) are rejected by validation instead of ever reaching the
// manifest or profile. Query parameters are never read on this surface.
export const publicInstallConfirmBodySchema = z
  .object({
    idempotencyKey: z.string().uuid(),
    region: z.string().min(1),
    // The size and the plan the customer reviewed. The server recomputes the
    // plan for this size and refuses a fingerprint that does not match.
    sizeProfile: infrastructureSizeTierSchema,
    planFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    // Required only for a credential-free reusable link (no target customer);
    // a targeted invitation already names its customer and must not supply it.
    customer: z
      .object({
        name: z.string().trim().min(1),
        email: z.string().trim().email(),
      })
      .strict()
      .optional(),
    config: z
      .array(
        z
          .object({
            key: z.string().min(1),
            value: z.string(),
            isSecret: z.boolean(),
          })
          .strict(),
      )
      .max(200),
  })
  .strict();
export type PublicInstallConfirmBody = z.infer<typeof publicInstallConfirmBodySchema>;

/** A non-uuid id would raise a Postgres error and surface as a 500 — map to 404 instead. */
function requireUuidId(id: string): void {
  if (!UUID_PATTERN.test(id)) {
    throw new NotFoundError('Resource not found');
  }
}

/** The sizing a link froze at creation (null on links created before sizing). */
function linkSizing(link: PublicInstallLinkRow): LinkSizing {
  return { recommended: link.recommendedSizeProfile, minimum: link.minimumSizeProfile };
}

interface ActivePublicInstallLink {
  link: PublicInstallLinkRow;
  application: ApplicationRow;
  publisherName: string;
}

/**
 * Resolve the link and enforce its lifecycle: unknown/malformed ids 404, a
 * revoked link 410, a disabled link 410 with its own code (so the page can
 * say the vendor turned it off rather than guess at a broken URL).
 */
async function loadActiveLink(db: RuntimeDb, linkId: string, token?: string): Promise<ActivePublicInstallLink> {
  requireUuidId(linkId);
  const rows = await db
    .select({
      link: schema.publicInstallLinks,
      application: schema.applications,
      publisherName: schema.organization.name,
    })
    .from(schema.publicInstallLinks)
    .innerJoin(schema.applications, eq(schema.publicInstallLinks.applicationId, schema.applications.id))
    .innerJoin(schema.organization, eq(schema.publicInstallLinks.organizationId, schema.organization.id))
    .where(eq(schema.publicInstallLinks.id, linkId))
    .limit(1);
  if (rows.length === 0) {
    throw new NotFoundError('Install link not found');
  }
  const row = rows[0]!;
  const targeted = row.link.tokenHash !== null;
  if (targeted) {
    // Private invitation: the secret authorizes review + confirmation only.
    // Missing/mismatched token is the same 404 as an unknown id — the caller
    // can never learn which failed.
    if (token === undefined || !verifyRelayToken(row.link.tokenHash, token)) {
      throw new NotFoundError('Install link not found');
    }
  }
  if (row.link.revokedAt !== null) {
    throw new ApiError(410, 'PUBLIC_INSTALL_LINK_REVOKED', 'This installation link has been revoked.');
  }
  if (row.link.expiresAt !== null && row.link.expiresAt.getTime() < Date.now()) {
    throw new ApiError(410, 'PUBLIC_INSTALL_LINK_EXPIRED', 'This installation link has expired.');
  }
  // `enabled` only gates the credential-free reusable link; a targeted
  // invitation is token-gated and has no enabled concept.
  if (!targeted && !row.link.enabled) {
    throw new ApiError(
      410,
      'PUBLIC_INSTALL_LINK_DISABLED',
      'This application is not currently available for installation.',
    );
  }
  return row;
}

/**
 * The newest published release: READY (built, digest recorded by the
 * pipeline) and not known-unavailable. The same selection the post-install
 * auto-deploy uses — null means nothing is published yet, which refuses the
 * whole surface with 410 rather than offering an install that cannot run.
 */
async function newestPublishedRelease(
  db: RuntimeDb,
  applicationId: string,
): Promise<{ version: string; createdAt: Date } | null> {
  const rows = await db
    .select({ version: schema.releases.version, createdAt: schema.releases.createdAt })
    .from(schema.releases)
    .where(
      and(
        eq(schema.releases.applicationId, applicationId),
        eq(schema.releases.releaseStatus, 'READY'),
        isNull(schema.releases.imageUnavailableAt),
      ),
    )
    .orderBy(desc(schema.releases.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The inputs the customer supplies at confirm time: runtime keys whose
 * effective provider is 'customer' (a saved setting) or "unreviewed
 * required" (no saved setting — legacy behaviour). Optional/unknown/none/
 * vendor/deployz keys are no longer asked. Generated/internal keys are
 * EXCLUDED — the relay mints them inside the customer's account (the same
 * mintable rule install-config.ts applies), so asking for them would both
 * leak the mechanism and produce a value nothing reads.
 */
export function publicInstallInputs(
  manifest: DeploymentManifest,
  settings: readonly EnvironmentSetting[] | null,
): PublicInstallInput[] {
  const mintable = new Set<string>(mintedEnvKeys(manifest, settings));
  const variablesByKey = new Map(manifest.environment.variables.map((variable) => [variable.key, variable]));
  const evaluation = evaluateEnvironmentSetup({
    variables: manifest.environment.variables,
    settings,
    // Not needed to decide which rows are customer inputs (only their status
    // would change, which this projection does not carry).
    vendorValueKeys: new Set(),
  });
  // The mintable heuristic applies only to rows the vendor has not reviewed:
  // an explicit "Set by customer" decision always asks the customer.
  return customerInputRows(evaluation)
    .filter((row) => row.setting !== null || !mintable.has(row.key))
    .map((row) => {
      const variable = variablesByKey.get(row.key);
      return {
        key: row.key,
        required: row.required,
        secret: row.secret,
        ...(variable?.classification !== undefined ? { classification: variable.classification } : {}),
        ...(variable?.purpose !== undefined ? { purpose: variable.purpose } : {}),
        ...(row.setting?.label ? { label: row.setting.label } : {}),
        ...(row.setting?.help ? { help: row.setting.help } : {}),
      };
    });
}

/**
 * GET /api/public-install/:linkId — the review projection. The manifest is
 * the same effective construction the readiness/plan endpoints serve
 * (runApplicationPreflight), so the public page can never disagree with the
 * vendor surfaces about what an install creates.
 */
export async function resolvePublicInstall(db: RuntimeDb, linkId: string, token?: string) {
  const { application, publisherName, link } = await loadActiveLink(db, linkId, token);
  // The opened event is throttled: a page that polls within the window does
  // not spam the log. Payload records ids only — the token is verified inside
  // loadActiveLink and is never written anywhere.
  const lastOpenedAt = lastOpenedAtByLinkId.get(link.id);
  if (lastOpenedAt === undefined || Date.now() - lastOpenedAt >= OPENED_THROTTLE_MS) {
    lastOpenedAtByLinkId.set(link.id, Date.now());
    await recordEvent(db, {
      organizationId: link.organizationId,
      eventType: 'invitation.opened',
      actorType: 'system',
      actorId: `public-install:${link.id}`,
      ...(link.customerId !== null ? { customerId: link.customerId } : {}),
      payload: { schemaVersion: 1, invitationId: link.id, applicationId: link.applicationId },
    });
  }
  // A consumed targeted invitation is not re-reviewable (a reusable link is).
  if (link.customerId !== null && link.confirmedAt !== null) {
    throw new ApiError(410, 'PUBLIC_INSTALL_LINK_USED', 'This installation link has already been used.');
  }
  const release = await newestPublishedRelease(db, link.applicationId);
  if (release === null) {
    throw new ApiError(410, 'RELEASE_NOT_PUBLISHED', 'This application has no published release yet.');
  }
  const { manifest } = await runApplicationPreflight(db, application, link.customerId);
  const bounds = sizingBounds(application, linkSizing(link));
  return {
    application: { name: application.name },
    publisher: { name: publisherName },
    release: { version: release.version, createdAt: release.createdAt },
    // A recommendation that is no longer deployable (bootstrap artifacts
    // unpublished since the invitation was created) is not served — the
    // customer only ever sees a recommendation that can actually deploy.
    recommendedRegion:
      link.recommendedRegion !== null && env.deployableAwsRegions.includes(link.recommendedRegion)
        ? link.recommendedRegion
        : null,
    regionSelection: link.regionSelection,
    regions: SUPPORTED_AWS_REGIONS.filter((region) => env.deployableAwsRegions.includes(region)).map(
      (region) => ({ value: region, label: REGION_LABELS[region] }),
    ),
    requiredInputs: publicInstallInputs(manifest, readEnvironmentSettings(application)),
    sizing: { recommended: bounds.recommended, minimum: bounds.minimum, options: sizeOptions(bounds) },
    plan: buildInstallPlan({ manifest, region: null, profile: resolveSizeSelection(application, undefined, linkSizing(link)).profile }),
  };
}

/** The INSTALL plan for one size, plus the fingerprint the confirmation must echo. */
export type PublicInstallPlan = DeploymentPlan & {
  sizeProfile: InfrastructureSizeTier;
  /** Null when the Region cannot deploy: there is nothing to approve. */
  planFingerprint: string | null;
};

/**
 * GET /api/public-install/:linkId/plan?region=…&profile=… — the canonical
 * INSTALL plan for a selected Region + size. The footprint is the compiler's
 * own output for this manifest, Region and profile — the same compilation
 * deployment creation runs — so the preview, the price and the stack agree.
 * An undeployable or unsupported Region returns the plan with `region: null`
 * and `costEstimate: null` ("Estimate unavailable"), never a guessed cost.
 */
export async function resolvePublicInstallPlan(
  db: RuntimeDb,
  linkId: string,
  region: string,
  profileId: string | undefined,
  token?: string,
): Promise<PublicInstallPlan> {
  const { application, link } = await loadActiveLink(db, linkId, token);
  if (link.customerId !== null && link.confirmedAt !== null) {
    throw new ApiError(410, 'PUBLIC_INSTALL_LINK_USED', 'This installation link has already been used.');
  }
  const requested = profileId === undefined ? undefined : infrastructureSizeTierSchema.safeParse(profileId);
  if (requested !== undefined && !requested.success) {
    throw new ApiError(422, 'UNKNOWN_PROFILE', `Unknown infrastructure profile "${profileId}".`);
  }
  const selection = resolveSizeSelection(application, requested?.data, linkSizing(link));
  const { manifest } = await runApplicationPreflight(db, application, link.customerId);
  if (!isSupportedRegion(region) || !env.deployableAwsRegions.includes(region)) {
    const plan = buildInstallPlan({ manifest, region: null, profile: selection.profile });
    return { ...plan, region: null, costEstimate: null, sizeProfile: selection.tier, planFingerprint: null };
  }
  const footprint = compileDeploymentIntent({ manifest, region, sizeProfile: selection.profile }).spec.footprint;
  const plan = buildInstallPlan({
    manifest,
    region,
    profile: selection.profile,
    ...(footprint ? { compiledFootprint: footprint } : {}),
  });
  return {
    ...plan,
    sizeProfile: selection.tier,
    planFingerprint:
      plan.footprint && plan.costEstimate
        ? planFingerprint({ linkId: link.id, region, profile: selection.profile, footprint: plan.footprint, costEstimate: plan.costEstimate })
        : null,
  };
}

async function findConfirmedInstallLinkId(
  db: RuntimeDb,
  linkId: string,
  confirmKey: string,
): Promise<string | null> {
  const rows = await db
    .select({ installLinkId: schema.deployments.installLinkId })
    .from(schema.deployments)
    .where(
      and(eq(schema.deployments.publicInstallLinkId, linkId), eq(schema.deployments.confirmKey, confirmKey)),
    )
    .limit(1);
  return rows[0]?.installLinkId ?? null;
}

/**
 * A replay returns the deployment the key already created, so it must be for
 * the Region and size the request approves. A different selection under the
 * same key is refused: the customer would otherwise be sent to a stack they
 * did not approve.
 */
async function assertReplayMatches(db: RuntimeDb, installLinkId: string, body: PublicInstallConfirmBody): Promise<void> {
  const [replayed] = await db
    .select({ region: schema.deployments.region, desiredState: schema.deployments.desiredState })
    .from(schema.deployments)
    .where(eq(schema.deployments.installLinkId, installLinkId))
    .limit(1);
  const profile = replayed ? resolveStoredInfrastructureSizeProfile(replayed.desiredState) : undefined;
  if (!replayed || replayed.region !== body.region || profile?.id !== body.sizeProfile) {
    throw new ApiError(
      409,
      'IDEMPOTENCY_KEY_REUSED',
      'This confirmation was already used for a different Region or size. Reload the page and confirm again.',
    );
  }
}

/** Whether an error is the confirm-idempotency unique violation (the insert race). */
function isConfirmKeyViolation(error: unknown): boolean {
  for (let cause: unknown = error; cause; cause = (cause as { cause?: unknown }).cause) {
    const c = cause as { code?: string; constraint?: string };
    if (c.code === '23505') {
      return c.constraint === 'deployments_public_install_confirm_uidx';
    }
  }
  return false;
}

/**
 * POST /api/public-install/:linkId/confirm — turn an accepted review into
 * exactly one deployment plus one customer row per (link, idempotency key).
 * Gates run in order: link active (404/410 as resolve), region deployable
 * (422 REGION_NOT_SUPPORTED), preflight ready against the effective manifest
 * with the submitted keys counted as provided (422 MANIFEST_NOT_COMPATIBLE
 * / MANIFEST_NEEDS_CONFIGURATION), then the submitted config itself (422
 * with the offending keys), then the PRODUCTION subscription gate (402
 * SUBSCRIPTION_REQUIRED — the same gate POST /api/deployments and
 * createDeployLink run; replays of an already-confirmed key return the
 * existing deployment before the gate so a lapsed subscription cannot
 * strand a customer mid-flow).
 *
 * Config capture rides the SAME §31 path as vendor-entered customer
 * configuration (setConfig): non-secret values persist as plaintext
 * customer-scoped rows; secret values persist only as SECRET_MASK — the
 * plaintext never touches the control-plane DB, and the relay write-through
 * seam carries it exactly as for a vendor-typed secret on a customer whose
 * relay is not connected yet. Creates no job and touches no relay state:
 * the existing /install flow owns everything after this point.
 */
export async function confirmPublicInstall(
  db: RuntimeDb,
  linkId: string,
  body: PublicInstallConfirmBody,
  configDeps: ConfigDeps,
  token?: string,
  templatePublisher?: import('./compiler-artifact.js').TemplatePublisher,
): Promise<{ installLinkId: string; created: boolean }> {
  const { application, link } = await loadActiveLink(db, linkId, token);
  const release = await newestPublishedRelease(db, link.applicationId);
  if (release === null) {
    throw new ApiError(410, 'RELEASE_NOT_PUBLISHED', 'This application has no published release yet.');
  }
  if (!env.deployableAwsRegions.includes(body.region)) {
    throw new ApiError(
      422,
      'REGION_NOT_SUPPORTED',
      `Region ${body.region} is not available for installation yet.`,
    );
  }
  resolveSizeSelection(application, body.sizeProfile, linkSizing(link));
  // A reusable link must name its customer; a targeted invitation already does.
  if (link.customerId === null && body.customer === undefined) {
    throw new ApiError(422, 'PUBLIC_INSTALL_CUSTOMER_REQUIRED', 'A customer name and email are required.');
  }
  // A blank value is no value: it never satisfies a required input, and it
  // never reaches the deployment.
  const submitted = body.config.filter((entry) => entry.value.trim() !== '');
  const bodyKeys = [...new Set(submitted.map((entry) => entry.key))];
  const { manifest, result } = await runApplicationPreflight(db, application, link.customerId, bodyKeys);
  requirePreflightReady(result);
  const inputs = publicInstallInputs(manifest, readEnvironmentSettings(application));
  const inputsByKey = new Map(inputs.map((input) => [input.key, input]));
  const bodyKeySet = new Set(bodyKeys);
  const missing = inputs.filter((input) => input.required && !bodyKeySet.has(input.key)).map((input) => input.key);
  const unexpected = bodyKeys.filter((key) => !inputsByKey.has(key));
  // The vendor's decision says which values are secret — never the client.
  const config = submitted.map((entry) => ({ ...entry, isSecret: inputsByKey.get(entry.key)?.secret ?? true }));
  if (missing.length > 0 || unexpected.length > 0) {
    const sentences: string[] = [];
    if (missing.length > 0) sentences.push(`These values are required but missing: ${missing.join(', ')}.`);
    if (unexpected.length > 0) sentences.push(`These keys are not part of this application: ${unexpected.join(', ')}.`);
    throw new ApiError(422, 'PUBLIC_INSTALL_CONFIG_INVALID', sentences.join(' '), {
      ...(missing.length > 0 ? { missing } : {}),
      ...(unexpected.length > 0 ? { unexpected } : {}),
    });
  }

  const existing = await findConfirmedInstallLinkId(db, link.id, body.idempotencyKey);
  if (existing !== null) {
    await assertReplayMatches(db, existing, body);
    // The first attempt's post-commit materialization may have failed (a KMS
    // error) and the client is retrying. Re-bind only the staged secrets that
    // have no bound row yet; bound rows are never touched. Only before the
    // relay connects, when the secrets have not been delivered yet.
    const [replayed] = await db
      .select()
      .from(schema.deployments)
      .where(
        and(
          eq(schema.deployments.installLinkId, existing),
          inArray(schema.deployments.state, ['NOT_INSTALLED', 'WAITING_FOR_RELAY']),
        ),
      )
      .limit(1);
    if (replayed) {
      await materializePendingSecretsForDeployment(
        { pendingSecrets: configDeps.pendingSecrets, cipher: configDeps.cipher },
        {
          organizationId: replayed.organizationId,
          id: replayed.id,
          applicationId: replayed.applicationId,
          customerId: replayed.customerId,
        },
      );
    }
    return { installLinkId: existing, created: false };
  }

  // A consumed targeted invitation cannot create another deployment — but a
  // replay of the SAME idempotency key already returned above, so only a
  // DIFFERENT key on a consumed invitation reaches this check. This is the
  // friendly fast path; the transaction re-checks under a row lock below so
  // two concurrent different-key confirms still admit exactly one deployment.
  if (link.customerId !== null && link.confirmedAt !== null) {
    throw new ApiError(410, 'PUBLIC_INSTALL_LINK_USED', 'This installation link has already been used.');
  }

  // PRODUCTION deployments require an ACTIVE subscription — the same gate as
  // POST /api/deployments and createDeployLink, run before any row is created.
  await assertProductionDeploymentAllowed(db, link.organizationId, env.billingEnforcementPaused);

  const actorId = `public-install:${link.id}`;
  try {
    const deployment = await db.transaction(async (tx) => {
      // Race backstop: two different-key confirms can both pass the pre-tx
      // consumed check above. Lock the invitation row and re-check under the
      // lock — the loser gets the same 410 and its transaction rolls back. A
      // reusable link (customerId null) is never consumed, so it skips this.
      if (link.customerId !== null) {
        const locked = await tx
          .select({ confirmedAt: schema.publicInstallLinks.confirmedAt })
          .from(schema.publicInstallLinks)
          .where(eq(schema.publicInstallLinks.id, link.id))
          .for('update')
          .limit(1);
        if (locked.length === 0 || locked[0]!.confirmedAt !== null) {
          throw new ApiError(410, 'PUBLIC_INSTALL_LINK_USED', 'This installation link has already been used.');
        }
      }
      let customerId = link.customerId;
      if (customerId === null) {
        const [customer] = await tx
          .insert(schema.customers)
          .values({
            organizationId: link.organizationId,
            name: body.customer!.name,
            email: body.customer!.email,
          })
          .returning();
        customerId = customer!.id;
        await recordEvent(tx, {
          organizationId: link.organizationId,
          eventType: 'customer.created',
          actorType: 'system',
          actorId,
          customerId: customerId,
          payload: { schemaVersion: 1, customerId: customerId },
        });
      }
      // Every dep here must read through THIS transaction: PGlite is
      // single-connection, so the shared (outer-db) pending-secrets store or
      // scope finder would deadlock against the tx's own lock.
      await setConfig(link.applicationId, customerId, config, {
        ...configDeps,
        store: createConfigStore(tx),
        secretWriter: createRelaySecretWriter(tx),
        pendingSecrets: createDrizzlePendingSecretStore(tx, configDeps.cipher),
        findScopeDeployments: createScopeDeploymentsFinder(tx),
        findApplicationOrganizationId: async (applicationId) => {
          const rows = await tx
            .select({ organizationId: schema.applications.organizationId })
            .from(schema.applications)
            .where(eq(schema.applications.id, applicationId))
            .limit(1);
          return rows[0]?.organizationId;
        },
      });
      // Delivery receipt for the pre-relay configuration the customer typed:
      // counts only, never the values.
      await recordEvent(tx, {
        organizationId: link.organizationId,
        eventType: 'invitation.configuration_delivered',
        actorType: 'system',
        actorId,
        customerId,
        payload: {
          schemaVersion: 1,
          invitationId: link.id,
          applicationId: link.applicationId,
          customerId,
          inputKeyCount: config.length,
          secretInputCount: config.filter((entry) => entry.isSecret).length,
        },
      });
      const { deployment } = await createDeploymentRecord(
        tx,
        {
          organizationId: link.organizationId,
          applicationId: link.applicationId,
          customerId,
          region: body.region as Region,
          deploymentType: 'PRODUCTION',
          createdBy: null,
          updatedBy: null,
          source: 'public_link',
          publicInstallLinkId: link.id,
          confirmKey: body.idempotencyKey,
          sizeProfile: body.sizeProfile,
          linkSizing: linkSizing(link),
          approvedPlanFingerprint: body.planFingerprint,
        },
        templatePublisher ? { templatePublisher } : undefined,
      );
      await recordEvent(tx, {
        organizationId: link.organizationId,
        eventType: 'invitation.confirmed',
        actorType: 'system',
        actorId,
        customerId,
        payload: {
          schemaVersion: 1,
          invitationId: link.id,
          applicationId: link.applicationId,
          customerId,
          idempotencyKey: body.idempotencyKey,
        },
      });
      await recordEvent(tx, {
        organizationId: link.organizationId,
        eventType: 'invitation.region_selected',
        actorType: 'system',
        actorId,
        customerId,
        deploymentId: deployment.id,
        payload: { schemaVersion: 1, invitationId: link.id, region: body.region },
      });
      await recordEvent(tx, {
        organizationId: link.organizationId,
        eventType: 'invitation.deployment_created',
        actorType: 'system',
        actorId,
        customerId,
        deploymentId: deployment.id,
        payload: { schemaVersion: 1, invitationId: link.id, deploymentId: deployment.id },
      });
      // Consume a targeted invitation: it can never create another
      // deployment. A reusable link stays open for more customers.
      if (link.customerId !== null) {
        await tx
          .update(schema.publicInstallLinks)
          .set({ confirmedAt: new Date(), updatedBy: null })
          .where(eq(schema.publicInstallLinks.id, link.id));
      }
      return deployment;
    });
    // DEPLOY-027 (Phase 4) materialization hook: every staged row in the new
    // deployment's scope (vendor + this customer) becomes a bound row
    // encrypted with the deployment context. Runs OUTSIDE the tx so the
    // pending-secrets store's drizzle queries do not contend with the
    // connection the tx holds.
    await materializePendingSecretsForDeployment(
      { pendingSecrets: configDeps.pendingSecrets, cipher: configDeps.cipher },
      {
        organizationId: link.organizationId,
        id: deployment.id,
        applicationId: link.applicationId,
        customerId: deployment.customerId,
      },
    );
    return { installLinkId: deployment.installLinkId, created: true };
  } catch (error) {
    // Two concurrent confirms with the same key can both pass the pre-check.
    // The partial unique index admits exactly one insert; on a targeted
    // invitation the same-key loser may instead surface the in-tx consumed
    // re-check's 410. Either way a same-key loser replays the winner's
    // deployment instead of erroring — the pre-tx 410 fast path never reaches
    // this catch (only the transaction is wrapped in the try), and a
    // different-key loser finds no deployment for its own key and rethrows.
    if (isConfirmKeyViolation(error) || (error instanceof ApiError && error.code === 'PUBLIC_INSTALL_LINK_USED')) {
      const winner = await findConfirmedInstallLinkId(db, link.id, body.idempotencyKey);
      if (winner !== null) {
        await assertReplayMatches(db, winner, body);
        return { installLinkId: winner, created: false };
      }
    }
    throw error;
  }
}

// ── Vendor management (the org-scoped routes in server.ts) ──────────────────
//
// The vendor-side lifecycle of the same rows the public surface above reads:
// create/list/enable/disable/revoke/regenerate, all scoped to the session's
// organization (a cross-org id 404s, exactly like every other owned loader).
// A link carries no secret, so the events record ids only.

/**
 * The existing live (not revoked) reusable link for an application, if any.
 * A targeted invitation (customer_id set) is not the application's link.
 */
async function findLiveLink(db: RuntimeDb, applicationId: string): Promise<PublicInstallLinkRow | null> {
  const rows = await db
    .select()
    .from(schema.publicInstallLinks)
    .where(
      and(
        eq(schema.publicInstallLinks.applicationId, applicationId),
        isNull(schema.publicInstallLinks.revokedAt),
        isNull(schema.publicInstallLinks.customerId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function loadOwnedLink(db: RuntimeDb, id: string, organizationId: string): Promise<PublicInstallLinkRow> {
  requireUuidId(id);
  const rows = await db
    .select()
    .from(schema.publicInstallLinks)
    .where(
      and(eq(schema.publicInstallLinks.id, id), eq(schema.publicInstallLinks.organizationId, organizationId)),
    )
    .limit(1);
  if (rows.length === 0) {
    throw new NotFoundError('Install link not found');
  }
  return rows[0]!;
}

/** Whether an error is the one-live-link-per-application unique violation. */
function isOneLiveLinkViolation(error: unknown): boolean {
  for (let cause: unknown = error; cause; cause = (cause as { cause?: unknown }).cause) {
    const c = cause as { code?: string; constraint?: string };
    if (c.code === '23505') {
      return c.constraint === 'public_install_links_one_live_per_application_uidx';
    }
  }
  return false;
}

/**
 * Map the one-live-link unique violation to the 409 (the existing link id in
 * details); any other error passes through unchanged.
 */
async function toLiveLinkConflict(db: RuntimeDb, applicationId: string, error: unknown): Promise<unknown> {
  if (!isOneLiveLinkViolation(error)) {
    return error;
  }
  const existing = await findLiveLink(db, applicationId);
  if (existing === null) {
    return error;
  }
  return new ApiError(
    409,
    'PUBLIC_INSTALL_LINK_EXISTS',
    'This application already has a live public install link. Revoke it before creating a new one.',
    { id: existing.id },
  );
}

/**
 * The public web install URL. The web app's /install page resolves public
 * install links first, so the same path serves both link kinds and
 * env.webUrl (the dashboard origin) is the base.
 */
function publicInstallUrl(linkId: string): string {
  return `${env.webUrl}/install/${linkId}`;
}

/** FIXED shape: the anchor text is constant, only the opaque URL is interpolated. */
function publicInstallHtmlSnippet(url: string): string {
  return `<a href="${url}">Deploy to AWS with Deployz</a>`;
}

/** Derived vendor-side status — no separate state machine is persisted. */
function deriveStatus(link: PublicInstallLinkRow): 'active' | 'disabled' | 'revoked' {
  if (link.revokedAt !== null) return 'revoked';
  return link.enabled ? 'active' : 'disabled';
}

function toLinkView(link: PublicInstallLinkRow) {
  return {
    id: link.id,
    url: publicInstallUrl(link.id),
    status: deriveStatus(link),
    recommendedSizeProfile: link.recommendedSizeProfile,
    minimumSizeProfile: link.minimumSizeProfile,
    createdAt: link.createdAt,
    revokedAt: link.revokedAt,
  };
}

function toCreatedView(link: PublicInstallLinkRow) {
  const url = publicInstallUrl(link.id);
  return {
    id: link.id,
    url,
    htmlSnippet: publicInstallHtmlSnippet(url),
    enabled: link.enabled,
    recommendedSizeProfile: link.recommendedSizeProfile,
    minimumSizeProfile: link.minimumSizeProfile,
    createdAt: link.createdAt,
  };
}

/**
 * Ensure at least one deployable release exists for the application before a
 * public install link is created. If no published release exists, auto-create
 * one from the analyzed snapshot so the vendor never needs to publish manually.
 */
async function ensureInitialRelease(
  db: RuntimeDb,
  application: typeof schema.applications.$inferSelect,
  userId: string,
): Promise<void> {
  const existing = await newestPublishedRelease(db, application.id);
  if (existing !== null) return;

  await ensureBuildConfigurationReady(db, application);

  const sha: string | undefined = (application.detectedMetadata as Record<string, unknown> | null)?.['analysisCommitSha'] as string | undefined;
  if (typeof sha !== 'string' || sha.length === 0) {
    throw new ApiError(
      422,
      'RELEASE_NOT_PUBLISHED',
      'This application has no published release and its analysis snapshot is missing a commit SHA. Re-analyse the application first.',
    );
  }

  // Idempotency guard: if a release already exists for this commit (by gitSha
  // or version) don't create a duplicate — the initial snapshot could still
  // be building, ready, or failed.
  const duplicate = await db
    .select({ id: schema.releases.id })
    .from(schema.releases)
    .where(
      and(
        eq(schema.releases.applicationId, application.id),
        or(eq(schema.releases.gitSha, sha), eq(schema.releases.version, sha.slice(0, 12))),
      ),
    )
    .limit(1);
  if (duplicate.length > 0) return;

  await createReleaseRecord(db, {
    organizationId: application.organizationId,
    userId,
    applicationId: application.id,
    version: sha.slice(0, 12),
    gitSha: sha,
  });
}

export interface PublicInstallLinkActorParams {
  organizationId: string;
  userId: string;
  linkId: string;
}

export interface CreateInstallationInvitationParams {
  organizationId: string;
  userId: string;
  applicationId: string;
  customerId: string;
  /** Optional vendor recommendation — never the final Region choice. */
  recommendedRegion?: Region;
  /** Optional size recommendation for this customer; absent = the application default. */
  recommendedSizeProfile?: InfrastructureSizeTier;
}

/**
 * The sizing a new link freezes: the vendor's per-link recommendation (or the
 * application default) and the application's current minimum. Later edits
 * to the application never change a link that already exists.
 */
function frozenLinkSizing(
  application: typeof schema.applications.$inferSelect,
  recommended: InfrastructureSizeTier | undefined,
): { recommendedSizeProfile: InfrastructureSizeTier; minimumSizeProfile: InfrastructureSizeTier } {
  const recommendedSizeProfile = recommended ?? application.defaultSizeProfile;
  assertSizeSettingsValid(recommendedSizeProfile, application.minimumSizeProfile);
  return { recommendedSizeProfile, minimumSizeProfile: application.minimumSizeProfile };
}

/**
 * POST /api/customers/:customerId/invitations — create a TARGETED invitation
 * for a customer + application WITHOUT creating a deployment. The vendor may
 * recommend a Region; the customer makes the final choice at confirmation.
 * Returns the one-time token (stored only as its sha256); the URL is
 * reconstructable from `link.id` + `token` and is never re-revealed.
 */
export async function createInstallationInvitation(
  db: RuntimeDb,
  params: CreateInstallationInvitationParams,
): Promise<{ link: PublicInstallLinkRow; token: string }> {
  const application = await loadOwnedApplication(db, params.applicationId, params.organizationId);
  await loadOwnedCustomer(db, params.customerId, params.organizationId);
  const sizing = frozenLinkSizing(application, params.recommendedSizeProfile);
  const token = mintDeployLinkToken();
  const [link] = await db
    .insert(schema.publicInstallLinks)
    .values({
      organizationId: params.organizationId,
      applicationId: params.applicationId,
      customerId: params.customerId,
      recommendedRegion: params.recommendedRegion ?? null,
      ...sizing,
      regionSelection: 'customer',
      tokenHash: hashRelayToken(token),
      expiresAt: new Date(Date.now() + DEFAULT_INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000),
      enabled: false,
      createdBy: params.userId,
      updatedBy: params.userId,
    })
    .returning();
  await recordEvent(db, {
    organizationId: params.organizationId,
    eventType: 'invitation.created',
    actorType: 'user',
    actorId: params.userId,
    customerId: params.customerId,
    payload: {
      schemaVersion: 1,
      applicationId: params.applicationId,
      invitationId: link!.id,
      customerId: params.customerId,
      recommendedRegion: params.recommendedRegion ?? null,
      expiresAt: link!.expiresAt,
    },
  });
  return { link: link!, token };
}

/**
 * POST /api/applications/:id/public-install-links — create + enable the
 * application's live link. The partial unique index admits exactly one live
 * link per application; the loser of the insert race gets the existing link's
 * id in the 409 details.
 */
export async function createPublicInstallLink(  db: RuntimeDb,
  params: { organizationId: string; userId: string; applicationId: string; recommendedSizeProfile?: InfrastructureSizeTier },
) {
  const application = await loadOwnedApplication(db, params.applicationId, params.organizationId);
  const sizing = frozenLinkSizing(application, params.recommendedSizeProfile);
  await ensureInitialRelease(db, application, params.userId);
  try {
    const link = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(schema.publicInstallLinks)
        .values({ organizationId: params.organizationId, applicationId: application.id, enabled: true, ...sizing })
        .returning();
      await recordEvent(tx, {
        organizationId: params.organizationId,
        eventType: 'public_install_link.created',
        actorType: 'user',
        actorId: params.userId,
        payload: { applicationId: application.id, linkId: row!.id },
      });
      return row!;
    });
    return toCreatedView(link);
  } catch (error) {
    throw (await toLiveLinkConflict(db, application.id, error));
  }
}

/**
 * GET /api/applications/:id/public-install-links — the application's reusable
 * links, newest first, derived status. Targeted invitations are listed per
 * customer (listCustomerInvitations), never here.
 */
export async function listPublicInstallLinks(db: RuntimeDb, organizationId: string, applicationId: string) {
  const rows = await db
    .select()
    .from(schema.publicInstallLinks)
    .where(
      and(
        eq(schema.publicInstallLinks.organizationId, organizationId),
        eq(schema.publicInstallLinks.applicationId, applicationId),
        isNull(schema.publicInstallLinks.customerId),
      ),
    )
    .orderBy(desc(schema.publicInstallLinks.createdAt));
  return rows.map(toLinkView);
}

/** Derived customer-side invitation status — nothing is persisted. */
export type InvitationStatus = 'active' | 'expired' | 'revoked' | 'used';

/**
 * GET /api/customers/:customerId/invitations — the customer's TARGETED
 * invitations (customer_id set), org-scoped, newest first, each with the
 * derived status. tokenHash and confirmedAt are never returned; the derived
 * status carries the state.
 */
export async function listCustomerInvitations(db: RuntimeDb, organizationId: string, customerId: string) {
  const rows = await db
    .select({
      id: schema.publicInstallLinks.id,
      applicationName: schema.applications.name,
      recommendedRegion: schema.publicInstallLinks.recommendedRegion,
      regionSelection: schema.publicInstallLinks.regionSelection,
      recommendedSizeProfile: schema.publicInstallLinks.recommendedSizeProfile,
      expiresAt: schema.publicInstallLinks.expiresAt,
      createdAt: schema.publicInstallLinks.createdAt,
      confirmedAt: schema.publicInstallLinks.confirmedAt,
      revokedAt: schema.publicInstallLinks.revokedAt,
    })
    .from(schema.publicInstallLinks)
    .innerJoin(schema.applications, eq(schema.publicInstallLinks.applicationId, schema.applications.id))
    .where(
      and(
        eq(schema.publicInstallLinks.organizationId, organizationId),
        eq(schema.publicInstallLinks.customerId, customerId),
      ),
    )
    .orderBy(desc(schema.publicInstallLinks.createdAt));
  const now = Date.now();
  return rows.map((row) => {
    let status: InvitationStatus = 'active';
    if (row.confirmedAt !== null) status = 'used';
    else if (row.revokedAt !== null) status = 'revoked';
    else if (row.expiresAt !== null && row.expiresAt.getTime() < now) status = 'expired';
    return {
      id: row.id,
      applicationName: row.applicationName,
      recommendedRegion: row.recommendedRegion,
      regionSelection: row.regionSelection,
      recommendedSizeProfile: row.recommendedSizeProfile,
      status,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
    };
  });
}

/**
 * POST /api/public-install-links/:id/enable|disable — idempotent flips. A
 * revoked link is terminal and refuses to re-enable.
 */
export async function setPublicInstallLinkEnabled(
  db: RuntimeDb,
  params: PublicInstallLinkActorParams & { enabled: boolean },
) {
  const link = await loadOwnedLink(db, params.linkId, params.organizationId);
  if (params.enabled && link.revokedAt !== null) {
    throw new ApiError(
      409,
      'PUBLIC_INSTALL_LINK_REVOKED',
      'This installation link has been revoked and cannot be enabled again.',
    );
  }
  if (link.enabled === params.enabled) {
    return toLinkView(link);
  }
  const [updated] = await db
    .update(schema.publicInstallLinks)
    .set({ enabled: params.enabled })
    .where(
      and(
        eq(schema.publicInstallLinks.id, link.id),
        eq(schema.publicInstallLinks.organizationId, params.organizationId),
      ),
    )
    .returning();
  await recordEvent(db, {
    organizationId: params.organizationId,
    eventType: params.enabled ? 'public_install_link.enabled' : 'public_install_link.disabled',
    actorType: 'user',
    actorId: params.userId,
    payload: { applicationId: link.applicationId, linkId: link.id },
  });
  return toLinkView(updated!);
}

/** POST /api/public-install-links/:id/revoke — idempotent; sets revoked_at. */
export async function revokePublicInstallLink(db: RuntimeDb, params: PublicInstallLinkActorParams) {
  const link = await loadOwnedLink(db, params.linkId, params.organizationId);
  if (link.revokedAt !== null) {
    return toLinkView(link);
  }
  const [updated] = await db
    .update(schema.publicInstallLinks)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(schema.publicInstallLinks.id, link.id),
        eq(schema.publicInstallLinks.organizationId, params.organizationId),
      ),
    )
    .returning();
  await recordEvent(db, {
    organizationId: params.organizationId,
    eventType: 'public_install_link.revoked',
    actorType: 'user',
    actorId: params.userId,
    payload: { applicationId: link.applicationId, linkId: link.id },
  });
  await recordEvent(db, {
    organizationId: params.organizationId,
    eventType: 'invitation.revoked',
    actorType: 'user',
    actorId: params.userId,
    payload: { schemaVersion: 1, applicationId: link.applicationId, invitationId: link.id },
  });
  return toLinkView(updated!);
}

/**
 * POST /api/public-install-links/:id/regenerate — revoke the current link and
 * issue a fresh one (fresh random id) in one transaction. Same gates as
 * create: a published release or auto-created one, and no OTHER live link for
 * the application.
 */
export async function regeneratePublicInstallLink(db: RuntimeDb, params: PublicInstallLinkActorParams) {
  const link = await loadOwnedLink(db, params.linkId, params.organizationId);
  const application = await loadOwnedApplication(db, link.applicationId, params.organizationId);
  await ensureInitialRelease(db, application, params.userId);
  try {
    const fresh = await db.transaction(async (tx) => {
      if (link.revokedAt === null) {
        await tx
          .update(schema.publicInstallLinks)
          .set({ revokedAt: new Date() })
          .where(eq(schema.publicInstallLinks.id, link.id));
      }
      // The fresh link keeps the replaced link's recommendation but takes the
      // application's current minimum; a recommendation below it is raised.
      const minimumSizeProfile = application.minimumSizeProfile;
      const kept = link.recommendedSizeProfile ?? application.defaultSizeProfile;
      const [row] = await tx
        .insert(schema.publicInstallLinks)
        .values({
          organizationId: params.organizationId,
          applicationId: link.applicationId,
          enabled: true,
          recommendedSizeProfile: sizeTierMeetsMinimum(kept, minimumSizeProfile) ? kept : minimumSizeProfile,
          minimumSizeProfile,
        })
        .returning();
      await recordEvent(tx, {
        organizationId: params.organizationId,
        eventType: 'public_install_link.regenerated',
        actorType: 'user',
        actorId: params.userId,
        payload: { applicationId: link.applicationId, linkId: row!.id, replacedLinkId: link.id },
      });
      await recordEvent(tx, {
        organizationId: params.organizationId,
        eventType: 'invitation.regenerated',
        actorType: 'user',
        actorId: params.userId,
        payload: {
          schemaVersion: 1,
          applicationId: link.applicationId,
          invitationId: row!.id,
          replacedLinkId: link.id,
        },
      });
      return row!;
    });
    return toCreatedView(fresh);
  } catch (error) {
    throw (await toLiveLinkConflict(db, link.applicationId, error));
  }
}
