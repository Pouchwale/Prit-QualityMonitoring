ALTER TABLE "departments" ADD COLUMN "covers_department_ids" uuid[] DEFAULT ARRAY[]::uuid[] NOT NULL;--> statement-breakpoint
-- One IPQC department for printing on every product: it covers Pouch, Label and Sleeve.
INSERT INTO "departments" ("name", "code", "covers_department_ids", "is_active")
SELECT 'IPQC (Print)', 'IPQC-PRINT', ARRAY(SELECT "id" FROM "departments" WHERE lower("code") IN ('pouch', 'label', 'sleeve') ORDER BY "name"), true
WHERE NOT EXISTS (SELECT 1 FROM "departments" WHERE "name" = 'IPQC (Print)' OR "code" = 'IPQC-PRINT');--> statement-breakpoint
-- IPQC workers and managers placed in Pouch for printing move to IPQC (Print).
UPDATE "users" SET "department_id" = (SELECT "id" FROM "departments" WHERE "code" = 'IPQC-PRINT'), "updated_at" = now()
WHERE "role" IN ('WORKER', 'MANAGER') AND "worker_quality_role" = 'IPQC'
  AND "department_id" = (SELECT "id" FROM "departments" WHERE lower("code") = 'pouch');
