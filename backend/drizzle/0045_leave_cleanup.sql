ALTER TABLE "leave_requests" DROP COLUMN "reminded_at";--> statement-breakpoint
ALTER TABLE "leave_requests" DROP COLUMN "escalated_at";--> statement-breakpoint
ALTER TABLE "shift_change_requests" DROP COLUMN "reminded_at";--> statement-breakpoint
ALTER TABLE "shift_change_requests" DROP COLUMN "escalated_at";--> statement-breakpoint
-- Leave Settings: the Admin role adds, edits and deletes leave types.
UPDATE "role_permissions" SET "can_create" = true, "can_delete" = true, "can_manage" = true WHERE "role" = 'ADMIN' AND "module" = 'leave_settings';--> statement-breakpoint
-- Paid Leave (PL) is no longer offered; removed when no request uses it.
DELETE FROM "leave_types" WHERE "code" = 'PL' AND NOT EXISTS (SELECT 1 FROM "leave_requests" r WHERE r."leave_type_id" = "leave_types"."id");--> statement-breakpoint
-- Reminders and escalation were removed: their stored setting goes too.
UPDATE "settings" SET "value" = "value" - 'reminders' WHERE "key" = 'leaveSettings';
