import { sql } from 'drizzle-orm';
import { bigserial, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { deployments } from './deployments.js';
import { deploymentJobs } from './jobs.js';

// Raw CloudFormation stack events reported by the relay while it waits for a
// stack operation. Progress/diagnostics only — never an input to lifecycle
// decisions. Uniqueness on (deployment, provider event id) makes ingestion
// idempotent across relay retries and Lambda restarts.
export const deploymentStackEvents = pgTable(
  'deployment_stack_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    deploymentId: uuid('deployment_id')
      .notNull()
      .references(() => deployments.id),
    jobId: uuid('job_id').references(() => deploymentJobs.id),
    providerEventId: text('provider_event_id').notNull(),
    eventAt: timestamp('event_at', { withTimezone: true }).notNull(),
    logicalResourceId: text('logical_resource_id').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceStatus: text('resource_status').notNull(),
    resourceStatusReason: text('resource_status_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('deployment_stack_events_dedupe_uidx').on(table.deploymentId, table.providerEventId),
    index('deployment_stack_events_deployment_idx').on(table.deploymentId, table.eventAt),
    index('deployment_stack_events_job_idx')
      .on(table.jobId, table.eventAt)
      .where(sql`${table.jobId} IS NOT NULL`),
  ],
);
