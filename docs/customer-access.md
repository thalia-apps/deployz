# Customer access — the customer deployment page

How a customer gets into the page for one deployment
(`/install/:installLinkId`), who may see what, and what the page shows. The
code is `apps/api/src/customer-access.ts` (API) and the `customer-*`
components in `apps/web/src/components/` (page). The connector-update
derivation that the page shows is in
[`operations/control-plane.md`](operations/control-plane.md).

## Model

- **One page for each deployment.** The same URL guides the install, shows
  progress, and stays the customer's page for the running deployment.
- **The link is not a credential.** The install link id identifies the
  deployment. Without a verified identity, `GET /api/install/:id` returns only
  `applicationName`, `publisherName` and `signInRequired: true`. The old URL
  fragment token (`#<token>`) still appears in links that the vendor copies,
  but the install routes ignore it.
- **The owner is an email address.** A customer has no Deployz account and no
  password. An emailed 8-digit code proves the address.
- **One owner per deployment.** Before the first sign-in, the allowed email is
  the email of the deployment's customer record (the vendor enters it for an
  invitation or a vendor-created deployment; the customer types it on a public
  install link). The first verified sign-in with that email claims the
  deployment (`deployment_owners`). After the claim, a change to the customer
  record does not change the owner.
- **A vendor member may open the page.** A Better Auth session of a member of
  the deployment's organization is also allowed (`viewer.kind = 'vendor'`).
  This covers TEST deployments, where the vendor is the customer.
- **Email verification comes before "Connect AWS account".** The Quick Create
  link carries the relay credential, so only a verified viewer gets it. A new
  customer verifies the email on the first visit after the confirmation.

## Sign-in

| Step | Route | Rule |
| --- | --- | --- |
| Request a code | `POST /api/customer/sign-in/code` `{ installLinkId, email }` | Always `202 { accepted: true }`. A code is sent only when the email is the allowed email. Sets the browser-flow cookie. |
| Verify | `POST /api/customer/sign-in/verify` `{ installLinkId, code }` | Needs the flow cookie of the browser that asked. Sets the session cookie and claims an unclaimed deployment. |
| Sign out | `POST /api/customer/sign-out` | Revokes the session row and clears the cookie. |

Limits (constants in `customer-access.ts`):

| Setting | Value |
| --- | --- |
| Code | 8 random digits; only an HMAC (server secret, challenge id) is stored |
| Code lifetime | 10 minutes |
| Attempts per code | 5, counted atomically before the comparison |
| Wrong codes per email | 10 per hour across all codes; a new code does not reset it |
| Resend cooldown | 60 seconds per email |
| Codes per email | 5 per hour |
| Active codes | One per browser flow; a resend retires the previous code |
| Session idle expiry | 30 minutes |
| Session absolute expiry | 12 hours |
| IP rate limit | 20 code requests and 30 verifications per minute |

- **Cookies.** `<prefix>.customer_session_token` and `<prefix>.customer_flow`
  (`__Secure-` when the API is on HTTPS; `<prefix>` is `COOKIE_PREFIX`, else
  `deployz`). HttpOnly, SameSite=Lax, Path=/, and `Domain=COOKIE_DOMAIN` when
  set — the same scope as the dashboard session (`.app.deployz.dev` in
  production, which does not cover customer application hostnames). Only the
  sha256 of the session token is stored.
- **CSRF.** The customer routes refuse a request whose `Origin` is not
  `WEB_URL` or `MARKETING_URL`. The session cookie name contains
  `session_token`, so the API's general origin check also covers every
  state-changing install route.
- **Polling and idle expiry.** A request from the page refreshes the idle
  timer. In a hidden tab the page fetches only its first data and does not
  repeat polls (`useStatusPoll`), so a background tab does not keep a session
  alive.
- **Fixture mode.** With `EMAIL_VERIFICATION_FIXTURE_MODE=true` (simulated
  E2E only), the code request also returns `fixtureCode`.
- **Known limit.** A request for an allowed email does more work (database
  writes and an SES call) than one for another email, so the response time
  can differ. The response body and status are the same.

## Who may do what

Every route below answers `404` (the same as an unknown link) to a visitor
who is neither the owner nor a vendor member. An expired, revoked or removed
link still answers `410` first, as before.

| Route | Purpose |
| --- | --- |
| `GET /api/install/:id` | Page data, Quick Create link, `viewer` |
| `GET /api/install/:id/status` | Live progress (customer projection) |
| `GET /api/install/:id/overview` | Connector, AWS location, activity |
| `POST /api/install/:id/launched` | "Connect AWS account" pressed |
| `POST /api/install/:id/retry` | Retry connection (new credential) |
| `POST /api/install/:id/domain/check` | Custom domain "Check now" |

All `/api/install/*` and `/api/customer/*` responses carry
`Cache-Control: no-store`.

## The page

| Section | Content |
| --- | --- |
| Session bar | "Signed in as …" and Sign out, or the vendor notice |
| Status and progress | The existing install progress and Open application |
| Deployz connector | Connection (Connected, Offline, Not connected yet, Unknown), last contact, installed version, update state, Update connector |
| AWS location | AWS account, Region, connector stack, Open in AWS |
| Activity | Customer-safe events only (`CUSTOMER_ACTIVITY_EVENTS`), newest first |
| Help | Contact the publisher; customer guide and security docs |

- **Connector offline is not application down.** The page says the status can
  be out of date. It never says that the application stopped.
- **Update connector** opens read-only steps: open the stack, replace the
  template with the versioned URL, keep every parameter, review the change
  set, and an AWS CLI command with `UsePreviousValue=true`. Deployz never
  changes the customer's stack. The update shows as done only when the
  connector reports the new build and a stable stack.
- **Activity** lists install, update, rollback, restart, settings, domain,
  removal, purge, connector and owner-claim events. Payloads never carry the
  email; the actor id is `customer-session:<id>`.

## Not in the MVP

Ownership transfer, recovery of a lost owner mailbox (a Team Admin case, done
by hand), sign-out of all sessions, a step-up check, and more than one owner.
