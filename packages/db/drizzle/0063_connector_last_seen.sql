ALTER TABLE "deployments" ADD COLUMN "revoked_relay_token_hash" text;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "connector_last_seen_at" timestamp with time zone;
