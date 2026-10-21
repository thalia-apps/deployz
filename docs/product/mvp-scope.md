# Deployz MVP — scope, principles and non-goals

The canonical statement of what Deployz is, what the current MVP supports, and
what it deliberately does not do. For how the pieces fit together, see
[`../architecture.md`](../architecture.md). For the step-by-step vendor and
customer journeys, see [`user-flows.md`](user-flows.md).

## What Deployz is

Deployz lets a small B2B software vendor run its web application inside each
customer's own AWS account, without building a private-deployment platform.
The vendor connects a GitHub repository once. Deployz analyzes it, builds
immutable releases, and gives the vendor an install link per customer. The
customer opens the link, reviews what will be created and what it costs, and
approves one CloudFormation Quick Create stack in their own account. From
then on the vendor operates every customer deployment (deploy, roll back,
restart, reconfigure, diagnose, disconnect, purge) from one dashboard.

Deployz is a **software distribution platform for customer-owned AWS
accounts**. It is not a Terraform generator, a Kubernetes platform, a generic
AWS deployment tool, a cloud console, or a DevOps consulting service. The
product is the recurring lifecycle of *vendor × application × version ×
customer × AWS deployment*.

**Target vendor:** a software company of roughly 5–20 people with a working
SaaS product and customers who ask "can this run in our AWS account?".
**End customer:** an organisation that wants data control, AWS billing
ownership and infrastructure visibility, and that will not hand a third party
permanent AWS credentials.

## Product principles

1. **Opinionated beats flexible.** Deployz supports one architecture
   exceptionally well and says "we don't support that" rather than "we can
   probably make that work". Every variation adds failure modes, support load
   and security surface.
2. **Deterministic infrastructure.** Provisioning is compiled
   deterministically from the frozen deployment spec into a versioned,
   content-addressed artifact with known IAM policies. AI helps understand
   applications and explain failures; it never invents production
   infrastructure.
3. **Customer credentials never leave the customer's AWS.** Deployz never
   asks for access keys or administrator credentials. Everything that touches
   the customer's account runs inside it (the relay), egress-only.
4. **Zero professional services.** A deployment that needs custom
   infrastructure work is unsupported, not a support ticket.
5. **Application portability before deployment magic.** Incompatibilities
   are detected early, with evidence and fix instructions, instead of being
   worked around.
6. **Infrastructure complexity stays invisible.** Vendors and customers see
   applications, releases, customers, deployments and health, never raw
   CloudFormation or ECS vocabulary in the primary UI.
7. **Human support minutes per active deployment per month** is the
   operational north star. At the MVP price point, prevention,
   classification and deterministic fixes beat architectural flexibility.

## The supported application architecture

One deployment is one application stack in one AWS Region of the customer's
account:

| Component | What Deployz provisions | Notes |
| --- | --- | --- |
| Compute | One build artifact on ECS Fargate: a web service behind an Application Load Balancer, plus one private service per declared background worker, plus a one-shot migration task when the app has a migration command | Needs a Dockerfile that builds a production image: a repository with none (or only development or template Dockerfiles) needs a repository change (DEPLOYABLE_WITH_CHANGES) when the full file list proves it. Per-task CPU/memory comes from the size profile (Small 0.25 vCPU / 512 MiB, Medium 1 vCPU / 2 GiB, Large 2 vCPU / 4 GiB). The web desired count comes from the profile; each worker runs one task. Workers have no URL and no load-balancer route. |
| Database (optional) | RDS PostgreSQL 16 or RDS MySQL 8.0, `db.t3.micro`, 20 GB (autoscaling to 100 GB), gp3, 7-day backups, deletion protection | Provisioned only when the analysis manifest requires PostgreSQL or MySQL. **Retained** on disconnect. |
| Cache (optional) | ElastiCache Valkey (Redis-compatible), single `cache.t4g.micro` node, no TLS, no cluster mode | Provisioned only when the manifest requires Redis. Deleted on disconnect. |
| Storage | One S3 bucket, always created | **Retained** on disconnect. |
| Network | Dedicated VPC, public/private subnets, NAT, security groups | Plus isolated DB-only subnets in the remaining available AZs when a database is present. Deleted on disconnect. |
| Messaging (optional) | SQS Standard queue, plus an optional dead-letter queue (the same capability, reached by a redrive edge) | Provisioned only when the analysis finds strong evidence of both a producer and a consumer. FIFO is not supported. Deleted on disconnect. `PREVIEW` maturity. |
| Scheduling (optional) | EventBridge Scheduler schedule invoking one one-shot ECS scheduled job | Provisioned only from a `render.yaml` `type: cron` service or a Kubernetes `CronJob` manifest naming both a schedule and a command. Deleted on disconnect. `PREVIEW` maturity. |
| Endpoint | Permanent `https://d-<deployment-id>.deployz.dev` URL, plus an optional vendor-managed custom domain | See [`../networking-and-https.md`](../networking-and-https.md). |

The infrastructure is compiled at deployment creation from the frozen
deployment spec — compiler-v2 is the provisioning path, and no
pre-published application template exists. Every workload (web, workers,
migration) shares the one build artifact; there is exactly one image per
deployment. Sizing is
frozen per deployment in an immutable profile registry
([`../infrastructure-profiles.md`](../infrastructure-profiles.md)). Three
sizes exist: Small (`small-v2`), Medium (`medium-v1`) and Large
(`large-v1`); `small-v1` stays frozen for existing deployments. The vendor
sets a recommended size and a minimum size per application and can
override the recommendation per link. The customer chooses any permitted
size before installing. A size changes capacity only, never topology.

Plan and status payloads may also name `worker`, `queue` and `schedule`
component kinds. All three are real, provisioned components: a `queue` is
an SQS Standard queue, and a `schedule` is an EventBridge Scheduler
schedule invoking a one-shot scheduled ECS job. A vendor cannot hand-declare
either one; both come only from strong code evidence found at analysis
time (see "What the MVP does" below).

Deployz supports **17 AWS Regions** (`SUPPORTED_AWS_REGIONS` in
`packages/contracts/src/index.ts`). Production offers only the subset named
in the `DEPLOYABLE_AWS_REGIONS` GitHub repository variable, for which the
regional bootstrap artifacts are published; the live list is an operator
setting, not a value in this repository
([`../operations/control-plane.md`](../operations/control-plane.md)). The
Region is chosen when a deployment is created and is immutable afterwards;
see [`user-flows.md#who-chooses-the-aws-region`](user-flows.md#who-chooses-the-aws-region).

## What the MVP does

- **Repository analysis**: deterministic detectors (runtime, Dockerfile, port,
  health path, environment variables, PostgreSQL/MySQL/Redis/S3 requirements,
  declared worker processes, SQS queue producer/consumer detection, scheduled-job
  detection from `render.yaml` and Kubernetes `CronJob` manifests,
  unsupported-architecture rejections) with an AI
  fallback that only fills
  genuinely open questions. A queue or a scheduled job provisions only from
  strong, unambiguous evidence; weaker evidence becomes a vendor question
  instead. Output: the application manifest, a readiness
  report with one deployability outcome and, on request, fix instructions
  for a coding agent ([`../ai-analysis.md`](../ai-analysis.md)). The
  outcome is DEPLOYABLE (Deployz settings only), DEPLOYABLE_WITH_CHANGES (a
  repository change from the closed catalogue of safe fixes) or
  NOT_DEPLOYABLE (a required capability outside the MVP). Only
  NOT_DEPLOYABLE is "not compatible". DEPLOYABLE stays "not yet confirmed by
  a build" until a release build passes; a failed release build changes it
  to DEPLOYABLE_WITH_CHANGES.
- **Configuration**: container port, health path, migration command and
  requirement overrides; per-variable environment-variable classification
  (managed by Deployz / set by vendor / set by customer / optional) with
  KMS-encrypted vendor and customer values
  ([`../environment-variables.md`](../environment-variables.md)).
- **Releases**: CodeBuild builds a commit from the application's branch into
  an immutable ECR image digest. Failed builds expose redacted log evidence
  and an on-request AI explanation.
- **Test deployment**: one free TEST deployment per application into the
  vendor's own AWS account, using the same install flow customers use.
- **Customer install**: a reusable public install link or a targeted
  invitation, a no-account customer page that shows the plan, the AWS
  resources and a Region-priced monthly cost estimate, one Quick Create
  stack, live install progress, automatic first deploy and a permanent HTTPS
  URL.
- **Day-2 operations**: deploy a release (the migration runs once as a
  one-shot task before any service updates; an already-run migration is not
  repeated; a corrected migration command, or "No separate migration",
  applies to an existing deployment on its next release deployment without
  changing its infrastructure), roll back (never re-runs migrations and warns that it does not
  reverse them), restart, update
  configuration, retry a failed install, reset the relay, retry default
  HTTPS.
- **Health and status**: CloudFormation success never means healthy. The
  relay's heartbeat verifies ECS counts, ALB target health, the HTTP probe and
  the running image digest before a release is promoted
  ([`../deployment-resilience.md`](../deployment-resilience.md)).
- **Failure handling**: deterministic failure codes with a recoverability
  class, safe retry eligibility, and AI explanation only for codes the
  classifier cannot resolve.
- **Disconnect and purge**: Disconnect removes the application, network and
  cache but retains the database, its credentials and the bucket; Purge
  deletes the retained items. The customer deletes the connector (bootstrap)
  stack themselves.
- **Billing**: Paddle subscription, $49/month platform fee from the moment
  the vendor subscribes (before a customer can confirm an invitation, or when
  the vendor adds the first customer deployment) plus $19/month per
  production deployment while it serves the customer (a failed or
  disconnected deployment is paused and not billed); the
  evaluation (analysis, configuration, releases, one TEST deployment) is
  free. See [`../billing/paddle-billing.md`](../billing/paddle-billing.md).
- **Team Admin**: an internal support and recovery console with read-only
  "view as vendor" sessions and audited recovery actions
  ([`../admin/team-admin.md`](../admin/team-admin.md)).

## Explicit MVP non-goals

Rejected at analysis time, with evidence, never silently adapted:

- Scheduled work is provisioned only from a `render.yaml` `type: cron`
  service or a Kubernetes `CronJob` manifest. In-process cron libraries, CI-level
  schedules (GitHub Actions, etc.), Vercel `crons` and crontab files never
  provision a schedule; Vercel `crons` and a crontab file each raise a
  vendor question instead. Worker-like code with no declared start command
  is not rejected — it becomes a needs-input question and Deployz never
  provisions it from weak evidence.
- FIFO SQS queues: only Standard queues are supported. A FIFO queue request
  fails the plan rather than silently becoming Standard.
- Message brokers other than SQS Standard: Kafka, RabbitMQ.
- Converting a repository's existing Redis usage into an SQS queue, or any
  other cross-technology substitution.
- AWS Lambda as a queue consumer or a schedule target. A scheduled job and a
  queue consumer both run as ECS Fargate tasks.
- Scheduled-job execution history and monitoring. Deployz has no dedicated
  execution-history subsystem; a job's outcome is visible only through the
  existing ECS task status and CloudWatch logs.
- Databases other than PostgreSQL and RDS MySQL: MariaDB (the MySQL
  dialect Deployz does not host), MongoDB, SQLite,
  Elasticsearch/OpenSearch, ClickHouse, embedded JVM databases.
- Redis Cluster, Redis Stack modules, TLS Redis.
- Compose application services beyond the web service and declared
  workers (extra long-running application services), an image that runs
  several supervised processes (s6-overlay, supervisord, or a start script
  that puts two or more long-running servers in the background), Kubernetes,
  Serverless/SAM, the
  repository's own Terraform/Pulumi/CloudFormation, Azure, GCP.
- Persistent volumes or local disk state (including a data directory or a
  configuration file that the image expects to be mounted), GPUs, Windows, ARM64 or privileged
  containers.

Not provided by the platform:

- Existing customer VPCs or databases, PrivateLink, Direct Connect, VPN,
  private-only applications (services with no public exposure beyond the
  declared workers), custom proxies or DNS architectures, custom IAM,
  accounts whose SCPs block the standard stack.
- A second build artifact per deployment — every workload shares the one
  image, so a worker that needs a different Dockerfile is unsupported.
- Multi-Region or active-active deployments, on-premises, air-gapped
  environments.
- Resizing an existing deployment, autoscaling, arbitrary AWS sizing,
  more than one task per workload, changing the topology of an existing
  deployment (a new requirement means a new deployment), per-customer builds.
  A deploy to a deployment whose application now needs a database or cache
  that the deployment does not have, a different database engine (PostgreSQL
  or MySQL), or a different set of workers, queues or schedules (added or
  removed) is refused (`409 INFRASTRUCTURE_CHANGE_REQUIRED`); a bulk deploy
  skips that deployment with the reason, and the post-install auto-deploy is
  not queued. A dropped database or cache, and changes to the runtime, port,
  health path, environment values or migration command, stay deployable.
- Customer-side controls inside Deployz: the customer approves the Quick
  Create and can only uninstall through the AWS console.
- Deployment notifications by email or Slack, vendor-branded install pages,
  customer-owned ECR, backup management, release approval workflows,
  scheduled releases, webhooks.
- Application-level observability. Customer runtime logs stay in the
  customer's account and Deployz never copies them out.

## Known limitations of the current implementation

Deliberate trade-offs that are documented rather than hidden:

- **Rollback never reverses schema migrations.** Every rollback affordance
  carries the warning "Application rollback does not automatically reverse
  database migrations."; vendors must write backward-compatible migrations.
- **Default-URL traffic passes through Deployz's Cloudflare edge.** The
  permanent `d-*` hostname is a proxied Cloudflare record; a custom domain
  routes directly to the customer's ALB.
- **Port-mismatch diagnosis is imprecise.** Deployz has no runtime log
  access by design, so a wrong container port surfaces as a health-check
  failure.
- **Retained resources cost money until purged.** After a disconnect the
  database, its credential secrets and the bucket remain in the customer's
  account until the vendor runs Purge or the customer deletes them.
- **A failed first install can leave empty credential secrets** in the
  customer account; they hold no customer data.
- **Per-deployment isolation is expensive.** A dedicated VPC with NAT and a
  dedicated ALB dominates the per-deployment AWS cost (roughly $77–114 per
  month before the application's own usage).
- **The shared control-plane ECR repository** is protected by unguessable
  UUID-namespaced tags, not per-application repositories.
- **No runtime-v1 backward compatibility.** Deployz is pre-launch; the MVP
  runs on compiler-v2, and the earlier static-template generation was
  removed rather than preserved.
- **A queue or a schedule cannot be hand-declared.** Both are provisioned
  only from strong code evidence; a vendor has no field to declare one
  directly.
- **Ambiguous queue or schedule evidence always becomes "Needs input", never
  a guess.** A workload that only reads a queue URL environment variable
  without ever calling an SQS operation gets no binding at all.
- **SQS and EventBridge Scheduler are not yet qualified on real AWS.** Both
  ship at `PREVIEW` maturity pending the real-AWS E2E qualification run;
  see [`../testing/aws-e2e.md`](../testing/aws-e2e.md).

## Deferred (post-MVP) items

Recorded so they are not mistaken for gaps:

- FIFO SQS queues and scheduled-job execution history/monitoring (see
  "Explicit MVP non-goals" above).
- A topology-changing `minimal` size profile; it needs a new
  infrastructure version and a security/cost review. In-place resizing of
  an existing deployment.
- Removal of the legacy deploy-link flow
  ([`../deploy-links.md`](../deploy-links.md)).
- Customer-provided build-time values, Dockerfile `ARG` detection, format
  validation beyond `_URL`/`_EMAIL`/`_PORT` names.
- Deployment notifications, ECR lifecycle policies, per-application ECR
  repositories, an `ANALYZING` sweeper, and a product exit for a DESTROY stuck
  in `DELETE_IN_PROGRESS`.
