import { eq, max, sql } from 'drizzle-orm'
import { db } from './client'
import { activities, activityParameters, departments, machineActivities, machines, parameters, settings } from './schema'

/** Set once the check types below have been created, so anything an admin later changes stays changed. */
const MARKER = 'checktypes.label-sleeve.2026-09'

type ParameterSpec = Pick<typeof parameters.$inferInsert, 'name' | 'code' | 'type' | 'unit' | 'options' | 'materialOptions' | 'description'>

/**
 * Every parameter the Label and Sleeve check types ask for. A parameter that already exists (by
 * name or by code, ignoring case) is reused exactly as it is: its type, limits and options belong
 * to the admin. Only the ones the plant does not have yet are created.
 */
const PARAMETER_SPECS: ParameterSpec[] = [
  { name: 'Artwork', code: 'ARTWORK', type: 'YES_NO', description: 'Printed job matches the approved artwork' },
  // The material is asked first, then the dyne; both are recorded on this one parameter.
  { name: 'Corona Treatment', code: 'CORONA', type: 'DROPDOWN', materialOptions: ['BOPP 38', 'PET 56'], options: ['38 Dyne', '40 Dyne', '56 Dyne'] },
  { name: 'Label', code: 'LABEL', type: 'PASS_FAIL', description: 'Label check' },
  { name: 'White Window Test', code: 'WHITE-WINDOW-TEST', type: 'PASS_FAIL', description: 'Label adhesion: white window test' },
  { name: 'Nail Test', code: 'NAIL-TEST', type: 'PASS_FAIL', description: 'Sleeve print rub resistance: nail test' },
  { name: 'Deep Punching', code: 'DEEP-PUNCHING', type: 'PASS_FAIL' },
  { name: 'Registration', code: 'REGISTRATION', type: 'PASS_FAIL' },
  { name: 'Print Pressure Value', code: 'PRINT-PRESSURE-VALUE', type: 'NUMBER', description: 'Printing pressure reading' },
  { name: 'Addition', code: 'ADDITION', type: 'YES_NO', description: 'Any addition on this job' },
  { name: 'Text Matter', code: 'TEXT-MATTER', type: 'PASS_FAIL', description: 'Printed text matches the approved artwork' },
  { name: 'Direction', code: 'DIRECTION', type: 'PASS_FAIL', description: 'Print and unwind direction are correct' },
  { name: 'Duration', code: 'DURATION', type: 'NUMBER', unit: 'min' },
  {
    name: 'Shared Card',
    code: 'SHARED-CARD',
    type: 'DROPDOWN',
    options: ['GMB', 'Shared Card', 'Pantone', 'Party Special', 'Last Supply', 'Online Approval'],
    description: 'Colour reference used for this job'
  },
  { name: 'Ink Photo', code: 'INK-PHOTO', type: 'PHOTO', description: 'Photo of the ink reference' }
]

/**
 * The two department check types, with their parameters in the order the worker fills them in.
 * Label uses the White Window Test and Sleeve the Nail Test, in place of the older Tape Test.
 */
const CHECK_TYPES = [
  {
    name: 'Label',
    code: 'LABEL-QC',
    description: 'Quality check for the Label department',
    /** Matched against the existing departments by name or code, ignoring case; created if missing. */
    department: { name: 'Label', code: 'LABEL', aliases: ['label'] },
    parameterNames: [
      'Artwork',
      'Corona Treatment',
      'Label',
      'White Window Test',
      'Deep Punching',
      'Registration',
      'Print Pressure Value',
      'Addition',
      'Text Matter',
      'Direction',
      'Shared Card',
      'Ink Photo'
    ]
  },
  {
    name: 'Sleeve',
    code: 'SLEEVE-QC',
    description: 'Quality check for the Sleeve department',
    // "sleave" and "slive" are how this department has been spelled in the plant's own data.
    department: { name: 'Sleeve', code: 'SLEEVE', aliases: ['sleeve', 'sleave', 'slive'] },
    parameterNames: [
      'Artwork',
      'Corona Treatment',
      'Label',
      'Nail Test',
      'Deep Punching',
      'Registration',
      'Print Pressure Value',
      'Addition',
      'Text Matter',
      'Duration',
      'Shared Card',
      'Ink Photo'
    ]
  }
]

const key = (s: string) => s.trim().toLowerCase()

/**
 * Adds the Label and Sleeve check types, once. Nothing existing is changed: departments and
 * parameters already in the plant are reused, and a check type whose name or code is already taken
 * is left exactly as the admin set it up. Returns how many check types were created.
 */
export async function ensureCheckTypes() {
  const [done] = await db.select({ key: settings.key }).from(settings).where(eq(settings.key, MARKER)).limit(1)
  if (done) return 0

  const created = await db.transaction(async (tx) => {
    // ---------------------------------------------------------------- departments
    const departmentRows = await tx.select({ id: departments.id, name: departments.name, code: departments.code }).from(departments)
    const departmentId = async (spec: (typeof CHECK_TYPES)[number]['department']) => {
      const found = departmentRows.find((d) => spec.aliases.includes(key(d.name)) || spec.aliases.includes(key(d.code)))
      if (found) return found.id
      const [row] = await tx.insert(departments).values({ name: spec.name, code: spec.code }).returning({ id: departments.id })
      departmentRows.push({ id: row.id, name: spec.name, code: spec.code })
      return row.id
    }

    // ---------------------------------------------------------------- parameters
    const existing = await tx.select({ id: parameters.id, name: parameters.name, code: parameters.code }).from(parameters)
    const [{ last }] = await tx.select({ last: max(parameters.sortOrder) }).from(parameters)
    let sortOrder = (last ?? -1) + 1
    const takenCodes = new Set(existing.map((p) => key(p.code)))
    const parameterId = new Map<string, string>()
    for (const spec of PARAMETER_SPECS) {
      const found = existing.find((p) => key(p.name) === key(spec.name) || key(p.code) === key(spec.code))
      if (found) {
        parameterId.set(spec.name, found.id)
        continue
      }
      // A free code, in case an unrelated parameter already uses the obvious one.
      let code = spec.code
      for (let n = 2; takenCodes.has(key(code)); n++) code = `${spec.code}-${n}`
      takenCodes.add(key(code))
      const [row] = await tx
        .insert(parameters)
        .values({ ...spec, code, isRequired: true, sortOrder: sortOrder++ })
        .returning({ id: parameters.id })
      existing.push({ id: row.id, name: spec.name, code })
      parameterId.set(spec.name, row.id)
    }

    // ---------------------------------------------------------------- check types
    const activityRows = await tx.select({ name: activities.name, code: activities.code }).from(activities)
    const activeMachines = await tx.select({ id: machines.id }).from(machines).where(eq(machines.isActive, true))
    const madeTypes: string[] = []
    for (const spec of CHECK_TYPES) {
      if (activityRows.some((a) => key(a.name) === key(spec.name) || key(a.code) === key(spec.code))) continue
      const [activity] = await tx
        .insert(activities)
        .values({
          name: spec.name,
          code: spec.code,
          description: spec.description,
          departmentId: await departmentId(spec.department),
          // Evidence is set per parameter in Check Types, so no single photo for the whole check.
          requirePhoto: false,
          requireVideo: false,
          requireJobNo: true
        })
        .returning({ id: activities.id })
      await tx.insert(activityParameters).values(
        spec.parameterNames.map((name, index) => ({
          activityId: activity.id,
          parameterId: parameterId.get(name)!,
          sortOrder: index,
          isRequired: true
        }))
      )
      // Offered on every machine in use; the admin narrows this in Check Types → Machines.
      if (activeMachines.length) await tx.insert(machineActivities).values(activeMachines.map((m) => ({ machineId: m.id, activityId: activity.id })))
      madeTypes.push(spec.name)
    }
    return madeTypes
  })

  await db
    .insert(settings)
    .values({ key: MARKER, value: { created, at: new Date().toISOString() } })
    .onConflictDoUpdate({ target: settings.key, set: { updatedAt: sql`now()` } })
  return created.length
}
