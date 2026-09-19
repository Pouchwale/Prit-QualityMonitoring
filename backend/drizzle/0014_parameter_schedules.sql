-- Each parameter of a job-based check type runs on its own frequency, so a job can have several
-- open interval checks at once (e.g. Viscosity due now, Print quality due later), each with only
-- the parameters due at its time. One open check per job, check type, kind and due time.
DROP INDEX IF EXISTS "quality_checks_one_open_job_check";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "quality_checks_one_open_job_check" ON "quality_checks" USING btree ("job_id","activity_id","kind","scheduled_at") WHERE "quality_checks"."kind" <> 'SCHEDULED' and "quality_checks"."status" in ('PENDING', 'DUE', 'IN_PROGRESS');
