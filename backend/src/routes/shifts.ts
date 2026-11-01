import { Router } from 'express'
import { z } from 'zod'
import { and, asc, eq, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { shifts, users } from '../db/schema'
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

const fields = {
  name: z.string().trim().min(1, 'Name is required').max(100),
  code: z.string().trim().min(1, 'Code is required').max(30),
  startTime: hhmm,
  endTime: hhmm,
  graceMinutes: z.coerce.number().int().min(0).max(240).default(15),
  isActive: z.boolean().default(true)
}

/**
 * A new shift must say what its break is: a start and end time, or null for "no break" chosen on
 * purpose. Editing may leave the break out (an older app): the shift then keeps its break.
 */
const createInput = z.object({ ...fields, breakStartTime: hhmm.nullable(), breakEndTime: hhmm.nullable() })
const updateInput = z.object({ ...fields, breakStartTime: hhmm.nullable().optional(), breakEndTime: hhmm.nullable().optional() })

const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))
/** Minutes from `from` to `to`, going forward round the clock (an end at or before the start is the next day). */
const span = (from: string, to: string) => (toMinutes(to) - toMinutes(from) + 1440) % 1440 || 1440

/** Shift and break times are checked together: the break must lie inside the shift's hours. */
function checkBreak(shift: { startTime: string; endTime: string; breakStartTime: string | null; breakEndTime: string | null }) {
  const { breakStartTime: start, breakEndTime: end } = shift
  if (!start && !end) return
  if (!start || !end) throw badRequest('Set both the break start and the break end, or choose "No break".')
  if (start === end) throw badRequest('The break must end after it starts.')
  const length = span(start, end)
  if (length > 240) throw badRequest('A break can be at most 4 hours.')
  const shiftLength = span(shift.startTime, shift.endTime)
  // Where the break starts, counted from the shift's start (overnight shifts included).
  const offset = (toMinutes(start) - toMinutes(shift.startTime) + 1440) % 1440
  if (offset + length > shiftLength) {
    throw badRequest(`The break (${start}–${end}) must be inside the shift's hours (${shift.startTime}–${shift.endTime}). Change the break or the shift times.`)
  }
}

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
 * Each worker's break, as it comes from their shift (services/workerBreaks.ts): read only. A break
 * is changed on the shift, and a worker moved to another shift takes that shift's break.
 */
shiftsRouter.get('/breaks', async (_req, res) => {
  const rows = await db
    .select({
      workerId: users.id,
      name: users.name,
      employeeId: users.employeeId,
      shiftId: shifts.id,
      shiftName: shifts.name,
      startTime: shifts.breakStartTime,
      endTime: shifts.breakEndTime
    })
    .from(users)
    .leftJoin(shifts, eq(users.shiftId, shifts.id))
    .where(and(eq(users.role, 'WORKER'), eq(users.isActive, true)))
    .orderBy(asc(users.name))
  res.json(rows.map((r) => ({ ...r, durationMinutes: r.startTime && r.endTime ? span(r.startTime, r.endTime) : null })))
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
  const body = (req.body ?? {}) as Record<string, unknown>
  if (!('breakStartTime' in body) || !('breakEndTime' in body)) throw badRequest('Set the break time of this shift (or choose "No break").')
  const data = createInput.parse(body)
  checkBreak(data)
  const [row] = await db.insert(shifts).values(data).returning()
  await audit(req, 'CREATE_SHIFT', 'Shift', row.id, { newValue: snapshot(row) })
  res.status(201).json(row)
})

shiftsRouter.put('/:id', async (req, res) => {
  const id = idParam(req)
  const parsed = updateInput.parse(req.body)
  const [before] = await db.select().from(shifts).where(eq(shifts.id, id))
  if (!before) throw notFound('Shift')
  // Break left out (an older app): the shift keeps its break, still checked against the new hours.
  const data = {
    ...parsed,
    breakStartTime: parsed.breakStartTime === undefined ? before.breakStartTime : parsed.breakStartTime,
    breakEndTime: parsed.breakEndTime === undefined ? before.breakEndTime : parsed.breakEndTime
  }
  checkBreak(data)
  const [row] = await db.update(shifts).set(data).where(eq(shifts.id, id)).returning()
  await removeUpcomingChecks({ shiftId: id })
  // Every worker on this shift follows its break from the next pass (services/workerBreaks.ts).
  invalidateCheckGeneration()
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
