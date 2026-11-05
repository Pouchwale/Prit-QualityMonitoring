ALTER TABLE "leave_requests" ADD COLUMN "requested_time" text;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD COLUMN "affects_from" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD COLUMN "affects_to" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD COLUMN "tasks_removed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD COLUMN "tasks_removed" integer;--> statement-breakpoint
ALTER TABLE "leave_types" ADD COLUMN "kind" text DEFAULT 'LEAVE' NOT NULL;--> statement-breakpoint
ALTER TABLE "quality_checks" ADD COLUMN "leave_request_id" uuid;--> statement-breakpoint
ALTER TABLE "quality_checks" ADD CONSTRAINT "quality_checks_leave_request_id_leave_requests_id_fk" FOREIGN KEY ("leave_request_id") REFERENCES "public"."leave_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Late Entry and Early Exit: today only, with a time; no quota, no half days, no custom name.
UPDATE "leave_types" SET "kind" = 'LATE_ENTRY', "annual_quota" = NULL, "allow_half_day" = false, "is_custom" = false, "max_consecutive_days" = NULL, "advance_notice_days" = 0, "carry_forward_max" = 0
WHERE "code" = 'LE' OR lower("name") = 'late entry';--> statement-breakpoint
UPDATE "leave_types" SET "kind" = 'EARLY_EXIT', "annual_quota" = NULL, "allow_half_day" = false, "is_custom" = false, "max_consecutive_days" = NULL, "advance_notice_days" = 0, "carry_forward_max" = 0
WHERE "code" = 'EE' OR lower("name") = 'early exit';--> statement-breakpoint
INSERT INTO "leave_types" ("name", "code", "annual_quota", "is_paid", "allow_half_day", "sort_order", "kind")
SELECT 'Late Entry', 'LE', NULL, true, false, 1, 'LATE_ENTRY' WHERE NOT EXISTS (SELECT 1 FROM "leave_types" WHERE "kind" = 'LATE_ENTRY')
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "leave_types" ("name", "code", "annual_quota", "is_paid", "allow_half_day", "sort_order", "kind")
SELECT 'Early Exit', 'EE', NULL, true, false, 2, 'EARLY_EXIT' WHERE NOT EXISTS (SELECT 1 FROM "leave_types" WHERE "kind" = 'EARLY_EXIT')
ON CONFLICT DO NOTHING;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "quality_checks_leave_request_idx" ON "quality_checks" ("leave_request_id") WHERE "leave_request_id" IS NOT NULL;
