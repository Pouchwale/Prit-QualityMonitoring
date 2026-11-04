ALTER TABLE "machine_breakdowns" ADD COLUMN "photo_path" text;--> statement-breakpoint
ALTER TABLE "machine_breakdowns" ADD COLUMN "photo_mime_type" text;--> statement-breakpoint
ALTER TABLE "machine_breakdowns" ADD COLUMN "photo_size_bytes" integer;--> statement-breakpoint
ALTER TABLE "machine_breakdowns" ADD COLUMN "photo_captured_at" timestamp with time zone;