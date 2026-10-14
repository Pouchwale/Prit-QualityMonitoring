ALTER TABLE "exceptions" ADD COLUMN "reading_label" text;--> statement-breakpoint
ALTER TABLE "exceptions" ADD COLUMN "reading_value" double precision;--> statement-breakpoint
ALTER TABLE "exceptions" ADD COLUMN "reading_unit" text;--> statement-breakpoint
ALTER TABLE "exception_reasons" ADD COLUMN "reading_label" text;--> statement-breakpoint
ALTER TABLE "exception_reasons" ADD COLUMN "reading_unit" text;--> statement-breakpoint
-- White Viscosity exceptions ask for the viscosity reading (seconds, as the White Viscosity parameter).
UPDATE "exception_reasons" SET "reading_label" = 'Viscosity', "reading_unit" = 'sec' WHERE "label" = 'White Viscosity' AND "reading_label" IS NULL;
