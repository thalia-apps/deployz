CREATE TABLE IF NOT EXISTS "deployment_owners" (
	"deployment_id" uuid PRIMARY KEY NOT NULL REFERENCES "deployments"("id"),
	"email" text NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customer_email_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"deployment_id" uuid NOT NULL REFERENCES "deployments"("id"),
	"flow_hash" text NOT NULL,
	"code_hmac" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_email_challenges_email_created_idx" ON "customer_email_challenges" ("email","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_email_challenges_flow_idx" ON "customer_email_challenges" ("flow_hash");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customer_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL UNIQUE,
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
