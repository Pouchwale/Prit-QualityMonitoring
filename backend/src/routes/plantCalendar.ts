import { Router } from 'express'
import { z } from 'zod'
import { and, eq, inArray, ne } from 'drizzle-orm'
import { db } from '../db/client'
import { plantClosures } from '../db/schema'
import { idParam, optionalText } from '../lib/validate'
import { badRequest, conflict, notFound } from '../lib/http'
import { audit, snapshot } from '../lib/audit'
import { requireAnyView, requireModule } from '../lib/permissions'
import { addDays, dateKey, formatDateKey, parseDateKey } from '../lib/time'
import { invalidateCheckGeneration } from '../services/checkGenerator'
import { CALENDAR_V2_START } from '../services/weeklyRules'
import { CLOSURE_LABEL, dayStates, isClosedType, listClosures, plansBetween, removeChecksIfClosed, weeklyOffDays } from '../services/plantCalendar'

export const plantCalendarRouter = Router()

const MAX_DAYS = 366

/** A real calendar date as YYYY-MM-DD (rejects e.g. 2026-02-31). */
const dateString = (label: string) =>
  z.string().refine((v) => {
    try {
      return dateKey(parseDateKey(v)) === v
    } catch {
      return false
    }
  }, `${label} must be a valid date`)

const closureType = z.enum(['CLOSED', 'HOLIDAY', 'SHUTDOWN', 'WORKING'], 'Choose Plant Closed, Holiday, Shutdown or Adjustment Working Day')

/** Every date from `from` to `to`, inclusive. */
function datesBetween(from: string, to: string) {
  const keys: string[] = []
  for (let d = parseDateKey(from); dateKey(d) <= to; d = addDays(d, 1)) keys.push(dateKey(d))
  return keys
}

/** Dates from 2027 belong to an annual calendar and change only through its review and approval. */
const MANAGED_BY_YEAR = `Dates from ${CALENDAR_V2_START.slice(0, 4)} onwards are managed in Annual Calendars, where changes are reviewed and approved.`

/** Whether the plant is open on each date, and why (entry, weekly closure or open), for the admin calendar. */
plantCalendarRouter.get('/days', requireAnyView('calendar', 'dashboard', 'schedules'), async (req, res) => {
  const q = z.object({ from: dateString('From date'), to: dateString('To date') }).parse(req.query)
  if (q.to < q.from) throw badRequest('"to" date must be on or after "from" date')
  if (datesBetween(q.from, q.to).length > 800) throw badRequest('Choose a shorter date range')
  const [states, plans] = await Promise.all([dayStates(parseDateKey(q.from), parseDateKey(q.to)), plansBetween(q.from, q.to)])
  // Machine day plans: on a planned date exactly these machines run, whatever the plant calendar says.
  res.json(
    states.map((s) => {
      const plan = plans.get(s.date)
      return { ...s, machinePlan: plan ? { count: plan.size, machineIds: [...plan] } : null }
    })
  )
})

plantCalendarRouter.get('/', requireAnyView('calendar', 'dashboard', 'schedules'), async (req, res) => {
  const q = z.object({ from: dateString('From date'), to: dateString('To date') }).parse(req.query)
  if (q.to < q.from) throw badRequest('"to" date must be on or after "from" date')
  if (datesBetween(q.from, q.to).length > 800) throw badRequest('Choose a shorter date range')
  res.json(await listClosures(q.from, q.to))
})

/**
 * The weekly off that applies before 2027 (Thursday). It is locked, so 2026 check statuses,
 * Missed counts and reports stay exactly as they are; from 2027 the weekly rules apply.
 */
plantCalendarRouter.get('/settings', requireAnyView('calendar', 'dashboard', 'schedules'), async (_req, res) => {
  res.json({ weeklyOffDays: await weeklyOffDays(), appliesUntil: '2026-12-31', locked: true })
})

plantCalendarRouter.put('/settings', requireModule('calendar', 'manage'), async () => {
  throw conflict('The weekly off up to 31/12/2026 is locked to keep 2026 records unchanged. From 2027, change the Weekly Rules instead.')
})

/** Marks one date, or every date in a range, as closed or as an adjustment working day. Dates already marked are updated. */
plantCalendarRouter.post('/', requireModule('calendar', 'manage'), async (req, res) => {
  const body = z
    .object({
      from: dateString('Date'),
      to: dateString('End date').optional(),
      type: closureType,
      reason: optionalText(200)
    })
    .parse(req.body)
  const to = body.to ?? body.from
  if (to < body.from) throw badRequest('End date must be on or after the start date')
  if (to >= CALENDAR_V2_START) throw conflict(MANAGED_BY_YEAR)
  const keys = datesBetween(body.from, to)
  if (keys.length > MAX_DAYS) throw badRequest(`Mark at most ${MAX_DAYS} days at a time`)

  const existing = await db.select().from(plantClosures).where(inArray(plantClosures.date, keys))
  const byDate = new Map(existing.map((r) => [r.date, r]))
  const userId = req.user!.id

  await db.transaction(async (tx) => {
    const fresh = keys.filter((k) => !byDate.has(k))
    if (fresh.length) {
      await tx
        .insert(plantClosures)
        .values(fresh.map((date) => ({ date, type: body.type, reason: body.reason, createdById: userId, updatedById: userId })))
    }
    if (existing.length) {
      await tx
        .update(plantClosures)
        .set({ type: body.type, reason: body.reason, updatedById: userId, updatedAt: new Date() })
        .where(inArray(plantClosures.date, existing.map((r) => r.date)))
    }
  })

  // An Adjustment Working Day opens the date even on a weekly off; checks come back from the schedules.
  const removedChecks = await removeChecksIfClosed(keys)
  invalidateCheckGeneration()
  await audit(req, isClosedType(body.type) ? 'MARK_PLANT_CLOSED' : 'MARK_WORKING_DAY', 'PlantCalendar', keys.length === 1 ? keys[0] : `${keys[0]} – ${keys[keys.length - 1]}`, {
    oldValue: existing.length ? existing.map((r) => ({ date: r.date, type: CLOSURE_LABEL[r.type], reason: r.reason })) : undefined,
    newValue: { from: body.from, to, days: keys.length, type: CLOSURE_LABEL[body.type], reason: body.reason, removedChecks }
  })
  res.status(201).json({ dates: keys, created: keys.length - existing.length, updated: existing.length, removedChecks })
})

/** Edits a calendar date: its type, reason or the date itself. */
plantCalendarRouter.put('/:id', requireModule('calendar', 'manage'), async (req, res) => {
  const id = idParam(req)
  const body = z.object({ date: dateString('Date'), type: closureType, reason: optionalText(200) }).parse(req.body)
  const [before] = await db.select().from(plantClosures).where(eq(plantClosures.id, id))
  if (before && (before.date >= CALENDAR_V2_START || body.date >= CALENDAR_V2_START)) throw conflict(MANAGED_BY_YEAR)
  if (!before) throw notFound('Calendar date')

  if (body.date !== before.date) {
    const [clash] = await db
      .select({ id: plantClosures.id })
      .from(plantClosures)
      .where(and(eq(plantClosures.date, body.date), ne(plantClosures.id, id)))
    if (clash) throw conflict(`${formatDateKey(body.date)} is already in the Plant Calendar. Edit that date instead.`)
  }

  const [row] = await db
    .update(plantClosures)
    .set({ ...body, updatedById: req.user!.id, updatedAt: new Date() })
    .where(eq(plantClosures.id, id))
    .returning()

  // Both dates are checked: moving an Adjustment Working Day off a weekly off closes the old date again.
  const removedChecks = await removeChecksIfClosed([before.date, row.date])
  invalidateCheckGeneration()
  await audit(req, 'UPDATE_PLANT_CLOSURE', 'PlantCalendar', row.date, {
    oldValue: snapshot({ ...before, type: CLOSURE_LABEL[before.type] }),
    newValue: { ...snapshot({ ...row, type: CLOSURE_LABEL[row.type] }), removedChecks }
  })
  res.json({ ...row, removedChecks })
})

/**
 * Removes a calendar entry; the date follows the weekly off again. A removed closure reopens an
 * ordinary day, and a removed Adjustment Working Day on a weekly off closes that date again.
 */
plantCalendarRouter.delete('/:id', requireModule('calendar', 'manage'), async (req, res) => {
  const id = idParam(req)
  const [existing] = await db.select({ date: plantClosures.date }).from(plantClosures).where(eq(plantClosures.id, id))
  if (existing && existing.date >= CALENDAR_V2_START) throw conflict(MANAGED_BY_YEAR)
  const [row] = await db.delete(plantClosures).where(eq(plantClosures.id, id)).returning()
  if (!row) throw notFound('Calendar date')
  invalidateCheckGeneration()
  const removedChecks = await removeChecksIfClosed([row.date])
  await audit(req, 'REMOVE_PLANT_CLOSURE', 'PlantCalendar', row.date, {
    oldValue: snapshot({ ...row, type: CLOSURE_LABEL[row.type] }),
    newValue: removedChecks ? { removedChecks } : undefined
  })
  res.json({ result: 'deleted', removedChecks })
})
