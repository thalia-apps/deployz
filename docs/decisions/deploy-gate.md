# Control-plane deploys run only from CI (2026-08-25)

**Status:** active. Implemented in `packages/cdk/src/deploy-gate.ts`, wired
in `packages/cdk/bin/deployz.ts`, tested by
`packages/cdk/test/deploy-gate.test.ts`. The operating procedure is in
[`../operations/control-plane.md`](../operations/control-plane.md).

## The incident

On 2026-08-25 a `cdk deploy Deployz` run from a developer machine would have
pushed that machine's `.env` into production. `collectEnvVars()` in
`packages/cdk/src/deployz-stack.ts` copies an allowlist out of `process.env`
and the result **replaces** the Lambda environment rather than merging with
it. Measured against the maintainer's `.env` at the time, a hand-run deploy
would have:

| Effect | Keys |
| --- | --- |
| Shipped localhost into production | `BETTER_AUTH_URL=http://localhost:3001` |
| Overwritten production secrets with development ones | `BETTER_AUTH_SECRET`, billing keys, `GITHUB_*` |
| Deleted from the running function | `API_URL`, `WEB_URL`, `MARKETING_URL`, `COOKIE_DOMAIN`, `EMAIL_FROM`, SES keys |
| Taken the API offline | `API_DOMAIN_NAME` / `API_CERTIFICATE_ARN` unset removes the `api.deployz.dev` domain mapping |

The gitignored `.env.production` override that the entrypoint loads was
documentation only: it did not exist on the machine. CI was never the leak
path; `deploy-api.yml` supplies every allowlisted key from repository
secrets on a runner with no `.env`.

## The decision

Refuse to run the control-plane CDK app outside GitHub Actions. The gate is
a pure function, `checkDeployGate({ env, allowLocal })`, allowed when
`env.GITHUB_ACTIONS === 'true'` or when the `local` CDK context key is
present. The refusal message names the workflow and the escape hatch.

- **`GITHUB_ACTIONS`, not `CI`.** `CI=true` is set by a wide range of local
  tooling and would silently open the gate; only a GitHub runner sets
  `GITHUB_ACTIONS`.
- **`-c local=true` keeps `synth` and `diff` usable.** The CDK CLI gives the
  app no indication of which command invoked it, so a check inside the app
  blocks `synth`, `diff` and `deploy` alike or none of them. The flag
  therefore also lets a deliberate local `deploy` through; that trade is
  accepted. Any value of `local` opens the gate, not only `true`.
- **Deliberately bypassable.** The risk addressed is habit and muscle memory
  (a person or an agent running the command the README used to recommend),
  not a determined operator.

## Rejected alternatives

- **Validate the environment and refuse when it looks local.** Catches the
  accident but leaves the hand-deploy path open and must keep pace with
  every new allowlisted key.
- **Enforce on the AWS side** (bootstrap-role trust policy, stack policy,
  SCP). Real enforcement, but the local AWS profile is the account root,
  which bypasses IAM entirely; a genuine wall needs an Organizations SCP and
  a move off root credentials. Out of scope for the MVP.

## Consequences

- `BOOTSTRAP_TEMPLATE_URL`, `DEPLOYABLE_AWS_REGIONS`, `DOCKERHUB_SECRET_NAME`,
  `POLAR_ENVIRONMENT`, `BILLING_ENFORCEMENT` and `BOOTSTRAP_REPUBLISH` are
  GitHub repository **variables** read by the workflow, because CI is the
  only route to change the running environment.
- The workflow's completeness gate refuses to deploy when any required value
  is blank, because a blank value would strip that capability from the
  running API rather than leave it alone.
- Defense in depth remains: the entrypoint still loads `.env.production`
  with override when it exists.
