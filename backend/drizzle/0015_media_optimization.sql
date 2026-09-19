CREATE TYPE "public"."media_processing" AS ENUM('PENDING', 'COMPRESSED', 'ORIGINAL', 'FAILED');--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "processing" "media_processing";--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "original_size_bytes" integer;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "original_sha256" text;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "width" integer;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "height" integer;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "media_original_sha256_idx" ON "media" USING btree ("original_sha256");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "media_processing_pending_idx" ON "media" USING btree ("created_at") WHERE "media"."processing" = 'PENDING';
