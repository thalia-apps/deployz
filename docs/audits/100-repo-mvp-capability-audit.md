# 100-repo MVP capability audit

Deployz `51997a3e` (main, 2026-10-06) · `ANALYSIS_VERSION` 38 · compiler `dynamic-compiler-v2-3`.
Sample: `repo-001`..`repo-100` from
`testing/repository-compatibility/benchmark.yaml` (removed 2026-10-18).
No AWS deployments. No product code changes.

## 1. Executive verdict

**Launch the MVP first. Fix Category C before launch. Do not start Phase 6 before launch.**

- Missing infrastructure is not the main blocker. MVP bugs are. 44 of the 66
  target-MVP repositories (67%) fit the current platform, but detection, gate or
  binding defects stop them.
- Today Deployz deploys 10 of 100 repositories meaningfully (A+B), and 5 of 66
  target repositories (8%). Do not launch in this state.
- Fixing Category C alone takes target-MVP coverage to 49 of 66 (74%), and all
  in-scope coverage to 54 of 89 (61%).
- The best single Phase 6 capability (6C EFS, or 6A/6B extra services) unlocks
  at most 6 target repositories (+9 points), at L complexity and high regression
  risk. The Category C fixes unlock 44 (+67 points) at S/M complexity.
- No repository needs Lambda, DynamoDB, OpenSearch (as a sole blocker) or
  CloudFront. No repository has detectable SQS or EventBridge Scheduler demand.
- The compiler is not a blocker. All 100 graphs compile. Every failure happens
  before the compiler: in analysis, the gate or the env bindings.

## 2. Current Deployz capability matrix

Code-verified at `51997a3e`. Code is the source of truth.

| Area | Current capability | Evidence |
| --- | --- | --- |
| Build | One Dockerfile from the repository is required. There is no buildpack, no build target and no build args. A `COPY .git` is rejected because builds use a GitHub tarball. | `packages/analysis/src/detectors.ts` `detectDockerfile`, `detectGitCopyInDockerfile` |
| Web | Exactly one public web workload behind the ALB. HTTPS on `d-<id>.deployz.dev` or a custom domain. Fargate `small-v1` gives 0.25 vCPU / 512 MiB, X86_64. | `packages/analysis/src/graph.ts:90`, `packages/contracts/src/profile.ts:40` |
| Workers | 0..N workers, each one ECS service. They use the same image with a different command, and come only from a Procfile, a compose worker or a package.json `worker` script. | `graph.ts:117`, `detectors.ts` `detectDeclaredWorkerCommands` |
| Migration | One one-shot task before rollout. It is used only when a deploy-safe command is found. A startup migration means no task. A missing migration is a warning only. | `graph.ts:142`, `apps/api/src/analysis.ts` `resolveMigrationCommand` |
| Scheduled jobs | EventBridge Scheduler to a one-shot ECS task. Sources are only `render.yaml` cron and Kubernetes `CronJob`. `PREVIEW`. | `packages/analysis/src/async-detection.ts:619` |
| Database | RDS PostgreSQL 16 or MySQL 8.0, one per deployment, retained on disconnect. MariaDB, MongoDB, SQLite, Elasticsearch/OpenSearch, ClickHouse, Cassandra, Neo4j and H2 are rejected. | `packages/analysis/src/resolver.ts`, `rejection.ts` |
| Cache | ElastiCache Valkey, one node. No TLS, no AUTH, no cluster, no modules, `volatile-lru`. | `redis.ts`, `infrastructure-compiler/src/compile.ts` |
| Queue | SQS Standard plus an optional DLQ, only from JS/TS producer and consumer evidence. FIFO fails closed. `PREVIEW`. | `async-detection.ts:409`, `compile.ts:1158` |
| Object storage | One S3 bucket, always created, with task-role access. It is injected as `STORAGE_BUCKET`, `S3_BUCKET`, `AWS_S3_BUCKET` and `AWS_REGION`. | `compile.ts:319,801` |
| Env vars and secrets | Each variable is managed, generated (minted in the customer account), vendor, customer or optional. Required keys with no value block preflight. The relay adds DB and Redis aliases after install. | `env-classification.ts`, `apps/api/src/preflight.ts`, `packages/relay/src/binding-alias.ts` |
| Multi-workload | Web + N workers + migration + scheduled jobs, all on one image. Compose with 2 or more non-worker app services is rejected. | `rejection.ts` `checkDockerComposeMultiService` |
| Rejected | Persistent volumes / declared data dirs, k8s / Helm, Terraform, Pulumi, own CloudFormation, Serverless, Azure / GCP files, GPU, Kafka, RabbitMQ, Temporal, Redis TLS / cluster / Stack. | `rejection.ts` (20 checks) |
| Analysis limits | 200-file cap. Source is fetched only for `sh/ts/js/py/rb/go`, so Java, PHP, C#, Elixir and Rust are visible only through manifests. The AI fallback fills open questions only. | `apps/api/src/github.ts:617,647` |

Doc/code disagreements that the code check found:

- `mvp-scope.md` rejects "local disk state, Windows, ARM64, privileged". The code detects only declared volumes and data dirs. It does not detect code-level disk writes, ARM64, Windows or privileged.
- The code also rejects Temporal, `COPY .git` and any compose top-level `volumes:` block. `mvp-scope.md` does not list them.
- The web desired count is fixed at 1 in the graph. The docs say "from the profile".
- The `DatabaseState` comment in `analyser.ts` still says MySQL is unsupported.

## 3. Dataset representativeness

The canonical sample is `repo-001`..`100` (80 `improvement` + 20 `unseen`, pinned
commits, double-inspected in earlier phases). The audit kept it unchanged. The
later `unseen2` set (`repo-201`..`220`) and `repo-221` are outside this sample.

| Characteristic | Repos | Characteristic | Repos |
| --- | --- | --- | --- |
| Node | 66 | PostgreSQL required or supported | 78 |
| Python | 18 | MySQL/MariaDB path | 11 |
| Go | 17 | SQLite default or option | 26 |
| Java/JVM | 8 | MongoDB | 2 |
| PHP | 6 | Redis required | 20 |
| Ruby / Rust / C# / Elixir | 4 / 3 / 2 / 2 | Background worker present | 55 |
| Monorepo | 52 | Migration present | 82 |
| Cohort realistic / messy / boundary | 59 / 22 / 19 | S3 used or optional | 58 |

Runtimes overlap in polyglot repositories.

Assessment: **reasonable, with a known bias.**

- The sample is open-source self-hosted software, not proprietary vendor SaaS.
- It over-represents three things relative to target vendors:
  - apps with a SQLite default and an engine selector (26),
  - self-hosted tools that keep state on local disk,
  - repositories that ship dev Compose files, Helm charts and Terraform samples.
- The first two inflate C (binding) and D (6C). The third inflates false rejections.
- Real vendors know their own env names, health route and migration command, and
  can override them. For a real vendor, many C items cost a failed first deploy,
  not a permanent block.
- 66 repositories are tagged target-MVP: a B2B web app with web + DB, optionally
  Redis, worker and S3.

## 4. Methodology

1. **Baseline.** A code-verified capability map at `51997a3e`: detectors, the 20 rejection checks, the gate, preflight, graph, planner, compiler throw paths.
2. **Pipeline run (local, no AWS, AI off).** Every repository went through the production path with the pinned snapshot:
   - `runApplicationAnalysis` → readiness report → `evaluateManifestReadiness` → production `evaluatePreflight`, run twice (no config, and all required env supplied)
   - → `manifestToApplicationGraph` → `planApplicationGraph` → `compileDeployzInfrastructure` → `buildDeploymentSpecV2`.

   The probe compiles even gate-blocked manifests. The harness is `scripts/repository-compatibility` (removed 2026-10-18) plus a probe script. Neither is committed.
3. **Ground truth.** 8 parallel Sonnet agents (12–13 repositories each) read the source at the pinned commit. They used the benchmark notes as a starting point and verified key claims in the source.
4. **Normalization (Opus master)**, applied to all rows before totals:
   - *Friction is not a blocker.* Spurious required env or an over-provisioned resource means B with PARTIAL correctness, because the vendor is prompted and can fill or ignore it.
   - *A confident wrong fact is C.* A wrong health path, port, Dockerfile, migration command or DB/S3 env binding that fails the deploy, or silently drops to SQLite or local disk, is C.
   - *A false rejection is C.* A detector bug is never D.
   - *Vendor Dockerfile work is not 6B.* This covers no in-repo production Dockerfile, a prebuilt artifact, a build target or a `.git` copy. Category follows the rest of the architecture, flagged "vendor Dockerfile work".
   - *Size.* A larger size profile is D only with a documented memory floor. Otherwise it is recorded as uncertainty.
   - 15 rows were changed by master overrides (category or target tag).

Pipeline facts for the whole sample (v38):

- **Verdict:** READY 30 · NEEDS_ATTENTION 19 · NOT_COMPATIBLE 51.
- **Preflight with no config:** ACTION_REQUIRED 32 · ready 17 · UNSUPPORTED 51.
- **Compile:** ok 100/100.
- **Detection:**
  - Exact health-path match 30/79. Port match 76/96.
  - Redis: 22 false positives against 20 truly required.
  - PostgreSQL: 5 false positives, 7 false negatives.
  - MySQL chosen 0 times.
  - Queues 0, schedules 0.
  - 52 repositories ask for required customer keys (median 4, maximum 41).

## 5. 100-repo result table

"target" = target-MVP. "size" = rough fix complexity.

| Repo | Stack | Architecture | Analysis correctness | A–E | Primary blocker | Secondary blocker | MVP/Phase6 | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 001 umami-software/umami | Node/Next.js 16 + Prisma | web+PG (Redis/Kafka/ClickHouse optional) | PARTIAL | B | Detector/gate false positives: KAFKA_MAX_MESSAGE_BYTES treated as required customer env (preflight ACTION_REQUIRED) and… | migration-command-missing warning although migration runs at startup | MVP | target; conf high |
| 002 Unleash/unleash | Node/Express+TS (pnpm monor… | web+PG (in-process scheduler) | INCORRECT | C | Migration command misdetected: package.json script copy-migrations-package (mkdir -p dist/migrations && cp src/migratio… | 6 spurious customer_required env (EMAIL_PASSWORD, INIT_ADMIN/CLIENT/FRONTEND_API_TOKENS,… | MVP | Wrong migration command; target; conf high; size S |
| 003 thedevs-network/kutt | Node/Express + knex | web+PG (Redis optional, in-process Bull/cron) | INCORRECT | C | Health path /health is not mounted (only /api/health, /api/v2/health); GET /health falls to the /:id link-redirect hand… | DB_CLIENT=pg not set (default better-sqlite3) - customer config B-type | MVP | Wrong auto-detected health path; target; conf high; size S |
| 004 miniflux/v2 | Go | web+PG (in-process scheduler) | INCORRECT | C | Health path /v1/integrations/status is an authenticated API route (401), not the public /healthcheck; ALB health check… | migration mode unknown: RUN_MIGRATIONS=1 not detected so schema is not applied (non-block… | MVP | Wrong auto-detected health path; target; conf high; size S |
| 005 Flagsmith/flagsmith | Python/Django + Node fronte… | web(unified API+UI)+PG (task processor in-proce… | INCORRECT | C | False NOT_COMPATIBLE: root docker-compose.yml lists 2 services (flagsmith, flagsmith-task-processor, same image, differ… | 19 spurious customer_required env (frontend/e2e keys: AMPLITUDE_API_KEY, SENTRY_DSN, ENVI… | MVP | False rejection: dev/optional Compose services counted as app services; target; conf med; size M |
| 006 documenso/documenso | Node/React Router 7 + Hono… | web+PG (jobs in-process; S3/Redis optional) | PARTIAL | B | Customer config: base URL, SMTP, and a PDF signing certificate (NEXT_PRIVATE_SIGNING_LOCAL_FILE_CONTENTS) for the produ… | Deployz provisions Valkey though redis is only for optional bullmq provider | MVP | target; conf med |
| 007 ghostfolio/ghostfolio | Node/NestJS+Angular (Nx) +… | web+PG+Redis (Bull in-process) | INCORRECT | C | Health path /api/health is wrong; Nest URI versioning (defaultVersion 1, apps/api/src/main.ts:68) makes the endpoint /a… | worker-command question for in-process Bull (non-blocking) | MVP | Wrong auto-detected health path; target; conf high; size S |
| 008 TwiN/gatus | Go (scratch image) | web only (in-memory storage) | PARTIAL | B | Spurious Postgres detected (lib/pq storage backend is opt-in) provisions an unneeded RDS and sets DATABASE_URL; BASE_UR… | migration-command-missing warning and MIGRATION_STRATEGY question for nonexistent DB | MVP | non-target; conf high |
| 009 heroku/node-js-getting-started | Node/Express (Heroku sample) | web only | CORRECT | B | No Dockerfile in repo: vendor must add one (Deployz has no buildpack/Dockerfile generation) and choose health path / |  | MVP | non-target; conf high |
| 010 knadh/listmonk | Go + Vue | web+PG | INCORRECT | C | App config not bound: Deployz binds DATABASE_* but listmonk reads LISTMONK_db__* (config.toml.sample bakes db host loca… | Dockerfile cannot build from repo (COPY listmonk . needs make dist binary) - customer mus… | MVP | Env binding gap (app-specific DB/Redis/S3 names, engine selector); target; conf med; size M |
| 011 healthchecks/healthchecks | Python/Django (uwsgi) | web(+in-container sendalerts/sendreports daemon… | INCORRECT | C | Health path /checks/status is wrong (login-required endpoint needing a code); real probe is /api/v3/status/, so ALB hea… | DB=postgres and DB_PASSWORD not set: bindings give DB_HOST/NAME/PORT/USER only, so the ap… | MVP | Wrong auto-detected health path; target; conf high; size M |
| 012 diced/zipline | Node/Fastify + Drizzle | web+PG+S3 (in-process tasks) | INCORRECT | C | Migration command npx drizzle-kit push (script db:prototype) is wrong: drizzle-kit is a devDependency, runtime image in… | CORE_SECRET (no default, rejects short/default values) not surfaced as required or genera… | MVP | Wrong migration command; target; conf med; size S |
| 013 louislam/uptime-kuma | Node/Express + Vue, socket.… | single web (websocket) + SQLite or external Mar… | PARTIAL | D | MariaDB-only DB engine (SQLite default is rejected); Deployz offers PostgreSQL/MySQL only | detector bugs: redis=true (monitor client), local-file-storage from compose ./data volume… | Phase 6 / post-MVP | RDS MariaDB; non-target; conf med; size M |
| 014 automatisch/automatisch | Node/Express + React, knex,… | web + worker (same image, WORKER env) + PG + Re… | INCORRECT | C | compose named volume flagged local-file-storage -> NOT_COMPATIBLE for an app that fits web+worker+PG+Redis | worker command taken from dev script `nodemon ... src/worker.js` (nodemon is a devDepende… | MVP | False rejection: Compose/VOLUME read as durable local storage; target; conf high; size M |
| 015 immich-app/immich | NestJS/Node + Python ML + p… | server + separate ML image + PG(VectorChord/pgv… | UNSUPPORTED | E | single-tenant media server: separate ML image + large local /data + non-RDS vector extension | 6A/6B extra service | Out of scope | non-target; conf high |
| 016 outline/outline | Node/Koa + React, Sequelize… | web (+worker+collab in-process) + PG + Redis +… | PARTIAL | B | normal config: URL, SSO provider, FILE_STORAGE=s3, AWS_S3_UPLOAD_BUCKET_URL | Deployz reports READY with no required env: URL, FILE_STORAGE=s3 and an SSO provider are… | MVP | target; conf med |
| 017 lukevella/rallly | Next.js, Prisma, pnpm/turbo | web + PG (+ optional S3, SMTP) | PARTIAL | C | migration command resolved to root-package script `pnpm --filter @rallly/database exec prisma migrate deploy`, which ca… | spurious customer_required SELF_HOSTED (Dockerfile ARG) | MVP | Wrong migration command; target; conf med; size S |
| 018 docmost/docmost | NestJS/Fastify + React, Kys… | web (in-process queue/collab) + PG + Redis + S3 | PARTIAL | C | migration command mis-detected as `tsx src/database/migrate.ts create` (creates a migration file, needs a name; tsx not… | false worker.needsCommand (worker is in-process) | MVP | Wrong migration command; target; conf med; size S |
| 019 linkwarden/linkwarden | Next.js + worker (tsx), Pri… | web+worker in one CMD + PG + local/S3 archive s… | PARTIAL | C | spurious required env (MEILI_MASTER_KEY, NEXT_PUBLIC_OLLAMA_ENDPOINT_URL, SPACES_BUCKET_NAME) block deploy; detected wo… | S3 needs static SPACES_KEY/SECRET (task role unsupported); SPACES_SECRET shown as deployz… | MVP | Wrong/duplicate worker command; target; conf med; size M |
| 020 papermark/papermark | Next.js 14 (Vercel-first),… | web + PG + S3 + many SaaS deps; no Dockerfile | PARTIAL | C | DB binding gap: POSTGRES_PRISMA_URL / _NON_POOLING / SHADOW listed as customer_required (customer cannot know the RDS U… | no Dockerfile (customer must author; Deployz states this correctly) | MVP | Env binding gap (app-specific DB/Redis/S3 names, engine selector); target; conf med; size S |
| 021 directus/directus | Node/Express + Vue (pnpm mo… | web + PG (+ optional Redis) + S3 | INCORRECT | C | READY with no required env while the image defaults DB_CLIENT=sqlite3: DB_CLIENT/DB_CONNECTION_STRING/DB_HOST/DB_USER/D… | ADMIN_EMAIL/ADMIN_PASSWORD/PUBLIC_URL/STORAGE_LOCATIONS not surfaced | MVP | Env binding gap (app-specific DB/Redis/S3 names, engine selector); target; conf med; size M |
| 022 ToolJet/ToolJet | NestJS + React, TypeORM, Bu… | single image (bundled redis) + PG (2 DBs) + Pos… | PARTIAL | D | ToolJet Database requires a PostgREST sidecar (separate image) and a second DB config | detector bugs: root docker-compose.yaml is the DEV compose (plugins/client/server) -> fal… | Phase 6 / post-MVP | 6A/6B extra services / multiple images; target; conf low; size L |
| 023 requarks/wiki | Node/Express + Vue, Objecti… | web + PG | INCORRECT | C | false rejection: VOLUME /wiki/data/content (optional git content path; reported from dev/build-arm/Dockerfile, a non-se… | DB_* discrete names from config.yml ($(DB_HOST)) not aliased (only DATABASE_*), DB_TYPE/D… | MVP | False rejection: Compose/VOLUME read as durable local storage; target; conf med; size M |
| 024 calcom/cal.diy | Next.js (turbo), Prisma, tR… | web + PG (Redis optional via Upstash REST) + in… | INCORRECT | C | false rejection: docker-compose.yml lists calcom, calcom-api, studio as 3 app services though only calcom is required (… | DATABASE_DIRECT_URL listed customer_required (needs alias to DATABASE_URL) | MVP | False rejection: dev/optional Compose services counted as app services; target; conf med; size M |
| 025 lobehub/lobehub | Next.js, Drizzle, pg_search… | web + PostgreSQL with ParadeDB pg_search + S3 (… | PARTIAL | D | required PostgreSQL extension pg_search (ParadeDB) is not available on RDS; needs a custom Postgres | v38 reasons are wrong: rediss:// flagged though Redis is optional, compose (lobe, postgre… | Phase 6 / post-MVP | Custom PostgreSQL extension (pg_search); target; conf med; size L |
| 026 amruthpillai/reactive-resume | TypeScript (pnpm/turbo, Hon… | web+PG (+opt S3/Redis) | PARTIAL | B |  | spurious Valkey (REDIS_URL optional) | MVP | non-target; conf true |
| 027 plankanban/planka | JS (Sails + React) | web+PG (+opt S3) | PARTIAL | B | gate lists 8 customer-required env keys of which 7 are optional in .env.sample (ACTIVE_USERS_LIMIT, MAX_UPLOAD_FILE_SIZ… | S3 keys demanded though Deployz bucket uses task role | MVP | target; conf med |
| 028 Infisical/infisical | TypeScript (Fastify backend… | web(in-proc BullMQ workers)+PG+Redis | INCORRECT | C | health path /health is the Go backend route (backend-go platform_routes.go:29); node app serves /api/status (routes/ind… | DB_CONNECTION_URI, INF_APP_CONNECTION_AWS_*, NEXT_PUBLIC_SAML_ORG_SLUG wrongly customer-r… | MVP | Wrong auto-detected health path; target; conf high; size M |
| 029 postalsys/emailengine | Node (Hapi, worker_threads) | web+Redis-as-database | PARTIAL | D | Redis used as the primary datastore; MVP Valkey is a non-durable volatile-lru cache | port not detected (EENGINE_PORT default 3000 in config/default.toml; no EXPOSE) | Phase 6 / post-MVP | Durable Redis datastore; non-target; vendor Dockerfile work; conf med; size S |
| 030 verdaccio/verdaccio | Node (pnpm monorepo, npm re… | web+local-disk storage | UNSUPPORTED | D | persistent local filesystem (published packages + htpasswd) with no in-repo object-storage option | health /-/ping not detected (moot) | Phase 6 / post-MVP | 6C persistent disk (EFS); non-target; conf high; size L |
| 031 gethomepage/homepage | Node (Next.js) | web+file-config dashboard | UNSUPPORTED | E | homelab dashboard whose configuration lives in editable files on a host mount | HOMEPAGE_ALLOWED_HOSTS missed; HOMEPAGE_MCP_TOKEN spurious | Out of scope | non-target; conf med |
| 032 mealie-recipes/mealie | Python (FastAPI + Nuxt) | web+PG(or SQLite)+local data dir | PARTIAL | D | core recipe images/backups on local /app/data with no object-storage option | DATABASE_URL bindings do not match POSTGRES_*/DB_ENGINE: app would silently use SQLite | Phase 6 / post-MVP | 6C persistent disk (EFS); target; conf high; size L |
| 033 paperless-ngx/paperless-ngx | Python (Django + Angular, s… | web+celery(in-container)+PG+Redis+local media | PARTIAL | D | archived documents stored on local disk with no object-storage option | Redis missed (redis false; celery broker required) | Phase 6 / post-MVP | 6C persistent disk (EFS); non-target; conf high; size L |
| 034 CTFd/CTFd | Python (Flask) | web+MySQL+(opt Redis)+S3 uploads | INCORRECT | C | false rejection: compose volume .data/CTFd/uploads treated as required local state although UPLOAD_PROVIDER=s3 is suppo… | DB detected as postgres but prod image only has PyMySQL; MySQL is now supported | MVP | False rejection: Compose/VOLUME read as durable local storage; target; conf med; size M |
| 035 spiral-project/ihatemoney | Python (Flask) | web+PG | INCORRECT | C | env binding gap: Deployz binds DATABASE_URL/DATABASE_* but app only reads SQLALCHEMY_DATABASE_URI; the app would silent… | SECRET_KEY default tralala not generated | MVP | Env binding gap (app-specific DB/Redis/S3 names, engine selector); target; conf high; size S |
| 036 django-helpdesk/django-helpdesk | Python (Django standalone) | web+cron(in-container)+PG+local media | PARTIAL | D | ticket attachments need persistent MEDIA_ROOT /data/media; S3 path not available in the standard image | standalone/Dockerfile unbuildable from archive (COPY django-helpdesk/) | Phase 6 / post-MVP | 6C persistent disk (EFS); target; conf med; size M |
| 037 apache/superset | Python (Flask) + Node front… | web+celery worker+beat+PG+Redis | PARTIAL | D | does not fit the single 0.25 vCPU / 512 MiB profile (pandas/gunicorn/celery need several GiB); needs larger size profile | gate rejects on dev compose services superset-node/websocket (false multi-service) | Phase 6 / post-MVP | Larger size profile; target; conf med; size L |
| 038 apache/answer | Go | web (in-process cron)+PG+local /data uploads | CORRECT | D | Durable local state: uploads and installer config.yaml under /data, no object-storage option |  | Phase 6 / post-MVP | 6C persistent disk (EFS); target; conf high |
| 039 usememos/memos | Go+React | web+PG(+S3 optional) | INCORRECT | C | MEMOS_DRIVER=postgres not set/asked: app silently runs SQLite on ephemeral disk while RDS idles | MEMOS_DRIVER=postgres not set so app silently uses sqlite on ephemeral disk (MEMOS_DSN al… | MVP | Env binding gap (app-specific DB/Redis/S3 names, engine selector); target; vendor Dockerfile work; conf med; size S |
| 040 authelia/authelia | Go+React | SSO portal (web) + config.yml + file/LDAP users | INCORRECT | E | Not a small SaaS app: reverse-proxy forward-auth SSO portal requiring a mounted config file and user DB file | root Dockerfile cannot build from repo (ARG TAG/SHA, prebuilt binary COPY) | Out of scope | non-target; conf med |
| 041 coder/coder | Go+React | control plane web+PG; needs workspace provision… | PARTIAL | E | Developer-environment platform: workspaces need Docker socket/K8s/cloud provisioning outside a single Fargate web task | scripts/Dockerfile copies prebuilt binary (not buildable from repo) | Out of scope | non-target; conf med |
| 042 grafana/grafana | Go+TS | web+PG (GF_DATABASE_*) | INCORRECT | C | Wrong health path: v38 picked /readyz which belongs to the module-server mode (pkg/server/health.go), not monolith graf… | No GF_DATABASE_* binding: DATABASE_URL not understood so Grafana falls back to sqlite on… | MVP | Wrong auto-detected health path; target; conf high; size S |
| 043 huginn/huginn | Ruby/Rails | web+delayed_job (jobs)+PG | INCORRECT | C | False NOT_COMPATIBLE: gate rejects on docker/single-process/docker-compose.yml (2 services) although the selected Docke… | spurious required FARADAY_HTTP_BACKEND (code uses ENV.fetch with default) | MVP | False rejection: dev/optional Compose services counted as app services; target; conf high; size S |
| 044 firefly-iii/firefly-iii | PHP/Laravel | web+DB(pgsql/mysql)+local uploads+cron | PARTIAL | D | No Dockerfile in repository (official image lives in another repo); also attachments only on local disk and cron needed… | DB missed (db null; Laravel pgsql not detected) | Phase 6 / post-MVP | 6C persistent disk (EFS); non-target; conf low; size M |
| 045 monicahq/monica | PHP/Laravel+Node | web(apache)+cron+PG | INCORRECT | C | Port detected as 8000 but Apache in scripts/docker/Dockerfile listens on 80; health /up (bootstrap/app.php) not found s… | cron worker (scripts/docker/cron.sh) not detected: reminders feature would not run | MVP | Wrong Dockerfile/port selection; target; conf med; size M |
| 046 kanboard/kanboard | PHP | web(nginx+php-fpm via s6, cron inside)+DB | UNSUPPORTED | D | Task attachments and plugins live only on local disk (VOLUME /var/www/app/data); no object-storage backend | health detected /health (real /healthcheck.php), db=null (DATABASE_URL pg not detected) -… | Phase 6 / post-MVP | 6C persistent disk (EFS); target; conf high; size S |
| 047 halo-dev/halo | Java/Spring+Vue | web+PG+local attachments/themes/plugins | UNSUPPORTED | D | Work dir (attachments, themes, plugins) on local disk; Dockerfile also needs prebuilt jar | Dockerfile not buildable from repo alone (no gradle step) | Phase 6 / post-MVP | 6C persistent disk (EFS); target; conf high; size M |
| 048 tolgee/tolgee-platform | Kotlin/Spring+React | web+PG+S3 optional | INCORRECT | C | Wrong health path /health (real /actuator/health) and DATABASE_* not mapped to SPRING_DATASOURCE_* | health /health wrong, real /actuator/health (would fail ALB check) | MVP | Wrong auto-detected health path; target; vendor Dockerfile work; conf med; size M |
| 049 OrchardCMS/OrchardCore | C#/.NET | web+DB via AutoSetup+local App_Data | PARTIAL | D | Tenant/shell state and data-protection keys under App_Data on local disk unless customer enables DB shells + S3 media (… | db=null: Postgres not detected so no RDS provisioned | Phase 6 / post-MVP | 6C persistent disk (EFS); non-target; conf low; size M |
| 050 livebook-dev/livebook | Elixir | web notebook IDE, local /data | INCORRECT | E | Developer notebook IDE that executes arbitrary code, not a small SaaS target; Dockerfile also needs undefaulted BASE_IM… | port detected 4000 but container serves 8080 (HEALTHCHECK uses LIVEBOOK_PORT-8080): ALB h… | Out of scope | non-target; conf med |
| 051 docusealco/docuseal | Ruby/Rails 8, Puma, Sidekiq… | web(+embedded sidekiq)+PG+S3 (redis optional/se… | PARTIAL | C | S3 bucket env alias S3_ATTACHMENTS_BUCKET not detected (STORAGE_BINDING ambiguity): app stays on ephemeral local disk,… | SIDEKIQ_BASIC_AUTH_PASSWORD falsely required (guarded by .to_s.empty? in config/initializ… | MVP | Env binding gap (app-specific DB/Redis/S3 names, engine selector); target; conf high; size S |
| 052 laurent22/joplin | Node/TypeScript (Koa, knex,… | web+PG (db-blob storage by default) | PARTIAL | C | DB engine selector DB_CLIENT=pg and POSTGRES_*/POSTGRES_CONNECTION_STRING not detected/aliased: Deployz injects only DA… | port null (APP_PORT:22300 default in env.ts not detected) | MVP | Env binding gap (app-specific DB/Redis/S3 names, engine selector); target; conf high; size M |
| 053 n8n-io/n8n | Node/TypeScript pnpm monore… | web+PG (+optional queue-mode workers+Redis); S3… | INCORRECT | C | Wrong Dockerfile selected (docker/images/engine, node dist/serve.js:3000) instead of docker/images/n8n; DB_TYPE/DB_POST… | migration command is a vitest test command (pre_deploy job would fail) | MVP | Wrong Dockerfile/port selection; target; vendor Dockerfile work; conf med; size L |
| 054 hoppscotch/hoppscotch | Node (NestJS, Prisma 7) + V… | single aio image (caddy+backend+webapp) + PG | INCORRECT | C | Port detected from ENV PORT=8080 (backend API) instead of the all-in-one EXPOSE 80; SPA/admin unreachable | detected port 8080 reaches only the backend API (SPA/admin not reachable) | MVP | Wrong Dockerfile/port selection; target; conf med; size S |
| 055 nocodb/nocodb | Node/TypeScript (NestJS) pn… | web+PG meta DB (+S3 attachments); no Dockerfile… | INCORRECT | C | False NOT_COMPATIBLE: charts/nocodb/Chart.yaml (optional Helm chart) triggers the kubernetes rejection | no Dockerfile in repo (vendor must author one) | MVP | False rejection: sample Helm/Terraform/k8s descriptors; target; vendor Dockerfile work; conf med; size M |
| 056 gristlabs/grist-core | Node/TypeScript + Python sa… | web + per-document SQLite files on local disk (… | UNSUPPORTED | D | Per-document SQLite files on persistent local disk (GRIST_DATA_DIR=/persist/docs) | S3 external storage needs static MinIO-client keys, not task role | Phase 6 / post-MVP | 6C persistent disk (EFS); target; conf high; size L |
| 057 gitroomhq/postiz-app | Node pnpm monorepo (NestJS,… | web(nginx+3 node procs)+PG+Redis+Temporal(+ES)+… | UNSUPPORTED | D | Requires a Temporal server (own Postgres + Elasticsearch in the official compose) | 3 node processes + nginx in 512 MiB | Phase 6 / post-MVP | 6A/6B extra services / multiple images; target; conf high; size L |
| 058 go-gitea/gitea | Go (s6 supervisor, openssh) | web+PG+local git repositories on disk | UNSUPPORTED | D | Git repositories require persistent local disk (VOLUME /data) | SSH TCP port 22 not exposable via ALB | Phase 6 / post-MVP | 6C persistent disk (EFS); non-target; conf high; size L |
| 059 go-vikunja/vikunja | Go + Vue (static binary, FR… | web(+in-process cron)+PG; attachments local or… | INCORRECT | C | Wrong health path auto-detected (/csv/status, explicit) so ALB health checks would fail; VIKUNJA_DATABASE_* names not b… | no VIKUNJA_DATABASE_SSLMODE (RDS force_ssl) | MVP | Wrong auto-detected health path; target; conf high; size M |
| 060 wallabag/wallabag | PHP/Symfony | web+PG(+optional Redis/RabbitMQ import workers)… | PARTIAL | C | Rejected as local-file-storage from dev compose/Dockerfile volumes, not a real need (secondary asset cache); real block… | dev Dockerfile (no app code, dev server) selected | MVP | False rejection: Compose/VOLUME read as durable local storage; target; vendor Dockerfile work; conf med; size S |
| 061 logto-io/logto | Node/TypeScript pnpm monore… | web+PG (admin console on second port 3002) | INCORRECT | C | DB_URL (assertEnv, required) not detected/aliased and seed/migration command missing: READY verdict but container crash… | admin console on port 3002/second hostname unreachable with a single public port (low con… | MVP | Env binding gap (app-specific DB/Redis/S3 names, engine selector); target; conf med; size M |
| 062 metabase/metabase | Clojure/JVM (uberjar built… | web+PG app DB (H2 default) | PARTIAL | D | 512 MiB small-v1 profile likely too small for Metabase JVM (needs ~1-2 GiB) | MB_DB_* env names not bound (app would use ephemeral H2, RDS idle) | Phase 6 / post-MVP | Larger size profile; target; conf low; size M |
| 063 keycloak/keycloak | java/quarkus | web+PG (Infinispan internal) | INCORRECT | D | 512 MiB too small for Keycloak (about 1.25 GB documented) | Dockerfile needs a CI-prebuilt Maven tarball (dockerfile_vendor_work) | Phase 6 / post-MVP | Larger size profile; target; vendor Dockerfile work; conf med; size L |
| 064 casdoor/casdoor | go + react | web+PG (optional redis) | PARTIAL | C | App needs driverName=postgres plus a composed keyword dataSourceName; Deployz binds only DATABASE_URL/HOST/... so no va… | health /api/health not detected (vendor can set) | MVP | Env binding gap (app-specific DB/Redis/S3 names, engine selector); target; conf med; size M |
| 065 ory/kratos | go | headless API+PG (courier in-process via flag) | INCORRECT | C | False READY: wrong health path /status (ALB check would fail), no DSN env binding, migration command and --watch-courie… | required config (identity schema, secrets, URLs) not surfaced as needs-input | MVP | Wrong auto-detected health path; target; conf med; size M |
| 066 karakeep-app/karakeep | node/next + workers | web+workers (in one container)+SQLite+local ass… | UNSUPPORTED | D | SQLite as the sole primary store (needs persistent disk) | separate headless-chrome service for crawling | Phase 6 / post-MVP | 6C persistent disk (EFS); non-target; conf high; size L |
| 067 formbricks/formbricks | node/next monorepo | web+PG(pgvector)+Redis+hub+cube+spicedb | UNSUPPORTED | D | Requires separate hub and cube (and spicedb) services from other images | Redis noeviction (Valkey volatile-lru) | Phase 6 / post-MVP | 6A/6B extra services / multiple images; target; conf med; size L |
| 068 baptisteArno/typebot.io | node/next/bun monorepo | builder web + viewer web + PG + Redis(opt) | UNSUPPORTED | D | Builder and viewer are two web services (different SCOPE builds of one Dockerfile) | Dockerfile ARG SCOPE has no default and is not detected | Phase 6 / post-MVP | 6A/6B extra services / multiple images; target; vendor Dockerfile work; conf med; size L |
| 069 twentyhq/twenty | node/nest + react | web+worker(same image)+PG+Redis+S3 | INCORRECT | C | False rejection: optional k8s/terraform deployment sample under packages/twenty-docker/k8s is treated as customer IaC | port 2020 comes from the dev stage, real port 3000 (NODE_PORT) | MVP | False rejection: sample Helm/Terraform/k8s descriptors; target; vendor Dockerfile work; conf med; size S |
| 070 LemmyNet/lemmy | rust | API backend + separate lemmy-ui + pictrs + PG | UNSUPPORTED | D | Needs lemmy-ui and pict-rs as separate services from other images/repos | no health route | Phase 6 / post-MVP | 6A/6B extra services / multiple images; non-target; conf high; size L |
| 071 chatwoot/chatwoot | ruby/rails + vue | web+sidekiq worker(same image)+PG(pgvector)+Red… | INCORRECT | C | False rejection from the dev docker-compose.yaml (rails + vite) instead of docker-compose.production.yaml (rails + side… | no start command: Procfile web/worker/release not used for web and migration | MVP | False rejection: dev/optional Compose services counted as app services; target; conf med; size M |
| 072 zulip/zulip | python/django + tornado | multi-process (django, tornado, queue workers)… | INCORRECT | E | Not a single-image container app: Puppet host install with RabbitMQ, memcached, Tornado and supervisor-managed queue wo… | RabbitMQ unsupported | Out of scope | non-target; conf med |
| 073 obsidiandynamics/kafdrop | java/spring | stateless web UI for an external Kafka cluster | UNSUPPORTED | E | Kafka admin tool, not a SaaS web app; depends on an external Kafka cluster Deployz does not provide | health /actuator/health not detected | Out of scope | non-target; conf low |
| 074 dani-garcia/vaultwarden | rust | web+PG+local /data | INCORRECT | C | Root Dockerfile is a symlink read as one-line text, so port/start/health are lost (detector) | once parsed, VOLUME /data triggers the local-filesystem rejection; S3 mode needs a non-de… | MVP | Wrong Dockerfile/port selection; target; conf med; size S |
| 075 dgtlmoon/changedetection.io | python/flask | web + flat-file /datastore | UNSUPPORTED | D | All state in a local /datastore directory with no DB or S3 option | optional browser sidecar | Phase 6 / post-MVP | 6C persistent disk (EFS); non-target; conf high; size L |
| 076 danny-avila/LibreChat | node/npm monorepo | web+MongoDB(+optional Meili/RAG/Redis) | UNSUPPORTED | D | MongoDB (no relational option) |  | Phase 6 / post-MVP | 6F DocumentDB (MongoDB); target; conf med; size L |
| 077 argoproj/argo-cd | go | k8s controllers + redis | UNSUPPORTED | E | Kubernetes controller platform | Dockerfile has no start command | Out of scope | non-target; conf high |
| 078 GoogleCloudPlatform/microservices-demo | polyglot 12 microservices | 12 services + redis (GKE demo) | UNSUPPORTED | E | Multi-service GCP/K8s reference demo | 12 separate images | Out of scope | non-target; conf high |
| 079 Azure-Samples/azure-search-openai-demo | python quart + vite frontend | web + Azure AI Search/Cosmos/Blob/Entra | UNSUPPORTED | E | Azure-service reference demo (AI Search/Cosmos/Blob hard deps) | frontend not built in Dockerfile | Out of scope | non-target; vendor Dockerfile work; conf high |
| 080 vllm-project/vllm | python/CUDA | GPU inference server | UNSUPPORTED | E | GPU inference server |  | Out of scope | non-target; conf high |
| 081 hedgedoc/hedgedoc | node yarn monorepo (HedgeDo… | backend(NestJS)+frontend(Next.js)+PG | UNSUPPORTED | D | Second required web service (Next.js frontend) built from a different Dockerfile | second image/build | Phase 6 / post-MVP | 6A/6B extra services / multiple images; target; conf high; size M |
| 082 mattermost/mattermost | go+node (prebuilt tarball i… | web + PG (+S3 optional) | INCORRECT | C | False NOT_COMPATIBLE[multi-service] from server/build/docker-compose.yml (15 dev support services, no Mattermost app se… | S3 file driver needs MM_FILESETTINGS_DRIVERNAME=amazons3 env or uploads go to local disk | MVP | False rejection: dev/optional Compose services counted as app services; target; conf med; size S |
| 083 windmill-labs/windmill | rust+svelte | web+worker standalone + PG | INCORRECT | C | False NOT_COMPATIBLE[multi-service]: root docker-compose.yml windmill_server/indexer/extra are optional scaling/aux ser… | Real build blocker: Dockerfile does COPY .git/ which tarball builds lack (vendor Dockerfi… | MVP | False rejection: dev/optional Compose services counted as app services; target; vendor Dockerfile work; conf med; size S |
| 084 NangoHQ/nango | node monorepo | server+jobs+runner+persist+orchestrator + PG +… | INCORRECT | D | Meaningful Nango (syncs/actions) needs jobs, runner, persist, orchestrator as extra long-running services; Dockerfile.s… | v38 false accept READY: start tsc && node dist/app.js, health /sync/status (real /health)… | Phase 6 / post-MVP | 6A/6B extra services / multiple images; target; vendor Dockerfile work; conf med; size L |
| 085 teableio/teable | node pnpm monorepo (Next+Ne… | web(+plugins proc)+PG+Redis(BullMQ)+S3 | INCORRECT | C | Env binding mismatch: Redis bound as REDIS_URL/HOST/PORT but app reads BACKEND_CACHE_REDIS_URI and throws at boot (Bull… | migration command from a package script (dotenv-flow -p ../../apps/nextjs-app ...) is pat… | MVP | Env binding gap (app-specific DB/Redis/S3 names, engine selector); target; conf med; size M |
| 086 wger-project/wger | django+node build | web + PG (+optional celery/redis) | INCORRECT | C | Wrong Dockerfile selected (extras/docker/base/Dockerfile: no CMD, no app) instead of extras/docker/production/Dockerfil… | spurious Redis (celery optional, off by default) over-provisions Valkey | MVP | Wrong Dockerfile/port selection; target; conf high; size S |
| 087 TandoorRecipes/recipes | django+vue3 (nginx+gunicorn) | web + PG (+S3 optional) | INCORRECT | C | False NOT_COMPATIBLE[local-filesystem] from a staticfiles volume in docs/install/docker/ipv6 compose; staticfiles are r… | health /health explicit but Tandoor has no such route (use /openapi/) | MVP | False rejection: Compose/VOLUME read as durable local storage; target; vendor Dockerfile work; conf med; size S |
| 088 netbox-community/netbox | python/django | web(gunicorn)+rqworker+PG+Redis+media-disk(S3 o… | CORRECT | B | No in-repo production Dockerfile + start command; worker command (rqworker) must be supplied | configuration.py not env-driven | MVP | target; vendor Dockerfile work; conf med |
| 089 Stirling-Tools/Stirling-PDF | java/spring+react | single stateless web (PDF/LibreOffice/OCR) + lo… | INCORRECT | D | small-v1 512 MiB too small for JVM+LibreOffice/OCR image (estimate) | v38 READY targets engine/Dockerfile (python AI engine :5001, 31 spurious required env) no… | Phase 6 / post-MVP | Larger size profile; non-target; conf low; size M |
| 090 sosedoff/pgweb | go | single web binary + customer PG (DATABASE_URL) | CORRECT | B | Dockerfile has COPY .git/ . which fails on tarball builds (vendor must change Dockerfile/Makefile); then health path /… | no health route | MVP | non-target; vendor Dockerfile work; conf high |
| 091 nextcloud/server | php | web(apache/fpm)+cron+PG/MySQL+local data dir (S… | PARTIAL | D | Persistent writable config.php/apps dir (no EFS) | no production Dockerfile (v38 selects .devcontainer/Dockerfile) | Phase 6 / post-MVP | 6C persistent disk (EFS); non-target; vendor Dockerfile work; conf med; size L |
| 092 Lissy93/dashy | node/vue | single web, static dashboard from baked conf.yml | CORRECT | A | — |  | MVP | non-target; conf med |
| 093 thelounge/thelounge | node | single web+websocket IRC client, state on local… | UNSUPPORTED | D | Local-disk durable state (THELOUNGE_HOME) with no object-storage option | no Dockerfile | Phase 6 / post-MVP | 6C persistent disk (EFS); non-target; vendor Dockerfile work; conf high; size L |
| 094 homarr-labs/homarr | node/next+nginx+embedded re… | single container (nginx+redis+Next) + DB (sqlit… | INCORRECT | C | False rejection: VOLUME /appdata (sqlite default) flagged local-filesystem though DB dialect is env-selectable to PG | db not detected (mysql drizzle config picked; migration-without-PG unsupported) | MVP | False rejection: Compose/VOLUME read as durable local storage; target; conf med; size M |
| 095 openstatusHQ/openstatus | ts monorepo + go + deno | dashboard+status-page+server+workflows+checker,… | UNSUPPORTED | D | Multiple application services/images (7 compose services incl. libsql, workflows, server, dashboard, status-page, check… | libSQL/SQLite datastore | Phase 6 / post-MVP | 6A/6B extra services / multiple images; non-target; conf high; size L |
| 096 mastodon/mastodon | ruby/rails+node streaming | web(puma)+sidekiq+streaming(node)+PG+Redis+S3(o… | PARTIAL | D | Streaming server is a second HTTP/websocket service (compose web+streaming, separate image) | 512 MiB likely insufficient for Rails+puma | Phase 6 / post-MVP | 6A/6B extra services / multiple images; non-target; conf med; size L |
| 097 plausible/analytics | elixir/phoenix | web+Oban in-process+PG+ClickHouse | INCORRECT | D | Mandatory ClickHouse analytics database | v38 does not detect ClickHouse (Elixir sources not fetched): ALMOST_READY false acceptance | Phase 6 / post-MVP | ClickHouse; non-target; conf high; size L |
| 098 wekan/wekan | node/meteor | web + MongoDB wire protocol (FerretDB sidecar o… | UNSUPPORTED | D | MongoDB-only datastore (MONGO_URL) | FerretDB sidecar compose | Phase 6 / post-MVP | 6F DocumentDB (MongoDB); non-target; conf med; size M |
| 099 BookStackApp/BookStack | php/laravel | web(apache)+MySQL+S3(opt) | INCORRECT | C | False rejection: dev-only docker-compose (app,node) counted as multi-service and dev/docker/Dockerfile selected | no production Dockerfile in repo (vendor work) | MVP | False rejection: dev/optional Compose services counted as app services; target; vendor Dockerfile work; conf low; size M |
| 100 penpot/penpot | clojure+node+rust | frontend(nginx)+backend(JVM)+exporter+mcp+PG+Va… | PARTIAL | D | 4 application containers (frontend nginx, backend JVM, exporter, mcp) | Dockerfiles COPY CI-prebuilt bundles (vendor work) | Phase 6 / post-MVP | 6A/6B extra services / multiple images; non-target; vendor Dockerfile work; conf high; size L |

## 6. Understanding coverage

Understanding means that Deployz describes the application correctly
(CORRECT), or rejects it for the right reason (UNSUPPORTED).

| Set | CORRECT | UNSUPPORTED | PARTIAL | INCORRECT | Understanding |
| --- | --- | --- | --- | --- | --- |
| All 100 | 5 | 23 | 29 | 43 | 28/100 (28%) |
| Target-MVP (66) | 2 | 8 | 18 | 38 | 10/66 (15%) |
| Non-target (34) | 3 | 15 | 11 | 5 | 18/34 (53%) |

Deployz understands what it must reject better than what it must deploy.
Most INCORRECT rows are confident wrong facts on apps that fit the MVP shape.

## 7. Deployment coverage

| Set | A | B | A+B (current) | C | D | E | A+B+C (post-C) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| All 100 | 1 | 9 | **10 (10%)** | 44 | 35 | 11 | **54 (54%)** |
| In-scope (excl. E, 89) | 1 | 9 | 10 (11%) | 44 | 35 | — | 54 (61%) |

- 6 of the 10 A/B rows still carry friction: spurious required keys or unneeded RDS/Valkey.
- 3 of the 10 need vendor Dockerfile work: heroku-sample, netbox, pgweb.
- Only dashy is A with zero inputs.

## 8. Target-MVP coverage

| Target-MVP (66) | Count | Share |
| --- | --- | --- |
| Current (A+B) | 5 | 8% |
| Category C (MVP bugs) | 44 | 67% |
| Category D (Phase 6 / post-MVP) | 17 | 26% |
| Post-C coverage | 49 | **74%** |
| Post-C + every D capability (theoretical) | 66 | 100% |

All 44 Category C rows are target-MVP repositories. The target gap is
dominated by bugs, not by missing infrastructure.

Uncertainty:

- Post-C coverage assumes general fixes, not per-repository patches. Some C rows have a second C blocker (for example, a wrong health path plus a binding gap).
- About 10 C rows (twenty, outline, cal.diy, mattermost, windmill, teable, linkwarden, chatwoot and others) carry an unverified 512 MiB memory risk.
- Realistic post-C target coverage: **61–74% (40–49 of 66)**.

## 9. Category C bugs (MVP)

Grouped by root cause. "Primary" counts rows where the cause is the main blocker.
"Any" counts every row the cause affects.

| # | Root cause | Primary | Any | Repos (primary) | Subsystem | Size |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | Env binding gap: the app reads its own DB/Redis/S3 names or an engine selector (`DB_CLIENT`, `SQLALCHEMY_DATABASE_URI`, `*_DATABASE_*`, `SPRING_DATASOURCE_*`, `GF_DATABASE_*`, `MB_DB_*`, `BACKEND_CACHE_REDIS_URI`, `S3_ATTACHMENTS_BUCKET`). The app silently runs SQLite or local disk, or crashes. | 10 | 21 | listmonk, papermark, directus, ihatemoney, memos, docuseal, joplin, logto, casdoor, teable | planner/spec + env model | M |
| C2 | Wrong auto-detected health path: a feature route (`/csv/status`, `/v1/integrations/status`, `/upgrade_to_enterprise/status`), a missed global prefix or URI version, or another mode's route. | 9 | 12 | kutt, miniflux, ghostfolio, healthchecks, infisical, grafana, tolgee, vikunja, kratos | analysis-detector | S–M |
| C3 | False rejection: dev, optional or same-image Compose services counted as app services. | 7 | 7 | flagsmith, cal.diy, huginn, chatwoot, mattermost, windmill, BookStack | gate | M |
| C4 | False rejection: a Compose volume or Dockerfile `VOLUME` from a non-selected, dev or docs file, or one with an S3 option, read as durable local storage. | 6 | 7 | automatisch, wiki.js, CTFd, wallabag, tandoor, homarr | gate | S–M |
| C5 | Wrong Dockerfile or port: a dev/base image ranked first, a symlinked Dockerfile, or an all-in-one `EXPOSE` lost to the backend `ENV PORT`. | 5 | 5 | monica, n8n, hoppscotch, vaultwarden, wger | analysis-detector | M |
| C6 | Wrong migration command: a non-deploy script (`create`, `make`, `push`, copy step, test), a devDependency CLI missing in the runtime image, or a workspace-relative command. | 4 | 9 | unleash, zipline, rallly, docmost | analysis-detector | S |
| C7 | False rejection: a sample Helm chart or Terraform/k8s descriptor in a non-runtime directory. | 2 | 2 | nocodb, twenty | gate | S |
| C8 | Wrong or duplicate worker: a dev script (`nodemon`), or a worker the CMD already runs. | 1 | 3 | linkwarden | analysis-detector | S |

Friction issues. These are not blocking, but they hurt launch quality:

- **F1 Required-env over-claiming.** 52 repositories ask for required customer keys (median 4, maximum 41: Dockerfile `ARG`, `NEXT_PUBLIC_*`, test vars, guarded reads). Effort: M.
- **F2 Redis over-provisioning.** 22 false positives against 20 truly required repositories, each about $12+/month. Effort: S.
- **F3 MySQL never selected.** 0 of 100, although CTFd, BookStack, monica and firefly-iii take a MySQL path. PHP and Python sources are not fetched. Effort: S–M.
- **F4 Required values missed.** Directus, outline, kratos and others need `PUBLIC_URL`-style values that Deployz does not surface. A vendor who knows the app can add them.

## 10. Phase 6 capability gaps (Category D)

| Capability | Repos | Target | Repos (target marked *) |
| --- | --- | --- | --- |
| 6C EFS / persistent disk | 15 | 6 | verdaccio, mealie*, paperless-ngx, django-helpdesk*, answer*, firefly-iii, kanboard*, halo*, OrchardCore, grist-core*, gitea, karakeep, changedetection.io, nextcloud, thelounge |
| 6A/6B extra services or multiple images | 10 | 6 | ToolJet*, postiz (Temporal)*, formbricks*, typebot*, lemmy, hedgedoc*, nango*, openstatus, mastodon, penpot |
| Larger size profile (not on the 6A–6H list) | 4 | 3 | superset*, metabase*, keycloak*, Stirling-PDF |
| 6F DocumentDB (MongoDB) | 2 | 1 | LibreChat*, wekan |
| ClickHouse | 1 | 0 | plausible |
| RDS MariaDB | 1 | 0 | uptime-kuma |
| Custom PostgreSQL extension (pg_search) | 1 | 1 | lobehub* |
| Durable Redis datastore | 1 | 0 | emailengine |
| 6D Lambda, 6E DynamoDB, 6G OpenSearch (sole blocker), 6H CloudFront | 0 | 0 | none |

Category E (11): immich, homepage, authelia, coder, livebook, zulip, kafdrop,
argo-cd, microservices-demo, azure-search-openai-demo, vllm.

## 11. Capability leverage ranking

Ranked by repos unlocked ÷ effort ÷ architectural risk.

"Incremental" counts the repos where the item is the primary blocker.
The full C set is needed to reach the post-C total.

| Rank | Capability | Affected (any) | Incremental coverage | Complexity | Regression risk | MVP or Phase 6 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | C1 binding mechanism: vendor maps managed values to app env names; engine selector as config; block "SQLite fallback with selector unset" | 21 | +10 (+15 pt target) | M | Low (additive env) | MVP |
| 2 | C2 health-path precision: strong evidence only, prefix/version aware, else Needs input | 12 | +9 (+14 pt) | S–M | Low | MVP |
| 3 | C6 migration-command safety | 9 | +4 (+6 pt) | S | Low | MVP |
| 4 | C7 IaC/Helm sample scoping | 2 | +2 (+3 pt) | S | Low | MVP |
| 5 | C4 local-storage rejection scoping | 7 | +6 (+9 pt) | S–M | Medium (false acceptance) | MVP |
| 6 | C3 Compose service scoping (production compose only; same-image services become workers) | 7 | +7 (+11 pt) | M | Medium (false acceptance) | MVP |
| 7 | C5 Dockerfile/port selection | 5 | +5 (+8 pt) | M | Low–Medium | MVP |
| 8 | C8 worker-command hygiene | 3 | +1 | S | Low | MVP |
| 9 | Larger size profile (1 vCPU / 2 GiB) | 4 (+~10 at risk) | +4 (+5 pt) | S–M | Low–Medium (new infra version, cost) | Post-MVP |
| 10 | 6A/6B extra services + multiple images | 10 | ≤+10 (≈+5 realistic; +9 pt) | L | High (release/rollback surface) | Phase 6 |
| 11 | 6C EFS / persistent disk | 15 | ≤+15 (≈+9 realistic; +9 pt) | L | High (stateful retention, backup, purge) | Phase 6 |
| 12 | 6F DocumentDB | 2 | ≤+2 | L | High (compatibility unknown) | Phase 6 |
| 13 | ClickHouse, MariaDB, PG extensions, durable Redis | 1 each | +1 each | M–L | Medium | Post-MVP |

Leverage clusters:

- **The C1+C2 pair** affects 24 distinct rows. One of the two is the primary blocker in 19 of them.
- **Gate scoping (C3+C4+C7)** turns 15 false rejections into deployable verdicts.
- **6C has the largest Phase 6 count**, but 9 of its 15 repositories are self-hosted tools, not SaaS.
- **6A/6B ties 6C on target repositories (6).**
- **Not observed:** demand for Lambda, DynamoDB, OpenSearch, CloudFront, FIFO, and more workers per app. Queue-like work in the corpus is Redis-backed (BullMQ, Sidekiq, Celery, Oban), not SQS.

## 12. Launch-now vs Phase-6-first comparison

| | Option A — launch MVP first (fix C) | Option B — limited Phase 6 first | Option C — Phase 6 first |
| --- | --- | --- | --- |
| Scope | C1–C8 + F1–F3 | A + size profile + one of 6A/6B or 6C | A + 6A/6B + 6C + 6F + size |
| Target-MVP coverage | 61–74% | 65–88% | up to ~100% (theoretical) |
| All-100 coverage | 45–54% | 54–68% | up to 89% (in-scope) |
| Effort | 8 contained S/M analyser and binding changes | + one L capability | 3–4 L capabilities |
| Regression risk | Low–Medium (gate precision) | High (new stateful or multi-image lifecycle) | Very high |
| Time to market | Shortest | + one L cycle | Multiple L cycles |
| Unsupported-state UX | Clear: named family + evidence today | Same | Same |
| Core value proposition | Intact: web + DB + Redis + worker + S3 is the mainstream SaaS shape | Adds breadth | Adds breadth |

The mainstream small-SaaS shape is already in the platform. Common target
apps are blocked by bugs in how Deployz reads them, not by missing
infrastructure. Phase 6 mostly adds breadth (self-hosted tools,
multi-service products).

## 13. Exact pre-launch recommendations

Do these in order. Each one is an analyser, gate or binding change with
regression tests. None adds infrastructure.

1. **C1 binding mechanism (M).**
   - Let the vendor bind any app env name to a managed value: DB URL/host/port/name/user/password, Redis URL, bucket.
   - Let the vendor set engine-selector constants (`DB_CLIENT=pg`, `DB_TYPE=postgresdb`, `MEMOS_DRIVER=postgres`) as plain config.
   - Block with a Needs-input question when the app has a SQLite/H2 fallback and its selector is unset. A silent fallback loses data.
2. **C2 health path (S–M).**
   - Auto-fill only from a Dockerfile/compose `HEALTHCHECK` or an exact health route, with the global prefix and URI version applied.
   - Never auto-fill a feature route that merely ends in `status` (COMP-039).
   - Otherwise ask.
3. **Gate scoping (C3, C4, C7; S–M).**
   - Read only the production Compose file. Ignore dev, test, docs and example files.
   - Treat same-image services as workers or optional.
   - Take `VOLUME` only from the selected Dockerfile.
   - Let S3-option evidence clear local-storage findings.
   - Report sample Helm/Terraform/k8s descriptors outside runtime paths as a warning, not a rejection.
   - Add false-acceptance regression tests for the 15 correct D/E local-disk and multi-service rejections.
4. **C6 migration command (S).**
   - Reject `create`, `make`, `push`, copy and test scripts.
   - Reject CLIs that are only devDependencies and are missing from the runtime image, and workspace-relative commands.
   - Prefer "startup" mode when the entrypoint already migrates.
5. **C5 Dockerfile and port (M).** Resolve symlinked Dockerfiles. Rank dev and base images last. Prefer an all-in-one `EXPOSE` over a backend `ENV PORT`. Take the port from the final stage.
6. **C8 worker (S).** Do not add a package.json `worker` script that is a dev script, or that the image CMD already runs.
7. **Friction (F1–F3; S–M).**
   - Do not mark Dockerfile `ARG`, `NEXT_PUBLIC_*`, test or guarded reads as required.
   - Provision Valkey only on required evidence.
   - Detect MySQL from PHP and Python manifests and config.
8. **Re-measure.** Bump `ANALYSIS_VERSION` and rerun this 100-repo audit and `unseen2`. Then run the simulated E2E suite. Then run the version canary on 3–5 C repositories (testing strategy escalation order).

Launch gate: target-MVP A+B ≥ 60%, zero silent-SQLite outcomes, and no new
false acceptances on the D/E set.

## 14. Explicit post-launch deferrals

- **Larger size profile (first post-launch item).** It unlocks superset, metabase, keycloak and Stirling-PDF, and de-risks about 10 memory-tight C apps. It needs a new infra version and a cost review.
- **6A/6B extra services and multiple build artifacts** (formbricks, typebot, hedgedoc, nango, ToolJet, postiz).
- **6C EFS / persistent containers** (mealie, answer, kanboard, halo, grist, helpdesk). Stateful lifecycle work.
- **6F DocumentDB** (LibreChat, wekan), ClickHouse, RDS MariaDB, custom PostgreSQL extensions, durable Redis / `noeviction` (DEPLOY-037).
- **No evidence in the sample:** 6D Lambda, 6E DynamoDB, 6G OpenSearch, 6H CloudFront, FIFO queues. Defer with no date.
- **SQS and EventBridge Scheduler stay `PREVIEW`.** The sample shows no detectable demand. Do not expand them before launch.
- **Build-time features:** build targets, build args and pre-Docker build steps (twenty, n8n, keycloak, tandoor, memos). Vendors fix these in their Dockerfile.

## Uncertainty

- **Ground truth.** It is one agent pass per repository, checked against the earlier double-inspected benchmark notes. Low-confidence rows are marked in the table (`conf low`).
- **AI fallback.** It is off in local runs. Production may resolve some open questions (for example, choosing between Dockerfiles). It never overrides deterministic facts, so no C row is expected to change.
- **No real deployment.** Compile success is not runtime success, and memory fit at 512 MiB is not measured.
- **Vendor knowledge.** A vendor who knows their app can override the health path, port and migration command. For real vendors many C rows cost one failed first deploy, not a permanent block. Silent SQLite fallback (C1) stays severe.

---

LAUNCH MVP FIRST

- **Current practical coverage:** 10/100 (A+B). Target-MVP 5/66 (8%).
- **Target-MVP coverage after Category C:** 49/66 (74%); realistic 61–74%.
- **Post-Category-C coverage, all repositories:** 54/100, or 54/89 in scope (61%).
- **Projected coverage after the recommended pre-launch work:** the same as post-C (only C and friction work is recommended). Target 61–74%, all 54%.
- **Top 5 blockers:**
  1. Env binding gaps (21 repos)
  2. False rejections from Compose, VOLUME and IaC scoping (16)
  3. Persistent-disk need, 6C (15; 6 target)
  4. Wrong health path (12)
  5. Extra services, 6A/6B (10; 6 target)
- **Work before launch:** C1 binding mechanism; C2 health-path precision; gate scoping C3/C4/C7; C6 migration safety; C5 Dockerfile/port; C8 worker hygiene; F1–F3 friction; then rerun this audit and the canary.
- **Work deferred:** larger size profile (first), 6A/6B, 6C, 6F, ClickHouse, MariaDB, PG extensions, durable Redis, build-time features. Lambda, DynamoDB, OpenSearch and CloudFront have no evidence.
- **Strongest evidence:**
  - 44 of 66 target repositories (67%) fit the current platform and fail only on Deployz bugs.
  - The best Phase 6 capability adds 6 target repositories at L complexity.
  - All 100 graphs compile, so the infrastructure layer is not the constraint.
