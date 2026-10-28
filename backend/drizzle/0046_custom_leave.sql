ALTER TABLE "leave_requests" ADD COLUMN "custom_type" text;--> statement-breakpoint
ALTER TABLE "leave_types" ADD COLUMN "is_custom" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- A Custom Leave type: the employee types the leave's own name. No limit, listed last.
INSERT INTO "leave_types" ("name", "code", "annual_quota", "is_paid", "allow_half_day", "requires_attachment", "advance_notice_days", "carry_forward_max", "is_custom", "is_active", "sort_order")
VALUES ('Custom Leave', 'CUSTOM', NULL, true, true, false, 0, 0, true, true, 90)
ON CONFLICT DO NOTHING;
