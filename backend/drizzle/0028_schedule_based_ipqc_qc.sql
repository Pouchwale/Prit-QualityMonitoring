--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "worker_quality_role" text NOT NULL DEFAULT 'IPQC';
--> statement-breakpoint
ALTER TABLE "schedules" ALTER COLUMN "machine_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "schedules" ALTER COLUMN "shift_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN IF NOT EXISTS "module" "quality_module" NOT NULL DEFAULT 'IPQC';
--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN IF NOT EXISTS "department_id" uuid REFERENCES "departments"("id") ON DELETE SET NULL;
--> statement-breakpoint
UPDATE "schedules" SET "module" = activities."module", "department_id" = activities."department_id"
FROM "activities"
WHERE "schedules"."activity_id" = "activities"."id";
--> statement-breakpoint
ALTER TABLE "quality_checks" ALTER COLUMN "machine_id" DROP NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "exceptions" ALTER COLUMN "machine_id" DROP NOT NULL;
EXCEPTION
  WHEN undefined_table THEN null;
  WHEN undefined_column THEN null;
END $$;
