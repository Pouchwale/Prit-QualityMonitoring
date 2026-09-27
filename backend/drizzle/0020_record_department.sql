ALTER TABLE "jobs" ADD COLUMN "department_id" uuid;--> statement-breakpoint
ALTER TABLE "quality_checks" ADD COLUMN "department_id" uuid;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_checks" ADD CONSTRAINT "quality_checks_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- Machines are shared between departments, so the department belongs to the work. Existing rows
-- are filled in from what they already record; nothing else is touched and no row is deleted.

-- 1. Every check takes the department of its check type (the work that was done).
UPDATE "quality_checks" qc
SET "department_id" = a."department_id"
FROM "activities" a
WHERE a."id" = qc."activity_id" AND a."department_id" IS NOT NULL AND qc."department_id" IS NULL;--> statement-breakpoint

-- 2. A check whose check type has no department falls back to the worker who did it.
UPDATE "quality_checks" qc
SET "department_id" = u."department_id"
FROM "users" u
WHERE u."id" = COALESCE(qc."submitted_by_id", qc."worker_id") AND u."department_id" IS NOT NULL AND qc."department_id" IS NULL;--> statement-breakpoint

-- 3. A job takes the department its own checks were recorded under; the commonest one wins when
--    a job somehow carries more than one.
UPDATE "jobs" j
SET "department_id" = best."department_id"
FROM (
  SELECT DISTINCT ON (qc."job_id") qc."job_id", qc."department_id", COUNT(*) AS n
  FROM "quality_checks" qc
  WHERE qc."job_id" IS NOT NULL AND qc."department_id" IS NOT NULL
  GROUP BY qc."job_id", qc."department_id"
  ORDER BY qc."job_id", n DESC, qc."department_id"
) best
WHERE best."job_id" = j."id" AND j."department_id" IS NULL;--> statement-breakpoint

-- 4. A job with no checks yet (planned, or started a moment ago) takes the department of the
--    worker responsible for it.
UPDATE "jobs" j
SET "department_id" = u."department_id"
FROM "users" u
WHERE u."id" = COALESCE(j."assigned_worker_id", j."started_by_id") AND u."department_id" IS NOT NULL AND j."department_id" IS NULL;--> statement-breakpoint

-- Manager scoping reads these columns on every list, dashboard and report.
CREATE INDEX IF NOT EXISTS "quality_checks_department_idx" ON "quality_checks" ("department_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_department_idx" ON "jobs" ("department_id");
