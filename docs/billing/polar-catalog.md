# Polar catalog

The catalog Deployz bills against. Deployz displays prices but does no money
math: Polar is the source of truth for charges, tax and invoices. Nothing in
the request path creates a product or a price; the deploy step "Prepare
Polar billing" runs `scripts/billing/polar-setup.mjs`, which creates them
once and finds them again on every later deploy.

## Pricing model

One monthly recurring USD product, tax-exclusive. No trials, no annual
prices. The checkout accepts discount codes that staff create in the Polar
dashboard (`polar-billing.md`, "Discount codes").

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

Created 2026-11-07 by the first staging deploy with `POLAR_TOKEN` set, in
the sandbox organization "Deployz Staging".

| Entity | Id |
|---|---|
| Product `Deployz` (`deployz_monthly_v1`) | `018a1c78-f981-418d-8d6a-1d56ac571f8c` |
| Webhook endpoint — `https://api.staging.deployz.dev/api/billing/webhook` | `fd681d8c-7fb3-414a-a326-9767c1b3a8db` |

The deploy log prints both ids. The signing secret is masked and never
recorded.

## Production

Created 2026-11-07 by the first production deploy with `POLAR_TOKEN` set
(release of `7521380e`).

| Entity | Id |
|---|---|
| Product `Deployz` (`deployz_monthly_v1`) | `512fd419-f323-46d7-89ea-f920d7ac8fda` |
| Webhook endpoint — `https://api.deployz.dev/api/billing/webhook` | `d6da5078-3fb0-419c-ae8f-91c55708b9c9` |
