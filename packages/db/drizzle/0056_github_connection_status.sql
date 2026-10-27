ALTER TABLE "github_installations" ADD COLUMN IF NOT EXISTS "account_id" text;--> statement-breakpoint
ALTER TABLE "github_installations" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "github_installations" ADD COLUMN IF NOT EXISTS "disconnected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "github_installations" ADD COLUMN IF NOT EXISTS "disconnected_by" text;
