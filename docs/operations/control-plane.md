# Operating the control plane

How the Deployz control plane is deployed and configured, how customer
templates are published, and how a Region is enabled. Architecture context:
[`../architecture.md`](../architecture.md). Decision record for the CI-only
rule: [`../decisions/deploy-gate.md`](../decisions/deploy-gate.md).

## Deploys run in CI, never from a laptop

`.github/workflows/deploy-api.yml` deploys the `Deployz` CDK stack (VPC, RDS,
API Lambda, SQS queue and worker Lambda, the CodeBuild/ECR release pipeline,
the KMS key, the public template bucket) for a push to `main` that touches
`apps/api`, `packages/{cdk,db,contracts,analysis,relay,copy-map}` or the
lockfile. `.github/workflows/release.yml` calls it after the CI workflow
succeeds, once for each stage it releases, and it can also be dispatched on
its own from the Actions tab for one service (see *Promotion, approval and
rollback*). A commit that is no longer the tip of `main` when its CI finishes
is not deployed; the newer commit's run deploys instead. One deploy runs at a
time for each environment. It:

1. supplies the Lambda's **entire** environment from the deploy job's GitHub
   Environment and the repository secrets (`collectEnvVars()` in
   `packages/cdk/src/deployz-stack.ts` replaces the deployed environment; a
   key that is absent is deleted from the running function);
2. refuses to deploy when any of the required values is blank
   (`CDK_DEFAULT_ACCOUNT`, `API_CERTIFICATE_ARN`, `BETTER_AUTH_SECRET`, the
   GitHub OAuth and App keys, the SES keys, the four Cloudflare keys,
   `DEPLOYZ_STAGE`, the public URLs, the API domain and the template-bucket
   prefix);
3. refuses when a value does not match the stage (see *Environments and the
   stage gate*);
4. refuses when `PADDLE_API_KEY` is set but the other Paddle values are not;
5. builds, runs `cdk deploy --all` (the app holds one stack, and its id comes
   from `DEPLOYZ_STAGE`; production is `Deployz`), then checks that
   `API_DOMAIN_NAME` is a DNS-only CNAME to the regional API domain the stack
   exports. A missing record, a wrong target or a proxied record fails the
   deploy here, and names the record to create, instead of as a readiness
   timeout. It then polls `<API_URL>/health/ready` (database and schema) for
   up to five minutes. `CREATE_COMPLETE` alone can hide an initialization crash
   (a failed migration, a missing KMS key ARN); the readiness poll is the
   real check;
6. optionally republishes the bootstrap template to every deployable Region
   (see below).

`packages/cdk/bin/deployz.ts` refuses to run outside GitHub Actions. To
inspect the stack locally:

```bash
pnpm --filter @deployz/cdk exec cdk diff Deployz -c local=true
```

The `local` context flag also re-enables `deploy`; it exists for previewing,
not shipping.

`deploy-web.yml` builds `apps/web` into a container and ships it to the
Lightsail container service behind `app.deployz.dev`, for a push to `main`
that touches `apps/web`, `packages/{copy-map,contracts}` or the lockfile,
then checks that `APP_HOST` and `MARKETING_HOST` resolve to the container
service, and then checks `https://app.deployz.dev/healthz`. Each push stores
a new image in the container service, and Lightsail refuses a push when the
service holds 150 images. Before each push, the workflow deletes all images
except the newest 10 and the image that a current or pending deployment runs.
`release.yml` waits for CI; a red CI run on `main` deploys nothing. When
validating a production change, record the SHA and confirm the release run
finished.

There are no CloudWatch alarms and no paging on the control plane. The SQS
dead-letter queue (three delivery attempts, three-day retention) is
inspected by hand when a job goes missing; the worker's structured logs
name the message id.

### Deploy identity

GitHub Actions assumes one IAM role for each GitHub Environment with OIDC.
Neither deploy workflow holds an AWS access key. Each role trusts only the
subject `repo:thalia-apps@342445206/deployz@1339375286:environment:<name>`
(GitHub's immutable subject, with the owner and repository ids) with the audience
`sts.amazonaws.com`. A job in another repository, or a job that declares no
Environment, therefore gets no credentials.

Each role may read the CDK bootstrap version parameter, assume the
`cdk-hnb659fds-*` bootstrap roles that make every stack change, locate and
write objects in its own stage's template buckets (`s3:GetBucketLocation`,
`s3:PutObject`, `s3:GetObject`), call `cloudformation:ValidateTemplate`, and
make the nine Lightsail container-service calls the web deploy needs. It holds
no other service permission.

[`../../.github/aws/github-oidc.yaml`](../../.github/aws/github-oidc.yaml)
creates both roles. The account owner deploys it by hand, with an admin
identity:

```bash
aws cloudformation deploy \
  --template-file .github/aws/github-oidc.yaml \
  --stack-name deployz-github-oidc \
  --capabilities CAPABILITY_NAMED_IAM
```

The stack outputs both role ARNs. Set each one as the variable
`AWS_DEPLOY_ROLE_ARN` on the Environment with the same name. A run without it
fails in the completeness gate, before any AWS call.

Two limits are known. Both roles may assume the shared `cdk-hnb659fds-*`
bootstrap roles, so the staging role could deploy the production stack. The
Lightsail statement is account-wide, because a container-service ARN carries
the service id and not the service name and the services carry no tag, so the
staging role could also deploy production's container service. The live
control is the stage gate and the protection rules on the `production`
Environment. A second AWS account is the post-MVP fix.

### Promotion, approval and rollback

`.github/workflows/release.yml` is the one entry point for a release. It runs
after a successful CI run for a push to `main` and releases in this order:
the staging API and the staging web app in parallel, then `staging-verify`,
then the production API and the production web app in parallel.
`staging-verify` polls staging's `<API_URL>/health/ready`,
`https://<APP_HOST>/healthz` and `https://<MARKETING_HOST>/`. It is the only
check of the marketing host, because `deploy-web.yml` polls the dashboard
host alone.

The approval gates the two production deploy jobs, and nothing else. It comes
from the required reviewers on the `production` Environment, which both called
deploy jobs declare, so both jobs wait together and one approval releases both
services. Staging needs no approval.

Each deploy records the commit it shipped in its own tag: `deployed/api` and
`deployed/web` for production, `deployed/staging/api` and
`deployed/staging/web` for staging. The next `gate` run for that environment
compares against its own tag, so a staging deploy can never decide what
production deploys next. Each deploy job also holds its own concurrency group,
`deploy-<environment>-api` and `deploy-<environment>-web`, so a staging deploy
never waits for a production deploy, and no group ever cancels a running
deploy.

An approval can arrive after a newer merge. The production deploy job
therefore re-reads the tip of `main` after the approval and fails when the
commit has moved, instead of deploying a stale commit. The run then names the
newer commit: approve the pending run for it, or dispatch the deploy with that
SHA.

Either deploy workflow can also be dispatched on its own, for one service.
That is the rollback path, and it skips both `gate` checks:

```bash
gh workflow run deploy-api.yml --ref main -f environment=production -f sha=<commit>
```

The `environment` input defaults to `staging`, so a dispatch that names no
environment deploys staging.

## Configuration keys

Names only. Every environment-specific value is a variable on the GitHub
Environment with the same name as the stage (`production`, `staging`); a
credential stays a repository secret. A key the Environment does not hold
arrives as a blank value, and a blank value stops the deploy. Everything the
API reads is validated in `apps/api/src/env.ts`.

| Group | Keys | Notes |
| --- | --- | --- |
| Stage | `DEPLOYZ_STAGE` (variable) | Selects the stack id and every stage-derived resource name. The stage gate refuses a deploy when it does not equal the Environment's own name. |
| Deploy identity | `AWS_DEPLOY_ROLE_ARN` (variable) | The IAM role GitHub Actions assumes with OIDC; one role for each Environment (see *Deploy identity*). A variable and not a secret: a role ARN is no credential, and a masked value would hide which role a run assumed. |
| Public URLs | `API_URL`, `WEB_URL`, `MARKETING_URL`, `COOKIE_DOMAIN`, `COOKIE_PREFIX`, `BETTER_AUTH_URL`, `EMAIL_FROM` | Variables on the GitHub Environment. `COOKIE_PREFIX` is optional. It changes the session-cookie name. A different name keeps a second control plane in the same cookie domain out of this one's session. Production leaves the variable empty, so it keeps Better Auth's default cookie name. Build the web image with the same value as the `NEXT_PUBLIC_COOKIE_PREFIX` build argument, or the dashboard looks for a cookie name the API never sets. |
| API domain | `API_DOMAIN_NAME`, `API_CERTIFICATE_ARN` | Both required or the `api.deployz.dev` mapping is removed. The certificate is requested out of band; the Cloudflare `api` CNAME must be DNS-only or TLS fails with 525. |
| Auth and GitHub | `BETTER_AUTH_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_INSTALL_URL` | The GitHub App's **Setup URL** must be `<WEB_URL>/github/setup` with "Redirect on update" enabled; that page binds the installation to the vendor's organisation and offers sign-in when needed. An installation already bound to another organisation is never rebound (the vendor lands on `?github=failed`); restoring a wrong binding is an operator DB edit. |
| Email | `AWS_SES_ACCESS_KEY_ID`, `AWS_SES_SECRET_ACCESS_KEY` | Organisation membership email only |
| Default HTTPS | `CLOUDFLARE_ZONE_ID`, `CLOUDFLARE_ZONE_NAME`, `DEPLOYZ_DEFAULT_HOSTNAME_PREFIX`, `CLOUDFLARE_ZONE_EDIT_API_TOKEN` | [`../networking-and-https.md`](../networking-and-https.md) |
| AI | `AI_GATEWAY_BASE_URL`, `AI_PROVIDER_API_KEY`, `AI_MODEL` (optional), `AI_GATEWAY_TOKEN` (only for an authenticated gateway) | Unset is safe: deterministic copy is served |
| Fix instructions | `FIX_INSTRUCTIONS_AI_PROVIDER` (repository variable: `openrouter` or `gateway`; the deploy uses `gateway` when unset), `FIX_INSTRUCTIONS_AI_MODEL` (repository variable, optional; OpenRouter only), `OPENROUTER_API_KEY` (secret) | No fallback model: a provider without its credentials answers 503 for fix instructions only, with `details.reason: not_configured`; a local API names the missing setting. `gateway` is the rollback to the shared gateway and `AI_MODEL` |
| Customer templates | `BOOTSTRAP_TEMPLATE_URL` (variable), `DEPLOYABLE_AWS_REGIONS` (variable), `BOOTSTRAP_REPUBLISH` (variable), `DEPLOYZ_TEMPLATE_BUCKET_PREFIX` (variable) | See *Publishing customer templates*. `DEPLOYZ_TEMPLATE_BUCKET_PREFIX` names this stage's regional buckets for the republish step; the Lambda's own copy comes from CDK. |
| Web deploy (`deploy-web.yml`) | `LIGHTSAIL_SERVICE_NAME`, `API_URL`, `APP_HOST`, `MARKETING_HOST`, `COOKIE_PREFIX`, `DEPLOYZ_STAGE` | Variables on the same Environment. `APP_HOST` and `MARKETING_HOST` are bare hostnames. The service name is also the local image tag, so a build for one stage cannot be pushed under another stage's name. |
| Release builds | `DOCKERHUB_SECRET_NAME` (variable) | [`../docker-hub-credentials.md`](../docker-hub-credentials.md). Unresolvable name fails every build; empty means unset. |
| Billing | `PADDLE_API_KEY`, `PADDLE_WEBHOOK_SECRET`, `PADDLE_CLIENT_TOKEN`, `PADDLE_PRICE_PLATFORM`, `PADDLE_PRICE_DEPLOYMENT`, `PADDLE_ENVIRONMENT` (variable, defaults to `sandbox`), `BILLING_ENFORCEMENT` (variable; `off` pauses the production-deployment subscription gate) | [`../billing/paddle-billing.md`](../billing/paddle-billing.md) |
| Secrets | `DEPLOYZ_KMS_KEY_ARN` | Set by CDK from the stack's own key; the API fails to start without it |
| Set by CDK | `DATABASE_URL`, `JOB_QUEUE_URL`, `DEPLOYZ_ECR_REPOSITORY_NAME`, `BUILD_LOG_GROUP_NAME`, `SOURCE_BUCKET`, `BUILD_PROJECT_NAME` | Not in the workflow. CDK also gives the Lambda `DEPLOYZ_TEMPLATE_BUCKET_PREFIX` outside production; in production the API defaults it to `deployz-templates`. |

`TEAM_ADMIN_EMAILS` and `GITHUB_FIXTURE_MODE` are local-development only and
are ignored or excluded inside Lambda. Production Team Admin access is
`user.platform_role = 'ADMIN'`, set by SQL
([`../admin/team-admin.md`](../admin/team-admin.md)). The `JEV_*` keys are
allowlisted but never set; Jev is off in production by decision.

## Staging

A staging control plane is a second stack of the same CDK app in the same AWS
account and Region. `DEPLOYZ_STAGE` (or `-c stage=staging`) selects the stage.
It gives the stack its own id and its own account-unique names
(`packages/cdk/src/stage.ts`):

| Name | Production | Staging |
| --- | --- | --- |
| Stack id | `Deployz` | `DeployzStaging` |
| KMS alias | `alias/deployz-config-secrets` | `alias/deployz-staging-config-secrets` |
| ECR repository | `deployz-images` | `deployz-staging-images` |
| Template bucket prefix | `deployz-templates` | `deployz-staging-templates` |

Each stage's names are written out, not derived with a suffix. The KMS key
and the ECR repository are `RemovalPolicy.RETAIN`: a rename leaves every
stored ciphertext unreadable and every stored image unreachable. The staging
bucket prefix is `deployz-staging-templates`, not
`deployz-templates-staging`, because the API's S3 grant is a wildcard on
`<prefix>-*` and a staging bucket must stay outside production's grant.

An unknown stage value fails the synth; it never falls back to production's
names. `cdk diff -c local=true -c stage=staging` previews the staging stack.

Staging shares the `deployz.dev` Cloudflare zone, so it needs its own
default-hostname prefix (`DEPLOYZ_DEFAULT_HOSTNAME_PREFIX=s-`) and its own
session-cookie name (`COOKIE_PREFIX`).

### Environments and the stage gate

There are two GitHub Environments, `production` and `staging`. Each one holds
the variables for its own stage. Both deploy jobs declare the Environment
they deploy, and the caller chooses it with the `environment` input. The
`production` Environment allows the `main` branch only and needs a reviewer's
approval. That approval gates the two production deploy jobs inside the
release run, after the staging verification (see *Promotion, approval and
rollback*). The `staging` Environment allows any branch and needs no
approval.

The step *Verify the environment values match the stage* then refuses a
deploy whose values belong to another stage. It reports every violation at
once. The rules are:

- `DEPLOYZ_STAGE` equals the stage the job is allowed to deploy.
- `API_URL` is `https://` and `API_DOMAIN_NAME`, and `BETTER_AUTH_URL` equals
  `API_URL`.
- `COOKIE_DOMAIN` starts with a dot, and `API_DOMAIN_NAME` ends with it.
- `DEPLOYZ_DEFAULT_HOSTNAME_PREFIX` is lowercase letters or digits and a
  trailing dash.
- In the web deploy, `API_URL` starts with `https://` and carries no path, and
  `APP_HOST` and `MARKETING_HOST` are bare hostnames.
- Outside production, every host, cookie and service name the stage owns
  carries the stage name, and `DEPLOYABLE_AWS_REGIONS` is the control-plane
  Region only.
- Outside production, `DEPLOYZ_DEFAULT_HOSTNAME_PREFIX` without its trailing
  dash starts the stage name (`s-` for `staging`). Every control plane in the
  shared Cloudflare zone must mint its default hostnames under its own
  prefix, so a stage that keeps production's `d-` is refused. A later stage
  whose name starts with `d` fails this rule. That is the intended signal:
  two control planes in one zone cannot share a prefix.
- In production, none of those values carries another stage's name, and
  `COOKIE_PREFIX` is empty.

A non-production stage must carry its own name in every host and name it
owns. A value without the stage name in it can only belong to another stage,
so the gate catches a production value in a staging Environment without any
workflow file naming a production value.

### Prerequisites an operator must do first

CDK cannot create these; the deploy fails or the environment is unusable
without them.

1. An ACM certificate for `api.staging.deployz.dev` in `us-east-1`, validated
   by a DNS-only Cloudflare CNAME. A proxied record fails TLS with 525.
2. A Lightsail certificate for `app.staging.deployz.dev` and
   `staging.deployz.dev`.
3. The S3 bucket `deployz-staging-templates-us-east-1`, with public read.
4. A "Deployz Staging" GitHub App and a separate OAuth app, both pointed at
   the staging hosts.
5. A new `BETTER_AUTH_SECRET` and a separate Cloudflare zone-edit token.
6. Enough `us-east-1` VPC and Elastic IP quota. The default is five of each,
   and staging adds one of each.

The three staging DNS records are not in that list, because the first deploy
of each service makes their targets. Each deploy prints the record to make,
and fails until the record exists. Every one of the three must be DNS only;
see [`../networking-and-https.md`](../networking-and-https.md).

## Database migrations

Every Lambda cold start (API and worker) applies the bundled drizzle
migrations (`packages/cdk/src/lambda/db-connection.ts`), except when one query
shows the newest bundled migration is already recorded in
`drizzle.__drizzle_migrations` (`migration-check.ts`); then the migrator is
skipped. Any error in that check runs the migrator as before. Each pending
migration applies and commits in its own transaction, so a migration can use
an enum value that an earlier migration adds, also on a fresh database. A
value that one migration adds and also uses still fails with 55P04; see
`0006_funny_pete_wisdom.sql` for the workaround. A new migration under
`packages/db/drizzle/` needs a matching hand-written import in that file;
`packages/cdk/test/lambda-migrations.test.ts` fails when one is missing. A
migration that cannot apply kills Lambda initialization: `/health/ready`
fails, the deploy workflow fails, and warm containers keep the cached
failure until they are recycled.

## Publishing customer templates

The bootstrap template is published by hand after `pnpm build`; the
application stack's CloudFormation is not published by hand at all — the
API compiles and publishes it at deployment creation.

1. **Compiled application artifacts (automatic).** At deployment creation
   the API compiles the deployment's frozen spec and puts the template in
   that region's `deployz-templates-<region>` bucket under
   `compiler-v2/<templateHash>.json` — a conditional `PutObject`
   (`IfNoneMatch: '*'`), so re-publishing identical infrastructure is a
   `412`-dedup, never an error or an overwrite. The bucket must already
   exist with public read for every deployable region; the publisher fails
   closed otherwise. (`deployz-templates-us-east-1` was found missing
   during the Phase 2 validation and has been created; all deployable
   regions now have their bucket.)
2. `pnpm --filter @deployz/cdk run publish:bootstrap` — synthesizes the
   bootstrap stack once, then publishes a per-Region template plus the relay
   Lambda's asset zips into every `deployz-templates-<region>` bucket, and
   verifies each Region (bucket Region, objects present, `ValidateTemplate`,
   URL reachability). It fails if any Region fails, because a half-published
   set leaves Regions failing with an S3 `PermanentRedirect` at stack
   creation. It prints the `BOOTSTRAP_TEMPLATE_URL` and
   `DEPLOYABLE_AWS_REGIONS` values to set as repository variables.

   Each publish has a **build id**: `BOOTSTRAP_BUILD_ID`, else the short
   source commit (`-dirty` when the working tree has changes). The id is
   baked into the relay Lambda as `DEPLOYZ_BOOTSTRAP_VERSION`, so the relay
   reports it as `bootstrapVersion` at enrollment and on every heartbeat.
   The publisher also writes an immutable copy of the template to
   `bootstrap/v1/versions/<buildId>/bootstrap-template-v1.json` in each
   Region and prints it as `versioned`. The fixed key
   `bootstrap/v1/bootstrap-template-v1.json` stays the latest build. Use the
   versioned URL for a customer-approved stack update, so the update applies
   the build that was reviewed and not a later one. A plain synth (tests, the
   committed artifact) uses the build id `dev`.

Why per Region: a Lambda must read its code from a bucket in its own Region.
The regional buckets must already exist with public read — the
`publish:bootstrap` verifier and the API's artifact publisher verify and
read/write objects, but neither creates buckets.

The relay code that drives every install ships inside the bootstrap
template's assets. A relay fix reaches a customer only after
`publish:bootstrap` for that Region **and** a bootstrap stack update (a new
Quick Create) on the customer side. With the repository variable
`BOOTSTRAP_REPUBLISH=on`, the deploy workflow republishes to every Region in
`DEPLOYABLE_AWS_REGIONS` after each successful API deploy. That step needs
`s3:GetBucketLocation`, `s3:PutObject`, `s3:GetObject` (the Region verifier
reads each object back) and `cloudformation:ValidateTemplate` on every
bucket; the deploy role in
[`../../.github/aws/github-oidc.yaml`](../../.github/aws/github-oidc.yaml)
grants them.

An IAM change in the bootstrap template follows the same rule. An existing
connector keeps its old permissions until its stack is updated or
recreated. Deployz cannot update a customer's stack. To apply an IAM change
in place, the customer must authorize and do the update:

1. Open the `deployz-bootstrap-…` stack in the CloudFormation console.
2. Select **Update**, then **Replace existing template**.
3. Enter the Region's published bootstrap template URL (the `templateURL` in
   the install page's Quick Create link).
4. Keep every parameter at its existing value, including `RelayCredential`
   and `EnrollmentCode`.
5. Review the change set before you execute it. Expect `Modify` with
   `Replacement: False` on the relay role, its default policy and
   `PermissionsBoundary`. Stop if the change set replaces a resource or
   changes the credential secret.

The installation identity and the enrollment do not change. This holds
only when the update keeps the previous value of every parameter:

- The installation id comes from the `InstallationId` custom resource. It
  reuses its physical id on an update, so it does not change.
- The relay credential secret stays only while `RelayCredential` keeps its
  previous value. An empty value flips the `HasRelayCredential` /
  `NoRelayCredential` conditions: CloudFormation deletes the secret and
  creates a new one with a new token, and the relay loses its enrollment.
  The console update flow keeps previous values when you do not edit the
  parameter; an `UpdateStack` API call must use `UsePreviousValue`.
- The SSM markers (`/deployz/<installationId>/…`) and the application stack
  are not resources of the bootstrap template, so an update does not touch
  them.
- A test pins the logical ids of the credential secrets, roles, permissions
  boundary, installation-id resource, relay function and schedule. A
  template change that renames one fails that test.

The
`AWS::IAM::ManagedPolicy` descriptions stay the same on purpose:
`Description` is a replacement property, so a new description would replace
both managed policies.

The relay runs once a minute on an EventBridge schedule with no retries, so
a missed event is dropped and not queued. The function has a 5-minute
timeout, so one invocation can overlap the next ones. Reserved concurrency
is not used, because a new AWS account may have a concurrency limit that is
too low to reserve any. Instead each invocation holds a lease in the SSM
parameter `/deployz/<installationId>/invocation-lease` (value:
invocation id and expiry). An invocation that finds a live lease, or cannot
read it, ends without polling. The lease expires 30 seconds after the
function timeout, so a crashed invocation does not block the relay for
long. The install-id function, its provider function and the relay function
keep their logs for one week.

The connector build id is the first 12 hex characters of the SHA-256 of the
bootstrap template (synthesized with the placeholder id `dev`). The template
holds the content-addressed relay asset hash, so the id changes only when the
connector changes, not on each commit. `pnpm --filter @deployz/cdk run --silent
bootstrap:build-id` prints it. `BOOTSTRAP_BUILD_ID` overrides it.

When `BOOTSTRAP_REPUBLISH` is `on`, `deploy-api.yml` computes the id once
before the API deploy and exports it as `BOOTSTRAP_BUILD_ID` to the CDK deploy
(API Lambda environment) and to the later republish step, which publishes the
immutable template at `bootstrap/v1/versions/<buildId>/bootstrap-template-v1.json`.
When `BOOTSTRAP_REPUBLISH` is off, CI does not set `BOOTSTRAP_BUILD_ID`, so
the API cannot name a versioned template that was not published.

The API offers a customer-approved connector update when `BOOTSTRAP_BUILD_ID`
is set and a deployment's connector reports another build, or reports no
release evidence. The offer links the existing stack in the CloudFormation
console and the versioned template; Deployz still cannot update the stack
itself. Without `BOOTSTRAP_BUILD_ID` only the missing-evidence case is offered,
with the fixed latest template. If the republish step fails after the API
deploy, run the workflow again to publish the template.

Until `BOOTSTRAP_TEMPLATE_URL` is set, the API returns no Quick Create URL
and the install page says no template has been published. A Region that is
not in `DEPLOYABLE_AWS_REGIONS` is rejected at deployment creation. When the
variable is unset entirely the API falls back to `us-east-1` only; when it
is set but empty, no Region is installable. The live values of these
variables (and of `BOOTSTRAP_REPUBLISH`, `PADDLE_ENVIRONMENT`,
`BILLING_ENFORCEMENT`, `DOCKERHUB_SECRET_NAME`) are held in the GitHub
repository settings, not in this repository: read them with
`gh variable list`.

## Enabling a Region

1. Create the `deployz-templates-<region>` bucket with public read.
2. Run `publish:bootstrap` with that Region included
   (`BOOTSTRAP_PUBLISH_REGIONS`).
3. Add the Region to the `DEPLOYABLE_AWS_REGIONS` repository variable and
   redeploy the API.

The Region must be one of the 17 in `SUPPORTED_AWS_REGIONS`
(`packages/contracts/src/index.ts`). Customer accounts need quota for one
VPC, one NAT gateway and one Elastic IP per deployment in that Region
(default quota five), and Fargate vCPU quota (as low as six on a new
account).

## Release builds

The CodeBuild project (`packages/cdk/src/pipeline/build-pipeline.ts`) builds
the vendor's repository tarball (fetched by the worker with a GitHub App
token and staged in the private source bucket) into the shared, immutable
ECR repository `deployz-images`, tagged `<applicationId>-<version>`, and
pins the digest on the release. Docker Hub pulls are anonymous unless
`DOCKERHUB_SECRET_NAME` is set; rate-limit failures are retried three times
(60 s, 180 s, 480 s) and classified `build_registry_rate_limited`. Builds
that stay `BUILDING` for 30 minutes are settled by the worker's sweep.
Failed builds keep their CodeBuild log; the API serves the last 3000 lines,
redacted, to the owning organisation. There is no ECR lifecycle policy, so
image storage grows until images are removed by hand; a release whose image
is deleted becomes `UNAVAILABLE` and can no longer be deployed.

## Watchdog and sweeps

The worker Lambda runs every 15 minutes: stuck-job reconciliation, relay
liveness (CONNECTED → DISCONNECTED after 15 minutes without a heartbeat),
stuck builds, billing reconciliation, a count-only config-secret inventory
(`watchdog:config-secret-inventory`; `stub` and `other` must be zero in
production), and expiry of pending secrets. Timings and rules are in
[`../deployment-resilience.md`](../deployment-resilience.md).

## Local development

No Docker or Postgres is needed: without `DATABASE_URL` the API uses a
file-backed PGlite store at `packages/db/.pgdata`. `pnpm install`,
`pnpm build`, then `pnpm dev` (or `pnpm e2e` for the simulated suite).
`pnpm build` must not run while `next dev` is running (it corrupts
`apps/web/.next`), and the API imports workspace packages from `dist/`, so
rebuild after editing a package the API or the relay harness depends on.
