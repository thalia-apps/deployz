# Deploy Links (legacy)

> **Status: legacy.** Deploy Links are superseded by installation invitations
> (`docs/installation-invitations.md`). The `deploy_links` table and the
> `/deploy/:publicId` route still work for links created before the
> invitation model shipped; they are marked `region_selection =
> 'legacy_publisher_fixed'` and continue to resolve through the shared
> pipeline. New customer entry points use invitations, not deploy links.
> The legacy path will be removed post-MVP after all existing deploy links
> have expired or their deployments have been destroyed.

A Deploy Link lets a vendor generate a secure, customer-specific "Deploy to
AWS" URL for an existing customer + application pair. The customer opens the
hosted page, connects their own AWS account through the existing flow, reviews
the deployment, and starts it. The feature is a thin entry point into the
existing deployment architecture — it does not add a second pipeline.

## What they are

- Vendor side: no dashboard surface remains (the "Deploy to AWS" card was
  removed with the invitation model), but the API still mints new links
  (`POST /api/customers/:customerId/deploy-links`, plus revoke and
  regenerate). Pick application + region, generate, copy the URL once.
- Customer side: `/deploy/<publicId>#<secret>`
  (`apps/web/src/app/deploy/[publicId]/page.tsx`). The secret is in the URL
  fragment, so it never reaches a request URL, an access log or a Referer.
  The page moves it into a cookie scoped to `/deploy/<publicId>` and removes
  it from the address bar (`LinkTokenGate`); the server page sends it as the
  header below. Review (application, AWS
  region, resources), "Deploy to AWS" handoff, then the install flow's own
  progress, domain and retry experience.
- Backend: `apps/api/src/deploy-links.ts` (lifecycle services), routes in
  `apps/api/src/server.ts`, table `deploy_links` +
  `deployments.source` enum (`manual | deploy_link`) in migration `0029`.

## How link authorization works

- A link is a public uuid plus a 32-byte random secret. Only the sha256 hash
  is stored (`token_hash`); the raw secret is returned exactly once, by
  generate and regenerate.
- Every public call presents the secret in the `x-deployz-token` header —
  never in a request URL or query string. `resolveDeployLink` verifies it with the same
  constant-time compare the relay tokens use, then enforces: revoked → 410
  `DEPLOY_LINK_REVOKED`, expired (30-day TTL) → 410 `DEPLOY_LINK_EXPIRED`,
  wrong token / unknown id / deleted deployment → 404 (never a distinction an
  attacker can read).
- The token authorizes exactly one deployment's install flow. It never
  becomes a session and grants no relay/AWS permissions — relay routes still
  authenticate with the relay's own bearer token.
- Public routes are rate-limited like the install routes
  (`PUBLIC_INSTALL_RATE_LIMIT`); the secret never reaches logs (header, not
  URL) and appears in no payload except the one-time generate/regenerate
  responses.
- Vendor routes are org-scoped with the house IDOR rule: another org's
  customer, application or link 404s, never 403s.

## How deployment reuse works

Generation runs the SAME creation path as the vendor manual flow
(`createDeploymentRecord`: region allowlist gate, manifest readiness gates,
one insert with enrollment code + install link) and marks it
`source: 'deploy_link'`. The launch, status, retry and domain-check routes
resolve the link first, then reuse the install routes' logic byte-for-byte
(readiness gate, NOT_INSTALLED → WAITING_FOR_RELAY, customer status
projection). Launch is guarded by a conditional UPDATE on
`state = 'NOT_INSTALLED'`, so double submits record one launch. Everything
after enrollment — jobs, relay, polling, resources, hostname, custom domains,
releases, rollback, destroy — is untouched, origin-agnostic machinery.

## Why there is no separate pipeline

The link is only an entry point: one `deploy_links` row keyed to one normal
deployment. Any second creation/install/status path would fork the state
machine this product depends on. The e2e scenario `deploy-link`
(`e2e/scenario-deploy-link.spec.ts`) proves a link-created deployment reaches
HEALTHY through the shared pipeline and appears in the fleet with
`source: deploy_link`.

## Key tests

- `apps/api/src/deploy-links.test.ts` — token lifecycle (valid, invalid,
  expired, revoked, malformed), cross-tenant 404s, regenerate rotation and
  409-after-start, double-submit race, fleet parity, destroy → link fails
  closed, token-vs-relay permission boundary, no raw token persisted or
  leaked.
- `apps/web/test/deploy-page.test.tsx`, `deploy-link-flow.test.ts` — page
  states, resolve-reason mapping.
- `e2e/scenario-deploy-link.spec.ts` — simulated E2E journey and failure
  journeys (no real AWS).

## Validated on real AWS

The full path (generate → token shown once → customer review → Deploy to
AWS → Quick Create → relay registration → HEALTHY → default HTTPS ACTIVE →
release update → Disconnect → Purge) was driven against the deployed control
plane and the test AWS account on 2026-09-05, with the fleet row carrying
`source: deploy_link`. Behaviours worth knowing: revoking a link does not
delete its NOT_INSTALLED deployment row (it holds no AWS resources); a
revoked link is replaced by generating a new one, which creates a new
deployment; the raw token never reaches the API logs (header-only
transport) and only `token_hash` is stored.

## MVP exclusions

Anonymous links, unknown-customer creation, marketplace, iframe/SDK embeds,
deployment REST API, white-labeling, button/CSS customization, multi-cloud,
Terraform, AWS Marketplace, custom deployment engines, separate link state
machines, and dedicated AWS infrastructure are all out of scope. Analytics are
the `event_logs` audit stream (`deploy_link.*` family) plus
`deployments.source`; there is no dashboard.
