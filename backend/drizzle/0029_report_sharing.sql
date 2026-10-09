CREATE TABLE IF NOT EXISTS "report_email_settings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "is_enabled" boolean NOT NULL DEFAULT false,
  "frequency_hours" integer NOT NULL DEFAULT 1,
  "percentage" integer NOT NULL DEFAULT 20,
  "recipients" text[] NOT NULL DEFAULT ARRAY[]::text[],
  "last_run_at" timestamp with time zone,
  "next_run_at" timestamp with time zone,
  "smtp_host" text,
  "smtp_port" integer DEFAULT 587,
  "smtp_secure" boolean DEFAULT false,
  "smtp_user" text,
  "smtp_pass" text,
  "smtp_from" text,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "report_email_logs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "trigger" text NOT NULL DEFAULT 'AUTO',
  "status" text NOT NULL DEFAULT 'SUCCESS',
  "recipients" text[] NOT NULL,
  "subject" text NOT NULL,
  "check_ids" uuid[] NOT NULL,
  "checks_count" integer NOT NULL DEFAULT 0,
  "period_from" timestamp with time zone,
  "period_to" timestamp with time zone,
  "percentage" integer,
  "pdf_size_bytes" integer,
  "video_count" integer DEFAULT 0,
  "error_message" text,
  "sent_at" timestamp with time zone NOT NULL DEFAULT now(),
  "sent_by_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "sent_by_name" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "report_email_logs_sent_at_idx" ON "report_email_logs" ("sent_at");
