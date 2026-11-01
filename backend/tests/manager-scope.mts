/**
 * Department-wise access for Managers (npm run test:manager-scope): an IPQC (Print) Manager sees only
 * IPQC workers and IPQC work; a QC (Pouch / Label / Sleeve) Manager only the QC workers and QC work of
 * that department; a Manager with no department nothing; the Super Admin everything.
 * Refuses to run unless DATABASE_URL names a database ending in "_test".
 *
 *   1. Copy the live database into pouchwale_quality_test; start a server on it (PORT=4191).
 *   2. DATABASE_URL=.../pouchwale_quality_test npm run test:manager-scope
 *   3. Drop the copy.
 */
import { and, eq, inArray } from 'drizzle-orm'
import { db, pool } from '../src/db/client'
import { departments, schedules, users } from '../src/db/schema'
import { signTokens } from '../src/lib/auth'

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
const tokenFor = async (id: string) => {
  const [u] = await db.select().from(users).where(eq(users.id, id))
  return signTokens(u, 'web').accessToken
}
const call = async (token: string, method: string, p: string, body?: unknown) => {
  const r = await fetch(BASE + p, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  return { status: r.status, json: (await r.json().catch(() => null)) as any }
}

const all = await db.select().from(departments)
const dept = (code: string) => all.find((d) => d.code.toLowerCase() === code)!
const IPQC = dept('ipqc-print')
const POUCH = dept('pouch')
const LABEL = dept('label')
const [sa] = await db.select().from(users).where(eq(users.role, 'SUPER_ADMIN'))
const SA = await tokenFor(sa.id)

// ---- Setup: Managers of each area, a Manager with no department, and a QC Label worker
const stamp = Date.now() % 100000
const makeUser = async (body: Record<string, unknown>) => {
  const r = await call(SA, 'POST', '/users', { password: 'secret12', ...body })
  if (r.status !== 201) throw new Error(`create user: ${r.status} ${JSON.stringify(r.json)}`)
  return r.json.id as string
}
const mIpqc = await makeUser({ employeeId: `MI${stamp}`, name: 'Test IPQC Manager', role: 'MANAGER', workerQualityRole: 'IPQC', departmentId: IPQC.id })
const mPouch = await makeUser({ employeeId: `MP${stamp}`, name: 'Test QC Pouch Manager', role: 'MANAGER', workerQualityRole: 'QC', departmentId: POUCH.id })
const mLabel = await makeUser({ employeeId: `ML${stamp}`, name: 'Test QC Label Manager', role: 'MANAGER', workerQualityRole: 'QC', departmentId: LABEL.id })
const mNone = await makeUser({ employeeId: `MN${stamp}`, name: 'Test Manager No Dept', role: 'MANAGER', workerQualityRole: 'QC' })
const labelWorker = await makeUser({ employeeId: `WL${stamp}`, name: 'Test Label Worker', role: 'WORKER', workerQualityRole: 'QC', departmentId: LABEL.id })
const [I, P, L, N] = await Promise.all([mIpqc, mPouch, mLabel, mNone].map(tokenFor))

const workers = await db.select().from(users).where(and(eq(users.role, 'WORKER'), eq(users.isActive, true)))
const ipqcWorkers = workers.filter((w) => w.workerQualityRole === 'IPQC' && w.departmentId === IPQC.id).map((w) => w.id)
const pouchQc = workers.filter((w) => w.workerQualityRole === 'QC' && w.departmentId === POUCH.id).map((w) => w.id)
const names = (rows: any[]) => rows.map((r) => r.name).sort().join(', ')
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x))

// ---- 1. Workers & Users
{
  const [ui, up, ul, un, us] = await Promise.all([I, P, L, N, SA].map((t) => call(t, 'GET', '/users')))
  check('1a IPQC (Print) Manager: only the IPQC workers', sameSet(ui.json.map((u: any) => u.id), ipqcWorkers), names(ui.json))
  check('1b QC (Pouch) Manager: only the QC workers of Pouch', sameSet(up.json.map((u: any) => u.id), pouchQc), names(up.json))
  check('1c QC (Label) Manager: only the QC workers of Label', sameSet(ul.json.map((u: any) => u.id), [labelWorker]), names(ul.json))
  check('1d a Manager with no department: nobody', un.status === 200 && un.json.length === 0, `${un.json?.length}`)
  check('1e the Super Admin: every account', us.json.length >= workers.length + 4, `${us.json.length}`)
  const editOther = await call(P, 'PUT', `/users/${ipqcWorkers[0]}`, { phone: '123' })
  const editMine = await call(P, 'PUT', `/users/${pouchQc[0]}`, { phone: '9999999' })
  const moveOut = await call(P, 'PUT', `/users/${pouchQc[0]}`, { departmentId: LABEL.id })
  check('1f a QC (Pouch) Manager edits their own worker, not an IPQC worker (403), and cannot move theirs to Label (403)', editOther.status === 403 && editMine.status === 200 && moveOut.status === 403, `${editOther.status},${editMine.status},${moveOut.status}`)
}

// ---- 2. Quality checks, exceptions, dashboard
const from = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10)
const to = new Date().toISOString().slice(0, 10)
{
  const q = `/quality-checks?from=${from}&to=${to}`
  const [ci, cp, cl, cn, cs] = await Promise.all([I, P, L, N, SA].map((t) => call(t, 'GET', q)))
  const mods = (rows: any[]) => [...new Set(rows.map((r) => r.module))].join(',')
  check('2a IPQC Manager: IPQC checks only', ci.status === 200 && ci.json.length > 0 && ci.json.every((c: any) => c.module === 'IPQC'), `${ci.json?.length} ${mods(ci.json ?? [])}`)
  check('2b QC (Pouch) Manager: QC checks of Pouch only', cp.status === 200 && cp.json.length > 0 && cp.json.every((c: any) => c.module === 'QC' && c.departmentId === POUCH.id), `${cp.json?.length} ${mods(cp.json ?? [])}`)
  check('2c QC (Label) Manager: no Pouch or IPQC checks', cl.json.every((c: any) => c.module === 'QC' && c.departmentId === LABEL.id), `${cl.json?.length}`)
  check('2d no department: no checks; the Super Admin: at least all of theirs together', cn.json.length === 0 && cs.json.length >= ci.json.length + cp.json.length + cl.json.length, `${cn.json.length}; ${cs.json.length}`)
  const otherCheck = cp.json[0]
  const detail = await call(I, 'GET', `/quality-checks/${otherCheck.id}`)
  check('2e an IPQC Manager cannot open a QC check (not found)', detail.status === 404, `${detail.status}`)
  const [di, dp, ds] = await Promise.all([I, P, SA].map((t) => call(t, 'GET', `/dashboard?from=${from}&to=${to}`)))
  check('2f dashboard counts: each Manager only their own checks', di.json.kpi.scheduled === ci.json.length && dp.json.kpi.scheduled === cp.json.length && ds.json.kpi.scheduled >= di.json.kpi.scheduled + dp.json.kpi.scheduled, `${di.json.kpi.scheduled} + ${dp.json.kpi.scheduled} ≤ ${ds.json.kpi.scheduled}`)
  const [ei, ep] = await Promise.all([I, P].map((t) => call(t, 'GET', `/exceptions?from=${from}&to=${to}`)))
  const exIds = (r: any) => r.json.map((e: any) => e.checkId)
  check('2g exceptions: each Manager only their own', exIds(ei).every((id: string) => ci.json.some((c: any) => c.id === id)) && exIds(ep).every((id: string) => cp.json.some((c: any) => c.id === id)), `${ei.json.length}, ${ep.json.length}`)
}

// ---- 3. Worker Performance
{
  const [pi, pp] = await Promise.all([I, P].map((t) => call(t, 'GET', `/performance/workers?from=${from}&to=${to}`)))
  check('3a performance: the IPQC Manager sees IPQC workers only, the QC (Pouch) Manager Pouch QC workers only', pi.json.workers.every((w: any) => ipqcWorkers.includes(w.workerId)) && pp.json.workers.every((w: any) => pouchQc.includes(w.workerId)) && pi.json.workers.length > 0, `${pi.json.workers.length}, ${pp.json.workers.length}`)
  const other = await call(P, 'GET', `/performance/workers/${ipqcWorkers[0]}?from=${from}&to=${to}`)
  const [wk, ov] = await Promise.all([call(P, 'GET', '/performance/weekly'), call(P, 'GET', '/performance/overall')])
  check('3b another department\'s worker: refused (403); weekly and overall scores list their workers only', other.status === 403 && wk.json.rows.every((r: any) => pouchQc.includes(r.workerId)) && ov.json.rows.every((r: any) => pouchQc.includes(r.workerId)), `${other.status}`)
  const fv = await call(P, 'GET', '/performance/filter-values')
  check('3c filter lists: their workers and departments only', fv.json.workers.every((w: any) => pouchQc.includes(w.id)) && fv.json.departments.every((d: any) => d.id === POUCH.id), `${fv.json.workers.length} workers, ${fv.json.departments.length} departments`)
}

// ---- 4. Schedules
{
  const [si, sp] = await Promise.all([I, P].map((t) => call(t, 'GET', '/schedules')))
  check('4a schedules: the IPQC Manager sees IPQC schedules, the QC (Pouch) Manager Pouch QC schedules', si.json.every((s: any) => s.module === 'IPQC') && sp.json.every((s: any) => s.module === 'QC' && (!s.workerId || pouchQc.includes(s.workerId))), `${si.json.length}, ${sp.json.length}`)
  const [ipqcSchedule] = await db.select().from(schedules).where(and(eq(schedules.module, 'IPQC'), inArray(schedules.workerId, ipqcWorkers)))
  if (ipqcSchedule) {
    const del = await call(P, 'DELETE', `/schedules/${ipqcSchedule.id}`)
    const still = await db.select().from(schedules).where(eq(schedules.id, ipqcSchedule.id))
    check('4b a QC Manager cannot delete an IPQC schedule (403)', del.status === 403 && still.length === 1, `${del.status}`)
  }
}

// ---- 5. Leave
{
  const [ajay] = workers.filter((w) => ipqcWorkers.includes(w.id))
  const W = signTokens(ajay, 'mobile').accessToken
  const types = (await call(SA, 'GET', '/leave/types')).json as any[]
  const cl = types.find((t) => t.code === 'CL')
  const days = await (await import('../src/services/plantCalendar')).dayStates(new Date(Date.now() + 60 * 86400_000), new Date(Date.now() + 75 * 86400_000))
  const day = days.find((d) => !d.closed)!.date
  const f = new FormData()
  for (const [k, v] of Object.entries({ leaveTypeId: cl.id, dayPart: 'FULL', startDate: day, endDate: day, reason: 'Scope test' })) f.append(k, v)
  const applied = (await (await fetch(`${BASE}/worker/leave/requests`, { method: 'POST', headers: { Authorization: `Bearer ${W}` }, body: f })).json()) as any
  const [li, lp] = await Promise.all([I, P].map((t) => call(t, 'GET', '/leave/requests?status=PENDING')))
  const [ci, cp] = await Promise.all([I, P].map((t) => call(t, 'GET', '/leave/pending-count')))
  check('5a an IPQC worker\'s leave: in the IPQC Manager\'s Approvals and badge, not the QC (Pouch) Manager\'s', li.json.some((r: any) => r.id === applied.id) && !lp.json.some((r: any) => r.id === applied.id) && ci.json.leave >= 1 && cp.json.leave === lp.json.length, `${applied.id ? 'applied' : JSON.stringify(applied)}; ${ci.json.leave} / ${cp.json.leave}`)
  const wrong = await call(P, 'POST', `/leave/requests/${applied.id}/decision`, { approve: true })
  const right = await call(I, 'POST', `/leave/requests/${applied.id}/decision`, { approve: true, comment: 'OK' })
  check('5b only their own Manager may decide it: QC (Pouch) Manager 403, IPQC Manager approves', wrong.status === 403 && right.status === 200 && right.json.status === 'APPROVED', `${wrong.status},${right.status}`)
  const rep = await call(P, 'GET', '/leave/report')
  check('5c leave report: their workers only', rep.json.rows.every((r: any) => pouchQc.includes(r.workerId)), `${rep.json.rows.length}`)
}

// ---- 6. Admins and the Super Admin are not limited
{
  const cs = await call(SA, 'GET', `/quality-checks?from=${from}&to=${to}`)
  check('6 the Super Admin still sees IPQC and QC checks of every department', new Set(cs.json.map((c: any) => c.module)).size === 2)
}

// Clean up the test accounts (disabled, kept for the audit trail of the copy).
await db.update(users).set({ isActive: false }).where(inArray(users.id, [mIpqc, mPouch, mLabel, mNone, labelWorker]))
console.log(results.join('\n'))
console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
await pool.end()
