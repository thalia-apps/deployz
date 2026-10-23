# CI

What `.github/workflows/ci.yml` runs, and how `scripts/test-affected.mjs`
decides what a change needs when you test it locally. See [`strategy.md`](strategy.md) for the
layer model this classifies into, and
[`simulated-e2e.md`](simulated-e2e.md) for what the Playwright suite itself
does.

## The jobs

CI runs on every push to `main` and on demand (`workflow_dispatch`, for a
manual full-regression run on any branch). Every run is the full
regression.

Until public launch, there is no pull-request CI (a temporary MVP
relaxation, see [`../decisions/README.md`](../decisions/README.md)). A pull
request merges with no required check. The full CI run on `main` is the
gate before production: `release.yml` releases production only after it
passes. To test a branch before a merge, dispatch `ci.yml` on that branch.

### `test-build`

Static checks, unit tests, and integration tests, from the workspace root
so every Vitest project runs in one parallel invocation. Runs `pnpm build`,
then:

- `pnpm typecheck:e2e` — typechecks `e2e/` (Playwright strips types, so
  this is the only place the simulation harness's TypeScript is checked).
- `pnpm test:static` — the static production-safety guards. They check: no
  AWS SDK value-import under `e2e/simulation/`; no product import of `e2e/`;
  no fixture-mode env var, environment-specific value or AWS access key in
  `deploy-api.yml`, `deploy-web.yml` or `release.yml`; each deploy workflow's
  `PATHS` dependency closure; and the per-environment workflow structure (the
  deploy job's Environment and stage gate, no Environment on the gate job,
  the concurrency group, the dispatch default, the tag name, `release.yml`'s
  calling jobs and its staging gate, `id-token: write`, `secrets: inherit`
  only in `release.yml`, and one `COOKIE_PREFIX` for both services).
- `pnpm vitest run` (every project).
- `pnpm lint` (whole workspace).
- `pnpm typecheck:scripts`.
- `pnpm synth:smoke` — the CDK bundling smoke. The Vitest project
  synthesizes with placeholder Lambda bundling, so this is the one proof
  every Lambda entry point still bundles for real.

### `e2e-simulated`

Simulated E2E ([`simulated-e2e.md`](simulated-e2e.md)). Sets fake sentinel
`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_REGION` values at the job
level — a live proof that simulated mode's env-scrubbing strips them from
the API under test, since real credentials never enter CI. The job is a
matrix of four parts: `fixture-1`, `fixture-2`, `fixture-3` and
`scenarios`. The fixture-mode suite is bound by the dev servers, not by
Playwright workers (four workers were no faster than two), so it is
sharded three ways with `--shard=n/3`; the scenario suites run in the
fourth part. Each part builds, installs the Chromium browser (cached by
lockfile hash), then runs its share:

- `fixture-1..3`: `node scripts/e2e.mjs --grep-invert "@scenario|visual"
  --shard=n/3` (every non-visual, non-scenario spec).
- `scenarios`: `node scripts/e2e.mjs --scenarios` (every simulated
  scenario), then `DEPLOYZ_DEFAULT_HTTPS_FIXTURE=true node scripts/e2e.mjs
  e2e/scenario-default-https.spec.ts`.

Each part uploads `test-results/` as an `e2e-simulated-results-<part>`
artifact on failure. The visual suite (`e2e/visual.spec.ts`) never runs
here — its committed snapshots are Windows-generated.

## Change classification

`scripts/test-affected.mjs` maps a change's files (`git diff` against a
base) to one risk level. CI does not run it while there is no pull-request
CI; use it locally (`pnpm test:affected`) to choose the tests to run before
a merge.

- **`minimal`** — every changed file matches the documentation patterns
  (`docs/`, `*.md`, `*.txt`, `*.png`, `LICENSE`, `.gitignore`,
  `.gitattributes`, `.editorconfig`), or nothing changed. No test layer
  runs.
- **`critical`** — the full regression: every Vitest project, both
  typechecks, the static guards, the CDK bundling smoke, every non-visual
  Playwright spec, every simulated scenario, and the default-HTTPS
  scenarios. A change is critical when any changed file:
  - matches root configuration (`package.json`, `pnpm-lock.yaml`,
    `pnpm-workspace.yaml`, `turbo.json`, `vitest.config.ts`,
    `playwright.config.ts`, `tsconfig.base.json`, `eslint.config.mjs`,
    any `.github/workflows/` file, `scripts/e2e.mjs`,
    `scripts/e2e-env.mjs`, `scripts/test-affected.mjs`,
    `scripts/test-affected.test.mjs`, `scripts/production-safety.test.mjs`,
    `e2e/tsconfig.json`, or any `.env*` file);
  - is under an `apps/*` or `packages/*` directory the workspace
    manifests do not name (an unknown workspace package);
  - is under `apps/api/src/` outside the `API_NON_CRITICAL` allowlist
    below (non-test file);
  - is under `packages/relay/src/` (non-test file) — relay code runs in
    the customer's AWS account;
  - is under `packages/contracts/src/` (non-test file) — a shared
    deployment contract;
  - is a DB schema file (`packages/db/src/schema/*`) or a migration
    (`packages/db/drizzle/*`);
  - is under `packages/cdk/src/`, `packages/cdk/bin/`, or
    `packages/cdk/artifacts/` (non-test, non-`packages/cdk/scripts/`) —
    infrastructure code deploys or publishes on merge;
  - is under `e2e/simulation/`, or is `e2e/seed-ready-manifest.ts` — the
    simulation harness backs every scenario;
  - is under an unrecognised `scripts/<dir>/` directory, or an
    unrecognised `e2e/` path;
  - is any other executable path the rules above do not name (fail-safe:
    an unknown path never selects zero tests); or
  - change detection itself failed (no merge-base, a bad `--base`) — the
    fail-safe fallback.
- **`targeted`** — everything else: the affected Vitest projects (with
  every transitive workspace dependent, derived from the package
  manifests — never hand-listed), the harness typecheck when a harness
  imports a changed dependency, and either the touched Playwright specs
  or the fixture-mode Playwright suite.

### The `API_NON_CRITICAL` allowlist

These `apps/api/src/` areas run the API's Vitest project (with its
dependents) and the fixture-mode Playwright suite, not the full
regression, because they do not shape a customer deployment:

- `apps/api/src/admin/`
- `apps/api/src/billing-*.ts`
- `apps/api/src/paddle.ts`
- `apps/api/src/email.ts`
- `apps/api/src/organizations.ts`
- `apps/api/src/ai-*.ts`
- `apps/api/src/jev-shadow.ts`
- `apps/api/src/sentry.ts`
- `apps/api/src/customer-activity.ts`

Every other file directly under `apps/api/src/` is critical by default.

### The `WEB_NO_E2E` paths

These `apps/web/` paths run the web Vitest project only, with no Playwright
coverage, because no spec renders them:

- `apps/web/test/`
- `apps/web/public/`
- `apps/web/src/components/deployz-brand.tsx`
- `apps/web/src/app/icon.*`, `apple-icon.*`, `favicon.*`

Every other `apps/web/` runtime file runs the web project plus the
fixture-mode Playwright suite.

### Derived dependents

The selector reads every `apps/*/package.json` and `packages/*/package.json`,
builds the `@deployz/*` dependency graph, and computes the transitive
reverse-dependency closure at plan time — there is no hand-maintained list
to fall out of date. For example, a change to `apps/api/src/` (an
allowlisted, non-critical file) selects `@deployz/api` **and**
`@deployz/cdk`, because the worker Lambda (`packages/cdk`) imports the API
package. The selector's own self-test (`scripts/test-affected.test.mjs`,
test 5b) asserts the graph has no dependent the manifests do not name.

### `scripts/<dir>` harness projects

`version-canary`, `repository-deployment`, and `run-and-check` each run their
own Vitest project (`SCRIPT_PROJECTS` in `scripts/test-affected.mjs`) plus the
harness typecheck (`pnpm typecheck:scripts`). A change in `run-and-check` also
runs the `repository-deployment` project, because Stage B imports the analysis
session and the recipe contract. `scripts/customer-reset/` runs the harness
typecheck only — it has no Vitest project. Any other unrecognised
`scripts/` directory is critical (fail-safe).

### AWS escalations (never executed)

For a relay or CDK customer-side change, the plan prints — but never
runs — a real-AWS command: the version canary (`core` for a relay
AWS-interface file, the stateless profile otherwise), plus `pnpm e2e:fresh`
for a bootstrap-stack change, and `pnpm canary:fixture-repo && ...` for a
`packages/fixture` change. See [`strategy.md`](strategy.md#the-escalation-policy-for-coding-agents).

## What a push to `main` runs

`test-build` and `e2e-simulated` both run the full regression.

Deploying is a separate concern from testing, but it does gate on CI:
`release.yml` triggers on `workflow_run` of a successful `CI` run for `main`
(a pull-request CI run has the PR branch as `head_branch` and is filtered
out). Until public launch, staging is skipped (a temporary MVP relaxation):
that run releases production only.
It calls `deploy-api.yml` and `deploy-web.yml`, which are reusable
workflows that take an environment and a commit. Each one keeps its own
`gate` job, which checks two things before anything deploys: the commit is
still the tip of `main` (an older run must not deploy over a newer one), and
the commit touches that service's runtime dependency closure (a path filter,
not `ci.yml`'s risk classification — see
`.github/workflows/deploy-api.yml` / `deploy-web.yml` and
[`../operations/control-plane.md`](../operations/control-plane.md)).

Staging deploys only from a `workflow_dispatch` of `release.yml` with
`environment: staging`, and `staging-verify` then polls the staging hosts. Until
public launch, the `production` Environment has no required reviewers, so
the two production jobs deploy without an approval. The deploy job re-checks
the tip of `main` before it deploys, so a commit that is no longer current
fails instead of deploying. Each deploy
holds a concurrency group for its own environment and service, so a staging
deploy never waits for a production deploy. The deploy tag is `deployed/api`
and `deployed/web` for production, and `deployed/staging/api` and
`deployed/staging/web` for staging.

The `deploy` job also runs two fail-closed gates of its own before it changes
anything: it refuses a blank required value from its GitHub Environment, and
it refuses a value that belongs to another stage (the rules are in
[`../operations/control-plane.md`](../operations/control-plane.md#environments-and-the-stage-gate)).
A direct `workflow_dispatch` run on one deploy workflow is the per-service
path, and it still skips both `gate` checks. When validating a production
change, record the SHA and confirm both the CI run and the release run
finished, rather than assuming one implies the other.

## The run-and-check image build

`.github/workflows/runcheck-build.yml` builds one third-party repository
image on an x86_64 runner for the Docker run-and-check test. It starts only
by hand (`workflow_dispatch`) with `repo`, `commit`, `dockerfile`, `context`
and `build_args`. It validates each input, uses no repository secrets and
has only `contents: read`. It uploads the image as a `docker save` artifact
for 7 days. Use it for the heavy repositories and after an emulation failure
on an ARM machine.

`.github/workflows/runcheck-exam.yml` runs the run-and-check exam itself on
x86_64 runners, one matrix job for each recipe (at most 20 at the same
time). It starts only by hand with `mode` (`observe` or `full`), `repos`
(`all` or recipe ids) and `analysis` (the analyser folder for `full`). It
validates each input, uses no repository secrets, has only `contents: read`
and does not keep Git credentials in the checkout. It uploads one JSON result
for each recipe for 14 days. `pnpm runcheck:fetch --run <run id>` downloads
them ([`compatibility.md`](compatibility.md#the-exam-on-x86_64-runners)).

## Timing expectations

See [`strategy.md`](strategy.md#timing-expectations) for the measured
numbers. In short: a push to `main` takes about 10 to 16 minutes, bound by
`test-build`'s full Vitest run and the fixture shards.

## Troubleshooting

- **A lone Playwright timeout on a busy runner is usually load, not a
  regression.** Rerun the failing spec in isolation
  (`pnpm e2e e2e/<file>.spec.ts` or `pnpm e2e --scenario=<id>`) before
  treating it as real.
- **The Turbo cache** (`.turbo/`, keyed on `runner.os` and the commit SHA,
  falling back to the most recent `turbo-<os>-` prefix) lets `pnpm build`
  and `pnpm lint` reuse task outputs from an earlier run; Turbo verifies
  task hashes, so a partial restore stays safe. Tests never read from this
  cache — they always run through `vitest` directly.
- **Re-running:** use `workflow_dispatch` on `ci.yml` for a manual
  full-regression run on any branch (useful for confirming a flake is
  fixed, independent of any pull request).
- **Preview a plan locally** without pushing:
  `node scripts/test-affected.mjs --files=a,b,c` (comma- or
  space-separated paths), or `pnpm test:affected` to plan against your
  current local changes.

## How to add a rule

Edit the lists at the top of `scripts/test-affected.mjs` —
`ROOT_CONFIG`, `DOC_FILE`, `WEB_NO_E2E`, `API_NON_CRITICAL`,
`CDK_CUSTOMER_SIDE`, `RELAY_AWS_INTERFACE`, or `SCRIPT_PROJECTS` — and add
a case to `scripts/test-affected.test.mjs` asserting the new rule's risk
level and layers. If the new rule names a path (as `API_NON_CRITICAL` and
`CDK_CUSTOMER_SIDE` do), add it to `VERIFIED_PATHS` too — test 17
(`every path the rules name exists on disk`) fails the build if a listed
path stops existing.

## Workflow supply chain

Every third-party `uses:` in `.github/workflows/` is pinned to a commit SHA
with the tag in a trailing comment; `.github/dependabot.yml` proposes weekly
updates for npm, GitHub Actions and the web Dockerfile base image. Values that
a pull request or a dispatch input controls reach a `run:` step through
`env:`, never through `${{ }}` expansion in the script. `.github/CODEOWNERS`
names the owners of `.github/`, `packages/cdk/` and `apps/api/src/server.ts`.
