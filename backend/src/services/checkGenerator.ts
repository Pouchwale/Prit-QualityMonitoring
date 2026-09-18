import { and, asc, eq, gt, gte, inArray, isNull, lt, lte } from 'drizzle-orm'
import { randomBytes } from 'node:crypto'
import { db } from '../db/client'
import { activities, jobs, machines, qualityChecks, scheduleTimers, schedules, shifts } from '../db/schema'
import { MINUTE, addDays, atTime, dateKey, startOfDay } from '../lib/time'
import { closedDateKeys, purgeClosedDays } from './plantCalendar'
import { eligibleWorkers, loadWorkers, pickWorker, reassignOpenChecks } from './workerAssignment'

/**
 * The rolling scheduler: every schedule (machine + check type + shift) has **one open check at a
 * time**, its "next check", and the timer restarts at every submission.
 *
 *   next due = the time the shift window opens when nothing has happened in it yet,
 *              otherwise the last submission + the interval,
 *              and after a missed check at least the end of that check's window.
 *
 * A JOB schedule only creates checks while a job runs on the machine, and never before the job
 * started. Windows already over when the generator runs (the server was off, or a check was
 * missed while nobody was looking) are recorded as Missed, exactly as the old grid did.
 *
 * The unique index `quality_checks_one_open_per_schedule` (and the older
 * `(schedule_id, scheduled_at)` one) makes every insert idempotent, so parallel ticks, several
 * server processes and a submission racing the scheduler can never create two open checks.
 */

const REGENERATE_AFTER_MS = 60_000
let lastGenerated = 0
let running: Promise<void> | null = null

export function invalidateCheckGeneration() {
  lastGenerated = 0
}

export function makeCheckCode(scheduledAt: Date) {
  return `QC-${dateKey(scheduledAt).replace(/-/g, '')}-${randomBytes(4).toString('hex').toUpperCase()}`
}

/** How long a manual check stays open when the shift's grace period is shorter. */
export const MIN_MANUAL_WINDOW_MINUTES = 30

export interface Occurrence {
  /** When this schedule's window opens and closes on this shift occurrence. */
  start: Date
  end: Date
}

type ScheduleRow = typeof schedules.$inferSelect
type ShiftRow = typeof shifts.$inferSelect

/**
 * The schedule's windows (one per shift occurrence) that are still running or start within
 * `days` days, oldest first. Occurrences that ended before `from - 1 day` are left out.
 */
export function occurrences(schedule: ScheduleRow, shift: ShiftRow, from: Date, days = 8): Occurrence[] {
  const list: Occurrence[] = []
  const horizon = new Date(from.getTime() + days * 24 * 60 * MINUTE)
  const firstDay = addDays(startOfDay(from), -1)
  for (let i = 0; i <= days + 1; i++) {
    const day = addDays(firstDay, i)
    const shiftStart = atTime(day, shift.startTime)
    let start = atTime(day, schedule.startTime ?? shift.startTime)
    // A custom window earlier than the shift start belongs to the part of an overnight shift after midnight.
    if (start < shiftStart) start = addDays(start, 1)
    let end = atTime(start, schedule.endTime ?? shift.endTime)
    if (end <= start) end = addDays(end, 1) // overnight
    if (end <= firstDay || start > horizon) continue
    list.push({ start, end })
  }
  return list.sort((a, b) => a.start.getTime() - b.start.getTime())
}

/** The occurrence of this schedule that is running at `at`, if any. */
export function occurrenceAt(schedule: ScheduleRow, shift: ShiftRow, at: Date): Occurrence | null {
  return occurrences(schedule, shift, at, 1).find((o) => o.start <= at && at < o.end) ?? null
}

/** The active schedule of this machine + check type whose window is open now, with its shift. */
export async function currentSchedule(machineId: string, activityId: string, at: Date) {
  const rows = await db
    .select({ schedule: schedules, shift: shifts })
    .from(schedules)
    .innerJoin(shifts, eq(schedules.shiftId, shifts.id))
    .where(
      and(
        eq(schedules.machineId, machineId),
        eq(schedules.activityId, activityId),
        eq(schedules.isActive, true),
        eq(shifts.isActive, true)
      )
    )
  for (const row of rows) {
    const occurrence = occurrenceAt(row.schedule, row.shift, at)
    if (occurrence) return { ...row, occurrence }
  }
  return null
}

interface AnchorEvent {
  /** When something happened (a submission, or the scheduled time of a missed/exception check). */
  at: Date
  /** The earliest the next check may be due because of it. */
  next: Date
}

/**
 * Creates the next check of every schedule that has no open check. Safe to call from several
 * places at once: concurrent calls share one run and every insert is idempotent.
 */
export async function generateNextChecks(force = false): Promise<void> {
  if (running) return running
  if (!force && Date.now() - lastGenerated < REGENERATE_AFTER_MS) return
  running = generate().finally(() => {
    running = null
  })
  return running
}

async function generate() {
  const inserts = await planChecks(new Date(), { markGenerated: true })
  for (let i = 0; i < inserts.length; i += 500) {
    await db.insert(qualityChecks).values(inserts.slice(i, i + 500)).onConflictDoNothing()
  }
}

/**
 * What the scheduler would create for every schedule if it ran at `now` and none of them had an
 * open check yet. Nothing is written. It answers "would this date get checks?" for any date,
 * which the scheduler itself cannot be asked directly: it only ever keeps one open check per
 * schedule, so a day is never filled with a grid of slots in advance.
 */
export async function planNextChecks(now = new Date()) {
  return planChecks(now, { ignoreOpen: true })
}

async function planChecks(now: Date, options: { ignoreOpen?: boolean; markGenerated?: boolean } = {}) {
  const rows = await db
    .select({ schedule: schedules, shift: shifts })
    .from(schedules)
    .innerJoin(shifts, eq(schedules.shiftId, shifts.id))
    .innerJoin(machines, eq(schedules.machineId, machines.id))
    .innerJoin(activities, eq(schedules.activityId, activities.id))
    .where(
      and(
        eq(schedules.isActive, true),
        eq(shifts.isActive, true),
        eq(machines.isActive, true),
        eq(machines.status, 'ACTIVE'),
        eq(activities.isActive, true)
      )
    )
  if (options.markGenerated) lastGenerated = Date.now()
  if (rows.length === 0) return []

  const scheduleIds = rows.map((r) => r.schedule.id)
  const since = addDays(startOfDay(now), -2)
  const [openRows, timers, history, runningJobs] = await Promise.all([
    db
      .select({ scheduleId: qualityChecks.scheduleId })
      .from(qualityChecks)
      .where(and(inArray(qualityChecks.scheduleId, scheduleIds), inArray(qualityChecks.status, ['PENDING', 'DUE', 'IN_PROGRESS']))),
    db.select().from(scheduleTimers).where(inArray(scheduleTimers.scheduleId, scheduleIds)),
    db
      .select({
        scheduleId: qualityChecks.scheduleId,
        status: qualityChecks.status,
        scheduledAt: qualityChecks.scheduledAt,
        windowEndsAt: qualityChecks.windowEndsAt,
        submittedAt: qualityChecks.submittedAt
      })
      .from(qualityChecks)
      .where(
        and(
          inArray(qualityChecks.scheduleId, scheduleIds),
          inArray(qualityChecks.status, ['COMPLETED', 'MISSED', 'EXCEPTION']),
          gte(qualityChecks.scheduledAt, since)
        )
      ),
    db.select().from(jobs).where(isNull(jobs.endedAt))
  ])

  const open = options.ignoreOpen ? new Set<string | null>() : new Set(openRows.map((r) => r.scheduleId))
  const timerBySchedule = new Map(timers.map((t) => [t.scheduleId, t]))
  const jobByMachine = new Map(runningJobs.map((j) => [j.machineId, j]))
  const historyBySchedule = new Map<string, typeof history>()
  for (const row of history) {
    if (!row.scheduleId) continue
    historyBySchedule.set(row.scheduleId, [...(historyBySchedule.get(row.scheduleId) ?? []), row])
  }

  // Plant Calendar: no checks on closed dates (an overnight shift can run into the next day).
  const closed = await closedDateKeys(addDays(startOfDay(now), -1), addDays(startOfDay(now), 10))
  // Every check is created for the worker responsible for it (services/workerAssignment.ts).
  const workers = await loadWorkers()
  const load = new Map<string, number>()

  const inserts: (typeof qualityChecks.$inferInsert)[] = []
  for (const { schedule, shift } of rows) {
    if (open.has(schedule.id)) continue
    const candidates = eligibleWorkers(workers, schedule.machineId, schedule.shiftId, schedule.workerId)
    // No worker on this machine and shift: no checks until the admin assigns one.
    if (candidates.length === 0) continue

    const job = jobByMachine.get(schedule.machineId) ?? null
    if (schedule.mode === 'JOB' && !job) continue

    const interval = Math.max(schedule.intervalMinutes, 5) * MINUTE
    const grace = shift.graceMinutes * MINUTE
    const timer = timerBySchedule.get(schedule.id)
    const past = historyBySchedule.get(schedule.id) ?? []

    let created = false
    for (const occurrence of occurrences(schedule, shift, now)) {
      if (occurrence.end <= now) continue
      // JOB schedules never look before the job started.
      const from = schedule.mode === 'JOB' && job ? new Date(Math.max(occurrence.start.getTime(), job.startedAt.getTime())) : occurrence.start
      if (from >= occurrence.end) continue

      const events: AnchorEvent[] = []
      if (timer?.lastSubmittedAt && timer.lastSubmittedAt >= occurrence.start && timer.lastSubmittedAt < occurrence.end) {
        events.push({ at: timer.lastSubmittedAt, next: new Date(timer.lastSubmittedAt.getTime() + interval) })
      }
      for (const check of past) {
        if (check.scheduledAt < occurrence.start || check.scheduledAt >= occurrence.end) continue
        if (check.status === 'MISSED') {
          const next = new Date(Math.max(check.scheduledAt.getTime() + interval, check.windowEndsAt.getTime()))
          events.push({ at: check.windowEndsAt, next })
        } else {
          // Completed: counted from the submission. Exception: it does not restart the timer.
          const at = check.status === 'COMPLETED' ? (check.submittedAt ?? check.scheduledAt) : check.scheduledAt
          events.push({ at, next: new Date(at.getTime() + interval) })
        }
      }

      let nextDue = from
      for (const event of events) {
        if (event.at < from) continue // before the job started, or before this window opened
        if (event.next > nextDue) nextDue = event.next
      }
      // Slots that were already over when the schedule was set up are not created (as before).
      if (nextDue.getTime() + grace <= schedule.updatedAt.getTime()) {
        const steps = Math.ceil((schedule.updatedAt.getTime() - grace - nextDue.getTime() + 1) / interval)
        nextDue = new Date(nextDue.getTime() + steps * interval)
      }

      while (nextDue < occurrence.end) {
        if (closed.has(dateKey(nextDue))) {
          // An overnight window can run into a closed date; the part before midnight still counts.
          const nextDay = startOfDay(addDays(nextDue, 1))
          if (nextDay >= occurrence.end || closed.has(dateKey(nextDay))) break
          nextDue = nextDay
          continue
        }
        const windowEndsAt = new Date(nextDue.getTime() + grace)
        const missed = windowEndsAt < now
        inserts.push({
          code: makeCheckCode(nextDue),
          scheduleId: schedule.id,
          machineId: schedule.machineId,
          activityId: schedule.activityId,
          workerId: pickWorker(candidates, load)!.id,
          shiftId: schedule.shiftId,
          jobId: job?.id ?? null,
          scheduledAt: nextDue,
          windowEndsAt,
          status: missed ? 'MISSED' : nextDue <= now ? 'DUE' : 'PENDING'
        })
        if (!missed) {
          created = true
          break
        }
        // The window is already over: record it as Missed and carry on to the following one.
        nextDue = new Date(Math.max(nextDue.getTime() + interval, windowEndsAt.getTime()))
      }
      if (created) break
    }
  }

  return inserts
}

/**
 * Kept for the callers that ask for a day's checks. The rolling generator always works out the
 * next check for every schedule, so the day itself only matters for the "is anything due?" pass.
 */
export async function ensureChecksForDay(_day: Date) {
  await generateNextChecks()
}

/** Moves open checks to DUE or MISSED based on the current time. Returns how many were missed. */
async function updateStatuses(): Promise<number> {
  const now = new Date()
  const missed = await db
    .update(qualityChecks)
    .set({ status: 'MISSED' })
    .where(and(inArray(qualityChecks.status, ['PENDING', 'DUE']), lt(qualityChecks.windowEndsAt, now)))
    .returning({ id: qualityChecks.id })
  await db
    .update(qualityChecks)
    .set({ status: 'DUE' })
    .where(
      and(eq(qualityChecks.status, 'PENDING'), lte(qualityChecks.scheduledAt, now), gte(qualityChecks.windowEndsAt, now))
    )
  return missed.length
}

/** Moves open checks to DUE or MISSED based on the current time. */
export async function refreshStatuses() {
  // Checks on plant-closed dates are removed first, so they never become Due or Missed.
  await purgeClosedDays()
  // Open checks follow the current Machine Assignment and shifts.
  await reassignOpenChecks()
  // A check that has just been missed frees its schedule for the next one.
  if (await updateStatuses()) invalidateCheckGeneration()
}

/** Refreshes statuses, creates the next check of every schedule, and opens the ones that are due. */
export async function prepareChecks(_days: Date[] = []) {
  await refreshStatuses()
  await generateNextChecks()
  await updateStatuses()
}

type Scope = { scheduleId: string } | { machineId: string } | { activityId: string } | { shiftId: string }

/**
 * After a configuration change, drop upcoming checks that nobody has started so they
 * are regenerated from the new configuration. Submitted and past checks are kept.
 */
export async function removeUpcomingChecks(scope: Scope) {
  const column =
    'scheduleId' in scope
      ? eq(qualityChecks.scheduleId, scope.scheduleId)
      : 'machineId' in scope
        ? eq(qualityChecks.machineId, scope.machineId)
        : 'activityId' in scope
          ? eq(qualityChecks.activityId, scope.activityId)
          : eq(qualityChecks.shiftId, scope.shiftId)

  await db
    .delete(qualityChecks)
    .where(and(column, eq(qualityChecks.status, 'PENDING'), gt(qualityChecks.scheduledAt, new Date())))
  invalidateCheckGeneration()
}

/**
 * When a job ends, the checks it created that nobody has been told about disappear, so nothing
 * is marked Missed for a machine that is not running. Checks already due stay until their window
 * closes.
 */
export async function removePendingJobChecks(machineId: string) {
  const jobSchedules = await db
    .select({ id: schedules.id })
    .from(schedules)
    .where(and(eq(schedules.machineId, machineId), eq(schedules.mode, 'JOB')))
  if (jobSchedules.length === 0) return 0
  const removed = await db
    .delete(qualityChecks)
    .where(
      and(
        inArray(qualityChecks.scheduleId, jobSchedules.map((s) => s.id)),
        eq(qualityChecks.status, 'PENDING'),
        isNull(qualityChecks.notifiedAt)
      )
    )
    .returning({ id: qualityChecks.id })
  invalidateCheckGeneration()
  return removed.length
}

/** The schedule's open check (pending or due), if it has one. */
export async function openCheckOfSchedule(scheduleId: string) {
  const [row] = await db
    .select()
    .from(qualityChecks)
    .where(and(eq(qualityChecks.scheduleId, scheduleId), inArray(qualityChecks.status, ['PENDING', 'DUE', 'IN_PROGRESS'])))
    .orderBy(asc(qualityChecks.scheduledAt))
    .limit(1)
  return row ?? null
}
