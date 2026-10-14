/**
 * A worker's shift change moves their Check Schedules (npm run test:shift-sync).
 * Uses two real workers of the test copy: Ankit (moved from his shift to "shift D") and Hiren
 * (must stay untouched). Refuses to run unless DATABASE_URL names a database ending in "_test".
 *
 *   1. Copy the live database into pouchwale_quality_test.
 *   2. DATABASE_URL=.../pouchwale_quality_test PUSH_DISABLED=1 ADMIN_PORT=0 PORT=4191 npm start
 *   3. DATABASE_URL=.../pouchwale_quality_test npm run test:shift-sync
 *   4. Drop the copy.
 */
import { and, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm'
import { db, pool } from '../src/db/client'
import { auditLogs, qualityChecks, rolePermissions, schedules, shifts, users } from '../src/db/schema'
import { signTokens } from '../src/lib/auth'
import { planChecks } from '../src/services/checkGenerator'

const dbName = new URL(process.env.DATABASE_URL ?? 'postgres://localhost/none').pathname.slice(1)
if (!dbName.endsWith('_test')) {
  console.error('Refusing to run: DATABASE_URL must name a test database (ending in _test).')
  process.exit(2)
}
const BASE = `${process.env.RBAC_API ?? 'http://localhost:4191'}/api`

let passed = 0
let failed = 0
const results: string[] = []
function check(name: string, ok: boolean, detail = '') {
  if (ok) passed++
  else failed++
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}
async function tokenFor(id: string) {
  const [u] = await db.select().from(users).where(eq(users.id, id))
  return signTokens(u, 'web').accessToken
}
async function call(token: string, method: string, p: string, body?: unknown) {
  const res = await fetch(BASE + p, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = text
  }
  return { status: res.status, json }
}

const byName = async (name: string) => (await db.select().from(users).where(eq(users.name, name)))[0]
const shiftNamed = async (name: string) => (await db.select().from(shifts).where(eq(shifts.name, name)))[0]
const schedulesOf = (workerId: string) => db.select().from(schedules).where(eq(schedules.workerId, workerId))
const checksOf = (workerId: string) => db.select().from(qualityChecks).where(eq(qualityChecks.workerId, workerId))
const strip = (rows: Record<string, unknown>[]) => JSON.stringify(rows.map((r) => ({ ...r })).sort((a, b) => String(a.id).localeCompare(String(b.id))))

const [sa] = await db.select().from(users).where(eq(users.role, 'SUPER_ADMIN'))
const [mgr] = await db.select().from(users).where(eq(users.role, 'MANAGER'))
const SA = await tokenFor(sa.id)
const MGR = await tokenFor(mgr.id)
const ankit = await byName('Ankit')
const hiren = await byName('Hiren')
const shiftD = await shiftNamed('shift D')
const oldShiftId = ankit.shiftId

const ankitSchedulesBefore = await schedulesOf(ankit.id)
const hirenSchedulesBefore = await schedulesOf(hiren.id)
const ankitChecksBefore = await checksOf(ankit.id)
const hirenChecksBefore = await checksOf(hiren.id)
const futurePending = ankitChecksBefore.filter((c) => c.status === 'PENDING' && c.scheduledAt > new Date())
const kept = ankitChecksBefore.filter((c) => !(c.status === 'PENDING' && c.scheduledAt > new Date()))
const versionBefore = (await call(SA, 'GET', '/schedules/version')).json.version
const startedAt = new Date()

// ---- 1. Change the shift: the schedules follow, in the same save
const put = await call(SA, 'PUT', `/users/${ankit.id}`, { shiftId: shiftD.id })
const ankitSchedulesAfter = await schedulesOf(ankit.id)
check(
  '1a Super Admin changes Ankit’s shift: saved, response says how many schedules moved',
  put.status === 200 && put.json.shiftId === shiftD.id && put.json.scheduleSync?.schedules === ankitSchedulesBefore.length && ankitSchedulesBefore.length > 0,
  JSON.stringify(put.json?.scheduleSync ?? put.json)
)
check(
  '1b every Ankit schedule now on shift D with its times',
  ankitSchedulesAfter.every((s) => s.shiftId === shiftD.id && s.startTime === shiftD.startTime && s.endTime === shiftD.endTime)
)
const sameOtherwise = ankitSchedulesBefore.every((b) => {
  const a = ankitSchedulesAfter.find((x) => x.id === b.id)
  return (
    a &&
    a.workerId === b.workerId &&
    a.machineId === b.machineId &&
    a.activityId === b.activityId &&
    a.departmentId === b.departmentId &&
    a.module === b.module &&
    a.intervalMinutes === b.intervalMinutes &&
    a.mode === b.mode &&
    a.isActive === b.isActive
  )
})
check('1c same schedule records (ids), worker, machine, check type, department, interval, mode and active state kept', sameOtherwise && ankitSchedulesAfter.length === ankitSchedulesBefore.length)
const audited = await db
  .select()
  .from(auditLogs)
  .where(and(eq(auditLogs.action, 'SYNC_WORKER_SCHEDULES'), eq(auditLogs.entityId, ankit.id), gte(auditLogs.createdAt, startedAt)))
check('1d recorded once in the audit log, with the new shift', audited.length === 1 && (audited[0].newValue as any)?.shift === 'shift D')

// ---- 2 / 6. What the Check Schedules page sees: a new version, then the new shift, for every viewer
{
  const v1 = (await call(SA, 'GET', '/schedules/version')).json.version
  const v2 = (await call(MGR, 'GET', '/schedules/version')).json.version
  const listSA = (await call(SA, 'GET', '/schedules')).json as any[]
  const listMgr = (await call(MGR, 'GET', '/schedules')).json as any[]
  const row = (list: any[]) => list.find((s) => s.workerId === ankit.id)
  check('2 the version the page polls changed, so open pages reload the list', v1 !== versionBefore && v1 === v2, `${versionBefore} -> ${v1}`)
  check('6 two viewers (Super Admin and a Manager) both get the new shift', row(listSA)?.shiftName === 'shift D' && row(listMgr)?.shiftName === 'shift D')
}

// ---- 3. Other workers untouched
{
  const hirenSchedulesAfter = await schedulesOf(hiren.id)
  const hirenChecksAfter = await checksOf(hiren.id)
  check('3 Hiren’s schedules and checks are exactly as before', strip(hirenSchedulesAfter) === strip(hirenSchedulesBefore) && strip(hirenChecksAfter) === strip(hirenChecksBefore))
}

// ---- 4. History kept; only upcoming checks nobody was asked to do yet are replaced
{
  const after = await checksOf(ankit.id)
  const stillThere = kept.every((k) => after.some((a) => a.id === k.id && a.status === k.status && String(a.submittedAt) === String(k.submittedAt) && a.shiftId === k.shiftId))
  check(
    '4 completed / missed / due checks of Ankit kept unchanged (old shift recorded on them); upcoming PENDING ones removed',
    stillThere && futurePending.length > 0 && futurePending.every((f) => !after.some((a) => a.id === f.id)),
    `${kept.length} kept, ${futurePending.length} upcoming removed`
  )
}

// ---- 5. No duplicates; the next check comes from the new shift
{
  const counts = await db
    .select({ scheduleId: qualityChecks.scheduleId, n: sql<number>`count(*)::int` })
    .from(qualityChecks)
    // Checks of a schedule (test checks made without one are not a schedule's).
    .where(and(inArray(qualityChecks.status, ['PENDING', 'DUE', 'IN_PROGRESS']), isNotNull(qualityChecks.scheduleId)))
    .groupBy(qualityChecks.scheduleId)
  check('5a no schedule has more than one open check; schedule count unchanged', counts.every((c) => c.n <= 1) && (await schedulesOf(ankit.id)).length === ankitSchedulesBefore.length)
  const plan = await planChecks(new Date())
  const next = plan.filter((p) => ankitSchedulesAfter.some((s) => s.id === p.scheduleId))
  const inWindow = next.every((p) => {
    const t = new Date(p.scheduledAt as Date)
    const minutes = (Number(t.toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false })) % 24) * 60
    return p.shiftId === shiftD.id && minutes >= 14 * 60 && minutes < 22 * 60
  })
  check('5b the next planned check of Ankit is on shift D, inside 14:00–22:00', next.length >= 1 && inWindow, next.map((p) => `${(p.scheduledAt as Date).toISOString()}`).join(', '))

  // Changing to the same shift again does nothing.
  const again = await call(SA, 'PUT', `/users/${ankit.id}`, { shiftId: shiftD.id })
  check('5c saving the same shift again changes no schedule', again.status === 200 && again.json.scheduleSync?.schedules === 0)

  // Two active schedules of the worker for the same check type and machine would become duplicates: refused, nothing saved.
  const [orig] = ankitSchedulesAfter
  const [extra] = await db
    .insert(schedules)
    .values({ ...orig, id: undefined, shiftId: oldShiftId, createdAt: undefined, updatedAt: undefined } as any)
    .returning()
  const conflictPut = await call(SA, 'PUT', `/users/${ankit.id}`, { shiftId: oldShiftId })
  const [ankitNow] = await db.select().from(users).where(eq(users.id, ankit.id))
  const untouched = await schedulesOf(ankit.id)
  check(
    '5d a change that would create duplicate schedules is refused (409) and nothing is saved',
    conflictPut.status === 409 && ankitNow.shiftId === shiftD.id && untouched.find((s) => s.id === orig.id)?.shiftId === shiftD.id,
    `${conflictPut.status} ${conflictPut.json?.error ?? ''}`
  )
  // The test's own extra schedule (and any check the server's scheduler made for it meanwhile).
  await db.delete(qualityChecks).where(eq(qualityChecks.scheduleId, extra.id))
  await db.delete(schedules).where(eq(schedules.id, extra.id))
}

// ---- 8. Permissions and validation
{
  const [workerUser] = await db.select().from(users).where(and(eq(users.role, 'WORKER'), eq(users.isActive, true)))
  const asWorker = await call(await tokenFor(workerUser.id), 'PUT', `/users/${ankit.id}`, { shiftId: oldShiftId })
  const managerRow = (await db.select().from(rolePermissions).where(and(eq(rolePermissions.role, 'MANAGER'), eq(rolePermissions.module, 'workers'))))[0]
  await call(SA, 'PUT', '/access/roles/MANAGER', { modules: { workers: { view: true, create: false, edit: false, delete: false } } })
  const asManager = await call(MGR, 'PUT', `/users/${ankit.id}`, { shiftId: oldShiftId })
  // put the Manager role back as it was
  await call(SA, 'PUT', '/access/roles/MANAGER', {
    modules: { workers: managerRow ? { view: managerRow.canView, create: managerRow.canCreate, edit: managerRow.canEdit, delete: managerRow.canDelete } : { view: false } }
  })
  const [ankitNow] = await db.select().from(users).where(eq(users.id, ankit.id))
  check('8a a Worker, and a Manager without Employee Management edit, cannot change the shift (403); nothing changed', asWorker.status === 403 && asManager.status === 403 && ankitNow.shiftId === shiftD.id, `${asWorker.status},${asManager.status}`)

  const [inactive] = await db.insert(shifts).values({ name: 'Test inactive', code: `TI${Date.now() % 100000}`, startTime: '01:00', endTime: '02:00', isActive: false }).returning()
  const bad = await call(SA, 'PUT', `/users/${ankit.id}`, { shiftId: inactive.id })
  const missing = await call(SA, 'PUT', `/users/${ankit.id}`, { shiftId: '00000000-0000-4000-8000-000000000000' })
  check('8b an inactive or unknown shift is refused (400) before anything is saved', bad.status === 400 && missing.status === 400, `${bad.status},${missing.status}`)
  await db.delete(shifts).where(eq(shifts.id, inactive.id))
}

// ---- back to the original shift: the schedules follow again
{
  const back = await call(SA, 'PUT', `/users/${ankit.id}`, { shiftId: oldShiftId })
  const rows = await schedulesOf(ankit.id)
  const [orig] = await db.select().from(shifts).where(eq(shifts.id, oldShiftId!))
  check('9 changing back moves the schedules back to the original shift and times', back.status === 200 && rows.every((s) => s.shiftId === oldShiftId && s.startTime === orig.startTime && s.endTime === orig.endTime))
}

console.log(results.join('\n'))
console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
await pool.end()
