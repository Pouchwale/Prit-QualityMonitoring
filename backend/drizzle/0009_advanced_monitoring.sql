-- Advanced monitoring: evidence per parameter, manual submission, N/A reasons, jobs and the
-- rolling "next check" timer. Additive only: every existing column and row is kept.

DO $$ BEGIN
	CREATE TYPE "public"."applies_when" AS ENUM('ALWAYS', 'JOB_RUNNING');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	CREATE TYPE "public"."schedule_mode" AS ENUM('INTERVAL', 'JOB');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	CREATE TYPE "public"."submission_type" AS ENUM('NOTIFICATION', 'MANUAL');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"machine_id" uuid NOT NULL,
	"job_no" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_by_id" uuid,
	"ended_at" timestamp with time zone,
	"ended_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "monitoring_reasons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text NOT NULL,
	"requires_remark" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "schedule_timers" (
	"schedule_id" uuid PRIMARY KEY NOT NULL,
	"last_submitted_at" timestamp with time zone,
	"last_check_id" uuid,
	"next_due_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jobs" DROP CONSTRAINT IF EXISTS "jobs_machine_id_machines_id_fk";--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" DROP CONSTRAINT IF EXISTS "jobs_started_by_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_started_by_id_users_id_fk" FOREIGN KEY ("started_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" DROP CONSTRAINT IF EXISTS "jobs_ended_by_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_ended_by_id_users_id_fk" FOREIGN KEY ("ended_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_timers" DROP CONSTRAINT IF EXISTS "schedule_timers_schedule_id_schedules_id_fk";--> statement-breakpoint
ALTER TABLE "schedule_timers" ADD CONSTRAINT "schedule_timers_schedule_id_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."schedules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_timers" DROP CONSTRAINT IF EXISTS "schedule_timers_last_check_id_quality_checks_id_fk";--> statement-breakpoint
ALTER TABLE "schedule_timers" ADD CONSTRAINT "schedule_timers_last_check_id_quality_checks_id_fk" FOREIGN KEY ("last_check_id") REFERENCES "public"."quality_checks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- One running job per machine.
CREATE UNIQUE INDEX IF NOT EXISTS "jobs_running_per_machine_idx" ON "jobs" USING btree ("machine_id") WHERE "ended_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_machine_started_idx" ON "jobs" USING btree ("machine_id","started_at");--> statement-breakpoint
-- Evidence and applicability per parameter inside a check type.
ALTER TABLE "activity_parameters" ADD COLUMN IF NOT EXISTS "require_photo" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "activity_parameters" ADD COLUMN IF NOT EXISTS "require_video" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "activity_parameters" ADD COLUMN IF NOT EXISTS "allow_na" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "activity_parameters" ADD COLUMN IF NOT EXISTS "applies_when" "applies_when" DEFAULT 'ALWAYS' NOT NULL;--> statement-breakpoint
-- Check types can be started by the worker without waiting for a notification.
ALTER TABLE "activities" ADD COLUMN IF NOT EXISTS "allow_manual" boolean DEFAULT true NOT NULL;--> statement-breakpoint
-- INTERVAL: due every interval inside the shift. JOB: due only while a job is running.
ALTER TABLE "schedules" ADD COLUMN IF NOT EXISTS "mode" "schedule_mode" DEFAULT 'INTERVAL' NOT NULL;--> statement-breakpoint
ALTER TABLE "quality_checks" ADD COLUMN IF NOT EXISTS "submission_type" "submission_type";--> statement-breakpoint
ALTER TABLE "quality_checks" ADD COLUMN IF NOT EXISTS "job_id" uuid;--> statement-breakpoint
ALTER TABLE "quality_checks" ADD COLUMN IF NOT EXISTS "next_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "quality_checks" DROP CONSTRAINT IF EXISTS "quality_checks_job_id_jobs_id_fk";--> statement-breakpoint
ALTER TABLE "quality_checks" ADD CONSTRAINT "quality_checks_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_check_values" ADD COLUMN IF NOT EXISTS "not_applicable" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "quality_check_values" ADD COLUMN IF NOT EXISTS "na_reason" text;--> statement-breakpoint
ALTER TABLE "quality_check_values" ADD COLUMN IF NOT EXISTS "na_remark" text;--> statement-breakpoint
ALTER TABLE "quality_check_values" ADD COLUMN IF NOT EXISTS "applies_when" "applies_when";--> statement-breakpoint
-- Evidence belongs to one parameter; null keeps the existing overall photo/video.
ALTER TABLE "media" ADD COLUMN IF NOT EXISTS "parameter_id" uuid;--> statement-breakpoint
ALTER TABLE "media" DROP CONSTRAINT IF EXISTS "media_parameter_id_parameters_id_fk";--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_parameter_id_parameters_id_fk" FOREIGN KEY ("parameter_id") REFERENCES "public"."parameters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- The configurable "Not Applicable" reasons. Kept as data, so admins can edit them later.
INSERT INTO "monitoring_reasons" ("label", "requires_remark", "sort_order")
SELECT v.label, v.requires_remark, v.sort_order
FROM (VALUES
	('Job still running', false, 0),
	('Parameter not applicable', false, 1),
	('Machine stopped', false, 2),
	('No production', false, 3),
	('Other', true, 4)
) AS v(label, requires_remark, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM "monitoring_reasons" m WHERE m."label" = v.label);--> statement-breakpoint
-- Cutover to the rolling model: future grid slots that were never notified are dropped once and
-- rebuilt as "the next check" per schedule. Submitted, missed and past checks are untouched.
DELETE FROM "quality_checks"
WHERE "schedule_id" IS NOT NULL AND "status" = 'PENDING' AND "notified_at" IS NULL AND "scheduled_at" > now();--> statement-breakpoint
-- Checks whose window is already over become Missed, exactly as the scheduler would do on its
-- next pass, so only genuinely open checks are left for the index below.
UPDATE "quality_checks" SET "status" = 'MISSED'
WHERE "status" IN ('PENDING', 'DUE') AND "window_ends_at" < now();--> statement-breakpoint
-- Any schedule still holding more than one open check keeps the earliest one that is Due or was
-- notified; the extra pending slots are dropped (the generator recreates them) and an extra due
-- check is recorded as Missed, so no submitted or notified record is lost.
DELETE FROM "quality_checks" WHERE "id" IN (
	SELECT "id" FROM (
		SELECT "id", "status", "notified_at",
			row_number() OVER (
				PARTITION BY "schedule_id"
				ORDER BY ("status" = 'DUE' OR "notified_at" IS NOT NULL) DESC, "scheduled_at", "id"
			) AS rn
		FROM "quality_checks"
		WHERE "schedule_id" IS NOT NULL AND "status" IN ('PENDING', 'DUE')
	) ranked
	WHERE ranked.rn > 1 AND ranked."status" = 'PENDING'
);--> statement-breakpoint
UPDATE "quality_checks" SET "status" = 'MISSED' WHERE "id" IN (
	SELECT "id" FROM (
		SELECT "id",
			row_number() OVER (
				PARTITION BY "schedule_id"
				ORDER BY ("status" = 'DUE' OR "notified_at" IS NOT NULL) DESC, "scheduled_at", "id"
			) AS rn
		FROM "quality_checks"
		WHERE "schedule_id" IS NOT NULL AND "status" IN ('PENDING', 'DUE')
	) ranked
	WHERE ranked.rn > 1
);--> statement-breakpoint
-- One open (pending or due) check per schedule: the rolling next check.
CREATE UNIQUE INDEX IF NOT EXISTS "quality_checks_one_open_per_schedule" ON "quality_checks" USING btree ("schedule_id") WHERE "status" IN ('PENDING', 'DUE');
