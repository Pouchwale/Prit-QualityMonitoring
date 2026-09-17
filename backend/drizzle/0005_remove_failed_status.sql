-- Status is only Completed, Missed or Exception once a check is finished. Checks that were
-- "Failed" (submitted with a reading outside limits) were completed; their readings keep FAIL.
ALTER TABLE "quality_checks" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
UPDATE "quality_checks" SET "status" = 'COMPLETED' WHERE "status" = 'FAILED';--> statement-breakpoint
ALTER TABLE "quality_checks" ALTER COLUMN "status" SET DEFAULT 'PENDING'::text;--> statement-breakpoint
DROP TYPE "public"."check_status";--> statement-breakpoint
CREATE TYPE "public"."check_status" AS ENUM('PENDING', 'DUE', 'IN_PROGRESS', 'COMPLETED', 'MISSED', 'EXCEPTION');--> statement-breakpoint
ALTER TABLE "quality_checks" ALTER COLUMN "status" SET DEFAULT 'PENDING'::"public"."check_status";--> statement-breakpoint
ALTER TABLE "quality_checks" ALTER COLUMN "status" SET DATA TYPE "public"."check_status" USING "status"::"public"."check_status";