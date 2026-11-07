import { sql } from 'drizzle-orm';
import { integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import {
  billingCheckoutIntentStatusEnum,
  billingEventProcessingStatusEnum,
  billingProviderEnum,
  billingReconciliationStatusEnum,
  billingSubscriptionStatusEnum,
  infrastructureSizeTierEnum,
  regionEnum,
} from '../enums.js';
import { organization } from './auth.js';
import { createdAt, id, updatedAt } from './common.js';
import { applications, customers } from './core.js';
import { deployments } from './deployments.js';

// Paddle migration Phase 3 — minimal billing schema. `provider` exists so a
// row says what it is, nothing more; this is not a multi-provider system.

// One row per organization. No row means evaluation mode (no subscription
// yet). Written by the Phase 6 webhook handler.
export const billingSubscriptions = pgTable('billing_subscriptions', {
  id: id(),
  organizationId: text('organization_id')
    .notNull()
    .unique()
    .references(() => organization.id),
  provider: billingProviderEnum('provider').notNull().default('POLAR'),
  providerCustomerId: text('provider_customer_id').notNull(),
  providerSubscriptionId: text('provider_subscription_id').notNull().unique(),
  status: billingSubscriptionStatusEnum('status').notNull(),
  currentPeriodStart: timestamp('current_period_start', { withTimezone: true }),
  currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
  // A pending change (Polar: cancel at the period end) already
  // accepted for this subscription, with its effective date. Null when
  // nothing is scheduled. Written by the Phase 6 webhook handler.
  scheduledChangeAction: text('scheduled_change_action'),
  scheduledChangeAt: timestamp('scheduled_change_at', { withTimezone: true }),
  lastProviderEventAt: timestamp('last_provider_event_at', { withTimezone: true }),
  lastReconciledAt: timestamp('last_reconciled_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// Raw webhook event log. `providerEventId` unique so a redelivered webhook is
// dedupe-checked at the database, not only in application code.
export const billingProviderEvents = pgTable('billing_provider_events', {
  id: id(),
  provider: billingProviderEnum('provider').notNull().default('POLAR'),
  providerEventId: text('provider_event_id').notNull().unique(),
  eventType: text('event_type').notNull(),
  organizationId: text('organization_id').references(() => organization.id),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  processedAt: timestamp('processed_at', { withTimezone: true }),
  processingStatus: billingEventProcessingStatusEnum('processing_status')
    .notNull()
    .default('RECEIVED'),
  error: text('error'),
  createdAt: createdAt(),
});

// One row per reconciliation pass (Phase 9): what the control plane expected
// to bill vs what the provider reports, and what action (if any) was taken.
export const billingReconciliationEvents = pgTable('billing_reconciliation_events', {
  id: id(),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organization.id),
  expectedDeploymentQuantity: integer('expected_deployment_quantity').notNull(),
  providerDeploymentQuantity: integer('provider_deployment_quantity'),
  action: text('action').notNull(),
  status: billingReconciliationStatusEnum('status').notNull(),
  error: text('error'),
  createdAt: createdAt(),
});

// Paddle migration Phase 8 — a production deployment the vendor asked for
// before the organization had a subscription. No deployment row exists yet:
// the parameters live here until the subscription activates, so no install
// link and no AWS provisioning can start before the vendor has paid. The
// webhook then creates the deployment and marks the intent COMPLETED.
export const billingCheckoutIntents = pgTable(
  'billing_checkout_intents',
  {
    id: id(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id),
    // Nullable for subscribe-only intents (invitation-first flow): no
    // deployment request is parked, so activation only starts the
    // subscription. When any is set, all three are set together.
    applicationId: uuid('application_id').references(() => applications.id),
    customerId: uuid('customer_id').references(() => customers.id),
    region: regionEnum('region'),
    // The size the vendor chose for the parked deployment; null = the
    // application default when the checkout completes.
    sizeProfile: infrastructureSizeTierEnum('size_profile'),
    provider: billingProviderEnum('provider').notNull().default('POLAR'),
    // The Polar checkout id. Null only in the instant between the row insert
    // and Polar creating the checkout — the webhook binds the subscription to
    // this intent through it, so the row must exist first.
    providerTransactionId: text('provider_transaction_id').unique(),
    status: billingCheckoutIntentStatusEnum('status').notNull().default('PENDING'),
    // The deployment this intent became, once resumed.
    deploymentId: uuid('deployment_id').references(() => deployments.id),
    error: text('error'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdBy: text('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // One PENDING intent per organization: activation resumes every pending
    // intent, so two of them would provision two deployments for one
    // checkout. A new checkout supersedes the previous one instead.
    uniqueIndex('billing_checkout_intents_one_pending_per_organization_uidx')
      .on(t.organizationId)
      .where(sql`${t.status} = 'PENDING'`),
  ],
);
