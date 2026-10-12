ALTER TABLE "exception_reasons" ADD COLUMN "requires_job_details" boolean DEFAULT true NOT NULL;--> statement-breakpoint
-- Keep today's behaviour: reasons named as a machine problem (machine / maintenance / breakdown) need the machine only.
UPDATE "exception_reasons" SET "requires_job_details" = false WHERE "label" ~* '(machine|maintenance|breakdown)';
