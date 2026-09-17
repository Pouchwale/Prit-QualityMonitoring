import { Router } from 'express'
import { z } from 'zod'
import { and, eq, inArray, ne } from 'drizzle-orm'
import { db } from '../db/client'
import { plantClosures } from '../db/schema'
import { idParam, optionalText } from '../lib/validate'
import { badRequest, conflict, notFound } from '../lib/http'
import { audit, snapshot } from '../lib/audit'
import { requireAnyView, requireModule } from '../lib/permissions'
import { addDays, dateKey, parseDateKey } from '../lib/time'
import { invalidateCheckGeneration } from '../services/checkGenerator'
import { CLOSURE_LABEL, listClosures, removeChecksOnClosedDays } from '../services/plantCalendar'

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

const closureType = z.enum(['CLOSED', 'HOLIDAY', 'SHUTDOWN'], 'Choose Plant Closed, Holiday or Shutdown')

/** Every date from `from` to `to`, inclusive. */
function datesBetween(from: string, to: string) {
  const keys: string[] = []
  for (let d = parseDateKey(from); dateKey(d) <= to; d = addDays(d, 1)) keys.push(dateKey(d))
  return keys
}

plantCalendarRouter.get('/', requireAnyView('calendar', 'dashboard', 'schedules'), async (req, res) => {
  const q = z.object({ from: dateString('From date'), to: dateString('To date') }).parse(req.query)
  if (q.to < q.from) throw badRequest('"to" date must be on or after "from" date')
  if (datesBetween(q.from, q.to).length > 800) throw badRequest('Choose a shorter date range')
  res.json(await listClosures(q.from, q.to))
})

/** Marks one date, or every date in a range, as closed. Dates already marked are updated. */
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

  const removedChecks = await removeChecksOnClosedDays(keys)
  invalidateCheckGeneration()
  await audit(req, 'MARK_PLANT_CLOSED', 'PlantCalendar', keys.length === 1 ? keys[0] : `${keys[0]} – ${keys[keys.length - 1]}`, {
    oldValue: existing.length ? existing.map((r) => ({ date: r.date, type: CLOSURE_LABEL[r.type], reason: r.reason })) : undefined,
    newValue: { from: body.from, to, days: keys.length, type: CLOSURE_LABEL[body.type], reason: body.reason, removedChecks }
  })
  res.status(201).json({ dates: keys, created: keys.length - existing.length, updated: existing.length, removedChecks })
})

/** Edits a closed date: its type, reason or the date itself. */
plantCalendarRouter.put('/:id', requireModule('calendar', 'manage'), async (req, res) => {
  const id = idParam(req)
  const body = z.object({ date: dateString('Date'), type: closureType, reason: optionalText(200) }).parse(req.body)
  const [before] = await db.select().from(plantClosures).where(eq(plantClosures.id, id))
  if (!before) throw notFound('Closed date')

  if (body.date !== before.date) {
    const [clash] = await db
      .select({ id: plantClosures.id })
      .from(plantClosures)
      .where(and(eq(plantClosures.date, body.date), ne(plantClosures.id, id)))
    if (clash) throw conflict(`${body.date} is already marked as closed. Edit that date instead.`)
  }

  const [row] = await db
    .update(plantClosures)
    .set({ ...body, updatedById: req.user!.id, updatedAt: new Date() })
    .where(eq(plantClosures.id, id))
    .returning()

  const removedChecks = await removeChecksOnClosedDays([row.date])
  // Moving a closure reopens the old date: its checks are generated again from the schedules.
  invalidateCheckGeneration()
  await audit(req, 'UPDATE_PLANT_CLOSURE', 'PlantCalendar', row.date, {
    oldValue: snapshot({ ...before, type: CLOSURE_LABEL[before.type] }),
    newValue: { ...snapshot({ ...row, type: CLOSURE_LABEL[row.type] }), removedChecks }
  })
  res.json({ ...row, removedChecks })
})

/** Reopens a date. Its checks are generated again from the schedules. */
plantCalendarRouter.delete('/:id', requireModule('calendar', 'manage'), async (req, res) => {
  const id = idParam(req)
  const [row] = await db.delete(plantClosures).where(eq(plantClosures.id, id)).returning()
  if (!row) throw notFound('Closed date')
  invalidateCheckGeneration()
  await audit(req, 'REMOVE_PLANT_CLOSURE', 'PlantCalendar', row.date, {
    oldValue: snapshot({ ...row, type: CLOSURE_LABEL[row.type] })
  })
  res.json({ result: 'deleted' })
})
