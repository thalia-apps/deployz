# Polar catalog

The catalog Deployz bills against. Deployz displays prices but does no money
math: Polar is the source of truth for charges, tax and invoices. Nothing in
the request path creates a product or a price; the deploy step "Prepare
Polar billing" runs `scripts/billing/polar-setup.mjs`, which creates them
once and finds them again on every later deploy.

## Pricing model

One monthly recurring USD product, tax-exclusive. No trials, no discounts,
no annual prices.

| Price | Amount | Quantity | What it bills |
|---|---|---|---|
| Fixed | $49.00 / month | — | The vendor's platform subscription. One per organization. |
| Unit-based (volume, one open tier) | $19.00 / month per unit | minimum 1 | Each customer deployment that is live, with a minimum of one. |

The checkout buys one unit ($68). Reconciliation sets the unit count to
`max(live − included, 1)` (`polar-billing.md`).

## How the setup script finds what it owns

| Resource | Found by | Created with |
|---|---|---|
| Product | metadata `deployz_config = deployz_monthly_v1` | name `Deployz`, visibility `private`, the two prices above, unit label "customer deployment(s)" |
| Webhook endpoint | its URL, `https://<API_DOMAIN_NAME>/api/billing/webhook` | format `raw`, API version `2026-10`, the nine `subscription.*` events `apps/api/src/billing-webhooks.ts` handles |
| Portal settings | the product's organization | subscription `update_units`, `update_plan` and `pause` off (best effort) |

More than one match stops the deploy. The script never edits a product's
prices: a new price shape is a new key (`deployz_monthly_v2`) and a
subscription migration.

## Sandbox (staging)

| Entity | Id |
|---|---|
| Product | Recorded after the first staging deploy with `POLAR_TOKEN` set. |
| Webhook endpoint | Recorded after the first staging deploy with `POLAR_TOKEN` set. |

The deploy log prints both ids. The signing secret is masked and never
recorded.

## Production

Not configured. To switch it on: set `POLAR_TOKEN` (a production
organization access token) as a secret and `POLAR_ENVIRONMENT=production`
as a variable on the `production` GitHub environment, deploy, and record the
ids the deploy log prints in a section of their own here.
