# Deployz UX guidelines

The target Deployz experience. The charter
([`ux-excellence-charter.md`](ux-excellence-charter.md)) defines how the UX
program works. This document defines what the UX must be. The code and the
product documents stay authoritative for current behavior. The UI mechanics
(shadcn, tokens, typography) stay in [`../ui-system.md`](../ui-system.md).

**STATUS: ACCEPTED (2026-09-29).** Implement these decisions in the UX phase
that owns them. A UX-BACKEND item (§12) still needs its own approval before
backend work starts. A change to a decision needs human approval and an
update to this document.

The UX-A audit evidence (source audit and browser capture, 2026-09-29) is in
the git history of this file (first commit). It is not kept here.

## 1. Journeys

### Vendor

| Step | Where | Dominant action |
| --- | --- | --- |
| Connect repository | Home (first use) → Add application | Add application |
| Analysis | Application › Overview | none (progress) |
| Fix what is required | Overview → Configuration › Resources | Review required changes |
| Test | Overview | Start test deployment |
| Share | Overview | Copy install link |
| Later releases | Application › Releases | Create release → Test release → Make available to new customers |
| Monitor | Home, Deployments | the row that needs attention |
| Operate a deployment | Deployment detail | one per state (§4) |

- Setup lifecycle: **Analyse → Configure → Test → Share**. Four steps. Release
  is not a lifecycle step. The Test card says that it builds the first
  release from `branch@sha`. Releases stays a first-class tab for later
  releases.
- Remove the unlinked `/dashboard/onboarding` route. Home's onboarding
  checklist and the application lifecycle are the only setup guidance.
- **Shareable release.** New customers install only the application's
  shareable release. A release becomes shareable only after a test
  deployment of that exact release succeeds. A newer READY release never
  replaces the shareable release because it is newer.
- First release: a successful test makes it shareable. This is the Share
  step of the lifecycle; the vendor does not take a separate action.
- Later releases: "Test release" and "Make available to new customers" are
  two explicit vendor actions. The second is available only for a release
  whose test succeeded. The Releases list marks the one release that new
  customers get.
- Existing deployments change only by "Deploy update".
- Until UX-BACKEND-004 ships, the UI must not claim this behavior; it
  describes the current behavior truthfully.

### Customer

Before deploy, the review page answers, in this order, as primary content:

1. What am I installing, and from whom? (application, publisher, release)
2. Where? (Region; "the AWS account you are signed in to")
3. What will be created? (resources, customer-level summary)
4. Approximate monthly AWS cost (when available)
5. What access does Deployz get? (facts plus a "Security details" link, also
   on the confirm form)
6. What do I provide? ("Set by customer" settings; secrets in `SecretInput`,
   with the truthful secret statement in §8)
7. What remains after removal, and does it keep costing money?

| Stage | Dominant action |
| --- | --- |
| Review and confirm | Continue to setup |
| Launch | Review setup in AWS |
| Waiting for AWS | none; after the staleness window: Retry connection |
| Deploying | none |
| Ready | Open application |
| Failed | none, or the action the customer must take (§6) |
| Removed | per §7 |

## 2. Information architecture

Sidebar: unchanged.

| Object | Owns | Does not own |
| --- | --- | --- |
| Application | Analysis, configuration, releases, install link | Deployment operations |
| Customer | Contact details, invitations, links to that customer's deployments | Deployment operations, install link |
| Deployment | Status, every day-2 action, per-deployment configuration, failure and recovery, diagnostics, infrastructure detail | Application defaults |

- **Diagnostics is part of the deployment page.** The recovery panel (§6)
  is on the deployment page. The infrastructure check table is a section of
  that page under Technical details. `/dashboard/deployments/[id]/diagnostics`
  stays as a deep link that opens the deployment page at that section. It is
  not a second recovery destination.
- Customer detail has one "Invite customer" button, in the header.
- Customer overrides of environment values are edited only on the
  deployment's configuration.

## 3. Application page

Tabs: **Overview · Configuration · Releases**.

Header: name, one status badge (§5), repository. No separate release badge.
Header overflow menu: **Re-analyse application** (its home in normal states).

**Overview** — at most three blocks: the state card
(`deriveApplicationPresentation`), the install-link row when a live link
exists, and one line "N services detected · View" that opens Configuration ›
Services.

**Configuration** — four secondary tabs, Resources first:

1. Resources — the canonical vendor resource view (§8): one flat row per
   service, with build & runtime (port, health path, migration, start and
   build command) as indented rows under the web application. Each issue
   shows on its row, beside the action that opens its editor.
2. Size presets — the Small / Medium / Large presets side by side
   (read-only), then the default size and the minimum allowed size.
3. Variables — one table for detected variables and vendor defaults,
   filtered to the vendor and customer inputs by default, with search.
4. Settings — name, repository, branch, re-analysis, danger zone.

**Releases** — list and "Create release" (commit, version, optional
migration override). A failed row opens its failure details.

## 4. Primary action per state

One filled button per screen. Other actions are outline or in "More actions".
Do not show an action the state cannot use; one line says when it becomes
available.

| Surface · state | Primary action |
| --- | --- |
| Application · analysing | none |
| Application · analysis failed or stale | **Re-analyse application** |
| Application · needs input (repository change) | Review required changes (Re-analyse in the fix dialog after the change) |
| Application · needs input (setting) | Review required changes |
| Application · ready to test | Start test deployment |
| Application · test running | View test deployment |
| Application · test failed | Review failure |
| Application · ready to share / live | Copy install link |
| Release · build failed | Review failure details |
| Deployment · waiting for customer | Copy install link |
| Deployment · setting up | none |
| Deployment · live | Open application |
| Deployment · needs attention or failed | Review failure (the recovery panel) |
| Deployment · update failed | Retry update |
| Deployment · update available | Deploy update |
| Deployment · removed, retained data exists | Delete retained data (outline, destructive) |
| Customer · review | Continue to setup |
| Customer · launch | Review setup in AWS |
| Customer · ready | Open application |

## 5. Status model

Three different kinds of problem. Do not collapse them into one generic
state.

| Kind | Meaning | Examples |
| --- | --- | --- |
| **Needs input** | The user must provide or change something. | Required repository change, a variable that needs a decision, a missing value |
| **Needs attention** | An operational condition needs intervention. Nothing the user started has failed. | Health checks failing, degraded, lost contact with the connector |
| **Failed** | An operation failed. | Analysis failed, release build failed, install failed, update failed, removal failed |

One status per object, derived once, with the same words on every surface.
A second badge is allowed only for a different dimension the user acts on.

- **Application**: Analysing · Needs input · Analysis failed · Ready to test
  · Testing · Test failed · Ready to share · Live.
- **Release**: Building · Ready · Build failed · Unavailable.
- **Deployment (vendor)**: Waiting for customer · Setting up · Live · Needs
  attention · {reason} · Updating · Install failed · Update failed (the
  previous release is still live) · Removing · Removal failed · Removed.
- **Deployment (customer page)**: Setting up · Ready · Needs attention ·
  Failed · Removed.

Rules:

- Health overrides the operation label. An install whose health checks fail
  is "Needs attention · Not responding", never "Installing".
- Failed outranks Needs attention. A failed update whose health checks also
  fail is "Update failed"; its impact line says that the running release
  is not responding, never "unaffected".
- Home, lists and detail read one classifier (`lib/deployment-status-groups`).
  No page classifies a deployment by itself. The status badge and the
  deployment page headline use the same precedence and the same words
  ("Install failed", not "Deployment failed").
- An application whose analysis has not started shows "Not analysed", not
  "Analysing".

## 6. Failure and recovery

One pattern everywhere, top to bottom:

1. **What happened** — one sentence, product words.
2. **Impact** — what still works ("Release v3 is still live").
3. **Who acts** — only when authoritative data says so.
4. **Recovery action** — one primary button (§4).
5. **Technical details** — collapsed.

Content and actions depend on the role:

| | Vendor | Customer |
| --- | --- | --- |
| Actions | Retry, fix, Re-analyse, copy prompt for coding agent, copy report for Deployz support | Usually none; the action only when the customer must act |
| Who acts | Shown when the data establishes it | "{Publisher} has been notified" or the customer's own step |
| Technical details | Raw error, events, identifiers | Stack name, installation reference |

Rules:

- Do not infer who must act in frontend code. Release build failures carry an
  authoritative owner (`cause.owner`). Deployment failures carry only a
  recoverability class (`FAILURE_RECOVERABILITY`), which does not say vendor
  or customer (UX-BACKEND-005).
- One source per failure. The deployment page, Home and the customer page
  show the same classified summary.
- No circular next step.
- Inline `Alert` for failures; toast only for short success.

## 7. Removal

Terms: **Remove deployment** (was Disconnect) and **Delete retained data**
(was Purge). The facts below are from
[`../architecture.md`](../architecture.md) § Disconnect, purge and retained
data.

| Action | Removes | Remains | Charges |
| --- | --- | --- | --- |
| Remove deployment | Application, cache, most of the network | Database (deletion protection on, backups continue), its credentials, the storage bucket, the network parts the database uses, the Deployz connector | Retained items keep costing money |
| Remove deployment when the connector is offline (force-complete) | Nothing verified | Everything in the customer account | Continue |
| Delete retained data (vendor only; the connector must be online) | Database (no final snapshot), bucket (every version), application secrets, certificates, remaining network | The Deployz connector | Stop, except the connector |
| Customer deletes the connector stack | The connector | Nothing Deployz created, if retained data was deleted first | — |

After **Remove deployment**, the customer page states:

- what was removed;
- what remains, by name, from the deployment's frozen plan;
- that retained resources can keep incurring AWS charges;
- how to delete them: ask {publisher} to delete retained data, or delete them
  in the AWS console; keep the connector until {publisher} has deleted the
  retained data, because the deletion runs through the connector;
- then: delete the connector stack.

After **Delete retained data** completes (`cleanup: COMPLETE`), the customer
page states that only the connector remains.

**Delete retained data** confirmation states: it cannot be undone; the exact
items it deletes (by name); that no final database snapshot is taken; that
the connector stays and the customer deletes it. Keep type-to-confirm.

Never claim cleanup that Deployz did not verify. After a force-complete, say
that resources may remain. The customer page cannot see this case today
(UX-BACKEND-001).

## 8. Progressive disclosure and resources

**Primary decision information — never under Technical details** (where it
applies): Region, the resources that will be created, estimated AWS cost,
AWS access and security, customer-provided configuration and secrets,
retained resources and data, removal behavior, the failure summary, the
rollback migration warning.

**Technical details** (collapsed, one label everywhere; on the customer
progress page the one disclosure is "Deployment details" because it also
holds the detailed step list, the activity feed and component status): AWS sizing (vCPU,
memory, instance class, storage size, NAT gateway), AWS resource types and
counts, stack names and status, logical IDs, ARNs, account IDs, installation
references, raw events and raw errors, detection evidence, passed checks,
the load-balancer hostname when an HTTPS address exists.

**One resource representation per user context.** Remove duplicates that have
no purpose in that context.

| Context | Representation |
| --- | --- |
| Vendor Overview | "N services detected · View" |
| Vendor Configuration › Resources | Canonical vendor view: one row per service with its sizing, its AWS resources (each once, collapsed), estimated AWS cost, Kept after removal, and issues (Needs input); Detected / Confirmed states under Technical details (UX-BACKEND-007) |
| Vendor deployment page | Live status per service; resource inventory under Technical details |
| Customer pre-deploy | Concise customer summary grouped under generic headings; the full AWS resource table, with Kept / Removed, under "View AWS resources" |
| Customer during deploy | Component progress, only after the first infrastructure event, under "Deployment details" |

**Customer secrets — truthful statement.** Customers type secrets before
their AWS account connects, so this path applies
([`../pending-secret-delivery.md`](../pending-secret-delivery.md)):

> Secrets you enter are sent to Deployz over HTTPS and stored encrypted until
> your AWS account connects. Deployz then delivers them to AWS Secrets
> Manager in your account and deletes the active copy. If your account does
> not connect within 24 hours, the secret is deleted and must be entered
> again. Encrypted backup copies may remain for up to 7 days. Deployz does
> not display secret values or write them to application logs.

The last sentence is verified: API responses and events carry the mask
(`SECRET_MASK`), and logs carry only key names, ids and counts
(`apps/api/src/public-install.ts:493-500`; redaction tests in
`apps/api/src/secret-delivery.integration.test.ts`). The 7-day figure is the
control-plane database backup retention (`packages/cdk/src/deployz-stack.ts:101`).

The Security Details page does not list application secrets as data that
stays in the account (`DATA_NOT_SENT_TO_DEPLOYZ` in `lib/security-details.ts`),
and it states that secrets pass through Deployz.

## 9. Long operations

One step list for install, update and removal, on both surfaces:

- Completed steps, collapsed into "N steps done" when done.
- The current step in present tense ("Connecting your AWS account"), elapsed
  time, typical duration, "Checked just now".
- The next step name.
- One line when user action is required, with the action.
- "Taking longer than usual" only past the typical duration.

Never label a running step with its done text. After a failed step, do not
show a next step: the operation stopped there.

## 10. Terminology

| Use | Do not use |
| --- | --- |
| Application | app, product (as a noun in copy) |
| Analyse, Analysis, Re-analyse | Analyze, Reanalyse |
| Release; "version" is its label | build, image (as a noun) |
| Deployment; "install" is the verb for the first deployment | installation, environment |
| Test deployment | test install |
| Install link | deploy link, installation link, private/unlisted link |
| Invitation · Invite customer | Create installation, pending installation |
| Deployz connector | Relay, bootstrap |
| Remove deployment | Disconnect, uninstall |
| Delete retained data | Purge |
| Needs input · Needs attention · Failed | issue, problem, error (as a status) |
| Technical details | Advanced details, Analysis details, Show technical… |
| Sentence-case buttons | Title-case buttons |

## 11. Shared UI primitives

Build only these. Everything else is direct shadcn composition.

| Primitive | Replaces |
| --- | --- |
| `StepList` | `deployment-progress-steps`, `deployment-stepper`, `live-step-detail` |
| `StatusBadge` over `deployment-status-groups` | page-local status labels and double badges |
| `FailurePanel` (role-aware content) | hero failure block, diagnostic card, customer failure details, release failure summary |
| `TechnicalDetails` | differently named disclosures |
| `SecretInput` (exists) | the inline password field in `public-install-flow.tsx` |
| `EmptyState` over shadcn `Empty` | hand-written empty blocks, only when a page is touched anyway |

Do not build `PageHeader`, generic data tables or card factories.

## 12. UX-BACKEND items

Recorded, not implemented. Each needs separate approval.

### UX-BACKEND-001 — Unverified removal is invisible to the customer

- **Problem**: A force-completed removal (`cleanupState: SKIPPED_RELAY_OFFLINE`)
  or a failed data deletion (`PURGE_FAILED`) reaches the customer as
  `cleanup: null`, the same as a normal removal.
- **User impact**: The customer is told the application was removed while it
  may still run and cost money.
- **Evidence**: `packages/contracts/src/index.ts:650`;
  `apps/api/src/customer-activity.ts:463-472`; `docs/architecture.md`
  (force-complete row).
- **Why frontend cannot solve it**: `cleanupState` is not in the customer
  payload.
- **Required capability**: The customer status says when removal was not
  verified.
- **Minimal change**: Add `UNVERIFIED` to the customer `cleanup` enum, set
  from `SKIPPED_RELAY_OFFLINE` and `PURGE_FAILED`.
- **Priority**: P1 / pre-MVP (removal truthfulness is UX correctness).
- **Found in UX-B**: the customer removed page reads the install-page data,
  which has no cleanup state for a removed deployment. After a completed
  **Delete retained data** it cannot say that only the connector remains, so
  it states what can remain. The same `cleanup` value must reach that page.

### UX-BACKEND-002 — Infrastructure check freshness

- **Problem**: A diagnostics check result can contradict the latest events
  ("service was not created" after "Application started").
- **User impact**: Contradictory diagnosis.
- **Evidence**: UX-A browser capture (health-check failure); the check result
  has no link to the operation it evaluated.
- **Why frontend cannot solve it**: The client cannot know whether a check
  predates the current operation.
- **Required capability**: Each check result names the operation or time it
  describes.
- **Minimal change**: Return `checkedAt` and the `jobId` in force when the
  check ran.
- **Priority**: P2. Confirm on real AWS first.

### UX-BACKEND-003 — Component status lags the install stage

- **Problem**: "Web service: Waiting" after the health check completed.
- **User impact**: Progress looks wrong.
- **Evidence**: UX-A browser capture; `specComponents` derive from stack
  events only.
- **Why frontend cannot solve it**: Inferring component state from the stage
  invents backend truth.
- **Required capability**: The runtime component is ready once the job
  reports the service started.
- **Minimal change**: Set the runtime component from the job result.
- **Priority**: P3. Possibly a simulation artifact; confirm on real AWS.
- **UX-C handling**: At READY the customer page names the services without
  their state, so a lagging "Waiting" never sits under "Your application is
  ready". During the install the states show as sent.

### UX-BACKEND-004 — Shareable release, frozen at confirmation

- **Decision (accepted)**: A release becomes shareable only after a test
  deployment of that exact release succeeds. The authoritative flow is:
  build the release → test that exact release → make that release
  shareable → the customer reviews the shareable release → confirmation
  freezes that exact release on the deployment → the install deploys that
  exact release. A newer READY release never replaces the shareable release
  because it is newer. The release shown on customer review never differs
  from the release installed.
- **Problem (current code)**: The backend's only release validity is "build
  READY and image available" (`newestDeployableRelease`,
  `apps/api/src/install-parameters.ts:26-45`; `newestPublishedRelease`,
  `apps/api/src/public-install.ts:176-193`). "A test deployment passed" is a
  frontend-only gate (`apps/web/src/lib/application-state.ts`). Link creation
  auto-creates a READY release when none exists (`ensureInitialRelease`,
  `public-install.ts:698-744`). No release is frozen on the deployment: the
  install and the post-install auto-deploy take the newest READY release at
  that moment (`apps/api/src/server.ts:5062-5109`). The release enum is
  `BUILDING | READY | FAILED` (`packages/db/src/enums.ts:22-26`).
- **User impact**: A new, untested release goes to every new install at
  once, and can differ from the release the customer reviewed.
- **Why frontend cannot solve it**: Release selection happens server-side at
  install time; hiding a button stops nothing.
- **Required capability**: A server-side shareable release per application,
  enforced at link and invitation creation, customer review, confirmation,
  install and auto-deploy; the confirmed release frozen on the deployment; a
  test deployment that deploys the exact release it tests.
- **Minimal change** (no new release state machine):
  - The application records one shareable release id.
  - First release: the first successful test deployment of that release sets
    it (onboarding stays Analyse → Configure → Test → Share).
  - Later releases: the vendor tests a chosen release, then makes it
    available to new customers by an explicit action, which the API accepts
    only for a release with a succeeded test deployment.
  - Customer review and confirmation read only the shareable release;
    confirmation stores its id on the deployment; INSTALL and the
    post-install auto-deploy deploy that stored id.
  - `ensureInitialRelease` no longer makes a link shareable by itself.
- **Priority**: P1 / pre-MVP.

### UX-BACKEND-005 — Who must act on a deployment failure

- **Problem**: Deployment failure codes carry a recoverability class
  (`USER_ACTION`, `RECONCILE_FIRST`, `DEPLOYZ_ACTION`, `TERMINAL`,
  `packages/copy-map/src/index.ts:350-382`). `USER_ACTION` covers both
  vendor faults (port mismatch, health check) and customer-account faults
  (policy blocks, quota).
- **User impact**: The failure panel cannot tell the vendor whether to fix
  the app or contact the customer, or tell the customer whether to act.
- **Why frontend cannot solve it**: Choosing vendor or customer per code in
  the UI invents classification.
- **Required capability**: Each failure code states who acts: vendor,
  customer, Deployz, or none (wait).
- **Minimal change**: Add an `actor` map beside `FAILURE_RECOVERABILITY` in
  `@deployz/copy-map`, covered by the parity test.
- **Priority**: P2.

### UX-BACKEND-006 — HTTPS state disagrees between two signals

- **Problem**: Four HTTPS signals derive from the same `domain` and
  `defaultHttps` records with different rules: `needsDomainSetup`
  (`apps/api/src/deployment-status.ts:1097-1123`), the `https://` gate in
  `resolveAppUrl` (`apps/api/src/fleet-row.ts:95-112`, which accepts
  `defaultHttps.status === 'CONFIGURING'`), the component state
  `httpsComponentStatus` (`deployment-status.ts:492-530`) and the vendor
  secure-endpoint state `endpointHttpsState` (`deployment-status.ts:540-574`,
  whose null fallback is `SETTING_UP`).
- **User impact**: The vendor headline can say "Add a custom domain" while
  the secure endpoint says "Setting up". With default HTTPS `CONFIGURING`,
  the stage is READY and the URL is `https://` while the secure-endpoint
  component is still in progress, on the vendor and the customer page.
- **Evidence**: UX-B browser run (default-HTTPS fixture off). UX-C source
  check: both combinations are reachable with production data, not only in
  the simulator (`defaultHttps` is `null` before the default-HTTPS machine
  starts; `CONFIGURING` is a normal transient state).
- **Why frontend cannot solve it**: Choosing one signal over the other in the
  UI invents the HTTPS state.
- **Required capability**: One authoritative HTTPS state for all surfaces.
- **Minimal change**: One shared "effective HTTPS state" helper in the API
  that feeds `needsDomainSetup`, the `https://` URL gate, the component state
  and the endpoint state; `CONFIGURING` does not count as HTTPS-ready, and a
  missing record means "needs setup", not "setting up".
- **Priority**: P3 → P2 (reachable on real data; wrong READY claim).

### UX-BACKEND-007 — Architecture nodes cannot be joined to plan components

- **Problem**: `ArchitectureNode` in the readiness response carries only
  `label` and `state` (`apps/web/src/lib/readiness.ts:78-81`), with no id that
  matches the plan footprint's workload/resource ids
  (`apps/web/src/lib/footprint.ts`). Labels differ ("PostgreSQL" vs
  "Database").
- **User impact**: Configuration › Services cannot show one row per
  component (state + what customers get + Kept / Removed, §8). It shows the
  detected components and the plan's components as two lists under one
  heading.
- **Why frontend cannot solve it**: Matching by label is a guess.
- **Required capability**: A stable component id on each architecture node
  and unresolved item.
- **Minimal change**: Add `componentId` (the footprint workload/resource id)
  to `ArchitectureNode` and `ArchitectureUnresolved`.
- **Priority**: P3.

## 13. Documentation debt

Correct these documents; the code is the truth until then.

1. [`../pending-secret-delivery.md`](../pending-secret-delivery.md) contradicts
   itself. The threat model says plaintext never enters "API responses"
   (line 133). The same document (lines 53-55) and the code
   (`apps/api/src/install-config.ts:72-89`) show that the authenticated
   `GET /api/relay/config` response returns decrypted secret values to the
   relay. Scope the threat-model line to responses other than the relay
   configuration channel.
