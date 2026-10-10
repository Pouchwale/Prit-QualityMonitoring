import { Router } from 'express'
import { z } from 'zod'
import { asc, eq, inArray, notExists } from 'drizzle-orm'
import { db } from '../db/client'
import { departments, machineActivities, machineDepartments, machines } from '../db/schema'
import { idParam, optionalText, optionalUuid } from '../lib/validate'
import { badRequest, notFound } from '../lib/http'
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
  activityIds: z.array(z.uuid()).optional(),
  /** Every department the machine works for; the first is its main department (departmentId). */
  departmentIds: z.array(z.uuid()).max(50).optional()
})

/**
 * Every machine once, with all its departments. `?departmentId=<id>` keeps the machines of that
 * department, `?departmentId=none` the machines with no department.
 */
machinesRouter.get('/', async (req, res) => {
  const { departmentId } = z.object({ departmentId: z.union([z.uuid(), z.literal('none')]).optional() }).parse(req.query)
  const filter =
    departmentId === 'none'
      ? notExists(db.select().from(machineDepartments).where(eq(machineDepartments.machineId, machines.id)))
      : departmentId
      ? inArray(machines.id, db.select({ id: machineDepartments.machineId }).from(machineDepartments).where(eq(machineDepartments.departmentId, departmentId)))
      : undefined
  const [rows, links, mapped] = await Promise.all([
    db
      .select({ machine: machines, departmentName: departments.name })
      .from(machines)
      .leftJoin(departments, eq(machines.departmentId, departments.id))
      .where(filter)
      .orderBy(asc(machines.name)),
    db.select().from(machineActivities),
    db
      .select({ machineId: machineDepartments.machineId, id: departments.id, code: departments.code, name: departments.name, isActive: departments.isActive })
      .from(machineDepartments)
      .innerJoin(departments, eq(machineDepartments.departmentId, departments.id))
      .orderBy(asc(departments.name))
  ])
  res.json(
    rows.map((r) => {
      // The main department first, then by name: a form that saves this order keeps the main one.
      const depts = mapped
        .filter((d) => d.machineId === r.machine.id)
        .map(({ machineId: _m, ...d }) => d)
        .sort((a, b) => Number(b.id === r.machine.departmentId) - Number(a.id === r.machine.departmentId))
      return {
        ...r.machine,
        departmentName: r.departmentName,
        departmentIds: depts.map((d) => d.id),
        departments: depts,
        activityIds: links.filter((l) => l.machineId === r.machine.id).map((l) => l.activityId)
      }
    })
  )
})

/**
 * Saves the machine's departments: duplicates dropped, unknown ids refused. Without `departmentIds`
 * (older screens send one departmentId) that one department is added and the others are kept.
 */
async function setDepartments(machineId: string, departmentIds: string[] | undefined, departmentId: string | null) {
  if (!departmentIds) {
    if (departmentId) await db.insert(machineDepartments).values({ machineId, departmentId }).onConflictDoNothing()
    return
  }
  await db.delete(machineDepartments).where(eq(machineDepartments.machineId, machineId))
  if (departmentIds.length) await db.insert(machineDepartments).values(departmentIds.map((departmentId) => ({ machineId, departmentId })))
}

/** Unique, existing department ids, in the order given; 400 for an unknown one. */
async function checkedDepartments(ids: string[] | undefined) {
  if (!ids) return undefined
  const unique = [...new Set(ids)]
  if (!unique.length) return unique
  const found = await db.select({ id: departments.id }).from(departments).where(inArray(departments.id, unique))
  if (found.length !== unique.length) throw badRequest('One of the chosen departments does not exist')
  return unique
}

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
  const { activityIds, departmentIds: rawDepartments, ...data } = input.parse(req.body)
  const departmentIds = await checkedDepartments(rawDepartments)
  if (departmentIds) data.departmentId = departmentIds[0] ?? null
  const [row] = await db.insert(machines).values(data).returning()
  await setActivities(row.id, activityIds)
  await setDepartments(row.id, departmentIds, row.departmentId)
  await audit(req, 'CREATE_MACHINE', 'Machine', row.id, { newValue: { ...snapshot(row), activityIds, departmentIds } })
  res.status(201).json(row)
})

machinesRouter.put('/:id', async (req, res) => {
  const id = idParam(req)
  const { activityIds, departmentIds: rawDepartments, ...data } = input.parse(req.body)
  const departmentIds = await checkedDepartments(rawDepartments)
  if (departmentIds) data.departmentId = departmentIds[0] ?? null
  const [before] = await db.select().from(machines).where(eq(machines.id, id))
  if (!before) throw notFound('Machine')
  const beforeDepartments = (await db.select({ id: machineDepartments.departmentId }).from(machineDepartments).where(eq(machineDepartments.machineId, id))).map((d) => d.id)
  const [row] = await db.update(machines).set(data).where(eq(machines.id, id)).returning()
  await setActivities(id, activityIds)
  await setDepartments(id, departmentIds, row.departmentId)
  if (before.status !== row.status || before.isActive !== row.isActive) {
    await removeUpcomingChecks({ machineId: id })
  }
  await audit(req, 'UPDATE_MACHINE', 'Machine', id, {
    oldValue: { ...snapshot(before), departmentIds: beforeDepartments },
    newValue: { ...snapshot(row), activityIds, departmentIds }
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
