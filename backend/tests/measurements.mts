/**
 * Measured Pass / Fail (Pouch Size: Height, Width, Gusset) and its on/off switch
 * (npm run test:measurements). Refuses to run unless DATABASE_URL names a database ending in "_test".
 *
 *   1. Copy the live database into pouchwale_quality_test.
 *   2. Start the backend on it: DATABASE_URL=.../pouchwale_quality_test PUSH_DISABLED=1 ADMIN_PORT=0 PORT=4191 npm start
 *   3. DATABASE_URL=.../pouchwale_quality_test npm run test:measurements
 *
 * It makes its own checks and a temporary Admin, turns off the Pouch check type's photo / video
 * rules while it runs (the test sends no files), and puts everything back at the end.
 */
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm'
import { db, pool } from '../src/db/client'
import { activityParameters, auditLogs, parameters, qualityChecks, qualityCheckValues, users } from '../src/db/schema'
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

const [pouchSize] = await db.select().from(parameters).where(eq(parameters.code, 'POUCH-SIZE'))
// A worker's machine check of a check type that asks for Pouch Size.
const [sample] = await db
  .select({ check: qualityChecks })
  .from(qualityChecks)
  .innerJoin(users, eq(users.id, qualityChecks.workerId))
  .innerJoin(activityParameters, and(eq(activityParameters.activityId, qualityChecks.activityId), eq(activityParameters.parameterId, pouchSize.id)))
  .where(and(eq(users.role, 'WORKER'), eq(users.isActive, true), isNotNull(qualityChecks.machineId), eq(activityParameters.isEnabled, true)))
  .orderBy(desc(qualityChecks.scheduledAt))
  .limit(1)
const activityId = sample.check.activityId
const [worker] = await db.select().from(users).where(eq(users.id, sample.check.workerId!))
const [sa] = await db.select().from(users).where(eq(users.role, 'SUPER_ADMIN'))
const [manager] = await db.select().from(users).where(and(eq(users.role, 'MANAGER'), eq(users.isActive, true)))
const [admin] = await db
  .insert(users)
  .values({ employeeId: `TEST-ADM-${Date.now()}`, name: 'Test Admin (measurements)', passwordHash: 'not-a-password', role: 'ADMIN' })
  .returning()
const WORKER = signTokens(worker, 'mobile').accessToken
const SA = signTokens(sa, 'web').accessToken
const ADMIN = signTokens(admin, 'web').accessToken
const MANAGER = manager ? signTokens(manager, 'web').accessToken : null

// The test sends no photos or videos: the check type's evidence rules are off while it runs.
const evidenceBefore = await db.select().from(activityParameters).where(eq(activityParameters.activityId, activityId))
await db.update(activityParameters).set({ requirePhoto: false, requireVideo: false }).where(eq(activityParameters.activityId, activityId))

const made: string[] = []
let n = 0
async function newCheck() {
  n++
  const now = new Date()
  const [row] = await db
    .insert(qualityChecks)
    .values({
      code: `TEST-MEAS-${Date.now()}-${n}`,
      machineId: sample.check.machineId,
      activityId,
      module: sample.check.module,
      workerId: worker.id,
      departmentId: sample.check.departmentId,
      shiftId: sample.check.shiftId,
      scheduledAt: new Date(now.getTime() - 60_000),
      windowEndsAt: new Date(now.getTime() + 30 * 60_000),
      status: 'DUE'
    })
    .returning()
  made.push(row.id)
  return row
}
/** Opens the check in the worker app and submits every Pass / Fail as Pass, Pouch Size as given. */
async function submit(pouchSizeValue: string) {
  const c = await newCheck()
  const form = await call(WORKER, 'GET', `/worker/checks/${c.id}`)
  const values = (form.json.parameters as any[]).map((p) => ({
    parameterId: p.id,
    value: p.id === pouchSize.id ? pouchSizeValue : p.type === 'PASS_FAIL' ? 'PASS' : p.type === 'YES_NO' ? 'YES' : p.type === 'NUMBER' ? '1' : p.type === 'DROPDOWN' ? p.options[0] : 'ok'
  }))
  const body = new FormData()
  body.append('itemCode', sample.check.itemCode ?? '')
  body.append('jobNo', `TJ${Date.now() % 100000}`)
  body.append('machineId', sample.check.machineId!)
  body.append('values', JSON.stringify(values))
  const res = await fetch(`${BASE}/worker/checks/${c.id}/submit`, { method: 'POST', headers: { Authorization: `Bearer ${WORKER}` }, body })
  const json = await res.json().catch(() => null)
  const [stored] = await db
    .select()
    .from(qualityCheckValues)
    .where(and(eq(qualityCheckValues.checkId, c.id), eq(qualityCheckValues.parameterId, pouchSize.id)))
  return { status: res.status, error: json?.error as string | undefined, stored, form: form.json }
}
const pouchField = (form: any) => (form.parameters as any[]).find((p) => p.id === pouchSize.id)

try {
  // ---- 1. Set up by the migration
  check(
    '1 migration: Pouch Size asks for Height, Width, Gusset in mm, switched on',
    JSON.stringify(pouchSize.measureFields) === '["Height","Width","Gusset"]' && pouchSize.unit === 'mm' && pouchSize.measureEnabled === true,
    JSON.stringify([pouchSize.measureFields, pouchSize.unit, pouchSize.measureEnabled])
  )

  // ---- 2. On: the worker enters the measurements
  {
    const r = await submit('PASS · Height 120 · Width 80 · Gusset 30,5')
    const f = pouchField(r.form)
    check('2a on: the worker form asks for Height, Width, Gusset', JSON.stringify(f?.measureFields) === '["Height","Width","Gusset"]' && /Height, Width, Gusset \(mm\)/.test(f?.rule ?? ''), f?.rule)
    check(
      '2b on: stored as one reading with the unit inside, PASS',
      r.status === 200 && r.stored?.value === 'PASS · Height 120 mm · Width 80 mm · Gusset 30.5 mm' && r.stored.result === 'PASS' && r.stored.unit === null,
      `${r.status} ${r.error ?? ''} ${r.stored?.value}`
    )
    const missing = await submit('FAIL · Height 120 · Width 80')
    check('2c on: a missing Gusset is refused with its name', missing.status === 400 && /Gusset/.test(missing.error ?? ''), `${missing.status} ${missing.error}`)
    const stale = await submit('PASS')
    check('2d on: a plain answer (a form opened while off) asks to open the check again', stale.status === 400 && /open the check again/.test(stale.error ?? ''), `${stale.status} ${stale.error}`)
  }

  // ---- 3. Who may switch
  {
    if (MANAGER) {
      const r = await call(MANAGER, 'PUT', `/parameters/${pouchSize.id}/measurements`, { enabled: false })
      check('3a a Manager cannot switch the measurements', r.status === 403, `${r.status}`)
    } else check('3a a Manager cannot switch the measurements (no Manager in the copy: skipped)', true)
    const worker403 = await call(WORKER, 'PUT', `/parameters/${pouchSize.id}/measurements`, { enabled: false })
    check('3b a worker cannot switch them', worker403.status === 403 || worker403.status === 401, `${worker403.status}`)
    const [still] = await db.select().from(parameters).where(eq(parameters.id, pouchSize.id))
    check('3c after the refused attempts they are still on', still.measureEnabled === true)
  }

  // ---- 4. An Admin switches them off
  {
    const r = await call(ADMIN, 'PUT', `/parameters/${pouchSize.id}/measurements`, { enabled: false })
    check('4a an Admin switches them off', r.status === 200 && r.json?.measureEnabled === false && r.json?.rule === 'Pass or Fail', `${r.status} ${JSON.stringify(r.json?.rule)}`)
    const [row] = await db.select().from(parameters).where(eq(parameters.id, pouchSize.id))
    check('4b the list of measurements is kept', JSON.stringify(row.measureFields) === '["Height","Width","Gusset"]' && row.unit === 'mm')
    const [log] = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, pouchSize.id), eq(auditLogs.action, 'DISABLE_PARAMETER_MEASUREMENTS'))).orderBy(desc(auditLogs.createdAt)).limit(1)
    check('4c the switch is in the audit log, by the Admin', log?.userName?.includes('Test Admin') ?? false, log?.userName ?? 'none')
    const plain = await submit('PASS')
    const f = pouchField(plain.form)
    check('4d off: the worker form is a plain Pass / Fail', JSON.stringify(f?.measureFields) === '[]' && f?.rule === 'Pass or Fail', JSON.stringify(f?.measureFields))
    check('4e off: a plain Pass is stored as before', plain.status === 200 && plain.stored?.value === 'PASS' && plain.stored.result === 'PASS', `${plain.status} ${plain.error ?? ''} ${plain.stored?.value}`)
    const stale = await submit('FAIL · Height 120 mm · Width 80 mm · Gusset 30 mm')
    check('4f off: a form opened while on still submits; only the answer is kept', stale.status === 200 && stale.stored?.value === 'FAIL' && stale.stored.result === 'FAIL', `${stale.status} ${stale.error ?? ''} ${stale.stored?.value}`)
    const list = await call(SA, 'GET', '/parameters')
    const listed = (list.json as any[]).find((p) => p.id === pouchSize.id)
    check('4g the Parameters list shows it off, with a plain rule', listed?.measureEnabled === false && listed?.rule === 'Pass or Fail')
  }

  // ---- 5. The Super Admin switches them on again
  {
    const r = await call(SA, 'PUT', `/parameters/${pouchSize.id}/measurements`, { enabled: true })
    check('5a the Super Admin switches them on again', r.status === 200 && r.json?.measureEnabled === true, `${r.status}`)
    const again = await submit('FAIL · Height 118 · Width 79 · Gusset 29')
    check('5b on again: the measurements are asked for and stored', again.status === 200 && again.stored?.value === 'FAIL · Height 118 mm · Width 79 mm · Gusset 29 mm', `${again.status} ${again.error ?? ''} ${again.stored?.value}`)
  }

  // ---- 6. Only a Pass / Fail with measurements has a switch
  {
    const [other] = await db.select().from(parameters).where(and(eq(parameters.type, 'PASS_FAIL'), sql`jsonb_array_length(${parameters.measureFields}) = 0`)).limit(1)
    const r = await call(SA, 'PUT', `/parameters/${other.id}/measurements`, { enabled: false })
    check('6 a parameter without measurements has nothing to switch', r.status === 400, `${r.status} ${other.name}`)
  }
} finally {
  // Everything back as it was.
  await db.update(parameters).set({ measureEnabled: pouchSize.measureEnabled, measureFields: pouchSize.measureFields, unit: pouchSize.unit }).where(eq(parameters.id, pouchSize.id))
  for (const row of evidenceBefore) {
    await db.update(activityParameters).set({ requirePhoto: row.requirePhoto, requireVideo: row.requireVideo }).where(and(eq(activityParameters.activityId, row.activityId), eq(activityParameters.parameterId, row.parameterId)))
  }
  for (const id of made) await db.delete(qualityChecks).where(eq(qualityChecks.id, id))
  await db.delete(auditLogs).where(eq(auditLogs.userId, admin.id))
  await db.delete(users).where(eq(users.id, admin.id))
}

for (const line of results) console.log(line)
console.log(`\n${passed} passed, ${failed} failed`)
await pool.end()
process.exit(failed ? 1 : 0)
