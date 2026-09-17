import { Router } from 'express'
import { z } from 'zod'
import { asc, eq } from 'drizzle-orm'
import { db } from '../db/client'
import { departments, machineActivities, machines } from '../db/schema'
import { idParam, optionalText, optionalUuid } from '../lib/validate'
import { notFound } from '../lib/http'
import { audit, snapshot } from '../lib/audit'
import { deleteOrDisable } from '../lib/crud'
import { removeUpcomingChecks } from '../services/checkGenerator'

export const machinesRouter = Router()

const input = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120),
  code: z.string().trim().min(1, 'Code is required').max(40),
  departmentId: optionalUuid,
  line: optionalText(),
  model: optionalText(),
  status: z.enum(['ACTIVE', 'MAINTENANCE', 'IDLE']).default('ACTIVE'),
  notes: optionalText(500),
  isActive: z.boolean().default(true),
  activityIds: z.array(z.uuid()).optional()
})

machinesRouter.get('/', async (_req, res) => {
  const [rows, links] = await Promise.all([
    db
      .select({ machine: machines, departmentName: departments.name })
      .from(machines)
      .leftJoin(departments, eq(machines.departmentId, departments.id))
      .orderBy(asc(machines.name)),
    db.select().from(machineActivities)
  ])
  res.json(
    rows.map((r) => ({
      ...r.machine,
      departmentName: r.departmentName,
      activityIds: links.filter((l) => l.machineId === r.machine.id).map((l) => l.activityId)
    }))
  )
})

async function setActivities(machineId: string, activityIds: string[] | undefined) {
  if (!activityIds) return
  await db.delete(machineActivities).where(eq(machineActivities.machineId, machineId))
  if (activityIds.length) {
    await db
      .insert(machineActivities)
      .values([...new Set(activityIds)].map((activityId) => ({ machineId, activityId })))
  }
}

machinesRouter.post('/', async (req, res) => {
  const { activityIds, ...data } = input.parse(req.body)
  const [row] = await db.insert(machines).values(data).returning()
  await setActivities(row.id, activityIds)
  await audit(req, 'CREATE_MACHINE', 'Machine', row.id, { newValue: { ...snapshot(row), activityIds } })
  res.status(201).json(row)
})

machinesRouter.put('/:id', async (req, res) => {
  const id = idParam(req)
  const { activityIds, ...data } = input.parse(req.body)
  const [before] = await db.select().from(machines).where(eq(machines.id, id))
  if (!before) throw notFound('Machine')
  const [row] = await db.update(machines).set(data).where(eq(machines.id, id)).returning()
  await setActivities(id, activityIds)
  if (before.status !== row.status || before.isActive !== row.isActive) {
    await removeUpcomingChecks({ machineId: id })
  }
  await audit(req, 'UPDATE_MACHINE', 'Machine', id, {
    oldValue: snapshot(before),
    newValue: { ...snapshot(row), activityIds }
  })
  res.json(row)
})

machinesRouter.delete('/:id', async (req, res) => {
  const id = idParam(req)
  await removeUpcomingChecks({ machineId: id })
  const result = await deleteOrDisable(machines, id)
  await audit(req, result === 'deleted' ? 'DELETE_MACHINE' : 'DISABLE_MACHINE', 'Machine', id)
  res.json({ result })
})
