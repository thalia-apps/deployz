# Polar billing — how it works

The reference for Deployz billing. Billing moved from Paddle to Polar in
November 2026 (`docs/decisions/README.md`). The decision tables are in
`billing-matrix.md` and the catalog in `polar-catalog.md`. This document is
the shape of the system as shipped.

## The commercial model

- **Evaluation is free and never expires.** Signup, analysis, configuration,
  AI recommendations, customer records, release builds, and ONE active test
  deployment of the vendor's own app per application. No card, no clock.
- **$68/month minimum** starts when the vendor subscribes: the $49/month
  platform fee plus one $19 unit. The first customer deployment uses that
  unit.
- **$19/month per customer deployment, while it serves the customer** —
  billed from the first verified READY stage, paused while the deployment is
  failed or its connector is disconnected, resumed when it serves again, and
  stopped the moment removal is accepted. A subscription always bills at
  least one unit, also when no deployment serves.
- **Payment state never touches running customer infrastructure.** A vendor
  whose card fails, or who cancels, keeps every existing deployment operable:
  deploy, rollback, restart, configure, destroy. Only *new* customer
  deployments are withheld.

Deployz displays prices but does no money math. Polar is the merchant of
record: it owns charges, tax, proration, invoices, cards and cancellation.
Deployz owns eligibility and exactly one number: the unit count,
`max(live − included, 1)` (see "Included production deployments").

## Division of responsibility

| Deployz owns | Polar owns |
|---|---|
| Whether a deployment may be created (entitlements) | Charging the card |
| `billing_state` per deployment (NOT_STARTED / ACTIVE / PAUSED / STOPPED) | Proration when the unit count changes mid-period |
| The unit count pushed as an absolute number: `max(live − included, 1)` | Invoices, receipts, tax |
| The included production deployment allowance (admin-set, per organization) | Nothing — Polar never learns it exists |
| The checkout intent (a parked request, never a deployment) | The hosted checkout page and the card form |
| Subscription status as projected from webhooks | Dunning, past-due, cancel |
| The customer portal *link* | The customer portal |
| A read-only view of the next renewal, payment method and invoices | The numbers in that view, read live on every request |

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
- `billing_subscriptions` — one row per organization. `provider` is `POLAR`
  (`PADDLE` rows are history, CANCELED by migration 0060). No row means
  evaluation. Status ∈ ACTIVE / PAST_DUE / PAUSED / CANCELED.
- `billing_provider_events` — every webhook delivery, keyed by the
  `webhook-id` header in `provider_event_id` (unique, so redelivery dedupes
  at the database).
- `billing_reconciliation_events` — what Deployz expected vs what Polar had,
  and what was done about it. No row for a no-op pass.
- `billing_checkout_intents` — a production deployment request parked until
  its subscription activates. At most one PENDING per organization.
  `provider_transaction_id` holds the Polar checkout id.

## The lifecycle, end to end

### 1. Subscribing → checkout

`POST /api/deployments` with `deploymentType: PRODUCTION` and no ACTIVE
subscription answers **402 `SUBSCRIPTION_REQUIRED`** with the status in
`details`. Nothing is written. The web app starts the subscription with
`POST /api/billing/checkout`, which:

1. Refuses ACTIVE (409 — create the deployment directly), and PAST_DUE /
   PAUSED (409 `SUBSCRIPTION_NEEDS_ATTENTION` — the fix is on the portal, not
   a second subscription). Only evaluation and CANCELED may check out.
2. Runs the same ownership and preflight gates as deployment creation when
   the request parks a deployment, so a completed checkout cannot land on a
   request that would never have worked.
3. Parks the request as a `billing_checkout_intents` row and creates ONE
   Polar checkout for the product (`POLAR_PRODUCT_ID`) at **one unit**
   ($68), with the organization id as the external customer id, discounts
   and trials off. The success URL is the dashboard page that started it
   (`returnPath`, a `/dashboard/...` path on `WEB_URL`) with
   `?checkout=complete`.
4. Returns the checkout URL. The web app sends the browser there; no card
   details reach Deployz.

A second click reuses the intent and its checkout while the checkout is
open. A checkout already paid answers 409 `CHECKOUT_ALREADY_PAID` (its
webhook is on the way); an expired one is replaced on the same intent.
Concurrent calls for one organization are serialized by a
transaction-scoped advisory lock. A PENDING intent older than 24 h expires.

Back on the page, the web app waits up to 30 seconds for the subscription to
read ACTIVE, then refreshes. The return URL is never proof of payment.

### 2. Activation → the deployment appears

Polar posts `subscription.*` events to `POST /api/billing/webhook`,
signature-verified (Standard Webhooks: `webhook-id`, `webhook-timestamp`,
`webhook-signature`; five-minute tolerance) over the raw body. The handler
upserts `billing_subscriptions` (regression- and mismatch-guarded), then
completes the intent whose checkout created the subscription: the
deployment insert and the intent's completion run in one transaction
guarded by `WHERE status = 'PENDING'`, so a redelivered event can never
create two deployments. Only now does a deployment row — and therefore an
install link — exist.

A subscription already on file always follows the organization on file. A
subscription not yet on file is bound only when its `checkout_id` is the
checkout of an organization's intent and its product is
`POLAR_PRODUCT_ID`. Only Deployz creates those checkouts, with its server
token, so client-chosen metadata can never bind a subscription to another
organization. The intent's status does not matter: a subscription paid
through Deployz's own checkout is never dropped because its intent expired
meanwhile; only a PENDING intent goes on to create its parked deployment.
Otherwise the event is IGNORED (`organization not found`).

### 3. Going live → billing starts

`billing_state` moves NOT_STARTED → ACTIVE on the first observed READY stage
(`markDeploymentLive`, from the relay write paths). That write returning
`true` triggers `reconcileBilling`, which reads the live count and the
organization's included allowance and sets the subscription's `units` to
`max(live − included, 1)`. Never a delta: running it twice yields the same
subscription as once. The first live deployment changes nothing: the
checkout already bought one unit.

#### Proration: billed now, never left pending

A unit change is billed at once (`proration_behavior: invoice`): a
deployment that goes live mid-period is charged for the rest of the
period on a new order, and one that stops is credited the same way. This
is what Paddle did (`prorated_immediately`) and what Stripe recommends for
quantity changes that must be collected (`always_invoice`).

The reason is cancellation. Polar puts a deferred (`prorate`) difference on
the next renewal invoice, but a subscription canceled before its renewal
has no next invoice: Polar creates no further orders after cancellation,
so a deferred charge would never be collected. Charging at once leaves
nothing pending.

Two exceptions keep a running deployment billed without hammering a card:

- **Card declined (402 `PaymentFailed`):** Polar refuses an `invoice`
  change whose payment fails. Reconcile then applies the same change with
  `prorate`, so the difference is billed at renewal, and records
  "payment failed; the difference is billed at renewal" on the ledger row.
- **PAST_DUE subscription:** reconcile uses `prorate` straight away, so the
  failing card is not charged again on every safety-job pass; Polar's own
  dunning collects the renewal.

Only these two paths can leave a difference pending. If such a subscription
is then canceled before its renewal, that difference is not collected — an
accepted, bounded loss (at most one period of the affected units).

#### A subscription set to end

When the vendor cancels on the portal, the subscription stays ACTIVE until
the period ends (`scheduledChangeAction = cancel`). Polar refuses any unit
change on it (403 `AlreadyCanceledSubscription`), so:

- new customer deployments are refused (402 `SUBSCRIPTION_REQUIRED`,
  "Your subscription is set to end. Resume it in the billing portal...",
  with `cancelAt` in `details`) — otherwise they would run unbilled;
- reconcile skips the subscription (SKIPPED, "cancellation scheduled", no
  Polar call, `lastReconciledAt` stamped so the safety job does not retry
  it every pass);
- existing deployments keep running and stay operable, as always.

Resuming on the portal (`subscription.uncanceled`) clears the schedule; the
webhook reconciles at once and bills any change since, as above.

### 4. Not serving → billing pauses; serving again → it resumes

A production deployment is billed only while it serves the customer.

- **Pause:** ACTIVE → PAUSED when the deployment is `FAILED` (nothing runs
  for the customer) or its connector is `DISCONNECTED`. The safety job
  (step 5) makes this decision on its 15-minute pass, from persisted
  columns only. `relayStatus` becomes `DISCONNECTED` only after
  `RELAY_STALE_AFTER_MS` (15 minutes) without a check-in, so a short
  heartbeat gap never changes the unit count.
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

### 5. Removal → billing stops

ACTIVE or PAUSED → STOPPED when removal is *accepted* (the destroy request),
with idempotent backstops at DESTROY success and force-complete. STOPPED is
terminal. Reconcile runs again; the unit count never goes under one.

### 6. The safety net

Every request-path billing write is best-effort — a Polar failure never
fails a deployment. `sweepBilling`, on the worker's existing 15-minute
schedule, closes the gaps that leaves: promotes a READY production deployment
still NOT_STARTED (signal: the persisted `step_timings.READY`), pauses and
resumes live deployments with their serving state (step 4), releases
webhook rows abandoned in RECEIVED so Polar's redelivery is processed, and
reconciles any ACTIVE/PAST_DUE subscription not checked for an hour.

### 7. Paying, managing, lapsing

- Two app-wide banners, and only two: PAST_DUE (links to the billing portal)
  and CANCELED. Evaluation gets none.
- The billing page is driven by the subscription status. Its Plan card says
  where the organization stands and carries the one action that state needs:
  evaluation shows what is free, the price ($68 today, including the first
  customer deployment) and "Start subscription"; CANCELED shows "Restart
  subscription"; PAST_DUE leads with the portal; PAUSED with the portal;
  ACTIVE shows the next renewal, the payment method and the portal links.
  Only an owner or admin sees these actions; with billing disabled the page
  says subscriptions are not available. Below the Plan card: the
  per-customer breakdown (before tax), then the invoices.
- Polar's portal has one entry page with the card form, the invoices and the
  cancel action, so every portal button opens it through a short-lived
  customer session for the organization's own Polar customer id.
- Every Polar page — checkout, portal, invoice PDF — opens in a new tab, so
  the vendor keeps their place in Deployz. The tab opens during the click
  and is pointed at the URL once the API has minted it, without an opener; a
  browser that blocks it gets the page in the same tab. While the vendor
  pays in the checkout tab, the billing page waits up to 15 minutes for the
  subscription to read ACTIVE and then refreshes.
- For an owner or admin, the subscribed page also shows what Polar holds,
  read live and never stored: the next renewal (date and recurring amount
  before tax; prorated adjustments and tax are added by Polar on the
  invoice), a scheduled cancellation, the saved payment method, and the
  orders of the current subscription with an invoice PDF
  (`GET /api/billing/account`, `GET /api/billing/invoices/:orderId`,
  `apps/api/src/billing-account.ts`). Orders are scoped by the
  organization's subscription id; an order of another subscription answers
  404. A credit for a deployment that stopped mid-period is a negative
  order and is listed as "Credit". Polar generates an invoice on request: the first download starts it
  and answers 409 `INVOICE_NOT_READY`; a retry a moment later gets the PDF.
  A member sees that only an owner or admin can see payments and invoices.
  When Polar fails, the page shows an inline alert and keeps the rest.
- Entitlements by status: matrix §4. Existing deployments are never gated.
- The billing page shows `N active · P paused · M included · K billed`;
  the paused count shows only when it is not zero, and `(minimum 1)` shows
  when the floor applies.
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
subscriptionUnits = max(billableDeploymentQuantity, 1)
```

where "active production billing deployments" is `count(deployment_type =
PRODUCTION AND billing_state = ACTIVE)` (`billing-matrix.md` §2). A PAUSED
deployment is not in the count, so it does not use the allowance.
`billableDeploymentQuantity`, `subscriptionUnits` and
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
- no waiver of the $68/month minimum — the subscription always bills the
  platform fee and at least one unit; the allowance only reduces the units
  above one.

Default 0, so every organization bills by the formula above until a Team
Admin sets a value. The value exists before any subscription does, and it
survives cancellation and reactivation, ownership transfer and membership
changes.

### Polar rule

Polar receives only the final unit count, as an absolute number. Polar
never learns the allowance exists: no discounts, custom prices, $0 prices,
per-vendor products or per-deployment items are created for it.

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
  a subscription — never a duplicate of the Polar update logic;
- keeps the new allowance if Polar fails: the reconciliation ledger records
  the drift, and the admin Reconcile action or the 15-minute safety job
  repairs it.

The vendor detail previews included and billable quantities before and
after, and a decrease warns that the next invoice may increase.

### What the vendor sees

The Billing page shows the pool — `N active · P paused · M included · K billed × $19` —
and never labels an individual deployment free or paid. The create page says
whether the next production deployment is covered or is the first billed one.
A live production deployment's detail reads "Counts toward your production
deployment total" (a paused one reads "Billing paused — not counted while it
is failed or disconnected"), and the disconnect dialog says the count goes
down and billing adjusts if the billable quantity changes. Customer-facing
install and deploy-link pages never show any of it.

### Explicitly out of scope

Not built, deliberately: custom platform prices, free platform months,
percentage discounts, discount codes, expiry dates, per-app or per-customer
allowances, consumable credits, volume tiers, custom contracts, arbitrary
price overrides. The allowance is one integer per organization and nothing
more.

## Configuration

Four values reach the API and worker Lambdas (`apps/api/src/env.ts`, the CDK
allowlist): `POLAR_TOKEN`, `POLAR_WEBHOOK_SECRET`, `POLAR_PRODUCT_ID` and
`POLAR_ENVIRONMENT` (`sandbox` or `production`). Only one is set by hand:

- `POLAR_TOKEN` — a Polar organization access token, a secret on the GitHub
  **environment** (`staging`, `production`), never on the repository.
- `POLAR_ENVIRONMENT` — optional variable on the GitHub environment. Unset,
  it follows the stage: `production` for the `production` environment,
  `sandbox` for every other.

The deploy step "Prepare Polar billing" (`.github/workflows/deploy-api.yml`)
runs `scripts/billing/polar-setup.mjs` when `POLAR_TOKEN` is set. It finds
or creates the product and the webhook endpoint
(`https://<API_DOMAIN_NAME>/api/billing/webhook`, pinned to API version
`2026-10`), locks the portal's unit, plan and pause changes, and adds
`POLAR_PRODUCT_ID` and the masked `POLAR_WEBHOOK_SECRET` to the job
environment. It refuses `POLAR_ENVIRONMENT=production` outside the
`production` GitHub environment, and it never prints the token or the
secret. `polar-catalog.md` records the ids.

Billing is optional at boot: with no token every billing surface reports
`BILLING_DISABLED` and nothing else is affected. With a token, the other
values are validated at startup.

`BILLING_ENFORCEMENT=off` pauses the PRODUCTION-deployment subscription gate
platform-wide, for an incident where Polar state is wrong or unreachable and
customers must not be blocked. Unset (the normal state) enforces. Nothing
else changes: webhooks, checkout, reconciliation and the allowance counters
keep running (`apps/api/src/env.ts`, `billing-entitlements.ts`).

With no token, checkout answers `503 BILLING_DISABLED` and creating a
PRODUCTION deployment is refused with `402` unless enforcement is paused.
TEST deployments are never gated.

## What was deliberately not built

- No trials, discounts, annual prices, tiers, seats, meters or slot
  purchasing. The one commercial override is the included production
  deployment allowance above — an integer per organization, never a price.
- No billing forms of Deployz's own: cards, addresses and cancellation are
  changed only on Polar's portal. The billing page reads and links; it never
  writes.
- No second subscription is ever sold: PAST_DUE and PAUSED cannot check out.
- No provider abstraction: `provider = POLAR` says what a row is, nothing
  more.
- No day-2 gating by payment state, CANCELED included — accepted cost: a
  canceled vendor can keep operating deployments they no longer pay for,
  because the alternative punishes their customers.

## Verification status and open items

Verified on the Polar **sandbox** through staging; the PR that made the
change carries the run log. `POLAR_TOKEN` is set on `production`; the
production product and webhook endpoint are created by the first production
deploy after this change, which then records their ids in `polar-catalog.md`.

Open before production: Polar production account approval.
