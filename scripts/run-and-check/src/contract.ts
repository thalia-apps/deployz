/**
 * The Docker run-and-check contract: recipes (inputs only), observations
 * (what a running application did, with evidence), Analysis claims (read
 * from the production manifest and readiness gate), verdicts and reports.
 *
 * Every module of the harness reads and writes these shapes, and nothing
 * else. Fixed code gives every verdict; agents never decide one.
 */
import { z } from 'zod';

import { deploymentManifestSchema, manifestReadinessResultSchema } from '@deployz/contracts';

const COMMIT_SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[\w.-]+\/[\w.-]+$/;
const RUN_ID = /^(repo-\d{3}|new-\d+|F\d{1,2})$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ── Shared ─────────────────────────────────────────────────────────────────

/** How the image of a fact was built and run (prompt 3.4 step 8). */
export const ARCHITECTURES = ['amd64-emulated', 'amd64-ci-build', 'amd64-native', 'arm64-native'] as const;
export const architectureSchema = z.enum(ARCHITECTURES);
export type Architecture = z.infer<typeof architectureSchema>;

export const REPOSITORY_SETS = ['tuning', 'holdout', 'spare', 'vendor', 'fixture'] as const;
export const repositorySetSchema = z.enum(REPOSITORY_SETS);
export type RepositorySet = z.infer<typeof repositorySetSchema>;

/**
 * One piece of proof: a log line, command output, a `docker diff` line, an
 * HTTP response line or a `docker inspect` value. Text is truncated and
 * redacted before it is stored; a generated secret value never appears.
 */
export const evidenceSchema = z
  .object({
    kind: z.enum(['log', 'command', 'diff', 'http', 'inspect']),
    /** The container or command that produced it, e.g. `web#1`, `valkey`. */
    source: z.string().min(1),
    text: z.string().max(2000),
  })
  .strict();
export type Evidence = z.infer<typeof evidenceSchema>;

/**
 * A fact of one observation run. `observed` means the check ran and `value`
 * holds its result. `not_run` means the check did not apply (no candidate
 * command). `error` means the check itself failed (an infrastructure
 * problem), never an application result.
 */
export function factSchema<T extends z.ZodTypeAny>(value: T) {
  return z
    .object({
      status: z.enum(['observed', 'not_run', 'error']),
      value: value.nullable(),
      arch: architectureSchema,
      evidence: z.array(evidenceSchema),
      /** Why the check did not run or failed. */
      note: z.string().optional(),
    })
    .strict();
}

// ── Recipe (inputs only, never expected answers) ───────────────────────────

/** A value the harness supplies to the application at run time. */
export const vendorInputSchema = z
  .object({
    name: z.string().regex(ENV_NAME),
    source: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('generated'),
          /** Generated fresh for each run; never stored. */
          format: z.enum(['hex32', 'hex64', 'base64-32', 'base64url-32', 'uuid', 'alnum-32']),
        })
        .strict(),
      z
        .object({
          kind: z.literal('fixed'),
          /** A non-secret test value, for example an admin email address. */
          value: z.string(),
        })
        .strict(),
      /** The app's own URL (`${DEPLOYZ_APP_URL}` in deploy-config.yaml); the harness fills it per run. */
      z.object({ kind: z.literal('deploymentUrl') }).strict(),
    ]),
  })
  .strict();
export type VendorInput = z.infer<typeof vendorInputSchema>;

export const recipeSchema = z
  .object({
    id: z.string().regex(RUN_ID),
    set: repositorySetSchema,
    source: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('git'),
          repository: z.string().regex(REPOSITORY),
          commit: z.string().regex(COMMIT_SHA),
        })
        .strict(),
      /** A known-answer fixture under `scripts/run-and-check/fixtures/<F#>/`. */
      z.object({ kind: z.literal('fixture'), fixture: z.string().regex(/^F\d{1,2}$/) }).strict(),
    ]),
    /** Only when the repository needs it. Paths are relative to the repository root. */
    build: z
      .object({
        dockerfile: z.string().min(1).optional(),
        context: z.string().min(1).optional(),
        /** The stage to build (`docker build --target`), when the last stage is not the application. */
        target: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i).optional(),
        buildArgs: z.record(z.string().regex(ENV_NAME), z.string()).optional(),
      })
      .strict()
      .optional(),
    vendorInputs: z.array(vendorInputSchema).default([]),
    /** The SQL engine whose URL the observation run gives, when the application reads only MySQL. Default: postgres. */
    databaseEngine: z.enum(['postgres', 'mysql']).optional(),
    /** One HTTP request that uses the database, when a generic request cannot. */
    smoke: z
      .object({
        method: z.enum(['GET', 'POST']),
        path: z.string().startsWith('/'),
        body: z.string().optional(),
        contentType: z.string().optional(),
      })
      .strict()
      .optional(),
    /**
     * A reviewed change that makes the application deployable with Deployz
     * when it is not deployable as it is (outcome 2): environment values the
     * vendor sets, for example the setting that selects PostgreSQL. A person
     * reviews each patch; it is the truth for outcome 2.
     */
    outcomePatch: z
      .object({
        environment: z.record(z.string().regex(ENV_NAME), z.string()),
        reason: z.string().min(1),
      })
      .strict()
      .optional(),
    /**
     * Reviewed: the health path the vendor enters when the Analysis asks for
     * one (`vendor_required`). The full run uses it only then; the manifest
     * path is a placeholder that production never deploys.
     */
    healthPath: z.string().startsWith('/').optional(),
    /**
     * Reviewed: the durable data the application keeps on local disk only
     * after use (notebooks, uploads, a SQLite file in a VOLUME), which a
     * fresh start does not write. The truth for the local-state claim, and a
     * healthy run is then outcome 2.
     */
    localState: z.string().min(1).optional(),
    /**
     * Reviewed: the application takes its database connection in a first-run
     * web setup wizard, which the observation does not complete. A start
     * without a SQL connection does not show that it needs no database.
     */
    setupWizard: z.string().min(1).optional(),
    /** Reviewer notes: why each override or input exists. */
    notes: z.array(z.string()).default([]),
  })
  .strict();
export type Recipe = z.infer<typeof recipeSchema>;

/** 1 = deployable with Deployz, 2 = deployable with changes, 3 = not deployable. */
export const outcomeSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export type DeployOutcome = z.infer<typeof outcomeSchema>;

// ── Observation (prompt 4.2) ───────────────────────────────────────────────

export const BUILD_FAILURES = ['dockerfile', 'infrastructure', 'emulation', 'timeout'] as const;

export const buildFactSchema = z
  .object({
    ok: z.boolean(),
    exitCode: z.number().int().nullable(),
    seconds: z.number().nonnegative(),
    imageBytes: z.number().int().nonnegative().nullable(),
    dockerfile: z.string(),
    context: z.string(),
    /** The stage that was built; absent in observations from before build targets. */
    target: z.string().nullable().optional(),
    failure: z.enum(BUILD_FAILURES).nullable(),
    /** True when the image came from the image cache (4.6). */
    fromCache: z.boolean(),
  })
  .strict();

export const listeningPortSchema = z
  .object({
    port: z.number().int().min(1).max(65535),
    /** `loopback` = bound to 127.0.0.1/::1 only (unreachable from the load balancer). */
    bind: z.enum(['all', 'loopback']),
    reachableFromProbe: z.boolean(),
  })
  .strict();

export const httpPathSchema = z
  .object({
    port: z.number().int(),
    path: z.string().startsWith('/'),
    /** null = no HTTP response (refused, reset or timeout). */
    status: z.number().int().nullable(),
  })
  .strict();

export const databaseFactSchema = z
  .object({
    /** The engine the application connected to, or null for no connection. */
    engine: z.enum(['postgres', 'mysql']).nullable(),
    connections: z.number().int().nonnegative(),
    /** Application tables that exist after the first start (names only). */
    tablesAfterStart: z.array(z.string()),
    /** A `.sqlite`/`.db` file was written while a database URL was available or missing. */
    sqliteFileWritten: z.boolean(),
  })
  .strict();

export const startupMigrationFactSchema = z
  .object({
    tablesCreatedByStart: z.boolean(),
    secondStartHealthy: z.boolean().nullable(),
  })
  .strict();

export const migrationCommandFactSchema = z
  .object({
    command: z.string().min(1),
    exitCode: z.number().int().nullable(),
    createdTables: z.boolean(),
    seconds: z.number().nonnegative(),
  })
  .strict();

export const redisFactSchema = z
  .object({
    connected: z.boolean(),
    clients: z.number().int().nonnegative(),
    /**
     * A web start without the Redis variables is healthy. null = not tested (no connection, the web was not
     * healthy, or the app still reached Valkey); absent in observations from before this check.
     */
    healthyWithout: z.boolean().nullable().optional(),
  })
  .strict();

/**
 * A second web container with a new filesystem and the same services, as a
 * replaced Fargate task starts. `changed` lists the probed paths (`port/path`)
 * whose status differs from the first container.
 */
export const freshContainerFactSchema = z
  .object({ healthy: z.boolean(), changed: z.array(z.string()) })
  .strict();

export const objectStorageFactSchema = z
  .object({ objectsWritten: z.number().int().nonnegative() })
  .strict();

export const workerFactSchema = z
  .object({
    command: z.string().min(1),
    /** Ran for the full 5-minute window without exiting. */
    stayedRunning: z.boolean(),
    exitCode: z.number().int().nullable(),
    restarts: z.number().int().nonnegative(),
    queueActivity: z.boolean().nullable(),
  })
  .strict();

export const requiredVariableFactSchema = z
  .object({
    name: z.string().regex(ENV_NAME),
    healthyWithout: z.boolean(),
    healthyWith: z.boolean(),
  })
  .strict();

export const sizeRunSchema = z
  .object({
    profile: z.enum(['small-v2', 'medium-v1']),
    memoryMiB: z.number().int(),
    cpus: z.number(),
    healthy: z.boolean(),
    /** Seconds from container start to the first healthy response. */
    startSeconds: z.number().nonnegative().nullable(),
    oomKilled: z.boolean(),
  })
  .strict();

/** One observation run. Every fact carries its own architecture and evidence. */
export const observationRunSchema = z
  .object({
    startedAt: z.string(),
    harnessVersion: z.string(),
    build: factSchema(buildFactSchema),
    /** The web container stays running and a reachable port answers HTTP. */
    webHealthy: factSchema(z.boolean()),
    listeningPorts: factSchema(z.array(listeningPortSchema)),
    httpPaths: factSchema(z.array(httpPathSchema)),
    smoke: factSchema(z.object({ path: z.string(), status: z.number().int().nullable() }).strict()),
    database: factSchema(databaseFactSchema),
    startupMigration: factSchema(startupMigrationFactSchema),
    migrationCommands: factSchema(z.array(migrationCommandFactSchema)),
    redis: factSchema(redisFactSchema),
    objectStorage: factSchema(objectStorageFactSchema),
    /** `docker diff` paths outside temp, log, cache and pid folders. */
    localDiskWrites: factSchema(z.array(z.string())),
    workers: factSchema(z.array(workerFactSchema)),
    requiredVariables: factSchema(z.array(requiredVariableFactSchema)),
    twoCopiesHealthy: factSchema(z.boolean()),
    restartHealthy: factSchema(z.boolean()),
    /** Observations from before this check read as not run. */
    freshContainer: factSchema(freshContainerFactSchema).default({
      status: 'not_run',
      value: null,
      arch: 'amd64-native',
      evidence: [],
      note: 'recorded before the fresh-container check',
    }),
    sizes: factSchema(z.array(sizeRunSchema)),
    /** Candidate commands and health paths that the runs probed, and where they came from. */
    candidates: z
      .object({
        /** The PORT value the observation gave the app; an app that listens on it follows PORT, as production sets PORT to the analysed port. */
        injectedPort: z.number().int(),
        healthPaths: z.array(z.string()),
        migrationCommands: z.array(z.string()),
        workerCommands: z.array(z.string()),
        variables: z.array(z.string()),
        from: z.array(z.string()),
      })
      .strict(),
    /** Retried infrastructure failures, reported apart from application results. */
    infrastructureFailures: z.array(z.string()),
    timings: z.record(z.string(), z.number().nonnegative()),
  })
  .strict();
export type ObservationRun = z.infer<typeof observationRunSchema>;

export const OBSERVATION_FACTS = [
  'build',
  'webHealthy',
  'listeningPorts',
  'httpPaths',
  'smoke',
  'database',
  'startupMigration',
  'migrationCommands',
  'redis',
  'objectStorage',
  'localDiskWrites',
  'workers',
  'requiredVariables',
  'twoCopiesHealthy',
  'restartHealthy',
  'freshContainer',
  'sizes',
] as const satisfies readonly (keyof ObservationRun)[];
export type ObservationFactName = (typeof OBSERVATION_FACTS)[number];

/**
 * The committed observation file `observations/<id>.json`: two runs of the
 * same pinned commit (4.7). The second run reuses the cached image. A fact
 * whose two runs disagree is listed in `unstable`.
 */
export const observationSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().regex(RUN_ID),
    set: repositorySetSchema,
    repository: z.string(),
    commit: z.string(),
    /** sha256 of the canonical recipe JSON, so a recipe change invalidates the observation. */
    recipeHash: z.string(),
    imageDigest: z.string().nullable(),
    runs: z.array(observationRunSchema).min(1).max(2),
    unstable: z.array(z.enum(OBSERVATION_FACTS)),
    complete: z.boolean(),
  })
  .strict();
export type Observation = z.infer<typeof observationSchema>;

// ── Analysis claims ────────────────────────────────────────────────────────

/**
 * The input of the claim check: one Analysis result per repository, as the
 * production path produces it (`runApplicationAnalysis`, then
 * `normalizeDeploymentManifest` and `evaluateManifestReadiness`). Any
 * Analysis implementation can be checked when it produces this shape.
 */
export const analysisResultFileSchema = z
  .object({
    id: z.string().regex(RUN_ID),
    commit: z.string(),
    /** e.g. `rules@<git sha>` or `ai-opus-5.5@<prompt hash>`. */
    analyser: z.string().min(1),
    status: z.enum(['analysed', 'failed']),
    failure: z.string().nullable(),
    manifest: deploymentManifestSchema.nullable(),
    gate: manifestReadinessResultSchema.nullable(),
    /** Questions the Analysis asks the vendor (manifest questions + gate findings that need a vendor answer). */
    vendorQuestions: z.number().int().nonnegative(),
    /** The stage the build targets (`dockerfileBuildTarget`); absent when the build uses the last stage. */
    buildTarget: z.string().optional(),
    /** The readiness report's deployability outcome; absent in files from before it. */
    outcome: z.enum(['DEPLOYABLE', 'DEPLOYABLE_WITH_CHANGES', 'NOT_DEPLOYABLE']).optional(),
    /** The AI engine record (`detected_metadata.aiEngine`): status or fallback reason, usage, latency, fact decisions. */
    ai: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .strict();
export type AnalysisResultFile = z.infer<typeof analysisResultFileSchema>;

export const CLAIM_TYPES = [
  'readiness', // READY | NEEDS_CONFIGURATION | NOT_COMPATIBLE
  'dockerfile', // the Dockerfile path and context build an image
  'web.port',
  'health.path',
  'database.engine', // postgres | mysql | none
  'redis.required',
  'storage.required', // S3 needed (true) or not
  'storage.local', // the app keeps state on local disk
  'migration.mode', // pre_deploy | startup | none | unknown
  'migration.command',
  'worker.command', // one claim per worker
  'env.required', // one claim per required variable
  'datastore.required', // one claim per datastore server that Deployz does not host (MongoDB, Elasticsearch, ClickHouse, …)
] as const;
export const claimTypeSchema = z.enum(CLAIM_TYPES);
export type ClaimType = z.infer<typeof claimTypeSchema>;

export const claimSchema = z
  .object({
    type: claimTypeSchema,
    /** The worker id or variable name for per-item claims. */
    subject: z.string().nullable(),
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    /** The manifest field or gate finding the claim came from. */
    from: z.string(),
    /** The dockerfile claim: the stage to build, when it is not the last one. */
    target: z.string().optional(),
  })
  .strict();
export type Claim = z.infer<typeof claimSchema>;

// ── Verdicts and reports (prompt 4.4) ──────────────────────────────────────

export const VERDICTS = ['CONFIRMED', 'CONTRADICTED', 'NOT_CHECKABLE'] as const;
export const verdictSchema = z.enum(VERDICTS);
export type Verdict = z.infer<typeof verdictSchema>;

export const claimVerdictSchema = z
  .object({
    claim: claimSchema,
    verdict: verdictSchema,
    /** For CONTRADICTED: the observed value. */
    observed: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
    /** Always set for NOT_CHECKABLE, e.g. "needs an external email server" or "emulation". */
    reason: z.string(),
    /** The observation facts the verdict used. */
    facts: z.array(z.enum(OBSERVATION_FACTS)),
    arch: architectureSchema,
    /** A fact the verdict used was unstable across the two runs. */
    unstable: z.boolean(),
  })
  .strict();
export type ClaimVerdict = z.infer<typeof claimVerdictSchema>;

/** One full run: the application with exactly the analysed settings (4.1 mode 3). */
const singleFullRunSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().regex(RUN_ID),
    analyser: z.string(),
    arch: architectureSchema,
    startedAt: z.string(),
    /** Names only; values are never stored. */
    environmentNames: z.array(z.string()),
    migration: z.object({ command: z.string(), exitCode: z.number().int().nullable() }).strict().nullable(),
    webHealthy: z.boolean(),
    healthPathStatus: z.number().int().nullable(),
    smokeStatus: z.number().int().nullable(),
    workers: z.array(workerFactSchema),
    evidence: z.array(evidenceSchema),
    infrastructureFailures: z.array(z.string()),
  })
  .strict();
/** The first full run; `repeat` is the second run on a fresh service set. Files from before the repeat have none. */
export const fullRunSchema = singleFullRunSchema.extend({ repeat: singleFullRunSchema.optional() }).strict();
export type FullRun = z.infer<typeof fullRunSchema>;

export const repositoryReportSchema = z
  .object({
    id: z.string().regex(RUN_ID),
    set: repositorySetSchema,
    repository: z.string(),
    commit: z.string(),
    analyser: z.string(),
    arch: architectureSchema,
    readiness: z.enum(['READY', 'NEEDS_CONFIGURATION', 'NOT_COMPATIBLE']).nullable(),
    verdicts: z.array(claimVerdictSchema),
    /** null when no full run exists yet, a full run hit a limit of the test, or the two full runs differ. */
    healthyWithAnalysedSettings: z.boolean().nullable(),
    /** The Analysis said READY, but both full runs are not healthy. */
    hiddenProblem: z.boolean(),
    /** One full run is healthy and the other is not. */
    unstableFullRun: z.boolean(),
    /** Fixes or vendor decisions the Analysis asked for that the application did not need. */
    falseProblems: z.array(z.string()),
    /** The outcome the Analysis predicts and the outcome the runs show; null when the runs do not decide it. */
    outcome: z.object({ predicted: outcomeSchema.nullable(), actual: outcomeSchema.nullable() }).strict(),
    vendorQuestions: z.number().int().nonnegative(),
    unstableFacts: z.array(z.enum(OBSERVATION_FACTS)),
    infrastructureFailures: z.array(z.string()),
  })
  .strict();
export type RepositoryReport = z.infer<typeof repositoryReportSchema>;

const countsSchema = z.record(z.string(), z.number().int().nonnegative());

/** Summary per repository set; tuning and holdout are always reported apart. */
export const summaryReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    analyser: z.string(),
    generatedAt: z.string(),
    sets: z.array(
      z
        .object({
          set: repositorySetSchema,
          repositories: z.number().int().nonnegative(),
          healthyWithAnalysedSettings: z.number().int().nonnegative(),
          hiddenProblems: z.array(z.string()),
          unstableFullRuns: z.array(z.string()),
          falseProblems: z.array(z.object({ id: z.string(), problem: z.string() }).strict()),
          /** `outcomes[predicted][actual]`: repositories whose actual outcome the runs decide. */
          outcomes: z.record(z.enum(['1', '2', '3']), z.record(z.enum(['1', '2', '3']), z.number().int().nonnegative())),
          /** Predicted outcome 1, actual 2 or 3: the release gate needs none. */
          falseDeployable: z.array(z.string()),
          /** Predicted outcome 3, actual 1 or 2. */
          falseNotDeployable: z.array(z.string()),
          contradictedByClaimType: countsSchema,
          contradictedByRuntime: countsSchema,
          notCheckableReasons: countsSchema,
          unstableFacts: z.array(z.object({ id: z.string(), fact: z.enum(OBSERVATION_FACTS) }).strict()),
          vendorQuestions: z.record(z.string(), z.number().int().nonnegative()),
        })
        .strict(),
    ),
  })
  .strict();
export type SummaryReport = z.infer<typeof summaryReportSchema>;

/** Expected verdicts of a known-answer fixture (`fixtures/<F#>/answers.json`). Harness tests only. */
export const fixtureAnswersSchema = z
  .object({
    fixture: z.string().regex(/^F\d{1,2}$/),
    claims: z.array(z.object({ claim: claimSchema, verdict: verdictSchema }).strict()).min(1),
    healthyWithAnalysedSettings: z.boolean(),
  })
  .strict();
export type FixtureAnswers = z.infer<typeof fixtureAnswersSchema>;
