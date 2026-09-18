import { and, asc, eq, inArray, isNull, ne } from 'drizzle-orm'
import { db, type Transaction } from '../db/client'
import { qualityChecks, scheduleTimers, schedules } from '../db/schema'
import { MINUTE } from '../lib/time'
import { generateNextChecks, invalidateCheckGeneration } from './checkGenerator'

/**
 * The monitoring timer of a schedule (machine + check type + shift). Every submission restarts
 * it: the next check is due `interval` minutes after the submission, not at the next slot of a
 * fixed grid. Exceptions do not restart it.
 */

/**
 * Restarts the timer inside the submission's transaction, with the timer row locked so two
 * submissions can never both move it. Returns the time the next check should be due.
 */
export async function resetScheduleTimer(
  tx: Transaction,
  scheduleId: string,
  checkId: string,
  submittedAt: Date
): Promise<Date | null> {
  const [schedule] = await tx.select().from(schedules).where(eq(schedules.id, scheduleId))
  if (!schedule) return null

  // Take the row lock first; the insert makes sure there is a row to lock.
  await tx.insert(scheduleTimers).values({ scheduleId }).onConflictDoNothing()
  await tx.select().from(scheduleTimers).where(eq(scheduleTimers.scheduleId, scheduleId)).for('update')

  const nextDueAt = new Date(submittedAt.getTime() + Math.max(schedule.intervalMinutes, 5) * MINUTE)
  await tx
    .update(scheduleTimers)
    .set({ lastSubmittedAt: submittedAt, lastCheckId: checkId, nextDueAt, updatedAt: new Date() })
    .where(eq(scheduleTimers.scheduleId, scheduleId))

  // Any other open slot of this schedule that nobody was told about is replaced by the next check.
  await tx
    .delete(qualityChecks)
    .where(
      and(
        eq(qualityChecks.scheduleId, scheduleId),
        ne(qualityChecks.id, checkId),
        eq(qualityChecks.status, 'PENDING'),
        isNull(qualityChecks.notifiedAt)
      )
    )
  return nextDueAt
}

/**
 * After the submission is committed: create the next check straight away and record the time it
 * is really due (the shift may have ended, or the plant may be closed that day) on the timer and
 * on the submitted check. Returns that time, or null when there is no next check.
 */
export async function settleNextDue(check: { id: string; scheduleId: string | null; machineId: string; activityId: string }) {
  invalidateCheckGeneration()
  await generateNextChecks(true)

  const where = check.scheduleId
    ? eq(qualityChecks.scheduleId, check.scheduleId)
    : and(eq(qualityChecks.machineId, check.machineId), eq(qualityChecks.activityId, check.activityId))!
  const [next] = await db
    .select({ id: qualityChecks.id, scheduledAt: qualityChecks.scheduledAt })
    .from(qualityChecks)
    .where(and(where, inArray(qualityChecks.status, ['PENDING', 'DUE', 'IN_PROGRESS'])))
    .orderBy(asc(qualityChecks.scheduledAt))
    .limit(1)

  const nextDueAt = next?.scheduledAt ?? null
  await db.update(qualityChecks).set({ nextDueAt }).where(eq(qualityChecks.id, check.id))
  if (check.scheduleId) {
    await db.update(scheduleTimers).set({ nextDueAt }).where(eq(scheduleTimers.scheduleId, check.scheduleId))
  }
  return nextDueAt
}

/** When the next check of this schedule is due, as stored by the last submission. */
export async function timerOf(scheduleId: string) {
  const [row] = await db.select().from(scheduleTimers).where(eq(scheduleTimers.scheduleId, scheduleId))
  return row ?? null
}
