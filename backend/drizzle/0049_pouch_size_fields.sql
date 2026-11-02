ALTER TABLE "parameters" ADD COLUMN "measure_fields" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
-- Pouch Size: the worker enters Height, Width and Gusset (mm), then chooses Pass or Fail.
UPDATE "parameters"
SET "measure_fields" = '["Height", "Width", "Gusset"]'::jsonb,
    "unit" = COALESCE(NULLIF(TRIM("unit"), ''), 'mm')
WHERE "code" = 'POUCH-SIZE' AND "type" = 'PASS_FAIL' AND jsonb_array_length("measure_fields") = 0;
