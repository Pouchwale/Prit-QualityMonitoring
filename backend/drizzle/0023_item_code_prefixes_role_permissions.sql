CREATE TABLE "role_permissions" (
	"role" "role" NOT NULL,
	"module" text NOT NULL,
	"can_view" boolean DEFAULT false NOT NULL,
	"can_manage" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_permissions_role_module_pk" PRIMARY KEY("role","module")
);
--> statement-breakpoint
ALTER TABLE "departments" ADD COLUMN "item_code_prefixes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint

-- A job's department is worked out from the start of its Item Code: RMLA -> Label, RMPO -> Pouch,
-- RMSL -> Sleeve. Each prefix goes to exactly one department, matched on its code or name the same
-- way ensureCheckTypes does (Sleeve is also spelled Sleave or Slive). When several match, the one
-- that has check types wins, then an active one, then the oldest.
UPDATE "departments" SET "item_code_prefixes" = '["RMLA"]'::jsonb
WHERE "id" = (
  SELECT d."id" FROM "departments" d
  WHERE lower(trim(d."code")) = 'label' OR lower(trim(d."name")) = 'label'
  ORDER BY (SELECT count(*) FROM "activities" a WHERE a."department_id" = d."id") DESC, d."is_active" DESC, d."created_at"
  LIMIT 1
);--> statement-breakpoint
UPDATE "departments" SET "item_code_prefixes" = '["RMPO"]'::jsonb
WHERE "id" = (
  SELECT d."id" FROM "departments" d
  WHERE lower(trim(d."code")) = 'pouch' OR lower(trim(d."name")) = 'pouch'
  ORDER BY (SELECT count(*) FROM "activities" a WHERE a."department_id" = d."id") DESC, d."is_active" DESC, d."created_at"
  LIMIT 1
);--> statement-breakpoint
UPDATE "departments" SET "item_code_prefixes" = '["RMSL"]'::jsonb
WHERE "id" = (
  SELECT d."id" FROM "departments" d
  WHERE lower(trim(d."code")) IN ('sleeve', 'sleave', 'slive') OR lower(trim(d."name")) IN ('sleeve', 'sleave', 'slive')
  ORDER BY (SELECT count(*) FROM "activities" a WHERE a."department_id" = d."id") DESC, d."is_active" DESC, d."created_at"
  LIMIT 1
);--> statement-breakpoint

-- Planned jobs take their department from their Item Code as well: it is never chosen by hand now.
-- (At Start Job it is worked out again, from the Item Code the job has then.)
UPDATE "jobs" j SET "department_id" = d."id", "updated_at" = now()
FROM "departments" d
WHERE j."status" = 'PLANNED' AND j."item_code" IS NOT NULL AND d."is_active"
  AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(d."item_code_prefixes") p WHERE upper(trim(j."item_code")) LIKE p || '%');--> statement-breakpoint

-- One set of permissions for the Manager role, set by the Super Admin. It starts from what the
-- active Managers already had: the modules all of them had, at the lowest level any of them had, so
-- none of them gains access. Disabled Managers, and Managers who were never given any module, are
-- left out of the comparison, so one of them cannot leave the whole role with nothing. The
-- per-Manager rows are kept, no longer read.
WITH "configured" AS (
  SELECT u."id" FROM "users" u
  WHERE u."role" = 'MANAGER' AND u."is_active"
    AND EXISTS (
      SELECT 1 FROM "manager_permissions" x
      WHERE x."user_id" = u."id" AND (x."can_view" OR x."can_manage")
        AND x."module" IN ('dashboard', 'checks', 'exceptions', 'reports', 'machines', 'parameters', 'activities', 'schedules', 'shifts', 'departments', 'workers', 'audit_logs', 'settings', 'calendar', 'performance')
    )
)
INSERT INTO "role_permissions" ("role", "module", "can_view", "can_manage")
SELECT 'MANAGER', mp."module", true, bool_and(mp."can_manage")
FROM "manager_permissions" mp
WHERE mp."user_id" IN (SELECT "id" FROM "configured")
  AND mp."module" IN ('dashboard', 'checks', 'exceptions', 'reports', 'machines', 'parameters', 'activities', 'schedules', 'shifts', 'departments', 'workers', 'audit_logs', 'settings', 'calendar', 'performance')
GROUP BY mp."module"
HAVING count(*) = (SELECT count(*) FROM "configured") AND bool_and(mp."can_view" OR mp."can_manage");--> statement-breakpoint

-- Jobs had no permission of their own: they came with Quality Checks.
INSERT INTO "role_permissions" ("role", "module", "can_view", "can_manage")
SELECT "role", 'jobs', "can_view", "can_manage" FROM "role_permissions" WHERE "role" = 'MANAGER' AND "module" = 'checks'
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- Downloading reports and checks (PDF, CSV and print) came with Reports or Quality Checks. Score
-- settings stay off: until now only Admins could change the scoring rule.
INSERT INTO "role_permissions" ("role", "module", "can_view", "can_manage")
SELECT 'MANAGER', 'export', true, false
WHERE EXISTS (SELECT 1 FROM "role_permissions" WHERE "role" = 'MANAGER' AND "module" IN ('reports', 'checks') AND ("can_view" OR "can_manage"))
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- Recorded in the audit log, so the Super Admin can review the Manager role in Manager Access.
INSERT INTO "audit_logs" ("user_name", "role", "action", "entity", "entity_id", "new_value")
SELECT 'System (update 0023)', 'SYSTEM', 'SEED_ROLE_PERMISSIONS', 'Role', 'MANAGER',
  jsonb_build_object('permissions', coalesce(
    (SELECT jsonb_object_agg("module", CASE WHEN "can_manage" THEN 'manage' ELSE 'view' END) FROM "role_permissions" WHERE "role" = 'MANAGER'),
    '{}'::jsonb
  ));
