import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import {
  aiExplanationStateEnum,
  failureCodeEnum,
  jobStateEnum,
  jobTypeEnum,
} from '../enums.js';
import { auditFields, id } from './common.js';
import { deployments } from './deployments.js';

// §39 DeploymentJob — the unit of work the relay executes.
export const deploymentJobs = pgTable('deployment_jobs', {
  id: id(),
  deploymentId: uuid('deployment_id')
    .notNull()
    .references(() => deployments.id),
  // §39 job type (INSTALL … HEALTH_REPORT).
  type: jobTypeEnum('type').notNull(),
  // §39 job state. WAITING: the relay went quiet mid-operation — the
  // watchdog parks the job here instead of failing it, and the relay's next
  // command poll claims it back (see sweepStuckJobs and GET /api/relay/commands).
  state: jobStateEnum('state').notNull().default('REQUESTED'),
  // §39 idempotency: retries with the same key must not double-execute.
  idempotencyKey: text('idempotency_key').notNull().unique(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  result: jsonb('result').$type<Record<string, unknown>>(),
  // §61 stable failure code, set only on FAILED.
  failureCode: failureCodeEnum('failure_code'),
  // Better Auth text user id. No FK by design: job history must outlive
  // user deletion.
  requestedBy: text('requested_by'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  // The last signal that the job is genuinely moving — relay acknowledgement,
  // heartbeat, or reported progress. The watchdog times out from THIS, not
  // updatedAt: a deployment row update says nothing about the job.
  lastProgressAt: timestamp('last_progress_at', { withTimezone: true }),
  // How many times the watchdog re-offered this job to the relay after its
  // runtime bound elapsed (reconcile-before-fail). Bounded; the relay's
  // describe-first executors make a re-offer converge on real AWS state
  // instead of duplicating work.
  reconcileCount: integer('reconcile_count').notNull().default(0),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  // §16/§29 cached AI explanation of this attempt's failure. Generated lazily
  // on the first diagnostics request and served from here afterwards, so a
  // deployment never waits on (or fails because of) the model. Cached on the
  // ATTEMPT rather than the deployment: a later attempt gets its own
  // explanation instead of inheriting a stale one.
  aiExplanationState: aiExplanationStateEnum('ai_explanation_state')
    .notNull()
    .default('PENDING'),
  aiExplanationWhat: text('ai_explanation_what'),
  aiExplanationWhy: text('ai_explanation_why'),
  aiExplanationFix: text('ai_explanation_fix'),
  // How sure the model was (high / medium / low) — the card hedges a
  // medium or low explanation instead of presenting a guess as a verdict.
  aiExplanationConfidence: text('ai_explanation_confidence'),
  // When the GENERATING claim was taken. Lets a later request reclaim a row
  // orphaned by a process that died mid-generation, which would otherwise pin
  // the attempt in GENERATING forever.
  aiExplanationClaimedAt: timestamp('ai_explanation_claimed_at', { withTimezone: true }),
  aiExplanationGeneratedAt: timestamp('ai_explanation_generated_at', {
    withTimezone: true,
  }),
  ...auditFields(),
},
(t) => [
  // §39 operation exclusivity, enforced where it cannot race: at most one
  // active mutating job per deployment. The route-level DEPLOYMENT_BUSY
  // check is a friendly fast path; this index is the correctness backstop
  // for two requests that both pass the check before either inserts.
  // Domain and health/report job types are deliberately outside the guard —
  // they never race an executor over the same stack/service. CONFIG_UPDATE
  // is outside it too: secret delivery (§31 phase 1.2) must be able to queue
  // a config job while an INSTALL/deploy is active (the secret value rides
  // the payload transiently and would otherwise be lost), and the relay
  // executes its commands sequentially anyway — CONFIG_UPDATE still blocks
  // OTHER mutations while active via requireDeploymentIdle.
  uniqueIndex('deployment_jobs_one_active_mutating_uidx')
    .on(t.deploymentId)
    .where(
      sql`${t.state} IN ('REQUESTED', 'QUEUED', 'WAITING', 'RUNNING') AND ${t.type} IN ('INSTALL', 'DEPLOY_RELEASE', 'ROLLBACK', 'RESTART', 'DESTROY', 'MIGRATION', 'INFRA_UPGRADE', 'PURGE')`,
    ),
  // A deployment's job history: the relay heartbeat and command poll, status
  // and detail routes. Postgres does not index a foreign key by itself.
  index('deployment_jobs_deployment_created_idx').on(t.deploymentId, t.createdAt),
  // The watchdog sweep reads active jobs across every deployment.
  index('deployment_jobs_active_state_idx')
    .on(t.state)
    .where(sql`${t.state} IN ('REQUESTED', 'QUEUED', 'WAITING', 'RUNNING')`),
]);
