ALTER TYPE "public"."role" ADD VALUE 'SUPER_ADMIN';--> statement-breakpoint
CREATE TABLE "manager_permissions" (
	"user_id" uuid NOT NULL,
	"module" text NOT NULL,
	"can_view" boolean DEFAULT false NOT NULL,
	"can_manage" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "manager_permissions_user_id_module_pk" PRIMARY KEY("user_id","module")
);
--> statement-breakpoint
ALTER TABLE "push_tokens" ADD COLUMN "kind" text DEFAULT 'expo' NOT NULL;--> statement-breakpoint
ALTER TABLE "push_tokens" ADD COLUMN "subscription" jsonb;--> statement-breakpoint
ALTER TABLE "manager_permissions" ADD CONSTRAINT "manager_permissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Managers created before per-module permissions could read every page and change nothing.
-- Keep exactly that for them: view on every module, manage on none. Admins then adjust it.
INSERT INTO "manager_permissions" ("user_id", "module", "can_view", "can_manage")
SELECT u."id", m."module", true, false
FROM "users" u
CROSS JOIN (VALUES ('dashboard'), ('checks'), ('exceptions'), ('reports'), ('machines'), ('parameters'), ('activities'), ('schedules'), ('shifts'), ('departments'), ('workers'), ('assignments'), ('audit_logs'), ('settings')) AS m("module")
WHERE u."role" = 'MANAGER'
ON CONFLICT DO NOTHING;
