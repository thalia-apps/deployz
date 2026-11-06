CREATE TABLE IF NOT EXISTS "rate_limit" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rate_limit_key_idx" ON "rate_limit" ("key");
