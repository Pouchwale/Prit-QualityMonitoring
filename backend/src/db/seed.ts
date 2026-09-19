import { db, pool } from './client'
import {
  activities,
  activityParameters,
  departments,
  machineActivities,
  machines,
  monitoringReasons,
  parameters,
  schedules,
  shifts,
  users,
  workerMachines
} from './schema'
import { passwordColumns } from '../lib/auth'
import { NEW_PARAMETERS } from './ensureNewParameters'

/**
 * Starter data. Safe to run more than once: it only inserts when the users table is empty.
 * Acceptance limits are left empty except where the PRD gives an example; the admin must
 * enter the company-approved limits from the SOPs.
 */
async function main() {
  const existing = await db.select({ id: users.id }).from(users).limit(1)
  if (existing.length) {
    console.log('Database already has data. Seed skipped.')
    return
  }

  await db.transaction(async (tx) => {
    await tx.insert(departments).values([
      { name: 'Pouch', code: 'POUCH' },
      { name: 'Slive', code: 'SLIVE' },
      { name: 'Label', code: 'LABEL' }
    ])

    const allShifts = await tx
      .insert(shifts)
      .values([
        { name: 'Shift A', code: 'SHIFT-A', startTime: '08:00', endTime: '16:00', graceMinutes: 20 },
        { name: 'Shift B', code: 'SHIFT-B', startTime: '16:00', endTime: '00:00', graceMinutes: 20 },
        { name: 'Shift C', code: 'SHIFT-C', startTime: '00:00', endTime: '08:00', graceMinutes: 20 }
      ])
      .returning()
    const shiftA = allShifts[0]

    // Plant machines. Departments are left empty so the admin can assign them.
    const allMachines = await tx
      .insert(machines)
      .values([
        { name: 'Lombardi', code: 'LOMBARDI' },
        { name: 'AKO 520', code: 'AKO-520' },
        { name: 'AKO 320', code: 'AKO-320' },
        { name: 'Gullace', code: 'GULLACE' },
        { name: 'Konica', code: 'KONICA' }
      ])
      .returning()
    const firstMachine = allMachines[0]

    const params = await tx
      .insert(parameters)
      .values([
        { name: 'Viscosity', code: 'VISCOSITY', type: 'NUMBER', unit: 'sec', minValue: 18, maxValue: 22, sortOrder: 0 },
        { name: 'Repeat Length', code: 'REPEAT-LENGTH', type: 'NUMBER', unit: 'mm', sortOrder: 1 },
        { name: 'Corona Treatment', code: 'CORONA', type: 'DROPDOWN', options: ['38 Dyne', '40 Dyne', '42 Dyne'], sortOrder: 2 },
        { name: 'TEAP Test', code: 'TEAP', type: 'PASS_FAIL', sortOrder: 3 },
        { name: 'Deep Punching', code: 'DEEP-PUNCHING', type: 'PASS_FAIL', sortOrder: 4 },
        { name: 'Registration', code: 'REGISTRATION', type: 'PASS_FAIL', sortOrder: 5 },
        { name: 'Print Prachar', code: 'PRINT-PRACHAR', type: 'PASS_FAIL', sortOrder: 6 },
        // Optional on the check form until the admin sets their rules in Check Types.
        ...NEW_PARAMETERS.map((p, i) => ({ ...p, isRequired: false, sortOrder: 7 + i }))
      ])
      .returning()

    const [routine] = await tx
      .insert(activities)
      .values({
        name: 'Routine Quality Check',
        code: 'ROUTINE-QC',
        description: 'Standard periodic quality check',
        // Evidence is captured per parameter (below), so no single photo for the whole check.
        requirePhoto: false,
        requireVideo: false,
        requireJobNo: true
      })
      .returning()

    /**
     * Per-parameter evidence and Not Applicable rules, as an example of how the plant works:
     *   Viscosity       a photo of the reading
     *   Registration    a photo and a video of the printed web (print quality)
     *   Deep Punching   a video of the machine, only while a job is running, and skippable
     * Everything else is a reading only. The admin adjusts these in Check Types.
     */
    const evidenceRules: Record<string, { requirePhoto?: boolean; requireVideo?: boolean; allowNa?: boolean; appliesWhen?: 'ALWAYS' | 'JOB_RUNNING' }> = {
      VISCOSITY: { requirePhoto: true },
      REGISTRATION: { requirePhoto: true, requireVideo: true, allowNa: true },
      'DEEP-PUNCHING': { requireVideo: true, allowNa: true, appliesWhen: 'JOB_RUNNING' }
    }

    await tx.insert(activityParameters).values(
      params.map((p, index) => ({
        activityId: routine.id,
        parameterId: p.id,
        sortOrder: index,
        isRequired: p.isRequired,
        ...evidenceRules[p.code]
      }))
    )

    // The reasons a worker may choose when marking a parameter Not Applicable. Migration 0009
    // already inserts these, so only a database without any reason at all is filled here.
    const reasons = await tx.select({ id: monitoringReasons.id }).from(monitoringReasons).limit(1)
    if (reasons.length === 0) {
      await tx.insert(monitoringReasons).values([
        { label: 'Job still running', requiresRemark: false, sortOrder: 0 },
        { label: 'Parameter not applicable', requiresRemark: false, sortOrder: 1 },
        { label: 'Machine stopped', requiresRemark: false, sortOrder: 2 },
        { label: 'No production', requiresRemark: false, sortOrder: 3 },
        { label: 'Other', requiresRemark: true, sortOrder: 4 }
      ])
    }
    await tx.insert(machineActivities).values(allMachines.map((m) => ({ machineId: m.id, activityId: routine.id })))

    await tx.insert(users).values({
      employeeId: 'ADMIN',
      name: 'Administrator',
      role: 'SUPER_ADMIN',
      designation: 'System Administrator',
      ...(await passwordColumns(process.env.SEED_ADMIN_PASSWORD || 'admin123')),
      appAccess: false
    })

    const [worker] = await tx
      .insert(users)
      .values({
        employeeId: 'EMP-104',
        name: 'Prit Patel',
        role: 'WORKER',
        designation: 'Quality Inspector',
        shiftId: shiftA.id,
        ...(await passwordColumns(process.env.SEED_WORKER_PASSWORD || 'worker123'))
      })
      .returning()

    await tx.insert(workerMachines).values(allMachines.map((m) => ({ userId: worker.id, machineId: m.id })))

    // Demo schedules on all three shifts so there is always something to test.
    await tx.insert(schedules).values(
      allShifts.map((shift) => ({
        machineId: firstMachine.id,
        activityId: routine.id,
        shiftId: shift.id,
        workerId: worker.id,
        intervalMinutes: 60
      }))
    )

    // No plant name is seeded. Set one in Admin → Settings if this site needs one;
    // the UI and the report simply leave it out when it is not set.
  })

  console.log('Seed complete.')
  console.log('Admin panel login  → Employee ID: ADMIN    Password:', process.env.SEED_ADMIN_PASSWORD || 'admin123')
  console.log('Worker app login   → Employee ID: EMP-104  Password:', process.env.SEED_WORKER_PASSWORD || 'worker123')
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => pool.end())
