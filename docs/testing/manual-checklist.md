# Manual QA checklist

The human walk of the whole product, with an arbitrary third-party
application (Documenso is the standing choice), through the real dashboard
against the deployed control plane and the test AWS account. See
[`compatibility.md`](compatibility.md#the-manual-full-product-walk) for when
to run this (manually, periodically, before a significant release, after an
analyser/build/platform change — never on a pull request).

Every item below is marked **Automated:** with the layer that already proves
the mechanical half of it, so the human check is only the part no automated
layer can judge — wording, feel, honesty of what the screen claims versus
what AWS actually did. An item marked **Automated: none** is not yet proven
by any automated layer; a repeated manual finding there is a candidate for a
new simulated scenario or canary case
([`strategy.md`](strategy.md#aws-failure--simulator-regression-rule)).

## Before you start

1. **Fix the commit under test.** Production is the last commit on `main`
   whose CI run was green: `release.yml` runs after a successful CI run and
   calls `deploy-api.yml` and `deploy-web.yml`, and the `deployed/api` and
   `deployed/web` tags name the commits production runs. The
   `deployed/staging/api` and `deployed/staging/web` tags name staging's.
   Record
   `git rev-parse origin/main` **and** confirm the release run for that SHA
   succeeded (`gh run list --workflow release.yml --limit 3`; a called
   workflow's run is nested under the caller's run and does not list on its
   own, and the API
   Lambda's `LastModified` must be after the run). Another workstream may
   merge while you test — re-record the SHA whenever `origin/main` moves and
   note which findings were observed on which SHA.

2. **Publish the bootstrap template from that commit.** The deploy workflow
    republishes the
    bootstrap template only when the `BOOTSTRAP_REPUBLISH` repository
    variable is `on`. Otherwise what a customer downloads is whatever
    `publish:bootstrap` last uploaded, so a walk on
    a stale template tests old relay code. (The application stack needs no
    publish step: the API compiles and publishes its artifact at deployment
    creation.) Compare
    `packages/cdk/artifacts/bootstrap-template-v1.json` (the relay asset hash
    in `RelayFunction.Code.S3Key`) with the published object before assuming
    they match:

    ```bash
    pnpm build
    BOOTSTRAP_PUBLISH_REGIONS=us-east-1 BOOTSTRAP_LEGACY_BUCKET_REGION=us-east-1 AWS_REGION=us-east-1 \
      pnpm --filter @deployz/cdk run publish:bootstrap
    ```

    The bootstrap publisher prints the `BOOTSTRAP_TEMPLATE_URL` it wrote; it
    must equal the deployed API Lambda's `BOOTSTRAP_TEMPLATE_URL` environment
    variable (`aws lambda get-function-configuration`). Without
    `BOOTSTRAP_PUBLISH_REGIONS` the publisher fans out to every
    `deployz-templates-<region>` bucket and fails closed if one is missing;
    restrict it to the Region under test when you only need one. Republish
    after every merge that touches `packages/relay/src` or
    `packages/cdk/src/bootstrap` —
    including a merge that lands mid-walk.

3. **Baseline and resource ledger.** Before creating anything, capture what
   exists so cleanup can be proven by difference, not by tags alone (the
   relay stack creates some untagged and retained resources):

   ```bash
   R=us-east-1
   aws cloudformation list-stacks --region $R --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE ROLLBACK_COMPLETE DELETE_FAILED CREATE_IN_PROGRESS DELETE_IN_PROGRESS --query 'StackSummaries[].[StackName,StackStatus]' --output text
   aws rds describe-db-instances --region $R --query 'DBInstances[].[DBInstanceIdentifier,DBInstanceStatus,DeletionProtection]' --output text
   aws elasticache describe-replication-groups --region $R --query 'ReplicationGroups[].ReplicationGroupId' --output text
   aws s3api list-buckets --query 'Buckets[].Name' --output text
   aws ecs list-clusters --region $R --query clusterArns --output text
   aws elbv2 describe-load-balancers --region $R --query 'LoadBalancers[].LoadBalancerName' --output text
   aws secretsmanager list-secrets --region $R --query 'SecretList[].Name' --output text
   aws logs describe-log-groups --region $R --query 'logGroups[].logGroupName' --output text
   aws resourcegroupstaggingapi get-resources --region $R --tag-filters Key=deployz:installation --query 'ResourceTagMappingList[].ResourceARN' --output text
   ```

   Keep a ledger. Add every identifier the moment it appears: the bootstrap
   stack name and installation id, the relay Lambda name, the application
   stack name, its outputs (RDS identifier, bucket, cache replication group,
   cluster, ALB), the ECR tag of any release you build, and anything created
   to diagnose (probe Lambdas, roles). The control-plane resources (the
   `Deployz` stack, its RDS, `deployz-images`, the template buckets) are
   never yours to touch.

## The walk

1. **Vendor** (`app.deployz.dev`, an org with the GitHub App installed): add
   the application, wait for analysis, confirm "Ready to deploy" and that the
   Configuration form shows the detected container port, health path and
   migration command you expect.
   **Automated:** `packages/analysis/test/*`, Stage A (`compatibility.md`)
   for analyser accuracy. **Judge:** does the readiness page read clearly to
   someone who has never seen Deployz before?
2. **Deployment**: Deployments → Create Customer Deployment (a throwaway
   customer name/email). Record the install link and deployment id.
   **Automated:** `e2e/create-deployment.spec.ts`. **Judge:** is the install
   link presented in a way a vendor would actually hand to a customer?
3. **Customer**: open the install link, press *Review setup in AWS*, land on
   the CloudFormation Quick Create page (stack name prefilled, template +
   control-plane URL + enrollment code prefilled), tick the IAM
   acknowledgement, *Create stack*.
   **Automated:** `packages/cdk/test/quick-create.test.ts`,
   `e2e/install.spec.ts`. **Judge:** does the hand-off from "customer clicks
   a link" to "customer is looking at a CloudFormation console they did not
   expect" make sense without an explanation?
4. **Provisioning**: the application stack appears
   (`deployz-app-<installation prefix>`); with Redis required this takes
   about 10 minutes. Watch for `relay:command-deferred` then
   `relay:command-resumed`/`relay:command-verified` in the relay log group.
   **Automated:** `e2e/scenario-provisioning.spec.ts`,
   `e2e/deployment-progress.spec.ts`. **Judge:** does the progress messaging
   the customer sees match what is actually happening in AWS at that moment
   — never further ahead, never vague when it could be specific?
5. **Healthy**: the deployment reaches HEALTHY only after a heartbeat with
   full task counts, healthy ALB targets and a successful HTTP probe. Check
   the app yourself with `curl` (the ALB is plain HTTP until HTTPS is
   active). HTTPS provisions automatically on `d-<deployment-id>.deployz.dev`
   with zero customer DNS.
   **Automated:** `e2e/scenario-default-https.spec.ts`,
   `apps/api/src/health-transitions.test.ts`. **Judge:** does "Open app"
   appear only once the app is genuinely reachable, never a moment early?
6. **Inventory**: `aws cloudformation list-stack-resources` per-type counts
   must equal the vendor *Infrastructure* section / `deployment_resources`
   rows.
   **Automated:** the plan-vs-inventory checks below.
7. **Release + deploy**: Application → Releases → Create Release; *Deploy
   Update* on the deployment. Watch the migration task's exit code and the
   app log group. A failed update must leave the deployment at
   UPDATE_AVAILABLE/HEALTHY with the old task definition still PRIMARY.
   **Automated:** `packages/relay/src/deploy.test.ts`,
   `e2e/scenario-lifecycle.spec.ts` (`update-failure`, `rollback-success`),
   the version canary `core` scenario (`aws-e2e.md`). **Judge:** does the
   failed-update banner say what actually broke, in words a vendor can act
   on, without exposing a raw AWS error at the top level?
8. **Disconnect**, then **Purge** from the vendor UI. After Disconnect the
   deployment leaves Home and the live fleet — open Deployments → status
   *Removed* to reach it. Disconnect deletes the application stack but
   retains RDS, its credential secrets, the S3 bucket and the subnet group;
   Purge removes those. The bootstrap/relay stack is deleted by the customer
   in CloudFormation — the pages must tell them so; in a walk, delete it
   yourself.
   **Automated:** `packages/relay/src/purge.test.ts`, scenarios
   `retained-resources`/`delete-failure`, the version canary's teardown.
   **Judge:** does the customer-facing *Security details* page state, in
   plain language, exactly what stays behind and why?

## Cleanup verification

Re-run the baseline commands from "Before you start" and diff against the
ledger:

- The bootstrap stack is not deleted by Purge: delete
  `deployz-bootstrap-<app>-<8 chars>` yourself with
  `aws cloudformation delete-stack` as the customer would from the console,
  then delete its relay log group.
- No `deployz-app-*` or `deployz-bootstrap-*` stack in any status other than
  DELETE_COMPLETE (`list-stacks` without a status filter shows deleted
  history for 90 days — that is expected).
- No RDS instance, RDS subnet group, ElastiCache replication group, ALB, ECS
  cluster (ACTIVE), VPC, NAT gateway, or EIP that was not in the baseline.
  Retained-by-design resources only disappear after Purge.
- Secrets Manager: no `DatabaseSecret…`, `DatabaseUrlSecret…`,
  `AppConfigSecret…` or `RelayCredential…` from the walk. Purged secrets sit
  in *scheduled for deletion* — `list-secrets --include-planned-deletion`
  shows them; that is the expected end state.
- Log groups: the application log group is deleted with the stack, but the
  relay function's log group and the install-id/log-retention Lambda groups
  survive stack deletion — delete them explicitly.
- SSM: no `/deployz/<installationId>/*` parameter left.
- ECR: delete the release image tag you built.
- Anything created to diagnose (probe Lambdas, roles, their log groups).
- `aws resourcegroupstaggingapi get-resources --tag-filters
  Key=deployz:installation,Values=<installationId>` returns nothing except
  INACTIVE ECS clusters/task definitions, which the tagging API keeps
  listing after deletion and which cost nothing.

## Driving the dashboard from automation

The dashboard is a Next.js app whose pages stream inside a Suspense boundary
that React reveals on `requestAnimationFrame`. A browser tab that is not
visible never fires it, so every page except Home stays on its skeletons and
no API calls run — it looks like an outage. Check
`document.visibilityState` before filing a defect, keep the driven tab in
the foreground, and prefer client-side navigation (clicking the app's own
links) over reloading a hidden tab.

## Known failure modes (still worth re-checking by hand)

Each of these was found live at least once; a guard now exists, but the
*symptom* — what a human sees on the screen — is what this walk re-checks,
not the guard's internals (which the linked test already covers).

| Symptom | Guard (automated) |
| --- | --- |
| Install reported "failed" after exactly 3 minutes while the stack keeps creating | SSM pending marker size handling; `packages/relay/src/pending.test.ts` |
| Healthy app analysed as NOT_COMPATIBLE (dev compose file, cloud SDKs) | `packages/analysis/test/phase7.test.ts` |
| Health path detected as a source-file path instead of a route | `deriveHealthPathFromFile` tests |
| Failed update marks the deployment FAILED although the old version still serves | `apps/api/src/failure-semantics.test.ts`, `packages/cdk/test/worker.test.ts` |
| Migration task exits 1 on a node-entrypoint image | migration runs as `sh -c <command>`; `packages/relay/src/deploy.test.ts` |
| Diagnostics blame a rolled-back resource for a relay-side fault | `RELAY_STATE_WRITE_FAILED` refinement |
| Create-deployment form duplicates the customer on a generic error | `e2e/create-deployment.spec.ts` |
| Deferred command never resumes (Disconnect stuck RUNNING) | SecureString marker decrypt fix; `packages/relay/src/pending.test.ts` |
| No Purge control after a normal Disconnect | any DELETED deployment is purgeable until `cleanupState` COMPLETE |
| Disconnected deployment unreachable from the dashboard | *Removed* status filter |
| Purge "succeeds" but the relay stack stays and keeps polling | `connectorStackRetained` reporting |
| VPC/subnet/DB security group/RDS subnet group survive Disconnect + Purge | tag-verified network sweep; `packages/relay/src/purge.test.ts` |

## AI MVP checks (P0/P1)

Run these on the same walk, in order — they cost nothing extra in AWS.

1. **Analysis.** The readiness page must show "What Deployz detected" with
   runtime, framework, start/build command, port, database, cache, storage,
   health check and migrations, each with evidence behind its disclosure.
   For Documenso: runtime Node.js, PostgreSQL required, health check
   `/api/health`, a migration command, no blocker.
   **Automated:** Stage A (`compatibility.md`). **Judge:** is the evidence
   disclosure actually convincing, or does it read like a black box?
2. **Fix guidance.** "Generate fix instructions" for a required finding must
   name the finding's evidence and read as verify-then-implement; reopening
   must reuse the cached document; Regenerate must produce a fresh one.
   **Automated:** `apps/api/src/fix-instructions.test.ts`,
   `e2e/fix-instructions.spec.ts`. **Judge:** would a developer unfamiliar
   with Deployz actually be able to follow it?
3. **Environment.** The Environment card must list managed/generated
   variables under "Deployz configures automatically" and only genuine
   customer-required keys under "You need to provide". `NEXTAUTH_SECRET` and
   the encryption keys must never be asked for.
   **Automated:** `apps/api/src/config.test.ts`,
   `apps/web/test/config.test.ts`.
4. **Preflight.** The create-deployment form must show the preflight before
   submit; the install link card must show it for the new deployment; the
   API must refuse launch (`MANIFEST_NEEDS_CONFIGURATION`) if a required
   value is deleted after creation, and allow it once restored. Documenso has
   no customer-required key — use an application that has one, or the
   simulated `scenario-sweep` suite.
   **Automated:** `apps/api/src/preflight.test.ts`, `e2e/readiness.spec.ts`.
5. **Post-install configuration.** After INSTALL succeeds, when the manifest
   has a value to deliver, the activity feed must show a "Configuration
   updated" event and the job output must list any `generatedKeys` (names
   only). Verify with the AWS CLI that the `AppConfigSecret` holds those keys
   and the task definition binds them.
   **Automated:** `apps/api/src/pending-secrets.test.ts`,
   `apps/api/src/pending-secret-delivery.integration.test.ts`.
6. **Failure diagnosis.** Use a broken release (or a real quota failure if
   one occurs): the diagnostics card must lead with the copy-map explanation,
   keep the raw relay text and failure context behind "Technical detail",
   and never show a raw CloudFormation status at the top level. A
   below-high-confidence AI explanation must be hedged.
   **Automated:** `apps/api/src/failure-classification.test.ts`,
   `apps/api/src/ai-explanation.test.ts`, `e2e/diagnostics.spec.ts`.
   **Judge:** does the leading explanation actually make sense to someone
   who has never seen the underlying AWS error?
7. **HTTPS truth.** While the certificate issues, the Infrastructure card
   must show *Secure endpoint* as "Setting up" / "Waiting for certificate" /
   "Activating HTTPS", and "Ready" only once `defaultHttps.status: ACTIVE`.
   Verify externally at each stage with `curl -sI
   https://d-<deployment-id>.deployz.dev/<health path>`.
   **Automated:** `apps/api/src/default-https.test.ts`,
   `e2e/scenario-default-https.spec.ts`.
8. **Unavailable release.** Deploy a release normally; delete a second READY
   release's image tag; press *Deploy Update* on a page loaded before the
   deletion. The API must answer 409 `RELEASE_UNAVAILABLE`, queue no job,
   keep the running release live, and the releases page must show
   "Unavailable" after the next refresh.
   **Automated:** `e2e/scenario-release-unavailable.spec.ts`.

## Plan and inventory checks

The install/destroy plan and the infrastructure expectations block are both
built purely from the stored manifest — never from a live AWS read. Cross-
check them against what AWS actually holds.

1. **Install plan vs. the Infrastructure section.** Before Create Stack,
   note the install page's "Deployz will create" list. After HEALTHY,
   `GET /api/deployments/:id/plan?action=install` must list the same
   components as CREATE, and the vendor page's Infrastructure section must
   show each `ready` with no `Missing` row and no `Not required` row for a
   component the manifest actually requires.
2. **Destroy plan vs. retained resources.** Before Disconnect, fetch
   `GET /api/deployments/:id/plan?action=destroy` and note DELETE vs.
   RETAIN. After Disconnect (before Purge), confirm AWS agrees with the
   RETAIN list (RDS, cache, bucket, secrets still present; application,
   secure endpoint, cache gone). After Purge, `infra.expectations.missing`
   on a re-fetched infrastructure response must read empty.

**Automated:** `packages/contracts/src/plan.test.ts`,
`packages/relay/src/purge.test.ts`, the version canary's
`verifyRetainedState`/`verifyPurgedRetainedState` steps (`aws-e2e.md`).
**Judge:** whether the honest, current-state framing survives contact with a
human who does not already know what "retained" is supposed to mean.

## Areas no automated layer judges

- **Visual polish.** `pnpm e2e e2e/visual.spec.ts` (snapshot diffing) catches
  pixel regressions, but its committed snapshots are **Windows-only** — run
  it on Windows, and re-check spacing/alignment/contrast by eye on at least
  one other platform, since no automated layer does.
- **Usability.** Can a first-time vendor and a first-time customer complete
  the walk above without external help? No automated layer measures this.
- **Wording.** Copy-map strings and page text are unit-tested for presence
  and for which code maps to which string, never for whether the words
  themselves are clear, honest, or free of jargon.
- **Vendor → customer hand-off clarity.** The moment a vendor-generated link
  becomes something a real customer opens cold (the install link, an
  invitation, a Deploy Link) is only automated for correctness (does it
  resolve, does it 404/410 correctly), never for whether a customer with no
  Deployz context understands what they are looking at.
- **Progress messaging.** Automated layers assert the *state machine* is
  monotonic and honest (`deployment-progress.spec.ts`); only a human
  watching the wall-clock time next to the words judges whether the message
  still feels honest three minutes into "Setting up your database".
- **Diagnostics clarity.** Automated layers assert a diagnostic leads with
  the copy-map explanation and hides raw text behind "Technical detail"
  (`e2e/diagnostics.spec.ts`); only a human judges whether that explanation
  actually resolves the confusion a real failure caused.
