# Deployz user flows — vendor and customer journeys

What each actor does, in order, and who configures what. This describes the
product **as implemented** at the time of writing; where the implementation
falls short of the documented intent, the gap is stated rather than hidden.
Scope and non-goals are in [`mvp-scope.md`](mvp-scope.md); the machinery
behind each step is in [`../architecture.md`](../architecture.md).

## Actors

- **Vendor** — the software company. Signs in to the Deployz dashboard
  (`apps/web`), owns applications, releases, customers and deployments.
- **Customer** — the vendor's customer. Never needs a Deployz account. Uses a
  public install page and their own AWS console.
- **Deployz team** — operates the control plane and the Team Admin support
  console ([`../admin/team-admin.md`](../admin/team-admin.md)).

## Vendor journey

| # | Step | Where | What the vendor does or sees |
| --- | --- | --- | --- |
| 1 | Sign up, organisation | `/sign-up`, `/organizations/new`, `/dashboard/settings` | Email + password or GitHub OAuth. One organisation with owner / admin / member roles. The organisation name is the publisher name customers see. |
| 2 | First use | `/dashboard` | Overview's onboarding checklist: Add application → Review configuration → Create deployment, with only the current step's action. After the first deployment, Overview shows the Live · Need attention · Deploying · Awaiting customer summary and at most three next steps (see [`../ui-system.md`](../ui-system.md#overview-home)). The application page carries the rest of the setup lifecycle. |
| 3 | Connect GitHub | `/github/setup` | Installs the Deployz GitHub App and selects repositories. The App's Setup URL must point at this page (see [`../operations/control-plane.md`](../operations/control-plane.md)). Webhooks handle installation events only; pushes do not trigger builds. |
| 4 | Create an application | `/dashboard/applications/new` | Picks a repository. Analysis starts automatically. One application per repository. The branch is the repository's default branch at creation and cannot be changed afterwards. |
| 5 | Analysis and readiness | `/dashboard/applications/[id]` | Overview is the application's home: one status badge (Not analysed, Analysing, Needs input, Analysis failed, Ready to test, Testing, Test failed, Ready to share, Live), one state card with one primary action, the install-link row when a live link exists, and "N services detected · View". The setup lifecycle is **Analyse → Configure → Test → Share**. "Re-analyse application" is in the header's "More actions" menu, and is the primary action when the analysis failed. "Copy prompt for coding agent" produces fix instructions for blocking findings. See [`../ai-analysis.md`](../ai-analysis.md). |
| 6 | Configuration | `…/config` | Four tabs, Resources first; the last tab is kept per application: Resources (one flat table: each service with its sizing, AWS resources, estimate, Kept after removal, issues and actions; build & runtime settings as indented rows), Size presets (the Small / Medium / Large presets side by side with each size's resources and estimated AWS cost, then the default size and the minimum allowed size; changes apply to new links and deployments only), Variables (one table for detected variables and vendor defaults, with filters and search), Settings (name, repository, branch, re-analysis, danger zone). Customer overrides show only with `?customer=` (opened from a deployment's Configuration). Overrides for container port, health path, migration command, and the database / storage / Redis requirements; unresolved architecture questions open as focused cards. Application root, Dockerfile path, build context and build/start commands are settable through the API (`PATCH /api/applications/:id`) but have no UI. |
| 7 | Environment variables | same page | For each detected variable: build or runtime, required, secret, and who provides it (Managed by Deployz / Set by vendor / Set by customer / Optional), plus a customer-facing label and help text. Vendor values are stored KMS-encrypted. See [`../environment-variables.md`](../environment-variables.md). |
| 8 | Releases | `…/releases` | Picks a commit from the configured branch (or enters a full SHA), gives it a version, optionally overrides the migration command. CodeBuild builds the image into ECR by digest. States: Building, Ready, Build failed (with log evidence and an optional AI explanation), Unavailable (image deleted). Each release shows an Infrastructure line: "No infrastructure changes", or a warning that the release requires infrastructure changes and automatic infrastructure upgrades are not supported yet. Creating a release never updates a customer. |
| 9 | Test deployment | `/dashboard/deployments/new?…&test=true` | One free TEST deployment per application, into the vendor's own AWS account, through the same install page a customer uses. The UI offers the customer install link only after a successful test deployment (the API does not enforce this). |
| 10 | Share with customers | see *Customer entry points* below | Three ways to hand a customer an install: a reusable public install link, a targeted invitation, or a vendor-created deployment. |
| 11 | Fleet views | `/dashboard/deployments`, `/dashboard/customers` | One status per deployment (Waiting for customer, Setting up, Live, Updating, Install / Update / Removal failed, Needs attention · reason, Removing, Removed), grouped for filtering as Failed or needs attention / In progress / Waiting for customer / Update available / Live / Removed. Customers roll up to Not installed / Installing / Live / Needs attention / Removing / Removed. |
| 12 | Deployment detail | `/dashboard/deployments/[id]` | The canonical operational page: status badge, hero (situation, progress, address), and for a failure the recovery panel (what happened, impact, cause and fix from the diagnostics classification, recoverability, technical details). Identifiers, the infrastructure check and raw events are under "Technical details". `…/diagnostics` is only a deep link to that section. |
| 13 | Day-2 actions | same page | Deploy update, Restart, Rollback to a previous release, Configuration (customer scope), Retry deployment (failed first install), new install link (connector reset: for an installed deployment the customer updates the existing connector stack with the new `RelayCredential` and `EnrollmentCode`; it never creates a second stack), connector update (customer-approved alert; keeps the credential), default-HTTPS retry (only when the default address itself is in error, not a custom domain). Actions are gated in this order: removed → never installed → relay not connected → another operation running. A failed update keeps the previous release live. Rollback never re-runs migrations. Bulk deploy of one release to every deployment exists only as an API route. |
| 14 | Custom domain | deployment detail → customer install page in a vendor session | The vendor enters the hostname; the customer creates two CNAME records in their own DNS; the relay issues an ACM certificate and wires the 443 listener. Change = remove, then add. See [`../networking-and-https.md`](../networking-and-https.md). |
| 15 | Remove deployment and Delete retained data | deployment detail | Remove deployment (type-to-confirm, plan-driven) deletes the application, network and cache and **retains** the database, its credentials and the bucket. Delete retained data deletes the retained items; the Deployz connector stays. "Complete removal anyway" settles a removal whose connector is gone, and says that resources may remain. Only the vendor can delete retained data. |
| 16 | Billing | `/dashboard/settings/billing` | Paddle subscription. Evaluation is free; the first PRODUCTION deployment requires the $49/month platform subscription; each live production deployment adds $19/month. See [`../billing/paddle-billing.md`](../billing/paddle-billing.md). |

### Customer entry points (vendor side)

| Entry point | Created from | What it creates | Region | Status |
| --- | --- | --- | --- | --- |
| **Reusable public install link** | Application overview ("Create install link") | Nothing until a customer confirms. Each confirmation creates a new customer record and a PRODUCTION deployment. One live link per application; enable / disable / revoke / regenerate. | Customer selects (pre-selected to the vendor's recommendation when present and deployable; otherwise explicit choice required) | Works end to end. |
| **Targeted invitation** | Customer detail page ("Create installation") or "Create deployment" on Home/Deployments, "Invite customer" on the Customers list | Nothing until the customer confirms. Bound to one customer, secured by a one-time token shown once. The token travels as the URL fragment (`#<token>`), stripped from history after capture. | Customer selects (pre-selected to the vendor's recommendation when present and deployable; otherwise explicit choice required) | Works end to end. |
| **Test deployment** | "Create Test Deployment" (`/dashboard/deployments/new?test=true`) | A TEST deployment immediately, in NOT_INSTALLED, with a per-deployment install link (30-day TTL, revoke / rotate). Free; no subscription required. | **Vendor** picks the Region | Works end to end. |
| Legacy deploy link | API only (`POST /api/customers/:id/deploy-links`) | A `/deploy/<publicId>?token=…` link with a vendor-fixed Region | Vendor | Legacy; kept for links that already exist. See [`../deploy-links.md`](../deploy-links.md). |

## Customer journey

1. **Receive a link** from the vendor (Deployz sends no email to customers).
   No Deployz account is needed.
2. **Review and choose** (public-link flow only, `apps/web/src/components/public-install-flow.tsx`):
   the AWS Region (only Regions the control plane can install into are
   offered), the application settings the vendor marked "Set by customer"
   (secrets in password fields, `_URL` / `_EMAIL` / `_PORT` names
    format-checked), name and email, the INSTALL plan, the resources that
    will be created (grouped under generic headings), a Region-priced
    monthly cost estimate, and the retention
   notice ("PostgreSQL and stored files are retained"). The customer also
   chooses the size: Small, Medium or Large, limited to the vendor's minimum,
   with the link's recommendation preselected and labelled "Vendor
   recommended". A change of size or Region recomputes the plan and the
   estimate and keeps what the customer typed. "Continue to setup" confirms
   the exact plan shown (its fingerprint): the server re-checks the link,
   Region, size, preflight and the vendor's subscription, refuses a plan
   that changed since the review (`409 PLAN_CHANGED`), then creates exactly
   one deployment with that size frozen. A vendor without an active subscription
   gets `402 SUBSCRIPTION_REQUIRED` here, so the customer's confirmation is
   refused; the vendor must subscribe first. Customer secrets go into the KMS-encrypted
   pending-secret vault ([`../pending-secret-delivery.md`](../pending-secret-delivery.md)).
   A vendor-created deployment skips this step; the vendor enters customer
   values on the deployment's configuration page instead.
3. **Pre-launch page** (`/install/<installLinkId>`): application,
   publisher, Region, release and invitation expiry, then the one shared
   customer review (also used by the hosted deploy page): the estimated
   monthly AWS cost; what will be deployed, as a compact summary under
   generic headings (Application hosting, Database, File storage, Network &
   security — only the ones the plan creates), with the complete AWS resource
   table under "View AWS resources"; environment variables, only when any
   exist; and the data and retention note. "Connect AWS account" marks the
   deployment WAITING_FOR_RELAY and opens the CloudFormation **Quick Create**
   URL for the frozen Region in a new tab. The next three steps, the AWS
   identity requirement, the Security details link (`/install/<id>/security`,
   which also opens for a public link or an invitation before a deployment
   exists) and the installation reference are under Technical details.
4. **Quick Create** in the customer's own AWS console creates the
   `deployz-bootstrap-…` stack: the relay Lambda on a one-minute schedule, its
   IAM role with a permissions boundary, the CloudFormation execution role,
   and the relay credential in Secrets Manager.
5. **Relay enrollment**: the relay registers with a single-use enrollment
   code; preflight runs again; the INSTALL job is created. While waiting, the
   page has no primary action. Past the staleness window it shows "Still
   connecting" guidance and "Retry connection", which mints a new code. If the connector already
   registered, the retry keeps its stack and the page shows how to update that
   stack with the new values; a second connector is not created. The
   expected stack name and a CloudFormation link are under Deployment details.
6. **Install progress**: the page polls `GET /api/install/:id/status` and
   shows one step list: Connect your AWS account → Create infrastructure
   (network, database and storage, cache as sub-rows) → Start application
   (migrations as a sub-row) → Check application → Set up HTTPS → Ready.
   Next to the heading are the completed-step count and the time on the
   current step. The current step shows the active operation, what AWS is
   doing and its typical duration; the latest AWS event is one row below the
   list. A failed step names what failed and shows no next step. One
   collapsed "Deployment details" disclosure holds the detailed step list,
   the full live AWS activity feed, the component rows (after the
   connection), raw CloudFormation events, identifiers and the resource
   inventory. At Ready "Open application"
   is the one primary action. INSTALL success auto-deploys the newest READY
   release.
7. **Permanent HTTPS URL**: `https://d-<deployment-id>.deployz.dev`, with no
   DNS work by the customer. READY needs verified health plus a verified
   HTTPS endpoint. Traffic to this URL passes through Deployz's Cloudflare
   edge; a custom domain routes directly to the customer's load balancer.
8. **Custom domain** (optional, vendor-initiated): the customer page shows the
   two CNAME records to create and a "Check now" button. The customer cannot
   add or remove a domain.
9. **After Remove deployment**: the page says the deployment was removed,
   lists what can remain in the account (the plan's retained components and
   the Deployz connector stack), says that retained resources can keep
   costing money, and explains how to delete them (ask the publisher to
   delete retained data, or use the AWS console; keep the connector until
   then). The page has no cleanup state, so it never says what was actually
   deleted (UX-BACKEND-001).
10. **What the customer must delete themselves**: always the bootstrap
    (connector) stack. If the vendor never purges: the retained RDS instance,
    its secrets, the bucket, and the network objects the retained database
    pins (a private subnet, the database security group, the VPC).
11. **What the customer cannot do in Deployz**: no deploy, rollback, restart,
    configuration, disconnect or purge. The customer uninstalls only through
    the AWS console.

## Who configures what

| Item | Who | When | Notes |
| --- | --- | --- | --- |
| Repository, application | Vendor | Before analysis | One application per repository; branch fixed at creation. |
| Port, health path, migration command, DB/Redis/storage overrides | Vendor | Before install; later edits affect later installs and deploys | A requirement change on a live deployment is reported as drift, never applied; a new deployment is needed. A newly required database or cache blocks deploys to that deployment until then. |
| Build settings (app root, Dockerfile, build context, build/start command) | Vendor | Before a release | API only. |
| Environment-variable classification, labels, help text | Vendor | Before release / install | |
| Vendor build-time values | Vendor | Before a release | Missing values block release creation. Values are baked into the image. |
| Vendor runtime values and secrets | Vendor | Before install | Not pushed to existing deployments. |
| Customer runtime values ("Set by customer") | Customer on the public install page, or the vendor on the customer's behalf | Before confirm; day 2 through the vendor | |
| Deployz-generated secrets (`…SECRET`, `SECRET_KEY_BASE`, …) | Relay, inside the customer account | At install | Minted with `crypto.randomBytes`; never stored in the control plane. (The template's own secret parameters are generated by the API per install and masked once the relay claims the job.) |
| Deployz-managed bindings (`DATABASE_*`, Redis, S3, `AWS_REGION`, `PORT`) | Deployz | At install | Injected by the compiled application stack. |
| Recommended Region | Vendor (optional) | On an invitation or public link | Shown as a badge and pre-selected. |
| Region | Customer (public link, invitation) or vendor (vendor-created deployment, legacy deploy link) | At creation | Immutable afterwards. |
| Recommended and minimum size | Vendor | Application configuration; recommendation per link | A link freezes both when it is created. |
| Infrastructure size | Customer (public link, invitation) or vendor (vendor-created deployment, legacy deploy link) | At creation | Any size at or above the minimum. Frozen afterwards; never resized. See [`../infrastructure-profiles.md`](../infrastructure-profiles.md#who-chooses-the-size). |
| Deployment type | Vendor | At creation | TEST via the create page; every customer confirmation is PRODUCTION. |
| AWS account | Customer | At launch | Whichever account runs the Quick Create. |
| Custom domain hostname | Vendor | Day 2 | |
| Custom domain DNS records | Customer | Day 2 | In the customer's DNS provider. |
| Default HTTPS URL | Deployz | After install | Automatic. |
| Deploy, rollback, restart, config update, disconnect, purge | Vendor | Day 2 | |
| Bootstrap stack deletion | Customer | After disconnect | CloudFormation console. |
| Included production deployment allowance | Deployz team (Team Admin) | Any time | |

## Who chooses the AWS Region

The intended model is: the vendor **recommends**, the customer **selects**, and
the Region is **immutable** once the deployment exists. The current
implementation matches this for both the public install link and targeted
invitations: the recommended Region pre-selects when present and deployable;
otherwise the customer must make an explicit choice (no silent first-region
default). For a test deployment (`?test=true`) the vendor chooses the Region
before the customer sees anything. Region enablement is an operator setting;
see [`../operations/control-plane.md`](../operations/control-plane.md).

## Status vocabulary

The customer-facing and vendor-facing vocabulary is defined once in
`packages/copy-map` and `apps/web/src/lib/deployment-vocabulary.ts`; raw
CloudFormation and ECS states never appear in the primary UI (an ESLint rule
rejects raw CloudFormation status literals in `apps/web`). See
[`../ui-system.md`](../ui-system.md) for the page anatomy and status rules and
[`../deployment-resilience.md`](../deployment-resilience.md) for the
underlying deployment, job and health states.
