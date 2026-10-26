CREATE INDEX IF NOT EXISTS "deployment_jobs_deployment_created_idx" ON "deployment_jobs" ("deployment_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deployment_jobs_active_state_idx" ON "deployment_jobs" ("state") WHERE "deployment_jobs"."state" IN ('REQUESTED', 'QUEUED', 'WAITING', 'RUNNING');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deployment_stack_events_job_idx" ON "deployment_stack_events" ("job_id","event_at") WHERE "deployment_stack_events"."job_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "event_logs_deployment_occurred_idx" ON "event_logs" ("deployment_id","occurred_at" DESC,"id" DESC) WHERE "event_logs"."deployment_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "event_logs_organization_occurred_idx" ON "event_logs" ("organization_id","occurred_at" DESC);
