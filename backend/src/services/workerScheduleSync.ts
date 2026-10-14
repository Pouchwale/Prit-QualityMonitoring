import { and, eq, gt, inArray } from 'drizzle-orm'
import type { Request } from 'express'
import type { Transaction } from '../db/client'
import { activities, machines, qualityChecks, schedules, shifts } from '../db/schema'
import { audit } from '../lib/audit'
import { badRequest, conflict } from '../lib/http'

/**
 * A worker's Check Schedules follow the worker's shift (Workers & Users).
 *
 * A schedule assigned to a worker keeps a copy of that worker's shift and its times (routes/
 * schedules.ts sets them when the schedule is saved), and the check generator plans the worker's
 * checks from that copy. When the worker's shift changes, this brings every schedule of that
 * worker to the new shift, inside the transaction that saves the worker, so the worker and the
 * schedules change together or not at all. Nothing else on the schedule changes: machine, check
 * type, department, interval, mode and active state stay as they are.
 *
 * Checks: upcoming checks of those schedules that nobody has been asked to do yet (PENDING, later
 * than now) are removed, as when a schedule is edited, and the generator creates the next ones
 * from the new shift. Due, started, submitted, missed and exception checks are kept untouched.
 * Other workers' schedules are never touched.
 *
 * Clearing a worker's shift leaves their schedules as they are (they keep the last shift).
 */
export async function syncWorkerSchedules(
  tx: Transaction,
  req: Request,
  worker: { id: string; name: string; employeeId: string },
  shiftId: string | null
): Promise<{ schedules: number; removedUpcomingChecks: number }> {
  if (!shiftId) return { schedules: 0, removedUpcomingChecks: 0 }
  const [shift] = await tx.select().from(shifts).where(eq(shifts.id, shiftId))
  if (!shift) throw badRequest('The chosen shift does not exist')

  const rows = await tx
    .select({ schedule: schedules, activityName: activities.name, machineName: machines.name })
    .from(schedules)
    .innerJoin(activities, eq(activities.id, schedules.activityId))
    .leftJoin(machines, eq(machines.id, schedules.machineId))
    .where(eq(schedules.workerId, worker.id))
    .for('update', { of: schedules })
  const changing = rows.filter(
    ({ schedule: s }) => s.shiftId !== shift.id || s.startTime !== shift.startTime || s.endTime !== shift.endTime
  )
  if (!changing.length) return { schedules: 0, removedUpcomingChecks: 0 }

  // Two active schedules of this worker for the same check type and machine would become the same
  // schedule on the new shift (duplicate checks): refused, and nothing is saved.
  const seen = new Map<string, (typeof rows)[number]>()
  for (const row of rows.filter((r) => r.schedule.isActive)) {
    const key = `${row.schedule.activityId}|${row.schedule.machineId ?? ''}`
    const other = seen.get(key)
    if (other) {
      throw conflict(
        `${worker.name} has two active schedules for ${row.activityName}${row.machineName ? ` on ${row.machineName}` : ''}. ` +
          `On ${shift.name} they would be duplicates: remove or deactivate one in Check Schedules first, then change the shift.`
      )
    }
    seen.set(key, row)
  }

  const ids = changing.map((r) => r.schedule.id)
  const now = new Date()
  await tx
    .update(schedules)
    // updatedAt: slots of the new shift that were already over are not created as Missed (check generator).
    .set({ shiftId: shift.id, startTime: shift.startTime, endTime: shift.endTime, updatedAt: now })
    .where(inArray(schedules.id, ids))
  const removed = await tx
    .delete(qualityChecks)
    .where(and(inArray(qualityChecks.scheduleId, ids), eq(qualityChecks.status, 'PENDING'), gt(qualityChecks.scheduledAt, now)))
    .returning({ id: qualityChecks.id })

  await audit(
    req,
    'SYNC_WORKER_SCHEDULES',
    'User',
    worker.id,
    {
      oldValue: { worker: `${worker.name} (${worker.employeeId})`, schedules: changing.map(({ schedule: s }) => ({ id: s.id, shiftId: s.shiftId, startTime: s.startTime, endTime: s.endTime })) },
      newValue: {
        worker: `${worker.name} (${worker.employeeId})`,
        shift: shift.name,
        schedules: changing.map(({ schedule: s, activityName, machineName }) => ({ id: s.id, checkType: activityName, machine: machineName, startTime: shift.startTime, endTime: shift.endTime })),
        removedUpcomingChecks: removed.length
      }
    },
    tx
  )
  console.log(JSON.stringify({ event: 'worker_schedules_synced', workerId: worker.id, shift: shift.name, schedules: ids.length, removedUpcomingChecks: removed.length }))
  return { schedules: ids.length, removedUpcomingChecks: removed.length }
}
