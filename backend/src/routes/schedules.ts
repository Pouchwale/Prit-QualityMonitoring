import { Router } from 'express'
import { z } from 'zod'
import { and, asc, eq } from 'drizzle-orm'
import { db } from '../db/client'
import { activities, machineActivities, machines, schedules, shifts, users, workerMachines } from '../db/schema'
import { hhmm, idParam, optionalUuid } from '../lib/validate'
import { badRequest, notFound } from '../lib/http'
import { audit, snapshot } from '../lib/audit'
import { invalidateCheckGeneration, removeUpcomingChecks } from '../services/checkGenerator'
import { eligibleWorkers, loadWorkers } from '../services/workerAssignment'

export const schedulesRouter = Router()

const input = z
  .object({
    machineId: z.uuid('Choose a machine'),
    activityId: z.uuid('Choose a quality check'),
    shiftId: z.uuid('Choose a shift'),
    workerId: optionalUuid,
    intervalMinutes: z.coerce.number().int().min(5, 'Minimum frequency is 5 minutes').max(1440),
    startTime: hhmm.nullish().or(z.literal('')).transform((v) => v || null),
    endTime: hhmm.nullish().or(z.literal('')).transform((v) => v || null),
    isActive: z.boolean().default(true)
  })
  .refine((s) => (s.startTime === null) === (s.endTime === null), {
    message: 'Set both start and end time, or leave both empty to use the shift times',
    path: ['startTime']
  })

async function validateRefs(data: z.infer<typeof input>) {
  if (data.workerId) {
    const [worker] = await db.select({ name: users.name, role: users.role }).from(users).where(eq(users.id, data.workerId))
    if (!worker) throw badRequest('Worker not found')
    if (worker.role !== 'WORKER') throw badRequest('Checks can only be assigned to workers')

    // A worker only ever sees checks for machines assigned to them.
    const [access] = await db
      .select({ machineId: workerMachines.machineId })
      .from(workerMachines)
      .where(and(eq(workerMachines.userId, data.workerId), eq(workerMachines.machineId, data.machineId)))
    if (!access) {
      const [machine] = await db.select({ name: machines.name }).from(machines).where(eq(machines.id, data.machineId))
      throw badRequest(`${worker.name} is not assigned to ${machine?.name ?? 'this machine'}. Assign the machine to the worker first.`)
    }
  }
  // Keep the machine ↔ quality check mapping in sync with schedules.
  await db.insert(machineActivities).values({ machineId: data.machineId, activityId: data.activityId }).onConflictDoNothing()
}

schedulesRouter.get('/', async (_req, res) => {
  const rows = await db
    .select({
      schedule: schedules,
      machineName: machines.name,
      activityName: activities.name,
      shiftName: shifts.name,
      shiftStartTime: shifts.startTime,
      shiftEndTime: shifts.endTime,
      workerName: users.name,
      workerEmployeeId: users.employeeId
    })
    .from(schedules)
    .innerJoin(machines, eq(schedules.machineId, machines.id))
    .innerJoin(activities, eq(schedules.activityId, activities.id))
    .innerJoin(shifts, eq(schedules.shiftId, shifts.id))
    .leftJoin(users, eq(schedules.workerId, users.id))
    .orderBy(asc(machines.name), asc(shifts.startTime))

  // The workers who actually get this schedule's checks (services/workerAssignment.ts).
  const workers = await loadWorkers()
  res.json(
    rows.map(({ schedule, ...names }) => ({
      ...schedule,
      ...names,
      checkWorkers: eligibleWorkers(workers, schedule.machineId, schedule.shiftId, schedule.workerId).map((w) => ({
        id: w.id,
        name: w.name,
        employeeId: w.employeeId
      }))
    }))
  )
})

schedulesRouter.post('/', async (req, res) => {
  const data = input.parse(req.body)
  await validateRefs(data)
  const [row] = await db.insert(schedules).values(data).returning()
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
  const [row] = await db.update(schedules).set(data).where(eq(schedules.id, id)).returning()
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
