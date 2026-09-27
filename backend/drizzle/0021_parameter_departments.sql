CREATE TABLE "parameter_departments" (
	"parameter_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	CONSTRAINT "parameter_departments_parameter_id_department_id_pk" PRIMARY KEY("parameter_id","department_id")
);
--> statement-breakpoint
ALTER TABLE "parameter_departments" ADD CONSTRAINT "parameter_departments_parameter_id_parameters_id_fk" FOREIGN KEY ("parameter_id") REFERENCES "public"."parameters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parameter_departments" ADD CONSTRAINT "parameter_departments_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "parameter_departments_department_idx" ON "parameter_departments" USING btree ("department_id");--> statement-breakpoint

-- A parameter can now serve several departments. Every department a parameter already had is
-- carried over before the old single column goes; a parameter that had none keeps none and stays
-- unassigned, which means every check type may use it.
INSERT INTO "parameter_departments" ("parameter_id", "department_id")
SELECT "id", "department_id" FROM "parameters" WHERE "department_id" IS NOT NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint

ALTER TABLE "parameters" DROP CONSTRAINT "parameters_department_id_departments_id_fk";--> statement-breakpoint
ALTER TABLE "parameters" DROP COLUMN "department_id";
