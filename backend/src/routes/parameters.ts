import { Router } from 'express'
import { z } from 'zod'
import { asc, desc, eq } from 'drizzle-orm'
import { db } from '../db/client'
import { activityParameters, departments, parameters } from '../db/schema'
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
    type: z.enum(['NUMBER', 'TEXT', 'DROPDOWN', 'YES_NO', 'PASS_FAIL']),
    unit: optionalText(30),
    minValue: optionalNumber,
    maxValue: optionalNumber,
    options: z.array(z.string().trim().min(1).max(100)).default([]),
    isRequired: z.boolean().default(true),
    isActive: z.boolean().default(true),
    /** Omit to keep the current position (update) or append at the end (create). */
    sortOrder: z.coerce.number().int().optional(),
    description: optionalText(500),
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
      options: p.type === 'DROPDOWN' ? [...new Set(p.options)] : []
    }
  })

function validate(p: z.infer<typeof input>) {
  if (p.type === 'DROPDOWN' && p.options.length === 0) throw badRequest('Add at least one dropdown option')
  if (p.minValue != null && p.maxValue != null && p.minValue > p.maxValue) {
    throw badRequest('Minimum value cannot be greater than maximum value')
  }
}

parametersRouter.get('/', async (_req, res) => {
  const [rows, links] = await Promise.all([
    db
      .select({ parameter: parameters, departmentName: departments.name })
      .from(parameters)
      .leftJoin(departments, eq(parameters.departmentId, departments.id))
      .orderBy(asc(parameters.sortOrder), asc(parameters.name)),
    db.select({ activityId: activityParameters.activityId, parameterId: activityParameters.parameterId }).from(activityParameters)
  ])
  res.json(
    rows.map((r) => ({
      ...r.parameter,
      departmentName: r.departmentName,
      rule: ruleText(r.parameter),
      activityIds: links.filter((l) => l.parameterId === r.parameter.id).map((l) => l.activityId)
    }))
  )
})

parametersRouter.post('/', async (req, res) => {
  const data = input.parse(req.body)
  validate(data)
  if (data.sortOrder === undefined) {
    const [last] = await db.select({ sortOrder: parameters.sortOrder }).from(parameters).orderBy(desc(parameters.sortOrder)).limit(1)
    data.sortOrder = (last?.sortOrder ?? -1) + 1
  }
  const [row] = await db.insert(parameters).values(data).returning()
  await audit(req, 'CREATE_PARAMETER', 'Parameter', row.id, { newValue: snapshot(row) })
  res.status(201).json(row)
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
  const { sortOrder, ...fields } = data
  const [row] = await db
    .update(parameters)
    .set(sortOrder === undefined ? fields : { ...fields, sortOrder })
    .where(eq(parameters.id, id))
    .returning()
  await audit(req, 'UPDATE_PARAMETER', 'Parameter', id, { oldValue: snapshot(before), newValue: snapshot(row) })
  res.json(row)
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
