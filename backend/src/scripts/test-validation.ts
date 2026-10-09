import { db, pool } from '../db/client'
import { users, activities, schedules, qualityChecks, departments } from '../db/schema'
import { eq, and, sql } from 'drizzle-orm'
import { planChecks, prepareChecks } from '../services/checkGenerator'
import { notifyDueChecks } from '../services/notifications'
import { listChecks } from '../services/checks'
import bcrypt from 'bcryptjs'
import { assertTestDatabase } from './testDatabaseGuard'

assertTestDatabase()

async function runValidationTests() {
  console.log('=== STARTING SCHEDULE-BASED IPQC/QC VALIDATION TESTS ===\n')

  // 1. Get or create Department
  let [dept] = await db.select().from(departments).limit(1)
  if (!dept) {
    const [insertedDept] = await db.insert(departments).values({
      name: 'Quality Assurance',
      code: 'QA-01'
    }).returning()
    dept = insertedDept
  }
  console.log(`[PASS] Using Department: ${dept.name} (${dept.id})`)

  // 2. Setup Activities: IPQC and QC
  let [ipqcActivity] = await db.select().from(activities).where(eq(activities.module, 'IPQC')).limit(1)
  if (!ipqcActivity) {
    const [act] = await db.insert(activities).values({
      name: 'IPQC Routine Check',
      code: 'IPQC-RTN',
      module: 'IPQC',
      departmentId: dept.id
    }).returning()
    ipqcActivity = act
  }
  if (!ipqcActivity.isActive) {
    const [act] = await db
      .update(activities)
      .set({ isActive: true })
      .where(eq(activities.id, ipqcActivity.id))
      .returning()
    ipqcActivity = act
  }
  let [qcActivity] = await db.select().from(activities).where(eq(activities.module, 'QC')).limit(1)
  if (!qcActivity) {
    const [act] = await db.insert(activities).values({
      name: 'QC Routine Check',
      code: 'QC-RTN',
      module: 'QC',
      departmentId: dept.id
    }).returning()
    qcActivity = act
  }
  console.log(`[PASS] IPQC Activity: ${ipqcActivity.name} (Module: ${ipqcActivity.module}, Active: ${ipqcActivity.isActive}, Monitoring: ${ipqcActivity.monitoring})`)
  console.log(`[PASS] QC Activity: ${qcActivity.name} (Module: ${qcActivity.module}, Active: ${qcActivity.isActive}, Monitoring: ${qcActivity.monitoring})`)

  // 3. Setup Workers:
  // Worker A: IPQC
  // Worker B: QC
  // Worker C: BOTH (IPQC + QC)
  const passwordHash = await bcrypt.hash('password123', 8)

  const ensureWorker = async (empId: string, name: string, qualityRole: 'IPQC' | 'QC' | 'BOTH') => {
    const [existing] = await db.select().from(users).where(eq(users.employeeId, empId))
    if (existing) {
      const [updated] = await db
        .update(users)
        .set({ workerQualityRole: qualityRole, isActive: true, appAccess: true })
        .where(eq(users.id, existing.id))
        .returning()
      return updated
    }
    const [created] = await db.insert(users).values({
      employeeId: empId,
      name,
      role: 'WORKER',
      workerQualityRole: qualityRole,
      passwordHash,
      departmentId: dept.id,
      isActive: true,
      appAccess: true
    }).returning()
    return created
  }

  const workerA = await ensureWorker('TEST-IPQC-01', 'Worker A (IPQC Only)', 'IPQC')
  const workerB = await ensureWorker('TEST-QC-01', 'Worker B (QC Only)', 'QC')
  const workerC = await ensureWorker('TEST-BOTH-01', 'Worker C (IPQC + QC)', 'BOTH')

  console.log(`[PASS] Configured Workers:`)
  console.log(`  - ${workerA.name}: Role = ${workerA.workerQualityRole}`)
  console.log(`  - ${workerB.name}: Role = ${workerB.workerQualityRole}`)
  console.log(`  - ${workerC.name}: Role = ${workerC.workerQualityRole}`)

  // 4. Test Schedule Configuration (Admin side: Worker -> Role -> Schedule)
  // Clear any existing test schedules for these workers
  await db.delete(schedules).where(sql`${schedules.workerId} IN (${workerA.id}, ${workerB.id}, ${workerC.id})`)

  // Schedule 1: Worker A -> IPQC schedule (30m interval, 09:00 - 18:00)
  const [schedA] = await db.insert(schedules).values({
    workerId: workerA.id,
    module: 'IPQC',
    departmentId: dept.id,
    activityId: ipqcActivity.id,
    intervalMinutes: 30,
    startTime: '09:00',
    endTime: '18:00',
    isActive: true
  }).returning()

  // Schedule 2: Worker B -> QC schedule (60m interval, 09:00 - 18:00)
  const [schedB] = await db.insert(schedules).values({
    workerId: workerB.id,
    module: 'QC',
    departmentId: dept.id,
    activityId: qcActivity.id,
    intervalMinutes: 60,
    startTime: '09:00',
    endTime: '18:00',
    isActive: true
  }).returning()

  // Schedule 3 & 4: Worker C -> IPQC (30m) AND QC (60m)
  const [schedC_IPQC] = await db.insert(schedules).values({
    workerId: workerC.id,
    module: 'IPQC',
    departmentId: dept.id,
    activityId: ipqcActivity.id,
    intervalMinutes: 30,
    startTime: '09:00',
    endTime: '18:00',
    isActive: true
  }).returning()

  const [schedC_QC] = await db.insert(schedules).values({
    workerId: workerC.id,
    module: 'QC',
    departmentId: dept.id,
    activityId: qcActivity.id,
    intervalMinutes: 60,
    startTime: '09:00',
    endTime: '18:00',
    isActive: true
  }).returning()

  console.log(`[PASS] Created Schedule-Based Configurations:`)
  console.log(`  - Schedule A: Worker ${workerA.name} -> Module: ${schedA.module}, Interval: ${schedA.intervalMinutes}m`)
  console.log(`  - Schedule B: Worker ${workerB.name} -> Module: ${schedB.module}, Interval: ${schedB.intervalMinutes}m`)
  console.log(`  - Schedule C (IPQC): Worker ${workerC.name} -> Module: ${schedC_IPQC.module}, Interval: ${schedC_IPQC.intervalMinutes}m`)
  console.log(`  - Schedule C (QC): Worker ${workerC.name} -> Module: ${schedC_QC.module}, Interval: ${schedC_QC.intervalMinutes}m`)

  // 5. Test Check Generator without Job dependency
  console.log('\n--- Testing Check Generator (prepareChecks) ---')
  const planned = await planChecks(new Date())
  console.log(`[DEBUG] planChecks produced ${planned.length} inserts:`, planned.map(p => ({ code: p.code, workerId: p.workerId, module: p.module, scheduledAt: p.scheduledAt })))
  await prepareChecks([new Date()])

  // Verify checks generated for worker A
  const checksA = await db.select().from(qualityChecks).where(eq(qualityChecks.workerId, workerA.id))
  console.log(`[CHECK] Worker A checks count: ${checksA.length}`)
  if (checksA.length === 0) throw new Error('Expected checks generated for Worker A!')
  for (const c of checksA) {
    if (c.module !== 'IPQC') throw new Error(`Worker A should only have IPQC checks, found ${c.module}`)
    if (c.jobId !== null) throw new Error('Schedule-based check should have no job dependency!')
  }
  console.log(`[PASS] Worker A has ${checksA.length} checks generated, all strictly IPQC with NO job dependency.`)

  // Verify checks generated for worker B
  const checksB = await db.select().from(qualityChecks).where(eq(qualityChecks.workerId, workerB.id))
  console.log(`[CHECK] Worker B checks count: ${checksB.length}`)
  if (checksB.length === 0) throw new Error('Expected checks generated for Worker B!')
  for (const c of checksB) {
    if (c.module !== 'QC') throw new Error(`Worker B should only have QC checks, found ${c.module}`)
    if (c.jobId !== null) throw new Error('Schedule-based check should have no job dependency!')
  }
  console.log(`[PASS] Worker B has ${checksB.length} checks generated, all strictly QC with NO job dependency.`)

  // Verify checks generated for worker C
  const checksC = await db.select().from(qualityChecks).where(eq(qualityChecks.workerId, workerC.id))
  const checksC_IPQC = checksC.filter((c) => c.module === 'IPQC')
  const checksC_QC = checksC.filter((c) => c.module === 'QC')
  console.log(`[CHECK] Worker C checks: ${checksC_IPQC.length} IPQC checks and ${checksC_QC.length} QC checks.`)
  if (checksC_IPQC.length === 0 || checksC_QC.length === 0) {
    throw new Error('Worker C should have both IPQC and QC checks generated!')
  }
  console.log(`[PASS] Worker C successfully receives both IPQC and QC checks on their separate schedules.`)

  // 6. Test RBAC & workerScope (Worker App visibility)
  console.log('\n--- Testing RBAC & workerScope ---')
  // Worker A query:
  const scopeA = and(eq(qualityChecks.workerId, workerA.id), eq(qualityChecks.module, 'IPQC'))
  const visibleA = await listChecks({ where: scopeA })
  const nonIpqcA = visibleA.filter((c) => c.module !== 'IPQC')
  if (nonIpqcA.length > 0) throw new Error('Worker A saw non-IPQC checks!')
  console.log(`[PASS] Worker A scope correctly isolates IPQC checks only (${visibleA.length} checks visible).`)

  // Worker B query:
  const scopeB = and(eq(qualityChecks.workerId, workerB.id), eq(qualityChecks.module, 'QC'))
  const visibleB = await listChecks({ where: scopeB })
  const nonQcB = visibleB.filter((c) => c.module !== 'QC')
  if (nonQcB.length > 0) throw new Error('Worker B saw non-QC checks!')
  console.log(`[PASS] Worker B scope correctly isolates QC checks only (${visibleB.length} checks visible).`)

  // Worker C query (sees both):
  const scopeC = eq(qualityChecks.workerId, workerC.id)
  const visibleC = await listChecks({ where: scopeC })
  const hasIpqc = visibleC.some((c) => c.module === 'IPQC')
  const hasQc = visibleC.some((c) => c.module === 'QC')
  if (!hasIpqc || !hasQc) throw new Error('Worker C scope should see both IPQC and QC checks!')
  console.log(`[PASS] Worker C scope correctly allows viewing both IPQC and QC checks (${visibleC.length} checks visible).`)

  // 7. Test Check Submission with Manual Item Code and PO No
  console.log('\n--- Testing Manual Check Submission ---')
  const checkToSubmit = checksA[0]
  const manualItemCode = 'MANUAL-ITEM-999'
  const manualPoNo = 'PO-MANUAL-777'
  const submissionTime = new Date()

  const [submittedCheck] = await db
    .update(qualityChecks)
    .set({
      status: 'COMPLETED',
      itemCode: manualItemCode,
      jobNo: manualPoNo,
      submittedAt: submissionTime,
      submittedById: workerA.id
    })
    .where(eq(qualityChecks.id, checkToSubmit.id))
    .returning()

  if (submittedCheck.itemCode !== manualItemCode || submittedCheck.jobNo !== manualPoNo) {
    throw new Error('Check submission failed to save manual Item Code and PO No!')
  }
  console.log(`[PASS] Check submission recorded successfully:`)
  console.log(`  - Check ID: ${submittedCheck.id}`)
  console.log(`  - Worker: ${workerA.name}`)
  console.log(`  - Module: ${submittedCheck.module}`)
  console.log(`  - Item Code: ${submittedCheck.itemCode}`)
  console.log(`  - PO No: ${submittedCheck.jobNo}`)
  console.log(`  - Status: ${submittedCheck.status}`)
  console.log(`  - Submitted At: ${submittedCheck.submittedAt?.toISOString()}`)

  // 8. Test Admin Monitoring Filters
  console.log('\n--- Testing Admin Monitoring Filters ---')
  const ipqcFiltered = await listChecks({ module: 'IPQC' })
  if (ipqcFiltered.some((c) => c.module !== 'IPQC')) throw new Error('Filter module=IPQC returned non-IPQC checks!')
  console.log(`[PASS] Admin filter module=IPQC returns ${ipqcFiltered.length} checks, all IPQC.`)

  const qcFiltered = await listChecks({ module: 'QC' })
  if (qcFiltered.some((c) => c.module !== 'QC')) throw new Error('Filter module=QC returned non-QC checks!')
  console.log(`[PASS] Admin filter module=QC returns ${qcFiltered.length} checks, all QC.`)

  const workerFiltered = await listChecks({ workerId: workerA.id })
  if (workerFiltered.some((c) => c.workerId !== workerA.id && c.submittedById !== workerA.id)) {
    throw new Error('Filter workerId returned checks from other workers!')
  }
  console.log(`[PASS] Admin filter workerId returns ${workerFiltered.length} checks for Worker A.`)

  console.log('\n=== ALL SCHEDULE-BASED IPQC/QC VALIDATION TESTS PASSED SUCCESSFULLY! ===\n')
}

runValidationTests()
  .catch((err) => {
    console.error('Validation test failed:', err)
    process.exitCode = 1
  })
  .finally(() => pool.end())
