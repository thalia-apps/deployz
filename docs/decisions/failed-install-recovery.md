# Failed first-install recovery (2026-08-27)

**Status:** active. Implemented in `packages/relay/src/recover.ts` and the
`POST /api/deployments/:id/retry-install` route; the vendor reaches it as
"Retry deployment" on the deployment detail page and Team Admin as a
recovery action. The lifecycle rules around it are in
[`../deployment-resilience.md`](../deployment-resilience.md).

## The problem

A failed **first** install used to brick a deployment permanently:

1. The relay honestly reports a terminal stack failure
   (`ROLLBACK_COMPLETE`, …) and never recreates such a stack.
2. CloudFormation cannot update a `ROLLBACK_COMPLETE` stack, so every later
   INSTALL fails while it exists.
3. Deleting the stack by hand can also fail: the RDS instance is
   `Retain` **and** has deletion protection, and the S3 bucket is `Retain`.
   The retained instance keeps its security group's ENIs alive, the security
   group keeps the subnet and VPC alive, and the stack lands in
   `DELETE_FAILED`.
4. The INSTALL job was created only at relay registration, so there was no
   retry path at all.

## The decisions

1. **Recovery runs inside an explicit vendor retry; there is no separate
   "clean up first" action and no automatic recovery.** Deleting resources
   in a customer account always starts with a human decision. The retry is
   double-guarded: a control-plane flag in the job payload and a relay-side
   refusal to touch any stack that is healthy or in progress.
2. **"Never successfully installed" is asserted by the control plane.** The
   route refuses (`409 INSTALL_ALREADY_SUCCEEDED`) when any earlier INSTALL
   job succeeded. A deployment that was healthy once keeps its
   data-protection guarantees; its failures belong to deploy or rollback.
3. **Recovery uses only already-granted IAM.** The relay's provisioner
   policy already allows `rds:ModifyDBInstance`, `rds:DeleteDBInstance` and
   the ElastiCache replication-group deletion, all conditioned on the
   `deployz:installation` tag that the application stack applies. No new
   permissions, no bootstrap template change. Orphans are identified from
   the failed stack's own resource list, never by name guessing.
4. **The failed attempt's bucket and credential secrets are removed.**
   They hold no data: the control plane proved the deployment never
   installed. Once recovery confirms the stack is gone, the relay deletes the
   buckets and secrets that carry this installation's tag, with the purge's
   own clients (bucket ownership is verified in code, because object ARNs do
   not resolve `aws:ResourceTag` conditions). The sweep runs only after the
   stack is confirmed gone and before the fresh install, so it never touches
   the new attempt. A sweep that fails (for example an older connector
   without the grants) is logged and never blocks the recovery. Earlier
   versions left these behind on purpose; that left empty buckets and
   secrets in the customer's account after removal.
5. **Bounded, convergent passes.** Every wait is capped inside the relay's
   5-minute invocation and the INSTALL executor's own budget. When the
   budget runs out the relay reports the real CloudFormation status; the
   vendor retries and each pass continues from real state. A stack already
   deleting is waited on, not re-deleted, until it settles `DELETE_FAILED`.
6. **Retryable states.** `FAILED`, and `INSTALLING` with an in-flight job
   older than 30 minutes (six missed relay polls: a dead invocation that
   would otherwise leave the deployment in `INSTALLING` forever; the stale
   job is cancelled and a fresh retry queued). Not retryable:
   `NOT_INSTALLED` (registration owns it), `INSTALLING` with a fresh attempt
   (a double-click replays the live job), `HEALTHY` / `UPDATE_AVAILABLE` /
   `UPDATING`, `DELETING` / `DELETED`. A relay that is not connected is
   refused with `409 RELAY_NOT_CONNECTED`; reconnect first.
7. **Attempt-scoped idempotency keys.** `${deploymentId}:INSTALL` is spent by
   the failed job, so retries use `${deploymentId}:INSTALL:RETRY:${n}`.
   Double-clicks on the same attempt still dedupe.
8. **Honest status is preserved.** Recovery is a separate module that runs
   before the unchanged install executor; the verification gate after
   install is unchanged.

## The flow

```
vendor: POST /api/deployments/:id/retry-install
  guards pass → new INSTALL job with { recovery: { neverInstalled: true } }
  deployment.state → INSTALLING, event install.retry.requested
relay (next poll):
  refuse live / in-progress stacks
  delete the terminal-failed stack, wait (bounded)
  on DELETE_FAILED: RDS deletion protection off → delete; delete the cache
  re-delete the stack, wait (bounded)
  installApplicationStack (unchanged) → verifyInstallation (unchanged)
```

The customer-facing retry (install link, deploy link) reaches the same pass.
When a connector registered in a previous attempt, the retry keeps its
bootstrap stack and installation and returns `existingStackUpdate` instead of a
Quick Create link. A new connector would mint a new installation id whose IAM is
scoped to its own tag, and it could never recover the failed stack or its
retained RDS instance. The customer updates the stack with the new
`RelayCredential` and `EnrollmentCode`; registration then creates the INSTALL
with `recovery`. A retry with no registered connector gets a fresh stack.

The relay's stack read is scoped to the installation tag, so a stack that has
been deleted answers `AccessDenied`, not "does not exist". The recreate step
therefore treats that answer as "gone" in recovery mode, at the first read and
after it has watched the old stack delete (2026-11-02, staging: the install
failed with `AWS_PERMISSION_DENIED` and never created the stack). The
authorization check before the create is unchanged, and CloudFormation still
refuses a create for a name that exists.

A retried install that defers (stack still building) is finished by the
resumer on later polls without re-running recovery.
