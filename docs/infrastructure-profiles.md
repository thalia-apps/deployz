# Infrastructure profiles, footprint and cost

The immutable infrastructure-size profile registry
(`packages/contracts/src/profile.ts`) is the single source of truth for the
AWS sizing of a deployment's application stack. What exists is decided by
the frozen spec's graph → planner → IR chain; the size profile only decides
*how big* it is
([`architecture.md`](architecture.md#application-template-generation)).

## Published profiles

| Key | Tier | Workload (each web, worker, migration and scheduled task) | Database (PostgreSQL 16 or MySQL 8.0) | Cache (Valkey) |
| --- | --- | --- | --- | --- |
| `small-v1` | Small (frozen) | 0.25 vCPU / 512 MiB × 1 task | `db.t4g.micro`, 20 GB (autoscaling to 100 GB), gp2 | `cache.t4g.micro` × 1 |
| `small-v2` | Small | 0.25 vCPU / 512 MiB × 1 task | `db.t3.micro`, 20 GB (autoscaling to 100 GB), gp3 | `cache.t4g.micro` × 1 |
| `medium-v1` | Medium | 1 vCPU / 2 GiB × 1 task | `db.t3.medium`, 20 GB (autoscaling to 100 GB), gp3 | `cache.t4g.small` × 1 |
| `large-v1` | Large | 2 vCPU / 4 GiB × 1 task | `db.t3.large`, 20 GB (autoscaling to 100 GB), gp3 | `cache.t4g.medium` × 1 |

- Each tier maps to one **current** version, which new deployments freeze:
  Small → `small-v2`, Medium → `medium-v1`, Large → `large-v1`
  (`currentInfrastructureSizeProfile`). `small-v1` is frozen for the
  deployments that use it.
- A profile changes capacity only. Every tier compiles the same resource
  graph: two AZs, one NAT gateway, single-AZ RDS with 7-day backups, one
  cache node, one task per workload. Engine and version stay
  manifest-driven constants, never profile fields.
- All classes are current-generation burstable classes that RDS (PostgreSQL
  16 and MySQL 8.0), ElastiCache (Valkey) and Fargate offer in every
  supported Region. `db.t3` (not `db.t4g`) keeps the database class
  available in every supported Region, as `small-v2` does.

## Who chooses the size

| Setting | Who | Where | Rule |
| --- | --- | --- | --- |
| Recommended size (application default) | Vendor | Application configuration › Size presets (Default size) | Small initially. Must be the same as the minimum size or bigger. |
| Minimum supported size | Vendor | Application configuration › Size presets (Minimum allowed size) | Small initially. |
| Link recommendation | Vendor | Creating a public link or an invitation | Preselects the application default. The vendor can override it per link. |
| Deployment size | Customer (public link, invitation) or vendor (vendor-created or TEST deployment, legacy deploy link, checkout) | At creation | Any size at or above the minimum. Frozen afterwards. |

Application settings live in `applications.default_size_profile` and
`applications.minimum_size_profile`. Re-analysis never writes them. A change
applies only to links and deployments created afterwards.

A link freezes its recommendation and minimum when it is created
(`public_install_links.recommended_size_profile` /
`minimum_size_profile`). Later application changes never alter an existing
link. Regenerating a reusable link keeps the replaced link's recommendation
and takes the application's current minimum; a recommendation below that
minimum is raised to it. This is how a vendor moves a live link to a new
minimum.
A link created before sizing existed has both columns null and follows the
application's current settings.

**Selection precedence** (`apps/api/src/deployment-size.ts`,
`resolveSizeSelection`): customer choice → link recommendation →
application default → Deployz default (Small). The minimum is the link's
frozen minimum, else the application's current minimum. A size below the
minimum is refused with `422 SIZE_PROFILE_NOT_ALLOWED`, never raised
silently. A vendor default below the vendor minimum is refused with
`422 SIZE_DEFAULT_BELOW_MINIMUM`.

## Resolution and freezing

- One resolution serves every creation path (`createDeploymentRecord`:
  manual, TEST, legacy deploy link, public link, invitation, checkout
  completion). The resolved profile goes to the planner, the compiler and
  `desired_state.infrastructureProfile = { id, version }` in one step, so the
  preview, the price and the compiled stack use the same profile.
- Footprint, plan and cost resolve through the graph → planner chain from
  the frozen spec, plus **Region + profile id/version + infrastructure
  version** (the compiler footprint when present; `resolveDeploymentFootprint`,
  `buildInstallPlan`, `buildUpdatePlan`, `buildDestroyPlan`).
- A deployment created before the registry has no stored reference and
  resolves to `small-v2` via `resolveStoredInfrastructureSizeProfile`. This
  legacy fallback is pinned: it does not follow later default changes.
- A stored reference that does not resolve to a published profile resolves
  to `undefined`; callers fail closed rather than guess a size.
- Release, rollback, restart, configuration update, destroy and purge reuse
  the frozen compiled artifact, so they never change the size. There is no
  in-place resize: a different size is a new deployment.

## Customer approval: the plan fingerprint

The public install page reads
`GET /api/public-install/:linkId/plan?region=…&profile=small|medium|large`.
The server compiles the deployment intent for that manifest, Region and
profile and returns the compiler's own footprint, the estimate, the
resolved `sizeProfile` and a `planFingerprint`: the sha256 of the link id,
the Region, the exact profile key, the footprint and the estimate. An
unknown size is `422 UNKNOWN_PROFILE`.

The confirmation (`POST /api/public-install/:linkId/confirm`) must carry
`sizeProfile` and `planFingerprint`. Inside the creation transaction the
server compiles the stack it will install, recomputes the fingerprint from
its own state and refuses any difference with `409 PLAN_CHANGED` (a stale
page, an application changed after the review, or an edited request). The
transaction then rolls back, so nothing is created. A replay of the same
idempotency key returns the existing deployment only when its Region and
size match the request; otherwise it is `409 IDEMPOTENCY_KEY_REUSED`. The
install page uses a new key whenever the Region or size changes.

## Footprint and cost estimate

`packages/contracts/src/footprint.ts` derives a versioned
`DeploymentFootprint` (workloads and managed resources with role, category,
service, sizing and lifecycle) from the manifest, the Region and the profile,
reusing `INFRASTRUCTURE_COMPONENTS` for lifecycle rather than a second
table. `packages/contracts/src/pricing.ts` turns it into a monthly AWS cost
estimate: per-service adapters, coarse Region factors, ranges rounded to
whole dollars (totals to $5), with `complete` / `pricingStatus` /
`usageDependent` flags. Sized services price by their size: Fargate by
CPU/memory, RDS (PostgreSQL and MySQL) by instance class, Valkey by node
type. A service or size with no adapter degrades to *unavailable*; nothing
throws and nothing is guessed. Both ride on `DeploymentPlan` as optional
`footprint` and `costEstimate` fields.

The footprint is **derived, never persisted** beyond the compiler's frozen
spec. Pricing is deliberately approximate and labelled as such. The vendor
configuration page shows the resources and the estimate for each size; the
customer install page shows them for the selected size and Region. An
undeployable Region shows *Estimate unavailable* rather than a number.

## Pinning and parity

The compiler tests pin every published profile onto the compiled
CloudFormation: task CPU/memory for web, worker, migration and scheduled
tasks, `DBInstanceClass` for PostgreSQL and MySQL, and `CacheNodeType`.
Compiling with a different profile changes only sizing properties, never
the resource graph. The pricing tests pin the range for every published
size. Editing a sizing value in the registry changes what the compiler
emits, so the tests fail first.

## Changing the registry

- Never edit a published `id` + `version`.
- A new size, or new values for an existing tier, is a new immutable
  version appended to `INFRASTRUCTURE_SIZE_PROFILES`, plus a move of that
  tier in `CURRENT_PROFILE_BY_TIER`, plus pricing ranges for the new
  classes, plus compiler pins, plus a full real-AWS certification of the
  new profile ([`testing/aws-e2e.md`](testing/aws-e2e.md#size-profiles)).
- A topology-changing profile (fewer AZs, no NAT gateway, dropping RDS,
  more than one task) requires a **new infrastructure version** and a
  **security/cost review**; it is not a registry row. In-place resizing,
  autoscaling and arbitrary AWS sizing are post-MVP.
