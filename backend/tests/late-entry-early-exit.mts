/**
 * Late Entry and Early Exit end to end (npm run test:late-entry): today only (another date is
 * refused by the server), a time inside the worker's shift, one of each kind a day, nothing changes
 * until a manager decides, approval excuses only that worker's unfinished tasks of that shift
 * (Late Entry: before the arrival time; Early Exit: from the leaving time), once; completed tasks,
 * other days and other workers are untouched; rejection changes nothing; the scheduler makes no
 * task in the excused stretch and the next day runs as normal; cancelling restores the tasks; every
 * step is audited. Refuses to run unless DATABASE_URL names a database ending in "_test".
 *
 *   1. Copy the live database into pouchwale_quality_test; point its SMTP at a dead local port;
 *      start a server on it:
 *      DATABASE_URL=.../pouchwale_quality_test PUSH_DISABLED=1 ADMIN_PORT=0 PORT=4191 npm start
 *   2. DATABASE_URL=.../pouchwale_quality_test npm run test:late-entry
 *   3. Drop the copy.
 */
import { and, eq, sql } from 'drizzle-orm'
import { db, pool } from '../src/db/client'
import { activities, auditLogs, leaveRequests, leaveTypes, machines, qualityChecks, schedules, shifts, users } from '../src/db/schema'
import { signTokens } from '../src/lib/auth'
import { addDays, dateKey, minutesOfDay } from '../src/lib/time'
import { planChecks } from '../src/services/checkGenerator'
import { cutWindows } from '../src/services/leave'

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
const MIN = 60_000
const hhmm = (d: Date) => {
  const m = minutesOfDay(d)
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}
const st = async (id: string) => (await db.select({ s: qualityChecks.status, l: qualityChecks.leaveRequestId }).from(qualityChecks).where(eq(qualityChecks.id, id)))[0]

// ---------------------------------------------------------------------------- setup
const now = new Date()
const today = dateKey(now)
const yesterday = dateKey(addDays(now, -1))
// Whole minutes, so the shift and the entered times line up exactly.
const at = (minutes: number) => new Date(Math.floor(now.getTime() / MIN) * MIN + minutes * MIN)
const shiftStart = at(-180)
const shiftEnd = at(180)
const arrival = at(-60)
const exitAt = at(60)
if (dateKey(shiftStart) !== today || dateKey(shiftEnd) !== today) {
  console.error('Run this between 03:00 and 21:00 plant time (the test shift must stay inside today).')
  process.exit(2)
}

const [sa] = await db.select().from(users).where(eq(users.role, 'SUPER_ADMIN'))
const [other] = await db.select().from(users).where(and(eq(users.role, 'WORKER'), eq(users.isActive, true))).limit(1)
const [shift] = await db
  .insert(shifts)
  .values({ name: 'LE/EE test shift', code: `LEE-${Date.now()}`, startTime: hhmm(shiftStart), endTime: hhmm(shiftEnd), isActive: true })
  .returning()
const [tw] = await db
  .insert(users)
  .values({ employeeId: `LEE${Date.now() % 1_000_000}`, name: 'Late Early Test Worker', passwordHash: 'x', role: 'WORKER', shiftId: shift.id, departmentId: other.departmentId })
  .returning()
const SA = await tokenFor(sa.id)
const TW = await tokenFor(tw.id, 'mobile')
const access = await call(SA, 'PUT', '/leave/worker-access', { enabled: true })
check('leave is on for workers', access.status === 200, String(access.status))

const [le] = await db.select().from(leaveTypes).where(eq(leaveTypes.kind, 'LATE_ENTRY'))
const [ee] = await db.select().from(leaveTypes).where(eq(leaveTypes.kind, 'EARLY_EXIT'))
check('migration tagged Late Entry and Early Exit', !!le && !!ee && le.name === 'Late Entry' && ee.name === 'Early Exit', `${le?.name} / ${ee?.name}`)
const [{ n: leaveKinds }] = await db.select({ n: sql<number>`count(*)::int` }).from(leaveTypes).where(eq(leaveTypes.kind, 'LEAVE'))
check('Custom Leave stays an ordinary leave type', leaveKinds >= 1, String(leaveKinds))

const [machine] = await db.select({ id: machines.id }).from(machines).limit(1)
const [activity] = await db.select({ id: activities.id, module: activities.module }).from(activities).where(eq(activities.isActive, true)).limit(1)
let n = 0
async function addCheck(workerId: string, scheduled: Date, status: 'PENDING' | 'DUE' | 'MISSED' | 'COMPLETED' | 'IN_PROGRESS') {
  const [row] = await db
    .insert(qualityChecks)
    .values({
      code: `QC-LEETEST-${Date.now()}-${++n}`,
      machineId: machine.id,
      activityId: activity.id,
      module: activity.module ?? 'IPQC',
      workerId,
      shiftId: shift.id,
      scheduledAt: scheduled,
      windowEndsAt: new Date(scheduled.getTime() + 15 * MIN),
      status,
      submittedAt: status === 'COMPLETED' ? new Date(scheduled.getTime() + 5 * MIN) : null,
      submittedById: status === 'COMPLETED' ? workerId : null
    })
    .returning({ id: qualityChecks.id })
  return row.id
}
const missedBefore = await addCheck(tw.id, at(-160), 'MISSED') // before arrival: Late Entry excuses it
const doneBefore = await addCheck(tw.id, at(-140), 'COMPLETED') // completed: always kept
const missedAfterArrival = await addCheck(tw.id, at(-50), 'MISSED') // after arrival: still counts
const otherWorkers = await addCheck(other.id, at(-160), 'MISSED') // another worker: untouched
const yesterdays = await addCheck(tw.id, addDays(at(-160), -1), 'MISSED') // another day: untouched
const dueBeforeExit = await addCheck(tw.id, at(-5), 'DUE') // before leaving: stays active
const pendingAfterExit = await addCheck(tw.id, at(75), 'PENDING') // after leaving: Early Exit excuses it
const missedAfterExitDone = await addCheck(tw.id, at(70), 'COMPLETED') // completed after leaving time: kept
const tomorrows = await addCheck(tw.id, addDays(at(75), 1), 'PENDING') // tomorrow: untouched

const apply = (typeId: string, time: string | undefined, date = today, reason = 'Bus was late today') =>
  call(TW, 'POST', '/worker/leave/requests', { leaveTypeId: typeId, dayPart: 'FULL', startDate: date, endDate: date, reason, ...(time ? { requestedTime: time } : {}) })

// ---------------------------------------------------------------------------- Late Entry: rules
const overview = await call(TW, 'GET', '/worker/leave')
const t = overview.json?.types?.find((x: any) => x.id === le.id)
check('the app gets the kind and the server date', t?.kind === 'LATE_ENTRY' && overview.json?.today === today, `${t?.kind} ${overview.json?.today}`)
check('Late Entry / Early Exit have no leave balance', !overview.json?.balances?.some((b: any) => b.leaveTypeId === le.id || b.leaveTypeId === ee.id))

const past = await apply(le.id, hhmm(arrival), yesterday)
check('a past date is refused (400)', past.status === 400 && /only be requested for today/.test(past.json?.error ?? past.json?.message ?? ''), `${past.status} ${JSON.stringify(past.json)}`)
const future = await apply(le.id, hhmm(arrival), dateKey(addDays(now, 1)))
check('a future date is refused (400)', future.status === 400, String(future.status))
const mixed = await call(TW, 'POST', '/worker/leave/requests', { leaveTypeId: le.id, dayPart: 'FULL', startDate: today, endDate: dateKey(addDays(now, 2)), reason: 'Bus was late', requestedTime: hhmm(arrival) })
check('a date range is refused (400)', mixed.status === 400, String(mixed.status))
const noTime = await apply(le.id, undefined)
check('the time is required (400)', noTime.status === 400, String(noTime.status))
const badTime = await apply(le.id, '25:99')
check('an invalid time is refused (400)', badTime.status === 400, String(badTime.status))
const outside = await apply(le.id, hhmm(at(240)))
check('a time outside the shift is refused (400)', outside.status === 400 && /outside your shift/.test(JSON.stringify(outside.json)), `${outside.status} ${JSON.stringify(outside.json)}`)
const atStart = await apply(le.id, hhmm(shiftStart))
check('arriving at the shift start is refused (400)', atStart.status === 400, String(atStart.status))

const leReq = await apply(le.id, hhmm(arrival))
check('Late Entry sent (201, pending)', leReq.status === 201 && leReq.json?.status === 'PENDING' && leReq.json?.kind === 'LATE_ENTRY', `${leReq.status} ${JSON.stringify(leReq.json)}`)
const leId = leReq.json?.id
check('it records the time against today', leReq.json?.startDate === today && leReq.json?.endDate === today && leReq.json?.requestedTime === hhmm(arrival) && leReq.json?.days === 0)
check('it covers shift start to arrival', new Date(leReq.json?.affectsFrom).getTime() === shiftStart.getTime() && new Date(leReq.json?.affectsTo).getTime() === arrival.getTime(), `${leReq.json?.affectsFrom} ${leReq.json?.affectsTo}`)
check('the label shows the time', /^Arrival at \d{1,2}:\d{2} (AM|PM)$/.test(leReq.json?.dayPartLabel ?? ''), leReq.json?.dayPartLabel)
const dup = await apply(le.id, hhmm(at(-30)))
check('a second Late Entry today is refused (409)', dup.status === 409, String(dup.status))
check('nothing changes while it is pending', (await st(missedBefore)).s === 'MISSED')

const selfDecide = await call(TW, 'POST', `/leave/requests/${leId}/decision`, { approve: true })
check('the worker cannot approve it', selfDecide.status === 403 || selfDecide.status === 401, String(selfDecide.status))

// ---------------------------------------------------------------------------- Late Entry: approval
const leOk = await call(SA, 'POST', `/leave/requests/${leId}/decision`, { approve: true, comment: 'Bus strike' })
check('manager approves (200)', leOk.status === 200 && leOk.json?.status === 'APPROVED', `${leOk.status} ${JSON.stringify(leOk.json)}`)
check('the missed task before arrival is excused, linked to the request', (await st(missedBefore)).s === 'EXCUSED' && (await st(missedBefore)).l === leId)
check('the completed task before arrival is kept', (await st(doneBefore)).s === 'COMPLETED')
check('the missed task after arrival still counts', (await st(missedAfterArrival)).s === 'MISSED')
check('another worker is untouched', (await st(otherWorkers)).s === 'MISSED')
check('yesterday is untouched', (await st(yesterdays)).s === 'MISSED')
check('the request records how many were excused, and when', leOk.json?.tasksRemoved === 1 && !!leOk.json?.tasksRemovedAt, `${leOk.json?.tasksRemoved}`)
const again = await call(SA, 'POST', `/leave/requests/${leId}/decision`, { approve: true })
check('it is decided once (409)', again.status === 409, String(again.status))
const [leAudit] = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, leId), eq(auditLogs.action, 'APPROVE_LEAVE')))
check('the approval is audited with the excused task codes', Array.isArray((leAudit?.newValue as any)?.excusedTasks) && (leAudit?.newValue as any).excusedTasks.length === 1, JSON.stringify(leAudit?.newValue))

const todayList = await call(TW, 'GET', '/worker/checks/today')
const ids: string[] = Array.isArray(todayList.json) ? todayList.json.map((c: any) => c.id) : []
check("the excused task is gone from the worker's list", todayList.status === 200 && !ids.includes(missedBefore) && ids.includes(missedAfterArrival), `${todayList.status} ${ids.length}`)
const detail = await call(SA, 'GET', `/quality-checks/${missedBefore}`)
check('admins still see it, as Excused by the Late Entry', detail.json?.status === 'EXCUSED' && detail.json?.leaveExcuse?.kind === 'LATE_ENTRY', `${detail.status} ${JSON.stringify(detail.json?.leaveExcuse)}`)

// ---------------------------------------------------------------------------- Early Exit: reject, then approve
const ee1 = await apply(ee.id, hhmm(exitAt), today, 'Doctor appointment')
check('Early Exit sent (201)', ee1.status === 201 && ee1.json?.kind === 'EARLY_EXIT', `${ee1.status} ${JSON.stringify(ee1.json)}`)
check('it covers leaving time to shift end', new Date(ee1.json?.affectsFrom).getTime() === exitAt.getTime() && new Date(ee1.json?.affectsTo).getTime() === shiftEnd.getTime())
check('Late Entry and Early Exit on one day are both allowed', ee1.status === 201)
check('tasks stay active before approval', (await st(pendingAfterExit)).s === 'PENDING' && (await st(dueBeforeExit)).s === 'DUE')
const rej = await call(SA, 'POST', `/leave/requests/${ee1.json?.id}/decision`, { approve: false, comment: 'Busy day' })
check('manager rejects (200)', rej.status === 200 && rej.json?.status === 'REJECTED' && !rej.json?.tasksRemovedAt, `${rej.status}`)
check('rejection changes nothing', (await st(pendingAfterExit)).s === 'PENDING')

const ee2 = await apply(ee.id, hhmm(exitAt), today, 'Doctor appointment')
check('a new Early Exit after a rejection is allowed (201)', ee2.status === 201, String(ee2.status))
const eeOk = await call(SA, 'POST', `/leave/requests/${ee2.json?.id}/decision`, { approve: true })
check('manager approves Early Exit (200)', eeOk.status === 200 && eeOk.json?.tasksRemoved === 1, `${eeOk.status} ${eeOk.json?.tasksRemoved}`)
check('the unfinished task after leaving is excused', (await st(pendingAfterExit)).s === 'EXCUSED')
check('the task before leaving stays active', (await st(dueBeforeExit)).s === 'DUE')
check('a completed task is never excused', (await st(missedAfterExitDone)).s === 'COMPLETED')
check("tomorrow's task is untouched", (await st(tomorrows)).s === 'PENDING')

// ---------------------------------------------------------------------------- the scheduler
check('cutWindows trims, splits and drops', (() => {
  const w = [{ start: at(-180), end: at(180), id: 'a' }]
  const r = cutWindows(w, [{ from: at(-180), to: at(-60) }, { from: at(60), to: at(180) }])
  return r.length === 1 && r[0].start.getTime() === at(-60).getTime() && r[0].end.getTime() === at(60).getTime() && r[0].id === 'a'
})())
const [sched] = await db
  .insert(schedules)
  .values({ activityId: activity.id, shiftId: shift.id, workerId: tw.id, departmentId: tw.departmentId, module: activity.module ?? 'IPQC', intervalMinutes: 30, isActive: true })
  .returning()
await db.update(schedules).set({ updatedAt: addDays(now, -1), createdAt: addDays(now, -1) }).where(eq(schedules.id, sched.id))
const mine = (list: Awaited<ReturnType<typeof planChecks>>) => list.filter((c) => c.scheduleId === sched.id)
const beforeArrival = mine(await planChecks(at(-90), { ignoreOpen: true }))
check('no task is made before the arrival time', beforeArrival.length > 0 && beforeArrival.every((c) => (c.scheduledAt as Date) >= arrival), beforeArrival.map((c) => (c.scheduledAt as Date).toISOString()).join(','))
const afterExit = mine(await planChecks(at(90), { ignoreOpen: true }))
check('no task is made after the leaving time today', afterExit.every((c) => dateKey(c.scheduledAt as Date) !== today), afterExit.map((c) => (c.scheduledAt as Date).toISOString()).join(','))
check('the next task is tomorrow at the normal shift start', afterExit.length === 1 && (afterExit[0].scheduledAt as Date).getTime() === addDays(shiftStart, 1).getTime(), afterExit.map((c) => (c.scheduledAt as Date).toISOString()).join(','))
const midday = mine(await planChecks(at(10), { ignoreOpen: true }))
check('between arrival and leaving, tasks are made as usual', midday.some((c) => dateKey(c.scheduledAt as Date) === today && (c.scheduledAt as Date) >= arrival && (c.scheduledAt as Date) < exitAt))
await db.update(schedules).set({ isActive: false }).where(eq(schedules.id, sched.id))

// ---------------------------------------------------------------------------- cancelling
const workerCancel = await call(TW, 'POST', `/worker/leave/requests/${ee2.json?.id}/cancel`)
check('the worker cannot cancel an approved one of today', workerCancel.status === 400 || workerCancel.status === 403, String(workerCancel.status))
const staffCancel = await call(SA, 'POST', `/leave/requests/${ee2.json?.id}/cancel`)
check('staff cancel an approved Early Exit (200)', staffCancel.status === 200 && staffCancel.json?.status === 'CANCELLED', String(staffCancel.status))
check('its task counts again (open)', (await st(pendingAfterExit)).s === 'PENDING' && (await st(pendingAfterExit)).l === null)
check('the Late Entry is unaffected', (await st(missedBefore)).s === 'EXCUSED')

// ---------------------------------------------------------------------------- normal leave still works
const leaveType = (await db.select().from(leaveTypes).where(eq(leaveTypes.kind, 'LEAVE')))[0]
const tomorrowKey = dateKey(addDays(now, 1))
const normal = await call(TW, 'POST', '/worker/leave/requests', { leaveTypeId: leaveType.id, dayPart: 'FULL', startDate: tomorrowKey, endDate: tomorrowKey, reason: 'Family function', customType: 'Family function' })
check('ordinary leave still applies (201)', normal.status === 201 && normal.json?.kind === 'LEAVE', `${normal.status} ${JSON.stringify(normal.json)}`)
const todayLeave = await call(TW, 'POST', '/worker/leave/requests', { leaveTypeId: leaveType.id, dayPart: 'SECOND_HALF', startDate: today, endDate: today, reason: 'Family function', customType: 'Family function' })
check('a Late Entry does not block half-day leave today', todayLeave.status === 201, `${todayLeave.status} ${JSON.stringify(todayLeave.json)}`)

// ---------------------------------------------------------------------------- clean up
await db.delete(qualityChecks).where(eq(qualityChecks.workerId, tw.id))
await db.delete(qualityChecks).where(eq(qualityChecks.id, otherWorkers))
await db.delete(schedules).where(eq(schedules.id, sched.id))
await db.delete(leaveRequests).where(eq(leaveRequests.workerId, tw.id))
await db.delete(users).where(eq(users.id, tw.id))
await db.delete(shifts).where(eq(shifts.id, shift.id))

console.log(results.join('\n'))
console.log(`\n${passed} passed, ${failed} failed`)
await pool.end()
process.exit(failed ? 1 : 0)
