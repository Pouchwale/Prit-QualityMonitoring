CREATE TABLE IF NOT EXISTS "machine_day_plans" (
	"date" date PRIMARY KEY NOT NULL,
	"note" text,
	"updated_by_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "machine_day_plans_updated_by_id_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "machine_day_plan_machines" (
	"date" date NOT NULL,
	"machine_id" uuid NOT NULL,
	CONSTRAINT "machine_day_plan_machines_date_machine_id_pk" PRIMARY KEY("date","machine_id"),
	CONSTRAINT "machine_day_plan_machines_date_machine_day_plans_date_fk" FOREIGN KEY ("date") REFERENCES "public"."machine_day_plans"("date") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "machine_day_plan_machines_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE cascade ON UPDATE no action
);
