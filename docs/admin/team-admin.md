# Team Admin

Team Admin is an operational support and recovery console for the Deployz
team. New features should only be added when they materially improve
diagnosis, support, or safe recovery. Do not grow it into a generic
back-office application.

Every Team Admin feature must help answer one of three questions:

1. What failed?
2. Why did it fail?
3. How can the Deployz team safely recover it?

## MVP scope

- Overview — items that need attention (failed/unhealthy deployments,
  stuck jobs, disconnected relays, in-progress installs), plus the small
  **Pilot Insights** section (see below).
- Vendors — cross-tenant vendor list and a support-oriented 360° detail.
- Deployments — the primary admin command center (status, progress,
  resource inventory, release history, relay/AWS state, related jobs).
- Jobs — global async-work view with a centralized STUCK definition.
- AWS Connections — relay/bootstrap connectivity per installed deployment.
- Audit Log — append-only record of privileged admin activity.
- Global search — resolve common identifiers to admin detail pages.
- View as Vendor — restricted, audited, read-only support impersonation.
- Safe recovery actions — thin wrappers over existing domain workflows.

Explicitly out of scope: separate admin modules for applications, releases,
billing, feature flags, platform health, tickets, CRM, system configuration,
complex RBAC, arbitrary DB editing, and arbitrary AWS/CloudFormation
operations. Application/release/activity details appear contextually inside
Vendor and Deployment views.

## Route structure

Web (`apps/web/src/app/admin/**`, own shell, separate from the vendor
dashboard):

- `/admin` — Overview
- `/admin/vendors`, `/admin/vendors/[id]`
- `/admin/deployments`, `/admin/deployments/[id]`
- `/admin/jobs`, `/admin/jobs/[id]`
- `/admin/connections`, `/admin/connections/[id]` (id = deployment id)
- `/admin/audit-log`
- `/admin/search?q=…`

API (`apps/api/src/admin/routes.ts`, registered from `buildServer`):

- `GET /api/admin/overview`
- `GET /api/admin/vendors`, `GET /api/admin/vendors/:id`
- `GET /api/admin/deployments`, `GET /api/admin/deployments/:id`
- `GET /api/admin/jobs`, `GET /api/admin/jobs/:id`
- `GET /api/admin/connections`, `GET /api/admin/connections/:id`
- `GET /api/admin/search?q=…`
- `GET /api/admin/audit-log`
- `POST /api/admin/vendors/:id/support-session`,
  `DELETE /api/admin/support-session`
- Recovery and billing actions (see below) under
  `/api/admin/deployments/:id/…` and `/api/admin/vendors/:id/…`
  (`apps/api/src/admin/routes.ts` is the authoritative list).

## Authorization model

- Platform staff are marked with `user.platform_role = 'ADMIN'`
  (nullable text column on the Better Auth `user` table; there is no
  role-management UI — grant via SQL/ops tooling).
- `TEAM_ADMIN_EMAILS` (comma-separated; exact emails or `*@domain`
  wildcards) additionally grants admin **outside the deployed Lambda
  only** (ignored when `AWS_LAMBDA_FUNCTION_NAME` is set). It exists for
  local dev and the E2E suite; production grants use the DB column, so an
  unverified sign-up can never self-escalate in production.
- Every `/api/admin/*` route uses a `requireTeamAdmin` preHandler
  (session auth via the existing `requireAuth`, then the platform-role
  check). Non-admins receive 403 `NOT_TEAM_ADMIN`.
- Admin read models are cross-tenant by design and therefore never use the
  session organization for scoping; they must only ever be reachable behind
  `requireTeamAdmin`.
- The web `/admin` area is guarded twice, matching the dashboard pattern:
  optimistic session-cookie check in `middleware.ts`, authoritative
  `fetchMe()` check (`isTeamAdmin`) in `app/admin/layout.tsx` with a
  redirect to `/dashboard` for non-admins. Navigation visibility is never
  the security boundary.

## View as Vendor security model

- Entering: `POST /api/admin/vendors/:id/support-session` sets
  `session.support_organization_id` on the **admin's own** Better Auth
  session row. The vendor's credentials, sessions, and browser are never
  touched, and the admin's identity (`request.user`) is preserved
  server-side throughout.
- While set (and only for users who still pass the platform-admin check),
  `requireAuth` resolves `request.organization` to the support target with
  a synthetic lowest-privilege `member` role and marks the request
  `supportMode`. A `support_organization_id` on a non-admin's session is
  ignored.
- Read-only enforcement is central and server-side: in support mode every
  non-GET/HEAD/OPTIONS request outside `/api/admin/*` is rejected with
  403 `SUPPORT_MODE_READ_ONLY`. No vendor-facing write is classified safe
  in the MVP.
- Exiting: `DELETE /api/admin/support-session` clears the column.
- Both start and end write audit events
  (`admin.support_session.started` / `admin.support_session.ended`).
- The vendor dashboard shows a persistent banner
  ("Viewing as <Vendor> — Admin support mode") with an obvious exit
  control whenever `/api/me` reports `supportMode`.

## Supported admin actions

Read-only diagnosis everywhere, plus these recovery actions — each invokes
the existing domain workflow (never direct state mutation), requires a
human-entered reason for risky operations, and writes an audit event:

- Retry failed install — same guarded flow as the vendor
  `retry-install` route (`admin.install.retry_requested`).
- Rollback to a previous still-READY release — same flow as the vendor
  rollback route; requires a reason (`admin.rollback.requested`).
- Force-complete a destroy stuck on a permanently offline relay — same
  guarded flow as the vendor `disconnect/force-complete` route; requires a
  reason (`admin.destroy.force_completed`).
- Reset relay enrollment — same flow as the vendor `relay/reset` route;
  requires a reason (`admin.relay.reset_requested`).
- Reconcile billing — runs the same `reconcileBilling` the lifecycle hooks
  and the safety job run; reason optional (`admin.billing.reconcile_requested`).
- Set the included production deployment allowance — the ONE commercial
  override Team Admin can make (`docs/billing/polar-billing.md`,
  "Included production deployments"). `POST
  /api/admin/vendors/:id/included-deployments` with an integer 0..10000 and
  a required reason; the vendor detail previews the billable quantity
  before and after and warns when a decrease may increase the invoice. A
  real change on a subscribed organization runs `reconcileBilling`; a Polar
  failure never reverts the value (`admin.billing.included_deployments.updated`).
  No vendor route can write it, and support mode is read-only.

Not provided, deliberately: deployment state editor, raw SQL/data editing,
arbitrary CloudFormation execution, generic AWS resource deletion, hidden
force flags, custom prices, discounts, coupons, or any other billing
override beyond the included-deployment allowance.

## Audit requirements

- Admin actions are recorded in the existing append-only `event_logs`
  table (immutable via DB trigger) with `actorType: 'user'`, the admin's
  user id as `actorId`, an `admin.*` event type, the target vendor's
  `organizationId`, and a payload carrying the admin's email, the entered
  reason where required, and outcome metadata.
- The Audit Log page lists `admin.*` events with actor/action/target/date
  filters. Audit records are never editable from the UI (or anywhere —
  the table trigger rejects UPDATE/DELETE).

## STUCK jobs

`STUCK` = a job in an active state (`REQUESTED/QUEUED/WAITING/RUNNING`)
whose last progress signal (`lastProgressAt ?? startedAt ?? createdAt`) is
older than its type's timeout. The per-type timeouts are the single
`JOB_TIMEOUTS_MS` map in `@deployz/contracts` — the same map the worker's
`sweepStuckJobs` enforces — so the admin view and the sweeper can never
disagree.

## Pilot Insights

The Overview carries a small **Pilot Insights** section: a pilot funnel,
deployment quality, common deterministic failures, invitation funnel, and
the support-intervention signal, over a trailing 7/30/90-day window
(`GET /api/admin/overview?days=…` returns the `pilotInsights` block). It
exists so the Deployz team can answer whether a vendor can reach HEALTHY
without intervention, and where pilots get stuck — it is pilot-readiness
support, not an analytics product. Funnel and metric definitions, privacy
rules, and known limitations live in `docs/product-telemetry.md`.

Team Admin is still not a generic analytics or back-office platform: no
dashboards beyond this section, no engagement metrics, no cohort/retention
views, and no customer-visible telemetry.

## Evaluating new admin functionality

Before adding anything to Team Admin, ask:

1. Does it materially improve diagnosis, support, or safe recovery?
2. Does an existing domain workflow already implement the mutation? Wrap
   it; never mutate state directly from admin code.
3. Is it auditable? Privileged mutations must write an `admin.*` event.
4. Does it keep raw AWS jargon behind "Technical details"?

If any answer is no, it does not belong in Team Admin.

## Testing

Unit/integration coverage lives in `apps/api/src/admin/*.test.ts`
(PGlite + `buildServer` + `app.inject`, per house pattern) and
`apps/web/test/admin-*.test.ts` (vocabulary/lib tests). Browser coverage
lives in `e2e/admin.spec.ts`; the E2E servers set `TEAM_ADMIN_EMAILS` to a
test wildcard so specs can mint admin accounts. See
`docs/testing/README.md` for the wider policy.
