# CI

What `.github/workflows/ci.yml` runs, and how `scripts/test-affected.mjs`
decides what a pull request needs. See [`strategy.md`](strategy.md) for the
layer model this classifies into, and
[`simulated-e2e.md`](simulated-e2e.md) for what the Playwright suite itself
does.

## The jobs

CI runs on every pull request to `main`, every push to `main`, and on
demand (`workflow_dispatch`, for a manual full-regression run on any
branch).

### `plan` (pull requests only)

Runs `node --test scripts/test-affected.test.mjs` (the selector's own
self-test — it must pass before the plan is trusted), then
`node scripts/test-affected.mjs --base=<PR base SHA> --format=json
--github-output`, adding `--full` when the pull request carries the
`ci:full` label. It publishes the plan as job outputs (`risk`,
`unit_projects`, `lint_packages`, `playwright`, `playwright_files`,
`typecheck_scripts`) and writes a short job summary: the risk level, the
reasons, the Vitest projects, the Playwright mode, and any AWS escalation
commands. A push to `main` or a manual run skips this job entirely — there
is no PR base to diff against, so `test-build` and `e2e-simulated` run
their full-regression branch instead.

### `test-build`

Static checks, unit tests, and integration tests, from the workspace root
so every selected Vitest project runs in one parallel invocation. Runs
`pnpm build` (skipped only for a `minimal` PR), then:

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
- `pnpm vitest run` (every project) on a push, a manual run, or a
  `critical` PR; otherwise `pnpm vitest run --project <p>` for each
  project the plan selected (`unit_projects`).
- `pnpm lint` (whole workspace) on a push, a manual run, or a `critical`
  PR; otherwise `pnpm turbo run lint --filter=<p>` for each package the
  plan selected (`lint_packages`).
- `pnpm typecheck:scripts` when the plan set `typecheck_scripts`, or
  always on a push/manual run/critical PR (a harness script imports a
  workspace package that changed, or the harness's own directory
  changed).
- `pnpm synth:smoke` — the CDK bundling smoke — only on the full
  regression (push, manual run, or `critical`). The Vitest project
  synthesizes with placeholder Lambda bundling, so this is the one
  pre-merge proof every Lambda entry point still bundles for real.

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
lockfile hash), then runs its share of the mode the plan selected
(`playwright`, or `full` on a push/manual run/critical PR):

| Mode | `fixture-1..3` | `scenarios` |
| --- | --- | --- |
| `full` | `node scripts/e2e.mjs --grep-invert "@scenario\|visual" --shard=n/3` (every non-visual, non-scenario spec) | `node scripts/e2e.mjs --scenarios` (every simulated scenario), then `DEPLOYZ_DEFAULT_HTTPS_FIXTURE=true node scripts/e2e.mjs e2e/scenario-default-https.spec.ts` |
| `fixture` | the same three shards | `node scripts/e2e.mjs e2e/scenario-ui.spec.ts e2e/scenario-release-unavailable.spec.ts <playwright_files>` (the two browser-driven scenario specs, plus any scenario spec the change touched directly) |
| `files` | `fixture-1` runs `node scripts/e2e.mjs <playwright_files>`; the other parts finish in seconds without setup | nothing |
| `none` | the job is skipped | |

Skipped entirely on a `minimal` PR. Each part uploads `test-results/` as
an `e2e-simulated-results-<part>` artifact on failure. The visual suite
(`e2e/visual.spec.ts`) never runs here — its committed snapshots are
Windows-generated.

### `pr-gate`

The required status check for pull requests. Fails when `plan`,
`test-build`, or `e2e-simulated` failed or was cancelled, when no plan was
published, or when the plan selected Playwright coverage (`playwright !=
'none'`) but `e2e-simulated` was skipped. A job that was intentionally
skipped (for example the whole `e2e-simulated` job on a docs-only PR)
does not fail the gate on its own.

## Change classification

`scripts/test-affected.mjs` maps the pull request's changed files (`git
diff` against the PR base) to one risk level.

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

`version-canary`, `repository-compatibility`, `repository-deployment`, and
`jev-eval` each run their own Vitest project (`SCRIPT_PROJECTS` in
`scripts/test-affected.mjs`) plus the harness typecheck
(`pnpm typecheck:scripts`). `scripts/customer-reset/` runs the harness
typecheck only — it has no Vitest project. Any other unrecognised
`scripts/` directory is critical (fail-safe).

### AWS escalations (never executed)

For a relay or CDK customer-side change, the plan prints — but never
runs — a real-AWS command: the version canary (`core` for a relay
AWS-interface file, the stateless profile otherwise), plus `pnpm e2e:fresh`
for a bootstrap-stack change, and `pnpm canary:fixture-repo && ...` for a
`packages/fixture` change. See [`strategy.md`](strategy.md#the-escalation-policy-for-coding-agents).

## The `ci:full` label

Applying the `ci:full` label to a pull request passes `--full` to the
selector, which forces `critical` regardless of what changed. Use it to
verify a flake fix or to measure the full suite's timing on a small
change.

## What a push to `main` runs

There is no `plan` job (no PR base to diff against). `test-build` and
`e2e-simulated` both take the full-regression branch unconditionally —
the same set a `critical` pull request runs. `pr-gate` does not run either
(it is `if: github.event_name == 'pull_request'`).

Deploying is a separate concern from testing, but it does gate on CI now:
`release.yml` triggers on `workflow_run` of a successful `CI` run for `main`
(a pull-request CI run has the PR branch as `head_branch` and is filtered
out). It calls `deploy-api.yml` and `deploy-web.yml`, which are reusable
workflows that take an environment and a commit. Each one keeps its own
`gate` job, which checks two things before anything deploys: the commit is
still the tip of `main` (an older run must not deploy over a newer one), and
the commit touches that service's runtime dependency closure (a path filter,
not `ci.yml`'s risk classification — see
`.github/workflows/deploy-api.yml` / `deploy-web.yml` and
[`../operations/control-plane.md`](../operations/control-plane.md)).

Staging deploys first. `staging-verify` then polls the staging hosts, and the
two production jobs wait for a reviewer's approval on the `production`
Environment. The deploy job re-checks the tip of `main` after the approval, so
a commit that is no longer current fails instead of deploying. Each deploy
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

## Timing expectations

See [`strategy.md`](strategy.md#timing-expectations) for the measured
numbers. In short: a `minimal` (docs-only) PR finishes in well under a
minute; a `targeted` web PR takes about 5 minutes (the three fixture
shards and the browser scenario specs run in parallel with `test-build`);
a `critical` PR or a push to `main` takes about 6.5 minutes, bound by
`test-build`'s full Vitest run.

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
- **Reading the plan:** the `plan` job's step summary shows the risk
  level, the reasons, the selected Vitest projects, the Playwright mode,
  and any AWS escalation commands — read it before re-running anything.
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
