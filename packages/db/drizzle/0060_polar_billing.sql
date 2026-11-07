-- Billing moves from Paddle to Polar (docs/billing/polar-billing.md).
--
-- billing_provider gains POLAR. NOT `ALTER TYPE ... ADD VALUE`: Postgres
-- refuses to USE a value added that way until the adding transaction has
-- committed, and drizzle applies every pending migration inside ONE
-- transaction (see 0006). Replacing the type lifts the restriction.
--
-- No real customer ever paid through Paddle, so every Paddle subscription is
-- closed (CANCELED) and every parked Paddle checkout (a txn_ id) expires. A CANCELED row is the
-- state from which the webhook accepts a new subscription for the same
-- organization, so a test organization re-subscribes through Polar with no
-- other change. Paddle rows stay as history.
ALTER TYPE "public"."billing_provider" RENAME TO "billing_provider_old";--> statement-breakpoint
CREATE TYPE "public"."billing_provider" AS ENUM('PADDLE', 'POLAR');--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ALTER COLUMN "provider" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ALTER COLUMN "provider" TYPE "public"."billing_provider" USING "provider"::text::"public"."billing_provider";--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ALTER COLUMN "provider" SET DEFAULT 'POLAR';--> statement-breakpoint
ALTER TABLE "billing_provider_events" ALTER COLUMN "provider" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "billing_provider_events" ALTER COLUMN "provider" TYPE "public"."billing_provider" USING "provider"::text::"public"."billing_provider";--> statement-breakpoint
ALTER TABLE "billing_provider_events" ALTER COLUMN "provider" SET DEFAULT 'POLAR';--> statement-breakpoint
ALTER TABLE "billing_checkout_intents" ALTER COLUMN "provider" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "billing_checkout_intents" ALTER COLUMN "provider" TYPE "public"."billing_provider" USING "provider"::text::"public"."billing_provider";--> statement-breakpoint
ALTER TABLE "billing_checkout_intents" ALTER COLUMN "provider" SET DEFAULT 'POLAR';--> statement-breakpoint
DROP TYPE "public"."billing_provider_old";--> statement-breakpoint
UPDATE "billing_subscriptions" SET "status" = 'CANCELED', "scheduled_change_action" = NULL, "scheduled_change_at" = NULL WHERE "provider" = 'PADDLE' AND "status" <> 'CANCELED';--> statement-breakpoint
UPDATE "billing_checkout_intents" SET "status" = 'EXPIRED', "resolved_at" = now() WHERE "status" = 'PENDING' AND ("provider_transaction_id" IS NULL OR "provider_transaction_id" LIKE 'txn\_%');
