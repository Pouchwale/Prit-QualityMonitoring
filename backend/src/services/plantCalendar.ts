import { and, asc, eq, gte, inArray, isNull, lt, lte, or } from 'drizzle-orm'
import { db } from '../db/client'
import { plantClosures, qualityChecks } from '../db/schema'
import { addDays, dateKey, parseDateKey, startOfDay } from '../lib/time'

/**
 * Plant Calendar: days the plant is closed (Plant Closed, Holiday or Shutdown).
 *
 * On a closed date, judged by the local date of each check's scheduled time:
 *  - no scheduled checks are generated (checkGenerator.ensureChecksForDay),
 *  - checks that were already generated and not submitted are removed, so none is ever marked
 *    Missed and no due alert is sent (removeChecksOnClosedDays, run before every status refresh),
 *  - the due-alert sender skips the date as well, in case a check slips through.
 * Submitted checks (Completed / Exception) are real records and are never removed.
 * Removing a closure lets the day's checks be generated again from the schedules.
 */

export type ClosureType = (typeof plantClosures.type.enumValues)[number]

export const CLOSURE_LABEL: Record<ClosureType, string> = {
  CLOSED: 'Plant Closed',
  HOLIDAY: 'Holiday',
  SHUTDOWN: 'Shutdown'
}

/** How far back and ahead the status refresher looks for closed days with open checks. */
const PURGE_WINDOW_DAYS = 62

/** Closed dates (YYYY-MM-DD) between two dates, inclusive. */
export async function closedDateKeys(from: Date, to: Date): Promise<Set<string>> {
  const rows = await db
    .select({ date: plantClosures.date })
    .from(plantClosures)
    .where(and(gte(plantClosures.date, dateKey(from)), lte(plantClosures.date, dateKey(to))))
  return new Set(rows.map((r) => r.date))
}

/** The closure on a date, if the plant is closed that day. */
export async function closureOn(day: Date) {
  const [row] = await db
    .select({ id: plantClosures.id, date: plantClosures.date, type: plantClosures.type, reason: plantClosures.reason })
    .from(plantClosures)
    .where(eq(plantClosures.date, dateKey(day)))
  return row ? { ...row, label: CLOSURE_LABEL[row.type] } : null
}

/** Checks on these dates that were never submitted: open ones and ones already marked Missed. */
function unsubmittedOn(keys: string[]) {
  const days = keys.map((key) => parseDateKey(key))
  return and(
    or(...days.map((day) => and(gte(qualityChecks.scheduledAt, day), lt(qualityChecks.scheduledAt, addDays(day, 1)))))!,
    isNull(qualityChecks.submittedAt),
    inArray(qualityChecks.status, ['PENDING', 'DUE', 'IN_PROGRESS', 'MISSED'])
  )
}

/** Removes the unsubmitted checks on closed dates. Returns how many were removed. */
export async function removeChecksOnClosedDays(keys: string[]) {
  if (keys.length === 0) return 0
  let removed = 0
  for (let i = 0; i < keys.length; i += 50) {
    const rows = await db.delete(qualityChecks).where(unsubmittedOn(keys.slice(i, i + 50))).returning({ id: qualityChecks.id })
    removed += rows.length
  }
  return removed
}

/** Run before statuses are refreshed: nothing on a closed day may become Due or Missed. */
export async function purgeClosedDays() {
  const today = startOfDay(new Date())
  const keys = await closedDateKeys(addDays(today, -PURGE_WINDOW_DAYS), addDays(today, PURGE_WINDOW_DAYS))
  return removeChecksOnClosedDays([...keys])
}

/** Closures in a date range, oldest first. */
export async function listClosures(from: string, to: string) {
  return db
    .select({
      id: plantClosures.id,
      date: plantClosures.date,
      type: plantClosures.type,
      reason: plantClosures.reason,
      updatedAt: plantClosures.updatedAt
    })
    .from(plantClosures)
    .where(and(gte(plantClosures.date, from), lte(plantClosures.date, to)))
    .orderBy(asc(plantClosures.date))
}
