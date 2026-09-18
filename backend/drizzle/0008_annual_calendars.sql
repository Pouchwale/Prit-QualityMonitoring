CREATE TYPE "public"."calendar_year_status" AS ENUM('DRAFT', 'APPROVED');--> statement-breakpoint
CREATE TABLE "calendar_year_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"calendar_year_id" uuid NOT NULL,
	"type" "closure_type" NOT NULL,
	"date" date,
	"name" text,
	"for_holiday_date" date,
	"printed_weekday" text,
	"source_text" text,
	"source_row" integer,
	"uncertain_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confirmed" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_years" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"year" integer NOT NULL,
	"status" "calendar_year_status" DEFAULT 'DRAFT' NOT NULL,
	"pending_changes" boolean DEFAULT false NOT NULL,
	"source_file_name" text,
	"source_path" text,
	"source_mime_type" text,
	"extraction_method" text,
	"extraction_note" text,
	"approved_by_id" uuid,
	"approved_at" timestamp with time zone,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_years_year_unique" UNIQUE("year")
);
--> statement-breakpoint
CREATE TABLE "plant_weekly_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"weekday" integer NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"note" text,
	"created_by_id" uuid,
	"updated_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "plant_closures" ADD COLUMN "calendar_year_id" uuid;--> statement-breakpoint
ALTER TABLE "calendar_year_items" ADD CONSTRAINT "calendar_year_items_calendar_year_id_calendar_years_id_fk" FOREIGN KEY ("calendar_year_id") REFERENCES "public"."calendar_years"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_years" ADD CONSTRAINT "calendar_years_approved_by_id_users_id_fk" FOREIGN KEY ("approved_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_years" ADD CONSTRAINT "calendar_years_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plant_weekly_rules" ADD CONSTRAINT "plant_weekly_rules_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plant_weekly_rules" ADD CONSTRAINT "plant_weekly_rules_updated_by_id_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "calendar_year_items_year_idx" ON "calendar_year_items" USING btree ("calendar_year_id");--> statement-breakpoint
ALTER TABLE "plant_closures" ADD CONSTRAINT "plant_closures_calendar_year_id_calendar_years_id_fk" FOREIGN KEY ("calendar_year_id") REFERENCES "public"."calendar_years"("id") ON DELETE set null ON UPDATE no action;