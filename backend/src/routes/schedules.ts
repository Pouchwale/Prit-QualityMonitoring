import { Router } from 'express'
import { z } from 'zod'
import { and, asc, eq, ne, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { activities, departments, machineActivities, machines, schedules, shifts, users } from '../db/schema'
import { hhmm, idParam, optionalUuid } from '../lib/validate'
import { badRequest, conflict, notFound } from '../lib/http'
import { audit, snapshot } from '../lib/audit'
import { invalidateCheckGeneration, removeUpcomingChecks } from '../services/checkGenerator'

export const schedulesRouter = Router()

const input = z
  .object({
    machineId: optionalUuid,
    activityId: z.uuid('Choose a quality check'),
    shiftId: optionalUuid,
    workerId: optionalUuid,
    departmentId: optionalUuid,
    module: z.enum(['IPQC', 'QC']).default('IPQC'),
    intervalMinutes: z.coerce.number().int().min(5, 'Minimum frequency is 5 minutes').max(1440),
    /**
     * INTERVAL: checks all through the shift/window. JOB: only while a job runs on the machine.
     * Left as it is when not sent, so older screens keep the stored mode.
     */
    mode: z.enum(['INTERVAL', 'JOB']).optional(),
    startTime: hhmm.nullish().or(z.literal('')).transform((v) => v || null),
    endTime: hhmm.nullish().or(z.literal('')).transform((v) => v || null),
    isActive: z.boolean().default(true)
  })
  .refine((s) => (s.startTime === null) === (s.endTime === null), {
    message: 'Set both start and end time, or leave both empty to use the shift times',
    path: ['startTime']
  })

/**
 * A schedule given to a worker must name an active worker whose quality role covers the schedule's
 * module (IPQC, QC or both): the worker app shows a worker every check assigned to them.
 */
async function assertScheduleWorker(workerId: string | null, module: 'IPQC' | 'QC') {
  if (!workerId) return
  const [worker] = await db
    .select({ role: users.role, isActive: users.isActive, name: users.name, qualityRole: users.workerQualityRole })
    .from(users)
    .where(eq(users.id, workerId))
  if (!worker || worker.role !== 'WORKER' || !worker.isActive) throw badRequest('Choose an active worker')
  const covers = worker.qualityRole === 'BOTH' || worker.qualityRole === module
  if (!covers) throw badRequest(`${worker.name} does ${worker.qualityRole} checks; this schedule is ${module}.`)
}

/** Refuses a second active schedule for the same machine, check type, shift and worker. */
async function assertNotDuplicate(row: { machineId: string | null; activityId: string; shiftId: string | null; workerId: string | null; isActive: boolean }, exceptId?: string) {
  if (!row.isActive) return
  const [same] = await db
    .select({ id: schedules.id })
    .from(schedules)
    .where(
      and(
        eq(schedules.isActive, true),
        eq(schedules.activityId, row.activityId),
        sql`${schedules.machineId} is not distinct from ${row.machineId}`,
        sql`${schedules.shiftId} is not distinct from ${row.shiftId}`,
        sql`${schedules.workerId} is not distinct from ${row.workerId}`,
        exceptId ? ne(schedules.id, exceptId) : undefined
      )
    )
    .limit(1)
  if (same) throw conflict('An active schedule for this machine, check type, shift and worker already exists. Edit that one instead.')
}

async function validateRefs(data: z.infer<typeof input>) {
  if (data.machineId) {
    // Keep the machine ↔ quality check mapping in sync with schedules.
    await db.insert(machineActivities).values({ machineId: data.machineId, activityId: data.activityId }).onConflictDoNothing()
  }
}

schedulesRouter.get('/', async (_req, res) => {
  const rows = await db
    .select({
      schedule: schedules,
      machineName: machines.name,
      activityName: activities.name,
      activityModule: activities.module,
      departmentName: departments.name,
      shiftName: shifts.name,
      shiftStartTime: shifts.startTime,
      shiftEndTime: shifts.endTime,
      workerName: users.name,
      workerEmployeeId: users.employeeId,
      workerQualityRole: users.workerQualityRole
    })
    .from(schedules)
    .innerJoin(activities, eq(schedules.activityId, activities.id))
    .leftJoin(machines, eq(schedules.machineId, machines.id))
    .leftJoin(shifts, eq(schedules.shiftId, shifts.id))
    .leftJoin(departments, eq(schedules.departmentId, departments.id))
    .leftJoin(users, eq(schedules.workerId, users.id))
    .orderBy(asc(activities.name), asc(schedules.startTime))

  res.json(rows.map(({ schedule, ...names }) => ({ ...schedule, ...names, checkWorkers: [] })))
})

schedulesRouter.post('/', async (req, res) => {
  const data = input.parse(req.body)
  await validateRefs(data)
  // If departmentId is missing, inherit from activity
  let departmentId = data.departmentId
  let module = data.module
  let shiftId = data.shiftId
  let startTime = data.startTime
  let endTime = data.endTime

  if (data.workerId) {
    const [worker] = await db.select({ shiftId: users.shiftId }).from(users).where(eq(users.id, data.workerId))
    if (worker?.shiftId) {
      shiftId = worker.shiftId
      const [shift] = await db.select().from(shifts).where(eq(shifts.id, shiftId))
      if (shift) {
        startTime = shift.startTime
        endTime = shift.endTime
      }
    }
  }

  if (shiftId && (!startTime || !endTime)) {
    const [shift] = await db.select().from(shifts).where(eq(shifts.id, shiftId))
    if (shift) {
      startTime ??= shift.startTime
      endTime ??= shift.endTime
    }
  }

  if (!departmentId || !module) {
    const [act] = await db.select().from(activities).where(eq(activities.id, data.activityId))
    if (act) {
      departmentId ??= act.departmentId ?? null
      module ??= act.module ?? 'IPQC'
    }
  }
  await assertScheduleWorker(data.workerId, module)
  await assertNotDuplicate({ machineId: data.machineId, activityId: data.activityId, shiftId: shiftId ?? null, workerId: data.workerId, isActive: data.isActive })
  const { mode, ...rest } = data
  const [row] = await db
    .insert(schedules)
    .values({ ...rest, shiftId: shiftId ?? null, startTime: startTime ?? null, endTime: endTime ?? null, departmentId: departmentId ?? null, module, ...(mode === undefined ? {} : { mode }) })
    .returning()
  invalidateCheckGeneration()
  await audit(req, 'CREATE_SCHEDULE', 'Schedule', row.id, { newValue: snapshot(row) })
  res.status(201).json(row)
})

schedulesRouter.put('/:id', async (req, res) => {
  const id = idParam(req)
  const data = input.parse(req.body)
  const [before] = await db.select().from(schedules).where(eq(schedules.id, id))
  if (!before) throw notFound('Schedule')
  await validateRefs(data)
  let departmentId = data.departmentId ?? before.departmentId
  let module = data.module ?? before.module
  let shiftId = data.shiftId ?? before.shiftId
  let startTime = data.startTime ?? before.startTime
  let endTime = data.endTime ?? before.endTime

  const targetWorkerId = data.workerId !== undefined ? data.workerId : before.workerId
  if (targetWorkerId) {
    const [worker] = await db.select({ shiftId: users.shiftId }).from(users).where(eq(users.id, targetWorkerId))
    if (worker?.shiftId) {
      shiftId = worker.shiftId
      const [shift] = await db.select().from(shifts).where(eq(shifts.id, shiftId))
      if (shift) {
        startTime = shift.startTime
        endTime = shift.endTime
      }
    }
  }

  if (shiftId && (!startTime || !endTime)) {
    const [shift] = await db.select().from(shifts).where(eq(shifts.id, shiftId))
    if (shift) {
      startTime ??= shift.startTime
      endTime ??= shift.endTime
    }
  }

  if (!departmentId || !module) {
    const [act] = await db.select().from(activities).where(eq(activities.id, data.activityId))
    if (act) {
      departmentId ??= act.departmentId ?? null
      module ??= act.module ?? 'IPQC'
    }
  }
  await assertScheduleWorker(data.workerId, module)
  await assertNotDuplicate({ machineId: data.machineId, activityId: data.activityId, shiftId: shiftId ?? null, workerId: data.workerId, isActive: data.isActive }, id)
  const { mode, ...rest } = data
  const [row] = await db
    .update(schedules)
    .set({ ...rest, shiftId: shiftId ?? null, startTime: startTime ?? null, endTime: endTime ?? null, departmentId: departmentId ?? null, module, ...(mode === undefined ? {} : { mode }) })
    .where(eq(schedules.id, id))
    .returning()
  await removeUpcomingChecks({ scheduleId: id })
  await audit(req, 'UPDATE_SCHEDULE', 'Schedule', id, { oldValue: snapshot(before), newValue: snapshot(row) })
  res.json(row)
})

schedulesRouter.delete('/:id', async (req, res) => {
  const id = idParam(req)
  const [before] = await db.select().from(schedules).where(eq(schedules.id, id))
  if (!before) throw notFound('Schedule')
  await removeUpcomingChecks({ scheduleId: id })
  await db.delete(schedules).where(eq(schedules.id, id))
  await audit(req, 'DELETE_SCHEDULE', 'Schedule', id, { oldValue: snapshot(before) })
  res.json({ result: 'deleted' })
})
