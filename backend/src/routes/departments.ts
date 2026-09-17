import { Router } from 'express'
import { z } from 'zod'
import { asc, eq } from 'drizzle-orm'
import { db } from '../db/client'
import { departments } from '../db/schema'
import { idParam } from '../lib/validate'
import { notFound } from '../lib/http'
import { audit, snapshot } from '../lib/audit'
import { deleteOrDisable } from '../lib/crud'

export const departmentsRouter = Router()

const input = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100),
  code: z.string().trim().min(1, 'Code is required').max(30),
  isActive: z.boolean().default(true)
})

departmentsRouter.get('/', async (_req, res) => {
  const rows = await db
    .select({ id: departments.id, name: departments.name, code: departments.code, isActive: departments.isActive })
    .from(departments)
    .orderBy(asc(departments.name))
  res.json(rows)
})

departmentsRouter.post('/', async (req, res) => {
  const data = input.parse(req.body)
  const [row] = await db.insert(departments).values(data).returning()
  await audit(req, 'CREATE_DEPARTMENT', 'Department', row.id, { newValue: snapshot(row) })
  res.status(201).json(row)
})

departmentsRouter.put('/:id', async (req, res) => {
  const id = idParam(req)
  const data = input.parse(req.body)
  const [before] = await db.select().from(departments).where(eq(departments.id, id))
  if (!before) throw notFound('Department')
  const [row] = await db.update(departments).set(data).where(eq(departments.id, id)).returning()
  await audit(req, 'UPDATE_DEPARTMENT', 'Department', id, { oldValue: snapshot(before), newValue: snapshot(row) })
  res.json(row)
})

departmentsRouter.delete('/:id', async (req, res) => {
  const id = idParam(req)
  const result = await deleteOrDisable(departments, id)
  await audit(req, result === 'deleted' ? 'DELETE_DEPARTMENT' : 'DISABLE_DEPARTMENT', 'Department', id)
  res.json({ result })
})
