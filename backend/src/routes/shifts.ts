import { Router } from 'express'
import { z } from 'zod'
import { asc, eq, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { shifts } from '../db/schema'
import { hhmm, idParam } from '../lib/validate'
import { notFound } from '../lib/http'
import { audit, snapshot } from '../lib/audit'
import { deleteOrDisable } from '../lib/crud'
import { removeUpcomingChecks } from '../services/checkGenerator'
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
