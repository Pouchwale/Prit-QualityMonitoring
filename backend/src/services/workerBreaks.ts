import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import { db } from '../db/client'
import { qualityChecks, workerBreaks } from '../db/schema'
import { addDays, atTime, startOfDay } from '../lib/time'

/**
 * Worker breaks (Shifts page → Break times): each worker's own daily break, plant time. One rule, in
 * one place, keeps a worker's checks out of their break, and everything else follows the checks:
 *
 *   A check that would be due during the break, or whose deadline (end of its window) would fall
 *   inside it, moves to the end of the break with its full window.
 *
 * So nothing is due and nothing is notified during the break (the notification goes out when the
 * check becomes due, at the end of the break), nothing turns Missed during it, and the Performance
 * page, the daily and weekly reports and the PDFs count each check from its own (moved) times, exactly
 * as before. A check already notified before the break (or one the worker opened during it) keeps its
 * due time; only its deadline moves on by the length of the break, the time the clock stood still.
 *
 * Applied when a check is planned (checkGenerator, jobMonitoring) and again every minute to the open
 * checks (keepChecksOutOfBreaks), so a break added or changed later, or a job handed over to a worker
 * with another break, applies at once. Both rules are idempotent: a moved check is never moved again.
 */

export interface BreakTime {
  /** HH:MM, plant time. */
  startTime: string
  /** HH:MM, plant time; earlier than the start means the break runs past midnight. */
  endTime: string
}

export type BreaksByWorker = Map<string, BreakTime>

export async function loadBreaks(): Promise<BreaksByWorker> {
  const rows = await db.select().from(workerBreaks)
  return new Map(rows.map((r) => [r.workerId, { startTime: r.startTime, endTime: r.endTime }]))
}

/** The break running at `at` (from its start, up to but not including its end), if any. */
export function breakAround(b: BreakTime, at: Date): { start: Date; end: Date } | null {
  for (const offset of [-1, 0]) {
    const day = addDays(startOfDay(at), offset)
    const start = atTime(day, b.startTime)
    let end = atTime(day, b.endTime)
    if (end <= start) end = addDays(end, 1)
    if (start <= at && at < end) return { start, end }
  }
  return null
}

/** The deadline falls inside the break: after its start, up to and including its end. */
const deadlineIn = (b: BreakTime, windowEndsAt: Date) => breakAround(b, new Date(windowEndsAt.getTime() - 1))

/** A not yet notified check's times, moved to the end of the break when it is due or ends inside it. */
export function outsideBreak(b: BreakTime | undefined, scheduledAt: Date, windowEndsAt: Date) {
  if (!b) return { scheduledAt, windowEndsAt }
  // A few rounds at most: a long window moved past one break could end in the next day's.
  for (let i = 0; i < 3; i++) {
    const brk = breakAround(b, scheduledAt) ?? deadlineIn(b, windowEndsAt)
    if (!brk) break
    const length = windowEndsAt.getTime() - scheduledAt.getTime()
    scheduledAt = brk.end
    windowEndsAt = new Date(brk.end.getTime() + length)
  }
  return { scheduledAt, windowEndsAt }
}

/** A notified check keeps its due time; a deadline inside the break moves on by the break's length. */
function pausedDeadline(b: BreakTime, windowEndsAt: Date) {
  const brk = deadlineIn(b, windowEndsAt)
  return brk ? new Date(windowEndsAt.getTime() + (brk.end.getTime() - brk.start.getTime())) : windowEndsAt
}

const isUniqueViolation = (err: unknown) => {
  const e = err as { code?: string; cause?: { code?: string } }
  return (e?.code ?? e?.cause?.code) === '23505'
}

/**
 * Applies the break rule to every open (Pending/Due) check of a worker who has a break. Runs before
 * checks are moved to Due or Missed (checkGenerator.updateStatuses). Returns how many checks moved.
 */
export async function keepChecksOutOfBreaks(now = new Date()): Promise<number> {
  const breaks = await loadBreaks()
  if (!breaks.size) return 0
  const open = await db
    .select({
      id: qualityChecks.id,
      workerId: qualityChecks.workerId,
      status: qualityChecks.status,
      kind: qualityChecks.kind,
      jobId: qualityChecks.jobId,
      activityId: qualityChecks.activityId,
      parameterIds: qualityChecks.parameterIds,
      scheduledAt: qualityChecks.scheduledAt,
      windowEndsAt: qualityChecks.windowEndsAt,
      notifiedAt: qualityChecks.notifiedAt
    })
    .from(qualityChecks)
    .where(and(inArray(qualityChecks.status, ['PENDING', 'DUE']), isNotNull(qualityChecks.workerId), inArray(qualityChecks.workerId, [...breaks.keys()])))

  let moved = 0
  for (const c of open) {
    const b = breaks.get(c.workerId!)!
    const next = c.notifiedAt
      ? { scheduledAt: c.scheduledAt, windowEndsAt: pausedDeadline(b, c.windowEndsAt) }
      : outsideBreak(b, c.scheduledAt, c.windowEndsAt)
    if (+next.scheduledAt === +c.scheduledAt && +next.windowEndsAt === +c.windowEndsAt) continue
    const status = c.status === 'DUE' && !c.notifiedAt && next.scheduledAt > now ? 'PENDING' : c.status
    try {
      await db
        .update(qualityChecks)
        .set({ ...next, status })
        .where(and(eq(qualityChecks.id, c.id), inArray(qualityChecks.status, ['PENDING', 'DUE'])))
      moved++
    } catch (err) {
      if (!isUniqueViolation(err)) throw err
      // Another check of this schedule is already at that time: leave this one as it is (never stop the tick).
      if (!c.jobId) {
        console.warn(`[breaks] Check ${c.id} could not move to ${next.scheduledAt.toISOString()}: another check of its schedule is there.`)
        continue
      }
      // Another open check of the same job and check type is already due at the end of the break:
      // that one asks for these parameters too, so the worker gets one check, not two.
      const [other] = await db
        .select({ id: qualityChecks.id, parameterIds: qualityChecks.parameterIds })
        .from(qualityChecks)
        .where(
          and(
            eq(qualityChecks.jobId, c.jobId),
            eq(qualityChecks.activityId, c.activityId),
            eq(qualityChecks.kind, c.kind),
            eq(qualityChecks.scheduledAt, next.scheduledAt),
            inArray(qualityChecks.status, ['PENDING', 'DUE'])
          )
        )
      if (!other) continue
      await db.transaction(async (tx) => {
        await tx
          .update(qualityChecks)
          .set({ parameterIds: [...new Set([...(other.parameterIds ?? []), ...(c.parameterIds ?? [])])] })
          .where(eq(qualityChecks.id, other.id))
        await tx.delete(qualityChecks).where(and(eq(qualityChecks.id, c.id), inArray(qualityChecks.status, ['PENDING', 'DUE'])))
      })
      moved++
    }
  }
  return moved
}
