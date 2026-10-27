import { posix as posixPath } from 'node:path';

import { eq } from 'drizzle-orm';

import type {
  AiAnalysisGateways,
  AiGateway,
  AnalysisEngine,
  AnalysisResult,
  FileTree,
  MergeResult,
  ReadinessReport,
  RepositoryAiInput,
  ResourceOverrides,
} from '@deployz/analysis';
import {
  REPO_AI_TIMEOUT_MS,
  REPOSITORY_AI_PROMPT_VERSION,
  analyseRepo,
  analyseRepositoryWithAi,
  buildApplicationAnalysis,
  buildReadinessReport,
  collectScripts,
  collectUnresolvedQuestions,
  deriveAmbiguities,
  detectDeclaredWorkerCommands,
  evidenceFileRequests,
  dockerfileWorkdirs,
  isDevToolCommand,
  listDockerfileCandidates,
  mainCommandRunsWorker,
  mergeAiAnalysis,
  migrationRunnerVerdict,
  optionalQueueMode,
  redactSecrets,
  runAiAnalysis,
  selectAiContextFiles,
  selectMigrationScript,
  vendorResourceOverrides,
  verdictFromReadiness,
} from '@deployz/analysis';
import { readVendorDismissedRejections, type VendorDismissedRejection } from '@deployz/contracts';
import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { ApiError } from './errors.js';
import { recordEvent } from './events.js';
import { effectiveReadinessReport } from './fix-instructions.js';
import {
  createGithubStore,
  fetchFilesForAnalysis,
  fetchHeadSha,
  getFileTreeForAnalysis,
  mintInstallationToken,
  parseRepoFullName,
  requireActiveInstallation,
  type FetchFn,
} from './github.js';
import type { JevShadowRunner } from './jev-shadow.js';

// §18/§19/§20 analysis orchestrator — the ONLY caller of `analyseRepo` /
// `evaluateCompatibility` outside their own package tests. Wires:
//   1. Load the application row + resolve its GitHub repo/branch.
//   2. Fetch a capped file tree (github.ts) and run the deterministic
//      analyser + rules engine (@deployz/analysis).
//   3. Persist analysisStatus/compatibilityStatus/compatibilityReason/
//      detectedMetadata, and backfill the §35 contract fields the analyser
//      found where they are still null.
//
// This module NEVER throws out of `runApplicationAnalysis` — every failure
// mode (repo not found, empty repo, no installation, GitHub disabled, rate
// limited, unexpected error) is caught and persisted as analysisStatus
// 'FAILED' with a reason. server.ts calls this detached from the request
// that triggered it (§ fire-and-forget 202-accepted semantics), so an
// unhandled rejection here would crash the process.

type ApplicationRow = typeof schema.applications.$inferSelect;

// Task 6 commit-SHA analysis cache: bumped whenever the detector/AI schema
// changes materially, so a repository whose head commit hasn't moved but
// whose analysis LOGIC has still gets a fresh run instead of a stale cache
// hit. Version 1 is the pre-AI implicit version (no `analysisVersion` field
// on the row at all). Version 3 introduced the semantic readiness report
// (`detected_metadata.readiness`). Version 4 introduced the Phase 7 §11
// metadata (env-var model, external-service requirements, unsupported
// architecture reasons), whose absence would silently keep old verdicts.
// Version 5 fixed file-based health-route path derivation (CANARY-003), so
// a stored `healthPath` computed under the old, buggy logic re-runs.
// Version 6 narrowed the §11.4 architecture rejections (CANARY-002) — a
// dev-only compose file and a bare `@azure/*`/`@google-cloud/*` package no
// longer reject, so a stale NOT_COMPATIBLE verdict from Version 5 must re-run.
// Version 7 is the Stage A detector-signal batch (COMP-001..007, 012, 013,
// 016, 018, 020): ports from Dockerfile/Compose, health paths from health
// checks and non-JS routes, Dockerfile ranking, migration-command resolution
// by value, and the tree-fetch priority — stored ports, health paths and
// NEEDS_CONFIGURATION verdicts from Version 6 must re-run.
// Version 8 is the Stage A rejection-precision batch (COMP-002, 008, 009,
// 011, 019): a configurable SQL engine, an uncorroborated broker client, a
// distroless base image, a one-shot Compose service, a variant/dev Compose
// file or a guarded Redis client, and a conditional cluster client no longer
// reject or provision — stale NOT_COMPATIBLE verdicts and `redisRequired`
// flags from Version 7 must re-run.
// Version 9 is the Stage A main-corpus batch (COMP-024, 026, 027, 028, 029,
// 032, 034, 035): local-disk state must be DECLARED (VOLUME/Compose mount)
// with no object-storage alternative, Compose sidecars and profile-gated
// services are not application services, database clients need the same
// corroboration brokers do, Dockerfile naming/ranking, EXPOSE variables and
// non-HTTP ports, PostgreSQL drivers across PHP/JVM/.NET/Rust/Elixir, script
// health checks, and tooling app roots — stale NOT_COMPATIBLE verdicts,
// ports, health paths and `postgres.required` flags from Version 8 must
// re-run.
// Version 10 is the Stage A hardening batch from the unseen set (COMP-015,
// 036, 037, 038): worker code and declared worker processes outside a root
// package.json script, IaC only in runtime paths, unsupported engines in
// JVM/Elixir/PHP/Python manifests, and Dockerfiles fetched ahead of
// workspace manifests — stale worker flags, NOT_COMPATIBLE verdicts and
// Dockerfile selections from Version 9 must re-run.
// Version 11 makes `resolveMigrationCommand` return a command that actually
// runs where the relay executes it (a bare ORM-CLI script value exited 127
// under `sh -c` with no node_modules/.bin on PATH — production-verified on
// Documenso's `prisma migrate deploy`): a bare invocation gets an `npx`
// prefix, and a schema-less Prisma `migrate deploy` gets a `--schema` flag
// computed from the Dockerfile's runtime WORKDIR — stored migration commands
// from Version 10 must re-run.
// Version 12 fixes `detectEnvVarModel` marking a variable required when a
// bare read is chained straight into further use (`process.env.X.split(',')`)
// even though the same file already early-returns on that key's absence
// (production-verified: Documenso's NEXT_PRIVATE_DATABASE_REPLICA_URLS blocked
// deployment creation with 422 MANIFEST_NEEDS_CONFIGURATION although the app
// runs fine without it) — env-var reads behind an early-return presence guard
// are no longer required — stored env-var models from Version 11 must re-run.
// Version 13 adds the runtime and bind-address detectors and persists the
// canonical `application` projection (runtime, commands, port, bind address,
// database, cache, storage, health check, migrations, env vars — each with
// source, confidence and evidence) — stored metadata from Version 12 must
// re-run so the readiness page can show what was detected.
// Version 14 stops classifying secrets shared with another party
// (WEBHOOK_SECRET, HMAC_SECRET, LICENSE_SECRET, …) as Deployz-generated —
// stored env-var models from Version 13 must re-run.
// Version 15 is the Stage B binding/evidence batch merged into main: the
// env-var names each provisioned value is injected under (MEMOS_DSN,
// PAPERLESS_DB*, GF_DATABASE_*, SQLALCHEMY_DATABASE_URI, CELERY_BROKER_URL,
// S3_ATTACHMENTS_BUCKET) are derived into `metadata.infrastructureBindings`
// and the manifest's database/storage `envBindings`, health-path modes and
// migration modes ride along, and the §15 typed evidence surface
// (`metadata.ambiguities`) is persisted — stored metadata and manifests from
// Versions 11..14 (no binding names, no health/migration modes, no
// ambiguities) must re-run before deployment creation.
// Version 16 is the Stage B Wave 1 binding batch (DEPLOY-005, DEPLOY-013): the
// `DB_*` family (DB_HOST/PORT/NAME/DATABASE/USER/USERNAME/PASSWORD/PASS,
// DB_CONNECTION_STRING) becomes postgres binding aliases, and mail relay
// credentials (MAIL_/SMTP_*) and provisioned-resource credentials
// (DB_PASSWORD, REDIS_PASSWORD) are no longer app-internal secrets the relay
// may mint — stored manifests and env-var models from Version 15 must re-run.
// Version 17 (DEPLOY-005, directus): a JS/TS module that reads its
// configuration through a local `env` object (`const env = useEnv()`,
// `env['DB_HOST']`) now contributes those keys to the env-var model and the
// binding aliases — stored models from Version 16 saw no such reads.
// Version 18 (DEPLOY-005, memos): a Go module that configures viper with an
// env prefix (`viper.SetEnvPrefix("memos")`, `AutomaticEnv()`) contributes
// `<PREFIX>_<KEY>` for every viper key it names (`MEMOS_DSN`), so the
// `*_DSN` url alias binds — stored v17 models hold none of these names.
// Version 19 (DEPLOY-005, outline): a read through a module's env object
// records the key but never a requirement — the env module owns the defaults
// — so the v17 rule no longer turns `env.CDN_URL` in a call into a gate
// blocker; stored v17/v18 models over-require and must re-run.
// Version 20 (DEPLOY-029, umami): `detectStartupMigrationEvidence` follows
// the script(s) the selected Dockerfile's CMD/ENTRYPOINT invoke,
// transitively up to depth 3, not just the CMD/ENTRYPOINT text itself; that
// chain now wins mode 'startup' over a package.json deploy-shaped script
// (an image that migrates itself at boot), and `migrationCommand` is no
// longer persisted for mode 'startup' — stored v19 rows with a pre_deploy
// mode and an invented `npx …` migration command for a self-migrating image
// must re-run.
// Version 21 (DEPLOY-030, outline): `classifyEnvVarPurpose` no longer calls
// a provider-prefixed name (AWS_/GITHUB_/SLACK_/OIDC_/…), TLS material
// (SSL_KEY/TLS_CERT/…) or a location-shaped name (*_URI/_URL/_ENDPOINT/
// _HOST) an internal_secret — those were minted as if they were an
// application-internal secret, switching on integrations and TLS config the
// vendor never asked for; stored v20 models must re-run.
// Version 22 (DEPLOY-031, pgweb): a new `dockerfile-git-copy` detector flags
// a `COPY`/`ADD` instruction whose source is the repository's `.git`
// directory — Deployz builds from a GitHub tarball that never has one, so
// the build fails at CodeBuild with an opaque checksum error; the readiness
// report now blocks with `build-context-git-metadata` before that happens —
// stored v21 reports must re-run to pick up the finding.
// Version 23 (DEPLOY-032, fider): `scanGoEnvReads` now also reads envdecode /
// caarlos0-env struct tags (`env:"KEY,required"`), and `detectRuntime`
// resolves a multi-stage build's runtime through the final stage's own
// `COPY --from=` references when that stage's base image is itself a bare
// OS with no runtime — fider's Go server, copied into a `debian` final
// stage past a `node` UI-build stage, was rated `node` and its env model was
// empty, so `JWT_SECRET` was never minted and the container panicked at
// boot; stored v22 reports must re-run to pick up both fixes.
// Version 24 (DEPLOY-030 residual, fider): a provider token anywhere in the
// name (`EMAIL_AWSSES_ACCESS_KEY_ID`, `BLOB_STORAGE_S3_ACCESS_KEY_ID`), a
// mail credential with intermediate segments (`EMAIL_SMTP_PASSWORD`) and
// composite TLS names (`SSL_CERT_KEY`) are no longer mintable internal
// secrets — a minted `EMAIL_AWSSES_ACCESS_KEY_ID` switched fider's e-mail
// provider to SES and it exited at boot; stored v23 models must re-run.
// Version 25 (MySQL evidence reconciliation): a language package installed
// by a Dockerfile `RUN` is a dependency (a `pip install mysqlclient` Django
// app lost MySQL), a required MySQL database gets the same bindings and
// migration mode as PostgreSQL, and package.json scripts, lockfiles and a
// database service's Compose port no longer describe a non-Node image; stored
// v24 rows must re-run.
// Version 26 (aws-gate-c qualification fixes): a dialect-agnostic ORM
// (drizzle-orm/knex) is no longer PostgreSQL evidence once a MySQL driver is
// present, and a `DATABASE_URL` with a non-PostgreSQL scheme no longer counts
// as PostgreSQL evidence either — a drizzle-orm + mysql2 repo was rated
// PostgreSQL instead of MySQL; a Compose application service whose name is
// worker-shaped but has no `command:` is now weak worker evidence
// (`worker.needsCommand`) instead of tripping the blocking
// `unsupported-multi-service` rejection; and the health-route regexes now
// capture the FULL literal path instead of truncating at the first health
// keyword (`/health/live` was rated `/health`). Stored v25 rows must re-run.
// Version 27 (Phase 5 — async & scheduled workloads): SQS (Standard) is no
// longer an unsupported architecture — a queue whose producer and consumer
// both resolve to declared workloads (bounded import reachability from each
// workload's own entry file) is now provisioned as `manifest.queues[]`;
// weaker evidence (ambiguous attribution, a consumer only reachable from the
// web process, a non-JS SQS client) surfaces as a non-blocking `questions`
// entry instead of the old `sqs-event-consumer` rejection. A render.yaml
// `type: cron` service or a Kubernetes `CronJob` naming both a schedule and a
// command is provisioned as `manifest.scheduledJobs[]`; in-process cron
// libraries, CI schedules and a bare cron string never provision anything.
// Stored v26 rows carry neither the new manifest fields nor the retired
// rejection's removal, so a stale NOT_COMPATIBLE verdict or an unprovisioned
// queue/schedule must re-run.
// Version 28 (Hovod): a `.env.example`/`.env.sample`/`.env.template` value is
// no longer a runtime default — it never reaches the container, yet it made
// schema-required reads (`S3_ENDPOINT: z.string().min(1)`, `JWT_SECRET`)
// optional, so nobody was asked for a value and the app exited at boot. An
// S3 region/endpoint variable the app reads is now `deployz_managed` (its
// value is derived from the deployment region). Stored v27 env-var models
// under-require and must re-run.
// Version 29: a variable the app assigns itself (`process.env.X = …`), a
// t3-env `runtimeEnv` pass-through, and a key a zod schema declares optional
// are no longer required config. Stored v28 env-var models over-require (rallly
// asked for 20 keys, dashy and emailengine for app-written ones) and must re-run.
// Version 30: a NestJS `@Controller('health')` (under the literal
// `setGlobalPrefix`) is a health route, and `health.controller.ts` now wins a
// slot under the file cap. Stored v29 rows wrongly ask for a health path.
// Version 31: a token count or limit (`*_MAX_TOKENS`, `*_TOKEN_LIMIT`) is no
// longer a secret, so it stops defaulting to "Set by customer". Stored v30
// env-var models flag it and must re-run.
// Version 32: a secret-named read in a file that also tests the key for
// presence (`Boolean(process.env.X)`) is optional, and an `if (` from an
// earlier statement no longer makes a later bare read look guarded. Stored v31
// env-var models over-require and must re-run.
// Version 33 (rallly): a new `dockerfile-build-context` detector records when
// a Dockerfile kept in a subdirectory is written for the repository root
// (`turbo prune`, `COPY turbo.json`, `COPY apps/web/...`); the release build
// uses the root as its context instead of the Dockerfile's directory. Stored
// v32 rows carry no such finding and their builds fail, so they must re-run.
// Version 34: a `parse*` helper call that spans lines or takes an expression
// default, a `!= null` test of the key, and a secret held in a tested local are
// no longer required config (unleash asked for 50 keys). Stored v33 env-var
// models over-require and must re-run.
// Version 35: env reads of a sibling app in an `apps/*` monorepo (the landing
// site next to the deployed `apps/web`) no longer count, and a non-secret value
// handed alone to a converter (`Number(…)`, `formatBaseUri(…)`) is not required.
// Stored v34 env-var models over-require and must re-run.
// Version 36 (rallly): a Dockerfile `ARG NAME` with no default that a compose
// file feeds through `build.args` is a required build-stage variable (rallly's
// `SELF_HOSTED=true` switches Next.js to `output: standalone`, which its Dockerfile
// copies). Stored v35 models miss it and the release build fails.
// Version 37: a Django project whose image never migrates carries a suggested
// migration command on the readiness finding (shown, never applied). Stored
// rows lack it and must re-run.
// Version 38 (OpenShip): a sibling app with only its own Dockerfile is a
// separate image and leaves env scope; a schema-optional key that a boot guard
// throws without is required; a zod member built by a helper is a read; an
// optional internal secret with a generatable name is deployz_generated.
// Stored v37 models over-require sibling keys and miss boot-required ones.
// Version 39 (MVP compatibility hardening, phase 1): the app's own names for
// managed values (SQLALCHEMY_DATABASE_URI, SPRING_DATASOURCE_URL, Prisma
// datasource env names, *_REDIS_URI, config-file reads) become bindings; an
// engine or storage selector whose default keeps data on the container disk
// is required; and an unsafe migration script (create/generate/push, test,
// copy, devDependency-only CLI, workspace filter) is never frozen into the
// pre-deploy task. Stored v38 rows miss bindings and selectors and can carry
// an unsafe migration command.
// Version 40 (MVP compatibility hardening, phase 2): only the production
// Compose file counts, a same-build or same-image service is a worker, and
// infrastructure/dev-tool services are not app services; a VOLUME counts only
// from the selected Dockerfile, a SQLite-only or S3-capable uploads volume is
// not local state; Helm/k8s/Terraform/Pulumi samples under deployment
// directories are a warning, not a rejection. Stored v39 rows can carry a
// false NOT_COMPATIBLE verdict.
// Version 41 (MVP compatibility hardening, phase 3): the health path comes
// from the selected Dockerfile/Compose HEALTHCHECK, then a dedicated health
// route with its global prefix and URI version, then a framework route, and
// otherwise the vendor is asked (no feature route ending in status, no route
// of another binary, no silent /health); a production Dockerfile outranks
// dev/base/sidecar images and a symlinked Dockerfile is resolved; the port
// comes from the runtime stage; a dev script or a process the CMD already
// starts is never a worker. Stored v40 rows can carry a wrong health path,
// port or Dockerfile.
// Version 42 (MVP compatibility hardening, phase 4): Valkey is provisioned
// only on strong required Redis evidence (an optional cache, a README or a
// Compose service alone no longer provisions it); MySQL is detected from
// Laravel config defaults, pdo_mysql, Django ENGINE, jdbc:mysql and ORM
// dialects; a tuning value, an optional integration credential, a client
// build-time name or a non-runtime read is no longer required config; and a
// required public URL variable (PUBLIC_URL, APP_URL, BASE_URL, …) is managed
// with the deployment's default HTTPS URL. Stored v41 rows over-provision
// Redis and over-ask.
// Version 43 (MVP compatibility hardening, phase 5): migrations an app runs
// from its own code at boot are startup mode; PostgreSQL is provisioned next to
// a SQLite default when a postgres dialect is configured; a provisioned
// database whose connection names the app never shows blocks with
// `database-connection-unverified` (the vendor maps the variable); a
// Dockerfile that copies files the repository lacks blocks with
// `dockerfile-missing-sources`; the DB_* names are standard database
// bindings; a compose volume of a service that builds another Dockerfile is
// not this image's state; a workspace-root, build-first or out-of-image
// start script is not the container command; config classes, ini env
// overrides and S3 name shapes feed bindings and selectors; and a mandatory
// ClickHouse repo, a required config-file mount, an image data dir and a
// hard-coded RabbitMQ host reject. Stored v42 rows can carry silent fallbacks.
// Version 44 (memos AWS canary): a Dockerfile in a subdirectory whose COPY
// source exists only at the repository root (`COPY go.mod go.sum ./` in
// `scripts/Dockerfile`) builds with the root as its context. Stored v43 rows
// build such a Dockerfile from its own directory and the build fails.
// Version 45 (repository AI thinking off): the AI fallback now answers inside
// REPO_AI_TIMEOUT_MS. Stored v44 rows never received an AI answer (every
// attempt spent its output budget on reasoning and timed out), so an open
// question was left to deterministic metadata only.
// Version 46 (fresh-100 F1): a repository whose only Dockerfiles are
// development-only files or templates, that has no Dockerfile at all, or whose
// single Dockerfile copies sources the repository lacks is NOT_COMPATIBLE when
// the full tracked path list proves it. Stored v45 rows answer
// NEEDS_CONFIGURATION for these repositories.
// Version 47 (fresh-100 F4): a Pulumi package in a deployment sample
// directory and a rediss:// URL that an env sample only mentions in a comment
// no longer reject the repository. Stored v46 rows answer NOT_COMPATIBLE for
// these repositories.
// Version 48 (fresh-100 F2): a Rails app whose database.yml names only the
// sqlite3 adapter, and an image started with a --config file that no
// instruction creates, are NOT_COMPATIBLE. Stored v47 rows answer
// NEEDS_CONFIGURATION or READY for these repositories.
// Version 49 (fresh-100 F3): an image with no default server command (a bare OS
// base with no CMD or ENTRYPOINT, or a launcher-only ENTRYPOINT with no CMD) has
// no start command, and an image that runs several supervised processes
// (s6-overlay, supervisord) is NOT_COMPATIBLE. Stored v48 rows answer READY or
// NEEDS_CONFIGURATION for these repositories.
// Version 50 (fresh-100 F6): a migration script that runs a development-only tool
// (vite-node, babel-node, ts-node-dev, esno) is not selected for the pre-deploy task
// when the final image prunes dev dependencies. Stored v49 rows can carry such a
// command.
// Version 51 (fresh-100 F5): the repository AI answer is no longer rejected when an
// architecture requirement carries an `explanation`. Stored v50 rows can lack the AI
// signal because that answer was discarded.
// Version 52 (migration recovery): a migration script is persisted only when the
// selected Dockerfile's runtime stage (and the stages it is built FROM) provides
// its runner, and `npx` is added only when that image also holds the CLI in its
// node_modules. Anything else becomes the blocking "Needs input" question
// `migration-command-needs-input`. Stored v51 rows may carry an `npx …` command
// the image cannot run and must re-run.
// Version 53 (reliability): a Go PostgreSQL driver in go.mod counts only when
// runtime Go source imports it, and a dev/ Dockerfile that starts a server is a
// production candidate. Stored v52 rows may require PostgreSQL from an unused
// driver or reject a usable dev/ Dockerfile.
// Version 54 (MVP analysis fixes): evidence is scoped to the selected
// production image (Dockerfile tie-break, FROM lineage runtime, image-path
// migration suggestion, required base-image ARG); health routes, listener
// overrides and startup migrations are read from the real start path; Node job
// libraries raise no worker question; storage and engine selectors whose
// default is local disk or SQLite must be set. Stored v53 rows can carry a
// wrong image, a false loopback or worker question, or accept local storage.
// Version 55 (readiness copy): the worker, message-queue and infrastructure
// findings no longer tell the vendor to merge jobs into the web process,
// replace a queue or remove deployment files. Stored v54 rows show the old copy.
// Version 56 (COMP-052): a Dockerfile `VOLUME $VAR` that only the base image
// sets is configuration or cache, not durable state, when the Compose service
// that runs the image mounts at least as many paths and every one is a
// configuration or cache path. Stored v55 rows reject such an app (searxng).
// Version 57 (run-and-check tuning fixes): a Go driver next to an in-memory store
// choice is not a database; a typeof test, a `delete` and a Rails storage.yml
// service block do not make a variable required; a RUN step that reads git
// history and a repository whose every startable Dockerfile copies a missing
// build output are unbuildable; a HEALTHCHECK port variable names the port; Node 26
// images have no Yarn for a Procfile worker. Stored v56 rows can carry those claims.
// Version 58 (deployability outcome): every finding has a fix class and the
// report has an outcome; only a required capability gap is NOT_COMPATIBLE. A
// Dockerfile in a deployment sample directory is not a Google Cloud file, and a
// compose file in a `*.Tests` directory is test tooling. Stored v57 rows reject
// fixable apps.
// Version 59 (AI open items): a Dockerfile that copies nothing from the repository
// is unbuildable (outline runs a floating base image), and a migration that the AI
// could not resolve is a change to verify. Stored v58 rows say deployable.
// Version 60 (false vendor questions): a boot script that runs a migrate script
// file, or an install command next to a migration library, migrates at start; a
// DB_* name in the code verifies the database binding; a debug tool's storage
// selector is not file storage; an AI migration command that adds arguments
// to a package script needs a cited line that shows them. Stored v59 rows ask
// those questions.
// Version 61 (default health path): without health evidence the health check
// probes `/` and accepts a redirect; an image ENV that names a SQLite file is
// an unsupported database. Stored v60 rows ask for a health path.
// Version 62 (start command copy): a missing start command is fixed in the
// repository; Deployz has no start command setting. Stored v61 rows say to set
// it in the application details.
// Version 63 (safe rules fallback): the rules Analysis asks how a required
// database migrates when its migration step is a script Deployz cannot run
// (CODE_CHANGE, outcome 2), and a start script that puts two or more
// long-running servers in the background is a multi-process image (outcome 2).
// Stored v62 rows are READY or deployable without these changes.
// Version 64 (AI checks, prompt v15): each AI fact that passes its check
// applies on its own; a migration command may cite the script it runs; a
// startup migration may cite Flyway or Liquibase in a Spring Boot build.
// Stored v63 rows ask the vendor for those facts.
// Version 65 (AI evidence files, prompt v16): the AI pack also reads the boot
// code and the named source files that the rules tree does not hold (C#,
// Java, Elixir, PHP, Rust), and the AI names the variable the app reads its
// database connection from. Stored v64 rows keep those questions open.
// Version 66 (env reads in more languages): the rules tree also holds C#,
// Java, Kotlin, PHP, Rust and Elixir source and appsettings.json, and the
// env-var model reads their variables. Stored v65 rows miss those variables.
// Version 67 (AI startup-migration evidence): an AI startup migration stores
// the rules' evidence shape, so the finding names the file and line. Stored
// v66 rows read "Migrations run at startup: undefined (undefined)".
// Version 68 (2026-10 corpus): the start command is the production stage's
// last CMD (never a HEALTHCHECK CMD); PHP env enums, `next.config` boot guards,
// viper fatal guards and `${ARG:?}` build args are read; Redis evidence of an
// app the image does not hold is ignored; a start path that runs the queue
// consumer asks no worker question; a root HEALTHCHECK accepts redirects.
// Stored v67 rows miss those variables and keep a strict `/` health check.
// Version 69 (2026-10 corpus round 2): JS reads that are a negation, a
// membership test, one candidate of a list, a tested secret local or a
// returned secret are optional; a JS `*_ALLOWED_HOSTS` check is host
// validation; an optional queue mode makes Redis and package.json workers
// optional; a production JSON config naming `mysql` is MySQL; env package
// defaults and production JSON configs stay inside the file cap.
// Version 70 (2026-10 corpus round 3): a documentation site image ranks below
// the app image; the start script the image runs names database bindings
// (`file_env 'MB_DB_CONNECTION_URI'`); a health check script URL may set the
// scheme and a base path from variables; a subdirectory Dockerfile that copies
// its whole context from a directory with no project file builds from the
// root. Stored v69 rows can build the docs image or the wrong context, or ask
// for the database variable.
// Version 71 (2026-10 corpus round 4): a development image that copies nothing
// and starts a mounted script ranks below the app image; a RUN that bind-mounts
// `.git` cannot build; a test's route call is not a route; Rust route
// attributes name a health path; an init-only ENTRYPOINT (`tini --`) with no
// CMD is no start command; a queue mode turned on only by an equality test is
// optional; an app config file that names its data path is durable local
// state; the file cap protects the start chain of the content-selected image.
// Stored v70 rows can name no health path, build the dev image, or miss the
// local-state blocker.
export const ANALYSIS_VERSION = 71;

export interface AnalysisRunnerDeps {
  db: RuntimeDb;
  fetchFn: FetchFn;
  githubAppId: string | undefined;
  githubAppPrivateKey: string | undefined;
  githubFixtureMode: boolean;
  /** §15 AI repository-analysis fallback — only invoked when a real question is left unresolved. */
  aiGateway: AiGateway;
  /** `ANALYSIS_ENGINE`. Default `rules`; `shadow` stores the AI result and changes nothing; `ai` uses it. */
  analysisEngine?: AnalysisEngine | undefined;
  /** The analyst gateway. Without it every engine runs the rules only. */
  aiAnalysis?: AiAnalysisGateways | undefined;
  /** Jev requirements/plan shadow verifier — fire-and-forget telemetry only, never awaited. */
  jevShadow?: JevShadowRunner | undefined;
  /** Injectable clock for JWT iat/exp — defaults to Date.now. */
  now?: (() => number) | undefined;
}

/** The shape `buildServer` wires into the `/analyse` route. */
export type AnalysisRunner = (
  applicationId: string,
  options?: { force?: boolean },
) => Promise<void>;

export function createAnalysisRunner(deps: AnalysisRunnerDeps): AnalysisRunner {
  return (applicationId: string, options?: { force?: boolean }) =>
    runApplicationAnalysis(deps, applicationId, options);
}

/**
 * Runs the full §18/§19 pipeline for one application and persists the
 * result. Safe to call detached (not awaited) — every error path is caught
 * internally and turned into a persisted FAILED status rather than a thrown
 * or rejected promise.
 */
export async function runApplicationAnalysis(
  deps: AnalysisRunnerDeps,
  applicationId: string,
  options?: { force?: boolean },
): Promise<void> {
  // Wall-clock for the funnel event's durationMs: the whole run happens in
  // this invocation, so entry→persist is a trustworthy duration with no
  // dedicated analysis_started/ended timestamp on the row.
  const runStartedMs = Date.now();
  // Known only once the row loads; a load failure has no org to attribute.
  let organizationId: string | undefined;
  try {
    const rows = await deps.db
      .select()
      .from(schema.applications)
      .where(eq(schema.applications.id, applicationId))
      .limit(1);
    const application = rows[0];
    if (!application) {
      // The row vanished between the route accepting the request and this
      // background run starting — nothing left to persist to.
      return;
    }
    organizationId = application.organizationId;

    // Task 6 commit-SHA analysis cache (real GitHub mode only — fixture mode
    // has no head commit to compare and always runs fully). The single
    // installation token a real-mode run needs is minted HERE, once, and
    // reused for both the head-sha lookup and — on a full run — the tree/
    // blob fetch below, so a full run never mints a second token.
    // `mintRealModeToken` throws the same errors a full run always threw
    // (missing installation / unconfigured App / a minting failure), which
    // is correct: if minting fails, the run was always going to fail. Once
    // minted, `fetchHeadSha` itself never throws — it degrades to
    // `undefined` on any non-200 — so the cache lookup stays best-effort.
    let headSha: string | undefined;
    let realModeToken: string | undefined;
    if (!deps.githubFixtureMode) {
      realModeToken = await mintRealModeToken(deps, application);
      headSha = await fetchHeadSha(
        { ...parseRepoFullName(application.repoFullName), branch: application.defaultBranch },
        realModeToken,
        deps.fetchFn,
      );
    }

    const engine = deps.analysisEngine ?? 'rules';
    if (!options?.force && headSha !== undefined && isCommitShaCacheHit(application.detectedMetadata, headSha, engine)) {
      const durationMs = Date.now() - runStartedMs;
      await deps.db.transaction(async (tx) => {
        await tx
          .update(schema.applications)
          .set({ analysisStatus: 'COMPLETE' })
          .where(eq(schema.applications.id, applicationId));
        await recordEvent(tx, {
          organizationId: organizationId!,
          eventType: 'application.analysis_completed',
          actorType: 'system',
          actorId: `analysis:${applicationId}`,
          payload: completedEventPayload({
            applicationId,
            analysisVersion: ANALYSIS_VERSION,
            durationMs,
            runtime: application.detectedMetadata?.['runtime'],
            readiness: storedReadinessReport(application.detectedMetadata),
            compatibility: application.compatibilityStatus,
            cached: true,
          }),
        });
      });
      return;
    }

    const tree = await fetchTreeForApplication(deps, application, realModeToken);
    // The vendor's "not used in production" answers apply only while the
    // rules find the same evidence; the second pass derives everything from them.
    const rulesOnly = analyseRepo(tree);
    const disputes = readVendorDismissedRejections(application.detectedMetadata);
    const vendor = vendorResourceOverrides(rulesOnly, disputes);
    const analysis = vendor.applied ? analyseRepo(tree, vendor.overrides) : rulesOnly;
    // AI-first Analysis: `shadow` records the AI result next to the rules;
    // `ai` uses it. Any AI failure falls back to the rules path below.
    const aiRun =
      engine === 'rules'
        ? null
        : await runAiEngine(deps.aiAnalysis, tree, analysis, evidenceFileLoader(deps, application, realModeToken), vendor.overrides);
    const aiMerge = engine === 'ai' ? (aiRun?.merge ?? null) : null;
    // §15 AI fallback: only runs when the deterministic scanner left a real
    // question unresolved, and can never fail the analysis — any AI error
    // degrades to the deterministic metadata plus a warning.
    const { metadata, aiResolved, multiServiceDowngraded } = aiMerge
      ? { metadata: aiMerge.analysis.metadata, aiResolved: [...aiMerge.aiResolved], multiServiceDowngraded: false }
      : await applyAiFallback(deps.aiGateway, tree, analysis);
    const mergedAnalysis: AnalysisResult = aiMerge
      ? aiMerge.analysis
      : multiServiceDowngraded
      ? {
          ...analysis,
          metadata,
          // Phase 10: the AI confidently classified every contested compose
          // service as optional/dev/integration — the deterministic
          // NOT_COMPATIBLE rejection is downgraded here (post-AI seam), never
          // in the pure analyser. A recommended/readiness verdict recomputes
          // from this adjusted rejection list.
          rejections: analysis.rejections.filter(
            (r) => !(r.dependency === 'docker-compose-multi-service' && r.detected),
          ),
        }
      : { ...analysis, metadata };
    // Vendor intent lives on the application row and can change while this
    // run is fetching and analysing (PATCH /api/applications/:id), so the
    // outcome is derived from the row as it is when written, under its lock.
    const resolvedWorkerCommands = resolveWorkerCommands(tree);
    const buildOutcome = (app: typeof application) => {
      // The vendor-owned field list lives on detected_metadata, which this
      // write replaces wholesale — carry it across or every re-analysis would
      // forget which fields the vendor edited. A row with no list at all
      // predates it: its saved values stay, and the list stays absent.
      const markerPresent = Array.isArray(app.detectedMetadata?.['vendorOverrides']);
      const vendorOverrides = markerPresent ? readVendorOverrides(app.detectedMetadata) : legacySavedFields(app);
      // The manifest-only overrides (app root, Dockerfile path, build context and
      // command, start command) have no column either; the build and the
      // deployment gate read them from this record.
      const manifestOverrides = app.detectedMetadata?.['manifestOverrides'];
      // The vendor's answers are read from the locked row, so none is lost.
      const vendorDismissedRejections = refreshDisputes(readVendorDismissedRejections(app.detectedMetadata), disputes, vendor.matched);
    const contractFieldUpdates = deriveContractFieldUpdates(vendorOverrides, tree, mergedAnalysis, aiResolved, resolvedWorkerCommands[0]?.command);
    // A migration script the runtime image is not shown to run is an open
    // vendor question until the vendor owns the field (a command, or no
    // separate migration).
    const migrationResolution = vendorOverrides.includes('migrationCommand')
      ? undefined
      : detectedMigrationCommand(tree, mergedAnalysis, aiResolved);
    const migrationNeedsInput =
      migrationResolution !== undefined && 'candidate' in migrationResolution ? migrationResolution : null;
    const detectedMigration = resolveMigrationCommand(tree);

    // The semantic readiness report is built from the MERGED metadata, so a
    // start/migration command the AI resolved counts as resolved here too.
    // The persisted verdict is derived from the report — one source of truth.
    const readiness: ReadinessReport = buildReadinessReport(mergedAnalysis, {
      workerCommandResolved: resolvedWorkerCommands.length > 0,
      migrationNeedsInput,
    });
    const applicationAnalysis = buildApplicationAnalysis(mergedAnalysis, {
      analysisVersion: ANALYSIS_VERSION,
      aiResolved,
      resolvedMigrationCommand:
        detectedMigration !== undefined && 'command' in detectedMigration ? detectedMigration.command : null,
    });
    // The metadata record this run persists — extracted once so the Jev
    // shadow below judges exactly the state that lands in the row.
    const detectedMetadata: Record<string, unknown> = {
      ...metadata,
      // Phase 4A: EVERY resolved worker command rides the metadata as a list
      // (one manifest `workers[]` entry each, via the manifest normalizer).
      // `resolvedWorkerCommand` stays as the FIRST command so the manifest
      // normalizer's legacy single-slot fallback and any pre-4A reader keep
      // working. Null when no worker process resolves.
      resolvedWorkerCommands: resolvedWorkerCommands.length > 0 ? resolvedWorkerCommands : null,
      resolvedWorkerCommand: resolvedWorkerCommands[0]?.command ?? null,
      readiness,
      application: applicationAnalysis,
      ...(migrationNeedsInput !== null ? { migrationNeedsInput } : {}),
      ...(markerPresent ? { vendorOverrides } : {}),
      ...(manifestOverrides !== undefined ? { manifestOverrides } : {}),
      ...(vendorDismissedRejections.length > 0 ? { vendorDismissedRejections } : {}),
      analysisVersion: ANALYSIS_VERSION,
      ...(engine !== 'rules' ? { analysisEngine: engine } : {}),
      ...(aiRun ? { aiEngine: aiRun.record } : {}),
      ...(headSha !== undefined ? { analysisCommitSha: headSha } : {}),
    };
    // The stored report keeps every finding; the persisted verdict reads the
    // report the way the page does — with the vendor's port and start
    // command applied — so the list badge and the readiness page agree.
    const outcomeReadiness = effectiveReadinessReport({
      containerPort: contractFieldUpdates.containerPort ?? app.containerPort,
      detectedMetadata: { ...app.detectedMetadata, readiness },
    }) ?? readiness;
    const outcomeVerdict = verdictFromReadiness(outcomeReadiness.state);
      return { contractFieldUpdates, detectedMetadata, outcomeReadiness, outcomeVerdict };
    };
    const durationMs = Date.now() - runStartedMs;

    const persisted = await deps.db.transaction(async (tx) => {
      const [fresh] = await tx
        .select()
        .from(schema.applications)
        .where(eq(schema.applications.id, applicationId))
        .limit(1)
        .for('update');
      if (!fresh) return undefined;
      const outcome = buildOutcome(fresh);
      await tx
        .update(schema.applications)
        .set({
          analysisStatus: 'COMPLETE',
          compatibilityStatus: outcome.outcomeVerdict,
          compatibilityReason: outcome.outcomeReadiness.summary,
          detectedMetadata: outcome.detectedMetadata,
          ...outcome.contractFieldUpdates,
        })
        .where(eq(schema.applications.id, applicationId));
      await recordEvent(tx, {
        organizationId: organizationId!,
        eventType: 'application.analysis_completed',
        actorType: 'system',
        actorId: `analysis:${applicationId}`,
        payload: completedEventPayload({
          applicationId,
          analysisVersion: ANALYSIS_VERSION,
          durationMs,
          runtime: mergedAnalysis.metadata['runtime'],
          readiness: outcome.outcomeReadiness,
          compatibility: outcome.outcomeVerdict,
        }),
      });
      return { fresh, outcome };
    });

    // Jev requirements/plan shadow (PR 2): fire-and-forget telemetry after
    // the persist step. The runner swallows its own errors; it can never
    // touch the production state written above.
    if (persisted) {
      void deps.jevShadow
        ?.run({
          applicationId,
          commitSha: headSha ?? 'unknown',
          application: persisted.fresh,
          contractFieldUpdates: persisted.outcome.contractFieldUpdates,
          detectedMetadata: persisted.outcome.detectedMetadata,
          analysis: mergedAnalysis,
          tree,
        })
        .catch(() => {});
    }
  } catch (error) {
    await markFailed(deps.db, applicationId, organizationId, error, Date.now() - runStartedMs);
  }
}

async function markFailed(
  db: RuntimeDb,
  applicationId: string,
  organizationId: string | undefined,
  error: unknown,
  durationMs: number,
): Promise<void> {
  const reason =
    error instanceof ApiError ? error.message : 'Repository analysis failed unexpectedly';
  // This runs detached on the worker Lambda and every error above is caught,
  // so this line is the ONLY trace a failed run leaves anywhere. Without it a
  // vendor's "Re-analyse does nothing" is undiagnosable: the row says FAILED,
  // the worker log says nothing at all. The original error goes out too — the
  // persisted `reason` is deliberately vendor-facing and loses the detail.
  console.error(`[analysis] application ${applicationId} FAILED: ${reason}`, error);
  try {
    await db.transaction(async (tx) => {
      await tx
        .update(schema.applications)
        .set({ analysisStatus: 'FAILED', compatibilityReason: reason })
        .where(eq(schema.applications.id, applicationId));
      if (organizationId !== undefined) {
        await recordEvent(tx, {
          organizationId,
          eventType: 'application.analysis_failed',
          actorType: 'system',
          actorId: `analysis:${applicationId}`,
          payload: { schemaVersion: 1, applicationId, failureCode: analysisFailureCode(error), durationMs },
        });
      }
    });
  } catch {
    // The DB write itself failed (e.g. connection dropped mid-run) — there
    // is nothing more we can do here. The row is left in ANALYZING; a retry
    // (re-POSTing /analyse) is the recovery path. Never rethrow.
  }
}

/**
 * Stable, deterministic failure classification for analysis_failed events —
 * never exception text. The existing failure path throws ApiError codes
 * (github.ts/analysis.ts); collapse them into the smallest enum that still
 * separates a vendor-fixable repo problem from a Deployz/GitHub-side outage.
 */
function analysisFailureCode(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'GITHUB_DISABLED':
        return 'github_disabled';
      case 'GITHUB_INSTALLATION_MISSING':
      case 'GITHUB_NOT_CONNECTED':
        return 'github_installation_missing';
      case 'GITHUB_RATE_LIMITED':
        return 'github_rate_limited';
      case 'GITHUB_REPO_FULL_NAME_INVALID':
      case 'GITHUB_REPO_NOT_FOUND':
      case 'GITHUB_REPO_EMPTY':
        return 'repository_unavailable';
      default:
        // token/tree fetch failures and other GitHub 5xx.
        return 'github_unavailable';
    }
  }
  return 'internal_error';
}

/**
 * The stored semantic readiness report (`detected_metadata.readiness`), when
 * the row carries one. Older rows predate the report and read as null.
 */
function storedReadinessReport(metadata: Record<string, unknown> | null): ReadinessReport | null {
  const raw = asRecord(metadata?.['readiness']);
  return typeof raw['state'] === 'string' && Array.isArray(raw['findings']) && 'summary' in raw
    ? (raw as unknown as ReadinessReport)
    : null;
}

/** Shared analysis_completed payload — full run and cache hit use one shape. */
function completedEventPayload(params: {
  applicationId: string;
  analysisVersion: number;
  durationMs: number;
  runtime: unknown;
  readiness: ReadinessReport | null;
  compatibility: string | null;
  cached?: boolean;
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    schemaVersion: 1,
    applicationId: params.applicationId,
    analysisVersion: params.analysisVersion,
    durationMs: params.durationMs,
  };
  // Runtime/framework family only — never repo content or env values.
  if (typeof params.runtime === 'string' && params.runtime.length > 0) {
    payload['runtime'] = params.runtime;
  }
  if (params.readiness) {
    payload['readiness'] = params.readiness.state;
    payload['compatibility'] = params.compatibility ?? verdictFromReadiness(params.readiness.state);
    payload['findingCount'] = params.readiness.findings.length;
    payload['blockingCount'] = params.readiness.findings.filter((finding) => finding.blocking).length;
  }
  if (params.cached) payload['cached'] = true;
  return payload;
}

// ── Task 6 commit-SHA analysis cache ────────────────────────────────────────

/**
 * Guards + mints the ONE installation token a real-mode run needs — shared
 * by the Task 6 head-sha cache lookup and (on a full run) the tree/blob
 * fetch, so a full run never mints more than once. Never called in fixture
 * mode. Throws the same structured errors a full run always threw on a
 * missing installation / unconfigured App / minting failure — a real-mode
 * run that can't get a token was always going to fail regardless of the
 * cache.
 */
async function mintRealModeToken(deps: AnalysisRunnerDeps, application: ApplicationRow): Promise<string> {
  if (!application.githubInstallationId) {
    throw new ApiError(
      422,
      'GITHUB_INSTALLATION_MISSING',
      'No GitHub installation is linked to this application',
    );
  }
  // Checked when the run starts, not when it was requested: a run queued
  // before a disconnect must not get a token after it.
  requireActiveInstallation(
    await createGithubStore(deps.db).get(application.githubInstallationId),
    application.organizationId,
  );
  if (!deps.githubAppId || !deps.githubAppPrivateKey) {
    throw new ApiError(503, 'GITHUB_DISABLED', 'GitHub App is not configured');
  }
  const { token } = await mintInstallationToken(
    application.githubInstallationId,
    deps.githubAppId,
    deps.githubAppPrivateKey,
    deps.now ? deps.now() : Date.now(),
    deps.fetchFn,
  );
  return token;
}

/** A cache hit: the stored analysis was for this exact commit and analyser version. */
function isCommitShaCacheHit(metadata: Record<string, unknown> | null, headSha: string, engine: AnalysisEngine): boolean {
  if (!metadata) return false;
  return (
    metadata['analysisCommitSha'] === headSha &&
    metadata['analysisVersion'] === ANALYSIS_VERSION &&
    (metadata['analysisEngine'] ?? 'rules') === engine
  );
}

// ── Repo/branch resolution + tree fetch ─────────────────────────────────────

// `realModeToken` is minted once by `mintRealModeToken` in
// `runApplicationAnalysis` (real mode only) and reused here — this function
// never mints its own token, so a full run mints exactly one.
async function fetchTreeForApplication(
  deps: AnalysisRunnerDeps,
  application: ApplicationRow,
  realModeToken: string | undefined,
): Promise<FileTree> {
  if (deps.githubFixtureMode) {
    return getFileTreeForAnalysis(application.repoFullName, { fixtureMode: true });
  }
  return getFileTreeForAnalysis(application.repoFullName, {
    fixtureMode: false,
    branch: application.defaultBranch,
    installationToken: realModeToken,
    fetchFn: deps.fetchFn,
  });
}

/** Fetches the AI evidence files of the analysed commit; null in fixture mode, where the tree is all there is. */
function evidenceFileLoader(
  deps: AnalysisRunnerDeps,
  application: ApplicationRow,
  realModeToken: string | undefined,
): ((paths: readonly string[]) => Promise<FileTree>) | null {
  if (deps.githubFixtureMode || !realModeToken) return null;
  const ref = { ...parseRepoFullName(application.repoFullName), branch: application.defaultBranch };
  return (paths) => fetchFilesForAnalysis(ref, realModeToken, deps.fetchFn, paths);
}

// ── §15 AI repository-analysis fallback ─────────────────────────────────────

/** The deterministic facts `RepositoryAiInput.detected` needs, read off `analysis.metadata`. */
function buildRepositoryAiInput(
  tree: FileTree,
  analysis: AnalysisResult,
  unresolved: string[],
): RepositoryAiInput {
  const metadata = analysis.metadata;
  const buildCommands = metadata['buildCommands'];
  const startupCommands = metadata['startupCommands'];
  const postgres = metadata['postgres'] as { required?: unknown } | undefined;
  const redis = metadata['redis'] as { required?: unknown } | undefined;

  return {
    detected: {
      packageManager: typeof metadata['packageManager'] === 'string' ? metadata['packageManager'] : null,
      framework: typeof metadata['framework'] === 'string' ? metadata['framework'] : null,
      buildCommand: Array.isArray(buildCommands) && typeof buildCommands[0] === 'string' ? buildCommands[0] : null,
      startCommand:
        Array.isArray(startupCommands) && typeof startupCommands[0] === 'string' ? startupCommands[0] : null,
      port: typeof metadata['port'] === 'string' ? metadata['port'] : null,
      dockerfilePath: typeof metadata['dockerfilePath'] === 'string' ? metadata['dockerfilePath'] : null,
      postgresRequired: postgres?.required === true,
      redisRequired: redis?.required === true,
      migrationCommandDetected: metadata['hasMigrationCommand'] === true,
    },
    files: selectAiContextFiles(tree),
    unresolved,
    ambiguities: deriveAmbiguities(tree, analysis),
  };
}

/** Read the collected aiSuggestions object (merged across phases). */
function collectSuggestions(metadata: Record<string, unknown>): Record<string, unknown> {
  const raw = metadata['aiSuggestions'];
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The AI Analysis budget for the whole run: one analyst call and the checks, inside the 15-minute worker. */
const AI_ENGINE_TIMEOUT_MS = 240_000;

const disputeKey = (entry: VendorDismissedRejection): string => `${entry.findingId}\n${entry.reason}`;

/**
 * The locked row's answers with `stale` set from this run: an answer this run
 * read is stale when its evidence no longer matched. An answer this run did
 * not read keeps its state.
 */
function refreshDisputes(
  current: readonly VendorDismissedRejection[],
  read: readonly VendorDismissedRejection[],
  matched: ReadonlySet<number>,
): VendorDismissedRejection[] {
  const readKeys = new Set(read.map(disputeKey));
  const matchedKeys = new Set(read.filter((_, index) => matched.has(index)).map(disputeKey));
  return current.map((entry) => {
    if (!readKeys.has(disputeKey(entry))) return entry;
    const { stale: _stale, ...rest } = entry;
    return matchedKeys.has(disputeKey(entry)) ? rest : { ...rest, stale: true };
  });
}

/**
 * Runs the AI-first Analysis and never throws: any failure (no gateway, an
 * outage, a timeout, invalid output) returns no merge, and the caller keeps
 * the rules result. `record` is stored as `detected_metadata.aiEngine` for
 * the shadow comparison and the spend log.
 */
async function runAiEngine(
  gateways: AiAnalysisGateways | undefined,
  tree: FileTree,
  analysis: AnalysisResult,
  loadFiles: ((paths: readonly string[]) => Promise<FileTree>) | null,
  baseOverrides: ResourceOverrides,
): Promise<{ merge: MergeResult | null; record: Record<string, unknown> }> {
  const startedAt = Date.now();
  if (!gateways) return { merge: null, record: { status: 'fallback', reason: 'not_configured' } };
  try {
    const requested = loadFiles === null ? [] : evidenceFileRequests(tree, analysis);
    // An unreadable evidence file only narrows the windows; it never stops the AI Analysis.
    const evidenceFiles = requested.length > 0 && loadFiles !== null ? await loadFiles(requested).catch(() => ({})) : {};
    const outcome = await runAiAnalysis({ tree, rules: analysis, gateways, evidenceFiles, baseOverrides }, { abortSignal: AbortSignal.timeout(AI_ENGINE_TIMEOUT_MS) });
    return { merge: outcome.merge, record: { status: 'ok', ...outcome.report, generatedAt: new Date().toISOString() } };
  } catch (error) {
    const reason = error instanceof Error ? error.name : 'unknown';
    // The provider's status and a short, redacted message: enough to tell a
    // routing or key problem from an outage, never the request content.
    const { statusCode, responseBody } = (error ?? {}) as { statusCode?: unknown; responseBody?: unknown };
    const detail = {
      ...(typeof statusCode === 'number' ? { statusCode } : {}),
      ...(error instanceof Error ? { message: redactSecrets(error.message).slice(0, 200) } : {}),
      ...(typeof responseBody === 'string' ? { responseBody: redactSecrets(responseBody).slice(0, 500) } : {}),
    };
    console.warn(JSON.stringify({ event: 'ai_analysis_fallback', reason, ...detail, latencyMs: Date.now() - startedAt }));
    return { merge: null, record: { status: 'fallback', reason, ...detail, latencyMs: Date.now() - startedAt } };
  }
}

/**
 * Runs the §15 AI fallback when (and only when) `collectUnresolvedQuestions`
 * finds something the deterministic scanner could not resolve, then merges
 * the answer with `mergeAiAnalysis` (deterministic always wins). Any AI
 * failure — unconfigured gateway, network error, timeout, schema violation —
 * is caught here and degrades to the deterministic metadata plus a warning;
 * it must never fail an analysis the deterministic scanner completed.
 */
async function applyAiFallback(
  aiGateway: AiGateway,
  tree: FileTree,
  analysis: AnalysisResult,
): Promise<{ metadata: Record<string, unknown>; aiResolved: string[]; multiServiceDowngraded?: boolean }> {
  const unresolved = collectUnresolvedQuestions(tree, analysis);
  if (unresolved.length === 0) {
    return { metadata: analysis.metadata, aiResolved: [] };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REPO_AI_TIMEOUT_MS);
  try {
    const input = buildRepositoryAiInput(tree, analysis, unresolved);
    const ai = await analyseRepositoryWithAi(input, aiGateway, { abortSignal: controller.signal });
    const outcome = mergeAiAnalysis(analysis.metadata, ai);
    const suggestions = collectSuggestions(outcome.metadata);
    const aiResolved = [...outcome.aiResolved];
    // Phase 10: the AI's architecture answers. A compose multi-service
    // rejection may be downgraded ONLY when the AI confidently (>=0.9, with
    // evidence) classifies every contested service optional/dev/integration;
    // 0.7–0.89 records a vendor-review suggestion while the rejection stands.
    const hasComposeRejection = analysis.rejections?.some(
      (r) => r.dependency === 'docker-compose-multi-service' && r.detected,
    );
    const architectureAnswers = ai.architectureRequirements ?? {};
    let multiServiceDowngraded = false;
    if (hasComposeRejection) {
      const allOptional = Object.values(architectureAnswers).every((entry) => {
        if (entry.requirement !== 'optional' && entry.requirement !== 'development_only' && entry.requirement !== 'integration_only') {
          return false;
        }
        return entry.confidence >= 0.9 && entry.evidencePaths.length > 0;
      });
      multiServiceDowngraded = allOptional && Object.keys(architectureAnswers).length > 0;
      for (const [service, entry] of Object.entries(architectureAnswers)) {
        if (entry.confidence >= 0.7 && entry.confidence < 0.9 && entry.requirement !== 'required') {
          suggestions.architecture = {
            ...asRecord(suggestions.architecture),
            [service]: entry,
          };
          aiResolved.push(`suggestion:architecture.${service}`);
        }
      }
    }
    return {
      metadata: {
        ...outcome.metadata,
        aiAnalysis: {
          unresolved,
          ambiguities: deriveAmbiguities(tree, analysis),
          aiResolved,
          suggestions,
          warnings: outcome.warnings,
          promptVersion: REPOSITORY_AI_PROMPT_VERSION,
          generatedAt: new Date().toISOString(),
        },
      },
      aiResolved,
      multiServiceDowngraded,
    };
  } catch {
    return {
      metadata: {
        ...analysis.metadata,
        aiAnalysis: { unresolved, warnings: ['AI analysis unavailable'] },
      },
      aiResolved: [],
    };
  } finally {
    clearTimeout(timer);
  }
}

// ── Legacy §19 checks shape ─────────────────────────────────────────────────
// No longer written — analyses persist `detected_metadata.readiness` instead.
// Kept only so computeReadiness (server.ts) can degrade gracefully when it
// reads a row analysed before the semantic-readiness report existed.

export interface ReadyCheck {
  label: string;
}
export interface AttentionCheck {
  title: string;
  detail: string;
  suggestedFix: string | null;
}
export interface UnsupportedCheck {
  title: string;
  reason: string;
}

// ── §35 contract field backfill ─────────────────────────────────────────────

// The §18 migration-command / worker detectors only report WHICH pattern
// matched (e.g. "drizzle-kit"), not the literal script text — not enough to
// persist as an executable command. This looks at package.json script KEYS
// directly (independent of, and narrower than, the §18 detectors) to
// recover an actual runnable command for the two contract fields that need
// one; it only ever proposes a value, never invents one. `collectScripts`
// (shared with the §18 detectors) reads every workspace package's scripts,
// not just the root manifest's — a monorepo's migration/worker script
// usually lives in the app package, not the workspace root.
const WORKER_SCRIPT_KEY_REGEX = /^worker$|worker[:-]?start|start[:-]?worker/i;

/**
 * A migration command analysis can persist, or a script it found but cannot
 * confirm the built image runs — then the vendor decides
 * (`migration-command-needs-input`).
 */
type MigrationCommandResolution = { command: string } | { candidate: string; reason: string };

/**
 * The vendor's package.json script is written to run via npm/pnpm/yarn's own
 * script runner, which puts the package's `node_modules/.bin` on PATH. The
 * relay's DEPLOY_RELEASE executor runs `sh -c <command>` directly inside the
 * built image, so a bare CLI-binary invocation exits 127 there. A bare ORM
 * CLI gets `npx` only when the runtime image provides `npx` and already holds
 * the CLI (`migrationRunnerVerdict`); a runner the image is not shown to
 * provide is never added, substituted or installed — the vendor decides.
 */
function qualifyMigrationCommand(tree: FileTree, command: string, packageDir: string): MigrationCommandResolution {
  const verdict = migrationRunnerVerdict(tree, command);
  if (!verdict.runnable) return { candidate: command, reason: verdict.reason };
  return { command: withPrismaSchemaFlag(verdict.needsNpx ? `npx ${command}` : command, packageDir, tree) };
}

const NPX_PRISMA_MIGRATE_DEPLOY_REGEX = /^npx\s+prisma\s+migrate\s+deploy\b/;
const SCHEMA_FLAG_REGEX = /--schema\b/;
const SCHEMA_PRISMA_PATH_REGEX = /(?:^|\/)schema\.prisma$/;

/**
 * The `schema.prisma` that belongs to the migration script's own package:
 * directly in the package's directory, then its `prisma/` subdirectory,
 * then — only if there is exactly one anywhere in the tree — that one.
 * `node_modules` copies are never candidates.
 */
function findPrismaSchemaPath(tree: FileTree, packageDir: string): string | undefined {
  const candidates = Object.keys(tree).filter(
    (path) => SCHEMA_PRISMA_PATH_REGEX.test(path) && !path.includes('node_modules/'),
  );
  if (candidates.length === 0) return undefined;
  const direct = packageDir ? `${packageDir}/schema.prisma` : 'schema.prisma';
  if (candidates.includes(direct)) return direct;
  const nested = packageDir ? `${packageDir}/prisma/schema.prisma` : 'prisma/schema.prisma';
  if (candidates.includes(nested)) return nested;
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** The selected Dockerfile's raw content, same ranking `detectDockerfile` uses. */
function selectedDockerfileContent(tree: FileTree): string | undefined {
  const path = listDockerfileCandidates(tree)[0];
  return path !== undefined ? tree[path] : undefined;
}

/**
 * If `command` (after the npx-prefix rewrite) is a Prisma `migrate deploy`
 * invocation with no explicit `--schema`, append one computed from the
 * schema's real location relative to the image's runtime WORKDIR. Prisma's
 * CLI does not search upward for a schema from an arbitrary cwd, and the
 * relay's `sh -c` runs the command from the image's WORKDIR — not from the
 * script's own package directory the way npm/pnpm/yarn would run it. Left
 * alone when the schema can't be located, or already sits at Prisma's
 * default lookup location relative to that cwd (`./schema.prisma` or
 * `./prisma/schema.prisma`) — an explicit flag there would be redundant.
 * Only ever applied to a command WE just npx-prefixed, or one the vendor
 * already wrote as `npx prisma migrate deploy` — an already-qualified
 * `pnpm prisma migrate deploy` etc. is left alone, matching the npx-prefix
 * rule's "never second-guess a vendor's already-qualified command".
 */
function withPrismaSchemaFlag(command: string, packageDir: string, tree: FileTree): string {
  if (!NPX_PRISMA_MIGRATE_DEPLOY_REGEX.test(command) || SCHEMA_FLAG_REGEX.test(command)) {
    return command;
  }
  const schemaPath = findPrismaSchemaPath(tree, packageDir);
  if (!schemaPath) return command;

  const dockerfileContent = selectedDockerfileContent(tree);
  const { imageRoot, runtimeCwd } = dockerfileContent !== undefined ? dockerfileWorkdirs(dockerfileContent) : { imageRoot: '/', runtimeCwd: '/' };
  const rootFromCwd = posixPath.relative(runtimeCwd, imageRoot);
  const schemaFromCwd = posixPath.join(rootFromCwd, schemaPath);

  if (schemaFromCwd === 'schema.prisma' || schemaFromCwd === 'prisma/schema.prisma') {
    return command;
  }
  return `${command} --schema ${schemaFromCwd}`;
}

/**
 * Resolve the migration command to persist as the §35 `migrationCommand`
 * contract field — the command the relay's DEPLOY_RELEASE executor runs
 * unattended against the production database on every deploy, so this picks
 * defensively:
 *
 *   The script comes from `selectMigrationScript` (@deployz/analysis): only a
 *   safe, deploy-shaped migration script of the deployed app's own package —
 *   never a create/generate/push/reset, test, copy/build step, chain with an unsafe step, or
 *   workspace-filtered command, and never a devDependency-only CLI. When
 *   nothing qualifies this returns undefined — an absent migration command is
 *   safer than a wrong one running unattended.
 *
 * The selected script's literal value is then rewritten into a command that
 * is actually runnable where the relay executes it: `sh -c <command>` inside
 * the built image, at the image's runtime WORKDIR, with no node_modules/.bin
 * on PATH (see `qualifyMigrationCommand`/`withPrismaSchemaFlag`) — the
 * package.json author wrote it assuming npm/pnpm/yarn's own script-running
 * environment, not the relay's.
 */
function resolveMigrationCommand(tree: FileTree): MigrationCommandResolution | undefined {
  const script = selectMigrationScript(tree);
  if (!script) return undefined;
  const [, command, packageDir] = script;
  return qualifyMigrationCommand(tree, command, packageDir);
}

/**
 * The migration command analysis writes for a field the vendor does not own.
 * DEPLOY-029: mode 'startup' means the built image already migrates itself
 * when it starts (the selected Dockerfile's CMD/ENTRYPOINT chain carries the
 * evidence — see `analyseRepo`). Persisting a detected package.json script
 * there would run it a second time as a pre-deploy step against a command the
 * image was never built to run standalone (umami: `sh: npx: not found`), so
 * the column is cleared — also a value a pre-fix analysis already invented.
 * Undefined leaves the column as it is: finding nothing never clears it.
 */
function detectedMigrationCommand(
  tree: FileTree,
  analysis: AnalysisResult,
  aiResolved: string[],
): MigrationCommandResolution | { command: null } | undefined {
  if (analysis.metadata['migrationMode'] === 'startup') return { command: null };
  if (aiResolved.includes('noMigration')) return { command: null };
  const migrationCommands = analysis.metadata['migrationCommands'];
  if (aiResolved.includes('migrationCommand') && Array.isArray(migrationCommands) && typeof migrationCommands[0] === 'string') {
    return qualifyMigrationCommand(tree, migrationCommands[0], '');
  }
  const aiQuestion = analysis.metadata['aiMigrationQuestion'] as { candidate?: unknown; reason?: unknown } | undefined;
  if (typeof aiQuestion?.candidate === 'string' && typeof aiQuestion.reason === 'string') {
    return { candidate: aiQuestion.candidate, reason: aiQuestion.reason };
  }
  const resolved = resolveMigrationCommand(tree);
  if (resolved) return resolved;
  if (aiResolved.includes('migrationCommands') && Array.isArray(migrationCommands) && typeof migrationCommands[0] === 'string') {
    return qualifyMigrationCommand(tree, migrationCommands[0], '');
  }
  const question = analysis.metadata['migrationQuestion'] as { candidate?: unknown; reason?: unknown } | undefined;
  if (typeof question?.candidate === 'string' && typeof question.reason === 'string') {
    return { candidate: question.candidate, reason: question.reason };
  }
  return undefined;
}

/**
 * Resolve EVERY declared worker start command (Phase 4A: one workload per
 * declared process): a Procfile/Compose-declared process leads (each keeps
 * its own slug id and source), then one `worker` entry from a package.json
 * worker script in any workspace package. A dev or watch script is never a
 * worker, nor is a script the image's start command already runs next to the
 * web process. Empty when nothing resolves—
 * worker-like code without a command never produces a workload here.
 */
export interface ResolvedWorkerCommand {
  id: string;
  command: string;
  source: string;
}

export function resolveWorkerCommands(tree: FileTree): ResolvedWorkerCommand[] {
  const workers: ResolvedWorkerCommand[] = [];
  const seen = new Set<string>();
  for (const declared of detectDeclaredWorkerCommands(tree)) {
    if (seen.has(declared.id)) continue;
    seen.add(declared.id);
    workers.push({ id: declared.id, command: declared.command, source: declared.source });
  }
  // A worker script of an app whose queue runs only in an optional mode (n8n `EXECUTIONS_MODE=queue`)
  // would start a worker that the default mode never feeds.
  if (workers.length === 0 && !mainCommandRunsWorker(tree) && optionalQueueMode(tree) === null) {
    const match = collectScripts(tree).find(([key, command]) => WORKER_SCRIPT_KEY_REGEX.test(key) && !isDevToolCommand(command));
    if (match?.[1] !== undefined) {
      workers.push({ id: 'worker', command: match[1], source: 'package.json' });
    }
  }
  return workers;
}

export interface ContractFieldUpdates {
  containerPort?: number;
  // A root check (`/` probed by the image's own HEALTHCHECK) clears a saved
  // detected path, so the manifest keeps its redirect-accepting default.
  healthPath?: string | null;
  // Startup mode clears a stale detected command (never a vendor one) —
  // see the DEPLOY-029 handling below — so it can be explicitly nulled out,
  // not just left absent.
  migrationCommand?: string | null;
  workerCommand?: string;
  databaseRequired?: boolean;
  storageRequired?: boolean;
  redisRequired?: boolean;
}

/**
 * The §35 contract fields the vendor has explicitly edited, as recorded by
 * PATCH /api/applications/:id on `detected_metadata.vendorOverrides`. Any
 * other shape (older rows, hand-written metadata) reads as "nothing is
 * vendor-owned yet".
 */
export function readVendorOverrides(metadata: Record<string, unknown> | null): string[] {
  const raw = metadata?.['vendorOverrides'];
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * A row analysed before `vendorOverrides` existed has no list to say which
 * saved values the vendor chose. Its non-null saved columns stay as they are;
 * analysis only fills the empty ones.
 */
export function legacySavedFields(app: {
  containerPort: number | null;
  healthPath: string | null;
  migrationCommand: string | null;
  workerCommand: string | null;
}): string[] {
  return (['containerPort', 'healthPath', 'migrationCommand', 'workerCommand'] as const).filter(
    (field) => app[field] !== null,
  );
}

/**
 * Writes the §35 contract fields the analyser found, so a re-analysis picks
 * up what actually changed in the repository (a moved port, a new /health
 * route, a renamed migrate script). Two rules bound it:
 *
 *   - A field the vendor edited (`vendorOverrides`) is never touched again.
 *     Being non-null is NOT enough on its own — the previous analysis wrote
 *     most of these values, and treating its own output as vendor intent is
 *     exactly what froze re-analysis.
 *   - Only a positive detection writes. Finding nothing never clears an
 *     existing value: a single unreadable blob drops that file from the
 *     tree (fetchBlobContent returns null on error), so "not detected" is
 *     not reliable enough to wipe a vendor's deployment contract. Booleans
 *     move false -> true on evidence, never back.
 *
 * `analysis` carries the MERGED (post-§15 AI fallback) metadata, and
 * `aiResolved` names which keys the AI filled — `databaseRequired`/
 * `redisRequired` pick up an AI-resolved flip for free via `analysis.metadata`
 * (the same gate `mergeAiAnalysis` already applied), while `containerPort`/
 * `migrationCommand` only fall back to the AI value when `aiResolved` says
 * so, since neither is derivable from `analysis.findings` the way the
 * deterministic path is.
 */
function deriveContractFieldUpdates(
  vendorOverrides: string[],
  tree: FileTree,
  analysis: AnalysisResult,
  aiResolved: string[],
  workerCommand: string | undefined,
): ContractFieldUpdates {
  const updates: ContractFieldUpdates = {};
  const vendorOwned = new Set(vendorOverrides);
  const finding = (name: string) => analysis.findings.find((f) => f.detector === name);

  if (!vendorOwned.has('containerPort')) {
    const port = finding('port');
    // Stage B phase 7: a framework-default port (low confidence) is a prefill
    // only — it is never auto-persisted as the application's contract port.
    if (port?.detected && port.portConfidence !== 'low' && typeof port.value === 'string') {
      const parsed = Number.parseInt(port.value, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        updates.containerPort = parsed;
      }
    } else if (aiResolved.includes('port') && typeof analysis.metadata['port'] === 'string') {
      const parsed = Number.parseInt(analysis.metadata['port'] as string, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        updates.containerPort = parsed;
      }
    }
  }

  if (!vendorOwned.has('healthPath')) {
    const health = finding('health-endpoint');
    // The health-endpoint detector's normalized `path` names the literal
    // path it found evidence for (a route registration, a file-based route
    // convention, or the "/health" default when only a Dockerfile
    // HEALTHCHECK / package.json script was found) — see detectors.ts.
    if (health?.detected && health.path) {
      // A saved `/` would be an explicit path whose check refuses the
      // redirect that a login page answers (cal.com `/` → `/auth/login`).
      updates.healthPath = health.mode === 'root' ? null : health.path;
    }
  }

  // Only the vendor's own value is left alone. A script the image is not
  // shown to run clears the column, so an earlier invented `npx …` command
  // never keeps running; the open question carries the script instead.
  if (!vendorOwned.has('migrationCommand')) {
    const resolution = detectedMigrationCommand(tree, analysis, aiResolved);
    if (resolution !== undefined) {
      updates.migrationCommand = 'command' in resolution ? resolution.command : null;
    }
  }

  if (!vendorOwned.has('workerCommand') && workerCommand) {
    updates.workerCommand = workerCommand;
  }

  if (!vendorOwned.has('databaseRequired')) {
    // Unlike a mere detector `detected` flag (library presence), RDS
    // provisioning is gated on the required-vs-present evidence rule — a
    // driver/ORM dependency alone never provisions a database.
    // `metadata.postgres.required` / `metadata.mysql.required` (Phase 4B)
    // are those gates, computed once and carried through `analysis.metadata`.
    const postgres = analysis.metadata['postgres'] as { required?: unknown } | undefined;
    const mysql = analysis.metadata['mysql'] as { required?: unknown } | undefined;
    if (postgres?.required === true || mysql?.required === true) updates.databaseRequired = true;
  }

  if (!vendorOwned.has('storageRequired')) {
    const s3 = finding('s3');
    if (s3?.detected) updates.storageRequired = true;
  }

  if (!vendorOwned.has('redisRequired')) {
    // Unlike `databaseRequired`/`storageRequired` (driven straight off a
    // detector's `detected` flag), Redis provisioning is gated on the §7
    // confidence policy, not mere presence — `metadata.redis.required` is
    // already that gate (high confidence AND a supported setup), computed
    // once by `assessRedis` and carried through `analysis.metadata`.
    const redis = analysis.metadata['redis'] as { required?: unknown } | undefined;
    if (redis?.required === true) updates.redisRequired = true;
  }

  return updates;
}
