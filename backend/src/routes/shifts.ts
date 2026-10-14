import { Router } from 'express'
import { z } from 'zod'
import { and, asc, eq, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { shifts, users, workerBreaks } from '../db/schema'
import { hhmm, idParam } from '../lib/validate'
import { badRequest, notFound } from '../lib/http'
import { requireModule } from '../lib/permissions'
import { audit, snapshot } from '../lib/audit'
import { deleteOrDisable } from '../lib/crud'
import { denyActivation, isSuperAdmin } from '../lib/activation'
import { invalidateCheckGeneration, removeUpcomingChecks } from '../services/checkGenerator'
import { getShiftLoginSettings, saveShiftLoginSettings } from '../services/workerShifts'
import { getWifiRule, saveWifiRule } from '../services/wifiRule'

export const shiftsRouter = Router()

/**
 * Shift Sign-In rules and the Company Wi-Fi rule: their own modules in the permission matrix
 * (shift_signin, wifi_rule: view and edit), mounted at /api/shifts before the Shifts router.
 */
export const shiftAccessRouter = Router()

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
 * interval and number, logout at shift end, and how early a worker may sign in. Shift Sign-In view
 * to read, edit to change.
 */
const loginSettingsInput = z.object({
  enabled: z.boolean(),
  autoLogout: z.boolean(),
  reminderIntervalMinutes: z.coerce.number().int().min(2, 'At least 2 minutes between reminders').max(120),
  maxReminders: z.coerce.number().int().min(1).max(10),
  earlyLoginMinutes: z.coerce.number().int().min(0).max(240)
})

shiftAccessRouter.get('/login-settings', requireModule('shift_signin', 'view'), async (_req, res) => {
  res.json(await getShiftLoginSettings())
})

shiftAccessRouter.put('/login-settings', requireModule('shift_signin', 'edit'), async (req, res) => {
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

/**
 * Company Wi-Fi alert rule (services/wifiRule.ts): Company Wi-Fi view to read, edit to change (the
 * Super Admin always; others only when granted in Roles & Permissions).
 */
const wifiRuleInput = z.object({
  enabled: z.boolean(),
  freshMinutes: z.coerce.number().int().min(3, 'At least 3 minutes').max(60),
  probeMinutes: z.coerce.number().int().min(2, 'At least 2 minutes').max(30)
})

shiftAccessRouter.get('/wifi-rule', requireModule('wifi_rule', 'view'), async (_req, res) => {
  res.json(await getWifiRule())
})

shiftAccessRouter.put('/wifi-rule', requireModule('wifi_rule', 'edit'), async (req, res) => {
  const next = wifiRuleInput.parse(req.body)
  if (next.probeMinutes >= next.freshMinutes) throw badRequest('Probe more often than the "seen within" time, or phones drop out between probes.')
  const before = await getWifiRule()
  await saveWifiRule(next)
  await audit(req, 'UPDATE_WIFI_ALERT_RULE', 'Settings', 'wifiAlertRule', { oldValue: before, newValue: next })
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
  }, { canDisable: isSuperAdmin(req), deny: () => denyActivation(req, 'Shift', id, { reason: 'Deleting would deactivate it: it has history' }) })
  await audit(req, result === 'deleted' ? 'DELETE_SHIFT' : 'DISABLE_SHIFT', 'Shift', id)
  res.json({ result })
})
