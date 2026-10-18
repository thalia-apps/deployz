# Simulated E2E

The default E2E layer (L3 in [`strategy.md`](strategy.md#the-layers)):
Playwright drives the real Next.js app and the real Fastify API; a
simulated customer AWS account answers the relay's
CloudFormation/ECS/ELB calls. No AWS credentials are used or required. See
[`test-matrix.md`](test-matrix.md) for which capability each scenario
proves, [`ci.md`](ci.md) for what CI runs, and
[`aws-e2e.md`](aws-e2e.md) for the real-AWS layers this suite escalates to.

## What is real, what is simulated

```
Browser (Playwright / Chromium)
   │
   ▼
Web (Next.js — apps/web)
   │  HTTP
   ▼
API (Fastify control plane — apps/api)
   │            ▲
   │ jobs        │ reads/writes
   ▼            │
Deployment engine (deployment_jobs, deployment-status.ts,          DB
step-timings.ts, stack-event-progress.ts)  ◀───────────────────────┘
   │  relay HTTP protocol
   │  (register → commands → progress/result → health)
   ▼
Infrastructure interface (packages/relay's own client seams —
CloudFormationReader, StackInstaller, StackEventsReader, StackDeleter,
EcsDeployClient, EcsServiceReader, TargetHealthReader, PendingStore, ...)
   │
   └──▶ Simulated AWS (e2e/simulation/simulated-account.ts — `pnpm e2e`)
```

Everything above the infrastructure interface — API routes, the DB,
stack-event ingest, status derivation, step timings, resource-inventory
persistence, both UIs — is production code, unchanged between this suite
and a real-AWS run. Only the AWS SDK calls are replaced.

## The simulation seam

Design decisions frozen on 2026-09-01, recorded here so they are not
re-litigated:

- **D1 — the seam is the relay's existing client interfaces.** The relay
  (`packages/relay`) is the only code that ever touches a customer's AWS
  account, and every relay module already defines a narrow client interface
  (`CloudFormationReader`, `EcsDeployClient`, `TargetHealthReader`, ...) with
  a `toX(sdkClient)` adapter kept separate from a `createRealX()`
  SDK-constructing wrapper. This suite runs the **real relay code** —
  `pollOnce`, the real install/deploy/rollback/destroy executors, real
  `verifyInstallation`, real `provision-progress`, the real stack-events
  collector — in the Playwright test process, speaking the real relay HTTP
  protocol to the real local API. Only the AWS *client* objects are replaced
  by an in-memory `SimulatedCustomerAccount`
  (`e2e/simulation/simulated-account.ts`).
- **D2 — the simulator is test-only, not a product mode.** It lives entirely
  under `e2e/simulation/`. Nothing ships in any production bundle, and the
  API exposes **no scenario-control endpoint** — scenario selection happens
  only inside the Playwright test process, via a fixture. This makes
  "production cannot expose scenario controls" true by construction rather
  than by policy. `scripts/production-safety.test.mjs` (`pnpm test:static`)
  enforces both halves of this: no product code imports from `e2e/`, and no
  file under `e2e/simulation/` has a value import from `@aws-sdk/*`.
- **D3 — mode selection and the real-AWS guard.** `DEPLOYZ_E2E_MODE` is set
  by the cross-platform runner `scripts/e2e.mjs`; every real-AWS mode
  refuses to run without `DEPLOYZ_E2E_ALLOW_REAL_AWS=1`, before anything is
  spawned; simulated mode launches the API with a scrubbed environment so
  locally present AWS credentials cannot leak real behaviour into a default
  run.
- **D4 — scenario format.** Typed fixtures describe a CloudFormation event
  timeline with a real reveal offset (milliseconds, for test speed) and a
  virtual timestamp offset (minutes, for what `Timestamp` fields report), so
  ETA and step-timing logic sees realistic durations while tests stay fast;
  ECS/ELB/target-health answers are scenario-controlled too.
- **D5 — real-AWS modes wrap existing machinery, not a parallel harness.**
  `fresh` (L4) wraps `packages/cdk/test/fresh-e2e.live.test.ts` — a real-AWS
  Vitest suite — behind the opt-in guard, a per-run unique stack name, and
  tag-based isolation. The version canary (L5/L6,
  `scripts/version-canary`) is a separate `tsx` harness that drives the
  deployed control plane directly through the same routes a vendor and a
  customer use, reusing the relay's own verification ladder rather than a
  vitest live-test file. Both share the same account guard and tagging
  conventions — see [`aws-e2e.md`](aws-e2e.md).
- **D6 — non-goals.** No record/replay, no LocalStack, no full AWS API
  emulation: the simulated account implements only the calls the relay
  makes, returning AWS-shaped structures.

## Fixture modes

`playwright.config.ts`'s `webServer` sets these for every simulated run:

| Variable | Values | Purpose |
| --- | --- | --- |
| `DEPLOYZ_E2E_MODE` | `simulated` (default) | Selects simulated mode; set by `scripts/e2e.mjs`, and read directly by `playwright.config.ts` as a second guard layer if Playwright is invoked without the runner. Other values select a real-AWS mode — see [`aws-e2e.md`](aws-e2e.md). |
| `DEPLOYZ_E2E_SCENARIO` | a scenario id | Set by the runner when `--scenario=<id>` is passed. Informational only — actual scenario selection is the Playwright `test.use({ deployzScenario })` fixture value / `--grep` filter, not this variable. |
| `GITHUB_FIXTURE_MODE` | `true` | GitHub routes serve a fixture org/repo set instead of calling GitHub. |
| `AI_FIXTURE_MODE` | `true` | A canned AI gateway response set, for deterministic fix-instructions generation. |
| `BUILD_FIXTURE_MODE` | `true` | A new release is marked built (READY, fixture digest) immediately instead of enqueuing `BUILD_RELEASE` (which no-ops locally anyway). |
| `DOMAIN_FIXTURE_MODE` | `true` | DNS/HTTPS domain checks pass only for `*.deployz-fixture.test` hostnames, with no throttle. |
| `TEAM_ADMIN_EMAILS` | `*@admin-e2e.deployz.test` | Team Admin env-grant allowlist (`docs/admin/team-admin.md`). Lets `e2e/admin.spec.ts` mint an admin account by signing up with a matching email — no DB seeding needed. |
| `BILLING_FIXTURE_MODE` | `true` | Canned billing states for the billing UI scenarios. |
| `DEPLOYZ_DEFAULT_HTTPS_FIXTURE` | `true` | Turns on the fixture default-HTTPS machine (fake Cloudflare and probe). Off by default; required for `e2e/scenario-default-https.spec.ts`, which skips without it. |
| `WEB_PORT`, `API_PORT` | port numbers | Override the default 3000/3001 so a run does not reuse another worktree's dev servers. |
| Scrub list | — | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_PROFILE`, `AWS_DEFAULT_PROFILE`, `JOB_QUEUE_URL`, `EMAIL_FROM`, `AWS_SES_ACCESS_KEY_ID`, `AWS_SES_SECRET_ACCESS_KEY` — removed from the API's environment before it boots (`scripts/e2e-env.mjs`'s `scrubEnv`), so credentials or config present in a developer's shell can't leak real AWS/email behaviour into a default run. |

`scripts/production-safety.test.mjs` also asserts none of these
fixture-mode variables (plus `DEPLOYZ_E2E_MODE`/`DEPLOYZ_E2E_SCENARIO`)
appear in any `env:` block or `run:` body of `deploy-api.yml`,
`deploy-web.yml` or `release.yml`. The API deploy job's `env:` block becomes
the deployed Lambda's entire environment, and the web deploy writes the
container's environment and its client build args inside `run:` bodies, so a
leaked fixture-mode variable would ship live.

## The runner CLI

```bash
# Fixture-mode suite — every non-scenario, non-visual spec.
node scripts/e2e.mjs --grep-invert "@scenario|visual"

# The full simulated suite (every e2e/*.spec.ts file, including scenarios).
pnpm e2e

# Only the tests tagged for one scenario.
pnpm e2e --scenario=happy-path

# Every @scenario-tagged test — the full simulated regression suite.
pnpm e2e:scenarios
# equivalent: node scripts/e2e.mjs --scenarios

# A single spec file.
pnpm e2e e2e/admin.spec.ts

# The default-HTTPS suite (needs the fixture machine on).
DEPLOYZ_DEFAULT_HTTPS_FIXTURE=true pnpm e2e e2e/scenario-default-https.spec.ts
```

On Windows PowerShell, set an env var first rather than inline:

```powershell
$env:DEPLOYZ_DEFAULT_HTTPS_FIXTURE = 'true'
pnpm e2e e2e/scenario-default-https.spec.ts
```

Every `pnpm e2e*` invocation also accepts `--dry-run`, which prints the
resolved command/env as JSON instead of running it, and forwards any other
flag straight to Playwright — for example
`node scripts/e2e.mjs --grep-invert "@scenario|visual"` (what the
fixture-mode CI step runs) or `pnpm e2e -- --workers=1` for local
debugging.

### Scenario selection

- **Test-side**: `test.use({ deployzScenario: 'happy-path' })` inside a
  `test.describe` block (see any file under `e2e/scenario-*.spec.ts`) — an
  option fixture defined in `e2e/simulation/fixtures.ts`, defaulting to
  `happy-path`.
- **CLI-side**: `--scenario=<id>` on `pnpm e2e`, which the runner translates
  into a Playwright `--grep "@scenario:<id>\b"` filter against test titles
  (every scenario test's title carries an `@scenario:<id>` tag).

## Fixture suite vs. scenario specs vs. default-HTTPS

Three overlapping slices of `e2e/*.spec.ts`, run differently in CI (see
[`ci.md`](ci.md)) because of what each needs:

- **Fixture-mode suite** (`--grep-invert "@scenario|visual"`) — every spec
  whose tests carry neither an `@scenario:` tag nor are
  `e2e/visual.spec.ts`. Covers sign-up, GitHub connection, applications,
  releases, config, billing, Team Admin, and the deployment-detail
  component spec — the vendor/customer workflow surface that does not need
  a simulated AWS timeline.
- **Scenario specs** (`e2e/scenario-*.spec.ts`) — every test tagged
  `@scenario:<id>`, selected with `--scenario=<id>` or `--scenarios`. These
  drive the relay through a simulated CloudFormation/ECS/ELB timeline.
- **Default-HTTPS scenarios** (`e2e/scenario-default-https.spec.ts`) — a
  scenario spec like the others, but its tests skip unless
  `DEPLOYZ_DEFAULT_HTTPS_FIXTURE=true` is set for the API under test. CI
  therefore runs it as its own step with the flag on, separate from the
  ordinary `--scenarios` run.

## Scenario catalogue

Twenty-eight scenario definitions are registered in
`e2e/simulation/scenarios/index.ts`; the table below has more rows because
several ids (`duplicate-request`, `relay-death-destroy`, `deploy-link`,
`release-unavailable`, `two-apps-1.0.0`, `retry-install-recovery`,
`install-link-retry`, `force-complete-repeated-failures`, the
`default-https-*` set) are spec-level `@scenario:` tags that compose
registered definitions or use the default-HTTPS fixture harness
(`DEPLOYZ_DEFAULT_HTTPS_FIXTURE=true`) rather than adding registry entries.
`--scenario=<id>` matches the tag as a word prefix, so `deploy-link` also
selects `deploy-link-invalid`. Every terminal-status column below is the
**honest, observed** production behaviour (verified against the actual
spec assertions and, where noted, against production logic itself) — not the
behaviour a naive reading of the scenario name would suggest.

"Main UI expectation" describes what the vendor/customer surfaces would show,
based on the same `deploymentStatus`/`healthStatus` fields these tests assert
over the HTTP API (`apps/web/src/lib/deployment-vocabulary.ts` is the single
source of the UI's wording for these). The API scenario specs drive the real
HTTP API; `e2e/scenario-ui.spec.ts` additionally drives four of them through a
real browser.

| Scenario id | Simulates | Terminal status | Main UI expectation | Main backend expectation | Test file |
| --- | --- | --- | --- | --- | --- |
| `happy-path` | Full successful install: network, database, storage, ALB/target-group, ECS service all `CREATE_COMPLETE`; ECS reports every target healthy | `state: HEALTHY`, `healthStatus: HEALTHY`; `deploymentStatus.stage: VERIFYING`, `step: TLS` (holds here — the default fixture suite runs HTTP-only installs with no default-HTTPS opt-in, so the ladder never reaches READY over plain HTTP) | "Waiting for secure domain setup" | Stack events persisted for every resource; resource inventory `technicalResourceCount > 0`; `stepTimings` populated | `e2e/scenario-install.spec.ts` |
| `cloudformation-rollback` | RDS `CREATE_FAILED` (AZ/instance-class mismatch) mid-install; stack rolls back to `ROLLBACK_COMPLETE` | `state: FAILED`; `failure.code: STACK_CREATE_FAILED`, `failure.awsStatus: ROLLBACK_COMPLETE` | "Failed" | Persisted `CREATE_FAILED` event on `ApplicationDatabase` with the AZ-mismatch reason | `e2e/scenario-install.spec.ts` |
| `ecs-failure` | Infra completes fine; `AWS::ECS::Service` `CREATE_FAILED` ("Service failed health checks"); stack rolls back | `state: FAILED`; `failure.code: STACK_CREATE_FAILED`, `failure.awsStatus: ROLLBACK_COMPLETE` | "Failed" | `WebService` event carries the health-check reason; `ApplicationDatabase` shows `CREATE_COMPLETE` (failure is application-specific, not infra-wide) | `e2e/scenario-install.spec.ts` |
| `healthcheck-failure` | Stack reaches `CREATE_COMPLETE` and `verifyInstallation` passes, but every ALB target is unhealthy | `state: INSTALLING` (INSTALL success never marks HEALTHY; only verified runtime health does), `healthStatus: UNHEALTHY`; `deploymentStatus.stage: VERIFYING`, `step: HEALTH_CHECK`, `failure: null` — the install succeeded; runtime health is a separate, honestly-UNHEALTHY signal | "Running health checks" — never Failed, never Ready | No `CREATE_FAILED` events; resource inventory populated | `e2e/scenario-install.spec.ts` |
| `slow-provision` | RDS stays `CREATE_IN_PROGRESS` for ~15 virtual minutes (past `DATABASE_STORAGE`'s 720s typical max) before the rest of the stack completes | Mid-flight: `stage: PROVISIONING`, `step: DATABASE_STORAGE`, `takingLongerThanUsual: true`; terminal: `state: HEALTHY`, `takingLongerThanUsual: false` | An ETA/"taking longer than usual" flag during the database step, Healthy once settled | `typicalDurationSeconds: { min: 180, max: 720 }` present for the active step | `e2e/scenario-provisioning.spec.ts` |
| `cloudformation-failure` | `AWS::EC2::VPC` `CREATE_FAILED`; the stack terminates directly at `CREATE_FAILED` — **no rollback at all** | `state: FAILED`; `failure.code: STACK_CREATE_FAILED`, `failure.awsStatus: CREATE_FAILED` (distinct from the rollback scenarios above) | "Failed" | `ApplicationVpc` `CREATE_FAILED` event; no `ROLLBACK_*` events anywhere in the persisted log | `e2e/scenario-provisioning.spec.ts` |
| `database-failure` | RDS `CREATE_FAILED` on a generic (non-AZ-capacity) reason; stack rolls back to `ROLLBACK_COMPLETE`; network completed first | `state: FAILED`; `failure.code: DATABASE_CREATE_FAILED`, `failure.awsStatus: ROLLBACK_COMPLETE`, `step: DATABASE_STORAGE` (exactly one failed category) | "Failed" at the database step | `ApplicationDatabase` event reason contains `InvalidParameterCombination` | `e2e/scenario-provisioning.spec.ts` |
| `rds-az-capacity` | RDS `CREATE_FAILED` with `InsufficientDBInstanceCapacity` — the incident that motivated automatic AZ placement; stack rolls back to `ROLLBACK_COMPLETE` | `state: FAILED`; `failure.code: RDS_AZ_CAPACITY` (the specific code wins over the generic `DATABASE_CREATE_FAILED`), `failure.awsStatus: ROLLBACK_COMPLETE` | Capacity-unavailable copy: retry once the rollback finishes, never quota advice | `ApplicationDatabase` event reason contains `InsufficientDBInstanceCapacity` | `e2e/scenario-provisioning.spec.ts` |
| `redis-failure` | Network + database complete; `AWS::ElastiCache::ReplicationGroup` `CREATE_FAILED`; stack rolls back. Uses the real analyser (`deployz-demo/bullmq-worker`) so `redisRequired` comes from production analysis, not a hand-set flag | `state: FAILED`; `failure.code: STACK_CREATE_FAILED`, `failure.awsStatus: ROLLBACK_COMPLETE`, `step: REDIS` | Install page lists a "Cache" component under what will be created; "Failed" at the Redis step | `GET /api/install/:id` `plan.components` contains a `Cache` entry; `ApplicationRedis` event type is `AWS::ElastiCache::ReplicationGroup` | `e2e/scenario-provisioning.spec.ts` |
| `bootstrap-failure` | The customer's bootstrap stack fails before the relay Lambda inside it ever registers — no relay ever starts | `state: WAITING_FOR_RELAY`; `stage: WAITING_FOR_AWS`, `step: AWS_SETUP`, `failure: null` — stable, not a false Failed/stuck state | "Waiting for AWS" | `GET /api/install/:id` reports `waitingForRelay: true`, `relayStuck: false` | `e2e/scenario-provisioning.spec.ts` |
| `relay-disconnect` | The relay registers, reports one early progress batch, then goes silent for the rest of the test (`stopAfterFirstProgress`) | Holds `state: INSTALLING`, `stage: PROVISIONING`, `step: NETWORK` (its last genuinely-known step), `job: { type: INSTALL, status: RUNNING }` — never regresses, never a false terminal state | "Installing" at the network step | Persisted stack-event count stops growing after the first batch | `e2e/scenario-provisioning.spec.ts` |
| `redis-success` | A successful install that also provisions an ElastiCache replication group (`redisRequired: true`) — the happy-path the `redis-failure` scenario inverts | `state: HEALTHY`, `healthStatus: HEALTHY` | Healthy, cache component present | Verify passes with the cache resource; cache row in the resource inventory; `GET /api/install/:id` `plan.components` contains a `Cache` entry; `infra.expectations.missing`/`.unexpected` are empty and the `cache` entry reads `expected: true, present: true` | `e2e/scenario-matrix.spec.ts` |
| `lifecycle-sweep` | One continuous lifecycle over a single deployment: install, then deploy success, deploy failure, rollback, relay reset + re-registration, deploy success, destroy, purge | `state: HEALTHY` through the day-2 chain, then `DELETED` with `cleanupState: COMPLETE` after purge | Vendor drives every day-2 action; disconnect/delete/purge complete | `rollback.completed`, `destroy.completed` and `purge.completed` events; migration stage ran for each DEPLOY_RELEASE and never for the rollback | `e2e/scenario-sweep.spec.ts` |
| `update-failure` | Install reaches HEALTHY; a `v1` release deploys and succeeds; a `v2` release rollout trips the ECS deployment circuit breaker | `state: UPDATE_AVAILABLE` (the deployment stays live — `v1` keeps serving); `failure.code: ECS_DEPLOYMENT_FAILED` surfaced on the live stage; `currentReleaseId` stays `v1` | Fleet shows the deployment live with the failed-update alert, `v1` still current | Event log contains `deploy.failed` | `e2e/scenario-lifecycle.spec.ts` |
| `rollback-success` | Same as `update-failure`, then a rollback to `v1` succeeds | `state: HEALTHY`, `failure: null`; `currentReleaseId` and `previousReleaseId` both `v1` (the honest pointer state — `v2` never advanced anything) | Healthy again after rollback | Event log contains `rollback.completed` | `e2e/scenario-lifecycle.spec.ts` |
| `rollback-failure` | Same as `update-failure`, but the rollback to `v1` also fails | `state: UPDATE_AVAILABLE` (still live — `v1` never stopped serving); `failure.code: ECS_DEPLOYMENT_FAILED`; release pointers unchanged — never a false success | Live with the failure surfaced | Event log contains `rollback.failed`, never `rollback.completed` | `e2e/scenario-lifecycle.spec.ts` |
| `delete-failure` | Install reaches HEALTHY; DESTROY hits a stack-level `DELETE_FAILED` with no attributable resource-level blocker | `state: FAILED` (**never** `DELETED`); `failure.code: STACK_DELETE_FAILED` | Never claims the deployment was removed | Event log contains `destroy.failed`, never `destroy.completed` | `e2e/scenario-lifecycle.spec.ts` |
| `retained-resources` | Install reaches HEALTHY; DESTROY completes cleanly (`DELETE_COMPLETE`) | `state: DELETED` | Infrastructure section shows database/storage as retained, application as removed | `infra.components`: `database`/`storage` status `retained`, `application` status `removed`; `infra.expectations.missing` is empty (a `DELETED` deployment never reads "removed" as "missing"); event log contains `destroy.completed` | `e2e/scenario-lifecycle.spec.ts` |
| `purge-failure` | Same clean destroy as `retained-resources`, then PURGE's orphan sweep finds one tag-owned S3 bucket it cannot delete (`deleteBucket` always fails) | `state: DELETED` (never resurrected); `cleanupState: PURGE_FAILED` (never `COMPLETE`) | Never claims a clean purge — the retained-resources warning stays | `purge.failed` event recorded with the sweep's own error in `payload.error`; no `purge.completed` event; a second `POST /purge` is accepted (202) because `PURGE_FAILED` stays retryable | `e2e/scenario-lifecycle.spec.ts` |
| `duplicate-request` | Two concurrent deploys of the same release race each other; a different release is requested while the first is active | One logical job (both responses name the same `jobId`); the different release gets 409 `DEPLOYMENT_BUSY`; exactly one `deploy.requested`/`deploy.completed` event pair | — | Uses the `happy-path` scenario definition | `e2e/scenario-resilience.spec.ts` |
| `transient-aws` | The first two post-create `DescribeStacks` polls answer as unreadable (throttled/timed out) | Install still reaches `HEALTHY` — the wait loop rides out transient errors within its unreadable-poll budget | Normal install | `transientDescribeFailures` scenario knob | `e2e/scenario-resilience.spec.ts` |
| `relay-death-destroy` | The teardown starts in the account, then the relay invocation dies mid-DESTROY (its poll cycle hangs) | `state` stays `DELETING` — never a false `DELETED` or `FAILED`; no `destroy.completed`/`destroy.failed` event; force-complete is the production escape hatch | Honest "deleting" until the vendor force-completes | `dieDuringDestroy` relay knob over `retained-resources` | `e2e/scenario-resilience.spec.ts` |
| `deploy-link` | The vendor generates a customer Deploy Link; the customer resolves and launches it through the public token-header routes; the `happy-path` install pipeline then runs unchanged | `state: HEALTHY`; customer projection `stage: VERIFYING` (HTTP-only fixture); fleet row `source: deploy_link` | The customer's progress view is the install flow's, entered from the /deploy link | Audit events `deploy_link.created`/`opened`/`launched` on the deployment; a wrong token 404s; a revoked link 410s resolve and launch; repeated launches record exactly one `deploy_link.launched` | `e2e/scenario-deploy-link.spec.ts` |
| `release-unavailable` | A release is listed READY, then its image is deleted from the registry (the BUILD_FIXTURE_MODE registry fixture, `POST /internal/fixture/release-images`) before the vendor presses Deploy | `state: HEALTHY`, `currentReleaseId` unchanged; `POST /api/deployments/:id/deploy` → 409 `RELEASE_UNAVAILABLE`; the release list reads `status: UNAVAILABLE` | The Deploy update dialog shows the plain-English refusal and, after reload, offers no release; the releases page badge reads Unavailable with the reason | No `DEPLOY_RELEASE` job and no `deploy.requested` event; `releases.image_unavailable_at` set (sticky) | `e2e/scenario-release-unavailable.spec.ts` |
| `stateless` | Full successful install without a database: network, storage, ALB/target-group and ECS service all reach `CREATE_COMPLETE`; no RDS instance; verify passes; ECS healthy | `state: HEALTHY`, `healthStatus: HEALTHY` | "Waiting for secure domain setup" | No `ApplicationDatabase` in stack events; inventory has no `database` component; `technicalResourceCount > 0`; `infra.expectations.missing`/`.unexpected` are empty and the `database` entry reads `expected: false, present: false` (a database the manifest never required is not "missing") | `e2e/scenario-install.spec.ts` |
| `two-apps-1.0.0` | Two separate applications both create release `1.0.0`, install to HEALTHY, and their `deploy` for `1.0.0` reports 202 and advances the release pointer (DZ-AUDIT-002 regression) | Both `state: HEALTHY` | Both deployments healthy in the fleet | Both release pointers advance to `1.0.0` and state stays HEALTHY | `e2e/scenario-lifecycle.spec.ts` |
| `retry-install-recovery` | First install fails (cloudformation-rollback); vendor calls `POST /api/deployments/:id/retry-install` from FAILED; the route queues a fresh INSTALL job with recovery metadata | `state: INSTALLING` (the first relay-pickup tick) | "Installing" | Route returns 202 with a `jobId`; `install.retry.requested` event logged; double-click returns the same job id (200) | `e2e/scenario-recovery.spec.ts` |
| `install-link-retry` | Mid-flight install-link retry: a relay started an install (state reaches INSTALLING), the customer calls `POST /api/install/:installLinkId/retry` while the installation is live | `state: NOT_INSTALLED`, a fresh enrollment code is minted; a new relay then installs to HEALTHY | "Not installed" then builds normally | `previousInstallationId` recorded; fresh Quick Create URL; install succeeds with the new relay | `e2e/scenario-recovery.spec.ts` |
| `force-complete-repeated-failures` | DESTROY fails twice (delete-failure scenario); the deployment reaches FAILED with two FAILED DESTROY jobs; the vendor calls `disconnect/force-complete` | State stays `FAILED` — the force-complete gate (60-minute staleness) refuses in the simulated window | "Failed" | Two FAILED DESTROY jobs exist; force-complete returns 409 `DESTROY_NOT_STALE`; deployment unchanged | `e2e/scenario-resilience.spec.ts` |
| `stale-install-resurrect` | A pending INSTALL is still deferred when its stack rolls back and fails; the vendor disconnects (DESTROY) and the stack is deleted; the relay then polls repeatedly and cold-starts | `state: DELETED` — DESTROY completes; the original INSTALL failure is unchanged, never a recreated stack | Never claims the install succeeded or that a new stack exists | No `CreateStack` after the DESTROY; `destroy.completed` event; the INSTALL job keeps its original FAILED result | `e2e/scenario-recovery.spec.ts` |
| `default-https-i` | Default-HTTPS DNS write failures exhaust the budget (5 `unavailable` failures); the machine reaches ERROR and stays ERROR across heartbeats; vendor retry route (`POST default-https/retry`) resets the machine to PENDING, which recovers to ACTIVE/READY | ERROR → (retry) → ACTIVE (READY) | "Ready" after retry | `defaultHttps.status` stays ERROR across waits; retry route returns `'retrying'`; machine recovers to ACTIVE; no INSTALL/DESTROY re-triggered | `e2e/scenario-default-https.spec.ts` |

Browser-level coverage: `e2e/scenario-ui.spec.ts` drives four of the original
scenarios (`happy-path`, `slow-provision`, `cloudformation-rollback`, and
`update-failure` → `rollback-success`) through a real Chromium browser against
both the customer install page and the vendor deployment detail page — the API
specs above prove the pipeline; this file proves both UIs render it honestly.

`e2e/deployment-detail.spec.ts` (a Playwright component/DOM spec, not a
scenario spec — it mocks API responses directly rather than driving the
simulated pipeline) proves the deployment detail page renders the server's
`plan` and `expectations` blocks honestly: a mocked destroy plan drives the
disconnect dialog's "will delete" / "will retain" rows, a mocked update plan
drives the deploy-update dialog's drift warning, and mocked `expectations`
drive the Infrastructure section's "Missing" and "Not required" rows.

Two Vitest suites outside `e2e/` guard the manifest-to-plan/verify contract
these scenarios exercise: `apps/api/src/requirements-contract.test.ts`
(the manifest survives byte-for-byte from deployment creation through the
INSTALL job payload to the relay's template selection and verification) and
the compiler tests (`packages/infrastructure-compiler/src/compile.test.ts`,
`safety.test.ts` — every compiled resource carries the lifecycle/retention
metadata the catalog and the relay's destroy/purge behavior rely on).

`e2e/admin.spec.ts` covers the Team Admin console
(`docs/admin/team-admin.md`): authorization, global search into the vendor
360° page, View as Vendor, diagnosing and retrying a failed install
(seeded through `cloudformation-rollback`), and the included production
deployment allowance. See
[`strategy.md`](strategy.md#validating-team-admin-changes) for when to
escalate past it.

## How to add a scenario

1. **Fixture file** — add `e2e/simulation/scenarios/<id>.ts` exporting a
   `ScenarioDefinition` (`e2e/simulation/types.ts`). Most lifecycle scenarios
   spread an existing one (usually `happyPath`) and only add the
   lifecycle-specific knob (`updateRollouts`, `destroy`) rather than
   reauthoring a whole install timeline.
2. **Registry** — import and add it to the `SCENARIOS` map in
   `e2e/simulation/scenarios/index.ts`, and re-export it from that file.
3. **Spec** — add a `test.describe` block (in an existing
   `e2e/scenario-*.spec.ts` file, or a new one) with
   `test.use({ deployzScenario: '<id>' })` and a test titled
   `` `@scenario:<id> ...` `` so `--scenario=<id>`/`--scenarios` picks it up.

### The two-clock timeline

Each `TimelineEvent` carries two independent clocks:

- `afterMs` — **real** (wall-clock) milliseconds after install start at which
  the event becomes visible to the simulated account's readers. Kept in the
  tens-to-low-thousands range so the whole suite stays fast.
- `atVirtualMs` — **simulated** milliseconds elapsed "into the install" this
  event's `Timestamp` field reports — minutes scale, so ETA/step-timing logic
  sees a realistic duration.

Events must be authored in non-decreasing `afterMs` (and correspondingly
non-decreasing `atVirtualMs`) order — array order doubles as reveal order.
A minimal annotated example (two events, ~30ms of real time apart, 40
virtual seconds apart):

```ts
{
  afterMs: 30,           // revealed 30ms into the test, real time
  atVirtualMs: 0,        // reports as "0 seconds into the install"
  logicalResourceId: 'ApplicationVpc',
  resourceType: 'AWS::EC2::VPC',
  status: 'CREATE_IN_PROGRESS',
},
{
  afterMs: 80,           // revealed 50ms later, real time
  atVirtualMs: 40_000,   // but reports as "40 virtual seconds" later
  logicalResourceId: 'ApplicationVpc',
  resourceType: 'AWS::EC2::VPC',
  status: 'CREATE_COMPLETE',
},
```

## Local execution

- **Build first.** The API imports `@deployz/db` (and other workspace
  packages) from compiled `dist/`, so run `pnpm build` before `pnpm e2e` the
  first time, or after editing a package the API depends on.
- **Dev-server reuse.** `playwright.config.ts` sets
  `reuseExistingServer: !process.env.CI` — locally, if the API/web dev
  servers are already running on ports 3001/3000, Playwright reuses them
  instead of booting new ones; in CI it always boots fresh.
- **Never run `pnpm build` while a dev server is running.** Building while
  `next dev`/`tsx --watch` is active can corrupt `apps/web/.next`. Check that
  nothing is listening on 3000/3001 before building if you need a clean
  build.
- **Rebuild after editing the relay.** The relay harness imports
  `@deployz/relay` from its compiled `dist/`, so a relay source edit is not
  exercised by `pnpm e2e` until `pnpm build` has run.
- **Isolate ports when several worktrees are active.** With
  `reuseExistingServer` on, a dev server left running by another worktree
  on 3000/3001 would be reused and the specs would test the wrong code. Set
  `WEB_PORT` and `API_PORT` to unused ports for the run.
- **Run the fixture-mode suite sharded locally.** CI shards the
  fixture-mode suite 3×, and an unsharded single-process run exceeds the
  per-test 60 s budgets on dev machines — run each shard as
  `node scripts/e2e.mjs --grep-invert "@scenario|visual" --workers=2`
  (both flags pass straight through to Playwright), or split by spec
  file with `pnpm e2e e2e/<file>.spec.ts`.
- **Default-HTTPS scenarios need the fixture machine on.**
  `e2e/scenario-default-https.spec.ts` skips unless
  `DEPLOYZ_DEFAULT_HTTPS_FIXTURE=true` is set for the API under test.

## Debugging

- **Traces and artifacts**: Playwright writes to `test-results/` on failure
  (screenshots, traces, an `error-context.md` per failed test); CI uploads
  this directory as the `e2e-simulated-results` artifact.
- **Scenario/deployment ids in the output**: the real relay code logs
  structured JSON events to stdout as it runs — `relay:command-executed`,
  `relay:stack-events-collected`, `relay:command-verified` — each carrying
  the `deploymentId`, `commandId`, and `stackName` involved, which is enough
  to correlate a failing assertion with the exact install it came from.
- **Server logs**: Playwright inherits the API/web dev servers' stdio
  (`[WebServer]`-prefixed lines in the same terminal), so application-level
  errors (e.g. a missing env var, an unhandled route error) show up inline
  with the test output.
- **A lone timeout during a full local run — in `e2e/scenario-ui.spec.ts`
  or in another spec's browser sign-up step — is usually load, not a
  regression.** Browser tests compete with the rest of the suite for the dev
  server's route compilation and CPU (the scenario-ui file runs serially and
  uses widened timeouts for exactly this reason). Before chasing it, rerun
  the failing spec in isolation — `pnpm e2e e2e/<file>.spec.ts` or
  `pnpm e2e --scenario=<id>` — and treat it as real only if it fails there
  too.

## Test-data cleanup

- **Per-test orgs.** Every scenario test signs up a fresh vendor account
  (`crypto.randomUUID().slice(0, 8)`-suffixed email) and creates its own
  application/customer/deployment — there are no shared fixture users, and
  nothing needs cleaning up between runs.
- **Local dev DB.** Without `DATABASE_URL` set, the API falls back to a
  file-backed PGlite store at `packages/db/.pgdata` (gitignored). Repeated
  local `pnpm e2e` runs accumulate test orgs/deployments there; delete the
  directory to start from a clean database.

## Convention

Every material deployment failure discovered in production or real E2E
should, where feasible, become a deterministic simulated regression scenario
— see [`strategy.md`](strategy.md#aws-failure--simulator-regression-rule).
