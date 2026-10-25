# Deployment resilience — how the lifecycle stays recoverable

How Deployz keeps deployments from becoming duplicated, stuck, misreported,
or unrecoverable. **Read this before changing deployment/job/relay logic.**
For the test harness, see `docs/testing/simulated-e2e.md`; for diagnosing
a live deployment, see
`docs/operations/troubleshooting.md`; for the surrounding architecture, see
`docs/architecture.md`.

The guiding principle: the control plane does not try to prevent every AWS
or application failure. It always knows what happened, preserves the safest
known state, and provides a deterministic path forward.

## The domain model

- **Deployment** (`deployments` row) — the long-lived customer environment.
  Its `state` is the lifecycle of the environment, deliberately distinct
  from the outcome of any one operation and from runtime health
  (`healthStatus`: UNKNOWN / HEALTHY / DEGRADED / UNHEALTHY) and relay
  connectivity (`relayStatus`: CONNECTED / DISCONNECTED / UNKNOWN), which
  are separate columns. The states and their transitions:

  | State | Entered when | Leaves to |
  | --- | --- | --- |
  | `NOT_INSTALLED` | deployment created | `WAITING_FOR_RELAY` (customer launches the Quick Create), `DELETED` (disconnect before install) |
  | `WAITING_FOR_RELAY` | launch recorded | `INSTALLING` (relay registers, INSTALL job created), `DELETED` |
  | `INSTALLING` | INSTALL claimed; also a retry-install | `HEALTHY` (heartbeat verifies runtime health after INSTALL success), `FAILED` (INSTALL fails, or the application never verifies within its window) |
  | `HEALTHY` | runtime health verified; a day-2 job succeeded with no newer release | `UPDATING`, `UPDATE_AVAILABLE`, `DELETING` |
  | `UPDATE_AVAILABLE` | a newer READY release exists | `UPDATING`, `DELETING` |
  | `UPDATING` | DEPLOY_RELEASE / ROLLBACK / RESTART running | `HEALTHY` or `UPDATE_AVAILABLE` (success, or a failed day-2 job whose previous release still serves), `FAILED` (a failed first deploy of a configured-first-start install) |
  | `FAILED` | first install or destroy failed; an installed application never verified within its window | `INSTALLING` (retry-install), `UPDATING` (deploy again after a first-start failure or an unverified install), `DELETING` |
  | `DELETING` | DESTROY queued | `DELETED` (success or force-complete), `FAILED` (destroy failed) |
  | `DELETED` | terminal; `cleanupState` tracks purge (`SKIPPED_RELAY_OFFLINE`, `PURGE_FAILED`, `COMPLETE`) | — |

  `DISCONNECTED` exists in the enum but nothing writes it as a deployment
  state; relay loss is `relayStatus`, not a lifecycle state.
- **Release** (`releases` row) — an immutable version/build.
  `currentReleaseId` points at the release that is really running, and only
  the heartbeat's digest reconciliation advances it. The control plane
  decides from that heartbeat's own `observedState.releaseEvidence`
  (`evaluateReleaseEvidence`), never from stored state: every workload the
  frozen spec requires must be observed with rollout COMPLETED, full and
  non-zero task counts and one image digest, the public workload needs
  healthy ALB targets, and the public HTTP probe must succeed. Evidence that
  is missing, stale or older than the last accepted evidence promotes nothing.
  The promotion transaction locks the deployment row and re-checks for an
  active mutating job, so a job cannot be overrun.
  `currentReleaseConfirmedAt` records the evidence that confirmed the current
  release (a first promotion or a re-confirmation of the same digest). The
  derived `servingRelease` is confirmed only while no deploy, rollback or
  restart settled after that evidence, so a failed update never leaves the
  previous release shown as confirmed until fresh evidence re-confirms it.
  `deployment.reconciled` carries `kind: 'initial' | 'drift'`.
  A SUCCEEDED DEPLOY_RELEASE/ROLLBACK job result alone never advances the
  pointer, so after any failure it still names what is really running. There
  is no separate lastHealthyRelease column because `currentReleaseId` IS that
  pointer by construction.
  A release is built once. A redelivered `BUILD_RELEASE` message for a
  release that is READY, or whose build already started, does nothing
  (`buildRelease` in the worker), so a READY digest is never rebuilt,
  replaced or marked FAILED. Only a failure before any build started is
  retried. A release that becomes READY flips a HEALTHY deployment to
  `UPDATE_AVAILABLE` only when it is newer than that deployment's current
  release.
- **Customer** (`customers` row) — who the deployment is for. `name`, `email`
  and `company` are contact metadata the vendor edits freely; the immutable
  `id` is the only thing anything is anchored to (`deployments.customer_id`,
  `application_configs.customer_id`, `event_logs.customer_id`). Email is never
  an identifier and is not unique. So `PATCH /api/customers/:id` writes three
  text columns and nothing else: no install link is reissued, no deployment
  changes hands, nothing in AWS is touched. `DELETE /api/customers/:id`
  refuses any customer that still has a deployment row — including a `DELETED`
  one, which may hold retained resources — because removing a record must
  never become a path to removing infrastructure. Disconnect and Purge on the
  deployment stay the only things that reach a customer's AWS account.
- **Operation** (`deployment_jobs` row) — one durable mutation (INSTALL,
  DEPLOY_RELEASE, ROLLBACK, RESTART, CONFIG_UPDATE, DESTROY, PURGE, domain
  jobs). Carries identity (`idempotencyKey`), lifecycle
  (`REQUESTED/QUEUED/WAITING/RUNNING/SUCCEEDED/FAILED/CANCELLED`), progress
  (`lastProgressAt`), classification (`failureCode`), and the watchdog's
  re-offer counter (`reconcileCount`).

## A failed update is not a failed deployment

The core semantic rule (`deploymentStateAfterFailedJob` in
`@deployz/contracts`, applied identically by the relay result route, the
watchdog, and the stack-event progress route's settlement backstop):

- A failed **day-2 operation** (deploy/rollback/restart) on a deployment
  with a running release returns the deployment to `UPDATE_AVAILABLE` (a
  newer READY release exists) or `HEALTHY` — the ECS circuit breaker
  restored the previous release, which never stopped serving. A running
  install counts here even when `currentReleaseId` is still null: the
  pointer advances only once the heartbeat verifies the auto-deployed
  release, so a SUCCEEDED install is itself a running workload. The FAILED job
  carries the failure; the status derivation surfaces it
  (`deploymentStatus.failure`) without regressing the live stage, and the
  vendor UI adds "The previous version is still running."
  The circuit breaker restores only a service whose own rollout failed. A
  worker has no health check, so its rollout can complete on the failed
  release. The relay therefore records each service's revision before it
  rolls the service (`previousTaskDefinitionArns` on the pending marker),
  and when the update fails it puts every service still on its new
  revision back on that one (`packages/relay/src/deploy.ts`).
- A failed **first install** or **destroy** marks the deployment `FAILED` —
  there, the operation's failure IS the environment's.
- **Install follow-ups are durable.** A successful INSTALL needs two
  follow-up jobs: the first `CONFIG_UPDATE` (only when there is
  configuration to apply) and the auto-deploy of the newest READY release.
  Both use keys tied to the install job
  (`<id>:CONFIG_UPDATE:install:<installJobId>`,
  `<id>:DEPLOY_RELEASE:install:<installJobId>`). The config job is created
  first; the deploy is never created when the config job could not be. The
  result route, a replayed INSTALL result, and the relay heartbeat all run
  the same idempotent `ensureInstallFollowUps` (`apps/api/src/server.ts`),
  so a control-plane crash after the settlement transaction is repaired by
  the next heartbeat, not by the watchdog. The decision is stored on the
  install job (`result.followUps.autoDeploy`: `queued`, `no_ready_release`,
  `migration_workload_missing`, `topology_changed`, or `superseded` when a
  later DEPLOY_RELEASE, ROLLBACK or DESTROY exists). A stored decision ends
  the repair; so does a DELETING or DELETED deployment. A failure stores
  nothing, so the repair retries. The heartbeat repairs only installs that
  finished in the last 24 hours.
- A **configured first start** (DEPLOY-009): when a vendor value or a
  Deployz-generated secret must reach the task before it can boot
  (`configPrecedesFirstStart`, `apps/api/src/install-config.ts`) and a READY
  release exists, the INSTALL creates the stack with `param_DesiredCount=0`
  and carries `startAfterConfig` in its payload. The stack completes without
  ever running an unconfigured task; the post-install `CONFIG_UPDATE`
  (queued first) registers the configured task-definition revision, and the
  auto-deploy of the newest READY release scales the service up and waits
  for the rollout (`packages/relay/src/deploy.ts`, `FIRST_START_DESIRED_COUNT`).
  The configured task definition must be attached before first scale-up.
  Command order alone does not guarantee this: two relay invocations can
  run the two commands at the same time, and a failed CONFIG_UPDATE does not
  stop the deploy. So the deploy scales a zero-task service only when its
  revision already carries the effective configuration
  (`unappliedConfigurationKeys`, `packages/relay/src/config-update.ts`). If
  not, it changes nothing, keeps zero tasks, and stays in progress until a
  CONFIG_UPDATE attaches the configured revision. Attaching it is an ECS
  rollout, and while the template's deployment is still `ACTIVE` beside it,
  ECS can start a new task in that older deployment. So the deploy also
  waits until the configured revision is the service's only deployment.
  The scale-up then sets that revision and the task count in one
  `UpdateService`.
  Such an install counts as a running workload only once a deploy has
  started it (`hasStartedInstall`), so a failed first deploy marks the
  deployment `FAILED` like a failed install would; the relay scales the
  rolled-back service back to zero so the template's unconfigured
  definition never churns. Recovery is deploying again after the
  configuration is fixed (`requireDeployableState` allows a FAILED
  deployment whose install succeeded); retry-install stays for installs that
  never created a stack.
  Until that first deploy succeeds the application has not started and its
  health is unverified: the install event reads "Infrastructure ready"
  (`startAfterConfig` in its payload), the step stays on starting the
  application, and the infrastructure card shows the application as pending.
- A failed **CONFIG_UPDATE** or **PURGE** never touches deployment state
  (a failed purge used to resurrect a DELETED deployment); a purge failure
  lands on `cleanupState: PURGE_FAILED` instead, which keeps it retryable.
  A failed CONFIG_UPDATE keeps the lifecycle state and the release
  pointers; the status derivation surfaces it while it is the latest
  configuration attempt (a failed release update takes precedence).
  Domain jobs (CONFIGURE_DOMAIN/REMOVE_DOMAIN) follow the same rule: their
  failures surface on the `custom_domains` row, never on the deployment.

The customer-facing retry (`POST /api/install/:id/retry`,
`POST /api/deploy-links/:id/retry`) re-arms a first install with a fresh
enrollment code and credential. It needs the link token (`x-deployz-token`;
the install link id alone gets a 404). It is refused after any successful
install and outside NOT_INSTALLED, WAITING_FOR_RELAY and INSTALLING (for
example while a DESTROY runs). A retry during INSTALLING is allowed on purpose
when the customer abandoned the attempt, but not while a connected relay is
running the INSTALL job (`409 INSTALL_IN_PROGRESS`). A FAILED
install is the vendor's to retry (retry-install, or a relay reset when the
connector is disconnected), so the customer pages show no retry for it and
the route refuses it.
When a previous attempt reached the customer account (a connector registered,
or an earlier retry already kept its stack) the retry keeps the same bootstrap
stack name. The API returns `quickCreateUrl: null` and `existingStackUpdate`,
so the customer UPDATES the existing connector stack with the new credential
and enrollment code. The same installation re-enrolls, and its INSTALL carries
`recovery` so the failed application stack is recovered. A retry for a
connector that never registered gets a fresh Quick Create and stack name.

Retrying a failed update is just deploying again — `requireDeployableState`
allows it, and `retryAwareIdempotencyKey` mints a fresh attempt key once the
newest attempt under a base key is FAILED. Application rollback restores the
image and service configuration only; it never reverses database
migrations (documented limitation).

A READY release is deployable only while its image still exists in the
control-plane registry. `requireDeployableRelease` asks the registry at
request time (deploy, rollback, bulk deploy, the post-install auto-deploy),
so a release the page listed before its image was deleted is refused with
409 `RELEASE_UNAVAILABLE` rather than queued to fail; the release is marked
`image_unavailable_at` (sticky, served as `UNAVAILABLE`) and the running
release is untouched. The uncertain-result rule applies here too: a registry
that does not answer marks nothing and lets the deploy proceed, where the
pipeline's own image-pull failure and the circuit breaker stay honest
(`apps/api/src/release-images.ts`, `release-images.test.ts`).

## Migrations run once, before the rollout, and never on rollback

A deployment whose frozen spec carries a migration workload compiles one
`AWS::ECS::TaskDefinition` (family `DeployzAppMigration<suffix>`, see
"Task families belong to one installation" below) with the migration command
baked in at compile time. DEPLOY_RELEASE then runs a
fixed order:

``` text
install / database ready
    → run the migration task once (exit 0 required)
    → roll every service to the new digest
```

- **Ordering.** The migration always runs after the infrastructure and
  the database are ready and before any service updates.
- **Failure.** A non-zero exit or a stopped task fails the job with
  `MIGRATION_FAILED` (family, exit code, stopped reason). No service is
  updated, the previous release keeps serving, and the deployment
  returns to `UPDATE_AVAILABLE` — a failed migration is a failed update,
  not a failed deployment.
- **Verdict.** Only the application container's own exit code 0 succeeds.
  ECS reports runtime containers without their `essential` flag, so the
  relay finds the application container in the exact revision the task ran
  (its one essential container that runs the release image) and reads that
  container's exit code by name. A missing or ambiguous container, or a
  missing exit code, fails `MIGRATION_FAILED`; it never succeeds. A failed
  AWS read defers to the next poll on the same task. The crash-loop detector
  and the install failure evidence read exit codes the same way: an exit of
  a helper container (the RDS CA init container) never counts as the
  application's.
- **Exactly-once by identity.** The deploy payload's migration identity
  is sha256 over the effective command (the frozen command, or the
  vendor's correction) plus the image digest. A SUCCEEDED DEPLOY_RELEASE
  job row carrying that identity proves the migration ran: a relay retry
  of a confirmed identity skips the run, while within one rollout the
  same task ARN resumes. A failed job never confirms an identity. A
  correction is a new identity, so it runs also for the same image.
- **Trust boundary.** The relay runs only the family the control plane
  names, and only when the deployment's own stack contains a task
  definition of that family. The payload carries `{family, identity}`; a
  top-level command string is rejected and dropped. The one, narrow
  amendment is the seat's own optional `command` (see "Migration recovery
  on an existing deployment" below): the relay puts it only into the
  application container of a new revision of the named family, then runs
  that exact revision ARN. RunTask never carries a command override.
- **Install and domain payload checks.** The relay refuses an INSTALL whose
  `templateUrl` is not an `https` S3 bucket URL, and one whose `stackName`
  is not the installation's own `deployz-app-<id>` stack. It deletes a
  certificate only when the certificate carries this installation's tag.
  Pinning the exact template bucket host is a post-MVP item.

- **Analysis freezes only a safe command.** `selectMigrationScript`
  (`packages/analysis`) accepts only a script of the deployed app's own
  package that applies pending migrations. It rejects create, generate,
  push, reset, rollback and seed steps, test runs, copy/build/rename steps,
  chains with an unsafe step, workspace-filter or `../` commands, and a CLI
  that is only a devDependency (unless the final Dockerfile stage keeps dev
  dependencies). If the image already migrates at boot (CMD/ENTRYPOINT
  chain, uwsgi hook, binary flag, or `RUN_MIGRATIONS`-style ENV), the mode
  is `startup` and no command is frozen. If nothing is safe, no command is
  frozen and the "no migration command" warning stays.

### Migration recovery on an existing deployment

The deployment's spec, compiled artifact and stack topology stay frozen.
The application's migration setting and its vendor-override marker
(`detected_metadata.vendorOverrides`) decide the effective migration
policy for each deployment's next DEPLOY_RELEASE:

| Application setting | Effective policy |
| --- | --- |
| No vendor override | Run the frozen command the stack compiled |
| A vendor command | Run the correction (equal to the frozen command → frozen) |
| A vendor `null` ("No separate migration") | Skip the migration |

A vendor `null` also freezes `migration.mode` as `none` (unless the image already
migrates at startup), so the "migration strategy" question closes. The mode is
informational; the relay and the workload compiler read only the command.

- **Snapshot at queue time.** The single deploy route, bulk deploy and the
  post-install auto-deploy all derive the policy in
  `requireDeployableRelease` and store it on the job payload
  (`migrationTask.command`, `migrationPolicy`). An active job never
  changes. The policy is part of the job's idempotency key
  (`…:DEPLOY_RELEASE:<releaseId>:migration:<policy>`), so a policy edit
  while a deploy is active is refused `DEPLOYMENT_BUSY` instead of
  replaying the old job.
- **No new workload.** A correction is accepted only when the frozen
  deployment already has a migration workload. Otherwise the deploy is
  refused `409 MIGRATION_WORKLOAD_MISSING` (bulk deploy skips that target
  with the reason; the post-install auto-deploy does not queue).
- **Revision preparation.** The relay copies the revision the stack
  created, overlays the effective application configuration (see "One-shot
  task families stay current" below), and changes only the application
  container's entrypoint, command and image. The command replaces the image
  ENTRYPOINT and runs through `sh -c` (`entryPoint: ['sh','-c']`,
  `command: [<command>]`); a stack compiled before this encoding gets the
  same override on a correction. The image must contain `sh`. Roles, secret
  references, volumes, networking and the RDS CA init container stay as they
  are. The command uses the compiler's own encoding
  (`oneShotContainerCommand`). With no correction, the
  relay restores the frozen command from the revision the stack created,
  so removing a correction returns to the frozen command. The stack's
  revision or the family's latest revision is reused when it is already
  exactly that copy.
- **Unchanged guarantees.** Pending-task resumption, confirmed-identity
  skipping, failed-update semantics (`MIGRATION_FAILED` → the previous
  release keeps serving) and migration-free ROLLBACK/RESTART do not
  change.
- **Relay version.** A relay built before this amendment ignores the
  seat's `command` and runs the frozen command. It reaches a customer
  only after the bootstrap template is republished and the customer's
  relay is recreated.

Analysis does not persist a migration command the built image may not
run. A bare ORM CLI gets `npx` only when the selected Dockerfile's
runtime stage (and the stages it is built `FROM`) is a Node image that
provides `npx` and already holds the CLI in its node_modules — never from
dependencies alone, never `bunx` as a substitute, never a runtime install.
An incompatible or uncertain runner becomes the blocking "Needs input"
question `migration-command-needs-input`; deployment creation is blocked
until the vendor enters a command or chooses "No separate migration"
(see [`ai-analysis.md`](ai-analysis.md)). Startup-migration detection is
unchanged.
- **ROLLBACK and RESTART never run migrations.** Application rollback
  restores the image and service configuration only; it never reverses
  database migrations, and no down-migration orchestration exists. Every
  rollback affordance in the UI carries the warning verbatim
  ("Application rollback does not automatically reverse database
  migrations."), and vendors must write backward-compatible migrations.

## One-shot task families stay current without a CloudFormation update

The migration family and every scheduled-job family (Phase 5) are compiled
into the stack once, with the INSTALL-time image baked in. DEPLOY_RELEASE and
ROLLBACK never touch CloudFormation, so a family's latest revision would
otherwise keep running whatever image the last stack operation set — never
the new release. `registerReleaseImageIntoFamily`
(`packages/relay/src/deploy.ts`) is the one generic, bounded step that keeps
a named family current. It copies the revision the deployment's own stack
created (the `AWS::ECS::TaskDefinition` stack resource of that family),
replacing only the release image, so no configuration is lost. A migration
or scheduled-job command replaces the image ENTRYPOINT and runs through
`sh -c`; a worker command is an argument list for the image ENTRYPOINT. It reuses
that revision, or the family's latest revision, only when it is exactly that
copy (idempotent and retry-safe); otherwise it registers the copy. It
returns the exact revision ARN.

**One-shot release tasks use the same effective application configuration
as the configured runtime workload.** The stack's one-shot revision has only
the compiler-managed bindings; vendor and customer values, Deployz-generated
secret references and binding aliases reach the services through later
revisions (CONFIG_UPDATE, the alias step), never the one-shot families. So
each copy takes three sources:

- **Structure** from the stack's one-shot revision: family, roles, sizing,
  command, entry point, mounts, logging, container dependencies and the
  init container stay as compiled.
- **Environment and secret references** from the configured revision of the
  `web` workload's service: the service its workload seat names, else the
  compiled `WebService` (a ROLLBACK payload has no seats), else the stack's
  only service. Only the entries delivered after install are copied: the
  entries that differ from the service's own stack-created revision. A
  vendor value that replaces a compiler-managed name (an external
  `DATABASE_URL`) is delivered, so it wins. A binding compiled for the web
  workload only (its queue) is not, so the one-shot keeps its own compiled
  bindings. The application container is the one container that runs an
  image from the release repository, matched by name, never by position;
  init and sidecar containers are never a source or a target. Secrets stay
  `valueFrom` references; the relay resolves no value.
- **Image** from the requested release digest.

This fails closed. If no runtime service, its stack-created revision or
the application container can be identified, the migration fails before RunTask (`MIGRATION_FAILED`) and a
scheduled-job family stays in progress. While that service revision does not
carry the effective configuration yet (`unappliedConfigurationKeys`, the
first-start guard), the migration does not start and the command stays in
progress. Scheduled-job families copy the settled service revision. A later
CONFIG_UPDATE does not change the one-shot families; the next deploy brings
them current.

- **The migration family** is brought current right before RunTask, on every
  DEPLOY_RELEASE. RunTask runs the exact revision ARN that returns — never
  the bare family, which another registration could move in between. This
  fixed a real Phase 4 defect: the migration used to run whatever image the
  stack was installed with, never the release image being deployed. The
  command is the effective one (see "Migration recovery on an existing
  deployment" above).
- **Every scheduled-job family** is brought current only once a
  DEPLOY_RELEASE or ROLLBACK has otherwise **settled** — never before, never
  interleaved with the service rollout. A failed update must leave scheduled
  jobs running the previous release's image, the same as it leaves services.
- **A registration error keeps the command in progress, not failed.** The
  services may already be running the release by the time a scheduled-job
  family fails to register, so treating that failure as a failed update
  would be dishonest — the previous release is no longer what serves. The
  command stays "in progress" (carrying any already-confirmed migration
  identity, so it is never re-run) and the next poll retries, bounded by the
  same in-progress grace as any other rollout. A scheduled-job family issue
  never fails an otherwise-successful release.
- **The relay only ever registers into a compiler-generated family name.**
  `TASK_FAMILY_PATTERN = /^DeployzApp[A-Za-z0-9]+$/` is a trust-boundary
  check on every family name the control plane sends (the migration family
  and every scheduled-job family alike) — the relay can never be pointed at
  an arbitrary family from a payload. The family must also be one its own
  stack created; any other family is refused before anything is copied.

### Task families belong to one installation

Every task-definition family a stack creates (each service, the migration,
each scheduled job) is `DeployzApp<Pascal(componentId)><suffix>`. The suffix
is the installation id's letters and digits, lower-cased
(`taskFamilySuffix` in `@deployz/contracts`). It is stable for the stack's
life for the same reason as the stack name `deployz-app-<id>`: a relay reset
re-enrolls the same installation. The control plane passes it as the stack
parameter `paramTaskFamilySuffix` at INSTALL (no default; only `[a-z0-9]+`),
and computes the same family names for the DEPLOY_RELEASE and ROLLBACK
payloads. Two installations in one AWS account and Region, even of
the same application and image, therefore never share a family: the
scheduler's revisionless target and its IAM scope name only this
installation's family. A deploy of an installation-scoped stack without a
registered installation is refused (409 `RELAY_NOT_CONNECTED`, the same
refusal as any deploy without a connected relay).

Stacks compiled before this change (`dynamic-compiler-v2-1`/`-2`) keep the
shared names `DeployzApp<Pascal>`: their artifacts are frozen. On them the
relay still copies only its own stack's revision (another installation's
revision has other roles, so it is never reused), and RunTask runs the exact
copy. A schedule on such a stack still targets the shared family's latest
revision. If another installation registers last, that run fails on the
scheduler role's PassRole scope, so it never runs as the other installation.
The schedule picks up its own revision at this installation's next settled
deploy. Moving such a stack to installation-scoped names needs a new
deployment (post-MVP: no stack-update path exists).

Scheduled-job task runs sit outside health and readiness semantics entirely.
No ECS service backs a scheduled job, so nothing verifies it the way a
service's rollout is verified: EventBridge Scheduler successfully invoking
`RunTask` is not the same as the task completing its actual work, and
Deployz has no execution-history subsystem for scheduled runs. Outcome
visibility for a scheduled job is only through the customer's own ECS
console and CloudWatch Logs — the same as for the migration task, which is
likewise proven only by its exit code, never by a long-lived service.

## A configuration update settles on its rollout

A CONFIG_UPDATE reports success only after every service it changed
completed its rollout (`packages/relay/src/config-update.ts`):

- **Same gates as a deploy.** The service's PRIMARY deployment is the one
  the update created and runs the target revision, its rollout is
  COMPLETED with the expected task count, no task of a new revision is in
  a crash loop, and every ALB target is healthy.
- **Resumable.** The target revision and the ECS deployment id of each
  rollout ride the relay's pending marker (`configRollouts`, key names
  only, never a secret value). The resumer settles them on a later poll; a
  re-offered command with its own marker only waits and never applies the
  configuration twice.
- **Rollback is failure.** A circuit-breaker rollback to the previous
  revision (or a PRIMARY on another revision or deployment) fails the job
  with `ECS_DEPLOYMENT_FAILED`. The previous revision keeps serving. Secret
  values the update already wrote to the configuration secret are **not**
  restored by the task rollback; automatic secret restoration is out of
  scope, and the job error says so.
- **Secret-only changes.** When the bindings stay the same but a bound
  secret value changed, the relay forces fresh tasks
  (`forceNewDeployment`) and waits for that rollout by its deployment id.
- **Zero tasks.** A service at zero tasks (an install that waits for its
  first start, DEPLOY-009) only gets its task definition re-pointed; the
  update succeeds at once and the following deploy starts it. Pending-secret
  delivery and the cleanup of bound rows on success are unchanged.

## A restart settles on its rollout

A RESTART reports success only after every service it restarted completed
the rollout it forced (`packages/relay/src/restart.ts`). Forcing the
deployment is not the restart: ECS settles 3-5 minutes later, and a job
recorded as succeeded earlier would leave the deployment idle while tasks
still roll, and would hide a crash loop.

- **Same gates as a configuration update.** The relay forces a new
  deployment of every service that has tasks, records each service's new
  PRIMARY deployment id on the pending marker, and settles with
  `settleConfigRollouts`: that deployment is PRIMARY and COMPLETED with the
  expected task count, and every ALB target is healthy; a `draining` target
  is a replaced task leaving and is ignored, but at least one other target
  must be healthy. A service at zero
  tasks has nothing to replace and is skipped; if every service is at zero,
  the restart succeeds at once.
- **Deferred while it runs.** The command stays in progress, and the
  operation exclusivity rule keeps other service mutations out. The resumer
  settles it on a later poll.
- **Rollback is failure.** A circuit-breaker rollback, or a PRIMARY on
  another deployment, fails the job with `ECS_DEPLOYMENT_FAILED`. This is a
  failed day-2 operation: the previous tasks keep serving and the deployment
  returns to `HEALTHY` or `UPDATE_AVAILABLE`.
- **Idempotent.** A re-offered RESTART with its own marker only waits on the
  recorded rollouts and never forces a second deployment. A RESTART that
  settled (including the all-zero case) leaves a `settled` marker, so a lost
  result report is repeated from the marker and never forces a second
  deployment. The running marker is written right after the forced
  deployment, so a relay that dies between the two calls can force once more
  on re-offer; the rolling replacement makes that safe.
- **No migrations.** A restart never runs a migration (see above).

## Idempotency and exclusivity

- Every operation has a durable idempotency key
  (`{deploymentId}:{TYPE}[:{releaseId}][:RETRY:n]`). A caller's
  `Idempotency-Key` header replaces it as
  `{deploymentId}:{TYPE}:client:{header}`: job keys are unique across all
  deployments, so the header is scoped to one deployment and one job type
  and can never return another deployment's or operation's job.
  `createOrReuseJob` inserts with
  ON CONFLICT DO NOTHING and replays the existing job for a duplicate.
- **One active mutating job per deployment**, enforced by a partial unique
  index (`deployment_jobs_one_active_mutating_uidx`) — the route-level
  `DEPLOYMENT_BUSY` check is the friendly fast path; the index is the
  correctness backstop for two requests that both pass the check before
  either inserts. Domain jobs are outside the guard (they never race an
  executor over the stack/service), and so is CONFIG_UPDATE: secret
  delivery must be able to queue a config job during an active
  install/deploy (for a deployment whose relay is not yet connected the
  secret values live in the pending-secrets vault and are delivered through
  the authenticated relay config endpoint; for a connected relay they ride
  the job payload until the relay claims it, after which the stored payload
  is redacted — see `docs/pending-secret-delivery.md`).
- **Service mutations never overlap.** `GET /api/relay/commands` hands out
  no service-mutating job (INSTALL, DEPLOY_RELEASE, ROLLBACK, RESTART,
  CONFIG_UPDATE, DESTROY, PURGE) while another one of the deployment is
  RUNNING, so a CONFIG_UPDATE queued during an install waits, still queued,
  until the install settles. A CONFIG_UPDATE is handed out only as the
  first service mutation of a batch. When a service mutation of a batch
  defers, the relay hands each later service mutation of that batch back
  unexecuted (`POST /api/relay/commands/:id/release` → REQUESTED); a job
  whose claimed payload was redacted (INSTALL, CONFIG_UPDATE) is never
  handed back. Domain jobs are not affected.
- `GET /api/relay/commands` claims jobs atomically (single
  UPDATE … RETURNING), so overlapping polls cannot hand the same command
  out twice; `POST /api/relay/commands/:id/result` ignores results for
  settled jobs (`alreadySettled`), so a relay retry or a late report after
  force-complete cannot flip state twice or recompute release pointers. A
  result without a boolean `success` gets `400` and settles nothing; a
  malformed report is never a default success.
  The result route settles only a job in `RUNNING`, so only a command the
  relay claimed. A result for a `REQUESTED`, `QUEUED` or `WAITING` job gets
  `409 COMMAND_NOT_CLAIMED` and settles nothing; the relay keeps its settled
  marker and reports again after its next poll has claimed the job.
- **A relay credential ends with the deployment's cleanup.** A `DELETED`
  deployment gets `410` on `GET /api/relay/config` and `POST /api/relay/health`
  (no vendor configuration, no health writes). Its command channel stays open
  because a later PURGE needs it. A successful PURGE clears `relayTokenHash`
  and `relayCredential`, so the token stops working. Registration needs an install
  link that is neither revoked nor expired. The relay
  reports `awsAccountId` as 12 digits only; the ECR pull grant uses it as the
  principal, and a re-enrollment with a new installation id revokes the grant
  of `previousInstallationId`.
- **Relay input is bounded.** A heartbeat `observedState` larger than 256 KiB
  gets `413`; stack-event rows are kept for at most 2,000 per job; a
  configuration value is at most 64 KiB.
- **A failed DESTROY is not deployable.** Billing stops when a DESTROY is
  queued and does not resume. So `requireDeployableState` refuses deploy,
  rollback and restart (`409 DEPLOYMENT_NOT_DEPLOYABLE`) for a `FAILED`
  deployment whose newest job is a DESTROY; the vendor disconnects again.
- AWS-side, every relay executor reads before it writes
  (describe-before-create/delete, running-digest short-circuit), so a
  re-delivered or re-offered command converges on real AWS state instead of
  duplicating a mutation.
- **A pending command carries authority.** Before it resumes or provisions,
  and before a DEPLOY_RELEASE, ROLLBACK, RESTART or CONFIG_UPDATE changes
  AWS, the relay asks the control plane whether the command is still active
  (`GET /api/relay/commands/:id/authority`). A superseded command never
  mutates AWS; an ambiguous answer defers every mutation. See
  "Pending-command authority and safe recreation" below.

## Pending-command authority and safe recreation

A deferred INSTALL must never recreate a stack the control plane has
superseded. Before it resumes or provisions, the relay asks the control
plane `GET /api/relay/commands/:id/authority` (authenticated with the
relay bearer token; returns `{active, jobState, reason?}`). Authority is
false when the job settled or was cancelled, when the deployment is
DELETING/DELETED, or when a later DESTROY superseded an INSTALL. A network
or 5xx answer is ambiguous: the relay defers all mutations and asks again
on the next poll. The decision record is
`docs/decisions/pending-command-authority.md`.

The same check guards the day-2 commands. A DEPLOY_RELEASE, ROLLBACK, RESTART
or CONFIG_UPDATE executor asks before it changes AWS. A deploy resumer asks
until its rollout has started. After that, settling only reads, so it
continues. An inactive command mutates nothing, and the resumer clears its
own marker with `compareAndSet`. An ambiguous answer defers.

`installApplicationStack` has three create modes:

- `fresh` — a first install creates the stack when it is absent.
- `resume` — a resumed install adopts an existing stack and never recreates
  a missing one.
- `recovery` — the authorized first-install recovery may recreate after
  `DELETE_IN_PROGRESS` becomes absent. Recovery rechecks authorization
  immediately before every `CreateStack`.

A read distinguishes a confirmed absent stack from a failed read. A
throttle, a permission denial or a transport error (`absent: false` plus an
`errorCode`) is never evidence that the stack was deleted. A run of
unreadable reads fails the install with that distinction; it does not claim
the stack was deleted.

On terminal settle every command that changes AWS (INSTALL, DEPLOY_RELEASE,
ROLLBACK, RESTART, CONFIG_UPDATE) writes a `settled` marker (the result plus
`settledAt`) instead of clearing first. This holds for an immediate executor
result and for a deferred resumer result. The marker is cleared only after
the result report succeeds (`onResultReported`). A failed report (429, 5xx,
timeout or a dead Lambda) retries from the marker, on the next poll or when
the control plane offers the command again, and never reruns provisioning, a
migration or a forced deployment. Every clear and write of an existing marker
uses `compareAndSet`, so a newer command's marker is never cleared or
overwritten. A new running marker is created only when no marker of the same
command exists.

A settled marker keeps no command payload, so it never holds a secret value.
A result that would exceed the 4096-character SSM limit is cut in a fixed
order: the error text is clipped, then the evidence is dropped, then the
output keeps only its scalars and key-name lists (`generatedKeys` stays),
then the output is dropped. `success` and `failureCode` always stay.

The store tells an absent marker (`ParameterNotFound`) from an unreadable
one (`AccessDenied`, throttling, a transport error or content that does not
parse). When the marker is unreadable, every executor and resumer defers and
changes nothing, because the command may already have run.

DESTROY cancels an obsolete INSTALL before the idle check: a DISCONNECTED
relay's active INSTALL can never complete, so it must not block the
teardown the vendor asked for. A CONNECTED relay's in-flight INSTALL still
blocks DESTROY through operation exclusivity.

## Reconciliation: the watchdog repairs, it does not guess

`sweepStuckJobs` (worker Lambda, 15-minute schedule) runs two clocks per
active mutating job:

- **Staleness** (`lastProgressAt` vs per-type `JOB_TIMEOUTS_MS`): heartbeats
  refresh `lastProgressAt` on every active job, so staleness means the
  relay itself went quiet. The job is parked `WAITING`
  (`operation.waiting_for_relay`) — never failed, because the operation may
  have completed in AWS. The relay's next command poll claims WAITING jobs
  back and resumes from its checkpoint. Only after a 24-hour grace does the
  watchdog fail it (`RELAY_DISCONNECTED`).
- **Runtime** (`startedAt` vs per-type `JOB_MAX_RUNTIME_MS`): the inverse
  hazard — a relay invocation that died between an AWS mutation and its
  checkpoint (SSM pending-marker) write leaves a RUNNING job that
  heartbeats keep fresh forever. Past the runtime bound the job is
  **re-offered** to the relay (state back to REQUESTED, bounded by
  `reconcileCount`, `operation.requeued` event); the describe-first
  executors then resolve the true state — a stack that completed is adopted
  and verified into success, a rolled-back one fails honestly. Only
  exhausted re-offers fail (`UNKNOWN`). One edge case: a REQUESTED job that
  a CONNECTED relay never claims within its staleness window also fails
  `UNKNOWN` without a re-offer (rare, because heartbeats refresh REQUESTED
  jobs too).
- **DESTROY never fails from the watchdog.** A dead-relay teardown is
  settled by the vendor's force-complete escape hatch
  (`POST /api/deployments/:id/disconnect/force-complete`, also a Team Admin
  action): allowed only when the relay is `DISCONNECTED` and the pending
  DESTROY has been stale for at least 60 minutes, or at least two
  consecutive DESTROY attempts have failed and 60 minutes have passed;
  otherwise `409 DESTROY_NOT_STALE`, `RELAY_NOT_OFFLINE` or
  `NO_PENDING_DESTROY`. It records `cleanupState: SKIPPED_RELAY_OFFLINE` —
  explicitly *not* claiming AWS resources were removed; PURGE later verifies
  and clears retained leftovers. PURGE itself has a staleness timeout so it
  cannot block retries forever.

| Job type | Staleness (`JOB_TIMEOUTS_MS`) | Maximum runtime (`JOB_MAX_RUNTIME_MS`) |
| --- | --- | --- |
| INSTALL | 60 min | 90 min |
| DEPLOY_RELEASE, ROLLBACK, RESTART, CONFIG_UPDATE | 20 min | 30 min |
| DESTROY | none (never failed by the watchdog) | 90 min (re-offered) |
| PURGE | 60 min | 90 min |
| CONFIGURE_DOMAIN, REMOVE_DOMAIN | 60 min | 90 min |

Re-offers are bounded at three per job. The same schedule also runs the
relay-liveness sweep: a relay with no heartbeat for 15 minutes
(`RELAY_STALE_AFTER_MS`) is marked `DISCONNECTED`, which the UI shows and
which retry eligibility respects.

The uncertain-result rule: nothing ever assumes a timed-out external call
failed. The relay's resumers re-describe AWS before acting; the control
plane re-offers rather than failing; a duplicate result is a no-op.

This includes stack-resource reads. The relay reads the stack in full (all
pages). If it cannot read the stack, it does not fail the deploy: a started
rollout stays in progress, and a RESTART is deferred and re-offered. Only a
stack that was read and has no ECS service fails.

### Progress reporting

During INSTALL and DESTROY the relay polls `DescribeStackEvents` inside its
existing wait loop (no second polling loop, worker, queue or WebSocket) and
posts new events to `POST /api/relay/commands/:id/progress`, which stores
them in `deployment_stack_events` (deduplicated on the provider event id),
refreshes `lastProgressAt` so the watchdog stays fed during long installs,
and derives the customer-facing provisioning phases. CloudFormation's own
stack status stays authoritative: events are progress only, a completed
stack never marks a deployment HEALTHY by itself, and `DELETE_*` /
`ROLLBACK_*` resource events never flip a phase to FAILED — only a genuine
`*_FAILED` with a non-boilerplate reason does. Lambda, IAM, log and secret
resources map to no customer-visible phase. Resource properties are never
forwarded.

## Failure classification and retry policy

- The relay reports a `failureCode`; the control plane **refines** coarse
  defaults (`STACK_CREATE_FAILED`, `AWS_PERMISSION_DENIED`, `UNKNOWN`,
  `STACK_DELETE_FAILED`) deterministically from the error text plus the
  persisted CloudFormation events (`apps/api/src/failure-classification.ts`)
  — server-side on purpose, because relay code in customer accounts never
  updates in place. Specific relay classifications are never second-guessed;
  the event payload records the relay's original code when refinement
  changed it.
- Every code carries a **recoverability** class (`@deployz/copy-map`):
  `RECONCILE_FIRST` (may repair itself — wait/check before acting),
  `USER_ACTION` (permissions/quota/app config must change first),
  `DEPLOYZ_ACTION` (our side of the boundary — support, not retry loops),
  `TERMINAL` (retrying cannot help as-is). The diagnostics endpoint serves
  it; the diagnostic card leads with it.
- Retry eligibility (`apps/api/src/retry-eligibility.ts`) turns the class
  into the vendor's action. `WAIT` is returned only where something recovers
  without the vendor: a live state, or a FAILED deployment with a release
  for the heartbeat self-heal to restore. A failed first install has no
  release and nothing reconciles it, so every code except `DEPLOYZ_ACTION`
  gets Retry deployment. An install that succeeded but never ran a release
  gets deploy again. When the connector is disconnected or not registered,
  Retry deployment leads with Issue new install link (relay reset). The
  guard `apps/web/test/failure-recovery-guard.test.ts` checks that every
  state × failure code has a control or a real automatic recovery.
- There is deliberately no generic retry-everything loop. Transient AWS
  errors are absorbed inside the relay's wait loops (unreadable-poll
  budget, bounded backoff); ambiguous outcomes go through reconciliation;
  permanent failures stop.

## Disconnect retains data on purpose: DESTROY vs PURGE

DESTROY (disconnect) is a data-preserving teardown, and **a DESTROY that
retains data is a success**. Before the delete call, the relay stops any
standalone task still running in the stack's own cluster — an ECS task whose
`group` starts with `family:` (a scheduled-job run, or a migration mid-run)
rather than a service. Nothing else stops these: CloudFormation's own
`AWS::ECS::Service` deletion drains service-managed tasks as part of the
stack's normal delete sequence, but a standalone task left running blocks
the cluster's own delete with `ClusterContainsTasksException`, which would
otherwise land the whole stack on `DELETE_FAILED`. This step is best-effort
and scoped to the stack's own cluster only — a task that cannot be stopped
just leaves the stack on the same `DELETE_FAILED` recovery path described
below. The relay deletes the application stack; the
deletion-protected RDS instance (PostgreSQL or MySQL) fails its delete only
after the security
group and subnet it pins, so the stack first lands on `DELETE_FAILED` —
expected pacing (45+ minutes of CloudFormation retrying), not a failure.
The relay lists the `DELETE_FAILED` resources and re-issues
`delete-stack` with `RetainResources`, repeating the pass on each poll
until the stack reaches `DELETE_COMPLETE`. Only the RDS instance and the
network it pins (DB subnet group, security group, subnet, VPC and the secondary VPC CIDR
block the database-only subnets use — and the
network only while a database is blocked or already retained) may be
retained. Any other `DELETE_FAILED` resource is a real failure:
`STACK_DELETE_FAILED` naming its logical id, type and reason, nothing retained. The deployment then settles
`DELETED` — truthfully: the application and cache are gone; the database, the network it pins (including the secondary VPC CIDR block), its credential secrets and the bucket are deliberately retained
(no final snapshot is ever taken), clearly visible, and removable by
PURGE.

After a DEPLOY_RELEASE, ROLLBACK or CONFIG_UPDATE has settled
successfully, the relay deregisters old task-definition revisions it
registered (best effort, at most 10 per invocation, never failing the
command). It touches only families its own stack created and only when the
family carries the installation suffix (shared v2-1/v2-2 families are
skipped). It keeps the stack-created revision, every revision a service
deployment uses, the target and previous revisions of the command, and the
newest 3 revisions of each family as rollback headroom. It needs
`ecs:ListTaskDefinitions` and `ecs:DeregisterTaskDefinition` on the relay
role; without them it silently does nothing.

PURGE is the second, explicit half. It deletes the retained data — every
retained RDS instance (PostgreSQL or MySQL; deletion protection off,
`SkipFinalSnapshot`), **every owned
application secret regardless of infrastructure generation** (anything
carrying the installation tag that is not the relay's own
`deployz:component=bootstrap` secret), the bucket (every version), ACM
certificates, every ACTIVE task-definition revision in the installation's own
suffixed families (including relay-registered ones; shared and other
installations' families are never touched), subnet groups and network orphans —
one kind per relay poll. A connector role without
`ecs:DeregisterTaskDefinition` (pre-#532 template) skips the revision pass:
PURGE still completes and reports `task-definition-revisions` in the result's
`leftovers` instead of claiming removal.
A failed purge lands on `cleanupState: PURGE_FAILED` and stays retryable.

## First-install recovery

`ROLLBACK_COMPLETE` cannot brick a deployment: the vendor's retry-install
route (guarded by "never successfully installed" — a deployment that was
ever healthy keeps its data-protection guarantees) runs the relay's
recovery pass: delete the terminal-failed stack; on DELETE_FAILED, clear
the known retained blockers (RDS deletion protection off + delete,
ElastiCache replication-group delete — identified from the failed stack's
own resource list, never by name); recreate; re-verify. Retained S3 buckets
are deliberately left (inert, empty, blocked by IAM tag-condition
semantics). The decision record is `docs/decisions/failed-install-recovery.md`.
A customer retry of a first install in progress reaches the same pass: it keeps
the connector stack, and the re-enrolled connector's INSTALL carries
`recovery.neverInstalled`. A second connector could not run it, because its IAM
is scoped to its own installation tag. Recovery is the only recreation path. A normal install creates a stack
only when none exists; a resumed install adopts an existing stack and
never recreates a missing one. Only the authorized recovery pass may
recreate a stack the previous attempt lost — see "Pending-command
authority and safe recreation" above and
`docs/decisions/pending-command-authority.md`.

## AZ placement resolution

The database subnet group covers all available, enabled standard AZs in
the customer's region. The relay discovers the AZs via
`DescribeAvailabilityZones` **before creating the stack** and fills the
template's `paramDbAz1` … `paramDbAzN` parameters. The compiler emits
DB-only subnets for slots 3..N, so the subnet group always covers every
available AZ — not just the two where the private subnets happen to sit.

Placement is resolved **only before the first stack creation**. A resumed
or retried install reuses the same template and the same AZ parameters;
the relay never re-discovers AZs for an existing stack. This keeps the
placement deterministic and avoids stack recreation loops.

If AZ discovery fails (the API call errors, or the region has fewer than
two available zones), the install fails honestly with a clear error
rather than silently truncating the subnet group. A retry after a
confirmed failed-first-install cleanup re-discovers the AZs — the
customer's capacity may have changed since the first attempt.

## Health is verified, never assumed

CloudFormation success alone never marks a deployment healthy: INSTALL
success leaves the deployment INSTALLING, and only the relay's runtime
health verification (ECS running counts + ALB target health, reported via
heartbeat) advances it to HEALTHY. The derived customer/vendor stage shows
READY only with confirmed health, passing release evidence and an https
URL. One exception: while a deploy, rollback, restart or configuration
update runs on a deployment whose release was already confirmed serving,
the rollout fails the release evidence, but the stage stays READY as long
as health and the https URL hold, because the previous release keeps
serving. When the job settles, the stage follows the evidence again. The INSTALLING to HEALTHY and FAILED to HEALTHY transitions need the
same passing evidence; the relay's `healthStatus` alone never earns them. A
connector that sends no `releaseEvidence` cannot promote or verify
readiness, and the status reports `connector.upgradeRequired`. When every
expected workload is intentionally at zero tasks (a configured first start
still waiting), `health.notStarted` is set and no outage event is recorded.
A missing required infrastructure component is reported, never repaired
automatically.

### An install that never verifies fails after a bounded window

An installed deployment cannot stay INSTALLING forever. The relay heartbeat
route (not the watchdog, which only sweeps jobs) fails it when all of these
hold: the state is INSTALLING, an INSTALL succeeded, no mutating job is
active, the latest mutating job is a settled INSTALL, DEPLOY_RELEASE or
CONFIG_UPDATE that finished at least 30 minutes ago, and this heartbeat's
release verdict is a refusal that blames the application. The window covers
the 300-second load-balancer health-check grace, a 3-5 minute ECS rollout and
a first-start migration. The latest
settled job anchors the window, so a deploy that follows the install restarts
it.

The deployment becomes FAILED once, under a row lock, with one
`deployment.install_not_verified` event that holds the verdict reason and a
short evidence summary (counts and statuses, no secrets). The classified code
is stored on the anchor job's result as `installVerification` and is read by
the status derivation and the diagnostics route. The reason maps to an
existing code: `PROBE_FAILED`, `PROBE_MISSING` and `TARGETS_UNHEALTHY` to
`IMAGE_HEALTH_CHECK_FAILED`; `TASKS_INSUFFICIENT` and `WORKLOAD_MISSING` to
`CONTAINER_START_FAILED`; `ROLLOUT_INCOMPLETE` to `ECS_DEPLOYMENT_FAILED`;
`DIGEST_MIXED` and `DIGEST_UNKNOWN` to `UNKNOWN`. A job that fails after the
anchor settles owns the failure instead.

These cases never fail: `EVIDENCE_MISSING` (an old connector; it gets the
upgrade-required path), `EVIDENCE_STALE`, `EVIDENCE_INVALID`,
`NO_EXPECTED_WORKLOADS`, and a configured first start whose workloads are
intentionally at zero tasks (its own deploy job governs it). Recovery is
**deploy again**, which `requireDeployableState` allows for a FAILED
deployment whose install succeeded. A passing heartbeat clears the FAILED
state through the existing `stateRecovered` rule only when a release is
already current.

## The trust boundary shapes everything

The control plane has **zero** AWS access into customer accounts; the relay
is the only path. That is why reconciliation is expressed as "re-offer to
the relay" rather than "describe from the control plane", why relay loss is
a first-class state (`WAITING`, `relayStatus: DISCONNECTED`,
force-complete) rather than an error, and why classification/refinement
lives server-side.

Verification expectations follow the same rule. `databaseRequired` and
`redisRequired` are explicit booleans derived from the deployment's stored
spec's verification contract (frozen at creation — see the domain model
above), never a silent default. The relay never assumes a database is
required. Until the
control plane's poll response has told it what this deployment actually
needs, it skips verification for that heartbeat instead of checking against
a guess. This keeps verification honest about what it does not yet know,
the same way the uncertain-result rule keeps reconciliation honest.

## Where the guarantees are tested

- Settlement/exclusivity/duplicate-result: `apps/api/src/failure-semantics.test.ts`,
  `deploy-contract.test.ts`, `server.test.ts`.
- Watchdog/reconciler: `packages/cdk/test/worker.test.ts` (the sweeps run in
  the worker Lambda, which the simulated E2E harness deliberately does not
  boot).
- Relay durability (resume, describe-first, recovery):
  `packages/relay/src/*.test.ts`.
- Real AWS, end to end (release build → install → deploy → rollback → failed
  release → recovery → destroy → purge → leak audit): the version canary,
  `docs/testing/aws-e2e.md` — the MVP release gate, with the
  product semantics it enforces (serving release, last successful release,
  latest attempt, rollback, persistent data) in one table.
- End-to-end failure boundaries: the simulated scenario suite
  (`docs/testing/simulated-e2e.md`) — including `duplicate-request`,
  `transient-aws`, and `relay-death-destroy` in
  `e2e/scenario-resilience.spec.ts`, `stale-install-resurrect` in
  `e2e/scenario-recovery.spec.ts`, `migration-correction` (a failed frozen
  migration recovered by a same-image correction or by "No separate
  migration") in `e2e/scenario-migration.spec.ts`, `config-update-failure`
  (a rolled-back configuration fails while the previous revision serves,
  then a retry succeeds) in `e2e/scenario-config-update.spec.ts`, and the
  DESTROY-retains /
  PURGE-removes proof in `retained-delete-recovery`
  (`e2e/scenario-lifecycle.spec.ts`).
