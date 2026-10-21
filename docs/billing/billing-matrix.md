# Billing matrix

The decision tables the billing code implements, in one place. Each table
names the test that walks it exhaustively, so a missing cell is a failing
test rather than an oversight. Keep this file and those tests in step.

## 1. Deployment billing transitions

`applyBillingTransition(deployment, event, now)` — `apps/api/src/billing-domain.ts`.
Walked cell by cell in `apps/api/src/billing-matrix.test.ts`.

A production deployment is billed only while it serves the customer.
`LIVE` is a verified READY stage, or the safety job seeing the deployment
serve again. `NOT_SERVING` is the safety job seeing it `FAILED` or its
connector `DISCONNECTED`. Runtime health (`healthStatus`) alone never moves
billing.

| Type | Billing state | `LIVE` | `NOT_SERVING` | `REMOVED` (removal accepted) |
|---|---|---|---|---|
| TEST | NOT_STARTED | — | — | — |
| TEST | ACTIVE | — | — | — |
| TEST | PAUSED | — | — | — |
| TEST | STOPPED | — | — | — |
| PRODUCTION | NOT_STARTED | → ACTIVE, `billingStartedAt` | — (never billed) | → STOPPED, `billingStoppedAt` |
| PRODUCTION | ACTIVE | — (write-once) | → PAUSED | → STOPPED, `billingStoppedAt` |
| PRODUCTION | PAUSED | → ACTIVE (resume) | — | → STOPPED, `billingStoppedAt` |
| PRODUCTION | STOPPED | — (terminal) | — (terminal) | — (terminal) |

"—" means no patch at all. A TEST deployment never bills from any cell; a
never-live PRODUCTION deployment that is removed goes straight to STOPPED so
it can never activate later.

## 1b. Serving signal

`servingBillingEvent({ state, relayStatus })` — `billing-domain.ts`, in
`billing-domain.test.ts`. The safety job applies it to ACTIVE and PAUSED
production rows (`syncServingBilling`, `packages/cdk/test/worker-billing.test.ts`).

| Deployment `state` | `relayStatus` | Event |
|---|---|---|
| FAILED | any | `NOT_SERVING` |
| any | DISCONNECTED (persisted after 15 min without a check-in) | `NOT_SERVING` |
| HEALTHY / UPDATE_AVAILABLE | CONNECTED | `LIVE` (resumes only a PAUSED row) |
| anything else (INSTALLING, UPDATING, …) | CONNECTED / UNKNOWN | none — keep the billing state |

The relay write paths apply `LIVE` at a verified READY stage, but not to a row
that still reads `FAILED` or `DISCONNECTED`. A failed update over a running
release never reaches `FAILED`, so it stays billed.

## 2. Billable predicate and quantity

`isBillableDeployment` — true only for PRODUCTION + ACTIVE. Eight cells, all in
`billing-matrix.test.ts`; PAUSED is not billable. `countBillableDeployments`
sums it into the active production deployment count.

`billableDeploymentQuantity(active, included) = max(active − included, 0)`,
with `included = organization.included_production_deployments` (default 0),
is the ONLY number reconciliation ever pushes to Paddle
(`billing-domain.test.ts`, `billing-reconcile.test.ts`):

| active | included | billable | Paddle deployment item |
|---|---|---|---|
| 5 | 0 | 5 | quantity 5 (unchanged behavior) |
| 5 | 2 | 3 | quantity 3 |
| 3 | 3 | 0 | removed |
| 1 | 10000 | 0 | removed — never negative |
| 0..4 | 2 | 0, 0, 0, 1, 2 | crosses the threshold one at a time |
| TEST rows, any state | any | not counted | never consume the allowance |
| PAUSED rows | any | not counted | shown as `paused`, never consume the allowance |

## 3. Paddle subscription status → Deployz status

`mapSubscriptionStatus` — `apps/api/src/billing-webhooks.ts`. In
`billing-matrix.test.ts`.

| Paddle | Deployz | Note |
|---|---|---|
| `active` | ACTIVE | |
| `trialing` | ACTIVE | Deployz sells no trials; if Paddle reports one it bills, so it is ACTIVE |
| `past_due` | PAST_DUE | |
| `paused` | PAUSED | |
| `canceled` | CANCELED | |
| anything else | *ignored* | the event is recorded IGNORED, never guessed |

## 4. Entitlements by subscription status (R13-1)

Integration tests: `billing-entitlements.test.ts` (tests 4–9),
`billing-checkout.test.ts`.

| Action | Evaluation (no row) | ACTIVE | PAST_DUE | PAUSED | CANCELED |
|---|---|---|---|---|---|
| New customer deployment (manual / invitation) | 402 → checkout | ✅ | 402 → card form | 402 → portal | 402 → checkout |
| Start a checkout (`POST /api/billing/checkout`) | ✅ | 409 `SUBSCRIPTION_ALREADY_ACTIVE` | 409 `SUBSCRIPTION_NEEDS_ATTENTION` | 409 `SUBSCRIPTION_NEEDS_ATTENTION` | ✅ (new subscription) |
| Deploy / rollback / restart / config / destroy an EXISTING deployment | ✅ | ✅ | ✅ | ✅ | ✅ |
| TEST deployment, analysis, configuration, customers, releases | ✅ | ✅ | ✅ | ✅ | ✅ |
| Customer portal (`POST /api/billing/portal`) | 409 `NO_SUBSCRIPTION` | ✅ | ✅ | ✅ | ✅ |

Payment state never touches running customer infrastructure.

## 5. Reconciliation outcomes (Phase 9)

`reconcileBilling` — `billing-reconcile.test.ts`.

| Situation | Status | Action | Ledger row? |
|---|---|---|---|
| Billing disabled (no Paddle) | SKIPPED | SKIPPED | no |
| No subscription, nothing live | SKIPPED | SKIPPED | no |
| No subscription, something live | SKIPPED | SKIPPED | yes — anomaly |
| PAUSED / CANCELED, something live | SKIPPED | SKIPPED | yes — anomaly |
| ACTIVE / PAST_DUE, provider already matches | SUCCEEDED | NONE | no — `lastReconciledAt` only |
| first live deployment | SUCCEEDED | ITEM_ADDED | yes |
| count changed | SUCCEEDED | QUANTITY_UPDATED | yes |
| last live deployment removed | SUCCEEDED | ITEM_REMOVED (item dropped, never qty 0) | yes |
| Paddle refused | FAILED | NONE | yes, with reason |

Always the ABSOLUTE quantity (`max(active − included, 0)`), never a delta:
two runs produce the same subscription as one. Inactive Paddle items are
never resent. The result also carries `active` and `included` so the admin
view and the audit trail can show the three numbers behind `expected`.

## 7. Included-deployment allowance changes (admin)

`POST /api/admin/vendors/:id/included-deployments` —
`admin-included-deployments.test.ts`, `billing-allowance.test.ts`.

| Situation | Stored? | Audited? | Reconciled? |
|---|---|---|---|
| Non-admin / anonymous / support mode | no | no | no |
| Negative, decimal, string, > 10000, blank reason | no (400) | no | no |
| No subscription yet | yes | yes | no — no provider call |
| ACTIVE / PAST_DUE, value changed | yes | yes, with outcome | yes — absolute quantity |
| PAUSED / CANCELED, value changed | yes | yes | SKIPPED (not updatable) |
| Same value | no write | yes (`changed: false`) | no |
| Paddle fails | yes — kept | yes, `FAILED` | ledger row; Reconcile action / sweep repair it |
| Two admins race | serialized on the row lock | both, true previous values | converges to the last write |

## 6. Webhook delivery handling (Phase 6)

`billing-webhooks.test.ts`.

| Delivery | Response | Recorded as |
|---|---|---|
| Missing / invalid signature | 401 (Paddle retries) | nothing written |
| Same `event_id` again, earlier attempt PROCESSED/IGNORED | 200 | DUPLICATE |
| Same `event_id` again, earlier attempt FAILED | processed again | RECEIVED → … |
| Older `occurred_at` than what is on file | 200 | IGNORED (stale) |
| Different subscription id while stored one is not CANCELED | 200 | IGNORED (mismatch) |
| Processing threw | 500 (Paddle retries) | FAILED |
| Row abandoned in RECEIVED > 10 min | — | reset to FAILED by the safety job |
