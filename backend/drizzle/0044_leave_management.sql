CREATE TABLE "leave_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"worker_id" uuid NOT NULL,
	"leave_type_id" uuid NOT NULL,
	"day_part" text DEFAULT 'FULL' NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"days" double precision NOT NULL,
	"reason" text NOT NULL,
	"attachment_path" text,
	"attachment_name" text,
	"attachment_type" text,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"decided_by_id" uuid,
	"decided_at" timestamp with time zone,
	"decision_comment" text,
	"cancelled_by_id" uuid,
	"cancelled_at" timestamp with time zone,
	"reminded_at" timestamp with time zone,
	"escalated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leave_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"annual_quota" double precision,
	"is_paid" boolean DEFAULT true NOT NULL,
	"allow_half_day" boolean DEFAULT true NOT NULL,
	"requires_attachment" boolean DEFAULT false NOT NULL,
	"max_consecutive_days" double precision,
	"advance_notice_days" integer DEFAULT 0 NOT NULL,
	"carry_forward_max" double precision DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "leave_types_name_unique" UNIQUE("name"),
	CONSTRAINT "leave_types_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "shift_change_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"worker_id" uuid NOT NULL,
	"current_shift_id" uuid,
	"requested_shift_id" uuid NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"reason" text NOT NULL,
	"attachment_path" text,
	"attachment_name" text,
	"attachment_type" text,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"decided_by_id" uuid,
	"decided_at" timestamp with time zone,
	"decision_comment" text,
	"cancelled_by_id" uuid,
	"cancelled_at" timestamp with time zone,
	"reminded_at" timestamp with time zone,
	"escalated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_worker_id_users_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_leave_type_id_leave_types_id_fk" FOREIGN KEY ("leave_type_id") REFERENCES "public"."leave_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_decided_by_id_users_id_fk" FOREIGN KEY ("decided_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_cancelled_by_id_users_id_fk" FOREIGN KEY ("cancelled_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_change_requests" ADD CONSTRAINT "shift_change_requests_worker_id_users_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_change_requests" ADD CONSTRAINT "shift_change_requests_current_shift_id_shifts_id_fk" FOREIGN KEY ("current_shift_id") REFERENCES "public"."shifts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_change_requests" ADD CONSTRAINT "shift_change_requests_requested_shift_id_shifts_id_fk" FOREIGN KEY ("requested_shift_id") REFERENCES "public"."shifts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_change_requests" ADD CONSTRAINT "shift_change_requests_decided_by_id_users_id_fk" FOREIGN KEY ("decided_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_change_requests" ADD CONSTRAINT "shift_change_requests_cancelled_by_id_users_id_fk" FOREIGN KEY ("cancelled_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "leave_requests_worker_idx" ON "leave_requests" USING btree ("worker_id","status");--> statement-breakpoint
CREATE INDEX "leave_requests_dates_idx" ON "leave_requests" USING btree ("start_date","end_date");--> statement-breakpoint
CREATE INDEX "shift_change_requests_worker_idx" ON "shift_change_requests" USING btree ("worker_id","status");--> statement-breakpoint
-- The usual leave types, without quotas: the Super Admin sets the yearly days in Leave Settings
-- (a quota of 0 lets no paid leave be taken until it is set).
INSERT INTO "leave_types" ("name", "code", "annual_quota", "is_paid", "allow_half_day", "requires_attachment", "sort_order") VALUES
  ('Casual Leave', 'CL', 0, true, true, false, 0),
  ('Sick Leave', 'SL', 0, true, true, false, 1),
  ('Paid Leave', 'PL', 0, true, true, false, 2),
  ('Emergency Leave', 'EL', 0, true, true, false, 3)
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- Permissions for the new modules: the Admin role as for other modules (everything), the Manager
-- role views and decides requests, workers may apply in the app. The Super Admin changes them in
-- Roles & Permissions.
INSERT INTO "role_permissions" ("role", "module", "can_view", "can_manage", "can_create", "can_edit", "can_delete", "can_approve", "can_export") VALUES
  ('ADMIN', 'leave', true, true, false, true, false, true, true),
  ('ADMIN', 'leave_settings', true, true, false, true, false, false, false),
  ('MANAGER', 'leave', true, true, false, false, false, true, false),
  ('WORKER', 'app_leave', false, true, true, false, false, false, false)
ON CONFLICT DO NOTHING;
