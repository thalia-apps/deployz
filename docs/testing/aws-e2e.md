# AWS E2E (real AWS, L4-L6)

The real-AWS layers (`strategy.md`'s L4-L6): a bootstrap-only smoke test, the
full-lifecycle version canary, and the scheduled production canary. All three
drive the deployed control plane and the test AWS account through the same
routes a vendor and a customer use — nothing here writes to the database or
to AWS directly on the product's behalf. See
[`strategy.md`](strategy.md#the-layers) for where these sit relative to the
simulated suite, and [`compatibility.md`](compatibility.md) for the separate
corpus-benchmark real-AWS layer (Stage B).

## L4 — fresh (bootstrap only)

`fresh` proves the bootstrap stack's real create/destroy path: stack
provisioning, IAM role creation, relay registration, resource tagging, and
destruction. It never installs an application — for that, use the version
canary's `profile`/`core` scenarios (L5), which reuse infrastructure per
profile and skip the 5+ minute bootstrap cycle.

Justified only after a change to
`packages/cdk/src/bootstrap/bootstrap-stack.ts`, `bin/bootstrap.ts`, or the
relay's registration/tagging behaviour. Not justified for copy, dashboard-only
changes, CSS, non-infrastructure API refactors, test-only changes, or
documentation — the simulated suite (`pnpm e2e`) covers those.

```bash
DEPLOYZ_E2E_ALLOW_REAL_AWS=1 pnpm e2e:fresh
```

Preconditions: AWS credentials via the standard SDK v3 chain, the `aws` CLI
on `PATH`, `AWS_REGION` (defaults `us-east-1`). `--dry-run` prints the
resolved command without running it and makes no AWS call; the runner still
refuses it without the opt-in, so a dry run cannot preview a run you are
not allowed to make.

Each run mints a sortable run id (`YYYYMMDD-HHMMSS-xxxx`), names its stack
`deployz-fresh-<runid>` (`DEPLOYZ_BOOTSTRAP_STACK_NAME`), and tags it
`DeployzTestMode=fresh`, `DeployzCanaryRun=<runId>`, `DeployzEnvironment=e2e`,
plus `DeployzCommit=<sha>` when resolvable — concurrent or un-torn-down runs
cannot collide with each other or a real customer's `deployz-bootstrap-…`
stack. A collision on the freshly minted name is refused, never treated as
recoverable. Teardown runs in a `try`/`finally`
(`CleanupRegistry`/`runWithTeardown`): an assertion failure mid-suite still
destroys the stack this run created. Only a killed process (no `finally`)
orphans a `deployz-fresh-<runid>` stack — destroy it by hand
(`cdk destroy --app "tsx bin/bootstrap.ts"` with `DEPLOYZ_BOOTSTRAP_STACK_NAME`
set, or the AWS Console).

**Pending qualification — relay credential scope (recorded, not run).**
The relay role and its permissions boundary now grant the credential
actions only on the connector's own credential secret (the `Fn::If` of
`RelayCredentialFromParam` and `RelayCredentialGenerated`). This run is a
pre-publication gate: do not publish the bootstrap template until it
passes. With `BOOTSTRAP_REPUBLISH=on`, a merge to `main` that changes
`packages/cdk` publishes the template, so run this gate before the merge.
Local tests do not satisfy it. Run `fresh` from the change, once with the
`RelayCredential` parameter set and once without it, and prove:

1. The relay enrolls (the relay reads the credential).
2. The relay role may write the credential: `aws iam
   simulate-principal-policy` on the relay role allows
   `secretsmanager:PutSecretValue` and `secretsmanager:UpdateSecret` on the
   `CredentialSecretArn` output.
3. The relay reads the credential after a fresh start: change the relay
   function's configuration to force a cold start, invoke it, and find
   `relay:poll-complete` with no `relay:credential-read-failed`.
4. The relay role is denied secret values elsewhere: create an untagged
   test secret in the same account and Region, and confirm the simulation
   returns `implicitDeny` for `secretsmanager:GetSecretValue` and
   `secretsmanager:PutSecretValue` on it. Delete the test secret.

Provisioning a real application stack (RDS + ElastiCache, 15-25 minutes) is
not part of `fresh`'s default run — the version canary's
`profile --profile redis` covers it through the product's own install path.

## L5 — AWS E2E (version canary)

The MVP release gate for version deployment, failed-release isolation,
rollback, recovery, persistence and cleanup. Runs against the **deployed
control plane** and the **test AWS account** (`151955775369`), through the
product's own routes.

```
canary (tsx, scripts/version-canary)          test AWS account
  sign-up, GitHub binding, application         bootstrap stack (relay Lambda)
  releases {version, gitSha=fixture tag}       ECR deployz-images
  install link → launched                      application stack:
  CreateStack (Quick Create template)             ECS service ← digest
                                                   ALB → fixture /version
  reads: CFN, ECS tasks, ECR, ALB, tags           RDS ← /canary/markers
```

### The canary vendor and GitHub installation

The control plane does not bind a GitHub installation that another
organization holds (`/api/github/setup` redirects with `github=failed`). A
GitHub account can have only one installation of the Deployz App, and the
`instashop-dev` installation belongs to a real vendor organization. Thus the
canary uses its own GitHub account and one persistent vendor organization
that holds that installation across runs. Do not bind the canary to an
installation that a real vendor uses.

One-time operator setup:

1. Create a GitHub organization for the canary only (for example
   `deployz-canary`).
2. Generate the fixture repository in it:
   `pnpm canary:fixture-repo --repo <canary-org>/deployz-canary-app`. Keep it
   public: the runner reads its tags with `gh` and the workflow token.
3. Install the Deployz GitHub App on the canary organization. Record the
   installation id (the number at the end of the installation's settings
   URL).
4. In the dashboard of the target control plane, sign up the canary vendor
   (for example `canary@<your-domain>`). Then connect GitHub and select the
   canary organization. This binds the installation to the vendor's
   organization. Use this vendor for the canary only, with one organization.
5. Set these values:

   | Name | Where (CI) | Value |
   | --- | --- | --- |
   | `DEPLOYZ_CANARY_GITHUB_INSTALLATION_ID` | repository variable | The installation id from step 3. |
   | `DEPLOYZ_CANARY_FIXTURE_REPO` | repository variable | `<canary-org>/deployz-canary-app` |
   | `DEPLOYZ_CANARY_VENDOR_EMAIL` | repository secret | The vendor email from step 4. |
   | `DEPLOYZ_CANARY_VENDOR_PASSWORD` | repository secret | The vendor password from step 4. |

   For a local run, export the same four values.

With the vendor values set, a run signs in instead of signing up. The bind
call is then a no-op re-bind by the holder. The organization keeps one
canary application per fixture repository: an application with deployment
history cannot be removed, so each run reuses it (the create call answers
`409 APPLICATION_ALREADY_CONNECTED` with its id). Customers, deployments,
releases and stacks are still new for each run. `cleanup --run-id` signs in
with the same vendor values. Do not run two canaries at the same time with
the same vendor.

Without the vendor values, a run signs up a fresh vendor. This works only
when no organization holds the installation yet, for example on a local
control plane.

Stage B (`scripts/repository-deployment`) reads the same values. With a
persistent vendor it runs every attempt in that vendor's organization, and
the repositories it deploys must be reachable through the canary
installation (set `fork` in `deploy-config.yaml` to a repository in the
canary GitHub organization).

### The fixture application

`packages/fixture` is the Deployz-controlled application every canary run
installs — deliberately close to nothing: `/health` answers 200 as soon as
the process is listening (the one exception is a release built with
`healthMode: broken`, which answers 500 on purpose), `/version` reports the
release identity baked into the image at build time, and `/canary/markers`
is a write-once database round trip the canary uses to prove persistence
across an update or a rollback.

`pnpm canary:fixture-repo` generates the public fixture repository
(`instashop-dev/deployz-canary-app`) from `packages/fixture` and pushes the
tag ladder a run needs: `v1`, `v2`, `v3-bad-health`, `v4`. Release *versions*
are minted per run (`v1-<run-id>`, since the shared ECR repository has
immutable tags); the fixture *tag* stays the artifact's identity.

`GET /canary/bindings` is what a `profile` run asks the running container
about its own environment, to prove the application stack actually injected
the env/secret bindings its manifest promised: `DATABASE_URL`,
`STORAGE_BUCKET`/`S3_BUCKET`/`AWS_S3_BUCKET`, `REDIS_URL` are checked
present/absent by a SHA-256 prefix (never the value itself), and when a
Redis binding is present the endpoint also does a raw-TCP `PING` and reports
whether it got `PONG`.

**Known trap:** `/canary/bindings` is new on this branch. The published
fixture repository (`instashop-dev/deployz-canary-app`) still carries
whatever image `pnpm canary:fixture-repo` last generated, which may predate
this endpoint — run `pnpm canary:fixture-repo` again before the next canary
so the fixture image actually answers `/canary/bindings` instead of 404ing.

**Fixture-application policy.** The canary publishes no application
template: the application stack is the compiled artifact the control plane
produces at deployment creation (`compiler-v2/<templateHash>.json` in the
region's template bucket). The run still installs the **bootstrap**
template published from the branch under test, so the relay under test is
what executes — skipped entirely in `--production` mode, which uses
whatever bootstrap template production already publishes (see L6 below).
Releases are built **just in time**: INSTALL success
auto-deploys the newest READY release, so v2/v3/v4 are only built once the
`core` ladder actually reaches them, not up front.

### Fixture A and Fixture B

- **Fixture A — the stateless profile** (`profile --profile stateless`):
  install, deploy, verify, teardown, no database. The fastest full-lifecycle
  proof; used for the production canary (L6) and as the default escalation
  for most relay/CDK changes. The analysis persists the fixture's `migrate`
  script as the application's migration command; a profile without
  PostgreSQL clears it after the analysis settles, because the manifest gate
  refuses a migration command without a database.
- **Fixture B — the `core` ladder** (`pnpm e2e:canary:versions core`): the
  full release/rollback/failed-release/recovery/persistence/cleanup
  lifecycle described below, under the PostgreSQL+Redis shape.
- **Other profiles** — `profile --profile pg` (PostgreSQL only),
  `profile --profile redis` (Redis only) and `profile --profile combined`
  (PostgreSQL and Redis) each certify one infrastructure
  shape: install to HEALTHY with the plan-vs-inventory gate, default HTTPS
  ACTIVE, bindings, then full teardown with its retained-state checks. No
  markers, no update/rollback ladder — `core` already proves that logic
  once; `profile` proves the product provisions and tears down that shape.

### Commands

```bash
DEPLOYZ_E2E_ALLOW_REAL_AWS=1 pnpm e2e:canary:versions preflight
DEPLOYZ_E2E_ALLOW_REAL_AWS=1 pnpm e2e:canary:versions core [--keep] [--existing-image=<digest>] [--reuse-stack]
DEPLOYZ_E2E_ALLOW_REAL_AWS=1 pnpm e2e:canary:versions resilience [--keep]
DEPLOYZ_E2E_ALLOW_REAL_AWS=1 pnpm e2e:canary:versions profile --profile <pg|stateless|redis|combined> [--size <small|medium|large>] [--run-id <id>] [--production]
DEPLOYZ_E2E_ALLOW_REAL_AWS=1 pnpm e2e:canary:versions journey --size <small|medium|large> [--profile <name>] [--run-id <id>]
DEPLOYZ_E2E_ALLOW_REAL_AWS=1 pnpm e2e:canary:versions cleanup --run-id <id>
DEPLOYZ_E2E_ALLOW_REAL_AWS=1 pnpm e2e:canary:versions audit --run-id <id>
```

On Windows PowerShell set `$env:DEPLOYZ_E2E_ALLOW_REAL_AWS = '1'` first.
Requirements: the `aws` CLI authenticated to the test account, `gh`
authenticated (fixture tag resolution), `pnpm build` done, and the bootstrap
template published from a commit that includes the relay under test (see
Troubleshooting below).

| Flag | Effect |
| --- | --- |
| `--keep` | Leave the environment in place for investigation; run `cleanup --run-id` afterwards. |
| `--existing-image=<digest>` (env `DEPLOYZ_E2E_EXISTING_IMAGE_DIGEST`) | Skip CodeBuild/GitHub-source rebuilds and reuse the supplied digest (`sha256:[0-9a-f]{64}`) for every release version — v1, v2, v3 and v4 all share it, so version verification relies on release/deployment records, not image changes. Use during deployment-engine iteration when the image is already published and the ~20-minute build wait is unnecessary; the default path (no flag) builds each release through CodeBuild and is required for full build-pipeline validation. |
| `--reuse-stack` | Skip bootstrap stack creation, application stack provisioning, and final infrastructure teardown; reuse a standing stack tagged `DeployzPersistent=true` and `DeployzTestMode=canary` (name defaults to `deployz-app`, override with `DEPLOYZ_E2E_CANARY_STACK_NAME`). Per-run resources (customer, deployment, releases) are still created and cleaned; infrastructure is left standing. Combine with `--keep` to leave both standing for the next reuse-stack run. Do not use when testing bootstrap or teardown logic itself. |
| `--production` | `profile` only — see L6 below. |
| `--size <small\|medium\|large>` (env `DEPLOYZ_CANARY_SIZE`) | Size of the deployment. Unset sends no size (application default). See [Size profiles](#size-profiles). |

### Runtime environment probe (`env-probe`)

`env-probe` proves which environment values a running application receives.
It does not trust the database or the UI. It starts one Fargate task from the
web service's current task definition. ECS injects the same `environment` and
`secrets` as for the application container. The command is replaced by a
shell script that prints, per key, `absent`, or `present` with the byte
length and a SHA-256 prefix. A value is never printed.

```bash
DEPLOYZ_E2E_ALLOW_REAL_AWS=1 pnpm e2e:canary:versions env-probe --stack <application stack> --keys DATABASE_URL,REDIS_URL,API_KEY --expect <file>
```

The optional `--expect` file is a local JSON map, never committed:
`"KEY": "exact intended value"`, `null` (must be absent) or `true` (present,
any value, for a generated or managed secret). The command exits non-zero on
a mismatch. Use it after an install, a configuration change, a release and a
reanalysis, to show the exact value reached the container. The probe task is
tagged `DeployzCanaryRun=<run id>` and stops by itself.

### The `core` scenario

```
preflight → vendor + application → build v1 → install → HEALTHY
→ v1 serving → default HTTPS ACTIVE → bindings present
→ seed CANARY_DATA → build v2 → deploy v2 → data + infra unchanged
→ rollback to v1 → data + infra unchanged
→ deploy v2 → build v3-bad-health → deploy v3 FAILS, v2 keeps serving
→ re-deploy of the running v2 mutates nothing
→ rollback to v1 → build v4 → deploy v4 → history keeps the failed v3
→ Disconnect → Purge → leftovers → leak audit
```

Each deploy/rollback step verifies four layers: Deployz (`state`,
`currentReleaseId`, job state), the job/relay (terminal state, payload
digest), AWS (ECS running digest, ECR digest, ALB target health, stack
status) and the live app (`/version`, `/health`, markers). `resilience` adds
concurrent-request handling, a `409 DEPLOYMENT_BUSY` check, and a two-poll
EventBridge-schedule outage the job must survive without being marked
FAILED.

### Teardown pacing

Disconnect and Purge run inside the customer account, on the relay's
one-minute EventBridge schedule (five minutes on a connector published
before the one-minute change), and Purge sweeps one orphan kind per poll —
most of a teardown's wall clock is waiting for the next tick. Teardown steps
therefore invoke the relay once between polls (the same handler the schedule
invokes, synchronously, so nudges cannot overlap). The deploy/rollback
ladder itself is never nudged, so the canary keeps proving a scheduled poll
delivers release work.

### Size profiles

Deployz has three sizes: Small, Medium and Large
([`infrastructure-profiles.md`](../infrastructure-profiles.md)). The version
canary certifies a size on real AWS.

**The `--size` flag.** `--size <small|medium|large>` (environment variable
`DEPLOYZ_CANARY_SIZE`) sends `sizeProfile` when the canary creates the
deployment. If you do not set it, the canary sends no size and the
application default applies. The expected size is then Small. An unknown
value stops the run before any AWS call. The run record (`run.json`) keeps
the size in `size` and the last sizing check in `sizing`.

**The `combined` profile.** `--profile combined` requires PostgreSQL and
Redis. The `pg`, `stateless` and `redis` profiles each cover one part of
this shape. Only `combined` shows that the database and the cache take the
same size in one stack.

**The sizing check (`assertSizing`).** The `profile` scenario runs it after
the deployment is HEALTHY and before the teardown. The check reads three
sources and compares each to the current profile of the expected size:

1. The frozen size in `GET /api/deployments/:id` (`size.profileKey`).
2. The install plan footprint (`GET /api/deployments/:id/plan?action=install`):
   the CPU and memory of each workload, the database instance type and
   storage, the cache node type and node count.
3. AWS. The canary finds every resource through the application stack's own
   resource list. It does not search the account. It reads the CPU and
   memory of the task definition of every ECS service (the web service and
   each worker), the desired count, the RDS `DBInstanceClass`,
   `AllocatedStorage` and `StorageType`, and the ElastiCache replication
   group `CacheNodeType` and node count. It reads the database and the cache
   only when the profile has them.

The check fails when AWS differs from the expected size, when the plan
differs from the expected size, or when the plan and AWS differ from each
other (plan parity). The message names each field with the value in AWS and
the expected value. The step file keeps the expected and actual values.

**The `journey` scenario.** It drives the whole size path through the
product API:

```
vendor sets application default medium, minimum small
→ build v1 → vendor invites a customer, link recommendation large
→ customer (no session) opens the invitation: recommended is large
→ customer reviews the plan for the chosen size (default small)
→ a different size gives a different fingerprint and estimate
→ a stale fingerprint is refused: 409 PLAN_CHANGED
→ customer confirms → install → HEALTHY → default HTTPS → sizing check
→ deploy v2 → sizing check → rollback to v1 → sizing check
→ Disconnect → Purge → leftovers → leak audit
```

The chosen size is `--size`. The default is Small, so the customer's choice
differs from the link recommendation (Large) and the application default
(Medium). The journey sets the application sizes back to Small and Small
when it ends. `--profile` is optional. Without it, the journey uses the
legacy shape (PostgreSQL). Use `--profile stateless` to keep the run short.

**Certification rule.**

- A NEW or CHANGED size profile (a new version, a new instance class, a new
  CPU or memory value) needs every size certified for every shape. That is
  3 sizes × 4 profiles (`stateless`, `pg`, `redis`, `combined`). The runs are
  independent. They can run in parallel in different Regions (one bootstrap
  stack for each Region). Run the `journey` once at the end.
- An ordinary change to the sizing code (selection, links, plan, pricing,
  dashboard) needs the `stateless` profile at one size that is not the
  default (for example `--size medium`), plus the `journey`.
- A change that does not touch sizing needs no size run.

**Parallel runs.** Each run has its own run id, evidence directory
(`canary-results/<run-id>`), customer, release versions and stack names.
Set `AWS_REGION` differently for each parallel run. Pass `--size` in every
parallel run. The canary application is shared in the vendor organization.
The `journey` changes its default and minimum sizes while it runs. A parallel
run that does not set `--size` can then create its deployment with the wrong
default. The workflow `aws-version-canary` concurrency group runs one workflow
at a time, so run parallel certifications from separate local shells.

**Cost.** Large uses `db.t3.large` and `cache.t4g.medium`, and 2 vCPU /
4 GiB tasks. Medium uses `db.t3.medium` and `cache.t4g.small`. Keep the runs
short. Do not use `--keep` on a Large run. Always run `cleanup --run-id` and
`audit --run-id` after a failed run.

### The MVP release gate

The MVP gate is **three consecutive `core` passes from fresh transient
infrastructure** (no `--reuse-stack`, no `--keep`). Any failure fixes the
root cause and restarts the count from zero — a flaky pass does not count
toward the three.

### Pending qualification — Phase 4 shapes (recorded, not run)

Phase 4 (multiple workers, RDS MySQL, one-shot migrations) is qualified
only in simulation plus unit and contract tests. The scenario backlog
below is recorded as the real-AWS qualification work; **none of it has
run**. The fixtures, profiles and commands above are unchanged — they
still certify the stateless, PostgreSQL and Redis shapes — and these
items are additions, not replacements:

1. **Web + two workers + PostgreSQL/Redis** — one install, three ECS
   services, per-workload verification (workers by service stability),
   the day-2 ladder across every service, then teardown.
2. **Web + worker + MySQL** — RDS MySQL 8.0 provisioning, the
   `DATABASE_URL`/`MYSQL_URL`/`DB_*` bindings, retention on disconnect
   and purge of the instance.
3. **Successful migration** — the one-shot task runs once per release;
   a retry of the confirmed identity skips the run.
4. **Failed migration** — `MIGRATION_FAILED` with family, exit code and
   stopped reason; no service update; the deployment returns to
   `UPDATE_AVAILABLE`.
5. **Combined Phase 4 topology** — the full
   `deployz-demo/composed-app` composition end to end, from analysis to
   purge.
6. **Migration correction** — after a failed frozen migration, a
   same-image correction registers a new revision of the migration family
   (only the application container's command and image change; the RDS CA
   init container stays) and recovers; "No separate migration" deploys
   without a run. The change that added it deferred this run by
   instruction; the run is not waived.

These runs should become targeted canary profiles before the Phase 4
shapes face real customer installs; until then the simulated scenarios
(`multi-worker-sweep`, `mysql-sweep`, `migration-success`,
`migration-failure`, `migration-correction`, `phase4-composition`) are the
standing evidence.

**AWS Gate C (2026-09-28) — first real-AWS evidence.** Stage B ran the
independent repository `Synapsr/Hovod` (`repo-221`) through the product
path: web + RDS MySQL + Valkey + S3, install → functional workflow
(API → MySQL → Redis/BullMQ → worker → S3) → DEPLOY_RELEASE → RESTART →
ROLLBACK → Disconnect → Purge → leak audit, all passing after seven fixes
(#394–#400). Status of the list above:

- Item 2 (MySQL): **qualified for web + MySQL** — RDS MySQL 8.0
  provisioning, `DATABASE_URL`/`MYSQL_URL` bindings used by the
  application, retention on Disconnect and purge of the instance. The
  worker half is not qualified (see below). `DATABASE_PORT` was 5432
  on that install (#399); the fix is verified in the compiled
  artifact, and a live task on a fresh MySQL install is still to show
  3306.
- Items 1, 3, 4, 5 and 6: **still pending.** Hovod runs its worker as a
  second process in the web task and its migrations inside API
  startup, so no separate worker service and no migration workload were
  provisioned.

Gate C also found that CONFIG_UPDATE failed on every compiler-v2 stack
(#396): the version canary's fixture carries no configuration, so no
canary covered it. A profile whose fixture needs one vendor value and
one secret would keep that path under test.

**Pending qualification — CONFIG_UPDATE settlement (recorded, not run).**
A configuration update now succeeds only after its rollout completes, and
a circuit-breaker rollback fails it. The real-AWS run must prove: a plain
value change rolls a new revision and succeeds after the targets are
healthy; a secret-only change forces fresh tasks; a configuration that
breaks the application is rolled back by the circuit breaker, the job
fails and the previous revision keeps serving. The change that added the
settlement deferred this run by instruction; the run is not waived, and
`config-update-failure` is the simulated evidence until then.

Stage B `fromEnv` secrets (`deploy-config.yaml`) deliver a credential
the harness cannot generate — Gate C's scoped S3 key pair — from the
environment at run time. The value is never stored.

### Pending qualification — Phase 5 shapes (recorded, not run)

Phase 5 (SQS queues, EventBridge Scheduler schedules, scheduled ECS jobs) is
qualified only in simulation plus unit and contract tests. The two shapes
below are recorded as the real-AWS qualification work; **neither has run**.
They are additions to the fixtures, profiles and commands above, not
replacements.

1. **Web → SQS (+ DLQ) → separate ECS worker → MySQL.** A producer web
   workload, a consumer worker workload, a queue with a dead-letter queue,
   and an RDS MySQL database. This shape also closes out Phase 4 pending
   item 1 above ("Web + two workers + PostgreSQL/Redis") for the
   separate-worker ECS service half of that item — the worker service
   topology itself is qualified here; item 1's PostgreSQL/Redis-specific
   assertions still stand on their own. It must prove on real AWS:
   - The queue's and DLQ's attributes (retention, visibility timeout,
     redrive policy) match what the compiler emitted, and the TLS-deny
     queue policy actually refuses a plaintext connection.
   - IAM denial checks: a role without produce access is actually denied
     `sqs:SendMessage`, and a role without consume access is actually
     denied `sqs:ReceiveMessage` — not just absent from the compiled
     template.
   - The queue env var binding (the app's own `..._QUEUE_URL`/`_ARN` name)
     actually reaches the running container.
   - Disconnect retains the database and the queue's data is handled
     correctly on teardown; Purge removes what Disconnect retained.
   - A leak audit that now includes queues and the per-workload IAM roles,
     alongside the existing resource kinds.
2. **Scheduler → scheduled ECS task → MySQL/S3.** A `render.yaml`- or
   CronJob-declared scheduled job, invoked by its own EventBridge Scheduler
   schedule, against a database and a bucket. It must prove on real AWS:
   - The schedule's name/ARN falls within the bootstrap-granted IAM scope
     (the execution role's `RunTask`/`PassRole` conditions actually hold on
     real resources, not only in the compiled policy document).
   - EventBridge Scheduler actually assumes its role and invokes `RunTask`.
   - `RunTask` picks up the **latest** task-definition revision after a
     DEPLOY_RELEASE/ROLLBACK — this revisionless family-targeting behavior
     (an auto-name `TaskDefinitionArn` resolution with no revision suffix)
     is unconfirmed on real AWS and stays a real risk until this shape is
     qualified.
   - The schedule's own dead-letter queue receives a message on an
     invocation failure.
   - A failing scheduled job does not affect the web/worker service's
     health — no shared verification path exists between them, and this
     shape must show that in practice, not only in the compiled template.
   - DESTROY correctly tears down while a scheduled job task is mid-run
     (the standalone-task-stop step, `packages/relay/src/destroy.ts`,
     actually clears a running task before the cluster delete).
   - A leak audit that now includes schedules and the scheduled job's own
     IAM roles, alongside the existing resource kinds.

## L6 — production canary

The same L5 harness, run as `profile --profile stateless --production`
(`DEPLOYZ_CANARY_PRODUCTION=1`) against the deployed control plane. It
answers one question: **can production Deployz deploy right now?**

- **No template override.** `--production` skips the branch
  bootstrap-template publish — the run installs with whatever bootstrap
  template production already publishes, exactly what a real customer's
  Quick Create uses. (There is no application-template override anywhere:
  the application stack is always the control plane's compiled artifact.)
- **HTTPS ACTIVE asserted** and **bindings asserted** the same way a branch
  run does.
- **Control-plane health recorded**: preflight writes what `GET /health` and
  `GET /health/ready` answered into `run.json`'s `controlPlaneHealth` — the
  closest thing to a deployed control-plane identifier those routes expose.

### When it runs

On demand (`workflow_dispatch` on `AWS version canary`,
`.github/workflows/aws-canary.yml`, scenario `profile`, profile `stateless`,
`production` checked). A weekly `schedule` trigger
(`profile --profile stateless --production`, Monday 06:00 UTC) is in the
workflow file but **commented out** — enable it only after three consecutive
green manual `profile --profile stateless --production` runs.

### On failure

- **Automatic cleanup** (`cleanup --run-id`) always runs when the canary
  step failed or was cancelled before its own teardown ran. There is no
  option to keep the environment: the vendor credentials never leave the
  runner, so a kept environment could not be cleaned through the product
  later. The failure diagnostics in the evidence replace it.
- **The leak audit always runs**, even on a clean pass and after a cleanup
  that could not finish.
- **One GitHub issue**, titled "Production canary failed", is created on the
  scheduled run's first failure and commented on for every later failure —
  never one issue per run.

## Safety

- **Real-AWS opt-in.** The version canary and `fresh` refuse before touching
  AWS or the control plane unless `DEPLOYZ_E2E_ALLOW_REAL_AWS=1` is set.
  Never set it merely to get past a refusal you don't understand.
  `customer-reset` is an operator tool with its own gate: an explicit
  `--confirm FULL-CUSTOMER-RESET` argument.
- **Account guard.** Every harness confirms `sts get-caller-identity`
  matches the expected test account (`DEPLOYZ_CANARY_EXPECTED_ACCOUNT`,
  default `151955775369`) before creating anything.
- **Tags and run ids.** Every resource a run creates carries
  `DeployzCanary=true`, `DeployzCanaryRun=<run-id>`, `DeployzTestMode=canary`
  (or `fresh`), `DeployzEnvironment=e2e`. Every deletion is keyed on an
  identifier the run recorded in its own evidence at creation time — there is
  no pattern-based or account-wide cleanup path inside the canary itself
  (that is what `customer-reset` is for; see Cleanup below).
- **Concurrency.** The GitHub Actions workflow runs one canary at a time
  (`concurrency: group: aws-version-canary`) — two installs in the same
  account would share connector-stack exports and race the leak audit.
- **Cost per run, and what a leak costs.** A `core`/`resilience` run
  provisions a full application stack (VPC, NAT gateway, ALB, ECS Fargate
  service, an RDS instance and, for the `redis` profile, an ElastiCache
  replication group) for the run's duration, plus one CodeBuild image build
  per release unless `--existing-image` is used — in practice 60-90 minutes
  end to end; the GitHub Actions job budgets 240 minutes total (120 for the
  canary step itself, the rest reserved so cleanup — up to 110 minutes —
  and the leak audit can still finish after a timeout). A `profile` run
  (including the scheduled production canary) provisions one install plus
  its retained-RDS teardown, budgeted 300 minutes total (180 for the canary
  step). `fresh`
  provisions only the bootstrap stack (a Lambda, its IAM role, a Secrets
  Manager secret, an EventBridge schedule) — negligible cost, a few minutes
  of runtime. A leak (a run whose teardown never completed) keeps billing
  for every hour the NAT gateway, ALB, RDS instance or ElastiCache node
  stays up — this is why the leak audit always runs and why `customer-reset`
  exists as the operator-level backstop.
- **Production-side effects.** A production canary run is a real customer
  install against the real control plane: it creates a throwaway vendor
  account and organization, a real `d-<deployment-id>.deployz.dev` Cloudflare
  DNS record for the run's lifetime, and `event_logs` rows like any other
  deployment. Cleanup removes the AWS resources and the DNS record; the
  vendor account and its `event_logs` history are not deleted (they are
  ordinary product data, not a leak).

## Evidence

`canary-results/<runId>/run.json` (identities, releases, jobs, steps — never
the vendor password), `steps/NN-<name>.json` (per-step facts and error),
`summary.md` (a PASS/FAIL table). A failed run keeps its environment for
inspection; `cleanup --run-id` tears it down from the recorded ids.

The vendor password lives only in `canary-results/<run-id>/credentials.json`
(`{email, password}`), written once at sign-up with file mode `0600`. It is
never written to `run.json`, and the GitHub Actions evidence upload excludes
it (`!canary-results/**/credentials.json`) — it never leaves the runner.
`cleanup --run-id` reads it back to sign in again; deleting a run's evidence
directory deletes the credentials with it.

### Diagnostics captured on failure

A failing install/deploy/destroy step attaches a best-effort diagnostics
snapshot to its own step file (`details.diagnostics`), read-only through the
same AWS/control-plane seams the rest of the canary uses: the CloudFormation
stack status and `*_FAILED` events for the bootstrap and application stacks,
the deployment's relay/health/cleanup state and the control plane's own
`/diagnostics` projection, and — when a release failed — its build failure
detail (`GET .../releases/:id/build-failure`). A capture failure is recorded
alongside (`diagnosticsError`) rather than masking the original error; each
piece of diagnostics is independently best-effort.

## Cleanup and the leak audit

Normal teardown runs the product's own Disconnect and Purge first (what a
customer gets), then the canary-only leftovers a customer would remove by
hand: the bootstrap stack (only once the application stack is gone — its
execution role lives in the bootstrap stack), the relay's Lambda log groups,
the run's ECR tags, the installation's task definitions, and the SSM pending
marker.

```bash
DEPLOYZ_E2E_ALLOW_REAL_AWS=1 pnpm e2e:canary:versions cleanup --run-id <id>   # Disconnect/Purge/leftovers for one run
DEPLOYZ_E2E_ALLOW_REAL_AWS=1 pnpm e2e:canary:versions audit --run-id <id>     # read-only leak audit for one run
```

The leak audit is an independent look at the account, keyed on the run's
recorded ids (installation tag, run tag, stack names, RDS, ALB, S3, secrets,
log groups, SSM, ACM, ECR) — it fails on anything disposable still found.
INACTIVE ECS clusters/services/task definitions that the tagging API keeps
listing after deletion are the one documented exception (they cost nothing).

**Known gap:** the leak audit does not yet check Cloudflare for a leftover
`d-<deployment-id>.deployz.dev` DNS record. Normal Disconnect/Purge removes
it through the product; a run that leaked before Disconnect completed can
leave the record behind with no automated check to catch it — verify by
hand (`dig d-<deployment-id>.deployz.dev` or the Cloudflare dashboard) after
an abnormal cleanup.

`scripts/customer-reset` (`pnpm admin:customer-cleanup`) is the operator's
bulk tool, not a canary command: `inventory` builds a manifest of every
customer installation, `execute --confirm FULL-CUSTOMER-RESET` wipes every
customer deployment's AWS resources and DB rows while preserving
control-plane data, and `verify` re-scans AWS and the DB to confirm nothing
customer-owned survived. Use it when an id-keyed `cleanup --run-id` cannot
reach a resource, or to reset the whole test account between campaigns —
never as a substitute for a run's own cleanup. The tool holds a protected
control-plane inventory that covers both stages: the stacks `Deployz` and
`DeployzStaging`, their build-source and template buckets, the regional
template buckets, the `cdk-*` bootstrap buckets, and the repositories
`deployz-images` and `deployz-staging-images`. The inventory repeats the
names in `packages/cdk/src/stage.ts`, because the script cannot import the
CDK package.

`packages/cdk/scripts/audit-deployment.mjs`
(`pnpm --filter @deployz/cdk audit:deployment --installation <uuid>`) is a
different, narrower tool: it asks AWS directly whether one installation
actually contains the application the control plane claims is deployed
(the same verification the relay itself would run), independent of any
canary run — useful when the control plane and the account seem to disagree.

## Escalation rules

These match the strings `scripts/test-affected.mjs` prints as (never runs)
AWS escalations, and the policy in
[`strategy.md`](strategy.md#the-escalation-policy-for-coding-agents). The
first rule below is **required**, learned from production outages that were
invisible to unit tests, CI and the simulator — not a judgment call:

- **Required.** A change to the relay's install/deploy/rollback/destroy/purge
  executors (`packages/relay/src`), the bootstrap template
  (`packages/cdk/src/bootstrap`), the infrastructure compiler or its
  CloudFormation output (`packages/infrastructure-compiler`,
  `packages/contracts` planning), or the relay's enrollment path needs a
  real-AWS run before the affected template or artifact path is live:
  `fresh` for a
  bootstrap-only change; the stateless `profile` otherwise; `core` for a
  release, rollback, deploy, destroy or purge change.
- **A `packages/relay/src` change** (non-test): `scripts/test-affected.mjs`
  prints `core` when the file is one of the relay's AWS-SDK-interface
  modules (`RELAY_AWS_INTERFACE`); the stateless `profile` otherwise —
  matching the rule above.
- **A `packages/cdk` customer-side change** (bootstrap, application stack,
  quick-create, the relay Lambda handler; non-test, non-`scripts/`): the
  stateless `profile`, plus `fresh` in addition when the change is under
  `packages/cdk/src/bootstrap/`, `bin/bootstrap.ts`, or
  `packages/cdk/artifacts/bootstrap-*`.
- **A sizing change** (size profiles, size selection, pricing, or the
  sizing the compiler emits): the stateless `profile` at one non-default
  `--size`, plus the `journey` scenario. A new or changed profile needs the
  full size certification in [Size profiles](#size-profiles).
- **A `packages/fixture` change** (non-test):
  `pnpm canary:fixture-repo && DEPLOYZ_E2E_ALLOW_REAL_AWS=1 pnpm e2e:canary:versions profile --profile stateless`
  — the fixture repository must be regenerated before a canary can use it.
- **Escalate to `fresh` only when**: explicitly requested; fundamental
  provisioning behaviour changed; validating a release; validating
  cleanup/destruction; or the version canary cannot provide adequate
  confidence on its own.
- Judgment is still needed only for a change `scripts/test-affected.mjs`'s
  file-path rules do not cover — never to skip an escalation the required
  rule above already covers.

## Troubleshooting

- **Preflight refuses the account, or `aws login` expiry** — you are not
  authenticated to the test account, or the session expired mid-run
  (`aws login` as its root/admin user re-authenticates; re-run afterwards).
- **`GitHub binding did not report connected` (`github=failed`)** — another
  organization holds the installation. Set the canary vendor values and
  installation id (see "The canary vendor and GitHub installation").
- **Install link has no Quick Create URL** — the bootstrap template is not
  published for this control plane (`BOOTSTRAP_TEMPLATE_URL` unset).
- **`CreateStack` refuses parameters** — the relay must include the fix for
  undeclared parameters being dropped; republish the bootstrap template.
- **Release build FAILED** — the release's `failureReason` names the
  CodeBuild phase; the fixture builds from its own directory.
- **`live /version answered <blank>, expected vN` while every other layer is
  green** — the probe could not read the app at all. The canary probes the
  URL the control plane advertises (`appUrl`), falling back to the ALB
  endpoint recorded at install. Before that fallback existed, the default
  HTTPS flow's 301 on the ALB's port-80 listener (which preserves the host
  header) redirected the raw ALB DNS name to itself over TLS, where the
  certificate covers only `d-<deployment>.deployz.dev`.
- **Failed-release step exceeds 50 minutes** — the ECS circuit breaker needs
  several task launches; check the deploy job's `reconcileCount` and the
  relay log group for repeated `UpdateService` calls (a known slow path, not
  a defect).
- **VPC quota is 5 per Region** — the control plane's own VPC plus one
  pre-existing orphan leave room for at most three concurrent installs in
  `us-east-1`; a `core`/`profile` run that hits `VpcLimitExceeded` needs an
  earlier run's infrastructure cleaned up first (`cleanup --run-id`, or
  `customer-reset inventory`/`execute` to find and remove it).
- **A retained RDS instance takes a while to purge.** Disconnect retains the
  database (deletion protection on); Purge turns protection off and deletes
  it, which can take tens of minutes end to end when default HTTPS is also
  active — do not treat a long-running Purge step as stuck before the
  teardown timeout is reached.
- **Republish the bootstrap template before a canary of a bootstrap
  change.** A canary
  run installs from whatever the bootstrap template already publishes unless
  it synthesizes its own (branch-testing mode, the default for `core`/
  `resilience`/non-production `profile`); a `--production` run always uses
  whatever is already published. A merge that changed
  `packages/relay/src` or `packages/cdk/src/bootstrap` needs a fresh
  `publish:bootstrap` before a `--production`
  canary can see it — see the deploy workflow's "Republish the bootstrap
  template" step in `.github/workflows/deploy-api.yml`. Compiled
  application artifacts need no publish step: the API publishes them at
  deployment creation.
