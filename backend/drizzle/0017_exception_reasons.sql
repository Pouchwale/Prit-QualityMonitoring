CREATE TABLE "exception_reasons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text NOT NULL,
	"requires_remark" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- The six reasons the worker app offered before they could be configured. Existing exceptions
-- keep their own text, so nothing here changes an old record.
INSERT INTO "exception_reasons" ("label", "requires_remark", "sort_order")
SELECT v.label, v.requires_remark, v.sort_order
FROM (VALUES
	('Machine stopped', false, 0),
	('Machine under maintenance', false, 1),
	('Worker unavailable', false, 2),
	('Material unavailable', false, 3),
	('Production stopped', false, 4),
	('Other', true, 5)
) AS v(label, requires_remark, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM "exception_reasons" e WHERE e."label" = v.label);
