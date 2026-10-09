-- Checks started by hand or created as test checks were stored without a module (IPQC/QC), so
-- workers limited to IPQC or QC could not open them. Every check now carries one.
UPDATE "quality_checks" qc SET "module" = COALESCE(
  (SELECT s."module" FROM "schedules" s WHERE s."id" = qc."schedule_id"),
  (SELECT a."module" FROM "activities" a WHERE a."id" = qc."activity_id"),
  'IPQC'
)
WHERE qc."module" IS NULL;
--> statement-breakpoint
ALTER TABLE "quality_checks" ALTER COLUMN "module" SET NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "quality_checks_worker_status_idx" ON "quality_checks" USING btree ("worker_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "quality_checks_submitted_by_idx" ON "quality_checks" USING btree ("submitted_by_id", "submitted_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "quality_checks_department_scheduled_idx" ON "quality_checks" USING btree ("department_id", "scheduled_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "quality_check_values_check_idx" ON "quality_check_values" USING btree ("check_id");
--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN IF NOT EXISTS "content_sha256" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "media_content_sha256_idx" ON "media" USING btree ("content_sha256");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "media_check_idx" ON "media" USING btree ("check_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "media_exception_idx" ON "media" USING btree ("exception_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "revoked_tokens" (
  "jti" text PRIMARY KEY NOT NULL,
  "user_id" uuid REFERENCES "users"("id") ON DELETE CASCADE,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- One report-sharing settings row only (two requests at the same moment could insert two).
DO $$ BEGIN
  IF (SELECT count(*) FROM "report_email_settings") <= 1 THEN
    CREATE UNIQUE INDEX IF NOT EXISTS "report_email_settings_singleton_idx" ON "report_email_settings" ((true));
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "quality_checks_open_window_idx" ON "quality_checks" USING btree ("window_ends_at") WHERE "quality_checks"."status" in ('PENDING', 'DUE', 'IN_PROGRESS');
