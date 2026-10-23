# Product telemetry

This document is the reference for Deployz MVP product telemetry: the
`event_logs` vocabulary, privacy rules, funnel semantics, and the Pilot
Insights view.

## Goal

Product telemetry answers one question:

> Can a supported SaaS vendor get from repository → analysis → AWS →
> HEALTHY without Deployz-team intervention, and where do they get stuck?

It does not measure generic engagement. There are no page-view events, no
third-party analytics (PostHog/Mixpanel/Amplitude), no warehouse/ETL, and no
separate telemetry service. The append-only, immutable `event_logs` table
(`packages/db/src/schema/events.ts`; UPDATE/DELETE rejected by DB trigger)
is the single source of truth.

## Event vocabulary

Every event is written through the typed helper `recordEvent` in
`apps/api/src/events.ts` (transactional with the state change wherever one
exists). The build worker (`packages/cdk/src/lambda/worker.ts`) cannot import
that module and writes its rows directly — same table, same payload contract.

Families that predate the MVP telemetry work (unchanged): `install.*`,
`deploy.*`, `rollback.*`, `restart.*`, `destroy.*`, `purge.*`, `config.*`,
`health.*`, `domain.*`, `deployment.step_completed`, `operation.*`,
`deploy_link.*`, `ecs.*`, admin audit (`admin.*`).

Added for the MVP funnel:

| Event | Emitted | Key payload fields |
| --- | --- | --- |
| `application.created` | application insert (tx) | `applicationId` |
| `application.analysis_started` | analysis trigger route (tx) | `applicationId` |
| `application.analysis_completed` | analysis status → COMPLETE (tx; full run and cache hit, `cached: true` on hit) | `applicationId`, `analysisVersion`, `runtime?`, `readiness`, `compatibility`, `findingCount`, `blockingCount`, `durationMs`, `cached?` |
| `application.analysis_failed` | analysis status → FAILED (tx) | `applicationId`, `failureCode`, `durationMs` |
| `application.preflight_evaluated` | preflight gates a provisioning action only — deploy-link creation, install launch, deploy-link launch, relay register. Read endpoints never emit. | `applicationId`, `result: 'pass'\|'blocked'`, `blockingCount`, `warningCount` |
| `application.configuration_saved` | successful config save | `applicationId`, `changedKeyCount` (count only — never keys or values) |
| `application.analysis_disputed` | the vendor marks an allowlisted blocker as "not used in production" (tx) | `applicationId`, `findingId`, `analysisVersion`, `analysisEngine`, `analysisCommitSha?` (never the evidence text) |
| `application.analysis_dispute_withdrawn` | the vendor undoes that answer (tx) | `applicationId`, `findingId`, `wasStale` |
| `customer.created` | customer insert (tx) | `customerId` (also the `customer_id` column) |
| `deployment.created` | deployment insert, every origin | `source: 'manual' \| 'deploy_link' \| 'public_link'` (mirrors `deployments.source`) |
| `relay.connected` | first successful relay enrollment (inside the register tx) | — (`deployment_id` column is the join key) |
| `release.created` | release insert (tx) | `applicationId` |
| `release.build_started` | build worker pins BUILDING (tx) | `applicationId` |
| `release.build_completed` | CodeBuild SUCCEEDED → READY (tx) | `applicationId` |
| `release.build_failed` | FAILED/CANCELLED/TIMED_OUT, pre-build failure, stuck-build sweep | `applicationId`, `failureCode` |

`event_logs` has no `application_id` column by design — application-scope
events carry `payload.applicationId`. Do not add the column without evidence
that critical queries need it.

## Privacy rules

Telemetry payloads never contain: environment variable values, generated
secrets, database passwords, AWS credentials, relay tokens, invitation raw
tokens, GitHub tokens, customer secrets, raw application logs, unredacted
relay diagnostics, or raw AI prompts/responses. Counts, stable codes, and
ids that already exist as row columns are the only payload content — for
example `changedKeyCount: 3`, never the configuration itself.

## Failure telemetry

Failures use stable, deterministic `failureCode` values — never exception
text or AI explanations (those stay on the vendor-facing columns):

- Analysis: `repository_unavailable`, `github_disabled`,
  `github_installation_missing`, `github_rate_limited`, `github_unavailable`,
  `internal_error`.
- Release build: `build_failed`, `build_cancelled`, `build_timeout`,
  `build_registry_rate_limited`.
- Install/deploy: the 24 stable failure codes from the job result payloads
  (`FAILURE_CODES` in `packages/copy-map`; for example
  `STACK_CREATE_FAILED`, `IMAGE_PULL_FAILED`).

## Funnel semantics

Metrics count distinct domain entities, never raw events. Semantics
implemented in `getOverviewPilotInsights` (`apps/api/src/admin/queries.ts`):

- Applications created — distinct `payload.applicationId` on
  `application.created`.
- Analysis completed — distinct applications with ≥ 1
  `application.analysis_completed` (repeated analyses count once).
- Ready to provision — distinct applications with ≥ 1 **pass**
  `application.preflight_evaluated`.
- AWS launched — distinct deployments with `install.launched`,
  `deploy_link.launched`, or `invitation.confirmed`.
- Relay connected — distinct deployments with `relay.connected`.
- Healthy — distinct deployments with `install.completed` and
  `result: 'success'` (a failed install then successful retry counts once,
  in both numerator and denominator).
- Invitation funnel — the same milestones restricted to deployments that
  originated from an invitation (`invitation.created` → `invitation.confirmed`
  → `install.launched` → `install.completed`). Legacy deploy-link
  deployments are tracked through the `deploy_link.*` milestones until the
  legacy path is removed.

## Origin attribution

`deployments.source` (`manual` | `deploy_link` | `public_link`) is written
once at creation. `deployment.created` mirrors it in `payload.source`, so
funnel queries can split manual vs invitation vs legacy deploy-link
performance without a join. Invitation performance is read from the
`invitation.*` milestones; legacy deploy-link performance from the
`deploy_link.*` milestones.

## Support intervention

A deployment **required Deployz-team intervention** when either:

1. An admin recovery action targeted it — `admin.install.retry_requested`,
   `admin.rollback.requested`, `admin.destroy.force_completed`, or
   `admin.relay.reset_requested` with `payload.targetType: 'deployment'` and
   `payload.targetId` = the deployment id; or
2. It became healthy while its organization had an
   `admin.support_session.started` in the window — support sessions are
   vendor-level, so every healthy deployment of that vendor counts as
   supported (documented imprecision; per-deployment precision is not
   fabricatable from the data).

"Healthy without support" = healthy deployments minus intervened ones.

## Durations

All durations derive from existing event timestamps; there is no separate
timing table. `deployment.step_completed` rows stay the source for
per-step provisioning timings.

- Time to healthy: earliest launch (`install.launched`, or
  `deploy_link.launched` when absent) → earliest successful
  `install.completed`, per deployment, both inside the window.
- Analysis duration: wall clock of the analysis run (entry → persist); there
  is no dedicated started/finished row timestamp.
- P90 is only reported at ≥ 10 duration samples; below that the UI shows a
  small-sample hint and the API returns `null`.

## Pilot Insights

A compact section on the Team Admin Overview (`/admin`) — five cards:
pilot funnel (with stage conversion), deployment quality, common failures,
invitations, support. `7d | 30d | 90d` toggle (default 30) drives
`GET /api/admin/overview?days=…`, which returns the `pilotInsights` block.
Team-admin only (`requireTeamAdmin`); no telemetry is vendor-visible. The
funnel counts use the semantics above, so retries and repeated opens cannot
inflate them, and conversion is suppressed when the previous stage is zero.

This is a pilot-readiness support component. Team Admin remains an
operational console, not a generic analytics or back-office platform.

## Known limitations

- Analysis `durationMs` is wall clock of the run, not a persisted
  started/finished pair.
- A redelivered `BUILD_RELEASE` message re-runs `buildRelease`, which can
  re-emit `release.build_started` (and on its pre-build failure path a second
  `release.build_failed`) for the same release — the same redelivery
  behaviour the build flow already had, now observable. The stuck-build sweep
  emits at most once per release.
- `release.build_failed` rows carry `release_id`, not `deployment_id`, so
  they contribute to failure counts but not to "deployments affected".
- Relay-register blocked preflight evaluations are throttled to one event per
  deployment per 15-minute window (a refused relay retries indefinitely;
  see `RELAY_BLOCKED_PREFLIGHT_THROTTLE_MS` in `apps/api/src/server.ts`).
- Blocked deploy-link creations do not persist a preflight event (the
  aborted creation transaction rolls it back); manual-creation blocks do
  persist.
- Support-session attribution is vendor-level (see above).
