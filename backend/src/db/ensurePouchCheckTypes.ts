import { eq, max, sql } from 'drizzle-orm'
import { db } from './client'
import {
  activities,
  activityParameters,
  departmentMappings,
  departments,
  machineActivities,
  machines,
  parameterDepartments,
  parameters,
  settings
} from './schema'

/** Marker to prevent overwriting admin changes on subsequent restarts */
const MARKER = 'checktypes.pouch-ipqc-qc.2026-10'

type ParameterSpec = Pick<typeof parameters.$inferInsert, 'name' | 'code' | 'type' | 'unit' | 'description'>

const POUCH_PARAMETERS: ParameterSpec[] = [
  // 1. Pouch Printing — IPQC
  {
    name: 'Rigition',
    code: 'RIGITION',
    type: 'PASS_FAIL',
    description: 'Rigition test for pouch printing'
  },
  {
    name: 'White Viscosity',
    code: 'WHITE-VISCOSITY',
    type: 'NUMBER',
    unit: 'sec',
    description: 'White ink viscosity reading in seconds'
  },
  {
    name: 'Color',
    code: 'COLOR',
    type: 'PASS_FAIL',
    description: 'Color match verification'
  },
  // 2. Pouch — QC
  {
    name: 'Pouch Leakage',
    code: 'POUCH-LEAKAGE',
    type: 'PASS_FAIL',
    description: 'Pouch leakage test'
  },
  {
    name: 'Pouch Size',
    code: 'POUCH-SIZE',
    type: 'PASS_FAIL',
    description: 'Pouch size verification'
  },
  {
    name: 'Zipper Closure',
    code: 'ZIPPER-CLOSURE',
    type: 'PASS_FAIL',
    description: 'Zipper closure test'
  }
]

const key = (s: string) => s.trim().toLowerCase()

export async function ensurePouchCheckTypes() {
  const [done] = await db.select({ key: settings.key }).from(settings).where(eq(settings.key, MARKER)).limit(1)
  if (done) return 0

  const created = await db.transaction(async (tx) => {
    // ---------------------------------------------------------------- Department
    const departmentRows = await tx.select({ id: departments.id, name: departments.name, code: departments.code }).from(departments)
    let pouchDept = departmentRows.find((d) => key(d.name) === 'pouch' || key(d.code) === 'pouch')
    if (!pouchDept) {
      const [newDept] = await tx.insert(departments).values({ name: 'Pouch', code: 'POUCH' }).returning()
      pouchDept = newDept
      departmentRows.push(newDept)
    }

    // Ensure RMPC department mapping exists
    const mappedPrefixes = (await tx.select({ prefix: departmentMappings.prefix }).from(departmentMappings)).map((m) => m.prefix.toUpperCase())
    if (!mappedPrefixes.includes('RMPC')) {
      await tx.insert(departmentMappings).values({ prefix: 'RMPC', departmentId: pouchDept.id })
    }

    // ---------------------------------------------------------------- Parameters
    const existingParams = await tx.select({ id: parameters.id, name: parameters.name, code: parameters.code }).from(parameters)
    const [{ last }] = await tx.select({ last: max(parameters.sortOrder) }).from(parameters)
    let sortOrder = (last ?? -1) + 1
    const takenCodes = new Set(existingParams.map((p) => key(p.code)))
    const paramIdMap = new Map<string, string>()

    for (const spec of POUCH_PARAMETERS) {
      const found = existingParams.find((p) => key(p.name) === key(spec.name) || key(p.code) === key(spec.code))
      if (found) {
        paramIdMap.set(spec.name, found.id)
      } else {
        let code = spec.code
        for (let n = 2; takenCodes.has(key(code)); n++) code = `${spec.code}-${n}`
        takenCodes.add(key(code))
        const [row] = await tx
          .insert(parameters)
          .values({ ...spec, code, isRequired: true, sortOrder: sortOrder++ })
          .returning({ id: parameters.id })
        existingParams.push({ id: row.id, name: spec.name, code })
        paramIdMap.set(spec.name, row.id)
      }

      // Link parameter to Pouch department in parameter_departments
      const pId = paramIdMap.get(spec.name)!
      await tx
        .insert(parameterDepartments)
        .values({ parameterId: pId, departmentId: pouchDept.id })
        .onConflictDoNothing()
    }

    // ---------------------------------------------------------------- Activities
    const activityRows = await tx.select().from(activities)
    const activeMachines = await tx.select({ id: machines.id }).from(machines).where(eq(machines.isActive, true))
    const madeTypes: string[] = []

    // 1. Pouch Printing — IPQC
    let pouchPrinting = activityRows.find((a) => key(a.name) === 'pouch printing' || key(a.code) === 'pouch-printing-ipqc')
    if (!pouchPrinting) {
      const [act] = await tx
        .insert(activities)
        .values({
          name: 'Pouch Printing',
          code: 'POUCH-PRINTING-IPQC',
          description: 'In-Process Quality Check for Pouch Printing',
          module: 'IPQC',
          departmentId: pouchDept.id,
          requirePhoto: true,
          requireVideo: false,
          requireJobNo: true,
          allowManual: true,
          monitoring: 'SHIFT',
          isActive: true
        })
        .returning()
      pouchPrinting = act
      madeTypes.push('Pouch Printing')
    } else {
      // Ensure module and department are correct
      await tx
        .update(activities)
        .set({
          module: 'IPQC',
          departmentId: pouchDept.id,
          requireJobNo: true,
          requirePhoto: true,
          isActive: true
        })
        .where(eq(activities.id, pouchPrinting.id))
    }

    // Set parameters for Pouch Printing
    const ipqcParamNames = ['Rigition', 'White Viscosity', 'Color']
    await tx.delete(activityParameters).where(eq(activityParameters.activityId, pouchPrinting.id))
    await tx.insert(activityParameters).values(
      ipqcParamNames.map((name, index) => ({
        activityId: pouchPrinting!.id,
        parameterId: paramIdMap.get(name)!,
        sortOrder: index,
        isRequired: true,
        isEnabled: true
      }))
    )
    if (activeMachines.length) {
      await tx
        .insert(machineActivities)
        .values(activeMachines.map((m) => ({ machineId: m.id, activityId: pouchPrinting!.id })))
        .onConflictDoNothing()
    }

    // 2. Pouch — QC
    // Look for existing QC activity named Pouch or with code POUCH-QC or ROUTINE-QC
    let pouchQc = activityRows.find((a) => (key(a.name) === 'pouch' && a.module === 'QC') || key(a.code) === 'pouch-qc')
    if (!pouchQc) {
      // If none found, look for ROUTINE-QC
      pouchQc = activityRows.find((a) => key(a.code) === 'routine-qc')
    }

    if (!pouchQc) {
      const [act] = await tx
        .insert(activities)
        .values({
          name: 'Pouch',
          code: 'POUCH-QC',
          description: 'Quality Check for Pouch',
          module: 'QC',
          departmentId: pouchDept.id,
          requirePhoto: true,
          requireVideo: false,
          requireJobNo: true,
          allowManual: true,
          monitoring: 'SHIFT',
          isActive: true
        })
        .returning()
      pouchQc = act
      madeTypes.push('Pouch')
    } else {
      // Update existing to have proper code, name, module, department and evidence rules
      await tx
        .update(activities)
        .set({
          name: 'Pouch',
          code: pouchQc.code === 'ROUTINE-QC' ? 'POUCH-QC' : pouchQc.code,
          module: 'QC',
          departmentId: pouchDept.id,
          requireJobNo: true,
          requirePhoto: true,
          isActive: true
        })
        .where(eq(activities.id, pouchQc.id))
      madeTypes.push('Pouch')
    }

    // Set parameters for Pouch QC
    const qcParamNames = ['Pouch Leakage', 'Pouch Size', 'Zipper Closure']
    await tx.delete(activityParameters).where(eq(activityParameters.activityId, pouchQc.id))
    await tx.insert(activityParameters).values(
      qcParamNames.map((name, index) => ({
        activityId: pouchQc!.id,
        parameterId: paramIdMap.get(name)!,
        sortOrder: index,
        isRequired: true,
        isEnabled: true
      }))
    )
    if (activeMachines.length) {
      await tx
        .insert(machineActivities)
        .values(activeMachines.map((m) => ({ machineId: m.id, activityId: pouchQc!.id })))
        .onConflictDoNothing()
    }

    return madeTypes
  })

  await db
    .insert(settings)
    .values({ key: MARKER, value: { created, at: new Date().toISOString() } })
    .onConflictDoUpdate({ target: settings.key, set: { updatedAt: sql`now()` } })

  return created.length
}
