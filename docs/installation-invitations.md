# Installation invitations — lifecycle and security

How a new installation starts. One concept
before deployment creation, a different concept after it.

## The two concepts

| Stage | Name | What it is |
| --- | --- | --- |
| Before confirmation | **Installation invitation** | A vendor-created entry point that names an application (and, for a targeted invitation, a customer). No deployment exists. |
| After deployment creation | **Customer deployment link** | The deployment's own `/install/:installLinkId` URL. It opens setup progress, status, access and domain information. It never creates another deployment. |

They are deliberately not presented as two kinds of "install link" — the
lifecycle stage, not the URL shape, is the product concept.

## Storage

Both invitation kinds live in `public_install_links`
(`packages/db/src/schema/public-install-links.ts`, migration `0044`):

- **Reusable public link** — `customer_id`/`token_hash` NULL, `enabled`
  gates it, one live per application. Anyone holding the URL may review and
  confirm; each confirmation creates its own customer and deployment.
- **Targeted invitation** — `customer_id` + `token_hash` set, `expires_at`
  (default 30 days), optional `recommended_region`. Exactly one deployment,
  ever: confirmation stamps `confirmed_at` (state `used`).

Both kinds freeze `recommended_size_profile` and `minimum_size_profile`
when they are created (migration `0052`): the vendor's per-link size
recommendation (default: the application default) and the application's
minimum at that time. Later application changes never alter an existing
link; regenerating a reusable link keeps the replaced link's recommendation
and takes the application's current minimum (a recommendation below it is
raised). Rows
created before sizing have both columns null and follow the application's
current settings ([`infrastructure-profiles.md`](infrastructure-profiles.md#who-chooses-the-size)).

`region_selection` records Region ownership: `'customer'` for everything
new; `'legacy_publisher_fixed'` exists for the legacy `deploy_links` table,
whose Region the vendor fixed before this model existed.

## Derived status (no state machine)

`status = 'used'` when `confirmed_at` is set, else `'revoked'` when
`revoked_at` is set, else `'expired'` when `expires_at < now()`, else
`'active'`. Served by `GET /api/customers/:customerId/invitations`.

## Vendor flow

1. Vendor selects customer + application, optionally recommends a Region
   ("Your customer will make the final Region selection before deployment.")
   and may override the recommended size (preselected: the application
   default; only sizes at or above the application minimum).
2. `POST /api/customers/:customerId/invitations` creates the invitation —
   **no deployment row**.
3. The response reveals the link URL and the one-time token exactly once.
4. Customer opens the link. The API requires the one-time token in the
   `x-deployz-token` header for a targeted invitation (a missing or wrong
   token is the same 404 as an unknown id). The web transport captures the
   token from the URL fragment (`#<token>`), strips it from browser history
   immediately, persists it in `sessionStorage` for refresh/back-navigation,
   and sends it as the header on resolve/plan/confirm. Reusable public links
   require no token.
5. Customer selects a Region (explicit choice required when there is no
   recommendation; the recommended Region pre-selects when present and
   deployable), chooses a size (the link's recommendation preselects and
   carries a "Recommended by your software provider" badge; sizes below the minimum are not
   offered), reviews the Region- and size-specific plan and cost
   (`GET /api/public-install/:id/plan?region=…&profile=…`), supplies
   configuration, and confirms the plan's fingerprint. The recommendation is
   shown as a badge; entered config values survive Region and size
   switches; stale plan responses from an earlier selection cannot
   overwrite the latest.
6. The server atomically re-validates the invitation (active, not expired,
   not revoked, not used), the subscription gate, preflight, Region, size
   and the approved plan fingerprint (`409 PLAN_CHANGED` when the compiled
   plan differs), then creates **exactly one** deployment (`source` =
   `public_link`). Region and size become immutable; the invitation is
   consumed.
7. Confirmation is idempotent per idempotency key (replays return the same
   deployment); a *different* key on a consumed invitation gets `410
   PUBLIC_INSTALL_LINK_USED`.

Invitations are not deployments and never touch billing counts.

The dashboard's primary "Create installation" path creates an invitation
(customer + application + optional recommended Region); the customer opens
the link, chooses the final Region, and confirms — only that confirmation
creates the deployment. A `?test=true` deployment stays the vendor's own
free test: it is created directly with a vendor-chosen Region because no
customer is involved. See `docs/product/user-flows.md` for all entry points.

## Token security

- 256-bit random secret; only its sha256 is stored (`token_hash`).
- Revealed exactly once at creation (and on regeneration); never retrievable
  again, never in API logs, never in event payloads.
- Transported in the `x-deployz-token` header, never in URLs or Quick Create
  parameters.
- Authorizes only invitation review and confirmation — never relay or AWS
  permissions.
- Targeted invitations are expiring and revocable; either is terminal for
  confirmation.

## Customer deployment links

Each deployment keeps its own `install_link_id`
(`/install/:installLinkId`). Copy actions on the vendor's customer page are
attached to the deployment row and copy that deployment's own URL — there is
no customer-level "the install link" and no helper that picks one deployment
for a customer.

## Legacy compatibility

- Existing `/deploy/:publicId` links keep working end to end; the flow is
  marked `region_selection = 'legacy_publisher_fixed'`.
- Existing `/install/:installLinkId` links are unchanged (they were always
  per-deployment).
- No existing deployment is rewritten. The legacy `/deploy` creation surface
  and its removal are a post-MVP decision once old links have expired or
  been migrated.

## Audit

The `invitation.*` event family (created/opened/regenerated/
revoked/confirmed/region_selected/deployment_created/
configuration_delivered). Payloads carry ids and counts only — never tokens,
config values, or customer PII.

## Post-MVP notes

- `invitation.expired` / `invitation.configuration_expired` events (need new
  persistence hooks to be honest).
- Legacy `/deploy` route removal.
