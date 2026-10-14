CREATE TABLE "user_permissions" (
	"user_id" uuid NOT NULL,
	"module" text NOT NULL,
	"can_view" boolean DEFAULT false NOT NULL,
	"can_create" boolean DEFAULT false NOT NULL,
	"can_edit" boolean DEFAULT false NOT NULL,
	"can_delete" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_permissions_user_id_module_pk" PRIMARY KEY("user_id","module")
);
--> statement-breakpoint
ALTER TABLE "role_permissions" ADD COLUMN "can_create" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD COLUMN "can_edit" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD COLUMN "can_delete" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_permissions" ADD CONSTRAINT "user_permissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- The Manager role's stored set becomes the matrix: "manage" meant create, edit and delete, except
-- the permanent deletes of quality checks and jobs, which Managers never had.
UPDATE "role_permissions" SET "can_create" = "can_manage", "can_edit" = "can_manage", "can_delete" = "can_manage" AND "module" NOT IN ('checks', 'jobs') WHERE "role" = 'MANAGER';--> statement-breakpoint
-- New modules for Managers, from what they had: Shift Sign-In with Workers or Shifts (its settings
-- were changed with Shifts manage), the Company Wi-Fi rule seen with Shifts (only the Super Admin changed it).
INSERT INTO "role_permissions" ("role", "module", "can_view", "can_manage", "can_create", "can_edit", "can_delete")
SELECT 'MANAGER', 'shift_signin', true, bool_or("module" = 'shifts' AND "can_manage"), false, bool_or("module" = 'shifts' AND "can_manage"), false
FROM "role_permissions" WHERE "role" = 'MANAGER' AND "module" IN ('workers', 'shifts') AND ("can_view" OR "can_manage")
HAVING count(*) > 0
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permissions" ("role", "module", "can_view", "can_manage", "can_create", "can_edit", "can_delete")
SELECT 'MANAGER', 'wifi_rule', true, false, false, false, false
FROM "role_permissions" WHERE "role" = 'MANAGER' AND "module" = 'shifts' AND ("can_view" OR "can_manage")
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- The Admin role keeps what it had: everything, except the permanent deletes of checks and jobs
-- (granted per Admin before) and changing the Company Wi-Fi rule (Super Admin only before).
INSERT INTO "role_permissions" ("role", "module", "can_view", "can_manage", "can_create", "can_edit", "can_delete")
SELECT 'ADMIN', m, true, true, true, m <> 'wifi_rule', m NOT IN ('checks', 'jobs')
FROM unnest(ARRAY['dashboard', 'checks', 'jobs', 'exceptions', 'reports', 'export', 'machines', 'parameters', 'activities', 'schedules',
  'shifts', 'departments', 'workers', 'audit_logs', 'settings', 'calendar', 'performance', 'shift_signin', 'wifi_rule']) AS m
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- An Admin's granted Delete Jobs / Delete Checks becomes their own permission for that module.
INSERT INTO "user_permissions" ("user_id", "module", "can_view", "can_create", "can_edit", "can_delete")
SELECT mp."user_id", CASE mp."module" WHEN 'delete:jobs' THEN 'jobs' ELSE 'checks' END, true, true, true, true
FROM "manager_permissions" mp JOIN "users" u ON u."id" = mp."user_id"
WHERE mp."module" IN ('delete:jobs', 'delete:checks') AND mp."can_manage" AND u."role" = 'ADMIN'
ON CONFLICT DO NOTHING;
