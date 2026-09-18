ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "item_code" text;--> statement-breakpoint
ALTER TABLE "quality_checks" ADD COLUMN IF NOT EXISTS "item_code" text;