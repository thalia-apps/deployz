# AI application analysis, preflight and failure diagnosis

The reference for the P0/P1 AI capabilities of the Deployz MVP: how a
repository becomes a validated application model, how that model gates
deployment, and how a failed deployment is explained. The design decisions
behind the AI boundary are in `docs/decisions/README.md`.

## Operating principle

> **AI infers and explains. Deterministic Deployz systems provision and
> mutate AWS infrastructure.**

- The AI may inspect repository content, resolve ambiguous facts, classify
  and explain. It never calls AWS, never generates infrastructure, never
  changes deployment or job state, never flips a failure code, and never
  produces a secret value. It flips a deterministic Analysis verdict in two
  cases only: the Compose multi-service downgrade (see "AI fallback"), and
  a checked answer under `ANALYSIS_ENGINE=ai` (see "AI-first Analysis").
- Every AI output crosses a strict Zod schema before anything reads it. A
  malformed, oversized or missing answer degrades to the deterministic
  result — an analysis still completes, a diagnosis still shows copy-map
  text, a deployment never depends on the model being available.
- Repository files, sample env files and error text are untrusted data. The
  prompts say so; secret-looking values are redacted before they leave the
  process; raw application logs are never collected.

## The flow

```
Repository (GitHub tree, bounded)
  → analyseRepo: deterministic detectors + rejection checks
  → ANALYSIS_ENGINE=rules (default): AI fallback ONLY for an
    unresolved question; merge is deterministic-always-wins
    ANALYSIS_ENGINE=ai: checked AI answers fill the open facts and
    can dismiss a blocker candidate
  → ApplicationAnalysis (canonical, typed, evidenced)
  → ReadinessReport (findings) · DeploymentManifest (contract)
  → Preflight gate at every path into provisioning
  → Deterministic engine: release build, INSTALL, DEPLOY_RELEASE, config
  → AWS (customer account, through the relay only)
  → Structured job results, CloudFormation events, heartbeats
  → refineFailureCode → DeploymentFailureContext
  → Copy-map explanation; AI explanation for the app-owned evidence-rich
    set (UNKNOWN + startup/config codes), with confidence
  → Vendor and customer UI (plain words; raw detail behind disclosures)
```

## Repository analysis

- **Orchestrator:** `runApplicationAnalysis` (`apps/api/src/analysis.ts`).
  Fetches a bounded file tree, runs `analyseRepo` (`packages/analysis/src/
  analyser.ts`), applies the AI fallback when needed, builds the readiness
  report and the canonical projection, backfills the contract fields the
  vendor has not edited, and persists everything in one write to
  `applications.detected_metadata`.
- **Commit cache:** a run is skipped when `analysisCommitSha` and
  `analysisVersion` match the stored ones. `ANALYSIS_VERSION` must be
  bumped whenever detector output or the projection changes shape, so
  stored rows re-run.
  Nothing re-runs a stale row by itself. `GET /api/applications/:id/readiness`
  returns `analysisOutdated` (the stored `analysisVersion` differs from
  `ANALYSIS_VERSION`), and the application header then shows a "Checks have
  been updated" notice with a Re-analyse action. The vendor starts the run.
- **Detectors** (`packages/analysis/src/detectors.ts`): Dockerfile,
  framework, port (six tiers), health endpoint, env vars, PostgreSQL
  (required vs present), MySQL (required vs present, with the engine
  choice recorded on the manifest; a MariaDB-only driver stays a
  rejection), local filesystem, declared worker processes, S3, migration
  command,
  start command, external services, package manager, build command,
  **runtime** (Dockerfile base image, then the shallowest manifest) and
  **bind address** (loopback-only servers). Redis is assessed separately
  with confidence and purpose. Rejections (`rejection.ts`) name the
  unsupported architectures.
- **Evidence scope:** a language package that a Dockerfile `RUN` installs
  (`pip install mysqlclient`) is a declared dependency, the same as a
  manifest entry. `package.json` build and start scripts and the package
  manager describe the app only when there is no Dockerfile, or when the
  selected Dockerfile builds or runs Node. A Python image does not get a
  sibling front end's `react-scripts build`. The Compose port comes from an
  application service, never from a database, cache or proxy service.
- **Runtime precision:** the image is the production stage of the selected
  Dockerfile. This stage is the last stage that is not a dev, test or build
  stage, together with the stages it is built from. A Dockerfile in a test,
  example or dev-container directory, a base image (system packages only, no
  CMD, ENTRYPOINT, EXPOSE or COPY) and a Dockerfile that starts a dev server
  are never selected (a dev server is `npm run dev`, `next dev`, `nodemon`,
  `--reload` or `sleep infinity`). A Dockerfile in a `dev/` build directory
  is selected when it starts something (CMD, ENTRYPOINT or EXPOSE) and is not
  one of those; a `.devcontainer/` or `.gitpod/` Dockerfile never is. A
  Dockerfile named production or prod ranks first. An
  arm or multi-process variant ranks last. When the other signals tie, a
  Dockerfile whose production stage starts something (CMD, ENTRYPOINT or
  EXPOSE) ranks first, then one that declares a port. Dockerfiles that still
  tie are recorded as `dockerfileSelectionTied` and give the recommended
  finding `dockerfile-target-unresolved`. When the last stage is a tooling
  stage (an artifact, upload, export, publish, lint, build or test stage) and
  an earlier named stage is the production stage, the analysis records
  `dockerfileBuildTarget`. The build then runs `docker build --target <stage>`
  (not for a vendor-overridden Dockerfile). The runtime comes from the
  production stage and the stages it is built `FROM` (leaf to root);
  `COPY --from` counts only when that lineage names no runtime image. A
  `go.mod` with no Go source and a `package.json` with no dependencies are
  tooling manifests: they decide the runtime only when nothing else remains.
  A Node framework is reported only for a Node image. The port is the ENV
  PORT or EXPOSE of the production stage, then a HEALTHCHECK of the
  production stage that probes localhost on a port variable with a default
  (`${LIVEBOOK_PORT-8080}`), then the one application service of the
  production Compose file that publishes a port, then a port literal in
  runtime source. An
  image with a front web server (nginx, caddy) publishes port 80. The health
  path, in order: the URL that the HEALTHCHECK of the production stage or a
  production Compose app service probes; a dedicated route that the app
  registers, with the framework prefix and URI version; the Spring actuator
  route. A dedicated route ends in a health word, and only an API root, a
  version or one namespace (for example system) comes before it.
  `status` is accepted only under an API root, or in a JS server. `readyz` and
  `livez` are not taken from source. A route is not used when it is in
  another language than the one the image starts, when two apps in the
  repository register a route and the start command does not name one of
  them, or when a front web server hides the app behind a prefix. In these
  cases the detector reports no path and the vendor is asked. A Dockerfile
  that is a git symlink is read from its target file. A package.json worker
  script is not a worker when it is a dev or watch command, or when the
  start command already runs the worker. A Procfile process is not a worker
  when the runtime image is a known Node, Bun or Deno image that does not
  have the runner the command starts with. Node 26 images have no Yarn
  unless the image runs `corepack enable` or installs Yarn.
- **Build and start checks:** when the selected Dockerfile copies a file or
  directory that the repository does not contain (a build output that a CI
  step makes before `docker build`), the gate blocks with
  `dockerfile-missing-sources`. The vendor adds a Dockerfile that builds the
  app from source, or selects another one. When the full repository path
  list proves there is no Dockerfile that builds a production image (none,
  only development or template files, or a selected Dockerfile that copies
  sources the repository lacks while every other Dockerfile with a CMD or
  ENTRYPOINT also copies a missing source), the repository is
  a repository change (`no-buildable-dockerfile`) instead. A selected
  Dockerfile that copies nothing from the build context (no `COPY` or `ADD`
  without `--from`, no bind mount) is not buildable either: its image runs
  code from another image, not from the commit (outline copies its build and
  `node_modules` from the floating `outlinewiki/outline-base` image), unless
  another candidate with a CMD or ENTRYPOINT copies from the repository. A capped or partial
  file list, a second candidate Dockerfile with a CMD or ENTRYPOINT that
  copies only repository content, a git submodule, `COPY --from=` and a generated
  directory never reject. A Dockerfile that copies `.git`, or a RUN step
  that reads git history (`git rev-parse`, `git describe`) with no `||`
  fallback and no `git clone` or `git init` in the Dockerfile, gives the
  required finding `build-context-git-metadata` (a repository change): the
  source archive has no `.git`. A single Dockerfile with a development
  name is development-only only when its content shows it (a dev server, no
  command, or no build step). A global `ARG` with no default that a `FROM`
  of the production stage lineage reads (`ARG BASE_IMAGE` with
  `FROM ${BASE_IMAGE}`) is a required build variable: the build fails
  without it. A `FROM base-${VARIANT}` also reads the base images of the
  stages that it can select (`base-default`, `base-cuda`). A `go.mod` line marked `// indirect` is not evidence that the
  app uses S3. A package.json `start` script is
  the container command only when it belongs to a package that the image
  runs (the root, the Dockerfile directory or the runtime WORKDIR), the
  package is not a workspace root, and the script does not build first
  (`tsc && node …`). Otherwise the vendor is asked for the start command.
- **Migrations at boot:** a migration that the app runs from its own code at
  boot (knex `migrate.latest()`, Umzug, Drizzle `migrate()`, TypeORM
  `runMigrations()`, golang-migrate, Flask-Migrate `upgrade()`, Django
  `call_command('migrate')`) sets the migration mode to `startup`. Then no
  pre-deploy command is kept. Only the real start path counts: the image
  CMD or ENTRYPOINT and the scripts it runs (a `./app migrate && ./app`
  subcommand, a `migrate deploy` wrapper), a Procfile `web:` line, the s6
  init scripts behind `/init`, and a Go migrator call (`migrations.Up`,
  `goose.Up`, `AutoMigrate`) in a server start file or an `Init` function it
  calls. A runner must be a call, not a declaration. Browser, CLI,
  test-setup and generated code never count. A Procfile `release:` line is
  pre-deploy, not startup. `CREATE TABLE IF NOT EXISTS` is never proof of
  schema upgrades.
- **Health and listener precedence:** a router mounted through an exported
  object (`app.use('/api', routes.api)`) keeps its mount prefix; the
  shortest prefix wins. A Go `r.URL.Path == "/healthz"` check, a NestJS
  `@Get('ping')` under `@Controller('server')` and the global prefix, and a
  HEALTHCHECK that every target of a multi-target Dockerfile shares are
  route candidates. An all-interfaces host in the production start text
  (`--bind 0.0.0.0`, `ENV HOST=0.0.0.0`, also in the script the ENTRYPOINT
  runs) overrides a loopback literal in source. Desktop, Electron and Tauri
  files never count, and a Python `app.run(host="127.0.0.1")` counts only in
  a module the image runs.
- **One relational database:** a required MySQL database gets the same
  bindings (the `DATABASE_*` names plus the names the app reads, such as
  `DB_HOST`), migration mode and migration findings as PostgreSQL.
  `databaseState` names the engine that the manifest provisions.
- **Go PostgreSQL drivers:** a direct `github.com/lib/pq` or `jackc/pgx`
  requirement in `go.mod` counts only when non-test, non-vendored Go source
  imports the module. A requirement that no code imports is not evidence of
  PostgreSQL.
- **Database engine:** PostgreSQL wins when the app can run on it. A Go
  PostgreSQL driver in `go.mod` counts when runtime Go source imports it,
  when an engine selector the app reads defaults to SQLite or PostgreSQL,
  or when a runtime Go file was outside the bounded fetch (the import cannot
  be ruled out). It does not count when runtime Go source declares an
  in-memory store next to the PostgreSQL store (`TypeMemory = "memory"`):
  the app runs without a database until its configuration selects one. The
  engine is MySQL only when a MySQL driver and one independent signal are
  present and PostgreSQL is not a runtime option. The independent signal
  is a `mysql://` or `mysql+pymysql://` URL, a `MYSQL_*` variable, a
  MySQL image in the production Compose file, a Prisma, Django, Spring
  (`jdbc:mysql`), Sequelize or Knex setting, a Dockerfile that installs
  `pdo_mysql`, or a Laravel default connection of `mysql`. A PostgreSQL
  driver that only a Python dev group or a dev requirements file declares
  does not count. A Laravel app that lists a `pgsql` connection keeps
  PostgreSQL. A MariaDB-only client (`mariadb-java-client`, a Laravel
  default of `mariadb`) stays unsupported. A MySQL driver next to a
  MariaDB image or client is MySQL. When a SQLAlchemy app declares PyMySQL
  and not `mysqlclient`, the manifest sets `database.urlScheme` to
  `mysql+pymysql`: SQLAlchemy reads a plain `mysql://` URL as the
  `mysqlclient` driver, which the image does not have.
- **Redis requirement:** Deployz provisions Redis only on strong
  evidence: a Redis client that the app builds at boot from a configured
  connection variable, or a queue library that needs Redis (BullMQ, Bull,
  Sidekiq, RQ, Celery with the `redis` extra). A client library, a
  connection variable, a Compose Redis service, or a README mention is
  not enough alone. A client library plus a configured connection
  variable is enough. Evidence that Redis is optional removes the
  requirement: a switch such as `REDIS_ENABLED` or `USE_CELERY`, a
  connection variable that an env sample comments out or calls optional,
  a connection variable that the code tests before it uses it, a backend
  selector whose default is not Redis (`CACHE_DRIVER=file`,
  `JOBS_PROVIDER=local`), an image that installs its own Redis server, or
  code that sets the connection itself. An env sample comment that says
  Redis is required overrides this evidence. The result is then
  `medium` confidence and the manifest does not request Redis.
- **AI fallback** (`repository-ai.ts`): asked only when a real question is
  open (multiple Dockerfiles, monorepo target, unknown start/build command
  or port, unclear database or Redis requirement), with at most eight files
  / 24k characters of context, sample env files stripped to key names, and
  a strict output schema. `mergeAiAnalysis` lets the AI fill a gap, never
  overwrite; a required-database or Redis flip needs corroborating
  deterministic evidence. One exception: when the rules reject a Compose
  application as `docker-compose-multi-service` and the AI rates every
  contested service optional, development-only or integration-only, with
  confidence 0.9 or more and evidence paths, `apps/api/src/analysis.ts`
  removes that rejection. The call runs with model thinking off and a
  30 s budget (`REPO_AI_TIMEOUT_MS`, two attempts inside it). With thinking
  on, the production model spent the whole output budget on reasoning, so no
  JSON came back and every attempt took longer than the budget.

## AI-first Analysis (`ANALYSIS_ENGINE`)

The AI-first engine (`packages/analysis/src/ai-analysis/`) is built and
tested. It is not switched on: the default engine is `rules`. The decision
and the release gate are in `docs/decisions/README.md`.

The engine does not find the facts again. The rules Analysis runs first. The
AI answers only the items that the rules left open. Every other rules value
is final.

- **Setting:** `ANALYSIS_ENGINE=rules|shadow|ai` (worker Lambda and API).
  `rules` runs the rules Analysis only. `shadow` runs the AI next to the
  rules, stores its result as `detected_metadata.aiEngine`, and changes
  nothing else. `ai` uses the merged AI result. `rules` is the one-setting
  rollback. The commit cache includes the engine, so a change of engine
  re-runs a stored row.
- **Open items** (`open-items.ts`):
  - A blocker candidate: a rejection where it is not known if the app needs
    the item. These are an unsupported datastore (MongoDB, Elasticsearch,
    ClickHouse, MariaDB, SQLite, H2 and the other database rejections, but
    not a missing PostgreSQL extension), durable local state (a declared
    data directory, a `VOLUME`, Compose named volumes), and a second
    application service in the production Compose file.
  - A fact that the rules did not resolve: no port, no start command, no
    health path (`vendor_required`), no Dockerfile or a tied choice, or an
    unknown migration mode for a required database.
  - A repository with no open item makes no model call.
- **Evidence pack** (`evidence-pack.ts`): the selected Dockerfile and the
  scripts it starts (the start path, shown once), then one small evidence
  window for each question. A window holds the lines around the best search
  hits (8 lines before and after) with their repository line numbers. A hit
  that reads an environment variable ranks first; for a health path a quoted
  health route ranks first, and a browser-side router ranks last. Start and
  migration questions also get the `scripts` block of `package.json`.
  Limits: 8,000 characters for the start path, 8,000 for each question,
  40,000 for the pack. The pack starts with the Deployz binding contract
  (`bindingContractOf`). Real `.env` files, key files, lockfiles, vendored
  code, tests, examples, hidden folders and browser bundles are never
  included. Secrets are redacted line by line, env sample values are
  removed, and a file with a private key is left out.
- **Analyst** (`analyst.ts`, prompt version 14): one Claude Opus 5.5 call
  answers every question. Each answer is closed:
  - a blocker: `required`, `optional_by_setting` (the variable, the value,
    and the engine it selects: `postgres`, `mysql`, `redis` or `s3`), or
    `not_used`;
  - a fact: a value, or `unknown`.
  Each answer has a confidence and `{path, line, quote}` evidence. When a
  window does not let the model decide, it answers `required` or `unknown`.
  The provider is held to a flat list of plain strings; the strict schemas
  then validate each answer. Reasoning effort: medium. Budget: 12,000
  completion tokens, 50,000 tokens in total by the reported usage, 180 s.
- **Checks** (`checks.ts`): each cited line exists in a window and contains
  its quote (one line of tolerance). A low-confidence answer never passes.
  - `optional_by_setting`: a cited line reads the setting, the value selects
    the engine (the value names it, or a cited line maps the value to it),
    and the engine can replace the blocker (a datastore: PostgreSQL or
    MySQL; local state: S3, PostgreSQL or MySQL). MinIO is not S3.
  - `not_used`: no production source file imports or connects to the
    datastore (dependency manifests, tests, documents and deployment files
    do not count); no production line uses the declared path or variable of
    the local state; a second Compose service is a third-party image (it
    does not build from the repository) that no production line names.
  - Start command: the final stage's CMD, its ENTRYPOINT, both together, a
    `package.json` script that the CMD runs, or a script file that the CMD
    starts. Nothing else, never a description.
  - Port: in the production stage `EXPOSE`, `ENV PORT` or `HEALTHCHECK`, or
    the app reads `PORT`. Health path: a cited line registers the route.
    Startup migration: cited on the start path or in the app's boot code or
    configuration, never in a dependency manifest.
- **Merge** (`merge.ts`): `required` or a failed check keeps the rules
  value. A passing `not_used` or `optional_by_setting` dismisses the
  rejection; `analyseRepo` re-runs with the dismissed reason and with the
  engine that the setting selects, so the env-var model, the bindings and
  the database state come from the same rules. When Deployz does not set
  the variable itself (it is not in the binding contract), the vendor must
  set it: it becomes a required variable, and its source names the value
  (outcome 2, deployable with changes). The open facts are all or nothing:
  they fill the open values only when every open fact of the repository
  passes. One fact left open (for example an unknown migration) keeps all
  the rules values, because it can hide a start failure behind the facts
  that were resolved (exam: new-23 became READY and did not start). A
  migration answer that is unknown or fails its own check stays an open
  vendor question (`migration-command-needs-input`, with the AI command as
  the candidate, or none): an unknown migration of a required database is
  never READY, because it can stop the start (Logto refuses to start until
  its database alterations are deployed).
- **Fallback:** an unconfigured gateway, an outage, a timeout (240 s for
  the whole run), a schema failure or a spend-limit error stores
  `aiEngine: {status: 'fallback', reason}` and the rules result is used.
- **Spend log:** the gateway logs one line per call (model, latency, tokens,
  attempts). `aiEngine` keeps the usage and the latency of the call (null
  without a call), the number of questions, the failed checks, each answer
  with its decision, and the setting changes.
- **Post-MVP:** a second reviewer model. It was removed from the MVP path:
  the checks decide each closed answer, and a reviewer objection only added
  vendor questions.

## The canonical model

`ApplicationAnalysis` (`packages/contracts/src/application-analysis.ts`,
built by `buildApplicationAnalysis`): runtime, framework, build, start,
port and bind address as facts — `value`, `source` (dockerfile,
package-manifest, compose, env-file, procfile, source, ai, none),
`confidence` (confirmed, likely, needs_confirmation), `evidence[]` (one
line each, never file content) — plus database, redis, storage, health
check, migrations and the classified environment variables. It is stored as
`detected_metadata.application`, served as `detected` on
`GET /api/applications/:id/readiness`, and rendered as "What Deployz
detected". `database.type` follows the required engine (`databaseState`):
a driver that nothing requires never outranks an unsupported database. It
explains; the manifest is the contract.

## Compatibility findings

`buildReadinessReport` (`readiness-report.ts`) produces findings with stable
ids, a `required` / `recommended` severity, a fix class and a `blocking` flag.
One table (`FIX_CLASSES`) gives each finding id its fix class, in line with
the remediation classes of the fix instructions:

| Fix class | Resolved by | Outcome when it is the worst required item |
|---|---|---|
| `SETTING` | a Deployz setting (port, start command, health check path, migration choice, Dockerfile path) | `DEPLOYABLE` |
| `CODE_CHANGE` | a repository change from the fix-instructions catalogue | `DEPLOYABLE_WITH_CHANGES` |
| `CAPABILITY_GAP` | nothing in the MVP: the app needs a capability that Deployz does not provide | `NOT_DEPLOYABLE` |

The worst required item sets the report `outcome`. Recommended findings never
change it. A finding is a `CAPABILITY_GAP` only when the app clearly needs the
capability. When that is not clear, the finding is a `CODE_CHANGE`, and the
fix instructions tell the coding agent to verify it first. SQLite is a gap
only when it is the only database driver: an app with a PostgreSQL or MySQL
driver too can select that engine. Local disk writes, a persistent volume
(also a `*_CONFIG_DIR`), several Compose application services, an unbuildable
Dockerfile (`no-buildable-dockerfile`), a `.git` copy
(`build-context-git-metadata`) and a MariaDB driver are `CODE_CHANGE`. A
finding id that the table does not know is a `CODE_CHANGE`.

| Spec severity | Deployz | Meaning |
|---|---|---|
| BLOCKER | `required` + `blocking` | NEEDS_CHANGES / NOT_COMPATIBLE — a required capability gap |
| WARNING | `required` | ALMOST_READY / NEEDS_ATTENTION — a setting or a repository change |
| RECOMMENDATION | `recommended` | never blocks READY |

The application page shows the outcome on the Overview card, with the
required items in three groups: "Set in Deployz", "Change in your
repository" and "Not supported". The build check applies to
`DEPLOYABLE`: it shows "Not yet confirmed by a build" until a release build
passes. When release builds failed and none passed, the outcome becomes
`DEPLOYABLE_WITH_CHANGES` and the card links to the failure details of the
release (`release-build-failure.ts`). Static rules do not predict every build
failure (a missing `.next/standalone`, a .NET module build, a frozen lockfile
that is out of date).

Ids: `unsupported-database-*` (MySQL is a supported engine, so only the
still-unsupported engines land here — MariaDB-only setups, MongoDB,
SQLite, Elasticsearch/OpenSearch, Cassandra, Neo4j, ClickHouse, embedded
JVM databases), `unsupported-redis-setup`,
`unsupported-architecture`, `unsupported-message-queue`,
`unsupported-multi-service` (Compose application services beyond the web
service and declared workers), `unsupported-persistent-volume`,
`unsupported-gpu`, `local-file-storage`,
`unsupported-no-dockerfile`, `build-context-git-metadata`
(blocking only as a `CAPABILITY_GAP`, see above); `container-setup`, `port-unresolved`, `start-command-missing`,
`health-check`, `localhost-binding`, `migration-command-needs-input`
(required); `database-migrations`,
`worker-command`, `worker-process`, `dockerfile-target-unresolved`
(recommended). For a Django project
(`manage.py` with `DJANGO_SETTINGS_MODULE`) whose image runs no migration,
`database-migrations` names `python <path>/manage.py migrate --noinput` as the
suggested migration command; the vendor sets it, Deployz never applies it.
The path is the path inside the image, relative to the final `WORKDIR`
(`COPY ./src ./` puts `src/manage.py` at `manage.py`). There is no
suggestion when the image does not copy `manage.py`.
A migration script is persisted only when the selected Dockerfile's
runtime stage, and the stages it is built `FROM`, provides its runner: a
bare ORM CLI gets `npx` only when that Node image also holds the CLI in
node_modules (installed there, or copied from a stage that installed it,
counting a production-only install for production dependencies only).
Dependencies alone never prove it, `bunx` is never substituted and
nothing is installed at run time. Anything else (a Bun or distroless
image, a removed npm, pnpm without corepack, an unreadable base image, no
Dockerfile) is `migration-command-needs-input`: it records
`migrationNeedsInput`, sets `migration.needsCommand` and blocks
deployment until the vendor enters a command or chooses "No separate
migration" — both are vendor overrides that re-analysis keeps. Analysis writes its result under a row lock from the row as it is at that moment, so an override saved while a run is in progress is kept. A row with no `vendorOverrides` list (older than the list) keeps its saved port, health path, migration and worker command; analysis fills only empty columns and does not add the list. A declared worker
process is `worker-process` — informational, because Deployz now runs it
as its own service. Worker-like code with no declared start command is
`worker-command` and sets `worker.needsCommand`: a needs-input question
that is never provisioned from weak evidence such as a queue library
alone. A Node job library (Bull, BullMQ, Agenda, Bree, pg-boss,
graphile-worker) or `worker_threads` alone raises no question: these jobs
run in the web process (`workerNeedsProcess` is false). Celery, RQ, Sidekiq
and every declared worker still do. `reconcileReadiness` applies the vendor's
container port, start command, migration choice, health path and Dockerfile
path as a view, so the page, the persisted
verdict and the fix instructions agree without a re-analysis.

Gate scoping. The architecture and storage blockers read only the files that
describe the production deployment:

- Compose: only the production Compose file counts. It is the root
  `docker-compose.production.yml`/`docker-compose.yml`, not a file in a
  `dev`, `test`, `docs`, `examples`, `contrib`, `build` or `demo` directory
  or a test project directory (`BTCPayServer.Tests`),
  not an `override`/`dev`/`ci` variant, and not a file that mounts the
  repository checkout (`.:/app`). Services on the same build or image are one
  application: the extra services are workers or replicas. Infrastructure
  images, bare runtime images (`node`), dev servers, database studios and
  services whose command, health probe or data volume is a database server
  (`postgres`, `pg_isready`, `/var/lib/postgresql`) are not application
  services. A service built from its own Dockerfile that the
  app neither depends on nor names, next to an app that builds and tags its
  own image, is an optional extra. Only two independent required
  application services give `unsupported-multi-service`.
- Local storage: `VOLUME` is read from the selected Dockerfile only, and a
  Compose volume only from the production file and the application service.
  Static, build, source, cache, log and socket mounts do not count. A volume
  that holds only the SQLite file is not local state when PostgreSQL can be
  selected. A Compose volume that holds the SQLite file and otherwise only
  framework storage (`storage/`, logs, caches) or marker files, as the
  Dockerfile and its start scripts name them, is not local state when
  PostgreSQL can be selected. An upload or files directory under it keeps it
  local state. An uploads, media or attachments volume is not local state when
  the app has an S3 SDK and a variable that selects it (`UPLOAD_PROVIDER`,
  `ACTIVE_STORAGE_SERVICE`, `STORAGE_TYPE`, an `S3_*_BUCKET` name). A
  `VOLUME $VAR` that only the base image sets is decided from the Compose
  service that runs this image (an application service, or the service whose
  image name equals the Dockerfile's `org.opencontainers.image.title`): it is
  not local state only when that service mounts at least as many paths and
  every one is a configuration or cache path. A
  `*_CONFIG_DIR` that the selected Dockerfile copies into (or into whose
  parent it copies the whole build context) holds shipped configuration, not
  state the customer writes. Data, home and storage directories stay durable.
- Databases: a production Compose database image that needs a PostgreSQL
  extension Amazon RDS does not provide (ParadeDB, TimescaleDB, Citus) is
  `other-database`. pgvector and PostGIS images are supported.
- Deployment files: Helm charts, Kubernetes manifests, Kustomize, Terraform
  and Pulumi files in `charts`, `helm`, `k8s`, `kubernetes`, `deploy`,
  `deployments`, `infra`, `terraform`, `install`, `contrib`, `dogfood`,
  `scaletest` or `*-docker` directories do not block. They give the `deployment-files-ignored`
  warning and the manifest field `ignoredDeploymentFiles`. Root-level files,
  files elsewhere, and the manifests of a Go module that imports
  `client-go` or `controller-runtime` still block. Azure files still block.
  A Dockerfile in one of these directories with a `gcr.io` base image
  (`kubernetes/minikube/Dockerfile`) is not a Google Cloud file.

Adding a rule: add the finding in `readiness-report.ts` (id, copy, severity,
confidence, and its fix class in `FIX_CLASSES`), a test in
`readiness-report.test.ts`, and — when the deployment
gate must enforce it — the matching check in `manifest.ts` /
`preflight.ts`. Bump `ANALYSIS_VERSION`.

## Async and scheduled workloads

`detectAsyncWorkloads` (`packages/analysis/src/async-detection.ts`) finds
SQS queues and scheduled jobs. It reads two independent evidence families.
Strong evidence provisions infrastructure. Weak or ambiguous evidence never
provisions anything — it becomes a non-blocking `questions` entry instead.

- **Queues (SQS Standard only).**
  - Precondition: the repository depends on an SQS SDK package
    (`@aws-sdk/client-sqs`, `aws-sdk`, `sqs-consumer`, or `sqs-producer`).
    With no such dependency, Deployz detects no queue.
  - Queue env var names: `<NAME>_QUEUE_URL`, `<NAME>_SQS_URL`, and the bare
    `QUEUE_URL` name a queue; a matching `<NAME>_QUEUE_ARN` reads as that
    same queue's ARN. `<NAME>_DLQ_URL` and `<NAME>_DEAD_LETTER_QUEUE_URL`
    name that queue's dead-letter queue.
  - SQS operations: `SendMessageCommand`, `SendMessageBatchCommand`,
    `.sendMessage(`, `.sendMessageBatch(`, and `Producer.create(` count as a
    producer. `ReceiveMessageCommand`, `.receiveMessage(`, and
    `Consumer.create(` count as a consumer.
  - Attribution: Deployz walks from the web app's own entry file, and from
    each declared worker's and each declared scheduled job's entry command,
    through relative imports, up to 4 levels deep. An SQS operation found in
    that reach attributes to the workload that reaches it.
  - Web-consumer distrust: a consume operation reached only from the `web`
    workload is never trusted. A request/response web process is not a
    queue consumer, so this evidence is treated as ambiguous and becomes a
    question instead of an attribution.
  - Provisioning rule: a queue is provisioned only when a producer and a
    consumer both resolve, with no ambiguity anywhere in the evidence. An
    unnamed queue variable, a variable read from more than one workload
    reach, or a queue with only a producer or only a consumer, each becomes
    a `questions` entry and is never provisioned.
  - Python (boto3): `sqs.receive_message`, `sqs.send_message`, and
    `get_queue_url` calls are detected when a `requirements*.txt` file names
    `boto3`, but this evidence always becomes a `questions` entry — Deployz
    does not parse Python well enough to attribute a queue relationship with
    confidence, so it never auto-provisions from Python evidence.
  - SQS usage no longer rejects the repository. Earlier Deployz versions
    treated any SQS consumer as an unsupported event-driven architecture
    (`checkSqsEventArchitecture`, removed); SQS Standard is now a supported
    managed resource.
- **Scheduled jobs.**
  - Recognized only from a `render.yaml` service with `type: cron`
    (schedule plus a command), and from a Kubernetes `CronJob` manifest
    (schedule plus a command/args). Both need a valid cron expression, or a
    macro such as `@daily`; a Kubernetes `CronJob` also needs a valid IANA
    timezone when one is set.
  - Never recognized, never provisioned: an in-process cron library (for
    example `node-cron`), a CI-level schedule (for example a GitHub Actions
    `schedule:` trigger), and a bare cron string with no production
    deployment declaration naming a command.
  - A Vercel `vercel.json` `crons` block (an HTTP path, not a command) and a
    `crontab` or `*.cron` file each become a `questions` entry — Deployz
    cannot resolve either to a runnable command on its own.
  - An id conflict — two schedule declarations that resolve to the same
    component id — becomes a `questions` entry instead of provisioning
    either.
- **Output.** `detectAsyncWorkloads` shapes its result as `ManifestQueue[]` /
  `ManifestScheduledJob[]` / `ManifestQuestion[]` already. `manifest.ts`'s
  `reconcileAsyncDeclarations` then keeps only the queues and jobs whose ids
  and workload references do not collide with the rest of the manifest (a
  reserved id, a vendor override, another queue or job); anything that would
  collide becomes a `questions` entry instead, so the planner is never
  handed a relationship it would reject.

`ANALYSIS_VERSION` (`apps/api/src/analysis.ts`) carries one history comment
per bump. Bump it whenever detector output or the projection changes.

## Fix instructions

`POST /api/applications/:id/fix-instructions` builds one prompt for the
vendor's own coding agent (`packages/analysis/src/fix-instructions.ts`).

- **Plan.** `planRemediation` is deterministic. It gives every unresolved
  finding one class: `APPLICATION_FIX` (an application code change with a
  known safe pattern), `CONFIGURATION_FIX` (Deployz settings, environment
  variables, or build and process files only), `ALREADY_SUPPORTED`,
  `DEPLOYZ_LIMITATION` (the app needs something Deployz does not provide),
  `NEEDS_INPUT` (a vendor decision or fact), or `UNSUPPORTED` (the app's
  deployment model is out of scope). Each item has a confidence, evidence,
  files to check, conditional actions, constraints, completion criteria and
  the Deployz settings that resolve it without a repository change. Related
  findings merge (the migration question absorbs the generic migration
  finding), duplicates drop, and items are ordered by dependency.
- **Safety rules.** No step tells the agent to merge a worker into the web
  process, delete working code, rewrite the data layer, remove deployment
  files, bypass security, invent secrets or suppress errors. Limitation,
  input and unsupported items only verify and report. Informational findings
  (a declared worker, provisioned queues, migrations at startup) are listed
  as "keep as is", never as blockers.
- **Model.** The model adds at most 70 words of repository-specific detail
  per item, as `{items: [{id, guidance}]}` under a strict schema. It cannot
  change a class, an action or a constraint. `isSafeGuidance` drops guidance
  that matches an unsafe pattern, is too long, or names an unknown item.
  A clause that forbids the change ("Do not move the worker into the web
  process") does not match. The API logs each dropped entry with the item id, the reason, the rule
  name and the length, never the text.
- **Document.** Sections: context (only the facts the items need, and only
  the Deployz capabilities they touch), fixes in order, vendor decisions,
  already supported, rules, validation (only applicable checks; a build
  alone is not proof), and a per-item completion report. Names of
  environment variables only, never values.
- **Cache.** The document is cached on the row, keyed by
  `FIX_INSTRUCTIONS_VERSION`, the model, the commit, the analysis version,
  the facts and the findings. `{regenerate: true}` bypasses it. Bump
  `FIX_INSTRUCTIONS_VERSION` when the plan, the prompt or the document
  changes.
- **Failure.** Any model failure (no credentials, timeout, malformed answer,
  spend limit, another model served) answers a retryable 503. The analysis
  and the readiness state do not change. When the provider settings are
  missing or invalid, the 503 carries `details.reason: not_configured` and
  the API logs the problem. A local API (`WEB_URL` on `localhost` or
  `127.0.0.1`) names the missing setting in the message; elsewhere the
  message stays generic. The explicit provider choice is kept: there is no
  fallback to another provider.
- **Configuration directories.** A persistent-volume item whose evidence
  names a `*_CONFIG_DIR` is a `CONFIGURATION_FIX`: commit the configuration
  files and copy them into the image, never move them to object storage.

## Environment variables

`detectEnvVarModel` decides `required` and `secret` with high precision. A
value in a sample file (`.env.example`/`.sample`/`.template`) is never a
default (`docs/environment-variables.md`);
`classifyEnvVariables` (`env-classification.ts`) decides who supplies the
value:

| Classification | Rule | Delivery |
|---|---|---|
| `deployz_managed` | the names the stack injects for THIS app (DATABASE_*, the Redis bindings, STORAGE/S3 bucket, AWS_REGION, PORT, HOSTNAME), and an S3 region/endpoint name the app reads when storage is provisioned | at install; S3 region/endpoint as a `derived` value on the first configuration pass |
| `deployz_generated` | secret + app-internal name (…SECRET, SECRET_KEY(_BASE), ENCRYPTION_KEY, SIGNING_KEY, APP_KEY, SALT…), no third-party prefix, no connection suffix, no shared/webhook secret, not a catalog credential; required, or optional with purpose `internal_secret` (it usually falls back to a development default) | minted once by the relay with `crypto.randomBytes` inside the customer's account, unless the vendor saved another decision (`mintedEnvKeys`) |
| `customer_required` | every other required key | a vendor decision on the configuration screen: the vendor supplies the value, or marks it "Set by customer" or optional (the name means "needs a vendor decision", not "the customer supplies it") |
| `optional` | read with a default | optional |
| `unknown` | declared only in a sample file | listed, never required |

The first configuration pass runs after a successful INSTALL (one
CONFIG_UPDATE job). The relay binds only secret keys whose value exists and
reports `unboundSecretKeys`. A secret entered before the customer's relay is
connected is held KMS-encrypted in the pending-secret vault and delivered
through the authenticated relay config endpoint on that first pass; a value
that waits longer than 24 hours expires and must be entered again
(`docs/pending-secret-delivery.md`).

## Preflight

`evaluatePreflight` (`apps/api/src/preflight.ts`) combines the manifest gate
(unsupported architecture, container setup, port, start command, required
env vars against the customer's saved keys with generated keys counted as
provided) with the readiness report's remaining findings as warnings, and
lists every check. States: READY, READY_WITH_WARNINGS, ACTION_REQUIRED,
UNSUPPORTED. It runs at deployment creation, the install-link and deploy-
link launches and relay registration (`requirePreflightReady`, 422 with
`details.findings`), and is served on `GET /api/applications/:id/preflight`
and `GET /api/deployments/:id/preflight`. Warnings never block; nothing in
the preflight calls the model.

## Failure diagnosis

1. **Classification** — the relay classifies at the executor boundary; the
   API refines coarse codes deterministically from error text and stack
   events (`failure-classification.ts`). Known signatures include SCP and
   IAM denial, quota, image pull, regional artifact mismatch, RDS and
   ElastiCache failures, ECS health-check and container-exit failures, and
   the relay's own state-write failure.
2. **Context** — `buildFailureContext` (`failure-context.ts`) gives one
   bounded, redacted representation: phase, attempt, settled and reported
   codes, blamed resource, ≤5 failed events, version. The diagnostics
   response serves it as `context` for the technical layer.
3. **Explanation** — every code that names an account or infrastructure
   cause is answered from the copy map without a model call. The app-owned
   evidence-rich set (`AI_EXPLAINABLE_FAILURE_CODES` in the diagnostics
   route: `UNKNOWN` plus the startup/config failure codes) asks the AI,
   with the structured event derived from the context, a strict
   `{what, why, fix, confidence}` schema,
   the deterministic code always overriding the echoed one, one generation
   per attempt cached on `deployment_jobs`, and deterministic copy on any
   failure. Confidence below `high` is hedged on the card ("Deployz could
   not determine the exact cause…").

Failed release builds (`apps/api/src/release-build-failure.ts`) follow
the same rules outside the deployment flow. Deployz reads the failed build's
log, redacts it, finds the earliest meaningful error, and classifies who most
likely has to act only when a log line supports it — never from the final
check or an exit code alone. "Explain with AI"
(`POST …/releases/:releaseId/build-failure/explain`) runs only on request,
sends at most 60 redacted log lines fenced as untrusted data, and keeps only
supporting line numbers that exist in that excerpt, shown with the log's own
text. It is not cached. Without log lines it makes no model call; on any AI
failure it answers 503 and the failure details stay usable.

Adding a signature: add the rule in `refineFailureCode` (order matters —
specific before generic), a test in `failure-classification.test.ts`, and
only if no existing code fits, a new code in all five mirrors
(`packages/db/src/enums.ts`, `packages/contracts`, `packages/copy-map`,
`packages/analysis/src/failure-codes.ts`, `apps/web/src/lib/
diagnostic-vocabulary.ts`) plus a migration.

## Configuration and cost

- Gateway: `AI_GATEWAY_BASE_URL`, `AI_PROVIDER_API_KEY`, optional
  `AI_GATEWAY_TOKEN`, `AI_MODEL` (`apps/api/src/ai-config.ts`);
  `AI_FIXTURE_MODE=true` swaps in canned answers for E2E and switches the
  AI-first engine off in the API.
- AI-first Analysis: `ANALYSIS_ENGINE` (`rules` when unset),
  `ANALYSIS_AI_MODEL` (default `anthropic/claude-opus-5.5`, an OpenRouter
  id). The analyst goes through the Cloudflare gateway's OpenRouter route
  (`<AI_GATEWAY_BASE_URL without /compat>/openrouter/v1`) with
  `OPENROUTER_API_KEY`. The gateway is authenticated: the
  `cf-aig-authorization` token is `AI_GATEWAY_TOKEN`, or `AI_PROVIDER_API_KEY`
  when that is unset (in production it is the gateway token). The gateway's unified `/compat` endpoint answered
  402 Payment Required for these models. Every request asks OpenRouter for a
  provider that honours the JSON schema, logs the served model, tokens and
  cost, and rejects an answer from another model.
- Fix-instructions model: `FIX_INSTRUCTIONS_AI_PROVIDER` (`openrouter`, the
  default, or `gateway`), `FIX_INSTRUCTIONS_AI_MODEL` (the OpenRouter model,
  default `anthropic/claude-opus-5.5`), `OPENROUTER_API_KEY`, optional
  `OPENROUTER_BASE_URL`. Only fix instructions use it. Through OpenRouter
  every request requires a provider that honours the JSON schema
  (`provider.require_parameters`), asks for low reasoning effort (Opus 5.5
  cannot switch thinking off), and logs the served model, tokens and cost
  (`usage.cost`). An answer from another model is rejected
  (`AiModelMismatchError`) and never retried. There is no fallback: a
  provider without credentials leaves fix instructions unavailable.
  `gateway` is the rollback to the shared gateway and `AI_MODEL`.
- Fix-instructions budget: 25 s per request (under the 30 s Lambda and HTTP
  API limits), one attempt may use 24 s, so a second attempt runs only after
  a fast failure; 4000 prompt and 4000 completion tokens.
- Prompts: `repository-ai.ts`, `fix-instructions.ts`,
  `diagnostic-explainer.ts`. Each has its own token budget, timeout, and
  a spend check on the gateway's reported usage; the gateway retries once
  on transient errors and malformed output, never on 4xx.
- Calls per lifecycle: at most one repository call per analysed commit (and
  only for an open question), one fix-instructions call per commit and
  finding set, one explanation per failed attempt whose code is in the
  AI-explained set (`UNKNOWN` plus the app-owned startup/config codes).
  Never on the deploy button, never per lifecycle event, never in a loop.

## Testing AI changes

- Deterministic corpora: `packages/analysis/test/eval-corpus.test.ts` (nine
  archetypes with exact expectations), `application-analysis.test.ts`,
  `env-classification.test.ts`, `readiness-report.test.ts`, and the Stage A
  rule tests (`stage-a*.test.ts`). The Docker run-and-check test
  (`pnpm runcheck:*`) checks each Analysis claim against the running
  application; see [`testing/compatibility.md`](testing/compatibility.md).
- AI-first Analysis: `packages/analysis/test/ai-analysis/` tests every
  open item, window, check and merge rule with fake gateways;
  `apps/api/src/analysis-engine.test.ts` tests the three engines and the
  fallback. The exam runs the engine with
  `pnpm runcheck:analyse --engine ai` ([`testing/compatibility.md`](testing/compatibility.md)).
- AI boundaries: schema/gate tests with fake gateways
  (`repository-ai.test.ts`, `diagnostic-explainer.test.ts`,
  `apps/api/src/ai-explanation.test.ts`, `fix-instructions` tests); the
  live gateway test (`ai-live.test.ts`) runs only with `DEPLOYZ_LIVE_AI=1`
  and asserts structure, never wording.
- Fix instructions: the unit tests in
  `packages/analysis/test/fix-instructions.test.ts` render the document from
  inline findings. They fail when a critical unsafe instruction appears: a
  worker or queue moved into the web process, infrastructure deleted, the
  data layer rewritten without approval, security disabled, a secret
  embedded or errors suppressed. CI runs them.
- Changing a prompt or schema: keep `.strict()`, add the fixture-mode
  answer in `apps/api/src/ai-fixture.ts` if E2E needs it, and never assert
  on model prose in CI.
