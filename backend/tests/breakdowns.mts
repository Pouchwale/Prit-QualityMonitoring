/**
 * Machine breakdowns end to end (npm run test:breakdowns): a worker reports a breakdown during their
 * shift, alerts pause at once, checks stay as they are until a manager decides, approval excuses only
 * that worker's unsubmitted checks on that machine from the report to the shift end (and checks the
 * scheduler creates later in the period), rejection changes nothing, scores leave excused checks out,
 * and every decision is audited. Refuses to run unless DATABASE_URL names a database ending in "_test".
 *
 *   1. Copy the live database into pouchwale_quality_test; start a server on it:
 *      DATABASE_URL=.../pouchwale_quality_test PUSH_DISABLED=1 ADMIN_PORT=0 PORT=4191 npm start
 *   2. DATABASE_URL=.../pouchwale_quality_test npm run test:breakdowns
 *   3. Drop the copy.
 */
import { and, eq, inArray, sql } from 'drizzle-orm'
import { db, pool } from '../src/db/client'
import { activities, auditLogs, machineBreakdowns, machines, qualityChecks, shifts, users } from '../src/db/schema'
import { signTokens } from '../src/lib/auth'
import { minutesOfDay } from '../src/lib/time'
import { applyApprovedBreakdowns, notInReportedBreakdown } from '../src/services/breakdownWindow'
import { workerPerformance } from '../src/services/performance'
import sharp from 'sharp'

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
/** A small real JPEG, like a phone camera photo of the machine. */
const PHOTO = await sharp({ create: { width: 320, height: 240, channels: 3, background: { r: 120, g: 90, b: 60 } } }).jpeg().toBuffer()
/** POST /worker/breakdowns as the app sends it: multipart, with the photo unless `withPhoto` is false. */
async function report(token: string, fields: Record<string, string>, withPhoto = true) {
  const f = new FormData()
  for (const [k, v] of Object.entries(fields)) f.append(k, v)
  if (withPhoto) {
    f.append('photoCapturedAt', new Date().toISOString())
    f.append('photo', new Blob([PHOTO], { type: 'image/jpeg' }), 'breakdown.jpg')
  }
  const res = await fetch(BASE + '/worker/breakdowns', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: f })
  const text = await res.text()
  let json: any = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: res.status, json }
}
const MIN = 60_000
const hhmm = (d: Date) => {
  const m = minutesOfDay(d)
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}
const statusOf = async (id: string) => (await db.select({ s: qualityChecks.status, b: qualityChecks.breakdownId }).from(qualityChecks).where(eq(qualityChecks.id, id)))[0]

// ---------------------------------------------------------------------------- setup
const now = new Date()
const [sa] = await db.select().from(users).where(eq(users.role, 'SUPER_ADMIN'))
const [w] = await db.select().from(users).where(eq(users.name, 'AJAY THAKOR'))
const [w2] = await db.select().from(users).where(eq(users.name, 'Hiren'))
// A shift that covers now: 2 hours ago to 4 hours from now (plant time).
const [shift] = await db
  .insert(shifts)
  .values({ name: 'Breakdown test shift', code: `BDT-${Date.now()}`, startTime: hhmm(new Date(now.getTime() - 120 * MIN)), endTime: hhmm(new Date(now.getTime() + 240 * MIN)), isActive: true })
  .returning()
await db.update(users).set({ shiftId: shift.id }).where(eq(users.id, w.id))
const SA = await tokenFor(sa.id)
const W = await tokenFor(w.id, 'mobile')
const W2 = await tokenFor(w2.id, 'mobile')

const myMachines = await call(W, 'GET', '/worker/machines')
const machineList: { id: string }[] = Array.isArray(myMachines.json) ? myMachines.json : (myMachines.json?.machines ?? myMachines.json?.items ?? [])
check('worker has machines to report on', machineList.length > 0, `status ${myMachines.status}`)
const m1 = machineList[0]?.id
const [otherMachine] = await db.select({ id: machines.id }).from(machines).where(sql`${machines.id} <> ${m1}`).limit(1)
const [activity] = await db.select({ id: activities.id, module: activities.module }).from(activities).limit(1)

let n = 0
async function addCheck(o: { workerId: string; machineId: string; minutes: number; status: 'PENDING' | 'DUE' | 'MISSED' | 'COMPLETED'; submitted?: boolean }) {
  const at = new Date(now.getTime() + o.minutes * MIN)
  const [row] = await db
    .insert(qualityChecks)
    .values({
      code: `QC-BDTEST-${Date.now()}-${++n}`,
      machineId: o.machineId,
      activityId: activity.id,
      module: activity.module ?? 'IPQC',
      workerId: o.workerId,
      shiftId: shift.id,
      scheduledAt: at,
      windowEndsAt: new Date(at.getTime() + 15 * MIN),
      status: o.status,
      submittedAt: o.submitted ? new Date(at.getTime() + 5 * MIN) : null,
      submittedById: o.submitted ? o.workerId : null
    })
    .returning({ id: qualityChecks.id })
  return row.id
}

// ---------------------------------------------------------------------------- reporting rules
const w2Machines = await call(W2, 'GET', '/worker/machines')
const w2List: { id: string }[] = Array.isArray(w2Machines.json) ? w2Machines.json : (w2Machines.json?.machines ?? w2Machines.json?.items ?? [])
const w2Shift = await call(W2, 'GET', '/worker/breakdowns')
if (w2List[0] && !w2Shift.json?.shift) {
  const noShift = await report(W2, { machineId: w2List[0].id, reason: 'Motor stopped' })
  check('a worker who is not on shift cannot report (400)', noShift.status === 400, `${noShift.status} ${JSON.stringify(noShift.json)}`)
} else results.push('SKIP  off-shift report (second worker is on shift now or has no machines)')

const badMachine = otherMachine && !machineList.some((m) => m.id === otherMachine.id) ? await report(W, { machineId: otherMachine.id, reason: 'Motor stopped' }) : null
if (badMachine) check('a machine that is not the worker’s is refused (403)', badMachine.status === 403, String(badMachine.status))

const tooShort = await report(W, { machineId: m1, reason: 'x' })
check('a reason is required (400)', tooShort.status === 400, String(tooShort.status))

const listBefore = await call(W, 'GET', '/worker/breakdowns')
check('worker list says they are on shift', listBefore.status === 200 && !!listBefore.json?.shift, JSON.stringify(listBefore.json?.shift))

const noPhoto = await report(W, { machineId: m1, reason: 'Main motor tripped' }, false)
check('a report without a photo is refused (400)', noPhoto.status === 400 && /photo/i.test(noPhoto.json?.error ?? ''), `${noPhoto.status} ${JSON.stringify(noPhoto.json)}`)
const rep = await report(W, { machineId: m1, reason: 'Main motor tripped' })
check('worker reports a breakdown (201, PENDING)', rep.status === 201 && rep.json?.status === 'PENDING', `${rep.status} ${JSON.stringify(rep.json)}`)
const bd = rep.json
check('the report carries a link to its photo', typeof bd?.photoUrl === 'string' && bd.photoUrl.startsWith('/media/'), String(bd?.photoUrl))
const photoRes = bd?.photoUrl ? await fetch(BASE.replace(/\/api$/, '') + bd.photoUrl) : null
check('the photo link serves the image', !!photoRes && photoRes.status === 200 && (photoRes.headers.get('content-type') ?? '').startsWith('image/'), `${photoRes?.status} ${photoRes?.headers.get('content-type')}`)
// The worker's shift now (back-to-back shifts are joined into one block): the period ends with it.
const shiftEnd = new Date(listBefore.json?.shift?.end)
check('period ends at the end of the worker’s shift', bd && new Date(bd.endsAt).getTime() === shiftEnd.getTime(), `${bd?.endsAt} vs ${listBefore.json?.shift?.end}`)

const dup = await report(W, { machineId: m1, reason: 'Again' })
check('a second report for the same machine while one is open is refused (409)', dup.status === 409, String(dup.status))

// Pretend the report was made 90 minutes ago (e.g. at 2:00 AM), then lay out checks around it.
await db.update(machineBreakdowns).set({ startedAt: new Date(now.getTime() - 90 * MIN) }).where(eq(machineBreakdowns.id, bd.id))
const before = await addCheck({ workerId: w.id, machineId: m1, minutes: -120, status: 'MISSED' })
const missedIn = await addCheck({ workerId: w.id, machineId: m1, minutes: -60, status: 'MISSED' })
const doneIn = await addCheck({ workerId: w.id, machineId: m1, minutes: -45, status: 'COMPLETED', submitted: true })
const dueIn = await addCheck({ workerId: w.id, machineId: m1, minutes: -5, status: 'DUE' })
const futureIn = await addCheck({ workerId: w.id, machineId: m1, minutes: Math.min(60, (shiftEnd.getTime() - now.getTime()) / MIN - 10), status: 'PENDING' })
const otherMachineIn = otherMachine ? await addCheck({ workerId: w.id, machineId: otherMachine.id, minutes: -30, status: 'MISSED' }) : null
const otherWorkerIn = await addCheck({ workerId: w2.id, machineId: m1, minutes: -30, status: 'MISSED' })
const afterShift = await addCheck({ workerId: w.id, machineId: m1, minutes: (shiftEnd.getTime() - now.getTime()) / MIN + 10, status: 'PENDING' })

// ---------------------------------------------------------------------------- while waiting
check('checks keep their status while waiting', (await statusOf(missedIn)).s === 'MISSED' && (await statusOf(dueIn)).s === 'DUE')
const alertable = async (id: string) =>
  (await db.select({ id: qualityChecks.id }).from(qualityChecks).where(and(eq(qualityChecks.id, id), notInReportedBreakdown))).length === 1
check('due alerts are paused for the machine as soon as it is reported', !(await alertable(dueIn)))
check('alerts for the worker’s other machine still go out', !otherMachineIn || (await alertable(otherMachineIn)))
check('alerts for another worker on that machine still go out', await alertable(otherWorkerIn))

const perfBefore = (await workerPerformance({ from: new Date(now.getTime() - 3 * 60 * MIN), to: new Date(now.getTime() + 6 * 60 * MIN), workerId: w.id })).workers[0]

const pending = await call(SA, 'GET', '/breakdowns?status=PENDING')
const inList = pending.json?.find?.((b: any) => b.id === bd.id)
check('the report is in the pending list with the affected checks counted', !!inList && inList.affectedCount >= 3, JSON.stringify(inList))
const countRes = await call(SA, 'GET', '/breakdowns/pending-count')
check('pending count includes it', countRes.status === 200 && countRes.json?.pending >= 1, JSON.stringify(countRes.json))

// ---------------------------------------------------------------------------- deciding
const byWorker = await call(await tokenFor(w.id), 'POST', `/breakdowns/${bd.id}/decision`, { approve: true, comment: 'Self approve' })
check('a worker cannot decide (403)', byWorker.status === 403, String(byWorker.status))
const noReason = await call(SA, 'POST', `/breakdowns/${bd.id}/decision`, { approve: true })
check('the decision needs a reason (400)', noReason.status === 400, String(noReason.status))

const ok = await call(SA, 'POST', `/breakdowns/${bd.id}/decision`, { approve: true, comment: 'Motor tripped, confirmed by maintenance' })
check('Super Admin approves', ok.status === 200 && ok.json?.breakdown?.status === 'APPROVED', `${ok.status} ${JSON.stringify(ok.json)}`)
check('it excused 3 checks (missed, due, upcoming)', ok.json?.excused === 3, String(ok.json?.excused))

check('missed check in the period is excused, with the breakdown attached', (await statusOf(missedIn)).s === 'EXCUSED' && (await statusOf(missedIn)).b === bd.id)
check('due check in the period is excused', (await statusOf(dueIn)).s === 'EXCUSED')
check('upcoming check in the period is excused', (await statusOf(futureIn)).s === 'EXCUSED')
check('check before the report stays missed', (await statusOf(before)).s === 'MISSED')
check('completed check in the period stays completed', (await statusOf(doneIn)).s === 'COMPLETED')
check('the worker’s other machine is not affected', !otherMachineIn || (await statusOf(otherMachineIn)).s === 'MISSED')
check('another worker on the same machine is not affected', (await statusOf(otherWorkerIn)).s === 'MISSED')
check('a check after the shift end is not affected', (await statusOf(afterShift)).s === 'PENDING')

const again = await call(SA, 'POST', `/breakdowns/${bd.id}/decision`, { approve: false, comment: 'Changed my mind' })
check('a decided report cannot be decided again (409)', again.status === 409, String(again.status))

// A check the scheduler creates later in the approved period is excused as it appears.
const lateCheck = await addCheck({ workerId: w.id, machineId: m1, minutes: Math.min(120, (shiftEnd.getTime() - now.getTime()) / MIN - 5), status: 'PENDING' })
await applyApprovedBreakdowns()
check('a check created later in the approved period is excused', (await statusOf(lateCheck)).s === 'EXCUSED')

// ---------------------------------------------------------------------------- score and lists
const perfAfter = (await workerPerformance({ from: new Date(now.getTime() - 3 * 60 * MIN), to: new Date(now.getTime() + 6 * 60 * MIN), workerId: w.id })).workers[0]
check('missed count drops by the excused missed checks', perfBefore && perfAfter && perfAfter.missed < perfBefore.missed, `${perfBefore?.missed} -> ${perfAfter?.missed}`)
check('excused checks are not assigned', perfBefore && perfAfter && perfAfter.assigned < perfBefore.assigned, `${perfBefore?.assigned} -> ${perfAfter?.assigned}`)

const detail = await call(SA, 'GET', `/breakdowns/${bd.id}`)
check('the report shows its checks', detail.status === 200 && detail.json?.checks?.some((c: any) => c.id === missedIn && c.status === 'EXCUSED'))

const day = (d: Date) => d.toISOString().slice(0, 10)
const excusedList = await call(SA, 'GET', `/quality-checks?from=${day(new Date(now.getTime() - 86400000))}&to=${day(new Date(now.getTime() + 86400000))}&status=EXCUSED`)
const listed = Array.isArray(excusedList.json) ? excusedList.json.find((c: any) => c.id === missedIn) : null
check('excused checks are listed with the manager’s reason', !!listed && listed.result === 'EXCUSED' && listed.breakdown?.decisionComment === 'Motor tripped, confirmed by maintenance', `${excusedList.status} ${JSON.stringify(listed?.breakdown)}`)

const [auditRow] = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, bd.id), eq(auditLogs.action, 'APPROVE_BREAKDOWN')))
check('the approval is audited with the excused check codes', !!auditRow && Array.isArray((auditRow.newValue as any)?.excusedChecks) && (auditRow.newValue as any).excusedChecks.length === 3)

// ---------------------------------------------------------------------------- reject and withdraw
await db.update(users).set({ shiftId: shift.id }).where(eq(users.id, w2.id))
const m2 = w2List[0]?.id
if (m2) {
  const rep2 = await report(W2, { machineId: m2, reason: 'Belt snapped' })
  check('second worker (now on shift) reports', rep2.status === 201, `${rep2.status} ${JSON.stringify(rep2.json)}`)
  await db.update(machineBreakdowns).set({ startedAt: new Date(now.getTime() - 90 * MIN) }).where(eq(machineBreakdowns.id, rep2.json.id))
  const missed2 = await addCheck({ workerId: w2.id, machineId: m2, minutes: -60, status: 'MISSED' })
  const due2 = await addCheck({ workerId: w2.id, machineId: m2, minutes: -3, status: 'DUE' })
  check('alerts paused while the second report waits', !(await alertable(due2)))
  const rej = await call(SA, 'POST', `/breakdowns/${rep2.json.id}/decision`, { approve: false, comment: 'No breakdown found on inspection' })
  check('Super Admin rejects', rej.status === 200 && rej.json?.breakdown?.status === 'REJECTED' && rej.json?.excused === 0, JSON.stringify(rej.json))
  check('rejected: missed check still counts as missed', (await statusOf(missed2)).s === 'MISSED')
  check('rejected: alerts resume', await alertable(due2))
  const [rejAudit] = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, rep2.json.id), eq(auditLogs.action, 'REJECT_BREAKDOWN')))
  check('the rejection is audited with its reason', (rejAudit?.newValue as any)?.comment === 'No breakdown found on inspection')
  const rep3 = await report(W2, { machineId: m2, reason: 'Belt snapped again' })
  check('after a rejection the worker can report again', rep3.status === 201, String(rep3.status))
  const cancel = await call(W2, 'POST', `/worker/breakdowns/${rep3.json.id}/cancel`)
  check('the worker withdraws a waiting report', cancel.status === 200 && cancel.json?.status === 'CANCELLED', JSON.stringify(cancel.json))
  const cancelAgain = await call(W2, 'POST', `/worker/breakdowns/${rep3.json.id}/cancel`)
  check('a withdrawn report cannot be withdrawn again (409)', cancelAgain.status === 409, String(cancelAgain.status))
  const otherCancel = await call(W, 'POST', `/worker/breakdowns/${rep2.json.id}/cancel`)
  check('a worker cannot withdraw someone else’s report (409)', otherCancel.status === 409, String(otherCancel.status))
} else {
  results.push('SKIP  reject/withdraw (the second worker has no machines)')
}

// ---------------------------------------------------------------------------- report
console.log(results.join('\n'))
console.log(`\n${passed} passed, ${failed} failed`)
await pool.end()
process.exit(failed ? 1 : 0)
