ALTER TABLE "report_email_settings" ADD COLUMN "daily_report_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "report_email_settings" ADD COLUMN "daily_report_time" text DEFAULT '08:30' NOT NULL;--> statement-breakpoint
ALTER TABLE "report_email_settings" ADD COLUMN "daily_report_last_date" text;