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
- The vendor, not the AI, can mark an allowlisted blocker as "not used in
  production" (see "Vendor disputes"). That answer is a vendor decision with
  its own provenance. The AI never creates, changes or removes it.
- Every AI output crosses a strict Zod schema before anything reads it. A
  malformed, oversized or missing answer degrades to the deterministic
  result — an analysis still completes, a diagnosis still shows copy-map
  text, a deployment never depends on the model being available.
- Repository files, sample env files and error text are untrusted data. The
  prompts say so; secret-looking values are redacted before they leave the
  process; raw application logs are never collected.
- **Repository commands are not sandboxed.** Deployz runs the migration,
  worker and scheduled commands that the repository declares (a
  `package.json` migrate script, a `Procfile` line, a `render.yaml` or
  Kubernetes cron command). The rules that choose a migration script
  (`selectMigrationScript`) protect data; they are not a command allowlist.
  The default branch is trusted input: a command in it runs under `sh -c`
  in the customer account with the privileges of the application container.
  No boundary is crossed, but a contributor who can push to the default
  branch can run a command the vendor never confirmed. The API refuses a
  vendor-set migration or start command that is blank, longer than 4096
  characters or holds a NUL character (the limits the relay applies). A
  vendor confirmation step for auto-filled commands is a post-MVP item.

## The flow

```
Repository (GitHub tree, bounded)
  → analyseRepo: deterministic detectors + rejection checks
    (a second pass applies the vendor's still-matching disputes)
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
  Fetches a bounded file tree (on a repository above the file cap, the start
  scripts of the Dockerfile that the analysis selects, ranked with each
  candidate's content, always stay in the tree), runs `analyseRepo` (`packages/analysis/src/
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
  application service, never from a database, cache or proxy service
  (Cassandra, CouchDB, Neo4j and etcd too), and never from a Compose file
  under `develop/` (a development stack).
- **Runtime precision:** the image is the production stage of the selected
  Dockerfile. This stage is the last stage that is not a dev, test, build or
  nightly stage (also with a number: `pr-test2`) and whose own CMD does not
  run a CI script (superset `showtime`: `docker-ci.sh`), together with the stages it
  is built from. The start command is the last CMD and the last ENTRYPOINT of
  this stage and its lineage. A HEALTHCHECK `CMD` and the CMD of another stage
  are never the start command. An ENTRYPOINT that is only a launcher or an
  init process (`["bundle", "exec"]`, mastodon `["/usr/bin/tini", "--"]`)
  with no CMD is no start command: the vendor gives one. A CMD that only
  prints the usage or the version (`CMD ["--help"]`) is no start command
  either. A Dockerfile in a test,
  example (also `docker_example/`), project template (`templates/`,
  `starters/`) or dev-container directory, a base image (system packages only, no
  CMD, ENTRYPOINT, EXPOSE or COPY), a Dockerfile that starts a dev server
  (a dev server is `npm run dev`, `next dev`, `nodemon`, `--reload` or
  `sleep infinity`) and a Dockerfile that copies nothing in and starts a
  script by a relative path (actual `CMD ["sh", "./bin/docker-start"]`: it
  runs a bind-mounted checkout) are never selected. A Dockerfile in a `dev/` build directory
  is selected when it starts something (CMD, ENTRYPOINT or EXPOSE) and is not
  one of those; a `.devcontainer/` or `.gitpod/` Dockerfile never is. An
  image in another hidden directory ranks with the dev images, and it is
  never selected when it starts nothing (the `.oss-scanner/` build
  environment of medusa and vendure). A production stage `FROM scratch` with no CMD or ENTRYPOINT only
  exports files (focalboard `Dockerfile.build`) and is never selected. These
  are never selected too: an image whose only command is a shell or a no-op
  (`CMD ["/bin/bash"]`, `CMD /bin/true`) and that exposes no port (a build
  toolchain or a file export: MongoDB, GitLab `Dockerfile.assets`); a file of
  two or more FROM lines and nothing else (an image-pin list, MySQL's
  vendored `dependencies.Dockerfile`); a Windows image (PowerShell, a `C:\`
  WORKDIR, a Windows base: Chroma `Dockerfile.windows`); a FROM whose
  variable no ARG declares (a template that a build tool fills in:
  OpenSearch `FROM ${base_image}`; the BuildKit platform variables need no
  ARG); and an image in a `selenium/` directory (browser tests). A
  documentation site image (Docusaurus, MkDocs, VitePress, VuePress, Sphinx,
  mdBook, Antora, Docsify) ranks with the dev images, below the app image. So
  does an image in a datastore or proxy directory (`hosting/couchdb/`,
  `docker/nginx/`): it builds a service next to the app. So does the image of
  an agent, runner, CLI or client when the repository also has a server image
  (Woodpecker `Dockerfile.agent.multiarch` next to
  `Dockerfile.server.multiarch.rootless`). A
  Dockerfile named production or prod ranks first. An
  arm or multi-process variant ranks last. When the other signals tie, a
  Dockerfile whose production stage starts something (CMD, ENTRYPOINT or
  EXPOSE) ranks first, then one that declares a port. Dockerfiles that still
  tie are recorded as `dockerfileSelectionTied` and give the recommended
  finding `dockerfile-target-unresolved`. When the last stage is a tooling
  stage (an artifact, upload, export, publish, lint, build or test stage, or a
  stage that runs a CI script) and
  an earlier named stage is the production stage, the analysis records
  `dockerfileBuildTarget`. The build then runs `docker build --target <stage>`
  (not for a vendor-overridden Dockerfile). A Dockerfile in a subdirectory
  builds from its own directory, unless it is written for the repository root
  (`dockerfileBuildContext` `.`): it runs `turbo prune`, copies a workspace
  root file, a path under its own directory or a path that only the root has,
  or copies the whole context from a directory with no project file (miniflux
  `packaging/docker/alpine/`: `ADD . /go/src/app`, then `make miniflux`). The runtime comes from the
  production stage and the stages it is built `FROM` (leaf to root);
  `COPY --from` counts only when that lineage names no runtime image. A
  `go.mod` with no Go source and a `package.json` with no dependencies are
  tooling manifests: they decide the runtime only when nothing else remains.
  A Node framework is reported only for a Node image. The port is the ENV
  PORT or EXPOSE of the production stage (`EXPOSE ${SUPERSET_PORT}` reads the
  variable from any key of an `ENV` line), then a HEALTHCHECK of the
  production stage that probes localhost on a port variable with a default
  (`${LIVEBOOK_PORT-8080}`), then the one application service of the
  production Compose file that publishes a port, then a port literal in
  runtime source, then the mapping of an application service (one that
  waits on a database or cache service with `depends_on` first: khoj
  `server` before its VNC `computer` sidecar). An
  image with a front web server (nginx, caddy) publishes port 80; an
  unprivileged nginx base (`nginxinc/nginx-unprivileged`, `bitnami/nginx`)
  with no EXPOSE serves on 8080. The health
  path, in order: the URL that the HEALTHCHECK of the production stage or a
  production Compose app service probes (also in the script it runs, with the
  host, port, scheme and a base path from variables:
  `http${s}://${addr}:${PORT}${base_path}/alive`; a Compose healthcheck counts
  only from an app service that waits on the database, when one does); a dedicated route that the app
  registers, with the framework prefix and URI version (also a Rust route
  attribute or call: actix `#[get("/healthz")]`; a FastAPI `APIRouter`
  route also gets the router prefix and the one `include_router(api,
  prefix="/api")` mounts it at); the Spring actuator
  route. A route that a test or spec calls (`page.request.get('/health')`)
  is not a registration. When one file registers the same route bare and
  under a prefix (listmonk `/health` and `/api/health`), the bare route is
  used: the prefixed one is in the API group, often behind its auth. A dedicated route ends in a health word, and only an API root, a
  version or one namespace (for example system) comes before it.
  `status` is accepted only under an API root, or in a JS server. `readyz` and
  `livez` are not taken from source. A route is not used when it is in
  another language than the one the image starts, when two apps in the
  repository register a route and the start command does not name one of
  them, or when a front web server hides the app behind a prefix. In these
  cases the detector reports no path. Apache or nginx in a PHP image is the
  PHP app's own server, not a front server: a PHP route keeps its path. A
  Laravel 11 app declares its framework route in `bootstrap/app.php`
  (`->withRouting(health: '/up')`). A `routes/api.php` route gets the `/api`
  prefix, or the prefix that `app/Providers/RouteServiceProvider.php` maps
  for that file (invoiceninja `Route::prefix('')`). Without a path the health check
  probes `/` and also accepts a redirect (`health.redirectsAccepted`, ALB
  matcher 200-399), and the vendor is not asked. A HEALTHCHECK of the
  production stage that probes `/` gives the same root check, and the
  analysis does not save `/` as the health path (a saved path is explicit and
  accepts only 200, but a login page answers `/` with a redirect). The vendor is asked only
  when a health handler file exists whose route was not resolved
  (`HealthController`, `HealthAction`, `health_check.ex`; a prefixed check
  such as `RedisHealthCheck.cs` checks a dependency and does not count).
  An image `ENV` that sets the path of a SQLite file
  (`ENV SQLITE_DATABASE=/app/data/app.sqlite3`) is an unsupported database
  when the app has no PostgreSQL driver. A Dockerfile
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
  another candidate with a CMD or ENTRYPOINT copies from the repository. A
  Dockerfile with no build step (no RUN with a compiler, package manager or
  build tool) that copies a prebuilt artefact is not buildable either: a
  generated directory that the repository does not contain (shiori's
  `COPY dist/shiori_…`) or a path of build arguments with no default (flipt's
  `COPY $TARGETPLATFORM/$BINARY /`). A goreleaser or other CI job makes these
  files before `docker build`. A selected Dockerfile that downloads a released
  build (`ADD` or `curl`/`wget` of a release asset or archive, also through an
  ARG default: Keycloak `ADD $KEYCLOAK_DIST`) and copies only setup files from
  the repository (scripts, configuration, a licence) is not buildable either:
  its image runs that release, not the commit. A candidate that copies nothing from the
  repository (a Dockerfile for a mounted checkout, or one whose only `ADD`
  downloads a URL), a candidate that downloads a released build, the image
  of an agent, runner or CLI next to a server image, and a candidate whose name marks it for development
  (typesense's `development-macos.Dockerfile`) are not another buildable
  Dockerfile. A Dockerfile in a test or example directory (also
  `test-framework/`) is never buildable, so the check does not need its
  content. A capped or partial
  file list (GitHub cuts the listing of a very large repository and says
  `truncated`; such a listing is not the full path list), a second candidate Dockerfile with a CMD or ENTRYPOINT that
  copies only repository content, a git submodule, `COPY --from=`, a heredoc
  source (`COPY <<'EOF' …`) and a generated directory that a build step of
  the Dockerfile can make never reject. A
  repository whose full path list holds only documents (README, licence,
  Markdown, images, `.github/`), root dot-files and root shell scripts has
  no application source (a meta-repository whose code is in git submodules,
  ONLYOFFICE DocumentServer): it is the
  `no-application-source` rejection (finding `unsupported-no-application-source`,
  a `CAPABILITY_GAP`), never a request to add a Dockerfile (a project that moved
  to Codeberg or GitLab). A Dockerfile that copies `.git`, a RUN step that
  bind-mounts `.git` from the context (gitea
  `--mount=type=bind,source=".git/"`), or a RUN step
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
  (`tsc && node …`), and the production stage lineage runs Node (a Node build
  stage whose output an nginx stage serves runs no package script). A
  production stage on the official nginx or httpd image with no CMD or
  ENTRYPOINT runs that image's command (`nginx -g daemon off;`,
  `httpd-foreground`). Otherwise the vendor is asked for the start command.
- **Migrations at boot:** a migration that the app runs from its own code at
  boot (knex `migrate.latest()`, Umzug, Drizzle `migrate()`, TypeORM
  `runMigrations()`, golang-migrate, Flask-Migrate `upgrade()`, Django
  `call_command('migrate')`) sets the migration mode to `startup`. Then no
  pre-deploy command is kept. Only the real start path counts: the image
  CMD or ENTRYPOINT and the scripts it runs, also an extension-less boot
  script that it names by path (Rails `/rails/bin/docker-entrypoint` with
  `bin/rails db:prepare`, `/scripts/init`; when several directories hold a
  script of that name, the one next to the Dockerfile; the tree fetch
  includes these scripts) (a `./app migrate && ./app`
  subcommand, a `migrate deploy` wrapper, an interpreter that runs the
  app's migrate script file such as `node ./db/migrations/pg/migrate.cjs`,
  or the app's own install or upgrade command, such as
  `bin/console app:install` or `app-installer init`, when the app also
  declares a migration library: Doctrine Migrations, Phinx or
  FluentMigrator), a Procfile `web:` line, the s6
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
  PostgreSQL. A requirement marked `// indirect` is a transitive module, so
  it is never a PostgreSQL signal (the same rule as the MySQL drivers).
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
  (`jdbc:mysql`), Sequelize or Knex setting, a production JSON config that
  names the client (Ghost `config/env/config.production.json`), a Dockerfile that installs
  `pdo_mysql`, or a Laravel default connection of `mysql`. A PostgreSQL
  driver that only a Python dev group or a dev requirements file declares
  does not count. A Laravel app that lists a `pgsql` connection keeps
  PostgreSQL, unless the selected image installs only a MySQL PHP driver
  (`php8.3-mysql`, `pdo_mysql`) and no PostgreSQL one: then the image cannot
  reach PostgreSQL. A MariaDB-only client (`mariadb-java-client`, a Laravel
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
  `JOBS_PROVIDER=local`; also in code: a setting that the code compares
  with `'redis'` and that defaults to another backend or to nothing, open-webui
  `os.getenv('WEBSOCKET_MANAGER', '')`), a `*_MODE` setting whose default is not `queue`
  while the code offers `queue` (n8n `EXECUTIONS_MODE`), or a `MODE`
  setting with no default that only an equality test turns to queue
  (Flowise `process.env.MODE === MODE.QUEUE`; a package.json worker script
  is then not provisioned either), an image that installs its own Redis server, or
  code that sets the connection itself. An env sample comment that says
  Redis is required overrides this evidence. The result is then
  `medium` confidence and the manifest does not request Redis. Evidence in
  an app directory that the image does not hold (a sibling app, see
  `docs/environment-variables.md`) does not count.
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
    not a missing PostgreSQL extension or database version), durable local state (a declared
    data directory that is not under a temporary, cache or log path such as
    `/tmp`, a data path in the app's own `config.yaml` or
    `config.toml` such as qdrant `storage_path: ./storage`, a `VOLUME`,
    Compose named volumes), a second
    application service in the production Compose file, and a declared
    service (below).
  - A declared service (`unconfirmed-declared-service`, rejection
    `unexplained-declared-service`): a service that the repository's own
    stack declares and that the rules do not explain. The stack is the
    production Compose file or, when the repository has none, the shallowest
    development stack (`dev/`, `.devcontainer/`, a source-mounted file; never
    a test, CI, example, sample, demo or documentation folder). It is a
    datastore or broker service (PostgreSQL, MySQL or MariaDB, Redis or
    Valkey, MongoDB, Elasticsearch or OpenSearch, Kafka or Redpanda, RabbitMQ,
    CockroachDB, ClickHouse, Cassandra, Neo4j, CouchDB, a search or vector
    engine, MinIO) that an application service of the stack names. A
    development stack names it with `links` or a host in a value
    (`REDIS_URL: redis://redis:6379`); `depends_on` there is only the start
    order (saleor's optional cache). An admin tool image is not a datastore
    and not an app. A development stack with more than one relational engine
    tests the app against each (shlink), so it states no need. The production
    file keeps the optional services of a lighter production variant
    (Flagsmith). Helm chart dependencies (not a vendored subchart) and env
    sample connection settings of an engine that Deployz does not provide
    (`KAFKA_BROKERS=…`) are declared services too; the rules' own PostgreSQL,
    MySQL, Redis and storage checks already read the env samples. A service
    is explained when the rules found its engine (PostgreSQL or MySQL
    evidence, a required Redis, S3 storage) or another rejection, dismissed
    or not, names it. In a development stack, a second service that builds
    from the repository and that the selected app names is a declared service
    too (mem0: the dashboard needs the API). The finding is CODE_CHANGE
    (outcome 2), never a blocker by itself: the vendor can mark it "not used
    in production", and the AI asks one question. Huly (CockroachDB,
    Redpanda, Elasticsearch in `dev/`), zammad (Redis in `.devcontainer/`,
    which the rules read as optional) and mem0 were false DEPLOYABLE before.
  - A fact that the rules did not resolve: no port, no start command, no
    health path (`vendor_required`: a health handler whose route was not
    resolved), no Dockerfile or a tied choice, an
    unknown migration mode for a required database, or no variable that the
    app reads its required database connection from (the
    `database-connection-unverified` case: no binding name is read with
    evidence).
  - The repository kind, when the rules found no Dockerfile that builds the
    repository (`no-buildable-dockerfile`), no port, no start command, or
    durable local state, and no `datastore-server` rejection: an
    application, a datastore server, or a library, framework, SDK or CLI
    that others install. "Add a Dockerfile" is the wrong fix for a
    repository with no server to run (crewAI, agno, superagent, Strapi), and
    "move the files to S3" is the wrong fix for a database, cache, search
    engine, broker or storage server (Valkey, PostgreSQL, Kafka,
    Prometheus). The rules decide only the clear cases (see
    `library-repository` and `datastore-server` below). The other cases go to the model: these
    repositories have ports, start scripts and Dockerfiles in examples and
    templates.
  - A repository with no open item makes no model call.
- **Evidence files** (`evidenceFileRequests`): the rules tree fetches at
  most 200 files of some source languages (TypeScript, JavaScript, Python,
  Ruby, Go, C#, Java, Kotlin, PHP, Rust, Elixir; the rules read the
  variables of each, see docs/environment-variables.md#code-reads). Scala
  and the files the cap left out are not in it. Inside the cap, a shallower
  manifest comes first: 600 plugin manifests (`packages/pieces/community/*/`)
  do not push out `packages/server/api/package.json`. For a repository with an
  open item, the API also fetches
  up to 40 production files that the tree does not hold: the boot files
  (`Program.cs`, `*Startup.cs`, `*Application.java`, `main.rs`,
  `application.ex`, `config/runtime.exs`, `index.php`, `appsettings.json`),
  the root README when the repository kind is asked, and the files named
  after each question (a migration manager or runner,
  `DatabaseManager`, `release_tasks`, an installer; health controllers and
  routes; configuration and storage files). A numbered migration file, a
  test, an example and a browser file are never fetched. The pack and the
  checks read these files; the rules and the merge re-run never see them,
  so a rules value cannot change because of them. An unreadable file only
  narrows the windows.
- **Evidence pack** (`evidence-pack.ts`): the selected Dockerfile and the
  scripts it starts (the start path, shown once), then one small evidence
  window for each question. A window holds the lines around the best search
  hits (8 lines before and after) with their repository line numbers. A hit
  that reads an environment variable ranks first; for a health path a quoted
  health route ranks first, and a browser-side router ranks last. For a
  migration, a hit in a start file ranks first, then a call that runs the
  migrations (`MigrateMaster(install)`, `databaseManager.Install()`, a boot
  `ensureSchema()`), and an import, a comment or a namespace line ranks
  last. For the database variable, a line that reads the environment ranks
  first. The repository kind shows the packaging lines of the six
  shallowest package manifests (`package.json`, `pyproject.toml`,
  `setup.py`, `setup.cfg`, `Cargo.toml`, `composer.json`, a gemspec), then
  at most 2,000 characters of the root README (its first line in the first 60
  lines that names a datastore role and the lines after it, else its top: the
  README often is the only file that says that the repository is a database
  or broker server; the README is never evidence for another question or
  check), then the server entrypoints of the code (`.listen(`, uvicorn, `FastAPI(`, a
  `start` script). Start and
  migration questions also get the `scripts` block of `package.json`.
  Limits: 8,000 characters for the start path, 8,000 for each question,
  40,000 for the pack. The pack starts with the Deployz binding contract
  (`bindingContractOf`). Real `.env` files, key files, lockfiles, vendored
  code, tests, examples, hidden folders and browser bundles are never
  included. Secrets are redacted line by line, env sample values are
  removed, and a file with a private key is left out.
- **Analyst** (`analyst.ts`, prompt version 20): one Claude Opus 5.5 call
  answers every question. Each answer is closed:
  - a blocker: `required`, `optional_by_setting` (the variable, the value,
    and the engine it selects: `postgres`, `mysql`, `redis` or `s3`), or
    `not_used`;
  - a fact: a value, or `unknown`. The repository kind is `application`,
    `datastore`, `library`, `framework`, `sdk` or `cli`. A `datastore`
    builds the server of a database, cache, search engine, vector store,
    message broker, object store or metrics store; an app that uses or
    manages a database is an `application`; when the repository also holds
    an app that serves HTTP, or when the model is not sure, it is
    `application`.
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
    does not build from the repository) that no production line names; no
    production source line names a declared service or its engine (any
    case).
  - `required` for a declared service: medium or high confidence and a
    cited production source or configuration line (never a Compose file, an
    env sample, a manifest or a document) that names the service or its
    engine. Without it the answer changes nothing.
  - Start command: the final stage's CMD, its ENTRYPOINT, both together, a
    `package.json` script that the CMD runs, or a script file that the CMD
    starts. Nothing else, never a description.
  - Port: in the production stage `EXPOSE`, `ENV PORT` or `HEALTHCHECK`, or
    the app reads `PORT`. Health path: a cited line registers the route.
    Startup migration: a cited line on the start path or in the app's boot
    code or configuration shows it. A dependency manifest is only context,
    except Flyway or Liquibase in a Spring Boot build (`pom.xml`,
    `build.gradle`) when no production setting turns it off: Spring Boot
    runs them at start. A dev script, a test or a document never shows it.
    A migration command is supported by a cited line that names it, or by a
    line of the script file it runs (`python3 manage.py migrate` cites
    `manage.py`, `/app/migrate.sh` cites `rel/overlays/migrate.sh`). Mode
    `none` with a required database never passes: the prompt asks for
    `unknown` when something other than the app creates the schema (a
    database init script). A migration command that
    adds arguments to a package script (`npm run alteration deploy`) needs
    a cited line that shows those arguments; the AI can invent an argument
    or leave out a required one, and then the migration fails.
  - Database variable: a cited production source line reads the variable
    (an environment read or a `${NAME}` interpolation; never an env sample,
    a Compose file or a document), and the name says that it holds a whole
    connection: a URL (`DB_URL`, `*_DSN`, `*_DB_URI`) or a JDBC URL. A part
    (`DB_HOST`) or a name without a known format (`BTCPAY_POSTGRES`, a
    driver connection string) fails: Deployz cannot set its value.
  - Repository kind: `application` changes nothing. Any other kind needs
    medium or high confidence and a cited line of a package manifest
    that packages the code for others to install: a build backend
    (`build-backend`, `requires = ["hatchling"]`), `[project.scripts]` or a
    console script entry, `"bin"` or a `"bin"` entry (`"codex":
    "bin/codex.js"`), `"main"`, `"exports"`, `"types"` or
    `"publishConfig"`, a Rust `[lib]` or `[[bin]]`, a Composer `"type":
    "library"`, a gemspec. A project name or a README line fails. A
    `datastore` needs a cited production line or root README line that
    names its role (a database server or database management system, a
    key-value store, a search engine, a message or streaming broker, an S3
    object store, a distributed file system, a time-series database) or the default client port of a database,
    cache or broker protocol (`#define CONFIG_DEFAULT_SERVER_PORT 6379`).
- **Merge** (`merge.ts`): `required` or a failed check keeps the rules
  value. A passing `not_used` or `optional_by_setting` dismisses the
  rejection; `analyseRepo` re-runs with the dismissed reason and with the
  engine that the setting selects, so the env-var model, the bindings and
  the database state come from the same rules. When Deployz does not set
  the variable itself (it is not in the binding contract), the vendor must
  set it: it becomes a required variable, and its source names the value
  (outcome 2, deployable with changes). Each open fact that passes its
  check fills its value on its own. An open fact that stays unresolved
  keeps its rules finding, so a resolved fact cannot hide it. A passing
  repository kind other than `application` replaces the
  `no-buildable-dockerfile` rejection with `library-repository` (finding
  `unsupported-library-repository`, a `CAPABILITY_GAP`): outcome 3, not
  deployable, and no "add a Dockerfile" finding. A passing `datastore`
  adds the `datastore-server` rejection (finding
  `unsupported-datastore-server`, a `CAPABILITY_GAP`) and removes
  `no-buildable-dockerfile`: outcome 3. The rules engine gives
  `datastore-server` itself when the first port that the production image
  exposes is the client port of a database, cache or broker protocol (MQTT 1883/8883, AMQP
  5671/5672, Kafka 9092, NATS 4222, MySQL 3306, PostgreSQL 5432, Redis 6379,
  MongoDB 27017, Cassandra 9042, Neo4j 7687, CockroachDB 26257: EMQX). A
  web app that exposes its web port first and a metrics port or a bundled
  database after it (focalboard, Helicone) is not one. The
  rules engine gives
  `library-repository` itself only when every production package manifest
  publishes its code (a `bin`, `exports`, a build backend, console scripts,
  a Rust `[lib]`). A workspace root and the manifests in examples, templates,
  cookbooks and test suites (typesense's `api_tests/`) do not count. `"main"`, `"module"` or `"types"` alone does
  not publish, because an application's package.json has them too. One
  manifest that publishes nothing (an application's package.json or
  composer.json, a Rust binary crate) keeps outcome 2, and the model then
  answers the repository kind. (Before
  prompt v15 the open facts were all or nothing, because an unknown
  migration was not a question then: new-23 became READY and did not
  start.) A migration answer that is unknown or fails its own check stays an open
  vendor question (`migration-command-needs-input`, with the AI command as
  the candidate, or none): an unknown migration of a required database is
  never READY, because it can stop the start (Logto refuses to start until
  its database alterations are deployed). Its fix class is CODE_CHANGE (a
  change to verify, outcome 2); a migration question that the rules ask
  with a known candidate command stays SETTING. A passing database variable
  becomes a `deployz_managed` variable and a `postgres` binding (`url` or
  `jdbc_url`), the same as an alias that the rules read in code, so Deployz
  sets it and `database-connection-unverified` is gone. An unknown one
  keeps that vendor question.
  - A `required` answer keeps the rules fix class. A required datastore is
    already a CAPABILITY_GAP (outcome 3). A checked `required` declared
    service whose cited line names an engine that Deployz does not provide
    (MongoDB, Elasticsearch or OpenSearch, Kafka or Redpanda, RabbitMQ,
    CockroachDB and the other datastores) becomes that engine's rejection:
    a CAPABILITY_GAP (outcome 3). When the question names one PostgreSQL,
    MySQL, Redis or S3 service and a cited line uses that engine, Deployz
    adds the engine (as an `optional_by_setting` answer does) and the
    question is dismissed: a setting, not a change. A question that names
    several services, or a second app service, keeps the question (outcome
    2). Durable
    local state and a second
    Compose service stay CODE_CHANGE (outcome 2) also when the AI says
    `required`: the app can move its data to S3 or the database, or drop
    the service. The live exam confirms it: the AI says `required` for the
    local state of healthy apps (new-18, new-7) and of apps whose reviewed
    change makes them deployable (new-21, repo-050, new-8). A CAPABILITY_GAP
    there would be a wrong "not deployable". The 12 apps of the c3ad6a17
    exam that the Analysis called outcome 2 and that failed both full runs
    are also outcome 2: a Deployz setting or a reviewed repository change
    removes each failure (recipe `outcomePatch`, or the `healthPath` answer
    for new-6; docs/testing/compatibility.md).
    None needs a capability that Deployz does not have, so no rule moves
    them to outcome 3.
- **Fallback:** an unconfigured gateway, an outage, a timeout (240 s for
  the whole run), a schema failure or a spend-limit error stores
  `aiEngine: {status: 'fallback', reason}` and the rules result is used.
  The rules result asks the same migration question when the migration
  mode of a required database is unknown and a package script names a
  database step that Deployz cannot run (a `migrat…` or `alteration` key
  that is not a create, dev or build step; Logto: `alteration: logto db
  alt`). It stores `migrationQuestion` and asks
  `migration-command-needs-input` with no candidate, fix class CODE_CHANGE
  (outcome 2). A known migration command and a startup migration ask
  nothing. An unknown migration with no such script stays the recommended
  `database-migrations` finding: on the 58 recipes and 10 fixtures, the question for every
  unknown migration made 28 more repositories outcome 2, and most of them
  are healthy because they migrate when they start. When the AI resolves
  the migration, the merge removes the rules question.
- **Spend log:** the gateway logs one line per call (model, latency, tokens,
  attempts). `aiEngine` keeps the usage and the latency of the call (null
  without a call), the number of questions, the failed checks, each answer
  with its decision, and the setting changes.
- **Post-MVP:** a second reviewer model. It was removed from the MVP path:
  the checks decide each closed answer, and a reviewer objection only added
  vendor questions.

## Final judge

The final judge (`packages/analysis/src/ai-analysis/judge.ts`) is one more
structured Opus call after the AI-first Analysis and its merge. It runs only
with `ANALYSIS_ENGINE=ai` and a merged AI result. Its job is to catch an
outcome that is too lenient. It never makes an outcome more lenient.

- **Skip:** an outcome that is already NOT_DEPLOYABLE makes no call
  (`aiJudge: {status: 'skipped', reason: 'not_deployable'}`). A row with
  vendor "not used" answers is not judged (`reason: 'vendor_answers'`): the
  vendor's answer is the newer evidence.
- **Input:** the outcome so far, the merged manifest facts (runtime,
  Dockerfile, start command, port, managed services, migration, workers,
  required or infrastructure variable names), the blocking reasons of the
  manifest, the checked answers (subject, answer, decision), the top-level
  directories and every root file (hidden files too, at most 60 entries; a
  longer listing says that it is partial, so an unlisted file is not proof
  that it is missing), and the files it reads: the root README from its first
  heading (80 lines, 4000 characters), `.gitmodules`, the selected
  Dockerfile (4000 characters) and up to two files that a blocking reason
  names. Lines are redacted and keep their numbers. The system message is a
  fixed support policy (`JUDGE_SYSTEM`): one image built from the
  repository source, one HTTP web process plus same-image workers,
  PostgreSQL, MySQL, Redis and S3, stateless disks, and the five impossible
  cases (`unsupported_service`, `several_services`, `local_disk_data`,
  `no_application`, `not_http`).
- **Output:** `verdict` (`keep`, `needs_changes`, `not_deployable` or
  `not_sure`), a category, a one-sentence reason and 1 to 3 cited
  `path:line` quotes.
- **Check and decision** (`decideJudgement`): every cited line must be one
  the judge was shown and contain its quote (`citedLineIn`, the analyst
  check). A cited `not_deployable` with a category blocks: the readiness
  report adds `final-review-unsupported` (CAPABILITY_GAP, NOT_DEPLOYABLE)
  and the manifest adds `Final review: <reason>` to `unsupported`, so the
  deployment gate blocks too. A cited `needs_changes` on a DEPLOYABLE
  outcome adds `final-review-changes` (CODE_CHANGE, DEPLOYABLE_WITH_CHANGES).
  `not_sure`, and a `not_deployable` or `needs_changes` whose citation fails,
  adds the recommended `final-review-question` (needs confirmation): the
  outcome stays, and the vendor checks the technical details. The judge only
  adds a finding; the rules, the checks and every other finding stay.
- **Customer copy:** the finding copy is fixed per category in
  `readiness-report.ts`. The judge's reason and cited lines are the
  technical evidence, in the collapsed details section.
- **Fallback:** a failure (timeout 90 s, schema, spend limit) stores
  `aiJudge: {status: 'fallback'}` and changes nothing.
- **Cost and settings:** low reasoning effort, about 5,900 prompt and 140
  completion tokens, about $0.026 per call and 3.5 s. Claude Opus 5.5 does
  not accept `temperature` (the API answers 400), so the call sets none.
  The call uses no prompt cache: production analyses are minutes apart, so
  a cache write (1.25 times the input price) costs more than the reads save.
  Measured: the top-level `cache_control` through OpenRouter wrote the
  whole prompt on every call and read nothing.
- **Testing:** `pnpm runcheck:judge --from <ai@ folder> --out <judge@ folder>`
  runs only the judge on stored AI analyses (the exam workflow mode
  `judge`), and `--score <dir>` scores a run against the ground truth: a
  wrong outcome, a "not sure", too strict and fixed.
- **Post-MVP:** a vendor dispute of a judge block (today the vendor
  re-analyses, or the vendor's "not used" answers skip the judge), and the
  Anthropic Batch API for exam runs (the gateway has no Anthropic key).

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
driver too can select that engine. `drizzle-orm` or `knex` beside a SQLite or
libSQL driver (`better-sqlite3`, `sqlite3`, `@libsql/client`) is not a
PostgreSQL driver. A PHP app that opens its own SQLite file (`new SQLite3(…)`,
`new PDO('sqlite:…')`; not `sqlite::memory:`) and has no MySQL or PostgreSQL
connection in code or a manifest is SQLite. A Go MySQL driver counts only on
a direct `go.mod` line (or through `gorm.io/driver/mysql`). Local disk writes, a persistent volume
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
SQLite, Elasticsearch/OpenSearch (also the Python clients `elasticsearch`,
`elasticsearch-dsl` and `opensearch-py`), Cassandra, Neo4j (also the Python
drivers `cassandra-driver` and `neo4j`), CouchDB (`nano`), ClickHouse,
embedded JVM databases; the client needs corroboration: a service of that
database in the production Compose file, a required connection setting, or
a production Dockerfile that sets the connection variable, such as
Rocket.Chat's `ENV MONGO_URL=mongodb://…`, where an image of the database
itself does not count; a runtime build file that downloads the
Elasticsearch or OpenSearch server archive needs no corroboration: the app
runs the server next to itself, SonarQube
`elasticsearch-${version}-linux-x86_64.tar.gz`; and a runtime source or
configuration line that states a minimum PostgreSQL or MySQL version above
the provided one, PostgreSQL 16 and MySQL 8.0: Wiki.js 3 "Requires >= 17".
A dependency manifest, a lockfile and a document do not count for the
version. The version rejection asks the AI nothing), `unsupported-redis-setup`,
`unsupported-architecture`, `unsupported-message-queue` (Kafka or RabbitMQ:
a broker service in the production Compose file, also a `rabbitmq` service
that `extends` another file and has no image, or a client such as `pika`,
`aio-pika`, `amqplib` or an `amqp://` URL in runtime source, with a required
connection setting),
`unsupported-multi-service` (Compose application services beyond the web
service and declared workers; also a multi-process image: s6-overlay or
supervisord with two or more services in the production stage (a trailing
dev all-in-one stage does not count), or with one queue worker or
scheduler next to the web service (Laravel `schedule:work` next to nginx and
php-fpm that the base image supervises), or a shell-form CMD or ENTRYPOINT
that puts a server in the background before the foreground one
(`node worker.js & node server.js`), or a start script on the
CMD/ENTRYPOINT chain that puts two or more long-running servers in the
background with `&`, such as Homarr's `redis-server &` and
`node server.js &`; an nginx, apache, httpd or caddy front end and a
migration step do not count; also a stack of seven or more component images:
sibling directories that each hold a `Dockerfile`, such as Harbor
`make/photon/{core,jobservice,registry,…}`, but not in vendored, development,
hidden, test or tooling directories; this rejection asks the AI nothing), `unsupported-persistent-volume`,
`unsupported-gpu` (a CUDA image or an NVIDIA GPU runtime library such as
`nvidia-cudnn-cu12`; a hosted-API client such as `nvidia-riva-client` is not one),
`local-file-storage`,
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
`worker-command` (a SETTING: the vendor types the command) and sets `worker.needsCommand`: a needs-input question
that is never provisioned from weak evidence such as a queue library
alone. A Node job library (Bull, BullMQ, Agenda, Bree, pg-boss,
graphile-worker) or `worker_threads` alone raises no question: these jobs
run in the web process (`workerNeedsProcess` is false). A queue consumer that
the image's start path runs (the start script, or a supervisord config that it
names, such as linkding's `manage.py run_huey`) runs in the web container too
and raises no question. Celery, RQ, Sidekiq
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
  repository checkout (`.:/app`). A service under a `profiles:` key, or one
  that a lighter production variant in the same directory leaves out, is
  optional and blocks nothing. Flagsmith's `docker-compose.flags-only.yml`
  runs the app and PostgreSQL without the ClickHouse, Kafka and ingestion
  services of `docker-compose.yml`. The variant must run an application
  service of the main file and only services of the main file. A Compose
  file in a deployment sample directory (`deploy`, `k8s`, `charts` and the
  other deployment-file directories) whose application services all pull
  published images, next to a Dockerfile Deployz can build, is a
  self-hosting sample: its brokers (Kafka, RabbitMQ), its second application
  service and its PostgreSQL extension image are no evidence (Langflow
  `deploy/docker-compose.yml`, LobeHub `docker-compose/deploy/`). A client in
  the source still blocks, and the sample's datastores stay declared
  services. The extension check reads only the primary Compose file. Services on the same build or image are one
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
  `ACTIVE_STORAGE_SERVICE`, `STORAGE_TYPE`, an `S3_*_BUCKET` name). An S3 SDK
  in the app removes the other Compose local-state findings too, but not a
  `VOLUME` of the selected Dockerfile (Vault `/vault/file`) and not a Compose
  mount at the path that the service's own `*_STATE_DIR` or `*_DATA_DIR`
  variable names (OpenClaw `OPENCLAW_STATE_DIR: /home/node/.openclaw`). A
  RUN step of the selected image that writes a `*data_dir`, `*base_dir` or
  `*storage_dir` setting with a local path into the app's configuration is
  a declared data directory (SFTPGo `"users_base_dir": "/srv/sftpgo/data"`). A
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
  `scaletest` or `*-docker` directories, also with a prefix (`sqlpad-charts`,
  `app_helm`), do not block. They give the `deployment-files-ignored`
  warning and the manifest field `ignoredDeploymentFiles`. Root-level files,
  files elsewhere, and the manifests of a Go module that imports
  `client-go` or `controller-runtime` still block. Terraform in a `ci`,
  `.circleci` or `hack` directory (Vault `enos/ci/`) is test or tooling
  infrastructure and is ignored, and so are Terraform modules (`modules/`)
  with no root configuration outside a `modules/` directory. Azure files still block.
  A Dockerfile in one of these directories with a `gcr.io` base image
  (`kubernetes/minikube/Dockerfile`) is not a Google Cloud file.

Adding a rule: add the finding in `readiness-report.ts` (id, copy, severity,
confidence, and its fix class in `FIX_CLASSES`), a test in
`readiness-report.test.ts`, and — when the deployment
gate must enforce it — the matching check in `manifest.ts` /
`preflight.ts`. Bump `ANALYSIS_VERSION`.

## Vendor disputes

A vendor can mark a blocking finding as "not used in production" when the
analysis read false evidence (a sample config, a test fixture, a development
Compose service). Deployz then analyses the repository again without that
blocker. Every other gate (readiness, manifest, preflight, compiler) still
runs. The TEST deployment proves the result. If the vendor is wrong, the
TEST deployment fails in the vendor's own account.

- **Allowlist.** Only the ids in `DISPUTABLE_FINDING_IDS`
  (`packages/contracts/src/vendor-disputes.ts`) accept a dispute:
  `unsupported-database-mongo`, `-elasticsearch`, `-other`, `-sqlite`,
  `-mariadb`, `unsupported-redis-setup`, `unsupported-message-queue`,
  `unsupported-multi-service`, `unconfirmed-declared-service`,
  `unsupported-persistent-volume` and `local-file-storage`. The rule: being wrong only fails the vendor's TEST
  deployment. It does not bypass security, and it does not give an image
  that Deployz cannot build. `unsupported-gpu`, `unsupported-architecture`,
  `unsupported-no-dockerfile`, `build-context-git-metadata` and the
  non-blocking findings are not on the list. The API enforces the list. The
  UI only hides the action.
- **Storage.** `detected_metadata.vendorDismissedRejections` holds
  `{findingId, reason, dismissedAt, dismissedBy, stale?}`, at most 20
  entries. `reason` is the finding's `technicalEvidence` when the vendor
  answered. The AI dismissals stay a separate list (`dismissedRejections`
  in `mergeAiAnswers`).
- **Matching and staleness.** An answer applies only while a detected
  rejection has the same finding id and the same reason text. For
  `local-file-storage`, the text is the `local-filesystem` detector's
  evidence, and a match sets `localFilesystem: false`. When the evidence
  changes, the answer stays in the list with `stale: true` and does not
  apply. The finding shows again with "Evidence changed". Note: a change to
  the reason text in a new analysis version also makes the answer stale.
- **Analysis.** `runApplicationAnalysis` runs `analyseRepo(tree)`, then
  `vendorResourceOverrides` (`packages/analysis/src/vendor-disputes.ts`),
  then `analyseRepo(tree, overrides)` when an answer matches. The AI engine
  receives the same overrides as `baseOverrides`, so an AI re-run keeps
  them. The run writes the list from the locked row and sets `stale` for the
  answers it read.
- **API.** `POST /api/applications/:id/blocker-disputes`
  `{findingId, reason}` and
  `DELETE /api/applications/:id/blocker-disputes/:findingId`. Both refuse
  with 409 `ANALYSIS_IN_PROGRESS` while an analysis runs. POST refuses an id
  that is not on the list (422 `FINDING_NOT_DISPUTABLE`) and evidence that
  is not the stored finding's (409 `FINDING_CHANGED`). Both write the list,
  set `ANALYZING` and record the event in one transaction, then run a
  forced analysis (the commit-SHA cache never answers it).
  `GET …/readiness` returns the list as `vendorDismissedRejections`.
- **UI.** A disputable blocking row on the Resources tab has the secondary
  action "Not used in production". It opens a confirmation dialog with the
  evidence and the consequence. The two storage findings add a "Files can
  be lost" warning. "Your answers", below the table, lists each answer with
  Undo. An unsupported reason that a blocking finding already shows gets no
  separate "Supported architecture" row and is counted once. The Overview card links to the row ("Is this wrong? Review it in
  Resources").
- **Telemetry.** `application.analysis_disputed` and
  `application.analysis_dispute_withdrawn`
  ([`product-telemetry.md`](product-telemetry.md)). They never hold the
  evidence text.

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
