# Decision log

Architecture and product decisions whose reasoning is still worth knowing.
Each entry states the decision, why, and what would change it. Completed
implementation plans and one-off reports are not kept; git history has them.
Three decisions with substantial detail have their own files:
[`deploy-gate.md`](deploy-gate.md),
[`failed-install-recovery.md`](failed-install-recovery.md) and
[`pending-command-authority.md`](pending-command-authority.md).

| Date | Decision | Status |
| --- | --- | --- |
| 2026-08-25 | Control-plane deploys run only from CI ([`deploy-gate.md`](deploy-gate.md)) | Active |
| 2026-08-25 | AI explanations are on-demand, cached, single-flight, and never change state | Active |
| 2026-08-26 | Installation is verified from CloudFormation, inside the relay, and fails closed | Active |
| 2026-08-27 | A failed first install is recovered by an explicit vendor retry ([`failed-install-recovery.md`](failed-install-recovery.md)) | Active |
| 2026-08-27 | Database passwords are alphanumeric; secret-backed `DATABASE_URL` | Active |
| 2026-08-30 | Valkey is a single-node replication group with TLS off | Active |
| 2026-09-02 | Background workers are deferred (Option B) | Superseded 2026-09-28 (workers are supported) |
| 2026-09-02 | Disconnect retains data; no final snapshot (RETAIN, not SNAPSHOT) | Active |
| 2026-09-02 | The stored manifest is the only source of infrastructure intent | Active |
| 2026-09-03 | Default HTTPS uses a Deployz-owned hostname per deployment (Option A) | Active (Route 53 replaced by Cloudflare 2026-09-04) |
| 2026-09-03 | Infrastructure profiles are immutable and frozen per deployment | Active |
| 2026-09-20 | Jev shadow analysis is not adopted | Active |
| 2026-09-22 | Config secrets are KMS-encrypted; Lambdas fail closed without the key | Active |
| 2026-09-25 | Runtime-v1 backward compatibility is not required for the MVP | Executed |
| 2026-09-26 | Purge deletes every owned application secret except the relay's own bootstrap component | Active |
| 2026-09-27 | Phase 3 passes without real-AWS validation; the runs move to the Final AWS Qualification backlog | Active |
| 2026-09-28 | The MVP boundary expands to background workers, RDS MySQL and first-class migrations; one build artifact and no private services stay | Active |
| 2026-09-29 | The MVP boundary expands to SQS queues and scheduled jobs | Active |
| 2026-10-02 | A pending INSTALL carries command authority; only authorized recovery may recreate a stack ([`pending-command-authority.md`](pending-command-authority.md)) | Active |
| 2026-10-02 | A migration correction rides the migration seat as a new revision of the same family | Active |
| 2026-10-02 | A configuration update settles on its rollout; service mutations never overlap | Active |
| 2026-10-08 | Staging is a second stack in the same account and Cloudflare zone, with the `s-` hostname prefix, and promotion to production needs an approval | Active |
| 2026-10-09 | Every environment-specific deploy value is a GitHub Environment variable, and the stage gate derives its rules from the stage name | Active |
| 2026-10-09 | GitHub Actions authenticates to AWS with OIDC and one IAM role for each Environment | Active |
| 2026-10-09 | One release workflow promotes a commit through staging to production, and the production deploy jobs wait for an approval | Active |
| 2026-10-10 | A repository with no buildable Dockerfile is NOT_COMPATIBLE when the evidence is complete | Superseded 2026-10-20 (a repository change, DEPLOYABLE_WITH_CHANGES) |
| 2026-10-10 | An image that runs several supervised application processes (s6-overlay, supervisord) is NOT_COMPATIBLE | Superseded 2026-10-20 (a repository change, DEPLOYABLE_WITH_CHANGES) |
| 2026-10-12 | A deploy fails closed when the application needs a database or cache that the deployment does not have | Active |
| 2026-10-12 | The per-environment workflow guards parse the workflows, and they match the production zone id by shape | Active |
| 2026-10-14 | An install that never verifies fails after a 30-minute window, driven by the heartbeat | Active |
| 2026-10-16 | Docker run-and-check replaces the label benchmarks (Stage A compatibility and remediation) | Active |
| 2026-10-19 | AI-first application Analysis: an AI analyst infers the facts, fixed checks verify them, the rules stay as the fallback | Superseded 2026-10-20 (the AI answers only the open items) |
| 2026-10-20 | The Analysis gives one deployability outcome; only a required capability gap is not compatible | Active |
| 2026-10-20 | The AI Analysis answers only the open items of the rules Analysis, with closed answers and one call; the reviewer is post-MVP | Proposed (release gate not passed) |
| 2026-10-21 | Every IAM role the application stack creates carries the connector's application role boundary | Active |
| 2026-10-21 | Without health evidence the health check probes `/` and accepts 200-399 | Active |
| 2026-10-21 | A production deployment is billed only while it serves the customer | Active |
| 2026-10-21 | The rules Analysis asks about an unusable migration script, and a start script with two background servers is a multi-process image | Active |
| 2026-10-23 | A vendor can dispute an allowlisted blocker ("not used in production"); the TEST deployment proves the answer | Active |
| 2026-10-23 | Until public launch, a push to `main` deploys staging at once and production deploys after CI, without waiting for staging | Superseded 2026-10-23 (staging is skipped) |
| 2026-10-23 | Until public launch, staging is skipped: production deploys after CI on `main`, and staging deploys only from a dispatch | Active |
| 2026-10-23 | Until public launch, the `production` Environment has no required reviewers: production deploys without an approval | Active |
| 2026-10-23 | Until public launch, there is no pull-request CI: the full CI run on `main` is the only gate before production | Active |

## AI explanations are on-demand and never change state (2026-08-25)

A deployment diagnosis or a build-failure explanation is generated only when
a user asks, cached on the job or release row, and claimed with a
single-flight `UPDATE … WHERE state IN ('PENDING','FAILED') OR (state =
'GENERATING' AND claimed_at < now() - interval '5 minutes')` so two requests
never pay for two model calls. The pattern works identically on Postgres and
PGlite, which advisory locks do not. AI output is advisory copy; it never
sets deployment state, failure codes or retry eligibility. The gateway is
Cloudflare AI Gateway (`AI_GATEWAY_BASE_URL`, `AI_PROVIDER_API_KEY`, optional
`AI_GATEWAY_TOKEN` only for an authenticated gateway, `AI_MODEL`); with no
configuration the deterministic copy is served instead of an error. See
[`../ai-analysis.md`](../ai-analysis.md).

## Installation is verified from CloudFormation, inside the relay (2026-08-26)

A production install once reported success against an empty account. Since
then the relay's `verifyInstallation` reads the application stack
(exists, complete, carries the installation tag, and contains the components
the deployment's infrastructure profile requires) before an INSTALL, deploy
or rollback result counts, and the heartbeat reports the same checks.
Rejected: sweeping the account for resources (needs IAM the relay must not
have, mostly untaggable); verifying from the control plane (needs
cross-account credentials, which the trust model forbids); a new
`INSTALL_UNVERIFIED` failure code (the failure-code enum is mirrored in the
database and copy map; `STACK_CREATE_FAILED` already means "the stack is not
there"). Later hardening replaced the CloudFormation-only deploy gate with
the runtime promotion gates in
[`../deployment-resilience.md`](../deployment-resilience.md).

## Alphanumeric database passwords, secret-backed `DATABASE_URL` (2026-08-27)

The task's `DATABASE_URL` is assembled through a CloudFormation dynamic
reference to a Secrets Manager secret, and dynamic references are not
percent-encoded. A generated password containing a URL-reserved character
corrupts the URL and the install rolls back minutes in (seen live). The
generated password therefore excludes punctuation entirely. The same work
made the container contract (port, health path, task size, grace period,
secret parameters) overridable per application preset; the Documenso preset
also proved that an application which derives its cookie domain from a
public URL needs a non-empty URL from the first boot, so a domain-less
install falls back to the ALB's own URL.

## Valkey: single-node replication group, TLS off (2026-08-30)

ElastiCache's `CreateCacheCluster` rejects the Valkey engine, so the cache is
a `CfnReplicationGroup` with one node, no Multi-AZ and no automatic
failover. `transitEncryptionEnabled` is set to `false` explicitly because the
default enables TLS and breaks every `redis://` client; a repository that
requires `rediss://`, Redis Cluster or Redis Stack modules is rejected at
analysis instead. The relay's IAM must authorize the replication-group
actions against the default parameter group as well as the tagged resource,
or a denied create leaves an untagged group behind and the stack cannot roll
back.

## Background workers are deferred — Option B (2026-09-02)

A repository that declares a worker process is rated needs-adaptation, and
the worker-command configuration surface is disabled. Real worker support
(Option A) would need a per-application infrastructure model (the shared
published templates cannot bake a per-app worker command) and dual-service
semantics across every relay module that today takes the first
`AWS::ECS::Service`. The CDK construct still contains a worker branch; no
published template enables it. In-process schedulers inside the web
container are allowed.

**Superseded 2026-09-28.** Phase 4 of the dynamic-infrastructure plan
shipped the workload model, which delivers Option A's outcome without the
rejected mechanics: there are no shared templates left to bake a command
into (compiler-v2 composes from the graph), so a declared worker process
becomes its own ECS service with its own frozen command. What stays
out: worker-like code with no declared start command becomes a
needs-input question and is never provisioned from weak evidence. See the
2026-09-28 boundary decision below.

## Disconnect retains data; no final snapshot (2026-09-02)

The application template sets `DeletionPolicy: Retain` on the RDS instance,
its subnet group, its credential secrets and the S3 bucket. Disconnect
(DESTROY) deletes the running application and network and leaves those
behind, with RDS automated backups continuing; Purge deletes them directly
with `SkipFinalSnapshot: true`. The earlier "final snapshot on delete" claim
was never implemented and was removed rather than built: a snapshot would
add a second retained artefact class to track, purge and bill, without
adding safety over the retained instance itself. The bootstrap stack is
never deleted by the relay (it cannot delete its own role); the customer
deletes it.

Resolved with the compiler-v2 cutover (2026-09-26): a DESTROY that retains
data is a **success**. The deletion-protected database fails its delete
after the security group and subnet it pins, so the stack passes through
`DELETE_FAILED`; the relay re-issues the delete with `RetainResources` for
the failed resources, repeating the pass until the stack reaches
`DELETE_COMPLETE`, and the deployment settles `DELETED` — the retained
data is deliberate, visible and purgeable, not a failure. PURGE then
removes the retained data, including every owned application secret
regardless of infrastructure generation (see the 2026-09-26 record
below).

## The stored manifest is the only source of infrastructure intent (2026-09-02, reaffirmed 2026-09-17)

The analyzer writes a versioned `DeploymentManifest`; it is frozen on the
deployment at creation, and every consumer (template selection, the INSTALL
payload, relay verification, deployment plans, the resource inventory) reads
it rather than the live `applications` columns. Invalid or missing
requirements fail before provisioning; nothing defaults to PostgreSQL. An
existing deployment's topology never changes: a requirement change is
reported as drift and satisfied by a new deployment.

## Default HTTPS uses a Deployz-owned hostname per deployment (2026-09-03)

ACM certificates are Region- and account-bound and cannot be exported, so a
shared Deployz certificate cannot terminate TLS on a customer's ALB.
Option A: a per-deployment certificate requested in the customer account,
DNS-validated through a record the control plane writes into its own zone,
reusing the existing `CONFIGURE_DOMAIN` / `REMOVE_DOMAIN` relay vocabulary
unchanged. Option B (a CloudFront distribution in the Deployz account) was
rejected because it adds a cross-account resource lifecycle that the
customer-account teardown machinery cannot reach, and a second TLS hop. The
zone moved from Route 53 to Cloudflare the next day because `deployz.dev`
lives on Cloudflare; the trade-off is that default-URL traffic transits the
Cloudflare edge. See [`../networking-and-https.md`](../networking-and-https.md).

## Infrastructure profiles are immutable and frozen per deployment (2026-09-03, registry 2026-09-22)

Sizing lives in an immutable registry and is frozen into
`desired_state.infrastructureProfile` at creation. A new size is a new
registry version; published versions are never edited. A topology-changing `minimal` profile (no NAT, fewer AZs)
needs a new infrastructure version and a security and cost review, not a
registry row.
See [`../infrastructure-profiles.md`](../infrastructure-profiles.md).


## Vendor-recommended, customer-chosen sizes (2026-10-15)

Deployz offers three sizes: Small (`small-v2`), Medium (`medium-v1`) and
Large (`large-v1`). The vendor sets a recommended size and a minimum size
per application and may override the recommendation per link; the
customer chooses any permitted size before installing, because the
customer pays the AWS bill and knows its load.

- **Capacity, not topology.** A size changes task CPU/memory, the RDS
  instance class and the cache node type only. The resource graph, AZ
  count, NAT gateway and task count stay the same, so no new
  infrastructure version or security review is needed, and every size runs
  the same compiled-stack code path.
- **Tiers, versioned profiles.** Vendors and links store a tier (`small`,
  `medium`, `large`); a deployment freezes the tier's current profile
  version. A later version of a tier never changes an existing deployment.
- **Links freeze their sizing.** A link keeps the recommendation and the
  minimum it was created with, so a vendor change cannot alter an offer a
  customer already holds. Old links (null) follow the application.
  Regenerating a reusable link is the vendor's deliberate step to re-offer
  it, so the fresh link takes the application's current minimum.
- **The customer approves one exact plan.** The confirmation echoes a
  fingerprint of the compiled footprint and estimate; the server recompiles
  inside the creation transaction and refuses a mismatch, so the stack can
  never differ from what the customer reviewed.
- **Classes.** `db.t3` (not `db.t4g`) and `cache.t4g` classes are offered in
  every supported Region for PostgreSQL 16, MySQL 8.0 and Valkey.
- **Deferred (post-MVP):** in-place resizing, autoscaling, more than one
  task per workload, per-workload sizes, arbitrary AWS sizing.

## Jev shadow analysis is not adopted (2026-09-20)

A shadow-mode second opinion from the Jev model agreed with the deterministic
analyzer on all 360 labelled decisions across 120 repositories, produced no
discriminative signal, and misclassified every verifiable failure case, most
with high confidence. The code stays behind `JEV_ENABLED` (unset in
production; the deploy workflow never sets the `JEV_*` keys) with zero
runtime effect. The evaluation corpus and `pnpm jev:eval` were removed on
2026-10-18 with the label benchmarks. Nothing routes a production decision
through Jev.

## Config secrets are KMS-encrypted; Lambdas fail closed (2026-09-22)

Vendor and customer secret values and pre-relay pending secrets are
encrypted with a dedicated KMS key (`alias/deployz-config-secrets`,
`RemovalPolicy.RETAIN`) using a fixed encryption-context purpose plus an
allowlisted context, enforced by IAM conditions. Inside Lambda a missing or
malformed key ARN fails initialization instead of falling back to a
reversible stub; outside Lambda the stub exists only for local development.
The worker may only decrypt. Legacy stub rows were migrated once and the
migration module removed; a rollback to pre-migration code would lose access
to stored secrets, so fixes go forward. See
[`../pending-secret-delivery.md`](../pending-secret-delivery.md).

## Raw CloudFormation events reach the customer page only behind a disclosure (2026-09-24)

The customer install page's live-activity feed keeps every customer-visible
field jargon-free (the stage headline, the step labels, the activity
messages, the friendly failure message), and puts the raw CloudFormation
events — including a failed resource's status reason — behind the collapsed
"View raw AWS events" disclosure and the technical-details facts. A
customer who opens the disclosure sees exactly what AWS reported; a
customer who does not never sees the jargon. `apps/api/src/customer-activity.test.ts`
pins both halves, and the E2E failure-path test asserts the raw reason is
hidden on the page, not absent from its payload.

## Runtime-v1 backward compatibility is not required for the MVP (2026-09-25, executed 2026-09-26)

Deployz is pre-launch. There are no live customer deployments on the
runtime-v1 template generation, so the MVP does not preserve
backward compatibility with it and does not build a migration path.

The four historical runtime-v1 template variants are reference
material, not compatibility contracts. Compiler-v2 became the sole
infrastructure-generation path for new deployments, as planned.
Internal test deployments may be recreated.

**Executed.** The relay now executes the frozen compiled artifact carried
in its INSTALL payload; the runtime-v1 machinery (template-variant
selection, the runtime-v1 application stack, the shadow-only integration,
v1↔v2 parity as a compatibility guarantee) is removed. The consequences
realized exactly as recorded: no migration layer was ever built, and no
dual runtime exists on any path.

What would change it: a contractual or operational requirement to
keep existing runtime-v1 deployments running after the MVP launches.

## Purge deletes every owned application secret regardless of generation (2026-09-26)

Purge's secret sweep keys on the `deployz:installation` tag, not on a
template-era allowlist: it deletes every tagged Secrets Manager secret the
relay owns **except** `deployz:component=bootstrap` — the relay's own
credential, which must survive so the relay can finish the purge. Earlier
purges only removed the compiler-v2 secret names; secrets left by any
other generation of the application stack would have survived purge
forever. Generation-agnostic deletion with the single bootstrap exclusion
is the invariant; the simulated `retained-delete-recovery` scenario and
the composite canary both assert a clean account after purge.

## Phase 3 passes without real-AWS validation (2026-09-27)

Phase 3 is an additive, spec-derived presentation cutover: existing
deployments render unchanged, lifecycle behavior is untouched, and the
simulated unit, contracts, web and E2E suites cover the behavior. The
phase gate therefore needs no AWS run. The Phase 2 carry-over
validations (`core` day-2 ladder completion; the `resilience` subcommand
plus RESTART-through-relay) and a full real-AWS lifecycle from a clean
account are deferred to the **Final AWS Qualification backlog**, to run
after the Phase 3 merge; the backlog is recorded in the
dynamic-infrastructure implementation plan. What would change it: any
further change that touches provisioning, lifecycle or the relay before
qualification has run.

## The MVP boundary expands to workers, RDS MySQL and migrations (2026-09-28)

Phase 4 moved three items from "rejected at analysis" into the supported
boundary: declared background worker processes, RDS MySQL, and
first-class one-shot migrations.

- **Workers** ride the workload model: one build artifact, one ECS
  service per workload, a frozen command per workload, stable kebab
  identities, no numbered fields. Only a declared run process provisions
  (a Procfile non-web entry, a Compose application service, an
  npm-script worker); weak evidence (queue libraries only) becomes a
  needs-input question, never an ECS service.
- **RDS MySQL** rides the same `relational_database` machinery as
  PostgreSQL: the resolver maps kind + engine to a capability, and
  networking, credentials, bindings, verification, retention and purge
  stay shared. The engine-specific part is one descriptor in the
  compiler. PostgreSQL manifests compile byte-identical output.
- **Migrations** are a one-shot workload with the frozen command baked
  into one named task definition. The relay runs only that family and
  can never receive a command string; the identity (sha256 over the
  frozen command plus the image digest) makes the run exactly-once per
  release. Failure stops the rollout, never the deployment — the
  deployment returns to `UPDATE_AVAILABLE` and the previous release
  keeps serving.

The one-build-artifact boundary is retained deliberately: multiple
build artifacts would multiply the release, build and rollback surface
for compositions the MVP target vendor does not have yet. A worker that
needs a different Dockerfile stays unsupported.

Private services were assessed and not implemented. The delivered
workload model (a workload kind plus `public: false` plus internal
networking) is expected to make them fall out naturally as a Phase 6
extension, not a rework.

Real-AWS qualification for the Phase 4 shapes is deferred: the evidence
is simulated E2E plus unit and contract tests, and the qualification
scenarios are recorded as pending in
[`../testing/aws-e2e.md`](../testing/aws-e2e.md).

What would change it: a vendor need for per-workload images (multiple
build artifacts), for services with no public exposure beyond workers,
or a failed real-AWS qualification of the recorded scenarios.

## The MVP boundary expands to SQS queues and scheduled jobs (2026-09-29)

Phase 5 moved two items from "rejected at analysis" or "not provisioned"
into the supported boundary: an SQS Standard queue (with an optional
dead-letter queue) and an EventBridge Scheduler schedule invoking a
one-shot scheduled ECS job.

- **Relationships are explicit graph edges, not inference.** A workload's
  use of a queue is a `produce` or `consume` edge; a queue's redrive
  target is a `dead-letter` edge; a schedule's target is an `invoke` edge.
  The planner validates the graph before any capability is resolved and
  fails closed: a queue with no producer or no consumer, a dead-letter
  queue that itself redrives, a schedule that does not invoke exactly one
  job, or a scheduled job invoked by more than one schedule all fail the
  plan rather than provisioning an orphan.
- **IAM is edge-derived and least-privilege, one role per workload.** Each
  non-web workload now gets its own IAM task role, built only from its own
  edges (`sqs:SendMessage` for a `produce` edge, the receive/delete/extend
  actions for a `consume` edge), so a producer never inherits a consumer's
  permissions and a worker never inherits another workload's queue access.
  This replaces the earlier single shared task role.
- **Detection requires strong evidence only.** A queue is provisioned only
  when its producer and consumer both resolve to a declared workload
  through bounded (depth-4) import reachability from that workload's own
  entry file, with no ambiguity. A scheduled job is provisioned only from
  an explicit production deployment declaration naming both a schedule and
  a command (a `render.yaml` `type: cron` service or a Kubernetes
  `CronJob` manifest) — never an in-process cron library, a CI-level
  schedule, a Vercel `crons` entry or a bare crontab file. Weak or
  ambiguous evidence always becomes a vendor question; Deployz never
  guesses and never provisions from it.
- **Only SQS Standard is supported, not FIFO.** FIFO's ordering and
  exactly-once semantics need application-level cooperation (message
  group IDs, deduplication) that Deployz does not verify. A FIFO queue
  request resolves to no capability and fails the plan rather than
  silently becoming Standard.
- **A dead-letter queue is the same SQS capability, not a separate
  resource kind.** It is an ordinary queue reached by a `dead-letter` edge
  from its source queue or schedule. For a queue, the compiler sets the
  source queue's `RedrivePolicy`; for a schedule, it sets the schedule
  target's `DeadLetterConfig` and grants the scheduler role
  `sqs:SendMessage` on that queue only.
- **A schedule targets its task family, not a pinned revision.** The
  compiler points the schedule at the revisionless task family ARN
  (`DeployzApp<Workload>`), the same family the relay registers each
  release's image into. A scheduled job therefore always runs the latest
  deployed image, mirroring how a service picks up a new release.
- **There is deliberately no execution-history subsystem for scheduled
  jobs.** Kept simple for the MVP; a job's outcome is visible only through
  the existing ECS task status and CloudWatch logs, the same as any other
  workload.
- **Both capabilities ship at `PREVIEW` maturity** until the real-AWS
  qualification recorded in [`../testing/aws-e2e.md`](../testing/aws-e2e.md)
  runs.
- **SQS usage in a repository is no longer an automatic rejection reason.**
  The earlier `sqs-event-consumer` rejection assumed any SQS consumer made
  the app an event-driven architecture Deployz could not host; Phase 5
  removes it, since a queue with a resolved producer and consumer is now a
  supported managed resource.

What would change it: the real-AWS qualification passing promotes SQS and
EventBridge Scheduler from `PREVIEW` to `SUPPORTED` maturity; a vendor need
for FIFO ordering or for scheduled-job execution history could revisit
those non-goals.

## Vendor runtime values reach running deployments (2026-10-02)

A saved or removed vendor runtime value now reaches every running
deployment of the application, the same way a customer override already
reaches that customer's deployment. Before, a vendor value reached only new
installations: a vendor who shipped a wrong value had no product path to
repair the customers already running it, because a deploy, a rollback and a
restart change only the image and never read configuration again.

- One `CONFIG_UPDATE` per customer with a connected relay; every message
  names its application, so a customer who runs two of the vendor's
  applications never receives one application's values or removals in the
  other.
- Vendor secret values never ride the queue. The relay decrypts them from
  its authenticated config read.
- A removed vendor default leaves a deployment only when that customer has
  no override for the key.
- Saving a decision (who provides a key) still starts no update.

What would change it: vendors who need staged rollouts of configuration
(one customer first) would need an explicit "apply to customers" step.

## The database spans all available AZs; the customer never picks one (2026-10-02)

RDS rejected installs with `InsufficientDBInstanceCapacity` because the
database subnet group only covered the two AZs that hold the private subnets.
The compute placement was correct and stayed correct; only the database had no
freedom to move. In a region where the requested instance class was exhausted
in those two AZs, the install could not succeed, and retrying it unchanged
could not succeed either.

- The relay discovers the region's available, enabled standard AZs through
  `DescribeAvailabilityZones` and passes them to the compiler as bounded
  `DbAz1`–`DbAz8` parameters. Fewer than two usable zones, or more than the
  eight slots, fails the attempt explicitly instead of silently narrowing.
- The compiler emits DB-only subnets for the slots beyond the two compute AZs.
  They are isolated — no NAT gateway, no internet route — and they exist only
  to give the subnet group somewhere else to go. The primary `/16` is fully
  allocated, so they live in a secondary VPC CIDR block.
- The DB instance's `AvailabilityZone` stays unset, so RDS picks one subnet
  from the group. The database remains **Single-AZ**, with its class, engine,
  storage, encryption, security, backups, deletion protection and retention
  unchanged.
- Placement is resolved only before a stack is created. An adopted or resumed
  stack keeps the placement it already has, and the extra subnets are owned,
  inventoried and purged with everything else.
- The failure now has its own code, `RDS_AZ_CAPACITY`, ahead of the generic
  database-create failure, so the customer reads "capacity unavailable, retry
  once the rollback finishes" instead of quota advice.

The database costs the same whether it lands in one AZ or another, but a
single-AZ database reached cross-AZ from the Fargate service can bill EC2
cross-AZ data transfer. That is shown as a usage-dependent charge, never as a
change to the estimated infrastructure total.

What would change it: a regional capacity crunch severe enough that a
Multi-AZ database or a different instance class is the only way through would
need a product decision, not a placement change — Multi-AZ roughly doubles the
database charge.

## A migration correction rides the migration seat (2026-10-02)

An existing deployment froze its migration command at creation. When that
command was wrong (for example an invented `npx …` the image could not
run), every release deployment failed `MIGRATION_FAILED`, and editing the
application changed only new deployments. The only repair was a new
deployment.

- The spec, the compiled artifact and the stack stay immutable. The
  application's migration setting and its vendor-override marker give the
  effective policy (frozen, corrected, or no separate migration), and each
  DEPLOY_RELEASE snapshots it when it is queued.
- The family-only payload contract gets one narrow amendment: the
  migration seat may carry the vendor's `command`. The relay accepts it
  only for a family that its deployment's own stack contains, puts it
  only into the application container of a new revision of that family
  (the compiler's command encoding), and runs that exact revision ARN.
  RunTask never carries a command override, and a top-level command is
  still dropped.
- A correction never adds a migration step to a deployment that was
  created without one; that needs a new deployment.
- Analysis stops adding `npx` without proof that the runtime image has
  the runner and the CLI. Uncertainty becomes a blocking vendor question.

Rejected: a RunTask command override (it bypasses the task definition the
relay can validate); recompiling the stack (it changes frozen
infrastructure); substituting `bunx` or installing tooling at run time
(Deployz would invent a command the vendor never ran).

Real-AWS qualification of the correction path is recorded as pending in
[`../testing/aws-e2e.md`](../testing/aws-e2e.md); the change deferred it
by instruction and did not waive it.

What would change it: a vendor need for per-deployment migration
commands, or relays that cannot be updated to read the seat's command.
## A configuration update settles on its rollout (2026-10-02)

CONFIG_UPDATE used to report success as soon as UpdateService returned. A
configuration that broke the application was rolled back by the ECS
circuit breaker while the job said it succeeded, and a pending secret was
cleaned up as delivered.

- Success now needs every changed service's rollout complete, with the
  deploy executor's gates. The rollouts ride the relay's pending marker
  and resume across invocations. A rollback fails the job; the lifecycle
  state and release pointers stay, and the failure is surfaced.
- The job error does not claim that the rollback restored secrets: a
  secret value already written stays written. Automatic secret
  restoration is out of scope.
- Service mutations never overlap. The claim route holds service
  mutations while one is running, and the relay hands back later
  mutations of a batch once one defers. CONFIG_UPDATE stays outside the
  unique index, so it can still be queued during an install; it is only
  handed out after the install settles.
- Without a queue (local development, simulated E2E) the API runs the
  CONFIG_UPDATE fan-out inline, the documented `queue.ts` contract, so the
  simulator covers the vendor configuration path.

Rejected: putting CONFIG_UPDATE into the one-active-job index (it would
lose secret values typed during an install); claiming one service
mutation per poll (it would delay every configured first start by a full
relay interval).

Real-AWS qualification is recorded as pending in
[`../testing/aws-e2e.md`](../testing/aws-e2e.md); the change deferred it
by instruction and did not waive it.

## A repository with no buildable Dockerfile is NOT_COMPATIBLE (2026-10-10)

The gate answered NEEDS_CONFIGURATION for a repository with no Dockerfile that
builds a production image. No Deployz setting adds a Dockerfile, so the answer
told the vendor something false: 19 of 28 gate false acceptances in the
fresh-100 run had this cause. The analyser now rejects (`no-buildable-dockerfile`)
when the full tracked path list shows no Dockerfile, only development-only or
template Dockerfiles, or a single Dockerfile that copies sources the repository
does not contain.

COMP-021 removed an earlier version of this check because the 200-file tree
cap made an absent `COPY` source prove nothing. The new check reads the full
tracked path list the fetch layer attaches, and it stays silent when that list
is missing, a Dockerfile in it was not fetched, a second candidate Dockerfile
exists, the repository has git submodules, or the source is a `COPY --from=` or
a generated directory (`dist`, `build`, `target`, …). The vendor-facing report
shows one blocking finding, "Has no Dockerfile that builds the app".

What would change it: a Deployz setting to supply a prebuilt image or a
Dockerfile path would turn the verdict back into configuration.

## A multi-process supervised image is NOT_COMPATIBLE (2026-10-10)

The gate accepted an image that runs several application processes under a
supervisor (s6-overlay or supervisord), for example api, cron, web and worker
in one container. The container starts and serves HTTP, but Deployz runs one web
process plus declared workers, each as its own service from the same image, and
it cannot split or scale the processes of one supervised container. The
analyser now rejects (`multi-process-image`) when the selected Dockerfile
installs s6-overlay or supervisord and copies two or more service definitions
(s6 `run` paths, supervisord `[program:]` sections) into the image.

A web-server front end (nginx, apache, httpd, caddy) and php-fpm count as one web
service, not as extra processes. Service files that the Dockerfile does not copy
(docs, examples, other images) do not count. A single supervised service stays
accepted.

What would change it: running several processes of one image as one Deployz
service, or a declared-workers import from a supervisor configuration.

## A deploy fails closed on a newly required database or cache (2026-10-12)

The stored manifest decision says a requirement change is reported as drift
and never applied. The deploy routes did not read that drift, so a release
of an application that now needs a database or cache was deployed onto a
stack that has neither. The task then runs with no `DATABASE_URL` or cache
binding. An application that falls back to local storage (for example
SQLite) when the binding is missing looks healthy while it writes customer
data to a disposable container.

`POST /api/deployments/:id/deploy` now refuses with `409
INFRASTRUCTURE_CHANGE_REQUIRED` when the deployment's frozen spec lacks a
database or cache that the application's effective manifest requires (the
same comparison as the readiness drift report). `deploy-bulk` skips that
deployment with the reason. A requirement that the application dropped
stays deployable, because the retained resource is only unused. Rollback,
restart and the post-install auto-deploy are not changed. The vendor fixes
the refusal with a new deployment, or by changing the requirement back
(a vendor override).

The check compares the frozen spec with the application's current analysis,
not with the release being deployed, because a release stores no spec.

What would change it: a stack-update path that adds a database or cache to an
existing deployment, or a per-release spec.


## Fix instructions: a deterministic plan, the model on OpenRouter (2026-10-13)

The previous fix prompt let per-finding template text and model prose decide
what the coding agent should do. Some of that text was out of date with the
product: it told agents to merge declared workers into the web process,
replace message queues with in-process jobs, delete deployment files, and
move a MongoDB data layer to PostgreSQL. It also listed a declared worker
as a blocker.

The plan is now deterministic (`planRemediation`): a class per finding, merged
and ordered, with conditional actions, constraints and completion criteria.
The model only adds repository-specific detail, and a safety filter drops
guidance that breaks the rules. Classification stays testable in CI, and a
model outage or a model change cannot change what the agent is told to do.

The model is Claude Opus 5.5 through OpenRouter, on its own settings
(`FIX_INSTRUCTIONS_AI_*`). Repository analysis and failure explanations stay
on the shared gateway. There is no automatic fallback between models. The
answer must come from the configured model, or the request fails with a
retryable 503. `FIX_INSTRUCTIONS_AI_PROVIDER=gateway` is the explicit rollback
to the previous model. The deploy keeps `gateway` until the repository
variable says `openrouter`, so production does not change before its
OpenRouter key exists.

What would change it: repository file contents in the prompt (the model sees
only structured facts and evidence today), or an asynchronous generation
path that removes the 25-second request budget.

## An install that never verifies fails after a bounded window (2026-10-14)

An installed deployment stayed INSTALLING for ever when the application never
passed release evidence. The watchdog only sweeps jobs, and no job is active
in that state, so nothing ended it.

The heartbeat now ends it. It is the only signal that carries the verdict, it
already runs every five minutes, and it needs no new scheduler or table. After
30 minutes from the latest settled install, deploy or configuration job, a
refusal that blames the application marks the deployment FAILED once, with a
code from the existing taxonomy (a new code would need a database enum
migration and copy in six places for no new remediation). The result is the
documented "first install failed" shape, so deploy again is the recovery.

Old connectors are excluded: with no release evidence the control plane cannot
tell a broken application from a connector that cannot report. They stay
INSTALLING with the upgrade-required flag. Stale or invalid evidence and a
configured first start at zero tasks are excluded for the same reason.

What would change it: a heartbeat-independent deadline (a scheduled sweep), or
a window per application size.
## Staging shares the production account and zone (2026-10-08)

The staging control plane is a second stack of the same CDK app in the
**same AWS account and Region** as production, and it shares the
`deployz.dev` Cloudflare zone. A second account and a second zone were
rejected for the MVP: both add a bootstrap, a billing surface and a
credential set to operate, for an environment whose only job is to prove a
change before it reaches customers.

What keeps the two apart is naming, not isolation by account:

- The stage selects the stack id, the config-secret KMS alias, the ECR
  repository and the prefix of the regional template buckets. Each stage's
  names are written out, never derived with a suffix, because the KMS key and
  the ECR repository are retained — a renamed key leaves stored ciphertext
  unreadable. An unknown stage value fails the synth instead of falling back
  to production's names.
- Staging's default hostnames carry the prefix `s-`, so its namespace guard
  can never write or delete a production `d-` record in the shared zone.
- Staging has its own `COOKIE_PREFIX`, GitHub App, OAuth app, auth secret and
  Cloudflare token.

Promotion to production needs an approval: a change is deployed to staging
first, and a human approves before the same commit reaches production.

What would change it: a staging workload heavy enough to contend with
production for account-level quota, or a compliance requirement to separate
non-production data, would need a second account.


## Environment values are GitHub Environment variables (2026-10-09)

Both deploy workflows carried production's own values as literals: the API
host, the dashboard host, the cookie domain, the Cloudflare zone id, the
default-hostname prefix and the Lightsail service name. A second stage could
then only be added by copying the file, and a literal left behind would
deploy a production value into staging — or push a staging image under
production's service name.

- Every environment-specific value is now a variable on the GitHub
  Environment that carries the stage's name, and each `deploy` job declares
  that Environment. A job without `environment:` resolves repository values
  only, so the declaration is what makes an Environment variable resolve.
  The key names did not change, so the existing secrets keep resolving.
- GitHub delivers a variable it does not hold as an empty string, and
  `collectEnvVars()` replaces the Lambda's whole environment, so a blank
  value deletes a capability from the running API. Both workflows therefore
  check every required key before `cdk deploy` and before the image build.
- The stage gate derives its rules from the stage name: outside production
  every host, cookie and service name the stage owns must carry the stage
  name, and production must carry no other stage's name. The rules compare
  the values against each other and against the stage name, so no production
  value is written in a workflow file. A production literal in a workflow
  file is what this change removes, and a rule that named production's values
  would put one back.

What would change it: a stage whose hosts cannot carry the stage name — a
separate domain per stage, for example — would need the gate to compare each
value against a per-Environment expected value instead of the stage name.


## GitHub Actions authenticates to AWS with OIDC (2026-10-09)

Both deploy workflows signed in to AWS with one long-lived access key, held as
a repository secret. The same key deployed every stage, a key that leaks does
not expire, and one key cannot separate staging from production.

- Each GitHub Environment has its own IAM role, and the `deploy` job assumes
  it with OIDC (`id-token: write`). The trust policy holds one statement, with
  `StringEquals` only: the subject must be
  `repo:thalia-apps@342445206/deployz@1339375286:environment:<name>` and the
  audience must be `sts.amazonaws.com`. A `StringLike` would also match
  another Environment. The repository uses GitHub's immutable subject, so the
  subject carries the owner and repository ids. A repository that someone
  creates again with the same name gets other ids and no credentials.
- The role ARN is the Environment variable `AWS_DEPLOY_ROLE_ARN`, not a
  secret. A role ARN is no credential, and a masked value would hide which
  role a run assumed. The completeness gate fails a run that misses the value,
  before any AWS call.
- `.github/aws/github-oidc.yaml` creates both roles, so the grant is reviewed
  in this repository instead of edited in the console. The account owner
  deploys that template by hand, with an admin identity: CI must not be able
  to widen its own permissions.
- Each role still holds no raw service permission on the stack. It assumes the
  CDK bootstrap roles, publishes the template objects of its own stage, and
  makes the Lightsail calls the web deploy needs.

Two limits stay. Both roles may assume the shared `cdk-hnb659fds-*` bootstrap
roles, so the staging role could deploy the production stack. The Lightsail
statement is account-wide, because a container-service ARN carries the service
id and not the service name and the services carry no tag, so no condition can
scope it. The live control is the stage gate and the protection rules on the
`production` Environment. IAM is the second layer here, and it is partial.

What would change it: a second AWS account, the post-MVP fix, would scope each
stage's role by account. A cheaper partial fix is to tag each container
service and add an `aws:ResourceTag` condition to the three taggable Lightsail
actions; that needs the owner to tag the existing production service by hand.


## One release workflow promotes a commit through staging to production (2026-10-09)

Both deploy workflows started from the same successful CI run on `main` and
deployed production directly. There was no promotion rule, and nothing in the
repository could add one: the `deployed/api` and `deployed/web` tags and the
`deploy-api` and `deploy-web` concurrency groups were repository-wide. A
staging deploy would move production's tag, so the next production gate would
compare against the staging commit, see no change and skip. A shared group
would make a staging deploy wait for a production deploy for no reason.

- `.github/workflows/release.yml` is the one entry point. It triggers on a
  successful CI run for `main` and releases the staging API and web app, then
  `staging-verify`, then the production API and web app. `staging-verify`
  polls staging's API, dashboard and marketing hosts. It is the single node
  both production jobs depend on, and the only check of the marketing host.
- The two deploy workflows are reusable workflows that take an `environment`
  and a `sha`. They keep their own `workflow_dispatch` path for one service, a
  rollback or a second staging deploy, and that input defaults to `staging`:
  an operator who forgets the flag must get staging, not production.
- The approval is the required reviewers on the `production` Environment,
  which both called deploy jobs declare. A calling job may not declare
  `environment:`, so the orchestrator cannot hold the approval itself. Both
  production jobs therefore wait together, and one approval releases both.
- The deploy tag comes from the environment: `deployed/api` and
  `deployed/web` for production, `deployed/staging/api` and
  `deployed/staging/web` for staging. The stage goes before the service in the
  name, because `refs/tags/deployed/api` is a file and `deployed/api/staging`
  cannot exist beside it. Each environment's gate compares against its own
  tag.
- The concurrency group moved from the workflow to the deploy job and carries
  the environment. A production job waiting for an approval must not hold a
  lock that stops the next staging deploy, and workflow-level `concurrency`
  cannot read `inputs`. `cancel-in-progress` stays `false`: GitHub cancels the
  running member of a group, which is the one thing that must never happen in
  the middle of a deploy.
- Every calling job passes `secrets: inherit` and declares `contents: write`
  and `id-token: write`. Inherit is needed because an explicit secrets mapping
  in a job that cannot declare an Environment would resolve every value at the
  repository level and pass production's secrets into the staging deploy. The
  permissions are a ceiling, never an elevation: a calling job that declares
  none hands the called workflow the default token, and both the OIDC step and
  the tag push fail.
- The gate's tip-of-`main` check runs before the approval, because the gate
  declares no Environment. The deploy job therefore re-reads the tip after the
  approval and fails a commit that has moved, instead of deploying a stale
  commit.

What would change it: a third stage, or a stage that must be released on its
own schedule, would need the release order to come from a list of stages
instead of the two pairs of jobs written out here.

## The per-environment workflow guards parse the workflows (2026-10-12)

`scripts/production-safety.test.mjs` found the deployed-environment block with
`indexOf('\n    env:\n')`, which is the first four-space `env:` in the file. A
job-level `env:` on a job before `deploy` would make the guard read the wrong
block and pass without checking anything, so the one rule that stops a
fixture-mode variable shipping to the live Lambda could go silent.

- Every per-environment guard now parses the workflow with the `yaml` package
  and reads a key path. A new job, a reordered job or a reformatted block
  cannot move what a guard inspects. The guards also cover `deploy-web.yml`
  and `release.yml`, not `deploy-api.yml` alone.
- The production Cloudflare zone id is matched by shape, `\b[0-9a-fA-F]{32}\b`,
  and never as a literal. `apps/api/src/env.test.ts` allows that literal only
  under `.github`, `.env.example` and `docs`, and it does not skip a
  `.test.mjs` file under `scripts/`. A shape keeps the guard file free of the
  production value, so the repository-wide zone-id guard keeps holding.
- Each guard names the files it covers. `aws-canary.yml` legitimately holds
  production values and the canary's own credentials, and `ci.yml` holds the
  simulator's fake credentials, so a repository-wide rule for either would
  fail today.
- The expected file set is pinned: the only `deploy-*` workflows the guards
  accept are `deploy-api.yml` and `deploy-web.yml`. A third deploy workflow
  fails that test until somebody gives it a `PATHS` dependency closure, a
  concurrency group and a service name, and names it in the guard file.
- The `workflow_dispatch` default of `staging` and `cancel-in-progress: false`
  are now guards, because an edit to either one is silent and reaches
  production. The bare `deployed/api` tag name for production and the absence
  of `release.yml` from the `PATHS` sets stay decisions, not defects: the tag
  name is the original repository-wide name, and `release.yml` only chooses
  what to release.
- `apps/api/src/env.test.ts` keeps its positional locators and stays out of
  scope. One guard protects the precondition they depend on instead: no job
  declared before `deploy` may carry a job-level `env:`. A job declared after
  `deploy` cannot move a forward `indexOf`, so the rule stops there.

What would change it: making the locators in `apps/api/src/env.test.ts`
structural would retire the precondition guard. A third stage, or a third
deploy workflow, would make the pinned file set and the two-file concurrency
comparison a list instead.

## Docker run-and-check replaces the label benchmarks (2026-10-16)

The Stage A repository-compatibility benchmark and the remediation benchmark
compare the Analysis with written labels. An audit found that the labels are
not trustworthy:

- The labels and the harness do not mean the same thing. The expected
  `migration` fact means "the application has migrations". The harness
  (`scripts/repository-compatibility/normalize.ts`, removed) compares it with
  "a separate migration command exists". This defect causes 43 of the 108
  unexplained mismatches.
- Claude models wrote the labels. The AI Analysis that replaces the rules
  uses the same models, so the labels and the Analysis share blind spots.

The Docker run-and-check test (`scripts/run-and-check/`) replaces both
benchmarks. It builds and runs real applications in Docker with PostgreSQL,
MySQL, Valkey and MinIO. It records what each application does, and it checks
each Analysis claim against that record with fixed code. The running
application is the truth, not a label. A recipe per repository holds inputs
only, never expected answers. Ten small fixture applications with known
answers test the harness itself. The test is the release gate for every
Analysis change: rules, prompts or models.

Limits:

- Docker on one machine does not test AWS IAM permissions, the load
  balancer, HTTPS certificates, TLS to RDS, the Fargate network or the relay.
  The Stage B real-AWS test (`benchmark:deploy`) continues to cover them on a
  few repositories.
- On a Windows on ARM machine, the amd64 application images run under QEMU
  emulation, and the services run natively as arm64. Emulation changes
  timing, CPU and memory use, and it can crash some builds. An x86_64 machine
  gives exact parity. A fact from a native arm64 run is evidence for
  behaviour only. It never confirms a Dockerfile or build claim.

Removal (2026-10-18): the label benchmarks (`scripts/repository-compatibility/`,
`scripts/remediation-benchmark/`, `scripts/jev-eval/` and their data under
`docs/testing/`) were removed. The checks for unsafe fix instructions moved
to unit tests in `packages/analysis/test/fix-instructions.test.ts`. The
Stage A rule tests in `packages/analysis/test/stage-a*.test.ts` stay. Stage B
takes its repositories from the recipes and does not grade the gate against
labels.

What would change it: an observation method that is less expensive than a
Docker run and as trustworthy (for example production telemetry from real
customer deployments), or a release gate that real-AWS runs can give at an
acceptable cost.

## A Host-checking app's health check also accepts 400 (2026-10-20)

Decision: when Analysis finds that the app checks the Host header (Django
`ALLOWED_HOSTS`, Rails `config.hosts`, ASP.NET `AllowedHosts`, Laravel
trusted hosts), the manifest sets `health.hostChecked` and the ALB target
group matcher is `200,400`. Other apps keep `200`.

Reason: an ALB health check always sends the task IP as Host, and AWS cannot
change it. A Host-checking app answers that probe 400 while it serves its own
domain, so it never became healthy. A 400 from the Host check still proves
that the process serves HTTP. The release probe uses the real domain and
still needs a success.

Rejected: asking the vendor for `ALLOWED_HOSTS=*` (it turns off the app's
Host protection), injecting the task IP (it changes on every replacement),
and a TCP health check (an ALB target group has none).

Compatibility: a relay validates the manifest with a strict schema and does
not read the flag, so the INSTALL payload leaves `health.hostChecked` out.

What would change it: a real-AWS run shows a Host-checking app that answers
400 while it is broken.

## Without health evidence the health check probes `/` (2026-10-21)

Decision: when Analysis finds no health route, no container HEALTHCHECK and
no health handler file, the health check probes `/`. The manifest sets
`health.redirectsAccepted`, and the ALB target group matcher is `200-399`
(`200-400` for a Host-checking app). The vendor is not asked. When the
repository has a health handler file whose route Analysis did not resolve
(`HealthController`, `HealthAction`, `health_check.ex`), the vendor is still
asked: that app has a health route, and its `/` can be a 404 (an API-only
app). A path that the vendor enters must answer 200.

Reason: the vendor question was the most common false problem of the
run-and-check exam. A web app with a page at `/` answers 200, or redirects to
a login or setup page. A redirect also proves that the process serves HTTP;
Kubernetes HTTP probes count 200-399 as success for the same reason. A
crashed app or an app that serves nothing at `/` (404, 5xx) still fails, and
the deployment rolls back.

Rejected: `/` with the default `200` matcher (most apps without a health
route redirect `/` to a login page, so they never became healthy), and
starting the image before the first deployment to try paths (it needs a safe
place to run customer code; post-MVP).

Compatibility: the relay does not read the flag, so the INSTALL payload
leaves `health.redirectsAccepted` out, as it does `health.hostChecked`.

What would change it: a real-AWS run shows an app without a health route
whose `/` redirects while the app is broken.

## AI-first application Analysis (2026-10-19)

**Superseded 2026-10-20** by "The AI Analysis answers only the open items".
The analyst no longer finds every fact, and the reviewer is removed.

The rules Analysis (`analyseRepo`) is a large set of hand-written detectors.
Each new stack, framework or repository layout needs new rules, and the
run-and-check exam shows that the long tail (PHP, Java, .NET, Elixir,
monorepos, unusual frameworks) is where the rules fail most. A model reads
these repositories better than a new rule per case.

Decision:

- An AI analyst (`claude-opus-5-5`) reads an evidence pack and proposes the
  manifest facts. Each fact has a value, a confidence and `file:line`
  evidence.
- The evidence pack comes from the existing detectors. They select the
  relevant files and signals within a size limit. Secrets are redacted
  before any model call. Repository files are untrusted data.
- Fixed checks verify each fact: the cited line exists and supports the
  claim; a required variable is an unguarded read with no default; the port
  agrees with the Dockerfile, the `HEALTHCHECK` or the `PORT` handling. The
  existing rejections stay deterministic and always win.
- A fact that passes the checks enters the `DeploymentManifest`. A fact that
  fails becomes a vendor question (NEEDS_CONFIGURATION). The AI never makes a
  silent guess.
- A reviewer model (DeepSeek V4 Pro, a pinned version) reads the same
  evidence pack and the analyst's facts and returns objections only. The
  first reviewer, GPT-6 Astra, cost about $0.27 of the $0.44 of each
  analysis; DeepSeek V4 Pro costs about $0.02, and it comes from another
  model family than the analyst, so it makes other mistakes. Jev was not
  chosen: its evaluation found no useful signal (see "Jev shadow analysis
  is not adopted"). A fixed check decides an
  objection. An objection that no check can decide becomes a vendor question.
- Both models go through Cloudflare AI Gateway, on its OpenRouter route
  with the OpenRouter key (the unified `/compat` endpoint answered 402 for
  these models), with a token budget, a timeout and a spend log for each
  call. The Analysis runs in the background
  analysis job (the worker Lambda) and its result is cached per commit.
- `ANALYSIS_ENGINE=rules|shadow|ai` selects the engine. The default is
  `rules`. `shadow` runs the AI next to the rules, stores its result and
  changes nothing. Any AI failure (an outage, a timeout, invalid output, a
  failed check) falls back to the rules Analysis. `ANALYSIS_ENGINE=rules` is
  the one-setting rollback.
- The operating principle does not change: the AI infers, deterministic code
  provisions. The AI never calls AWS, never generates infrastructure, never
  writes a secret value and never sets deployment or job state.
- The AI can remove a database that the rules require, only with high
  confidence and evidence that passes the checks (user decision,
  2026-10-20). An unused RDS instance is a needless cost and a needless
  vendor question; a wrong removal fails the deployment, so a medium or low
  confidence keeps the database.

Release gate: the AI engine must pass the gate in
[`../testing/compatibility.md`](../testing/compatibility.md#release-gate) in
two full exam runs, on the tuning set and on the holdout set (at least 10
holdout repositories). Then it runs in shadow mode in production. The switch
needs the user's go after the shadow measurements.

What would change it: the AI fails the gate after four tuning rounds (then
the AI role stays limited to the open questions, as today), the cost or the
time per analysis is above the budget, or shadow mode shows a new class of
failed deploy.

## One deployability outcome per repository (2026-10-20)

Decision: the readiness report gives one outcome. DEPLOYABLE: Deployz
settings only. DEPLOYABLE_WITH_CHANGES: a repository change from the closed
catalogue of safe fixes in the fix instructions. NOT_DEPLOYABLE: the app needs
a capability outside the MVP. One table (`FIX_CLASSES` in
`readiness-report.ts`) gives each finding a fix class (SETTING, CODE_CHANGE,
CAPABILITY_GAP), and the worst required item wins. Only NOT_DEPLOYABLE is
`NOT_COMPATIBLE`; the other two are `READY` or `NEEDS_ATTENTION`.

Reason: the report put every blocking finding in NEEDS_CHANGES, and
`verdictFromReadiness` showed it as NOT_COMPATIBLE, also when a known
repository change fixes it. On the 32 run-and-check repositories with an
observed outcome, the old verdict was correct for 20 and gave 9 false "not
compatible" results: a `.git` copy, an unbuildable Dockerfile, a
`*_CONFIG_DIR`, a Dockerfile in `kubernetes/minikube/` read as Google Cloud,
a `BTCPayServer.Tests/` compose file read as production, and a migration
command without a database. A false rejection loses a vendor who could deploy;
a fixable app needs instructions, not a refusal.

Rules:

- A finding is a CAPABILITY_GAP only when the app clearly needs it. When that
  is not clear, it is a CODE_CHANGE with a "verify" step for the coding agent.
  Several Compose application services and a MariaDB driver are CODE_CHANGE.
- SQLite is a CAPABILITY_GAP only when it is the only database driver.
- A migration command without a database is a configuration error
  (`migration-database-missing`), not a rejection.
- Build check: DEPLOYABLE shows "not yet confirmed by a build" until a
  release build passes. Failed release builds with no passed build move it to
  DEPLOYABLE_WITH_CHANGES with the build-failure details. Static rules do not
  predict every build failure (rallly, Smartstore, undb in the observations).

The deployment gate (`evaluateManifestReadiness`) still blocks every
repository change before a deployment: the outcome changes the verdict and
the vendor's next step, not what can deploy.

What would change it: a run-and-check measurement that shows a false
DEPLOYABLE or DEPLOYABLE_WITH_CHANGES for an app that needs a capability, or
a new MVP capability (a persistent volume, several services) that makes a
CODE_CHANGE a SETTING.

## The AI Analysis answers only the open items (2026-10-20)

Status: proposed. The switch waits for the release gate and a shadow period
in production. This decision replaces "AI-first application Analysis
(2026-10-19)".

The goal is one of three outcomes for each repository: deployable with
Deployz (1), deployable with changes (2), not deployable (3). In exam A
(`ai@6cc47cc6-examA`) the analyst found all ten facts again, and it agreed
with the rules on most of them (Redis 56 of 56, port 51 of 56, Dockerfile
50 of 56). It cost $0.46 on average ($0.86 at most) and took about 55 s.
It could not change a rejection, but most wrong outcomes come from
rejections (local state, a second Compose service, an unsupported
datastore). Its checks also added vendor questions (the start command for 21
repositories, required variables for 29).

Decision:

- The rules Analysis runs first. The AI answers only its open items: a
  blocker candidate where it is not known if the app needs the item, and a
  fact that the rules did not resolve (port, start command, health path,
  Dockerfile, migration mode). A repository with no open item makes no call.
- Each answer is closed. A blocker: required, optional by setting `<name>`
  (with the value and the engine it selects), or not used. A fact: a value,
  or unknown. Each answer has `path:line` evidence from one small evidence
  window for its question.
- One Claude Opus 5.5 call per repository. The reviewer model is removed
  from the MVP path; it is a post-MVP item.
- Fixed checks decide each answer ([`../ai-analysis.md`](../ai-analysis.md#ai-first-analysis-analysis_engine)).
  "Optional by setting": the evidence reads the setting and the setting
  selects an engine that Deployz provides. "Not used": no production source
  imports or connects to the item. A start command is the image CMD or
  ENTRYPOINT, or a script that the CMD runs.
- A checked "not used" or "optional by setting" dismisses the rejection.
  This changes the earlier rule that the AI never changes a rejection. A
  setting that Deployz does not set itself becomes a required vendor
  variable (outcome 2). Every other answer, and every failed check, keeps the
  rules value.
- The run-and-check report gives a 3x3 outcome matrix. The release gate adds
  two criteria: no predicted outcome 1 that is really 2 or 3, and fewer false
  outcome 3 than the rules baseline ([`../testing/compatibility.md`](../testing/compatibility.md#release-gate)).

Measured on the 58 exam repositories (tuning and holdout), after the merge
with the deployability outcome. The answers came from Claude Opus 5.5 in a
coding session (no API call), replayed through the production checks and
merge. Full exams on x86_64 runners, each full run twice: AI
`ai@080dad04-open-items` (run 39451043684), rules `rules@080dad04` (run
39451101030). The predicted outcome is the readiness report's `outcome`.

| | rules@0fc073b8 | rules@080dad04 | AI open items |
| --- | --- | --- | --- |
| Hidden problems, tuning + holdout | 2 + 0 | 1 + 0 | **0 + 0** |
| False problems, tuning + holdout | 11 + 6 | 6 + 5 | 6 + 6 |
| CONTRADICTED claims, tuning + holdout | 14 + 14 | 9 + 14 | 8 + 14 |
| Predicted 1, actually 2 or 3 | — | 5 + 8 | 2 + 4 |
| Predicted 3, actually 1 or 2 | — | 0 + 0 | 0 + 0 |

- CONTRADICTED claims are fewer than or equal to `rules@080dad04` for each
  claim type.
- The two hidden problems of `rules@0fc073b8` are fixed. repo-016 (Outline):
  the Dockerfile copies nothing from the repository and runs the floating
  `outlinewiki/outline-base` build, so it is not buildable (a repository
  change). new-14 (Logto): the AI could not resolve the migration of its
  required database; that migration question is now a change to verify
  (CODE_CHANGE, outcome 2), not a setting.
- Predicted 1, actually 2 or 3, is not 0 (the gate needs 0). new-27 and new-31
  do not build: the product's build check makes them outcome 2 after the
  first failed release build, but the harness does not apply it. new-20 and
  new-26 ask the vendor for a setting (a required variable) that the full run
  does not supply, so the harness counts them as 3. new-15 (Homarr, a second
  server on the same port) and new-17 (Espial, SQLite in `/app/data`) are
  real misses of the Analysis.
- False outcome 3 is 0 for both engines, so it cannot be fewer than the
  rules.
- 45 of 58 repositories have an open item. A pack is about 17,000
  characters (at most 34,000), against about 90,000 before. The cost and the
  time are not measured yet: the answers were not API calls.

What would change it: a full exam shows a hidden problem or a false
outcome 1 that the AI causes, the cost or the time per analysis is above the
budget, or shadow mode shows a new class of failed deploy.

### Live engine measurement (2026-10-21)

Two live runs of the production engine (`ANALYSIS_ENGINE=ai`, OpenRouter,
`anthropic/claude-opus-5.5`, prompt version 14) on main 0c21c52e:
`ai@0c21c52e-live` (run 39603707809) and `ai@0c21c52e-live2` (run
39603711909). Full exam of `ai@0c21c52e-live`: run 39630983428. The
comparison is with `ai@fac42408-open-items` (analyses run 39564872355, full
run 39591576160). These analyses also came from live gateway calls, not from
replayed answers. The rules baseline is `rules@bd38acd3` (full run 39591579170).

| | rules@bd38acd3 | ai@fac42408-open-items | ai@0c21c52e-live |
| --- | --- | --- | --- |
| Hidden problems, tuning + holdout | 1 + 0 (new-14) | 0 + 0 | **0 + 0** |
| False problems, tuning + holdout | 1 + 1 | 1 + 0 (new-7) | **1 + 0** (new-7) |
| CONTRADICTED claims, tuning + holdout | 9 + 12 | 8 + 12 | **8 + 12** |
| Predicted 1, actually 2 or 3 | 4 + 6 | 1 + 4 | **1 + 4** |
| Predicted 3, actually 1 or 2 | 0 + 0 | 0 + 0 | **0 + 0** |

Outcome matrix of `ai@0c21c52e-live` (rows: predicted 1, 2, 3; columns:
actual 1, 2, 3). Tuning: `15 0 1 / 4 7 8 / 0 0 3`. Holdout: `4 2 2 / 1 5 5 /
0 0 1`. new-14 and new-17 are decided here and not in run 39591576160,
because that run has no full-run result for them. Their outcomes agree with
the analysis.

- AI fallbacks: 0 in each run. 41 of 58 repositories make one call; 17 have
  no open item.
- Cost: $2.02 for each run of 58 repositories, $0.049 for each call on
  average. About 10,000 prompt tokens and 480 completion tokens for each call.
- Latency for each call: median 7.8 s and 7.5 s, 90th percentile 11.2 s and
  12.5 s, maximum 16.9 s.
- Stability: `pnpm runcheck:stability` finds 0 changed claims between the
  two live runs, and 0 between each live run and `ai@fac42408-open-items`.
- 66 questions in each run. The fixed checks accept 9 answers (7 migration
  modes, 1 health path, 1 port) and the same 9 in each run. No checked
  answer dismisses a rejection.
- 4 answers change between the three runs. The checks reject each changed
  answer, so the rules value stays: new-25 and repo-053 migration ("low
  confidence"), new-9 Compose services `not_used` ("exactly one listed
  service must build the app"), repo-204 health path `/rest/health` ("no
  cited line supports the claim").

The checks reject most of the answers that have a value. These are the
candidate fixes (no change in this measurement):

- "another open fact stays unresolved" rejects a correct-looking value
  (new-1 and new-23 health path, new-26 and repo-071 migration).
- A migration answer that cites a build file (`.csproj`, `pom.xml`,
  `Cargo.toml`, `build.gradle`) is rejected because the file is not on the
  start path (new-8, new-10, new-24, repo-074, repo-205). The prompt can ask
  for the boot code that runs the migration.
- "no cited line supports the claim" for new-1, new-13 and new-14
  migration commands.
- new-28: migration mode `none` with a database always needs a vendor
  decision, so that answer can never pass.
- The misses that stay are the same as before: new-15 (predicted 1, a second
  server on the same port) and new-7 (false problem, scoold).

## Application roles carry a permissions boundary (2026-10-21)

Decision: the CloudFormation execution role can create an IAM role, put an
inline policy on it or attach a policy to it only under `role/deployz/`, only
for its installation tag, and only when the role carries the connector's
`ApplicationRoleBoundary` managed policy. It can attach only
`AmazonECSTaskExecutionRolePolicy`, pass only `role/deployz/*` roles, and
change only `deployz-app*` S3 buckets. The relay passes the boundary ARN as
the template parameter `paramRoleBoundaryArn`.

Reason: before this, a template applied through the execution role could
create a tagged role with any policy and pass it to ECS, so the deploy path
was account administrator in one step, and the bucket actions reached every
bucket in the account. The customer guide said so, and a security review
would stop there. A boundary on the execution role itself does not help: a
boundary does not carry over to the roles a principal creates. Requiring a
boundary at role creation is the AWS-recommended way to delegate role
creation, and BYOC vendors that sell to security-focused customers
(StreamNative, Omnistrate) use it. The boundary grants only what the
compiler's roles use, with no IAM management, so a role under it cannot
create a way out.

Rejected: pre-creating every application role in the connector stack (the
roles differ for each workload and schedule, so it needs a topology
redesign), a CloudFormation Guard Hook that checks trust policies (more moving
parts and a per-operation cost; post-MVP), and a customer stack parameter
that denies all writes (it blocks deploys; post-MVP).

Compatibility: the template parameter defaults to empty, and an empty value
leaves the roles without a boundary, which is what a connector published
before this change expects. A connector with the boundary refuses, before
`CreateStack`, an artifact compiled before it, because CloudFormation would
refuse its roles mid-create; that deployment needs a new artifact. Existing
application stacks are never updated in place, and their deletes need no
boundary.

Known limit: IAM cannot limit a role's trust policy, so a template can still
create a role that another account can assume. The boundary limits that role
to the application's own data.

What would change it: a compiler role needs an action outside the boundary
(widen the boundary, as a new connector version), or a customer asks for
proof that no role trusts another account (then the Guard Hook).

## Billing pauses while a deployment does not serve the customer (2026-10-21)

Decision: a production deployment is billed only while it serves the
customer. The billing state machine has a `PAUSED` state. The 15-minute
billing safety job moves an ACTIVE deployment to PAUSED when its `state` is
`FAILED` or its `relayStatus` is `DISCONNECTED`. Billing resumes at the next
verified READY stage, or on the next safety-job pass when the connector is
connected and the deployment is `HEALTHY` or `UPDATE_AVAILABLE`. Removal
still stops billing permanently. TEST deployments and never-live
deployments are never billed. Each pause and resume is an `event_logs`
entry, and the Paddle quantity follows through the normal absolute
reconciliation.

Reason: the earlier rule (only LIVE and REMOVED moved billing, and no health
signal could) charged vendors for deployments that ran nothing for their
customers. The product owner decided that failed or disconnected
deployments must not be billed. A persisted state, not a value derived at
reconcile time, keeps each pause and resume auditable per deployment and
lets the billing page show active, paused and billed counts. Using the
persisted `relayStatus` (written only after 15 minutes without a check-in)
and the existing 15-minute pass means a short heartbeat gap never changes
the Paddle quantity, with no new scheduler.

Rejected: pausing on runtime health (`healthStatus` UNHEALTHY or DEGRADED).
It changes on every relay poll and would churn the Paddle quantity, and the
deployment can still serve part of its traffic. Pausing on a failed update:
the previous release still serves, so the deployment returns to `HEALTHY` or
`UPDATE_AVAILABLE` and stays billed.

Accepted cost: a disconnected connector pauses billing even when the
application still runs in the customer account, because Deployz cannot
verify it. A pause can lag the outage by up to 15 minutes after the
disconnect threshold, and a resume by the safety job by up to 15 minutes;
both favor the vendor.

What would change it: a vendor abuses the disconnect pause (keep the
application running and the connector stopped), or Paddle proration churn
from repeated outages shows in invoices (then add a minimum pause time).

## Connector IAM is limited to its own installation (2026-10-21)

Decision: every write grant of a connector is limited to its own
installation. Where AWS evaluates the `deployz:installation` tag, the limit is
the tag. Where it does not, the limit is the resource name
`deployz-app-<short installation id>-*`, which CloudFormation gives every
unnamed resource of the application stack. The relay passes only its own
execution role to CloudFormation. `ecs:RunTask` and `ecs:StopTask` carry the
`ecs:cluster` condition. Request-tag grants also refuse a resource that
carries another installation's tag. Only `ecs:DeregisterTaskDefinition` and
`secretsmanager:GetRandomPassword` stay on `*` among the writes.

Reason: several deployments can share one AWS account and Region, each with
its own connector. The earlier grants assumed one installation per account
and Region, so one connector could stop another deployment's tasks, empty its
buckets, delete its log groups and cache, or pass its roles. The fix is in
the connector template, so it reaches a customer only when the customer
updates the connector stack; it was done now, before more connectors are
installed with the wider template.

Rejected: a separate AWS account per deployment (customer burden, post-MVP)
and relay-code checks alone (the code already checks tags, but the IAM grant
is the boundary a security review reads).

Known limit: the relay permissions boundary is at the 6,144-character quota,
so it keeps the wider form of the name- and cluster-scoped statements; the
attached provisioner policies carry the limit. An untagged resource that is
not a Deployz resource can still be tagged by the execution role, which only
CloudFormation can assume for templates that Deployz compiles.

What would change it: an AWS action gains resource-level support (scope it),
or a compiler change names a resource outside the stack prefix (that resource
then needs a tag-scoped grant).

## The rules fallback is as safe as the AI path (2026-10-21)

Decision: production uses the rules result when the AI Analysis fails, so
the rules give no READY that the AI path does not give.

- Migration: when a required database has an unknown migration mode and a
  package script names a database step that Deployz cannot run (a
  `migrat…` or `alteration` key that is not a create, dev or build step),
  the rules ask `migration-command-needs-input` with fix class CODE_CHANGE
  (outcome 2). Logto (new-14) was READY and refuses to start until
  `npm run alteration deploy` runs. A question for every unknown migration
  was rejected: it made 28 more repositories outcome 2, and most of them
  are healthy because they migrate when they start.
- Multi-process image: a start script on the CMD/ENTRYPOINT chain that puts
  two or more long-running servers in the background (`&`) is a
  multi-process image, like s6-overlay or supervisord. A web-server front
  end and a migration step do not count. Homarr (new-15) starts nginx,
  Redis and Next.js from `run.sh`. In the full run nginx on the image port
  answers 502, and the run is not healthy.

Each rule changes one repository of the 58 recipes and 10 fixtures.

What would change it: a full exam shows a false problem from either rule,
or Deployz runs several processes of one image as one service.

## A vendor can dispute an allowlisted blocker (2026-10-23)

Context: rules and AI analysis cannot be right for every repository. A false
blocker (MongoDB in test fixtures, a development Compose service, a declared
volume that holds no data) stopped the vendor with no product path forward.
Only the AI could dismiss a blocker.

Decision: the vendor can mark a blocking finding as "not used in
production" when the finding is on a fixed allowlist
(`DISPUTABLE_FINDING_IDS`). The answer is an input to `analyseRepo`, so the
manifest, preflight and compiler see one result. It applies only while the
analysis finds the same evidence text, and it is kept across re-analysis.
Details: [`../ai-analysis.md#vendor-disputes`](../ai-analysis.md#vendor-disputes).

- The allowlist rule: a wrong answer only fails the vendor's own TEST
  deployment. GPU, architecture (Kubernetes, serverless, Terraform), no
  buildable Dockerfile and a `.git` copy stay hard blockers.
- The vendor answer and the AI dismissal have separate provenance. The AI
  never writes the vendor list.
- The storage findings are on the list with a "Files can be lost" warning,
  because the AI can already dismiss local-disk state.

Rejected: a conversational assistant (cost, prompt-injection exposure, and
every useful result must still map to the same closed set of overrides); a
new decision table with a proposal lifecycle (the dispute list on
`detected_metadata` and the evidence text give persistence and staleness
with no migration); a `deployz.yaml` repository file (post-MVP).

What would change it: dispute counts show a hard blocker that is often false
(add it to the list), a need for vendor-hosted external dependencies, or
TEST failures after disputes that show a finding must not be disputable.

## Staging deploys on merge until public launch (2026-10-23)

Context: Deployz is not open to the public. A merge waited for a second full
CI run on `main` (10 to 16 minutes) before staging, and production waited for
staging and an approval. This slowed development.

Decision: `release.yml` also triggers on a push to `main`. That run releases
staging only, in parallel with the CI run. The run that starts after CI passes
on `main` releases production only. It does not wait for the staging deploy
or `staging-verify`. The tip-of-`main` check, the stage gate and the
per-environment concurrency groups stay. The required reviewers on the
`production` Environment are a repository setting and stay independent of
this change.

- A commit can run on staging before its CI run on `main` finishes. A red CI
  run still stops production.
- A failed staging deploy does not stop production.

What would change it: the public launch. Then remove the `push` trigger,
release production again only after `staging-verify`, and make sure the
`production` Environment has required reviewers. This partly replaces the
2026-10-09 release decision, which stays the target shape.

## Staging is skipped until public launch (2026-10-23)

Context: after the previous decision, staging no longer delayed production,
but every merge still deployed it. Staging is not used for testing at this
stage.

Decision: `release.yml` no longer triggers on a push to `main`. The run after a
successful CI run on `main` releases production only. Staging deploys only
from a `workflow_dispatch` of `release.yml` with `environment: staging`. The
staging stack and Lightsail service stay as they are, so a dispatch still
works.

- Nothing deploys a commit before its CI run on `main` passes.
- No automatic deploy proves a change on staging before production.

What would change it: the public launch, or a need to test on staging before
production. Then release staging first and production only after
`staging-verify`, as the 2026-10-09 decision describes.

## Production deploys without an approval until public launch (2026-10-23)

Context: the production deploy jobs waited for a reviewer on the `production`
Environment. An approval that came after a newer merge failed the tip-of-`main`
check, so a release (#603) did not reach production until a later run.
Deployz is not open to the public, so the approval only slowed development.

Decision: the `production` Environment has no required reviewers. Its branch
policy stays: only `main` can deploy to production. A successful CI run on
`main` releases production at once. The tip-of-`main` check, the stage gate
and the per-environment concurrency groups stay. This is a repository
setting, not a workflow change.

- No human checks a commit before it reaches production. A red CI run still
  deploys nothing.
- A bad deploy is rolled back with a `workflow_dispatch` of `deploy-api.yml`
  or `deploy-web.yml` with an earlier `sha`.

What would change it: the public launch, or the first real customer on
production. Then set required reviewers on the `production` Environment
again, as the 2026-10-08 and 2026-10-09 decisions describe.

## No pull-request CI until public launch (2026-10-23)

Context: a change ran the full CI twice: once on its pull request (10 to 16
minutes) and once more on `main` before production. Deployz is not open to
the public, and many sessions open pull requests in parallel.

Decision: `ci.yml` runs only on a push to `main` and on `workflow_dispatch`,
and every run is the full regression. The `plan` and `pr-gate` jobs are
removed. A pull request is still required, but it has no required status
check (the "PR Gate" check is removed from the "restrict main" ruleset), so
it merges at once. The full CI run on `main` is the only gate before
production. To test a branch before a merge, dispatch `ci.yml` on that
branch or run `pnpm test:affected` locally.

- Production still gets only commits that passed the full regression, as
  they are on `main`.
- A broken change can reach `main`. Its CI run fails, nothing deploys, and
  every later merge waits for a fix. A later green run deploys everything
  before it.

What would change it: the public launch, or a red `main` that blocks merges
often. Then restore the pull-request trigger, the `plan` and `pr-gate`
jobs, and "PR Gate" as a required check, before the production reviewers
come back.
