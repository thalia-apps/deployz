import { sql } from 'drizzle-orm';
import { integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import {
  cleanupStateEnum,
  deploymentBillingStateEnum,
  deploymentSourceEnum,
  deploymentStateEnum,
  deploymentTypeEnum,
  healthStatusEnum,
  regionEnum,
  relayStatusEnum,
} from '../enums.js';
import { organization } from './auth.js';
import { auditFields, id } from './common.js';
import { applications, customers, releases } from './core.js';
import { publicInstallLinks } from './public-install-links.js';

export const deployments = pgTable(
  'deployments',
  {
  id: id(),
  customerId: uuid('customer_id')
    .notNull()
    .references(() => customers.id),
  applicationId: uuid('application_id')
    .notNull()
    .references(() => applications.id),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organization.id),
  region: regionEnum('region').notNull(),
  state: deploymentStateEnum('state').notNull().default('NOT_INSTALLED'),
  // How the deployment row came to be: the vendor's manual flow, a
  // customer-facing Deploy Link, or a customer's public install link confirm.
  // Origin attribution only — no semantics change, the deployment engine
  // treats all three identically.
  source: deploymentSourceEnum('source').notNull().default('manual'),
  // Public install link origin: the link whose confirm created this row plus
  // the customer's idempotency key. Null on every other source. The partial
  // unique index on the pair makes exactly one deployment per (link, key) —
  // a replayed or raced confirm returns the existing deployment.
  publicInstallLinkId: uuid('public_install_link_id').references(() => publicInstallLinks.id),
  confirmKey: text('confirm_key'),
  awsAccountId: text('aws_account_id'),
  currentReleaseId: uuid('current_release_id').references(() => releases.id),
  previousReleaseId: uuid('previous_release_id').references(() => releases.id),
  // The observation time of the last relay evidence that confirmed the
  // current release is the one serving. Also the newest accepted evidence, so
  // an older heartbeat arriving late cannot move the pointer back.
  currentReleaseConfirmedAt: timestamp('current_release_confirmed_at', { withTimezone: true }),
  relayStatus: relayStatusEnum('relay_status').notNull().default('UNKNOWN'),
  // §46 health starts UNKNOWN, not HEALTHY: a deployment that has never
  // checked in has no observed health, and rendering one as healthy is the
  // product asserting something it never measured.
  healthStatus: healthStatusEnum('health_status').notNull().default('UNKNOWN'),
  desiredState: jsonb('desired_state').$type<Record<string, unknown>>().notNull().default({}),
  observedState: jsonb('observed_state').$type<Record<string, unknown>>(),
  // Phase 11 — the Deployz-managed HTTPS state machine (see
  // apps/api/src/default-https.ts). Owned entirely by the control plane: the
  // hostname, certificate and DNS-validation facts for this deployment's
  // default `d-<id>.deployz.dev` endpoint. A separate document from
  // custom_domains because it is NOT customer DNS — the customer never
  // configures or owns it.
  defaultHttps: jsonb('default_https').$type<Record<string, unknown> | null>(),
  // Write-once observational timestamps for the derived deployment `step`
  // (apps/api/src/deployment-status.ts) — NOT a persisted lifecycle. Keyed by
  // DeploymentStep, `{ startedAt, completedAt? }` per step. Populated by
  // apps/api/src/step-timings.ts from the relay-authenticated write paths so
  // the event_logs `deployment.step_completed` stream has a duration to cite.
  stepTimings: jsonb('step_timings').$type<Record<string, { startedAt: string; completedAt?: string }>>(),
  // The vendor's backup-retention choice (days) for a first install that failed
  // creating the database. Null means the template default (7). Read by
  // INSTALL payload building and only for a spec whose template declares the
  // parameter; it never changes a database that already exists.
  backupRetentionDays: integer('backup_retention_days'),
  // The frozen DeploymentSpecV2 (packages/contracts deployment-spec-v2.ts):
  // graph + IR + the compiler's verification contract, ownership records,
  // footprint and the published artifact location. Written once at creation,
  // read by INSTALL payload building, verification, plans and inventory.
  specV2: jsonb('spec_v2').$type<Record<string, unknown>>(),
  infraVersion: text('infra_version').notNull().default('dynamic-compiler-v2'),
  // §12 enrollment. Three identifiers, deliberately separate:
  //   installLinkId  — the only one in a customer-facing URL (/install/:id).
  //   enrollmentCode — single use, carried into the bootstrap stack as a
  //                    template parameter and traded once for a binding.
  //   installationId — the id the RELAY mints for itself inside the customer
  //                    account, unknown until it enrolls, hence nullable.
  // Before this split the install URL carried the relay's own id, so anyone
  // holding the link could register a token of their own and take the
  // deployment over.
  installLinkId: uuid('install_link_id').notNull().unique().defaultRandom(),
  enrollmentCode: text('enrollment_code').notNull().unique(),
  enrollmentUsedAt: timestamp('enrollment_used_at', { withTimezone: true }),
  installationId: text('installation_id').unique(),
  // Retry-isolation fields: the attempt counter keeps Quick Create stack
  // names fresh across retries (a ROLLBACK_COMPLETE stack never blocks the
  // next attempt), bootstrap_stack_name is the expected name of the current
  // attempt, and install_started_at marks when the customer launched AWS.
  attemptNumber: integer('attempt_number').notNull().default(0),
  bootstrapStackName: text('bootstrap_stack_name'),
  installStartedAt: timestamp('install_started_at', { withTimezone: true }),
  // Invitation lifecycle: the customer-facing link is time-limited and
  // vendor-revocable. NULL expiry = no limit (links created before this
  // field existed stay valid, so existing installations are untouched).
  installLinkExpiresAt: timestamp('install_link_expires_at', { withTimezone: true }),
  installLinkRevokedAt: timestamp('install_link_revoked_at', { withTimezone: true }),
  // Phase 5 §9.6: the identifiers a relay/reset REPLACED. A reset nulls
  // installationId and may rename the bootstrap stack, so the previous
  // stack's retained resources stay attributable to this deployment — a
  // later purge carries these to find them instead of silently orphaning.
  previousInstallationId: text('previous_installation_id'),
  previousBootstrapStackName: text('previous_bootstrap_stack_name'),
  // sha256 of the relay's bearer token. Stored (not the plaintext) and in
  // Postgres (not in memory) so a restart cannot reopen the enrollment.
  relayTokenHash: text('relay_token_hash'),
  // DZ-AUDIT-013: server-established relay credential plaintext. Set at
  // deployment creation / relay/reset / install-link retry together with
  // relayTokenHash. NULLed after the relay's first successful registration
  // (the credential has been delivered through the Quick Create URL and is
  // consumed). Re-enrollment mints a fresh one.
  relayCredential: text('relay_credential'),
  // sha256 of the relay token a verified purge revoked. Nothing authenticates
  // with it: only the relay auth check compares a presented token with it, to
  // tell that the connector stack still polls (see connectorLastSeenAt).
  revokedRelayTokenHash: text('revoked_relay_token_hash'),
  // The last poll of a revoked connector. Throttled; null when none arrived.
  connectorLastSeenAt: timestamp('connector_last_seen_at', { withTimezone: true }),
  relayBoundAt: timestamp('relay_bound_at', { withTimezone: true }),
  // Relay identity, reported at enrollment and on every heartbeat. Older
  // relays never report these — they stay null, which the UI reads as
  // "capabilities unknown" and gates unsupported actions on.
  relayVersion: text('relay_version'),
  bootstrapVersion: text('bootstrap_version'),
  relayCapabilities: jsonb('relay_capabilities').$type<Record<string, boolean>>(),
  // Provider-independent classification (Paddle migration Phase 2). Replaces
  // the is_test_deployment boolean — a TEST deployment never becomes
  // billable (apps/api/src/billing-domain.ts).
  deploymentType: deploymentTypeEnum('deployment_type').notNull().default('PRODUCTION'),
  // Billing state machine, driven by apps/api/src/billing-lifecycle.ts.
  // Write-once timestamps: once set, a transition never overwrites them.
  billingState: deploymentBillingStateEnum('billing_state').notNull().default('NOT_STARTED'),
  billingStartedAt: timestamp('billing_started_at', { withTimezone: true }),
  billingStoppedAt: timestamp('billing_stopped_at', { withTimezone: true }),
  lastHealthAt: timestamp('last_health_at', { withTimezone: true }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  // Null on a normal disconnect (relay removed the resources). Set only when
  // the control plane knows something about the AWS-side leftovers.
  cleanupState: cleanupStateEnum('cleanup_state'),
  ...auditFields(),
  },
  (t) => [
    // Structural guarantee for the free-evaluation entitlement (Paddle
    // migration Phase 7): at most one non-deleted TEST deployment per
    // application. Retries and recreates are allowed once the previous one
    // is DELETED. The route-level check in apps/api/src/billing-entitlements.ts
    // is the friendly fast path; this partial unique index is the correctness
    // backstop for two concurrent creates that both pass the check before
    // either inserts.
    uniqueIndex('deployments_one_active_test_per_application_uidx')
      .on(t.applicationId)
      .where(sql`${t.deploymentType} = 'TEST' AND ${t.state} <> 'DELETED'`),
    // Confirm idempotency for public install links: one deployment per
    // (link, key) pair. Both columns stay null on every other source.
    uniqueIndex('deployments_public_install_confirm_uidx')
      .on(t.publicInstallLinkId, t.confirmKey)
      .where(sql`${t.publicInstallLinkId} IS NOT NULL AND ${t.confirmKey} IS NOT NULL`),
  ],
);
