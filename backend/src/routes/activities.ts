import { Router } from 'express'
import { z } from 'zod'
import { asc, eq } from 'drizzle-orm'
import { db } from '../db/client'
import { activities, activityParameters, departments, machineActivities, parameters } from '../db/schema'
import { idParam, optionalText, optionalUuid } from '../lib/validate'
import { notFound } from '../lib/http'
import { audit, snapshot } from '../lib/audit'
import { deleteOrDisable } from '../lib/crud'
import { removeUpcomingChecks } from '../services/checkGenerator'

export const activitiesRouter = Router()

const input = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120),
  code: z.string().trim().min(1, 'Code is required').max(40),
  departmentId: optionalUuid,
  description: optionalText(500),
  requirePhoto: z.boolean().default(true),
  requireVideo: z.boolean().default(false),
  requireJobNo: z.boolean().default(true),
  isActive: z.boolean().default(true),
  /** Parameters in the order they appear on the worker form. */
  parameters: z
    .array(
      z.object({
        parameterId: z.uuid(),
        isRequired: z.boolean().default(true),
        isEnabled: z.boolean().default(true)
      })
    )
    .default([]),
  machineIds: z.array(z.uuid()).default([])
})

activitiesRouter.get('/', async (_req, res) => {
  const [rows, params, links] = await Promise.all([
    db
      .select({ activity: activities, departmentName: departments.name })
      .from(activities)
      .leftJoin(departments, eq(activities.departmentId, departments.id))
      .orderBy(asc(activities.name)),
    db
      .select({
        activityId: activityParameters.activityId,
        parameterId: activityParameters.parameterId,
        sortOrder: activityParameters.sortOrder,
        isRequired: activityParameters.isRequired,
        isEnabled: activityParameters.isEnabled,
        name: parameters.name,
        code: parameters.code,
        type: parameters.type,
        unit: parameters.unit,
        parameterActive: parameters.isActive
      })
      .from(activityParameters)
      .innerJoin(parameters, eq(activityParameters.parameterId, parameters.id))
      .orderBy(asc(activityParameters.sortOrder)),
    db.select().from(machineActivities)
  ])

  res.json(
    rows.map((r) => ({
      ...r.activity,
      departmentName: r.departmentName,
      parameters: params
        .filter((p) => p.activityId === r.activity.id)
        .map(({ activityId: _a, ...p }) => p),
      machineIds: links.filter((l) => l.activityId === r.activity.id).map((l) => l.machineId)
    }))
  )
})

async function saveRelations(activityId: string, data: z.infer<typeof input>) {
  await db.transaction(async (tx) => {
    await tx.delete(activityParameters).where(eq(activityParameters.activityId, activityId))
    const seen = new Set<string>()
    const rows = data.parameters
      .filter((p) => !seen.has(p.parameterId) && seen.add(p.parameterId))
      .map((p, index) => ({ activityId, parameterId: p.parameterId, sortOrder: index, isRequired: p.isRequired, isEnabled: p.isEnabled }))
    if (rows.length) await tx.insert(activityParameters).values(rows)

    await tx.delete(machineActivities).where(eq(machineActivities.activityId, activityId))
    const machineIds = [...new Set(data.machineIds)]
    if (machineIds.length) await tx.insert(machineActivities).values(machineIds.map((machineId) => ({ machineId, activityId })))
  })
}

activitiesRouter.post('/', async (req, res) => {
  const data = input.parse(req.body)
  const { parameters: _p, machineIds: _m, ...fields } = data
  const [row] = await db.insert(activities).values(fields).returning()
  await saveRelations(row.id, data)
  await audit(req, 'CREATE_ACTIVITY', 'Activity', row.id, { newValue: data })
  res.status(201).json(row)
})

activitiesRouter.put('/:id', async (req, res) => {
  const id = idParam(req)
  const data = input.parse(req.body)
  const { parameters: _p, machineIds: _m, ...fields } = data
  const [before] = await db.select().from(activities).where(eq(activities.id, id))
  if (!before) throw notFound('Activity')
  const beforeParams = await db.select().from(activityParameters).where(eq(activityParameters.activityId, id))
  const [row] = await db.update(activities).set(fields).where(eq(activities.id, id)).returning()
  await saveRelations(id, data)
  if (before.isActive !== row.isActive) await removeUpcomingChecks({ activityId: id })
  await audit(req, 'UPDATE_ACTIVITY', 'Activity', id, {
    oldValue: { ...snapshot(before), parameters: beforeParams },
    newValue: data
  })
  res.json(row)
})

activitiesRouter.delete('/:id', async (req, res) => {
  const id = idParam(req)
  await removeUpcomingChecks({ activityId: id })
  const result = await deleteOrDisable(activities, id)
  await audit(req, result === 'deleted' ? 'DELETE_ACTIVITY' : 'DISABLE_ACTIVITY', 'Activity', id)
  res.json({ result })
})
