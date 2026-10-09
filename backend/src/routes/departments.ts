import { Router } from 'express'
import { z } from 'zod'
import { and, asc, eq, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { departmentMappings, departments } from '../db/schema'
import { idParam } from '../lib/validate'
import { badRequest, notFound } from '../lib/http'
import { audit, snapshot } from '../lib/audit'
import { deleteOrDisable } from '../lib/crud'

export const departmentsRouter = Router()

const input = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100),
  code: z.string().trim().min(1, 'Code is required').max(30),
  isActive: z.boolean().default(true),
  /** Sent by older apps. The prefixes are now set in Department Configuration (routes/departmentMappings.ts). */
  itemCodePrefixes: z.array(z.string()).max(20).optional()
})

/** The active Item Code prefixes of each department, from Department Configuration. */
// Written out in full: inside a select, drizzle leaves column names unqualified.
const itemCodePrefixes = sql<string[]>`coalesce((
  select json_agg(dm.prefix order by dm.prefix)
  from department_mappings dm
  where dm.department_id = departments.id and dm.is_active
), '[]'::json)`

const PREFIXES_MOVED = 'Item Code prefixes are now set on the Department Configuration page.'

/** Refuses a change to the prefixes from an older app: they are no longer edited with the department. */
async function refusePrefixChange(sent: string[] | undefined, departmentId: string | null) {
  if (!sent) return
  const wanted = [...new Set(sent.map((p) => p.trim().toUpperCase()).filter(Boolean))].sort()
  const current = departmentId
    ? (
        await db
          .select({ prefix: departmentMappings.prefix })
          .from(departmentMappings)
          .where(and(eq(departmentMappings.departmentId, departmentId), eq(departmentMappings.isActive, true)))
      )
        .map((r) => r.prefix)
        .sort()
    : []
  if (wanted.length !== current.length || wanted.some((p, i) => p !== current[i])) throw badRequest(PREFIXES_MOVED)
}

departmentsRouter.get('/', async (_req, res) => {
  const rows = await db
    .select({ id: departments.id, name: departments.name, code: departments.code, isActive: departments.isActive, itemCodePrefixes })
    .from(departments)
    .orderBy(asc(departments.name))
  res.json(rows)
})

departmentsRouter.post('/', async (req, res) => {
  const { itemCodePrefixes: sent, ...data } = input.parse(req.body)
  await refusePrefixChange(sent, null)
  const [row] = await db.insert(departments).values(data).returning()
  await audit(req, 'CREATE_DEPARTMENT', 'Department', row.id, { newValue: snapshot(row) })
  res.status(201).json(row)
})

departmentsRouter.put('/:id', async (req, res) => {
  const id = idParam(req)
  const { itemCodePrefixes: sent, ...data } = input.parse(req.body)
  const [before] = await db.select().from(departments).where(eq(departments.id, id))
  if (!before) throw notFound('Department')
  await refusePrefixChange(sent, id)
  const [row] = await db.update(departments).set(data).where(eq(departments.id, id)).returning()
  await audit(req, 'UPDATE_DEPARTMENT', 'Department', id, { oldValue: snapshot(before), newValue: snapshot(row) })
  res.json(row)
})

departmentsRouter.delete('/:id', async (req, res) => {
  const id = idParam(req)
  // A department still named by an Item Code mapping, or recorded on users, checks, jobs, schedules or
  // check types, is disabled instead: deleting it would blank the department in that history.
  const result = await deleteOrDisable(departments, id, async () => {
    const found = await db.execute(sql`
      select 1 from users where department_id = ${id}
      union all select 1 from quality_checks where department_id = ${id}
      union all select 1 from jobs where department_id = ${id}
      union all select 1 from schedules where department_id = ${id}
      union all select 1 from activities where department_id = ${id}
      limit 1`)
    return found.rows.length > 0
  })
  await audit(req, result === 'deleted' ? 'DELETE_DEPARTMENT' : 'DISABLE_DEPARTMENT', 'Department', id)
  res.json({ result })
})
