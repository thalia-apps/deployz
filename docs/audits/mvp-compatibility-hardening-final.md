# MVP compatibility hardening: final report

Baseline `e0186004` (main, 2026-10-06) · `ANALYSIS_VERSION` 38 · compiler `dynamic-compiler-v2-3`.
Final `3bc65f9c` (main) · `ANALYSIS_VERSION` 44 · compiler `dynamic-compiler-v2-5`.
Follows the [100-repo MVP capability audit](100-repo-mvp-capability-audit.md).
No Phase 6 capability was added. No new infrastructure was added.

## 1. Verdict

- The local gates pass on the canonical corpus:
  - target-MVP A+B is 65%
  - target understanding is 82%
  - critical false READY is 0
  - unsafe migration auto-selection is 0
  - D/E rejections did not regress
- The unseen holdout does not collapse.
- The two real-AWS canaries ran on production (§9).
  - **Canary A (memos): PASS end to end.**
  - **Canary B (ghostfolio)** passed every step except one. The first
    redeploy found a real health-check grace defect. The redeploy passed
    after the grace was raised to 300 s on the live test deployment. The
    fix is merged (#493).
- The canaries found and fixed two more generic defects (#492, #493). They
  also found two infrastructure defects, tracked as separate tasks (§7).
- **Main CI cannot run at the final SHA.** GitHub Actions refuses every job:
  "recent account payments have failed or your spending limit needs to be
  increased". So the #493 compiler fix is not deployed, and the Canary B
  rerun with the compiled 300 s grace is not done. The launch gate is
  therefore not complete.

## 2. Method

Every number comes from the real production analysis path:

`runApplicationAnalysis` → readiness → `normalizeDeploymentManifest` →
`evaluateManifestReadiness` → production `evaluatePreflight` (no config, then
all required keys supplied) → `manifestToApplicationGraph` →
`planApplicationGraph` → `compileDeployzInfrastructure`.

The input is the pinned snapshots of
`benchmark.yaml` (`docs/testing/repository-compatibility/`, removed 2026-10-18):

- canonical `repo-001`…`repo-100`
- holdout `unseen2` `repo-201`…`repo-220`

Baseline and final ran over the same, complete snapshot cache. The AI
fallback is off.

**Ground truth.** Ten parallel agents wrote one source-verified record per
repository, from repository evidence at the pinned commit. They never used
Deployz output. Each record holds:

- the Dockerfile and port
- the unauthenticated health path
- the migration mode and the safe/unsafe commands
- the database engine and engine selector, and the env names the app reads
- the Redis and S3 need, selectors and names
- workers
- the true D/E family

The canonical records start from the audit table (category, target tag).
The holdout records came from separate agents, and the orchestrator did not
read them before the holdout run.

**Master corrections**, each source-verified (3 of 120 records):

- outline `FILE_STORAGE` already defaults to `s3`, so it is not a selector.
- an automatisch "forbidden worker" pattern matched its real production
  worker.
- n8n's Dockerfile copies a prebuilt `./compiled` directory. The record's
  own note says that no in-repo Dockerfile builds the app.

Expected facts in `benchmark.yaml` were not edited.

**Scoring** is deterministic per fact. Each fact is CORRECT, ASKED (the gate
blocks with a vendor question, or a non-blocking warning for a missing
migration command) or WRONG (a confident wrong value):

- **A**: deployable, all facts correct, READY with no inputs.
- **B**: deployable, no WRONG fact.
- **C**: any WRONG fact, or a false NOT_COMPATIBLE.
- **D/E**: the truth says the app is outside the MVP.

Rules for the critical facts:

- A database binding is satisfied by one bound URL name or by all bound parts.
- A selector is satisfied when it is required, or when it is itself a bound
  URL.
- A binding asked from the vendor counts as WRONG, because the vendor
  cannot know the RDS value. The exception is the
  `database-connection-unverified` question, where the vendor maps the
  variable.
- **Understanding correct** means no WRONG fact, no false rejection and no
  unneeded RDS or Valkey.
- **Critical false READY** means READY with silent data loss, or with a wrong
  health path, port, Dockerfile or migration command, or READY for a D/E app.

## 3. Before / after: canonical 100

Target-MVP (66 repositories):

| Metric | Before | After | Delta |
| --- | --- | --- | --- |
| A+B | 3 (5%) | **43 (65%)** | +40 |
| Category A / B / C / D | 0 / 3 / 46 / 17 | 6 / 37 / 6 / 17 | C −40 |
| Understanding correct | 15 (23%) | **54 (82%)** | +39 |
| Critical false READY | 13 | **0** | −13 |
| False NOT_COMPATIBLE | 15 | 3 | −12 |
| Silent data-loss risk (selector, binding, local disk) | 29 | 3, none READY | −26 |
| Wrong health path | 17 | 0 (20 ask) | −17 |
| Wrong port | 3 | 0 | −3 |
| Wrong Dockerfile | 8 | 0 (3 ask) | −8 |
| Wrong migration command | 13 | 0 | −13 |
| Wrong DB engine / selector / binding | 3 / 15 / 17 | 0 / 1 / 1 | |
| Wrong S3 selector or binding | 8 | 1 | −7 |
| Wrong worker | 2 | 1 | −1 |

All 100 repositories:

| Metric | Before | After |
| --- | --- | --- |
| A+B | 7 | 48 |
| Understanding correct | 39 | 83 |
| Critical false READY (incl. D/E READY) | 15 | 0 |
| D/E not rejected | 11 | 7 (none READY) |
| Unneeded Valkey (Redis false positive) | 15 | 3 |
| Unneeded RDS | 1 | 1 |
| MySQL chosen / truly MySQL | 0 / 2 | 2 / 2 |
| Customer-required keys: median / max / total | 1 / 41 / 431 | 0 / 35 / 280 |

Needs Input rate (target, after): 20 health, 15 selector, 10 migration
warning, 3 Dockerfile, 2 worker and 1 port questions. Every one replaces a
confident wrong value or a silent fallback.

## 4. Unseen holdout (`unseen2`, 20)

| Metric | Before | After | Canonical after |
| --- | --- | --- | --- |
| Target understanding | 8/12 (67%) | **10/12 (83%)** | 82% |
| Target A+B (of deployable target) | 1/5 | 3/5 | 43/49 |
| Critical false READY (all) | 1 | 0 | 0 |
| False NOT_COMPATIBLE (target) | 3 | 1 | 3 |
| Analysis crash | 1 (RSSHub not cached) | 0 | 0 |

The holdout's own truth puts 7 of its 12 target repositories in D, so its
target A+B ceiling is 5/12. Understanding and false-READY match the
canonical corpus. Deployable-target conversion (3/5) is lower than canonical
(43/49) on a small sample. Two generic gaps remain: a hidden `.render/`
Dockerfile outranks `.github/deployment/…`, and an undetected `DB_DIALECT`
selector stays blocked behind a Dockerfile question. Neither was tuned.

One generic bug was fixed from the holdout. A comment-style package.json
key (`"// … migrations:run": ""`) made an empty migration command and crashed
the PostHog analysis.

## 5. Launch gates

| Gate | Result |
| --- | --- |
| Target-MVP A+B ≥ 65% | **PASS**: 43/66 (65.2%) |
| Target understanding ≥ 70% | **PASS**: 54/66 (82%) |
| 0 critical false READY | **PASS**: 0 canonical, 0 holdout |
| 0 silent SQLite/H2/local-storage fallback | **PASS** for READY outcomes. 3 deployable apps keep an undetected app-specific selector, and each is blocked by another vendor question (§8). |
| 0 unsafe migration auto-selection | **PASS**: 0 wrong migration commands, canonical and holdout |
| No regression in true D/E unsupported cases | **PASS**: every D/E app that was NOT_COMPATIBLE still is. 4 more D/E apps now reject for their true reason. |
| Unseen holdout reasonably close | **PASS**: target understanding 83% vs 82%, 0 critical false READY |
| Full CI green | **FAIL**: every PR (#487–#493) was green before merge. Main CI at `3bc65f9c` cannot start because of GitHub Actions billing. |
| Both AWS canaries PASS | **PARTIAL**: Canary A PASS. Canary B PASS except the redeploy step, which passed only with the grace fix applied by hand. The rerun on the compiled fix waits for the deploy (§9). |

## 6. Bugs fixed (generic, with regression tests)

Phase 1, data integrity ([#487](https://github.com/thalia-apps/deployz/pull/487)):

- **Compiler `dynamic-compiler-v2-4`**: every alias binding is in every task
  definition. Before, the migration task and scheduled jobs never got
  aliases, because the relay added them only to services after install.
  The new `jdbc_url` kind was added.
- App-specific binding names: `SQLALCHEMY_DATABASE_URI`, `DSN`, `*_DB_*`,
  `*_POSTGRES_*`, `*_DATASOURCE_URL`, Prisma `env()` names, `*_REDIS_URI`, and
  Rails/Laravel/Spring/`config.yml` config-file reads.
- Engine and storage selectors whose default keeps data on the container
  disk are required. Defaults are read from JS, Python, Ruby, PHP, Go viper,
  Spring, envalid/zod schemas, comparison-only switches, Dockerfile `ENV`,
  NestJS and django-environ.
- Migration safety: these are never auto-selected: create/generate/make,
  push, reset/rollback/seed, test, copy/build/rename, devDependency-only or
  undeclared CLIs, workspace filters, and scripts of another package. More
  startup shapes are recognised.

Phase 2, false rejections ([#488](https://github.com/thalia-apps/deployz/pull/488)):

- Only the production Compose file counts, and same-build or same-image
  services are workers.
- Only the selected Dockerfile's `VOLUME` counts. A SQLite-only volume or an
  S3-capable upload volume is not state.
- Sample Helm/k8s/Terraform/Pulumi files under deployment directories are a
  warning.

Phase 3, runtime precision ([#489](https://github.com/thalia-apps/deployz/pull/489)):

- Health path order: HEALTHCHECK, then a dedicated route with prefix and
  version, then a framework route, then the vendor is asked. There is no
  feature route and no silent `/health`.
- Production Dockerfile ranking and symlink resolution.
- Port from the runtime stage.
- Dev scripts and CMD-run processes are never workers.

Phase 4, configuration friction ([#490](https://github.com/thalia-apps/deployz/pull/490)):

- Valkey only on strong required Redis evidence.
- MySQL detected across PHP, Python, JVM and ORM dialects.
- Fewer false required keys.
- A required public URL is derived as `https://d-<id>.deployz.dev`.

Phase 5, remaining defects ([#491](https://github.com/thalia-apps/deployz/pull/491)):

- `database-connection-unverified` blocks a provisioned database whose
  connection names the app never shows.
- Vendor mapping of any variable to a managed value: database
  URL/parts/JDBC, Redis, bucket. The mapped name reaches the frozen manifest
  and every task definition.
- `dockerfile-missing-sources` blocks a Dockerfile that copies a CI build
  output.
- A workspace-root, build-first or out-of-image start script is not the
  container command.
- In-process startup migrations set mode `startup`.
- PostgreSQL is provisioned next to a SQLite default.
- `DB_*` are standard database bindings.
- A compose volume of a wrapper image is not this image's state.
- Config-class, ini-override and `*_S3_NAME` storage names are read.
- ClickHouse-as-Ecto-repo, a required config-file mount, an image data
  directory and a hard-coded RabbitMQ host now reject.
- A blank script is never a migration candidate.

## 7. Regressions caught during the work

- **vaultwarden** went from B to C (NOT_COMPATIBLE). The symlinked Dockerfile
  now resolves, and it declares `VOLUME /data` (attachments, RSA key). The
  rejection reflects the real image. The truth record (medium confidence)
  says deployable, so it is counted against the score.
- **Phase 2 admitted mattermost, CTFd and tandoor.** For one phase they had a
  wrong health path or engine. Phases 3 and 4 fixed them before release
  tagging.
- **The first selector pass** treated `STORAGE_DRIVER` as a DB selector. Its
  storage check never ran. Fixed.
- **The first missing-sources pass** blocked buildable Dockerfiles. It split
  flagged JSON `COPY` forms and read `/src` absolutely. Fixed before merge,
  with tests.
- **A widened `process.env` presence test** dropped wekan's MongoDB
  rejection. It was reverted.
- **A Spring `spring.datasource` regex** backtracked catastrophically and hung
  analysis on a long `application.yaml`. It was replaced with a linear form.
- **AWS canary findings, fixed:** a subdirectory Dockerfile that copies
  root-only files was built from its own directory (#492). A 60 s web
  health-check grace killed migrate-at-boot apps on 0.25 vCPU (#493).
- **AWS canary findings, filed as separate tasks:**
  - `db.t4g.micro` is no longer orderable in us-east-1 (PostgreSQL 16,
    MySQL 8.0), so every new database install there fails.
  - At first start, ECS ran one task on the template's task definition
    (no vendor configuration) about 6 s before the configured revision.
- **The E2E environment-ownership spec** encoded "Managed by Deployz is
  disabled for vendor keys". That changed by design: any key can map to a
  managed value. The spec was updated.

## 8. Remaining known limitations

- **Category C (6 target):**
  - wiki.js: `VOLUME` for an optional git content path.
  - windmill: an optional `windmill_extra` sidecar image. The `.git` copy
    still blocks it correctly.
  - vaultwarden: `/data`.
  - outline: a Procfile worker that the image CMD already runs.
  - directus: `STORAGE_<NAME>_DRIVER` storage locations.
  - tolgee: an embedded-PostgreSQL autostart flag. It is blocked behind
    `dockerfile-missing-sources`.

  No safe generic rule covers these without false acceptance of true D apps.
- **D/E apps still NEEDS_CONFIGURATION, never READY:** firefly-iii,
  OrchardCore, metabase, keycloak, nango, Stirling-PDF, nextcloud. There is
  no detectable memory floor, and their local state is not visible in the
  fetched files.
- **The guard asks for some apps that read a standard name in an unparsed
  shape**, for example Rust or Elixir config. The vendor maps `DATABASE_URL`
  once.
- **Java/Kotlin source is still not fetched.** Spring config files are.
- **Memory fit at 512 MiB is not measured.**

## 9. AWS canaries

Both canaries ran on production (`api.deployz.dev`, control plane `8539c2f0`,
then `3c927afb`):

- They ran in the Thalia vendor organization. Its GitHub installation reads
  the `instashop-dev` forks.
- The customer side was the test account `151955775369`.
- The dashboard's own API calls were made from the signed-in browser session.
- The bootstrap stacks were created with the AWS CLI from each install link's
  Quick Create parameters. That is what the customer's Quick Create does.
- No analysis override was given. The only vendor input was the answer to the
  question that analysis asked.

**Canary A: memos (repo-039), data and binding, us-east-2: PASS.**

| Step | Result |
| --- | --- |
| Analysis (v43) | Correct with no overrides: Dockerfile `scripts/Dockerfile`, port 5230, `/healthz`, PostgreSQL. The app's own `MEMOS_DSN` is bound as the database URL. |
| Zero silent fallback | Preflight blocked READY on `MEMOS_DRIVER` (engine selector, default SQLite). The vendor set `postgres`. |
| Build | The first build failed: the context was `scripts/`, but the Dockerfile copies root-only `go.mod`. A generic fix (#492, v44) chose the root context. The rebuild was READY. |
| Install | The compiled task definition (revision 1, before any relay change) carries `MEMOS_DSN` as a secret next to `DATABASE_URL`. The app logs `Database driver: postgres`, with the schema from `migration/postgres/LATEST.sql`. HEALTHY, default HTTPS ACTIVE. |
| Write | The first admin was created through the API (11:43:13Z). `GET /api/v1/instance/profile` gives `needsSetup:false`. |
| Restart | The product Restart replaced the task. Admin present, `needsSetup:false`. |
| Redeploy | Release `1.0.2` was deployed (`deploy.completed`). Admin present, `needsSetup:false`. |
| Destroy and purge | Disconnect completed. Purge swept the RDS instance, then the network orphans. See the cleanup line below. |

**Canary B: ghostfolio (repo-007), runtime detection.**

| Step | Result |
| --- | --- |
| Analysis (v43) | Correct with no overrides: health `/api/v1/health` (URI version; before this work it was the wrong `/api/health`), port 3333, migration mode `startup`, PostgreSQL plus required Redis (`REDIS_HOST/PORT`). |
| First install, us-east-1 | Stack rollback: RDS has no `db.t4g.micro` capacity there. AWS offers no orderable `db.t4g.micro` for PostgreSQL 16 or MySQL 8.0 in us-east-1. Other regions offer it. The product reported `FAILED` with the reason. Destroy, purge and bootstrap removal were clean. |
| Install, us-east-2 | Prisma migrations ran at boot against RDS. `/api/v1/health` checks the DB and Redis: 200 `{"status":"OK"}` over HTTPS with a verified certificate. HEALTHY, HTTPS ACTIVE. |
| Restart | The task was replaced. Health 200. |
| Redeploy `1.0.1` | It failed 3 times. The 90 s boot on 0.25 vCPU passed the 60 s grace, so the circuit breaker rolled back. The product showed `deploy.failed`, `UPDATE_AVAILABLE`, and the previous release kept serving. The task definitions differed only in the image digest. With the service grace raised to 300 s (by hand, on the test deployment), the same release rolled out with 0 failed tasks and was promoted. A generic fix (#493, compiler v2-5) gives every web service a 300 s grace. |
| Worker | None needed: ghostfolio runs its Bull jobs in process. Analysis did not invent a worker. |
| Destroy and purge | Disconnect completed. Purge swept the RDS instance, then the network orphans. |

Still to do after GitHub Actions billing is restored:
- main CI at `3bc65f9c`
- the control-plane deploy of compiler v2-5
- a fresh Canary B install (about 60 minutes): install, redeploy, restart,
  destroy and purge, with no manual change

Cleanup and leak audit (2026-10-07):
- All three canary deployments reached `DELETED` with `cleanupState: COMPLETE` (`purge.completed`). The bootstrap stacks were then deleted.
- us-east-1 and us-east-2 have no `deployz-app-*` or bootstrap stacks, RDS instances or snapshots, ElastiCache groups, tagged VPCs, NAT gateways, Elastic IPs, ECS clusters, load balancers, secrets, log groups, ACM certificates or buckets left.
- The VPC counts are back to baseline: 2 in us-east-1, 1 in us-east-2.

## 10. Explicit Phase 6 and post-MVP deferrals

- **6C, EFS / persistent disk:** verdaccio, mealie, paperless, answer,
  kanboard, halo, grist, gitea, changedetection, thelounge, karakeep,
  nextcloud, vaultwarden.
- **6A/6B, extra services and images:** ToolJet, postiz, formbricks, typebot,
  hedgedoc, nango, openstatus, lemmy, mastodon, penpot.
- **Larger size profile:** superset, metabase, keycloak, Stirling-PDF.
- **Other engines and extensions:** DocumentDB, ClickHouse, MariaDB, PostgreSQL
  extensions, durable Redis.
- **Build-time features:** build targets, required build args, pre-Docker
  build steps.
- **No evidence:** Lambda, DynamoDB, OpenSearch, CloudFront.

## 11. Merged pull requests

| PR | Squash SHA |
| --- | --- |
| [#487](https://github.com/thalia-apps/deployz/pull/487) phase 1 | `9503f8fa` |
| [#488](https://github.com/thalia-apps/deployz/pull/488) phase 2 | `ec8875ed` |
| [#489](https://github.com/thalia-apps/deployz/pull/489) phase 3 | `74f7d55d` |
| [#490](https://github.com/thalia-apps/deployz/pull/490) phase 4 | `c6fb1490` |
| [#491](https://github.com/thalia-apps/deployz/pull/491) phase 5 | `8539c2f0` |
| [#492](https://github.com/thalia-apps/deployz/pull/492) root build context (canary A finding) | `3c927afb` |
| [#493](https://github.com/thalia-apps/deployz/pull/493) 300 s web health-check grace (canary B finding) | `3bc65f9c` |

MVP COMPATIBILITY GATE: FAIL
