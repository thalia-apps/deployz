# Paddle billing — how it works

The reference for Deployz billing after the Stripe → Paddle migration
(September 2026). The decision tables are in `billing-matrix.md` and the
catalog in `paddle-catalog.md`. This document is the shape of the system as
shipped.

## The commercial model

- **Evaluation is free and never expires.** Signup, analysis, configuration,
  AI recommendations, customer records, release builds, and ONE active test
  deployment of the vendor's own app per application. No card, no clock.
- **$49/month platform** starts with the vendor's first *customer*
  deployment — the moment they ask Deployz to run their app for someone else.
- **$19/month per customer deployment, while it serves the customer** —
  billed from the first verified READY stage, paused while the deployment is
  failed or its connector is disconnected, resumed when it serves again, and
  stopped the moment removal is accepted.
- **Payment state never touches running customer infrastructure.** A vendor
  whose card fails, or who cancels, keeps every existing deployment operable:
  deploy, rollback, restart, configure, destroy. Only *new* customer
  deployments are withheld.

Deployz displays prices but does no money math. Paddle owns charges, tax,
proration, invoices, cards and cancellation. Deployz owns eligibility and
exactly one number: how many customer deployments are live beyond the
organization's included allowance (see "Included production deployments").

## Division of responsibility

| Deployz owns | Paddle owns |
|---|---|
| Whether a deployment may be created (entitlements) | Charging the card |
| `billing_state` per deployment (NOT_STARTED / ACTIVE / PAUSED / STOPPED) | Proration when the count changes mid-cycle |
| The billable deployment quantity pushed as an absolute number: `max(live − included, 0)` | Invoices, receipts, tax |
| The included production deployment allowance (admin-set, per organization) | Nothing — Paddle never learns it exists |
| The checkout intent (a parked request, never a deployment) | The checkout overlay and the card form |
| Subscription status as projected from webhooks | Dunning, past-due, pause/resume, cancel |
| The customer portal *link* | The customer portal |

## Data

Four tables (`packages/db/src/schema/billing.ts`), two columns on
`deployments`, and one on `organization`:

- `organization.included_production_deployments` — integer, NOT NULL,
  default 0, CHECK 0..10000 (migration 0038). The admin-set allowance; see
  "Included production deployments" below. Written only by the Team Admin
  route.

- `deployments.deployment_type` (TEST / PRODUCTION) and
  `deployments.billing_state` with `billing_started_at` / `billing_stopped_at`.
  `PAUSED` (migration 0053) marks a deployment that was live and does not
  serve the customer now. Test deployments never bill from any state
  (matrix §1).
- `billing_subscriptions` — one row per organization, `provider = PADDLE`.
  No row means evaluation. Status ∈ ACTIVE / PAST_DUE / PAUSED / CANCELED.
- `billing_provider_events` — every webhook delivery, `provider_event_id`
  unique so redelivery dedupes at the database.
- `billing_reconciliation_events` — what Deployz expected vs what Paddle had,
  and what was done about it. No row for a no-op pass.
- `billing_checkout_intents` — a production deployment request parked until
  its subscription activates. At most one PENDING per organization.

## The lifecycle, end to end

### 1. First customer deployment → checkout (Phase 8)

`POST /api/deployments` with `deploymentType: PRODUCTION` and no ACTIVE
subscription answers **402 `SUBSCRIPTION_REQUIRED`** with the status in
`details`. Nothing is written. The web app then calls
`POST /api/billing/checkout`, which:

1. Refuses ACTIVE (409 — create the deployment directly), and PAST_DUE /
   PAUSED (409 `SUBSCRIPTION_NEEDS_ATTENTION` — the fix is on the portal, not
   a second subscription). Only evaluation and CANCELED may check out.
2. Runs the same ownership and preflight gates as deployment creation, so a
   completed checkout cannot land on a request that would never have worked.
3. Parks the request as a `billing_checkout_intents` row and creates ONE
   Paddle transaction for the **platform price only** — the parked
   deployment is not live, so the $19 item is not on it. The intent id
   travels in the transaction's `customData`.
4. Returns the transaction id; the web app opens Paddle's overlay
   (`@paddle/paddle-js`, client token fetched at runtime from
   `GET /api/billing/config` — nothing Paddle-specific is baked into the
   build).

A second click reuses the intent and its transaction. A PENDING intent older
than 24 h expires.

### 2. Activation → the deployment appears (Phases 6, 8)

Paddle posts `subscription.created` / `subscription.activated` to
`POST /api/billing/webhook`, signature-verified over the raw body. The
handler upserts `billing_subscriptions` (regression- and mismatch-guarded),
then completes the intent the event names through the echoed `customData`:
the deployment insert and the intent's completion run in one transaction
guarded by `WHERE status = 'PENDING'`, so a redelivered event can never
create two deployments. Only now does a deployment row — and therefore an
install link — exist.

A checkout can be opened in the browser with client-chosen `customData`, so
the handler trusts `customData.organizationId` for a new
`subscription.created` / `subscription.activated` only when `customData.checkoutIntentId`
names that organization's PENDING intent (and, when the event carries a
transaction id, that intent's transaction). Otherwise the event falls back to
the subscription-id lookup and is IGNORED (`organization not found`) when no
row exists.

### 3. Going live → billing starts (Phases 2, 9)

`billing_state` moves NOT_STARTED → ACTIVE on the first observed READY stage
(`markDeploymentLive`, from the relay write paths). That write returning
`true` triggers `reconcileBilling`, which reads the live count and the
organization's included allowance and pushes `max(live − included, 0)` to
Paddle as an **absolute** quantity on the per-deployment item —
`prorated_immediately`, `on_payment_failure: apply_change`. Never a delta:
running it twice yields the same subscription as once.

### 4. Not serving → billing pauses; serving again → it resumes

A production deployment is billed only while it serves the customer.

- **Pause:** ACTIVE → PAUSED when the deployment is `FAILED` (nothing runs
  for the customer) or its connector is `DISCONNECTED`. The safety job
  (step 5) makes this decision on its 15-minute pass, from persisted
  columns only. `relayStatus` becomes `DISCONNECTED` only after
  `RELAY_STALE_AFTER_MS` (15 minutes) without a check-in, so a short
  heartbeat gap never changes the Paddle quantity.
- **Resume:** PAUSED → ACTIVE at the next verified READY stage on the relay
  write paths (the same hook that starts billing), or on the next safety-job
  pass when the connector is `CONNECTED` and the deployment is `HEALTHY` or
  `UPDATE_AVAILABLE`. `billing_started_at` is not rewritten.
- **Not paused:** a failed update over a running release. The deployment
  returns to `HEALTHY` / `UPDATE_AVAILABLE` because the previous release
  still serves (`docs/deployment-resilience.md`), so it stays billed. Runtime
  health (`healthStatus`) alone does not pause billing.
- **Never billed:** a production deployment that never went live stays
  NOT_STARTED, also when its first install fails.

Each pause and resume writes `deployment.billing_paused` or
`deployment.billing_resumed` to `event_logs`, with the deployment `state` and
`relayStatus` that caused it, and reconciles the organization.
`servingBillingEvent` and `syncServingBilling`
(`apps/api/src/billing-domain.ts`, `billing-lifecycle.ts`) are the only
implementation.

### 5. Removal → billing stops (Phases 2, 9)

ACTIVE or PAUSED → STOPPED when removal is *accepted* (the destroy request),
with idempotent backstops at DESTROY success and force-complete. STOPPED is
terminal. Reconcile runs again; when the last live deployment goes, the item
is removed rather than set to zero (its minimum quantity is 1).

### 6. The safety net (Phase 10)

Every request-path billing write is best-effort — a Paddle failure never
fails a deployment. `sweepBilling`, on the worker's existing 15-minute
schedule, closes the gaps that leaves: promotes a READY production deployment
still NOT_STARTED (signal: the persisted `step_timings.READY`), pauses and
resumes live deployments with their serving state (step 4), releases
webhook rows abandoned in RECEIVED so Paddle's redelivery is processed, and
reconciles any ACTIVE/PAST_DUE subscription not checked for an hour.

### 7. Paying, managing, lapsing (Phases 11–14)

- Two app-wide banners, and only two: PAST_DUE (deep-links to Paddle's card
  form) and CANCELED. Evaluation gets none.
- The billing page tells the truth: evaluation reads as free; subscribed
  shows the rate, next billing date, per-customer breakdown, and "Manage
  billing" into Paddle's hosted portal via a short-lived session for the
  organization's own customer id.
- Entitlements by status: matrix §4. Existing deployments are never gated.
- The billing page shows `N active · P paused · M included · K billed`;
  the paused count shows only when it is not zero.
- Admins see live count, subscription, last reconciled, recent outcomes, and
  can run the same `reconcileBilling` on demand, audited.

## Included production deployments

An organization-scoped, admin-controlled allowance: the number of live
production deployments the organization may run before the per-deployment
charge applies.

### Business rule

```
billableDeploymentQuantity =
  max(active production billing deployments − included production deployments, 0)
```

where "active production billing deployments" is `count(deployment_type =
PRODUCTION AND billing_state = ACTIVE)` (`billing-matrix.md` §2). A PAUSED
deployment is not in the count, so it does not use the allowance. `billableDeploymentQuantity` /
`productionDeploymentCounts` in `apps/api/src/billing-domain.ts` are the
only implementation; `reconcileBilling`, `GET /api/billing/summary` and the
admin vendor detail all read them.

### Entitlement semantics

Included production deployments are:

- organization-wide — one value on the `organization` row, pooled across
  every application and every customer of that organization;
- a concurrent allowance, not consumable credits — three included means
  three live at a time, forever, not three lifetime deployments;
- not per application, not per customer, and never attached to a specific
  deployment: no deployment row carries an "is free" flag;
- separate from the vendor's own test deployment, which is free from any
  state and never counts toward the total;
- no waiver of the $49/month platform subscription — the first production
  deployment still activates it, the allowance only affects the $19 item.

Default 0, so every organization bills exactly as before until a Team
Admin sets a value. The value exists before any subscription does, and it
survives cancellation and reactivation, ownership transfer and membership
changes.

### Paddle rule

Paddle receives only the final billable quantity, as an absolute number.
When it is 0 the deployment item is removed (never a $0 price, never a
quantity-0 item); the platform item is untouched. Paddle never learns the
allowance exists: no coupons, discounts, custom prices, $0 prices, per-vendor
products or per-deployment items are created for it.

### Admin rule

Only a Team Admin can change it, through `POST
/api/admin/vendors/:id/included-deployments` (`docs/admin/team-admin.md`).
Every change:

- requires a human-entered reason;
- is written with the organization row locked, so concurrent changes audit
  the true previous value;
- is audited in the immutable `event_logs` as
  `admin.billing.included_deployments.updated` with the old and new
  allowance, the active count, the old and new billable quantity, the reason,
  and the reconciliation outcome;
- runs the canonical `reconcileBilling` immediately when the organization has
  a subscription — never a duplicate of the Paddle update logic;
- keeps the new allowance if Paddle fails: the reconciliation ledger records
  the drift, and the admin Reconcile action or the 15-minute safety job
  repairs it.

The vendor detail previews included and billable quantities before and
after, and a decrease warns that the next invoice may increase.

### What the vendor sees

The Billing page shows the pool — `N active · P paused · M included · K billed × $19` —
and never labels an individual deployment free or paid. The create page says
whether the next production deployment is covered or is the first billed one,
and that the platform subscription still starts with the first one. A live
production deployment's detail reads "Counts toward your production
deployment total" (a paused one reads "Billing paused — not counted while it
is failed or disconnected"), and the disconnect dialog says the count goes down and
billing adjusts if the billable quantity changes. Customer-facing install and
deploy-link pages never show any of it.

### Explicitly out of scope

Not built, deliberately: custom platform prices, free platform months,
percentage discounts, Paddle coupons or promo codes, expiry dates, per-app or
per-customer allowances, consumable credits, volume tiers, custom contracts,
arbitrary price overrides. The allowance is one integer per organization and
nothing more.

## Configuration

Six values, all supplied by `.github/workflows/deploy-api.yml` (and the CDK
allowlist): five repository secrets — `PADDLE_API_KEY`,
`PADDLE_WEBHOOK_SECRET`, `PADDLE_CLIENT_TOKEN`, `PADDLE_PRICE_PLATFORM`,
`PADDLE_PRICE_DEPLOYMENT` — and the repository variable
`PADDLE_ENVIRONMENT`. Billing is optional at boot: with no API key every
billing surface reports `BILLING_DISABLED` and nothing else is affected.
Once the key is set the other five are validated at startup. Price ids are
configuration, never source — `paddle-catalog.md`.

The worker Lambda receives the same six values, so the safety job needs no
separate configuration.

Two operational switches live beside them as repository *variables*:

- `PADDLE_ENVIRONMENT` defaults to `sandbox`; production activation is an
  operator step (create the production catalog per `paddle-catalog.md`, set
  the five secrets, switch the variable). The repository does not record
  whether production billing is switched on; check the variable.
- `BILLING_ENFORCEMENT=off` pauses the PRODUCTION-deployment subscription
  gate platform-wide, for an incident where Paddle state is wrong or
  unreachable and customers must not be blocked. Unset (the normal state)
  enforces. Nothing else changes: webhooks, checkout, reconciliation and
  the allowance counters keep running (`apps/api/src/env.ts`,
  `billing-entitlements.ts`).

With no Paddle key, checkout answers `503 BILLING_DISABLED` and creating a
PRODUCTION deployment is refused with `402` unless enforcement is paused.
TEST deployments are never gated.

## What was deliberately not built

- No trials, discounts, annual prices, tiers, or metering. The one
  commercial override is the included production deployment allowance
  above — an integer per organization, never a price.
- No billing screens of Deployz's own for cards, invoices or cancellation.
- No second subscription is ever sold: PAST_DUE and PAUSED cannot check out.
- No provider abstraction: `provider = PADDLE` says what a row is, nothing
  more.
- No day-2 gating by payment state, CANCELED included — accepted cost: a
  canceled vendor can keep operating deployments they no longer pay for,
  because the alternative punishes their customers.

## Verification status

The lifecycle, webhooks, checkout, portal, reconciliation and the allowance
were verified end to end against the Paddle **sandbox** on 2026-09-08 (see
the PR history for the run log). Production Paddle has not been verified
from this repository: `PADDLE_ENVIRONMENT` defaults to `sandbox` and no
production price ids are recorded in `paddle-catalog.md`. Treat billing
as sandbox-verified, production-unconfirmed until an operator records
otherwise.
