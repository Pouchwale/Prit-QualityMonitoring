import { Router } from 'express'
import { z } from 'zod'
import { asc, eq, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { db, type Transaction } from '../db/client'
import { departmentMappings, departments, jobs, users } from '../db/schema'
import { idParam } from '../lib/validate'
import { badRequest, conflict, notFound } from '../lib/http'
import { audit } from '../lib/audit'
import { checkMappingPrefix } from '../services/itemCodeDepartment'

/**
 * Department Configuration: the Item Code prefix -> department mappings that decide a job's
 * department (services/itemCodeDepartment.ts). Reading needs view on Departments; every change
 * needs manage on Departments (app.ts), and is written to the audit log in the same transaction.
 * Jobs and checks keep the department they were given: nothing here changes them.
 */
export const departmentMappingsRouter = Router()

const creator = alias(users, 'creator')
const updater = alias(users, 'updater')

/**
 * How many jobs (any status) have an Item Code with this prefix. Prefixes hold no LIKE wildcards.
 * Written out in full: inside a select, drizzle leaves column names unqualified.
 */
const jobCount = sql<number>`(select count(*)::int from jobs j where upper(j.item_code) like department_mappings.prefix || '%')`

const prefixInput = z.string().trim().min(1, 'Enter the Item Code prefix').max(40, 'Item Code prefix is too long')
const departmentInput = z.uuid('Choose a department')

const createInput = z.object({
  prefix: prefixInput,
  departmentId: departmentInput,
  isActive: z.boolean().default(true)
})

const updateInput = z.object({
  prefix: prefixInput.optional(),
  departmentId: departmentInput.optional()
})

const statusInput = z.object({ isActive: z.boolean({ error: 'isActive must be true or false' }) })

/** Mapping changes wait for each other, so two mappings can never take overlapping prefixes at once. */
const lockMappings = (tx: Transaction) => tx.execute(sql`lock table ${departmentMappings} in share row exclusive mode`)

async function requireDepartment(tx: Transaction, departmentId: string) {
  const [department] = await tx.select({ id: departments.id, name: departments.name }).from(departments).where(eq(departments.id, departmentId))
  if (!department) throw badRequest('The chosen department does not exist. Reload the page and choose again.')
  return department
}

async function lockedMapping(tx: Transaction, id: string) {
  const [row] = await tx.select().from(departmentMappings).where(eq(departmentMappings.id, id)).for('update')
  if (!row) throw notFound('Department mapping')
  return row
}

/** What the audit log keeps of a mapping: readable, without the timestamps. */
async function auditView(tx: Transaction, row: typeof departmentMappings.$inferSelect) {
  const [department] = await tx.select({ name: departments.name }).from(departments).where(eq(departments.id, row.departmentId))
  return { prefix: row.prefix, departmentId: row.departmentId, departmentName: department?.name ?? null, isActive: row.isActive }
}

departmentMappingsRouter.get('/', async (_req, res) => {
  const rows = await db
    .select({
      id: departmentMappings.id,
      prefix: departmentMappings.prefix,
      departmentId: departmentMappings.departmentId,
      departmentName: departments.name,
      departmentCode: departments.code,
      departmentActive: departments.isActive,
      isActive: departmentMappings.isActive,
      jobCount,
      createdAt: departmentMappings.createdAt,
      createdByName: creator.name,
      updatedAt: departmentMappings.updatedAt,
      updatedByName: updater.name
    })
    .from(departmentMappings)
    .innerJoin(departments, eq(departments.id, departmentMappings.departmentId))
    .leftJoin(creator, eq(creator.id, departmentMappings.createdById))
    .leftJoin(updater, eq(updater.id, departmentMappings.updatedById))
    .orderBy(asc(departmentMappings.prefix))
  res.json(rows)
})

departmentMappingsRouter.post('/', async (req, res) => {
  const body = createInput.parse(req.body)
  const userId = req.user!.id
  const row = await db.transaction(async (tx) => {
    await lockMappings(tx)
    const prefix = await checkMappingPrefix(body.prefix, null, tx)
    await requireDepartment(tx, body.departmentId)
    const [created] = await tx
      .insert(departmentMappings)
      .values({ prefix, departmentId: body.departmentId, isActive: body.isActive, createdById: userId, updatedById: userId })
      .returning()
    await audit(req, 'CREATE_DEPARTMENT_MAPPING', 'DepartmentMapping', created.id, { newValue: await auditView(tx, created) }, tx)
    return created
  })
  res.status(201).json(row)
})

/** Changes a mapping's prefix and/or department. Jobs already planned or started keep their department. */
departmentMappingsRouter.patch('/:id', async (req, res) => {
  const id = idParam(req)
  const body = updateInput.parse(req.body)
  if (body.prefix === undefined && body.departmentId === undefined) throw badRequest('Send the new prefix or department')
  const row = await db.transaction(async (tx) => {
    await lockMappings(tx)
    const before = await lockedMapping(tx, id)
    const prefix = body.prefix === undefined ? before.prefix : await checkMappingPrefix(body.prefix, id, tx)
    const departmentId = body.departmentId ?? before.departmentId
    if (prefix === before.prefix && departmentId === before.departmentId) return before
    if (departmentId !== before.departmentId) await requireDepartment(tx, departmentId)
    const [updated] = await tx
      .update(departmentMappings)
      .set({ prefix, departmentId, updatedById: req.user!.id, updatedAt: new Date() })
      .where(eq(departmentMappings.id, id))
      .returning()
    await audit(req, 'UPDATE_DEPARTMENT_MAPPING', 'DepartmentMapping', id, { oldValue: await auditView(tx, before), newValue: await auditView(tx, updated) }, tx)
    return updated
  })
  res.json(row)
})

/** Activates or deactivates a mapping. Jobs with an inactive prefix cannot be planned or started. */
departmentMappingsRouter.patch('/:id/status', async (req, res) => {
  const id = idParam(req)
  const { isActive } = statusInput.parse(req.body)
  const row = await db.transaction(async (tx) => {
    const before = await lockedMapping(tx, id)
    if (before.isActive === isActive) return before
    const [updated] = await tx
      .update(departmentMappings)
      .set({ isActive, updatedById: req.user!.id, updatedAt: new Date() })
      .where(eq(departmentMappings.id, id))
      .returning()
    await audit(
      req,
      isActive ? 'ACTIVATE_DEPARTMENT_MAPPING' : 'DEACTIVATE_DEPARTMENT_MAPPING',
      'DepartmentMapping',
      id,
      { oldValue: await auditView(tx, before), newValue: await auditView(tx, updated) },
      tx
    )
    return updated
  })
  res.json(row)
})

/**
 * Deletes a mapping that no job has used yet. Once jobs have used its prefix it stays, so the
 * configuration still explains them: deactivate it instead.
 */
departmentMappingsRouter.delete('/:id', async (req, res) => {
  const id = idParam(req)
  await db.transaction(async (tx) => {
    await lockMappings(tx)
    const before = await lockedMapping(tx, id)
    const [{ used }] = await tx
      .select({ used: sql<number>`count(*)::int` })
      .from(jobs)
      .where(sql`upper(${jobs.itemCode}) like ${before.prefix} || '%'`)
    if (used > 0) {
      throw conflict(`${before.prefix} is used by ${used} ${used === 1 ? 'job' : 'jobs'}, so it cannot be deleted. Deactivate it instead to stop new jobs with this prefix.`)
    }
    const oldValue = await auditView(tx, before)
    await tx.delete(departmentMappings).where(eq(departmentMappings.id, id))
    await audit(req, 'DELETE_DEPARTMENT_MAPPING', 'DepartmentMapping', id, { oldValue }, tx)
  })
  res.json({ result: 'deleted' })
})
