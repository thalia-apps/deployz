# Deployz architecture

The authoritative description of the live Deployz MVP: what runs where, the
flow a deployment follows, how the customer's infrastructure is chosen and
built, and where the trust boundaries sit. Product scope and non-goals are
in [`product/mvp-scope.md`](product/mvp-scope.md); the actor journeys are in
[`product/user-flows.md`](product/user-flows.md). For how the lifecycle stays
recoverable, read [`deployment-resilience.md`](deployment-resilience.md)
before changing deployment, job, relay, worker or watchdog logic. Decision
rationale lives in [`decisions/README.md`](decisions/README.md).

## The two sides

**Control plane (the Deployz AWS account, `us-east-1`)** —
`packages/cdk/src/deployz-stack.ts`:

| Component | Code | Role |
| --- | --- | --- |
| API Lambda (Fastify, Node 22, behind HTTP API Gateway at `api.deployz.dev`) | `apps/api` | Auth (Better Auth), GitHub App, analysis, releases, deployments, invitations, relay channel, billing, Team Admin |
| Worker Lambda (SQS consumer + 15-minute schedule) | `packages/cdk/src/lambda/worker.ts` | Analysis and release-build jobs, CONFIG_UPDATE fan-out (the API runs it inline without a queue), CodeBuild result handling, the reconcile watchdog and the other sweeps |
| RDS PostgreSQL 16 (`db.t4g.micro`, isolated subnets) | `packages/db` (drizzle) | All control-plane state |
| SQS job queue + dead-letter queue | `apps/api/src/queue.ts` | API → worker messages |
| CodeBuild project + ECR repository `deployz-images` | `packages/cdk/src/pipeline/build-pipeline.ts` | Release builds; immutable tags, digest-pinned deploys |
| Source bucket (private, 30-day expiry) | | Repository tarballs staged for CodeBuild |
| Template bucket (public read) + regional `deployz-templates-<region>` buckets | `packages/cdk/scripts/publish-bootstrap.mjs`; the API (`apps/api/src/compiler-artifact.ts`) | The bootstrap templates; and the compiled application artifacts the API publishes at deployment creation under `compiler-v2/<templateHash>.json` |
| KMS key `alias/deployz-config-secrets` | | Config-secret and pending-secret encryption |
| Cloudflare zone `deployz.dev` (external) | `apps/api/src/cloudflare-records.ts` | Default-HTTPS DNS records |
| Web app on Lightsail (`app.deployz.dev`) | `apps/web` | Vendor dashboard, public install pages, Team Admin |

Everything in the control plane is deployed by CI only; see
[`operations/control-plane.md`](operations/control-plane.md).

A second control plane (staging) can run in the same AWS account and Region.
The stage selects every account-unique name — the stack id, the config-secret
KMS alias, the ECR repository and the prefix of the regional template buckets
— so the two stacks never share a resource and neither can reach into the
other's template buckets. Production's names are written out per stage, never
derived, because the KMS key and the ECR repository are retained. See
[`operations/control-plane.md`](operations/control-plane.md).

**Customer side (the customer's AWS account and chosen Region)**:

| Stack | Created by | Contents |
| --- | --- | --- |
| Bootstrap ("connector") stack `deployz-bootstrap-…` | The customer's Quick Create | The relay Lambda (Node 22, 5-minute timeout) on a 5-minute EventBridge schedule, its role with a permissions boundary, the CloudFormation execution role, the relay credential in Secrets Manager, an SSM pending-command marker |
| Application stack `deployz-app-<installation-id-prefix>` | The relay, from the compiled CloudFormation artifact frozen in the deployment's spec | VPC, ALB (for public workloads), one ECS Fargate service per workload (the web service plus any declared workers), the one-shot migration task definition when the app has a migration command, S3 bucket, optional RDS PostgreSQL or RDS MySQL, optional Valkey cache, app config secret, roles, per-workload log groups and security groups, alarm |

The relay talks to the control plane **egress-only** and is the only code
that ever touches the customer's AWS account.

## The live flow

1. **Repository** — the vendor installs the Deployz GitHub App and creates an
   application from a repository (`apps/api/src/github.ts`). Webhooks handle
   installation events only; a push never builds anything.
2. **Analysis** — `@deployz/analysis` runs deterministic detectors (runtime,
   Dockerfile, port, bind address, health path, environment-variable model,
   external services, PostgreSQL / MySQL / storage / Redis requirements,
   declared worker processes, SQS queue and EventBridge Scheduler scheduled-job
   detection, the unsupported-architecture rejections). An AI
   fallback resolves only
   genuinely open questions and can never override a detector. Output: the
   canonical `ApplicationAnalysis`, the readiness report and the versioned
   deployment manifest (`packages/analysis/src/{manifest,readiness-report,application-analysis}.ts`).
   See [`ai-analysis.md`](ai-analysis.md). Detected variable names become a
   vendor setup task ([`environment-variables.md`](environment-variables.md)).
3. **Manifest** — the READY manifest is frozen on each deployment as its
   desired state and is the **only** source of infrastructure intent for
   everything downstream (the compiled artifact, the INSTALL payload, relay
   verification, plans, inventory). Gates refuse to move a non-READY
   deployment toward provisioning.
4. **Preflight** — `apps/api/src/preflight.ts` combines the manifest gate
   (unsupported architecture, container setup, port, start command, required
   variables against the saved configuration) with the readiness warnings.
   It runs at deployment creation, at invitation confirm, before an install
   or deploy link launches, and again at relay registration. Warnings never
   block; a missing required value does.
5. **Release** — the vendor picks a commit from the configured branch (or a
   full SHA) and a version. The worker fetches the tarball with a GitHub App
   token, stages it in S3, and starts CodeBuild, which pushes to ECR; the
   `IMAGE_DIGEST` from the build event is pinned on the release, and a deploy
   always targets `repository@sha256:…`. Release states: BUILDING, READY,
   FAILED, plus the derived sticky `UNAVAILABLE` when the image is later
   found missing. For a FAILED build the API serves the last 3000 lines of
   the CodeBuild log, redacted, with an optional on-request AI explanation.
   Deployment creation and install links are refused until a READY release
   exists (`RELEASE_NOT_PUBLISHED`).
6. **Install** — the customer opens the install page, confirms (public link
   or invitation) or opens a vendor-created deployment's link, and runs the
   Quick Create. The relay registers with a single-use enrollment code and
   the credential minted for that link, preflight re-runs, the INSTALL job is
   created, and the relay provisions the application stack in the customer
   account with the newest READY release's image reference. Cross-account
   ECR pull is granted control-plane-side for the customer account id the
   relay reports. When configuration must precede the first start, the
   install creates the service with zero tasks and the post-install
   CONFIG_UPDATE plus auto-deploy start it. INSTALL success auto-deploys the
   newest READY release.
7. **Deploy** — DEPLOY_RELEASE runs the frozen migration (if the spec has a
   migration workload) as a one-shot ECS task — the compiler baked the
   command into a single task definition (family `DeployzAppMigration<suffix>`,
   unique to the installation) — and
   then updates every service to the pinned digest. The migration and the
   scheduled jobs run with the same effective application configuration as
   the configured web service: compiler-managed bindings, vendor and customer
   values, Deployz-generated secret references and binding aliases
   (`docs/deployment-resilience.md`). The migration always runs
   after the infrastructure and the database are ready and before any service
   updates; its identity (sha256 over the effective command plus the image
   digest) makes it run exactly once per release — a retry of an
   already-succeeded migration skips the run. The application's migration
   setting can correct the command or skip the migration on an existing
   deployment's next release deployment without changing its spec or
   stack: the relay registers a new revision of the same family that
   changes only the application container's command and image
   ([`deployment-resilience.md`](deployment-resilience.md)). A failed migration fails the
   job with `MIGRATION_FAILED` (task family, exit code, stopped reason); no
   service is updated, the previous release keeps serving, and the deployment
   returns to `UPDATE_AVAILABLE`. Before a
   deploy, rollback or bulk deploy is queued the API asks the registry
   whether the image still exists (`apps/api/src/release-images.ts`); a
   deleted image refuses with `RELEASE_UNAVAILABLE` and never touches the
   running release. Rollback and restart never run migrations.
8. **Health and promotion** — the relay's heartbeat reports ECS counts,
   rollout state, ALB target health, the HTTP probe, the running digest, the
   component verification and the stack inventory. Verification has one
   `compute` check per workload: the web service verifies through its ALB
   target and the HTTP probe, a worker verifies through its service
   stability alone (it has no ALB target and no HTTP endpoint). The control
   plane
   promotes the release pointer only when every gate passes (rollout
   COMPLETED, full counts, healthy targets, successful probe).
   `GET /api/deployments/:id/infrastructure` compares the components the
   manifest requires against the persisted CloudFormation inventory and
   reports anything missing or unexpected; it never scans AWS itself and
   never repairs anything.
9. **Default HTTPS** — every deployment gets `https://d-<deployment-id>.deployz.dev`
   with no customer DNS work; a custom domain, once ACTIVE, takes precedence
   and the default URL stays as the permanent fallback. See
   [`networking-and-https.md`](networking-and-https.md).
10. **Day 2** — config updates, further deploys, rollback, restart, relay
    re-enrollment, retry of a failed first install and default-HTTPS retry
    run through the same command queue, gated on relay connectivity and
    operation exclusivity.
11. **Disconnect and purge** — DESTROY removes the application stack but
    retains the database, its credential secrets and the bucket (no final
    snapshot is ever taken); PURGE deletes the retained items, the ACM
    certificates and the network orphans; the customer deletes the bootstrap
    stack. Details below.

## Application template generation

The control plane compiles a CloudFormation template from the frozen
`DeploymentSpecV2`; there is no pre-published application template and no
other provisioning path.

**`DeploymentManifest` → `ApplicationGraph` → `DeployzIR` → compiler-v2 →
compiled artifact**

1. **DeploymentManifest** (`schemaVersion` = 1) remains the frozen deployment
   contract: container setup, port, health path, environment variables,
   PostgreSQL/Redis/S3 requirements. It is the input to analysis and
   preflight.
2. **ApplicationGraph** is a projection of the manifest describing what the
   application needs: workloads, resources, bindings, external services.
   It does not contain AWS capability decisions. The graph builder connects
   every workload to every managed resource (a BINDING superset), so every
   workload receives the same managed variables at runtime — a workload
   that uses fewer resources is not narrowed at the binding level. A queue
   or a schedule is different: it is reached only through explicit
   `produce` / `consume` / `dead-letter` / `invoke` edges, not the binding
   superset, and the planner rejects (fails closed) a graph where an edge
   is missing its other side — an orphaned queue or an unreachable
   scheduled job never provisions.
3. **Capability Resolver / Planner** maps graph needs to AWS capabilities
   (ECS Fargate services for the web and worker workloads, the one-shot
   migration task, RDS PostgreSQL, RDS MySQL, ElastiCache Valkey, S3, ALB,
   Secrets Manager, SQS Standard queues, EventBridge Scheduler schedules),
   applies the immutable size profile and region, and emits `DeployzIR` —
   the authoritative provisioning intent. SQS and EventBridge Scheduler
   ship at `PREVIEW` maturity: supported and provisioned, but not yet
   qualified against real AWS (see
   [`testing/aws-e2e.md`](testing/aws-e2e.md)).
4. **compiler-v2** (`packages/infrastructure-compiler`) turns the IR into a
   deterministic CloudFormation template, a resolved AWS graph, a
   verification contract, ownership records and a footprint.
5. **Compile and publish at creation.** The API runs this chain at
   deployment creation and publishes the template to the region's
   public-read template bucket at `compiler-v2/<templateHash>.json`
   (a conditional `PutObject`; an object that already holds the hash is
   byte-identical, so `412 PreconditionFailed` is dedup success). The
   publish happens before the deployment row is written — no compile or
   publish, no deployment. The completed spec is persisted on the row
   (`deployments.spec_v2`, `infra_version = 'dynamic-compiler-v2'`).
6. **Relay INSTALL** executes the payload's `templateUrl` — the frozen
   artifact — with typed parameters (pinned image digest, generated
   `NoEcho` app secrets, manifest-derived port and health path). The relay
   never synthesizes templates and fails closed without the artifact URL.

Rules: the manifest is authoritative and an invalid or missing requirement
fails before provisioning; the relay refuses an INSTALL without the
payload's artifact URL; the heartbeat's expected components come from the
deployment spec; an existing deployment keeps the artifact it was created
with (releases never recompile it); unsupported infrastructure changes
that would replace or delete managed resources fail closed.

## What the application stack contains

The compiled stack contains: a VPC (two public and two private subnets, one
NAT gateway, plus isolated DB-only subnets in the remaining available AZs when
a database is present), an ECS cluster, and one Fargate service per persistent
workload (sized by the deployment's frozen profile, for example `small-v2`: 0.25 vCPU / 512 MiB per task; deployment circuit
breaker with rollback). The web workload runs behind the internet-facing
ALB (one HTTP listener, a target group, an unhealthy-target alarm, and a
300-second health-check grace period, so an app that migrates at boot is not
stopped before it listens); each
declared worker runs its own private service — one task, its own log group
and security group, no ALB target, no HTTP health check. Every workload
gets a task definition with the same frozen image and its own frozen
command; a migration command compiles into one additional one-shot task
definition (no service). A worker command is an argument list (`sh -c
<command>`) for the image ENTRYPOINT. A migration or scheduled-job command
replaces the image ENTRYPOINT and runs through `sh -c`, so the image must
contain `sh` (an image `FROM scratch` cannot run a one-shot command). Each non-web workload now gets its own IAM task
role, scoped to its own queue edges (a worker never inherits another
workload's `sqs:SendMessage`); the web task role stays the anchor for the
shared execution role. Shared resources: the S3 bucket
(**Retain**), the application config secret (Delete), and the task
execution role. Optional resources are composed from the IR:

| Capability adds | Lifecycle on destroy |
| --- | --- |
| RDS PostgreSQL 16 instance (`db.t3.micro`, 20→100 GB, gp3, 7-day backups, deletion protection), subnet group, master secret + URL secret | **Retain** |
| RDS MySQL 8.0 instance (same class, storage type, backup and protection settings), subnet group, master secret + URL secret | **Retain** |
| ElastiCache Valkey replication group (one `cache.t4g.micro` node, no Multi-AZ, TLS off), cache subnet group and security group | Delete |
| SQS Standard queue (SSE-managed, TLS-only queue policy), plus an optional dead-letter queue (same capability, reached by a queue → queue redrive edge) | Delete |
| EventBridge Scheduler schedule (cron or rate expression, optional IANA timezone, bounded retry policy) invoking one scheduled-job task definition — no ECS service, no ALB, no verification check; the task definition targets the same Fargate task family the relay updates on every release, so a schedule always runs the latest deployed image | Delete |

Parameters: the web desired count, image reference, container port,
health-check path, and the generated application secrets. Each worker
service runs one task.

Redis details: the app receives `REDIS_URL` (`redis://<endpoint>:6379`),
`REDIS_HOST` and `REDIS_PORT`; other detected alias names are in the
compiled task definitions too (see "Alias bindings" below). `REDIS_PASSWORD` is never resolved (no AUTH in the
MVP). The cache security group allows 6379 from the whole VPC CIDR, wider
than the database rule. Detection tiers and the supported/unsupported
matrix are in [`ai-analysis.md`](ai-analysis.md).

Database details: the task's `DATABASE_URL` (`sslmode=require` for
PostgreSQL, `mysql://` for MySQL) is assembled
through a CloudFormation dynamic reference, so the generated password is
alphanumeric only; an init container mounts the RDS CA bundle for clients
that verify the chain, and the CA environment is shared by every workload,
so workers and the migration task verify TLS the same way. MySQL also
binds `MYSQL_URL` and the `DB_*` aliases. Aliases such as `DB_HOST` /
`DB_USER` are bound from
the analysis manifest.

Alias bindings: the compiler writes every alias name in the manifest's
database, cache and storage `envBindings` (for example `MEMOS_DSN`,
`SQLALCHEMY_DATABASE_URI`, `BACKEND_CACHE_REDIS_URI`,
`S3_ATTACHMENTS_BUCKET`) into every task definition: web, workers, the
migration task and the scheduled jobs. An alias copies the value of the
standard name. It never replaces a standard or platform name. The
`jdbc_url` kind (`SPRING_DATASOURCE_URL`) gets
`jdbc:postgresql://<host>:5432/deployz?sslmode=require` (or the
`jdbc:mysql://…?sslMode=REQUIRED` form). The relay's post-install alias step
stays for artifacts that an earlier compiler version made.

Vendor-mapped names join the manifest bindings. A vendor can map any
variable name to a managed value in Configuration (a setting with a
`binding`, see `docs/environment-variables.md`), also a name that analysis
did not detect. `applyEnvironmentBindings`
(`packages/contracts/src/environment-setup.ts`) appends each mapped name to
the `envBindings` of the matching resource, and it skips a name that is
already bound. Preflight and the manifest that a new deployment freezes both
use it, so the compiler binds the mapped name as it binds a detected alias.
When analysis finds no evidence that the app reads a database connection
variable, the manifest has `database.connectionUnverified`. The readiness
gate then blocks with `database-connection-unverified` until the vendor maps
a database value.

The database is a **Single-AZ database with automatic placement**. The
compiler emits a DB subnet group that covers all available, enabled
standard AZs in the customer's region: the two private subnets (which the
ECS services also use) plus DB-only subnets in every other available AZ.
The DB-only subnets are isolated — no NAT gateway, no internet route —
and exist only to give the database more placement options. The relay
discovers the AZs via `DescribeAvailabilityZones` before creating the
stack and fills the template's `paramDbAz1` … `paramDbAzN` parameters.
The DB instance's `AvailabilityZone` is unset, so RDS chooses one subnet
from the group at create time. This avoids the `InsufficientDBInstanceCapacity`
failure that occurs when the subnet group only covers two AZs and AWS
reports no capacity in either.

The HTTPS listener and its certificate are **not** in the template; the
relay adds them after install.

### Infrastructure components and AWS resources

`INFRASTRUCTURE_COMPONENTS` (`packages/contracts/src/components.ts`) is the
shared list of the five components a deployment can have: application,
endpoint, database, cache and storage. Each row names the graph need that
requires it, its `lifecycle` (`delete` or `retain`) on destroy, the
CloudFormation `primaryResourceType` that proves it exists, and the relay
`checkName` that verifies it. A multi-workload deployment holds one
application-component seat per workload, so each service is verified and
presented on its own. It is the semantic catalog for relay
verification, lifecycle presentation and deployment plans; the compiler
owns how each capability is constructed and CloudFormation owns the real
lifecycle.

`AWS_RESOURCES` (`packages/contracts/src/aws-resources.ts`) is the
customer-facing resource catalog: every meaningful AWS resource the stack
creates, with a customer name, purpose, display group, the component it
binds to, its CloudFormation type and its lifecycle. It omits objects with
no customer meaning (route tables, listeners).

The runtime-v1 parity tests (`lifecycle-parity.test.ts`,
`sizing-parity.test.ts`) were removed with the runtime-v1 application
stack; capability lifecycle and sizing are tested in the capability
registry and the compiler tests.

### Deployment plans

A plan (`packages/contracts/src/plan.ts`) states what INSTALL, UPDATE or
DESTROY does to a deployment's infrastructure. It is derived through the
graph → planner chain from the frozen spec (the compiler footprint when
present), never from AWS or an LLM, and is deterministic. INSTALL: every
required component is CREATE. UPDATE: only
the application component is UPDATE; the topology never changes, and a
difference between the deployed and current requirements is reported as
`requirementDrift`, never as a CREATE or DELETE. DESTROY: each component is
DELETE or RETAIN per its lifecycle; it never represents PURGE. Plans carry
the filtered `awsResources`, the resolved footprint and a Region-priced cost
estimate ([`infrastructure-profiles.md`](infrastructure-profiles.md)).
`GET /api/applications/:id/plan`, `GET /api/deployments/:id/plan?action=…`
and `GET /api/public-install/:id/plan?region=…&profile=…` serve the same
derivation, so the vendor page and the customer page can never disagree.

## Regions and sizing

- 17 supported Regions (`SUPPORTED_AWS_REGIONS`, mirrored in the database
  enum). Installable Regions are `DEPLOYABLE_AWS_REGIONS`, for which the
  regional bootstrap artifacts are published; the resolver fails closed.
- The Region is chosen at deployment creation and is immutable
  ([`product/user-flows.md#who-chooses-the-aws-region`](product/user-flows.md#who-chooses-the-aws-region)).
- Sizing is frozen per deployment from the immutable profile registry
  (Small `small-v2`, Medium `medium-v1`, Large `large-v1`). The vendor
  recommends, the customer chooses at or above the vendor minimum —
  [`infrastructure-profiles.md`](infrastructure-profiles.md).

## Installation invitations and links

The `public_install_links` table holds two kinds of link: a **reusable
public link** (no token; any customer who opens it can confirm) and a
**targeted invitation** (bound to one customer, secured by a one-time token
presented in the `x-deployz-token` header; only its hash is stored). In both
cases the deployment is created only when the customer confirms
(`POST /api/public-install/:id/confirm`): the server re-validates the link,
the subscription gate, preflight, Region and profile, then creates exactly
one deployment (idempotent per key; a used invitation answers `410`).

Two older entry points still exist: a **vendor-created deployment** with a
vendor-chosen Region and a per-deployment install link (the dashboard's
primary "Create deployment" path today), and the legacy **deploy link**
([`deploy-links.md`](deploy-links.md)). The targeted-invitation path is not
currently completed by the web app; see
[`installation-invitations.md`](installation-invitations.md).

## Secrets and configuration values

- **Vendor values and secrets** (`application_configs`) and **customer values
  typed before the relay connects** (`pending_secrets`) are stored as KMS
  ciphertext (`kms1:` format, key `alias/deployz-config-secrets`, encryption
  context bound to organisation / application / key and, for pending rows,
  customer and deployment). Inside Lambda the cipher fails closed: no key,
  no start, and no plaintext fallback anywhere. Decryption happens in the
  API (the authenticated `GET /api/relay/config` response and the
  materialization of staged rows when a deployment is created) and in the
  worker (vendor build-time values). Full threat model and cipher contract:
  [`pending-secret-delivery.md`](pending-secret-delivery.md).
- **Deployz-generated secrets** (the `deployz_generated` variables) are
  minted by the relay with `crypto.randomBytes` inside the customer account
  and written to the application's Secrets Manager secret; the control plane
  never sees those. Separately, the API generates the template's secret
  *parameters* (the generic app API key and signing secret, plus any
  preset-specific ones) for every INSTALL; they sit in the job payload until
  the relay claims it and are masked afterwards.
- **Managed bindings** (`DATABASE_*`, Redis, S3, `AWS_REGION`, `PORT`) are
  template parameters and dynamic references in the customer account.
- **Plaintext that still exists in the control plane**, by design and worth
  knowing: a CONFIG_UPDATE for a deployment whose relay is already connected
  carries the values through SQS (server-side encrypted) and the job row
  until the relay claims it, after which the payload is redacted; the relay
  credential sits in the deployment row until the relay first registers;
  vendor build-time secrets are passed to CodeBuild as plaintext environment
  overrides visible to anyone with `codebuild:BatchGetBuilds` in the Deployz
  account.

## Trust and ownership boundaries

| Party | Owns | Holds |
| --- | --- | --- |
| Deployz | The control plane, the ECR repository and build logs, the template buckets, the KMS key, the `deployz.dev` zone | GitHub App key, OAuth and SES keys, the Cloudflare zone-edit token, Paddle and AI keys — all Lambda environment from CI secrets |
| Customer | Both stacks, the retained data, the ACM certificates, the SSM marker, the relay credential, the application secrets, the runtime logs | The relay bearer token; the customer's own AWS credentials, which Deployz never asks for |
| Vendor | Applications, releases, configuration values | A Better Auth session |

- The control plane holds **no** customer AWS credentials and never calls
  into a customer account. It can queue commands from the relay's fixed
  vocabulary (INSTALL, DEPLOY_RELEASE, ROLLBACK, RESTART, CONFIG_UPDATE,
  DESTROY, PURGE, CONFIGURE_DOMAIN, REMOVE_DOMAIN), grant or revoke ECR pull
  for the customer's account id, and write `d-*` records in its own zone. It
  cannot read customer logs, describe customer AWS, or update relay code in
  place: a relay fix reaches a customer only after the bootstrap template is
  republished and the customer's stack is recreated.
- The relay's IAM is a permissions boundary scoped to the
  `deployz:installation` tag, with documented condition-free exceptions for
  actions AWS cannot tag-condition (reads, S3 bucket actions,
  `GetRandomPassword`, log retention, task-definition deregistration,
  ElastiCache replication-group lifecycle, `ecs:RunTask`,
  `ecs:ListTaskDefinitions`). The relay role's
  `ecs:DeregisterTaskDefinition` is granted on `*` (the boundary does the
  same) because ECS supports no resource-level scoping for it; the relay code
  restricts it to the installation's own suffixed task families. The bootstrap
  stack attaches the provisioner policy at install; nothing is attached
  later. The relay reads and writes its own credential secret by that
  secret's ARN only. It reads and writes other secret values only on secrets
  that carry its `deployz:installation` tag (the application's
  configuration); it can list secrets and read their metadata without a
  condition. The relay has no log-reading permissions. Relay-created resources (listener, certificate)
  must carry the installation tag or the relay cannot modify them later.
- Relay authentication: a per-link credential minted by the API (hash
  stored; plaintext until first registration), presented as a bearer token;
  the enrollment code is single-use (burned by a conditional update, so two
  concurrent first registrations admit one); a second party registering the
  same installation gets `409`. Tokens do not rotate except through a relay
  reset, which is a new Quick Create.
- Every application stack and its resources are tagged
  `deployz:installation`, `deployz:application`, `deployz:vendor`,
  `deployz:component`; the relay verifies ownership by tag before it deletes
  anything and skips mismatches.
- Team Admin sessions are read-only outside `/api/admin/*`; recovery actions
  are audited ([`admin/team-admin.md`](admin/team-admin.md)).

## Disconnect, purge and retained data

| Operation | What happens | What remains |
| --- | --- | --- |
| **Disconnect** (`POST …/destroy`, job DESTROY) | A never-installed deployment is marked DELETED immediately. Otherwise the relay verifies the stack tag and deletes the stack; CloudFormation's policies decide what stays. On `DELETE_FAILED` the relay re-issues the delete with `RetainResources` for the failed resources, repeating the pass until the stack completes — the deletion-protected database keeps failing its delete after the SG/subnet it pins, so those stay behind with it. The deployment settles DELETED (a truthful success) while the retained data waits for Purge. Custom-domain and default-HTTPS removal jobs are queued; DNS records are deleted on success; the ECR pull grant is revoked; billing stops. | RDS instance (deletion protection on, automated backups continue), its subnet group, `DatabaseSecret` and `DatabaseUrlSecret`, the S3 bucket, and the network objects the database ENI pins (a private subnet, the DB-only subnets with the VPC's secondary CIDR block, the DB security group, the VPC). Charges continue. |
| **Force-complete** (`POST …/disconnect/force-complete`) | Control-plane-only settlement for a dead relay: `cleanupState: SKIPPED_RELAY_OFFLINE`, pending secrets and DNS records deleted. Never claims AWS resources were removed. | Everything in the customer account. |
| **Purge** (`POST …/purge`, job PURGE; allowed while `cleanupState ≠ COMPLETE`) | The relay deletes, one kind per poll and only what carries its tags: the application stack (clearing blockers on `DELETE_FAILED`), owned RDS instances (`SkipFinalSnapshot`), caches, buckets (every version), every owned application secret regardless of infrastructure generation (anything except the relay's own `deployz:component=bootstrap` secret), ACM certificates, ACTIVE task-definition revisions of the installation's own suffixed families (a role lacking `ecs:DeregisterTaskDefinition` reports them as `leftovers`, not a failure), subnet groups, then the VPC network. Failure → `PURGE_FAILED` (retryable); success → `COMPLETE`, ECR grant revoked, DNS orphans reconciled. | The bootstrap stack. |
| **Customer deletes the bootstrap stack** | In the CloudFormation console, after purge. The relay cannot delete its own role. | Nothing. |

The `finalSnapshot` flag that the API and web still send on destroy is
ignored by the relay; no final snapshot is ever taken. `DELETE /api/customers/:id`
refuses a customer that still has any deployment row, including a DELETED
one, so removing a record can never remove infrastructure.

## The MVP support boundary

Deployz supports one opinionated architecture: one build artifact on ECS
Fargate that runs as a web service behind an ALB, plus declared background
workers (one private ECS service each) and a one-shot migration task when
the app has a migration command; S3, and optional RDS PostgreSQL, RDS
MySQL and ElastiCache Valkey; and, when strong code evidence names them, an
SQS Standard queue (with an optional dead-letter queue) and an EventBridge
Scheduler schedule invoking a one-shot scheduled ECS job — installed from a
compiler-generated CloudFormation
template. FIFO queues are not supported: a FIFO request resolves to no
capability and fails the plan rather than silently becoming Standard.
Anything that does not fit is rejected at analysis time with
evidence, never silently adapted. The full list of non-goals, known
limitations and deferred items is in [`product/mvp-scope.md`](product/mvp-scope.md).

## Where the details live

| Topic | Document |
| --- | --- |
| Lifecycle invariants, states, watchdog, retry | [`deployment-resilience.md`](deployment-resilience.md) |
| Analysis, readiness, preflight, diagnosis | [`ai-analysis.md`](ai-analysis.md) |
| Environment variables | [`environment-variables.md`](environment-variables.md) |
| Secrets and KMS | [`pending-secret-delivery.md`](pending-secret-delivery.md) |
| Networking, DNS, HTTPS, custom domains | [`networking-and-https.md`](networking-and-https.md) |
| Sizing and cost | [`infrastructure-profiles.md`](infrastructure-profiles.md) |
| Invitations and links | [`installation-invitations.md`](installation-invitations.md), [`deploy-links.md`](deploy-links.md) |
| Operating the control plane, publishing templates, Regions | [`operations/control-plane.md`](operations/control-plane.md) |
| Diagnosing failures | [`operations/troubleshooting.md`](operations/troubleshooting.md) |
| Testing | [`testing/README.md`](testing/README.md) |
| Billing | [`billing/paddle-billing.md`](billing/paddle-billing.md) |
| Team Admin | [`admin/team-admin.md`](admin/team-admin.md) |
| UI system | [`ui-system.md`](ui-system.md) |
