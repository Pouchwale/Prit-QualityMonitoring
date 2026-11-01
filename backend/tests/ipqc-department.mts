/**
 * The IPQC (Print) department (npm run test:ipqc-department): one IPQC department that covers Pouch,
 * Label and Sleeve. Refuses to run unless DATABASE_URL names a database ending in "_test".
 *
 *   1. Copy the live database into pouchwale_quality_test; start a server on it (PORT=4191).
 *   2. DATABASE_URL=.../pouchwale_quality_test npm run test:ipqc-department
 *   3. Drop the copy.
 */
import { and, eq, ilike, inArray } from 'drizzle-orm'
import { db, pool } from '../src/db/client'
import { activities, departments, machineActivities, machines, users } from '../src/db/schema'
import { signTokens } from '../src/lib/auth'
import { checkTypeInScope, userDepartmentScope } from '../src/services/checkTypeScope'

const dbName = new URL(process.env.DATABASE_URL ?? 'postgres://localhost/none').pathname.slice(1)
if (!dbName.endsWith('_test')) {
  console.error('Refusing to run: DATABASE_URL must name a test database (ending in _test).')
  process.exit(2)
}
const BASE = `${process.env.RBAC_API ?? 'http://localhost:4191'}/api`
let passed = 0
let failed = 0
const results: string[] = []
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) passed++
  else failed++
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}
const [sa] = await db.select().from(users).where(eq(users.role, 'SUPER_ADMIN'))
const SA = signTokens(sa, 'web').accessToken
const call = async (token: string, method: string, p: string, body?: unknown) => {
  const r = await fetch(BASE + p, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  return { status: r.status, json: (await r.json().catch(() => null)) as any }
}

const all = await db.select().from(departments)
const byCode = (c: string) => all.find((d) => d.code.toLowerCase() === c)
const ipqc = byCode('ipqc-print')
const pouch = byCode('pouch')!
const label = byCode('label')!
const sleeve = byCode('sleeve')!

// ---- 1. The department
check(
  '1a migration: one department "IPQC (Print)" covering Pouch, Label and Sleeve; the three are unchanged',
  !!ipqc && ipqc.name === 'IPQC (Print)' && ipqc.isActive && [pouch.id, label.id, sleeve.id].every((id) => ipqc.coversDepartmentIds.includes(id)) && all.filter((d) => d.name.startsWith('IPQC')).length === 1 && [pouch, label, sleeve].every((d) => d.isActive),
  ipqc ? `covers ${ipqc.coversDepartmentIds.length}` : 'missing'
)
const ipqcPeople = await db.select().from(users).where(and(inArray(users.role, ['WORKER', 'MANAGER']), eq(users.workerQualityRole, 'IPQC'), eq(users.isActive, true)))
const qcPeople = await db.select().from(users).where(and(eq(users.role, 'WORKER'), eq(users.workerQualityRole, 'QC'), eq(users.isActive, true)))
check(
  '1b IPQC workers and managers that were in Pouch are in IPQC (Print); QC workers keep their department',
  ipqcPeople.every((u) => u.departmentId !== pouch.id) && ipqcPeople.some((u) => u.departmentId === ipqc!.id) && qcPeople.every((u) => u.departmentId !== ipqc!.id),
  ipqcPeople.map((u) => `${u.name}: ${all.find((d) => d.id === u.departmentId)?.name ?? '—'}`).join(', ')
)

// ---- 2. Its IPQC workers do the IPQC checks of Pouch, Label and Sleeve
const [worker] = ipqcPeople.filter((u) => u.role === 'WORKER' && u.departmentId === ipqc!.id)
const scope = await userDepartmentScope(worker.id)
check('2a the scope of an IPQC (Print) worker: their department and Pouch, Label, Sleeve', scope.id === ipqc!.id && [pouch.id, label.id, sleeve.id].every((id) => checkTypeInScope(id, scope)), `${scope.covers.length} covered`)
const [qcWorker] = qcPeople
const qcScope = await userDepartmentScope(qcWorker.id)
check('2b a QC worker in Pouch is not widened: Label is still another department', checkTypeInScope(pouch.id, qcScope) && !checkTypeInScope(label.id, qcScope))

// The Printing check type (IPQC, in Pouch) on the worker's machine screen, and started by hand.
const [printing] = await db.select().from(activities).where(ilike(activities.name, 'printing'))
const W = signTokens(worker, 'mobile').accessToken
const machinesRes = await call(W, 'GET', '/worker/machines')
const list = (machinesRes.json?.machines ?? machinesRes.json ?? []) as any[]
const withPrinting = list.find((m) => (m.checkTypes ?? []).some((c: any) => c.activityId === printing.id || c.id === printing.id))
check('2c the worker app shows the Printing check (a Pouch IPQC check) to the IPQC (Print) worker', machinesRes.status === 200 && !!withPrinting, `${machinesRes.status}, ${list.length} machines`)
if (withPrinting) {
  const started = await call(W, 'POST', `/worker/machines/${withPrinting.id}/checks`, { activityId: printing.id })
  check('2d …and lets them start it by hand (not refused as "another department")', started.status === 200 || started.status === 201 || (started.status !== 403 && !/another department/.test(started.json?.error ?? '')), `${started.status} ${started.json?.error ?? ''}`)
}

// ---- 3. Covers is editable on the Departments page
{
  const list1 = await call(SA, 'GET', '/departments')
  const row = (list1.json as any[]).find((d) => d.id === ipqc!.id)
  const edit = await call(SA, 'PUT', `/departments/${ipqc!.id}`, { name: ipqc!.name, code: ipqc!.code, isActive: true, coversDepartmentIds: [pouch.id, ipqc!.id] })
  const [after] = await db.select().from(departments).where(eq(departments.id, ipqc!.id))
  const keep = await call(SA, 'PUT', `/departments/${ipqc!.id}`, { name: ipqc!.name, code: ipqc!.code, isActive: true })
  const [kept] = await db.select().from(departments).where(eq(departments.id, ipqc!.id))
  await call(SA, 'PUT', `/departments/${ipqc!.id}`, { name: ipqc!.name, code: ipqc!.code, isActive: true, coversDepartmentIds: [pouch.id, label.id, sleeve.id] })
  check(
    '3 the list shows what each department covers; editing it saves (never itself); saving without it keeps it',
    row?.coversDepartmentIds?.length === 3 && edit.status === 200 && after.coversDepartmentIds.length === 1 && after.coversDepartmentIds[0] === pouch.id && keep.status === 200 && kept.coversDepartmentIds.length === 1,
    `${edit.status} ${JSON.stringify(after.coversDepartmentIds.length)} ${keep.status}`
  )
}

console.log(results.join('\n'))
console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
await pool.end()
