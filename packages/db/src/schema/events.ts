import { sql } from 'drizzle-orm';
import { bigserial, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

// §40 EventLog — the APPEND-ONLY audit stream.
//
// Starter event_type families (todo 36 runs the completeness scan):
//   install.*   deploy.*   rollback.*   config.*   destroy.*   health.*   billing.*
//
// §62 payload contract: who (actor_type/actor_id) / when (occurred_at) /
// customer / previous state / requested state / release / job ID / result.
//
// Immutability is enforced by the `event_logs_immutable` plpgsql trigger
// installed by drizzle/0001_event_logs_immutable.sql (UPDATE + DELETE +
// TRUNCATE all raise). A REVOKE-based guard is not possible against PGlite's
// single role, so the trigger IS the enforcement and event-logs.test.ts
// proves it.
//
// No foreign keys and no updated_at BY DESIGN: audit rows must survive
// deletion of the entities they reference, and append-only rows never update.
export const eventLogs = pgTable('event_logs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  actorType: text('actor_type').notNull(),
  actorId: text('actor_id').notNull(),
  organizationId: text('organization_id').notNull(),
  customerId: uuid('customer_id'),
  deploymentId: uuid('deployment_id'),
  jobId: uuid('job_id'),
  releaseId: uuid('release_id'),
  eventType: text('event_type').notNull(),
  previousState: text('previous_state'),
  requestedState: text('requested_state'),
  result: text('result'),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
},
(t) => [
  // A deployment's timeline (newest first) and the per-deployment throttle checks.
  index('event_logs_deployment_occurred_idx')
    .on(t.deploymentId, t.occurredAt.desc(), t.id.desc())
    .where(sql`${t.deploymentId} IS NOT NULL`),
  // Organization activity and the invitation rate limit.
  index('event_logs_organization_occurred_idx').on(t.organizationId, t.occurredAt.desc()),
]);
