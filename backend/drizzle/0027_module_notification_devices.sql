--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "quality_module" AS ENUM ('IPQC', 'QC');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN IF NOT EXISTS "module" "quality_module" NOT NULL DEFAULT 'IPQC';
--> statement-breakpoint
ALTER TABLE "quality_checks" ADD COLUMN IF NOT EXISTS "module" "quality_module";
--> statement-breakpoint
UPDATE "activities" SET "module" = 'QC' WHERE "name" ILIKE '%pouch%' OR "code" ILIKE '%pouch%';
--> statement-breakpoint
UPDATE "quality_checks" SET "module" = activities."module"
FROM "activities"
WHERE "quality_checks"."activity_id" = "activities"."id" AND "quality_checks"."module" IS NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "module_notification_assignments" (
  "module" text PRIMARY KEY,
  "user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_by_id" uuid REFERENCES "users"("id") ON DELETE SET NULL
);
--> statement-breakpoint
INSERT INTO "module_notification_assignments" ("module", "user_id", "updated_at")
VALUES ('IPQC', NULL, now()), ('QC', NULL, now())
ON CONFLICT ("module") DO NOTHING;
