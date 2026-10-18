# Testing strategy

The testing philosophy for Deployz, and the layer model every other testing
document builds on. Read this first. For "is this specific capability
tested, and where," see [`test-matrix.md`](test-matrix.md). For what CI
runs, see [`ci.md`](ci.md). For the simulated E2E mechanics, see
[`simulated-e2e.md`](simulated-e2e.md).

## Purpose

Deployz deploys real customer applications into real AWS accounts. A test
gap here can strand or destroy a customer's infrastructure, or make the
vendor and the customer see two different truths about the same
deployment. This document sets the rules for where a test belongs, so that
confidence is cheap to get and real AWS stays a deliberate, rare step.

## Principles

- **Test behaviour at the cheapest reliable layer.** Start at unit. Move up
  only when the current layer cannot prove the behaviour.
- **Never use E2E to compensate for missing unit coverage.** A missing unit
  test is a unit-test gap, not an E2E gap. Add the unit test first.
- **Use deterministic, Deployz-controlled fixtures for regression.** A
  regression test must reproduce the same failure every run. Real
  third-party repositories are not deterministic enough for regression
  tests; use the simulated AWS account and the fixture application instead.
- **Compatibility testing is separate from CI.** The repository-compatibility
  and repository-deployment benchmarks measure analyser accuracy against a
  large corpus. They do not run on a pull request and they do not gate a
  merge.
- **Real AWS is small, diagnosable, and cleans up after itself.** Every
  real-AWS run tags its own resources, keeps a short evidence trail, and
  destroys what it created. A real-AWS run that cannot explain a failure in
  a few minutes has failed at its one job.
- **One source of truth.** A capability's test coverage is documented once,
  in [`test-matrix.md`](test-matrix.md). A command's exact behaviour is
  documented once, in the file that owns it. Other documents link to it
  instead of repeating it.

## The layers

Use the cheapest layer that can establish confidence. Each layer proves one
thing. Do not stretch a layer to prove something a higher layer owns.

| Layer | Proves | Must not be used for | Command | Runs |
| --- | --- | --- | --- | --- |
| **L0 — static** | The code builds, lints clean, and typechecks, including the E2E harness and the AWS scripts; production-safety guards hold (no AWS SDK in the simulator, no fixture-mode env var reaches the deployed Lambda, and the per-environment structure of the deploy and release workflows is intact); every Lambda entry point still bundles | Business logic — static checks read shapes, not behaviour | `pnpm build`, `pnpm lint`, `pnpm typecheck:e2e`, `pnpm typecheck:scripts`, `pnpm test:static`, `node --test scripts/test-affected.test.mjs`, `pnpm synth:smoke` | Every non-minimal PR (the subset the plan selects); the full set on `main` |
| **L1 — unit** | Pure logic: state derivation, business rules, parsing, pricing, the client-side state matrices — Vitest over fakes and in-memory fixtures, including `apps/web`'s jsdom tests | A real DB, a real HTTP boundary, or a real AWS call | `pnpm vitest run` (or `pnpm vitest run --project <package>`, or a single test file) | Every non-minimal PR, scoped to the affected projects; every project on `main` |
| **L2 — integration/contract** | A real local dependency with no network call to AWS or GitHub: API routes over PGlite, DB constraints, CDK bootstrap-template synthesis, the worker Lambda over PGlite, relay executors over fakes, compiler determinism/composition/identity over fixtures, and parity tests between packages (manifest ↔ plan ↔ verify) | A real customer AWS account, or vendor/customer UI rendering | `pnpm vitest run --project <package>` (same command as L1 — the distinction is what the test exercises, not how it runs) | Same as L1 |
| **L3 — UI/workflow** | A vendor or customer workflow end to end: the real Next.js app and the real Fastify API, driven by Playwright. Fixture-mode specs replace GitHub, AI and DNS with canned data. Scenario specs additionally replace the AWS SDK client with a `SimulatedCustomerAccount` and drive the real relay code over it | AWS API behaviour itself — the simulator only returns AWS-shaped answers, it does not verify AWS's actual behaviour | `pnpm e2e` (the full simulated suite — every `e2e/*.spec.ts` file, including scenarios), `node scripts/e2e.mjs --grep-invert "@scenario|visual"` (the fixture-mode suite alone), `pnpm e2e --scenario=<id>`, `pnpm e2e --scenarios` (every scenario), `pnpm e2e e2e/<file>.spec.ts` | Every non-minimal PR that touches runtime UI/API code, or names a spec; every spec and scenario on `main` |
| **L4 — AWS integration** (`fresh`) | One real AWS boundary in minutes, with no product flow: the bootstrap stack's real create → verify → destroy path | A full product lifecycle — `fresh` never installs an application | `DEPLOYZ_E2E_ALLOW_REAL_AWS=1 pnpm e2e:fresh` | Manual/local escalation only; never in CI |
| **L5 — AWS E2E** (version canary) | A complete real lifecycle through the deployed control plane, against a Deployz-controlled fixture application. Fixture A is the stateless profile (`profile --profile stateless`) — install, deploy, verify, teardown, no database. Fixture B is the Postgres+Redis `core` ladder — the full release/rollback/failed-release/recovery/persistence/cleanup lifecycle | Routine development iteration — this is an escalation, not a debugging loop | `DEPLOYZ_E2E_ALLOW_REAL_AWS=1 pnpm e2e:canary:versions profile --profile stateless`, `DEPLOYZ_E2E_ALLOW_REAL_AWS=1 pnpm e2e:canary:versions core` | Manual/on-demand escalation, and before an MVP release |
| **L6 — production canary** | The same harness as L5, run with `profile --profile stateless --production`, against the deployed control plane with the production-published template — answers "can production Deployz deploy right now?" | A pre-merge check — this runs against production, not a pull request | `DEPLOYZ_E2E_ALLOW_REAL_AWS=1 pnpm e2e:canary:versions profile --profile stateless --production` | On demand; a weekly schedule exists in the workflow but stays disabled until three consecutive green manual `--production` runs — see [`aws-e2e.md`](aws-e2e.md#l6--production-canary) |
| **Compatibility** | Analyser accuracy over a large corpus: Stage A offline against 120 pinned repositories, Stage B through the real production path against the same corpus | A product regression check — a compatibility finding (`COMP-nnn`/`DEPLOY-nnn`) is an analyser-accuracy finding, not a proof the product is broken | `pnpm benchmark:compat` (Stage A, no AWS), `pnpm benchmark:deploy` (Stage B, real AWS) | On demand — see [`compatibility.md`](compatibility.md) |
| **Manual** | Whatever no automated layer reaches yet: the full product walk against the deployed control plane, with an arbitrary real application, through the real dashboard | A substitute for automation — a manual finding should become a scenario or a canary case | A human follows the written runbook | Before calling a release ready — see [`manual-checklist.md`](manual-checklist.md) |

## What belongs where

- **Pure state or business logic** (status derivation, pricing, vocabulary
  mapping, retry eligibility) → unit (L1).
- **A payload or service boundary** (a route's request/response shape, a
  package's exported contract) → integration (L2).
- **API and DB behaviour** (a route backed by PGlite, a DB constraint, a
  migration) → integration (L2).
- **A vendor or customer workflow** (sign-up, connect a repo, install,
  Team Admin) → UI/workflow (L3).
- **AWS API or CloudFormation behaviour itself** (a template change, a
  relay AWS-SDK adapter change) → AWS integration (L4).
- **A complete deployment lifecycle** (release, rollback, failed release,
  recovery, cleanup) → AWS E2E (L5).
- **Production availability** (can Deployz deploy right now, against the
  live control plane) → production canary (L6).

### The compiler-v2 evidence set

The live provisioning path (compile at creation → publish a
content-addressed artifact → relay executes the frozen artifact) is proven
at three separate layers, and only the last touches real AWS:

- **Unit/contract (L1/L2)** — compiler determinism, capability
  composition and stable logical identity
  (`packages/infrastructure-compiler`), and the API's artifact
  publication and INSTALL-parameter tests.
- **Simulated E2E (L3)** — the full product path over the
  `SimulatedCustomerAccount`, including `retained-delete-recovery`
  (DESTROY retains; PURGE removes) and the Phase 4 capability scenarios
  (`multi-worker-sweep`, `mysql-sweep`, `migration-success`,
  `migration-failure`, `phase4-composition`) and the Phase 5
  composition (`phase5-composition`: queues, a dead-letter queue, a
  schedule and a scheduled job).
- **Real AWS (L4+)** — mandatory for release gates: the direct composite
  canary, the version canary's `profile` runs, and the `core` day-2
  ladder. A green simulated suite never substitutes for these. The
  Phase 4 shapes (multiple workers, RDS MySQL, one-shot migrations) have
  no real-AWS qualification yet; their scenario backlog is recorded as
  pending in [`aws-e2e.md`](aws-e2e.md).

Capability composition — not the four historical application templates —
is the primary testing model: tests assert what the compiler composes
from a graph, not which static template variant was selected. The
runtime-v1 parity tests were removed with runtime-v1.

## The escalation policy for coding agents

Follow this order. Do not skip a layer unless you are confident the current
layer cannot establish confidence.

1. **Targeted unit/integration tests.** Run only the relevant tests for the
   package you changed, from the workspace root:
   `pnpm vitest run --project <package-name> <test-file>` (for example
   `pnpm vitest run --project @deployz/api src/retry-eligibility.test.ts`).
   Run from the root — a package without its own Vitest config resolves the
   root `projects` paths incorrectly when invoked from inside the package.
   Do not run the full unit suite during each fix iteration. Use
   `pnpm test:affected` to see the plan CI would run for your current
   changes, and `pnpm test:escalation` to see only the AWS escalation
   commands your changes would suggest.

2. **A targeted simulated E2E check.** Run one scenario
   (`pnpm e2e --scenario=<id>`, choosing the scenario closest to the
   behaviour under test — for example `--scenario=happy-path` for a
   golden-path install, `--scenario=cloudformation-rollback` for rollback
   handling, `--scenario=ecs-failure` for ECS provisioning errors) or one
   spec directly (`pnpm e2e e2e/<file>.spec.ts`). Do not run the entire E2E
   suite during each fix iteration.

3. **The simulated regression suite before merge.** Run `pnpm e2e:scenarios`
   for every scenario, or the fixture-mode suite
   (`node scripts/e2e.mjs --grep-invert "@scenario|visual"`) for a runtime
   UI/API change. CI runs the subset `scripts/test-affected.mjs` selects for
   most pull requests, and the full regression for a critical pull request
   or a push to `main`.

4. **Real AWS, only as an escalation.** Always set
   `DEPLOYZ_E2E_ALLOW_REAL_AWS=1`. Do not launch fresh AWS infrastructure
   merely because deployment-related code changed. `pnpm e2e:canary` — the
   read-only persistent canary — is retired: no standing installation is
   provisioned for it to verify. The version canary
   (`pnpm e2e:canary:versions`) is the only real-AWS product check in
   active use; see [`aws-e2e.md`](aws-e2e.md).

   Escalate to the version canary when a change affects: relay/AWS
   interaction, CloudFormation polling, resource discovery, bootstrap,
   ECS, RDS, Redis/Valkey, ALB, ACM, IAM, infrastructure health, or
   application-stack behaviour.

   Escalate to `fresh` only when: explicitly requested; fundamental
   provisioning behaviour changed; validating a release; validating
   cleanup/destruction; or the version canary cannot provide adequate
   confidence.

   Two rules learned from production outages, both invisible to unit
   tests, CI and the simulator. Both are **required**, not a judgment call:

   - A change to the relay's install/deploy/rollback/destroy/purge
     executors (`packages/relay/src`), the bootstrap template
     (`packages/cdk/src/bootstrap`), the infrastructure compiler or its
     CloudFormation output (`packages/infrastructure-compiler`,
     `packages/contracts` planning), or the relay's enrollment path
     **requires** a real-AWS run before the affected template or artifact
     path is live: `fresh`
     for a bootstrap-only change; the stateless `profile` otherwise; `core`
     for a release, rollback, deploy, destroy or purge change. A wrong
     `GetAtt` and a mis-shaped relay credential each once broke every
     customer install.
   - `pnpm test:affected` prints the exact command for the change you made
     (see [`ci.md`](ci.md) for what the selector detects); judgment is still
     needed only for a change the selector's file-path rules do not cover —
     never to skip an escalation the rule above already requires.

   Real AWS execution requires:

   ```
   DEPLOYZ_E2E_ALLOW_REAL_AWS=1
   ```

   Never bypass this safeguard. A refusal is signal, not friction — never
   set the variable merely to get past a refusal you don't understand.

Do not modify tests merely to make a failing implementation pass. Diagnose
the implementation first.

### AWS failure → simulator regression rule

When a real AWS failure occurs (the version canary, `fresh`, Stage B
repository deployments, or manual AWS testing):

1. Capture the exact AWS state, SDK response, or event sequence.
2. Add a deterministic simulator scenario under `e2e/simulation/scenarios/`
   that reproduces the failure. Reuse `SimulatedCustomerAccount`, the relay
   harness, and the existing scenario registration pattern in
   `scenarios/index.ts`.
3. Reproduce the failure locally through the simulator.
4. Fix the root cause locally.
5. Rerun the simulator to confirm the fix.
6. Confirm once on real AWS.

Scenario files use problem-oriented names, for example
`ecs-target-timeout.ts`, `missing-stack-output.ts`,
`relay-disconnect-during-destroy.ts`.

For every AWS bug, explicitly decide: "Can this AWS failure be represented
in the simulator?" If yes, add the regression scenario before closing the
bug. If no, document why in the bug report. See
[`simulated-e2e.md`](simulated-e2e.md#how-to-add-a-scenario) for the exact
steps.

### Validating Team Admin changes

Team Admin (`docs/admin/team-admin.md`) is simulated-mode only — it never
needs real AWS, since it reads and acts on the same DB and domain workflows
the vendor surfaces already exercise. Validate a change with
`apps/api/src/admin/*.test.ts` (Vitest) for the API layer, plus
`pnpm e2e e2e/admin.spec.ts` for browser coverage (authorization, search,
View as Vendor, failed-deployment diagnosis/recovery). Escalate past
simulated E2E only if the change also touches the underlying domain
workflow's real AWS behaviour — the escalation ladder above still applies
to that workflow, not to the admin wrapper around it.

## Timing expectations

Before this round of CI work, a typical pull request took a median 8.2
minutes (p90 9.3 minutes) to go green: the full Vitest suite alone took
426 seconds, and the E2E job took 5.5 minutes, mostly run in sequence.

After this round (parallel affected-project Vitest, placeholder Lambda
bundling inside the CDK Vitest project, a cached Playwright browser, the
fixture-mode suite sharded across three runners with the scenario suites
in a fourth), measured on the final stack:

| Change | Wall time | Longest job |
| --- | --- | --- |
| docs-only (`minimal`) | about 0.6 min | nothing runs |
| web runtime change (`targeted`: fixture-mode suite + browser scenario specs, 192 + 5 tests) | 5.0 min | E2E shard 1: 272 s |
| full regression (`critical`, push to `main`): every Vitest project, every spec, every scenario | 6.5 min | `test-build`: 365 s |

Before this round the same web change ran fewer tests (the 23 fixture-mode
specs never ran in CI) in 6.1 minutes, and a critical run took 8 to 9
minutes with the full Vitest suite at 426 seconds. The fixture-mode suite is
bound by the dev servers, not by Playwright workers (four workers were no
faster than two), which is why it is sharded rather than parallelised on
one runner.

The CDK Vitest project synthesizes with placeholder Lambda bundling — see
`packages/cdk/vitest.config.ts` — so `pnpm synth:smoke` is the one place
that bundles every Lambda entry point for real; it runs only on the full
regression, not on every targeted pull request.

This change also fixed the `Timeout calling "onTaskUpdate"` flake that had
been failing pushes to `main`: the CDK project's synchronous esbuild calls
were blocking the Vitest worker's RPC channel. Eight consecutive
verification runs after the fix were green.
