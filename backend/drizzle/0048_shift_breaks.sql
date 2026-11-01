ALTER TABLE "shifts" ADD COLUMN "break_start_time" text;--> statement-breakpoint
ALTER TABLE "shifts" ADD COLUMN "break_end_time" text;--> statement-breakpoint
-- Breaks now belong to shifts. Each shift takes the break its workers had (the most common one when
-- they differ); worker_breaks is kept as it was, no longer used.
UPDATE "shifts" s SET "break_start_time" = b.start_time, "break_end_time" = b.end_time
FROM (
  SELECT DISTINCT ON (u.shift_id) u.shift_id, wb.start_time, wb.end_time
  FROM "worker_breaks" wb JOIN "users" u ON u.id = wb.worker_id
  WHERE u.shift_id IS NOT NULL
  GROUP BY u.shift_id, wb.start_time, wb.end_time
  ORDER BY u.shift_id, count(*) DESC, wb.start_time
) b
WHERE b.shift_id = s.id;
