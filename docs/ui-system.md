# Deployz UI System

Deployz uses **shadcn/ui as the application design system**. This document is
the canonical, compact reference. It is intentionally short — it defines the
system, not a design handbook.

## Principles

1. Use existing shadcn components first (`apps/web/src/components/ui`).
2. Follow native shadcn composition (e.g. `Card > CardHeader > CardTitle`).
3. Prefer built-in variants (`<Button variant="outline">`) over restyling.
4. Use semantic theme tokens (`bg-background`, `text-muted-foreground`, …).
5. Use `className` primarily for layout (spacing, width, grid/flex, responsive).
6. Prefer direct composition in pages over wrappers.
7. Extract domain components only after real repetition (e.g. `DeploymentStatusBadge`).
8. No additional UI framework. Lucide icons only.
9. Preserve shadcn/Radix accessibility behavior.
10. Keep raw AWS/CloudFormation states out of primary customer UI. Raw
    AWS resource types never appear on customer primary surfaces either —
    unknown resources bucket under a neutral label instead.
11. Preserve application logic unless a task explicitly requires changing it.

Never build a second design system on top of shadcn. No `UniversalCard`,
`GenericDataTable<T>`, or `DashboardWidgetFactory` layers.

## Architecture

```text
shadcn/ui primitives (components/ui)
        ↓
direct page composition (app/dashboard/**)
        ↓
feature/domain components only where repeated logic justifies them
```

## Shell

- `DashboardShell` composes `SidebarProvider > AppSidebar + SidebarInset`.
- `AppSidebar` carries the brand (SidebarHeader), `OrgSwitcher` and
  `DashboardNav` (SidebarContent: the organization row, then groups: main +
  Management), and the account menu (SidebarFooter).
- `SiteHeader` carries the `SidebarTrigger` and a compact section label on
  nested routes only — index routes where the label would repeat the page's
  own title suppress it, and the top bar carries no user identity. No
  duplicate large page titles in header and body.
- Screen padding and base spacing come from the shell's single `<main>`
  (`flex flex-col gap-6 p-4 md:p-6 lg:p-8`). Pages do not add shell padding.
- `SidebarInset` carries `min-w-0`, so a wide table scrolls inside its own
  container and never widens the page beside the tablet sidebar.
- No parallel custom responsive navigation; mobile behavior comes from the
  shadcn Sidebar.

## Brand

- Use `DeployzBrand` (icon + "Deployz") or `DeployzIcon` from
  `components/deployz-brand.tsx` for each brand mark. Do not paste the SVG
  into a different component and do not use a letter as a placeholder mark.
- The symbol uses `currentColor`. It follows the text color in light and dark
  mode.
- The asset rules and the drift test are in `apps/web/brand/deployz/README.md`.

## Status vocabulary

- User-facing deployment states come from
  `@/lib/deployment-vocabulary` (`DEPLOYMENT_STATE_LABELS`,
  `DEPLOYMENT_STATE_BADGE`) — rendered via `DeploymentStatusBadge`.
- Never show raw lifecycle terms (`CREATE_IN_PROGRESS`,
  `UPDATE_ROLLBACK_COMPLETE`) as primary labels; they may appear under
  advanced/diagnostic disclosures only.
- Never communicate state by color alone — pair color with label text (and
  icon/dot where the badge carries one).
- The Customers list says one thing per customer instead of a per-deployment
  state: `CUSTOMER_DEPLOYMENT_STATUS_LABELS` / `_BADGE` in
  `@deployz/copy-map`, derived by `customerDeployment` in `@/lib/customers`.
  It is a projection of the deployment `state` plus `attentionReason`, never a new
  lifecycle and never a second mapping of raw AWS statuses — extend the
  projection, not the vocabulary, when a case is missing.

## Deployment detail

The vendor deployment detail page (`app/dashboard/deployments/[id]`) is a
status page, not a console. Top to bottom:

1. Compact header — breadcrumb, application name, status/health badges,
   customer and running version on one muted line.
2. `DeploymentHero` — one state-aware card whose headline is the page's only
   `aria-live` element. The words come from `lib/deployment-hero.ts`
   (`deriveHero`), which only chooses copy for what the API already derived
   (`state`, `deploymentStatus`, `jobs`). A failed day-2 operation reads
   "Update failed … Release vX is still live and unaffected", never as the
   deployment being down; DELETING is "Removing this deployment", never
   failed. The install step list (first → last) shows only while an install
   is in flight or failed; the live URL block shows once the app is reachable.
3. Contextual actions in the hero footer — one primary action per state
   (Open application / Deploy update / Retry update / Retry deployment),
   Configuration as an outline button, and Restart / Rollback / Remove
   deployment behind a "More actions" menu. Day-2 actions are not rendered
   before an install has completed. A failure renders as `FailurePanel`
   (the recovery panel) inside the hero.
4. Compact metadata `dl` (customer, region label, release, created, URL,
   custom domain). AWS account, stack status, version identifiers, the
   infrastructure check and the raw CloudFormation event feed live under
   the collapsed `TechnicalDetails` at the bottom.
5. `InfrastructureSummary` — one row per service with a plain-English
   status; services the application does not need read "Not required". The
   resource-level inventory (`InfrastructureSection`) opens from
   "View N resources".
6. Recent activity — newest first, five rows by default, "View full
   activity" for the rest. The classified failure's plain-English summary is
   the only failure text at the top level; the relay's raw error stays inside
   the row's disclosure.

## Create deployment

The create page (`app/dashboard/deployments/new`, `?test=true` for the free
test deployment) is one flat form, at most 960px wide, with no cards:

1. Back link and title.
2. Configuration — Customer full width, then Application and AWS region
   side by side (stacked on mobile).
3. A divider, then readiness as status lines: `PreflightSummary` ("11 checks
   passed" with the passed checks behind "View details"; blocked and
   recommended checks always show under the line) and the release line
   (checking, "Building release …", ready, failed with Build / Review
   build failure actions, or unavailable with Try again).
4. The primary action. A test deployment is enabled only when the preflight
   is ready and the release is built; while disabled, one short hint beside
   the button says why. An invitation is not gated on the preflight — the
   customer supplies their own values first. A new customer or application
   re-runs the checks (the preflight does not depend on the region); any
   selection change clears the previous submit error.

## Application page

The vendor application page (`app/dashboard/applications/[id]`) has three
route tabs, controlled by the URL (shadcn `Tabs`, `role="tab"` links, not
plain links):

1. **Overview** — one state-aware card (the primary card), the compact
   customer install-link card when the card's own primary action is not the
   link and a live link exists, and at most one recent-event line. An
   application that has never had an eligible install link (still inside the
   setup lifecycle, no live link yet) gets no separate card at all — the
   primary card names the reason in one line near the lifecycle instead.
   When the readiness payload carries an `architecture` block, the page also
   shows the compact "Architecture detected" card: the detected components
   grouped by plan group, each marked Detected automatically, Confirmed or
   Needs input, with the grouped detail under a "View architecture"
   disclosure — an explanation of what Deployz detected, not an editor. The
   card is hidden when the block is absent, and the primary card's analysis
   and operation states win over it.
2. **Releases** — version history. Each release row shows an Infrastructure
   line: "No infrastructure changes", or the warning "This release requires
   infrastructure changes. Automatic infrastructure upgrades are not
   supported yet." The line reports the update plan's `infrastructureChange`;
   it adds no new gate. A failed release row offers "Review
   failure details": the stage, the earliest error the build log shows, who
   most likely has to act (repository, temporary, Deployz, or not
   determined), the relevant redacted log lines, and the actions View build
   logs, Copy technical details, Copy prompt for coding agent (an
   investigation prompt, never a claimed fix), Explain with AI (on demand),
   and — for a Deployz-side failure, instead of the prompt — Copy report for
   Deployz support. The buildspec's "The image build did not produce an
   image" is a final check and is never shown as the cause.
3. **Configuration** — four secondary tabs (shadcn `Tabs`, default
   variant, under the route tabs): Resources, Size presets, Variables,
   Settings. Resources opens by default. The selected tab is kept per
   application in `sessionStorage` (`deployz:config-tab:<id>`). A section
   anchor picks its tab: `#required-changes`, `#services` and
   `#config-row-*` open Resources; `#deployment-size` opens Size presets;
   `#environment-variables` and `#env-row-*` open Variables; `#settings`
   opens Settings. Selecting a tab removes the anchor, so the same link
   works again. Every panel stays mounted and is only hidden, so unsaved
   edits survive a tab switch and a switch loads nothing (no analysis, no
   plan or AWS request). A tab shows a count only for the existing
   attention counts: Resources counts the required findings plus the
   unresolved architecture questions; Variables counts `environmentSetup`
   needs-decision plus missing-value. Each setting has one place to edit
   it; other tabs only link to it.
   - **Resources** (`lib/configuration-inventory.ts`,
     `deriveServiceInventory`): one short attention line (`#required-changes`,
     focused when the URL has that hash) with the count and a link to the
     variables that need input, then one flat table: Resource ·
     Configuration · action. Groups are small labels: Application &
     runtime, Data services, Networking & HTTPS, External integrations
     (empty groups are omitted). Each issue badge sits beside its resource
     name and its text under the configuration; the row's action (Edit,
     Add, Fix, Get fix instructions) opens the existing EditDialog or
     FixInstructionsDialog. Runtime, build and start commands, port, health
     check, worker command and migrations are indented rows under their
     service; commands show in full and wrap. A muted line carries the
     row's estimate ("Est. AWS/month: …", "Price unavailable" for a planned
     row without a price, never $0) and "Kept after removal" where it
     applies. Each plan AWS resource sits once under the service that owns
     it (collapsed "Planned AWS resources (N)"); resources no service owns
     stay on a "Shared resources" row. Detected / Confirmed node states sit
     under Technical details, because nodes cannot be joined to plan rows
     yet (UX-BACKEND-007).
   - **Size presets**: the three published presets side by side, read-only
     (rows Compute, Workers, Database, Storage, Cache, Est. AWS cost; a row
     shows only when a size has a value). Each size's values and estimate
     come from that size's plan (`costEstimate`, "+ usage" when usage is
     excluded). The column header marks the saved Default and "Below
     minimum". Under a divider, two selects change the defaults: Default
     size (only sizes at or above the minimum) and Minimum allowed size
     ("Smallest size customers can select."; raising it raises the
     default). One Save writes both. Region, on-demand, 730 hours, USD and
     the excluded charges sit behind "Estimate details". Before a completed
     analysis the tab says when the presets show.
   - **Variables**: one table (Variable · When used · Who provides · Value ·
     Required · Secret · Status · Actions) for the detected variables and
     every other vendor default, in the groups Needs attention, Set by
     vendor, Set by customer, Managed by Deployz, Optional and uncertain.
     Filters: Vendor & customer (the default: Needs attention, Set by
     vendor, Set by customer), Needs input (with its count), Managed,
     Optional, All; a search matches variable names. New values always
     show. Filters only hide rows: edits on hidden rows are kept and saved.
     The table renders 50 rows at a time with "Show 50 more". Secrets are
     write-only and show only their state. Edit opens the existing editors
     in the row. One Save writes the decisions, then the values; a failed
     value write after saved decisions says so. Customer overrides stay a
     separate section in this tab, shown only with `?customer=`.
   - **Settings**: General (name, repository, default branch, Re-analyse)
     then, under a divider, the Danger zone with its existing typed
     confirmation. The header's "More actions" menu keeps Re-analyse too.

`lib/application-state.ts` (`deriveApplicationPresentation`) is the single
source of the page's state: badge, heading, message, actions, the setup
lifecycle, polling, the install-link presentation, and notices. No section
reads `analysisStatus`, a readiness finding, or a deployment `state` for
itself — extend the mapper when a case is missing, never add a second
derivation. Precedence: an active operation (analysis running, a test
deployment installing or removing) always wins over readiness data, because
readiness is only as new as the last analysis while the operation is
happening now.

- The primary card's heading is the page's only `aria-live` region.
- The setup lifecycle (Analyse → Configure → Test → Share) shows only before
  the first verified test deployment or customer deployment exists. After
  that it is `null` — never a completed stepper sitting on the page forever.
- Readiness copy never shows a passed-check count. It says "No blocking
  issues" or "N changes required" — the same rule as the Configuration
  table. It describes the analysis only.
- The header shows two badges: the application state ("Analysis complete"
  when the analysis passed and no test deployment exists) and, separately,
  release readiness ("Release ready", "Release building", "Release build
  failed", "No deployable release", "No release yet"). An older READY release
  keeps the application deployable when a newer build failed. With no
  deployable release, the primary card never offers "Start test deployment".
- The Configuration table's result vocabulary is Ready / Not used / Change
  required / Recommended / Needs review — never "Passed", never a percentage.
  Ready and Not used show no badge, because the value already says it. Its
  action names what it does ("Edit port", "Add health check", "Get fix
  instructions"): Add for an unset optional field and Edit once a value
  exists. Raw detection evidence (file + reason) lives only under the
  collapsed "Analysis details" disclosure, never in the table itself.
- Required findings and architecture questions show as issues on their
  Resources row and are counted once in the attention line and on the tab.
  External services (`architecture.externalServices`) are information,
  never an attention item: each is a row under External integrations,
  billed separately, linking to the Variables tab. Fix routes by
  `requiredChangeFix`: only `port-unresolved` opens a setting editor; every
  other finding needs a repository change and a new analysis, so it opens the
  fix instructions.
- Planned infrastructure comes from the plan's `footprint` through
  `footprintComponentRows` (`lib/footprint.ts`), generic over `service`/
  `category` — a new resource kind renders through the same rows with no
  page change. Services match footprint resources by category, not id.
- The install-link card shows one status badge, Copy link, Preview, and an
  overflow menu (copy HTML snippet, toggle enabled/disabled, regenerate,
  revoke) behind a visible "Manage" button. Regenerate and revoke both require confirmation. A live
  link stays visible in every state except the page's own `unavailable`/
  `unknown` states — it is never hidden or invalidated silently. On an
  application that is not ready to share, its warning states what a
  customer gets right now from the newest READY release (or that installs
  are refused when there is none), never a claim that a test must pass
  again.
- Configuration-required shows the required findings as plain-language
  labels (`requiredChangeLabel`) and one action, "Review required changes",
  linking to the Configuration tab's `#required-changes` anchor.
- Ready-to-share and customers-active name the release customers actually
  get (the newest READY release) when releases loaded successfully; a newer
  release that failed to build is called out as a separate notice, never
  implied to be what customers get. Releases that failed to load are never
  guessed at.
- Billing notices do not belong on this page.

## Overview (Home)

The homepage (`app/dashboard/page.tsx`) is titled "Overview"; the sidebar
item stays "Home". Its state comes from `lib/home-state.ts`
(`deriveHomeState`), which reads only the applications and deployments
lists. There is no deployment table, activity feed, chart or banner on it.

- **Onboarding** (no customer deployment yet): one checklist, Add
  application → Review configuration → Create deployment. A step is complete
  only when the data says so (configuration is complete only when the
  analysis is COMPLETE and READY). Only the current step shows a detail line
  and its one action; no header action competes with it. A ready application
  makes the current step "Create deployment"
  (`/dashboard/deployments/new?applicationId=…`).
- **Overview** (at least one deployment): the header carries "Create
  deployment". One compact summary card: Live · Need attention · Deploying ·
  Awaiting customer, each a count above a short label and a link to
  `/dashboard/deployments?status=healthy|attention|in-progress|waiting`. Each
  count is one status group of `lib/deployment-status-groups`, so it equals
  the rows of its filtered view. Only a nonzero Need attention count is red.
- **Next steps**: at most three rows, each one title and one link, most
  urgent first. Attention is one grouped row ("6 deployments need attention"
  → Review deployments). Customers that have not installed are one row,
  counted by customer ("1 customer hasn't completed setup" → View pending
  setups). An application task shows only when no application can be
  deployed and none is being analysed. Zero counts and normal in-progress
  deployments are never tasks.
- With no next steps, "Nothing needs your attention." "All deployments
  healthy" shows above it only when every deployment is live and reports
  HEALTHY; a live deployment without a health report is named as such,
  never called healthy. Attention counts current state only: a later
  successful attempt clears an earlier failure.
- Loading is a skeleton of the same layout under the real title; a failed
  load is the error state with Try again, never zero counts. When updates
  fail after a load, the last known state stays with "Updates unavailable",
  and the all-clear message is hidden.
- Refresh reuses `useStatusPoll`: 5 s only while an analysis runs or the
  organization's only deployment is being set up, otherwise 60 s.

## List views (Customers, Deployments)

The two lists answer different questions. Customers answers "which
relationships need attention?" with one row per customer. Deployments answers
"what is happening in each customer environment?" with one row per deployment.

- The status words come from `lib/deployment-status-groups`. That module holds
  the precise label of one deployment, the filter group of the status filter,
  the default sort rank, and the customer-level bucket the Customers summary
  counts. Do not classify a status anywhere else.
- The Customers summary is a projection of the customer's deployments. It is
  never a stored status.
- A state that the app does not know shows as "Unknown status" and counts as
  "Needs attention". It never shows a raw enum value.
- The "Live" status filter (`status=healthy`) also keeps live deployments that
  have an update available: their badge reads Live, and Overview counts them
  as Live. "Update available" stays a separate filter for that subset.
- The Deployments header action is "Create deployment". Invitation wording
  stays on the invitation itself (the create page and its submit button).
- Search, filters, and sort live in the URL query (`q`, `status` or `state`,
  `application`, `region`, `sort`, `dir`). Use `useListParams`. A default value
  leaves no trace in the URL. Back from a detail page restores the view.
- Search waits 250 ms before it writes to the URL (`ListSearchInput`). Filters
  and sort apply at once. "Clear filters" shows only when a filter is active.
- A list that has no rows because of a filter shows `NoMatchesState`. A list
  that is empty shows its own first-use state. Never mix the two.
- Region codes show with a friendly name (`lib/regions`). An unknown region
  shows its code.
- Tables choose their columns from their own width with container queries
  (`@container`, `@2xl:`, `@4xl:`), not from the viewport, because the sidebar
  changes the space that is available. A hidden column moves under the
  customer instead of disappearing.

## Plan-driven surfaces

Some pages show what will happen to infrastructure: the install page, the
disconnect dialog, and the deploy-update dialog. Each page shows the
`DeploymentPlan` that the API sends. The API builds this plan from the
deployment's manifest. The page does not build its own plan. The page does
not guess which resources exist. The page only shows the plan's data.

The Security Details page follows the same rule for IAM. It reads every IAM
action, resource and condition from the committed bootstrap template
(`packages/cdk/artifacts/bootstrap-template-v1.json`) through
`lib/bootstrap-permissions.ts`. Do not write IAM action lists in web code.

## Spec-derived components

Status payloads carry `specComponents` (componentId, label, state,
detail), derived from stack events through the spec's ownership records.
The customer install page's Resources summary and the vendor progress
card list components from `specComponents`; a payload without them falls
back to the legacy rendering byte-identically.

- The customer review ("What Deployz creates in your AWS account") groups under the
  plan groups (application, data, cache, storage, messaging, networking,
  edge, security). The fallback chain is component group → kind map →
  Application. Only non-empty groups render.
- A logicalId the ownership records do not know buckets as one `other`
  component with a neutral detail. Raw AWS resource types never appear
  on customer primary surfaces.
- The vendor diagnostic card names the affected component ("Affects:
  {label}") when the failure context carries a component; the raw
  componentId stays behind the technical disclosure.

## Multi-workload presentation

One deployment can run more than one workload: the web service, declared
background workers, and a one-shot migration task. The UI stays generic —
it renders whatever workload rows the plan's footprint carries, never a
hard-coded topology.

- Footprint rows are generic: every workload is one row sized from the
  plan's footprint (`footprintComponentRows` in `lib/footprint.ts`), and
  the install page's infrastructure table draws one row per workload
  under "Compute & Networking". A new workload kind renders through the
  same rows with no page change.
- Public versus internal: the web workload is the deployment's only
  public entry point. The architecture diagram emphasizes it behind the
  load balancer and draws every worker as internal; a worker row states
  its reach in plain words ("Processes background jobs — not reachable
  from the internet").
- Workers get no ingress affordances: no URL, no health-check or
  endpoint affordances, no HTTP status. A worker's status is its ECS
  service's own, shown through the same status vocabulary as every other
  component.
- Every rollback affordance carries the warning verbatim: "Application
  rollback does not automatically reverse database migrations."

## Typography

| Level | Classes |
| --- | --- |
| Page title | `text-2xl font-semibold tracking-tight` |
| Section title | `text-base font-semibold` |
| Body | `text-sm` |
| Secondary | `text-sm text-muted-foreground` |
| Metadata | `text-xs text-sm:text-muted-foreground` |

One `<h1>` per page.

## Page spacing

- Page root: `flex flex-col gap-6` (the shell already provides padding).
- Inside sections: `gap-2` / `gap-3` / `gap-4`.

## Destructive actions

- Use `AlertDialog` (destructive variant) for disconnect/remove flows.
- State actual consequences; avoid "Are you sure?".
- Keep the existing type-to-confirm pattern where present.

## Tables

- Use the shadcn `Table` primitives. Application-specific tables (e.g. the
  deployments table) may live as named components; no generic table
  abstraction.
- Wrap wide tables with `overflow-x-auto` for mobile.

## Loading

- Use `Spinner` (`components/ui/spinner.tsx`) for a user-triggered action.
  Show it inside the control that started the action (for example, the
  submit `Button`).
- Use `Skeleton` for initial data on a route or a section. Match the
  skeleton shape to the real layout. Set `aria-busy` on the loading
  container.
- Do not replace visible content with a skeleton during a background
  refresh or a poll. Keep the current content on screen and update it
  when new data arrives.
- Write specific loading text: a verb, an object, and "…". Examples:
  "Analyzing application…", "Saving configuration…". Do not use a generic
  "Loading…" when the operation is known.
- Accessibility: set `aria-hidden` on the `Spinner` when adjacent text
  already states the operation. Set `aria-busy` on the control or the
  container. Keep the text readable during the load. Do not show status
  by color alone. Keep focus on the control that started the action. The
  `animate-spin` rule slows under `prefers-reduced-motion: reduce`, but it
  does not stop, so the spinner still shows activity.
- `Button` example:
  `<Button loading={pending} loadingText="Saving configuration…">Save</Button>`.
  For a native control that is not a `Button`, add `<Spinner aria-hidden />`
  next to it, and set `disabled` and `aria-busy` on the control.
- Multi-action forms: track which action is pending. Show the spinner only
  on that action's control. Disable the other actions while one is
  pending.
- Error recovery: clear the loading state in a `finally` block. Show an
  actionable failure in an inline `Alert`. Use a toast only for a
  short-lived success message.
- Long-running server work: end the button's loading state when the
  server accepts the request. Hand off to the existing status or
  progress UI for the rest of the operation.
- Anti-patterns: a full-screen blocking overlay, a global loading store, a
  generic "Loading…" label, a spinner that hides an error, an artificial
  delay, or two buttons spinning at the same time.

## Feedback

- Short-lived operation feedback: Sonner toast (`toast.success(...)` etc.).
- Persistent or actionable failures: inline `Alert`. Important deployment
  failures are never toast-only.
- For in-progress states, see Loading above.

## Responsive expectations

- Desktop: full sidebar, compact operational content.
- Tablet: collapsible sidebar.
- Mobile: shadcn Sidebar mobile behavior, stacked actions, responsive
  dialogs/sheets, horizontal table scrolling. Essential actions stay visible.

## Guardrails

- ESLint checks (root `eslint.config.mjs`) reject new arbitrary Tailwind
  palette colors and known raw CloudFormation statuses in customer-facing
  `apps/web/src` code.
- Visual regression: `e2e/visual.spec.ts` covers canonical pages; run
  `pnpm e2e e2e/visual.spec.ts` after UI changes. The committed snapshots
  are Windows-only — generate and compare them on Windows.
