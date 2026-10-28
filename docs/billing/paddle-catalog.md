# Paddle catalog — Phase 4

The catalog Deployz bills against. Deployz displays prices but does no money
math: Paddle is the source of truth for charges and invoices, and nothing in
the codebase ever creates a product or a price. Ids are configuration
(`PADDLE_PRICE_PLATFORM`, `PADDLE_PRICE_DEPLOYMENT`), never source.

## Pricing model

Two products, one recurring USD price each, billed monthly. No trials, no
discounts, no annual prices, no tiers.

| Product | Price | Quantity | What it bills |
|---|---|---|---|
| Deployz Platform | $49.00 / month | exactly 1 | The vendor's platform subscription. One per organization. |
| Customer Deployment | $19.00 / month each | 1 to 1000 | Each customer deployment that is actually live. |

The platform price is the only item on the first checkout transaction
(`apps/api/src/billing-checkout.ts`): a parked deployment is not live yet.
The deployment quantity is set by Phase 9 reconciliation from the number of
deployments whose `billing_state` is `ACTIVE`.

## Sandbox

Created 2026-09-08 through the authenticated Paddle **sandbox** MCP
(`sandbox-mcp.paddle.com`) — never the live MCP, never the REST API. The
catalog was empty beforehand; both products and both prices were created in
one pass and read back as `active`.

| Entity | Id |
|---|---|
| Product — Deployz Platform | `pro_01m20257s830ht2qxk87br6exq` |
| Price — $49/month, quantity 1..1 | `pri_01m20257wy8pbwhbarybef5d7z` |
| Product — Customer Deployment | `pro_01m2025827v6kbnmnmebjns1cw` |
| Price — $19/month, quantity 1..1000 | `pri_01m202585w1nb1bcgmnvbx4bv3` |

Verified after creation: both prices `active`, USD, `billing_cycle`
`{ interval: month, frequency: 1 }`, amounts `4900` and `1900`,
`trial_period` null, tax category `standard`.

## Production

Created 2026-10-28 through the authenticated Paddle **live** MCP, with the
same names, descriptions, amounts, quantity limits and tax mode as the
sandbox. Read back as `active`, USD, monthly, `4900` / `1900`, no trial.

| Entity | Id |
|---|---|
| Product — Deployz Platform | `pro_01m610t14e20720ks2fynbt22p` |
| Price — $49/month, quantity 1..1 | `pri_01m610t25agdphge6d8w4fh77r` |
| Product — Customer Deployment | `pro_01m610t1gtesdqqk3vbp52jasw` |
| Price — $19/month, quantity 1..1000 | `pri_01m610t2fp2ydcya68hn9gvr14` |
| Notification destination — `https://api.app.deployz.dev/api/billing/webhook` | `ntfset_01m610t35kcj28shbpr0s5jw3h` |

The notification destination receives platform traffic only (no
simulations) for the nine events `apps/api/src/billing-webhooks.ts`
handles: `subscription.created`, `.activated`, `.updated`, `.past_due`,
`.paused`, `.resumed`, `.canceled`, `transaction.completed` and
`transaction.payment_failed`. Its secret key is `PADDLE_WEBHOOK_SECRET`.

## Creating the production equivalents

Production has its OWN ids. Do not copy the sandbox ids above into a
production environment — they do not exist there.

1. Use the authenticated Paddle **live** MCP (or the Paddle dashboard) on the
   production account.
2. Create product `Deployz Platform`, description "Monthly Deployz platform
   subscription for vendors using Deployz in production.", tax category
   `standard`. Add one price: USD `4900`, billing cycle 1 month, quantity
   minimum 1 / maximum 1.
3. Create product `Customer Deployment`, description "Monthly charge for each
   active production customer deployment managed through Deployz.", tax
   category `standard`. Add one price: USD `1900`, billing cycle 1 month,
   quantity minimum 1 / maximum 1000.
4. Confirm both prices read back `active`, USD, monthly, `4900` / `1900`,
   with no trial period.
5. Set `PADDLE_PRICE_PLATFORM` and `PADDLE_PRICE_DEPLOYMENT` to the new price
   ids as secrets of the `production` GitHub environment (see
   `.github/workflows/deploy-api.yml`), together
   with `PADDLE_API_KEY`, `PADDLE_WEBHOOK_SECRET`, `PADDLE_CLIENT_TOKEN`, and
   the environment variable `PADDLE_ENVIRONMENT` set to `production`.
6. Record the production ids in this file, in a section of their own.

## Changing a price

Paddle prices are immutable in the ways that matter: a price change is a NEW
price id plus a subscription update, not an edit. Archive the old price only
after every subscription has moved. Update this file and the two secrets in
the same change.
