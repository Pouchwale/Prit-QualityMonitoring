CREATE TABLE "machine_departments" (
	"machine_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	CONSTRAINT "machine_departments_machine_id_department_id_pk" PRIMARY KEY("machine_id","department_id")
);
--> statement-breakpoint
ALTER TABLE "machine_departments" ADD CONSTRAINT "machine_departments_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_departments" ADD CONSTRAINT "machine_departments_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "machine_departments_department_idx" ON "machine_departments" USING btree ("department_id");--> statement-breakpoint
-- Each machine keeps its current department as its first mapping; nothing else changes.
INSERT INTO "machine_departments" ("machine_id", "department_id") SELECT "id", "department_id" FROM "machines" WHERE "department_id" IS NOT NULL ON CONFLICT DO NOTHING;
