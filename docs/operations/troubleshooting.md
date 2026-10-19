# Troubleshooting deployments

How to diagnose a deployment that is failing, stuck, or leaving things
behind. The invariants this relies on are in
[`../deployment-resilience.md`](../deployment-resilience.md); the support
console is [`../admin/team-admin.md`](../admin/team-admin.md).

## Where to look first

1. **The deployment page's recovery panel and Technical details**
   (`/dashboard/deployments/[id]`; `…/diagnostics` deep-links to the
   infrastructure check; `GET /api/deployments/:id/diagnostics`): the failure code, its
   recoverability class, the evidence (persisted CloudFormation events, the
   relay's error text, ECS stop reasons), the retry eligibility, and an AI
   explanation for the codes whose cause lives inside the application
   (`UNKNOWN`, `CONTAINER_START_FAILED`, `IMAGE_HEALTH_CHECK_FAILED`,
   `DATABASE_CONNECTION_FAILED`, `MISSING_SECRET`, `PORT_MISMATCH`,
   `MIGRATION_FAILED`); every other code gets deterministic copy only.
2. **Team Admin** (`/admin`): the deployment 360° view, the job list with
   STUCK detection, the AWS connection (relay) list, and the audit log. Use
   "View as Vendor" to see exactly what the vendor sees, read-only.
3. **Control-plane logs** (CloudWatch, Deployz account): the API and worker
   Lambdas log structured JSON. Useful event names: `operation.requeued`,
   `operation.waiting_for_relay`, `watchdog:config-secret-inventory`,
   `release.build_failed`.
4. **Relay logs** (CloudWatch, customer account, the `/aws/lambda/…` group
   of the relay function, whose CDK-generated name starts with the bootstrap
   stack name and contains `RelayFunction`; one-week retention):
   `relay:command-executed`,
   `relay:stack-events-collected`, `relay:pending-marker-too-large`,
   `relay:pending-marker-unreadable`, `relay:purge-bootstrap-retained`.
   Deployz has no access to these; ask the customer, or use the test
   account for canaries.

Deployz never reads customer application logs. A container that exits
before producing output looks the same as one whose logs were deleted by a
rollback; the ECS stop reason and exit code in the diagnostics evidence are
the only signal.

## Failure codes and what to do

Every failure carries one of 24 stable codes and a recoverability class
(`packages/copy-map/src/index.ts`):

| Class | Meaning | Action |
| --- | --- | --- |
| `RECONCILE_FIRST` | May repair itself (relay returning, watchdog re-offer, transient AWS condition) | Wait one or two relay polls (one minute each; five minutes on a connector published before PR #531); retry only if it persists |
| `USER_ACTION` | The vendor or customer must change something (permissions, quota, app configuration) | Fix the cause, then deploy again or retry the install |
| `DEPLOYZ_ACTION` | The fault is on Deployz's side (template, image, relay state) | Do not loop on retry; investigate the control plane or template |
| `TERMINAL` | Retrying cannot help as-is | Change the requirement (unsupported architecture, unsupported Region) |

| Code | Class | Typical cause |
| --- | --- | --- |
| `STACK_CREATE_FAILED` | USER_ACTION | CloudFormation rollback; read the first `CREATE_FAILED` event in the evidence. The control plane refines this code from the persisted stack events when it can. |
| `STACK_DELETE_FAILED` | USER_ACTION | Usually the retained database pinning a subnet or security group; see *Disconnect takes a long time* |
| `AWS_PERMISSION_DENIED` | USER_ACTION | A customer SCP or a relay IAM gap; the evidence names the action |
| `AWS_SCP_BLOCKED` | USER_ACTION | Customer organisation policy blocks a standard resource |
| `QUOTA_EXCEEDED` | USER_ACTION | VPC / NAT / Elastic IP (default 5 per Region) or Fargate vCPU quota |
| `REGION_NOT_SUPPORTED` | TERMINAL | Region not in `DEPLOYABLE_AWS_REGIONS` |
| `TEMPLATE_UNAVAILABLE` | DEPLOYZ_ACTION | Bootstrap template not published for the Region, or the deployment's compiled artifact missing from the INSTALL payload — the relay refuses rather than guesses |
| `IMAGE_PULL_FAILED` | DEPLOYZ_ACTION | ECR cross-account grant missing or the image deleted; check the release is not `UNAVAILABLE` |
| `CONTAINER_START_FAILED` | USER_ACTION | The task exits at boot (missing configuration, a value the app rejects); check the ECS stop reason and the unbound secret keys |
| `IMAGE_HEALTH_CHECK_FAILED` | USER_ACTION | The health path does not answer 2xx on the container port; a wrong port surfaces here, not as `PORT_MISMATCH` |
| `PORT_MISMATCH` | USER_ACTION | Rarely produced; Deployz has no log access to prove it |
| `MISSING_SECRET` | USER_ACTION | A required secret was never provided |
| `MIGRATION_FAILED` | USER_ACTION | The one-off migration task exited non-zero (the command replaces the image ENTRYPOINT and runs as `sh -c <command>`; the image must contain `sh`) |
| `ECS_DEPLOYMENT_FAILED` | USER_ACTION | The circuit breaker rolled the service back; the previous release keeps serving |
| `RDS_AZ_CAPACITY` | USER_ACTION | RDS returned `InsufficientDBInstanceCapacity` for the requested instance class. Regional capacity, not a quota or permissions fault. The retry rediscovers AZs; wait for the rollback to finish first |
| `DATABASE_CREATE_FAILED` / `DATABASE_CONNECTION_FAILED` / `RDS_UNAVAILABLE` | USER_ACTION / RECONCILE_FIRST | RDS provisioning or connectivity; the app must accept `sslmode=require` with the RDS CA bundle the template mounts |
| `REDIS_PROVISIONING_FAILED` / `REDIS_CONNECTION_FAILED` | DEPLOYZ_ACTION / RECONCILE_FIRST | Valkey replication group; TLS clients (`rediss://`) are unsupported |
| `RELAY_DISCONNECTED` | RECONCILE_FIRST | No heartbeat for 15 minutes, or a WAITING job aged past 24 hours |
| `RELAY_STATE_WRITE_FAILED` | DEPLOYZ_ACTION | The relay could not write its SSM pending marker (4 KB cap) |
| `DOMAIN_OPERATION_TIMEOUT` | RECONCILE_FIRST | A domain job passed its staleness bound |
| `UNSUPPORTED_ARCHITECTURE` | TERMINAL | Rejected at analysis |
| `UNKNOWN` | RECONCILE_FIRST | Re-offers exhausted or an unclassified error; the AI explanation is available here |

## Stuck operations

The worker's watchdog runs every 15 minutes with two clocks per active job:

| Job type | Staleness (no progress signal) | Maximum runtime |
| --- | --- | --- |
| INSTALL | 60 min | 90 min |
| DEPLOY_RELEASE, ROLLBACK, RESTART, CONFIG_UPDATE | 20 min | 30 min |
| DESTROY | never failed by the watchdog | 90 min (re-offered) |
| PURGE | 60 min | 90 min |
| CONFIGURE_DOMAIN, REMOVE_DOMAIN | 60 min | 90 min |

- **Relay connected, job over its runtime**: the job is re-offered to the
  relay (up to three times, `operation.requeued`); the describe-first
  executors adopt whatever really happened. After three re-offers it fails
  `UNKNOWN`.
- **Relay silent**: the job is parked `WAITING` (`operation.waiting_for_relay`)
  and resumes on the relay's next poll. After 24 hours it fails
  `RELAY_DISCONNECTED`.
- **Relay marked DISCONNECTED** after 15 minutes without a heartbeat. The
  relay runs on a one-minute schedule with a 5-minute timeout; a long install
  is deferred through the SSM pending marker and resumed on later polls, so
  quiet polls are normal during provisioning.
- **A DESTROY whose relay is gone** never fails by itself: the vendor (or
  Team Admin) uses force-complete, which records
  `cleanupState: SKIPPED_RELAY_OFFLINE` and does not claim that AWS
  resources were removed. A PURGE requested when no relay exists cannot
  complete: it is parked WAITING after 60 minutes and fails
  `RELAY_DISCONNECTED` with `cleanupState: PURGE_FAILED` about 25 hours
  later. The retained resources must then be removed by hand (or by a new
  Quick Create followed by another purge).
- **A STUCK job with a warm relay that keeps failing the same way**: the
  relay caches a failed result per idempotency key for the life of its warm
  container; a retry needs a fresh attempt key, which "deploy again" and
  "retry deployment" mint automatically.

## Common situations

**Install reports failure after exactly three minutes while the stack keeps
creating.** The relay could not write its pending marker
(`RELAY_STATE_WRITE_FAILED`). The marker is a Standard-tier SSM SecureString
capped at 4,096 characters; the install payload is compacted (the manifest
is dropped) to fit. Check the relay log for `relay:pending-marker-too-large`.

**A deferred command never resumes** (a disconnect sits RUNNING, the stack
is `DELETE_FAILED`, nobody retries). Historically a SecureString marker read
without decryption parsed as "nothing pending"; the relay now decrypts and
logs `relay:pending-marker-unreadable`. Republish the bootstrap template if
the customer's relay predates the fix.

**The deployment stays `INSTALLING`, then becomes `FAILED`, because it never
becomes healthy.** INSTALL succeeded but the runtime health gate never passes
(the container keeps restarting, or the health path never answers). After 30
minutes without passing evidence a heartbeat marks the deployment `FAILED`
with a classified code. An old connector that sends no release evidence stays
`INSTALLING` and is asked to upgrade. Retry-install is refused once an
INSTALL has succeeded. Read the
ECS stop reason and `unboundSecretKeys` in the diagnostics, fix the
configuration or the release, then **deploy again**: a DEPLOY_RELEASE
against an installed deployment is allowed from `INSTALLING` and from
`FAILED` (`requireDeployableState`), and a successful rollout promotes it to
`HEALTHY`. If the install itself must be redone, disconnect and create a
new deployment.

**Install link has no Quick Create button.** `BOOTSTRAP_TEMPLATE_URL` is
unset or the Region is not in `DEPLOYABLE_AWS_REGIONS`
([`control-plane.md`](control-plane.md)).

**Quick Create fails with `AlreadyExists` after "Issue new install link".** The
deployment was installed before, so its connector stack is still in the
customer account. The install page then shows an update of that stack instead
of a Quick Create link: the customer chooses Update, then Replace existing
template, and enters the new `RelayCredential` and `EnrollmentCode`. Creating a
second stack for the same installation is not supported.

**Customer retried a failed install and created a second connector.** The retry
of a failed install whose connector registered shows an update of the existing
connector stack, not a Quick Create link. A customer who created a second
connector stack instead must delete that extra `deployz-bootstrap-…` stack. It
cannot recover the first attempt's failed application stack and its retained
database. Update the original connector stack with the new values.

**Connector update required or available.** The deployment page shows the
alert when the connector reports no release evidence (it cannot verify
releases) or reports a build other than the published one
(`BOOTSTRAP_BUILD_ID`). The customer updates the existing stack with the
versioned template and keeps every parameter at "Use existing value",
especially `RelayCredential`. This is not a reset and issues no new credential.

**CloudFormation refuses the Quick Create parameters.** The customer's
bootstrap template predates a parameter the control plane now sends;
republish the bootstrap template and have the customer create a new stack.

**Enrollment fails with `RELAY_CREDENTIAL_MISMATCH`.** The bootstrap stack
was created from a template that does not carry the `RelayCredential`
parameter, or from an install link that was rotated afterwards. Rotate the
install link and create the stack again.

**The failed update shows the previous version still running.** Correct:
the ECS circuit breaker restored it; the deployment returns to `HEALTHY` or
`UPDATE_AVAILABLE` and only the job is FAILED. Fix the cause and deploy again.

**The app container exits at boot with a missing variable.** Check the
environment-variable classification: a "Set by customer" or "Set by vendor"
value that was never entered, or an app that reads a name Deployz did not
bind (aliases such as `DB_HOST` are covered; a viper-style prefix or a
`useEnv()` accessor may not be). A value typed before the relay connected is
delivered from the pending-secret vault at first config, so it should be
present; check `unboundSecretKeys` in the CONFIG_UPDATE result.

**A build fails with an opaque checksum or "Cannot find module" error.**
The source tarball has no `.git` directory (a Dockerfile that copies `.git`
is now rejected at analysis), or the build context is wrong (a monorepo
Dockerfile builds from its own directory unless `docker/Dockerfile` or a
vendor override says otherwise). The release's build-failure page shows the
CodeBuild log.

**A build fails with a Docker Hub 429.** Anonymous pulls are rate-limited
per source address; the build retries three times. Configure
[`../docker-hub-credentials.md`](../docker-hub-credentials.md) to
authenticate pulls.

**Default HTTPS stays "Setting up" or fails with `DEFAULT_DNS_TIMEOUT`.**
Five configure cycles are the budget (waiting for a running install spends none). Check that the ACM validation record
is unproxied, the routing record is proxied, and the ALB answers on 443.
Retry from the deployment page resets the counter but keeps the certificate;
a certificate ACM has marked FAILED is not replaced by retry. See
[`../networking-and-https.md`](../networking-and-https.md).

**The app URL redirects the raw ALB hostname to itself over TLS.** Expected
once default HTTPS is configured: port 80 is a 301 redirect that preserves
the host, and the certificate covers only `d-<id>.deployz.dev`. Probe the
advertised URL, not the ALB DNS name.

**Disconnect takes 45+ minutes and passes through `DELETE_FAILED` — and
still succeeds.** The retained RDS instance keeps an ENI in the database
security group and a private subnet; CloudFormation retries the subnet
delete for about 14 minutes, then the relay re-issues the delete with
`RetainResources` for the failed resources and repeats the pass until the
stack completes. The deployment then settles DELETED — a truthful success:
the application is gone, and the database, its secrets and the bucket are
deliberately retained for Purge, not left behind by a fault. Purge then
removes the database, its secrets (every owned application secret,
regardless of when the stack was created), the bucket, the ACM
certificates, the subnet group and the network orphans, one kind per relay
poll (about 95 minutes for a full purge). Only the database and the
network it pins (DB subnet group, security group, subnets, VPC, secondary VPC CIDR block) are
retained this way; any other `DELETE_FAILED` resource (for example an ECS
cluster or a log group) fails the Disconnect with its resource id and reason.

**After Purge the connector stack is still there and still polling.**
Expected: the relay cannot delete its own stack. The vendor page and the
customer install page both ask the customer to delete `deployz-bootstrap-…`
in CloudFormation. Delete it only after `cleanupState` is `COMPLETE` and the
application stack is gone: the CloudFormation execution role lives in the
bootstrap stack, and an application stack whose execution role was deleted
can only be removed with `--role-arn` or after recreating the role.

**Something looks leaked after a purge.** The tagging API lags: inactive ECS
clusters and task definitions, a deleted NAT gateway (about an hour), and
secrets "scheduled for deletion" still list for a while. Confirm each ARN
against its own service before calling it a leak.

**A vendor cannot create a production deployment (402).** The organisation
has no active Paddle subscription. Checkout is the normal path;
`BILLING_ENFORCEMENT=off` pauses the gate platform-wide for an incident.
Existing deployments are never blocked by billing state.

**The API answers 500 to everything after a deploy.** A migration failed at
Lambda initialization and warm containers cached the failure. Fix the data
or the migration, redeploy, and recycle the function.

## Real-AWS test-account hygiene

- The version canary, `pnpm e2e:fresh`, the Stage B deployment benchmark and
  `pnpm admin:customer-cleanup execute` all refuse any AWS account other than
  `DEPLOYZ_CANARY_EXPECTED_ACCOUNT`. Delete test resources only by ids
  recorded at creation, never by name pattern.
- `aws login` sessions expire after roughly ten hours; a mid-run expiry
  fails only the AWS steps, and the harnesses' `--cleanup` reruns finish
  them. Concurrent CLI processes race on token refresh; the harnesses retry.
- Launch multi-hour runs detached (PowerShell `Start-Process`). Git Bash
  mangles `/aws/lambda/...` log-group names; use PowerShell for those.
- Stage B evidence directories contain the harness vendor's credentials
  (`series.json`); only `runs/evidence*/` is gitignored.
- `pnpm admin:customer-cleanup inventory | execute --confirm FULL-CUSTOMER-RESET | verify`
  (`scripts/customer-reset`, needs `DATABASE_URL`) wipes every customer
  deployment and its AWS resources while preserving control-plane data; it
  refuses stacks tagged `DeployzPersistent=true` or `DeployzProtected=true`.
