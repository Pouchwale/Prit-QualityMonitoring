CREATE TABLE "department_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"prefix" text NOT NULL,
	"department_id" uuid NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by_id" uuid,
	"updated_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "department_mappings_prefix_unique" UNIQUE("prefix")
);
--> statement-breakpoint
ALTER TABLE "department_mappings" ADD CONSTRAINT "department_mappings_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "department_mappings" ADD CONSTRAINT "department_mappings_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "department_mappings" ADD CONSTRAINT "department_mappings_updated_by_id_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "department_mappings_department_idx" ON "department_mappings" USING btree ("department_id");--> statement-breakpoint

-- The Item Code prefixes move from departments.item_code_prefixes to their own rows, so each
-- mapping can be switched on and off and edited on the Department Configuration page. Every saved
-- prefix keeps its department and starts active (RMLA -> Label, RMPO -> Pouch, RMSL -> Sleeve).
-- Jobs and checks are not touched: they keep the department they were given.
INSERT INTO "department_mappings" ("prefix", "department_id", "is_active")
SELECT DISTINCT ON (upper(trim(p."prefix"))) upper(trim(p."prefix")), d."id", true
FROM "departments" d
CROSS JOIN LATERAL jsonb_array_elements_text(d."item_code_prefixes") AS p("prefix")
WHERE trim(p."prefix") <> ''
ORDER BY upper(trim(p."prefix")), d."is_active" DESC, d."created_at"
ON CONFLICT ("prefix") DO NOTHING;--> statement-breakpoint

INSERT INTO "audit_logs" ("user_name", "role", "action", "entity", "entity_id", "new_value")
SELECT 'System (update 0024)', 'SYSTEM', 'MIGRATE_DEPARTMENT_MAPPINGS', 'DepartmentMapping', NULL,
  jsonb_build_object('mappings', coalesce(
    (SELECT jsonb_object_agg(m."prefix", d."name") FROM "department_mappings" m JOIN "departments" d ON d."id" = m."department_id"),
    '{}'::jsonb
  ));--> statement-breakpoint

ALTER TABLE "departments" DROP COLUMN "item_code_prefixes";