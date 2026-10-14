/**
 * The reading an exception reason asks for, e.g. White Viscosity → Viscosity (sec)
 * (npm run test:exception-reading). Refuses to run unless DATABASE_URL names a database ending in "_test".
 *
 *   1. Copy the live database into pouchwale_quality_test; start a server on it (PORT=4191).
 *   2. DATABASE_URL=.../pouchwale_quality_test npm run test:exception-reading
 *   3. Drop the copy.
 *
 * Writes the two report PDFs of the test exception to EXCEPTION_READING_PDF_DIR when set, to look at.
 */
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { and, eq, isNotNull, sql } from 'drizzle-orm'
import { db, pool } from '../src/db/client'
import { checkExceptions, exceptionReasons, qualityChecks, users } from '../src/db/schema'
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

// A worker with a machine check of the past (its machine, Item Code and check type are reused).
const [sample] = await db
  .select({ check: qualityChecks })
  .from(qualityChecks)
  .innerJoin(users, eq(users.id, qualityChecks.workerId))
  // An Item Code in today's format: older checks hold free text such as "FGPO - 7441", which a new
  // exception would (rightly) refuse.
  .where(
    and(
      eq(users.role, 'WORKER'),
      eq(users.isActive, true),
      isNotNull(qualityChecks.machineId),
      sql`${qualityChecks.itemCode} ~ '^(FGPO|FGLA|FGSL)[0-9]+$'`
    )
  )
  .limit(1)
const worker = (await db.select().from(users).where(eq(users.id, sample.check.workerId!)))[0]
const [sa] = await db.select().from(users).where(eq(users.role, 'SUPER_ADMIN'))
const WORKER = await tokenFor(worker.id, 'mobile')
const SA = await tokenFor(sa.id)

let n = 0
/** A due check for the worker, made for this test. */
async function newCheck() {
  n++
  const now = new Date()
  const [row] = await db
    .insert(qualityChecks)
    .values({
      code: `TEST-RDG-${Date.now()}-${n}`,
      machineId: sample.check.machineId,
      activityId: sample.check.activityId,
      module: sample.check.module,
      workerId: worker.id,
      departmentId: sample.check.departmentId,
      shiftId: sample.check.shiftId,
      scheduledAt: new Date(now.getTime() - 60_000),
      windowEndsAt: new Date(now.getTime() + 30 * 60_000),
      status: 'DUE'
    })
    .returning()
  return row
}
/** Sends an exception from the worker app (multipart, with a fresh photo). */
async function sendException(checkId: string, fields: Record<string, string>) {
  const photo = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: Math.floor(Math.random() * 255), g: n * 7 % 255, b: Date.now() % 255 } } })
    .jpeg()
    .toBuffer()
  const form = new FormData()
  for (const [k, v] of Object.entries({ itemCode: sample.check.itemCode!, jobNo: `TJ${Date.now() % 100000}`, photoCapturedAt: new Date().toISOString(), ...fields })) form.append(k, v)
  form.append('photo', new Blob([photo], { type: 'image/jpeg' }), `p${Date.now()}.jpg`)
  const res = await fetch(`${BASE}/worker/checks/${checkId}/exception`, { method: 'POST', headers: { Authorization: `Bearer ${WORKER}` }, body: form })
  return { status: res.status, json: await res.json().catch(() => null) }
}

// ---- 1. The setting
{
  const [reason] = await db.select().from(exceptionReasons).where(eq(exceptionReasons.label, 'White Viscosity'))
  check('1 migration: White Viscosity asks for "Viscosity" in sec; other reasons ask for nothing', reason?.readingLabel === 'Viscosity' && reason.readingUnit === 'sec')
  const others = await db.select().from(exceptionReasons).where(sql`${exceptionReasons.label} <> 'White Viscosity' and ${exceptionReasons.readingLabel} is not null`)
  check('1b no other reason was changed', others.length === 0)
  const c = await newCheck()
  const form = await call(WORKER, 'GET', `/worker/checks/${c.id}`)
  const rule = (form.json?.exceptionReasonRules as any[] | undefined)?.find((r) => r.label === 'White Viscosity')
  check('1c the worker app gets the rule with the check form', form.status === 200 && rule?.readingLabel === 'Viscosity' && rule?.readingUnit === 'sec', `${form.status}`)
  await db.delete(qualityChecks).where(eq(qualityChecks.id, c.id))
}

// ---- 2. Cannot be sent without a valid value
const target = await newCheck()
{
  const missing = await sendException(target.id, { reason: 'White Viscosity' })
  const bad: Record<string, number> = {}
  for (const v of ['abc', '0', '-3', '21,5', '1.234', '999999']) bad[v] = (await sendException(target.id, { reason: 'White Viscosity', readingValue: v })).status
  const [row] = await db.select().from(qualityChecks).where(eq(qualityChecks.id, target.id))
  check('2a no value: refused (400) with "Enter the Viscosity (sec) value"', missing.status === 400 && /Viscosity \(sec\)/.test(missing.json?.error ?? ''), missing.json?.error ?? '')
  check('2b invalid values refused (400): letters, 0, negative, comma, 3 decimals, too large', Object.values(bad).every((s) => s === 400), JSON.stringify(bad))
  check('2c nothing was saved: the check is still due, no exception', row.status === 'DUE' && (await db.select().from(checkExceptions).where(eq(checkExceptions.checkId, target.id))).length === 0)
}

// ---- 3. A valid value is saved with the exception
{
  const ok = await sendException(target.id, { reason: 'White Viscosity', readingValue: '21.5' })
  const [exc] = await db.select().from(checkExceptions).where(eq(checkExceptions.checkId, target.id))
  check('3 valid value: sent (200); saved as 21.5 with label "Viscosity" and unit "sec"', ok.status === 200 && exc?.readingValue === 21.5 && exc.readingLabel === 'Viscosity' && exc.readingUnit === 'sec', `${ok.status} ${JSON.stringify(ok.json?.error ?? '')}`)
}

// ---- 4. Other reasons: no reading asked, and a value sent anyway is not stored
{
  const c = await newCheck()
  const r = await sendException(c.id, { reason: 'Material unavailable', readingValue: '12' })
  const [exc] = await db.select().from(checkExceptions).where(eq(checkExceptions.checkId, c.id))
  check('4 another reason: sent without a reading; nothing stored for it', r.status === 200 && exc?.readingValue === null, `${r.status}`)
}

// ---- 5. Shown in the details and reports
{
  const reading = 'Viscosity: 21.5 sec'
  const detail = await call(SA, 'GET', `/quality-checks/${target.id}`)
  const list = await call(SA, 'GET', '/exceptions')
  const history = await call(WORKER, 'GET', '/worker/checks/history')
  const record = await call(WORKER, 'GET', `/worker/checks/${target.id}/record`)
  check('5a check details (admin panel): exception.reading', detail.json?.exception?.reading === reading, detail.json?.exception?.reading ?? '')
  check('5b Exceptions list', (list.json as any[]).some((e) => e.checkId === target.id && e.reading === reading))
  const histItems = (history.json?.items ?? history.json) as any[]
  check('5c worker app history and record', histItems.some((h) => h.id === target.id && h.exceptionReading === reading) && record.json?.exception?.reading === reading)

  const day = new Date().toISOString().slice(0, 10)
  const pdf = await fetch(`${BASE}/reports/quality-monitoring.pdf?from=${day}&to=${day}`, { headers: { Authorization: `Bearer ${SA}` } })
  const inspection = await fetch(`${BASE}/reports/sharing/preview-pdf?checkIds=${target.id}`, { headers: { Authorization: `Bearer ${SA}` } })
  const pdfBytes = Buffer.from(await pdf.arrayBuffer())
  const inspectionBytes = Buffer.from(await inspection.arrayBuffer())
  check('5d the Reports PDF and the Quality Inspection Report PDF are made', pdf.status === 200 && inspection.status === 200 && pdfBytes.length > 1000 && inspectionBytes.length > 1000, `${pdf.status},${inspection.status}`)
  if (process.env.EXCEPTION_READING_PDF_DIR) {
    fs.writeFileSync(path.join(process.env.EXCEPTION_READING_PDF_DIR, 'reports.pdf'), pdfBytes)
    fs.writeFileSync(path.join(process.env.EXCEPTION_READING_PDF_DIR, 'inspection.pdf'), inspectionBytes)
  }
}

// ---- 6. The setting can be turned off (and back on) by the reason's editor
{
  const [reason] = await db.select().from(exceptionReasons).where(eq(exceptionReasons.label, 'White Viscosity'))
  const off = await call(SA, 'PUT', `/exception-reasons/${reason.id}`, { label: reason.label, readingLabel: null })
  const c = await newCheck()
  const sentWithout = await sendException(c.id, { reason: 'White Viscosity' })
  const on = await call(SA, 'PUT', `/exception-reasons/${reason.id}`, { label: reason.label, readingLabel: 'Viscosity', readingUnit: 'sec' })
  const [after] = await db.select().from(exceptionReasons).where(eq(exceptionReasons.id, reason.id))
  const [old] = await db.select().from(checkExceptions).where(eq(checkExceptions.checkId, target.id))
  check(
    '6 turned off: sent without a reading; turned on again; earlier exceptions keep their reading',
    off.status === 200 && sentWithout.status === 200 && on.status === 200 && after.readingLabel === 'Viscosity' && old.readingValue === 21.5,
    `${off.status},${sentWithout.status},${on.status}`
  )
}

console.log(results.join('\n'))
console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
await pool.end()
