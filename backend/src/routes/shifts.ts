import { Router } from 'express'
import { z } from 'zod'
import { and, asc, eq, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { shifts, users, workerBreaks } from '../db/schema'
import { hhmm, idParam } from '../lib/validate'
import { badRequest, notFound } from '../lib/http'
import { audit, snapshot } from '../lib/audit'
import { deleteOrDisable } from '../lib/crud'
import { invalidateCheckGeneration, removeUpcomingChecks } from '../services/checkGenerator'
import { getShiftLoginSettings, saveShiftLoginSettings } from '../services/workerShifts'

export const shiftsRouter = Router()

const input = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100),
  code: z.string().trim().min(1, 'Code is required').max(30),
  startTime: hhmm,
  endTime: hhmm,
  graceMinutes: z.coerce.number().int().min(0).max(240).default(15),
  isActive: z.boolean().default(true)
})

/**
 * Shift sign-in rules for workers (services/workerShifts.ts): reminders at shift start and their
 * interval and number, logout at shift end, and how early a worker may sign in. Read with the shift
 * list; changed with Shifts manage (the router's guard).
 */
const loginSettingsInput = z.object({
  enabled: z.boolean(),
  autoLogout: z.boolean(),
  reminderIntervalMinutes: z.coerce.number().int().min(2, 'At least 2 minutes between reminders').max(120),
  maxReminders: z.coerce.number().int().min(1).max(10),
  earlyLoginMinutes: z.coerce.number().int().min(0).max(240)
})

shiftsRouter.get('/login-settings', async (_req, res) => {
  res.json(await getShiftLoginSettings())
})

shiftsRouter.put('/login-settings', async (req, res) => {
  const next = loginSettingsInput.parse(req.body)
  const before = await getShiftLoginSettings()
  await saveShiftLoginSettings(next)
  await audit(req, 'UPDATE_SHIFT_LOGIN_SETTINGS', 'Settings', 'shiftLogin', { oldValue: before, newValue: next })
  res.json(next)
})

/**
 * Worker breaks (services/workerBreaks.ts): each worker's daily break. Read with Shifts view, changed
 * with Shifts manage (the router's guard), like the rest of the Shifts page.
 */
const breakInput = z
  .object({ startTime: hhmm, endTime: hhmm })
  .refine((b) => b.startTime !== b.endTime, { message: 'The break must end after it starts', path: ['endTime'] })
  .refine((b) => breakMinutes(b) <= 240, { message: 'A break can be at most 4 hours', path: ['endTime'] })

const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))
const breakMinutes = (b: { startTime: string; endTime: string }) => (toMinutes(b.endTime) - toMinutes(b.startTime) + 1440) % 1440

shiftsRouter.get('/breaks', async (_req, res) => {
  const rows = await db
    .select({
      workerId: users.id,
      name: users.name,
      employeeId: users.employeeId,
      shiftName: shifts.name,
      startTime: workerBreaks.startTime,
      endTime: workerBreaks.endTime,
      updatedAt: workerBreaks.updatedAt
    })
    .from(users)
    .leftJoin(workerBreaks, eq(workerBreaks.workerId, users.id))
    .leftJoin(shifts, eq(users.shiftId, shifts.id))
    .where(and(eq(users.role, 'WORKER'), eq(users.isActive, true)))
    .orderBy(asc(users.name))
  res.json(rows.map((r) => ({ ...r, durationMinutes: r.startTime && r.endTime ? breakMinutes({ startTime: r.startTime, endTime: r.endTime }) : null })))
})

shiftsRouter.put('/breaks/:workerId', async (req, res) => {
  const workerId = idParam(req, 'workerId')
  const data = breakInput.parse(req.body)
  const [worker] = await db.select({ role: users.role }).from(users).where(eq(users.id, workerId))
  if (!worker) throw notFound('Worker')
  if (worker.role !== 'WORKER') throw badRequest('Breaks are set for workers only')
  const [before] = await db.select().from(workerBreaks).where(eq(workerBreaks.workerId, workerId))
  const [row] = await db
    .insert(workerBreaks)
    .values({ workerId, ...data })
    .onConflictDoUpdate({ target: workerBreaks.workerId, set: { ...data, updatedAt: new Date() } })
    .returning()
  // Open checks follow the new break on the next pass (services/workerBreaks.ts).
  invalidateCheckGeneration()
  await audit(req, before ? 'UPDATE_WORKER_BREAK' : 'CREATE_WORKER_BREAK', 'User', workerId, {
    oldValue: before ? { startTime: before.startTime, endTime: before.endTime } : undefined,
    newValue: { startTime: row.startTime, endTime: row.endTime, durationMinutes: breakMinutes(row) }
  })
  res.json({ ...row, durationMinutes: breakMinutes(row) })
})

shiftsRouter.delete('/breaks/:workerId', async (req, res) => {
  const workerId = idParam(req, 'workerId')
  const [removed] = await db.delete(workerBreaks).where(eq(workerBreaks.workerId, workerId)).returning()
  if (!removed) throw notFound('Break')
  invalidateCheckGeneration()
  await audit(req, 'DELETE_WORKER_BREAK', 'User', workerId, { oldValue: { startTime: removed.startTime, endTime: removed.endTime } })
  res.status(204).end()
})

shiftsRouter.get('/', async (_req, res) => {
  const rows = await db.select().from(shifts).orderBy(asc(shifts.startTime))
  res.json(rows)
})

shiftsRouter.post('/', async (req, res) => {
  const data = input.parse(req.body)
  const [row] = await db.insert(shifts).values(data).returning()
  await audit(req, 'CREATE_SHIFT', 'Shift', row.id, { newValue: snapshot(row) })
  res.status(201).json(row)
})

shiftsRouter.put('/:id', async (req, res) => {
  const id = idParam(req)
  const data = input.parse(req.body)
  const [before] = await db.select().from(shifts).where(eq(shifts.id, id))
  if (!before) throw notFound('Shift')
  const [row] = await db.update(shifts).set(data).where(eq(shifts.id, id)).returning()
  await removeUpcomingChecks({ shiftId: id })
  await audit(req, 'UPDATE_SHIFT', 'Shift', id, { oldValue: snapshot(before), newValue: snapshot(row) })
  res.json(row)
})

shiftsRouter.delete('/:id', async (req, res) => {
  const id = idParam(req)
  await removeUpcomingChecks({ shiftId: id })
  // A shift recorded on users, checks or handovers is disabled instead, so that history keeps it.
  const result = await deleteOrDisable(shifts, id, async () => {
    const found = await db.execute(sql`
      select 1 from users where shift_id = ${id}
      union all select 1 from quality_checks where shift_id = ${id}
      union all select 1 from job_handovers where to_shift_id = ${id}
      limit 1`)
    return found.rows.length > 0
  })
  await audit(req, result === 'deleted' ? 'DELETE_SHIFT' : 'DISABLE_SHIFT', 'Shift', id)
  res.json({ result })
})
