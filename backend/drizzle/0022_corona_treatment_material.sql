ALTER TABLE "parameters" ADD COLUMN "material_options" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint

-- Treatment is merged into Corona Treatment: the worker picks the material first (BOPP 38 /
-- PET 56), then the dyne, and both are recorded together on the one parameter.
UPDATE "parameters" corona
SET "material_options" = COALESCE(
  (SELECT t."options" FROM "parameters" t WHERE t."code" = 'TREATMENT' AND jsonb_array_length(t."options") > 0),
  '["BOPP 38", "PET 56"]'::jsonb
)
WHERE corona."code" = 'CORONA' AND jsonb_array_length(corona."material_options") = 0;--> statement-breakpoint

-- Off every check type, so it is no longer a parameter of its own on any worker form.
DELETE FROM "activity_parameters"
WHERE "parameter_id" IN (SELECT "id" FROM "parameters" WHERE "code" = 'TREATMENT');--> statement-breakpoint

-- Kept as a disabled row, never deleted: readings already recorded against it point at it and
-- must keep doing so.
UPDATE "parameters" SET "is_active" = false WHERE "code" = 'TREATMENT';
