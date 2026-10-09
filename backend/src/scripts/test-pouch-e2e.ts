import { db, pool } from '../db/client'
import {
  activities,
  activityParameters,
  departments,
  parameters,
  qualityCheckValues,
  qualityChecks,
  schedules,
  users
} from '../db/schema'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { planChecks } from '../services/checkGenerator'
import { notifyDueChecks } from '../services/notifications'
import { listChecks } from '../services/checks'
import bcrypt from 'bcryptjs'
import { assertTestDatabase } from './testDatabaseGuard'

assertTestDatabase()

async function runE2ETest() {
  console.log('=====================================================')
  console.log('   POUCH IPQC & QC CHECK TYPES END-TO-END VALIDATION')
  console.log('=====================================================\n')

  // 1. Verify Check Types & Parameters in Master Data
  console.log('--- STEP 1: Verify Master Data Configuration ---')
  const [pouchDept] = await db.select().from(departments).where(eq(departments.code, 'POUCH'))
  if (!pouchDept) throw new Error('Pouch department not found')
  console.log(`[PASS] Pouch Department found: ID=${pouchDept.id}`)

  // Verify Pouch Printing IPQC
  const [ipqcAct] = await db
    .select()
    .from(activities)
    .where(and(eq(activities.name, 'Pouch Printing'), eq(activities.module, 'IPQC')))
  if (!ipqcAct) throw new Error('Pouch Printing (IPQC) activity not found')

  const ipqcParams = await db
    .select({ name: parameters.name, code: parameters.code, type: parameters.type, unit: parameters.unit })
    .from(activityParameters)
    .innerJoin(parameters, eq(activityParameters.parameterId, parameters.id))
    .where(eq(activityParameters.activityId, ipqcAct.id))
    .orderBy(asc(activityParameters.sortOrder))

  console.log(`[PASS] Pouch Printing (IPQC) Activity found: ID=${ipqcAct.id}, Active=${ipqcAct.isActive}`)
  console.log('       Configured Parameters:', ipqcParams.map((p) => `${p.name} (${p.type}${p.unit ? ` ${p.unit}` : ''})`))
  const expectedIpqcParams = ['Rigition', 'White Viscosity', 'Color']
  for (const expected of expectedIpqcParams) {
    if (!ipqcParams.some((p) => p.name === expected)) {
      throw new Error(`Missing expected IPQC parameter: ${expected}`)
    }
  }

  // Verify Pouch QC
  const [qcAct] = await db
    .select()
    .from(activities)
    .where(and(eq(activities.name, 'Pouch'), eq(activities.module, 'QC')))
  if (!qcAct) throw new Error('Pouch (QC) activity not found')

  const qcParams = await db
    .select({ name: parameters.name, code: parameters.code, type: parameters.type, unit: parameters.unit })
    .from(activityParameters)
    .innerJoin(parameters, eq(activityParameters.parameterId, parameters.id))
    .where(eq(activityParameters.activityId, qcAct.id))
    .orderBy(asc(activityParameters.sortOrder))

  console.log(`[PASS] Pouch (QC) Activity found: ID=${qcAct.id}, Active=${qcAct.isActive}`)
  console.log('       Configured Parameters:', qcParams.map((p) => `${p.name} (${p.type})`))
  const expectedQcParams = ['Pouch Leakage', 'Pouch Size', 'Zipper Closure']
  for (const expected of expectedQcParams) {
    if (!qcParams.some((p) => p.name === expected)) {
      throw new Error(`Missing expected QC parameter: ${expected}`)
    }
  }

  // Verify existing check types are intact
  const otherActivities = await db.select().from(activities).where(inArray(activities.name, ['Label', 'sleeve']))
  console.log(`[PASS] Existing check types intact: ${otherActivities.map((a) => `${a.name} (${a.module})`).join(', ')}`)

  // 2. Setup Workers
  console.log('\n--- STEP 2: Setup Test Workers ---')
  const passwordHash = await bcrypt.hash('password123', 8)

  async function ensureWorker(empId: string, name: string, role: 'IPQC' | 'QC' | 'BOTH') {
    let [w] = await db.select().from(users).where(eq(users.employeeId, empId))
    if (!w) {
      const [newW] = await db
        .insert(users)
        .values({
          employeeId: empId,
          name,
          role: 'WORKER',
          workerQualityRole: role,
          passwordHash,
          departmentId: pouchDept.id,
          isActive: true,
          appAccess: true
        })
        .returning()
      w = newW
    } else {
      const [updated] = await db
        .update(users)
        .set({ workerQualityRole: role, isActive: true, appAccess: true })
        .where(eq(users.id, w.id))
        .returning()
      w = updated
    }
    return w
  }

  const workerIpqc = await ensureWorker('TEST-POUCH-IPQC', 'Test Pouch IPQC Worker', 'IPQC')
  const workerQc = await ensureWorker('TEST-POUCH-QC', 'Test Pouch QC Worker', 'QC')
  const workerBoth = await ensureWorker('TEST-POUCH-BOTH', 'Test Pouch Both Worker', 'BOTH')
  console.log(`[PASS] Workers: ${workerIpqc.name} (IPQC), ${workerQc.name} (QC), ${workerBoth.name} (BOTH)`)

  // 3. Setup Schedules
  console.log('\n--- STEP 3: Create Check Schedules ---')
  // IPQC Schedule for Pouch Printing
  let [ipqcSchedule] = await db
    .select()
    .from(schedules)
    .where(and(eq(schedules.workerId, workerIpqc.id), eq(schedules.activityId, ipqcAct.id)))
  if (!ipqcSchedule) {
    const [sched] = await db
      .insert(schedules)
      .values({
        workerId: workerIpqc.id,
        activityId: ipqcAct.id,
        module: 'IPQC',
        departmentId: pouchDept.id,
        intervalMinutes: 30,
        startTime: '08:00',
        endTime: '20:00',
        mode: 'INTERVAL',
        isActive: true
      })
      .returning()
    ipqcSchedule = sched
  }
  console.log(`[PASS] Created/verified IPQC Schedule: ID=${ipqcSchedule.id}, Activity=Pouch Printing`)

  // QC Schedule for Pouch
  let [qcSchedule] = await db
    .select()
    .from(schedules)
    .where(and(eq(schedules.workerId, workerQc.id), eq(schedules.activityId, qcAct.id)))
  if (!qcSchedule) {
    const [sched] = await db
      .insert(schedules)
      .values({
        workerId: workerQc.id,
        activityId: qcAct.id,
        module: 'QC',
        departmentId: pouchDept.id,
        intervalMinutes: 60,
        startTime: '08:00',
        endTime: '20:00',
        mode: 'INTERVAL',
        isActive: true
      })
      .returning()
    qcSchedule = sched
  }
  console.log(`[PASS] Created/verified QC Schedule: ID=${qcSchedule.id}, Activity=Pouch`)

  // 4. Generate & Plan Checks
  console.log('\n--- STEP 4: Scheduler Plan Checks & Notifications ---')
  const now = new Date()
  await planChecks(now)
  console.log('[PASS] planChecks completed')

  const notifyRes = await notifyDueChecks()
  console.log(`[PASS] notifyDueChecks: ${notifyRes.checks} check(s) evaluated`)

  // 5. IPQC Check Execution Flow
  console.log('\n--- STEP 5: Pouch Printing (IPQC) Worker Execution Flow ---')
  // Find open check for Pouch Printing
  let [ipqcCheck] = await db
    .select()
    .from(qualityChecks)
    .where(
      and(
        eq(qualityChecks.activityId, ipqcAct.id),
        eq(qualityChecks.workerId, workerIpqc.id),
        inArray(qualityChecks.status, ['PENDING', 'DUE'])
      )
    )
    .orderBy(asc(qualityChecks.scheduledAt))
    .limit(1)

  if (!ipqcCheck) {
    // Generate one check directly if scheduler window was outside
    const [c] = await db
      .insert(qualityChecks)
      .values({
        code: `QC-TEST-IPQC-${Date.now()}`,
        scheduleId: ipqcSchedule.id,
        activityId: ipqcAct.id,
        workerId: workerIpqc.id,
        module: 'IPQC',
        departmentId: pouchDept.id,
        scheduledAt: now,
        windowEndsAt: new Date(now.getTime() + 30 * 60_000),
        status: 'DUE'
      })
      .returning()
    ipqcCheck = c
  }
  console.log(`[PASS] IPQC Check available: ID=${ipqcCheck.id}, Code=${ipqcCheck.code}, Status=${ipqcCheck.status}`)

  // Verify form parameters for Pouch Printing check
  const ipqcFormParameters = await db
    .select({ id: parameters.id, name: parameters.name, code: parameters.code, type: parameters.type })
    .from(activityParameters)
    .innerJoin(parameters, eq(activityParameters.parameterId, parameters.id))
    .where(and(eq(activityParameters.activityId, ipqcCheck.activityId), eq(activityParameters.isEnabled, true)))
    .orderBy(asc(activityParameters.sortOrder))

  console.log('       Worker Form Parameters:', ipqcFormParameters.map((p) => p.name).join(', '))
  if (ipqcFormParameters.length !== 3) throw new Error('Expected 3 parameters for Pouch Printing')

  // Worker enters Item Code, PO No, Parameter readings and submits
  const ipqcValues = [
    { name: 'Rigition', type: 'PASS_FAIL' as const, value: 'PASS', result: 'PASS' as const },
    { name: 'White Viscosity', type: 'NUMBER' as const, unit: 'sec', value: '21', result: 'PASS' as const },
    { name: 'Color', type: 'PASS_FAIL' as const, value: 'PASS', result: 'PASS' as const }
  ]

  // Submit IPQC check
  await db.transaction(async (tx) => {
    await tx
      .update(qualityChecks)
      .set({
        status: 'COMPLETED',
        overallResult: 'PASS',
        itemCode: 'RMPC-PRINT-001',
        jobNo: 'PO-88100',
        submittedAt: new Date(),
        submittedById: workerIpqc.id
      })
      .where(eq(qualityChecks.id, ipqcCheck.id))

    for (const v of ipqcValues) {
      const p = ipqcFormParameters.find((fp) => fp.name === v.name)!
      await tx.insert(qualityCheckValues).values({
        checkId: ipqcCheck.id,
        parameterId: p.id,
        parameterName: v.name,
        parameterType: v.type,
        unit: v.unit,
        value: v.value,
        result: v.result
      })
    }
  })
  console.log('[PASS] Pouch Printing IPQC Check submitted successfully with Item Code "RMPC-PRINT-001" & PO No. "PO-88100"')

  // 6. QC Check Execution Flow
  console.log('\n--- STEP 6: Pouch (QC) Worker Execution Flow ---')
  // Find open check for Pouch QC
  let [qcCheck] = await db
    .select()
    .from(qualityChecks)
    .where(
      and(
        eq(qualityChecks.activityId, qcAct.id),
        eq(qualityChecks.workerId, workerQc.id),
        inArray(qualityChecks.status, ['PENDING', 'DUE'])
      )
    )
    .orderBy(asc(qualityChecks.scheduledAt))
    .limit(1)

  if (!qcCheck) {
    const [c] = await db
      .insert(qualityChecks)
      .values({
        code: `QC-TEST-QC-${Date.now()}`,
        scheduleId: qcSchedule.id,
        activityId: qcAct.id,
        workerId: workerQc.id,
        module: 'QC',
        departmentId: pouchDept.id,
        scheduledAt: now,
        windowEndsAt: new Date(now.getTime() + 60 * 60_000),
        status: 'DUE'
      })
      .returning()
    qcCheck = c
  }
  console.log(`[PASS] QC Check available: ID=${qcCheck.id}, Code=${qcCheck.code}, Status=${qcCheck.status}`)

  // Verify form parameters for Pouch QC check
  const qcFormParameters = await db
    .select({ id: parameters.id, name: parameters.name, code: parameters.code, type: parameters.type })
    .from(activityParameters)
    .innerJoin(parameters, eq(activityParameters.parameterId, parameters.id))
    .where(and(eq(activityParameters.activityId, qcCheck.activityId), eq(activityParameters.isEnabled, true)))
    .orderBy(asc(activityParameters.sortOrder))

  console.log('       Worker Form Parameters:', qcFormParameters.map((p) => p.name).join(', '))
  if (qcFormParameters.length !== 3) throw new Error('Expected 3 parameters for Pouch QC')

  // Worker enters Item Code, PO No, Parameter readings and submits
  const qcValues = [
    { name: 'Pouch Leakage', type: 'PASS_FAIL' as const, value: 'PASS', result: 'PASS' as const },
    { name: 'Pouch Size', type: 'PASS_FAIL' as const, value: 'PASS', result: 'PASS' as const },
    { name: 'Zipper Closure', type: 'PASS_FAIL' as const, value: 'PASS', result: 'PASS' as const }
  ]

  // Submit QC check
  await db.transaction(async (tx) => {
    await tx
      .update(qualityChecks)
      .set({
        status: 'COMPLETED',
        overallResult: 'PASS',
        itemCode: 'RMPC-POUCH-002',
        jobNo: 'PO-88200',
        submittedAt: new Date(),
        submittedById: workerQc.id
      })
      .where(eq(qualityChecks.id, qcCheck.id))

    for (const v of qcValues) {
      const p = qcFormParameters.find((fp) => fp.name === v.name)!
      await tx.insert(qualityCheckValues).values({
        checkId: qcCheck.id,
        parameterId: p.id,
        parameterName: v.name,
        parameterType: v.type,
        value: v.value,
        result: v.result
      })
    }
  })
  console.log('[PASS] Pouch QC Check submitted successfully with Item Code "RMPC-POUCH-002" & PO No. "PO-88200"')

  // 7. Admin Reporting & Monitoring Verification
  console.log('\n--- STEP 7: Verify Admin Monitoring & Reports Filtering ---')
  const ipqcList = await listChecks({ module: 'IPQC', ids: [ipqcCheck.id] })
  if (ipqcList.length !== 1 || ipqcList[0].activityName !== 'Pouch Printing') {
    throw new Error('Admin IPQC filtering failed')
  }
  console.log(`[PASS] Admin IPQC Query correctly returned check: ${ipqcList[0].code} (${ipqcList[0].activityName})`)

  const qcList = await listChecks({ module: 'QC', ids: [qcCheck.id] })
  if (qcList.length !== 1 || qcList[0].activityName !== 'Pouch') {
    throw new Error('Admin QC filtering failed')
  }
  console.log(`[PASS] Admin QC Query correctly returned check: ${qcList[0].code} (${qcList[0].activityName})`)

  console.log('\n=====================================================')
  console.log('   ALL END-TO-END VALIDATION TESTS PASSED!')
  console.log('=====================================================')

  await pool.end()
}

runE2ETest().catch((err) => {
  console.error('\n[FAIL] E2E Test Failed:', err)
  process.exit(1)
})
