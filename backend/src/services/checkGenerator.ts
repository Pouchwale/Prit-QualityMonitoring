import { and, eq, gt, gte, inArray, lt, lte } from 'drizzle-orm'
import { randomBytes } from 'node:crypto'
import { db } from '../db/client'
import { activities, machines, qualityChecks, schedules, shifts } from '../db/schema'
import { MINUTE, addDays, atTime, dateKey, startOfDay } from '../lib/time'
import { closedDateKeys, purgeClosedDays } from './plantCalendar'
import { eligibleWorkers, loadWorkers, pickWorker, reassignOpenChecks } from './workerAssignment'

/**
 * Scheduled checks are materialised lazily: when someone asks for a day's checks,
 * every active schedule is expanded into one row per time slot. The unique
 * (schedule_id, scheduled_at) constraint makes this idempotent.
 */

const lastGenerated = new Map<string, number>()
const REGENERATE_AFTER_MS = 60_000

export function invalidateCheckGeneration() {
  lastGenerated.clear()
}

export function makeCheckCode(scheduledAt: Date) {
  return `QC-${dateKey(scheduledAt).replace(/-/g, '')}-${randomBytes(4).toString('hex').toUpperCase()}`
}

export async function ensureChecksForDay(day: Date) {
  const key = dateKey(day)
  const last = lastGenerated.get(key)
  if (last && Date.now() - last < REGENERATE_AFTER_MS) return
  lastGenerated.set(key, Date.now())

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

  // Plant Calendar: no checks on closed dates (an overnight shift can run into the next day).
  const closed = await closedDateKeys(day, addDays(day, 2))
  // Every check is created for the worker responsible for it (services/workerAssignment.ts).
  const workers = await loadWorkers()
  const load = new Map<string, number>()

  const slots: (typeof qualityChecks.$inferInsert)[] = []
  for (const { schedule, shift } of rows) {
    const candidates = eligibleWorkers(workers, schedule.machineId, schedule.shiftId, schedule.workerId)
    // No worker on this machine and shift: no checks until the admin assigns one.
    if (candidates.length === 0) continue
    const shiftStart = atTime(day, shift.startTime)
    let start = atTime(day, schedule.startTime ?? shift.startTime)
    // A custom window earlier than the shift start belongs to the part of an overnight shift after midnight.
    if (start < shiftStart) start = addDays(start, 1)
    let end = atTime(start, schedule.endTime ?? shift.endTime)
    if (end <= start) end = addDays(end, 1) // overnight
    const interval = Math.max(schedule.intervalMinutes, 5) * MINUTE

    for (let t = start.getTime(); t < end.getTime(); t += interval) {
      const scheduledAt = new Date(t)
      const windowEndsAt = new Date(t + shift.graceMinutes * MINUTE)
      // Do not create slots that were already over when the schedule was set up.
      if (windowEndsAt <= schedule.updatedAt) continue
      if (closed.has(dateKey(scheduledAt))) continue
      slots.push({
        code: makeCheckCode(scheduledAt),
        scheduleId: schedule.id,
        machineId: schedule.machineId,
        activityId: schedule.activityId,
        workerId: pickWorker(candidates, load)!.id,
        shiftId: schedule.shiftId,
        scheduledAt,
        windowEndsAt,
        status: 'PENDING'
      })
    }
  }

  for (let i = 0; i < slots.length; i += 500) {
    await db.insert(qualityChecks).values(slots.slice(i, i + 500)).onConflictDoNothing()
  }
}

/** Moves open checks to DUE or MISSED based on the current time. */
export async function refreshStatuses() {
  // Checks on plant-closed dates are removed first, so they never become Due or Missed.
  await purgeClosedDays()
  // Open checks follow the current Machine Assignment and shifts.
  await reassignOpenChecks()
  const now = new Date()
  await db
    .update(qualityChecks)
    .set({ status: 'MISSED' })
    .where(and(inArray(qualityChecks.status, ['PENDING', 'DUE']), lt(qualityChecks.windowEndsAt, now)))
  await db
    .update(qualityChecks)
    .set({ status: 'DUE' })
    .where(
      and(eq(qualityChecks.status, 'PENDING'), lte(qualityChecks.scheduledAt, now), gte(qualityChecks.windowEndsAt, now))
    )
}

/** Generates checks for the given days (plus the previous day for overnight shifts) and refreshes statuses. */
export async function prepareChecks(days: Date[]) {
  const unique = new Map<string, Date>()
  for (const day of days) {
    for (const d of [addDays(startOfDay(day), -1), startOfDay(day)]) unique.set(dateKey(d), d)
  }
  for (const d of unique.values()) await ensureChecksForDay(d)
  await refreshStatuses()
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
