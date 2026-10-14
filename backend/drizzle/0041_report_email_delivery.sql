CREATE TABLE "report_email_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"log_id" uuid NOT NULL,
	"failed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"error_message" text,
	"failed_recipients" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"alert_email_status" text,
	"alert_email_to" text,
	"alert_email_error" text,
	"alert_email_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"read_by_id" uuid,
	"dismissed_at" timestamp with time zone,
	"dismissed_by_id" uuid,
	CONSTRAINT "report_email_alerts_log_id_unique" UNIQUE("log_id")
);
--> statement-breakpoint
ALTER TABLE "report_email_logs" ALTER COLUMN "status" SET DEFAULT 'PENDING';--> statement-breakpoint
ALTER TABLE "report_email_logs" ADD COLUMN "recipient_status" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "report_email_logs" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "report_email_logs" ADD COLUMN "last_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "report_email_logs" ADD COLUMN "next_retry_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "report_email_logs" ADD COLUMN "failure_kind" text;--> statement-breakpoint
ALTER TABLE "report_email_logs" ADD COLUMN "recovered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "report_email_logs" ADD COLUMN "message_id" text;--> statement-breakpoint
ALTER TABLE "report_email_settings" ADD COLUMN "failure_alert_email" text;--> statement-breakpoint
ALTER TABLE "report_email_alerts" ADD CONSTRAINT "report_email_alerts_log_id_report_email_logs_id_fk" FOREIGN KEY ("log_id") REFERENCES "public"."report_email_logs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_email_alerts" ADD CONSTRAINT "report_email_alerts_read_by_id_users_id_fk" FOREIGN KEY ("read_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_email_alerts" ADD CONSTRAINT "report_email_alerts_dismissed_by_id_users_id_fk" FOREIGN KEY ("dismissed_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "report_email_logs_retry_idx" ON "report_email_logs" USING btree ("status","next_retry_at");--> statement-breakpoint
-- Rows from before delivery tracking: SUCCESS meant the mail server took the email, so they are SENT;
-- every one of them was handed to the mail server once.
UPDATE "report_email_logs" SET "status" = 'SENT' WHERE "status" = 'SUCCESS';--> statement-breakpoint
UPDATE "report_email_logs" SET "attempts" = 1, "last_attempt_at" = "sent_at" WHERE "attempts" = 0;
