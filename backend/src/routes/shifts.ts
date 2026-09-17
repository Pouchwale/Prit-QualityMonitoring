import { Router } from 'express'
import { z } from 'zod'
import { asc, eq } from 'drizzle-orm'
import { db } from '../db/client'
import { shifts } from '../db/schema'
import { hhmm, idParam } from '../lib/validate'
import { notFound } from '../lib/http'
import { audit, snapshot } from '../lib/audit'
import { deleteOrDisable } from '../lib/crud'
import { removeUpcomingChecks } from '../services/checkGenerator'

export const shiftsRouter = Router()

const input = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100),
  code: z.string().trim().min(1, 'Code is required').max(30),
  startTime: hhmm,
  endTime: hhmm,
  graceMinutes: z.coerce.number().int().min(0).max(240).default(15),
  isActive: z.boolean().default(true)
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
  const result = await deleteOrDisable(shifts, id)
  await audit(req, result === 'deleted' ? 'DELETE_SHIFT' : 'DISABLE_SHIFT', 'Shift', id)
  res.json({ result })
})
