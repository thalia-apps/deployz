# Deployz documentation

The documentation set for the Deployz MVP. Each area has one authoritative
document; other documents link to it instead of repeating it. The documents
describe the product **as implemented** and were verified against the code
on 2026-09-24; intended-but-unbuilt behavior is labelled as a gap or a
deferred item. Live operator settings (which Regions are enabled, whether
production billing is switched on) are held in GitHub repository variables,
not here.

## Start here

| Question | Read |
| --- | --- |
| What is Deployz, what does the MVP do, what is out of scope? | [`product/mvp-scope.md`](product/mvp-scope.md) |
| What does a vendor do, what does a customer do, who configures what, who picks the Region? | [`product/user-flows.md`](product/user-flows.md) |
| How is it built, what runs in which AWS account, what does a deployment create? | [`architecture.md`](architecture.md) |
| How to work in this repository (layout, commands, CI) | [`../README.md`](../README.md) |
| Rules for coding agents | [`../CLAUDE.md`](../CLAUDE.md) |

## Authoritative documents by area

| Area | Document | Covers |
| --- | --- | --- |
| Product scope | [`product/mvp-scope.md`](product/mvp-scope.md) | Principles, supported architecture, non-goals, known limitations, deferred items |
| User journeys | [`product/user-flows.md`](product/user-flows.md) | Vendor and customer flows, entry points, configuration ownership, Region choice |
| UX program | [`product/ux-excellence-charter.md`](product/ux-excellence-charter.md) | How the UX Excellence workstream operates: simplification rule, mental models, state design, backend boundary, agent model, phase gates |
| UX target | [`product/ux-guidelines.md`](product/ux-guidelines.md) | What the Deployz UX must be: journeys, information architecture, primary actions, terminology, status model, disclosure, recovery, progress, shared primitives, UX-BACKEND items |
| Architecture | [`architecture.md`](architecture.md) | Control plane and customer side, the live flow, template selection, components and plans, trust boundaries, disconnect/purge/retained data |
| Deployment lifecycle | [`deployment-resilience.md`](deployment-resilience.md) | States, failed-update semantics, idempotency and exclusivity, watchdog and reconciliation, failure classification, first-install recovery, health promotion |
| Analysis and AI | [`ai-analysis.md`](ai-analysis.md) | Detectors, the canonical model, compatibility findings, fix instructions, env-var classification, preflight, failure diagnosis, AI configuration and testing |
| Environment variables | [`environment-variables.md`](environment-variables.md) | Detection, per-variable decisions, where values go, security notes |
| Secrets and KMS | [`pending-secret-delivery.md`](pending-secret-delivery.md) | Cipher contract, the KMS key, pending-secret delivery, threat model, accepted plaintext paths |
| Networking and HTTPS | [`networking-and-https.md`](networking-and-https.md) | VPC layout, default `d-*` URL, Cloudflare records, ACM, custom domains, teardown |
| Sizing and cost | [`infrastructure-profiles.md`](infrastructure-profiles.md) | The immutable profile registry, footprint, cost estimate, parity |
| Customer entry points | [`installation-invitations.md`](installation-invitations.md), [`deploy-links.md`](deploy-links.md) | Public links and invitations; the legacy deploy link |
| Operating the control plane | [`operations/control-plane.md`](operations/control-plane.md) | CI-only deploys, promotion and the production approval, rollback, configuration keys, migrations, publishing templates, enabling a Region, release builds, local development |
| Troubleshooting | [`operations/troubleshooting.md`](operations/troubleshooting.md) | Where to look, failure codes and recoverability, stuck operations, common situations, test-account hygiene |
| Docker Hub credentials | [`docker-hub-credentials.md`](docker-hub-credentials.md) | Authenticated base-image pulls for release builds |
| Testing | [`testing/README.md`](testing/README.md) | The testing strategy, the coverage matrix, and every testing document |
| Billing | [`billing/paddle-billing.md`](billing/paddle-billing.md) | Commercial model, entitlements, allowance, configuration; [`billing/billing-matrix.md`](billing/billing-matrix.md) decision tables; [`billing/paddle-catalog.md`](billing/paddle-catalog.md) prices |
| Team Admin | [`admin/team-admin.md`](admin/team-admin.md) | Scope, routes, authorization, support sessions, recovery actions, audit |
| Telemetry | [`product-telemetry.md`](product-telemetry.md) | Event vocabulary, privacy rules, funnel semantics, Pilot Insights |
| UI system | [`ui-system.md`](ui-system.md) | shadcn conventions, status vocabulary, page anatomy |
| Decisions | [`decisions/README.md`](decisions/README.md) | Why the architecture is shaped the way it is; [`decisions/deploy-gate.md`](decisions/deploy-gate.md), [`decisions/failed-install-recovery.md`](decisions/failed-install-recovery.md) |

## Conventions

- **Current vs intended.** When the implementation differs from the intended
  behavior, the document says so in place ("known gap") rather than
  describing the intent as fact. Code gaps are tracked in the pull request
  that found them, not in a standing document.
- **No implementation plans or run reports.** Completed plans, phase
  ledgers, audits and one-off canary reports are removed once their durable
  knowledge has moved into the documents above; git history keeps them.
  Exceptions are the benchmark finding registries under `testing/`, which
  the harnesses and tests read.
- **Names, never values.** Configuration keys are documented by name only.
- **Generated files.** `testing/*/runs/summary.md` files are written by the
  harness scripts; do not edit them by hand.
- **Language.** Instructions are written in Simplified Technical English
  (ASD-STE100): short sentences, one instruction each, active voice.
