-- Job-based quality monitoring: job lifecycle (planned → start check → active → end check →
-- completed), per-parameter check frequency, job checks with only the parameters that are due,
-- and worker handover. Additive: existing jobs, check types, schedules and checks keep working.

DO $$ BEGIN
  CREATE TYPE "public"."job_status" AS ENUM('PLANNED', 'STARTING', 'ACTIVE', 'ENDING', 'COMPLETED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."check_kind" AS ENUM('SCHEDULED', 'JOB_START', 'JOB_INTERVAL', 'JOB_END');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."parameter_frequency" AS ENUM('JOB_START', 'INTERVAL', 'JOB_END');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."activity_monitoring" AS ENUM('SHIFT', 'JOB');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

-- Check types: shift schedules (as before) or job-based, with the grace for job interval checks.
ALTER TABLE "activities" ADD COLUMN IF NOT EXISTS "monitoring" "activity_monitoring" DEFAULT 'SHIFT' NOT NULL;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN IF NOT EXISTS "grace_minutes" integer DEFAULT 20 NOT NULL;--> statement-breakpoint

-- When each parameter of a job-based check type is checked.
ALTER TABLE "activity_parameters" ADD COLUMN IF NOT EXISTS "frequency" "parameter_frequency" DEFAULT 'INTERVAL' NOT NULL;--> statement-breakpoint
ALTER TABLE "activity_parameters" ADD COLUMN IF NOT EXISTS "interval_minutes" integer DEFAULT 60 NOT NULL;--> statement-breakpoint

-- Jobs: lifecycle, the worker currently responsible, planning and end request.
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "status" "job_status" DEFAULT 'ACTIVE' NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "assigned_worker_id" uuid;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "planned_by_id" uuid;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "planned_for" date;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "note" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "activated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "end_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "end_requested_by_id" uuid;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "force_closed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "started_at" DROP NOT NULL;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "jobs" ADD CONSTRAINT "jobs_assigned_worker_id_users_id_fk" FOREIGN KEY ("assigned_worker_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "jobs" ADD CONSTRAINT "jobs_planned_by_id_users_id_fk" FOREIGN KEY ("planned_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "jobs" ADD CONSTRAINT "jobs_end_requested_by_id_users_id_fk" FOREIGN KEY ("end_requested_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
-- Existing jobs: running ones are active, ended ones completed; the starter is responsible.
UPDATE "jobs" SET
  "status" = CASE WHEN "ended_at" IS NULL THEN 'ACTIVE'::"job_status" ELSE 'COMPLETED'::"job_status" END,
  "assigned_worker_id" = COALESCE("assigned_worker_id", "started_by_id"),
  "activated_at" = COALESCE("activated_at", "started_at");--> statement-breakpoint
-- One running job per machine; planned jobs do not count.
DROP INDEX IF EXISTS "jobs_running_per_machine_idx";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "jobs_running_per_machine_idx" ON "jobs" USING btree ("machine_id") WHERE "jobs"."status" in ('STARTING', 'ACTIVE', 'ENDING');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_status_idx" ON "jobs" USING btree ("status");--> statement-breakpoint

-- Every handover of a running job from one worker to another.
CREATE TABLE IF NOT EXISTS "job_handovers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "job_id" uuid NOT NULL,
  "from_user_id" uuid,
  "to_user_id" uuid,
  "to_shift_id" uuid,
  "note" text,
  "created_by_id" uuid,
  "moved_checks" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "job_handovers" ADD CONSTRAINT "job_handovers_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "job_handovers" ADD CONSTRAINT "job_handovers_from_user_id_users_id_fk" FOREIGN KEY ("from_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "job_handovers" ADD CONSTRAINT "job_handovers_to_user_id_users_id_fk" FOREIGN KEY ("to_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "job_handovers" ADD CONSTRAINT "job_handovers_to_shift_id_shifts_id_fk" FOREIGN KEY ("to_shift_id") REFERENCES "public"."shifts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "job_handovers" ADD CONSTRAINT "job_handovers_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_handovers_job_idx" ON "job_handovers" USING btree ("job_id", "created_at");--> statement-breakpoint

-- Checks: what kind of check, and (for job checks) exactly which parameters it asks for.
ALTER TABLE "quality_checks" ADD COLUMN IF NOT EXISTS "kind" "check_kind" DEFAULT 'SCHEDULED' NOT NULL;--> statement-breakpoint
ALTER TABLE "quality_checks" ADD COLUMN IF NOT EXISTS "parameter_ids" uuid[];--> statement-breakpoint
-- One open check of each kind per job and check type: no duplicates, however many ticks run.
CREATE UNIQUE INDEX IF NOT EXISTS "quality_checks_one_open_job_check" ON "quality_checks" USING btree ("job_id", "activity_id", "kind") WHERE "quality_checks"."kind" <> 'SCHEDULED' and "quality_checks"."status" in ('PENDING', 'DUE', 'IN_PROGRESS');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "quality_checks_job_idx" ON "quality_checks" USING btree ("job_id");
