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
  /** "Overall check photo/video": one photo/video for the whole check. */
  requirePhoto: z.boolean().default(true),
  requireVideo: z.boolean().default(false),
  requireJobNo: z.boolean().default(true),
  /** The worker may start this check from the machine screen. Left as it is when not sent. */
  allowManual: z.boolean().optional(),
  /** SHIFT: shift schedules create the checks. JOB: checked per job (start, intervals, end). Kept when not sent. */
  monitoring: z.enum(['SHIFT', 'JOB']).optional(),
  /** Job interval checks stay open this long after they are due. Kept when not sent. */
  graceMinutes: z.coerce.number().int().min(5, 'Grace must be at least 5 minutes').max(240).optional(),
  isActive: z.boolean().default(true),
  /** Parameters in the order they appear on the worker form, with their evidence rules. */
  parameters: z
    .array(
      z.object({
        parameterId: z.uuid(),
        isRequired: z.boolean().default(true),
        isEnabled: z.boolean().default(true),
        /** Evidence for this parameter. Omitted fields keep whatever is stored. */
        requirePhoto: z.boolean().optional(),
        requireVideo: z.boolean().optional(),
        allowNa: z.boolean().optional(),
        appliesWhen: z.enum(['ALWAYS', 'JOB_RUNNING']).optional(),
        /** Job-based check types: when this parameter is checked. */
        frequency: z.enum(['JOB_START', 'INTERVAL', 'JOB_END']).optional(),
        intervalMinutes: z.coerce.number().int().min(5, 'The interval must be at least 5 minutes').max(1440, 'The interval can be at most 24 hours').optional()
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
        requirePhoto: activityParameters.requirePhoto,
        requireVideo: activityParameters.requireVideo,
        allowNa: activityParameters.allowNa,
        appliesWhen: activityParameters.appliesWhen,
        frequency: activityParameters.frequency,
        intervalMinutes: activityParameters.intervalMinutes,
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
  // The parameter rows are rewritten, so anything the caller did not send keeps its old value
  // (an older admin screen must not silently clear the per-parameter evidence rules).
  const before = await db.select().from(activityParameters).where(eq(activityParameters.activityId, activityId))
  const kept = new Map(before.map((row) => [row.parameterId, row]))
  await db.transaction(async (tx) => {
    await tx.delete(activityParameters).where(eq(activityParameters.activityId, activityId))
    const seen = new Set<string>()
    const rows = data.parameters
      .filter((p) => !seen.has(p.parameterId) && seen.add(p.parameterId))
      .map((p, index) => ({
        activityId,
        parameterId: p.parameterId,
        sortOrder: index,
        isRequired: p.isRequired,
        isEnabled: p.isEnabled,
        requirePhoto: p.requirePhoto ?? kept.get(p.parameterId)?.requirePhoto ?? false,
        requireVideo: p.requireVideo ?? kept.get(p.parameterId)?.requireVideo ?? false,
        allowNa: p.allowNa ?? kept.get(p.parameterId)?.allowNa ?? false,
        appliesWhen: p.appliesWhen ?? kept.get(p.parameterId)?.appliesWhen ?? ('ALWAYS' as const),
        frequency: p.frequency ?? kept.get(p.parameterId)?.frequency ?? ('INTERVAL' as const),
        intervalMinutes: p.intervalMinutes ?? kept.get(p.parameterId)?.intervalMinutes ?? 60
      }))
    if (rows.length) await tx.insert(activityParameters).values(rows)

    await tx.delete(machineActivities).where(eq(machineActivities.activityId, activityId))
    const machineIds = [...new Set(data.machineIds)]
    if (machineIds.length) await tx.insert(machineActivities).values(machineIds.map((machineId) => ({ machineId, activityId })))
  })
}

activitiesRouter.post('/', async (req, res) => {
  const data = input.parse(req.body)
  const { parameters: _p, machineIds: _m, allowManual, ...rest } = data
  const fields = { ...rest, ...(allowManual === undefined ? {} : { allowManual }) }
  const [row] = await db.insert(activities).values(fields).returning()
  await saveRelations(row.id, data)
  await audit(req, 'CREATE_ACTIVITY', 'Activity', row.id, { newValue: data })
  res.status(201).json(row)
})

activitiesRouter.put('/:id', async (req, res) => {
  const id = idParam(req)
  const data = input.parse(req.body)
  const { parameters: _p, machineIds: _m, allowManual, ...rest } = data
  // Not sent: keep the stored value, so older screens do not turn manual submission off.
  const fields = { ...rest, ...(allowManual === undefined ? {} : { allowManual }) }
  const [before] = await db.select().from(activities).where(eq(activities.id, id))
  if (!before) throw notFound('Activity')
  const beforeParams = await db.select().from(activityParameters).where(eq(activityParameters.activityId, id))
  const [row] = await db.update(activities).set(fields).where(eq(activities.id, id)).returning()
  await saveRelations(id, data)
  // Paused, or switched between shift schedules and job-based: the old plan's upcoming checks go.
  if (before.isActive !== row.isActive || before.monitoring !== row.monitoring) await removeUpcomingChecks({ activityId: id })
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
