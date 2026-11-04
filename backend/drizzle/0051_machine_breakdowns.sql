ALTER TYPE "public"."check_status" ADD VALUE 'EXCUSED';--> statement-breakpoint
CREATE TABLE "machine_breakdowns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"worker_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"remark" text,
	"started_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"shift_name" text,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"decided_by_id" uuid,
	"decided_by_name" text,
	"decided_at" timestamp with time zone,
	"decision_comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "machine_breakdowns_code_unique" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "quality_checks" ADD COLUMN "breakdown_id" uuid;--> statement-breakpoint
ALTER TABLE "machine_breakdowns" ADD CONSTRAINT "machine_breakdowns_worker_id_users_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_breakdowns" ADD CONSTRAINT "machine_breakdowns_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_breakdowns" ADD CONSTRAINT "machine_breakdowns_decided_by_id_users_id_fk" FOREIGN KEY ("decided_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "machine_breakdowns_status_idx" ON "machine_breakdowns" USING btree ("status","started_at");--> statement-breakpoint
CREATE INDEX "machine_breakdowns_worker_machine_idx" ON "machine_breakdowns" USING btree ("worker_id","machine_id","ends_at");--> statement-breakpoint
ALTER TABLE "quality_checks" ADD CONSTRAINT "quality_checks_breakdown_id_machine_breakdowns_id_fk" FOREIGN KEY ("breakdown_id") REFERENCES "public"."machine_breakdowns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Machine Breakdowns permission: Admins and Managers view and decide reports (Managers only for
-- their department's workers, services/departmentScope.ts). The Super Admin changes it in Roles & Permissions.
INSERT INTO "role_permissions" ("role", "module", "can_view", "can_manage", "can_create", "can_edit", "can_delete", "can_approve", "can_export") VALUES
  ('ADMIN', 'breakdowns', true, true, false, false, false, true, false),
  ('MANAGER', 'breakdowns', true, true, false, false, false, true, false)
ON CONFLICT DO NOTHING;
