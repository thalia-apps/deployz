import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { setupFastifyErrorHandler } from '@sentry/node';
import { createHash } from 'node:crypto';
import { fromNodeHeaders } from 'better-auth/node';
import { and, desc, eq, getTableColumns, gt, gte, inArray, isNull, like, ne, notInArray, sql } from 'drizzle-orm';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import { z } from 'zod';

import {
  FIX_INSTRUCTIONS_TIMEOUT_MS,
  applicationGraphHash,
  createAiGateway,
  generateFixInstructions,
  manifestToApplicationGraph,
  normalizeDeploymentManifest,
  readApplicationAnalysis,
  redactSecrets,
  verdictFromReadiness,
  type AiGateway,
  type PassedCheck,
  type ReadinessFinding,
  type ReadinessState,
  type StructuredEvent,
} from '@deployz/analysis';
import {
  DESTROY_PENDING_STALE_AFTER_MS,
  DEPLOYMENT_MANIFEST_SCHEMA_VERSION,
  APP_API_KEY_PARAMETER,
  APP_SIGNING_SECRET_PARAMETER,
  REGION_LABELS,
  RELAY_STALE_AFTER_MS,
  SUPPORTED_AWS_REGIONS,
  aggregateInfrastructureComponents,
  billingSubscriptionStatusSchema,
  bootstrapStackName,
  buildBootstrapQuickCreateUrl,
  buildDestroyPlan,
  buildInstallPlan,
  buildUpdatePlan,
  compareInfrastructureExpectations,
  applicationStackNameForInstallation,
  applyEnvironmentBindings,
  deployzProvidableKeys,
  deploymentPlanSchema,
  deploymentStateAfterFailedJob,
  deploymentTypeSchema,
  environmentSettingsSchema,
  failureCodeSchema,
  provisionedResources,
  validateEnvironmentSettings,
  evaluateReleaseEvidence,
  failureEvidenceSchema,
  healthComponentsSchema,
  healthStatusSchema,
  httpProbeSchema,
  infrastructureResponseSchema,
  infrastructureSizeTierSchema,
  currentInfrastructureSizeProfile,
  isSupportedRegion,
  ownershipClassificationsFromSpec,
  regionSchema,
  relayCapabilitiesSchema,
  relayCommandProgressSchema,
  releaseEvidenceSchema,
  requiredInfrastructureComponents,
  requirementsFromSpec,
  migrationTaskFromSpec,
  oneShotTasksFromSpec,
  resourceChecksFromSpec,
  resolveBootstrapTemplate,
  profileKey,
  resolveStoredInfrastructureSizeProfile,
  summarizeApplicationGraph,
  summarizeInfrastructureStatus,
  topologyDriftFor,
  workloadServicesFromSpec,
  type ApplicationAnalysis,
  type ApplicationGraphSummary,
  type ApplicationRequirementsSummary,
  type BillingSubscriptionStatus,
  type CustomerDeploymentStatus,
  type ExpectedWorkload,
  type DeploymentManifest,
  type DeploymentPlan,
  type InfrastructureChange,
  type InfrastructureComponentStatus,
  type InfrastructureSummaryStatus,
  type PlanComponentGroup,
  type ResourceKind,
  type VendorStackEvent,
} from '@deployz/contracts';
import { FAILURE_REMEDIATION, failureRecoverability, type FailureCode } from '@deployz/copy-map';
// Deep import so the Lambda bundle never touches @deployz/db's package root:
// the root re-exports client.ts, whose PGlite dev fallback is external in the
// Lambda bundle and crashes cold start with Runtime.ImportModuleError.
import {
  persistDeploymentResourceSnapshot,
  type ObservedStackResource,
} from '@deployz/db/deployment-resources-persist';
import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import type { Auth } from './auth.js';
import { resolveExplanation, type ExplanationText } from './ai-explanation.js';
import { createFixtureAiGateway } from './ai-fixture.js';
import {
  ANALYSIS_VERSION,
  createAnalysisRunner,
  legacySavedFields,
  readVendorOverrides,
  type AnalysisRunner,
  type AttentionCheck,
  type ReadyCheck,
  type UnsupportedCheck,
} from './analysis.js';
import {
  buildFixInstructionsContext,
  effectiveReadinessReport,
  fixInstructionsCacheKey,
  readCachedFixInstructions,
} from './fix-instructions.js';
import { completePendingCheckoutIntent, createCheckoutIntent } from './billing-checkout.js';
import {
  isBillableDeployment,
  productionDeploymentCounts,
  PLATFORM_PRICE_DOLLARS,
  DEPLOYMENT_PRICE_DOLLARS,
} from './billing-domain.js';
import { markDeploymentLive, markDeploymentRemoved } from './billing-lifecycle.js';
import { createBillingPortalLinks } from './billing-portal.js';
import { reconcileBilling } from './billing-reconcile.js';
import { handlePaddleWebhook } from './billing-webhooks.js';
import { createPaddle, type PaddleBilling } from './paddle.js';
import {
  createConfigStore,
  createConfigurableCustomersFinder,
  createRelaySecretWriter,
  createScopeDeploymentsFinder,
  getConfig,
  listProvidedConfigKeys,
  listVendorValues,
  SECRET_MASK,
  setConfig,
  setConfigBodySchema,
  type ConfigDeps,
} from './config.js';
import { FIX_INSTRUCTIONS_AI_PROBLEMS } from './ai-config.js';
import { env } from './env.js';
import { ApiError, NotFoundError, UnauthorizedError, toErrorEnvelope } from './errors.js';
import {
  createAppJwt,
  createGithubStore,
  fetchInstallationAccount,
  getCommit,
  getFixtureCommit,
  handleInstallationWebhook,
  listBranchCommits,
  listFixtureBranchCommits,
  listInstallations,
  listRepositories,
  mintInstallationToken,
  parseRepoFullName,
  verifyWebhookSignature,
  type FetchFn,
  type GithubWebhookEvent,
} from './github.js';
import {
  createJevFailureShadowRunnerFromEnv,
  createJevShadowRunnerFromEnv,
  type JevFailureShadowRunner,
} from './jev-shadow.js';
import { createEmailSender, type EmailSender } from './email.js';
import type { EcrClient } from './ecr-grants.js';
import {
  createEcrPullGrantDeps,
  grantPullToCustomer,
  revokePullFromCustomer,
  type EcrPullGrantDeps,
} from './ecr-pull-grants.js';
import { refineFailureCode } from './failure-classification.js';
import { readInstallVerification, unverifiedInstall } from './install-verification.js';
import {
  createFixtureReleaseImageClient,
  createRealReleaseImageClient,
  refreshReleaseImageAvailability,
  releaseWireStatus,
  requireReleaseImageAvailable,
  type ReleaseImageClient,
} from './release-images.js';
import { buildFailureContext, toStructuredEvent } from './failure-context.js';
import { createDrizzlePendingSecretStore, createSecretCipherFromEnv } from './pending-secrets.js';
import { retryEligibilityFor } from './retry-eligibility.js';
import { buildInstallPayload, buildRelayConfigEntries, queuePostInstallConfig, requireTaskFamilySuffix } from './install-config.js';
import { requirePreflightReady, runApplicationPreflight, runDeploymentPreflight } from './preflight.js';
import {
  confirmPublicInstall,
  createInstallationInvitation,
  createPublicInstallLink,
  listCustomerInvitations,
  listPublicInstallLinks,
  publicInstallConfirmBodySchema,
  regeneratePublicInstallLink,
  resolvePublicInstall,
  resolvePublicInstallPlan,
  revokePublicInstallLink,
  setPublicInstallLinkEnabled,
} from './public-install.js';
import { createReleaseRecord, ensureBuildConfigurationReady } from './releases.js';
import { evaluateForApplication, readEnvironmentSettings } from './environment-setup.js';
import {
  awaitsFirstStart,
  createOrReuseJob,
  hasStartedInstall,
  newerReadyReleaseExists,
} from './jobs.js';
import {
  applicationToManifestOverrides,
  derivationApplicationFor,
  readStoredDeploymentSpec,
  readStoredManifest,
  type ManifestApplicationRow,
} from './manifest.js';
import {
  createS3TemplatePublisher,
  NO_OP_TEMPLATE_PUBLISHER,
  type TemplatePublisher,
} from './compiler-artifact.js';
import { enqueue } from './queue.js';
import {
  acceptInvitation,
  activateOrganization,
  createInvitation,
  createOrganization,
  createOrganizationBodySchema,
  deleteAccount,
  deleteAccountBodySchema,
  deleteOrganization,
  deleteOrganizationBodySchema,
  inviteMemberBodySchema,
  getPublicInvitation,
  getSubscriptionStatus,
  leaveOrganization,
  listInvitations,
  listInvitationsForEmail,
  listMembers,
  listOrganizations,
  rejectInvitation,
  removeMember,
  resendInvitation,
  revokeInvitation,
  transferOwnership,
  transferOwnershipBodySchema,
  updateMemberRole,
  updateMemberRoleBodySchema,
  updateOrganization,
  updateOrganizationBodySchema,
  type Actor,
  type OrganizationDeps,
} from './organizations.js';
import { recordEvent, type DeploymentEventType } from './events.js';
import { revokeInstallLink, rotateInstallLink } from './install-link-lifecycle.js';
import { createFixtureDomainCheckDeps, createRealDomainCheckDeps, type DomainCheckDeps } from './domain-check.js';
import {
  createDefaultHttpsFixtureProvider,
  type DefaultHttpsFixtureProvider,
  type FixtureDnsFailureCode,
} from './default-https-fixture.js';
import {
  applyDomainJobResult,
  createCustomDomain,
  findActiveDomain,
  isDomainJobType,
  removeCustomDomain,
  runDomainCheck,
  toDomainView,
  type CustomDomainRow,
} from './domains.js';
import { connectorUpdateLinks, connectorUpdateOffer, type ConnectorUpdateOffer } from './connector-update.js';
import {
  deriveDeploymentStatus,
  endpointHttpsState,
  endpointStatusForHttpsState,
  mergeComponentState,
  primaryServiceLogicalIds,
  toCustomerDeploymentStatus,
  toVendorDeploymentStatus,
  type DerivedDeploymentStatus,
} from './deployment-status.js';
import {
  buildCustomerLiveProgress,
  type CustomerLiveProgress,
  type LiveHttpsState,
} from './customer-activity.js';
import {
  planComponentsFromSpec,
  specComponentIdentityByLogicalId,
  specComponentLabelByLogicalId,
  specComponentsForStatus,
} from './spec-components.js';
import {
  createDeployLink,
  createDeploymentRecord,
  listDeployLinks,
  materializePendingSecretsForDeployment,
  regenerateDeployLink,
  resolveDeployLink,
  revokeDeployLink,
  type DeployLinkRow,
} from './deploy-links.js';
import { assertSizeSettingsValid } from './deployment-size.js';
import {
  assertProductionDeploymentAllowed,
  assertTestDeploymentSlot,
  isTestDeploymentSlotViolation,
} from './billing-entitlements.js';
import {
  DEFAULT_HTTPS_APEX,
  DEFAULT_HTTPS_FIXTURE_APEX,
  applyDefaultHttpsJobResult,
  beginDefaultHttpsRemoval,
  isDefaultHttpsJob,
  parseDefaultHttps,
  reconcileOrphanedDefaultRecords,
  runDefaultHttpsCheck,
  type DefaultHttpsDeps,
  type DefaultHttpsState,
} from './default-https.js';
import {
  createCloudflareDnsClient,
  createDnsClientFromNameWriter,
  noopDnsRecordClient,
} from './cloudflare-records.js';
import {
  resolveAppUrl,
  resolveDefaultUrl,
  toFleetRow,
  type DeploymentJobRow,
  type DeploymentRow,
} from './fleet-row.js';
import { advanceStepTimings } from './step-timings.js';
import {
  hashRelayToken,
  mintEnrollmentCode,
  mintRelayCredential,
  verifyRelayToken,
  verifyRelayTokenWithRotation,
} from './relay-store.js';
import {
  INSTALL_FAILURE_STACK_STATUSES,
  summarizeStackEvents,
  type StoredStackEvent,
} from './stack-event-progress.js';
import { createRequireAuth, requireRole, type OrganizationRow } from './require-auth.js';
import { createRequireTeamAdmin, isTeamAdmin } from './admin/auth.js';
import { registerAdminRoutes } from './admin/routes.js';
import {
  BUILD_EXPLANATION_TIMEOUT_MS,
  buildFailureDetails,
  createCloudWatchBuildLogReader,
  explainBuildFailure,
  readReleaseBuildLog,
  type BuildLogReader,
} from './release-build-failure.js';

export interface ServerDeps {
  auth: Auth;
  db: RuntimeDb;
  // Injectable GitHub seams for tests (the real values come from env). The
  // webhook secret is required to verify signatures; fixtureMode flips the
  // repo/installations routes to the fixture store.
  githubWebhookSecret?: string | undefined;
  githubFixtureMode?: boolean | undefined;
  // The App install URL offered by the "Connect GitHub" empty state. An empty
  // string means "not configured" (same as the webhook secret), which is what
  // lets a test assert the unconfigured screen on a machine that has a .env.
  githubAppInstallUrl?: string | undefined;
  // Injectable §18/§19 analysis runner for POST /:id/analyse (real
  // implementation hits GitHub; tests can supply a fake instead). Defaults
  // to analysis.ts's createAnalysisRunner wired to env/fixture GitHub deps.
  analysisRunner?: AnalysisRunner | undefined;
  // Injectable transactional-email seam (invitations, membership changes).
  // Defaults to email.ts's env-driven sender; tests supply a recorder.
  emailSender?: EmailSender | undefined;
  // Injectable fetch for the GitHub App calls (token minting, installation
  // lookup). Defaults to global fetch; tests supply a stub so no request
  // ever leaves the machine.
  githubFetch?: FetchFn | undefined;
  // The App's own credentials. Default to env; injectable so the App routes
  // are testable on a machine (or a CI runner) with no .env.
  githubAppId?: string | undefined;
  githubAppPrivateKey?: string | undefined;
  // Injectable logger, so a test can read back what a failing request
  // reported. Production uses the default below.
  loggerInstance?: FastifyBaseLogger | undefined;
  // Injectable §16/§29 AI gateway for diagnostic explanations. Defaults to the
  // env-configured Cloudflare AI Gateway, which degrades to a throwing stub
  // when unconfigured so diagnostics fall back to deterministic remediation.
  aiGateway?: AiGateway | undefined;
  // Injectable gateway for the coding-agent fix instructions, which run on
  // their own model (FIX_INSTRUCTIONS_AI_*, ai-config.ts). Defaults to the
  // env-configured one; the route answers 503 not_configured when it has none.
  fixInstructionsAiGateway?: AiGateway | undefined;
  // Injectable Jev UNKNOWN-failure shadow runner (telemetry only). Defaults to
  // the env-configured Jev client, which degrades to a noop when Jev is
  // disabled — the failure flow is identical either way.
  jevFailureShadow?: JevFailureShadowRunner | undefined;
  // Injectable custom-domains MVP DNS/HTTPS-probe seam (runDomainCheck).
  // Defaults to env.domainFixtureMode's real-vs-fixture split; tests inject a
  // fake so no real DNS lookup or HTTPS probe ever leaves the machine.
  domainCheckDeps?: DomainCheckDeps | undefined;
  // Injectable Phase 11 default-HTTPS seam. Defaults to env: the flow is ON
  // only when a Route53 zone is configured (or under DNS fixture mode), the
  // record writer is then the real Route53 client, and the HTTPS probe reuses
  // domainCheckDeps. Tests inject fakes so nothing touches real AWS.
  defaultHttpsDeps?: DefaultHttpsDeps | undefined;
  // Injectable Team Admin identity (docs/admin/team-admin.md). Defaults to
  // env; tests override to enable env-grants without a Lambda-shaped env.
  teamAdminEmails?: string[] | undefined;
  teamAdminEnvGrantsEnabled?: boolean | undefined;
  // Injectable ECR repository-policy seam for the Phase 1.1 install-grant /
  // destroy-revoke lifecycle. Defaults to the real SDK client; tests inject a
  // recorder so no ECR call ever leaves the machine.
  ecrClient?: EcrClient | undefined;
  // Injectable release-image availability seam (release-images.ts). Defaults
  // to the real registry client in the deployed Lambda and to the scriptable
  // fixture everywhere else; tests inject a fake.
  releaseImages?: ReleaseImageClient | undefined;
  // Injectable failed-build log seam (release-build-failure.ts). Defaults to
  // the real log reader when BUILD_LOG_GROUP_NAME is set (the deployed
  // Lambda) and to none elsewhere; tests inject a fake. Null means no reader.
  buildLogReader?: BuildLogReader | null | undefined;
  // Injectable Phase 5 Paddle billing seam (paddle.ts). Defaults to
  // env-configured createPaddle(), which is null when PADDLE_API_KEY is
  // unset; tests inject a fake PaddleBilling so no real Paddle call ever
  // leaves the machine.
  paddle?: PaddleBilling | null | undefined;
  // Injectable Paddle migration Phase 7 fixture-mode override. Defaults to
  // env.billingFixtureMode; mirrors githubFixtureMode's `?? env.x` pattern.
  // When on, POST /api/organizations seeds a fixture ACTIVE subscription
  // (organizations.ts) and the fixture-only
  // POST /internal/fixture/billing/subscription route below exists.
  billingFixtureMode?: boolean | undefined;
  // Injectable compiler-v2 template-publication seam (compiler-artifact.ts).
  // Defaults to the real S3 publisher in the deployed Lambda and to a no-op
  // everywhere else; tests inject a recorder so no S3 call ever leaves the
  // machine.
  templatePublisher?: TemplatePublisher | undefined;
}

// application/deployment/release ids are uuid-keyed columns. A non-uuid id
// would raise a Postgres "invalid input syntax for type uuid" error and
// surface as a 500, so non-uuid ids map to 404 instead.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Route-level rate limit for the unauthenticated /api/install/:id routes and
// the public /api/deploy-links/:publicId resolve route (registered with
// @fastify/rate-limit's `global: false` above, so nothing else is capped by
// default). Keyed by IP (trustProxy makes that the
// real client behind the API Gateway); 300/min is an order of
// magnitude over the install page's 5s poll cadence (12/min) — several tabs,
// "Check now" clicks, and NAT'd offices all fit — while still bounding an
// anonymous caller who has nothing but a guessable-length uuid to try.
const PUBLIC_INSTALL_RATE_LIMIT = { max: 300, timeWindow: '1 minute' } as const;

// Commit selector routes hit GitHub's API on every call (no caching) — capped
// well under GitHub's own per-installation rate limits while comfortably
// covering normal use (opening the release picker, paging, typing a sha).
const GITHUB_COMMITS_RATE_LIMIT = { max: 60, timeWindow: '1 minute' } as const;

// Failed-build evidence reads the build log (a few log-service calls per
// request); the AI explanation spends model tokens. Both are on-demand
// clicks, so these caps only bound a script, never a person.
const BUILD_FAILURE_RATE_LIMIT = { max: 30, timeWindow: '1 minute' } as const;
const BUILD_EXPLANATION_RATE_LIMIT = { max: 5, timeWindow: '1 minute' } as const;

// A refused relay retries registration indefinitely, so only the first
// blocked preflight evaluation per window is recorded per deployment — the
// blockingCount still travels on the one event that is kept.
const RELAY_BLOCKED_PREFLIGHT_THROTTLE_MS = 15 * 60 * 1000;

// The §35 contract fields the analyser auto-detects and the vendor can take
// ownership of by editing them (see PATCH /api/applications/:id). `name` is
// not one — the analyser never writes it. `workerCommand` is NOT one either
// (Phase 8): background worker processes are deferred, so the worker command
// is analysis-recorded but never vendor-configurable.
const CONTRACT_FIELDS = [
  'containerPort',
  'healthPath',
  'migrationCommand',
  'databaseRequired',
  'storageRequired',
  'redisRequired',
] as const;

/**
 * The manifest-only vendor overrides (Phase 2) — no applications column backs
 * them, so they live on `detected_metadata.manifestOverrides` instead of being
 * recorded as claimed column fields. `redisRequired` IS column-backed and stays
 * in CONTRACT_FIELDS above.
 */
const fixInstructionsBodySchema = z.object({ regenerate: z.boolean().optional() });

const MANIFEST_OVERRIDE_FIELDS = [
  'appRoot',
  'dockerfilePath',
  'buildContext',
  'buildCommand',
  'startCommand',
] as const;

function requireUuidId(id: string): void {
  if (!UUID_PATTERN.test(id)) {
    throw new NotFoundError('Resource not found');
  }
}

/**
 * Reject a malformed uuid in a QUERY parameter with a 400, not a 404: an
 * absent filter is legitimate, a malformed one is a bad request. Unchecked,
 * the value reached the uuid column and Postgres raised, which surfaced as a
 * bare 500 with no error envelope.
 */
function requireUuidQueryParam(value: string | undefined, field: string): void {
  if (value !== undefined && !UUID_PATTERN.test(value)) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${field} must be a valid identifier.`);
  }
}

// Resolves the organization id from the AUTHENTICATED SESSION ONLY (§S1: the
// client can never assert its own org). Earlier this also accepted an
// `organizationId` query param, which let any signed-in user read another
// org's data by passing `?organizationId=<other-org>` — that fallback is
// gone; the session's active organization is the sole source of truth.
function organizationIdFromRequest(request: { organization?: { id: string } | undefined }): string {
  return request.organization?.id ?? '';
}

/** Session org, or 401 when the request has none. Every authed route needs this. */
function requireSessionOrganizationId(request: { organization?: { id: string } | undefined }): string {
  const organizationId = organizationIdFromRequest(request);
  if (!organizationId) {
    throw new ApiError(401, 'UNAUTHORIZED', 'An organization is required');
  }
  return organizationId;
}

/** Session organization row, or 401 when the request has none. */
function requireSessionOrganization(request: FastifyRequest): OrganizationRow {
  const organization = request.organization;
  if (!organization) {
    throw new ApiError(401, 'UNAUTHORIZED', 'An organization is required');
  }
  return organization;
}

/** The signed-in user as an audit/email actor. */
function requireActor(request: FastifyRequest): Actor {
  const user = request.user;
  if (!user) {
    throw new UnauthorizedError();
  }
  return { id: user.id, name: user.name, email: user.email };
}

/** The caller's session row id — the tenant pointer writes target it. */
function requireSessionId(request: FastifyRequest): string {
  const sessionId = request.sessionId;
  if (!sessionId) {
    throw new UnauthorizedError();
  }
  return sessionId;
}

/**
 * Resolves the org to write into a create body: always the session org.
 * Some clients may still send a body `organizationId` (legacy payload
 * shape) — if they do, and it disagrees with the session, that is either a
 * bug or an attempted cross-org write, so it is rejected outright rather
 * than silently overridden.
 */
function resolveWriteOrganizationId(
  request: { organization?: { id: string } | undefined },
  bodyOrganizationId: string | undefined,
): string {
  const organizationId = requireSessionOrganizationId(request);
  if (bodyOrganizationId !== undefined && bodyOrganizationId !== organizationId) {
    throw new ApiError(
      403,
      'ORGANIZATION_MISMATCH',
      'organizationId does not match the authenticated session organization',
    );
  }
  return organizationId;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * A caller-supplied Idempotency-Key, scoped to one deployment and one job
 * type. Job keys are unique across ALL deployments, so an unscoped header let
 * a key used anywhere (another deployment, another tenant, another operation)
 * hand back that other job instead of running this one.
 */
function clientIdempotencyKey(
  request: { headers: Record<string, string | string[] | undefined> },
  deploymentId: string,
  type: JobType,
): string | undefined {
  const header = firstHeaderValue(request.headers['idempotency-key']);
  return header === undefined ? undefined : `${deploymentId}:${type}:client:${header}`;
}

// ── Ownership-scoped loaders (IDOR guards) ──────────────────────────────────
//
// Every :id route below MUST resolve its resource through one of these
// instead of a bare `where(eq(table.id, id))` lookup — an id-only lookup lets
// any authenticated user reach any org's rows just by knowing (or guessing)
// a UUID. On a mismatch these throw NotFoundError (404), not 403: whether the
// resource exists at all must not leak to a caller who cannot see it.

type ApplicationRow = typeof schema.applications.$inferSelect;
type CustomerRow = typeof schema.customers.$inferSelect;
type JobType = (typeof schema.deploymentJobs.$inferSelect)['type'];

async function loadOwnedApplication(
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

async function loadOwnedDeployment(
  db: RuntimeDb,
  id: string,
  organizationId: string,
): Promise<DeploymentRow> {
  requireUuidId(id);
  const rows = await db
    .select()
    .from(schema.deployments)
    .where(and(eq(schema.deployments.id, id), eq(schema.deployments.organizationId, organizationId)))
    .limit(1);
  if (rows.length === 0) {
    throw new NotFoundError('Deployment not found');
  }
  return rows[0]!;
}

async function loadOwnedCustomer(
  db: RuntimeDb,
  id: string,
  organizationId: string,
): Promise<CustomerRow> {
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

/** Derived deploy-link status — no separate state machine is persisted. */
function deriveDeployLinkStatus(link: {
  revokedAt: Date | null;
  expiresAt: Date;
  now?: Date;
}): 'active' | 'revoked' | 'expired' {
  if (link.revokedAt !== null) return 'revoked';
  return (link.now ?? new Date()).getTime() > link.expiresAt.getTime() ? 'expired' : 'active';
}

// The vendor-facing deploy-link row: the link's own columns plus the display
// fields that only exist via a join (application name, deployment state,
// region) and the derived status. Never includes token_hash.
function toDeployLinkView(input: {
  link: DeployLinkRow;
  application: Pick<ApplicationRow, 'name'> | null;
  deployment: Pick<DeploymentRow, 'state' | 'region'> | null;
}) {
  const { link, application, deployment } = input;
  return {
    id: link.id,
    customerId: link.customerId,
    applicationId: link.applicationId,
    applicationName: application?.name ?? null,
    deploymentId: link.deploymentId,
    deploymentState: deployment?.state ?? null,
    region: deployment?.region ?? null,
    status: deriveDeployLinkStatus(link),
    expiresAt: link.expiresAt,
    revokedAt: link.revokedAt,
    lastUsedAt: link.lastUsedAt,
    createdAt: link.createdAt,
  };
}

// The Quick Create link for the public deploy-link page — the same rules the
// install page applies: no link once the enrollment code is spent, the
// template resolved for THIS deployment's region (never cross-region).
// DZ-AUDIT-013: carries the relayCredential parameter when one is stored.
function deployLinkQuickCreateUrl(input: {
  region: DeploymentRow['region'];
  deploymentId: string;
  appName: string;
  attemptNumber: number;
  bootstrapStackName: string | null;
  previousBootstrapStackName?: string | null;
  enrollmentCode: string;
  enrollmentUsedAt: Date | null;
  relayCredential?: string | null;
}): string | null {
  if (input.enrollmentUsedAt !== null) return null;
  if (
    input.bootstrapStackName !== null &&
    input.bootstrapStackName === input.previousBootstrapStackName
  ) {
    return null;
  }
  const stackName =
    input.bootstrapStackName ??
    bootstrapStackName({
      appName: input.appName,
      deploymentId: input.deploymentId,
      attempt: input.attemptNumber,
    });
  const templateUrl = resolveBootstrapTemplate(input.region, {
    ...(env.bootstrapTemplateUrl ? { legacyUrl: env.bootstrapTemplateUrl } : {}),
    deployableRegions: env.deployableAwsRegions,
  });
  return templateUrl
    ? buildBootstrapQuickCreateUrl({
        region: input.region,
        templateUrl,
        controlPlaneUrl: env.apiUrl,
        enrollmentCode: input.enrollmentCode,
        relayCredential: input.relayCredential ?? undefined,
        stackName,
      })
    : null;
}

// The connector update the customer may approve for this deployment's
// existing bootstrap stack (null before enrollment or after removal).
function connectorUpdateFor(deployment: DeploymentRow): ConnectorUpdateOffer | null {
  return connectorUpdateOffer(deployment, {
    buildId: env.bootstrapBuildId,
    legacyUrl: env.bootstrapTemplateUrl,
    deployableRegions: env.deployableAwsRegions,
  });
}

// A reset of a deployment that was installed before keeps its bootstrap stack
// name, because the connector stack still exists in the customer's account: a
// Quick Create would fail with AlreadyExists. The customer instead UPDATES that
// stack with the new relay credential and enrollment code. Null for any other
// deployment (including a never-installed reset, which gets a fresh stack name).
function existingStackUpdateFor(input: {
  region: DeploymentRow['region'];
  bootstrapStackName: string | null;
  previousBootstrapStackName: string | null;
  enrollmentCode: string;
  enrollmentUsedAt: Date | null;
  relayCredential: string | null;
}): {
  stackName: string;
  consoleUrl: string;
  templateUrl: string | null;
  enrollmentCode: string;
  relayCredential: string | null;
  controlPlaneUrl: string;
} | null {
  if (
    input.enrollmentUsedAt !== null ||
    input.bootstrapStackName === null ||
    input.bootstrapStackName !== input.previousBootstrapStackName
  ) {
    return null;
  }
  const links = connectorUpdateLinks(input.region, input.bootstrapStackName, {
    buildId: env.bootstrapBuildId,
    legacyUrl: env.bootstrapTemplateUrl,
    deployableRegions: env.deployableAwsRegions,
  });
  return {
    stackName: input.bootstrapStackName,
    consoleUrl: links.updateUrl,
    templateUrl: links.templateUrl,
    enrollmentCode: input.enrollmentCode,
    relayCredential: input.relayCredential,
    controlPlaneUrl: env.apiUrl,
  };
}

// A customer retry of a failed first install keeps the connector stack when a
// previous attempt reached the customer's account (a connector registered, or
// an earlier retry already chose to keep it). The old attempt's failed stack
// and its retained database can be recovered only through that same connector
// installation, so a second connector would orphan them. Nothing reached the
// account when no connector ever registered: that retry gets a fresh stack.
function retryKeepsConnector(deployment: DeploymentRow): boolean {
  return (
    deployment.bootstrapStackName !== null &&
    (deployment.installationId !== null ||
      deployment.enrollmentUsedAt !== null ||
      deployment.bootstrapStackName === deployment.previousBootstrapStackName)
  );
}

/**
 * Resolve the config scope from a request's customer id: an absent/empty id
 * is the vendor scope, otherwise the customer is loaded to get its NAME.
 * The config screen names the customer — a raw customer id is an internal
 * identifier that means nothing to the vendor (§65) — and loading it here
 * also keeps the scope org-owned: a customer of another organization 404s.
 */
async function resolveConfigScope(
  db: RuntimeDb,
  customerId: string | null | undefined,
  organizationId: string,
): Promise<{ customerId: string | null; customerName: string | null }> {
  if (customerId === null || customerId === undefined || customerId.length === 0) {
    return { customerId: null, customerName: null };
  }
  const customer = await loadOwnedCustomer(db, customerId, organizationId);
  return { customerId: customer.id, customerName: customer.name };
}

/**
 * The deploy/rollback payload contract — everything the relay needs to roll
 * an immutable image out, derived SERVER-side from the READY release. The
 * browser only ever names a releaseId; repository and digest are never
 * client-supplied.
 */
interface DeployPayload {
  releaseId: string;
  version: string;
  imageRepository: string;
  imageDigest: string;
  /** Per-workload rollout seats from the frozen spec — see requireDeployableRelease. */
  workloads?: { id: string; serviceLogicalId: string; desiredCount: number }[];
  /**
   * The frozen one-shot migration seat (Phase 4C) — the compiled task family
   * plus the control-plane-computed identity. Absent when the frozen spec has
   * no migration workload, the vendor chose no separate migration, or the
   * identity is already confirmed. `command` is present only for a vendor
   * correction; the relay puts it into a new revision of the same family.
   */
  migrationTask?: { family: string; identity: string; command?: string };
  /**
   * The effective migration policy this job snapshotted when it differs
   * from the frozen command: `skip`, or `corrected:<fingerprint>`. Absent
   * for the frozen policy. It is part of the job's idempotency key.
   */
  migrationPolicy?: string;
  /**
   * Scheduled-job ECS task-definition families (Phase 5) — derived ONLY from
   * the frozen spec's `oneShotTasksFromSpec(spec, 'scheduled-job', …)` and
   * the installation's task-family suffix. The
   * relay registers the release image into each of them once the rollout
   * settles; it never runs them (`AWS::Scheduler::Schedule` does). Sent on
   * both DEPLOY_RELEASE and ROLLBACK payloads — unlike the migration seat,
   * this never gates on a confirmed identity.
   */
  scheduledJobFamilies?: string[];
  [key: string]: unknown;
}

/** The scheduled-job task families a deployment's frozen spec compiled, for
 *  the DEPLOY_RELEASE/ROLLBACK payload (Phase 5). Undefined when there is no
 *  deployment row (a bulk/legacy caller) or no compiled spec — never an
 *  empty array standing in for "not derived". */
function scheduledJobFamiliesFor(deployment: DeploymentRow | undefined): string[] | undefined {
  if (deployment === undefined) return undefined;
  const spec = readStoredDeploymentSpec(deployment.specV2);
  if (!spec) return undefined;
  const families = oneShotTasksFromSpec(
    spec,
    'scheduled-job',
    requireTaskFamilySuffix(spec, deployment.installationId),
  ).map((task) => task.family);
  return families.length > 0 ? families : undefined;
}

async function requireDeployableRelease(
  db: RuntimeDb,
  releaseImages: ReleaseImageClient,
  releaseId: string,
  applicationId: string,
  deployment?: DeploymentRow,
): Promise<DeployPayload> {
  requireUuidId(releaseId);
  const rows = await db
    .select()
    .from(schema.releases)
    .where(and(eq(schema.releases.id, releaseId), eq(schema.releases.applicationId, applicationId)))
    .limit(1);
  const release = rows[0];
  if (!release) {
    throw new NotFoundError('Release not found');
  }
  // The image digest arrives from CodeBuild in RepoDigests form
  // (`repository@sha256:…`); the wire contract wants the two parts apart,
  // with the digest matching the strict immutable form.
  const at = release.imageDigest?.lastIndexOf('@') ?? -1;
  const imageRepository = at > 0 ? release.imageDigest!.slice(0, at) : null;
  const imageDigest = at > 0 ? release.imageDigest!.slice(at + 1) : null;
  if (
    release.releaseStatus !== 'READY' ||
    imageRepository === null ||
    imageDigest === null ||
    !/^sha256:[0-9a-f]{64}$/.test(imageDigest)
  ) {
    throw new ApiError(
      409,
      'RELEASE_NOT_READY',
      `Version ${release.version} has no deployable image yet. Wait for the build to finish or pick another release.`,
    );
  }
  // READY says the build once pushed an image; the registry says whether it
  // still exists. Checked at request time so a release the page listed
  // before its image was deleted is refused here, never queued.
  await requireReleaseImageAvailable(db, releaseImages, release);
  const payload: DeployPayload = {
    releaseId: release.id,
    version: release.version,
    imageRepository,
    imageDigest,
  };
  // Phase 4A: per-workload rollout seats, derived ONLY from the deployment's
  // frozen spec (one entry per compute check; the count from the spec's own
  // footprint — web keeps its configured count, workers their default of 1).
  // The relay scales each workload's service to its own count and names the
  // right workload in a failure. Absent for an uncompiled spec, so a
  // single-workload deploy carries byte-for-byte the payload it always did.
  if (deployment !== undefined) {
    const spec = readStoredDeploymentSpec(deployment.specV2);
    const workloads = spec ? workloadServicesFromSpec(spec) : null;
    if (workloads !== null && workloads.length > 0) {
      const footprint = spec?.footprint ?? null;
      payload.workloads = workloads.map((workload) => ({
        id: workload.id,
        serviceLogicalId: workload.serviceLogicalId,
        desiredCount:
          footprint?.workloads.find((entry) => entry.id === workload.id)?.quantity ?? 1,
      }));
    }
    // Phase 4C: the frozen one-shot migration. The relay receives the NAMED
    // task-definition family the compiler froze from the analyzed command,
    // and only when this deployment has no SUCCEEDED deploy already
    // confirming the same migration identity. The application's migration
    // setting decides the effective policy, snapshotted here: the frozen
    // command, a vendor correction (the only command that rides the seat),
    // or no separate migration. ROLLBACK builds its payload WITHOUT the
    // deployment row, so a rollback (and RESTART, whose payload is empty)
    // can never carry the seat.
    const migration = spec
      ? migrationTaskFromSpec(spec, requireTaskFamilySuffix(spec, deployment.installationId))
      : null;
    const frozenCommand =
      migration !== null
        ? (spec?.graph.workloads.find((workload) => workload.kind === 'migration')?.command ?? null)
        : null;
    const policy = await migrationPolicyFor(db, applicationId, frozenCommand);
    if (policy.mode === 'skipped') {
      payload.migrationPolicy = 'skip';
    } else if (policy.mode === 'corrected') {
      payload.migrationPolicy = `corrected:${createHash('sha256').update(policy.command).digest('hex').slice(0, 16)}`;
    }
    if (migration !== null && frozenCommand !== null && policy.mode !== 'skipped') {
      const command = policy.mode === 'corrected' ? policy.command : frozenCommand;
      const identity = migrationIdentity(command, imageDigest);
      if (!(await migrationIdentityConfirmed(db, deployment.id, identity))) {
        payload.migrationTask = {
          family: migration.family,
          identity,
          ...(policy.mode === 'corrected' ? { command } : {}),
        };
      }
    }
    // Phase 5: scheduled-job families, derived only from the frozen spec —
    // sent unconditionally (never gated on a migration-style confirmation),
    // so every DEPLOY_RELEASE payload carries them.
    const scheduledJobFamilies = scheduledJobFamiliesFor(deployment);
    if (scheduledJobFamilies !== undefined) {
      payload.scheduledJobFamilies = scheduledJobFamilies;
    }
  }
  return payload;
}

/**
 * The migration identity (Phase 4C): sha256 over the EFFECTIVE migration
 * command (the frozen command, or the vendor's correction) and the release's
 * immutable image digest. A changed command or a new image always means a
 * new identity (the migration runs again, also for the same image), and an
 * unchanged combination is never re-run once a deploy with the same identity
 * has SUCCEEDED for this deployment.
 */
export function migrationIdentity(command: string, imageDigest: string): string {
  return createHash('sha256').update(`${command}\n${imageDigest}`).digest('hex');
}

/**
 * Whether this deployment has already confirmed this migration identity: the
 * durable record is the deployment's own SUCCEEDED DEPLOY_RELEASE job rows —
 * the payload that produced each success is stored verbatim on the row, so
 * "a succeeded deploy carried this identity" IS "this migration ran and
 * passed" (the relay settles success only after the migration stage exited 0,
 * and rollback/restart jobs never carry the seat). Stored in the control
 * plane's own database — it survives relay rebuilds (unlike the relay's
 * pending-marker state file) and needs no new schema.
 */
async function migrationIdentityConfirmed(
  db: RuntimeDb,
  deploymentId: string,
  identity: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: schema.deploymentJobs.id })
    .from(schema.deploymentJobs)
    .where(
      and(
        eq(schema.deploymentJobs.deploymentId, deploymentId),
        eq(schema.deploymentJobs.type, 'DEPLOY_RELEASE'),
        inArray(schema.deploymentJobs.state, ['SUCCEEDED', 'SUCCESS']),
        sql`${schema.deploymentJobs.payload} -> 'migrationTask' ->> 'identity' = ${identity}`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

type MigrationPolicy =
  | { mode: 'frozen' }
  | { mode: 'corrected'; command: string }
  | { mode: 'skipped' };

/**
 * The effective migration policy for one deployment's next DEPLOY_RELEASE,
 * from the application's migration setting and its vendor-override marker:
 * no override runs the frozen command; an explicit command is a correction;
 * an explicit null (no separate migration) skips the migration. The
 * deployment's spec and topology never change — a correction is accepted
 * only when the frozen deployment already has a migration workload
 * (`frozenCommand` is null when it does not).
 */
async function migrationPolicyFor(
  db: RuntimeDb,
  applicationId: string,
  frozenCommand: string | null,
): Promise<MigrationPolicy> {
  const [application] = await db
    .select({
      migrationCommand: schema.applications.migrationCommand,
      detectedMetadata: schema.applications.detectedMetadata,
    })
    .from(schema.applications)
    .where(eq(schema.applications.id, applicationId))
    .limit(1);
  if (!application || !readVendorOverrides(application.detectedMetadata).includes('migrationCommand')) {
    return { mode: 'frozen' };
  }
  const command = application.migrationCommand?.trim() || null;
  if (command === null) return frozenCommand === null ? { mode: 'frozen' } : { mode: 'skipped' };
  if (frozenCommand === null) {
    throw new ApiError(
      409,
      'MIGRATION_WORKLOAD_MISSING',
      'This deployment was created without a separate migration step, so a migration command cannot be added to it. Choose "No separate migration" for the application, or create a new deployment.',
    );
  }
  return command === frozenCommand ? { mode: 'frozen' } : { mode: 'corrected', command };
}

/** The base idempotency key of a DEPLOY_RELEASE: one per release and effective migration policy. */
function deployReleaseKey(deploymentId: string, releaseId: string, payload: DeployPayload): string {
  const base = `${deploymentId}:DEPLOY_RELEASE:${releaseId}`;
  return payload.migrationPolicy === undefined ? base : `${base}:migration:${payload.migrationPolicy}`;
}

/** The keys a CONFIG_UPDATE job carried: the ones whose bound pending-secret rows its success delivered. */
function configUpdateDeliveredKeys(payload: Record<string, unknown> | null): string[] {
  const keys = (field: string): string[] =>
    Array.isArray(payload?.[field])
      ? (payload[field] as unknown[]).filter((key): key is string => typeof key === 'string')
      : [];
  const secrets = Array.isArray(payload?.['secrets']) ? (payload['secrets'] as { key?: unknown }[]) : [];
  return [
    ...new Set([
      ...keys('changedKeys'),
      ...keys('removedKeys'),
      ...secrets.flatMap((entry) => (typeof entry.key === 'string' ? [entry.key] : [])),
    ]),
  ];
}

/**
 * How long after an INSTALL succeeded a heartbeat still repairs its missing
 * follow-ups. Installs from before the decision was recorded stay untouched.
 */
const INSTALL_FOLLOW_UP_REPAIR_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Job types that change the stack or its ECS services — the relay runs one at a time. */
const SERVICE_MUTATING_JOB_TYPES: ReadonlySet<string> = new Set([
  'INSTALL',
  'DEPLOY_RELEASE',
  'ROLLBACK',
  'RESTART',
  'CONFIG_UPDATE',
  'DESTROY',
  'PURGE',
  'MIGRATION',
  'INFRA_UPGRADE',
]);

/**
 * One mutating operation per deployment: before creating any mutating job,
 * refuse if another is still active. Concurrency here means two executors
 * racing the same ECS service/stack, with no honest way to report either
 * outcome. A retry of the SAME command (same idempotency key) is not
 * concurrency — it reuses its existing job.
 */
async function requireDeploymentIdle(
  db: RuntimeDb,
  deploymentId: string,
  sameKeyIdempotencyKey?: string,
): Promise<void> {
  const active = await db
    .select({ id: schema.deploymentJobs.id })
    .from(schema.deploymentJobs)
    .where(
      and(
        eq(schema.deploymentJobs.deploymentId, deploymentId),
        inArray(schema.deploymentJobs.state, ['REQUESTED', 'QUEUED', 'WAITING', 'RUNNING']),
        inArray(schema.deploymentJobs.type, [
          'INSTALL',
          'DEPLOY_RELEASE',
          'ROLLBACK',
          'RESTART',
          'CONFIG_UPDATE',
          'DESTROY',
          'MIGRATION',
          'INFRA_UPGRADE',
        ]),
        ...(sameKeyIdempotencyKey
          ? [ne(schema.deploymentJobs.idempotencyKey, sameKeyIdempotencyKey)]
          : []),
      ),
    )
    .limit(1);
  if (active.length > 0) {
    throw new ApiError(
      409,
      'DEPLOYMENT_BUSY',
      'Another deployment operation is already in progress.',
    );
  }
}

/**
 * Whether a claimed or pending relay command is still authoritative: the
 * control plane's answer to the relay's "must I still run this?" probe. A
 * command that settled, whose deployment is being torn down, or (for an
 * INSTALL) that a later DESTROY superseded must not keep mutating AWS.
 * `latestDestroyCreatedAt` is the deployment's newest DESTROY createdAt, or
 * null when none exists.
 */
export function relayCommandAuthority(
  job: Pick<DeploymentJobRow, 'type' | 'state' | 'createdAt'>,
  deployment: Pick<DeploymentRow, 'state'>,
  latestDestroyCreatedAt: Date | null,
): { active: boolean; reason?: string } {
  if (!['REQUESTED', 'QUEUED', 'WAITING', 'RUNNING'].includes(job.state)) {
    return { active: false, reason: 'settled' };
  }
  if (deployment.state === 'DELETING' || deployment.state === 'DELETED') {
    return { active: false, reason: 'teardown' };
  }
  if (
    job.type === 'INSTALL' &&
    latestDestroyCreatedAt !== null &&
    latestDestroyCreatedAt.getTime() >= job.createdAt.getTime()
  ) {
    return { active: false, reason: 'superseded_by_teardown' };
  }
  return { active: true };
}

/**
 * Derived idempotency key that a settled prior attempt does not poison. The
 * fixed derived keys exist to absorb double-clicks and replays, but
 * createOrReuseJob hands the same row back regardless of state — so once an
 * attempt settled, every later user-initiated request silently received the
 * old job and nothing ran: a retry after a FAILED deploy (observed live), and
 * a re-deploy of v2 after rolling back to v1, which handed back the earlier
 * SUCCEEDED v2 job while v1 kept serving (version canary). When the newest
 * attempt under this base key is terminal, mint an attempt-scoped key; while
 * it is still active the base key keeps its replay-absorbing behavior.
 */
async function retryAwareIdempotencyKey(
  db: RuntimeDb,
  deploymentId: string,
  type: JobType,
  baseKey: string,
): Promise<string> {
  const attempts = (
    await db
      .select({
        state: schema.deploymentJobs.state,
        idempotencyKey: schema.deploymentJobs.idempotencyKey,
        createdAt: schema.deploymentJobs.createdAt,
      })
      .from(schema.deploymentJobs)
      .where(
        and(
          eq(schema.deploymentJobs.deploymentId, deploymentId),
          eq(schema.deploymentJobs.type, type),
        ),
      )
  ).filter(
    (job) => job.idempotencyKey === baseKey || job.idempotencyKey.startsWith(`${baseKey}:RETRY:`),
  );
  const newest = attempts.sort(
    (a, b) =>
      b.createdAt.getTime() - a.createdAt.getTime() ||
      b.idempotencyKey.localeCompare(a.idempotencyKey),
  )[0];
  return newest !== undefined && SETTLED_JOB_STATES.has(newest.state)
    ? `${baseKey}:RETRY:${attempts.length}`
    : baseKey;
}

/**
 * The customer-facing retry (install link / deploy link) re-arms a first
 * install, including mid-flight (a customer may abandon a stack and start
 * over). It must not run on a deployment that is being removed or is in a
 * day-2 state: the reset would fight the DESTROY/deploy job still running.
 */
const PUBLIC_RETRYABLE_STATES: ReadonlySet<string> = new Set([
  'NOT_INSTALLED',
  'WAITING_FOR_RELAY',
  'INSTALLING',
  'FAILED',
]);

function assertPublicRetryAllowed(deployment: { state: string }): void {
  if (!PUBLIC_RETRYABLE_STATES.has(deployment.state)) {
    throw new ApiError(409, 'INSTALL_NOT_RETRYABLE', `Deployment is ${deployment.state}, not retryable.`);
  }
}

/** Every applications column except the two large JSON ones (see GET /api/applications). */
const APPLICATION_LIST_COLUMNS = Object.fromEntries(
  Object.entries(getTableColumns(schema.applications)).filter(
    ([name]) => name !== 'detectedMetadata' && name !== 'environmentSettings',
  ),
) as Omit<ReturnType<typeof getTableColumns<typeof schema.applications>>, 'detectedMetadata' | 'environmentSettings'>;

/** Every deployment_jobs column except the payload (see GET /api/deployments). */
const JOB_LIST_COLUMNS = Object.fromEntries(
  Object.entries(getTableColumns(schema.deploymentJobs)).filter(([name]) => name !== 'payload'),
) as Omit<ReturnType<typeof getTableColumns<typeof schema.deploymentJobs>>, 'payload'>;

const SETTLED_JOB_STATES: ReadonlySet<string> = new Set(['SUCCEEDED', 'SUCCESS', 'FAILED', 'CANCELLED']);

// maskAwsAccountId/toFleetRow live in ./fleet-row.js — shared with Team
// Admin's cross-tenant deployment queries (apps/api/src/admin/queries.ts)
// without admin code importing this file (which registers admin routes).


// §19 semantic readiness derivation. Analyses persist the full semantic
// report on `applications.detected_metadata.readiness` (analysis.ts) — this
// puts it on the wire, adding the state derived from `analysisStatus`
// (ANALYSIS_INCOMPLETE while pending/failed — never a fabricated result).
// Rows analysed before the report existed degrade into equivalent findings
// built from the legacy `checks` shape. No percentages, ever.

/** One existing deployment's requirement drift vs the application's effective requirements. */
interface DeploymentRequirementDriftSummary {
  deploymentId: string;
  customerName: string;
  state: DeploymentRow['state'];
  drift: DeploymentPlan['requirementDrift'];
}

/** A deployments row joined to its customer label — what the drift summary needs. */
type DeploymentRequirementDriftRow = Pick<DeploymentRow, 'id' | 'state' | 'desiredState' | 'specV2'> & {
  customerName: string;
};

/** The `GET /api/applications/:id/readiness` wire shape. */
interface ReadinessResponse {
  analysisStatus: string;
  state: ReadinessState;
  requiredCount: number;
  recommendedCount: number;
  /** One short explanation of the state. Null while analysis is incomplete. */
  summary: string | null;
  /** Why a FAILED analysis failed. Null in every other state. */
  failureReason: string | null;
  findings: ReadinessFinding[];
  passed: PassedCheck[];
  /** The commit the analysis ran against, when known. */
  analyzedCommitSha: string | null;
  /** True when the stored analysis predates the current analyser, so a re-analysis would apply newer checks. */
  analysisOutdated: boolean;
  /** What the analysis detected, with source, confidence and evidence. Null until a Version 13+ analysis ran. */
  detected: ApplicationAnalysis | null;
  /** Server-computed database/redis/storage truth (Phase 1). Null while analysis is incomplete. */
  requirements: ApplicationRequirementsSummary | null;
  /**
   * How each existing deployment's frozen manifest differs from the
   * application's current effective requirements — reported only, never
   * repaired (the MVP never changes an existing deployment's topology in
   * place, so the frozen manifests stay as they are). Empty while analysis
   * is incomplete.
   */
  deploymentRequirementDrift: DeploymentRequirementDriftSummary[];
  /** Env-var setup counts (docs/environment-variables.md). Null while analysis is incomplete. */
  environmentSetup: {
    needsDecision: number;
    missingValue: number;
    missingBuildValue: number;
    customer: number;
    total: number;
  } | null;
  /**
   * What the analysed ApplicationGraph says the application needs — grouped
   * components, per-node resolution state and the unresolved questions — for
   * the vendor "Architecture detected" card. Absent while analysis is
   * incomplete.
   */
  architecture?: ReadinessArchitecture;
}

/** One node of the readiness architecture summary — a component the graph detected. */
interface ReadinessArchitectureNode {
  label: string;
  /** 'confirmed' when a vendor override resolved the node, else 'detected'. */
  state: 'detected' | 'confirmed';
}

interface ReadinessArchitecture {
  counts: ApplicationGraphSummary;
  /** Components grouped for the compact card, in display order. */
  groups: { group: PlanComponentGroup; nodes: ReadinessArchitectureNode[] }[];
  /** Focused questions the vendor must answer (kind + question + blocking). */
  unresolved: { kind: string; question: string; blocking: boolean }[];
  /** Third-party services the app calls directly (Stripe, OpenAI, …) — information only. */
  externalServices: string[];
}

/**
 * ApplicationGraph resource kind → card group. External services are excluded
 * before this lookup, so the map is total over every remaining kind — a group
 * can never fall through to an unlisted bucket.
 */
const ARCHITECTURE_GROUP_BY_RESOURCE_KIND: Record<Exclude<ResourceKind, 'external_service'>, PlanComponentGroup> = {
  relational_database: 'data',
  document_database: 'data',
  key_value_database: 'data',
  cache: 'cache',
  queue: 'messaging',
  event_bus: 'messaging',
  object_storage: 'storage',
  filesystem: 'storage',
  search: 'storage',
  vector_store: 'storage',
  generic_service: 'edge',
};

const ARCHITECTURE_GROUP_ORDER = ['application', 'data', 'cache', 'storage', 'messaging', 'edge'] as const;

/** The architecture summary for the analysed application — built from the same effective manifest the requirements and drift summaries read. */
function computeArchitecture(app: ManifestApplicationRow): ReadinessArchitecture {
  const graph = manifestToApplicationGraph(effectiveApplicationManifest(app));
  const nodes = new Map<string, ReadinessArchitectureNode[]>();
  const externalServices: string[] = [];
  const push = (group: string, label: string, overridden: boolean): void => {
    const list = nodes.get(group);
    const node = { label, state: overridden ? ('confirmed' as const) : ('detected' as const) };
    if (list) list.push(node);
    else nodes.set(group, [node]);
  };
  for (const workload of graph.workloads) push('application', workload.label, workload.provenance.overridden);
  for (const resource of graph.resources) {
    // An external service (EXTERNAL_SAAS) is not Deployz-created — Deployz
    // would never provision it, so it stays out of the architecture groups
    // and is listed as information only.
    if (resource.kind === 'external_service' || resource.ownership === 'EXTERNAL_SAAS') {
      externalServices.push(resource.label);
      continue;
    }
    push(ARCHITECTURE_GROUP_BY_RESOURCE_KIND[resource.kind], resource.label, resource.provenance.overridden);
  }
  // Schedules ride the messaging group, like their plan components.
  for (const schedule of graph.schedules ?? []) push('messaging', schedule.label, schedule.provenance.overridden);
  return {
    counts: summarizeApplicationGraph(graph),
    groups: ARCHITECTURE_GROUP_ORDER.filter((group) => nodes.has(group)).map((group) => ({
      group,
      nodes: nodes.get(group)!,
    })),
    unresolved: graph.unresolved.map((entry) => ({ kind: entry.field, question: entry.question, blocking: entry.blocking })),
    externalServices,
  };
}

/** Legacy-row bridge: rebuild findings from the pre-report `checks` shape. */
function legacyReadiness(app: {
  compatibilityStatus: string | null;
  compatibilityReason: string | null;
  detectedMetadata: Record<string, unknown> | null;
}): Pick<ReadinessResponse, 'state' | 'requiredCount' | 'recommendedCount' | 'summary' | 'findings' | 'passed'> {
  const rawChecks = app.detectedMetadata?.checks as
    | { ready?: ReadyCheck[]; needsAttention?: AttentionCheck[]; unsupported?: UnsupportedCheck[] }
    | undefined;

  const toFinding = (
    entry: { title: string; detail?: string; reason?: string; suggestedFix?: string | null },
    blocking: boolean,
    index: number,
  ): ReadinessFinding => ({
    id: `legacy-${blocking ? 'blocking' : 'required'}-${index}`,
    category: 'legacy',
    title: entry.title,
    severity: 'required',
    blocking,
    plainEnglishExplanation: entry.detail ?? entry.reason ?? entry.title,
    whyItMatters: '',
    technicalEvidence: entry.detail ?? entry.reason ?? '',
    suggestedOutcome: entry.suggestedFix ?? '',
    confidence: 'confirmed',
  });

  const unsupported = (rawChecks?.unsupported ?? []).map((entry, i) => toFinding(entry, true, i));
  const attention = (rawChecks?.needsAttention ?? []).map((entry, i) => toFinding(entry, false, i));
  const findings = [...unsupported, ...attention];
  // A COMPLETE row with no verdict at all is treated like NEEDS_ATTENTION
  // (the old endpoint's fallback) — never READY by omission.
  const state: ReadinessState =
    app.compatibilityStatus === 'NOT_COMPATIBLE'
      ? 'NEEDS_CHANGES'
      : app.compatibilityStatus === 'READY'
        ? 'READY'
        : 'ALMOST_READY';

  return {
    state,
    requiredCount: findings.length,
    recommendedCount: 0,
    summary: app.compatibilityReason,
    findings,
    passed: (rawChecks?.ready ?? []).map((entry, i) => ({ id: `legacy-passed-${i}`, label: entry.label })),
  };
}

async function computeReadiness(
  db: RuntimeDb,
  app: ManifestApplicationRow & {
    id: string;
    analysisStatus: string;
    compatibilityStatus: string | null;
    compatibilityReason: string | null;
    environmentSettings?: unknown;
  },
  deployments: DeploymentRequirementDriftRow[],
): Promise<ReadinessResponse> {
  if (app.analysisStatus !== 'COMPLETE') {
    return {
      analysisStatus: app.analysisStatus,
      state: 'ANALYSIS_INCOMPLETE',
      requiredCount: 0,
      recommendedCount: 0,
      summary: null,
      // A FAILED analysis used to look exactly like a still-running one on
      // the wire, so the page showed "Analysing your app" for ever and
      // Re-analyse appeared to do nothing. The reason is on the row either
      // way (analysis.ts persists it) — it just was never sent.
      failureReason: app.analysisStatus === 'FAILED' ? app.compatibilityReason : null,
      findings: [],
      passed: [],
      analyzedCommitSha: null,
      analysisOutdated: false,
      detected: null,
      requirements: null,
      deploymentRequirementDrift: [],
      environmentSetup: null,
    };
  }

  const analyzedCommitSha =
    typeof app.detectedMetadata?.['analysisCommitSha'] === 'string'
      ? (app.detectedMetadata['analysisCommitSha'] as string)
      : null;
  const report = effectiveReadinessReport(app);
  const body = report
    ? {
        state: report.state as ReadinessState,
        requiredCount: report.requiredCount,
        recommendedCount: report.recommendedCount,
        summary: report.summary,
        findings: report.findings,
        passed: report.passed,
      }
    : legacyReadiness(app);
  const detected = readApplicationAnalysis(app.detectedMetadata);
  const environmentSetup = await evaluateForApplication(db, app);

  return {
    analysisStatus: app.analysisStatus,
    ...body,
    failureReason: null,
    analyzedCommitSha,
    analysisOutdated: app.detectedMetadata?.['analysisVersion'] !== ANALYSIS_VERSION,
    detected,
    requirements: computeApplicationRequirements(app, detected),
    deploymentRequirementDrift: computeDeploymentRequirementDrift(app, deployments),
    architecture: computeArchitecture(app),
    environmentSetup: {
      needsDecision: environmentSetup.counts.needsDecision,
      missingValue: environmentSetup.counts.missingValue,
      missingBuildValue: environmentSetup.counts.missingBuildValue,
      customer: environmentSetup.counts.customer,
      total: environmentSetup.counts.total,
    },
  };
}

/**
 * The application's current effective manifest — the single construction
 * computeApplicationRequirements and computeDeploymentRequirementDrift share.
 */
function effectiveApplicationManifest(app: ManifestApplicationRow & { environmentSettings?: unknown }): DeploymentManifest {
  return applyEnvironmentBindings(
    normalizeDeploymentManifest({ metadata: app.detectedMetadata ?? {} }, applicationToManifestOverrides(app)),
    readEnvironmentSettings(app),
  );
}

/**
 * The server-computed truth for database/redis/storage (Phase 1) — replaces
 * the web app's client-side OR of `application.*Required` with
 * `detected.*.required`, which cannot represent a vendor override to
 * `false`. Built from the same manifest `runApplicationPreflight` builds, so
 * the two endpoints can never disagree about what a new deployment gets.
 */
function computeApplicationRequirements(
  app: ManifestApplicationRow,
  detected: ApplicationAnalysis | null,
): ApplicationRequirementsSummary | null {
  const manifest = effectiveApplicationManifest(app);
  const overrides = new Set(readVendorOverrides(app.detectedMetadata));
  return {
    schemaVersion: DEPLOYMENT_MANIFEST_SCHEMA_VERSION,
    database: {
      detected: detected?.database.required ?? false,
      effective: manifest.database.postgres,
      overridden: overrides.has('databaseRequired'),
    },
    redis: {
      detected: detected?.redis.required ?? false,
      effective: manifest.redis.required,
      overridden: overrides.has('redisRequired'),
    },
    storage: {
      detected: detected?.storage.objectStorageDetected ?? false,
      effective: manifest.storage.required,
      overridden: overrides.has('storageRequired'),
    },
  };
}

/**
 * Requirement drift between each existing deployment's frozen spec and the
 * application's current effective manifest (the same construction
 * computeApplicationRequirements builds) — the vendor-facing "existing
 * deployments keep their frozen provisioning intent; these deployments now
 * differ" surface. Compared by graph hash: a deployment has drifted when its
 * spec's graph is not the graph the application currently wants. Reported
 * only, never repaired. DELETED deployments and rows without a valid spec
 * are skipped; deployments with no drift are omitted.
 */
function computeDeploymentRequirementDrift(
  app: ManifestApplicationRow,
  deployments: DeploymentRequirementDriftRow[],
): ReadinessResponse['deploymentRequirementDrift'] {
  const desiredManifest = effectiveApplicationManifest(app);
  const desiredGraph = manifestToApplicationGraph(desiredManifest);
  const desiredGraphHash = applicationGraphHash(desiredGraph);
  const summary: ReadinessResponse['deploymentRequirementDrift'] = [];
  for (const deployment of deployments) {
    if (deployment.state === 'DELETED') continue;
    const spec = readStoredDeploymentSpec(deployment.specV2);
    if (!spec) continue;
    if (spec.graphHash === desiredGraphHash) continue;
    const requirements = requirementsFromSpec(spec);
    const drift: DeploymentPlan['requirementDrift'] = [];
    const deployedDatabase = requirements ? requirements.databaseRequired : false;
    const deployedRedis = requirements ? requirements.redisRequired : false;
    if (deployedDatabase !== desiredManifest.database.postgres) {
      drift.push({ kind: 'database', deployed: deployedDatabase, desired: desiredManifest.database.postgres });
    }
    if (deployedRedis !== desiredManifest.redis.required) {
      drift.push({ kind: 'cache', deployed: deployedRedis, desired: desiredManifest.redis.required });
    }
    drift.push(...topologyDriftFor(spec.graph, desiredGraph));
    if (drift.length > 0) {
      summary.push({
        deploymentId: deployment.id,
        customerName: deployment.customerName,
        state: deployment.state,
        drift,
      });
    }
  }
  return summary;
}

/**
 * Fail closed on an unsupported infrastructure change: the application now
 * needs a database or cache that this deployment's frozen stack does not
 * have, or a different database engine, workload set, queue set or schedule
 * set. A new release on that stack would run with no binding or without its
 * workers, and an app that falls back to local storage would look healthy
 * while it loses data. A dropped database or cache stays deployable (the
 * resource is only unused).
 */
async function requireNoAddedRequirement(
  db: RuntimeDb,
  deployment: Pick<DeploymentRow, 'id' | 'applicationId' | 'state' | 'desiredState' | 'specV2'>,
): Promise<void> {
  const [app] = await db
    .select()
    .from(schema.applications)
    .where(eq(schema.applications.id, deployment.applicationId))
    .limit(1);
  if (!app) return;
  const [summary] = computeDeploymentRequirementDrift(app, [{ ...deployment, customerName: '' }]);
  const blocking = (summary?.drift ?? []).filter(
    (entry) => (entry.kind !== 'database' && entry.kind !== 'cache') || (entry.desired && !entry.deployed),
  );
  if (blocking.length === 0) return;
  const names = blocking
    .map((entry) =>
      entry.kind === 'database'
        ? 'a database'
        : entry.kind === 'cache'
          ? 'a cache'
          : entry.kind === 'engine'
            ? `a ${entry.name} database`
            : `a changed ${entry.kind} set (${entry.name})`,
    )
    .join(', ');
  throw new ApiError(
    409,
    'INFRASTRUCTURE_CHANGE_REQUIRED',
    `The application now needs ${names}, which this deployment does not have. Create a new deployment for this customer, or change the application's requirements back.`,
  );
}

// §25 "deploy to all compatible customers" — deployable means the fleet
// member is in a state where a new release can be rolled out. Deployments
// that are still installing, mid-transition, or gone are skipped rather than
// silently targeted.
const BULK_DEPLOYABLE_STATES = new Set<DeploymentRow['state']>(['HEALTHY', 'UPDATE_AVAILABLE']);

// States where a deploy or rollback has nothing to act on: no relay has ever
// enrolled, or the deployment is gone. Wider than BULK_DEPLOYABLE_STATES on
// purpose — that set answers "which customers does a fan-out include", while
// this one answers "can this one deployment be deployed at all", so an
// in-flight UPDATING retry still reaches the idempotent job path.
const UNDEPLOYABLE_STATES = new Set<DeploymentRow['state']>([
  'NOT_INSTALLED',
  'WAITING_FOR_RELAY',
  'DELETING',
  'DELETED',
]);

// An in-flight INSTALL older than this is dead: the relay polls every 5
// minutes and a single executor pass fits well inside it, so six missed
// cycles mean the invocation is never coming back (crashed Lambda, expired
// container). Only then may retry-install supersede the job.
const INSTALL_JOB_STALE_AFTER_MS = 30 * 60 * 1000;

// §9.4 force-complete on a LIVE relay: how many consecutive FAILED DESTROY
// jobs must accumulate before the escape hatch opens even though the relay
// still reads online. One failure is retryable by the vendor; two failures
// on a connected relay mean the delete itself is wedged.
const REPEATED_DESTROY_FAILURES_REQUIRED = 2;

// The failure codes the diagnostics route may spend a model call on:
// UNKNOWN plus the app-owned startup/config failures, where the §16-bounded
// evidence (redacted error, container verdict, failed resources) can sharpen
// the deterministic copy. Every other code names an account or infrastructure
// cause the copy map already answers unambiguously — those never reach AI.
export const AI_EXPLAINABLE_FAILURE_CODES: ReadonlySet<FailureCode> = new Set([
  'UNKNOWN',
  'CONTAINER_START_FAILED',
  'IMAGE_HEALTH_CHECK_FAILED',
  'DATABASE_CONNECTION_FAILED',
  'MISSING_SECRET',
  'PORT_MISMATCH',
  'MIGRATION_FAILED',
]);

/** 409s a deploy/rollback/restart aimed at a deployment that has nothing to
 *  deploy into — the single-deployment mirror of the skip reason deploy-bulk
 *  gives. A FAILED deployment that never completed a first successful
 *  INSTALL is still effectively uninstalled: there is no relay-managed
 *  infrastructure for these commands to act on, only retry-install (and
 *  destroy) may touch it. The same check retry-install itself uses. */
async function requireDeployableState(db: RuntimeDb, deployment: DeploymentRow): Promise<void> {
  if (UNDEPLOYABLE_STATES.has(deployment.state)) {
    throw new ApiError(
      409,
      'DEPLOYMENT_NOT_DEPLOYABLE',
      `Deployment is ${deployment.state}, not deployable`,
    );
  }
  if (deployment.state === 'FAILED' && !(await hasSucceededInstall(db, deployment.id))) {
    throw new ApiError(
      409,
      'DEPLOYMENT_NOT_DEPLOYABLE',
      'This deployment never completed its first install; use Retry install instead.',
    );
  }
  // §9.5 relay-liveness gates, mirroring retry-install's refusals: a job
  // queued for a relay that is not (or no longer) connected would sit
  // REQUESTED until the watchdog fails it an hour later, which the vendor
  // just watched happen. The fix for a dead relay is re-enrollment
  // (relay/reset), not another doomed job — refuse so the UI points there.
  if (!deployment.installationId) {
    throw new ApiError(
      409,
      'RELAY_NOT_CONNECTED',
      'No relay is connected to this deployment. Reconnect it before deploying.',
    );
  }
  if (deployment.relayStatus === 'DISCONNECTED') {
    throw new ApiError(
      409,
      'RELAY_DISCONNECTED',
      'The relay for this deployment is disconnected. Reconnect it before deploying.',
    );
  }
}

/** Whether the deployment's most recent job is a DESTROY. */
async function latestJobIsDestroy(db: RuntimeDb, deploymentId: string): Promise<boolean> {
  const [latest] = await db
    .select({ type: schema.deploymentJobs.type })
    .from(schema.deploymentJobs)
    .where(eq(schema.deploymentJobs.deploymentId, deploymentId))
    .orderBy(desc(schema.deploymentJobs.createdAt))
    .limit(1);
  return latest?.type === 'DESTROY';
}

/** Whether any INSTALL job for this deployment ever finished successfully. */
async function hasSucceededInstall(db: RuntimeDb, deploymentId: string): Promise<boolean> {
  const installJobs = await db
    .select({ state: schema.deploymentJobs.state })
    .from(schema.deploymentJobs)
    .where(
      and(
        eq(schema.deploymentJobs.deploymentId, deploymentId),
        eq(schema.deploymentJobs.type, 'INSTALL'),
      ),
    );
  return installJobs.some((j) => j.state === 'SUCCEEDED' || j.state === 'SUCCESS');
}

// resolveAppUrl now lives in ./fleet-row.js, alongside toFleetRow.

/** The health path the application template checks by default. */
const DEFAULT_HEALTH_PATH = '/health';

/**
 * §10.2 + Phase 11 the URL the relay probes once per poll: whatever endpoint
 * currently serves the deployment, plus the application's configured health
 * path. Single source of truth: the base is resolveAppUrl (fleet-row.ts) —
 * the exact URL the product surfaces (ACTIVE custom domain, else the
 * default-HTTPS hostname once ACTIVE/CONFIGURING, else the ALB) — so the
 * relay probes precisely what a customer would click. The control plane
 * knows all of these and hands the full URL to the relay in each poll's
 * deployment meta, so the relay never has to resolve either inside the
 * customer account. Null when no endpoint exists yet — the relay then omits
 * the probe.
 * `jobs` must be ascending by createdAt.
 */
function resolveProbeUrl(
  jobs: ReadonlyArray<Pick<DeploymentJobRow, 'type' | 'state' | 'result'>>,
  healthPath: string | null,
  domain: Pick<CustomDomainRow, 'hostname' | 'status'> | null,
  defaultHttps: { hostname: string; status: string } | null,
): string | null {
  const base = resolveAppUrl(jobs, domain, defaultHttps);
  if (!base) return null;
  const trimmed = healthPath?.trim() ?? '';
  const path = trimmed.length > 0 ? trimmed : DEFAULT_HEALTH_PATH;
  return `${base.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * Paddle migration Phase 9 — pushes the absolute live-deployment count onto
 * the subscription after a billing state actually changed. Always called
 * OUTSIDE the caller's transaction: a Paddle round trip must never hold a
 * database connection open. Never throws — reconcileBilling records its own
 * failure, and the Phase 10 safety job retries the drift.
 */
async function reconcileAfterBillingChange(
  db: RuntimeDb,
  paddle: PaddleBilling | null,
  organizationId: string,
): Promise<void> {
  const result = await reconcileBilling({ db, paddle }, organizationId);
  if (result.status === 'FAILED') {
    console.error(
      JSON.stringify({ event: 'billing:reconcile-failed', organizationId, error: result.reason }),
    );
  }
}

/**
 * Step-timings follow-up shared by both relay-authenticated write paths
 * (POST /api/relay/health and the job-result handler below): re-derive the
 * deployment's status from the values THEY just wrote (not the stale
 * pre-transaction row — deriveDeploymentStatus is read-time, so a stale row
 * would compute yesterday's step), advance the persisted `step_timings`
 * against it, and record one `deployment.step_completed` event per step that
 * newly finished.
 *
 * Best-effort by design, same idiom as reconcileRunningDigest's call site
 * below: a relay heartbeat or job result must never fail because this
 * observational side channel had a bad day. Callers wrap this in try/catch
 * and log rather than propagate.
 *
 * `knownDomain` lets a caller that already looked up the active domain this
 * request (the health handler does, further down, for its own DNS
 * auto-check) hand it over instead of paying for a second identical query;
 * omit it and this fetches its own.
 */
async function advanceStepTimingsAfterWrite(
  db: RuntimeDb,
  paddle: PaddleBilling | null,
  freshDeployment: DeploymentRow,
  knownDomain?: CustomDomainRow | null,
): Promise<void> {
  const applicationRows = await db
    .select({ migrationCommand: schema.applications.migrationCommand })
    .from(schema.applications)
    .where(eq(schema.applications.id, freshDeployment.applicationId))
    .limit(1);
  const application = derivationApplicationFor(freshDeployment, applicationRows[0] ?? null);

  const jobs = await db
    .select()
    .from(schema.deploymentJobs)
    .where(eq(schema.deploymentJobs.deploymentId, freshDeployment.id))
    .orderBy(schema.deploymentJobs.createdAt);
  const domain = knownDomain !== undefined ? knownDomain : await findActiveDomain(db, freshDeployment.id);
  const defaultHttps = parseDefaultHttps(freshDeployment.defaultHttps);
  const appUrl = resolveAppUrl(jobs, domain, defaultHttps);

  const derived = deriveDeploymentStatus({ deployment: freshDeployment, application, jobs, domain, defaultHttps, appUrl });

  // Paddle migration Phase 2 (R0-2): the first observed READY stage is the
  // billing-activation signal. Independent of the step-timings write below —
  // it must run even when `changed` is false — and never allowed to fail
  // this best-effort follow-up, same contract as every other side effect here.
  if (derived.stage === 'READY') {
    try {
      // Phase 9: reconcile only when the billing state ACTUALLY moved. A
      // heartbeat on an already-billing deployment must not pay for a Paddle
      // round trip, and the Phase 10 job sweeps up any drift regardless.
      if (await markDeploymentLive(db, freshDeployment, new Date())) {
        await reconcileAfterBillingChange(db, paddle, freshDeployment.organizationId);
      }
    } catch (error) {
      console.error(JSON.stringify({ event: 'billing:mark-live-failed', deploymentId: freshDeployment.id, error: String(error) }));
    }
  }

  const { next, changed, completedSteps } = advanceStepTimings(freshDeployment.stepTimings, derived, new Date());
  if (!changed) return;

  await db.transaction(async (tx) => {
    await tx
      .update(schema.deployments)
      .set({ stepTimings: next })
      .where(eq(schema.deployments.id, freshDeployment.id));
    for (const completed of completedSteps) {
      await recordEvent(tx, {
        organizationId: freshDeployment.organizationId,
        eventType: 'deployment.step_completed',
        actorType: 'relay',
        actorId: freshDeployment.installationId ?? freshDeployment.id,
        deploymentId: freshDeployment.id,
        customerId: freshDeployment.customerId,
        payload: {
          step: completed.step,
          startedAt: completed.startedAt,
          completedAt: completed.completedAt,
          durationSeconds: completed.durationSeconds,
        },
      });
    }
  });
}

// Shared by both public status routes (GET /api/install/:installLinkId/status
// and GET /api/deploy-links/:publicId/status) so they can never diverge on
// what live progress looks like. Stack events are loaded ONLY when the stage
// can actually use them (PROVISIONING/FAILED) — one bounded query, the latest
// INSTALL job's events, newest first — since these routes are unauthenticated
// and rate-limited.
async function loadCustomerLiveProgress(
  db: RuntimeDb,
  derived: DerivedDeploymentStatus,
  params: {
    deploymentId: string;
    jobs: { id: string; type: JobType }[];
    domain: CustomDomainRow | null;
    defaultHttps: DefaultHttpsState | null;
    stepTimings: DeploymentRow['stepTimings'];
    cleanupState: DeploymentRow['cleanupState'];
    launched: boolean;
    /** The deployment's frozen spec — feeds the spec-component fallbacks. */
    specV2: DeploymentRow['specV2'];
  },
): Promise<{ progress: CustomerLiveProgress; stackEvents: StoredStackEvent[] }> {
  const installJob = [...params.jobs].reverse().find((job) => job.type === 'INSTALL') ?? null;

  // A failure of a later job (a release, a restart) has no stack events of
  // its own: the install's events would describe a different operation.
  const stackOperationActive =
    derived.stage === 'PROVISIONING' ||
    (derived.stage === 'FAILED' && derived.failure?.jobType === 'INSTALL');
  let events: StoredStackEvent[] = [];
  if (stackOperationActive && installJob) {
    const rows = await db
      .select({
        eventAt: schema.deploymentStackEvents.eventAt,
        logicalResourceId: schema.deploymentStackEvents.logicalResourceId,
        resourceType: schema.deploymentStackEvents.resourceType,
        resourceStatus: schema.deploymentStackEvents.resourceStatus,
        resourceStatusReason: schema.deploymentStackEvents.resourceStatusReason,
      })
      .from(schema.deploymentStackEvents)
      .where(
        and(
          eq(schema.deploymentStackEvents.deploymentId, params.deploymentId),
          eq(schema.deploymentStackEvents.jobId, installJob.id),
        ),
      )
      .orderBy(desc(schema.deploymentStackEvents.eventAt), desc(schema.deploymentStackEvents.id))
      .limit(200);
    events = rows;
  }

  // Same precedence deployment-status.ts's httpsComponentStatus applies: a
  // custom domain, when present, over the Deployz-owned default endpoint.
  const https: LiveHttpsState | null = params.domain
    ? {
        hostname: params.domain.hostname,
        status: params.domain.status,
        lastError: params.domain.lastError,
        lastCheckedAt: params.domain.lastCheckedAt?.toISOString() ?? null,
      }
    : params.defaultHttps
      ? {
          hostname: params.defaultHttps.hostname,
          status: params.defaultHttps.status,
          lastError: params.defaultHttps.lastError,
          lastCheckedAt: params.defaultHttps.lastDnsCheckAt ?? null,
          deployzOwned: true,
        }
      : null;

  return {
    progress: buildCustomerLiveProgress({
      stage: derived.stage,
      step: derived.step,
      events,
      componentLabelByLogicalId: specComponentLabelByLogicalId(params.specV2),
      installJobId: installJob?.id ?? null,
      stepTimings: params.stepTimings,
      cleanupState: params.cleanupState,
      health: derived.health.layers,
      https,
      needsDomainSetup: derived.needsDomainSetup,
      launched: params.launched,
    }),
    // Reused by the caller for the spec-derived component list — loading them
    // twice would double the route's only event query.
    stackEvents: events,
  };
}

// Also shared by both public status routes: the READY-only AWS summary of the
// customer's own deployment — stored, non-secret facts, nothing derived from
// live AWS state. Undefined unless the stage is READY (before that there is
// no settled AWS footprint to summarize) and unless the relay enrolled (no
// installationId → no application stack to name). releaseVersion is the same
// source GET /api/install/:installLinkId uses for InstallData.releaseVersion
// — the releases row behind current_release_id, version string only. The
// endpoint and the last-verified time are deliberately absent: `url` and
// `updatedAt` already carry them.
async function loadCustomerAwsSummary(
  db: RuntimeDb,
  derived: DerivedDeploymentStatus,
  deployment: Pick<DeploymentRow, 'installationId' | 'region' | 'currentReleaseId'>,
): Promise<CustomerDeploymentStatus['awsSummary']> {
  if (derived.stage !== 'READY' || !deployment.installationId) {
    return undefined;
  }
  const releases = deployment.currentReleaseId
    ? await db
        .select({ version: schema.releases.version })
        .from(schema.releases)
        .where(eq(schema.releases.id, deployment.currentReleaseId))
        .limit(1)
    : [];
  return {
    applicationStackName: applicationStackNameForInstallation(deployment.installationId),
    region: deployment.region,
    releaseVersion: releases[0]?.version ?? null,
  };
}

/**
 * §46 deployment state a finished job leaves behind. The relay reporting a
 * command result is what actually moves a deployment through its lifecycle —
 * without this the fleet is stuck in INSTALLING forever, which silently
 * disables §25 bulk deploy (needs HEALTHY/UPDATE_AVAILABLE), §29 diagnostics
 * (needs FAILED) and billing (bills only HEALTHY/UPDATE_AVAILABLE deployments).
 *
 * Mirrors the transitions the packages/cdk job workflows already model. A job
 * type absent from this map leaves the state alone — CONFIG_UPDATE is
 * non-disruptive (§31), so a config write must not disturb the lifecycle.
 *
 * INSTALL is deliberately absent: a CloudFormation CREATE_COMPLETE does not
 * prove the application is running. The deployment stays in INSTALLING until
 * the relay's runtime health verification reports HEALTHY (see the
 * /api/relay/health handler, which advances INSTALLING → HEALTHY), so a
 * "healthy" state always means observed-healthy, never just stack-complete.
 */
const JOB_SUCCESS_STATE: Partial<Record<JobType, DeploymentRow['state']>> = {
  DEPLOY_RELEASE: 'HEALTHY',
  ROLLBACK: 'HEALTHY',
  RESTART: 'HEALTHY',
  DESTROY: 'DELETED',
};

/**
 * Job types whose SUCCESS names a release in the audit event. §10.3: these no
 * longer advance the release pointer at result time — the heartbeat's digest
 * reconciliation does, once the HTTP probe and every ECS/ALB gate pass. This
 * set now only decides which jobs carry a releaseId on their event.
 */
const RELEASE_ADVANCING_JOBS = new Set<JobType>(['DEPLOY_RELEASE', 'ROLLBACK']);

/**
 * Parameters the control plane GENERATES at install time — their values are
 * secrets. `redactClaimedPayload` scrubs these from the INSTALL job payload
 * once the relay has claimed it, so generated install secrets do not sit in
 * `deployment_jobs.payload` indefinitely (§31 "stop storing generated install
 * secrets unnecessarily in job payloads").
 */
const INSTALL_SECRET_PARAMETER_IDS = new Set<string>([
  APP_API_KEY_PARAMETER,
  APP_SIGNING_SECRET_PARAMETER,
]);

/**
 * The relay receives a command's payload exactly once, at claim time
 * (`GET /api/relay/commands`). After that response the stored row never
 * needs the plaintext again, so the claim handler scrubs it in the same
 * request that serves it:
 *  - CONFIG_UPDATE: newly-entered secret VALUES (transport-only) become
 *    key stubs — the DB keeps key names, never values.
 *  - INSTALL: generated secret parameter values become SECRET_MASK; plain
 *    parameters (image reference, desired count) survive untouched.
 */
export function redactClaimedPayload(job: {
  readonly type: string;
  readonly payload: Record<string, unknown> | null;
}): Record<string, unknown> | null {
  const payload = job.payload;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return payload;

  if (job.type === 'CONFIG_UPDATE' && Array.isArray(payload['secrets'])) {
    return {
      ...payload,
      secrets: (payload['secrets'] as { key?: unknown }[]).map((entry) => ({
        key: typeof entry.key === 'string' ? entry.key : '',
      })),
    };
  }

  if (job.type === 'INSTALL' && typeof payload['parameters'] === 'object' && payload['parameters'] !== null) {
    const parameters = payload['parameters'] as Record<string, unknown>;
    const redacted: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parameters)) {
      redacted[key] = INSTALL_SECRET_PARAMETER_IDS.has(key) ? SECRET_MASK : value;
    }
    return { ...payload, parameters: redacted };
  }

  return payload;
}

/** §40 event type per job outcome. Job types with no vendor-visible event are absent. */
  const JOB_RESULT_EVENT: Partial<
    Record<JobType, { completed: DeploymentEventType; failed: DeploymentEventType }>
  > = {
  INSTALL: { completed: 'install.completed', failed: 'install.failed' },
  DEPLOY_RELEASE: { completed: 'deploy.completed', failed: 'deploy.failed' },
  ROLLBACK: { completed: 'rollback.completed', failed: 'rollback.failed' },
  RESTART: { completed: 'restart.completed', failed: 'restart.failed' },
  DESTROY: { completed: 'destroy.completed', failed: 'destroy.failed' },
  // Without these, a CONFIG_UPDATE result vanished: the job row held the
  // relay's error but nothing reached the activity feed (verified live).
  CONFIG_UPDATE: { completed: 'config.updated', failed: 'config.failed' },
  PURGE: { completed: 'purge.completed', failed: 'purge.failed' },
};

// Control-plane surface: /health, /api/me, /api/auth/*.
// Errors cross the boundary as structured envelopes via toErrorEnvelope;
// Sentry capture lives in its onError hook (never in the render path).
/** One install-page visit makes several reads; count them as one open. */
const INSTALL_LINK_OPENED_DEDUPE_MS = 5 * 60 * 1000;

export async function buildServer({
  auth,
  db,
  githubWebhookSecret,
  githubFixtureMode,
  githubAppInstallUrl,
  analysisRunner,
  emailSender,
  ecrClient,
  releaseImages: injectedReleaseImages,
  buildLogReader = env.buildLogGroupName ? createCloudWatchBuildLogReader(env.buildLogGroupName) : null,
  githubFetch: injectedGithubFetch,
  githubAppId: injectedGithubAppId,
  githubAppPrivateKey: injectedGithubAppPrivateKey,
  aiGateway = env.aiFixtureMode ? createFixtureAiGateway() : createAiGateway(env.aiGateway),
  fixInstructionsAiGateway: injectedFixInstructionsAiGateway,
  jevFailureShadow = createJevFailureShadowRunnerFromEnv({ db }, env.jev),
  domainCheckDeps = env.domainFixtureMode ? createFixtureDomainCheckDeps() : createRealDomainCheckDeps(),
  defaultHttpsDeps: injectedDefaultHttpsDeps,
  teamAdminEmails = env.teamAdminEmails,
  teamAdminEnvGrantsEnabled = env.teamAdminEnvGrantsEnabled,
  loggerInstance,
  paddle = createPaddle(),
  billingFixtureMode,
  // Compiler-v2 artifact publication: the real S3 publisher only in the
  // deployed Lambda (env.releaseImageRegistryEnabled); simulated E2E, tests
  // and local dev get the no-op, so deployment creation never touches S3.
  templatePublisher = env.releaseImageRegistryEnabled
    ? createS3TemplatePublisher()
    : NO_OP_TEMPLATE_PUBLISHER,
}: ServerDeps): Promise<FastifyInstance> {
  const fixInstructionsAiGateway =
    injectedFixInstructionsAiGateway ??
    (env.aiFixtureMode ? createFixtureAiGateway() : createAiGateway(env.fixInstructionsAi));
  const billingFixtureModeResolved = billingFixtureMode ?? env.billingFixtureMode;
  // Phase 1.1: the ECR grant lifecycle. Best-effort by design — a failing
  // grant must not fail the install request that owns it (see ecr-pull-grants.ts).
  const ecrGrantDeps: EcrPullGrantDeps = createEcrPullGrantDeps(ecrClient);
  // Release-image availability: the real registry client only in the
  // deployed Lambda (env.releaseImageRegistryEnabled); everywhere else the
  // scriptable fixture, whose internal route below exists only under
  // BUILD_FIXTURE_MODE (E2E) and never in production.
  const fixtureReleaseImages =
    injectedReleaseImages === undefined && !env.releaseImageRegistryEnabled
      ? createFixtureReleaseImageClient()
      : null;
  const releaseImages: ReleaseImageClient =
    injectedReleaseImages ?? fixtureReleaseImages ?? createRealReleaseImageClient();
  // Phase 11 default HTTPS. Fixture mode (E2E) wins; production uses the
  // Cloudflare DNS client when the deployz.dev zone is configured, falls
  // back to the legacy Route53 writer while it still exists, and is off when
  // no zone is configured. Off means a deployment needs a custom domain for
  // HTTPS, exactly as before Phase 11.
  // Phase 14 simulated E2E: under BOTH fixture flags the default-HTTPS DNS
  // provider is an assertable/failure-scriptable in-memory fake (see
  // default-https-fixture.ts), exposed to scenarios over the gated
  // `/internal/fixture/default-dns-*` endpoints below. Production never
  // constructs it (the flags are off and are scrubbed from the deploy env),
  // so those routes do not exist in production at all.
  const fixtureDefaultDnsProvider: DefaultHttpsFixtureProvider | null =
    env.domainFixtureMode && env.defaultHttpsFixtureMode
      ? createDefaultHttpsFixtureProvider(DEFAULT_HTTPS_FIXTURE_APEX, env.defaultHostnamePrefix)
      : null;
  const defaultHttpsDeps: DefaultHttpsDeps = (() => {
    if (injectedDefaultHttpsDeps) {
      return injectedDefaultHttpsDeps;
    }
    // DNS fixture mode first: the E2E fixture namespace is not real DNS, so
    // the writer is a no-op regardless of any zone env vars.
    if (env.domainFixtureMode) {
      return {
        enabled: env.defaultHttpsFixtureMode,
        apex: DEFAULT_HTTPS_FIXTURE_APEX,
        prefix: env.defaultHostnamePrefix,
        dns:
          fixtureDefaultDnsProvider?.client ??
          createDnsClientFromNameWriter(noopDnsRecordClient, {
            zoneName: DEFAULT_HTTPS_FIXTURE_APEX,
            prefix: env.defaultHostnamePrefix,
          }),
        probeHttps: (hostname) => domainCheckDeps.probeHttps(hostname),
        // The simulated relay polls every few milliseconds; the production
        // minimum interval would stall every scenario.
        minAttemptIntervalMs: 0,
      };
    }
    const apex = DEFAULT_HTTPS_APEX;
    const cloudflareToken = env.cloudflareZoneApiToken;
    const cloudflareZoneId = env.cloudflareZoneId;
    const cloudflareZoneName = env.cloudflareZoneName;
    if (cloudflareToken && cloudflareZoneId && cloudflareZoneName) {
      // Cloudflare is authoritative for the deployz.dev apex.
      return {
        enabled: true,
        apex: cloudflareZoneName,
        prefix: env.defaultHostnamePrefix,
        dns: createCloudflareDnsClient({
          token: cloudflareToken,
          zoneId: cloudflareZoneId,
          zoneName: cloudflareZoneName,
          prefix: env.defaultHostnamePrefix,
        }),
        probeHttps: (hostname) => domainCheckDeps.probeHttps(hostname),
      };
    }
    // Phase 16: the legacy Route53 default-HTTPS writer was removed — the
    // Cloudflare client is the only provider. Without Cloudflare config the
    // flow is off (a deployment then needs a custom domain for HTTPS).
    return {
      enabled: false,
      apex,
      prefix: env.defaultHostnamePrefix,
      dns: createDnsClientFromNameWriter(noopDnsRecordClient, {
        zoneName: apex,
        prefix: env.defaultHostnamePrefix,
      }),
      probeHttps: (hostname) => domainCheckDeps.probeHttps(hostname),
    };
  })();
  // `logger: false` meant a 500 left NO trace anywhere: not in CloudWatch, not
  // in the response (the envelope is deliberately generic), nowhere. Three
  // production failures in a row could only be diagnosed by reading
  // configuration and guessing. `warn` keeps the per-request info lines off
  // while letting the error handler below say what actually broke.
  // trustProxy: production runs behind API Gateway + Lambda, so request.ip
  // is the gateway unless X-Forwarded-For is honored — and the per-IP rate
  // limit on the public install routes would otherwise pool every customer
  // into the gateway's single bucket. The Lambda is only reachable through
  // that gateway, so the header is trustworthy here.
  const app = Fastify(
    loggerInstance
      ? { loggerInstance, trustProxy: true }
      : { logger: { level: 'warn' }, trustProxy: true },
  );

  // Sentry owns capture via the onError hook this registers. Capture filter:
  // ApiError 4xx are expected client errors — not reportable; everything else
  // (5xx ApiError, unknown throws) is. Do NOT captureException in the custom
  // error handler below — that would double-report.
  setupFastifyErrorHandler(app, {
    shouldHandleError: (error) => !(error instanceof ApiError) || error.statusCode >= 500,
  });

  // Single render path for every thrown error: structured envelope, no stack
  // traces, no internal messages.
  app.setErrorHandler((error, request, reply) => {
    const { statusCode, body } = toErrorEnvelope(error);
    // The envelope a 5xx returns is generic on purpose — it must not leak
    // internals to the caller. That makes the log the ONLY place the real
    // cause survives, so write it there.
    if (statusCode >= 500) {
      request.log.error(
        { err: error, method: request.method, url: request.url, code: body.error.code },
        'request failed',
      );
    }
    return reply.code(statusCode).send(body);
  });

  // Browser origin differs by port; cookies are host-scoped, so credentialed
  // CORS + trustedOrigins is the whole cookie story. `methods` must be listed
  // explicitly: the default is GET,HEAD,POST, which fails the preflight for
  // the config PUT and the organization PATCH.
  await app.register(cors, {
    origin: [...env.webOrigins],
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  // §12/§44 the three public install-link routes take no auth at all, so
  // they are the one surface an anonymous caller could hammer. `global:
  // false` means registering this plugin does nothing by itself — every
  // other route (authenticated or relay-token-authenticated) stays
  // unaffected; only the routes below that opt in with `config.rateLimit`
  // are capped. 120/min per IP is generous headroom over the install page's
  // own 5s status-poll cadence (12/min) while still bounding abuse.
  await app.register(rateLimit, { global: false });

  app.get('/health', () => ({ ok: true }));

  // Stable, minimal readiness probe for external monitors: no internal or
  // customer detail crosses this boundary — reachability is the whole answer.
  app.get('/api/health', () => ({ status: 'ok' }));

  // DZ-AUDIT-015: readiness endpoint that proves the process answers AND the
  // DB is reachable. Used by the deploy workflow's health check instead of the
  // static /health probe, so a silent DB failure (migration-wedge, credential
  // expiry) is caught before traffic is routed here. Cheap, non-destructive,
  // no internal details in the response.
  app.get('/health/ready', async () => {
    try {
      await db.execute(sql`SELECT 1`);
      // Proves the migrated schema is queryable, not just that the DB
      // answers — a deployment whose migrations never applied must fail the
      // deploy workflow's probe visibly (DZ-AUDIT-015).
      await db.execute(sql`SELECT 1 FROM deployments LIMIT 1`);
    } catch {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Service not ready');
    }
    return { ok: true };
  });

  // ── Fixture-only default-HTTPS DNS surface (Phase 14 simulated E2E) ───────
  // Registered ONLY when the in-memory provider exists (both fixture flags on,
  // see `fixtureDefaultDnsProvider` above). In any other boot these routes do
  // not exist and answer Fastify's default 404 — an internal test surface can
  // never be enabled in production, exactly like the scenario-control absence
  // scripts/production-safety.test.mjs pins. They carry no auth: they are gated by
  // environment, and the simulated suite is the only environment they exist in.
  if (fixtureDefaultDnsProvider) {
    const snapshot = () => ({
      records: fixtureDefaultDnsProvider.records().map((record) => ({
        name: record.name,
        content: record.content,
        type: record.type,
        proxied: record.proxied,
        comment: record.comment,
      })),
      remainingFailures: fixtureDefaultDnsProvider.remainingFailures(),
      mutations: fixtureDefaultDnsProvider.mutations(),
    });

    app.get('/internal/fixture/default-dns-records', async () => snapshot());

    // Plant a RAW record (bypassing the namespace guard) so a scenario can
    // model exactly what a leftover/hostile zone might hold and prove the
    // purge reconciliation never mutates it.
    app.post('/internal/fixture/default-dns-records', async (request) => {
      const body = request.body as { name?: unknown; content?: unknown; proxied?: unknown };
      if (typeof body?.name !== 'string' || typeof body?.content !== 'string') {
        throw new ApiError(400, 'INVALID_REQUEST', 'name and content are required');
      }
      fixtureDefaultDnsProvider.plantRecord(body.name, body.content, body.proxied === true);
      return snapshot();
    });

    // Script the next `count` DNS operations to fail (FIFO), consumed by the
    // default-HTTPS machine's writes — drives the Phase 12 watchdog and the
    // rate-limit path end to end. `deploymentId` scopes the script to one
    // deployment so parallel simulated scenarios never consume each other's.
    // Scenario time control for the elapsed configure budget: `clear` drops a
    // deployment's unconsumed failures; `ageMs` moves its budget start back.
    app.post('/internal/fixture/default-https-budget', async (request) => {
      const body = request.body as { deploymentId?: unknown; ageMs?: unknown; clear?: unknown };
      if (typeof body?.deploymentId !== 'string') {
        throw new ApiError(400, 'INVALID_REQUEST', 'deploymentId is required');
      }
      if (body.clear === true) {
        fixtureDefaultDnsProvider.clearFailures(body.deploymentId);
      }
      if (typeof body.ageMs === 'number') {
        const [row] = await db
          .select({ defaultHttps: schema.deployments.defaultHttps })
          .from(schema.deployments)
          .where(eq(schema.deployments.id, body.deploymentId))
          .limit(1);
        const state = parseDefaultHttps(row?.defaultHttps ?? null);
        if (state?.configureStartedAt) {
          const aged = { ...state, configureStartedAt: new Date(Date.parse(state.configureStartedAt) - body.ageMs).toISOString() };
          await db
            .update(schema.deployments)
            .set({ defaultHttps: aged as unknown as Record<string, unknown> })
            .where(eq(schema.deployments.id, body.deploymentId));
        }
      }
      return snapshot();
    });

    app.post('/internal/fixture/default-dns-failures', async (request) => {
      const body = request.body as { code?: unknown; count?: unknown; deploymentId?: unknown };
      const code = body?.code;
      const count = typeof body?.count === 'number' && Number.isInteger(body.count) ? body.count : 0;
      const deploymentId = typeof body?.deploymentId === 'string' ? body.deploymentId : undefined;
      if (code !== 'unavailable' && code !== 'rate_limit') {
        throw new ApiError(400, 'INVALID_REQUEST', 'code must be "unavailable" or "rate_limit"');
      }
      fixtureDefaultDnsProvider.queueFailures(count, code as FixtureDnsFailureCode, deploymentId);
      return snapshot();
    });
  }

  if (fixtureReleaseImages && env.buildFixtureMode) {
    // Model an image deleted from the registry after a page listed the
    // release, so the simulated suite can prove the deploy-time guard.
    app.post('/internal/fixture/release-images', async (request) => {
      const body = request.body as { releaseId?: unknown; missing?: unknown };
      if (typeof body?.releaseId !== 'string' || typeof body?.missing !== 'boolean') {
        throw new ApiError(400, 'INVALID_REQUEST', 'releaseId and missing are required');
      }
      const [release] = await db
        .select({ imageDigest: schema.releases.imageDigest })
        .from(schema.releases)
        .where(eq(schema.releases.id, body.releaseId))
        .limit(1);
      const digest = release?.imageDigest?.slice(release.imageDigest.lastIndexOf('@') + 1);
      if (!digest) throw new NotFoundError('Release not found');
      if (body.missing) fixtureReleaseImages.markMissing(digest);
      else fixtureReleaseImages.restore(digest);
      return fixtureReleaseImages.snapshot();
    });
  }

  // GitHub and Paddle webhooks verify signatures over the raw body, so
  // register a raw-json parser for those routes before the JSON parser
  // consumes them. A bad signature -> 400/401 structured envelope.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string', bodyLimit: 1048576 },
    (request, body, done) => {
      const rawWebhook =
        request.raw.url?.startsWith('/api/github/webhook') ||
        request.raw.url?.startsWith('/api/billing/webhook');
      if (rawWebhook) {
        done(null, body);
        return;
      }
      try {
        done(null, JSON.parse(body as string));
      } catch (error) {
        done(error as Error);
      }
    },
  );

  // GitHub App webhook: signature-verified via X-Hub-Signature-256 over the
  // raw body. The account->org resolver (#13) matches the GitHub login to
  // the organization slug — sufficient for the MVP since vendor orgs are
  // created with their GitHub org name as the slug.
  const githubStore = createGithubStore(db);
  const githubFetch: FetchFn = injectedGithubFetch ?? globalThis.fetch.bind(globalThis);
  const githubAppId = injectedGithubAppId ?? env.githubAppId;
  const githubAppPrivateKey = injectedGithubAppPrivateKey ?? env.githubAppPrivateKey;
  // §18/§19: real GitHub-backed analysis by default; tests inject a fake
  // via ServerDeps.analysisRunner instead of hitting GitHub.
  const runAnalysis: AnalysisRunner =
    analysisRunner ??
    createAnalysisRunner({
      db,
      fetchFn: githubFetch,
      githubAppId,
      githubAppPrivateKey,
      githubFixtureMode: githubFixtureMode ?? env.githubFixtureMode,
      aiGateway,
      // Shadow-only: a disabled/partial Jev config resolves to the noop
      // runner, and the runner never affects the analysis outcome.
      jevShadow: createJevShadowRunnerFromEnv({ db }, env.jev),
    });
  app.post('/api/github/webhook', async (request, reply) => {
    const webhookSecret = githubWebhookSecret ?? env.githubWebhookSecret;
    if (!webhookSecret) {
      throw new ApiError(503, 'GITHUB_DISABLED', 'GitHub App is not configured');
    }
    const signature = request.headers['x-hub-signature-256'];
    const rawBody = request.body as string;
    if (!verifyWebhookSignature(rawBody, Array.isArray(signature) ? signature[0] : signature, webhookSecret)) {
      throw new ApiError(400, 'WEBHOOK_SIGNATURE_INVALID', 'Webhook signature verification failed');
    }
    const body = JSON.parse(rawBody) as {
      action?: string | undefined;
      installation?: { id: number; account?: { login: string; type?: string } | undefined } | undefined;
      sender?: { login: string } | undefined;
    };
    const event: GithubWebhookEvent = {
      type: String(request.headers['x-github-event'] ?? ''),
      action: body.action,
      installation: body.installation,
      sender: body.sender,
    };
    const handled = await handleInstallationWebhook(githubStore, event);
    return reply.code(200).send({ received: true, handled });
  });

  const requireAuth = createRequireAuth({
    auth,
    db,
    teamAdminEmails,
    envGrantsEnabled: teamAdminEnvGrantsEnabled,
  });
  const requireTeamAdmin = createRequireTeamAdmin({
    requireAuth,
    teamAdminEmails,
    envGrantsEnabled: teamAdminEnvGrantsEnabled,
  });

  const organizationDeps: OrganizationDeps = {
    db,
    emailSender: emailSender ?? createEmailSender(),
    webUrl: env.webUrl,
  };

  // Fixture-only billing surface (Paddle migration Phase 7 CI fixture mode).
  // Every fresh organization already gets an ACTIVE subscription under
  // billingFixtureMode (organizations.ts createOrganization, auth.ts's
  // signup session hook) — this route lets a scenario drive
  // PAST_DUE/PAUSED/CANCELED/evaluation (null) on top of that. Session-
  // authenticated (unlike the DNS/release-image fixture routes above)
  // because it acts on the caller's own organization. Registered only under
  // billingFixtureMode, so it does not exist in production.
  if (billingFixtureModeResolved) {
    app.post(
      '/internal/fixture/billing/subscription',
      { preHandler: requireAuth },
      async (request) => {
        const organizationId = requireSessionOrganizationId(request);
        const body = request.body as { status?: unknown };
        if (body?.status !== null && !billingSubscriptionStatusSchema.safeParse(body?.status).success) {
          throw new ApiError(
            400,
            'INVALID_REQUEST',
            "status must be 'ACTIVE', 'PAST_DUE', 'PAUSED', 'CANCELED', or null",
          );
        }
        if (body.status === null) {
          await db
            .delete(schema.billingSubscriptions)
            .where(eq(schema.billingSubscriptions.organizationId, organizationId));
          return { subscriptionStatus: null };
        }
        const status = body.status as BillingSubscriptionStatus;
        const now = new Date();
        const currentPeriodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
        await db
          .insert(schema.billingSubscriptions)
          .values({
            organizationId,
            providerCustomerId: `ctm_fixture_${organizationId}`,
            providerSubscriptionId: `sub_fixture_${organizationId}`,
            status,
            currentPeriodStart: now,
            currentPeriodEnd,
          })
          .onConflictDoUpdate({
            target: schema.billingSubscriptions.organizationId,
            set: { status, currentPeriodStart: now, currentPeriodEnd },
          });
        return { subscriptionStatus: status };
      },
    );
  }

  app.get('/api/me', { preHandler: requireAuth }, async (request) => ({
    user: request.user ?? null,
    // Paddle migration Phase 11: the active organization carries its
    // subscription status so the dashboard shell can raise a past-due or
    // canceled banner without a second round trip. Read here rather than
    // looked up from `organizations` on the client, because in a support
    // session `organization` is the VENDOR's while `organizations` is the
    // admin's own memberships — the lookup would silently find nothing.
    organization: request.organization
      ? {
          ...request.organization,
          subscriptionStatus: await getSubscriptionStatus(db, request.organization.id),
        }
      : null,
    role: request.member?.role ?? null,
    organizations: request.user ? await listOrganizations(db, request.user.id) : [],
    isTeamAdmin: request.user
      ? isTeamAdmin(request.user, teamAdminEmails, teamAdminEnvGrantsEnabled)
      : false,
    supportMode:
      request.supportMode && request.organization
        ? { organizationId: request.organization.id, organizationName: request.organization.name }
        : null,
  }));

  registerAdminRoutes(app, {
    db,
    paddle,
    requireTeamAdmin,
    performRetryInstall,
    performRollback,
    performForceCompleteDestroy,
    performRelayReset,
  });

  // ── Organizations ───────────────────────────────────────────────

  // Every organization the caller belongs to — the tenant switcher's data.
  app.get('/api/organizations', { preHandler: requireAuth }, async (request) => ({
    organizations: await listOrganizations(db, requireActor(request).id),
  }));

  app.post('/api/organizations', { preHandler: requireAuth }, async (request, reply) => {
    const body = createOrganizationBodySchema.parse(request.body);
    const created = await createOrganization(
      db,
      requireActor(request),
      requireSessionId(request),
      body,
      billingFixtureModeResolved,
    );
    return reply.code(201).send(created);
  });

  // Switch the active tenant. Membership is re-checked here, so an id the
  // caller does not belong to is a 404, not a switch.
  app.post('/api/organizations/:id/activate', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    return activateOrganization(db, requireActor(request), requireSessionId(request), id);
  });

  // §41 screen 18 organization settings.
  app.get('/api/organization', { preHandler: requireAuth }, async (request) => {
    const organization = requireSessionOrganization(request);
    const members = await listMembers(db, organization.id);
    const subscriptionStatus = await getSubscriptionStatus(db, organization.id);
    return {
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      subscriptionStatus,
      createdAt: organization.createdAt,
      role: requireRole(request),
      memberCount: members.length,
    };
  });

  app.patch('/api/organization', { preHandler: requireAuth }, async (request) => {
    const organizationId = requireSessionOrganizationId(request);
    const body = updateOrganizationBodySchema.parse(request.body);
    const row = await updateOrganization(
      db,
      requireActor(request),
      organizationId,
      requireRole(request),
      body,
    );
    const subscriptionStatus = await getSubscriptionStatus(db, organizationId);
    return { id: row.id, name: row.name, slug: row.slug, subscriptionStatus, createdAt: row.createdAt };
  });

  app.delete('/api/organization', { preHandler: requireAuth }, async (request, reply) => {
    const organizationId = requireSessionOrganizationId(request);
    const body = deleteOrganizationBodySchema.parse(request.body);
    await deleteOrganization(
      db,
      organizationDeps,
      requireActor(request),
      organizationId,
      requireRole(request),
      body,
    );
    return reply.code(204).send();
  });

  // ── Members ────────────────────────────────────────────────────

  app.get('/api/organization/members', { preHandler: requireAuth }, async (request) => ({
    members: await listMembers(db, requireSessionOrganizationId(request)),
  }));

  app.patch(
    '/api/organization/members/:memberId',
    { preHandler: requireAuth },
    async (request) => {
      const { memberId } = request.params as { memberId: string };
      const body = updateMemberRoleBodySchema.parse(request.body);
      return updateMemberRole(
        db,
        organizationDeps,
        requireActor(request),
        requireSessionOrganizationId(request),
        requireRole(request),
        memberId,
        body,
      );
    },
  );

  app.delete(
    '/api/organization/members/:memberId',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { memberId } = request.params as { memberId: string };
      await removeMember(
        db,
        organizationDeps,
        requireActor(request),
        requireSessionOrganizationId(request),
        requireRole(request),
        memberId,
      );
      return reply.code(204).send();
    },
  );

  app.post('/api/organization/leave', { preHandler: requireAuth }, async (request, reply) => {
    await leaveOrganization(
      db,
      requireActor(request),
      requireSessionOrganizationId(request),
      requireRole(request),
    );
    return reply.code(204).send();
  });

  app.post(
    '/api/organization/transfer-ownership',
    { preHandler: requireAuth },
    async (request, reply) => {
      const body = transferOwnershipBodySchema.parse(request.body);
      await transferOwnership(
        db,
        organizationDeps,
        requireActor(request),
        requireSessionOrganizationId(request),
        requireRole(request),
        body,
      );
      return reply.code(204).send();
    },
  );

  // ── Invitations ─────────────────────────────────────────────

  app.get('/api/organization/invitations', { preHandler: requireAuth }, async (request) => ({
    invitations: await listInvitations(db, requireSessionOrganizationId(request)),
  }));

  app.post(
    '/api/organization/invitations',
    { preHandler: requireAuth },
    async (request, reply) => {
      const body = inviteMemberBodySchema.parse(request.body);
      const created = await createInvitation(
        organizationDeps,
        requireActor(request),
        requireSessionOrganizationId(request),
        requireRole(request),
        body,
      );
      return reply.code(201).send(created);
    },
  );

  app.post(
    '/api/organization/invitations/:invitationId/resend',
    { preHandler: requireAuth },
    async (request) => {
      const { invitationId } = request.params as { invitationId: string };
      return resendInvitation(
        organizationDeps,
        requireActor(request),
        requireSessionOrganizationId(request),
        requireRole(request),
        invitationId,
      );
    },
  );

  app.delete(
    '/api/organization/invitations/:invitationId',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { invitationId } = request.params as { invitationId: string };
      await revokeInvitation(
        db,
        requireActor(request),
        requireSessionOrganizationId(request),
        requireRole(request),
        invitationId,
      );
      return reply.code(204).send();
    },
  );

  // Pending invitations addressed to the caller, across every tenant.
  app.get('/api/invitations', { preHandler: requireAuth }, async (request) => ({
    invitations: await listInvitationsForEmail(db, requireActor(request).email),
  }));

  // UNAUTHENTICATED by design — the invitee may not have an account yet, and
  // the accept screen has to name the organization before they sign in. Only
  // non-sensitive display fields: no member list, no tenant internals.
  app.get('/api/invitations/:invitationId', async (request) => {
    const { invitationId } = request.params as { invitationId: string };
    return getPublicInvitation(db, invitationId);
  });

  app.post(
    '/api/invitations/:invitationId/accept',
    { preHandler: requireAuth },
    async (request) => {
      const { invitationId } = request.params as { invitationId: string };
      return acceptInvitation(
        organizationDeps,
        requireActor(request),
        requireSessionId(request),
        invitationId,
      );
    },
  );

  app.post(
    '/api/invitations/:invitationId/reject',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { invitationId } = request.params as { invitationId: string };
      await rejectInvitation(db, requireActor(request), invitationId);
      return reply.code(204).send();
    },
  );

  // ── Account ────────────────────────────────────────────────────

  app.delete('/api/account', { preHandler: requireAuth }, async (request, reply) => {
    const body = deleteAccountBodySchema.parse(request.body);
    await deleteAccount(db, organizationDeps, requireActor(request), body);
    return reply.code(204).send();
  });

  // §12/§44 public customer installation page. UNAUTHENTICATED by design —
  // the customer has no Deployz account. Only non-sensitive display fields:
  // never AWS account ids, tokens, config values, or internal db ids.
  // The public install page. Keyed on install_link_id, NOT on the relay's
  // installation id: the link is emailed to a customer and lives in browser
  // history, so it must not double as the identifier that authenticates a
  // relay. The enrollment code it returns is single-use and is what the
  // customer's bootstrap stack carries.
  /**
   * Vendor install-link lifecycle controls: view/revoke/replace the customer
   * invitation without touching the running deployment.
   */
  app.post(
    '/api/deployments/:id/install-link/revoke',
    { preHandler: requireAuth },
    async (request) => {
      const { id } = request.params as { id: string };
      const organizationId = requireSessionOrganizationId(request);
      const deployment = await loadOwnedDeployment(db, id, organizationId);
      return await revokeInstallLink(db, deployment, request.user!.id);
    },
  );

  app.post(
    '/api/deployments/:id/install-link/rotate',
    { preHandler: requireAuth },
    async (request) => {
      const { id } = request.params as { id: string };
      const organizationId = requireSessionOrganizationId(request);
      const deployment = await loadOwnedDeployment(db, id, organizationId);
      const result = await rotateInstallLink(db, deployment, request.user!.id);
      if ('refused' in result) {
        throw new ApiError(
          409,
          'INSTALL_ALREADY_STARTED',
          'This deployment has already been installed, so the link cannot be replaced.',
        );
      }
      return result;
    },
  );

  /**
   * Invitation lifecycle gate for the public install routes: a revoked or
   * expired link can no longer START an installation. A link whose install
   * has already started keeps working — the customer must still reach the
   * progress view for what already exists in their account.
   */
  function installLinkGate(row: {
    enrollmentUsedAt: Date | null;
    installLinkRevokedAt: Date | null;
    installLinkExpiresAt: Date | null;
  }): { code: 'INSTALL_LINK_REVOKED' | 'INSTALL_LINK_EXPIRED'; message: string } | null {
    if (row.enrollmentUsedAt !== null) return null;
    if (row.installLinkRevokedAt !== null) {
      return {
        code: 'INSTALL_LINK_REVOKED',
        message: 'This installation link was revoked by the publisher.',
      };
    }
    if (row.installLinkExpiresAt !== null && row.installLinkExpiresAt.getTime() <= Date.now()) {
      return {
        code: 'INSTALL_LINK_EXPIRED',
        message: 'This installation link has expired. Ask the publisher for a new one.',
      };
    }
    return null;
  }

  app.get(
    '/api/install/:installLinkId',
    { config: { rateLimit: PUBLIC_INSTALL_RATE_LIMIT } },
    async (request) => {
    const { installLinkId } = request.params as { installLinkId: string };
    requireUuidId(installLinkId);
    const rows = await db
      .select({
        applicationName: schema.applications.name,
        publisherName: schema.organization.name,
        customerName: schema.customers.name,
        region: schema.deployments.region,
        enrollmentCode: schema.deployments.enrollmentCode,
        enrollmentUsedAt: schema.deployments.enrollmentUsedAt,
        deploymentId: schema.deployments.id,
        deploymentState: schema.deployments.state,
        organizationId: schema.deployments.organizationId,
        customerId: schema.deployments.customerId,
        attemptNumber: schema.deployments.attemptNumber,
        bootstrapStackName: schema.deployments.bootstrapStackName,
        previousBootstrapStackName: schema.deployments.previousBootstrapStackName,
        installStartedAt: schema.deployments.installStartedAt,
        installLinkExpiresAt: schema.deployments.installLinkExpiresAt,
        installLinkRevokedAt: schema.deployments.installLinkRevokedAt,
        observedState: schema.deployments.observedState,
        relayCredential: schema.deployments.relayCredential,
        desiredState: schema.deployments.desiredState,
        specV2: schema.deployments.specV2,
        releaseVersion: schema.releases.version,
      })
      .from(schema.deployments)
      .innerJoin(schema.applications, eq(schema.deployments.applicationId, schema.applications.id))
      .innerJoin(schema.organization, eq(schema.deployments.organizationId, schema.organization.id))
      .innerJoin(schema.customers, eq(schema.deployments.customerId, schema.customers.id))
      .leftJoin(schema.releases, eq(schema.deployments.currentReleaseId, schema.releases.id))
      .where(eq(schema.deployments.installLinkId, installLinkId))
      .limit(1);
    if (rows.length === 0) {
      throw new NotFoundError('Installation not found');
    }
    const row = rows[0]!;
    // Spent codes are of no use to the install page — it renders the "already
    // set up" state instead — so stop handing the credential to anyone who
    // replays the link out of a mailbox or browser history.
    const alreadyInstalled = row.enrollmentUsedAt !== null;
    // Invitation lifecycle (DZ-AUDIT-013 follow-up): a revoked or expired
    // link stops new installs; a started one keeps its progress view.
    const gate = installLinkGate(row);
    if (gate) {
      throw new ApiError(410, gate.code, gate.message);
    }
    // Structured analytics: the invitation was opened. Ids only — no secrets,
    // no AWS data (mirrors the deploy_link.opened precedent).
    // The page reads this route on load and again on every refresh, so one
    // visit is one event: a repeat within INSTALL_LINK_OPENED_DEDUPE_MS is
    // not recorded.
    const recentOpen = await db
      .select({ id: schema.eventLogs.id })
      .from(schema.eventLogs)
      .where(
        and(
          eq(schema.eventLogs.deploymentId, row.deploymentId),
          eq(schema.eventLogs.eventType, 'install_link.opened'),
          gte(schema.eventLogs.occurredAt, new Date(Date.now() - INSTALL_LINK_OPENED_DEDUPE_MS)),
        ),
      )
      .limit(1);
    if (recentOpen.length === 0) {
      await recordEvent(db, {
        organizationId: row.organizationId,
        eventType: 'install_link.opened',
        actorType: 'system',
        actorId: `install-link:${installLinkId}`,
        deploymentId: row.deploymentId,
        customerId: row.customerId,
        payload: { schemaVersion: 1, alreadyInstalled },
      });
    }
    // §16.1: the customer-visible "Deployz will create" table — same shape
    // `GET /api/deployments/:id/plan?action=install` serves once the
    // deployment exists. Null only when the stored manifest is missing or
    // invalid; the page never guesses one. Shared with the public
    // deploy-link resolve page, so the two can never disagree.
    const manifest = readStoredManifest(row.desiredState);
    const plan = manifest ? buildInstallPlan({ manifest, region: row.region }) : null;
    // The expected bootstrap stack name: the persisted one once an attempt
    // has launched (a record of what the customer was told), otherwise the
    // name the link below will prefill. Derived from deployment identity so
    // two deployments into the same AWS account/region never collide.
    const stackName =
      row.bootstrapStackName ??
      bootstrapStackName({
        appName: row.applicationName,
        deploymentId: row.deploymentId,
        attempt: row.attemptNumber,
      });
    const waitingForRelay = row.deploymentState === 'WAITING_FOR_RELAY';
    // The relay enrolling is the only way out of WAITING_FOR_RELAY. Past one
    // relay-staleness window with no enrollment the page shows guidance
    // instead of a failure — the bootstrap stack may still be creating, or
    // may have failed before the connector ever started.
    const relayStuck =
      waitingForRelay &&
      row.installStartedAt !== null &&
      Date.now() - row.installStartedAt.getTime() > RELAY_STALE_AFTER_MS;
    // The install link already identifies exactly this deployment, so its
    // own id/state/domain are within the scope the link already grants —
    // this is not a tenant-boundary crossing, just more detail about the
    // one deployment the link names.
    const domain = await findActiveDomain(db, row.deploymentId);
    return {
      applicationName: row.applicationName,
      publisherName: row.publisherName,
      customerName: row.customerName,
      region: row.region,
      plan,
      deploymentId: row.deploymentId,
      deploymentState: row.deploymentState,
      // The serving release's version — the pointer (current_release_id)
      // advances only via heartbeat reconciliation, so this is null until a
      // release is actually live. Version string only: never the image
      // digest or git SHA on this public surface.
      releaseVersion: row.releaseVersion,
      domain: domain ? toDomainView(domain) : null,
      routingTarget: domain?.routingTarget ?? null,
      // Same §24 derivation the fleet row uses — one progress model for the
      // install page and the dashboard, so the two cannot disagree. Only
      // offered once a relay enrolled; before that there is nothing to
      // observe.
      components: alreadyInstalled
        ? mergeComponentState(row.observedState, derivationApplicationFor(row, null))
        : null,
      bootstrapStackName: stackName,
      waitingForRelay,
      relayStuck,
      // The invitation's own expiry, so the page can state it above the fold.
      installLinkExpiresAt: row.installLinkExpiresAt,
      // The Quick Create link is built HERE, not in the web app: only the
      // control plane knows which template is currently published, which
      // region this customer's deployment targets, and this deployment's
      // single-use enrollment code. The link carries no credential — the
      // relay's is minted by CloudFormation inside the customer's account.
      //
      // DZ-AUDIT-013: the relayCredential is carried alongside the enrollment
      // code whenever one has been established. Spent codes get no link.
      quickCreateUrl:
        !alreadyInstalled && existingStackUpdateFor(row) === null
          ? (() => {
              const templateUrl = resolveBootstrapTemplate(row.region, {
                ...(env.bootstrapTemplateUrl
                  ? { legacyUrl: env.bootstrapTemplateUrl }
                  : {}),
                deployableRegions: env.deployableAwsRegions,
              });
              return templateUrl
                ? buildBootstrapQuickCreateUrl({
                    region: row.region,
                    templateUrl,
                    controlPlaneUrl: env.apiUrl,
                    enrollmentCode: row.enrollmentCode,
                    relayCredential: row.relayCredential ?? undefined,
                    stackName,
                  })
                : null;
            })()
          : null,
      existingStackUpdate: existingStackUpdateFor(row),
      alreadyInstalled,
    };
    },
  );

  // §12/§44 the unified deployment-status derivation (apps/api/src/
  // deployment-status.ts), scoped exactly like the route above: the
  // install-link id, not the relay's own installation id. UNAUTHENTICATED by
  // design, so this returns ONLY the customer projection — never relay
  // identity, job payloads, or raw AWS/stack detail (see
  // customerDeploymentStatusSchema in @deployz/contracts).
  app.get(
    '/api/install/:installLinkId/status',
    { config: { rateLimit: PUBLIC_INSTALL_RATE_LIMIT } },
    async (request) => {
      const { installLinkId } = request.params as { installLinkId: string };
      requireUuidId(installLinkId);
      const rows = await db
        .select({
          deployment: schema.deployments,
          migrationCommand: schema.applications.migrationCommand,
        })
        .from(schema.deployments)
        .innerJoin(schema.applications, eq(schema.deployments.applicationId, schema.applications.id))
        .where(eq(schema.deployments.installLinkId, installLinkId))
        .limit(1);
      if (rows.length === 0) {
        throw new NotFoundError('Installation not found');
      }
      const row = rows[0]!;
      const jobs = await db
        .select()
        .from(schema.deploymentJobs)
        .where(eq(schema.deploymentJobs.deploymentId, row.deployment.id))
        .orderBy(schema.deploymentJobs.createdAt);
      const domain = await findActiveDomain(db, row.deployment.id);
      const defaultHttps = parseDefaultHttps(row.deployment.defaultHttps);
      const appUrl = resolveAppUrl(jobs, domain, defaultHttps);
      const derived = deriveDeploymentStatus({
        deployment: row.deployment,
        application: derivationApplicationFor(row.deployment, row),
        jobs,
        domain,
        defaultHttps,
        appUrl,
      });
      const { progress, stackEvents } = await loadCustomerLiveProgress(db, derived, {
        deploymentId: row.deployment.id,
        jobs,
        domain,
        defaultHttps,
        stepTimings: row.deployment.stepTimings,
        cleanupState: row.deployment.cleanupState,
        launched: row.deployment.installStartedAt !== null,
        specV2: row.deployment.specV2,
      });
      const status = toCustomerDeploymentStatus(derived, progress);
      // Additive spec-derived components — omitted entirely without a
      // compiled spec, so legacy deployments' responses are byte-identical.
      const specComponents = specComponentsForStatus(row.deployment.specV2, status.components, stackEvents);
      const awsSummary = await loadCustomerAwsSummary(db, derived, row.deployment);
      return {
        ...status,
        ...(awsSummary ? { awsSummary } : {}),
        ...(specComponents ? { specComponents } : {}),
      };
    },
  );

  // Pre-relay launch signal: the install page reports the customer pressing
  // "Deploy to AWS" so the deployment can show an explicit waiting state
  // (and, if no relay ever enrolls, guidance instead of a false failure).
  // Public for the same reason GET above is: keyed on the install link,
  // which is the only credential the customer holds. Idempotent — reopening
  // the CloudFormation console page is not a new attempt.
  app.post(
    '/api/install/:installLinkId/launched',
    { config: { rateLimit: PUBLIC_INSTALL_RATE_LIMIT } },
    async (request, reply) => {
    const { installLinkId } = request.params as { installLinkId: string };
    requireUuidId(installLinkId);
    const rows = await db
      .select({ deployment: schema.deployments, applicationName: schema.applications.name })
      .from(schema.deployments)
      .innerJoin(schema.applications, eq(schema.deployments.applicationId, schema.applications.id))
      .where(eq(schema.deployments.installLinkId, installLinkId))
      .limit(1);
    if (rows.length === 0) {
      throw new NotFoundError('Installation not found');
    }
    const { deployment, applicationName } = rows[0]!;
    // Invitation lifecycle: a revoked or expired link cannot start an install.
    const launchGate = installLinkGate(deployment);
    if (launchGate) {
      throw new ApiError(410, launchGate.code, launchGate.message);
    }
    // Phase 3/5 gate: the install link is a second boundary where a
    // non-READY manifest — or a required value removed since creation — must
    // be stopped before any AWS provisioning.
    const preflight = await runDeploymentPreflight(db, deployment, null);
    if (!preflight.ready) {
      await recordEvent(db, {
        organizationId: deployment.organizationId,
        eventType: 'application.preflight_evaluated',
        actorType: 'system',
        actorId: `install-link:${deployment.installLinkId}`,
        deploymentId: deployment.id,
        customerId: deployment.customerId,
        payload: {
          schemaVersion: 1,
          applicationId: deployment.applicationId,
          result: 'blocked',
          blockingCount: preflight.blockers.length,
          warningCount: preflight.warnings.length,
        },
      });
    }
    requirePreflightReady(preflight);
    if (deployment.state !== 'NOT_INSTALLED') {
      return reply.code(200).send({ state: deployment.state });
    }
    const launched = await db.transaction(async (tx) => {
      // The state guard closes the double-submit window (same as the
      // deploy-link launch route): two tabs can both pass the NOT_INSTALLED
      // check above, but only the first UPDATE matches — the waiting state
      // and the launch event are recorded exactly once.
      const updated = await tx
        .update(schema.deployments)
        .set({
          state: 'WAITING_FOR_RELAY',
          installStartedAt: new Date(),
          bootstrapStackName: bootstrapStackName({
            appName: applicationName,
            deploymentId: deployment.id,
            attempt: deployment.attemptNumber,
          }),
        })
        .where(
          and(
            eq(schema.deployments.id, deployment.id),
            eq(schema.deployments.state, 'NOT_INSTALLED'),
          ),
        )
        .returning();
      if (updated.length === 0) {
        const [current] = await tx
          .select({ state: schema.deployments.state })
          .from(schema.deployments)
          .where(eq(schema.deployments.id, deployment.id));
        return current?.state ?? deployment.state;
      }
      await recordEvent(tx, {
        organizationId: deployment.organizationId,
        eventType: 'install.launched',
        actorType: 'system',
        actorId: `install-link:${deployment.installLinkId}`,
        deploymentId: deployment.id,
        customerId: deployment.customerId,
        previousState: deployment.state,
        requestedState: 'WAITING_FOR_RELAY',
      });
      // Inside the guarded tx, so the pass is recorded exactly once per
      // deployment launch no matter how often the page is reopened.
      await recordEvent(tx, {
        organizationId: deployment.organizationId,
        eventType: 'application.preflight_evaluated',
        actorType: 'system',
        actorId: `install-link:${deployment.installLinkId}`,
        deploymentId: deployment.id,
        customerId: deployment.customerId,
        payload: {
          schemaVersion: 1,
          applicationId: deployment.applicationId,
          result: 'pass',
          blockingCount: preflight.blockers.length,
          warningCount: preflight.warnings.length,
        },
      });
      return 'WAITING_FOR_RELAY';
    });
    return { state: launched };
    },
  );

  // Customer-facing retry for an install that never connected. Fresh
  // attempt: new enrollment code, bumped attempt number (so the Quick
  // Create link prefill moves to a stack name no ROLLBACK_COMPLETE
  // remnant of the failed attempt can block), spent in-flight INSTALL
  // jobs cancelled. The failed attempt's stack is NOT deleted here —
  // cleanup stays on the separate purge path. Guarded like retry-install:
  // a deployment that was ever healthy must not be reset from the public
  // page.
  app.post(
    '/api/install/:installLinkId/retry',
    { config: { rateLimit: PUBLIC_INSTALL_RATE_LIMIT } },
    async (request, reply) => {
    const { installLinkId } = request.params as { installLinkId: string };
    requireUuidId(installLinkId);
    const rows = await db
      .select({ deployment: schema.deployments, applicationName: schema.applications.name })
      .from(schema.deployments)
      .innerJoin(schema.applications, eq(schema.deployments.applicationId, schema.applications.id))
      .where(eq(schema.deployments.installLinkId, installLinkId))
      .limit(1);
    if (rows.length === 0) {
      throw new NotFoundError('Installation not found');
    }
    const { deployment, applicationName } = rows[0]!;
    // Invitation lifecycle: a revoked or expired link cannot re-arm an install.
    const retryGate = installLinkGate(deployment);
    if (retryGate) {
      throw new ApiError(410, retryGate.code, retryGate.message);
    }
    if (await hasSucceededInstall(db, deployment.id)) {
      throw new ApiError(
        409,
        'INSTALL_ALREADY_SUCCEEDED',
        'This deployment installed successfully before; contact the vendor to make changes.',
      );
    }
    assertPublicRetryAllowed(deployment);
    const nextAttempt = deployment.attemptNumber + 1;
    const keepsConnector = retryKeepsConnector(deployment);
    const stackName = keepsConnector
      ? deployment.bootstrapStackName!
      : bootstrapStackName({
          appName: applicationName,
          deploymentId: deployment.id,
          attempt: nextAttempt,
        });
    const enrollmentCode = mintEnrollmentCode();
    const relayCredential = mintRelayCredential();
    await db.transaction(async (tx) => {
      await tx
        .update(schema.deploymentJobs)
        .set({ state: 'CANCELLED', finishedAt: new Date() })
        .where(
          and(
            eq(schema.deploymentJobs.deploymentId, deployment.id),
            eq(schema.deploymentJobs.type, 'INSTALL'),
            inArray(schema.deploymentJobs.state, ['REQUESTED', 'QUEUED', 'RUNNING', 'WAITING']),
          ),
        );
      await tx
        .update(schema.deployments)
        .set({
          state: 'NOT_INSTALLED',
          enrollmentCode,
          enrollmentUsedAt: null,
          installationId: null,
          // Phase 5 §9.6: the identifiers this retry replaces stay recorded so
          // a later purge can still find the PREVIOUS stack's retained
          // resources — a public retry must not silently orphan them.
          ...(deployment.installationId
            ? { previousInstallationId: deployment.installationId }
            : {}),
          ...(deployment.bootstrapStackName
            ? { previousBootstrapStackName: deployment.bootstrapStackName }
            : {}),
          // DZ-AUDIT-013: fresh credential on every retry.
          relayCredential,
          relayTokenHash: hashRelayToken(relayCredential),
          relayBoundAt: null,
          relayStatus: 'UNKNOWN',
          attemptNumber: nextAttempt,
          bootstrapStackName: stackName,
          installStartedAt: null,
        })
        .where(eq(schema.deployments.id, deployment.id));
      await recordEvent(tx, {
        organizationId: deployment.organizationId,
        eventType: 'install.retry.requested',
        actorType: 'system',
        actorId: `install-link:${deployment.installLinkId}`,
        deploymentId: deployment.id,
        customerId: deployment.customerId,
        previousState: deployment.state,
        requestedState: 'NOT_INSTALLED',
        payload: {
          attempt: nextAttempt,
          bootstrapStackName: stackName,
          ...(deployment.installationId
            ? { previousInstallationId: deployment.installationId }
            : {}),
          ...(deployment.bootstrapStackName
            ? { previousBootstrapStackName: deployment.bootstrapStackName }
            : {}),
        },
      });
    });
    await dropDefaultHttpsForFreshAttempt(deployment);
    return reply.code(200).send({
      state: 'NOT_INSTALLED',
      attemptNumber: nextAttempt,
      bootstrapStackName: stackName,
      quickCreateUrl:
        env.bootstrapTemplateUrl && !keepsConnector
          ? buildBootstrapQuickCreateUrl({
              region: deployment.region,
              templateUrl: env.bootstrapTemplateUrl,
              controlPlaneUrl: env.apiUrl,
              enrollmentCode,
              relayCredential,
              stackName,
            })
          : null,
      existingStackUpdate: keepsConnector
        ? existingStackUpdateFor({
            region: deployment.region,
            bootstrapStackName: stackName,
            previousBootstrapStackName: stackName,
            enrollmentCode,
            enrollmentUsedAt: null,
            relayCredential,
          })
        : null,
    });
    },
  );

  // §31 application configuration surface (auth-gated). Vendor defaults are
  // customer_id NULL rows; customer overrides are scoped by ?customerId.
  // Secrets are write-only: GET masks them (value: null, never plaintext) and
  // PUT writes them through the relay to the customer's Secrets Manager
  // before persisting the masked placeholder in the control plane.
  const configStore = createConfigStore(db);
  const configSecretWriter = createRelaySecretWriter(db);
  // DEPLOY-027 (Phase 4): the cipher + the at-rest pending_secrets store +
  // the scope-deployments query, wired from env so production uses KMS and
  // local/test environments degrade to the cipher stub. In Lambda a missing
  // or invalid key throws here, so the function fails INIT (and the deploy's
  // readiness check) instead of storing secrets with the stub. buildServer
  // owns the construction so every route below shares one instance.
  const cipher = createSecretCipherFromEnv({
    kmsKeyArn: env.kmsKeyArn,
    isLambda: Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME),
  });
  const pendingSecrets = createDrizzlePendingSecretStore(db, cipher);
  const compilerDeps = { templatePublisher };
  const configDeps: ConfigDeps = {
    store: configStore,
    secretWriter: configSecretWriter,
    pendingSecrets,
    cipher,
    findScopeDeployments: createScopeDeploymentsFinder(db),
    findApplicationOrganizationId: async (applicationId) => {
      const rows = await db
        .select({ organizationId: schema.applications.organizationId })
        .from(schema.applications)
        .where(eq(schema.applications.id, applicationId))
        .limit(1);
      return rows[0]?.organizationId;
    },
    findConfigurableCustomers: createConfigurableCustomersFinder(db),
  };

  app.get('/api/applications/:id/config', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const organizationId = requireSessionOrganizationId(request);
    await loadOwnedApplication(db, id, organizationId); // 404s on cross-org access
    const { customerId } = request.query as { customerId?: string | undefined };
    const scope = await resolveConfigScope(db, customerId, organizationId);
    return { ...(await getConfig(id, scope.customerId, configStore)), customerName: scope.customerName };
  });

  app.put('/api/applications/:id/config', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const organizationId = requireSessionOrganizationId(request);
    await loadOwnedApplication(db, id, organizationId); // 404s on cross-org access
    const body = setConfigBodySchema.parse(request.body);
    const scope = await resolveConfigScope(db, body.customerId, organizationId);
    // §9.5 relay-liveness gate for config-update, mirroring the deploy gate:
    // the worker fans CONFIG_UPDATE jobs out to this app's deployments, and a
    // disconnected relay never claims its share. Refuse the whole write so the
    // vendor reconnects first instead of watching doomed jobs accumulate.
    // Scope matches the worker's fan-out exactly (customer-scoped; a null
    // customer fan-out is empty and needs no gate).
    if (scope.customerId !== null) {
      const deadRelay = await db
        .select({ id: schema.deployments.id })
        .from(schema.deployments)
        .where(
          and(
            eq(schema.deployments.applicationId, id),
            eq(schema.deployments.customerId, scope.customerId),
            notInArray(schema.deployments.state, [
              'NOT_INSTALLED',
              'WAITING_FOR_RELAY',
              'DELETING',
              'DELETED',
            ]),
            eq(schema.deployments.relayStatus, 'DISCONNECTED'),
          ),
        )
        .limit(1);
      if (deadRelay.length > 0) {
        throw new ApiError(
          409,
          'RELAY_DISCONNECTED',
          'A deployment relay for this configuration is disconnected. Reconnect it before changing configuration.',
        );
      }
    }
    const view = await setConfig(
      id,
      scope.customerId,
      body.entries,
      configDeps,
      body.deletes ?? [],
    );
    // Keys actually written by this save: entries minus untouched secrets
    // (empty value = "leave unchanged" — setConfig skips them) plus removals.
    // Counts only — never key names or values (privacy).
    const changedKeyCount =
      body.entries.filter((entry) => !(entry.isSecret && entry.value.length === 0)).length +
      (body.deletes?.length ?? 0);
    await recordEvent(db, {
      organizationId,
      eventType: 'application.configuration_saved',
      actorType: 'user',
      actorId: request.user!.id,
      // Vendor-default scope (customerId null) keeps the column null.
      ...(scope.customerId !== null ? { customerId: scope.customerId } : {}),
      payload: { schemaVersion: 1, applicationId: id, changedKeyCount },
    });
    return { ...view, customerName: scope.customerName };
  });

  // Vendor decisions for how each detected env var gets its value
  // (docs/environment-variables.md). Does NOT rerun analysis —
  // it reads the manifest analysis already produced. Vendor VALUES are still
  // saved with the existing PUT /api/applications/:id/config (vendor scope).
  async function environmentSettingsView(app: typeof schema.applications.$inferSelect) {
    const manifest = effectiveApplicationManifest(app);
    const vendorValueKeys = await listProvidedConfigKeys(db, app.id, null);
    return {
      settings: readEnvironmentSettings(app),
      variables: manifest.environment.variables,
      deployzKeys: [...deployzProvidableKeys(manifest.environment.variables)],
      provisioned: provisionedResources(manifest),
      vendorValueKeys,
    };
  }

  app.get('/api/applications/:id/environment-settings', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const organizationId = requireSessionOrganizationId(request);
    const app = await loadOwnedApplication(db, id, organizationId);
    return environmentSettingsView(app);
  });

  app.put('/api/applications/:id/environment-settings', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const organizationId = requireSessionOrganizationId(request);
    const app = await loadOwnedApplication(db, id, organizationId);
    const parsedBody = z.object({ settings: environmentSettingsSchema }).strict().safeParse(request.body);
    if (!parsedBody.success) {
      throw new ApiError(400, 'INVALID_ENVIRONMENT_SETTINGS', 'The submitted settings are invalid.', {
        issues: parsedBody.error.issues,
      });
    }
    const manifest = effectiveApplicationManifest(app);
    const problems = validateEnvironmentSettings(
      parsedBody.data.settings,
      deployzProvidableKeys(manifest.environment.variables),
      provisionedResources(manifest),
    );
    if (problems.length > 0) {
      throw new ApiError(422, 'ENVIRONMENT_SETTINGS_INVALID', problems.join(' '), { problems });
    }
    const [updated] = await db
      .update(schema.applications)
      .set({ environmentSettings: parsedBody.data.settings })
      .where(and(eq(schema.applications.id, id), eq(schema.applications.organizationId, organizationId)))
      .returning();
    await recordEvent(db, {
      organizationId,
      eventType: 'application.environment_settings_saved',
      actorType: 'user',
      actorId: request.user!.id,
      payload: { schemaVersion: 1, applicationId: id, settingCount: parsedBody.data.settings.length },
    });
    return environmentSettingsView(updated!);
  });

  // The GitHub App's Setup URL. GitHub sends the vendor here right after they
  // install (or reconfigure) the App, with `installation_id` in the query —
  // this is the one moment where the GitHub installation and the vendor's
  // Deployz session are both present, so it is where the two get bound.
  //
  // The redirect is a top-level GET navigation, so the Lax session cookie is
  // sent. A vendor who installed the App while signed out has no cookie to
  // send, though, and a JSON 401 would strand them on an error page with the
  // installation unbound — so that case goes to sign-in instead, carrying the
  // installation id back to the web setup page. The callback is RELATIVE
  // because the sign-in page rejects absolute URLs as open redirects.
  const redirectSignedOutToSignIn = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    try {
      await requireAuth(request);
    } catch (error) {
      // Only a missing session redirects. Anything else (a database failure
      // resolving the tenant, say) must surface as itself rather than be
      // disguised as "please sign in".
      if (!(error instanceof UnauthorizedError)) throw error;
      const { installation_id: installationId } = request.query as {
        installation_id?: string | undefined;
      };
      const target = installationId
        ? `/github/setup?installation_id=${encodeURIComponent(installationId)}`
        : '/github/setup';
      return reply.redirect(`${env.webUrl}/sign-in?callbackUrl=${encodeURIComponent(target)}`);
    }
  };
  app.get('/api/github/setup', { preHandler: redirectSignedOutToSignIn }, async (request, reply) => {
    const { installation_id: installationId } = request.query as {
      installation_id?: string | undefined;
    };
    // This GET writes a binding, which the support-mode guard (non-GET only)
    // cannot see.
    if (request.supportMode) {
      throw new ApiError(403, 'SUPPORT_MODE_READ_ONLY', 'Support mode is read-only. Exit support mode to make changes.');
    }
    const organizationId = requireSessionOrganizationId(request);
    const dashboardUrl = `${env.webUrl}/dashboard/applications`;
    if (!installationId) {
      return reply.redirect(`${dashboardUrl}?github=missing_installation`);
    }

    if (!githubAppId || !githubAppPrivateKey) {
      throw new ApiError(503, 'GITHUB_DISABLED', 'GitHub App is not configured');
    }
    // GitHub sends a *browser* to this URL, so a thrown error would render the
    // JSON envelope at the vendor and strand them there — the same dead end
    // the signed-out redirect above exists to avoid. Whatever goes wrong
    // (GitHub unreachable, an installation this App does not own, a private
    // key it cannot sign with), put them back on the dashboard, which reports
    // the state it can actually see.
    try {
      const jwt = createAppJwt(githubAppId, githubAppPrivateKey, Date.now());
      const account = await fetchInstallationAccount(installationId, jwt, githubFetch);

      // An installation id is a small public integer: a binding another
      // organization already holds must never be taken over by whoever
      // knows the id.
      const existing = await githubStore.get(installationId);
      if (existing !== null && existing.organizationId !== organizationId) {
        request.log.warn({ installationId }, 'github setup refused: installation bound to another organization');
        return reply.redirect(`${dashboardUrl}?github=failed`);
      }

      await githubStore.set({
        id: installationId,
        organizationId,
        accountLogin: account.accountLogin,
        accountType: account.accountType,
      });
    } catch (error) {
      request.log.error({ err: error, installationId }, 'github setup binding failed');
      return reply.redirect(`${dashboardUrl}?github=failed`);
    }

    return reply.redirect(`${dashboardUrl}?github=connected`);
  });

  // GitHub repo-selection surface (auth-gated). Fixture mode serves the
  // fixture org/repos so the dashboard renders test data without a real App;
  // otherwise the installation store (written by /api/github/setup) is the
  // source of truth, and repo listing needs a minted installation token.
  app.get('/api/github/installations', { preHandler: requireAuth }, async (request) => {
    const organizationId = request.organization?.id;
    if (!organizationId) {
      throw new ApiError(401, 'UNAUTHORIZED', 'An organization is required');
    }
    const fixtureMode = githubFixtureMode ?? env.githubFixtureMode;
    const installations = await listInstallations(githubStore, organizationId, { fixtureMode });
    return {
      installations,
      connectUrl: (githubAppInstallUrl ?? env.githubAppInstallUrl) || null,
    };
  });

  app.get('/api/github/repos', { preHandler: requireAuth }, async (request) => {
    const { installationId } = request.query as { installationId?: string | undefined };
    if (!installationId) {
      throw new ApiError(400, 'INSTALLATION_ID_REQUIRED', 'installationId query parameter is required');
    }
    const organizationId = requireSessionOrganizationId(request);
    const fixtureMode = githubFixtureMode ?? env.githubFixtureMode;
    if (fixtureMode) {
      const repositories = await listRepositories(installationId, { fixtureMode: true });
      return { repositories };
    }
    // An installation id is a guessable integer, and the token minted below
    // can read every repository in it — so the caller must own it.
    const record = await githubStore.get(installationId);
    if (!record || record.organizationId !== organizationId) {
      throw new NotFoundError('GitHub installation not found');
    }
    if (!githubAppId || !githubAppPrivateKey) {
      throw new ApiError(503, 'GITHUB_DISABLED', 'GitHub App is not configured');
    }
    const { token } = await mintInstallationToken(
      installationId,
      githubAppId,
      githubAppPrivateKey,
      Date.now(),
      githubFetch,
    );
    const repositories = await listRepositories(installationId, {
      fixtureMode: false,
      installationToken: token,
      fetchFn: githubFetch,
    });
    return { repositories };
  });

  // ── Request schemas (route boundary validation) ─────────────────────────

  // organizationId is optional and, when present, is validated (not
  // trusted) against the session — see resolveWriteOrganizationId. It is
  // NEVER the source of truth for which org a row is written into.
  const createApplicationBodySchema = z.object({
    organizationId: z.string().min(1).optional(),
    name: z.string().min(1),
    githubInstallationId: z.string().min(1),
    repoFullName: z.string().min(1),
    repoUrl: z.string().min(1),
    defaultBranch: z.string().min(1),
    containerPort: z.number().int().nullish(),
    healthPath: z.string().nullish(),
    databaseRequired: z.boolean().nullish(),
    storageRequired: z.boolean().nullish(),
    redisRequired: z.boolean().nullish(),
  });

  // §36 PATCH-only — mirrors POST but all-optional. `nullish` fields let the
  // client clear a currently-set value by sending `null`. For the boolean
  // requirement fields `null` means "reset to the detected value" (the columns
  // are NOT NULL, so the handler writes the detected value, never null).
  const patchApplicationBodySchema = z.object({
    name: z.string().min(1).optional(),
    containerPort: z.number().int().nullish(),
    healthPath: z.string().nullish(),
    migrationCommand: z.string().nullish(),
    databaseRequired: z.boolean().nullish(),
    storageRequired: z.boolean().nullish(),
    redisRequired: z.boolean().nullish(),
    // Vendor sizing settings — apply to links and deployments created later.
    defaultSizeProfile: infrastructureSizeTierSchema.optional(),
    minimumSizeProfile: infrastructureSizeTierSchema.optional(),
    // Phase 2 manifest overrides — stored on detected_metadata.manifestOverrides.
    appRoot: z.string().nullish(),
    dockerfilePath: z.string().nullish(),
    buildContext: z.string().nullish(),
    buildCommand: z.string().nullish(),
    startCommand: z.string().nullish(),
  });

  const createCustomerBodySchema = z.object({
    organizationId: z.string().min(1).optional(),
    name: z.string().trim().min(1),
    email: z.string().trim().email(),
    company: z.string().trim().nullish(),
    externalReference: z.string().nullish(),
  });

  // Contact metadata only. externalReference and the customer id itself are
  // deliberately absent: an edit here never changes what a deployment or an
  // install link is anchored to.
  const updateCustomerBodySchema = z.object({
    name: z.string().trim().min(1),
    email: z.string().trim().email(),
    company: z.string().trim().nullish(),
  });

  const createDeploymentBodySchema = z.object({
    applicationId: z.string().uuid(),
    customerId: z.string().uuid(),
    organizationId: z.string().min(1).optional(),
    // The canonical supported set from @deployz/contracts — never a
    // hand-maintained duplicate.
    region: regionSchema,
    deploymentType: deploymentTypeSchema.default('PRODUCTION'),
    sizeProfile: infrastructureSizeTierSchema.optional(),
  });

  // Paddle migration Phase 8 — the three parameters a production deployment
  // needs, parked as a checkout intent instead of a deployment. All three are
  // optional TOGETHER: an empty body parks a subscribe-only intent (the
  // invitation-first flow's self-serve subscription start), which activates
  // the subscription without creating anything. deploymentType is absent on
  // purpose: a checkout is only ever for a PRODUCTION deployment (a TEST one
  // is free and needs no subscription).
  const createCheckoutBodySchema = z.object({
    applicationId: z.string().uuid().optional(),
    customerId: z.string().uuid().optional(),
    region: regionSchema.optional(),
    sizeProfile: infrastructureSizeTierSchema.optional(),
  });

  // Deploy Link generation targets the SESSION org's customer (path) and
  // application (body); the region is vendor-chosen exactly as manual
  // deployment creation chooses it. The customer is not in the body because
  // the path already names it.
  const createDeployLinkBodySchema = z.object({
    applicationId: z.string().uuid(),
    region: regionSchema,
    sizeProfile: infrastructureSizeTierSchema.optional(),
  });

  // Installation invitation targets the SESSION org's customer (path) and
  // application (body). `recommendedRegion` is optional — the customer makes
  // the final Region choice at confirmation.
  const createInvitationBodySchema = z
    .object({
      applicationId: z.string().uuid(),
      recommendedRegion: regionSchema.optional(),
      recommendedSizeProfile: infrastructureSizeTierSchema.optional(),
    })
    .strict();

  // A reusable link may carry its own size recommendation; absent = the
  // application default. The body itself is optional.
  const createPublicInstallLinkBodySchema = z
    .object({ recommendedSizeProfile: infrastructureSizeTierSchema.optional() })
    .strict();

  const createReleaseBodySchema = z.object({
    version: z.string().min(1),
    gitSha: z.string().min(1),
    migrationCommand: z.string().nullish(),
  });

  const deployBodySchema = z.object({
    releaseId: z.string().uuid(),
  });

  const deployBulkBodySchema = z.object({
    releaseId: z.string().uuid(),
    deploymentIds: z.array(z.string().uuid()).nullish(),
  });

  const rollbackBodySchema = z.object({
    releaseId: z.string().uuid(),
  });

  const destroyBodySchema = z.object({
    finalSnapshot: z.boolean().nullish(),
  });

  const addDomainBodySchema = z.object({ hostname: z.string() });

  // ── Applications (§17–§19) ──────────────────────────────────────────────

  // POST /api/applications — Create application from GitHub repo selection
  app.post('/api/applications', { preHandler: requireAuth }, async (request, reply) => {
    const body = createApplicationBodySchema.parse(request.body);
    const organizationId = resolveWriteOrganizationId(request, body.organizationId);
    // The installation id is what analysis later mints a repo-read token
    // from, so an application may only point at an installation this
    // organization connected.
    if (!(githubFixtureMode ?? env.githubFixtureMode)) {
      const record = await githubStore.get(body.githubInstallationId);
      if (!record || record.organizationId !== organizationId) {
        throw new NotFoundError('GitHub installation not found');
      }
    }

    // One application per repository per organization. Choosing the same repo
    // twice used to create a second application with its own releases and
    // deployments, and the repo list went on offering "Choose" as though it
    // were not already connected. The id comes back so the client can send
    // the vendor to the application they already have.
    const existing = await db
      .select({ id: schema.applications.id })
      .from(schema.applications)
      .where(
        and(
          eq(schema.applications.organizationId, organizationId),
          eq(schema.applications.repoFullName, body.repoFullName),
        ),
      )
      .limit(1);
    if (existing.length > 0) {
      throw new ApiError(
        409,
        'APPLICATION_ALREADY_CONNECTED',
        'This repository is already connected. Open it from your applications list.',
        { applicationId: existing[0]!.id },
      );
    }

    const row = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(schema.applications)
        .values({
          organizationId,
          name: body.name,
          githubInstallationId: body.githubInstallationId,
          repoFullName: body.repoFullName,
          repoUrl: body.repoUrl,
          defaultBranch: body.defaultBranch,
          containerPort: body.containerPort ?? null,
          healthPath: body.healthPath ?? null,
          databaseRequired: body.databaseRequired ?? false,
          storageRequired: body.storageRequired ?? false,
          redisRequired: body.redisRequired ?? false,
          analysisStatus: 'PENDING',
          createdBy: request.user?.id ?? null,
          updatedBy: request.user?.id ?? null,
        })
        .returning();
      if (created) {
        await recordEvent(tx, {
          organizationId,
          eventType: 'application.created',
          actorType: 'user',
          actorId: request.user!.id,
          payload: { schemaVersion: 1, applicationId: created.id },
        });
      }
      return created;
    });
    return reply.code(201).send(row);
  });

  // GET /api/applications — List applications for current org
  app.get('/api/applications', { preHandler: requireAuth }, async (request) => {
    const organizationId = requireSessionOrganizationId(request);
    // The list pages read three detected facts (Docker, database engine,
    // analysed commit). The full detected_metadata is hundreds of KB for a
    // dozen apps, so only those keys leave the database; the detail route
    // still returns the whole row.
    const metadata = schema.applications.detectedMetadata;
    const rows = await db
      .select({
        ...APPLICATION_LIST_COLUMNS,
        detectedMetadata: sql<Record<string, unknown> | null>`CASE WHEN ${metadata} IS NULL THEN NULL ELSE jsonb_strip_nulls(jsonb_build_object('hasDockerfile', ${metadata}->'hasDockerfile', 'databaseState', ${metadata}->'databaseState', 'analysisCommitSha', ${metadata}->'analysisCommitSha')) END`,
      })
      .from(schema.applications)
      .where(eq(schema.applications.organizationId, organizationId));
    return { applications: rows };
  });

  // GET /api/applications/:id — Get single application
  app.get('/api/applications/:id', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const organizationId = requireSessionOrganizationId(request);
    return loadOwnedApplication(db, id, organizationId);
  });

  // PATCH /api/applications/:id — Update deployability fields
  // A field the vendor actually CHANGES here becomes vendor-owned: it is
  // recorded on detected_metadata.vendorOverrides and analysis.ts never
  // auto-detects it again (§35 provenance). Everything else stays
  // auto-detected, so a re-analysis keeps tracking the repository.
  // ⚠️ Race with the fire-and-forget analysis run: a PATCH that lands while
  // an analysis is in flight can still be overwritten by that run's write —
  // the override is recorded, but the analysis loaded the row before it. The
  // UI warns against editing mid-analysis; re-saving after it settles wins.
  app.patch('/api/applications/:id', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const organizationId = requireSessionOrganizationId(request);
    await loadOwnedApplication(db, id, organizationId);
    const body = patchApplicationBodySchema.parse(request.body);
    // The read-modify-write of detected_metadata holds the row lock, so a
    // concurrent PATCH or analysis write cannot drop this request's override.
    return db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(schema.applications)
        .where(eq(schema.applications.id, id))
        .limit(1)
        .for('update');
      if (!existing) throw new NotFoundError('Application not found');
      const set: Record<string, unknown> = {};
      if (body.name !== undefined) set.name = body.name;
      if (body.containerPort !== undefined) set.containerPort = body.containerPort ?? null;
      if (body.healthPath !== undefined) set.healthPath = body.healthPath ?? null;
      if (body.migrationCommand !== undefined) set.migrationCommand = body.migrationCommand ?? null;
      if (body.defaultSizeProfile !== undefined || body.minimumSizeProfile !== undefined) {
        const defaultSizeProfile = body.defaultSizeProfile ?? existing.defaultSizeProfile;
        const minimumSizeProfile = body.minimumSizeProfile ?? existing.minimumSizeProfile;
        assertSizeSettingsValid(defaultSizeProfile, minimumSizeProfile);
        if (defaultSizeProfile !== existing.defaultSizeProfile) set.defaultSizeProfile = defaultSizeProfile;
        if (minimumSizeProfile !== existing.minimumSizeProfile) set.minimumSizeProfile = minimumSizeProfile;
      }
      const detectedRequirements = readApplicationAnalysis(existing.detectedMetadata);
      if (body.databaseRequired !== undefined) {
        set.databaseRequired = body.databaseRequired ?? detectedRequirements?.database.required ?? false;
      }
      if (body.storageRequired !== undefined) {
        set.storageRequired = body.storageRequired ?? detectedRequirements?.storage.objectStorageDetected ?? false;
      }
      if (body.redisRequired !== undefined) {
        set.redisRequired = body.redisRequired ?? detectedRequirements?.redis.required ?? false;
      }

      // Phase 2 manifest-only overrides (app root, Dockerfile, build
      // context/command, start command) have no applications column; they live
      // on detected_metadata.manifestOverrides. A null clears that key.
      let nextMetadata = existing.detectedMetadata ?? {};
      const storedManifestOverrides = (nextMetadata['manifestOverrides'] ?? {}) as Record<string, unknown>;
      const nextManifestOverrides = { ...storedManifestOverrides };
      let manifestOnlyChanged = false;
      for (const field of MANIFEST_OVERRIDE_FIELDS) {
        const value = body[field];
        if (value === undefined) continue;
        manifestOnlyChanged = true;
        if (value === null) {
          delete nextManifestOverrides[field];
        } else {
          nextManifestOverrides[field] = value;
        }
      }
      if (manifestOnlyChanged) {
        nextMetadata = { ...nextMetadata, manifestOverrides: nextManifestOverrides };
      }

      if (Object.keys(set).length === 0 && !manifestOnlyChanged) return existing;
      // The details form re-submits every field on every save, so only a value
      // that actually differs counts as the vendor claiming that field. An
      // explicit null migration command is the vendor's "No separate
      // migration" decision, so it always claims the field.
      const claimed = CONTRACT_FIELDS.filter(
        (field) =>
          set[field] !== undefined &&
          (set[field] !== existing[field] || (field === 'migrationCommand' && body.migrationCommand === null)),
      );
      // Any other field explicitly set to null relinquishes vendor ownership so
      // the next analysis re-detects it (see analysis.ts deriveContractFieldUpdates).
      const released = CONTRACT_FIELDS.filter(
        (field) => field !== 'migrationCommand' && body[field] === null,
      );
      if (claimed.length > 0 || released.length > 0 || manifestOnlyChanged) {
        if (claimed.length > 0 || released.length > 0) {
          // A row analysed before the list existed treats its non-null saved
          // columns as the vendor's (analysis.ts); recording one claim must not
          // make the others look auto-detected.
          const overrides = new Set([
            ...(Array.isArray(existing.detectedMetadata?.['vendorOverrides'])
              ? readVendorOverrides(existing.detectedMetadata)
              : legacySavedFields(existing)),
            ...claimed,
          ]);
          for (const field of released) {
            overrides.delete(field);
          }
          nextMetadata = { ...nextMetadata, vendorOverrides: [...overrides] };
        }
        set.detectedMetadata = nextMetadata;
      }
      // A port, health path or start command the vendor sets (or clears)
      // resolves (or restores) a readiness finding — keep the persisted verdict
      // in step with the readiness page, which applies the same reconciliation
      // on read.
      if (
        existing.analysisStatus === 'COMPLETE' &&
        (claimed.includes('containerPort') ||
          claimed.includes('migrationCommand') ||
          claimed.includes('healthPath') ||
          released.includes('healthPath') ||
          manifestOnlyChanged)
      ) {
        const effective = effectiveReadinessReport({
          containerPort: 'containerPort' in set ? (set.containerPort as number | null) : existing.containerPort,
          detectedMetadata: nextMetadata,
        });
        if (effective) {
          set.compatibilityStatus = verdictFromReadiness(effective.state);
          set.compatibilityReason = effective.summary;
        }
      }
      set.updatedBy = request.user?.id ?? null;
      const [row] = await tx
        .update(schema.applications)
        .set(set)
        .where(eq(schema.applications.id, id))
        .returning();
      if (!row) {
        throw new NotFoundError('Application not found');
      }
      return row;
    });
  });

  // DELETE /api/applications/:id — Remove an application (only if it has zero deployments)
  app.delete('/api/applications/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const organizationId = requireSessionOrganizationId(request);
    const app = await loadOwnedApplication(db, id, organizationId);
    const deployments = await db
      .select({ id: schema.deployments.id })
      .from(schema.deployments)
      .where(eq(schema.deployments.applicationId, id))
      .limit(1);
    if (deployments.length > 0) {
      throw new ApiError(
        409,
        'APPLICATION_HAS_DEPLOYMENTS',
        'This application has deployment history and cannot be removed. Applications can only be removed before their first deployment.',
      );
    }
    await db.transaction(async (tx) => {
      await tx.insert(schema.eventLogs).values({
        actorType: 'user',
        actorId: request.user!.id,
        organizationId,
        eventType: 'APPLICATION_DELETED',
        payload: { applicationId: id, applicationName: app.name, repoFullName: app.repoFullName },
      });
      await tx.delete(schema.applicationConfigs).where(eq(schema.applicationConfigs.applicationId, id));
      await tx.delete(schema.releases).where(eq(schema.releases.applicationId, id));
      await tx.delete(schema.applications).where(eq(schema.applications.id, id));
    });
    return reply.code(204).send();
  });

  // POST /api/applications/:id/analyse — Trigger analysis
  app.post('/api/applications/:id/analyse', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const organizationId = requireSessionOrganizationId(request);
    await loadOwnedApplication(db, id, organizationId);
    // Task 6 commit-SHA analysis cache: `force` bypasses it (the vendor's
    // explicit "Re-analyse" action) — an auto-trigger sends no body and
    // lets the cache decide.
    const body = request.body as { force?: boolean } | undefined;
    const force = body?.force === true;
    await db.transaction(async (tx) => {
      await tx
        .update(schema.applications)
        .set({ analysisStatus: 'ANALYZING', updatedBy: request.user?.id ?? null })
        .where(eq(schema.applications.id, id));
      await recordEvent(tx, {
        organizationId,
        eventType: 'application.analysis_started',
        actorType: 'user',
        actorId: request.user!.id,
        payload: { schemaVersion: 1, applicationId: id },
      });
    });
    // The §18/§19 pipeline runs on the worker, not after this response.
    // Detaching it here with `void runAnalysis(id)` works on a long-lived
    // server and silently does nothing on Lambda, which freezes the
    // execution environment as soon as the reply is sent — the application
    // would sit at ANALYZING for ever. Without a queue (local dev) the
    // long-lived server can and does run it inline.
    const queued = await enqueue({ type: 'ANALYSE_APPLICATION', applicationId: id, force });
    if (!queued) {
      // runAnalysis catches every internal failure and persists FAILED
      // rather than throwing; the `.catch` is a second net so a rejected
      // promise can never surface as an unhandled rejection.
      await runAnalysis(id, { force }).catch(() => {});
    }
    return reply.code(202).send({ status: 'ANALYZING' });
  });

  // GET /api/applications/:id/readiness — Get compatibility result (§19)
  app.get('/api/applications/:id/readiness', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const organizationId = requireSessionOrganizationId(request);
    const app = await loadOwnedApplication(db, id, organizationId);
    const deployments = await db
      .select({
        id: schema.deployments.id,
        customerName: schema.customers.name,
        state: schema.deployments.state,
        desiredState: schema.deployments.desiredState,
        specV2: schema.deployments.specV2,
      })
      .from(schema.deployments)
      .innerJoin(schema.customers, eq(schema.deployments.customerId, schema.customers.id))
      .where(eq(schema.deployments.applicationId, id));
    return computeReadiness(db, app, deployments);
  });

  // GET /api/applications/:id/preflight — the pre-deployment gate for this
  // application, against the vendor defaults or one customer's configuration
  // (Phase 5). Read-only; the same evaluation deployment creation enforces.
  app.get('/api/applications/:id/preflight', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const organizationId = requireSessionOrganizationId(request);
    const application = await loadOwnedApplication(db, id, organizationId);
    const { customerId } = request.query as { customerId?: string };
    if (customerId) await loadOwnedCustomer(db, customerId, organizationId);
    return (await runApplicationPreflight(db, application, customerId ?? null)).result;
  });

  // GET /api/applications/:id/plan — the INSTALL plan for this application's
  // current effective manifest (Phase 4). No deployment exists yet, so no
  // AWS region has been chosen.
  app.get('/api/applications/:id/plan', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const organizationId = requireSessionOrganizationId(request);
    const application = await loadOwnedApplication(db, id, organizationId);
    if (application.analysisStatus !== 'COMPLETE') {
      throw new ApiError(409, 'ANALYSIS_NOT_COMPLETE', 'Run the analysis before requesting a deployment plan.');
    }
    const { profile, region } = request.query as { profile?: string; region?: string };
    const requested = profile === undefined ? undefined : infrastructureSizeTierSchema.safeParse(profile);
    if (requested !== undefined && !requested.success) {
      throw new ApiError(422, 'UNKNOWN_PROFILE', `Unknown infrastructure profile "${profile}".`);
    }
    // The vendor previews any size, also one below the minimum it is choosing.
    const tier = requested?.data ?? application.defaultSizeProfile;
    const plannedRegion = region !== undefined && isSupportedRegion(region) ? region : null;
    const { manifest } = await runApplicationPreflight(db, application, null);
    return buildInstallPlan({ manifest, region: plannedRegion, profile: currentInfrastructureSizeProfile(tier) });
  });

  // POST /api/applications/:id/fix-instructions — Generate the consolidated
  // coding-agent prompt for the unresolved readiness findings. Read-only with
  // respect to the analysis: generation never changes findings, readiness
  // state, or the repository. Any AI failure maps to a retryable 503 — the
  // analysis stays fully usable without it.
  app.post(
    '/api/applications/:id/fix-instructions',
    { preHandler: requireAuth },
    async (request) => {
      const { id } = request.params as { id: string };
      const organizationId = requireSessionOrganizationId(request);
      const application = await loadOwnedApplication(db, id, organizationId);

      if (application.analysisStatus !== 'COMPLETE') {
        throw new ApiError(
          409,
          'ANALYSIS_NOT_COMPLETE',
          'Run the analysis before generating fix instructions.',
        );
      }
      const context = buildFixInstructionsContext(application);
      if (!context) {
        throw new ApiError(
          409,
          'NO_UNRESOLVED_FINDINGS',
          'There are no unresolved findings to generate instructions for.',
        );
      }

      // A missing provider setting never recovers on retry. Say so, and name
      // the setting only on a local API: production customers never see
      // variable names.
      if (injectedFixInstructionsAiGateway === undefined && !env.aiFixtureMode && env.fixInstructionsAiProblem) {
        const problem = FIX_INSTRUCTIONS_AI_PROBLEMS[env.fixInstructionsAiProblem];
        request.log.warn({ problem }, 'fix-instructions provider not configured');
        const localApi = ['localhost', '127.0.0.1'].includes(new URL(env.webUrl).hostname);
        throw new ApiError(
          503,
          'FIX_INSTRUCTIONS_UNAVAILABLE',
          localApi
            ? `Fix instructions are not configured: ${problem}. Set it in .env and restart the API.`
            : "We couldn't generate the instructions right now. Try again in a moment.",
          { reason: 'not_configured' },
        );
      }

      // Same commit, same analysis version, same findings → the same
      // document. Reuse it instead of paying for another generation; the
      // vendor can still ask for a fresh one. A re-analysis replaces
      // detected_metadata wholesale, which drops the cache on its own.
      const key = fixInstructionsCacheKey(
        context,
        application.detectedMetadata?.['analysisVersion'],
        env.aiFixtureMode ? 'fixture' : (env.fixInstructionsAi?.model ?? 'unconfigured'),
      );
      const { regenerate } = fixInstructionsBodySchema.parse(request.body ?? {});
      const cached = regenerate ? null : readCachedFixInstructions(application.detectedMetadata, key);
      if (cached) {
        return { instructions: cached.instructions, generatedAt: cached.generatedAt, cached: true };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FIX_INSTRUCTIONS_TIMEOUT_MS);
      try {
        const instructions = await generateFixInstructions(context, fixInstructionsAiGateway, {
          abortSignal: controller.signal,
          onDropped: (dropped) =>
            request.log.warn(
              { applicationId: id, itemId: dropped.itemId, reason: dropped.reason, rule: dropped.rule, length: dropped.length },
              'fix-instructions guidance dropped',
            ),
        });
        const generatedAt = new Date().toISOString();
        const fresh = await loadOwnedApplication(db, id, organizationId);
        await db
          .update(schema.applications)
          .set({
            detectedMetadata: { ...fresh.detectedMetadata, fixInstructions: { key, instructions, generatedAt } },
          })
          .where(eq(schema.applications.id, id));
        return { instructions, generatedAt, cached: false };
      } catch (error) {
        // Every AI failure (unconfigured gateway, timeout, malformed output,
        // spend limit) is the same retryable condition to the vendor.
        request.log.warn({ err: error }, 'fix-instructions generation failed');
        throw new ApiError(
          503,
          'FIX_INSTRUCTIONS_UNAVAILABLE',
          "We couldn't generate the instructions right now. Try again in a moment.",
        );
      } finally {
        clearTimeout(timer);
      }
    },
  );

  // ── Customers (§37) ─────────────────────────────────────────────────────

  // POST /api/customers — Create customer
  app.post('/api/customers', { preHandler: requireAuth }, async (request, reply) => {
    const body = createCustomerBodySchema.parse(request.body);
    const organizationId = resolveWriteOrganizationId(request, body.organizationId);
    const row = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(schema.customers)
        .values({
          organizationId,
          name: body.name,
          email: body.email,
          company: body.company || null,
          externalReference: body.externalReference ?? null,
        })
        .returning();
      if (created) {
        await recordEvent(tx, {
          organizationId,
          eventType: 'customer.created',
          actorType: 'user',
          actorId: request.user!.id,
          customerId: created.id,
          payload: { schemaVersion: 1, customerId: created.id },
        });
      }
      return created;
    });
    return reply.code(201).send(row);
  });

  // GET /api/customers — List customers for org
  app.get('/api/customers', { preHandler: requireAuth }, async (request) => {
    const organizationId = requireSessionOrganizationId(request);
    const rows = await db
      .select()
      .from(schema.customers)
      .where(eq(schema.customers.organizationId, organizationId));
    return { customers: rows };
  });

  // GET /api/customers/:id — One customer
  app.get('/api/customers/:id', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const organizationId = requireSessionOrganizationId(request);
    return await loadOwnedCustomer(db, id, organizationId);
  });

  // PATCH /api/customers/:id — Edit contact metadata.
  //
  // Name, email and company are display metadata, nothing more. The customer
  // id is the only thing deployments, install links and configs are anchored
  // to (deployments.customer_id, application_configs.customer_id — both uuid
  // foreign keys), so this route updates three text columns and touches
  // nothing else: no install link is reissued, no deployment is re-owned, and
  // nothing in the customer's AWS account is contacted. The id itself is not
  // in the body schema, so it cannot be rewritten.
  app.patch('/api/customers/:id', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const body = updateCustomerBodySchema.parse(request.body);
    const organizationId = requireSessionOrganizationId(request);
    await loadOwnedCustomer(db, id, organizationId);
    const [row] = await db
      .update(schema.customers)
      .set({ name: body.name, email: body.email, company: body.company || null })
      .where(and(eq(schema.customers.id, id), eq(schema.customers.organizationId, organizationId)))
      .returning();
    return row!;
  });

  // DELETE /api/customers/:id — Remove a customer record (only if it has zero
  // deployments), mirroring DELETE /api/applications/:id.
  //
  // Deleting a customer record must never be a back door into deleting
  // infrastructure. A customer with any deployment row — including a removed
  // one, which may still hold retained AWS resources — is refused: Disconnect
  // and Purge on the deployment are the only paths that touch the customer's
  // AWS account, and they stay the vendor's explicit choice.
  app.delete('/api/customers/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const organizationId = requireSessionOrganizationId(request);
    const customer = await loadOwnedCustomer(db, id, organizationId);
    const deployments = await db
      .select({ id: schema.deployments.id })
      .from(schema.deployments)
      .where(eq(schema.deployments.customerId, id))
      .limit(1);
    if (deployments.length > 0) {
      throw new ApiError(
        409,
        'CUSTOMER_HAS_DEPLOYMENTS',
        'This customer has a deployment and cannot be removed. Removing a customer never removes anything from their AWS account — remove the deployment first.',
      );
    }
    await db.transaction(async (tx) => {
      await tx.insert(schema.eventLogs).values({
        actorType: 'user',
        actorId: request.user!.id,
        organizationId,
        customerId: id,
        eventType: 'CUSTOMER_DELETED',
        payload: { customerId: id, customerName: customer.name },
      });
      // A customer with no deployments can still hold customer-scoped config
      // overrides; they are unreachable without a deployment, and the foreign
      // key would otherwise reject the delete.
      await tx
        .delete(schema.applicationConfigs)
        .where(eq(schema.applicationConfigs.customerId, id));
      await tx
        .delete(schema.customers)
        .where(and(eq(schema.customers.id, id), eq(schema.customers.organizationId, organizationId)));
    });
    return reply.code(204).send();
  });

  // ── Deploy Links (docs/deploy-links.md) ────────────────────────────────

  // POST /api/customers/:customerId/deploy-links — Generate a deploy link for
  // an existing customer + application. Runs the SAME deployment-creation
  // gates as POST /api/deployments (source 'deploy_link') inside one
  // transaction with the deploy_links row and the audit event, then returns
  // the raw secret token exactly once — it is never retrievable again.
  app.post(
    '/api/customers/:customerId/deploy-links',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { customerId } = request.params as { customerId: string };
      const body = createDeployLinkBodySchema.parse(request.body);
      const organizationId = requireSessionOrganizationId(request);
      const { link, deployment, application, token } = await createDeployLink(db, {
        organizationId,
        userId: requireActor(request).id,
        customerId,
        applicationId: body.applicationId,
        region: body.region,
        ...(body.sizeProfile !== undefined ? { sizeProfile: body.sizeProfile } : {}),
      }, {
        pendingSecrets,
        cipher,
      }, compilerDeps);
      return reply.code(201).send({
        link: toDeployLinkView({ link, application, deployment }),
        deployment,
        token,
      });
    },
  );

  // POST /api/customers/:customerId/invitations — create a TARGETED
  // installation invitation WITHOUT creating a deployment. The vendor may
  // recommend a Region; the customer makes the final choice at confirmation.
  // Returns the one-time token exactly once — it is never retrievable again.
  app.post(
    '/api/customers/:customerId/invitations',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { customerId } = request.params as { customerId: string };
      const body = createInvitationBodySchema.parse(request.body);
      const organizationId = requireSessionOrganizationId(request);
      const { link, token } = await createInstallationInvitation(db, {
        organizationId,
        userId: requireActor(request).id,
        customerId,
        applicationId: body.applicationId,
        ...(body.recommendedRegion !== undefined ? { recommendedRegion: body.recommendedRegion } : {}),
        ...(body.recommendedSizeProfile !== undefined ? { recommendedSizeProfile: body.recommendedSizeProfile } : {}),
      });
      return reply.code(201).send({
        id: link.id,
        token,
        expiresAt: link.expiresAt,
        recommendedRegion: link.recommendedRegion,
        recommendedSizeProfile: link.recommendedSizeProfile,
      });
    },
  );

  // GET /api/customers/:customerId/invitations — the customer's targeted
  // installation invitations, newest first, with the derived status
  // ('active' | 'expired' | 'revoked' | 'used'). Never carries the token.
  app.get(
    '/api/customers/:customerId/invitations',
    { preHandler: requireAuth },
    async (request) => {
      const { customerId } = request.params as { customerId: string };
      const organizationId = requireSessionOrganizationId(request);
      await loadOwnedCustomer(db, customerId, organizationId); // 404s on cross-org
      return { invitations: await listCustomerInvitations(db, organizationId, customerId) };
    },
  );

  // GET /api/customers/:customerId/deploy-links — Link state for the vendor
  // panel: newest first, with the derived status ('active' | 'revoked' |
  // 'expired') and the linked deployment's state/region.
  app.get(
    '/api/customers/:customerId/deploy-links',
    { preHandler: requireAuth },
    async (request) => {
      const { customerId } = request.params as { customerId: string };
      const organizationId = requireSessionOrganizationId(request);
      await loadOwnedCustomer(db, customerId, organizationId); // 404s on cross-org
      const rows = await listDeployLinks(db, organizationId, customerId);
      return {
        links: rows.map(({ link, deployment, application }) =>
          toDeployLinkView({ link, application, deployment }),
        ),
      };
    },
  );

  // POST /api/deploy-links/:id/revoke — Stop the link accepting its token.
  // Idempotent: revoking an already-revoked link returns its current state.
  app.post('/api/deploy-links/:id/revoke', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const organizationId = requireSessionOrganizationId(request);
    const link = await revokeDeployLink(db, {
      organizationId,
      userId: requireActor(request).id,
      linkId: id,
    });
    return { link: toDeployLinkView({ link, application: null, deployment: null }) };
  });

  // POST /api/deploy-links/:id/regenerate — Rotate the secret to a fresh one
  // (reviving a revoked link) while the deployment is still NOT_INSTALLED.
  // Returns the new raw token exactly once.
  app.post('/api/deploy-links/:id/regenerate', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const organizationId = requireSessionOrganizationId(request);
    const { link, token } = await regenerateDeployLink(db, {
      organizationId,
      userId: requireActor(request).id,
      linkId: id,
    });
    return {
      link: toDeployLinkView({ link, application: null, deployment: null }),
      token,
    };
  });

  // GET /api/deploy-links/:publicId — PUBLIC resolve for the customer page.
  // The secret token travels in the x-deployz-token header, never the URL,
  // so it does not leak into browser history or access logs. Rate-limited
  // like the install routes. The response is a crafted customer projection:
  // no installLinkId, no enrollmentCode, no organization id, no internal ids.
  app.get(
    '/api/deploy-links/:publicId',
    { config: { rateLimit: PUBLIC_INSTALL_RATE_LIMIT } },
    async (request) => {
      const { publicId } = request.params as { publicId: string };
      const token = firstHeaderValue(request.headers['x-deployz-token']);
      const { deployment, application, customer } = await resolveDeployLink(db, publicId, token);
      const waitingForRelay = deployment.state === 'WAITING_FOR_RELAY';
      // Same guidance-instead-of-failure rule as the install page: past one
      // relay-staleness window with no enrollment the page shows help, not an
      // error — the bootstrap stack may still be creating.
      const relayStuck =
        waitingForRelay &&
        deployment.installStartedAt !== null &&
        Date.now() - deployment.installStartedAt.getTime() > RELAY_STALE_AFTER_MS;
      const domain = await findActiveDomain(db, deployment.id);
      const stackName =
        deployment.bootstrapStackName ??
        bootstrapStackName({
          appName: application.name,
          deploymentId: deployment.id,
          attempt: deployment.attemptNumber,
        });
      // Same unified status derivation the install page uses — one progress
      // model for every customer surface.
      const derived = deriveDeploymentStatus({
        deployment,
        application: derivationApplicationFor(deployment, application),
        jobs: [],
        domain,
        appUrl: null,
      });
      const resolveManifest = readStoredManifest(deployment.desiredState);
      const deploymentProfile = resolveStoredInfrastructureSizeProfile(deployment.desiredState);
      return {
        link: { status: 'active' },
        application: { name: application.name },
        customer: { name: customer.name },
        region: deployment.region,
        // The same install plan the install page serves, so the two customer
        // surfaces never disagree about what a deployment creates.
        plan: resolveManifest ? buildInstallPlan({ manifest: resolveManifest, region: deployment.region, ...(deploymentProfile ? { profile: deploymentProfile } : {}) }) : null,
        deploymentState: deployment.state,
        bootstrapStackName: stackName,
        waitingForRelay,
        relayStuck,
        quickCreateUrl: deployLinkQuickCreateUrl({
          region: deployment.region,
          deploymentId: deployment.id,
          appName: application.name,
          attemptNumber: deployment.attemptNumber,
          bootstrapStackName: deployment.bootstrapStackName,
          previousBootstrapStackName: deployment.previousBootstrapStackName,
          enrollmentCode: deployment.enrollmentCode,
          enrollmentUsedAt: deployment.enrollmentUsedAt,
          relayCredential: deployment.relayCredential,
        }),
        existingStackUpdate: existingStackUpdateFor(deployment),
        domain: domain ? toDomainView(domain) : null,
        routingTarget: domain?.routingTarget ?? null,
        status: toCustomerDeploymentStatus(derived),
      };
    },
  );

  // POST /api/deploy-links/:publicId/launched — the customer pressed
  // "Deploy to AWS" on the hosted page. Mirrors the install route exactly
  // (readiness gate, idempotent, NOT_INSTALLED → WAITING_FOR_RELAY) but
  // resolves through the deploy link first, so a revoked or expired link can
  // never start a deployment. Event actor follows the deploy-link convention.
  app.post(
    '/api/deploy-links/:publicId/launched',
    { config: { rateLimit: PUBLIC_INSTALL_RATE_LIMIT } },
    async (request) => {
      const { publicId } = request.params as { publicId: string };
      const token = firstHeaderValue(request.headers['x-deployz-token']);
      const { deployment, application } = await resolveDeployLink(db, publicId, token);
      // The same Phase 3/5 gate the install page enforces: a non-READY
      // manifest must be stopped before any AWS provisioning.
      const preflight = await runDeploymentPreflight(db, deployment, application);
      if (!preflight.ready) {
        await recordEvent(db, {
          organizationId: deployment.organizationId,
          eventType: 'application.preflight_evaluated',
          actorType: 'system',
          actorId: `deploy-link:${publicId}`,
          deploymentId: deployment.id,
          customerId: deployment.customerId,
          payload: {
            schemaVersion: 1,
            applicationId: deployment.applicationId,
            result: 'blocked',
            blockingCount: preflight.blockers.length,
            warningCount: preflight.warnings.length,
          },
        });
      }
      requirePreflightReady(preflight);
      if (deployment.state !== 'NOT_INSTALLED') {
        // Idempotent: reopening the CloudFormation console is not a new attempt.
        return { state: deployment.state };
      }
      const launched = await db.transaction(async (tx) => {
        // The state guard closes the double-submit window: two tabs (or a
        // refresh racing a retry) can both pass the NOT_INSTALLED check
        // above, but only the first UPDATE matches — the waiting state and
        // the launch event are recorded exactly once.
        const updated = await tx
          .update(schema.deployments)
          .set({
            state: 'WAITING_FOR_RELAY',
            installStartedAt: new Date(),
            bootstrapStackName: bootstrapStackName({
              appName: application.name,
              deploymentId: deployment.id,
              attempt: deployment.attemptNumber,
            }),
          })
          .where(
            and(
              eq(schema.deployments.id, deployment.id),
              eq(schema.deployments.state, 'NOT_INSTALLED'),
            ),
          )
          .returning();
        if (updated.length === 0) {
          const [current] = await tx
            .select({ state: schema.deployments.state })
            .from(schema.deployments)
            .where(eq(schema.deployments.id, deployment.id));
          return current?.state ?? deployment.state;
        }
        await recordEvent(tx, {
          organizationId: deployment.organizationId,
          eventType: 'deploy_link.launched',
          actorType: 'system',
          actorId: `deploy-link:${publicId}`,
          deploymentId: deployment.id,
          customerId: deployment.customerId,
          previousState: deployment.state,
          requestedState: 'WAITING_FOR_RELAY',
        });
        // Inside the guarded tx, so the pass is recorded exactly once per
        // deployment launch no matter how often the page is reopened.
        await recordEvent(tx, {
          organizationId: deployment.organizationId,
          eventType: 'application.preflight_evaluated',
          actorType: 'system',
          actorId: `deploy-link:${publicId}`,
          deploymentId: deployment.id,
          customerId: deployment.customerId,
          payload: {
            schemaVersion: 1,
            applicationId: deployment.applicationId,
            result: 'pass',
            blockingCount: preflight.blockers.length,
            warningCount: preflight.warnings.length,
          },
        });
        return 'WAITING_FOR_RELAY';
      });
      return { state: launched };
    },
  );

  // GET /api/deploy-links/:publicId/status — live customer projection for the
  // hosted page, identical in shape and hygiene to the install status route.
  app.get(
    '/api/deploy-links/:publicId/status',
    { config: { rateLimit: PUBLIC_INSTALL_RATE_LIMIT } },
    async (request) => {
      const { publicId } = request.params as { publicId: string };
      const token = firstHeaderValue(request.headers['x-deployz-token']);
      const { deployment, application } = await resolveDeployLink(db, publicId, token);
      const jobs = await db
        .select()
        .from(schema.deploymentJobs)
        .where(eq(schema.deploymentJobs.deploymentId, deployment.id))
        .orderBy(schema.deploymentJobs.createdAt);
      const domain = await findActiveDomain(db, deployment.id);
      const defaultHttps = parseDefaultHttps(deployment.defaultHttps);
      const appUrl = resolveAppUrl(jobs, domain, defaultHttps);
      const derived = deriveDeploymentStatus({
        deployment,
        application: derivationApplicationFor(deployment, application),
        jobs,
        domain,
        defaultHttps,
        appUrl,
      });
      const { progress, stackEvents } = await loadCustomerLiveProgress(db, derived, {
        deploymentId: deployment.id,
        jobs,
        domain,
        defaultHttps,
        stepTimings: deployment.stepTimings,
        cleanupState: deployment.cleanupState,
        launched: deployment.installStartedAt !== null,
        specV2: deployment.specV2,
      });
      const status = toCustomerDeploymentStatus(derived, progress);
      const specComponents = specComponentsForStatus(deployment.specV2, status.components, stackEvents);
      const awsSummary = await loadCustomerAwsSummary(db, derived, deployment);
      return {
        ...status,
        ...(awsSummary ? { awsSummary } : {}),
        ...(specComponents ? { specComponents } : {}),
      };
    },
  );

  // POST /api/deploy-links/:publicId/retry — customer-facing retry for an
  // install that never connected, mirroring the install retry: fresh
  // enrollment code, bumped attempt number, spent in-flight INSTALL jobs
  // cancelled, and a deployment that was ever healthy is never reset from a
  // public page.
  app.post(
    '/api/deploy-links/:publicId/retry',
    { config: { rateLimit: PUBLIC_INSTALL_RATE_LIMIT } },
    async (request) => {
      const { publicId } = request.params as { publicId: string };
      const token = firstHeaderValue(request.headers['x-deployz-token']);
      const { deployment, application } = await resolveDeployLink(db, publicId, token);
      if (await hasSucceededInstall(db, deployment.id)) {
        throw new ApiError(
          409,
          'INSTALL_ALREADY_SUCCEEDED',
          'This deployment installed successfully before; contact the vendor to make changes.',
        );
      }
      assertPublicRetryAllowed(deployment);
      const nextAttempt = deployment.attemptNumber + 1;
      const keepsConnector = retryKeepsConnector(deployment);
      const stackName = keepsConnector
        ? deployment.bootstrapStackName!
        : bootstrapStackName({
            appName: application.name,
            deploymentId: deployment.id,
            attempt: nextAttempt,
          });
      const enrollmentCode = mintEnrollmentCode();
      const relayCredential = mintRelayCredential();
      await db.transaction(async (tx) => {
        await tx
          .update(schema.deploymentJobs)
          .set({ state: 'CANCELLED', finishedAt: new Date() })
          .where(
            and(
              eq(schema.deploymentJobs.deploymentId, deployment.id),
              eq(schema.deploymentJobs.type, 'INSTALL'),
              inArray(schema.deploymentJobs.state, ['REQUESTED', 'QUEUED', 'RUNNING', 'WAITING']),
            ),
          );
        await tx
          .update(schema.deployments)
          .set({
            state: 'NOT_INSTALLED',
            enrollmentCode,
            enrollmentUsedAt: null,
            installationId: null,
            // Phase 5 §9.6: the identifiers this retry replaces stay recorded so
            // a later purge can still find the PREVIOUS stack's retained
            // resources — a public retry must not silently orphan them.
            ...(deployment.installationId
              ? { previousInstallationId: deployment.installationId }
              : {}),
            ...(deployment.bootstrapStackName
              ? { previousBootstrapStackName: deployment.bootstrapStackName }
              : {}),
            // DZ-AUDIT-013: fresh credential on retry.
            relayCredential,
            relayTokenHash: hashRelayToken(relayCredential),
            relayBoundAt: null,
            relayStatus: 'UNKNOWN',
            attemptNumber: nextAttempt,
            bootstrapStackName: stackName,
            installStartedAt: null,
          })
          .where(eq(schema.deployments.id, deployment.id));
        await recordEvent(tx, {
          organizationId: deployment.organizationId,
          eventType: 'deploy_link.retry.requested',
          actorType: 'system',
          actorId: `deploy-link:${publicId}`,
          deploymentId: deployment.id,
          customerId: deployment.customerId,
          previousState: deployment.state,
          requestedState: 'NOT_INSTALLED',
          payload: {
            attempt: nextAttempt,
            bootstrapStackName: stackName,
            ...(deployment.installationId
              ? { previousInstallationId: deployment.installationId }
              : {}),
            ...(deployment.bootstrapStackName
              ? { previousBootstrapStackName: deployment.bootstrapStackName }
              : {}),
          },
        });
      });
      await dropDefaultHttpsForFreshAttempt(deployment);
      return {
        state: 'NOT_INSTALLED',
        attemptNumber: nextAttempt,
        bootstrapStackName: stackName,
        quickCreateUrl: deployLinkQuickCreateUrl({
          region: deployment.region,
          deploymentId: deployment.id,
          appName: application.name,
          attemptNumber: nextAttempt,
          bootstrapStackName: stackName,
          previousBootstrapStackName: keepsConnector ? stackName : null,
          enrollmentCode,
          enrollmentUsedAt: null,
          relayCredential,
        }),
        existingStackUpdate: keepsConnector
          ? existingStackUpdateFor({
              region: deployment.region,
              bootstrapStackName: stackName,
              previousBootstrapStackName: stackName,
              enrollmentCode,
              enrollmentUsedAt: null,
              relayCredential,
            })
          : null,
      };
    },
  );

  // POST /api/deploy-links/:publicId/domain/check — customer-facing "Check
  // now" for a custom domain, link-scoped like every route above. Read-only
  // trigger; runDomainCheck's own interval floor plus the IP-keyed rate limit
  // guard against hammering it.
  app.post(
    '/api/deploy-links/:publicId/domain/check',
    { config: { rateLimit: PUBLIC_INSTALL_RATE_LIMIT } },
    async (request) => {
      const { publicId } = request.params as { publicId: string };
      const token = firstHeaderValue(request.headers['x-deployz-token']);
      const { deployment } = await resolveDeployLink(db, publicId, token);
      const domain = await findActiveDomain(db, deployment.id);
      if (!domain) throw new NotFoundError('Custom domain not found');
      const fresh = await runDomainCheck(db, deployment, domain, domainCheckDeps);
      return { domain: toDomainView(fresh) };
    },
  );

  // ── Public install links (customer installation review) ────────────────

  // GET /api/public-install/:linkId — PUBLIC, credential-free review page
  // for the vendor-published link. UNAUTHENTICATED by design and rate-limited
  // like the install routes; the opaque link id is the only identifier in or
  // out. The projection carries no secrets, no manifest JSON, no template
  // URLs and no internal ids — see apps/api/src/public-install.ts.
  app.get(
    '/api/public-install/:linkId',
    { config: { rateLimit: PUBLIC_INSTALL_RATE_LIMIT } },
    async (request) => {
      const { linkId } = request.params as { linkId: string };
      const token = firstHeaderValue(request.headers['x-deployz-token']);
      return resolvePublicInstall(db, linkId, token);
    },
  );

  // GET /api/public-install/:linkId/plan?region=…&profile=… — the canonical
  // INSTALL plan for a customer-selected Region + size profile. Pricing stays
  // on the server; an undeployable/unsupported Region returns an "estimate
  // unavailable" plan (region/cost null), never a guessed cost.
  app.get(
    '/api/public-install/:linkId/plan',
    { config: { rateLimit: PUBLIC_INSTALL_RATE_LIMIT } },
    async (request) => {
      const { linkId } = request.params as { linkId: string };
      const { region, profile } = request.query as { region?: string; profile?: string };
      const token = firstHeaderValue(request.headers['x-deployz-token']);
      if (region === undefined) {
        throw new ApiError(422, 'REGION_REQUIRED', 'A region is required.');
      }
      return resolvePublicInstallPlan(db, linkId, region, profile, token);
    },
  );

  // POST /api/public-install/:linkId/confirm — the customer accepted the
  // review. Body only (query parameters are never read); idempotent per
  // (link, idempotencyKey). Creates exactly one deployment (source
  // 'public_link') and one customer row, then hands the customer off to the
  // existing /install/:installLinkId flow, which owns everything after this
  // point — no job, no relay state, no secrets in the response.
  app.post(
    '/api/public-install/:linkId/confirm',
    { config: { rateLimit: PUBLIC_INSTALL_RATE_LIMIT } },
    async (request, reply) => {
      const { linkId } = request.params as { linkId: string };
      const body = publicInstallConfirmBodySchema.parse(request.body);
      const token = firstHeaderValue(request.headers['x-deployz-token']);
      const result = await confirmPublicInstall(db, linkId, body, configDeps, token, templatePublisher);
      return reply.code(result.created ? 201 : 200).send({ installLinkId: result.installLinkId });
    },
  );

  // ── Public install links — vendor management (org-scoped) ──────────────

  // POST /api/applications/:id/public-install-links — create + enable the
  // application's live public install link. If no published release exists the
  // API auto-creates one from the analyzed snapshot, so the vendor never needs
  // to publish manually. Only one live link per application exists
  // (409 PUBLIC_INSTALL_LINK_EXISTS, the existing id in details). The snippet
  // is server-built with a FIXED anchor text — only the opaque URL is
  // interpolated, never the application name.
  app.post(
    '/api/applications/:id/public-install-links',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const organizationId = requireSessionOrganizationId(request);
      const body = createPublicInstallLinkBodySchema.parse(request.body ?? {});
      const link = await createPublicInstallLink(db, {
        organizationId,
        userId: requireActor(request).id,
        applicationId: id,
        ...(body.recommendedSizeProfile !== undefined ? { recommendedSizeProfile: body.recommendedSizeProfile } : {}),
      });
      return reply.code(201).send(link);
    },
  );

  // GET /api/applications/:id/public-install-links — every link for the
  // application, newest first, with the derived status ('active' |
  // 'disabled' | 'revoked').
  app.get('/api/applications/:id/public-install-links', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const organizationId = requireSessionOrganizationId(request);
    await loadOwnedApplication(db, id, organizationId); // 404s on cross-org
    return { links: await listPublicInstallLinks(db, organizationId, id) };
  });

  // POST /api/public-install-links/:id/enable — idempotent flip. Enabling a
  // revoked link is refused (409 PUBLIC_INSTALL_LINK_REVOKED).
  app.post('/api/public-install-links/:id/enable', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const organizationId = requireSessionOrganizationId(request);
    const link = await setPublicInstallLinkEnabled(db, {
      organizationId,
      userId: requireActor(request).id,
      linkId: id,
      enabled: true,
    });
    return { link };
  });

  // POST /api/public-install-links/:id/disable — idempotent flip; the public
  // surface then answers 410 PUBLIC_INSTALL_LINK_DISABLED until re-enabled.
  app.post('/api/public-install-links/:id/disable', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const organizationId = requireSessionOrganizationId(request);
    const link = await setPublicInstallLinkEnabled(db, {
      organizationId,
      userId: requireActor(request).id,
      linkId: id,
      enabled: false,
    });
    return { link };
  });

  // POST /api/public-install-links/:id/revoke — stop the link resolving.
  // Idempotent: revoking an already-revoked link returns its current state.
  app.post('/api/public-install-links/:id/revoke', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const organizationId = requireSessionOrganizationId(request);
    const link = await revokePublicInstallLink(db, {
      organizationId,
      userId: requireActor(request).id,
      linkId: id,
    });
    return { link };
  });

  // POST /api/public-install-links/:id/regenerate — revoke the current link
  // and issue a fresh one (fresh random id) in one transaction. Same shape
  // and gates as create.
  app.post('/api/public-install-links/:id/regenerate', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const organizationId = requireSessionOrganizationId(request);
    const link = await regeneratePublicInstallLink(db, {
      organizationId,
      userId: requireActor(request).id,
      linkId: id,
    });
    return link;
  });

  // ── Deployments (§12, §23–§24, §38) ────────────────────────────────────

  // POST /api/deployments — Create deployment. Stays NOT_INSTALLED until the
  // relay first registers (see /api/relay/register, §6/§39) — that is where
  // the INSTALL job actually gets created, since the deployment record can
  // legitimately exist before any relay has ever called home.
  app.post('/api/deployments', { preHandler: requireAuth }, async (request, reply) => {
    const body = createDeploymentBodySchema.parse(request.body);
    // Fail closed: a deployment may only target a region whose bootstrap
    // artifacts are CONFIRMED published. Selecting a supported-but-unpublished
    // region would produce an install link whose Lambda code cannot be fetched
    // in that region — the exact PermanentRedirect failure this guard exists
    // to prevent. The region must be in the canonical deployable set, not just
    // the supported enum.
    if (!env.deployableAwsRegions.includes(body.region)) {
      throw new ApiError(
        422,
        'REGION_NOT_SUPPORTED',
        `Region ${body.region} is not available for installation yet.`,
      );
    }
    const organizationId = resolveWriteOrganizationId(request, body.organizationId);
    // Paddle migration Phase 7 — evaluation is free (TEST deployments never
    // consult billing); only PRODUCTION requires an ACTIVE subscription, and
    // only one active TEST deployment is allowed per application. Both gates
    // run before createDeploymentRecord and before any customer row is
    // created for this deployment.
    if (body.deploymentType === 'TEST') {
      await assertTestDeploymentSlot(db, organizationId, body.applicationId);
    } else {
      await assertProductionDeploymentAllowed(db, organizationId, env.billingEnforcementPaused);
    }
    // Everything after this point (org-scoped 404s, the Phase 2 manifest
    // readiness gates, and the insert) is shared with the deploy-link flow —
    // see createDeploymentRecord in apps/api/src/deploy-links.ts. The final
    // manifest is persisted as the deployment's desired state so rollback and
    // day-2 deploys keep the exact config this deployment was created with.
    let deployment;
    try {
      ({ deployment } = await createDeploymentRecord(
        db,
        {
          organizationId,
          applicationId: body.applicationId,
          customerId: body.customerId,
          region: body.region,
          deploymentType: body.deploymentType,
          createdBy: request.user?.id ?? null,
          updatedBy: request.user?.id ?? null,
          source: 'manual',
          ...(body.sizeProfile !== undefined ? { sizeProfile: body.sizeProfile } : {}),
        },
        compilerDeps,
      ));
      // DEPLOY-027 (Phase 4): materialization runs after the deployment row
      // is durable — same pattern as createDeployLink / public-install /
      // completePendingCheckoutIntent.
      await materializePendingSecretsForDeployment({ pendingSecrets, cipher }, {
        organizationId,
        id: deployment.id,
        applicationId: deployment.applicationId,
        customerId: deployment.customerId,
      });
    } catch (error) {
      // Two concurrent creates can both pass assertTestDeploymentSlot before
      // either inserts — the partial unique index catches the loser here.
      // Re-running the same check now finds the winner's committed row and
      // throws the identical 409, with its deploymentId.
      if (body.deploymentType === 'TEST' && isTestDeploymentSlotViolation(error)) {
        await assertTestDeploymentSlot(db, organizationId, body.applicationId);
      }
      throw error;
    }
    return reply.code(201).send(deployment);
  });

  // GET /api/regions — the region options for the "Create customer
  // deployment" screen. Served by the control plane (not hardcoded in the
  // web app) so the UI can never offer a region that is not actually
  // deployable: only regions whose regional bootstrap artifacts are confirmed
  // published appear here. Derived from the canonical SUPPORTED_AWS_REGIONS /
  // REGION_LABELS in @deployz/contracts, intersected with
  // env.deployableAwsRegions.
  app.get('/api/regions', { preHandler: requireAuth }, async () => {
    return {
      regions: SUPPORTED_AWS_REGIONS.filter((region) => env.deployableAwsRegions.includes(region)).map(
        (region) => ({ value: region, label: REGION_LABELS[region] }),
      ),
    };
  });

  // GET /api/deployments — Fleet dashboard (§23). Joined with customers +
  // applications + the current release so the UI gets Customer / Version /
  // Region / Status (and application name / masked AWS account / created
  // date for §24) without a second round trip per row.
  app.get('/api/deployments', { preHandler: requireAuth }, async (request) => {
    const { customerId, applicationId, includeDeleted } = request.query as {
      customerId?: string;
      applicationId?: string;
      includeDeleted?: string;
    };
    const organizationId = requireSessionOrganizationId(request);
    // These reach a uuid column directly. Unvalidated, a hand-typed URL made
    // Postgres raise and the request 500 with no error envelope.
    requireUuidQueryParam(customerId, 'customerId');
    requireUuidQueryParam(applicationId, 'applicationId');
    const conditions = [eq(schema.deployments.organizationId, organizationId)];
    if (customerId) {
      conditions.push(eq(schema.deployments.customerId, customerId));
    }
    if (applicationId) {
      conditions.push(eq(schema.deployments.applicationId, applicationId));
    }
    // §63 a removed deployment stays in the audit trail but leaves the fleet:
    // the homepage already excluded it and this list did not, so the two
    // screens disagreed about what the fleet was.
    if (includeDeleted !== 'true') {
      conditions.push(ne(schema.deployments.state, 'DELETED'));
    }
    const rows = await db
      .select({
        deployment: schema.deployments,
        customerName: schema.customers.name,
        applicationName: schema.applications.name,
        version: schema.releases.version,
        migrationCommand: schema.applications.migrationCommand,
      })
      .from(schema.deployments)
      .innerJoin(schema.customers, eq(schema.deployments.customerId, schema.customers.id))
      .innerJoin(schema.applications, eq(schema.deployments.applicationId, schema.applications.id))
      .leftJoin(schema.releases, eq(schema.deployments.currentReleaseId, schema.releases.id))
      .where(and(...conditions));

    // Batched so the list stays one round trip per table regardless of fleet
    // size: N per-row queries here previously would have meant N+1 queries
    // (jobs) and another N+1 (domains) on top of the row query above.
    const ids = rows.map((row) => row.deployment.id);
    const jobRows =
      ids.length > 0
        ? await db
            // Status derivation never reads a job's payload (the INSTALL
            // payload carries the whole manifest), so it stays in the database.
            .select(JOB_LIST_COLUMNS)
            .from(schema.deploymentJobs)
            .where(inArray(schema.deploymentJobs.deploymentId, ids))
            .orderBy(schema.deploymentJobs.createdAt)
        : [];
    const jobsByDeployment = new Map<string, Omit<DeploymentJobRow, 'payload'>[]>();
    for (const job of jobRows) {
      const list = jobsByDeployment.get(job.deploymentId);
      if (list) {
        list.push(job);
      } else {
        jobsByDeployment.set(job.deploymentId, [job]);
      }
    }
    // The partial unique index on (deployment_id) WHERE removed_at IS NULL
    // guarantees at most one row per deployment here, so no per-deployment
    // "latest" reduction is needed the way findActiveDomain does for a
    // single deployment.
    const domainRows =
      ids.length > 0
        ? await db
            .select()
            .from(schema.customDomains)
            .where(and(inArray(schema.customDomains.deploymentId, ids), isNull(schema.customDomains.removedAt)))
        : [];
    const domainByDeployment = new Map(domainRows.map((domain) => [domain.deploymentId, domain]));

    return {
      deployments: rows.map((row) => {
        const jobs = jobsByDeployment.get(row.deployment.id) ?? [];
        const domain = domainByDeployment.get(row.deployment.id) ?? null;
        const defaultHttps = parseDefaultHttps(row.deployment.defaultHttps);
        const appUrl = resolveAppUrl(jobs, domain, defaultHttps);
        // Phase 2: the requirement booleans come from the deployment's frozen
        // manifest, never the live `applications` columns above — so the
        // fleet's component list and derived status can never disagree with
        // what this deployment was actually created with.
        const derivedRow = { ...row, ...derivationApplicationFor(row.deployment, row) };
        const derived = deriveDeploymentStatus({
          deployment: row.deployment,
          application: derivedRow,
          jobs,
          domain,
          defaultHttps,
          connectorUpdate: connectorUpdateFor(row.deployment),
          appUrl,
        });
        // Spec components from the existing component states only — the list
        // endpoint does no per-row stack-event query (see the detail route).
        const specComponents = specComponentsForStatus(row.deployment.specV2, derived.components, []);
        return {
          ...toFleetRow(derivedRow),
          deploymentStatus: {
            ...toVendorDeploymentStatus(derived),
            ...(specComponents ? { specComponents } : {}),
          },
        };
      }),
    };
  });

  // GET /api/deployments/:id — Deployment detail (§24)
  app.get('/api/deployments/:id', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const organizationId = requireSessionOrganizationId(request);
    requireUuidId(id);
    const rows = await db
      .select({
        deployment: schema.deployments,
        customerName: schema.customers.name,
        applicationName: schema.applications.name,
        version: schema.releases.version,
        migrationCommand: schema.applications.migrationCommand,
      })
      .from(schema.deployments)
      .innerJoin(schema.customers, eq(schema.deployments.customerId, schema.customers.id))
      .innerJoin(schema.applications, eq(schema.deployments.applicationId, schema.applications.id))
      .leftJoin(schema.releases, eq(schema.deployments.currentReleaseId, schema.releases.id))
      .where(and(eq(schema.deployments.id, id), eq(schema.deployments.organizationId, organizationId)))
      .limit(1);
    if (rows.length === 0) {
      throw new NotFoundError('Deployment not found');
    }
    const jobs = await db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.deploymentId, id))
      .orderBy(schema.deploymentJobs.createdAt);
    // Task 11: a compact status/reference for the internal detail page —
    // attached here rather than inside toFleetRow so the fleet LIST endpoint
    // doesn't pick up an extra per-row domain query.
    const domain = await findActiveDomain(db, rows[0]!.deployment.id);
    const customDomain = domain ? { hostname: domain.hostname, status: domain.status.toLowerCase() } : null;
    const defaultHttps = parseDefaultHttps(rows[0]!.deployment.defaultHttps);
    const appUrl = resolveAppUrl(jobs, domain, defaultHttps);
    const defaultUrl = resolveDefaultUrl(defaultHttps);
    // Phase 2: derive the requirement booleans from the deployment's frozen
    // manifest, never the live `applications` columns selected above.
    const derivedRow = { ...rows[0]!, ...derivationApplicationFor(rows[0]!.deployment, rows[0]!) };
    const derived = deriveDeploymentStatus({
      deployment: derivedRow.deployment,
      application: derivedRow,
      jobs,
      domain,
      defaultHttps,
      connectorUpdate: connectorUpdateFor(rows[0]!.deployment),
      appUrl,
    });
    const specComponents = specComponentsForStatus(rows[0]!.deployment.specV2, derived.components, []);
    const sizeProfile = resolveStoredInfrastructureSizeProfile(rows[0]!.deployment.desiredState);
    return {
      ...toFleetRow(derivedRow),
      jobs: jobs.map((job) => ({ ...job, payload: redactClaimedPayload(job) ?? {} })),
      customDomain,
      appUrl,
      defaultUrl,
      // The size frozen at creation; null only for an unresolvable stored reference.
      size: sizeProfile ? { id: sizeProfile.id, label: sizeProfile.label, profileKey: profileKey(sizeProfile) } : null,
      deploymentStatus: {
        ...toVendorDeploymentStatus(derived),
        ...(specComponents ? { specComponents } : {}),
      },
    };
  });

  // ── Releases (§22) ──────────────────────────────────────────────────────

  // POST /api/applications/:id/releases — Create release
  app.post('/api/applications/:id/releases', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const organizationId = requireSessionOrganizationId(request);
    const application = await loadOwnedApplication(db, id, organizationId);
    await ensureBuildConfigurationReady(db, application);
    const body = createReleaseBodySchema.parse(request.body);

    // §36 one immutable record per version. Two releases called 1.0.0 make
    // "deploy 1.0.0" ambiguous, so the unique index refuses the second and
    // this turns it into a message a person can act on.
    const duplicate = await db
      .select({ id: schema.releases.id })
      .from(schema.releases)
      .where(and(eq(schema.releases.applicationId, id), eq(schema.releases.version, body.version)))
      .limit(1);
    if (duplicate.length > 0) {
      throw new ApiError(
        409,
        'RELEASE_VERSION_EXISTS',
        `Version ${body.version} already exists for this application. Use a different version number.`,
      );
    }

    const row = await createReleaseRecord(db, {
      organizationId,
      userId: request.user?.id ?? null,
      applicationId: id,
      version: body.version,
      gitSha: body.gitSha,
      migrationCommand: body.migrationCommand ?? null,
    });

    return reply.code(201).send(row);
  });

  // GET /api/applications/:id/releases — List releases
  app.get('/api/applications/:id/releases', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const organizationId = requireSessionOrganizationId(request);
    await loadOwnedApplication(db, id, organizationId);
    const stored = await db
      .select()
      .from(schema.releases)
      .where(eq(schema.releases.applicationId, id))
      .orderBy(schema.releases.createdAt);
    // A READY release whose image the registry no longer holds reads
    // UNAVAILABLE. Throttled per release (release-images.ts) — a page load is
    // one registry call at most, never a poll.
    const rows = await refreshReleaseImageAvailability(db, releaseImages, stored);
    return {
      releases: rows.map((row) => ({
        id: row.id,
        version: row.version,
        gitSha: row.gitSha,
        status: releaseWireStatus(row),
        failureReason: row.failureReason,
        createdAt: row.createdAt,
      })),
    };
  });

  // ── Failed release builds (release-build-failure.ts) ────────────────────
  //
  // Evidence for ONE failed release of an application the caller's
  // organization owns: the redacted build log, the earliest errors in it,
  // and the on-demand AI reading of those lines. Read-only — nothing here
  // changes the release or starts a build.
  async function loadFailedRelease(
    applicationId: string,
    releaseId: string,
    organizationId: string,
  ): Promise<{ application: ApplicationRow; release: typeof schema.releases.$inferSelect }> {
    const application = await loadOwnedApplication(db, applicationId, organizationId);
    requireUuidId(releaseId);
    const [release] = await db
      .select()
      .from(schema.releases)
      .where(and(eq(schema.releases.id, releaseId), eq(schema.releases.applicationId, application.id)))
      .limit(1);
    if (!release) {
      throw new NotFoundError('Release not found');
    }
    if (release.releaseStatus !== 'FAILED') {
      throw new ApiError(409, 'RELEASE_NOT_FAILED', 'Build failure details exist only for a release whose build failed.');
    }
    return { application, release };
  }

  async function loadBuildFailureDetails(request: FastifyRequest) {
    const { id, releaseId } = request.params as { id: string; releaseId: string };
    const { application, release } = await loadFailedRelease(id, releaseId, requireSessionOrganizationId(request));
    const log = await readReleaseBuildLog(buildLogReader, release.currentBuildId);
    return { details: buildFailureDetails({ release, application, log }), log };
  }

  // GET /api/applications/:id/releases/:releaseId/build-failure
  app.get(
    '/api/applications/:id/releases/:releaseId/build-failure',
    { preHandler: requireAuth, config: { rateLimit: BUILD_FAILURE_RATE_LIMIT } },
    async (request) => (await loadBuildFailureDetails(request)).details,
  );

  // GET /api/applications/:id/releases/:releaseId/build-log — the redacted,
  // bounded build log the details panel links to.
  app.get(
    '/api/applications/:id/releases/:releaseId/build-log',
    { preHandler: requireAuth, config: { rateLimit: BUILD_FAILURE_RATE_LIMIT } },
    async (request) => {
      const { log } = await loadBuildFailureDetails(request);
      return log.status === 'available'
        ? { status: log.status, lines: log.log.lines, truncated: log.log.truncated }
        : { status: log.status, lines: [], truncated: false };
    },
  );

  // POST /api/applications/:id/releases/:releaseId/build-failure/explain —
  // on demand only. Any AI failure is a retryable 503; the details and logs
  // above never depend on it.
  app.post(
    '/api/applications/:id/releases/:releaseId/build-failure/explain',
    { preHandler: requireAuth, config: { rateLimit: BUILD_EXPLANATION_RATE_LIMIT } },
    async (request) => {
      const { details } = await loadBuildFailureDetails(request);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), BUILD_EXPLANATION_TIMEOUT_MS);
      try {
        return await explainBuildFailure(details, aiGateway, { abortSignal: controller.signal });
      } catch (error) {
        request.log.warn({ err: error }, 'release build explanation failed');
        throw new ApiError(
          503,
          'BUILD_EXPLANATION_UNAVAILABLE',
          'The AI explanation is not available right now. The failure details and build logs are not affected.',
        );
      } finally {
        clearTimeout(timer);
      }
    },
  );

  // ── Commit selector (releases) ──────────────────────────────────────────
  //
  // Backs the release form's "pick a commit" UI: a paged, branch-scoped
  // commit list plus manual-sha resolution, both narrowed to the
  // application's own repo/branch (never a caller-supplied branch — see the
  // commit-selector contract). Same fixture/real-App split as
  // /api/github/repos, and the same 409 GITHUB_NOT_CONNECTED story: an
  // installation token mint failure means the App was uninstalled or access
  // was revoked since the application was connected, which is indistinguishable
  // from "never connected" from here.
  async function resolveCommitInstallationToken(application: ApplicationRow, organizationId: string): Promise<string> {
    if (!application.githubInstallationId) {
      throw new ApiError(409, 'GITHUB_NOT_CONNECTED', 'This application is not connected to a GitHub installation');
    }
    const record = await githubStore.get(application.githubInstallationId);
    if (!record || record.organizationId !== organizationId) {
      throw new ApiError(409, 'GITHUB_NOT_CONNECTED', 'This application is not connected to a GitHub installation');
    }
    if (!githubAppId || !githubAppPrivateKey) {
      throw new ApiError(503, 'GITHUB_DISABLED', 'GitHub App is not configured');
    }
    try {
      const { token } = await mintInstallationToken(
        application.githubInstallationId,
        githubAppId,
        githubAppPrivateKey,
        Date.now(),
        githubFetch,
      );
      return token;
    } catch (error) {
      // mintInstallationToken collapses every non-2xx from GitHub into one
      // opaque failure (no status code surfaces) — the App having been
      // uninstalled or its access revoked (401/403/404) is the expected
      // cause, so every mint failure reads as "not connected" rather than a
      // generic 502.
      if (error instanceof ApiError && error.code === 'GITHUB_TOKEN_FETCH_FAILED') {
        throw new ApiError(409, 'GITHUB_NOT_CONNECTED', 'This application is not connected to a GitHub installation');
      }
      throw error;
    }
  }

  const commitsQuerySchema = z.object({
    page: z.coerce.number().int().min(1).max(10).optional().default(1),
  });

  // GET /api/applications/:id/commits?page=N — paged commit history for the
  // application's own repo + default branch (fixed page size 30).
  app.get(
    '/api/applications/:id/commits',
    { preHandler: requireAuth, config: { rateLimit: GITHUB_COMMITS_RATE_LIMIT } },
    async (request) => {
      const { id } = request.params as { id: string };
      const organizationId = requireSessionOrganizationId(request);
      const application = await loadOwnedApplication(db, id, organizationId);
      const parsedQuery = commitsQuerySchema.safeParse(request.query);
      if (!parsedQuery.success) {
        throw new ApiError(400, 'INVALID_PAGE', 'page must be an integer between 1 and 10');
      }
      const { page } = parsedQuery.data;

      const fixtureMode = githubFixtureMode ?? env.githubFixtureMode;
      const { commits, nextPage } = fixtureMode
        ? listFixtureBranchCommits(page)
        : await listBranchCommits(
            { ...parseRepoFullName(application.repoFullName), branch: application.defaultBranch },
            page,
            await resolveCommitInstallationToken(application, organizationId),
            githubFetch,
          );

      return {
        repoFullName: application.repoFullName,
        branch: application.defaultBranch,
        commits,
        nextPage,
      };
    },
  );

  const COMMIT_SHA_REGEX = /^[0-9a-f]{7,40}$/i;

  // GET /api/applications/:id/commits/:sha — manual sha entry, resolved and
  // validated against the application's own repo (the sha regex is what
  // guarantees a branch name can never be resolved and stored as a release).
  app.get(
    '/api/applications/:id/commits/:sha',
    { preHandler: requireAuth, config: { rateLimit: GITHUB_COMMITS_RATE_LIMIT } },
    async (request) => {
      const { id, sha } = request.params as { id: string; sha: string };
      const organizationId = requireSessionOrganizationId(request);
      const application = await loadOwnedApplication(db, id, organizationId);
      if (!COMMIT_SHA_REGEX.test(sha)) {
        throw new ApiError(400, 'INVALID_COMMIT_SHA', 'sha must be 7-40 hexadecimal characters');
      }

      const fixtureMode = githubFixtureMode ?? env.githubFixtureMode;
      const commit = fixtureMode
        ? getFixtureCommit(sha)
        : await getCommit(
            parseRepoFullName(application.repoFullName),
            sha,
            await resolveCommitInstallationToken(application, organizationId),
            githubFetch,
          );

      return { commit };
    },
  );

  // ── Job triggers (§25, §27, §63) ────────────────────────────────────────

  /**
   * Record a vendor-initiated job: move the deployment into its §46 in-flight
   * state and append the §40 event, atomically.
   *
   * Both used to be missing. The deployment stayed on HEALTHY from the moment
   * a deploy was requested until the relay answered, so a vendor who clicked
   * "Deploy Update" watched the page return to exactly the state it was in —
   * and no row was ever written to the event log, so "Recent activity" stayed
   * empty through a deployment's entire life.
   */
  async function markJobRequested(params: {
    deployment: DeploymentRow;
    jobId: string;
    inFlightState: DeploymentRow['state'] | null;
    eventType: DeploymentEventType;
    actorId: string | null;
    releaseId?: string | undefined;
  }): Promise<void> {
    await db.transaction(async (tx) => {
      if (params.inFlightState) {
        await tx
          .update(schema.deployments)
          .set({ state: params.inFlightState, updatedBy: params.actorId })
          .where(eq(schema.deployments.id, params.deployment.id));
      }
      await recordEvent(tx, {
        organizationId: params.deployment.organizationId,
        eventType: params.eventType,
        actorType: 'user',
        actorId: params.actorId ?? 'system',
        deploymentId: params.deployment.id,
        customerId: params.deployment.customerId,
        jobId: params.jobId,
        releaseId: params.releaseId,
        previousState: params.deployment.state,
        requestedState: params.inFlightState,
        result: 'pending',
      });
    });
  }

  /**
   * Phase 1.1: after a successful INSTALL the stack runs the template's pinned
   * image — roll the newest READY release of the application immediately so a
   * fresh installation serves real traffic without a manual deploy step.
   *
   * No READY release (nothing built yet), a migration command the frozen
   * deployment has no migration step for, or an application whose topology
   * no longer fits the frozen stack are decisions, not failures: the outcome
   * names the reason and nothing is queued. The job is keyed on the install
   * job, so a replay or a heartbeat repair reuses it; a vendor-driven deploy
   * meets it through the one-active-job rule.
   *
   * The deployment state is deliberately NOT advanced (`inFlightState: null`):
   * the INSTALLING → HEALTHY transition belongs to the relay's runtime-health
   * verification, and an auto-queued deploy must not make the deployment look
   * healthier than it is. The relay picks the job up on its next poll and the
   * DEPLOY_RELEASE result handler settles the state as usual.
   */
  async function autoDeploySelectedRelease(
    deployment: DeploymentRow,
    installJobId: string,
  ): Promise<'queued' | 'no_ready_release' | 'migration_workload_missing' | 'topology_changed'> {
    try {
      await requireNoAddedRequirement(db, deployment);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'INFRASTRUCTURE_CHANGE_REQUIRED') return 'topology_changed';
      throw error;
    }
    // Newest first, skipping releases already known to be unavailable; a
    // release whose image turns out to be gone at this moment is skipped for
    // the next one rather than queued to fail.
    const newestReady = await db
      .select({ id: schema.releases.id })
      .from(schema.releases)
      .where(
        and(
          eq(schema.releases.applicationId, deployment.applicationId),
          eq(schema.releases.releaseStatus, 'READY'),
          isNull(schema.releases.imageUnavailableAt),
        ),
      )
      .orderBy(desc(schema.releases.createdAt))
      .limit(5);
    let release: { id: string } | undefined;
    let payload: DeployPayload | undefined;
    for (const candidate of newestReady) {
      try {
        payload = await requireDeployableRelease(db, releaseImages, candidate.id, deployment.applicationId, deployment);
        release = candidate;
        break;
      } catch (error) {
        if (error instanceof ApiError && error.code === 'RELEASE_UNAVAILABLE') continue;
        if (error instanceof ApiError && error.code === 'MIGRATION_WORKLOAD_MISSING') return 'migration_workload_missing';
        throw error;
      }
    }
    if (!release || !payload) return 'no_ready_release';

    const { job, created } = await createOrReuseJob(db, {
      deploymentId: deployment.id,
      type: 'DEPLOY_RELEASE',
      idempotencyKey: `${deployment.id}:DEPLOY_RELEASE:install:${installJobId}`,
      payload,
      requestedBy: null,
    });
    if (created) {
      await markJobRequested({
        deployment,
        jobId: job.id,
        inFlightState: null,
        eventType: 'deploy.requested',
        actorId: null,
        releaseId: release.id,
      });
    }
    return 'queued';
  }

  /**
   * The follow-ups of a successful INSTALL, in the order the relay must run
   * them: the first configuration pass, then the auto-deploy (a zero-task
   * install, DEPLOY-009, needs its configured task-definition revision before
   * the deploy that first starts it). Both are keyed on the install job, so
   * the result route, a replayed result and the heartbeat repair converge on
   * the same jobs. A failure here leaves the install job unmarked, so the next
   * heartbeat retries; once the outcome is decided (queued, skipped with a
   * reason, or the deployment moved on) the decision is recorded on the install
   * job's result and the repair stops.
   */
  async function ensureInstallFollowUps(
    deployment: DeploymentRow,
    installJob: { id: string; createdAt: Date },
  ): Promise<void> {
    if (deployment.state === 'DELETING' || deployment.state === 'DELETED') return;
    const [later] = await db
      .select({ id: schema.deploymentJobs.id })
      .from(schema.deploymentJobs)
      .where(
        and(
          eq(schema.deploymentJobs.deploymentId, deployment.id),
          inArray(schema.deploymentJobs.type, ['DEPLOY_RELEASE', 'ROLLBACK', 'DESTROY']),
          gt(schema.deploymentJobs.createdAt, installJob.createdAt),
          ne(schema.deploymentJobs.idempotencyKey, `${deployment.id}:DEPLOY_RELEASE:install:${installJob.id}`),
        ),
      )
      .limit(1);
    let outcome: string = 'superseded';
    if (!later) {
      await queuePostInstallConfig(db, deployment, installJob.id, configStore);
      outcome = await autoDeploySelectedRelease(deployment, installJob.id);
    }
    await db
      .update(schema.deploymentJobs)
      .set({
        result: sql`coalesce(${schema.deploymentJobs.result}, '{}'::jsonb) || ${JSON.stringify({ followUps: { autoDeploy: outcome } })}::jsonb`,
      })
      .where(eq(schema.deploymentJobs.id, installJob.id));
  }


  // POST /api/deployments/:id/deploy — Trigger (or reuse) a DEPLOY_RELEASE job
  app.post('/api/deployments/:id/deploy', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const organizationId = requireSessionOrganizationId(request);
    const deployment = await loadOwnedDeployment(db, id, organizationId);
    const body = deployBodySchema.parse(request.body);
    const payload = await requireDeployableRelease(db, releaseImages, body.releaseId, deployment.applicationId, deployment);
    // The same rule deploy-bulk applies. Without it this route accepted a
    // deploy for a NOT_INSTALLED deployment — 202, a queued job, and nothing
    // in the customer's account to ever run it.
    await requireDeployableState(db, deployment);
    await requireNoAddedRequirement(db, deployment);
    const idempotencyKey =
      clientIdempotencyKey(request, deployment.id, 'DEPLOY_RELEASE') ??
      (await retryAwareIdempotencyKey(
        db,
        deployment.id,
        'DEPLOY_RELEASE',
        deployReleaseKey(deployment.id, body.releaseId, payload),
      ));
    await requireDeploymentIdle(db, deployment.id, idempotencyKey);
    const { job, created } = await createOrReuseJob(db, {
      deploymentId: deployment.id,
      type: 'DEPLOY_RELEASE',
      idempotencyKey,
      payload,
      requestedBy: request.user?.id ?? null,
    });
    if (created) {
      await markJobRequested({
        deployment,
        jobId: job.id,
        inFlightState: BULK_DEPLOYABLE_STATES.has(deployment.state) ? 'UPDATING' : null,
        eventType: 'deploy.requested',
        actorId: request.user?.id ?? null,
        releaseId: body.releaseId,
      });
    }
    return reply.code(created ? 202 : 200).send({ jobId: job.id, state: job.state });
  });

  // POST /api/applications/:id/deploy-bulk — §25 "one / selected / all
  // compatible customers". Fans out into individual per-deployment
  // DEPLOY_RELEASE jobs via the exact same idempotent path as the
  // single-deploy route above — never one aggregate job.
  app.post('/api/applications/:id/deploy-bulk', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const organizationId = requireSessionOrganizationId(request);
    await loadOwnedApplication(db, id, organizationId);
    const body = deployBulkBodySchema.parse(request.body);
    // Early release gate (READY + image available). Each target below derives
    // its own payload — per-deployment rollout seats and migration state.
    await requireDeployableRelease(db, releaseImages, body.releaseId, id);

    const conditions = [
      eq(schema.deployments.applicationId, id),
      eq(schema.deployments.organizationId, organizationId),
    ];
    if (body.deploymentIds && body.deploymentIds.length > 0) {
      conditions.push(inArray(schema.deployments.id, body.deploymentIds));
    }
    const targets = await db
      .select()
      .from(schema.deployments)
      .where(and(...conditions));

    const results: Array<{
      deploymentId: string;
      status: 'REQUESTED' | 'ALREADY_REQUESTED' | 'SKIPPED';
      jobId?: string;
      reason?: string;
    }> = [];

    for (const deployment of targets) {
      if (!BULK_DEPLOYABLE_STATES.has(deployment.state)) {
        results.push({
          deploymentId: deployment.id,
          status: 'SKIPPED',
          reason: `Deployment is ${deployment.state}, not deployable`,
        });
        continue;
      }
      // Same §9.5 gate as the single-deploy route: a dead relay never claims
      // the job, and the watchdog would fail it later — skip with a reason.
      if (deployment.relayStatus === 'DISCONNECTED') {
        results.push({
          deploymentId: deployment.id,
          status: 'SKIPPED',
          reason: 'The relay for this deployment is disconnected — reconnect it before deploying.',
        });
        continue;
      }
      // A deployment whose relay never enrolled has no installationId and
      // cannot receive commands — skip with a reason instead of queuing a
      // doomed job (DZ-AUDIT-032).
      if (!deployment.installationId) {
        results.push({
          deploymentId: deployment.id,
          status: 'SKIPPED',
          reason: 'The relay for this deployment has not connected yet — install it before deploying.',
        });
        continue;
      }
      try {
        await requireNoAddedRequirement(db, deployment);
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        results.push({ deploymentId: deployment.id, status: 'SKIPPED', reason: error.message });
        continue;
      }
      // Phase 4A/4C: each target resolves its own per-workload seats and
      // migration policy from ITS frozen spec — the same derivation as the
      // single-deploy route (a target may be on an older compiled generation
      // than another, or have no migration step to correct).
      let targetPayload: DeployPayload;
      try {
        targetPayload = await requireDeployableRelease(db, releaseImages, body.releaseId, id, deployment);
      } catch (error) {
        if (!(error instanceof ApiError && error.code === 'MIGRATION_WORKLOAD_MISSING')) throw error;
        results.push({ deploymentId: deployment.id, status: 'SKIPPED', reason: error.message });
        continue;
      }
      const idempotencyKey = await retryAwareIdempotencyKey(
        db,
        deployment.id,
        'DEPLOY_RELEASE',
        deployReleaseKey(deployment.id, body.releaseId, targetPayload),
      );
      const busy = await db
        .select({ id: schema.deploymentJobs.id })
        .from(schema.deploymentJobs)
        .where(
          and(
            eq(schema.deploymentJobs.deploymentId, deployment.id),
            inArray(schema.deploymentJobs.state, ['REQUESTED', 'QUEUED', 'WAITING', 'RUNNING']),
            inArray(schema.deploymentJobs.type, [
              'INSTALL',
              'DEPLOY_RELEASE',
              'ROLLBACK',
              'RESTART',
              'CONFIG_UPDATE',
              'DESTROY',
              'MIGRATION',
              'INFRA_UPGRADE',
            ]),
            // A retry of this same release deploy reuses its job; only a
            // DIFFERENT active operation skips this deployment.
            ne(schema.deploymentJobs.idempotencyKey, idempotencyKey),
          ),
        )
        .limit(1);
      if (busy.length > 0) {
        results.push({
          deploymentId: deployment.id,
          status: 'SKIPPED',
          reason: 'Another deployment operation is already in progress.',
        });
        continue;
      }
      const { job, created } = await createOrReuseJob(db, {
        deploymentId: deployment.id,
        type: 'DEPLOY_RELEASE',
        idempotencyKey,
        payload: targetPayload,
        requestedBy: request.user?.id ?? null,
      });
      if (created) {
        // Telemetry alignment: the single-deploy route and auto-deploy go
        // through markJobRequested and emit deploy.requested; bulk targets
        // used to be queued here directly and got no event. inFlightState is
        // null to preserve bulk's exact behaviour — it never advanced a
        // deployment's state the way the single-deploy route does.
        await markJobRequested({
          deployment,
          jobId: job.id,
          inFlightState: null,
          eventType: 'deploy.requested',
          actorId: request.user?.id ?? null,
          releaseId: body.releaseId,
        });
      }
      results.push({
        deploymentId: deployment.id,
        status: created ? 'REQUESTED' : 'ALREADY_REQUESTED',
        jobId: job.id,
      });
    }

    return { results };
  });

  // Trigger (or reuse) a ROLLBACK job for an already-loaded, already-owned
  // deployment. Shared by the vendor rollback route and the admin recovery
  // action — never mutate state independently of this.
  async function performRollback(
    deployment: DeploymentRow,
    actorId: string | null,
    releaseId: string,
    idempotencyKeyHeader: string | undefined,
  ): Promise<{ job: DeploymentJobRow; created: boolean }> {
    await requireDeployableState(db, deployment);
    const payload = await requireDeployableRelease(db, releaseImages, releaseId, deployment.applicationId);
    // ROLLBACK builds its payload WITHOUT the deployment row (see
    // requireDeployableRelease) so it can never carry the migration seat —
    // but scheduled-job families (Phase 5) are not migration-gated, and
    // ROLLBACK must bring them current too (the family's latest revision
    // otherwise keeps running whatever image the last stack operation set).
    const scheduledJobFamilies = scheduledJobFamiliesFor(deployment);
    if (scheduledJobFamilies !== undefined) {
      payload.scheduledJobFamilies = scheduledJobFamilies;
    }
    const idempotencyKey =
      idempotencyKeyHeader ??
      (await retryAwareIdempotencyKey(
        db,
        deployment.id,
        'ROLLBACK',
        `${deployment.id}:ROLLBACK:${releaseId}`,
      ));
    await requireDeploymentIdle(db, deployment.id, idempotencyKey);
    const { job, created } = await createOrReuseJob(db, {
      deploymentId: deployment.id,
      type: 'ROLLBACK',
      idempotencyKey,
      payload,
      requestedBy: actorId,
    });
    if (created) {
      await markJobRequested({
        deployment,
        jobId: job.id,
        inFlightState: BULK_DEPLOYABLE_STATES.has(deployment.state) ? 'UPDATING' : null,
        eventType: 'rollback.requested',
        actorId,
        releaseId,
      });
    }
    return { job, created };
  }

  // POST /api/deployments/:id/rollback — Trigger (or reuse) a ROLLBACK job
  app.post('/api/deployments/:id/rollback', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const organizationId = requireSessionOrganizationId(request);
    const deployment = await loadOwnedDeployment(db, id, organizationId);
    const body = rollbackBodySchema.parse(request.body);
    const { job, created } = await performRollback(
      deployment,
      request.user?.id ?? null,
      body.releaseId,
      clientIdempotencyKey(request, deployment.id, 'ROLLBACK'),
    );
    return reply.code(created ? 202 : 200).send({ jobId: job.id, state: job.state });
  });

  // POST /api/deployments/:id/restart — Restart the running application.
  // Same image, no release pointer change: a fresh ECS deployment of the
  // current task definition.
  app.post('/api/deployments/:id/restart', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const organizationId = requireSessionOrganizationId(request);
    const deployment = await loadOwnedDeployment(db, id, organizationId);
    await requireDeployableState(db, deployment);
    const idempotencyKey =
      clientIdempotencyKey(request, deployment.id, 'RESTART') ??
      (await retryAwareIdempotencyKey(db, deployment.id, 'RESTART', `${deployment.id}:RESTART`));
    await requireDeploymentIdle(db, deployment.id, idempotencyKey);
    const { job, created } = await createOrReuseJob(db, {
      deploymentId: deployment.id,
      type: 'RESTART',
      idempotencyKey,
      payload: {},
      requestedBy: request.user?.id ?? null,
    });
    if (created) {
      await markJobRequested({
        deployment,
        jobId: job.id,
        inFlightState: BULK_DEPLOYABLE_STATES.has(deployment.state) ? 'UPDATING' : null,
        eventType: 'restart.requested',
        actorId: request.user?.id ?? null,
      });
    }
    return reply.code(created ? 202 : 200).send({ jobId: job.id, state: job.state });
  });

  // POST /api/deployments/:id/destroy — Trigger (or reuse) a DESTROY job
  app.post('/api/deployments/:id/destroy', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const organizationId = requireSessionOrganizationId(request);
    const deployment = await loadOwnedDeployment(db, id, organizationId);
    const body = destroyBodySchema.parse(request.body);

    if (deployment.state === 'DELETED') {
      throw new ApiError(
        409,
        'DEPLOYMENT_ALREADY_REMOVED',
        'This deployment has already been removed.',
      );
    }

    // Nothing was ever installed, so there is nothing in the customer's
    // account to remove and no relay to ask. Queuing a DESTROY job here left
    // the deployment sitting at "Not installed" forever while the vendor
    // watched a confirmation dialog close and nothing happen.
    if (deployment.state === 'NOT_INSTALLED' || deployment.state === 'WAITING_FOR_RELAY') {
      const removalActor = { actorType: 'user' as const, actorId: request.user?.id ?? 'system' };
      let billingStopped = false;
      await db.transaction(async (tx) => {
        await tx
          .update(schema.deployments)
          .set({ state: 'DELETED', deletedAt: new Date(), updatedBy: request.user?.id ?? null })
          .where(eq(schema.deployments.id, deployment.id));
        await recordEvent(tx, {
          organizationId: deployment.organizationId,
          eventType: 'destroy.completed',
          actorType: 'user',
          actorId: request.user?.id ?? 'system',
          deploymentId: deployment.id,
          customerId: deployment.customerId,
          previousState: deployment.state,
          requestedState: 'DELETED',
          payload: { reason: 'never installed — removed without a relay job' },
        });
        // Accepted removal intent (R0-1): this IS the destroy, there being no
        // relay job to accept it later.
        billingStopped = await markDeploymentRemoved(tx, deployment, new Date(), removalActor);
      });
      // DEPLOY-027 (Phase 4): drop any pending secret rows for a deployment
      // that never had a relay to consume them — they would otherwise sit
      // until the worker sweep at TTL. Runs OUTSIDE the tx so the
      // pending-secrets drizzle queries do not contend with the connection
      // the tx holds (PGlite is single-connection).
      await pendingSecrets.deleteBoundForDeployment(deployment.id);
      // Phase 9: outside the transaction — a Paddle round trip must never
      // hold the connection the delete just used.
      if (billingStopped) {
        await reconcileAfterBillingChange(db, paddle, deployment.organizationId);
      }
      return reply.code(200).send({ jobId: null, state: 'DELETED' });
    }

    // A pending DESTROY blocks every other mutating command: accepting a
    // deploy against a stack that is about to be deleted can only produce a
    // job whose subject disappears underneath it.
    const idempotencyKey =
      clientIdempotencyKey(request, deployment.id, 'DESTROY') ??
      (await retryAwareIdempotencyKey(db, deployment.id, 'DESTROY', `${deployment.id}:DESTROY`));
    // A DISCONNECTED relay can never complete an active INSTALL, so that
    // install is obsolete and must not block the teardown the vendor asked
    // for. A CONNECTED relay's in-flight INSTALL is genuinely in progress and
    // still blocks DESTROY through the idle check below. Only INSTALL jobs
    // are cancelled — every other job type is left alone.
    if (deployment.relayStatus === 'DISCONNECTED') {
      const cancelledInstalls = await db
        .update(schema.deploymentJobs)
        .set({ state: 'CANCELLED', finishedAt: new Date() })
        .where(
          and(
            eq(schema.deploymentJobs.deploymentId, deployment.id),
            eq(schema.deploymentJobs.type, 'INSTALL'),
            inArray(schema.deploymentJobs.state, ['REQUESTED', 'QUEUED', 'WAITING', 'RUNNING']),
          ),
        )
        .returning();
      if (cancelledInstalls.length > 0) {
        request.log.info(
          {
            deploymentId: deployment.id,
            cancelledInstallJobIds: cancelledInstalls.map((row) => row.id),
          },
          'cancelled obsolete INSTALL for disconnected relay before DESTROY',
        );
      }
    }
    await requireDeploymentIdle(db, deployment.id, idempotencyKey);
    // Data deletion during a wedged destroy is authorized ONLY for a
    // deployment that never completed an install — its retained database is
    // an empty artifact of a failed create, not customer data. Anything
    // that ever ran keeps the data-preserving destroy path (the relay
    // finishes the stack delete RETAINING what it cannot remove).
    const neverInstalled = !(await hasSucceededInstall(db, deployment.id));
    const { job, created } = await createOrReuseJob(db, {
      deploymentId: deployment.id,
      type: 'DESTROY',
      idempotencyKey,
      payload: {
        finalSnapshot: body.finalSnapshot ?? false,
        dataDeletionAuthorized: neverInstalled,
      },
      requestedBy: request.user?.id ?? null,
    });
    if (created) {
      await markJobRequested({
        deployment,
        jobId: job.id,
        inFlightState: 'DELETING',
        eventType: 'destroy.requested',
        actorId: request.user?.id ?? null,
      });
    }
    // Accepted removal intent (R0-1): a DESTROY has been queued for a
    // deployment that was actually installed. Idempotent — a replay of an
    // already-accepted destroy is a no-op.
    if (
      await markDeploymentRemoved(db, deployment, new Date(), {
        actorType: 'user',
        actorId: request.user?.id ?? 'system',
      })
    ) {
      await reconcileAfterBillingChange(db, paddle, deployment.organizationId);
    }

    // The stack is coming down — start tearing down any custom domain
    // alongside it rather than leaving it dangling once the deployment is
    // gone. The DESTROY-success handler below is the safety net if this
    // REMOVE_DOMAIN job never finishes.
    const activeDomain = await findActiveDomain(db, deployment.id);
    if (activeDomain) {
      await removeCustomDomain(db, deployment, activeDomain);
    }

    // Phase 11: same teardown for the deployment's default-HTTPS state — the
    // relay removes the customer-side certificate and 443 listener via a
    // REMOVE_DOMAIN job; the control-plane route53 records are removed by the
    // DESTROY-success (or REMOVE-success, or purge) handlers.
    const defaultHttpsState = parseDefaultHttps(deployment.defaultHttps);
    if (defaultHttpsState) {
      await beginDefaultHttpsRemoval(db, deployment, defaultHttpsState);
    }

    return reply.code(created ? 202 : 200).send({ jobId: job.id, state: job.state });
  });

  // Settle a DESTROY whose relay went offline mid-delete, OR whose delete
  // keeps FAILING on a relay that is still online, for an already-loaded,
  // already-owned deployment. Shared by the vendor disconnect/force-complete
  // route and the admin recovery action.
  //
  // This completes the CONTROL-PLANE disconnect only. It never claims the
  // customer's AWS resources were removed: cleanupState records
  // SKIPPED_RELAY_OFFLINE, the warning stays visible until a PURGE runs, and
  // the stuck DESTROY job is cancelled rather than failed so the deployment
  // does not land in FAILED with no way out.
  async function performForceCompleteDestroy(
    deployment: DeploymentRow,
    actorId: string | null,
  ): Promise<{ state: 'DELETED'; cleanupState: 'SKIPPED_RELAY_OFFLINE'; jobId: string }> {
    // Two escape paths, discriminated by whether a DESTROY is still in
    // flight:
    //   1. DELETING + a pending (REQUESTED..RUNNING) DESTROY — the relay
    //      went offline mid-delete (relayStatus DISCONNECTED required).
    //   2. DELETING or FAILED + NO pending DESTROY, but REPEATED FAILED
    //      DESTROY jobs whose latest is the deployment's newest job — the
    //      delete itself is wedged on a relay that keeps reporting failure
    //      (even while technically connected).
    const preForceDefaultHttps = parseDefaultHttps(deployment.defaultHttps);
    const destroys = await db
      .select()
      .from(schema.deploymentJobs)
      .where(
        and(
          eq(schema.deploymentJobs.deploymentId, deployment.id),
          eq(schema.deploymentJobs.type, 'DESTROY'),
        ),
      )
      .orderBy(desc(schema.deploymentJobs.createdAt))
      .limit(10);
    const job = destroys.find((j) =>
      ['REQUESTED', 'QUEUED', 'WAITING', 'RUNNING'].includes(j.state),
    );

    if (job) {
      // Path 1 — offline relay mid-delete.
      if (deployment.state !== 'DELETING') {
        throw new ApiError(
          409,
          'NOT_DELETING',
          'Only a disconnect that is still in progress can be completed this way.',
        );
      }
      // Persisted liveness is the gate: the worker sweep only writes
      // DISCONNECTED after the relay missed its check-in window, so this
      // cannot fire on a relay that is merely between polls.
      if (deployment.relayStatus !== 'DISCONNECTED') {
        throw new ApiError(
          409,
          'RELAY_NOT_OFFLINE',
          'The relay for this deployment is not confirmed offline.',
        );
      }
      const lastSignal = job.lastProgressAt ?? job.startedAt ?? job.createdAt;
      if (Date.now() - lastSignal.getTime() < DESTROY_PENDING_STALE_AFTER_MS) {
        throw new ApiError(
          409,
          'DESTROY_NOT_STALE',
          'The disconnect has not been pending long enough to complete it this way.',
        );
      }
    } else {
      // Path 2 — repeated FAILED destroys, no job in flight.
      const latestAny = await db
        .select({ type: schema.deploymentJobs.type, state: schema.deploymentJobs.state })
        .from(schema.deploymentJobs)
        .where(eq(schema.deploymentJobs.deploymentId, deployment.id))
        .orderBy(desc(schema.deploymentJobs.createdAt))
        .limit(1);
      if (
        deployment.state !== 'DELETING' &&
        deployment.state !== 'FAILED'
      ) {
        throw new ApiError(
          409,
          'NOT_DELETING',
          'Only a disconnect that is still in progress can be completed this way.',
        );
      }
      const failedDestroys = destroys.filter((d) => d.state === 'FAILED');
      if (
        failedDestroys.length < REPEATED_DESTROY_FAILURES_REQUIRED ||
        latestAny[0]?.type !== 'DESTROY' ||
        latestAny[0]?.state !== 'FAILED'
      ) {
        throw new ApiError(409, 'NO_PENDING_DESTROY', 'No disconnect is waiting on this deployment.');
      }
      const lastFailedAt = destroys[0]!.finishedAt ?? destroys[0]!.updatedAt ?? destroys[0]!.createdAt;
      if (Date.now() - lastFailedAt.getTime() < DESTROY_PENDING_STALE_AFTER_MS) {
        throw new ApiError(
          409,
          'DESTROY_NOT_STALE',
          'The disconnect has not been pending long enough to complete it this way.',
        );
      }
    }

    const reason = job ? 'RELAY_OFFLINE' : 'REPEATED_DESTROY_FAILURE';
    const settleJobId = job?.id ?? destroys[0]!.id;

    let billingStopped = false;
    await db.transaction(async (tx) => {
      if (job) {
        await tx
          .update(schema.deploymentJobs)
          .set({
            state: 'CANCELLED',
            finishedAt: new Date(),
            result: { forceCompleted: true, reason },
          })
          .where(eq(schema.deploymentJobs.id, job.id));
      }
      await tx
        .update(schema.deployments)
        .set({
          state: 'DELETED',
          deletedAt: new Date(),
          cleanupState: 'SKIPPED_RELAY_OFFLINE',
          updatedBy: actorId,
        })
        .where(eq(schema.deployments.id, deployment.id));
      // Same safety net as a DESTROY success: the row must not linger as a
      // phantom "removing" domain for a deployment that no longer exists.
      const danglingDomain = await findActiveDomain(tx, deployment.id);
      if (danglingDomain) {
        await tx
          .update(schema.customDomains)
          .set({ removedAt: new Date() })
          .where(eq(schema.customDomains.id, danglingDomain.id));
      }
      // Phase 11: same for the default-HTTPS state — the relay is offline, so
      // the customer-side certificate will be swept by a later purge, but the
      // control-plane record is ours to drop now.
      await tx
        .update(schema.deployments)
        .set({ defaultHttps: null })
        .where(eq(schema.deployments.id, deployment.id));
      // Idempotent backstop (R0-1): the destroy route already stopped
      // billing when the removal was accepted; this only catches a
      // deployment that somehow reached force-complete while still ACTIVE.
      billingStopped = await markDeploymentRemoved(tx, deployment, new Date(), {
        actorType: 'user',
        actorId: actorId ?? 'system',
      });
      await recordEvent(tx, {
        organizationId: deployment.organizationId,
        eventType: 'destroy.force_completed',
        actorType: 'user',
        actorId: actorId ?? 'system',
        deploymentId: deployment.id,
        customerId: deployment.customerId,
        jobId: settleJobId,
        previousState: deployment.state,
        requestedState: 'DELETED',
        result: 'success',
        payload: {
          relayStatus: deployment.relayStatus,
          reason,
          awsResourcesRemoved: false,
          cleanupState: 'SKIPPED_RELAY_OFFLINE',
        },
      });
    });

    // Phase 9: outside the transaction, and only when this backstop was the
    // write that actually stopped billing.
    if (billingStopped) {
      await reconcileAfterBillingChange(db, paddle, deployment.organizationId);
    }

    // DEPLOY-027 (Phase 4): force-completed deployments never had a
    // successful relay poll; the bound rows would otherwise linger until
    // the TTL sweep.
    await pendingSecrets.deleteBoundForDeployment(deployment.id);

    // Phase 11: best-effort drop of the deployz-zone CNAMEs on the same
    // force-complete (the DB state was cleared inside the transaction).
    if (preForceDefaultHttps) {
      try {
        await defaultHttpsDeps.dns.deleteDefaultDeploymentRecord(deployment.id);
      } catch (error) {
        // swallowed — purge is the authoritative cleanup if this fails.
        console.error(JSON.stringify({ event: 'default-https:force-complete-record-cleanup-failed', name: 'default-record', error: String(error) }));
      }
      if (preForceDefaultHttps.validationName) {
        try {
          await defaultHttpsDeps.dns.deleteDefaultValidationRecord(
            deployment.id,
            preForceDefaultHttps.validationName,
          );
        } catch (error) {
          // swallowed — purge is the authoritative cleanup if this fails.
          console.error(JSON.stringify({ event: 'default-https:force-complete-record-cleanup-failed', name: preForceDefaultHttps.validationName, error: String(error) }));
        }
      }
    }

    return { state: 'DELETED', cleanupState: 'SKIPPED_RELAY_OFFLINE', jobId: settleJobId };
  }

  // POST /api/deployments/:id/disconnect/force-complete — settle a DESTROY
  // whose relay went offline mid-delete, OR whose delete keeps FAILING on a
  // relay that is still online.
  app.post(
    '/api/deployments/:id/disconnect/force-complete',
    { preHandler: requireAuth },
    async (request) => {
      const { id } = request.params as { id: string };
      requireUuidId(id);
      const organizationId = requireSessionOrganizationId(request);
      const deployment = await loadOwnedDeployment(db, id, organizationId);
      const result = await performForceCompleteDestroy(deployment, request.user?.id ?? null);
      return { state: result.state, cleanupState: result.cleanupState };
    },
  );

  // POST /api/deployments/:id/purge — Permanently remove retained AWS
  // resources (P2). Only a force-completed disconnect can carry leftovers:
  // a normal disconnect removed its resources via the relay. The vendor
  // typed the deployment name in the dashboard to confirm; the relay
  // re-verifies ownership of every resource before deleting it.
  app.post('/api/deployments/:id/purge', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    requireUuidId(id);
    const organizationId = requireSessionOrganizationId(request);
    const deployment = await loadOwnedDeployment(db, id, organizationId);

    // Purge is the second step of every removal, not only the force-complete
    // escape hatch: a normal Disconnect retains the database, its credential
    // secrets, the stored files and the relay stack (docs/deployment-resilience.md),
    // so a DELETED deployment stays purgeable until a purge has COMPLETEd
    // (CANARY-013).
    if (deployment.state !== 'DELETED' || deployment.cleanupState === 'COMPLETE') {
      throw new ApiError(
        409,
        'NOT_PURGE_ELIGIBLE',
        'Only a disconnected deployment whose retained resources have not been purged can be purged.',
      );
    }
    // One mutating operation per deployment: a purge already in flight must
    // not be joined by another.
    const idempotencyKey =
      clientIdempotencyKey(request, deployment.id, 'PURGE') ??
      (await retryAwareIdempotencyKey(db, deployment.id, 'PURGE', `${deployment.id}:PURGE`));
    await requireDeploymentIdle(db, deployment.id, idempotencyKey);
    const { job, created } = await createOrReuseJob(db, {
      deploymentId: deployment.id,
      type: 'PURGE',
      idempotencyKey,
      // Phase 5 §9.6: a reset may have LEFT an older installation behind
      // (previous stack/install ids recorded on the row). Carry them so the
      // purge can find and account for that stack's retained resources
      // instead of silently orphaning them.
      payload: {
        ...(deployment.previousInstallationId
          ? { previousInstallationId: deployment.previousInstallationId }
          : {}),
        ...(deployment.previousBootstrapStackName
          ? { previousBootstrapStackName: deployment.previousBootstrapStackName }
          : {}),
      },
      requestedBy: request.user?.id ?? null,
    });
    if (created) {
      await recordEvent(db, {
        organizationId: deployment.organizationId,
        eventType: 'purge.requested',
        actorType: 'user',
        actorId: request.user?.id ?? 'system',
        deploymentId: deployment.id,
        customerId: deployment.customerId,
        jobId: job.id,
        previousState: deployment.state,
        result: 'pending',
        payload: {},
      });
    }

    // Phase 11: a purge is the authorized final teardown — drop the
    // deployment's deployz-zone CNAMEs and its default-HTTPS state now
    // (the relay's ACM sweep handles the customer-side certificate). A
    // normal destroy already cleared these; this is the force-complete /
    // relay-offline backstop.
    const leftoverDefaultHttps = parseDefaultHttps(deployment.defaultHttps);
    if (leftoverDefaultHttps) {
      await db
        .update(schema.deployments)
        .set({ defaultHttps: null })
        .where(eq(schema.deployments.id, deployment.id));
      try {
        await defaultHttpsDeps.dns.deleteDefaultDeploymentRecord(deployment.id);
      } catch (error) {
        request.log.warn({ err: error }, 'default-https record cleanup on purge failed');
      }
      if (leftoverDefaultHttps.validationName) {
        try {
          await defaultHttpsDeps.dns.deleteDefaultValidationRecord(
            deployment.id,
            leftoverDefaultHttps.validationName,
          );
        } catch (error) {
          request.log.warn({ err: error }, 'default-https record cleanup on purge failed');
        }
      }
    }

    // Phase 11: every purge pass also reconciles ORPHANED default records —
    // a best-effort teardown delete that failed earlier (destroy, force-
    // complete, the relay-result safety net) left a routing CNAME whose
    // deployment row is gone. The sweep lists the zone's d-* CNAMEs, keeps any
    // a live deployment still owns, and deletes the rest (reserved/unparseable
    // names are structurally skipped by the parse guard). Bounded by the
    // client's pagination and failure is state-only — a failure here never
    // fails the purge request itself; the next purge retries the sweep.
    try {
      await reconcileOrphanedDefaultRecords(db, defaultHttpsDeps.dns, {
        zone: defaultHttpsDeps.apex,
        prefix: env.defaultHostnamePrefix,
      });
    } catch (error) {
      request.log.warn({ err: error }, 'default-https orphan reconciliation on purge failed');
    }
    return reply.code(created ? 202 : 200).send({ jobId: job.id, state: job.state });
  });

  // A fresh first-install attempt (customer retry, deploy-link retry, reset of
  // a never-installed deployment) replaces the relay credential, so the
  // certificate requested for the previous attempt belongs to a relay that no
  // longer polls. Drop that default-HTTPS state, cancel its unfinished domain jobs (a
  // RUNNING one belongs to the revoked relay and can never report) and remove
  // its control-plane DNS records; the next attempt requests a new
  // certificate. The old certificate is unused and stays in the customer's
  // account, tagged for a later purge.
  async function dropDefaultHttpsForFreshAttempt(deployment: DeploymentRow): Promise<void> {
    const previous = parseDefaultHttps(deployment.defaultHttps);
    if (!previous) return;
    await db
      .update(schema.deployments)
      .set({ defaultHttps: null })
      .where(eq(schema.deployments.id, deployment.id));
    await db
      .update(schema.deploymentJobs)
      .set({ state: 'CANCELLED', finishedAt: new Date() })
      .where(
        and(
          eq(schema.deploymentJobs.deploymentId, deployment.id),
          inArray(schema.deploymentJobs.type, ['CONFIGURE_DOMAIN', 'REMOVE_DOMAIN']),
          like(schema.deploymentJobs.idempotencyKey, `${deployment.id}:%:default-https:%`),
          inArray(schema.deploymentJobs.state, ['REQUESTED', 'QUEUED', 'WAITING', 'RUNNING']),
        ),
      );
    try {
      await defaultHttpsDeps.dns.deleteDefaultDeploymentRecord(deployment.id);
      if (previous.validationName) {
        await defaultHttpsDeps.dns.deleteDefaultValidationRecord(deployment.id, previous.validationName);
      }
    } catch (error) {
      // Purge reconciliation removes any record this misses.
      console.error(JSON.stringify({ event: 'default-https:fresh-attempt-record-cleanup-failed', error: String(error) }));
    }
  }

  // §14 re-enrollment, for an already-loaded, already-owned deployment.
  // Shared by the vendor relay/reset route and the admin recovery action.
  //
  // The recovery path for a lost credential, a rebuilt bootstrap stack, or a
  // rejected enrollment. Without it a 409 from /api/relay/register would be
  // unrecoverable: the binding is single-use by design, so something has to
  // be able to clear it, and that something is a deliberate vendor action.
  //
  // A reset is also a fresh install attempt when nothing was ever installed:
  // the attempt number bumps (so the next Quick Create link prefills a
  // stack name no ROLLBACK_COMPLETE remnant can block), leftover in-flight
  // INSTALL jobs from the dead attempt are cancelled (they would otherwise
  // be failed by the watchdog and drag the reset deployment back to
  // FAILED), and the deployment returns to NOT_INSTALLED so the dashboard
  // offers the install link again. A deployment that was ever healthy keeps
  // its state — its reset only rotates the credential.
  async function performRelayReset(
    deployment: DeploymentRow,
    actorId: string | null,
  ): Promise<{ installLinkId: string | null; attemptNumber: number }> {
    const enrollmentCode = mintEnrollmentCode();
    const relayCredential = mintRelayCredential();
    const [application] = await db
      .select({ name: schema.applications.name })
      .from(schema.applications)
      .where(eq(schema.applications.id, deployment.applicationId))
      .limit(1);
    const neverInstalled = !(await hasSucceededInstall(db, deployment.id));
    const nextAttempt = deployment.attemptNumber + 1;
    const stackName = bootstrapStackName({
      appName: application?.name ?? '',
      deploymentId: deployment.id,
      attempt: nextAttempt,
    });

    await db.transaction(async (tx) => {
      if (neverInstalled) {
        await tx
          .update(schema.deploymentJobs)
          .set({ state: 'CANCELLED', finishedAt: new Date() })
          .where(
            and(
              eq(schema.deploymentJobs.deploymentId, deployment.id),
              eq(schema.deploymentJobs.type, 'INSTALL'),
              inArray(schema.deploymentJobs.state, ['REQUESTED', 'QUEUED', 'RUNNING', 'WAITING']),
            ),
          );
      }
      await tx
        .update(schema.deployments)
        .set({
          enrollmentCode,
          enrollmentUsedAt: null,
          installationId: null,
          // Phase 5 §9.6: the identifiers this reset replaces stay recorded so
          // a later purge can still find the PREVIOUS stack's retained
          // resources — re-enrollment must not silently orphan them.
          ...(deployment.installationId
            ? { previousInstallationId: deployment.installationId }
            : {}),
          ...(deployment.bootstrapStackName
            ? { previousBootstrapStackName: deployment.bootstrapStackName }
            : {}),
          // DZ-AUDIT-013: fresh credential on every reset.
          relayCredential,
          relayTokenHash: hashRelayToken(relayCredential),
          relayBoundAt: null,
          relayStatus: 'UNKNOWN',
          attemptNumber: nextAttempt,
          bootstrapStackName: neverInstalled ? stackName : deployment.bootstrapStackName,
          installStartedAt: null,
          updatedBy: actorId,
          ...(neverInstalled ? { state: 'NOT_INSTALLED' as const } : {}),
        })
        .where(eq(schema.deployments.id, deployment.id));
      await recordEvent(tx, {
        organizationId: deployment.organizationId,
        eventType: 'relay.reenrollment.requested',
        actorType: 'user',
        actorId: actorId ?? 'system',
        deploymentId: deployment.id,
        customerId: deployment.customerId,
        previousState: deployment.state,
        requestedState: neverInstalled ? 'NOT_INSTALLED' : deployment.state,
        payload: {
          attempt: nextAttempt,
          bootstrapStackName: neverInstalled ? stackName : null,
          ...(deployment.installationId
            ? { previousInstallationId: deployment.installationId }
            : {}),
          ...(deployment.bootstrapStackName
            ? { previousBootstrapStackName: deployment.bootstrapStackName }
            : {}),
        },
      });
    });

    if (neverInstalled) await dropDefaultHttpsForFreshAttempt(deployment);

    return { installLinkId: deployment.installLinkId, attemptNumber: nextAttempt };
  }

  // POST /api/deployments/:id/relay/reset — §14 re-enrollment.
  app.post('/api/deployments/:id/relay/reset', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const organizationId = requireSessionOrganizationId(request);
    const deployment = await loadOwnedDeployment(db, id, organizationId);
    const result = await performRelayReset(deployment, request.user?.id ?? null);
    return { installLinkId: result.installLinkId };
  });

  // Recovery for a failed FIRST install, for an already-loaded,
  // already-owned deployment. Shared by the vendor retry-install route and
  // the admin recovery action.
  //
  // A terminal-failed application stack (ROLLBACK_COMPLETE, DELETE_FAILED…)
  // cannot be updated, and its retained RDS/S3 resources block manual
  // deletion — without this route a failed first install bricks the
  // deployment until someone cleans the AWS account by hand. The retry
  // queues a fresh INSTALL job whose payload tells the relay this
  // deployment never installed successfully, authorizing it to delete the
  // failed stack and its orphaned blockers before recreating (recovery runs
  // inside the command; one vendor action, no separate cleanup step).
  //
  // The idempotent-replay path (a double-click on a live retry) returns the
  // existing job rather than creating one; callers must map that
  // discriminated result to a 200, and the created-a-new-job path to
  // 202/200 exactly as createOrReuseJob reports.
  async function performRetryInstall(
    deployment: DeploymentRow,
    actorId: string | null,
  ): Promise<
    | { replayed: true; job: DeploymentJobRow }
    | { replayed: false; created: boolean; job: DeploymentJobRow }
  > {
    const installJobs = await db
      .select()
      .from(schema.deploymentJobs)
      .where(
        and(
          eq(schema.deploymentJobs.deploymentId, deployment.id),
          eq(schema.deploymentJobs.type, 'INSTALL'),
        ),
      );
    if (installJobs.some((j) => j.state === 'SUCCEEDED' || j.state === 'SUCCESS')) {
      // A deployment that was ever healthy must never receive destructive
      // recovery — its retained database may hold customer data. A later
      // failure belongs to deploy/rollback, not to first-install retry.
      throw new ApiError(
        409,
        'INSTALL_ALREADY_SUCCEEDED',
        'This deployment installed successfully before; use Deploy or Rollback instead.',
      );
    }

    const inFlight = installJobs.find((j) =>
      ['REQUESTED', 'QUEUED', 'RUNNING', 'WAITING'].includes(j.state),
    );
    const retryKeyPrefix = `${deployment.id}:INSTALL:RETRY`;
    const inFlightIsFresh =
      inFlight !== undefined &&
      (inFlight.startedAt ?? inFlight.createdAt).getTime() > Date.now() - INSTALL_JOB_STALE_AFTER_MS;

    if (inFlight !== undefined && inFlightIsFresh) {
      // A double-click on a live retry is an idempotent replay, not a new
      // attempt — return the queued job rather than a 409.
      if (inFlight.idempotencyKey.startsWith(retryKeyPrefix)) {
        return { replayed: true, job: inFlight };
      }
      throw new ApiError(
        409,
        'INSTALL_NOT_RETRYABLE',
        'The current install attempt is still in progress.',
      );
    }

    const retryable = deployment.state === 'FAILED' || inFlight !== undefined;
    if (!retryable) {
      throw new ApiError(
        409,
        'INSTALL_NOT_RETRYABLE',
        `Deployment is ${deployment.state}, not retryable.`,
      );
    }

    if (!deployment.installationId) {
      throw new ApiError(
        409,
        'RELAY_NOT_CONNECTED',
        'No relay is connected to this deployment. Reconnect it before retrying the install.',
      );
    }

    // A bound-but-disconnected relay never picks the retry job up, and the
    // watchdog would fail it an hour later — re-failing the deployment the
    // vendor just tried to save. The fix for a dead relay is re-enrollment
    // (relay/reset: fresh code + attempt + stack name), not another install
    // job; refuse so the UI points there instead.
    if (deployment.relayStatus === 'DISCONNECTED') {
      throw new ApiError(
        409,
        'RELAY_DISCONNECTED',
        'The relay for this deployment is disconnected. Reconnect it before retrying the install.',
      );
    }

    // Same Phase 3/5 gate the register route runs before minting an INSTALL
    // — without it, a deployment whose stored manifest is missing/invalid
    // fails inside buildInstallPayload with a bare 422 and no guidance.
    requirePreflightReady(await runDeploymentPreflight(db, deployment, null));

    // Superseded stale attempt (a dead relay invocation's RUNNING job, or a
    // queued job the FAILED state outran) is closed BEFORE the new insert —
    // the one-active-job index refuses a second active INSTALL otherwise.
    if (inFlight) {
      await db
        .update(schema.deploymentJobs)
        .set({ state: 'CANCELLED', finishedAt: new Date() })
        .where(eq(schema.deploymentJobs.id, inFlight.id));
    }

    // Attempt-scoped key: the original `${deployment.id}:INSTALL` row is
    // FAILED and createOrReuseJob would keep returning it. Counting prior
    // attempts keeps the key deterministic, so a double-click reuses the
    // same retry job instead of queuing a second one.
    const idempotencyKey = `${deployment.id}:INSTALL:RETRY:${installJobs.length}`;
    const { job, created } = await createOrReuseJob(db, {
      deploymentId: deployment.id,
      type: 'INSTALL',
      idempotencyKey,
      payload: {
        recovery: { neverInstalled: true },
        ...(await buildInstallPayload(db, deployment, configStore, deployment.installationId)),
      },
      requestedBy: actorId,
    });

    if (created) {
      await db.transaction(async (tx) => {
        await tx
          .update(schema.deployments)
          .set({ state: 'INSTALLING', updatedBy: actorId })
          .where(eq(schema.deployments.id, deployment.id));
        await recordEvent(tx, {
          organizationId: deployment.organizationId,
          eventType: 'install.retry.requested',
          actorType: 'user',
          actorId: actorId ?? 'system',
          deploymentId: deployment.id,
          customerId: deployment.customerId,
          jobId: job.id,
          previousState: deployment.state,
          requestedState: 'INSTALLING',
          result: 'pending',
          payload: { supersededJobId: inFlight?.id ?? null },
        });
      });
    }

    if (created && deployment.installationId && deployment.awsAccountId) {
      // Phase 1.1: a fresh install attempt re-grants pull access. Idempotent —
      // a replay or an already-granted installation is a no-op policy write.
      await grantPullToCustomer(
        ecrGrantDeps,
        deployment.installationId,
        deployment.awsAccountId,
      );
    }

    return { replayed: false, created, job };
  }

  // POST /api/deployments/:id/retry-install — recovery for a failed FIRST
  // install.
  app.post('/api/deployments/:id/retry-install', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const organizationId = requireSessionOrganizationId(request);
    const deployment = await loadOwnedDeployment(db, id, organizationId);
    const result = await performRetryInstall(deployment, request.user?.id ?? null);
    if (result.replayed) {
      return reply.code(200).send({ jobId: result.job.id, state: result.job.state });
    }
    return reply.code(result.created ? 202 : 200).send({ jobId: result.job.id, state: result.job.state });
  });

  // ── Custom domain (custom-domains MVP) ────────────────────────────────
  app.post('/api/deployments/:id/domain', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    requireUuidId(id);
    const organizationId = requireSessionOrganizationId(request);
    const actor = requireActor(request);
    const deployment = await loadOwnedDeployment(db, id, organizationId);
    const body = addDomainBodySchema.parse(request.body);
    const domain = await createCustomDomain(db, deployment, body.hostname, actor.id);
    return reply.code(201).send({ domain: toDomainView(domain) });
  });

  app.get('/api/deployments/:id/domain', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    requireUuidId(id);
    const organizationId = requireSessionOrganizationId(request);
    const deployment = await loadOwnedDeployment(db, id, organizationId);
    const domain = await findActiveDomain(db, deployment.id);
    return { domain: domain ? toDomainView(domain) : null };
  });

  app.post('/api/deployments/:id/domain/check', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    requireUuidId(id);
    const organizationId = requireSessionOrganizationId(request);
    const deployment = await loadOwnedDeployment(db, id, organizationId);
    const domain = await findActiveDomain(db, deployment.id);
    if (!domain) throw new NotFoundError('Custom domain not found');
    const fresh = await runDomainCheck(db, deployment, domain, domainCheckDeps);
    return { domain: toDomainView(fresh) };
  });

  app.delete('/api/deployments/:id/domain', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    requireUuidId(id);
    const organizationId = requireSessionOrganizationId(request);
    const deployment = await loadOwnedDeployment(db, id, organizationId);
    const domain = await findActiveDomain(db, deployment.id);
    if (!domain) throw new NotFoundError('Custom domain not found');
    const fresh = await removeCustomDomain(db, deployment, domain);
    return { domain: toDomainView(fresh) };
  });

  // Customer-facing "Check now" — link-scoped like GET /api/install/:installLinkId.
  // Read-only trigger; runDomainCheck's own interval floor plus the IP-keyed
  // rate limit above are the two guards against hammering it.
  app.post(
    '/api/install/:installLinkId/domain/check',
    { config: { rateLimit: PUBLIC_INSTALL_RATE_LIMIT } },
    async (request) => {
      const { installLinkId } = request.params as { installLinkId: string };
      requireUuidId(installLinkId);
      const rows = await db
        .select()
        .from(schema.deployments)
        .where(eq(schema.deployments.installLinkId, installLinkId))
        .limit(1);
      const deployment = rows[0];
      if (!deployment) throw new NotFoundError('Installation not found');
      const domain = await findActiveDomain(db, deployment.id);
      if (!domain) throw new NotFoundError('Custom domain not found');
      const fresh = await runDomainCheck(db, deployment, domain, domainCheckDeps);
      return { domain: toDomainView(fresh) };
    },
  );

  // POST /api/deployments/:id/default-https/retry — DZ-AUDIT-008: vendor
  // reset for a default-HTTPS machine stuck in ERROR. Resets the machine
  // to PENDING with a fresh budget and kicks off the driver immediately.
  app.post('/api/deployments/:id/default-https/retry', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    requireUuidId(id);
    const organizationId = requireSessionOrganizationId(request);
    const deployment = await loadOwnedDeployment(db, id, organizationId);
    const parsed = parseDefaultHttps(deployment.defaultHttps);
    if (!parsed || parsed.status !== 'ERROR') {
      throw new ApiError(409, 'NOT_IN_ERROR', 'Default HTTPS is not in an error state.');
    }
    const reset: DefaultHttpsState = {
      ...parsed,
      status: 'PENDING',
      configureAttempts: 0,
      lastError: null,
    };
    await db
      .update(schema.deployments)
      .set({ defaultHttps: reset as unknown as Record<string, unknown> })
      .where(eq(schema.deployments.id, deployment.id));
    // Kick the driver so the machine starts moving immediately, not just
    // on the next heartbeat cadence.
    await runDefaultHttpsCheck(db, deployment, defaultHttpsDeps);
    return { status: 'retrying' };
  });

  // ── Events & diagnostics (§24, §29, §40) ────────────────────────────────

  // GET /api/deployments/:id/events — Event log
  app.get('/api/deployments/:id/events', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const organizationId = requireSessionOrganizationId(request);
    await loadOwnedDeployment(db, id, organizationId);
    const { limit, offset } = request.query as { limit?: string; offset?: string };
    const take = Math.min(Number(limit ?? 50), 200);
    const skip = Number(offset ?? 0);
    // The newest events, returned oldest first: a long-lived deployment has
    // more than one page, and its latest activity must be on the first one.
    const rows = await db
      .select()
      .from(schema.eventLogs)
      .where(eq(schema.eventLogs.deploymentId, id))
      .orderBy(desc(schema.eventLogs.occurredAt), desc(schema.eventLogs.id))
      .limit(take)
      .offset(skip);
    return { events: rows.reverse() };
  });

  // GET /api/deployments/:id/stack-events — vendor CloudFormation diagnostics
  app.get('/api/deployments/:id/stack-events', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const organizationId = requireSessionOrganizationId(request);
    await loadOwnedDeployment(db, id, organizationId);
    const { limit } = request.query as { limit?: string };
    const take = Math.min(Number(limit ?? 100), 200);
    const rows = await db
      .select()
      .from(schema.deploymentStackEvents)
      .where(eq(schema.deploymentStackEvents.deploymentId, id))
      .orderBy(desc(schema.deploymentStackEvents.eventAt), desc(schema.deploymentStackEvents.id))
      .limit(take);
    const events: VendorStackEvent[] = rows.map((row) => ({
      id: row.id,
      eventAt: row.eventAt.toISOString(),
      logicalResourceId: row.logicalResourceId,
      resourceType: row.resourceType,
      resourceStatus: row.resourceStatus,
      resourceStatusReason: row.resourceStatusReason,
    }));
    return { events };
  });

  // GET /api/deployments/:id/preflight — the gate a not-yet-provisioned
  // deployment must pass, against this customer's configuration (Phase 5).
  app.get('/api/deployments/:id/preflight', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const organizationId = requireSessionOrganizationId(request);
    const deployment = await loadOwnedDeployment(db, id, organizationId);
    const application = await loadOwnedApplication(db, deployment.applicationId, organizationId);
    return runDeploymentPreflight(db, deployment, application);
  });

  // GET /api/deployments/:id/plan?action=install|update|destroy — the
  // deterministic plan for one action on this deployment (Phase 4).
  // install/destroy read the deployment's frozen manifest; update compares
  // it against the application's current effective manifest and reports any
  // difference as requirementDrift — the MVP architecture never changes an
  // existing deployment's topology in place.
  app.get('/api/deployments/:id/plan', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const organizationId = requireSessionOrganizationId(request);
    const deployment = await loadOwnedDeployment(db, id, organizationId);
    const { action } = request.query as { action?: string };
    const manifest = readStoredManifest(deployment.desiredState);
    if (!manifest) {
      throw new ApiError(
        422,
        'MANIFEST_NEEDS_CONFIGURATION',
        'Deployment has no valid deployment manifest. Run analysis or correct the application configuration first.',
      );
    }
    const profile = resolveStoredInfrastructureSizeProfile(deployment.desiredState);
    const spec = readStoredDeploymentSpec(deployment.specV2);
    const compiledFootprint = spec?.footprint ?? undefined;
    if (action === 'install') {
      const plan = buildInstallPlan({
        manifest,
        region: deployment.region,
        ...(profile ? { profile } : {}),
        ...(compiledFootprint ? { compiledFootprint } : {}),
      });
      // A frozen spec upgrades the components to spec-derived identity — same
      // names/actions/lifecycles for the catalog kinds, plus componentId/group.
      return deploymentPlanSchema.parse(
        spec ? { ...plan, components: planComponentsFromSpec(spec, 'install', false) } : plan,
      );
    }
    if (action === 'destroy') {
      const plan = buildDestroyPlan({
        manifest,
        region: deployment.region,
        ...(profile ? { profile } : {}),
        ...(compiledFootprint ? { compiledFootprint } : {}),
      });
      return deploymentPlanSchema.parse(
        spec ? { ...plan, components: planComponentsFromSpec(spec, 'destroy', false) } : plan,
      );
    }
    if (action === 'update') {
      const application = await loadOwnedApplication(db, deployment.applicationId, organizationId);
      const { manifest: desiredManifest } = await runApplicationPreflight(db, application, null);
      const newRelease = await newerReadyReleaseExists(db, deployment.applicationId, deployment.currentReleaseId);
      const updatePlan = buildUpdatePlan({
        deployedManifest: manifest,
        desiredManifest,
        region: deployment.region,
        newRelease,
        ...(profile ? { profile } : {}),
        ...(compiledFootprint ? { compiledFootprint } : {}),
      });
      const plan = {
        ...updatePlan,
        requirementDrift: [
          ...updatePlan.requirementDrift,
          ...topologyDriftFor(
            spec?.graph ?? manifestToApplicationGraph(manifest),
            manifestToApplicationGraph(desiredManifest),
          ),
        ],
      };
      // Release-vs-infrastructure gate (phase 3): requirement drift means the
      // release needs topology changes the MVP cannot apply in place — fail
      // closed regardless of feasibility. requirementDrift stays in the
      // response unchanged.
      const infrastructureChange: InfrastructureChange = plan.requirementDrift.length
        ? { status: 'unsupported', reason: 'topology_changed' }
        : { status: 'none' };
      return deploymentPlanSchema.parse({
        ...plan,
        ...(spec ? { components: planComponentsFromSpec(spec, 'update', newRelease) } : {}),
        infrastructureChange,
      });
    }
    throw new ApiError(400, 'INVALID_REQUEST', 'action must be "install", "update", or "destroy".');
  });

  // GET /api/deployments/:id/diagnostics — Diagnostics (§29)
  app.get('/api/deployments/:id/diagnostics', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const organizationId = requireSessionOrganizationId(request);
    const deployment = await loadOwnedDeployment(db, id, organizationId);
    // A failed day-2 operation no longer marks the deployment itself FAILED
    // (the previous release keeps serving), but its diagnostics must stay
    // reachable — gate on "the most recent mutating attempt failed", with
    // the deployment state as the legacy fast path.
    const [latestMutating] = await db
      .select({ state: schema.deploymentJobs.state })
      .from(schema.deploymentJobs)
      .where(
        and(
          eq(schema.deploymentJobs.deploymentId, id),
          inArray(schema.deploymentJobs.type, [
            'INSTALL',
            'DEPLOY_RELEASE',
            'ROLLBACK',
            'RESTART',
            'CONFIG_UPDATE',
            'DESTROY',
            'PURGE',
          ]),
        ),
      )
      .orderBy(desc(schema.deploymentJobs.createdAt))
      .limit(1);
    if (deployment.state !== 'FAILED' && latestMutating?.state !== 'FAILED') {
      return {
        failureCode: null,
        recoverability: null,
        what: null,
        why: null,
        fix: null,
        evidence: null,
        retryEligibility: null,
        events: [],
      };
    }
    const events = await db
      .select()
      .from(schema.eventLogs)
      .where(eq(schema.eventLogs.deploymentId, id))
      .orderBy(schema.eventLogs.occurredAt)
      .limit(10);
    // §61: report the code the relay actually gave for the failure. Falling
    // back to UNKNOWN when the job carried no code is honest; hardcoding it
    // when the job DOES carry one throws away the only classification we have.
    let [failedJob] = await db
      .select({
        id: schema.deploymentJobs.id,
        type: schema.deploymentJobs.type,
        failureCode: schema.deploymentJobs.failureCode,
        result: schema.deploymentJobs.result,
        payload: schema.deploymentJobs.payload,
        finishedAt: schema.deploymentJobs.finishedAt,
      })
      .from(schema.deploymentJobs)
      .where(and(eq(schema.deploymentJobs.deploymentId, id), eq(schema.deploymentJobs.state, 'FAILED')))
      .orderBy(desc(schema.deploymentJobs.finishedAt))
      .limit(1);
    // An install that never verified is failed by the control plane, not by
    // a job: the record sits on the settled job the window was measured from
    // and wins over any older failed job.
    const [settledJob] = await db
      .select({
        id: schema.deploymentJobs.id,
        type: schema.deploymentJobs.type,
        result: schema.deploymentJobs.result,
        finishedAt: schema.deploymentJobs.finishedAt,
      })
      .from(schema.deploymentJobs)
      .where(and(eq(schema.deploymentJobs.deploymentId, id), eq(schema.deploymentJobs.state, 'SUCCEEDED')))
      .orderBy(desc(schema.deploymentJobs.finishedAt))
      .limit(1);
    const unverifiedRecord = deployment.state === 'FAILED' ? readInstallVerification(settledJob?.result) : null;
    if (
      settledJob &&
      unverifiedRecord !== null &&
      (!failedJob || (failedJob.finishedAt?.getTime() ?? 0) < (settledJob.finishedAt?.getTime() ?? 0))
    ) {
      failedJob = {
        id: settledJob.id,
        type: settledJob.type,
        failureCode: unverifiedRecord.failureCode,
        result: null,
        payload: {},
        finishedAt: settledJob.finishedAt,
      };
    }
    // Phase 6: the one bounded, sanitised failure representation — built
    // from the failed job and the CloudFormation events persisted for it.
    const failureContext = failedJob
      ? buildFailureContext({
          deploymentId: id,
          job: { type: failedJob.type, failureCode: failedJob.failureCode, result: failedJob.result },
          attempt: deployment.attemptNumber,
          // Component identity for the blamed resource, from the frozen spec
          // when it has one — absent, never guessed.
          componentIdentityByLogicalId: specComponentIdentityByLogicalId(deployment.specV2),
          stackEvents: await db
            .select({
              logicalResourceId: schema.deploymentStackEvents.logicalResourceId,
              resourceType: schema.deploymentStackEvents.resourceType,
              resourceStatus: schema.deploymentStackEvents.resourceStatus,
              resourceStatusReason: schema.deploymentStackEvents.resourceStatusReason,
            })
            .from(schema.deploymentStackEvents)
            .where(and(eq(schema.deploymentStackEvents.deploymentId, id), eq(schema.deploymentStackEvents.jobId, failedJob.id)))
            .orderBy(schema.deploymentStackEvents.eventAt),
          // A deploy/rollback payload names the version it targeted.
          applicationVersion:
            typeof (failedJob.payload as { version?: unknown } | null)?.version === 'string'
              ? ((failedJob.payload as { version: string }).version)
              : null,
        })
      : null;
    // §29/§61: the remediation is looked up from the code the relay actually
    // reported. These three fields used to be string literals, identical for
    // every failure, and the fix line told the vendor to read an event log
    // that was never written and had no screen.
    const failureCode = failedJob?.failureCode ?? 'UNKNOWN';
    const remediation = FAILURE_REMEDIATION[failureCode as FailureCode] ?? FAILURE_REMEDIATION.UNKNOWN;
    // What the relay said, verbatim. Stored on the job all along and never
    // surfaced, which left "Technical detail" empty on every failure.
    const jobResult = failedJob?.result as { error?: string } | null;
    // Phase 1: the relay's structured evidence, redacted again on the way
    // out — ingest already sanitised it, but the serve path never trusts
    // the store (same rule technicalDetail follows).
    const contextEvidence = failureContext?.evidence ?? null;

    // §22/§23/§42: a code that names an account or infrastructure cause is
    // unambiguous — the deterministic §65 copy map is the whole answer and AI
    // is never consulted. Only the app-owned evidence-rich set
    // (AI_EXPLAINABLE_FAILURE_CODES — UNKNOWN plus the startup/config
    // failures) is worth a model call, because the bounded §16 evidence can
    // sharpen what/why/fix for a failure that lives in the application.
    let explanation: ExplanationText = { ...remediation, confidence: null };
    if (failedJob && failureContext && AI_EXPLAINABLE_FAILURE_CODES.has(failureCode)) {
      // §16: the AI explanation is built from the deterministic code plus
      // the sanitised failure context only — the relay's error redacted and
      // truncated, the first failed resources, the attempt and the version.
      // Never raw text, never application logs.
      const event: StructuredEvent = toStructuredEvent(failureContext, deployment.state);

      // Generated once per attempt and cached; `remediation` is the fallback
      // for every path where AI is unavailable, so the copy map stays the
      // single source of this copy (§65). Never throws, never touches
      // deployment state.
      explanation = await resolveExplanation(
        { db, gateway: aiGateway },
        { jobId: failedJob.id, failureCode, event },
        { ...remediation, confidence: null },
      );
    }

    // Phase 2: safe-retry eligibility for the deployment + its latest failed
    // job — a manual-retry signal for the card, never an automatic retry.
    // Null when there is no failed job.
    const retryEligibility = failedJob
      ? retryEligibilityFor({
          state: deployment.state,
          relayStatus: deployment.relayStatus,
          installSucceeded: await hasSucceededInstall(db, id),
          failureCode,
        })
      : null;

    return {
      failureCode,
      // §61 recoverability — which affordance the UI should lead with
      // (wait/reconcile, fix-then-retry, contact support, or none).
      recoverability: failureRecoverability(failureCode),
      retryEligibility,
      what: explanation.what,
      why: explanation.why,
      fix: explanation.fix,
      // Phase 7: deterministic copy is authoritative and carries no
      // confidence; AI text names how sure the model was so the card can
      // hedge a medium or low reading instead of presenting it as a verdict.
      source: explanation.confidence === null ? 'deterministic' : 'ai',
      confidence: explanation.confidence,
      // Verbatim in length and wording, but never a secret: the same
      // redaction the context applies, without its truncation.
      technicalDetail: typeof jobResult?.error === 'string' ? redactSecrets(jobResult.error) : null,
      // Phase 1: structured container evidence, redacted on
      // the way out regardless of what ingest did — null when the relay
      // sent none (every relay built before evidence existed).
      evidence:
        contextEvidence === null
          ? null
          : {
              container:
                contextEvidence.container === null
                  ? null
                  : {
                      ...contextEvidence.container,
                      stoppedReason:
                        contextEvidence.container.stoppedReason !== null
                          ? redactSecrets(contextEvidence.container.stoppedReason)
                          : null,
                    },
            },
      // Phase 6: the normalised context — phase, codes, blamed resource, the
      // failed events — for the card's technical layer.
      context: failureContext,
      events,
    };
  });

  // GET /api/deployments/:id/infrastructure — composed infrastructure
  // inventory (§59). Reads ONLY the persisted relay snapshot — the relay is
  // the single pipeline that observes AWS, so this route never calls it. A
  // stale or absent snapshot keeps the last-known rows; the connection
  // warning, not the statuses, surfaces the relay gap.
  app.get(
    '/api/deployments/:id/infrastructure',
    { preHandler: requireAuth },
    async (request) => {
      const { id } = request.params as { id: string };
      const organizationId = requireSessionOrganizationId(request);
      const deployment = await loadOwnedDeployment(db, id, organizationId);

      const resources = await db
        .select()
        .from(schema.deploymentResources)
        .where(eq(schema.deploymentResources.deploymentId, id))
        .orderBy(
          schema.deploymentResources.componentKind,
          schema.deploymentResources.logicalResourceId,
        );

      const now = Date.now();
      const lastHealthAt = deployment.lastHealthAt;
      const connected =
        deployment.relayStatus === 'CONNECTED' &&
        lastHealthAt !== null &&
        now - lastHealthAt.getTime() <= RELAY_STALE_AFTER_MS;

      let maxUpdatedAt: Date | null = null;
      for (const row of resources) {
        if (maxUpdatedAt === null || row.lastUpdatedAt.getTime() > maxUpdatedAt.getTime()) {
          maxUpdatedAt = row.lastUpdatedAt;
        }
      }
      const lastUpdatedAt = maxUpdatedAt;

      const snapshotState =
        resources.length === 0
          ? 'none'
          : lastUpdatedAt !== null && now - lastUpdatedAt.getTime() <= RELAY_STALE_AFTER_MS
            ? 'fresh'
            : 'stale';

      const observed = deployment.observedState as
        | { infraHealth?: { provisioning?: { stackStatus?: unknown } } }
        | null
        | undefined;
      const rawStackStatus = observed?.infraHealth?.provisioning?.stackStatus;

      const aggregate = aggregateInfrastructureComponents(
        resources.map((row) => ({
          ...row,
          // resource_status is text in the table; the persistence helper
          // only ever writes mapped values (mapResourceStatus in contracts).
          resourceStatus: row.resourceStatus as InfrastructureComponentStatus,
        })),
        { deploymentState: deployment.state, region: deployment.region },
      );

      // The secure endpoint is READY only when HTTPS actually serves: the
      // load balancer's CREATE_COMPLETE says nothing about the certificate,
      // so the endpoint component is overlaid with the default-HTTPS /
      // custom-domain machine state (the same source the deployment hero
      // reads) whenever its CloudFormation rows are complete.
      const domain = await findActiveDomain(db, id);
      const defaultHttps = parseDefaultHttps(deployment.defaultHttps);
      // A configured first start (DEPLOY-009) creates the service with zero
      // tasks: its CloudFormation rows complete before any task has run, so
      // the application is not "ready" until a deploy has started it.
      const deploymentSpec = readStoredDeploymentSpec(deployment.specV2);
      // The task definition and roles complete before the services do, so the
      // application is only ready once the public service the spec expects is
      // in the inventory — a worker service alone never stands in for it.
      const primaryServiceMissing =
        deployment.state !== 'DELETED' &&
        primaryServiceLogicalIds(deploymentSpec).some(
          (logicalId) =>
            !resources.some(
              (row) =>
                row.logicalResourceId === logicalId &&
                row.resourceType === 'AWS::ECS::Service' &&
                row.resourceStatus !== 'removed',
            ),
        );
      const applicationNeverStarted =
        deployment.currentReleaseId === null &&
        aggregate.components.some((c) => c.kind === 'application' && c.status === 'ready') &&
        (await awaitsFirstStart(db, id));
      const components = aggregate.components.map((component) => {
        if (primaryServiceMissing && component.kind === 'application' && component.status === 'ready') {
          return {
            ...component,
            status: deployment.state === 'INSTALLING' ? ('provisioning' as const) : ('unknown' as const),
          };
        }
        if (applicationNeverStarted && component.kind === 'application') {
          return { ...component, status: 'pending' as const };
        }
        if (component.kind !== 'endpoint' || component.status !== 'ready' || deployment.state === 'DELETED') {
          return component;
        }
        const httpsState = endpointHttpsState(domain, defaultHttps);
        return {
          ...component,
          status: endpointStatusForHttpsState(httpsState),
          httpsState,
          ...(defaultHttps ? { defaultHttpsStatus: defaultHttps.status } : {}),
        };
      });
      const rollup = summarizeInfrastructureStatus(components);

      // The aggregate rolls up to the component vocabulary ('ready'); the
      // wire summary presents it as 'healthy'.
      const summaryStatus: InfrastructureSummaryStatus =
        rollup === 'ready' ? 'healthy' : (rollup as InfrastructureSummaryStatus);

      const lastUpdatedAtIso = lastUpdatedAt?.toISOString() ?? null;

      // Requirement-aware verification (Phase 6): compare what the frozen
      // spec's verification contract requires against this inventory — a
      // report only, never an auto-repair. Without a spec, the stored
      // manifest's requirement booleans stand in; with neither, there is
      // nothing to compare against.
      const storedManifest = readStoredManifest(deployment.desiredState);
      const expectations = (() => {
        const expectedKinds = deploymentSpec?.verificationContract
          ? [...new Set(deploymentSpec.verificationContract.checks.map((check) => check.componentKind))]
          : storedManifest
            ? requiredInfrastructureComponents({
                postgres: storedManifest.database.postgres,
                redis: storedManifest.redis.required,
              }).map((definition) => definition.kind)
            : null;
        if (expectedKinds === null) return null;
        const comparison = compareInfrastructureExpectations(
          expectedKinds,
          primaryServiceMissing ? components.filter((c) => c.kind !== 'application') : components,
        );
        // A removed component is never "missing" after destroy — once
        // the deployment is DELETED, the simplest honest rule is that
        // nothing is missing.
        return deployment.state === 'DELETED' ? { ...comparison, missing: [] } : comparison;
      })();

      return infrastructureResponseSchema.parse({
        provider: 'aws',
        region: deployment.region,
        stackStatus: typeof rawStackStatus === 'string' ? rawStackStatus : null,
        connectionState: connected ? 'connected' : 'disconnected',
        snapshotState,
        summary: {
          status: summaryStatus,
          componentCount: components.length,
          technicalResourceCount: resources.length,
        },
        components,
        lastUpdatedAt: lastUpdatedAtIso,
        disconnectWarning:
          !connected && snapshotState !== 'none' && lastUpdatedAt !== null
            ? { lastVerifiedAt: lastUpdatedAtIso }
            : null,
        expectations,
      });
    },
  );

  // ── Billing ──────────────────────────────────────────────────────────────

  // GET /api/billing/summary — Billing summary
  app.get('/api/billing/summary', { preHandler: requireAuth }, async (request) => {
    const organizationId = requireSessionOrganizationId(request);
    // Line items are named by CUSTOMER ("Acme Corp  $19"), not by
    // application — join customers for the label. Billability comes from
    // isBillableDeployment (the single billing rule, driven by the
    // deployment's own billing_state, not its live health).
    const deployments = await db
      .select({
        customerName: schema.customers.name,
        applicationName: schema.applications.name,
        deploymentType: schema.deployments.deploymentType,
        billingState: schema.deployments.billingState,
      })
      .from(schema.deployments)
      .innerJoin(schema.applications, eq(schema.deployments.applicationId, schema.applications.id))
      .innerJoin(schema.customers, eq(schema.deployments.customerId, schema.customers.id))
      .where(eq(schema.deployments.organizationId, organizationId));
    const deploymentItems = deployments.filter(isBillableDeployment).map((d) => ({
      name: d.customerName,
      applicationName: d.applicationName,
    }));
    // The allowance is pooled: no single deployment is "the free one", so the
    // lines above carry no amount. The organization is billed for the live
    // production deployments beyond its included allowance, and the total is
    // computed from that quantity — the same formula reconciliation pushes.
    const [organizationRow] = await db
      .select({ included: schema.organization.includedProductionDeployments })
      .from(schema.organization)
      .where(eq(schema.organization.id, organizationId))
      .limit(1);
    const counts = productionDeploymentCounts(deployments, organizationRow?.included ?? 0);
    const total = PLATFORM_PRICE_DOLLARS + counts.billable * DEPLOYMENT_PRICE_DOLLARS;

    const [subscriptionRow] = await db
      .select({
        status: schema.billingSubscriptions.status,
        currentPeriodStart: schema.billingSubscriptions.currentPeriodStart,
        currentPeriodEnd: schema.billingSubscriptions.currentPeriodEnd,
      })
      .from(schema.billingSubscriptions)
      .where(eq(schema.billingSubscriptions.organizationId, organizationId))
      .limit(1);

    return {
      base: PLATFORM_PRICE_DOLLARS,
      deploymentPrice: DEPLOYMENT_PRICE_DOLLARS,
      deployments: deploymentItems,
      productionDeployments: counts,
      total,
      subscription: subscriptionRow
        ? {
            status: subscriptionRow.status,
            currentPeriodStart: subscriptionRow.currentPeriodStart,
            currentPeriodEnd: subscriptionRow.currentPeriodEnd,
          }
        : null,
    };
  });

  // GET /api/billing/config — what apps/web needs to open Paddle.js checkout
  // (Phase 8): the client token, environment and price ids. Never the api key
  // or webhook secret — those never leave the server.
  app.get('/api/billing/config', { preHandler: requireAuth }, async () => {
    if (!paddle) {
      return { enabled: false };
    }
    return {
      enabled: true,
      environment: paddle.config.environment,
      clientToken: paddle.config.clientToken,
      pricePlatform: paddle.config.pricePlatform,
      priceDeployment: paddle.config.priceDeployment,
    };
  });

  // POST /api/billing/checkout — the vendor's first production deployment
  // (Phase 8), or a subscribe-only start (invitation-first flow). Nothing is
  // provisioned here: the request is parked as a checkout intent and answered
  // with the Paddle transaction id apps/web opens with Paddle.js. A parked
  // deployment row appears only when the subscription activates (see
  // onSubscriptionChanged below); a subscribe-only intent creates nothing.
  app.post('/api/billing/checkout', { preHandler: requireAuth }, async (request) => {
    const body = createCheckoutBodySchema.parse(request.body);
    const organizationId = requireSessionOrganizationId(request);
    // Same fail-closed region gate as POST /api/deployments — a checkout must
    // never be sold for a region the deployment could not be created in.
    if (body.region !== undefined && !env.deployableAwsRegions.includes(body.region)) {
      throw new ApiError(
        422,
        'REGION_NOT_SUPPORTED',
        `Region ${body.region} is not available for installation yet.`,
      );
    }
    return createCheckoutIntent(
      { db, paddle },
      {
        organizationId,
        ...(body.applicationId !== undefined ? { applicationId: body.applicationId } : {}),
        ...(body.customerId !== undefined ? { customerId: body.customerId } : {}),
        ...(body.region !== undefined ? { region: body.region } : {}),
        ...(body.sizeProfile !== undefined ? { sizeProfile: body.sizeProfile } : {}),
        createdBy: request.user?.id ?? null,
      },
    );
  });

  // POST /api/billing/portal — mint short-lived, pre-authenticated links into
  // Paddle's hosted customer portal (Phase 12). Card, invoices and cancel all
  // live there, never on a Deployz screen. The links are for the signed-in
  // organization's own Paddle customer; nothing about the session is cached.
  app.post('/api/billing/portal', { preHandler: requireAuth }, async (request) => {
    const organizationId = requireSessionOrganizationId(request);
    return createBillingPortalLinks({ db, paddle }, organizationId);
  });

  // POST /api/billing/webhook — Paddle subscription/transaction events.
  // Signature-verified over the raw body (see the addContentTypeParser
  // carve-out above); ApiErrors (missing/invalid signature, billing
  // disabled) render through the existing error handler as 401/503. A
  // processing failure throws a plain Error so this answers 500 and Paddle
  // retries the same event id.
  app.post('/api/billing/webhook', async (request, reply) => {
    const signatureHeader = request.headers['paddle-signature'];
    const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
    const result = await handlePaddleWebhook(
      {
        db,
        paddle,
        // Phase 8 — the subscription is live, so the production deployment
        // parked on it can now be created. completePendingCheckoutIntent
        // never throws, so a deployment that cannot be created does not make
        // Paddle redeliver an event that was applied correctly.
        onSubscriptionChanged: async ({ organizationId, status, checkoutIntentId }) => {
          if (status !== 'ACTIVE') return;
          const completed = await completePendingCheckoutIntent(
            { db, paddle, materialization: { pendingSecrets, cipher }, templatePublisher },
            organizationId,
            checkoutIntentId,
          );
          if (completed?.status === 'FAILED') {
            request.log.error(
              { organizationId, checkoutIntentId: completed.checkoutIntentId, err: completed.error },
              'checkout intent could not be completed',
            );
          }
          // Phase 9 (transition map row 19): the subscription is live, so
          // push the absolute live-deployment count onto it. Also covers a
          // resumed subscription whose deployments changed while it was
          // paused.
          await reconcileAfterBillingChange(db, paddle, organizationId);
        },
      },
      request.body as string,
      signature,
    );
    return reply.send({ received: true, outcome: result.outcome });
  });

  // ── Onboarding (§42) ────────────────────────────────────────────────────

  // GET /api/onboarding — where the organization stands on the six §42
  // steps. The step KEYS are the wire contract; the labels stay in the copy
  // map (§65) so there is one source of copy, not two.
  //
  // The counts below read row LENGTH, not a `count` alias over a uuid column:
  // the previous shape aliased applications.id as `count` and put it through
  // Number(), which is NaN for a uuid, so every step read as incomplete.
  app.get('/api/onboarding', { preHandler: requireAuth }, async (request) => {
    const organizationId = requireSessionOrganizationId(request);
    const applications = await db
      .select({
        analysisStatus: schema.applications.analysisStatus,
        compatibilityStatus: schema.applications.compatibilityStatus,
      })
      .from(schema.applications)
      .where(eq(schema.applications.organizationId, organizationId));
    const deployments = await db
      .select({ state: schema.deployments.state })
      .from(schema.deployments)
      .where(eq(schema.deployments.organizationId, organizationId));

    const hasApplication = applications.length > 0;
    const analysed = applications.some((row) => row.analysisStatus === 'COMPLETE');
    const compatible = applications.some((row) => row.compatibilityStatus === 'READY');
    const hasDeployment = deployments.length > 0;
    // §5: the success moment is readiness — a deployment that actually runs.
    const ready = compatible && deployments.some((row) => row.state === 'HEALTHY');

    const steps = [
      { step: 'connect_github', completed: hasApplication },
      { step: 'choose_repository', completed: hasApplication },
      { step: 'analyse', completed: analysed },
      { step: 'fix_compatibility', completed: compatible },
      { step: 'create_test_deployment', completed: hasDeployment },
      { step: 'ready_for_customer_deployment', completed: ready },
    ];
    const firstIncomplete = steps.findIndex((step) => !step.completed);
    return { steps, currentStep: firstIncomplete === -1 ? steps.length : firstIncomplete + 1 };
  });

  // Better Auth over Fastify: construct a Fetch Request, call auth.handler,
  // forward status/headers/body. Official recipe from the docs.
  app.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    handler: async (request, reply) => {
      // Resolve against the canonical API origin rather than the request's
      // Host header. Two reasons: API Gateway terminates TLS, so the old
      // hardcoded `http://` handed Better Auth an http origin that failed its
      // own https origin check; and Host is client-controlled, which made this
      // a header-injection surface on the auth endpoint. request.url is a path
      // plus query, so this keeps both and guarantees the origin matches the
      // baseURL Better Auth was configured with.
      const url = new URL(request.url, env.apiUrl);
      const headers = fromNodeHeaders(request.headers);
      const init: RequestInit = {
        method: request.method,
        headers,
        ...(request.body ? { body: JSON.stringify(request.body) } : {}),
      };

      const response = await auth.handler(new Request(url.toString(), init));

      reply.status(response.status);
      // set-cookie must survive as separate header lines (squashing breaks the
      // browser); content-length is recomputed by Fastify.
      response.headers.forEach((value, key) => {
        const lower = key.toLowerCase();
        if (lower !== 'set-cookie' && lower !== 'content-length') {
          reply.header(key, value);
        }
      });
      const setCookies =
        typeof response.headers.getSetCookie === 'function'
          ? response.headers.getSetCookie()
          : [];
      if (setCookies.length > 0) {
        reply.header('set-cookie', setCookies);
      }
      return reply.send(response.body ? await response.text() : null);
    },
  });

  // ── Relay endpoints (bearer-token auth, not session cookie) ─────────
  //
  // The relay authenticates with a bearer token registered at install time
  // (see relay-store.ts). Every route below resolves the calling deployment
  // FROM THE VERIFIED TOKEN, never from a client-supplied id alone — an
  // installationId is public (it's in the install URL), so it cannot be the
  // credential.

  async function requireRelayDeployment(
    installationId: string | undefined,
    token: string,
    oldToken?: string | undefined,
  ): Promise<DeploymentRow> {
    if (!installationId) {
      throw new ApiError(400, 'INSTALLATION_ID_REQUIRED', 'installationId is required');
    }
    const rows = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.installationId, installationId))
      .limit(1);
    const deployment = rows[0];
    if (!deployment || !verifyRelayTokenWithRotation(deployment.relayTokenHash, token, oldToken)) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Invalid relay credentials');
    }
    return deployment;
  }

  /** The rotation grace header the relay sends while adopting a new token. */
  function oldRelayToken(request: { headers: Record<string, unknown> }): string | undefined {
    const value = request.headers['x-deployz-old-token'];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  /** The bearer token the relay presents. */
  function requireBearerToken(request: { headers: Record<string, unknown> }): string {
    const authHeader = request.headers.authorization as string | undefined;
    if (!authHeader?.startsWith('Bearer ')) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Missing bearer token');
    }
    return authHeader.slice(7);
  }

  // ── Runtime digest reconciliation ──────────────────────────────────────
  //
  // The relay reports the sha256 digest actually running in ECS. Reconcile
  // it against releases so a deployment whose pointer drifted (manual AWS
  // change, repaired build, lost update) tells the truth again — but never
  // while a mutating job is in flight, which would make the pointer
  // ambiguous.

  /** Normalizes `repository@sha256:…` and bare `sha256:…` to `sha256:…`. */
  function digestSuffix(imageDigest: string | null): string | null {
    if (!imageDigest) return null;
    const at = imageDigest.lastIndexOf('@');
    return (at >= 0 ? imageDigest.slice(at + 1) : imageDigest).toLowerCase();
  }

  type JobTypeValue = NonNullable<(typeof schema.deploymentJobs.$inferSelect)['type']>;
  type JobStateValue = NonNullable<(typeof schema.deploymentJobs.$inferSelect)['state']>;

  const MUTATING_JOB_TYPES: readonly JobTypeValue[] = [
    'INSTALL',
    'DEPLOY_RELEASE',
    'ROLLBACK',
    'RESTART',
    'CONFIG_UPDATE',
    'DESTROY',
    'MIGRATION',
    'INFRA_UPGRADE',
  ];
  const ACTIVE_JOB_STATES: readonly JobStateValue[] = ['REQUESTED', 'QUEUED', 'WAITING', 'RUNNING'];

  /** The workloads the frozen spec requires; `public` marks the ones the load balancer serves. */
  function expectedWorkloadsFor(deployment: Pick<DeploymentRow, 'specV2'>): ExpectedWorkload[] {
    const spec = readStoredDeploymentSpec(deployment.specV2);
    const services = spec ? workloadServicesFromSpec(spec) : null;
    if (!spec || !services) return [];
    const publicIds = new Set(spec.ir.ingress.public ? spec.ir.ingress.targetWorkloadIds : []);
    return services.map((service) => ({
      id: service.id,
      serviceLogicalId: service.serviceLogicalId,
      public: publicIds.has(service.id),
    }));
  }

  /**
   * §10.3 the promotion gate's observational half: whether ONE heartbeat's
   * `releaseEvidence` proves every required workload runs one image digest at
   * full capacity with healthy targets and a successful public probe. Only
   * that heartbeat counts — never the stored observedState — and evidence
   * older than the newest already accepted for the deployment is rejected, so
   * a late heartbeat cannot move the release pointer back.
   */
  function assessReleaseEvidence(
    deployment: Pick<DeploymentRow, 'specV2' | 'currentReleaseConfirmedAt'>,
    rawEvidence: unknown,
  ): { accepted: boolean; digest: string | null; observedAt: Date | null; reason: string | null; notStarted: boolean } {
    const expected = expectedWorkloadsFor(deployment);
    const verdict = evaluateReleaseEvidence(rawEvidence, expected, new Date());
    const parsed = releaseEvidenceSchema.safeParse(rawEvidence);
    const observedAt = parsed.success ? new Date(parsed.data.observedAt) : null;
    const notStarted =
      parsed.success &&
      !verdict.pass &&
      verdict.reason !== 'EVIDENCE_STALE' &&
      expected.length > 0 &&
      expected.every((workload) =>
        parsed.data.services.some(
          (service) =>
            service.workloadId === workload.id &&
            service.serviceLogicalId === workload.serviceLogicalId &&
            service.observed &&
            service.desiredCount === 0,
        ),
      );
    const outOfOrder =
      observedAt !== null &&
      deployment.currentReleaseConfirmedAt !== null &&
      observedAt < deployment.currentReleaseConfirmedAt;
    if (verdict.pass && outOfOrder) {
      return { accepted: false, digest: null, observedAt, reason: 'EVIDENCE_OUT_OF_ORDER', notStarted: false };
    }
    return verdict.pass
      ? { accepted: true, digest: verdict.digest, observedAt, reason: null, notStarted: false }
      : { accepted: false, digest: null, observedAt, reason: verdict.reason, notStarted };
  }

  /**
   * Bounded install verification (docs/deployment-resilience.md): an installed
   * deployment that outlives its verification window with the application
   * still failing release evidence becomes FAILED, classified by the verdict
   * reason. The deployment row is locked so the check and the transition are
   * one step: a job created meanwhile, or a second heartbeat, cannot repeat it.
   */
  async function failUnverifiedInstall(
    deployment: DeploymentRow,
    evidence: { accepted: boolean; reason: string | null; notStarted: boolean },
    rawEvidence: unknown,
  ): Promise<void> {
    await db.transaction(async (tx) => {
      const [locked] = await tx
        .select({ state: schema.deployments.state })
        .from(schema.deployments)
        .where(eq(schema.deployments.id, deployment.id))
        .for('update');
      if (locked?.state !== 'INSTALLING') return;
      const jobs = await tx
        .select({
          id: schema.deploymentJobs.id,
          type: schema.deploymentJobs.type,
          state: schema.deploymentJobs.state,
          createdAt: schema.deploymentJobs.createdAt,
          finishedAt: schema.deploymentJobs.finishedAt,
          result: schema.deploymentJobs.result,
        })
        .from(schema.deploymentJobs)
        .where(eq(schema.deploymentJobs.deploymentId, deployment.id));
      const unverified = unverifiedInstall({
        jobs,
        verdict: { pass: evidence.accepted, reason: evidence.reason, notStarted: evidence.notStarted },
        now: new Date(),
      });
      if (unverified === null) return;

      const anchor = jobs.find((job) => job.id === unverified.anchorJobId);
      await tx
        .update(schema.deploymentJobs)
        .set({
          result: {
            ...(anchor?.result ?? {}),
            installVerification: { failureCode: unverified.failureCode, reason: unverified.reason },
          },
        })
        .where(eq(schema.deploymentJobs.id, unverified.anchorJobId));
      await tx
        .update(schema.deployments)
        .set({ state: 'FAILED' })
        .where(eq(schema.deployments.id, deployment.id));
      const parsed = releaseEvidenceSchema.safeParse(rawEvidence);
      await recordEvent(tx, {
        organizationId: deployment.organizationId,
        eventType: 'deployment.install_not_verified',
        actorType: 'relay',
        actorId: deployment.installationId ?? deployment.id,
        deploymentId: deployment.id,
        customerId: deployment.customerId,
        jobId: unverified.anchorJobId,
        previousState: 'INSTALLING',
        requestedState: 'FAILED',
        result: 'failure',
        payload: {
          failureCode: unverified.failureCode,
          reason: unverified.reason,
          evidence: parsed.success
            ? {
                services: parsed.data.services.map((service) => ({
                  workloadId: service.workloadId,
                  desiredCount: service.desiredCount,
                  runningCount: service.runningCount,
                  rolloutState: service.rolloutState,
                  targets: service.targets,
                })),
                httpProbeStatus: parsed.data.httpProbe?.status ?? null,
              }
            : null,
        },
      });
    });
  }

  /**
   * Promotes or re-confirms the current release from accepted evidence. The
   * deployment row is locked inside the transaction (a job insert needs the
   * same row for its foreign key), so a job created or settled since the
   * heartbeat began cannot be overrun, and an older heartbeat that lost a race
   * cannot move the confirmation back.
   */
  async function reconcileRunningDigest(
    deployment: DeploymentRow,
    runningImageDigest: string,
    observedAt: Date,
  ): Promise<void> {
    const digest = digestSuffix(runningImageDigest);
    if (!digest) return;

    let currentIsServing = false;
    if (deployment.currentReleaseId) {
      const currentRows = await db
        .select({ imageDigest: schema.releases.imageDigest })
        .from(schema.releases)
        .where(eq(schema.releases.id, deployment.currentReleaseId))
        .limit(1);
      currentIsServing = digestSuffix(currentRows[0]?.imageDigest ?? null) === digest;
    }

    let reconciled: typeof schema.releases.$inferSelect | null = null;
    if (!currentIsServing) {
      const releases = await db
        .select()
        .from(schema.releases)
        .where(eq(schema.releases.applicationId, deployment.applicationId));
      const matches = releases.filter(
        (release) => release.releaseStatus === 'READY' && digestSuffix(release.imageDigest) === digest,
      );
      // Zero matches: the raw digest stays in observedState and the runtime
      // version renders as unknown. More than one: the same image built under
      // two versions — reconciling would be a guess, so it stays as-is.
      if (matches.length !== 1) return;
      reconciled = matches[0]!;
    }

    await db.transaction(async (tx) => {
      const [locked] = await tx
        .select({
          currentReleaseId: schema.deployments.currentReleaseId,
          currentReleaseConfirmedAt: schema.deployments.currentReleaseConfirmedAt,
          state: schema.deployments.state,
        })
        .from(schema.deployments)
        .where(eq(schema.deployments.id, deployment.id))
        .for('update');
      if (!locked || locked.currentReleaseId !== deployment.currentReleaseId) return; // The pointer moved meanwhile.
      if (locked.currentReleaseConfirmedAt !== null && locked.currentReleaseConfirmedAt > observedAt) return;
      const activeJobs = await tx
        .select({ id: schema.deploymentJobs.id })
        .from(schema.deploymentJobs)
        .where(
          and(
            eq(schema.deploymentJobs.deploymentId, deployment.id),
            inArray(schema.deploymentJobs.state, ACTIVE_JOB_STATES),
            inArray(schema.deploymentJobs.type, MUTATING_JOB_TYPES),
          ),
        )
        .limit(1);
      if (activeJobs.length > 0) return; // A job owns the pointer right now.

      if (reconciled === null) {
        await tx
          .update(schema.deployments)
          .set({ currentReleaseConfirmedAt: observedAt })
          .where(eq(schema.deployments.id, deployment.id));
        return;
      }

      await tx
        .update(schema.deployments)
        .set({
          currentReleaseId: reconciled.id,
          previousReleaseId: locked.currentReleaseId,
          currentReleaseConfirmedAt: observedAt,
        })
        .where(eq(schema.deployments.id, deployment.id));
      // The result route may have set UPDATE_AVAILABLE because the released
      // image was not yet promoted — now that it IS promoted, resolve the
      // state: HEALTHY when no newer READY release exists, else stay
      // UPDATE_AVAILABLE (a genuinely newer release was published meanwhile).
      if (locked.state === 'UPDATE_AVAILABLE') {
        const hasNewer = await newerReadyReleaseExists(
          tx,
          deployment.applicationId,
          reconciled.id,
        );
        if (!hasNewer) {
          await tx
            .update(schema.deployments)
            .set({ state: 'HEALTHY' })
            .where(
              and(
                eq(schema.deployments.id, deployment.id),
                eq(schema.deployments.state, 'UPDATE_AVAILABLE'),
              ),
            );
        }
      }
      await recordEvent(tx, {
        organizationId: deployment.organizationId,
        eventType: 'deployment.reconciled',
        actorType: 'relay',
        actorId: deployment.installationId ?? deployment.id,
        deploymentId: deployment.id,
        customerId: deployment.customerId,
        releaseId: reconciled.id,
        previousState: locked.currentReleaseId,
        requestedState: reconciled.id,
        result: 'success',
        payload: {
          source: 'runtime-observation',
          // initial: the first release confirmed for this deployment;
          // drift: the runtime differed from the release the pointer named.
          kind: locked.currentReleaseId === null ? 'initial' : 'drift',
          previousReleaseId: locked.currentReleaseId,
          reconciledReleaseId: reconciled.id,
          imageDigest: digest,
        },
      });
    });
  }

  app.post('/api/relay/register', async (request, reply) => {
    const token = requireBearerToken(request);
    const body = request.body as {
      enrollmentCode?: string;
      installationId?: string;
      awsAccountId?: string;
      relayVersion?: string;
      bootstrapVersion?: string;
      capabilities?: unknown;
    };
    if (!body?.enrollmentCode || !body?.installationId) {
      throw new ApiError(
        400,
        'INVALID_REQUEST',
        'enrollmentCode and installationId are required',
      );
    }
    const capabilitiesParsed = relayCapabilitiesSchema.safeParse(body.capabilities);

    // The enrollment code — not the installation id — is what identifies the
    // deployment. The id is minted by the customer's own bootstrap stack and
    // is unknown here until this call; the code is minted by the control
    // plane, carried into the stack as a template parameter, and burned on
    // first use. Anything else and there is nothing tying a relay in some AWS
    // account to a deployment a vendor created.
    const rows = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.enrollmentCode, body.enrollmentCode))
      .limit(1);
    const deployment = rows[0];
    if (!deployment) {
      throw new NotFoundError('Deployment not found');
    }

    const tokenHash = hashRelayToken(token);

    // DZ-AUDIT-013: if this deployment has a server-established credential
    // (relayCredential was stored at creation / relay/reset), the presented
    // bearer MUST verify against the stored hash. If it does not match,
    // refuse — the credential is not negotiable, only the bootstrap stack
    // that received it through the Quick Create URL knows it.
    // Legacy deployments (relayCredential is null) keep the old adopt-and-bind
    // path so in-flight installations before this change still work.
    if (deployment.relayCredential !== null) {
      if (!verifyRelayToken(deployment.relayTokenHash, token)) {
        throw new ApiError(
          401,
          'RELAY_CREDENTIAL_MISMATCH',
          'The relay bearer token does not match the server-established credential. ' +
          'Only a bootstrap stack deployed from the install link can present the right token.',
        );
      }
    }

    if (deployment.enrollmentUsedAt !== null) {
      // Already enrolled. A relay cold start or a retry replays this call
      // with the same id and token, which must stay harmless.
      const sameRelay =
        deployment.installationId === body.installationId &&
        verifyRelayToken(deployment.relayTokenHash, token);
      if (sameRelay) {
        return reply.code(200).send({ registered: true });
      }
      // Anything else is a second party trying to take the deployment over.
      // Refusing (rather than rebinding, which is what this route used to do)
      // is what keeps the real relay connected; the vendor recovers with
      // "Issue new install link", which mints a fresh code and credential.
      await recordEvent(db, {
        organizationId: deployment.organizationId,
        eventType: 'install.enrollment.rejected',
        actorType: 'relay',
        actorId: body.installationId,
        deploymentId: deployment.id,
        customerId: deployment.customerId,
        result: 'failure',
        payload: { reason: 'enrollment code already used by another relay' },
      });
      throw new ApiError(
        409,
        'RELAY_ALREADY_ENROLLED',
        'This installation is already connected. To install again, ask the software provider to issue a new install link, then update the existing connector stack in your AWS account with the new RelayCredential and EnrollmentCode. Do not create a second stack.',
      );
    }

    // §6/§39: an INSTALL job must be reachable through the API so a fresh
    // deployment can ever progress past the pre-install states. We create it
    // here (first relay registration) rather than at deployment-creation
    // time — the deployment row can legitimately exist before any relay has
    // called home, and this is the first point where we know the relay is
    // alive. WAITING_FOR_RELAY is the same first-install case with the
    // launch signal already recorded.
    // Phase 3/5 gate: the relay registering is the final boundary before an
    // INSTALL job is minted. Re-evaluate the stored manifest against the
    // customer's configuration as it is now.
    const preflight = await runDeploymentPreflight(db, deployment, null);
    if (!preflight.ready) {
      // Blocked registrations change nothing, so the event is written
      // outside the register tx below. A refused relay keeps retrying, so
      // only the first blocked evaluation per window is recorded per
      // deployment — one bounded lookup on an already-rare failure path.
      const [recentBlocked] = await db
        .select({ id: schema.eventLogs.id })
        .from(schema.eventLogs)
        .where(
          and(
            eq(schema.eventLogs.eventType, 'application.preflight_evaluated'),
            eq(schema.eventLogs.deploymentId, deployment.id),
            gte(schema.eventLogs.occurredAt, new Date(Date.now() - RELAY_BLOCKED_PREFLIGHT_THROTTLE_MS)),
            sql`(${schema.eventLogs.payload}->>'result') = 'blocked'`,
          ),
        )
        .limit(1);
      if (!recentBlocked) {
        await recordEvent(db, {
          organizationId: deployment.organizationId,
          eventType: 'application.preflight_evaluated',
          actorType: 'relay',
          actorId: body.installationId!,
          deploymentId: deployment.id,
          customerId: deployment.customerId,
          payload: {
            schemaVersion: 1,
            applicationId: deployment.applicationId,
            result: 'blocked',
            blockingCount: preflight.blockers.length,
            warningCount: preflight.warnings.length,
          },
        });
      }
    }
    requirePreflightReady(preflight);

    const firstInstall =
      deployment.state === 'NOT_INSTALLED' || deployment.state === 'WAITING_FOR_RELAY';
    const installJob =
      firstInstall
        ? (
            await createOrReuseJob(db, {
              deploymentId: deployment.id,
              type: 'INSTALL',
              idempotencyKey: await retryAwareIdempotencyKey(db, deployment.id, 'INSTALL', `${deployment.id}:INSTALL`),
              payload: {
                // A retry that kept the connector stack re-enrolls the same
                // installation, so the failed attempt's stack is recovered.
                ...(deployment.bootstrapStackName !== null &&
                deployment.bootstrapStackName === deployment.previousBootstrapStackName
                  ? { recovery: { neverInstalled: true } }
                  : {}),
                ...(await buildInstallPayload(db, deployment, configStore, body.installationId!)),
              },
              requestedBy: null,
            })
          ).job
        : null;

    let lostEnrollmentRace = false;
    await db.transaction(async (tx) => {
      const enrolled = await tx
        .update(schema.deployments)
        .set({
          installationId: body.installationId!,
          // DZ-AUDIT-013: the plaintext credential is consumed on successful
          // registration — the Quick Create URL has been used and won't be
          // issued again. Re-enrollment mints a fresh one.
          relayCredential: null,
          relayTokenHash: tokenHash,
          relayBoundAt: new Date(),
          enrollmentUsedAt: new Date(),
          relayStatus: 'CONNECTED',
          // §24 the customer's account id is knowable only from inside their
          // account; the relay is the only thing that can tell us.
          ...(body.awsAccountId ? { awsAccountId: body.awsAccountId } : {}),
          ...(typeof body.relayVersion === 'string' ? { relayVersion: body.relayVersion } : {}),
          ...(typeof body.bootstrapVersion === 'string' ? { bootstrapVersion: body.bootstrapVersion } : {}),
          ...(capabilitiesParsed.success ? { relayCapabilities: capabilitiesParsed.data } : {}),
          ...(deployment.state === 'NOT_INSTALLED' || deployment.state === 'WAITING_FOR_RELAY'
            ? { state: 'INSTALLING' as const }
            : {}),
        })
        // The code burns on first use: a concurrent registration that read
        // the row before this commit matches nothing here.
        .where(and(eq(schema.deployments.id, deployment.id), isNull(schema.deployments.enrollmentUsedAt)))
        .returning();
      if (enrolled.length === 0) {
        lostEnrollmentRace = true;
        return;
      }

      if (installJob) {
        await recordEvent(tx, {
          organizationId: deployment.organizationId,
          eventType: 'install.requested',
          actorType: 'relay',
          actorId: body.installationId!,
          deploymentId: deployment.id,
          customerId: deployment.customerId,
          jobId: installJob.id,
          previousState: deployment.state,
          requestedState: 'INSTALLING',
          result: 'pending',
        });
      }
      // This tx only ever runs on the FIRST successful enrollment (the
      // enrollmentUsedAt guard above already idempotented same-relay replays
      // and refused second parties) — so this IS relay.connected. Heartbeats
      // never reach this code; a re-enrollment after an admin relay reset
      // (fresh enrollment code) is a distinguishable new first connection and
      // emits again by design. The deploymentId column is the join key.
      await recordEvent(tx, {
        organizationId: deployment.organizationId,
        eventType: 'relay.connected',
        actorType: 'relay',
        actorId: body.installationId!,
        deploymentId: deployment.id,
        customerId: deployment.customerId,
        payload: { schemaVersion: 1 },
      });
      // In the register tx, reached only on the first registration (the
      // enrollmentUsedAt guard above already idempotented replays).
      await recordEvent(tx, {
        organizationId: deployment.organizationId,
        eventType: 'application.preflight_evaluated',
        actorType: 'relay',
        actorId: body.installationId!,
        deploymentId: deployment.id,
        customerId: deployment.customerId,
        payload: {
          schemaVersion: 1,
          applicationId: deployment.applicationId,
          result: 'pass',
          blockingCount: preflight.blockers.length,
          warningCount: preflight.warnings.length,
        },
      });
    });

    if (lostEnrollmentRace) {
      const [winner] = await db
        .select()
        .from(schema.deployments)
        .where(eq(schema.deployments.id, deployment.id))
        .limit(1);
      if (
        winner?.installationId === body.installationId &&
        verifyRelayToken(winner.relayTokenHash, token)
      ) {
        return reply.code(200).send({ registered: true });
      }
      await recordEvent(db, {
        organizationId: deployment.organizationId,
        eventType: 'install.enrollment.rejected',
        actorType: 'relay',
        actorId: body.installationId,
        deploymentId: deployment.id,
        customerId: deployment.customerId,
        result: 'failure',
        payload: { reason: 'enrollment code already used by another relay' },
      });
      throw new ApiError(
        409,
        'RELAY_ALREADY_ENROLLED',
        'This installation is already connected. To install again, ask the software provider to issue a new install link, then update the existing connector stack in your AWS account with the new RelayCredential and EnrollmentCode. Do not create a second stack.',
      );
    }

    // Phase 1.1: a just-enrolled relay's customer account needs pull access to
    // the vendor ECR before the INSTALL job queued above can ever start a task
    // that pulls the image. Idempotent + best-effort: an already-granted
    // installation (replay) is a no-op policy write, and a grant failure logs
    // and surfaces later as the customer task's IMAGE_PULL_FAILED.
    if (installJob && typeof body.awsAccountId === 'string' && body.awsAccountId.length > 0) {
      await grantPullToCustomer(ecrGrantDeps, body.installationId!, body.awsAccountId);
    }

    return reply.code(200).send({ registered: true });
  });

  // §39 relay command channel, backed by deployment_jobs (not the old
  // write-only in-memory map). Picking up REQUESTED/QUEUED jobs transitions
  // them to RUNNING so a retried poll does not hand out the same command
  // twice while it's in flight.
  app.get('/api/relay/commands', async (request) => {
    const token = requireBearerToken(request);
    const { installationId } = request.query as { installationId?: string };
    const deployment = await requireRelayDeployment(installationId, token);

    // Service mutations never overlap: while one is RUNNING (a rollout the
    // relay is still waiting on) no other is handed out, and a CONFIG_UPDATE
    // is handed out only as the first service mutation of a batch. A
    // CONFIG_UPDATE queued during an install therefore waits, still queued,
    // until the install settles.
    const candidates = await db
      .select({
        id: schema.deploymentJobs.id,
        type: schema.deploymentJobs.type,
        state: schema.deploymentJobs.state,
        createdAt: schema.deploymentJobs.createdAt,
      })
      .from(schema.deploymentJobs)
      .where(
        and(
          eq(schema.deploymentJobs.deploymentId, deployment.id),
          inArray(schema.deploymentJobs.state, ['REQUESTED', 'QUEUED', 'WAITING', 'RUNNING']),
        ),
      );
    const mutationRunning = candidates.some(
      (job) => job.state === 'RUNNING' && SERVICE_MUTATING_JOB_TYPES.has(job.type),
    );
    const claimIds: string[] = [];
    let mutationClaimed = false;
    for (const job of candidates.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
      if (job.state === 'RUNNING') continue;
      if (SERVICE_MUTATING_JOB_TYPES.has(job.type)) {
        if (mutationRunning || (job.type === 'CONFIG_UPDATE' && mutationClaimed)) continue;
        mutationClaimed = true;
      }
      claimIds.push(job.id);
    }

    // Atomic claim: transition and read in one statement, so two overlapping
    // polls (a client retry racing the original) can never both receive the
    // same command — the second poll's UPDATE matches zero rows. WAITING jobs
    // are claimed back too: the watchdog parks a job there when the relay
    // goes quiet mid-operation, and this poll IS the relay returning.
    const jobs =
      claimIds.length === 0
        ? []
        : (
            await db
              .update(schema.deploymentJobs)
              .set({ state: 'RUNNING', startedAt: new Date(), lastProgressAt: new Date() })
              .where(
                and(
                  eq(schema.deploymentJobs.deploymentId, deployment.id),
                  inArray(schema.deploymentJobs.id, claimIds),
                  inArray(schema.deploymentJobs.state, ['REQUESTED', 'QUEUED', 'WAITING']),
                ),
              )
              .returning()
          ).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    // Payload redaction rides the claim: the relay reads the value ONCE from
    // this response (built from the pre-redaction rows below); the stored row
    // keeps only the shape without plaintext (see `redactClaimedPayload`).
    for (const job of jobs) {
      await db
        .update(schema.deploymentJobs)
        .set({
          // The payload column is NOT NULL; a null redaction (defensive
          // only — the column never stores null) falls back to {}.
          payload: redactClaimedPayload(job) ?? {},
        })
        .where(eq(schema.deploymentJobs.id, job.id));
    }

    // Deployment facts the observe hook needs but no command carries: the
    // heartbeat runs outside any command, so this poll response is the only
    // channel that reaches it. Phase 2: derived from the deployment's frozen
    // spec's verification contract, never the live `applications` columns —
    // the relay's requirement-aware heartbeat checks must never disagree
    // with what this deployment was actually created with. A missing/invalid
    // or uncompiled spec omits BOTH flags (never a guessed default) so
    // poll.ts's "send both or neither" contract holds.
    const manifest = readStoredManifest(deployment.desiredState);
    const spec = readStoredDeploymentSpec(deployment.specV2);
    const requirements = spec ? requirementsFromSpec(spec) : null;

    // §10.2 + Phase 11: the probe URL is where the app is ACTUALLY served —
    // the custom domain / default-HTTPS hostname once HTTPS is configured,
    // otherwise the successful INSTALL's ALB endpoint — plus the configured
    // health path.
    const installJobs = await db
      .select({ result: schema.deploymentJobs.result, state: schema.deploymentJobs.state, type: schema.deploymentJobs.type })
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.deploymentId, deployment.id))
      .orderBy(schema.deploymentJobs.createdAt);
    const activeDomain = await findActiveDomain(db, deployment.id);
    const defaultHttps = parseDefaultHttps(deployment.defaultHttps);

    return {
      commands: jobs.map((job) => ({
        id: job.id,
        deploymentId: deployment.id,
        type: job.type,
        idempotencyKey: job.idempotencyKey,
        payload: job.payload,
      })),
      deployment: {
        ...(requirements
          ? {
              databaseRequired: requirements.databaseRequired,
              redisRequired: requirements.redisRequired,
              // Phase 4A: the per-workload service seats (one compute check
              // each) ride the same gate — both from the frozen spec, both
              // or neither, so the relay's verification and heartbeat agree
              // with the stack.
              workloads: workloadServicesFromSpec(spec!),
              // Phase 5: verification-contract checks outside the fixed
              // catalog (queue/schedule/…) — the relay verifies these
              // generically. Omitted (never an empty array) when the spec
              // carries none, so an unaffected deployment's poll response
              // stays byte-identical.
              ...(resourceChecksFromSpec(spec!).length > 0
                ? { resourceChecks: resourceChecksFromSpec(spec!) }
                : {}),
            }
          : {}),
        probeUrl: resolveProbeUrl(installJobs, manifest?.health.path ?? null, activeDomain, defaultHttps),
      },
    };
  });

  // Whether a claimed/pending command is still authoritative. The relay asks
  // before it keeps mutating AWS: a command that settled, whose deployment is
  // being torn down, or (INSTALL) that a later DESTROY superseded is no longer
  // safe to run. Auth mirrors the result route: the token must belong to the
  // JOB'S deployment.
  // The relay hands back a command it claimed but did not start, because
  // another service mutation of the same batch is still in flight. The job
  // returns to REQUESTED and is offered again once that one settles. A job
  // whose claimed payload was redacted (INSTALL parameters, CONFIG_UPDATE
  // secret values) cannot be handed back: its values are gone.
  app.post('/api/relay/commands/:id/release', async (request, reply) => {
    const token = requireBearerToken(request);
    const { id } = request.params as { id: string };
    requireUuidId(id);

    const [job] = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.id, id)).limit(1);
    if (!job) {
      throw new NotFoundError('Job not found');
    }
    const [deployment] = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, job.deploymentId))
      .limit(1);
    if (!deployment || !verifyRelayTokenWithRotation(deployment.relayTokenHash, token, oldRelayToken(request))) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Invalid relay credentials');
    }
    if (job.type === 'INSTALL' || job.type === 'CONFIG_UPDATE') {
      throw new ApiError(409, 'COMMAND_NOT_RELEASABLE', 'This command cannot be handed back after it was claimed.');
    }
    const released = await db
      .update(schema.deploymentJobs)
      .set({ state: 'REQUESTED', startedAt: null, lastProgressAt: new Date() })
      .where(and(eq(schema.deploymentJobs.id, job.id), eq(schema.deploymentJobs.state, 'RUNNING')))
      .returning();
    return reply.code(200).send({ released: released.length > 0 });
  });

  app.get('/api/relay/commands/:id/authority', async (request, reply) => {
    const token = requireBearerToken(request);
    const { id } = request.params as { id: string };
    requireUuidId(id);

    const jobRows = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.id, id)).limit(1);
    if (jobRows.length === 0) {
      throw new NotFoundError('Job not found');
    }
    const job = jobRows[0]!;

    const deploymentRows = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, job.deploymentId))
      .limit(1);
    const deployment = deploymentRows[0];
    if (
      !deployment ||
      !verifyRelayTokenWithRotation(deployment.relayTokenHash, token, oldRelayToken(request))
    ) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Invalid relay credentials');
    }

    const [latestDestroy] = await db
      .select({ createdAt: schema.deploymentJobs.createdAt })
      .from(schema.deploymentJobs)
      .where(
        and(
          eq(schema.deploymentJobs.deploymentId, deployment.id),
          eq(schema.deploymentJobs.type, 'DESTROY'),
        ),
      )
      .orderBy(desc(schema.deploymentJobs.createdAt))
      .limit(1);

    const authority = relayCommandAuthority(job, deployment, latestDestroy?.createdAt ?? null);
    return reply.code(200).send({
      active: authority.active,
      jobState: job.state,
      ...(authority.reason ? { reason: authority.reason } : {}),
    });
  });

  app.post('/api/relay/commands/:id/result', async (request, reply) => {
    const token = requireBearerToken(request);
    const { id } = request.params as { id: string };
    requireUuidId(id);

    const jobRows = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.id, id)).limit(1);
    if (jobRows.length === 0) {
      throw new NotFoundError('Job not found');
    }
    const job = jobRows[0]!;

    const deploymentRows = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, job.deploymentId))
      .limit(1);
    const deployment = deploymentRows[0];
    if (
      !deployment ||
      !verifyRelayTokenWithRotation(deployment.relayTokenHash, token, oldRelayToken(request))
    ) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Invalid relay credentials');
    }

    const body = request.body as {
      success?: boolean;
      error?: string;
      output?: Record<string, unknown>;
      failureCode?: string;
      evidence?: unknown;
    };
    // The relay's free-text error reaches the job result, the event feed and
    // the vendor UI; it is customer-side output, so redact secret shapes first.
    if (typeof body.error === 'string') {
      body.error = redactSecrets(body.error);
    }
    // Every relay version sends a boolean; a malformed report never settles a
    // job as SUCCEEDED by default.
    if (typeof body.success !== 'boolean') {
      throw new ApiError(400, 'VALIDATION_ERROR', 'A relay result must say whether the command succeeded');
    }
    const state = body.success ? 'SUCCEEDED' : 'FAILED';
    const failureCodeParsed = state === 'FAILED' ? failureCodeSchema.safeParse(body.failureCode) : undefined;
    // A code the enum does not know used to be dropped on the floor, which
    // left the vendor looking at "Unknown issue" with no trace of what the
    // relay actually said. Keep the raw string in the event payload so a
    // vocabulary drift is visible in the audit trail instead of silent.
    const unrecognisedFailureCode =
      state === 'FAILED' && body.failureCode !== undefined && !failureCodeParsed?.success
        ? body.failureCode
        : undefined;

    // Phase 1 structured failure evidence: the relay's stopped-container
    // verdict, sanitised before it is persisted or classified — its free
    // text gets the same redaction + truncation stack-event reasons get at
    // ingest. A block that does not parse is dropped (never stored raw);
    // relays built before evidence existed send nothing at all.
    const evidenceParsed =
      body.evidence !== undefined ? failureEvidenceSchema.safeParse(body.evidence) : undefined;
    const failureEvidence =
      evidenceParsed !== undefined && evidenceParsed.success
        ? {
            container:
              evidenceParsed.data.container === null
                ? null
                : {
                    ...evidenceParsed.data.container,
                    stoppedReason:
                      evidenceParsed.data.container.stoppedReason !== null
                        ? redactSecrets(evidenceParsed.data.container.stoppedReason).slice(0, 500)
                        : null,
                  },
          }
        : null;
    if (body.evidence !== undefined) {
      if (failureEvidence !== null) {
        body.evidence = failureEvidence;
      } else {
        delete body.evidence;
      }
    }

    // §61 server-side refinement: the relay hardcodes coarse defaults (every
    // INSTALL failure is STACK_CREATE_FAILED, most thrown exceptions become
    // AWS_PERMISSION_DENIED). Sharpen those using the error text and the
    // persisted CloudFormation events for this job, so remediation copy
    // matches the real cause — for every installation, old relays included.
    const reportedFailureCode = failureCodeParsed?.success ? failureCodeParsed.data : null;
    // The persisted CloudFormation events for this job — §61 refinement's
    // input and, below, the Jev UNKNOWN-failure shadow's evidence. Loaded for
    // INSTALL/DESTROY only, the two job types that wait on a stack.
    const stackEvents: {
      resourceType: string;
      logicalResourceId: string;
      resourceStatus: string;
      resourceStatusReason: string | null;
      eventAt: Date;
    }[] =
      state === 'FAILED' && (job.type === 'INSTALL' || job.type === 'DESTROY')
        ? await db
            .select({
              resourceType: schema.deploymentStackEvents.resourceType,
              logicalResourceId: schema.deploymentStackEvents.logicalResourceId,
              resourceStatus: schema.deploymentStackEvents.resourceStatus,
              resourceStatusReason: schema.deploymentStackEvents.resourceStatusReason,
              eventAt: schema.deploymentStackEvents.eventAt,
            })
            .from(schema.deploymentStackEvents)
            .where(
              and(
                eq(schema.deploymentStackEvents.deploymentId, deployment.id),
                eq(schema.deploymentStackEvents.jobId, job.id),
              ),
            )
            .orderBy(schema.deploymentStackEvents.eventAt)
        : [];
    let effectiveFailureCode = reportedFailureCode;
    if (state === 'FAILED') {
      effectiveFailureCode = refineFailureCode({
        reported: reportedFailureCode,
        errorText: body.error ?? null,
        stackEvents,
        evidence: failureEvidence,
      });
    }

    // A finished job is what advances the deployment's own §46 state.
    // Domain jobs manage the custom_domains row, never the deployment
    // lifecycle — a failed cert request must not mark the deployment FAILED.
    // A failed day-2 operation on a deployment with a running release keeps
    // the deployment in a live state (deploymentStateAfterFailedJob): the
    // previous release is still serving, and the FAILED job itself carries
    // the failure for the status derivation to surface. currentReleaseId
    // alone under-counts this: a first install runs the template-pinned
    // image with no release row ever deployed (CANARY-008), so a SUCCEEDED
    // install also counts as a running workload — unless it was a zero-task
    // install waiting for configuration (DEPLOY-009), whose first deploy is
    // the first start.
    const nextState = isDomainJobType(job.type)
      ? undefined
      : state === 'FAILED'
        ? (deploymentStateAfterFailedJob({
            jobType: job.type,
            hasCurrentRelease:
              deployment.currentReleaseId !== null ||
              (await hasStartedInstall(db, deployment.id)),
            newerReadyReleaseExists: await newerReadyReleaseExists(
              db,
              deployment.applicationId,
              deployment.currentReleaseId,
            ),
          }) ?? undefined)
        : state === 'SUCCEEDED' && (job.type === 'DEPLOY_RELEASE' || job.type === 'ROLLBACK')
          ? await newerReadyReleaseExists(
              db,
              deployment.applicationId,
              deployment.currentReleaseId,
            )
            ? 'UPDATE_AVAILABLE'
            : 'HEALTHY'
          : JOB_SUCCESS_STATE[job.type];
    // The release this job rolled out, for the audit event only. §10.3: a
    // DEPLOY_RELEASE/ROLLBACK success must NOT advance the release pointers
    // here — the relay has settled ECS (rollout + targets), but promotion
    // also needs the observed HTTP probe healthy, which only arrives on the
    // heartbeat. The heartbeat's digest reconciliation advances the pointer
    // once every gate passes, so a partially-rolled-out service is never
    // promoted on the relay's word alone.
    const releaseId =
      state === 'SUCCEEDED' && RELEASE_ADVANCING_JOBS.has(job.type)
        ? ((job.payload as { releaseId?: string } | null)?.releaseId ?? null)
        : null;

    // Phase 11 teardown: the Route53 records this deployment's default HTTPS
    // owns, captured pre-transaction (the row is cleared inside it). Removed
    // best-effort after the commit once the certificate is gone (a default
    // REMOVE_DOMAIN success) or the whole stack is gone (DESTROY success).
    const preTxDefaultHttps = parseDefaultHttps(deployment.defaultHttps);

    let billingStopped = false;
    let alreadySettled = false;
    await db.transaction(async (tx) => {
      const updated = await tx
        .update(schema.deploymentJobs)
        .set({
          state,
          result: body as Record<string, unknown>,
          finishedAt: new Date(),
          lastProgressAt: new Date(),
          ...(effectiveFailureCode ? { failureCode: effectiveFailureCode } : {}),
        })
        .where(
          and(
            eq(schema.deploymentJobs.id, id),
            inArray(schema.deploymentJobs.state, ['REQUESTED', 'QUEUED', 'WAITING', 'RUNNING']),
          ),
        )
        .returning();
      // A settled job never reprocesses: a late duplicate result (the relay's
      // earlier report timed out and it retried, or the job was already
      // force-completed/cancelled) must not flip the deployment state again or
      // recompute release pointers against a since-changed deployment row.
      if (updated.length === 0) {
        alreadySettled = true;
        return;
      }

      if (isDomainJobType(job.type)) {
        // Phase 11: default-HTTPS jobs (idempotency keys under the
        // `:default-https:` namespace) drive the deployments.default_https
        // machine; every other domain job drives the custom_domains row.
        if (isDefaultHttpsJob(job)) {
          await applyDefaultHttpsJobResult(tx, deployment.id, job, body);
        } else {
          await applyDomainJobResult(tx, deployment, job, body);
        }
      }

      if (nextState) {
        await tx
          .update(schema.deployments)
          .set({
            state: nextState,
            // §10.3 keeps CURRENT-release promotion gated on the heartbeat's
            // digest reconciliation, but the rollback's own bookkeeping is
            // job truth: the release this rollback replaced is the pointer
            // the deployment carried into it. currentReleaseId itself still
            // only moves via the gated reconciliation.
            ...(state === 'SUCCEEDED' && job.type === 'ROLLBACK'
              ? { previousReleaseId: deployment.currentReleaseId }
              : {}),
            ...(nextState === 'DELETED' ? { deletedAt: new Date() } : {}),
          })
          .where(eq(schema.deployments.id, deployment.id));
      }

      // Safety net: a DESTROY success means the whole stack (and with it any
      // custom domain's ALB listener/routing) is gone regardless of whether
      // its own REMOVE_DOMAIN job ever reported back. Force it removed so it
      // never lingers as a phantom "removing" row for a deployment that no
      // longer exists. Same for the Phase 11 default-HTTPS state: the stack's
      // certificate and listener are gone with it.
      if (job.type === 'DESTROY' && nextState === 'DELETED') {
        const danglingDomain = await findActiveDomain(tx, deployment.id);
        if (danglingDomain) {
          await tx
            .update(schema.customDomains)
            .set({ removedAt: new Date() })
            .where(eq(schema.customDomains.id, danglingDomain.id));
        }
        await tx
          .update(schema.deployments)
          .set({ defaultHttps: null })
          .where(eq(schema.deployments.id, deployment.id));
        // Idempotent backstop (R0-1): the destroy route already stopped
        // billing when the removal was accepted; this only catches a
        // deployment that somehow reached DESTROY success while still ACTIVE.
        billingStopped = await markDeploymentRemoved(tx, deployment, new Date(), {
          actorType: 'relay',
          actorId: deployment.installationId ?? deployment.id,
        });
      }

      // A successful PURGE is what clears the retained-resources warning:
      // the relay verified and removed every owned leftover. The deployment
      // state itself never moves — it was already DELETED.
      if (job.type === 'PURGE' && state === 'SUCCEEDED') {
        await tx
          .update(schema.deployments)
          .set({ cleanupState: 'COMPLETE' })
          .where(eq(schema.deployments.id, deployment.id));
      }
      // A failed PURGE must NOT resurrect the deployment (never back to
      // FAILED — deploymentStateAfterFailedJob already returns null for it):
      // the cleanup lifecycle is separate, so the failure records itself on
      // cleanupState instead, keeping the deployment DELETED and the purge
      // retryable from the PURGE_FAILED state.
      if (job.type === 'PURGE' && state === 'FAILED') {
        await tx
          .update(schema.deployments)
          .set({ cleanupState: 'PURGE_FAILED' })
          .where(eq(schema.deployments.id, deployment.id));
      }

      const eventType = JOB_RESULT_EVENT[job.type]?.[state === 'FAILED' ? 'failed' : 'completed'];
      if (eventType) {
        await recordEvent(tx, {
          organizationId: deployment.organizationId,
          eventType,
          actorType: 'relay',
          actorId: deployment.installationId ?? deployment.id,
          deploymentId: deployment.id,
          customerId: deployment.customerId,
          jobId: job.id,
          releaseId: releaseId ?? undefined,
          previousState: deployment.state,
          requestedState: nextState ?? null,
          result: state === 'FAILED' ? 'failure' : 'success',
          payload: {
            ...(body.error ? { error: body.error } : {}),
            ...(effectiveFailureCode ? { failureCode: effectiveFailureCode } : {}),
            // Audit trail: what the relay itself said, when refinement
            // changed it — the classification decision stays traceable.
            ...(reportedFailureCode && reportedFailureCode !== effectiveFailureCode
              ? { reportedFailureCode }
              : {}),
            ...(unrecognisedFailureCode ? { unrecognisedFailureCode } : {}),
            // A configured first start (DEPLOY-009) created the stack with
            // zero tasks: this event means "infrastructure ready", not
            // "application started and healthy".
            ...(job.type === 'INSTALL' &&
            state !== 'FAILED' &&
            (job.payload as Record<string, unknown> | null)?.['startAfterConfig'] === true
              ? { startAfterConfig: true }
              : {}),
          },
        });
      }
    });

    // Job was already settled (result route's earlier report won, or
    // force-complete cancelled it) — skip all side effects.
    if (alreadySettled) {
      if (job.type === 'INSTALL' && job.state === 'SUCCEEDED') {
        try {
          await ensureInstallFollowUps(deployment, job);
        } catch (error) {
          request.log.warn({ err: error }, 'install follow-up repair failed');
        }
      }
      return reply.code(200).send({ received: true, alreadySettled: true });
    }

    // DEPLOY-027 (Phase 4): a successful CONFIG_UPDATE ack means the relay
    // fetched every bound row, applied the secrets to the customer, and is
    // done with them. The deployment never polls again with the same key,
    // so we drop the bound rows of the keys THIS job carried — the values
    // live only in the customer's Secrets Manager from here on. A secret
    // bound after the job was created waits for the CONFIG_UPDATE its own
    // write queued. Same idea for PURGE success: the relay has confirmed the
    // customer account is fully released, no relay will ever poll again.
    if (job.type === 'CONFIG_UPDATE' && state === 'SUCCEEDED') {
      await pendingSecrets.deleteBoundForDeployment(deployment.id, configUpdateDeliveredKeys(job.payload));
    }
    if (job.type === 'PURGE' && state === 'SUCCEEDED') {
      await pendingSecrets.deleteBoundForDeployment(deployment.id);
    }

    // Best-effort step-timings follow-up (see advanceStepTimingsAfterWrite) —
    // Phase 9: outside the transaction, and only when this backstop was the
    // write that actually stopped billing.
    if (billingStopped) {
      await reconcileAfterBillingChange(db, paddle, deployment.organizationId);
    }

    // derived from the values THIS request just wrote, not the stale
    // pre-transaction `deployment`. The release pointers are deliberately
    // absent: promotion happens on the heartbeat (§10.3).
    try {
      await advanceStepTimingsAfterWrite(db, paddle, {
        ...deployment,
        ...(nextState ? { state: nextState } : {}),
      });
    } catch (error) {
      request.log.warn({ err: error }, 'step-timings advance failed');
    }

    // Phase 1.1 side effects, best-effort after the transaction — neither may
    // fail the /result response:
    //  - INSTALL success queues its follow-ups (first configuration pass, then
    //    the deploy of the newest READY release). A replayed result and the
    //    relay heartbeat repair a failed attempt.
    //  - DESTROY/PURGE success revokes the customer's ECR pull grant (both
    //    revocations are idempotent, whichever lands first).
    if (job.type === 'INSTALL' && state === 'SUCCEEDED') {
      // Phase 4: the first configuration pass — vendor/customer values saved
      // before the install, and the app-internal secrets Deployz generates.
      // Queued BEFORE the auto-deploy (see ensureInstallFollowUps). A failure
      // is repaired by the next heartbeat or a replayed result.
      try {
        await ensureInstallFollowUps(deployment, job);
      } catch (error) {
        request.log.warn({ err: error }, 'install follow-ups failed');
      }
    }
    // Phase 11: a successful INSTALL means the ALB exists — start (or nudge)
    // the default-HTTPS machine so the deployment earns its own HTTPS URL
    // without any customer DNS input. Best-effort: the heartbeat driver is
    // the cadence that keeps it moving, this is just the earliest kick.
    if (job.type === 'INSTALL' && state === 'SUCCEEDED') {
      try {
        await runDefaultHttpsCheck(db, { ...deployment, state: 'HEALTHY' }, defaultHttpsDeps);
      } catch (error) {
        request.log.warn({ err: error }, 'default-https start after install failed');
      }
    }
    if ((job.type === 'DESTROY' || job.type === 'PURGE') && state === 'SUCCEEDED') {
      const installationId = deployment.installationId;
      if (installationId) {
        await revokePullFromCustomer(ecrGrantDeps, installationId);
      }
    }
    // Phase 11 record teardown (see preTxDefaultHttps above): the deployz-zone
    // CNAMEs are the control plane's to remove — the relay never sees them.
    // The certificate is gone when DESTROY succeeded (whole stack) or when a
    // DEFAULT-HTTPS REMOVE_DOMAIN succeeded (its own cert). A CUSTOM domain's
    // REMOVE_DOMAIN never touches the default records — the deployment keeps
    // its permanent Deployz URL while the custom domain is being removed.
    if (preTxDefaultHttps) {
      const certificateGone =
        state === 'SUCCEEDED' &&
        (job.type === 'DESTROY' || (job.type === 'REMOVE_DOMAIN' && isDefaultHttpsJob(job)));
      if (certificateGone) {
        try {
          await defaultHttpsDeps.dns.deleteDefaultDeploymentRecord(deployment.id);
        } catch (error) {
          request.log.warn({ err: error }, 'default-https record cleanup failed');
        }
        if (preTxDefaultHttps.validationName) {
          try {
            await defaultHttpsDeps.dns.deleteDefaultValidationRecord(
              deployment.id,
              preTxDefaultHttps.validationName,
            );
          } catch (error) {
            request.log.warn({ err: error }, 'default-https record cleanup failed');
          }
        }
      }
    }

    // Jev UNKNOWN-failure shadow (PR 3): fire-and-forget telemetry after all
    // settlement work — only when the job actually settled above (an
    // alreadySettled duplicate returned early) AND the effective code stayed
    // UNKNOWN after refinement. Known or refined codes never reach Jev, and
    // the runner can never touch the state written above.
    if (state === 'FAILED' && effectiveFailureCode === 'UNKNOWN') {
      void jevFailureShadow
        .run({
          deploymentId: deployment.id,
          jobId: job.id,
          deploymentStage: job.type,
          failureReason: body.error ?? '',
          ...(stackEvents.length > 0
            ? {
                recentEvents: stackEvents.map((event) => ({
                  resourceType: event.resourceType,
                  logicalResourceId: event.logicalResourceId,
                  resourceStatus: event.resourceStatus,
                  ...(event.resourceStatusReason !== null
                    ? { resourceStatusReason: event.resourceStatusReason }
                    : {}),
                  eventAt: event.eventAt.toISOString(),
                })),
              }
            : {}),
          ...(failureEvidence?.container?.stoppedReason
            ? { ecsStoppedReason: failureEvidence.container.stoppedReason }
            : {}),
          healthStatus: deployment.healthStatus,
          relayStatus: deployment.relayStatus,
          ...(job.startedAt ? { elapsedMs: Date.now() - job.startedAt.getTime() } : {}),
          retryCount: job.reconcileCount,
          deployzFailureCode: 'UNKNOWN',
        })
        .catch(() => {});
    }

    return reply.code(200).send({ received: true });
  });

  // Relay stack-event progress ingest: fed by the relay while an INSTALL or
  // DESTROY job is mid-flight, well before /result ever reports. Auth mirrors
  // /health's (installationId travels in the body, not derived from the job)
  // rather than /result's job-first lookup — the job named in :id is
  // cross-checked against the authenticated deployment below, so a relay can
  // never probe another deployment's job ids: it gets the same 404 as an
  // unknown one.
  app.post('/api/relay/commands/:id/progress', async (request, reply) => {
    const token = requireBearerToken(request);
    const { id } = request.params as { id: string };
    requireUuidId(id);

    const rawBody = request.body as { installationId?: string } | undefined;
    const deployment = await requireRelayDeployment(rawBody?.installationId, token, oldRelayToken(request));

    const parsed = relayCommandProgressSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError(400, 'INVALID_REQUEST', 'Invalid progress payload');
    }
    const body = parsed.data;

    const jobRows = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.id, id)).limit(1);
    const job = jobRows[0];
    if (!job || job.deploymentId !== deployment.id) {
      throw new NotFoundError('Job not found');
    }
    if (job.type !== 'INSTALL' && job.type !== 'DESTROY') {
      throw new ApiError(409, 'UNSUPPORTED_JOB_TYPE', 'Progress ingest is only supported for INSTALL and DESTROY jobs');
    }

    const now = new Date();
    const insertedRows = await db
      .insert(schema.deploymentStackEvents)
      .values(
        body.events.map((event) => ({
          deploymentId: deployment.id,
          jobId: job.id,
          providerEventId: event.eventId,
          eventAt: new Date(event.timestamp),
          logicalResourceId: event.logicalResourceId,
          resourceType: event.resourceType,
          resourceStatus: event.resourceStatus,
          resourceStatusReason: event.resourceStatusReason
            ? redactSecrets(event.resourceStatusReason).slice(0, 500)
            : null,
        })),
      )
      .onConflictDoNothing({
        target: [schema.deploymentStackEvents.deploymentId, schema.deploymentStackEvents.providerEventId],
      })
      .returning();
    const accepted = insertedRows.length;

    await db
      .update(schema.deploymentJobs)
      .set({ lastProgressAt: now })
      .where(eq(schema.deploymentJobs.id, job.id));

    if (job.type === 'INSTALL' && (job.state === 'RUNNING' || job.state === 'WAITING')) {
      const eventRows = await db
        .select()
        .from(schema.deploymentStackEvents)
        .where(
          and(
            eq(schema.deploymentStackEvents.deploymentId, deployment.id),
            eq(schema.deploymentStackEvents.jobId, job.id),
          ),
        )
        .orderBy(schema.deploymentStackEvents.eventAt, schema.deploymentStackEvents.id);
      const storedEvents: StoredStackEvent[] = eventRows.map((row) => ({
        eventAt: row.eventAt,
        logicalResourceId: row.logicalResourceId,
        resourceType: row.resourceType,
        resourceStatus: row.resourceStatus,
        resourceStatusReason: row.resourceStatusReason,
      }));
      const snapshot = summarizeStackEvents(body.stackName, storedEvents, now.toISOString());
      if (snapshot !== null) {
        const existingObservedState = deployment.observedState;
        const nextObservedState = {
          ...(existingObservedState ?? {}),
          infraHealth: {
            ...((existingObservedState?.['infraHealth'] as Record<string, unknown>) ?? {}),
            provisioning: snapshot,
          },
        };
        await db
          .update(schema.deployments)
          .set({ observedState: nextObservedState })
          .where(eq(schema.deployments.id, deployment.id));

        try {
          await advanceStepTimingsAfterWrite(db, paddle, { ...deployment, observedState: nextObservedState });
        } catch (error) {
          request.log.warn({ err: error }, 'step-timings advance failed');
        }
      }

      // A failure-determined stack status is CloudFormation's own verdict
      // that this install cannot succeed: the create failed and AWS is
      // already tearing down (or has torn down) what it created. Normally
      // the relay executor reports that verdict via /result; a lost deferred
      // report (pending marker gone) would instead leave the job RUNNING
      // and the deployment INSTALLING forever — the heartbeat keeps the
      // watchdog's staleness clock fresh, so nothing canonical ever lands
      // FAILED while the customer page already shows the error. Settle here
      // from the same evidence /result would use: the same rule
      // (deploymentStateAfterFailedJob), the same first-writer-wins guard
      // on the job's state, and the same server-side refinement.
      const stackStatus =
        snapshot !== null && typeof snapshot['stackStatus'] === 'string' ? snapshot['stackStatus'] : null;
      if (stackStatus !== null && INSTALL_FAILURE_STACK_STATUSES.has(stackStatus)) {
        const effectiveFailureCode =
          refineFailureCode({
            reported: 'STACK_CREATE_FAILED',
            errorText: null,
            stackEvents: storedEvents,
            evidence: null,
          }) ?? 'STACK_CREATE_FAILED';
        const nextState = deploymentStateAfterFailedJob({
          jobType: 'INSTALL',
          hasCurrentRelease:
            deployment.currentReleaseId !== null || (await hasStartedInstall(db, deployment.id)),
          newerReadyReleaseExists: await newerReadyReleaseExists(
            db,
            deployment.applicationId,
            deployment.currentReleaseId,
          ),
        });
        await db.transaction(async (tx) => {
          const settled = await tx
            .update(schema.deploymentJobs)
            .set({
              state: 'FAILED',
              result: {
                success: false,
                failureCode: effectiveFailureCode,
                error: `CloudFormation stack status: ${stackStatus}`,
                // Mirror the relay's own failed-install result shape, so the
                // status derivation's failure.awsStatus (extractStackStatus)
                // finds the stack status a late /result can no longer deliver
                // (alreadySettled discards its output).
                output: { stackStatus },
                settledFrom: 'stack-event-progress',
              },
              finishedAt: now,
              lastProgressAt: now,
              failureCode: effectiveFailureCode,
            })
            .where(
              and(
                eq(schema.deploymentJobs.id, job.id),
                inArray(schema.deploymentJobs.state, ['REQUESTED', 'QUEUED', 'WAITING', 'RUNNING']),
              ),
            )
            .returning();
          // First writer wins: /result (or an earlier batch) already settled
          // this job — its state transition and event stand unchanged.
          if (settled.length === 0) return;
          if (nextState) {
            await tx
              .update(schema.deployments)
              .set({ state: nextState })
              .where(eq(schema.deployments.id, deployment.id));
          }
          const eventType = JOB_RESULT_EVENT[job.type]?.failed;
          if (eventType) {
            await recordEvent(tx, {
              organizationId: deployment.organizationId,
              eventType,
              actorType: 'relay',
              actorId: deployment.installationId ?? deployment.id,
              deploymentId: deployment.id,
              customerId: deployment.customerId,
              jobId: job.id,
              previousState: deployment.state,
              requestedState: nextState ?? null,
              result: 'failure',
              payload: {
                failureCode: effectiveFailureCode,
                ...(effectiveFailureCode !== 'STACK_CREATE_FAILED'
                  ? { reportedFailureCode: 'STACK_CREATE_FAILED' }
                  : {}),
                stackStatus,
                settledFrom: 'stack-event-progress',
              },
            });
          }
        });
      }
    } else if (job.type === 'INSTALL' && job.state === 'FAILED') {
      // The AWS rollback keeps running after settlement and the relay keeps
      // streaming its events — but a late /result can no longer deliver the
      // terminal stack status (alreadySettled discards its output). Keep the
      // settled result's stack status current from the same events, so the
      // failure surfaces the terminal AWS status exactly as the relay's own
      // report would have. An interim status never downgrades a terminal one
      // (the /result-won case already carries the terminal status).
      const settledRows = await db
        .select()
        .from(schema.deploymentStackEvents)
        .where(
          and(
            eq(schema.deploymentStackEvents.deploymentId, deployment.id),
            eq(schema.deploymentStackEvents.jobId, job.id),
          ),
        )
        .orderBy(schema.deploymentStackEvents.eventAt, schema.deploymentStackEvents.id);
      const settledEvents: StoredStackEvent[] = settledRows.map((row) => ({
        eventAt: row.eventAt,
        logicalResourceId: row.logicalResourceId,
        resourceType: row.resourceType,
        resourceStatus: row.resourceStatus,
        resourceStatusReason: row.resourceStatusReason,
      }));
      const settledSnapshot = summarizeStackEvents(body.stackName, settledEvents, now.toISOString());
      const latestStatus =
        settledSnapshot !== null && typeof settledSnapshot['stackStatus'] === 'string'
          ? settledSnapshot['stackStatus']
          : null;
      const recordedStatus = (job.result as { output?: { stackStatus?: string } } | null | undefined)?.output
        ?.stackStatus;
      const interimStatus = latestStatus === 'ROLLBACK_IN_PROGRESS' || latestStatus === 'DELETE_IN_PROGRESS';
      const downgrade =
        interimStatus && recordedStatus !== null && recordedStatus !== 'ROLLBACK_IN_PROGRESS' && recordedStatus !== 'DELETE_IN_PROGRESS';
      if (
        latestStatus !== null &&
        !downgrade &&
        INSTALL_FAILURE_STACK_STATUSES.has(latestStatus) &&
        recordedStatus !== latestStatus
      ) {
        const result = (job.result ?? {}) as Record<string, unknown>;
        const output = (result['output'] ?? {}) as Record<string, unknown>;
        await db
          .update(schema.deploymentJobs)
          .set({ result: { ...result, output: { ...output, stackStatus: latestStatus } } })
          .where(eq(schema.deploymentJobs.id, job.id));
      }
    }

    request.log.info({
      deploymentId: deployment.id,
      jobId: job.id,
      stackName: body.stackName,
      accepted,
      event: 'relay:stack-events-ingested',
    });

    return reply.code(200).send({ accepted });
  });

  app.post('/api/relay/health', async (request, reply) => {
    const token = requireBearerToken(request);
    const body = request.body as {
      installationId?: string;
      observedState?: Record<string, unknown>;
      healthStatus?: string;
      components?: Record<string, unknown>;
      runningImageDigest?: string | null;
      identity?: {
        awsAccountId?: string;
        relayVersion?: string;
        bootstrapVersion?: string;
        capabilities?: unknown;
      };
    };
    const deployment = await requireRelayDeployment(
      body?.installationId,
      token,
      oldRelayToken(request),
    );

    const healthStatusParsed = healthStatusSchema.safeParse(body.healthStatus);
    // Identity rides every heartbeat (token-authenticated), so a deployment
    // enrolled before these columns existed self-repairs its account id,
    // relay version and capabilities without re-enrollment.
    const identity = body?.identity;
    const capabilitiesParsed = identity?.capabilities
      ? relayCapabilitiesSchema.safeParse(identity.capabilities)
      : undefined;
    // §24 per-component health rides in observed_state — the column already
    // exists for exactly this and needs no migration. The relay reports only
    // the components a deployment actually has, which is what lets the detail
    // page stop rendering a Database row for an app with no database.
    const componentsParsed = body.components
      ? healthComponentsSchema.safeParse(body.components)
      : undefined;
    const observedState =
      componentsParsed?.success === true
        ? { ...(body.observedState ?? deployment.observedState ?? {}), components: componentsParsed.data }
        : (body.observedState ?? deployment.observedState ?? {});
    // The runtime digest rides observedState too, so the raw truth survives
    // even when it cannot be reconciled to a release.
    if (body?.runningImageDigest !== undefined) {
      (observedState as Record<string, unknown>)['runningImageDigest'] = body.runningImageDigest;
    }
    // The relay's verification checks carry free text (stack names, AWS
    // error codes) that the vendor diagnostics page shows behind its
    // technical disclosure — redacted at ingest, as stack-event reasons are.
    const infraChecks = (observedState as { infraHealth?: { checks?: unknown } } | null)?.infraHealth?.checks;
    if (Array.isArray(infraChecks)) {
      for (const check of infraChecks) {
        if (check !== null && typeof check === 'object' && typeof (check as { detail?: unknown }).detail === 'string') {
          (check as { detail: string }).detail = redactSecrets((check as { detail: string }).detail);
        }
      }
    }

    // §10.2 HTTP probe ingest: the relay reports what it measured this poll
    // (status/latency/time — never a body); the control plane maintains the
    // last-success / last-failed timestamps across heartbeats so the record
    // always answers "when did this app last answer?" as well as "what did it
    // answer just now?". A malformed probe is dropped untouched — an old relay
    // sending none keeps whatever was already stored.
    const rawProbe = (observedState as Record<string, unknown> | null)?.['httpProbe'];
    const probeParsed = rawProbe === undefined ? undefined : httpProbeSchema.safeParse(rawProbe);
    if (probeParsed?.success === true) {
      const previousProbe = (deployment.observedState as { httpProbe?: Record<string, unknown> } | null)
        ?.httpProbe;
      const previousLastSuccessAt =
        typeof previousProbe?.['lastSuccessAt'] === 'string'
          ? (previousProbe['lastSuccessAt'] as string)
          : null;
      const previousLastFailedAt =
        typeof previousProbe?.['lastFailedAt'] === 'string'
          ? (previousProbe['lastFailedAt'] as string)
          : null;
      (observedState as Record<string, unknown>)['httpProbe'] = {
        ok: probeParsed.data.ok,
        statusCode: probeParsed.data.statusCode,
        latencyMs: probeParsed.data.latencyMs,
        checkedAt: probeParsed.data.checkedAt,
        ...(probeParsed.data.error !== undefined ? { error: probeParsed.data.error } : {}),
        lastSuccessAt: probeParsed.data.ok ? probeParsed.data.checkedAt : previousLastSuccessAt,
        lastFailedAt: probeParsed.data.ok ? previousLastFailedAt : probeParsed.data.checkedAt,
      };
    }

    // Release evidence: only THIS heartbeat's own report counts, never the
    // state stored by an earlier one. The verdict is stamped into observedState
    // for the status derivation; a connector that sends no evidence is stamped
    // EVIDENCE_MISSING, which flags it for upgrade.
    const evidence = assessReleaseEvidence(
      deployment,
      (body.observedState as Record<string, unknown> | undefined)?.['releaseEvidence'],
    );
    (observedState as Record<string, unknown>)['releaseVerdict'] = {
      pass: evidence.accepted,
      reason: evidence.reason,
      notStarted: evidence.notStarted,
      evaluatedAt: new Date().toISOString(),
    };

    const previousHealth = deployment.healthStatus;
    const nextHealth = healthStatusParsed.success ? healthStatusParsed.data : previousHealth;
    // Edge-triggered: the rollout failure is recorded once per observed
    // failure, not on every heartbeat while it stays failed.
    const previousRolloutState = (
      deployment.observedState as { deploymentRolloutState?: string } | null
    )?.deploymentRolloutState;
    const nextRolloutState = (observedState as Record<string, unknown> | null)?.[
      'deploymentRolloutState'
    ];
    const rolloutNewlyFailed =
      nextRolloutState === 'FAILED' && previousRolloutState !== 'FAILED';
    // Observed state wins over a stale FAILED: a failed day-2 operation no
    // longer marks the deployment FAILED (deploymentStateAfterFailedJob
    // restores a live state), but rows written before that rule — or any
    // edge path that still lands on FAILED with a running release — self-heal
    // here: a healthy heartbeat is the ground truth that the deployment is
    // running. A failed FIRST install (no release ever deployed) has nothing
    // running and stays FAILED until retried.
    // ...but not when what failed was a DESTROY: the app still serving is
    // exactly the problem then, and flipping back to HEALTHY would hide the
    // stuck teardown the vendor explicitly asked for.
    const stateRecovered =
      nextHealth === 'HEALTHY' &&
      evidence.accepted &&
      deployment.state === 'FAILED' &&
      deployment.currentReleaseId !== null &&
      !(await latestJobIsDestroy(db, deployment.id));
    // INSTALL succeeded (CFN stack complete) but the deployment is still
    // INSTALLING: runtime verification is what earns HEALTHY, and this is the
    // only place it can land. Guarded by the INSTALL job actually having
    // finished — a healthy-looking heartbeat racing ahead of the INSTALL
    // result must not bill or label the deployment before the install settled.
    const installVerifiedHealthy =
      deployment.state === 'INSTALLING' &&
      nextHealth === 'HEALTHY' &&
      evidence.accepted &&
      (await hasSucceededInstall(db, deployment.id));

    await db.transaction(async (tx) => {
      await tx
        .update(schema.deployments)
        .set({
          observedState,
          relayStatus: 'CONNECTED',
          lastHealthAt: new Date(),
          ...(stateRecovered ? { state: 'HEALTHY' as const } : {}),
          ...(installVerifiedHealthy ? { state: 'HEALTHY' as const } : {}),
          ...(healthStatusParsed.success ? { healthStatus: healthStatusParsed.data } : {}),
          ...(identity?.awsAccountId ? { awsAccountId: identity.awsAccountId } : {}),
          ...(typeof identity?.relayVersion === 'string' ? { relayVersion: identity.relayVersion } : {}),
          ...(typeof identity?.bootstrapVersion === 'string'
            ? { bootstrapVersion: identity.bootstrapVersion }
            : {}),
          ...(capabilitiesParsed?.success ? { relayCapabilities: capabilitiesParsed.data } : {}),
        })
        .where(eq(schema.deployments.id, deployment.id));

      // Only a CHANGE is worth an event — the relay reports on every poll and
      // an append-only log of "still healthy" would bury everything else.
      // An intentional zero-task state (a configured first start still
      // waiting) is not an outage and records no health event.
      if (nextHealth !== previousHealth && !(evidence.notStarted && nextHealth !== 'HEALTHY')) {
        await recordEvent(tx, {
          organizationId: deployment.organizationId,
          eventType:
            nextHealth === 'HEALTHY' ? 'health.recovered' : nextHealth === 'UNHEALTHY' ? 'health.unhealthy' : 'health.degraded',
          actorType: 'relay',
          actorId: deployment.installationId ?? deployment.id,
          deploymentId: deployment.id,
          customerId: deployment.customerId,
          previousState: previousHealth,
          requestedState: nextHealth,
          result: nextHealth === 'HEALTHY' ? 'success' : 'failure',
          payload: componentsParsed?.success ? { components: componentsParsed.data } : {},
        });
      }

      if (stateRecovered) {
        await recordEvent(tx, {
          organizationId: deployment.organizationId,
          eventType: 'deployment.state_recovered',
          actorType: 'relay',
          actorId: deployment.installationId ?? deployment.id,
          deploymentId: deployment.id,
          customerId: deployment.customerId,
          previousState: 'FAILED',
          requestedState: 'HEALTHY',
          result: 'success',
          payload: {},
        });
      }

      if (rolloutNewlyFailed) {
        await recordEvent(tx, {
          organizationId: deployment.organizationId,
          eventType: 'ecs.rollout_failed',
          actorType: 'relay',
          actorId: deployment.installationId ?? deployment.id,
          deploymentId: deployment.id,
          customerId: deployment.customerId,
          result: 'failure',
          payload: { deploymentRolloutState: 'FAILED' },
        });
      }
    });

    // Bounded install verification: an application that never passes release
    // evidence must not stay INSTALLING forever. Best-effort like the other
    // post-write steps; the next heartbeat retries.
    if (deployment.state === 'INSTALLING') {
      try {
        await failUnverifiedInstall(
          deployment,
          evidence,
          (body.observedState as Record<string, unknown> | undefined)?.['releaseEvidence'],
        );
      } catch (error) {
        request.log.warn({ err: error }, 'install verification check failed');
      }
    }

    // §59 inventory persistence: the relay is the ONLY pipeline that observes
    // AWS — this stores the raw ListStackResources read it transported.
    // Absent inventory (read failed / stack gone) passes null, a no-op that
    // preserves the last complete snapshot — a partial read must never
    // overwrite a good one. Classification joins the deployment's frozen
    // spec's ownership records on logical id; unlisted resources fall back
    // to type-based classifyResource. A persistence error never fails the
    // heartbeat.
    try {
      const infraHealth = (observedState as Record<string, unknown> | null)?.['infraHealth'] as
        | { inventory?: { stackId: string; resources: ObservedStackResource[]; observedAt: string } }
        | null
        | undefined;
      const inventory = infraHealth?.inventory ?? null;
      const spec = readStoredDeploymentSpec(deployment.specV2);
      const classifications = spec ? ownershipClassificationsFromSpec(spec) : null;
      await persistDeploymentResourceSnapshot(db, {
        deploymentId: deployment.id,
        stackId: inventory?.stackId ?? '',
        resources: inventory?.resources ?? null,
        observedAt: inventory?.observedAt ?? new Date().toISOString(),
        ...(classifications ? { classificationByLogicalId: classifications } : {}),
      });
    } catch (error) {
      request.log.warn({ err: error }, 'infrastructure inventory persistence failed');
    }

    // Runtime truth wins: reconcile the deployment's release pointer to the
    // digest this heartbeat's release evidence proved running — but ONLY when
    // the evidence passes in full (§10.3). Failures here must not fail the
    // heartbeat itself.
    if (evidence.accepted && evidence.digest !== null && evidence.observedAt !== null) {
      try {
        await reconcileRunningDigest(deployment, evidence.digest, evidence.observedAt);
      } catch (error) {
        request.log.warn({ err: error }, 'runtime digest reconciliation failed');
      }
    }

    // Repair the follow-ups of a recent successful INSTALL whose result route
    // died before queuing them (see ensureInstallFollowUps). The install job's
    // result records the decision, so a settled install costs one read.
    try {
      const [install] = await db
        .select()
        .from(schema.deploymentJobs)
        .where(and(eq(schema.deploymentJobs.deploymentId, deployment.id), eq(schema.deploymentJobs.type, 'INSTALL')))
        .orderBy(desc(schema.deploymentJobs.createdAt))
        .limit(1);
      if (
        install?.state === 'SUCCEEDED' &&
        install.result?.['followUps'] === undefined &&
        install.finishedAt !== null &&
        Date.now() - install.finishedAt.getTime() <= INSTALL_FOLLOW_UP_REPAIR_WINDOW_MS
      ) {
        await ensureInstallFollowUps(deployment, install);
      }
    } catch (error) {
      request.log.warn({ err: error }, 'install follow-up repair failed');
    }

    // A heartbeat is a progress signal for the deployment's active mutating
    // jobs: the relay is alive and still owes their answers, so the watchdog
    // must not time them out on this tick's evidence.
    await db
      .update(schema.deploymentJobs)
      .set({ lastProgressAt: new Date() })
      .where(
        and(
          eq(schema.deploymentJobs.deploymentId, deployment.id),
          inArray(schema.deploymentJobs.state, ['REQUESTED', 'QUEUED', 'WAITING', 'RUNNING']),
        ),
      );

    // Custom-domain auto-check piggybacks on the ~5-minute relay heartbeat —
    // the existing background cadence, no new scheduler. Best-effort: a DNS
    // hiccup must never fail a health report.
    const activeDomain = await findActiveDomain(db, deployment.id);
    if (
      activeDomain &&
      ['PENDING', 'WAITING_FOR_DNS', 'CONFIGURING', 'REMOVING'].includes(activeDomain.status) &&
      (!activeDomain.lastCheckedAt || Date.now() - activeDomain.lastCheckedAt.getTime() > 180_000)
    ) {
      try {
        await runDomainCheck(db, deployment, activeDomain, domainCheckDeps);
      } catch {
        // swallowed — heartbeat must succeed regardless
      }
    }

    // Phase 11 default-HTTPS driver rides the same cadence: every heartbeat
    // on an installed deployment nudges the machine one step (request the
    // cert, write the deployz-zone records, re-describe, probe, activate).
    // A running INSTALL starts it early so certificate validation overlaps
    // stack creation. Best-effort for the same reason as the custom-domain
    // check above.
    if (['INSTALLING', 'HEALTHY', 'UPDATING', 'UPDATE_AVAILABLE'].includes(deployment.state)) {
      try {
        await runDefaultHttpsCheck(db, deployment, defaultHttpsDeps);
      } catch {
        // swallowed — heartbeat must succeed regardless
      }
    }

    // Best-effort step-timings follow-up (see advanceStepTimingsAfterWrite) —
    // derived from the values THIS heartbeat just wrote, not the stale
    // pre-transaction `deployment`. Reuses `activeDomain` above instead of
    // looking it up again.
    try {
      await advanceStepTimingsAfterWrite(
        db,
        paddle,
        {
          ...deployment,
          observedState: observedState as Record<string, unknown> | null,
          relayStatus: 'CONNECTED',
          lastHealthAt: new Date(),
          ...(stateRecovered ? { state: 'HEALTHY' as const } : {}),
          ...(installVerifiedHealthy ? { state: 'HEALTHY' as const } : {}),
          ...(healthStatusParsed.success ? { healthStatus: healthStatusParsed.data } : {}),
        },
        activeDomain,
      );
    } catch (error) {
      request.log.warn({ err: error }, 'step-timings advance failed');
    }

    return reply.code(200).send({ received: true });
  });

  // §31 relay config fetch — the CONFIG_UPDATE executor calls this over its
  // authenticated channel to learn the effective desired configuration
  // before applying it. Plain values travel; secret values do NOT (they are
  // write-only in the control plane and already live in the customer's
  // Secrets Manager — the relay only needs their key names).
  app.get('/api/relay/config', async (request) => {
    const token = requireBearerToken(request);
    const { installationId } = request.query as { installationId?: string };
    const deployment = await requireRelayDeployment(
      installationId,
      token,
      oldRelayToken(request),
    );

    // Phase 4: generated keys ride along as `generated: true` entries (no
    // value — the relay mints them inside the customer's account).
    // DEPLOY-027 (Phase 4): the vault is the relay's only decryption seam.
    // It lists bound rows, decrypts per key with the stored KMS context, and
    // stamps delivery on every successful decrypt. A decrypt failure logs
    // ids only, omits the value, and keeps the row so the next relay cycle
    // can retry — plaintext never appears in this response's envelope.
    const defaultHostname = { prefix: defaultHttpsDeps.prefix, zone: defaultHttpsDeps.apex };
    const entries = await buildRelayConfigEntries(db, { ...deployment, defaultHostname }, configStore, {
      async readBound(deploymentId, key) {
        const rows = await pendingSecrets.listBoundForDeployment(deploymentId);
        const row = rows.find((candidate) => candidate.key === key);
        if (row === undefined) return undefined;
        try {
          const plaintext = await cipher.decrypt(row.ciphertext, row.encryptionContext);
          await pendingSecrets.stampDelivery(deploymentId, key);
          return plaintext;
        } catch (error) {
          request.log.warn(
            { err: error, deploymentId, key },
            'pending-secret decrypt failed; omitting value, keeping row',
          );
          return undefined;
        }
      },
      async stampDelivery(deploymentId, key) {
        await pendingSecrets.stampDelivery(deploymentId, key);
      },
      // VENDOR-scope secrets never bind a pending-secret row (that path is
      // customer-only) — they decrypt straight off the application_configs
      // ciphertext (apps/api/src/config.ts's listVendorValues does the same
      // decrypt for build variables).
      async readVendorSecret(applicationId, key) {
        const values = await listVendorValues(db, applicationId, [key], cipher);
        return values[key];
      },
    });
    return { entries };
  });

  return app;
}
