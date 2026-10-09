CREATE TABLE "worker_shift_logins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"worker_id" uuid NOT NULL,
	"shift_id" uuid,
	"shift_start" timestamp with time zone NOT NULL,
	"shift_end" timestamp with time zone NOT NULL,
	"login_at" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"logout_at" timestamp with time zone,
	"logout_reason" text,
	"reminders_sent" integer DEFAULT 0 NOT NULL,
	"first_reminder_at" timestamp with time zone,
	"last_reminder_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "push_tokens" ADD COLUMN IF NOT EXISTS "signed_out_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "worker_shift_logins" ADD CONSTRAINT "worker_shift_logins_worker_id_users_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_shift_logins" ADD CONSTRAINT "worker_shift_logins_shift_id_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shifts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "worker_shift_logins_worker_start_idx" ON "worker_shift_logins" USING btree ("worker_id","shift_start");--> statement-breakpoint
CREATE INDEX "worker_shift_logins_open_idx" ON "worker_shift_logins" USING btree ("shift_end") WHERE "worker_shift_logins"."logout_at" is null;