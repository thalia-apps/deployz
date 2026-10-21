import { z } from 'zod';

import { scheduleExpressionSchema, scheduleRetryPolicySchema, scheduleTimezoneSchema } from './schedule.js';

// ---------------------------------------------------------------------------
// Canonical deployment manifest (Phase 2 boundary).
//
// The typed, authoritative deployment contract derived from detector output
// + vendor overrides (packages/analysis/src/manifest.ts) and persisted on
// `deployments.desired_state.manifest` at deployment creation. The relay's
// INSTALL/DEPLOY_RELEASE/ROLLBACK execution reads from it, so a deployment
// keeps the exact config it was created with even if the application's
// analysis or overrides change afterwards.
//
// Every field is deliberately narrow: nullable where a detector can honestly
// miss a value, so the manifest can represent a config-incomplete app and the
// readiness evaluator can say WHY instead of failing to build one.
// ---------------------------------------------------------------------------

/** One env var a provisioned dependency is injected as. */
export const manifestEnvBindingSchema = z
  .object({
    name: z.string().min(1),
    kind: z.enum(['url', 'host', 'port', 'bucket', 'database', 'username', 'password', 'arn', 'jdbc_url']),
  })
  .strict();
export type ManifestEnvBinding = z.infer<typeof manifestEnvBindingSchema>;

/**
 * One env var the application reads (§11.2 Phase 7 model). Replaces the
 * Phase 2 name-list: `required`/`secret` are only ever true when detection
 * has honest evidence (a documented sample value missing, a bare read with no
 * default, a well-known service credential), and `source` names that evidence
 * so the vendor can see WHY a variable is flagged.
 */
/**
 * Who supplies the value (AI MVP Phase 4). `deployz_managed` — injected at
 * install (database, cache, storage, port); `deployz_generated` — an
 * app-internal secret Deployz mints inside the customer's account;
 * `customer_required` — the vendor must supply it; `optional` — read with a
 * default; `unknown` — declared in a sample file, never read.
 */
export const envVariableClassificationSchema = z.enum([
  'deployz_managed',
  'deployz_generated',
  'customer_required',
  'optional',
  'unknown',
]);
export type EnvVariableClassification = z.infer<typeof envVariableClassificationSchema>;

export const manifestEnvVariableSchema = z
  .object({
    key: z.string().min(1),
    /** The app has no default and Deployz will not inject a value — the vendor must supply one. */
    required: z.boolean(),
    /** Name/convention evidence says the value is a credential (never a value). */
    secret: z.boolean(),
    /** Evidence strings: file paths, reads, or service detections that produced this entry. */
    source: z.array(z.string()),
    /**
     * What the variable is for (Stage B phase 3). Absent on variables written
     * before the field existed — optional, not defaulted, so old persisted
     * data round-trips unchanged.
     */
    purpose: z
      .enum(['internal_secret', 'external_credential', 'infrastructure_binding', 'optional_configuration', 'unknown'])
      .optional(),
    /** How sure the purpose classification is (exact known-name vs name-shape heuristic). */
    confidence: z.enum(['high', 'medium', 'low']).optional(),
    /**
     * Deployz can generate a value for this variable (Stage B phase 4): an
     * application-INTERNAL required secret, never an external vendor
     * credential or a provisioned binding. Absent/undefined = not
     * generatable — old persisted data round-trips unchanged.
     */
    generatable: z.boolean().optional(),
    /** Absent on rows analysed before classification existed. */
    classification: envVariableClassificationSchema.optional(),
  })
  .strict();
export type ManifestEnvVariable = z.infer<typeof manifestEnvVariableSchema>;

/**
 * The manifest shape version. Every manifest written from now on carries
 * `schemaVersion: 1`. A stored manifest with NO `schemaVersion` is the
 * pre-versioning shape and parses as version 1 (legacy compatibility — all
 * manifests persisted so far predate this field). Any other value fails
 * validation, which `readStoredManifest` turns into `null` and the
 * deployment preflight turns into a 422 before provisioning.
 */
export const DEPLOYMENT_MANIFEST_SCHEMA_VERSION = 1 as const;

/**
 * One declared worker process (Phase 4A). The id is the evidence-derived
 * stable workload id (Procfile process name, compose service name), never a
 * numbered field; `source` names the file that declared the process.
 */
export const manifestWorkerSchema = z
  .object({
    id: z.string().min(1),
    /** Worker process start command (runnable, e.g. `node worker.js`). */
    command: z.string().min(1),
    /** Repository path that declared the process (Procfile, compose file, …). */
    source: z.string().min(1),
  })
  .strict();
export type ManifestWorker = z.infer<typeof manifestWorkerSchema>;

/** A stable kebab-case component id (queue, scheduled job). */
const componentIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);

/**
 * One Standard message queue the application both produces to and consumes
 * from (Phase 5A/5B). Only evidence that resolves BOTH sides to declared
 * workloads reaches the manifest; anything weaker is a `questions` entry.
 * `producers`/`consumers` name workload ids (`web`, a worker id, a
 * scheduled-job id) — the edges the graph turns into bindings and IAM.
 */
export const manifestQueueSchema = z
  .object({
    id: componentIdSchema,
    /** The env vars the application reads for this queue (its own names). */
    envBindings: z.array(manifestEnvBindingSchema).min(1),
    producers: z.array(z.string().min(1)).min(1),
    consumers: z.array(z.string().min(1)).min(1),
    messageRetentionSeconds: z.number().int().min(60).max(1209600).optional(),
    visibilityTimeoutSeconds: z.number().int().min(0).max(43200).optional(),
    /** A Standard dead-letter queue the queue redrives to after `maxReceiveCount` receives. */
    deadLetter: z
      .object({
        maxReceiveCount: z.number().int().min(1).max(1000),
        /** Env vars the application reads for the dead-letter queue (may be empty). */
        envBindings: z.array(manifestEnvBindingSchema),
        producers: z.array(z.string().min(1)),
        consumers: z.array(z.string().min(1)),
      })
      .strict()
      .optional(),
    /** Repository path(s) that evidenced the queue. */
    source: z.string().min(1),
  })
  .strict();
export type ManifestQueue = z.infer<typeof manifestQueueSchema>;

/**
 * One scheduled one-shot job (Phase 5C/5D): a frozen command on the shared
 * build artifact, run on a schedule. Only explicit production schedule
 * declarations (a deployment manifest naming both a schedule and a command)
 * reach the manifest — in-process cron libraries and CI schedules never do.
 */
export const manifestScheduledJobSchema = z
  .object({
    id: componentIdSchema,
    command: z.string().min(1),
    schedule: scheduleExpressionSchema,
    timezone: scheduleTimezoneSchema.nullable(),
    retry: scheduleRetryPolicySchema.optional(),
    /** Route undeliverable invocations to a Standard dead-letter queue. */
    deadLetter: z.boolean().optional(),
    enabled: z.boolean().optional(),
    source: z.string().min(1),
  })
  .strict();
export type ManifestScheduledJob = z.infer<typeof manifestScheduledJobSchema>;

/** An ambiguous-evidence question (Phase 5): surfaced as Needs input, never provisioned. */
export const manifestQuestionSchema = z
  .object({
    id: z.string().min(1),
    field: z.enum(['queue_relationship', 'schedule']),
    question: z.string().min(1),
    source: z.string().min(1),
  })
  .strict();
export type ManifestQuestion = z.infer<typeof manifestQuestionSchema>;

export const deploymentManifestSchema = z
  .object({
    schemaVersion: z.literal(DEPLOYMENT_MANIFEST_SCHEMA_VERSION).default(DEPLOYMENT_MANIFEST_SCHEMA_VERSION),
    application: z
      .object({
        /** Repository path the app lives in (e.g. `.`, `apps/web`). */
        root: z.string().min(1),
        /** Runtime family ('node' today; 'unknown' when undetectable). */
        runtime: z.string().min(1),
        /** Detected framework, when any (e.g. 'express', 'next'). */
        framework: z.string().nullable(),
        /** Path to the build Dockerfile, or null when none was found. */
        dockerfilePath: z.string().min(1).nullable(),
      })
      .strict(),
    build: z
      .object({
        /** Image build command (e.g. `npm run build`), when one was found. */
        command: z.string().nullable(),
        /** Build context directory — usually the app root. */
        context: z.string().min(1),
        /** Dockerfile COPY sources that are not in the repository (a CI build output); absent when none. */
        missingSources: z.array(z.string()).optional(),
      })
      .strict(),
    web: z
      .object({
        /** Process start command (Dockerfile CMD / `start` script), or null. */
        command: z.string().nullable(),
        /** TCP port the app listens on, or null when undetected. */
        port: z.number().int().nullable(),
        /**
         * True when the port is a framework DEFAULT (Stage B phase 7,
         * optional/additive): the value is a prefill only and the deployment
         * gate still requires the vendor to confirm it.
         */
        portIsDefault: z.boolean().optional(),
      })
      .strict(),
    health: z
      .object({
        /**
         * ALB/container health-check path. Stage B phase 5: for
         * `vendor_required` mode this is a neutral placeholder — the manifest
         * gate blocks the deployment, so the value is never provisioned.
         */
        path: z.string().min(1),
        /**
         * How the path is known (Stage B phase 5, optional/additive):
         * `explicit` — a declared route or HEALTHCHECK URL names it; `root` —
         * the app's own HEALTHCHECK probes `/`; `vendor_required` — no health
         * evidence exists and the vendor must supply one. Absent on manifests
         * written before the field existed (legacy default behaviour).
         */
        mode: z.enum(['explicit', 'root', 'vendor_required']).optional(),
        /** The app rejects a Host header it does not know (Django ALLOWED_HOSTS): the ALB health check, which sends the task IP, gets 400. */
        hostChecked: z.boolean().optional(),
        /** The default `/` without health evidence: a redirect (a login or setup page) also proves the server is up. */
        redirectsAccepted: z.boolean().optional(),
      })
      .strict(),
    database: z
      .object({
        /** Whether Deployz provisions a managed PostgreSQL instance. */
        postgres: z.boolean(),
        /**
         * Env vars injected pointing at the managed database. Stage B phase 2:
         * absent on manifests written before the field existed (optional, not
         * defaulted, so an old stored manifest round-trips byte-identical).
         * `url`-kind bindings carry the whole `postgresql://` connection URL,
         * `host`/`port`/`database`/`username`/`password`-kind bindings carry
         * just that part.
         */
        envBindings: z.array(manifestEnvBindingSchema).optional(),
        /**
         * Which engine the managed database runs (Phase 4B, optional/
         * additive). Absent means the historical default, PostgreSQL —
         * manifests written before the field existed (and every PostgreSQL
         * deployment) omit it, so old manifests round-trip byte-identical.
         * `postgres` is the legacy "managed database required" boolean's
         * name; the engine field is what actually distinguishes the engine.
         */
        engine: z.enum(['postgres', 'mysql']).optional(),
        /**
         * The URL scheme for the app's driver when the engine's standard
         * scheme does not load it: `mysql+pymysql` for a SQLAlchemy app that
         * has only PyMySQL. Absent means the standard scheme.
         */
        urlScheme: z.enum(['mysql+pymysql']).optional(),
        /**
         * True when a managed relational database is provisioned but no
         * binding name (standard or alias) is evidenced as read or declared by
         * the application, so the app may read the connection under a name
         * analysis cannot see. Blocks readiness until the vendor maps a
         * variable to a managed database value. Absent otherwise, so existing
         * manifests stay byte-identical.
         */
        connectionUnverified: z.boolean().optional(),
      })
      .strict(),
    redis: z
      .object({
        required: z.boolean(),
        /** Env vars injected pointing at the provisioned cache. */
        envBindings: z.array(manifestEnvBindingSchema),
      })
      .strict(),
    storage: z
      .object({
        required: z.boolean(),
        /** Env vars injected naming the provisioned bucket. */
        envBindings: z.array(manifestEnvBindingSchema),
      })
      .strict(),
    migration: z
      .object({
        /** Unattended migration command run on deploy, or null. */
        command: z.string().nullable(),
        /**
         * How the database schema is updated (Stage B phase 6, optional/
         * additive): `pre_deploy` — Deployz runs the command before the new
         * version starts; `startup` — the app runs migrations when it starts
         * (informational; no command is invented); `none` — no database;
         * `unknown` — a required database but no migration evidence. Absent
         * on manifests written before the field existed.
         */
        mode: z.enum(['pre_deploy', 'startup', 'none', 'unknown']).optional(),
        /**
         * True when analysis found a migration script whose runner the
         * runtime image is not shown to provide, and the vendor has not yet
         * entered a command or chosen no separate migration. Blocks
         * provisioning. Absent on manifests written before the field existed.
         */
        needsCommand: z.boolean().optional(),
      })
      .strict(),
    worker: z
      .object({
        /** Worker process start command, or null when the app has no worker. */
        command: z.string().nullable(),
        /**
         * True when worker-like code was detected but no declared run process
         * resolves how a worker starts (Phase 4A, optional/additive): the
         * deployment stays deployable but the question is surfaced as an
         * unresolved requirement. Absent on manifests written before the
         * field existed.
         */
        needsCommand: z.boolean().optional(),
      })
      .strict(),
    /**
     * Every declared worker process (Phase 4A, optional/additive). Absent on
     * manifests written before the field existed — consumers fall back to the
     * legacy single `worker` slot, which always carries the FIRST worker's
     * command for backward compatibility.
     */
    workers: z.array(manifestWorkerSchema).optional(),
    /** Standard message queues (Phase 5, optional/additive — absent when none). */
    queues: z.array(manifestQueueSchema).optional(),
    /** Scheduled one-shot jobs (Phase 5, optional/additive — absent when none). */
    scheduledJobs: z.array(manifestScheduledJobSchema).optional(),
    /** Ambiguous queue/schedule evidence (Phase 5, optional/additive). */
    questions: z.array(manifestQuestionSchema).optional(),
    environment: z
      .object({
        /**
         * The env vars the app reads, for the config surface. Phase 7 model:
         * each entry carries required/secret/source (§11.2) — a plain
         * name-list could not express that a missing required value needs
         * configuration before provisioning.
         */
        variables: z.array(manifestEnvVariableSchema),
      })
      .strict(),
    /** Helm, Kubernetes or Terraform files in deployment or sample directories that Deployz ignores (optional/additive, shown as a warning). */
    ignoredDeploymentFiles: z.array(z.string()).optional(),
    /** External (non-Deployz) services the app integrates with. Informational. */
    externalServices: z.array(z.string()),
    /** Why the app is not compatible with Deployz hosting, when it isn't. */
    unsupported: z.array(z.string()),
  })
  .strict();
export type DeploymentManifest = z.infer<typeof deploymentManifestSchema>;

/**
 * The vendor-correctable manifest inputs — mirrors PATCH /api/applications/:id.
 * Nullish so an absent override reads as "let detection decide". Values that
 * live on applications columns (port, health/migration/worker commands, the
 * boolean requirements) arrive from there; the five manifest-only paths
 * (app root, Dockerfile, build context/command, start command) arrive from
 * `detected_metadata.manifestOverrides`.
 */
export const deploymentManifestOverridesSchema = z
  .object({
    appRoot: z.string().nullish(),
    dockerfilePath: z.string().nullish(),
    buildContext: z.string().nullish(),
    buildCommand: z.string().nullish(),
    startCommand: z.string().nullish(),
    port: z.number().int().nullish(),
    healthPath: z.string().nullish(),
    migrationCommand: z.string().nullish(),
    workerCommand: z.string().nullish(),
    databaseRequired: z.boolean().optional(),
    storageRequired: z.boolean().optional(),
    redisRequired: z.boolean().optional(),
  })
  .strict();
export type DeploymentManifestOverrides = z.infer<typeof deploymentManifestOverridesSchema>;

/** One infrastructure requirement's detected-vs-effective-vs-overridden state. */
export const applicationRequirementFieldSchema = z
  .object({
    /** Whether analysis detected this requirement, independent of any vendor override. */
    detected: z.boolean(),
    /** The manifest's actual requirement, after vendor overrides are applied. */
    effective: z.boolean(),
    /** Whether the vendor has taken ownership of this field (§35 provenance). */
    overridden: z.boolean(),
  })
  .strict();
export type ApplicationRequirementField = z.infer<typeof applicationRequirementFieldSchema>;

/**
 * The `GET /api/applications/:id/readiness` `requirements` wire shape —
 * the server-computed truth for database/redis/storage, replacing the
 * client-side OR-derivation that could not represent an override to `false`.
 */
export const applicationRequirementsSummarySchema = z
  .object({
    schemaVersion: z.literal(DEPLOYMENT_MANIFEST_SCHEMA_VERSION),
    database: applicationRequirementFieldSchema,
    redis: applicationRequirementFieldSchema,
    storage: applicationRequirementFieldSchema,
  })
  .strict();
export type ApplicationRequirementsSummary = z.infer<typeof applicationRequirementsSummarySchema>;

// ── Readiness gate output (evaluated from the FINAL manifest) ──────────────

export const manifestReadinessStateSchema = z.enum([
  'READY',
  'NEEDS_CONFIGURATION',
  'NOT_COMPATIBLE',
]);
export type ManifestReadinessState = z.infer<typeof manifestReadinessStateSchema>;

export const manifestReadinessFindingSchema = z
  .object({
    /** Stable machine id, e.g. 'dockerfile-missing'. */
    id: z.string().min(1),
    /** Coarse grouping, e.g. 'container', 'compatibility'. */
    category: z.string().min(1),
    severity: z.enum(['error', 'warning']),
    message: z.string().min(1),
  })
  .strict();
export type ManifestReadinessFinding = z.infer<typeof manifestReadinessFindingSchema>;

export const manifestReadinessResultSchema = z
  .object({
    state: manifestReadinessStateSchema,
    findings: z.array(manifestReadinessFindingSchema),
  })
  .strict();
export type ManifestReadinessResult = z.infer<typeof manifestReadinessResultSchema>;