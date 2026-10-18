import { z } from 'zod';

import { regionSchema, isSupportedRegion } from './regions.js';

export * from './regions.js';

export * from './infrastructure.js';
export * from './manifest.js';
export * from './environment-setup.js';
export * from './application-analysis.js';
export * from './components.js';
export * from './aws-resources.js';
export * from './plan.js';
export * from './plan-components.js';
export * from './footprint.js';
export * from './pricing.js';
export * from './profile.js';
export * from './tags.js';
export * from './application-graph.js';
export * from './capability-registry.js';
export * from './deployz-ir.js';
export * from './deployment-spec-v2.js';
export * from './schedule.js';
export * from './release-evidence.js';

// Shared Zod contracts between api and web. Shapes mirror the Drizzle schema
// in @deployz/db (packages/db/src/schema/*.ts) exactly — the db stays the
// source of truth; these are the WIRE forms (timestamptz -> ISO datetime
// strings, date -> ISO date strings, jsonb -> record). Parity with the live
// pgEnums is locked by index.test.ts.
//
// Enum values cite the plan sections (`.omo/plans/deployz-mvp.md`) whose
// vocabulary they implement. Copy values verbatim from packages/db/src/enums.ts.

export const PACKAGE_NAME = '@deployz/contracts';

// ---------------------------------------------------------------------------
// Enums (parity-tested against @deployz/db pgEnums)
// ---------------------------------------------------------------------------

// applications.analysis_status — repository analysis lifecycle (§18/§19).
export const analysisStatusSchema = z.enum(['PENDING', 'ANALYZING', 'COMPLETE', 'FAILED']);
export type AnalysisStatus = z.infer<typeof analysisStatusSchema>;

// applications.compatibility_status — persisted §19 verdict.
export const compatibilityStatusSchema = z.enum(['READY', 'NEEDS_ATTENTION', 'NOT_COMPATIBLE']);
export type CompatibilityStatus = z.infer<typeof compatibilityStatusSchema>;

// releases.release_status — image build lifecycle.
export const releaseStatusSchema = z.enum(['BUILDING', 'READY', 'FAILED']);
export type ReleaseStatus = z.infer<typeof releaseStatusSchema>;

// deployments.source — origin attribution of a deployment row.
export const deploymentSourceSchema = z.enum(['manual', 'deploy_link', 'public_link']);
export type DeploymentSource = z.infer<typeof deploymentSourceSchema>;

// Region ownership for an installation entry point (MVP Readiness 2, Phase 2).
// 'customer' = the customer makes the final Region choice at confirmation;
// 'legacy_publisher_fixed' = a pre-existing link whose Region the vendor fixed.
export const regionSelectionSchema = z.enum(['customer', 'legacy_publisher_fixed']);
export type RegionSelection = z.infer<typeof regionSelectionSchema>;

// deployments.deployment_type — provider-independent classification (Paddle
// migration Phase 2). Replaces is_test_deployment: a TEST deployment never
// becomes billable (apps/api/src/billing-domain.ts).
export const deploymentTypeSchema = z.enum(['TEST', 'PRODUCTION']);
export type DeploymentType = z.infer<typeof deploymentTypeSchema>;

// deployments.billing_state — Paddle migration Phase 2 billing state machine.
// NOT_STARTED -> ACTIVE on the deployment's first READY stage, ACTIVE ->
// STOPPED once removal is accepted. STOPPED is terminal.
export const deploymentBillingStateSchema = z.enum(['NOT_STARTED', 'ACTIVE', 'STOPPED']);
export type DeploymentBillingState = z.infer<typeof deploymentBillingStateSchema>;

// organization.included_production_deployments — the admin-set number of live
// PRODUCTION deployments an organization may run before the per-deployment
// charge applies. Pooled and concurrent, never consumed. The billable Paddle
// quantity is max(active - included, 0) (apps/api/src/billing-domain.ts).
// The upper bound is a sanity cap, mirrored by the database CHECK constraint.
export const INCLUDED_PRODUCTION_DEPLOYMENTS_MAX = 10000;
export const includedProductionDeploymentsSchema = z
  .number()
  .int()
  .min(0)
  .max(INCLUDED_PRODUCTION_DEPLOYMENTS_MAX);

// §46 deployment states — product vocabulary. Customers never see raw
// CFN/ECS internals; these ten states are the whole user-facing model.
export const deploymentStateSchema = z.enum([
  'NOT_INSTALLED',
  'WAITING_FOR_RELAY',
  'INSTALLING',
  'HEALTHY',
  'UPDATING',
  'UPDATE_AVAILABLE',
  'FAILED',
  'DISCONNECTED',
  'DELETING',
  'DELETED',
]);
export type DeploymentState = z.infer<typeof deploymentStateSchema>;

// §39 job types. MIGRATION is the §26 internal gated step; INFRA_UPGRADE is
// §60; HEALTH_REPORT carries relay REPORT_HEALTH payloads.
export const jobTypeSchema = z.enum([
  'INSTALL',
  'DEPLOY_RELEASE',
  'ROLLBACK',
  'RESTART',
  'CONFIG_UPDATE',
  'DESTROY',
  'MIGRATION',
  'INFRA_UPGRADE',
  'HEALTH_REPORT',
  'PREFLIGHT',
  'HEALTH_CHECK',
  'CONFIGURE_DOMAIN',
  'REMOVE_DOMAIN',
  'PURGE',
]);
export type JobType = z.infer<typeof jobTypeSchema>;

// §39 job states. WAITING semantics: the job is waiting on customer approval
// OR on relay pickup — the payload/result disambiguates which.
// SUCCESS is legacy: rows recorded before the CANARY fixes wrote it, so
// every reader accepts SUCCEEDED and SUCCESS alike. New writes always use
// SUCCEEDED; do not drop SUCCESS from the schema without a data migration
// first.
export const jobStateSchema = z.enum([
  'REQUESTED',
  'QUEUED',
  'WAITING',
  'RUNNING',
  'SUCCEEDED',
  'SUCCESS',
  'FAILED',
  'CANCELLED',
]);
export type JobState = z.infer<typeof jobStateSchema>;

/**
 * §46 deployment state a FAILED job leaves behind — shared by the relay
 * result route and the stuck-job watchdog so both settle a failure the same
 * way. A failed day-2 operation (deploy/rollback/restart) on a deployment
 * that has a running release must NOT mark the whole deployment FAILED: the
 * previous release keeps serving (the ECS circuit breaker restores it), so
 * the deployment stays in a live state and the FAILED job itself carries the
 * failure. Only a first install (nothing ever ran) or a destroy failure
 * represents the deployment itself being broken.
 *
 * Returns `null` when the failure must not touch the deployment state at
 * all: CONFIG_UPDATE is non-disruptive in both directions, and a failed
 * PURGE happens on an already-DELETED deployment (flipping it to FAILED
 * would resurrect it).
 */
export function deploymentStateAfterFailedJob(input: {
  jobType: JobType;
  hasCurrentRelease: boolean;
  newerReadyReleaseExists: boolean;
}): 'FAILED' | 'HEALTHY' | 'UPDATE_AVAILABLE' | null {
  switch (input.jobType) {
    case 'DEPLOY_RELEASE':
    case 'ROLLBACK':
    case 'RESTART':
      if (!input.hasCurrentRelease) return 'FAILED';
      // The state the deployment held before the operation started: a READY
      // release newer than the one running is exactly what UPDATE_AVAILABLE
      // means (the failed candidate itself qualifies).
      return input.newerReadyReleaseExists ? 'UPDATE_AVAILABLE' : 'HEALTHY';
    case 'CONFIG_UPDATE':
    case 'PURGE':
      return null;
    default:
      return 'FAILED';
  }
}

// §61 failure codes — stable taxonomy from day one. Todo 27 (classifier
// pipeline) may extend this set; nothing else may invent codes.
export const failureCodeSchema = z.enum([
  'AWS_SCP_BLOCKED',
  'PORT_MISMATCH',
  'REGION_NOT_SUPPORTED',
  'QUOTA_EXCEEDED',
  'IMAGE_HEALTH_CHECK_FAILED',
  'MIGRATION_FAILED',
  'RELAY_DISCONNECTED',
  'ECS_DEPLOYMENT_FAILED',
  'RDS_UNAVAILABLE',
  'AWS_PERMISSION_DENIED',
  'STACK_CREATE_FAILED',
  'STACK_DELETE_FAILED',
  'RDS_AZ_CAPACITY',
  'DATABASE_CREATE_FAILED',
  'DATABASE_CONNECTION_FAILED',
  'IMAGE_PULL_FAILED',
  'CONTAINER_START_FAILED',
  'MISSING_SECRET',
  'TEMPLATE_UNAVAILABLE',
  'UNSUPPORTED_ARCHITECTURE',
  'UNKNOWN',
  'REDIS_PROVISIONING_FAILED',
  'REDIS_CONNECTION_FAILED',
  'DOMAIN_OPERATION_TIMEOUT',
  'RELAY_STATE_WRITE_FAILED',
]);
export type FailureCode = z.infer<typeof failureCodeSchema>;

/**
 * Phase 1 structured failure evidence a relay MAY attach to a failed
 * command result: what the stopped containers said. Every field is
 * nullable so a relay that observed only part of the picture can say
 * exactly that, and the whole block is absent on relays built before
 * evidence existed. Server-side use only — the result route safeParses
 * it at ingest (parse failures are tolerated and dropped, never
 * persisted raw) and redacts its free text before storage.
 */
export const failureEvidenceSchema = z.object({
  container: z
    .object({
      /** The essential container's process exit code; null when ECS reported none. */
      exitCode: z.number().nullable(),
      /** ECS's own stop code, e.g. 'EssentialContainerExited'. */
      stopCode: z.string().nullable(),
      /** ECS's free-text stop reason — redacted at ingest before it is persisted. */
      stoppedReason: z.string().nullable(),
      /** How many stopped tasks share this verdict. */
      stoppedTaskCount: z.number().nullable(),
    })
    .nullable(),
});
export type FailureEvidence = z.infer<typeof failureEvidenceSchema>;

export const relayStatusSchema = z.enum(['CONNECTED', 'DISCONNECTED', 'UNKNOWN']);
export type RelayStatus = z.infer<typeof relayStatusSchema>;

/**
 * What a relay can actually execute. Reported at enrollment and on every
 * heartbeat; absent (null) for relays built before capabilities existed,
 * which the UI must treat as "nothing supported".
 */
export const relayCapabilitiesSchema = z
  .object({
    deployRelease: z.boolean(),
    rollback: z.boolean(),
    restart: z.boolean(),
    configUpdate: z.boolean(),
    destroy: z.boolean(),
    domainManagement: z.boolean(),
  })
  .strict();
export type RelayCapabilities = z.infer<typeof relayCapabilitiesSchema>;

/** Relay identity block sent with registration and heartbeats. */
export const relayIdentitySchema = z
  .object({
    awsAccountId: z.string().regex(/^\d{12}$/),
    region: z.string(),
    relayVersion: z.string(),
    bootstrapVersion: z.string().nullable(),
    capabilities: relayCapabilitiesSchema,
  })
  .strict();
export type RelayIdentity = z.infer<typeof relayIdentitySchema>;

// UNKNOWN first: a deployment that has never checked in has no observed
// health, and the column defaults to it. Reporting UNKNOWN is a relay saying
// "I cannot tell", which is different from saying nothing at all.
export const healthStatusSchema = z.enum(['UNKNOWN', 'HEALTHY', 'DEGRADED', 'UNHEALTHY']);

/**
 * §24 per-component health. Every field optional — the relay reports only the
 * components a deployment actually has, so an application with no database
 * simply omits it rather than claiming one is healthy. Beyond the five fixed
 * keys, any additional key is a WORKLOAD id (Phase 4A — one health entry per
 * compiled workload service, e.g. `web`, `email-worker`), validated as a
 * health status by the catchall so per-workload reporting needs no schema
 * change per workload.
 */
export const healthComponentsSchema = z
  .object({
    application: healthStatusSchema.optional(),
    database: healthStatusSchema.optional(),
    storage: healthStatusSchema.optional(),
    loadBalancer: healthStatusSchema.optional(),
    redis: healthStatusSchema.optional(),
  })
  .catchall(healthStatusSchema.optional());
export type HealthComponents = z.infer<typeof healthComponentsSchema>;
export type HealthStatus = z.infer<typeof healthStatusSchema>;

/**
 * §10.2 one HTTP health-path probe. The relay measures status code, latency
 * and the check time, and NEVER a response body; the control plane maintains
 * `lastSuccessAt`/`lastFailedAt` across heartbeats. `error` is a short
 * transport reason (timeout / unreachable) — never application output.
 */
export const httpProbeSchema = z
  .object({
    /** A 2xx response — the only outcome that counts as a successful check. */
    ok: z.boolean(),
    /** HTTP status code; null when the request failed before one arrived. */
    statusCode: z.number().int().nullable(),
    /** Round-trip latency in milliseconds. */
    latencyMs: z.number().int().nullable(),
    /** ISO 8601 — when this probe ran. */
    checkedAt: z.string().datetime({ offset: true }),
    error: z.string().max(500).optional(),
    /** ISO 8601 — the most recent successful check, maintained by the control plane. */
    lastSuccessAt: z.string().datetime({ offset: true }).nullable().optional(),
    /** ISO 8601 — the most recent failed check, maintained by the control plane. */
    lastFailedAt: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict();
export type HttpProbe = z.infer<typeof httpProbeSchema>;

/** The ALB target-count half of the runtime-health layers (§10.1). */
export const healthTargetsSchema = z
  .object({
    desiredCount: z.number().int().nullable(),
    runningCount: z.number().int().nullable(),
    unhealthyTargetCount: z.number().int().nullable(),
    pendingTargetCount: z.number().int().nullable(),
    unknownTargetCount: z.number().int().nullable(),
  })
  .strict();
export type HealthTargets = z.infer<typeof healthTargetsSchema>;

/**
 * §10.1 layered runtime health — the five layers that must never be
 * collapsed into one number: infrastructure status (verification), ECS
 * rollout state, ALB target health, HTTP application health, and relay
 * connectivity. Each layer reports what its own source observed; one broken
 * layer never masquerades as another.
 */
export const runtimeHealthLayersSchema = z
  .object({
    /** Verification's verdict on the stack — HEALTHY/UNHEALTHY/UNKNOWN. */
    infrastructure: healthStatusSchema.nullable(),
    /** The ECS PRIMARY deployment's rollout state, when ECS reported one. */
    rollout: z.enum(['COMPLETED', 'IN_PROGRESS', 'FAILED']).nullable(),
    /** ECS + ALB counts, when the runtime-health observation reported them. */
    targets: healthTargetsSchema.nullable(),
    /** The latest HTTP probe of the application's health path, when one ran. */
    http: httpProbeSchema.nullable(),
    /** Relay connectivity, persisted by the liveness sweep / heartbeat. */
    relay: z.enum(['CONNECTED', 'DISCONNECTED', 'UNKNOWN']),
  })
  .strict();
export type RuntimeHealthLayers = z.infer<typeof runtimeHealthLayersSchema>;

// Paddle migration Phase 3 — minimal billing schema. `provider` exists so a
// row says what it is, nothing more; this is not a multi-provider system.
export const billingProviderSchema = z.enum(['PADDLE']);
export type BillingProvider = z.infer<typeof billingProviderSchema>;

// billing_subscriptions.status — mirrors the Paddle subscription lifecycle
// this control plane cares about.
export const billingSubscriptionStatusSchema = z.enum([
  'ACTIVE',
  'PAST_DUE',
  'PAUSED',
  'CANCELED',
]);
export type BillingSubscriptionStatus = z.infer<typeof billingSubscriptionStatusSchema>;

// billing_provider_events.processing_status — webhook event lifecycle.
export const billingEventProcessingStatusSchema = z.enum([
  'RECEIVED',
  'PROCESSED',
  'IGNORED',
  'FAILED',
]);
export type BillingEventProcessingStatus = z.infer<typeof billingEventProcessingStatusSchema>;

// billing_reconciliation_events.status — outcome of one reconciliation pass.
export const billingReconciliationStatusSchema = z.enum(['SUCCEEDED', 'FAILED', 'SKIPPED']);
export type BillingReconciliationStatus = z.infer<typeof billingReconciliationStatusSchema>;

// billing_checkout_intents.status — Paddle migration Phase 8. A production
// deployment the vendor asked for before there was a subscription: PENDING
// until the subscription activates, then COMPLETED (the deployment row now
// exists), FAILED (creating it did not work) or SUPERSEDED (the vendor
// started a newer checkout).
export const billingCheckoutIntentStatusSchema = z.enum([
  'PENDING',
  'COMPLETED',
  'FAILED',
  'EXPIRED',
]);
export type BillingCheckoutIntentStatus = z.infer<typeof billingCheckoutIntentStatusSchema>;

export const buildStatusSchema = z.enum(['PENDING', 'BUILDING', 'SUCCEEDED', 'FAILED']);
export type BuildStatus = z.infer<typeof buildStatusSchema>;

export const customDomainStatusSchema = z.enum([
  'PENDING',
  'WAITING_FOR_DNS',
  'CONFIGURING',
  'ACTIVE',
  'ERROR',
  'REMOVING',
]);
export type CustomDomainStatus = z.infer<typeof customDomainStatusSchema>;

export const cleanupStateSchema = z.enum(['SKIPPED_RELAY_OFFLINE', 'PURGE_FAILED', 'COMPLETE']);
export type CleanupState = z.infer<typeof cleanupStateSchema>;

// ---------------------------------------------------------------------------
// Unified deployment status — a read-time derivation, not a persisted state.
//
// Customers (the public install page) and vendors (the fleet/detail screens)
// both need "where is this deployment right now", but today that answer is
// scattered across deployments.state, deployments.healthStatus,
// deployments.relayStatus, the newest deployment_jobs row, and custom_domains
// — four sources a page would otherwise have to reconcile itself, and
// disagree if two pages reconcile them differently. deriveDeploymentStatus
// (apps/api/src/deployment-status.ts) collapses all four into ONE of six
// stages, at read time, from data that already exists; nothing new is
// written to the database for this feature. The two schemas below are the
// only shapes that ever leave the derivation: customerDeploymentStatusSchema
// for the unauthenticated install-status endpoint (never relay/job/AWS
// internals), vendorDeploymentStatusSchema for the authenticated fleet/detail
// endpoints (full operational detail). Both are produced from the same
// internal derived object, so their `stage` can never disagree.
// ---------------------------------------------------------------------------

/**
 * The six-stage lifecycle every deployment's progress collapses into.
 * WAITING_FOR_AWS: the customer has not started the CloudFormation Quick
 * Create yet. CONNECTING: AWS setup ran and the relay is registering.
 * PROVISIONING: the INSTALL job is actively creating infrastructure.
 * VERIFYING: infrastructure exists, health/HTTPS are not both confirmed yet.
 * READY: healthy and reachable over HTTPS. FAILED: the deployment failed
 * (state === 'FAILED') — a relay outage never lands here, only a terminal
 * job failure does.
 */
export const deploymentStageSchema = z.enum([
  'WAITING_FOR_AWS',
  'CONNECTING',
  'PROVISIONING',
  'VERIFYING',
  'READY',
  'FAILED',
]);
export type DeploymentStage = z.infer<typeof deploymentStageSchema>;

/**
 * A read-time DERIVED sub-step of the six stages above (apps/api/src/
 * deployment-status.ts) — NOT a new persisted lifecycle; `state` and
 * `stage` remain the only source of truth. Mainly distinguishes what
 * PROVISIONING is actually doing (PREPARING/NETWORK/DATABASE_STORAGE/
 * REDIS/MIGRATION/APPLICATION), but also covers WAITING_FOR_AWS (AWS_SETUP),
 * CONNECTING (RELAY_CONNECT), VERIFYING (HEALTH_CHECK/TLS), and READY.
 * MIGRATION sits between the cache and the application: a deploy with a
 * migration command runs that command as a one-off ECS task before the
 * service update, while cache provisioning is a create-time step.
 * TLS deliberately comes AFTER HEALTH_CHECK, not before: in Deployz, HTTPS
 * (custom domain) setup only starts once health passes (`needsDomainSetup`),
 * so an earlier position in the order would misstate what happens next.
 */
export const deploymentStepSchema = z.enum([
  'AWS_SETUP',
  'RELAY_CONNECT',
  'PREPARING',
  'NETWORK',
  'DATABASE_STORAGE',
  'REDIS',
  'MIGRATION',
  'APPLICATION',
  'HEALTH_CHECK',
  'TLS',
  'READY',
]);
export type DeploymentStep = z.infer<typeof deploymentStepSchema>;

/**
 * Canonical step order. The one place the API's applicable-steps filter and
 * the UI's progress list both read from, so the two can never disagree
 * about sequence.
 */
export const DEPLOYMENT_STEP_ORDER: readonly DeploymentStep[] = [
  'AWS_SETUP',
  'RELAY_CONNECT',
  'PREPARING',
  'NETWORK',
  'DATABASE_STORAGE',
  'REDIS',
  'MIGRATION',
  'APPLICATION',
  'HEALTH_CHECK',
  'TLS',
  'READY',
];

/**
 * How long each step typically takes, in seconds — the ONLY source either
 * projection may cite for "usually takes N minutes" or a slow-step nudge;
 * nothing else hardcodes a duration. `null` means no honest range exists:
 * TLS is customer-DNS-dependent (the customer's own action, not AWS's), and
 * READY has no duration at all. These are wide, deliberately-forgiving
 * envelopes, not a promise — `takingLongerThanUsual` (apps/api/src/
 * deployment-status.ts) only fires once the active step's elapsed time
 * passes `max`.
 */
export const TYPICAL_STEP_DURATION_SECONDS: Record<DeploymentStep, { min: number; max: number } | null> = {
  AWS_SETUP: { min: 60, max: 300 },
  RELAY_CONNECT: { min: 60, max: 420 }, // relay polls every 5 min
  PREPARING: { min: 30, max: 360 },
  NETWORK: { min: 120, max: 360 },
  DATABASE_STORAGE: { min: 180, max: 720 }, // RDS dominates
  REDIS: { min: 480, max: 1200 }, // ElastiCache replication group
  MIGRATION: { min: 60, max: 600 }, // one-off ECS task before the service update
  APPLICATION: { min: 180, max: 600 }, // ECS stabilization behind CFN
  HEALTH_CHECK: { min: 60, max: 600 }, // bounded by heartbeat cadence
  TLS: null,
  READY: null,
};

/**
 * Per-component progress status. Deliberately NOT the same vocabulary as
 * healthStatusSchema: a component can be "not required" or "pending" before
 * it has ever reported health at all, states healthStatusSchema has no room
 * for.
 */
export const componentProgressStatusSchema = z.enum([
  'PENDING',
  'IN_PROGRESS',
  'READY',
  'FAILED',
  'NOT_REQUIRED',
]);
export type ComponentProgressStatus = z.infer<typeof componentProgressStatusSchema>;

/** One step in the progress list — runtime, database, storage, redis, https. */
export const componentProgressSchema = z
  .object({
    key: z.string(),
    label: z.string(),
    status: componentProgressStatusSchema,
  })
  .strict();
export type ComponentProgress = z.infer<typeof componentProgressSchema>;

/** The progress state of one spec-derived component. */
export const specComponentStateSchema = z.enum(['PENDING', 'IN_PROGRESS', 'COMPLETE', 'FAILED']);
export type SpecComponentState = z.infer<typeof specComponentStateSchema>;

/**
 * One entry of the status payloads' additive `specComponents` field — present
 * only when the deployment has a frozen spec, absent otherwise (never
 * empty-by-guess). Identity comes from the spec's ownership records.
 */
export const specComponentSchema = z
  .object({
    componentId: z.string(),
    label: z.string(),
    state: specComponentStateSchema,
    /** Supporting fact for a generic entry — customer-safe wording, never a raw AWS type. */
    detail: z.string().optional(),
  })
  .strict();
export type SpecComponent = z.infer<typeof specComponentSchema>;

/** One line of the install page's recent-activity list: a real AWS or Deployz
 *  event, never an invented one. `message` is customer copy — never a raw
 *  CloudFormation status or resource type. */
export const customerActivityItemSchema = z
  .object({
    key: z.string(),
    at: z.iso.datetime(),
    message: z.string(),
    state: z.enum(['IN_PROGRESS', 'COMPLETE', 'FAILED']),
  })
  .strict();
export type CustomerActivityItem = z.infer<typeof customerActivityItemSchema>;

/**
 * The raw facts behind the install page's collapsed "Technical details":
 * `facts` are label/value rows for the active step (stack name and status,
 * service rollout, certificate state, ...), `events` are raw CloudFormation
 * events. The customer owns the AWS account these come from, and the install
 * link is their credential. Status reasons are secret-redacted at ingest.
 * Never render any of this in the main UI.
 */
export const customerTechnicalDetailsSchema = z
  .object({
    reference: z.string(),
    facts: z.array(z.object({ label: z.string(), value: z.string() }).strict()).max(12),
    events: z
      .array(
        z
          .object({
            at: z.iso.datetime(),
            logicalResourceId: z.string(),
            resourceType: z.string(),
            resourceStatus: z.string(),
            resourceStatusReason: z.string().nullable(),
          })
          .strict(),
      )
      .max(8),
  })
  .strict();
export type CustomerTechnicalDetails = z.infer<typeof customerTechnicalDetailsSchema>;

/**
 * The public install-status wire shape (GET /api/install/:installLinkId/
 * status). Unauthenticated by design, so this is the ONLY place deployment
 * progress reaches an anonymous caller — no relay identity, no job payloads,
 * no NOT_REQUIRED components (nothing to show for a component the app never
 * asked for), no `stepTimings`. Raw AWS/CFN detail is confined to
 * `technicalDetails`; every other field is customer copy.
 *
 * The four live-provisioning fields are optional: the web app and the API
 * deploy separately, so the page must work with a response that omits them.
 */
export const customerDeploymentStatusSchema = z
  .object({
    stage: deploymentStageSchema,
    updatedAt: z.iso.datetime(),
    currentActivity: z.string(),
    step: deploymentStepSchema,
    // Applicable steps for THIS deployment, in order (REDIS present only
    // when the application requires it) — what a progress list renders.
    steps: z.array(deploymentStepSchema),
    // The active step's typical range, or null when none exists (TLS/READY).
    typicalDurationSeconds: z.object({ min: z.number().int(), max: z.number().int() }).strict().nullable(),
    takingLongerThanUsual: z.boolean(),
    removed: z.boolean(),
    statusUpdatesUnavailable: z.boolean(),
    needsDomainSetup: z.boolean(),
    components: z.array(componentProgressSchema),
    // Spec-derived component identity (phase 3) — present only when the
    // deployment has a frozen spec.
    specComponents: z.array(specComponentSchema).optional(),
    url: z.string().nullable(),
    // When the active step started — the install page's elapsed time.
    stepStartedAt: z.iso.datetime().nullable().optional(),
    // Latest meaningful real events for the active step, newest first,
    // deduplicated. Empty when AWS or Deployz has reported none.
    recentActivity: z.array(customerActivityItemSchema).max(5).optional(),
    // Set as soon as AWS reports a resource failure, before the job itself
    // is FAILED — a rollback can take many minutes to settle.
    provisioningIssue: z.object({ message: z.string() }).strict().nullable().optional(),
    // Cleanup of a failed install — deliberately independent of the lifecycle
    // stage, so a cleanup still running can never keep the deployment looking
    // in-progress. IN_PROGRESS: AWS is still removing the failed attempt's
    // resources. COMPLETE: a later verified cleanup removed them. RETAINED:
    // terminal, and some resources may intentionally remain. Null when no
    // failed attempt is being cleaned up.
    cleanup: z.enum(['IN_PROGRESS', 'COMPLETE', 'RETAINED']).nullable().optional(),
    technicalDetails: customerTechnicalDetailsSchema.nullable().optional(),
    // Populated only once the deployment is READY (enrolled): non-secret,
    // stored-deployment data. The endpoint comes from the existing `url`
    // field and last-verified from the existing `updatedAt` field, so they
    // are deliberately not duplicated here.
    awsSummary: z
      .object({
        applicationStackName: z.string(),
        region: z.string(),
        releaseVersion: z.string().nullable(),
      })
      .strict()
      .nullable()
      .optional(),
    failure: z
      .object({
        // Whether the failure belongs to the application's own
        // startup/config work — the one fact the customer card needs to say
        // "the vendor must fix this, no action is required from you". The
        // raw §61 code stays OFF this unauthenticated surface (§65); the
        // vendor projection carries it.
        ownedByApplication: z.boolean(),
        // True when the §61 recoverability class is USER_ACTION and the
        // failure is not application-owned: something in the customer's AWS
        // account or inputs must change before a retry can succeed, so the
        // page shows an actionable next step instead of the default
        // "no action required" copy.
        customerActionRequired: z.boolean(),
        customerMessage: z.string(),
        component: z.string().nullable(),
        reference: z.string(),
        technical: z
          .object({
            stage: z.string(),
            component: z.string().nullable(),
            awsStatus: z.string().nullable(),
          })
          .strict()
          .nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type CustomerDeploymentStatus = z.infer<typeof customerDeploymentStatusSchema>;

/**
 * The vendor wire shape (GET /api/deployments, GET /api/deployments/:id —
 * one `deploymentStatus` field per row). Full operational detail: relay
 * liveness, the latest job, the raw CFN stack status, NOT_REQUIRED
 * components included. `removed` is not repeated here — the surrounding
 * fleet row already carries `state` (DELETING/DELETED), which is where the
 * vendor screens have always read it from.
 */
export const vendorDeploymentStatusSchema = z
  .object({
    stage: deploymentStageSchema,
    updatedAt: z.iso.datetime(),
    currentActivity: z.string(),
    step: deploymentStepSchema,
    steps: z.array(deploymentStepSchema),
    typicalDurationSeconds: z.object({ min: z.number().int(), max: z.number().int() }).strict().nullable(),
    takingLongerThanUsual: z.boolean(),
    // When the active step started, per the resolution ladder in
    // apps/api/src/deployment-status.ts — null when nothing authoritative is
    // known yet.
    stepStartedAt: z.iso.datetime().nullable(),
    // Completed + active steps only, in order. durationSeconds is null until
    // both ends of a step are known.
    stepTimings: z.array(
      z
        .object({
          step: deploymentStepSchema,
          startedAt: z.iso.datetime(),
          completedAt: z.iso.datetime().nullable(),
          durationSeconds: z.number().int().nullable(),
        })
        .strict(),
    ),
    statusUpdatesUnavailable: z.boolean(),
    needsDomainSetup: z.boolean(),
    components: z.array(componentProgressSchema),
    // Spec-derived component identity (phase 3) — present only when the
    // deployment has a frozen spec.
    specComponents: z.array(specComponentSchema).optional(),
    relay: z
      .object({
        connected: z.boolean(),
        lastSeenAt: z.iso.datetime().nullable(),
      })
      .strict(),
    job: z
      .object({
        type: jobTypeSchema,
        status: jobStateSchema,
      })
      .strict()
      .nullable(),
    aws: z.object({ stackStatus: z.string().nullable() }).strict(),
    health: z
      .object({
        status: healthStatusSchema,
        // §10.1 layered runtime health — see runtimeHealthLayersSchema. Never
        // collapsed into the scalar `status` above.
        layers: runtimeHealthLayersSchema,
        // Every workload is intentionally at zero tasks (a configured first
        // start still waiting) — a runtime condition, not an outage.
        notStarted: z.boolean(),
      })
      .strict(),
    // Which release is serving and whether relay evidence confirms it.
    servingRelease: z
      .object({
        releaseId: z.uuid().nullable(),
        confirmedAt: z.iso.datetime().nullable(),
        confirmed: z.boolean(),
      })
      .strict(),
    // The connector sends no release evidence, so it can neither promote a
    // release nor verify readiness.
    connector: z
      .object({
        upgradeRequired: z.boolean(),
        reason: z.literal('RELEASE_EVIDENCE_MISSING').nullable(),
        // A customer-approved connector update is on offer: the connector is
        // too old to verify releases, or reports another build than the one
        // currently published. The customer performs it in their own AWS
        // account (updating the existing stack keeps its credential).
        updateAvailable: z.boolean(),
        // Console page of the existing connector stack, and the template URL
        // to choose at "Replace existing template".
        updateUrl: z.string().nullable(),
        updateTemplateUrl: z.string().nullable(),
      })
      .strict(),
    url: z.string().nullable(),
    failure: z
      .object({
        code: failureCodeSchema.nullable(),
        component: z.string().nullable(),
        reference: z.string(),
        message: z.string(),
        awsStatus: z.string().nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type VendorDeploymentStatus = z.infer<typeof vendorDeploymentStatusSchema>;

/**
 * How long a relay may stay silent (three missed five-minute polls) before it
 * counts as DISCONNECTED. Shared by the API's liveness module and the worker's
 * scheduled sweep — the sweep persists it, every read afterwards trusts the
 * persisted column, so the two must agree on the threshold.
 */
export const RELAY_STALE_AFTER_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// STUCK jobs — shared by the worker's stuck-job watchdog
// (packages/cdk/src/lambda/worker.ts's sweepStuckJobs) and Team Admin's
// read-only STUCK flag (docs/admin/team-admin.md). Kept as ONE map and ONE
// pure predicate so the sweeper and the admin view can never disagree about
// which jobs are stuck.
// ---------------------------------------------------------------------------

/** Per mutating job type timeout, in milliseconds. DESTROY is deliberately
 *  absent: while the relay lives, its heartbeats refresh lastProgressAt, so a
 *  DESTROY only ever trips a timeout when the relay is dead — and failing it
 *  here would strand the deployment in FAILED with no disconnect path left.
 *  That case is settled by the force-complete escape hatch instead, gated on
 *  the same staleness. */
export const JOB_TIMEOUTS_MS: Partial<Record<JobType, number>> = {
  INSTALL: 60 * 60 * 1000,
  DEPLOY_RELEASE: 20 * 60 * 1000,
  ROLLBACK: 20 * 60 * 1000,
  RESTART: 20 * 60 * 1000,
  CONFIG_UPDATE: 20 * 60 * 1000,
  PURGE: 60 * 60 * 1000,
  // Phase 5 §9.3: domain operations ride the same relay channel, so a stuck
  // CONFIGURE_DOMAIN/REMOVE_DOMAIN must not idle forever — generous window
  // (cert issuance + ALB listener work is a single invocation) then fail.
  CONFIGURE_DOMAIN: 60 * 60 * 1000,
  REMOVE_DOMAIN: 60 * 60 * 1000,
};

/** Job states the STUCK definition (and the worker's sweep) ever consider. */
export const ACTIVE_JOB_STATES: readonly JobState[] = ['REQUESTED', 'QUEUED', 'WAITING', 'RUNNING'];

/** The minimal job shape `isJobStuck`/`jobStuckAt` need. */
export interface StuckJobInput {
  type: JobType;
  state: JobState;
  createdAt: Date;
  startedAt: Date | null;
  lastProgressAt: Date | null;
}

/**
 * The moment a job became stuck, or null if it is not (not an active state,
 * its type has no timeout, or it has not yet exceeded one). Pure — same
 * inputs always give the same answer, and the caller supplies `now`.
 * `lastProgressAt ?? startedAt ?? createdAt` is the last genuine progress
 * signal (docs/admin/team-admin.md's STUCK jobs section).
 */
export function jobStuckAt(job: StuckJobInput, now: Date = new Date()): Date | null {
  if (!ACTIVE_JOB_STATES.includes(job.state)) return null;
  const timeout = JOB_TIMEOUTS_MS[job.type];
  if (timeout === undefined) return null;
  const lastSignal = job.lastProgressAt ?? job.startedAt ?? job.createdAt;
  if (now.getTime() - lastSignal.getTime() <= timeout) return null;
  return new Date(lastSignal.getTime() + timeout);
}

/** Whether a job is currently STUCK. Convenience wrapper over `jobStuckAt`. */
export function isJobStuck(job: StuckJobInput, now: Date = new Date()): boolean {
  return jobStuckAt(job, now) !== null;
}

// ---------------------------------------------------------------------------
// Relay stack-event progress — raw CloudFormation events the relay reports
// while it waits for a stack operation (packages/db/src/schema/
// stack-events.ts). Progress/diagnostics only, never an input to lifecycle
// decisions. relayCommandProgressSchema is the ingest payload for the future
// POST /api/relay/commands/:id/progress; vendorStackEventSchema is the read
// shape a `deployment_stack_events` row takes on the vendor endpoint / web
// fetcher. Plain z.object (no .strict()) — matches how other relay ingest
// payloads are validated in apps/api/src/server.ts.
// ---------------------------------------------------------------------------

export const relayStackEventSchema = z.object({
  eventId: z.string().min(1).max(255),
  timestamp: z.string().datetime({ offset: true }),
  logicalResourceId: z.string().min(1).max(255),
  resourceType: z.string().min(1).max(255),
  resourceStatus: z.string().min(1).max(64),
  resourceStatusReason: z.string().min(1).max(2000).optional(),
});
export type RelayStackEvent = z.infer<typeof relayStackEventSchema>;

export const relayCommandProgressSchema = z.object({
  commandId: z.string().min(1),
  installationId: z.string().min(1),
  stackName: z.string().min(1).max(255),
  events: z.array(relayStackEventSchema).min(1).max(50),
});
export type RelayCommandProgress = z.infer<typeof relayCommandProgressSchema>;

export const vendorStackEventSchema = z.object({
  id: z.number(),
  eventAt: z.string(),
  logicalResourceId: z.string(),
  resourceType: z.string(),
  resourceStatus: z.string(),
  resourceStatusReason: z.string().nullable(),
});
export type VendorStackEvent = z.infer<typeof vendorStackEventSchema>;

// ---------------------------------------------------------------------------
// Shared column groups
// ---------------------------------------------------------------------------

const jsonRecord = z.record(z.string(), z.unknown());

// §62 audit fields on every infra-changing record (Better Auth text user id;
// nullable — relay/system actors are not users).
const auditColumns = {
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  createdBy: z.string().nullable(),
  updatedBy: z.string().nullable(),
} as const;

// ---------------------------------------------------------------------------
// Core objects (§33–§40) — shapes mirror packages/db/src/schema/*.ts
// ---------------------------------------------------------------------------

// Better Auth organization plugin shape.
export const organizationSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  logo: z.string().nullable(),
  metadata: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime().nullable(),
});
export type Organization = z.infer<typeof organizationSchema>;

// Paddle migration Phase 3 — one row per organization; no row means
// evaluation mode (no subscription yet).
export const billingSubscriptionSchema = z.object({
  id: z.uuid(),
  organizationId: z.string(),
  provider: billingProviderSchema,
  providerCustomerId: z.string(),
  providerSubscriptionId: z.string(),
  status: billingSubscriptionStatusSchema,
  currentPeriodStart: z.iso.datetime().nullable(),
  currentPeriodEnd: z.iso.datetime().nullable(),
  // Paddle's `scheduled_change` — a pending cancel/pause/resume already
  // accepted for this subscription, with its effective date. Null when
  // nothing is scheduled.
  scheduledChangeAction: z.string().nullable(),
  scheduledChangeAt: z.iso.datetime().nullable(),
  lastProviderEventAt: z.iso.datetime().nullable(),
  lastReconciledAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type BillingSubscription = z.infer<typeof billingSubscriptionSchema>;

// Better Auth core user shape.
export const userSchema = z.object({
  id: z.string(), // Better Auth text pk
  name: z.string(),
  email: z.email(),
  emailVerified: z.boolean(),
  image: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type User = z.infer<typeof userSchema>;

// Membership roles. Exactly one owner per organization — ownership moves by
// transfer, never by a plain role change (apps/api/src/organizations.ts).
export const organizationRoleSchema = z.enum(['owner', 'admin', 'member']);
export type OrganizationRole = z.infer<typeof organizationRoleSchema>;

// Roles an invitation may carry — never 'owner'.
export const invitableRoleSchema = z.enum(['admin', 'member']);
export type InvitableRole = z.infer<typeof invitableRoleSchema>;

export const invitationStatusSchema = z.enum(['pending', 'accepted', 'rejected', 'canceled']);
export type InvitationStatus = z.infer<typeof invitationStatusSchema>;

export const memberSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  userId: z.string(),
  role: organizationRoleSchema,
  createdAt: z.iso.datetime(),
});
export type Member = z.infer<typeof memberSchema>;

export const invitationSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  email: z.email(),
  role: invitableRoleSchema,
  status: invitationStatusSchema,
  expiresAt: z.iso.datetime(),
  inviterId: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Invitation = z.infer<typeof invitationSchema>;

export const applicationSchema = z.object({
  id: z.uuid(),
  organizationId: z.string(),
  name: z.string(),
  githubInstallationId: z.string().nullable(),
  repoFullName: z.string(),
  repoUrl: z.string(),
  defaultBranch: z.string(),
  containerPort: z.number().int().nullable(),
  healthPath: z.string().nullable(),
  // §35 vendor-default migration command; releases.migrationCommand overrides.
  migrationCommand: z.string().nullable(),
  workerCommand: z.string().nullable(),
  databaseRequired: z.boolean(),
  storageRequired: z.boolean(),
  redisRequired: z.boolean(),
  analysisStatus: analysisStatusSchema,
  compatibilityStatus: compatibilityStatusSchema.nullable(),
  compatibilityReason: z.string().nullable(),
  detectedMetadata: jsonRecord.nullable(),
  ...auditColumns,
});
export type Application = z.infer<typeof applicationSchema>;

export const releaseSchema = z.object({
  id: z.uuid(),
  applicationId: z.uuid(),
  version: z.string(),
  gitSha: z.string(),
  imageDigest: z.string().nullable(),
  migrationCommand: z.string().nullable(),
  buildStatus: buildStatusSchema,
  releaseStatus: releaseStatusSchema,
  ...auditColumns,
});
export type Release = z.infer<typeof releaseSchema>;

// §37: MINIMAL on purpose — Deployz is not a CRM. No extra fields.
export const customerSchema = z.object({
  id: z.uuid(),
  organizationId: z.string(),
  name: z.string(),
  email: z.email(),
  company: z.string().nullable(),
  externalReference: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Customer = z.infer<typeof customerSchema>;

export const deploymentSchema = z.object({
  id: z.uuid(),
  customerId: z.uuid(),
  applicationId: z.uuid(),
  organizationId: z.string(),
  region: regionSchema,
  state: deploymentStateSchema,
  source: deploymentSourceSchema.optional(),
  awsAccountId: z.string().nullable(),
  currentReleaseId: z.uuid().nullable(),
  previousReleaseId: z.uuid().nullable(),
  relayStatus: relayStatusSchema,
  healthStatus: healthStatusSchema,
  desiredState: jsonRecord,
  observedState: jsonRecord.nullable(),
  // Write-once observational timestamps for the derived deployment `step`
  // (apps/api/src/deployment-status.ts) — NOT a persisted lifecycle.
  stepTimings: jsonRecord.nullable(),
  infraVersion: z.string(),
  installationId: z.string(),
  deploymentType: deploymentTypeSchema,
  billingState: deploymentBillingStateSchema,
  billingStartedAt: z.iso.datetime().nullable(),
  billingStoppedAt: z.iso.datetime().nullable(),
  lastHealthAt: z.iso.datetime().nullable(),
  deletedAt: z.iso.datetime().nullable(),
  cleanupState: cleanupStateSchema.nullable(),
  ...auditColumns,
});
export type Deployment = z.infer<typeof deploymentSchema>;

// §39 DeploymentJob — the unit of work the relay executes.
export const deploymentJobSchema = z.object({
  id: z.uuid(),
  deploymentId: z.uuid(),
  type: jobTypeSchema,
  state: jobStateSchema,
  // §39 idempotency: retries with the same key must not double-execute.
  idempotencyKey: z.string(),
  payload: jsonRecord,
  result: jsonRecord.nullable(),
  // §61 stable failure code, set only on FAILED.
  failureCode: failureCodeSchema.nullable(),
  // Better Auth text user id. No FK by design: job history must outlive
  // user deletion.
  requestedBy: z.string().nullable(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  ...auditColumns,
});
export type DeploymentJob = z.infer<typeof deploymentJobSchema>;

// §40 EventLog — the APPEND-ONLY audit stream. No created_at/updated_at by
// design: append-only rows never update.
export const eventLogSchema = z.object({
  id: z.number().int(), // bigserial
  occurredAt: z.iso.datetime(),
  actorType: z.string(),
  actorId: z.string(),
  organizationId: z.string(),
  customerId: z.uuid().nullable(),
  deploymentId: z.uuid().nullable(),
  jobId: z.uuid().nullable(),
  releaseId: z.uuid().nullable(),
  eventType: z.string(),
  previousState: z.string().nullable(),
  requestedState: z.string().nullable(),
  result: z.string().nullable(),
  payload: jsonRecord,
});
export type EventLog = z.infer<typeof eventLogSchema>;

// ---------------------------------------------------------------------------
// Structured error envelope — the single error wire shape for the API.
// ---------------------------------------------------------------------------

export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

// ---------------------------------------------------------------------------
// CloudFormation Quick Create install link.
//
// Shared because three sides build or check the same URL: the API returns it
// on GET /api/install/:installationId, the publisher (packages/cdk) reports
// it after uploading a template, and the tests assert the exact format. One
// implementation, so the three can never drift.
//
// The URL carries NO credential and NO secret: only the non-secret
// `ControlPlaneUrl` template parameter. The bootstrap-generated credential
// and the minted installation identifier are produced at deploy time inside
// the customer's account and never appear in a URL.
// ---------------------------------------------------------------------------

/** Default CloudFormation stack name for the customer bootstrap stack. */
export const DEFAULT_BOOTSTRAP_STACK_NAME = 'deployz-bootstrap';

/**
 * How long a DESTROY job may stay pending before the dashboard offers
 * "Complete disconnect anyway" — and the API accepts it — when the relay is
 * persistently DISCONNECTED. The value the stuck-job watchdog historically
 * allowed a DESTROY before failing it; the sweep now leaves DESTROY to this
 * path instead, because a watchdog FAILED would strand the deployment with
 * no disconnect left. Shared so the API gate and the UI prompt cannot
 * disagree about when the escape hatch opens.
 */
export const DESTROY_PENDING_STALE_AFTER_MS = 60 * 60 * 1000;

// DEPLOY-027 (Phase 4): the TTL of an at-rest pending_secrets row. A row
// older than this can no longer be decrypted — its KMS ciphertext is dropped
// by the worker's sweep and the vendor/customer value is lost by design. The
// constant is shared so the API write path (24h from the moment of write)
// and the worker's expiry sweep never disagree about what counts as expired.
export const DEFAULT_PENDING_SECRET_TTL_MS = 24 * 60 * 60 * 1000;

// The fixed `purpose` pair the control-plane secret cipher adds to every KMS
// EncryptionContext, and the only context keys it may carry. The CDK stack
// puts both into the Lambdas' IAM conditions, so a caller cannot use the
// key for another purpose or smuggle extra (possibly sensitive) context in.
// Every value is an opaque id or an env-var name — never a secret or an email.
export const CONFIG_SECRET_KMS_PURPOSE = 'deployz-config-secret';
export const CONFIG_SECRET_KMS_CONTEXT_KEYS = [
  'purpose',
  'scope',
  'organizationId',
  'applicationId',
  'customerId',
  'deploymentId',
  'key',
] as const;

/**
 * CloudFormation stack name for a customer's application stack.
 *
 * Pinned here rather than at a call site because two independent components
 * must agree on it: whatever creates the stack, and the verifier that looks it
 * up afterwards. A disagreement between them reads exactly like a failed
 * install.
 *
 * No production code creates this stack yet — `INSTALL` is still a stub.
 * This constant is the name whoever implements it must use for
 * `CreateStack`'s `StackName`, since `verifyInstallation()` already looks up
 * `DEFAULT_APPLICATION_STACK_NAME` by default.
 */
export const DEFAULT_APPLICATION_STACK_NAME = 'deployz-app';

/**
 * Per-deployment bootstrap stack names. A fixed `deployz-bootstrap` makes
 * the second deployment into the same AWS account/region fail with "stack
 * already exists"; deriving the name from the deployment identity (plus an
 * attempt suffix on retry) keeps attempts isolated and readable.
 */
export interface BootstrapStackNameParts {
  /** Customer-facing application name — contributes the readable slug. */
  readonly appName: string;
  /** Deployment id (uuid) — the uniqueness carrier. */
  readonly deploymentId: string;
  /** Install attempt number; 0 (default) is the first attempt. */
  readonly attempt?: number;
}

function slugify(value: string, maxLength: number): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
}

/**
 * `deployz-bootstrap-<slug>-<shortId>` (`-r<n>` from attempt 1 on). Pure
 * and deterministic — the Quick Create URL, the `bootstrap_stack_name`
 * column, and the install page all derive the same name from the same
 * deployment row.
 */
export function bootstrapStackName(parts: BootstrapStackNameParts): string {
  const slug = slugify(parts.appName, 24);
  const shortId = parts.deploymentId.slice(0, 8).toLowerCase();
  const attempt = parts.attempt ?? 0;
  return [
    'deployz-bootstrap',
    ...(slug !== '' ? [slug] : []),
    shortId,
    ...(attempt > 0 ? [`r${attempt}`] : []),
  ].join('-');
}

/**
 * `deployz-app-<shortInstallationId>` — unique per attempt without
 * control-plane state, because the installation identifier is minted per
 * bootstrap stack. Falls back to the fixed default when no installation
 * identifier is known (tests, pre-enrollment).
 */
export function applicationStackNameForInstallation(installationId: string): string {
  const short = installationId.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
  return short !== '' ? `deployz-app-${short}` : DEFAULT_APPLICATION_STACK_NAME;
}

/**
 * The graph-shaping requirement booleans a deployment's infrastructure is
 * built from — whether the application needs PostgreSQL and Redis. Drives the
 * component and AWS resource catalogs, the plans, the footprint, and the
 * relay's verification; no caller may re-derive them from a manifest twice.
 */
export interface InfrastructureRequirements {
  readonly postgres: boolean;
  readonly redis: boolean;
}

/**
 * CFN logical id of the application template's image parameter (CDK strips
 * the underscore from `param_ImageReference`). The relay's INSTALL passes the
 * deployment's newest READY release image reference (`repository@sha256:…`)
 * as this parameter; the template default keeps the publish-time image.
 */
export const IMAGE_REFERENCE_PARAMETER = 'paramImageReference';

/** CFN logical id of the task-count parameter (CDK strips the underscore from `param_DesiredCount`). */
export const DESIRED_COUNT_PARAMETER = 'paramDesiredCount';

/**
 * CFN logical ids of the app-runtime secrets the control plane generates per
 * install. Values are random 32-byte base64url strings; they travel only
 * through the INSTALL job payload into NoEcho parameters and are redacted
 * from the stored job payload once claimed.
 */
export const APP_API_KEY_PARAMETER = 'paramAppApiKey';
export const APP_SIGNING_SECRET_PARAMETER = 'paramAppSigningSecret';

/** The bootstrap stack's non-secret control-plane parameter. */
export const CONTROL_PLANE_URL_PARAMETER = 'ControlPlaneUrl';

/** The bootstrap stack's single-use enrollment parameter. */
export const ENROLLMENT_CODE_PARAMETER = 'EnrollmentCode';
export const RELAY_CREDENTIAL_PARAMETER = 'RelayCredential';

/**
 * Deterministic public bucket that carries one supported region's bootstrap
 * template + Lambda assets.
 *
 * A bootstrap stack must read its Lambda code from a bucket in ITS OWN
 * region — a cross-region bucket fails Lambda creation with
 * `PermanentRedirect` (verified in production: a us-east-2 stack referencing
 * the us-east-1 template bucket rolled back on exactly that error). The
 * publisher therefore fans identical artifacts out to `deployz-templates-<region>`
 * per region, and this function is the single rule for what each region's
 * bucket is called, shared by the publisher (which writes it) and the
 * resolver (which builds the URL).
 *
 * `prefix` lets a non-production control plane name its own regional buckets
 * (see `packages/cdk/src/stage.ts`). The default is production's prefix, so
 * every caller that does not pass one is unchanged.
 */
export function bootstrapTemplateBucketName(region: string, prefix = 'deployz-templates'): string {
  return `${prefix}-${region}`;
}

/** Object key of the published bootstrap template (under the key prefix). */
export const BOOTSTRAP_TEMPLATE_KEY = 'bootstrap-template-v1.json';

/**
 * Resolves the public bootstrap template URL for a deployment's region.
 *
 * Deterministic string construction (no AWS calls, no maintained region→URL
 * map): every supported region's template lives at
 * `https://deployz-templates-<region>.s3.<region>.amazonaws.com/bootstrap/v1/...`.
 *
 * FAILS CLOSED. Returns `undefined` — never a template from another region —
 * when the region is unsupported, when `deployableRegions` is given and does
 * not include the region (artifacts not confirmed published), or when
 * `legacyUrl` (the old single-bucket `BOOTSTRAP_TEMPLATE_URL`) would be the
 * only option but does not belong to the requested region. `legacyUrl` is
 * honored ONLY for `us-east-1`, the one region the legacy bucket ever
 * served; a deployment in any other region must never silently fall back to
 * it. Callers must treat `undefined` as "no link can be generated" and reject
 * before building a Quick Create URL.
 */
export function resolveBootstrapTemplate(
  region: string,
  options: {
    /** Legacy single-bucket template URL (`BOOTSTRAP_TEMPLATE_URL`), if set. */
    readonly legacyUrl?: string;
    /** Key prefix under the bucket (e.g. `bootstrap/v1`). */
    readonly keyPrefix?: string;
    /**
     * Regions whose regional artifacts are confirmed published. When given,
     * a region outside it resolves to `undefined` even if supported — the
     * "regional artifacts are unavailable" fail-closed case.
     */
    readonly deployableRegions?: readonly string[];
  } = {},
): string | undefined {
  if (!isSupportedRegion(region)) return undefined;
  // Migration compatibility: the legacy flow published exactly one template,
  // to one us-east-1 bucket. It is safe to keep handing that URL to
  // us-east-1 deployments only — never as a fallback for another region.
  // Checked before the deployable gate: the legacy URL IS the confirmation
  // that us-east-1 is published, so it must work even when
  // `deployableRegions` is unset.
  if (region === 'us-east-1' && options.legacyUrl) return options.legacyUrl;
  const deployable = options.deployableRegions;
  if (deployable !== undefined && !deployable.includes(region)) return undefined;
  const keyPrefix = options.keyPrefix ?? 'bootstrap/v1';
  return `https://${bootstrapTemplateBucketName(region)}.s3.${region}.amazonaws.com/${keyPrefix}/${BOOTSTRAP_TEMPLATE_KEY}`;
}

export interface BootstrapQuickCreateOptions {
  /** AWS region the console deep-link targets. */
  readonly region: string;
  /** Public HTTPS URL of the published bootstrap template. */
  readonly templateUrl: string;
  /** Base URL of the Deployz control plane the relay polls (non-secret). */
  readonly controlPlaneUrl: string;
  /**
   * Single-use enrollment code from the install link.
   *
   * Optional because the template publisher builds a URL for the PUBLISHED
   * template itself, before any deployment exists and so before any code has
   * been minted. Omitting it leaves the stack's EnrollmentCode parameter at
   * its empty default, which the relay then refuses to enrol with — the
   * customer-facing URL always comes from the install page, which has the
   * code for their specific deployment.
   */
  readonly enrollmentCode?: string | undefined;
  /**
   * Server-established relay credential (DZ-AUDIT-013). Delivered through
   * the Quick Create URL as a bootstrap template parameter, exactly like the
   * enrollment code.
   *
   * Optional (legacy deployments created before this change have none). When
   * set, the bootstrap stack uses it as SecretString instead of generating
   * one inside the customer account.
   */
  readonly relayCredential?: string | undefined;
  /** CloudFormation stack name. Defaults to `deployz-bootstrap`. */
  readonly stackName?: string | undefined;
}

/**
 * Builds the deterministic CloudFormation Quick Create deep-link:
 *
 *   https://{region}.console.aws.amazon.com/cloudformation/home?region={region}
 *     #/stacks/create/review
 *     ?templateURL={url-encoded templateUrl}
 *     &stackName={stackName}
 *     &param_ControlPlaneUrl={controlPlaneUrl}
 *     &param_EnrollmentCode={enrollmentCode}
 *
 * The relay's communication credential is never here — CloudFormation mints
 * it inside the customer's account. The enrollment code is not that
 * credential: it is single use, it is spent the moment the relay binds, and
 * it exists because the installation identifier is minted in the customer's
 * account too, so nothing else ties this stack to a deployment.
 *
 * Pure — same inputs, same URL. `URLSearchParams` keeps the parameter order
 * deterministic (templateURL, stackName, then params).
 */
export function buildBootstrapQuickCreateUrl(options: BootstrapQuickCreateOptions): string {
  const base =
    `https://${options.region}.console.aws.amazon.com/cloudformation/home` +
    `?region=${encodeURIComponent(options.region)}` +
    `#/stacks/create/review`;

  const query = new URLSearchParams();
  query.set('templateURL', options.templateUrl);
  query.set('stackName', options.stackName ?? DEFAULT_BOOTSTRAP_STACK_NAME);
  query.set(`param_${CONTROL_PLANE_URL_PARAMETER}`, options.controlPlaneUrl);
  if (options.enrollmentCode !== undefined) {
    query.set(`param_${ENROLLMENT_CODE_PARAMETER}`, options.enrollmentCode);
  }
  if (options.relayCredential !== undefined) {
    query.set(`param_${RELAY_CREDENTIAL_PARAMETER}`, options.relayCredential);
  }

  return `${base}?${query.toString()}`;
}

/**
 * The ECR tag a release's image is pushed under.
 *
 * A release version is unique per application, not per registry, so two
 * applications can both call a release `v1.0.0`. Namespacing the tag by the
 * application keeps them apart in the single shared `deployz-images`
 * repository. The build pipeline pushes under this tag and every reader —
 * the digest lookup after a build, the ECR cleanup, the leak audit — has to
 * compose it the same way, so the rule lives here rather than in each caller.
 */
export function releaseImageTag(applicationId: string, version: string): string {
  return `${applicationId}-${version}`;
}
