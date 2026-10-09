ALTER TABLE "report_email_settings" ADD COLUMN IF NOT EXISTS "frequency_minutes" integer DEFAULT 60;
--> statement-breakpoint
ALTER TABLE "report_email_settings" ADD COLUMN IF NOT EXISTS "frequency_mode" text DEFAULT 'INTERVAL';
--> statement-breakpoint
ALTER TABLE "report_email_settings" ADD COLUMN IF NOT EXISTS "scheduled_time" text;
