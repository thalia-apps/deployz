# Deployz MVP test coverage matrix

## 1. Purpose

This matrix is the primary source of truth for Deployz MVP test coverage.
It lists every core capability. It shows the happy path, the failure
paths, the historical regressions, the intended test layers, the current
test coverage, and any missing coverage. Use it to answer two questions:
"is this capability tested?" and "at what layer?"

Update this matrix when you add a capability, close a coverage gap, or
change which layer owns a test. Do not let it go stale. It replaces ad
hoc searches across `e2e/`, `apps/api/src`, `apps/web/test`, and
`packages/*/test` as the way to check coverage before you ship a change.

## 2. How to read this matrix

Each row is one product capability, not one test file. A capability can
span several layers (for example, a unit test for the pure logic and an
E2E scenario for the wiring). The "Current coverage" column lists
concrete file paths, scenario IDs, or canary command names. Every file
path in this matrix exists in the repository at the time of writing. Every
scenario ID exists in `e2e/simulation/scenarios/index.ts`, or is named as
a spec-level `@scenario:` tag composed from a registered scenario (see
[`simulated-e2e.md`](simulated-e2e.md#scenario-selection)).

"Missing coverage" says what is not tested today. It does not say the
capability is broken. It says the matrix found no test for that failure
path or edge case. The coverage-gaps summary (Section 8) turns every
"Missing coverage" cell into a proposed test, ordered by priority.

## 3. Layer legend

Layer definitions match [`strategy.md`](strategy.md#the-layers). Deployz
testing has seven layers, plus two categories that sit outside the layer
ladder.

- **L0 — static.** Build, lint, and typecheck (including the E2E harness
  and the AWS scripts), plus the static production-safety guards and the
  CDK bundling smoke. No running code. Runs on almost every pull request.
- **L1 — unit.** Pure logic with no external system: Vitest tests over
  fakes and in-memory fixtures. Runs on affected packages and their
  dependents.
- **L2 — integration/contract.** A real local dependency, but no network
  call to AWS or GitHub: PGlite-backed API/DB tests, CDK template synthesis,
  and parity tests that check one package's vocabulary against another's.
- **L3 — UI/workflow.** Playwright tests that drive the real web app and
  the real API. Fixture-mode specs replace GitHub, AI, and DNS with
  canned data. Scenario specs additionally replace the AWS SDK client with
  a `SimulatedCustomerAccount` and drive the real relay code over it.
- **L4 — AWS integration (`fresh`).** One real AWS boundary in minutes,
  with no product flow: create and destroy a bootstrap stack only.
- **L5 — AWS E2E (version canary).** A full real lifecycle through the
  deployed control plane, using a Deployz-controlled fixture application.
  Fixture A is the stateless profile (`profile --profile stateless`).
  Fixture B is the Postgres+Redis `core` ladder.
- **L6 — production canary.** The same L5 harness (`profile --profile
  stateless --production`) against the deployed control plane, on a
  schedule, to answer "can production Deployz deploy right now?"
- **compat** — the compatibility tests (the Docker run-and-check test,
  `pnpm runcheck:*`, no AWS; Stage B `benchmark:deploy`, real AWS against
  third-party repos). They measure analyser accuracy, not product
  regressions. They never run on a pull request.
- **manual** — a human follows a written runbook. Today this is
  `docs/testing/manual-checklist.md`.

## 4. Priority legend

- **P0** — the core deployment path, or data safety (a bug here can
  strand or destroy a customer's AWS resources, or make the vendor and
  customer see different truths).
- **P1** — important MVP behaviour. A bug here degrades trust or wastes
  operator time, but does not strand resources or corrupt state.
- **P2** — polish. A bug here is cosmetic, or affects a rarely used path.

---

## 5. Vendor capabilities

| Capability | Happy path | Expected failure paths | Edge cases / historical regressions | Intended layers | Current coverage | Missing coverage | Priority |
|---|---|---|---|---|---|---|---|
| GitHub connection | Vendor authorizes the GitHub App; installation token is vended | Webhook signature invalid; App JWT expired; no installation found | `apps/api/src/github.test.ts` covers webhook signature verification, App JWT, and installation-token vending (93 tests) | L1, L2, L3 | `apps/api/src/github.test.ts`; `apps/web/test/github-state.test.ts`; `apps/web/test/github-setup.test.ts`; `e2e/github.spec.ts` (GITHUB_FIXTURE_MODE) | Mid-session access revocation (installation deselects the repo after analysis started) is not simulated | P1 |
| Repository permissions (GitHub App selected-repo access) | Vendor selects a repo the App has access to | Vendor points at a repo the App cannot see | S4 scope enforcement inside `github.test.ts`; a real-world GitHub App selected-repo access blocker was hit during the 2026-09 regional/pilot campaigns (operational finding, not yet a named COMP/DEPLOY id) | L1, L2 | `apps/api/src/github.test.ts` (S4 scope); `e2e/applications.spec.ts` ("Select repo" path) | No test for the App having access revoked between selection and analysis; no test for a repo outside the installation's selected-repo list at analysis time | P1 |
| Application creation | Vendor creates an application from a connected repo | Duplicate application; cross-org access attempt; delete blocked by live deployments | §42 list/edit/delete/delete-blocked/cross-org isolation | L1, L2, L3 | `e2e/applications.spec.ts` (10 tests) | none known | P1 |
| Repo analysis | Analyser reads the repo and returns a manifest | Unreadable repo; empty repo; analysis timeout | 41 `COMP-nnn` findings track analyser-accuracy regressions; `c9983cd7` (DEPLOY-031, Dockerfile copies `.git`) | L1, compat | `packages/analysis/test/analysis.test.ts` (134 tests); `apps/api/src/analysis.test.ts`; `packages/analysis/test/eval-corpus.test.ts`; the Stage A rule tests `packages/analysis/test/stage-a*.test.ts` (COMP-001..041; the Stage A corpus was removed on 2026-10-18); the Docker run-and-check test (`pnpm runcheck:*`) | 10 COMP findings (COMP-005, 010, 014, 017, 022, 025, 030, 039, 040, 041) were open when the Stage A registry was removed on 2026-10-18 | P1 |
| Framework/runtime detection | Analyser identifies the framework, runtime, and start command | Ambiguous multi-framework repo; unsupported runtime | `94f5a61a` (DEPLOY-032, Go env struct tags rated the app Go, not the JS UI) | L1, compat | `packages/analysis/test/analysis.test.ts`; `packages/analysis/test/application-analysis.test.ts` (`detectRuntime`, `detectBindAddress`) | none known | P1 |
| Database detection | Analyser detects a Postgres dependency and derives `DATABASE_URL` bindings | False-positive DB detection; DB engine gated behind an env value | `e8f0d3a1` (DB_* family becomes postgres binding aliases, DEPLOY-005/013); `b64f52fd` (DEPLOY-026, preset pins its own connection-URL names) | L1, compat | `packages/analysis/test/stage-b-phase2.test.ts`; `packages/analysis/test/analysis.test.ts` | COMP-022 (open): a DB engine selected by an env value is rated READY without the value present; `DEPLOY-022`/COMP-029 (open): a false-positive DB detection provisions a real RDS instance in Stage B | P0 |
| Redis detection | Analyser detects a Redis/BullMQ dependency and marks the Cache component required | Redis-Stack (unsupported) repo; Redis used only in a dev script | `c86643a5` (redis component actually reported); `33bee50b` (Valkey needs a replication group, not a cache cluster) | L1, L3, compat | `packages/analysis/test/redis.test.ts`; `e2e/redis.spec.ts`; scenario `redis-success`; scenario `redis-failure` | Overlap between `redis.test.ts` and inline Redis fixtures in `packages/analysis/test/stage-a.test.ts` not yet de-duplicated (tracked, not urgent) | P1 |
| Worker detection (declared processes → workloads) | A declared run process (Procfile non-web entry, Compose application service, npm-script worker) becomes a `workers[]` entry that provisions its own ECS service | Worker-like code with no declared start command becomes a needs-input question, never a service; dev/test/build utilities never become workloads | Weak evidence (queue libraries only) sets `worker.needsCommand` and never auto-provisions; a worker-bearing Compose service no longer counts as a second application container | L1, L2 | `packages/analysis/test/multi-worker.test.ts`; `packages/analysis/test/manifest.test.ts`; `apps/api/src/analysis.test.ts`; scenario `multi-worker-sweep` | none known | P0 |
| MySQL detection (engine selection) | A MySQL driver plus an independent signal (Prisma mysql provider, `mysql://` URL, `MYSQL_*` variable, Compose image, Laravel default) marks the manifest database engine `mysql` | A MariaDB-only driver stays a rejection; a MySQL driver next to a PostgreSQL driver is a configurable engine, not a requirement | A bare MySQL driver deploys without a database and raises the binding question instead | L1, L2 | `packages/analysis/test/mysql-database.test.ts`; `packages/analysis/test/manifest.test.ts`; `packages/contracts/src/footprint.test.ts` | none known | P0 |
| Storage detection | Analyser detects an S3/object-storage dependency | False-positive storage requirement | none named in the history mining | L1, L2 | `packages/contracts/src/aws-resources.test.ts`; `packages/analysis/test/stage-b-phase2.test.ts` (S3 binding derivation) | No application-level proof that a provisioned bucket is reachable end to end; `packages/fixture` has no S3 client, so neither the L5 canary nor any scenario exercises S3 at the application layer | P1 |
| Environment-variable discovery | Analyser lists required and optional env vars from source | Env var read through a helper/schema library is missed | 5 commits in the "Env vars" class, e.g. `2148e057` (directus shape), `b54481b5` (viper shape), `9ddd10e5` (module env object) | L1, compat | `packages/analysis/test/phase7.test.ts` (§11.2 env-var model, 43 tests); `packages/analysis/test/env-classification.test.ts` | COMP-017 (open): env reads through helper functions/schema libraries | P1 |
| Requirement validation | Preflight computes READY/ALMOST_READY/NOT_READY from the manifest | Manifest fails validation; preflight called before analysis finishes | `518ee409` (CANARY-004, generic retry message swallowed a real 422); `fa0b55d2` (red-team audit follow-ups) | L1, L2, L3 | `apps/api/src/preflight.test.ts`; `packages/analysis/test/readiness-report.test.ts`; `e2e/readiness.spec.ts`; `e2e/create-deployment.spec.ts` | none known | P0 |
| Unsupported/missing requirements (rejection + fix instructions) | A NOT_READY finding produces AI fix instructions the vendor can act on | Fix instructions requested before analysis; AI gateway timeout | `945ea6fe` (rebuilt fix-instructions prompt for coding agents); `cf835bfc` (cache fix instructions per commit/version/finding set) | L1, L3 | `apps/api/src/fix-instructions.test.ts`; `packages/analysis/test/fix-instructions.test.ts`; `e2e/fix-instructions.spec.ts`; `e2e/scenario-matrix.spec.ts` (gaps D/E) | none known | P1 |
| Configuration | Vendor sets default config values and required secrets | Secret value re-rendered instead of masked; customer override ignored | `8b3dc5ec`/`bf9530ea` (DEPLOY-030, provider-shaped values never auto-mintable) | L1, L3 | `apps/api/src/config.test.ts`; `apps/web/test/config.test.ts` (`mergeConfig`); `e2e/config.spec.ts` (secret-masking boundary) | none known | P0 |
| Secrets (entry, masking, KMS, pending delivery) | A vendor-entered secret is KMS-encrypted, held pending relay enrollment, then delivered | KMS key disabled/denied; relay never enrolls; duplicate confirmation; browser closed mid-flow | 9 commits in the "Secrets/KMS" class: `dd39e0a0`/`c78d66be`/`ac892aa9` (KMS fix phases 1-3); `f4ecd39e` (DEPLOY-010, CONFIG_UPDATE finds the secret by construct-id prefix); `a9aec36c` (DEPLOY-013, an app-internal secret's value never reaches the customer account); `56342f7e` (DEPLOY-012, the relay may read/write the config secret); `de36e466` (never mint a shared secret; redact the diagnostics technical detail); `349f6953` (DZ-AUDIT-012/013, secrets transport and relay enrollment binding); `cacd0f7b` (tag-based retained-secret discovery) | L1, L2 | `apps/api/src/pending-secrets.test.ts`; `apps/api/src/pending-secret-delivery.integration.test.ts` (8 named threat-model cases); `packages/cdk/test/deployz-stack.test.ts` (config-secret KMS key); `packages/cdk/test/worker-config-secrets.test.ts` | No test exercises real `@aws-sdk/client-kms` error shapes (`AccessDeniedException`, `DisabledException`, `KeyUnavailableException`) — every KMS test uses a hand-rolled fake client; no simulated-E2E scenario touches KMS/secret encryption at all | P0 |
| Reanalysis | Vendor re-triggers analysis; existing fix instructions are recomputed, not just kept | Re-analysis on an unchanged commit | `e2e/fix-instructions.spec.ts` header: "generating fix instructions never itself resolves the finding; re-analysis recomputes the same result" | L1, L3 | `apps/api/src/analysis.test.ts`; `e2e/fix-instructions.spec.ts` | none known | P2 |
| Commit selection | Vendor picks a commit for a release | Commit SHA unreachable; branch has no commits | none named in the history mining | L1 | `apps/web/test/commit-picker.test.tsx` (client control only) | No server-route test validates an invalid/unreachable commit SHA is rejected before a release is created | P2 |
| Release creation | Vendor creates a release from a commit; it builds to READY | Create a release with no repo access; duplicate version | `0507a0e1` (refuse installs without a built release) | L1, L3 | `apps/web/test/releases.test.ts`; `apps/web/test/releases-page.test.tsx`; `e2e/seed-ready-manifest.ts` (`BUILD_FIXTURE_MODE`) | none known | P1 |
| Build (CodeBuild) | Release triggers the real build pipeline and produces an ECR image | Build fails; source-fetch fails | none in the simulated suite (by design — CodeBuild is a real-AWS-only step) | L1, L5 | `packages/cdk/test/pipeline.test.ts` (`BuildPipeline`, source-fetch); `packages/cdk/test/worker.test.ts` (`resolveBuildContext`); version canary `core` step 3 (`buildRelease`) | No L2/L3 coverage of the build pipeline exists by design (`BUILD_FIXTURE_MODE` bypasses it); the real pipeline is exercised only by the AWS canary and Stage B | P1 |
| Build failures (incl. Docker Hub rate limit) | A build failure is classified and shown to the vendor with a clear reason | Docker Hub 429 rate limit; CodeBuild timeout; deleted base image | `6a379f16` (authenticate Docker Hub pulls, stop blaming repos for 429); `ad4d99dc` (fixture pulls from ECR Public mirror) | L1, L3 | `apps/api/src/release-build-failure.test.ts`; `apps/api/src/failure-classification.test.ts`; `apps/api/src/failure-context.test.ts`; `e2e/scenario-release-unavailable.spec.ts` (deleted image, 409) | No scenario or fixture models a registry pull rate-limit failure — only a deleted-image case exists | P1 |
| Customer install link (public link, invitation, deploy link) | Vendor generates a public install link or a Deploy Link; customer launches it | Link resolved after revoke; double-launch race; repeated launch of a Deploy Link | `05d5fd64` (deploy-links lifecycle/authorization hardening); `e4f0e6d0` (install-link double-launch race) | L1, L3 | `apps/api/src/deploy-links.test.ts`; `apps/api/src/public-install.test.ts`; `apps/api/src/installation-invitations.test.ts`; `e2e/install.spec.ts`; `e2e/scenario-deploy-link.spec.ts` (generate/resolve/launch/invalid/revoked/repeated) | none known | P0 |

---

## 6. Customer capabilities

| Capability | Happy path | Expected failure paths | Edge cases / historical regressions | Intended layers | Current coverage | Missing coverage | Priority |
|---|---|---|---|---|---|---|---|
| Install link (resolve/expired/revoked) | Customer opens a valid link and sees the trust page | Expired link; revoked link; malformed token | covered by the Deploy Link edge cases above | L1, L3 | `apps/web/test/deploy-link-flow.test.ts` (resolve-reason mapping); `e2e/install.spec.ts`; `e2e/scenario-deploy-link.spec.ts` | none known | P0 |
| Customer creation/selection | Vendor creates or selects a customer for a deployment | Duplicate customer on retry; cross-org customer selection | `abef9768`-era customer-reset work; duplicate-customer-on-retry is one of the 12 failure modes in the manual runbook (§6) | L1, L3 | `apps/api/src/customers.test.ts`; `apps/web/test/customer-list.test.ts`; `apps/web/test/create-deployment-page.test.tsx`; `e2e/customers.spec.ts`; `e2e/create-deployment.spec.ts` | none known at the automated layer (duplicate-customer-on-retry is a manual-runbook check only) | P1 |
| Infrastructure plan | The install plan lists the AWS resources that will be created | Plan requested before analysis; plan drifts from the actual deployed resources | none named in the history mining | L1, L2 | `packages/contracts/src/plan.test.ts` (`buildInstallPlan`/`buildDestroyPlan`/`buildUpdatePlan`); `apps/web/test/install-plan.test.ts` | Plan-vs-actual-inventory cross-check is proven only at L5/manual (version canary, Stage B, the manual runbook §9) — no simulated-E2E assertion that the plan matches the `SimulatedCustomerAccount`'s outputs | P1 |
| Infrastructure profile (size registry, footprint/cost) | Customer sees a footprint/cost estimate matching the chosen size profile | Size profile the compiler does not implement | none named in the history mining | L1, L2 | `packages/contracts/src/profile.test.ts`; `packages/contracts/src/footprint.test.ts`; `packages/contracts/src/pricing.test.ts`; `packages/infrastructure-compiler/src/compile.test.ts` (sizing drives the compiled resources); `apps/web/test/footprint-components.test.tsx` | none known | P2 |
| Size selection (vendor default and minimum, link recommendation, customer choice, plan fingerprint) | The customer installs the size it approved; a link keeps its frozen recommendation | Size below the minimum, stale or tampered plan, legacy deployment or link without sizing | none named in the history mining | L1, L2, L5 | `apps/api/src/public-install.test.ts`; `apps/api/src/deployment-size.ts` callers in `server.test.ts` and `billing-checkout.test.ts`; `apps/web/test/public-install-page.test.tsx`; `apps/web/test/deployment-configuration.test.tsx`; `e2e/deployment-size.spec.ts`; AWS: `e2e:canary:versions profile --size …`, `journey` | none known | P1 |
| Resource selection | Customer sees required vs. optional AWS resources before install | A component required by the manifest is missing from the resource list | none named in the history mining | L1, L2 | `packages/contracts/src/components.test.ts`; `packages/contracts/src/infrastructure.test.ts`; `apps/web/test/infrastructure-section.test.ts` | none known | P2 |
| Vendor blocker disputes | The vendor marks an allowlisted blocker as "not used in production"; the forced re-analysis drops it and the deployment installs | A finding outside the allowlist (422); evidence that changed (409); a running analysis (409); another organization (404) | An answer whose evidence changed stays as stale and does not apply; an AI re-run keeps the vendor answer | L1, L2, L3 | `packages/analysis/test/vendor-disputes.test.ts`; `apps/api/src/blocker-disputes.test.ts`; `apps/web/test/deployment-configuration.test.tsx` (Vendor blocker disputes); `apps/web/test/application-overview.test.tsx` (dispute hint); scenario `vendor-dispute` | none known | P1 |
| Required vs recommended resources | Required resources block install; recommended resources do not | A recommended resource is wrongly treated as blocking | none named in the history mining | L1, L2 | `packages/contracts/src/aws-resources.test.ts`; `apps/web/test/readiness.test.ts` (§19) | none known | P2 |
| Region selection (incl. region asset/template availability) | Customer picks a supported region; the right template/Lambda assets exist there | Region with no published template; cross-region Lambda asset redirect | `76fc24ed` (CANARY-001, per-region bucket subset); `a53c68a7` (per-region bootstrap publish, cross-region PermanentRedirect); `cf2edce7` (DZ-AUDIT-005/008/015, region contract) | L1, L2 | `apps/web/test/regions.test.ts`; `packages/cdk/test/quick-create.test.ts` (CFN template limits, per-region orchestration) | Region-asset mismatch has no simulated-E2E analog by architecture decision (real-AWS finding, e.g. single-region Lambda assets blocking `us-west-1`); only `fresh`/manual catch a live regression | P1 |
| AWS connection (Quick Create, bootstrap template) | Customer clicks Deploy to AWS; CloudFormation Quick Create opens with parameters filled | Quick Create URL exceeds CFN limits; template not yet published for the region | `7c74519c` (published template carries no preset health check); `dddbe8b6` (stateless variant, no DB wiring) | L1, L2, L3, L4, L5 | `packages/cdk/test/quick-create.test.ts` (62 tests); `packages/cdk/test/bootstrap-stack.test.ts`; `e2e/install.spec.ts`; `e2e/scenario-install.spec.ts`; `pnpm e2e:fresh`; version canary `core` install step | none known | P0 |
| Bootstrap (stack + relay enrollment) | Bootstrap stack creates the relay Lambda, IAM role, and credential secret; relay registers | Bootstrap stack fails before relay ever registers | `52d823ca` (bootstrap must `Ref` the relay credential secret, not `GetAtt Arn`); `55b1db5a` (relay credential stored as JSON); `fce69874`/`ea41e3d6` (IAM traps) | L1, L2, L4, L3 | `packages/cdk/test/bootstrap-stack.test.ts` (1113 LOC/49 tests); `packages/cdk/test/artifacts.test.ts`; `packages/cdk/test/zip.test.ts`; scenario `bootstrap-failure`; `pnpm e2e:fresh` | none known | P0 |
| Relay (registration, polling, pending marker/SSM 4 KB, auth) | Relay registers, polls on a one-minute schedule (one invocation at a time, under an SSM lease), and executes commands | SSM parameter exceeds 4 KB; pending marker not decrypted; relay auth token rotated | `d4fbeee6` (CANARY-005, SSM 4 KB limit); `4fff11be` (CANARY-011, SecureString pending marker decrypt) | L1, L3 | `packages/relay/src/auth.test.ts`; `packages/relay/src/pending.test.ts`; `packages/relay/src/poll.test.ts`; `packages/relay/src/identity.test.ts`; scenario `relay-disconnect` | none known | P0 |
| Stack creation (INSTALL) | The application CloudFormation stack creates cleanly and the relay reports HEALTHY | VPC/RDS/ECS `CREATE_FAILED`; stack rolls back; stack terminates with no rollback | `1f85974d` (DEPLOY-001, install runs the release image); `0b7ba7e2` (per-deployment templates, no `Fn::Export`) | L1, L2, L3, L4, L5 | `packages/relay/src/install.test.ts` (959 LOC/46 tests); `packages/infrastructure-compiler/src/compile.test.ts`; `e2e/scenario-install.spec.ts`; scenarios `happy-path`, `cloudformation-rollback`, `ecs-failure`, `healthcheck-failure`, `stateless` | none known | P0 |
| Database (RDS, DATABASE_URL, CA bundle) | RDS provisions; the app receives a working `DATABASE_URL` with the CA bundle installed | RDS `CREATE_FAILED`; app connects without the CA bundle and TLS verification fails | `67e3da21` (DEPLOY-007, RDS CA bundle delivered into the task); `e8f0d3a1` (DEPLOY-005/013) | L1, L2, L3, L5 | `packages/infrastructure-compiler/src/compile.test.ts` (RDS CA bundle cases); scenario `database-failure`; canary `profile pg` | none known | P0 |
| MySQL database (RDS MySQL 8.0) | The resolver maps `relational_database` + engine `mysql` to `aws.rds-mysql`; the app receives `DATABASE_URL` (`mysql://`), `MYSQL_URL` and `DB_*` bindings; disconnect retains, purge deletes | RDS MySQL `CREATE_FAILED`; MariaDB-only driver rejected at analysis | PostgreSQL manifests compile byte-identical output; the CA bundle environment is shared by every workload | L1, L2, L3 | `packages/analysis/test/mysql-database.test.ts`; `packages/infrastructure-compiler/src/compile.test.ts` (MySQL engine); `packages/contracts/src/footprint.test.ts`; scenario `mysql-sweep` | No real-AWS qualification of an RDS MySQL install/teardown yet (recorded as pending in `aws-e2e.md`) | P0 |
| Background workers (one ECS service per workload) | Every declared worker provisions as its own private Fargate service with its own frozen command, log group and security group; one build artifact is shared | A worker service fails to stabilize (verification fails while the web service stays healthy); a numbered worker field is never accepted | Workers have no ALB target and no HTTP health check — verification is service stability; the web desired count comes from the profile, workers run one task each | L1, L2, L3 | `packages/infrastructure-compiler/src/compile.test.ts` (multi-workload composition, stable identity); `packages/relay/src/deploy.test.ts`; `packages/relay/src/ecs-health.test.ts`; `apps/api/src/deployment-status.test.ts`; `apps/web/test/install-plan.test.ts`; scenarios `multi-worker-sweep`, `phase4-composition` (web, workers, MySQL, Redis and the migration composed across the full chain) | No real-AWS qualification of a multi-service stack yet (recorded as pending in `aws-e2e.md`) | P0 |
| Migrations (one-shot migration task) | The migration task (family `DeployzAppMigration<suffix>`, unique to the installation, command baked in at compile time) runs once after the database is ready — RunTask runs the exact revision the relay registered — then the services roll | Migration exits non-zero → `MIGRATION_FAILED` with family/exit/stopped-reason, no service update, the deployment returns to `UPDATE_AVAILABLE`; the verdict reads the application container by name from the revision that ran (the RDS CA init container's exit 0, in either order, never passes; a missing container or exit code never succeeds; a failed AWS read defers); a payload with a command string is rejected | A SUCCEEDED deploy carrying the migration identity confirms it — retries skip the run; ROLLBACK/RESTART never run migrations; on an existing deployment a vendor correction (new identity, also for the same image) or "No separate migration" is snapshotted on the queued job and keyed into its idempotency; the relay copies the stack's own revision of the family, changes only the application container's command and image, and runs the exact revision ARN; a correction for a deployment without a migration workload is refused `MIGRATION_WORKLOAD_MISSING`; analysis turns an incompatible or uncertain runner into the blocking `migration-command-needs-input` question instead of adding `npx` | L1, L2, L3 | `packages/contracts/src/deployment-spec-v2.test.ts`; `packages/infrastructure-compiler/src/compile.test.ts` (migration task); `packages/relay/src/deploy.test.ts` (incl. `migration correction`); `apps/api/src/deploy-contract.test.ts` (incl. `migration policy snapshot`); `apps/api/src/analysis.test.ts` (runner needs input); `packages/analysis/test/migration-runner.test.ts`; `apps/web/test/migration-edit-dialog.test.tsx`; `apps/web/test/rollback-migration-warning.test.ts`; scenarios `migration-success`, `migration-failure`, `migration-correction` | No real-AWS qualification of a real one-shot migration run or a migration correction yet (recorded as pending in `aws-e2e.md`) | P0 |
| Storage (S3) | S3 bucket provisions and the app's IAM role can read/write it | Bucket policy denies the task role | none named in the history mining | L1, L2, L5 | `packages/contracts/src/aws-resources.test.ts`; `packages/infrastructure-compiler/src/compile.test.ts` (bucket composition) | No scenario or canary fixture exercises S3 at the application layer (the fixture app has no S3 client); IAM-policy correctness is proven only by the compiler tests, never by a live read/write | P1 |
| Queues (SQS Standard, producer/consumer/DLQ detection and provisioning) | A queue with a resolved producer and consumer provisions with a TLS-deny policy, a redrive policy to its DLQ, and least-privilege per-workload IAM statements | Ambiguous or unnamed queue evidence becomes a `questions` entry, never a provisioned queue; a `web`-attributed consume operation is distrusted; Python (boto3) evidence always becomes a question | Two-workload attribution through bounded (depth-4) import reachability; a queue whose producer/consumer id collides with another manifest component becomes a question instead of provisioning | L1, L2, L3 | `packages/analysis/test/async-detection.test.ts`; `packages/analysis/test/async-relationships.test.ts`; `packages/infrastructure-compiler/src/compile.test.ts` (queue + per-workload IAM composition); scenario `phase5-composition` (web producer, worker consumer, DLQ and MySQL across the full chain) | No real-AWS qualification of a provisioned queue/DLQ yet (recorded as pending in `aws-e2e.md`) | P0 |
| Scheduled jobs (EventBridge Scheduler, one-shot ECS task) | A `render.yaml type: cron` service or a Kubernetes `CronJob` provisions its own task definition (no ECS service, family unique to the installation) and an EventBridge Scheduler schedule targeting the latest task-definition revision; the relay copies only the revision its own stack created, and never another installation's revision of a shared (older) family | An invalid cron expression or timezone becomes a `questions` entry; an in-process cron library, a CI-level schedule, Vercel `crons`, and a bare crontab file never provision anything; an id conflict becomes a `questions` entry | A scheduled job sits outside health/readiness semantics — no ECS service, no verification check; the relay registers the release image into the family only after a DEPLOY_RELEASE/ROLLBACK has settled | L1, L2, L3 | scenario `phase5-composition` (schedule, family registration on release and rollback, a failed job leaves health unchanged, destroy with a running job task); `packages/analysis/test/async-detection.test.ts`; `packages/infrastructure-compiler/src/schedule-expression.test.ts`; `packages/infrastructure-compiler/src/compile.test.ts` (scheduled-job task + schedule composition); `packages/cdk/test/bootstrap-stack.test.ts` (scoped SQS/Scheduler bootstrap permissions); `packages/relay/src/deploy.test.ts` (`registerReleaseImageIntoFamily`, scheduled-job family sequencing); `packages/relay/src/destroy.test.ts` (standalone-task stop before cluster delete); `packages/relay/src/verify.test.ts` | No real-AWS qualification of a scheduled job run yet (recorded as pending in `aws-e2e.md`); the revisionless family-targeting behavior (latest task-definition revision picked up after a release) is unconfirmed on real AWS | P0 |
| Redis (Valkey replication group) | ElastiCache/Valkey replication group provisions; the app connects | ElastiCache `CREATE_FAILED`; a cache-cluster template variant is used instead of a replication group | `33bee50b` (Valkey needs a replication group, not a cache cluster); `c86643a5`; `efe00c42` | L1, L2, L3, L5 | `packages/infrastructure-compiler/src/compile.test.ts` (cache composition); the version canary's `profile --profile redis` (real ElastiCache proof, `aws-e2e.md`); scenario `redis-failure`; scenario `redis-success` | Redis is proven only at the provisioning level; no fixture exercises an actual cache read/write from the application | P1 |
| Application startup (ECS, env/secret injection, migration command) | ECS task starts, receives env/secrets, and runs the migration command before serving | Migration command fails; container starts then exits; migration syntax breaks under the container shell | `ceab3e30` (CANARY-009, migration runs through the container shell); `a05c37e4` (DEPLOY-014); `a8453c9d` (DEPLOY-011, `CONTAINER_START_FAILED`); `adcd2dd1` (CANARY-010, release migration command outranks the manifest) | L1, L2, L3, L5 | `packages/relay/src/deploy.test.ts` (1147 LOC/42 tests); `packages/relay/src/ecs-observe.test.ts`; `packages/infrastructure-compiler/src/compile.test.ts` (container contract); `packages/cdk/test/worker.test.ts` | none known | P0 |
| HTTPS (default d-* domain, ACM, Cloudflare records, custom domain) | Default HTTPS activates automatically; a custom domain can be added, verified, and connected | ACM validation record rejected; Cloudflare DNS write fails; rate limiting; custom-domain precedence over the default domain | 14 commits in the "HTTPS/health" class: `d7eb6ecf` (ACM trailing-dot record), `4412bea3` (tag the relay-created listener so the relay may delete it), `d7de33e0` (retry `DeleteCertificate` while ACM still holds the association), `068ab9a4` (purge reads certificate tags account-wide), `8db16659` (the HTTPS step says it is waiting, not counting time, OBS-C), `7c74519c` (a published template carries no preset health check), `bf9530ea`/`8b3dc5ec` (DEPLOY-030, provider/TLS-shaped values never mintable) | L1, L2, L3, L5 | `apps/api/src/default-https.test.ts`; `apps/api/src/domain-routes.test.ts`; `apps/api/src/domain-validation.test.ts`; `apps/api/src/domain-check.test.ts`; `apps/api/src/cloudflare-records.test.ts`; `e2e/custom-domain.spec.ts`; `e2e/scenario-default-https.spec.ts` (A-I) | Explicit HTTPS-ACTIVE wait/probe exists in Stage B (`describeDependencies`) but not in the base version canary's `core`/`resilience`/`profile` scenarios | P1 |
| Health checks (ALB targets, health path) | ALB reports every target healthy; the health path answers 200 | Every ALB target unhealthy; health path derived incorrectly from a file-based router | `bbfd6e35` (CANARY-003, file-route health paths derived from the router root); `dfba01f7` (DEPLOY-006, generic template relies on ALB health, no in-container curl probe) | L1, L2, L3 | `apps/api/src/health-transitions.test.ts`; `packages/relay/src/ecs-health.test.ts`; `packages/relay/src/http-probe.test.ts`; scenario `healthcheck-failure` | none known | P0 |
| Deployment progress (derived steps, stack events, timing) | The vendor and customer both see a monotonic, honest step ladder while the stack provisions | A step goes backward on a stack rollback; timing derived from a stale snapshot | `fed891dd` (provisioning step ladder stays monotonic); `f1a8c9fa` (truthful mid-install stack status and timing); `d6bbfb5c` (derived step stays truthful during rollback) | L1, L2, L3 | `apps/api/src/deployment-status.test.ts` (1651 LOC/121 tests); `apps/api/src/stack-event-progress.test.ts`; `apps/api/src/step-timings.test.ts`; `packages/relay/src/provision-progress.test.ts`; `e2e/deployment-progress.spec.ts`; `e2e/stack-events.spec.ts`; `e2e/scenario-ui.spec.ts` | none known | P0 |
| Error states (failure classification, diagnostics, AI explanation) | A FAILED deployment shows a plain-English reason, a technical detail, and an AI explanation when confident | Ambiguous failure code; AI explanation gateway unavailable; secret value leaked into a diagnostic | `0a4b3087` (CANARY-006, relay state-persistence failures classified as Deployz-side); `de36e466` (redact the diagnostics technical detail) | L1, L2, L3 | `apps/api/src/failure-classification.test.ts`; `apps/api/src/failure-context.test.ts`; `apps/api/src/failure-evidence.test.ts`; `apps/api/src/ai-explanation.test.ts`; `packages/analysis/test/diagnostic-explainer.test.ts`; `apps/web/test/diagnostic-card.test.tsx`; `apps/web/test/diagnostic-vocabulary.test.ts`; `e2e/diagnostics.spec.ts` | none known | P0 |

---

## 7. Operations / lifecycle capabilities

| Capability | Happy path | Expected failure paths | Edge cases / historical regressions | Intended layers | Current coverage | Missing coverage | Priority |
|---|---|---|---|---|---|---|---|
| Retry (retry-install, recovery arc, DELETE_FAILED cleanup) | Admin retries a failed install; the deployment reaches HEALTHY | Retry on a deployment that is not eligible; `DELETE_FAILED` stack blocks a retry | admin diagnose-and-retry is asserted in `e2e/admin.spec.ts` against scenario `cloudformation-rollback` | L1, L2, L3 | `apps/api/src/retry-eligibility.test.ts`; `packages/relay/src/recover.test.ts` (`recoverFailedInstallStack`, `clearDeleteBlockersAndRetryDelete`); `apps/api/src/admin/admin-actions.test.ts`; `e2e/scenario-recovery.spec.ts` (`retry-install-recovery`, `install-link-retry`); `e2e/admin.spec.ts` | The `/retry-install` admin HTTP route has only narrow depth beyond the pure `retryEligibilityFor` unit test — no route-level test covers the full eligibility matrix | P1 |
| Diagnostics | Deployment diagnostics show the classified failure and evidence | No failure exists yet (empty state) | covered under Error states above | L1, L2, L3 | `e2e/diagnostics.spec.ts` (3 tests: classification + no-issues path) | none known | P1 |
| Redeploy/update (DEPLOY_RELEASE, circuit breaker, rollback) | A new release deploys via ECS `UpdateService`; a bad rollout rolls back automatically | ECS deployment circuit breaker trips; rollback itself fails; a same-digest rollback is wrongly treated as success | `4de29dd1` (DEPLOY-015, circuit-breaker rollback onto a same-digest revision is a failure); `8ef97916` (a release is deployable again once its previous attempt settled); `7b93e3c7` (CANARY-008, failed update never fails a deployment with a running install) | L1, L2, L3, L5 | `packages/relay/src/deploy.test.ts`; `packages/relay/src/config-update.test.ts`; `packages/contracts/src/plan.test.ts` (`buildUpdatePlan`); `e2e/scenario-lifecycle.spec.ts` (`update-failure`, `rollback-success`, `rollback-failure`, `two-apps-1.0.0`); version canary `core` steps 8-13 (build v2, deploy, rollback, re-deploy idempotency, bad-health deploy) | none known | P0 |
| Deployment status consistency (vendor vs customer projections) | The vendor detail page and the customer/public-install page always agree on stage, health, and terminal state | A field disagrees between `toVendorDeploymentStatus` and `toCustomerDeploymentStatus`; the client-side vendor and customer state matrices diverge | 15 commits in the "Vendor/customer state mismatch" class, e.g. `df121f78` (read stack status/checks from the real relay result nesting), `f1a8c9fa`/`d6bbfb5c` (truthful step timing and status during a rollback), `5d99c3ec` (plain-English relay report, truthful secure-endpoint status), `d83cc0d2` (truthful, race-safe lifecycle state, DZ-AUDIT-006/007/011/024/032), `3b62f888` (truthful vendor UX, DZ-AUDIT-019/020/035), `e4f0e6d0` (install-link double-launch race), `85657649`/`dd52bbee`/`bd070bef` (a removed/retained deployment is never rendered as live or gone) | L1, L2, L3 | `apps/api/src/deployment-status.test.ts` (`scenario %i: customer and vendor agree on every field they share` — a full-matrix cross-check across every scenario in the file's own matrix, not just `.stage`); `apps/web/test/application-state.test.ts` (client vendor matrix, 74 tests, no cross-check); `e2e/deployment-progress.spec.ts` (projection-consistency invariant across the public install page, vendor detail page, and raw `/status` API) | No `apps/web` test yet renders both the vendor detail view and the public-install/customer view from the same underlying status object client-side — the server-side full-matrix check above closes only that half | P0 |
| Destroy | Customer or relay deletes the application stack cleanly | Stack-level `DELETE_FAILED` with no attributable blocker | `dd52bbee` (a retained-on-failure resource is not reported as removed); `85657649` (a removed deployment is not rendered as live, OBS-G/F) | L1, L2, L3 | `packages/relay/src/destroy.test.ts`; `packages/contracts/src/plan.test.ts` (`buildDestroyPlan`); scenario `delete-failure`; scenario `retained-resources` | none known | P0 |
| Retained resources (RDS/S3/secrets retained, purge sweeps network orphans) | RDS/S3/secrets retained by `DeletionPolicy` after DESTROY; PURGE later sweeps the network orphans a retained DB leaves behind | Purge cannot reach an orphan; retained-state check disagrees with the real AWS tags | `76eb6c66` (CANARY-015, purge sweeps network orphans); `5547b1c2` (retained-state check by secret kind); `9e4fbd4b` (retained-state verification + plan-vs-inventory gates); `7cfbb0b2` (allow 80 minutes for a Disconnect that retains the database) | L1, L2, L3, L5 | `packages/relay/src/purge.test.ts` (1599 LOC/51 tests); `packages/relay/src/recover.test.ts`; `packages/relay/src/stack-resources.test.ts`; `packages/infrastructure-compiler/src/safety.test.ts`; scenario `retained-delete-recovery` (`e2e/simulation/scenarios/retained-delete-recovery.ts`, driven from `e2e/scenario-lifecycle.spec.ts` — proves DESTROY retains and PURGE removes, including every owned application secret); scenario `retained-resources`; scenario `purge-failure` (`e2e/simulation/scenarios/purge-failure.ts`, driven from `e2e/scenario-lifecycle.spec.ts` — gives the orphan-ownership client one leftover resource instead of the always-empty, always-succeeding list); version canary `teardown.ts` (`destroyThroughProduct`, `leakAudit`) | none known | P0 |
| Dead relay handling (disconnect, force-complete, relay silence) | A silent relay never marks the job FAILED merely because it stopped reporting; force-complete is available after any Disconnect | Relay silent for 11+ minutes mid-deploy; force-complete requested before Disconnect | 7 commits in the "Dead relay" class: `8651eab3` (CANARY-013, Purge available after any Disconnect); `0bc8ff42` (resilience scenario: duplicate requests, busy refusals, relay interruption); `0a4b3087`/`85a6740c` (CANARY-006, relay state-persistence failures classified as Deployz-side); `6e28e797` (mirror the force-complete threshold locally); `e3e9574c` (nudge the relay while a teardown waits for its next poll) | L1, L2, L3, L5 | `apps/api/src/disconnect-force-complete.test.ts`; scenario `relay-disconnect`; `e2e/scenario-resilience.spec.ts` (`relay-death-destroy`, `force-complete-repeated-failures` tags); `e2e/scenario-recovery.spec.ts` (`stale-install-resurrect` tag); version canary `resilience` Phase 10 (11-minute EventBridge rule disable) | none known | P0 |
| AWS disconnect | Customer disconnects; the deployment enters a disconnected, still-retained state | Disconnect requested while a job is active | covered by Dead relay and Retained resources above | L1, L2, L3, L5 | `apps/api/src/disconnect-force-complete.test.ts`; `packages/relay/src/purge.test.ts`; version canary `teardown.ts` Disconnect step | none known | P0 |
| Post-disconnect cleanup (purge, connector stack ownership) | Purge deletes the application stack, sweeps orphans, and leaves the bootstrap/connector stack for the customer to delete | Purge deletes the connector stack it does not own; purge runs while a delete is still pending | `67e93b1a` (CANARY-014, the connector stack is the customer's to delete, purge stops pretending); `624eb1b8` (cleanup lineage DZ-AUDIT-009/010/014/018) | L1, L3, L5 | `packages/relay/src/purge.test.ts`; `e2e/scenario-default-https.spec.ts` (destroy/purge cleanup tests); `e2e/scenario-sweep.spec.ts`; version canary `removeCanaryLeftovers` (BUG-003 guard: never delete the connector before a completed application-stack DELETE) | none known | P0 |
| Orphan cleanup (leak audit, test-account janitor) | A finished run's leak audit finds zero orphaned tagged resources | A crashed run leaves resources with no recorded run ID to clean up against | orphaned RDS automated snapshots and `/aws/lambda/deployz-bootstrap-...` log groups were previously found only by a human during a real cleanup session, per the committed `customer-cleanup-protected.json` evidence | L1, L5, manual | `packages/relay/src/purge.test.ts` (orphan sweep, CANARY-015 network-orphan sweep); version canary `teardown.ts` `auditLeaks`/`leakAudit`; `cleanup --run-id <id>` / `audit --run-id <id>`; manual full-product-canary ledger diff (§5) | No scheduled, account-wide, cross-region sweep exists independent of a known run ID; `customer-reset`'s own orphan sweep covers only RDS/ElastiCache/S3, never ECR image tags or CloudWatch log groups | P1 |
| Configuration update settlement (CONFIG_UPDATE) | A configuration change succeeds only after every changed service completed its rollout (task count, COMPLETED, healthy targets); the target revision and deployment id resume from the relay marker | Circuit-breaker rollback → `ECS_DEPLOYMENT_FAILED`, the previous revision keeps serving, lifecycle and release pointers stay, the failure is surfaced and the error says secrets were not restored; a crash loop of the new revision fails | A secret-only change forces fresh tasks; zero-task delivery before the first start succeeds at once; a re-offered command only waits; service mutations never overlap (claim guard, CONFIG_UPDATE held during INSTALL, relay hands back later mutations) | L1, L2, L3 | `packages/relay/src/config-update.test.ts`; `packages/relay/src/poll.test.ts`; `apps/api/src/failure-semantics.test.ts` (`service mutations never overlap`); `apps/api/src/config.test.ts` (queue-less fan-out); scenario `config-update-failure` | No real-AWS qualification of a configuration rollout or rollback yet (recorded as pending in `aws-e2e.md`; deferred by instruction for this change) | P0 |
| Watchdog/reconciliation (stuck jobs, failed-update semantics, one-active-job) | The worker Lambda reconciles a stuck job and a failed update never fails a deployment with a running install | Two jobs race for the same deployment; a config update runs outside the one-active-job guard when it should not | `7b93e3c7` (CANARY-008); `6fcbb277` (CONFIG_UPDATE kept outside the one-active-job guard); `3315c541` (tolerate an older API during mixed-version rollouts) | L1, L2 | `packages/cdk/test/worker.test.ts` (1771 LOC/61 tests, largest file in the package); `apps/api/src/failure-semantics.test.ts` | Deliberately excluded from simulated E2E by design — `e2e/scenario-resilience.spec.ts`'s own header states the watchdog sweep is proven against PGlite in `worker.test.ts`, not booted in the simulator | P0 |
| Team Admin support actions | Team Admin searches, views a vendor's data, and takes a safe recovery action, with an audit trail | Non-admin attempts an admin route; support session outlives its window | admin console is documented as authoritative in `docs/admin/team-admin.md` | L1, L2, L3 | `apps/api/src/admin/admin-actions.test.ts`; `apps/api/src/admin/support-session.test.ts`; `apps/api/src/admin/admin-search-audit.test.ts`; `apps/api/src/admin/admin-overview-vendors.test.ts`; `apps/api/src/admin/admin-deployments-jobs.test.ts`; `apps/api/src/admin/pilot-insights.test.ts`; `e2e/admin.spec.ts` (7 tests: authz, global search/360°, View-as-Vendor, diagnose+retry, allowance+audit log) | none known | P1 |
| Billing entitlement gate (brief) | A PRODUCTION deployment is gated by the org's billing entitlement; Paddle events keep the subscription state in sync | Webhook replay; entitlement check during a Paddle outage; included-deployments allowance exceeded | Paddle migration is documented per-file across `billing-*.test.ts` | L1, L2, L3 | `apps/api/src/billing-entitlements.test.ts`; `apps/api/src/billing-lifecycle.test.ts`; `apps/api/src/billing-matrix.test.ts`; `apps/api/src/billing-webhooks.test.ts`; `apps/api/src/billing-reconcile.test.ts`; `packages/cdk/test/worker-billing.test.ts`; `apps/api/src/admin/admin-billing.test.ts`; `e2e/billing.spec.ts` | none known | P2 |

---

## 8. Coverage gaps summary

This section lists every "Missing coverage" cell above as one proposed
fix. Each line names a proposed layer and a one-line proposed test. The
list is ordered by priority, P0 first.

### P0

1. **~~Vendor/customer deployment-status consistency.~~ Landed (server
   side).** `apps/api/src/deployment-status.test.ts` now cross-checks every
   shared field, not only `.stage`, across every scenario in the file's own
   matrix (see the capability row above).
   Proposed layer: L1 (done); L2/web (open).
   Remaining proposed test: one `apps/web` test that renders both the
   vendor detail view and the public-install/customer view from the same
   underlying status object and asserts they tell a consistent story.

2. **~~Simulated PURGE failure path.~~ Landed.** `e2e/simulation/relay-harness.ts`
   used to give PURGE an always-empty, always-succeeding orphan-ownership
   list; the `purge-failure` scenario
   (`e2e/simulation/scenarios/purge-failure.ts`, driven from
   `e2e/scenario-lifecycle.spec.ts`) now gives it one leftover resource and
   asserts the deployment surfaces it instead of reporting a clean purge
   (see the Retained resources row above). No further action needed.

3. **KMS real-SDK error-shape drift.** Every KMS test uses a hand-rolled
   fake `@aws-sdk/client-kms` client.
   Proposed layer: L2.
   Proposed test: add a targeted integration test that feeds
   `AccessDeniedException`, `DisabledException`, and `KeyUnavailableException`
   error shapes (matching the real SDK's error class names and fields)
   through `pending-secrets.ts`'s cipher creation path, asserting each
   fails closed with the correct diagnostic.

4. **S3 application-level binding proof.** No test proves a provisioned
   bucket is reachable from the running application.
   Proposed layer: L5 (Fixture B).
   Proposed test: add an S3 upload/download endpoint to `packages/fixture`.
   Exercise it from the version canary's storage-bearing profile so a real
   IAM/bucket regression is caught end to end, not only at CDK-synth level.

5. **Database detection false positives that provision real RDS.**
   `COMP-022` (open) and `DEPLOY-022`/`COMP-029` (open) describe a
   falsely-detected database provisioning a real, costly RDS instance in
   Stage B.
   Proposed layer: compat (a run-and-check fixture) plus L1.
   Proposed test: add the specific repo shape from `DEPLOY-022`/`COMP-029`
   as a fixture of the Docker run-and-check test, and add a
   `packages/analysis` unit case asserting an env-gated DB engine choice
   is not rated READY without the value present (closes `COMP-022`
   directly).

6. **Watchdog/reconciliation stays L1-only by design.** This is a
   deliberate architecture decision, not an oversight — recorded here so
   it is not mistaken for an accidental gap. No action needed unless the
   decision changes.

### P1

7. **`/retry-install` admin route depth.** Only the pure
   `retryEligibilityFor` unit and `admin-actions.test.ts`'s narrow cases
   exist.
   Proposed layer: L2.
   Proposed test: add route-level cases to
   `apps/api/src/admin/admin-actions.test.ts` covering the full retry
   eligibility matrix (not-yet-failed, already-retrying, blocked by a
   `DELETE_FAILED` stack, exhausted retries).

8. **Region-asset mismatch has no simulated-E2E analog.** This is an
   accepted architecture decision (no CFN-timeline analog exists), but the
   real-AWS layer that does cover it (`fresh`) only runs on demand.
   Proposed layer: L4.
   Proposed test: add a `--region` option to `pnpm e2e:fresh` so an
   operator can target a non-default region after a bootstrap/Lambda-asset
   change, and run it as a periodic (not per-PR) check.

9. **HTTPS-ACTIVE explicit assertion missing from the base version
   canary.** Stage B has this; `core`/`resilience`/`profile` do not.
   Proposed layer: L5.
   Proposed test: port Stage B's `describeDependencies` HTTPS-ACTIVE wait
   into `scripts/version-canary/steps.ts`, reused by `core`/`resilience`/
   `profile`.

10. **CFN failed-event capture is missing from all real-AWS harnesses.**
    Proposed layer: L5.
    Proposed test: add a `DescribeStackEvents` capture (filtered to
    `*_FAILED`) into `scripts/version-canary/evidence.ts`'s step details,
    triggered only on a failing step, reused automatically by Stage B.

11. **No account-wide, cross-region, run-ID-independent orphan sweep.**
    Proposed layer: L6 / new scheduled tooling.
    Proposed test/tool: a scheduled job that cross-references every
    Deployz-tagged resource against the DB's live deployments and
    installations, across all supported regions, report-only.

12. **`customer-reset` has no AWS account-id guard.**
    Proposed layer: tooling (unit-testable).
    Proposed test: add an `identity.account === EXPECTED` assertion at
    the top of `runCleanup`/`runInventory` in
    `scripts/customer-reset/index.ts`, matching the pattern in
    `scripts/version-canary/config.ts`'s `requireRealAwsOptIn`, with a
    unit test asserting it refuses a foreign account.

13. **`customer-reset` has no structured per-run evidence.**
    Proposed layer: tooling.
    Proposed test: add a minimal per-run JSON log (attempted/succeeded/
    failed per deployment), modelled on `scripts/version-canary/evidence.ts`'s
    `Evidence` class.

14. **Build pipeline (CodeBuild) has no L2/L3 coverage.** This is
    intentional (`BUILD_FIXTURE_MODE` bypasses it), but leaves a layer gap
    between unit tests and the real-AWS canary.
    Proposed layer: L2.
    Proposed test: add a `packages/cdk/test/worker.test.ts` case that
    simulates a CodeBuild-reported failure event flowing through job
    status derivation, distinct from the already-covered pure
    classification unit tests.

15. **~~23 "Targeted-only" Playwright specs never run automatically on
    push/critical/targeted-web.~~ Resolved.** The CI classifier redesign
    (see [`ci.md`](ci.md)) replaced the old exact-spec-file mapping with
    a fixture-mode Playwright suite (`node scripts/e2e.mjs --grep-invert
    "@scenario|visual"`) that runs every non-scenario, non-visual spec for
    any targeted change to runtime UI/API code, and the full suite for
    every critical pull request and every push to `main`. No further
    action needed.

16. **~~`e2e.yml` (the only automated runner of those 23 specs) has no
    schedule trigger.~~ Resolved.** `.github/workflows/e2e.yml`
    (`workflow_dispatch` only) is deleted: the fixture-mode and full
    Playwright suites now run through `ci.yml` on every push to `main` and
    on `ci.yml`'s own `workflow_dispatch`, which needs no separate schedule.

17. **Redis and S3 are proven only at the provisioning level, never at
    the application level.**
    Proposed layer: L5 (Fixture B, deferred).
    Proposed test: when Fixture B is built, add a cache read/write
    endpoint alongside the S3 endpoint from item 4, exercised by the
    `redis` canary profile.

23. **Phase 4 real-AWS qualification is pending (recorded, not run).**
    Multiple workers, RDS MySQL and one-shot migrations are proven in
    simulation and unit/contract tests only; no real-AWS run has
    exercised these shapes.
    Proposed layer: L5.
    Proposed test: run the recorded qualification backlog from
    [`aws-e2e.md`](aws-e2e.md) — web + two workers + PostgreSQL/Redis;
    web + worker + MySQL; a successful migration; a failed migration;
    a migration correction on an existing deployment; the combined Phase 4
    topology — as targeted canary profiles before the Phase 4 shapes face
    real installs.

24. **Phase 5 real-AWS qualification is pending (recorded, not run).**
    SQS queues, EventBridge Scheduler schedules and scheduled ECS jobs are
    proven in simulation and unit/contract tests only; no real-AWS run has
    exercised these shapes, including the revisionless family-targeting
    behavior a scheduled job depends on.
    Proposed layer: L5.
    Proposed test: run the two recorded shapes from
    [`aws-e2e.md`](aws-e2e.md) — web → SQS (+ DLQ) → separate ECS worker →
    MySQL, and Scheduler → scheduled ECS task → MySQL/S3 — as targeted
    canary profiles before the Phase 5 shapes face real installs.

### P2

18. **GitHub App access revoked mid-session.**
    Proposed layer: L1.
    Proposed test: add a case to `apps/api/src/github.test.ts` where the
    installation's selected-repo list changes between analysis start and
    analysis completion, asserting a clear failure instead of a silent
    success on stale access.

19. **Commit-selection server-side validation.**
    Proposed layer: L1/L2.
    Proposed test: add a case (to `apps/api/src/analysis.test.ts` or a
    new small file) asserting an invalid or unreachable commit SHA is
    rejected before a release is created.

20. **`docs/ui-system.md` documented a non-existent `pnpm test:e2e`
    script for `visual.spec.ts`.**
    Status: **fixed** in this pass — corrected to `pnpm e2e
    e2e/visual.spec.ts`, with a note that the snapshots are Windows-only.

21. **~~`jev-eval`/`jev-shadow` is orphaned tooling~~ Resolved.** `pnpm
    jev:eval` and its evaluation corpus were removed on 2026-10-18 (see
    "Jev shadow analysis" in [`compatibility.md`](compatibility.md)). This is
    not a test-coverage gap.

22. **~~Stage B B1 `runtime-reuse` class is dead code.~~ Resolved.** The
    `--runtime-reuse` CLI path and `assertRuntimeReuseSupported()` are
    removed from `scripts/repository-deployment`; `DEPLOY-017` stays the
    historical record. See [`compatibility.md`](compatibility.md).

---

Keep this matrix current:

- When you add a capability, add one row to the matching section.
- When you close a "Missing coverage" cell, update that cell and remove
  the matching item from Section 8, or mark it done.
- When a test file is renamed, moved, or deleted, update every row that
  cites it.
- Do not let this file describe a test, scenario, or command that no
  longer exists. If you are unsure whether a citation is still accurate,
  verify it before you trust it.
