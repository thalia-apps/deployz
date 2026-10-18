# Deployz

Deployz lets a B2B software vendor run its web application inside each
customer's own AWS account: connect a GitHub repository, let Deployz analyze
it and build releases, hand each customer an install link, and operate every
customer deployment from one dashboard. The customer approves one
CloudFormation Quick Create stack; a small relay Lambda inside their account
does all the AWS work, and Deployz never holds their credentials.

**Documentation:** start at [`docs/README.md`](docs/README.md). Product
scope is in [`docs/product/mvp-scope.md`](docs/product/mvp-scope.md), the
architecture in [`docs/architecture.md`](docs/architecture.md).

This repository is the monorepo for the Deployz MVP: pnpm workspaces +
Turborepo, TypeScript strict, Vitest, ESLint flat config.

## Layout

| Path | Package | Purpose |
| --- | --- | --- |
| `apps/web` | `@deployz/web` | Next.js vendor dashboard (applications, releases, customers, deployments), the customer install/security pages, and the Team Admin support console |
| `apps/api` | `@deployz/api` | Fastify control-plane API (auth, GitHub, analysis, deployment lifecycle, relay channel, billing, admin) |
| `packages/contracts` | `@deployz/contracts` | Shared Zod contracts between api, web, and the deployment machinery (regions, manifests, components, plans, profiles, footprint, pricing) |
| `packages/db` | `@deployz/db` | Drizzle schema + migrations |
| `packages/cdk` | `@deployz/cdk` | Control-plane AWS CDK stack (API/worker Lambda, SQS, CodeBuild pipeline), the customer bootstrap and application stacks, the committed template artifacts and the publish scripts |
| `packages/analysis` | `@deployz/analysis` | Pure repository-analysis core (detectors, rejection checks, readiness/manifest rules, remediation) |
| `packages/relay` | `@deployz/relay` | Relay Lambda (fixed-vocabulary customer-account actor: install/deploy/destroy/purge/domain executors) |
| `packages/copy-map` | `@deployz/copy-map` | Copy/message mapping helpers (failure-code copy, recoverability, event labels) |
| `packages/fixture` | `@deployz/fixture` | The fixture container application used by the real-AWS version canary |
| `e2e/` | — | Playwright specs and the simulated customer AWS account |
| `scripts/` | — | The E2E runner, risk-based test selection, and the real-AWS harnesses (version canary, repository benchmarks, customer reset) |

## Commands

Run from the repo root:

- `pnpm install` — install all workspace dependencies
- `pnpm build` — build every package via Turborepo (`tsc` emit to `dist/`); required before the first `pnpm e2e` and after editing a package the API or relay harness imports
- `pnpm vitest run` — run all tests (Vitest projects: `packages/*`, `apps/*`, the `scripts/*` harnesses)
- `pnpm lint` — lint every package
- `pnpm dev` — run every package's persistent dev script
- `pnpm e2e` — the simulated end-to-end suite (no AWS credentials); `pnpm e2e --scenario=<id>` for one scenario, `pnpm e2e:scenarios` for the full regression suite
- `pnpm test:affected` / `pnpm test:escalation` — risk-based test selection for a change

No Docker or Postgres is needed locally: without `DATABASE_URL` the API uses
a file-backed PGlite store. See
[`docs/testing/README.md`](docs/testing/README.md) for the full test ladder,
including the opt-in real-AWS modes, and
[`docs/operations/control-plane.md`](docs/operations/control-plane.md) for
local-development notes.

## Deploying the control plane

**Deploys run in CI, not from a laptop.** A push to `main` starts
`.github/workflows/release.yml` after CI succeeds. It deploys the
control-plane stack and the web app to staging, waits for a reviewer's
approval, and then deploys the same commit to production;
`.github/workflows/deploy-api.yml` and `deploy-web.yml` do the work. A hand-run
`cdk deploy` would replace the production Lambda environment with the local
`.env`, so `packages/cdk/bin/deployz.ts` refuses to run outside GitHub
Actions; use `-c local=true` only to `synth` or `diff`. The bootstrap
template is republished by hand with `publish:bootstrap`.
The procedure, every configuration key, and how a Region is enabled are in
[`docs/operations/control-plane.md`](docs/operations/control-plane.md); the
reasoning is in [`docs/decisions/deploy-gate.md`](docs/decisions/deploy-gate.md).

## Module-resolution scheme

One base config (`tsconfig.base.json`, `strict: true` plus strict-adjacent flags), two per-package flavors:

- **NodeNext** (`module`/`moduleResolution: "NodeNext"`) for packages that run directly on Node: `apps/api`, `packages/cdk`, `packages/fixture`, `packages/relay`, `packages/analysis`. Relative imports in these packages must use explicit `.js` extensions.
- **Bundler** (`module: "ESNext"`, `moduleResolution: "Bundler"`) for libraries and the web app: `apps/web`, `packages/contracts`, `packages/db`, `packages/copy-map`. Extensionless relative imports allowed; if one of these is later consumed directly by Node (unbundled), switch it to NodeNext or add `.js` extensions.

Every package builds with `tsc -p tsconfig.json` emitting ESM + declarations to `dist/`. Tests (`src/**/*.test.ts`) are excluded from build emit; Vitest runs them from source.

## CI

`.github/workflows/ci.yml` runs on every push and pull request to `main`. A
`plan` job classifies a pull request with `scripts/test-affected.mjs`
(`minimal` for docs-only changes, `targeted`, or `critical`; the `ci:full`
label forces `critical`); `test-build` runs `pnpm install --frozen-lockfile`,
`pnpm build`, `pnpm typecheck:e2e`, the selected (or every) Vitest project,
lint, `pnpm typecheck:scripts` and, for the full regression, `pnpm
synth:smoke`; `e2e-simulated` runs the selected Playwright specs, and for
pushes to `main` and critical pull requests every non-visual spec, the full
scenario suite and the default-HTTPS scenarios. Real AWS never enters CI;
the real-AWS canary is the separate `workflow_dispatch` workflow
`aws-canary.yml`. See [`docs/testing/README.md`](docs/testing/README.md).
