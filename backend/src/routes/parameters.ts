import { Router } from 'express'
import { z } from 'zod'
import { asc, desc, eq } from 'drizzle-orm'
import { db } from '../db/client'
import { activityParameters, departments, parameterDepartments, parameters } from '../db/schema'
import { idParam, optionalText, optionalUuid } from '../lib/validate'
import { badRequest, notFound } from '../lib/http'
import { audit, snapshot } from '../lib/audit'
import { ruleText } from '../services/evaluate'

export const parametersRouter = Router()

const optionalNumber = z
  .union([z.number(), z.string(), z.null()])
  .optional()
  .transform((v, ctx) => {
    if (v === null || v === undefined || v === '') return null
    const n = Number(v)
    if (!Number.isFinite(n)) {
      ctx.addIssue({ code: 'custom', message: 'Must be a number' })
      return z.NEVER
    }
    return n
  })

const input = z
  .object({
    name: z.string().trim().min(1, 'Name is required').max(120),
    code: z.string().trim().min(1, 'Code is required').max(40),
    type: z.enum(['NUMBER', 'TEXT', 'DROPDOWN', 'YES_NO', 'PASS_FAIL', 'PHOTO']),
    unit: optionalText(30),
    minValue: optionalNumber,
    maxValue: optionalNumber,
    options: z.array(z.string().trim().min(1).max(100)).default([]),
    /**
     * Dropdown only: the first choice, e.g. the material before the dyne. Empty for an ordinary
     * dropdown. Left out of the request the stored list is kept, so an older screen that knows
     * nothing about it never clears it.
     */
    materialOptions: z.array(z.string().trim().min(1).max(100)).optional(),
    /** Dropdown only: the worker may choose several options instead of one. */
    multiSelect: z.boolean().default(false),
    isRequired: z.boolean().default(true),
    isActive: z.boolean().default(true),
    /** Omit to keep the current position (update) or append at the end (create). */
    sortOrder: z.coerce.number().int().optional(),
    description: optionalText(500),
    /**
     * The departments this parameter is used by; an empty list means unassigned, and every check
     * type may use it. Left out of the request, the stored departments are kept, so an older
     * screen that still sends a single `departmentId` never clears them.
     */
    departmentIds: z.array(z.uuid()).optional(),
    /** What an older screen sends: one department. Used only when `departmentIds` is absent. */
    departmentId: optionalUuid
  })
  .transform((p) => {
    // Keep only the fields that apply to the chosen input type.
    const isNumber = p.type === 'NUMBER'
    return {
      ...p,
      unit: isNumber ? p.unit : null,
      minValue: isNumber ? p.minValue : null,
      maxValue: isNumber ? p.maxValue : null,
      options: p.type === 'DROPDOWN' ? [...new Set(p.options)] : [],
      materialOptions: p.type === 'DROPDOWN' ? (p.materialOptions ? [...new Set(p.materialOptions)] : undefined) : [],
      multiSelect: p.type === 'DROPDOWN' && p.multiSelect,
      departmentIds: p.departmentIds ?? (p.departmentId ? [p.departmentId] : undefined)
    }
  })

function validate(p: z.infer<typeof input>) {
  if (p.type === 'DROPDOWN' && p.options.length === 0) throw badRequest('Add at least one dropdown option')
  if (p.minValue != null && p.maxValue != null && p.minValue > p.maxValue) {
    throw badRequest('Minimum value cannot be greater than maximum value')
  }
}

parametersRouter.get('/', async (_req, res) => {
  const [rows, links, departmentLinks] = await Promise.all([
    db.select().from(parameters).orderBy(asc(parameters.sortOrder), asc(parameters.name)),
    db.select({ activityId: activityParameters.activityId, parameterId: activityParameters.parameterId }).from(activityParameters),
    db
      .select({ parameterId: parameterDepartments.parameterId, departmentId: departments.id, departmentName: departments.name })
      .from(parameterDepartments)
      .innerJoin(departments, eq(parameterDepartments.departmentId, departments.id))
      .orderBy(asc(departments.name))
  ])
  res.json(
    rows.map((parameter) => {
      const mine = departmentLinks.filter((d) => d.parameterId === parameter.id)
      return {
        ...parameter,
        /** The departments this parameter serves; empty means unassigned. */
        departmentIds: mine.map((d) => d.departmentId),
        departmentNames: mine.map((d) => d.departmentName),
        rule: ruleText(parameter),
        activityIds: links.filter((l) => l.parameterId === parameter.id).map((l) => l.activityId)
      }
    })
  )
})

/** Rewrites which departments a parameter serves. Left out of the request, the stored ones stay. */
async function saveDepartments(parameterId: string, departmentIds: string[] | undefined) {
  if (departmentIds === undefined) return
  const wanted = [...new Set(departmentIds)]
  await db.transaction(async (tx) => {
    await tx.delete(parameterDepartments).where(eq(parameterDepartments.parameterId, parameterId))
    if (wanted.length) await tx.insert(parameterDepartments).values(wanted.map((departmentId) => ({ parameterId, departmentId })))
  })
}

/** One parameter with the departments it serves, for the response. */
async function withDepartments(parameter: typeof parameters.$inferSelect) {
  const mine = await db
    .select({ id: departments.id, name: departments.name })
    .from(parameterDepartments)
    .innerJoin(departments, eq(parameterDepartments.departmentId, departments.id))
    .where(eq(parameterDepartments.parameterId, parameter.id))
    .orderBy(asc(departments.name))
  return { ...parameter, departmentIds: mine.map((d) => d.id), departmentNames: mine.map((d) => d.name) }
}

parametersRouter.post('/', async (req, res) => {
  const data = input.parse(req.body)
  validate(data)
  if (data.sortOrder === undefined) {
    const [last] = await db.select({ sortOrder: parameters.sortOrder }).from(parameters).orderBy(desc(parameters.sortOrder)).limit(1)
    data.sortOrder = (last?.sortOrder ?? -1) + 1
  }
  const { departmentIds, departmentId: _legacy, ...fields } = data
  const [row] = await db.insert(parameters).values(fields).returning()
  await saveDepartments(row.id, departmentIds ?? [])
  const created = await withDepartments(row)
  await audit(req, 'CREATE_PARAMETER', 'Parameter', row.id, { newValue: { ...snapshot(row), departments: created.departmentNames } })
  res.status(201).json(created)
})

/** Sets the default display order: body is the full list of parameter ids in order. */
parametersRouter.put('/order', async (req, res) => {
  const { ids } = z.object({ ids: z.array(z.uuid()) }).parse(req.body)
  await db.transaction(async (tx) => {
    for (const [index, id] of ids.entries()) {
      await tx.update(parameters).set({ sortOrder: index }).where(eq(parameters.id, id))
    }
  })
  await audit(req, 'REORDER_PARAMETERS', 'Parameter', null, { newValue: ids })
  res.status(204).end()
})

parametersRouter.put('/:id', async (req, res) => {
  const id = idParam(req)
  const data = input.parse(req.body)
  validate(data)
  const [before] = await db.select().from(parameters).where(eq(parameters.id, id))
  if (!before) throw notFound('Parameter')
  const wasIn = await withDepartments(before)
  const { sortOrder, departmentIds, departmentId: _legacy, ...fields } = data
  const [row] = await db
    .update(parameters)
    .set(sortOrder === undefined ? fields : { ...fields, sortOrder })
    .where(eq(parameters.id, id))
    .returning()
  await saveDepartments(id, departmentIds)
  const updated = await withDepartments(row)
  await audit(req, 'UPDATE_PARAMETER', 'Parameter', id, {
    oldValue: { ...snapshot(before), departments: wasIn.departmentNames },
    newValue: { ...snapshot(row), departments: updated.departmentNames }
  })
  res.json(updated)
})

/** Deletes the parameter and removes it from all activities. Submitted values keep their snapshot. */
parametersRouter.delete('/:id', async (req, res) => {
  const id = idParam(req)
  const [before] = await db.select().from(parameters).where(eq(parameters.id, id))
  if (!before) throw notFound('Parameter')
  await db.delete(parameters).where(eq(parameters.id, id))
  await audit(req, 'DELETE_PARAMETER', 'Parameter', id, { oldValue: snapshot(before) })
  res.json({ result: 'deleted' })
})
