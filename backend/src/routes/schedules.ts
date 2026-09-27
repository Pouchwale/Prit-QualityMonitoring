import { Router } from 'express'
import { z } from 'zod'
import { and, asc, eq } from 'drizzle-orm'
import { db } from '../db/client'
import { activities, machineActivities, machines, schedules, shifts, users } from '../db/schema'
import { hhmm, idParam, optionalUuid } from '../lib/validate'
import { badRequest, notFound } from '../lib/http'
import { audit, snapshot } from '../lib/audit'
import { invalidateCheckGeneration, removeUpcomingChecks } from '../services/checkGenerator'

export const schedulesRouter = Router()

const input = z
  .object({
    machineId: z.uuid('Choose a machine'),
    activityId: z.uuid('Choose a quality check'),
    shiftId: z.uuid('Choose a shift'),
    workerId: optionalUuid,
    intervalMinutes: z.coerce.number().int().min(5, 'Minimum frequency is 5 minutes').max(1440),
    /**
     * INTERVAL: checks all through the shift. JOB: only while a job runs on the machine.
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

async function validateRefs(data: z.infer<typeof input>) {
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

  // Checks belong to whoever is running the job on the machine, so a schedule names no worker.
  res.json(rows.map(({ schedule, ...names }) => ({ ...schedule, ...names, checkWorkers: [] })))
})

schedulesRouter.post('/', async (req, res) => {
  const data = input.parse(req.body)
  await validateRefs(data)
  const { mode, ...rest } = data
  const [row] = await db
    .insert(schedules)
    .values({ ...rest, ...(mode === undefined ? {} : { mode }) })
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
  const { mode, ...rest } = data
  const [row] = await db
    .update(schedules)
    .set({ ...rest, ...(mode === undefined ? {} : { mode }) })
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
