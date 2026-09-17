CREATE TYPE "public"."closure_type" AS ENUM('CLOSED', 'HOLIDAY', 'SHUTDOWN');--> statement-breakpoint
CREATE TABLE "plant_closures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"date" date NOT NULL,
	"type" "closure_type" DEFAULT 'CLOSED' NOT NULL,
	"reason" text,
	"created_by_id" uuid,
	"updated_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plant_closures_date_unique" UNIQUE("date")
);
--> statement-breakpoint
ALTER TABLE "plant_closures" ADD CONSTRAINT "plant_closures_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plant_closures" ADD CONSTRAINT "plant_closures_updated_by_id_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;