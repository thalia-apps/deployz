# Networking, DNS and HTTPS

How a deployment becomes reachable: the network inside the customer account,
the permanent Deployz-owned HTTPS address, custom domains, and how all of it
is torn down. Code: `apps/api/src/default-https.ts`,
`apps/api/src/cloudflare-records.ts`, `apps/api/src/domains.ts`,
`apps/api/src/domain-check.ts`, `packages/relay/src/domain.ts`.

## Network inside the customer account

Every application stack creates its own VPC (two public and two private
subnets across two AZs, one NAT gateway with an Elastic IP, an internet
gateway), an internet-facing Application Load Balancer in the public subnets,
and the ECS Fargate service, the optional RDS instance and the optional
Valkey cache in the private subnets. A deployment with a database also adds
isolated DB-only subnets in every other available AZ of the region; they carry
no NAT gateway and no internet route, and exist only so the RDS subnet group
can span the whole region. Security groups: the ALB accepts 80 and
443 from the internet (443 is opened at publish time even though the listener
is added later); the service accepts traffic only from the ALB; the database
accepts 5432 only from the service security group; the cache accepts 6379
from the whole VPC CIDR. Nothing except the ALB is internet-reachable, and
the control plane never connects into the VPC.

Consequences worth knowing:

- Each deployment consumes one VPC, one NAT gateway and one Elastic IP. New
  AWS accounts have a default quota of five per Region.
- The NAT gateway and the dedicated ALB dominate the per-deployment AWS cost.
- The published templates contain **one HTTP listener** only. The HTTPS
  listener and its certificate are created by the relay after install.

## URL kinds

| URL | Owner | When it exists |
| --- | --- | --- |
| `https://d-<deployment-id>.deployz.dev` (default URL) | Deployz (Cloudflare zone `deployz.dev`) | Every deployment, automatically; the machine starts once the deployment is HEALTHY (the first verified heartbeat after INSTALL) |
| `https://<custom-hostname>` (custom domain) | The customer's DNS | Only when the vendor adds one and the customer creates the records |
| `http://<alb-dns-name>` | AWS | Always; the fallback while HTTPS is being set up |

The preferred public URL (`resolveAppUrl`, `apps/api/src/fleet-row.ts`) is
the custom domain when it is ACTIVE, otherwise the default URL once its
machine is ACTIVE or CONFIGURING, otherwise the bare ALB endpoint. The
default URL is never disabled while a custom domain exists; it is the
permanent fallback. The relay probes the same URL the customer sees.

## Default HTTPS

Two Cloudflare DNS records per deployment, both written by the control plane
into the `deployz.dev` zone and both restricted by a namespace guard to
`d-*` names:

1. an **unproxied** CNAME `_<label>.d-<id>.deployz.dev` for ACM DNS-01
   validation (unproxied so ACM can see it);
2. a **proxied** CNAME `d-<id>.deployz.dev` → the deployment's ALB.

The certificate itself is requested **in the customer account** by the
relay's `CONFIGURE_DOMAIN` executor, tagged with the installation id. Once
ACM reports ISSUED, the relay creates the 443 listener (or adds the
certificate to an existing one) and turns the port-80 listener into a 301
redirect. The control plane never touches the customer's load balancer.

The certificate request starts while the INSTALL is still running (the relay
has claimed the INSTALL and the deployment is `INSTALLING`), so ACM validation
overlaps stack creation. In that window the job carries `deferListener`: the
relay requests and describes the certificate and reports the load balancer when
it exists, but creates no 443 listener. The control plane writes the validation
CNAME as soon as the relay reports it and the routing CNAME once the load
balancer is known. Waiting for the stack spends none of the configure budget.
After the install settles, the next job attaches the listener to the same
certificate. A fresh first-install attempt (customer retry, deploy-link retry,
reset of a never-installed deployment) replaces the relay credential, so it
drops this state, cancels its queued domain jobs and removes its DNS records;
the unused certificate stays in the customer account until a purge. A
retry-install keeps the state and reuses the certificate.

### State machine

State lives in `deployments.default_https` (JSON). Statuses: `PENDING`,
`WAITING_FOR_DNS`, `CONFIGURING`, `ACTIVE`, `ERROR`, `REMOVING`. Custom
domains use the same six values in the `custom_domains` table.

| From | Trigger | To |
| --- | --- | --- |
| (none), deployment INSTALLING with a running INSTALL, or HEALTHY / UPDATING / UPDATE_AVAILABLE | a heartbeat, or INSTALL success | `PENDING`, a `CONFIGURE_DOMAIN` job is queued |
| `PENDING` | job result carries the ACM validation record | `WAITING_FOR_DNS`; the validation CNAME is upserted, the routing CNAME once the load balancer is known; a new job cycle starts |
| `WAITING_FOR_DNS` | job result: certificate ISSUED and listener configured | `CONFIGURING` |
| `CONFIGURING` | the control plane's HTTPS probe succeeds | `ACTIVE`; the deployment can be READY |
| any non-ACTIVE | a configure job fails (`CONFIGURE_FAILED`, `AWS_PERMISSION_DENIED`) or the 30-minute configure budget is spent (`DEFAULT_DNS_TIMEOUT`) | `ERROR` (terminal; while Cloudflare answers 429 the machine keeps waiting) |
| `ACTIVE` | a later failure | stays `ACTIVE` (a failure never demotes an active address) |
| `ERROR` | `POST /api/deployments/:id/default-https/retry` | `PENDING` with the attempt counter reset |
| any | DESTROY / force-complete / purge | `REMOVING`, then the records are deleted |

The machine advances on the relay heartbeat (every minute) and once
immediately after INSTALL success, so a typical deployment reaches ACTIVE
a few minutes after it becomes healthy. The configure budget is elapsed
time, not a count of heartbeats: it starts at the first attempt and lasts
30 minutes, because ACM DNS validation can take that long. The machine
makes at most one DNS attempt per minute, whatever the heartbeat rate. The
retry route resets the attempt counter, which starts a new budget.

### Origin TLS and the Cloudflare hop

The default-URL path is HTTPS in two segments: browser → Cloudflare edge
(Cloudflare's edge certificate for `d-*.deployz.dev`), then Cloudflare → the
customer's ALB over the per-deployment ACM certificate. This means traffic to
the default URL transits Deployz's Cloudflare account; a custom domain does
not. The zone's SSL/TLS mode must be **Full (strict)** for the second hop to
be encrypted and validated; in Flexible mode Cloudflare would connect to the
origin over plain HTTP. The zone mode is an out-of-band operator setting that
nothing in this repository verifies. The HTTPS probe treats any completed
HTTPS response as success, so `ACTIVE` proves reachability, not origin TLS.

### Production configuration

Supplied to the API Lambda by `.github/workflows/deploy-api.yml`, which
refuses to deploy if any is missing: `CLOUDFLARE_ZONE_ID`,
`CLOUDFLARE_ZONE_NAME` (`deployz.dev`), `DEPLOYZ_DEFAULT_HOSTNAME_PREFIX`
(`d-`), and the secret `CLOUDFLARE_ZONE_EDIT_API_TOKEN`. The API's own
`api.deployz.dev` CNAME must be DNS-only (not proxied) or TLS to the API
fails with a Cloudflare 525.

`DEPLOYZ_DEFAULT_HOSTNAME_PREFIX` controls which names the control plane
mints and which names its namespace guard lets it write. Every control plane
that shares the zone therefore needs its own prefix: staging uses `s-`, so it
can never write or delete a production `d-` record.

### Staging configuration

Cloudflare Universal SSL covers the zone and one label below it. It does not
cover a host two labels deep. Each of the three staging hosts is two labels
deep, so each staging record must be DNS only (grey cloud). A proxied record
answers 525.

| Host | Record type | Target | Cloud |
| --- | --- | --- | --- |
| `api.staging.deployz.dev` | CNAME | the regional API domain that the staging stack exports | DNS only |
| `app.staging.deployz.dev` | CNAME | the staging container-service host | DNS only |
| `staging.deployz.dev` | CNAME | the staging container-service host | DNS only |

The deploy of each service makes the target it uses. The three records
therefore cannot exist before the first staging deploy of each service. Each
deploy prints the record to make, and fails until the record exists. Each
deploy also tests the answer against the proxy addresses that Cloudflare
publishes, so it reports whether the host is proxied or is an A record.

### Cloudflare client behaviour

Search-then-create/update (Cloudflare has no upsert; a concurrent-create
`81057` is retried by re-lookup), delete treats `81044` (already gone) as
success, proxied records are sent with `ttl: 1`, and errors map to
`CLOUDFLARE_AUTH_FAILED`, `CLOUDFLARE_PERMISSION_DENIED`,
`CLOUDFLARE_RATE_LIMITED`, `CLOUDFLARE_DNS_CONFLICT`,
`CLOUDFLARE_UNAVAILABLE`. Reserved names (`deployz.dev`, `app`, `www`, `api`,
`admin`) can never be written. All provider calls in tests go through an
injectable transport; nothing in the test suite reaches Cloudflare.

## Custom domains

- **Who does what.** The vendor enters the hostname (from the deployment
  detail page, which opens the customer install page in a vendor session).
  Deployz shows the customer two CNAME records to create in their own DNS: a
  validation record for ACM and a routing record pointing at the ALB. The
  relay requests the ACM certificate in the customer account, wires the 443
  listener and the port-80 redirect. Deployz **only reads** the customer's
  DNS; it writes nothing outside its own `d-*` namespace.
- **Validation rules** (`apps/api/src/domain-validation.ts`): a single
  hostname, no wildcards, no reserved Deployz suffixes; a two-label
  public-suffix approximation is a deliberate MVP trade-off rather than a
  full public-suffix list.
- **States** follow the same six statuses. Domain job failures land on the
  `custom_domains` row and never change the deployment state. `ERROR` is
  terminal for a domain; ACTIVE domains are not re-checked. A certificate
  that ACM reports as `FAILED` or `VALIDATION_TIMED_OUT` moves a `PENDING` or
  `WAITING_FOR_DNS` domain to `ERROR` (`CERTIFICATE_FAILED`). The vendor can
  remove a domain in every state except `REMOVING`.
- **Change = remove, then add.** There is no in-place hostname edit. After
  removal the preferred URL falls back to the default URL immediately, and a
  new domain can be added at once (soft-deleted rows do not block the unique
  index).
- **Precedence.** A custom domain is preferred as soon as its status is
  ACTIVE (which the machine grants only after DNS, certificate and probe
  passed); there is no separate runtime-health condition.

## Teardown

- **DESTROY** queues a default-HTTPS `REMOVE_DOMAIN` job (the relay deletes
  the listener certificate and reverts port 80 to a forward, then deletes the
  ACM certificate, retrying while the listener association drains) and, on
  success, the control plane deletes both `d-*` records. Custom-domain
  removal is queued the same way.
- **Force-complete** (relay gone) deletes the records from the control plane
  side without touching AWS.
- **PURGE** deletes any leftover records for the deployment and runs an
  orphan sweep over `d-*` routing records whose deployment row is gone.
  Orphaned validation records (`_…d-<id>`) are not swept. The relay's purge
  also deletes owned ACM certificates by tag.
- All DNS teardown is best-effort: a Cloudflare failure is logged and never
  fails the destroy or purge request.

## Known limitations

- A FAILED or timed-out ACM certificate is not replaced on retry; retry
  re-describes the stored certificate and surfaces `DEFAULT_DNS_TIMEOUT`.
- The HTTPS probe accepts any completed HTTPS response, including a
  Cloudflare 52x from the edge, so `ACTIVE` can precede the origin serving.
- A HEALTHY deployment can present the default URL while the machine is
  still `CONFIGURING`, before the probe has passed.
- Regional or wildcard certificates are not implemented; one ACM certificate
  is issued per deployment in the deployment's Region.
- Universal SSL covers the zone and one label below it. A host two labels
  deep has no edge certificate, so its record must be DNS only. Cloudflare
  Advanced Certificate Manager removes this limit, and the MVP does not use
  it.
