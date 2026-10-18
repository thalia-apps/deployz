# Compatibility

The corpus layer (`strategy.md`'s **compat** row): how accurately Deployz
analyses and deploys real open-source repositories. It measures the Analysis
and the product against realistic customer code. It is not a product
regression check, it never gates a merge, and it never runs on a pull
request. See [`strategy.md`](strategy.md#the-layers) for how it differs from
the AWS E2E layers.

Two tests answer two different questions:

| Test | Question | AWS | Repository list |
| --- | --- | --- | --- |
| Docker run-and-check — `pnpm runcheck:*` | Is each Analysis claim true for the running application? | None | `scripts/run-and-check/recipes/` |
| Stage B — `pnpm benchmark:deploy` | Can Deployz actually *deploy* it, end to end? | Real, test account | reads the repository list by id |

## Docker run-and-check

The test builds and runs real applications in Docker and checks each
Analysis claim against what the application does. The running application
is the truth, not a label. It replaces the label benchmarks (Stage A
compatibility and remediation); the decision is in
[`../decisions/README.md`](../decisions/README.md). The harness is
`scripts/run-and-check/`.

```bash
pnpm runcheck:preflight                  # machine facts, safety, emulation and disk checks
pnpm runcheck:analyse                    # the production Analysis for every recipe
pnpm runcheck:observe [--repo <id>] [--force]
pnpm runcheck:claims [--repo <id>] [--analysis <dir>]
pnpm runcheck:full [--repo <id>] [--analysis <dir>] [--force]
pnpm runcheck:fixtures [--no-observe]
```

### Three modes

1. **Observation run** (`runcheck:observe`). Runs once per repository commit.
   Docker builds the image and runs the application with every candidate
   service: PostgreSQL 16 with TLS, MySQL 8.0, Valkey and MinIO (S3). The
   harness records what the application does: listening ports and their
   bind address, HTTP status per path, database connections and tables,
   migrations at start and from a separate command, Valkey clients, MinIO
   objects, local disk writes (`docker diff`), workers, required variables,
   two copies at the same time and a restart. Each fact has evidence and the
   CPU architecture it came from. Each observation runs twice; a fact that
   differs between the runs is `unstable`. The result is committed in
   `scripts/run-and-check/observations/<id>.json`. An observation does not
   depend on one Analysis: the probed paths, commands and variables come
   from the recipe, from every stored Analysis and from a fixed list.
2. **Claim check** (`runcheck:claims`). Compares an Analysis result with the
   stored observations. It needs no Docker and takes seconds. Fixed code
   gives each claim one verdict: `CONFIRMED`, `CONTRADICTED` or
   `NOT_CHECKABLE` with a reason. Use it to evaluate a rule, prompt or model
   change quickly.
3. **Full run** (`runcheck:full`). Runs the application with exactly the
   settings that the Analysis produced, and nothing more: the migration
   command first, then the web container with the image command, then each
   worker. Use it when the Analysis produces settings that the observations
   do not cover, and for the release gate.

The report (`.runs/reports/<analyser>/summary.md`) gives, per repository
set: the applications that are healthy with the analysed settings, **hidden
problems** (the Analysis said READY and the application fails with the
analysed settings), **false problems** (the Analysis asked for a fix or a
vendor decision that the application did not need), CONTRADICTED claims per
claim type and per runtime, NOT_CHECKABLE reasons, unstable facts and the
vendor questions per repository. The tuning set and the holdout set are
always reported apart.

### Production parity

- The Analysis runs through the production path (`runApplicationAnalysis`,
  then the readiness gate as production preflight evaluates it).
- The container environment comes from the production compiler:
  `compileDeploymentIntent` gives the CloudFormation template, and the
  harness resolves the task-definition `Environment` and `Secrets` to the
  local services. Minted secrets and derived URL and S3 values use the same
  exported functions as the relay (`mintedEnvKeys`, `generateSecretValue`,
  `derivedUrlEnvValue`, `derivedS3EnvValue`). The harness adds only the
  MinIO endpoint and keys (production uses the task IAM role), and it points
  a derived S3 endpoint to MinIO. Each observation lists these names.
- The web container runs the image command, as production does. A worker
  runs `sh -c <command>` with the image ENTRYPOINT. A migration replaces the
  ENTRYPOINT with `sh -c` (`workloadContainerCommand`,
  `oneShotContainerCommand`).
- The application gets the `small-v2` memory (512 MiB). The RDS CA bundle
  path holds the CA of the local PostgreSQL certificate.

### Recipes

A recipe (`recipes/<id>.yaml`) holds **inputs only**, never expected
answers: the repository and the pinned commit, build overrides only when the
repository needs them, vendor inputs (a generated secret with a format, or a
fixed non-secret test value), the SQL engine when the application supports
only MySQL, and one smoke request when a generic request cannot touch the
database. A person reviews each recipe.

### Known-answer fixtures

`fixtures/F1` to `fixtures/F10` are ten small applications with known
behaviour (for example a server bound to 127.0.0.1 only, a silent SQLite
fallback, a lazy database connection). `answers.json` is the only place with
expected answers, and it tests only the harness. `pnpm runcheck:fixtures`
must give the expected verdict for every fixture before anyone trusts other
results.

### Safety

Repository code is untrusted. It runs only inside Docker containers and
BuildKit, never on the host.

- Every `docker` call has a clean environment (`PATH`, `SystemRoot`, `TEMP`,
  `TMP`, `USERPROFILE`, `ProgramFiles`, `DOCKER_*`). No host credential
  reaches a container.
- The harness refuses unsafe options: `--privileged`, the host network or
  PID namespace, added capabilities, devices, published ports, `--env-file`,
  `-e NAME` without a value, and mounts of host paths or the Docker socket.
- Builds use a Git URL context (`https://github.com/<owner>/<repo>.git#<sha>`),
  so the source never touches the host file system.
- Applications and services run on an internal Docker network with no
  internet. Probes run from a probe container on that network.
- Every container has CPU, memory and PID limits. Every resource has the
  label `deployz.runcheck=1`. Cleanup removes only labelled resources.
- One build runs at a time on the machine (a lock file in
  `%LOCALAPPDATA%\deployz-runcheck`). Built images are cached there with
  `docker save`, outside the repository.

### CPU architecture

Deployz runs Fargate tasks on x86_64. On an ARM machine, the application
images build and run as `linux/amd64` under QEMU emulation, and the services
run natively. Emulation makes startup slower: the harness multiplies the
health grace time by 3 and records the measured times. A heavy repository,
or one whose build crashes under emulation, builds on an x86_64 GitHub
runner with the manual workflow `runcheck-build.yml` ([`ci.md`](ci.md)), and
the harness loads that image. Every fact records its architecture
(`amd64-emulated`, `amd64-ci-build` or `arm64-native`). A fact from a native
arm64 run is evidence for behaviour only. It never confirms a Dockerfile
claim.

### Limits

Docker on one machine does not test AWS IAM permissions, the load balancer,
HTTPS certificates, TLS to RDS with the Amazon CA, the Fargate network or
the relay. Stage B keeps covering those on a few repositories. Emulation
changes timing, CPU and memory use. An x86_64 machine gives exact parity.

### Release gate

A new Analysis implementation (a rules change, a prompt change or a model
change) passes only when, compared with the baseline:

1. Hidden problems are **0** in the tuning set and in the holdout set.
2. CONTRADICTED claims are fewer than or equal to the baseline, for each
   claim type.
3. False problems are fewer than the baseline.
4. All fixtures pass.

Use the claim check for quick evaluation. Use a full run on every
repository for the final decision. Never use the holdout set to tune rules
or prompts.

## Stage B — repository-deployment audit

Answers what Stage A stops short of: when a repository is inside the MVP
support boundary, can Deployz build it, deploy it into a real customer AWS
account, make it healthy over HTTPS, and remove it cleanly afterwards? It
runs the pinned repositories through the real production path — analysis,
configuration, CodeBuild, ECR, the published templates, the relay,
CloudFormation, ECS, the ALB, RDS, ElastiCache, S3, the heartbeat health
gates, default HTTPS, Disconnect and Purge — and records one result per
repository. `CloudFormation CREATE_COMPLETE` is never a pass; a repository
passes only when it reaches a stable application-level healthy state and its
resources are gone afterwards.

### Classes B2 and B3

An earlier third class, **B1 runtime-reuse** (deploy every repository onto
one shared standing installation, to avoid fresh AWS per attempt), is
withdrawn (`DEPLOY-017`): a deployment owns its installation
(`deployments.installation_id` is UNIQUE, the enrollment code is single-use,
the relay token binds to the deployment that traded it), so a standing
installation can never serve a second deployment. There is no
`--runtime-reuse` CLI mode any more. Every repository Stage B actually runs
now goes through one of:

| Class | Infrastructure | Coverage | Repositories |
| --- | --- | --- | --- |
| **B2 capability-cohort** | Fresh per attempt | Infrastructure capability cohorts (PostgreSQL, Redis, PostgreSQL+Redis, storage, custom Dockerfile, custom port, custom health check, special topology) | Explicit list in `deploy-config.yaml` (`b2Repos`) |
| **B3 fresh-full** | Fresh per attempt | Full funnel through fresh AWS (build → ECR → bootstrap → install → healthy → destroy → cleanup audit) | 10-15 representative repos in `deploy-config.yaml` (`b3Repos`) |

A repository not listed in either defaults to `capability-cohort` in its
result (`deploymentClass`, `deploymentClassFor`'s default) — it runs the
same fresh-AWS `--real-aws` funnel as an explicit B2 entry, so that is the
honest default now. `'runtime-reuse'` stays a valid `deploymentClass` value
only because the committed `runs/*.json` history (40 result files) recorded
it before the removal; `deploymentClassFor` never assigns it to a new
result. `--gate` audits any repository offline regardless of class (the
deployment gate only, no AWS). To make a retry cheap without a fresh
CodeBuild run, use `--reuse-application` (redeploys the release the
repository already built).

Override a repository's class with `deploymentClass: fresh-full` (or
`capability-cohort`) in its `deploy-config.yaml` entry — it takes precedence
over the `b2Repos`/`b3Repos` lists.

### The funnel and its gates

| Stage | What runs | Stops the funnel when |
| --- | --- | --- |
| Gate | `runApplicationAnalysis` → `normalizeDeploymentManifest` + `evaluateManifestReadiness`, then the same gate on the deployed control plane | expected unsupported and rejected (`EXPECTED_UNSUPPORTED`); expected deployable but rejected (`GATE_ERROR`, a false rejection) |
| Configuration | Vendor overrides and configuration values from `deploy-config.yaml`; secrets generated at run time, or read from the environment (`fromEnv`) for a credential the harness cannot generate — never committed | the gate still refuses (`CONFIG_ERROR`) |
| Build | A release is created at the pinned SHA; CodeBuild → ECR digest | release `FAILED` (`SOURCE_FETCH_ERROR`, `BUILD_ERROR`, `IMAGE_ERROR`) — no AWS infrastructure created |
| Deployment | Customer + deployment, install link launched, bootstrap stack created exactly as Quick Create would, relay enrolls, INSTALL provisions the application stack | stack failure (`INFRA_ERROR`), task failure (`CONTAINER_START_ERROR`, `PORT_ERROR`, `ENV_BINDING_ERROR`, …), `TIMEOUT` |
| Health | Heartbeat gates, `currentReleaseId` promoted, default HTTPS ACTIVE, independent probes over HTTP and HTTPS | `HEALTH_PATH_ERROR`, `TLS_ERROR`, `APPLICATION_ERROR`, `DATABASE_ERROR`, `REDIS_ERROR`, `MIGRATION_ERROR`, `STORAGE_ERROR` |
| Cleanup | Disconnect → Purge → customer-owned leftovers → leak audit | `DESTROY_ERROR`, `CLEANUP_LEAK` |

Stage B reuses the version canary's building blocks rather than
reimplementing them: the vendor-side control-plane client
(`scripts/version-canary/control-plane.ts`), the AWS view and leak audit
(`scripts/version-canary/aws.ts`), and product teardown
(`scripts/version-canary/teardown.ts`) are all imported as is; only the
per-repository step functions and result model are Stage B's own, because
the assertions differ (any application, not one fixture).

### Classification vocabulary

`classification` (`scripts/repository-deployment/results.ts`) is `PASS` or
one of `FAILURE_STAGES`; `rootCause` is one of `ROOT_CAUSES`. No other label
is accepted — the schema refuses anything else, and
`harness.test.ts` asserts every one of these ids is documented here:

```
GATE_ERROR CONFIG_ERROR SOURCE_FETCH_ERROR BUILD_ERROR IMAGE_ERROR INFRA_ERROR
CONTAINER_START_ERROR ENV_BINDING_ERROR DATABASE_ERROR REDIS_ERROR
MIGRATION_ERROR STORAGE_ERROR PORT_ERROR HEALTH_PATH_ERROR TLS_ERROR
APPLICATION_ERROR TIMEOUT DESTROY_ERROR CLEANUP_LEAK EXPECTED_UNSUPPORTED
REPOSITORY_BROKEN TEST_HARNESS_ERROR

DEPLOYZ_BUG ANALYSIS_BUG ANALYSIS_MISSING_SIGNAL MVP_CAPABILITY_GAP
CORRECTLY_UNSUPPORTED REPO_CONFIGURATION UPSTREAM_REPO_FAILURE
AWS_TRANSIENT_FAILURE TEST_HARNESS_FAILURE
```

`REPOSITORY_BROKEN` and `TEST_HARNESS_ERROR` are failure stages for a corpus
snapshot that cannot be attempted at all and a harness-side fault, neither a
product nor an analyser problem. `DEPLOYZ_BUG`, `REPO_CONFIGURATION`,
`UPSTREAM_REPO_FAILURE` and `AWS_TRANSIENT_FAILURE` are root causes with no
Stage A equivalent: a genuine product defect, a `deploy-config.yaml`
mistake, a fault in the third-party repository itself, and a transient AWS
error a retry would clear.

### Cleanup rules and the leak audit

1. Real AWS needs `DEPLOYZ_E2E_ALLOW_REAL_AWS=1` **and** `--real-aws`.
2. Preflight refuses any AWS account other than the test account.
3. Every identifier is written to the attempt's ledger
   (`runs/evidence/<run id>/run.json`, gitignored) at creation time. Cleanup
   runs in `finally`: Disconnect → Purge → leftovers → leak audit. An
   interrupted run is resumed with `--resume`, which finishes cleanup for
   anything still alive before continuing the selection.
4. The connector (bootstrap) stack is never removed while an application
   stack was ever created unless the product's `cleanupState` is
   `COMPLETE` — Purge runs inside the connector's relay, so removing it
   earlier strands whatever the sweep had not reached yet.
5. After each wave, and at the end of Stage B, an account-level scan for the
   Stage B tags and the product's installation tags must return nothing
   disposable (the same INACTIVE-ECS exception the canary's leak audit has).
6. The global real-AWS concurrency guard (`--max-active`, default 2) refuses
   a new attempt before it creates anything when the evidence dir already
   holds that many unfinished runs.
7. **Concurrency with the canary: never overlap in the test account.**
   Stage B and the version canary (`aws-e2e.md`) share the same test
   account and the same VPC quota (5 per Region). Do not run a Stage B wave
   and a version-canary run against the same Region at the same time.

```bash
pnpm benchmark:deploy --gate                                          # offline gate audit, every repository
pnpm benchmark:deploy --dry-run --wave wave-1                         # print the plan, touch nothing
DEPLOYZ_E2E_ALLOW_REAL_AWS=1 pnpm benchmark:deploy --real-aws --repo repo-001
DEPLOYZ_E2E_ALLOW_REAL_AWS=1 pnpm benchmark:deploy --real-aws --resume
DEPLOYZ_E2E_ALLOW_REAL_AWS=1 pnpm benchmark:deploy --cleanup --repo repo-001
DEPLOYZ_E2E_ALLOW_REAL_AWS=1 pnpm benchmark:deploy --audit
```

**Findings** are systemic (`DEPLOY-nnn`, in
[`repository-deployment/findings.md`](repository-deployment/findings.md)),
distinct from Stage A's `COMP-nnn` analyser-accuracy findings — a Stage B
`GATE_ERROR` on an expected-deployable repository is a Stage A false
rejection seen from the product side; a `HEALTH_PATH_ERROR` is a Stage A
`healthPath` mismatch that became a failed deployment.

## `pnpm jev:eval`

An offline evaluation harness for a shadow-mode second opinion: it runs the
requirements-shadow verifier and the UNKNOWN-failure classifier across the
Stage A corpus and the Stage B failure records, and compares the result
against the same `benchmark.yaml` expected facts Stage A uses — labels never
come from the analyser. `--fixture` runs with deterministic canned answers
and needs no credentials; the default mode needs
`JEV_ENABLED`/`JEV_GATEWAY_URL`/`JEV_API_KEY` and fails fast without them.
`--max-calls` (default 150) and `--delay-ms` (default 250) guard cost and
rate; a repository whose run file already carries the same evidence
fingerprint and schema versions is resumed, not re-asked.

```bash
pnpm jev:eval                     # every corpus repository
pnpm jev:eval --repo repo-001     # one (or several --repo) entries
pnpm jev:eval --failures          # replay the Stage B failure records
pnpm jev:eval --plan              # dry-run: selection, sizes, call count
```

As of 2026-09-20 a full evaluation (360 labelled decisions across 120
repositories) found the shadow model produced no discriminative signal and
misclassified every verifiable failure case — Jev shadow analysis is not
adopted (`docs/decisions/README.md`). The code stays behind `JEV_ENABLED`
(unset in production) with zero runtime effect, and `pnpm jev:eval` remains
a one-command re-evaluation if a future model version warrants it. Its
resume cache and result files moved from `docs/testing/jev-shadow/runs/` to
`scripts/jev-eval/runs/` (`EVAL_DIR` in `scripts/jev-eval/index.ts`) — next
to the harness that reads it, alongside the `version-canary`,
`repository-compatibility` and `repository-deployment` harness directories.

## The manual full-product walk

Everything above is repeatable and scriptable. What it cannot prove is
whether the product, as a whole, is pleasant and correct to use with an
**arbitrary third-party application** driven by a **human** through the real
dashboard — Documenso is the standing choice, because it needs PostgreSQL, a
migration command, and a real health path, and is not a Deployz-controlled
fixture. The written checklist for this walk is
[`manual-checklist.md`](manual-checklist.md).

Run it:

- **Manually**, on demand.
- **Periodically**, as a standing hygiene check independent of any specific
  change.
- **Before a significant release** — the same standard the version canary's
  three-consecutive-`core`-passes gate applies to the fixture ladder, applied
  once to a real application.
- **After an analyser, build, or platform change** that the automated layers
  above cannot exercise directly (a change to the analyser's detectors, the
  CodeBuild/ECR build pipeline, or the published templates).
- **Never on a pull request.** Like the rest of this document, it is not a
  merge gate.

## What is kept where

Nothing under `runs/` moved except `jev-shadow` (above).
`repository-compatibility/findings.md`, `benchmark.yaml`, `.cache/` and
`runs/` stay where the Stage A harness reads them
(`docs/testing/repository-compatibility/`).
`repository-deployment/findings.md`, `deploy-config.yaml` and `runs/` stay
where the Stage B harness reads them
(`docs/testing/repository-deployment/`). This document replaces
`repository-compatibility/README.md` and `repository-deployment/README.md`,
which are deleted — the harness code, `findings.md` registries and YAML
configuration are the source of truth for anything not covered here (corpus
entry format, finding categories, the full result-record schema, the
multi-region campaign flags).
