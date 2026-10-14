ALTER TABLE "role_permissions" ADD COLUMN "can_approve" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD COLUMN "can_export" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_permissions" ADD COLUMN "can_approve" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_permissions" ADD COLUMN "can_export" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Approve keeps today's access: approving an annual calendar and resolving an exception were Edit.
UPDATE "role_permissions" SET "can_approve" = "can_edit" WHERE "module" IN ('calendar', 'exceptions');--> statement-breakpoint
UPDATE "user_permissions" SET "can_approve" = "can_edit" WHERE "module" IN ('calendar', 'exceptions');--> statement-breakpoint
-- Export keeps today's access: the separate "Export Reports" module becomes the Export action of the
-- modules it covered (Reports, Quality Checks, Worker Performance), for roles and users that had it
-- and can view that module. The old 'export' rows stay as history; they are no longer read.
UPDATE "role_permissions" r SET "can_export" = true
WHERE r."module" IN ('reports', 'checks', 'performance') AND r."can_view"
  AND EXISTS (SELECT 1 FROM "role_permissions" e WHERE e."role" = r."role" AND e."module" = 'export' AND e."can_view");--> statement-breakpoint
UPDATE "user_permissions" u SET "can_export" = true
WHERE u."module" IN ('reports', 'checks', 'performance') AND u."can_view"
  AND coalesce(
    (SELECT e."can_view" FROM "user_permissions" e WHERE e."user_id" = u."user_id" AND e."module" = 'export'),
    (SELECT r."can_view" FROM "role_permissions" r JOIN "users" us ON us."role" = r."role" WHERE us."id" = u."user_id" AND r."module" = 'export'),
    false
  );--> statement-breakpoint
-- The Worker role's app features, as workers have them today: start/end/hand over jobs, own
-- performance, own history.
INSERT INTO "role_permissions" ("role", "module", "can_view", "can_manage", "can_create", "can_edit", "can_delete", "can_approve", "can_export")
VALUES
  ('WORKER', 'app_jobs', false, true, true, true, false, false, false),
  ('WORKER', 'app_performance', true, false, false, false, false, false, false),
  ('WORKER', 'app_history', true, false, false, false, false, false, false)
ON CONFLICT DO NOTHING;
