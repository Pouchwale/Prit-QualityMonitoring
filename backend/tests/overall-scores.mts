/**
 * Overall scores (npm run test:overall-scores): every worker's overall counts and score, as the
 * Worker Performance page shows them (GET /api/performance/overall), and who may read them. Refuses
 * to run unless DATABASE_URL names a database ending in "_test".
 *
 *   1. Copy the live database into pouchwale_quality_test; start a server on it (PORT=4191).
 *   2. DATABASE_URL=.../pouchwale_quality_test npm run test:overall-scores
 *   3. Drop the copy.
 */
import { and, eq, isNotNull, sql } from 'drizzle-orm'
import { db, pool } from '../src/db/client'
import { qualityChecks, rolePermissions, users } from '../src/db/schema'
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
function check(name: string, ok: boolean, detail = '') {
  if (ok) passed++
  else failed++
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}
async function tokenFor(id: string, app: 'web' | 'mobile' = 'web') {
  const [u] = await db.select().from(users).where(eq(users.id, id))
  return signTokens(u, app).accessToken
}
async function call(token: string, p: string, method = 'GET', body?: unknown) {
  const res = await fetch(BASE + p, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

const [sa] = await db.select().from(users).where(eq(users.role, 'SUPER_ADMIN'))
const [mgr] = await db.select().from(users).where(eq(users.role, 'MANAGER'))
const SA = await tokenFor(sa.id)
const MGR = await tokenFor(mgr.id)

// ---- 1. Every worker, with counts that match the checks in the database
const report = (await call(SA, '/performance/overall')).json
{
  const workers = await db.select().from(users).where(eq(users.role, 'WORKER'))
  const shown = new Set((report.rows as any[]).map((r) => r.workerId))
  const activeMissing = workers.filter((w) => w.isActive && !shown.has(w.id))
  check('1a every active worker is listed', activeMissing.length === 0 && report.rows.length > 0, `${report.rows.length} rows`)

  const counts = await db
    .select({ workerId: qualityChecks.workerId, status: qualityChecks.status, n: sql<number>`count(*)::int` })
    .from(qualityChecks)
    .where(isNotNull(qualityChecks.workerId))
    .groupBy(qualityChecks.workerId, qualityChecks.status)
  const of = (id: string, status: string) => counts.find((c) => c.workerId === id && c.status === status)?.n ?? 0
  const wrong = (report.rows as any[]).filter((r) => {
    const o = r.overall
    const completed = of(r.workerId, 'COMPLETED')
    const exceptions = of(r.workerId, 'EXCEPTION')
    const missed = of(r.workerId, 'MISSED')
    const assigned = completed + exceptions + missed
    const expectedScore = assigned ? Math.round(((completed + exceptions) / assigned) * 100) - 100 : null
    return o.completed !== completed || o.exceptions !== exceptions || o.missed !== missed || o.assigned !== assigned || o.score !== expectedScore
  })
  check(
    '1b completed / exceptions / missed / assigned and the score match the database (score = done ÷ assigned − 100)',
    wrong.length === 0,
    wrong.map((r) => `${r.name}: ${JSON.stringify(r.overall)}`).join('; ')
  )
  const deptOk = (report.rows as any[]).every((r) => {
    const w = workers.find((x) => x.id === r.workerId)!
    return (r.department ?? null) !== undefined && (!w.departmentId ? r.department === null : typeof r.department === 'string')
  })
  check('1c each worker’s department is shown (none when the worker has none)', deptOk)
}

// ---- 2. Who may read it: Worker Performance view
{
  const [perm] = await db.select().from(rolePermissions).where(and(eq(rolePermissions.role, 'MANAGER'), eq(rolePermissions.module, 'performance')))
  await call(SA, '/access/roles/MANAGER', 'PUT', { modules: { performance: { view: true } } })
  const a = await call(MGR, '/performance/overall')
  await call(SA, '/access/roles/MANAGER', 'PUT', { modules: { performance: { view: false } } })
  const c = await call(MGR, '/performance/overall')
  await call(SA, '/access/roles/MANAGER', 'PUT', { modules: { performance: perm ? { view: perm.canView, export: perm.canExport } : { view: false } } })
  const [worker] = await db.select().from(users).where(and(eq(users.role, 'WORKER'), eq(users.isActive, true)))
  const e = await call(await tokenFor(worker.id), '/performance/overall')
  check('2 with Worker Performance view: 200; without: 403; a worker: 403', a.status === 200 && c.status === 403 && e.status === 403, `${a.status},${c.status},${e.status}`)
}

console.log(results.join('\n'))
console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
await pool.end()
