/**
 * Plant Calendar and task assignment (npm run test:plant-calendar): Holiday, Plant Closed (with a
 * reason), Shutdown and Adjustment Working Day, for Scheduled tasks (check schedules) and Job-based
 * tasks (a running job's interval checks). Calendar changes go through the API, exactly as the admin
 * panel makes them. Refuses to run unless DATABASE_URL names a database ending in "_test".
 *
 *   1. Copy the live database into pouchwale_quality_test; start a server on it (PORT=4191).
 *   2. DATABASE_URL=.../pouchwale_quality_test npm run test:plant-calendar
 *   3. Drop the copy.
 */
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import { db, pool } from '../src/db/client'
import { activities, activityParameters, jobs, machineActivities, machines, plantClosures, qualityChecks, schedules, shifts, users } from '../src/db/schema'
import { signTokens } from '../src/lib/auth'
import { addDays, atTime, dateKey, parseDateKey, startOfDay } from '../src/lib/time'
import { occurrences, planChecks } from '../src/services/checkGenerator'
import { generateJobIntervalChecks } from '../src/services/jobMonitoring'
import { dayStates } from '../src/services/plantCalendar'

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
const [sa] = await db.select().from(users).where(eq(users.role, 'SUPER_ADMIN'))
const SA = signTokens(sa, 'web').accessToken
async function call(method: string, p: string, body?: unknown) {
  const res = await fetch(BASE + p, { method, headers: { Authorization: `Bearer ${SA}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  return { status: res.status, json: (await res.json().catch(() => null)) as any }
}
const mark = (date: string, type: 'HOLIDAY' | 'CLOSED' | 'SHUTDOWN' | 'WORKING', reason?: string) => call('POST', '/plant-closures', { from: date, type, reason })
const entryOn = async (date: string) => (await db.select().from(plantClosures).where(eq(plantClosures.date, date)))[0]
const unmark = async (date: string) => {
  const e = await entryOn(date)
  return e ? call('DELETE', `/plant-closures/${e.id}`) : { status: 404, json: null }
}
const stateOf = async (date: string) => (await dayStates(parseDateKey(date), parseDateKey(date)))[0]

// ---------------------------------------------------------------------------- dates
// An ordinary open date and a weekly off, both without a calendar entry, from the day after tomorrow (2026).
const today = dateKey(new Date())
let OPEN = ''
let WEEKLY = ''
for (const s of await dayStates(addDays(parseDateKey(today), 2), parseDateKey('2026-12-31'))) {
  if (!OPEN && s.source === 'OPEN') OPEN = s.date
  if (!WEEKLY && s.source === 'WEEKLY') WEEKLY = s.date
}

// ---------------------------------------------------------------------------- scheduled tasks
// An active worker schedule on a day shift.
const [sched] = await db
  .select({ schedule: schedules, shift: shifts })
  .from(schedules)
  .innerJoin(shifts, eq(shifts.id, schedules.shiftId))
  .where(and(eq(schedules.isActive, true), isNotNull(schedules.workerId), sql`${shifts.endTime} > ${shifts.startTime}`))
  .limit(1)
/** The schedule's shift window on a date, and every check slot it would get that day. */
async function scheduledSlots(date: string) {
  const win = occurrences(sched.schedule, sched.shift, startOfDay(parseDateKey(date)), 1).find((o) => dateKey(o.start) === date)!
  // Planned from just before the window ends, so the earlier slots come back too (as Missed).
  const list = await planChecks(new Date(win.end.getTime() - 60_000), { ignoreOpen: true })
  return list.filter((p) => p.scheduleId === sched.schedule.id && (p.scheduledAt as Date) >= win.start && (p.scheduledAt as Date) < win.end).length
}

// ---------------------------------------------------------------------------- job-based tasks
// A Job check type with interval parameters, switched on and linked to an enabled machine, and a running job.
const [jobType] = await db
  .select({ id: activities.id, departmentId: activities.departmentId })
  .from(activities)
  .innerJoin(activityParameters, eq(activityParameters.activityId, activities.id))
  .where(and(eq(activities.monitoring, 'JOB'), eq(activityParameters.frequency, 'INTERVAL')))
  .limit(1)
await db.update(activities).set({ isActive: true }).where(eq(activities.id, jobType.id))
const [machine] = await db.select().from(machines).where(and(eq(machines.isActive, true), eq(machines.status, 'ACTIVE'))).limit(1)
await db.insert(machineActivities).values({ machineId: machine.id, activityId: jobType.id }).onConflictDoNothing()
const [worker] = await db.select().from(users).where(and(eq(users.role, 'WORKER'), eq(users.isActive, true))).limit(1)
// A test job left by an interrupted run goes first (one running job per machine).
const leftover = await db.select({ id: jobs.id }).from(jobs).where(sql`${jobs.jobNo} like 'TEST-CAL-%'`)
if (leftover.length) {
  await db.delete(qualityChecks).where(inArray(qualityChecks.jobId, leftover.map((j) => j.id)))
  await db.delete(jobs).where(inArray(jobs.id, leftover.map((j) => j.id)))
}
const [job] = await db
  .insert(jobs)
  .values({ machineId: machine.id, jobNo: `TEST-CAL-${Date.now() % 100000}`, status: 'ACTIVE', departmentId: jobType.departmentId, assignedWorkerId: worker.id, startedAt: new Date(), activatedAt: new Date(Date.now() - 3600_000) })
  .returning()
/** Whether the running job gets an interval check on a date (planned at noon that day). */
async function jobChecks(date: string) {
  await db.delete(qualityChecks).where(and(eq(qualityChecks.jobId, job.id), eq(qualityChecks.kind, 'JOB_INTERVAL')))
  const noon = atTime(parseDateKey(date), '12:00')
  await db.update(jobs).set({ activatedAt: new Date(noon.getTime() - 3600_000) }).where(eq(jobs.id, job.id))
  const made = await generateJobIntervalChecks(noon)
  const rows = await db.select({ at: qualityChecks.scheduledAt }).from(qualityChecks).where(and(eq(qualityChecks.jobId, job.id), eq(qualityChecks.kind, 'JOB_INTERVAL')))
  return rows.filter((r) => dateKey(r.at) === date).length + made * 0
}

results.push(`INFO  open date ${OPEN}, weekly off ${WEEKLY}; schedule ${sched.shift.name} ${sched.shift.startTime}–${sched.shift.endTime}; job on ${machine.name}`)

// ---- 1. Holiday added, then removed
let openDaySlots = 0
{
  const before = [await scheduledSlots(OPEN), await jobChecks(OPEN)]
  openDaySlots = before[0]
  const add = await mark(OPEN, 'HOLIDAY', 'Test holiday')
  const during = [await scheduledSlots(OPEN), await jobChecks(OPEN)]
  const del = await unmark(OPEN)
  const after = [await scheduledSlots(OPEN), await jobChecks(OPEN)]
  check('1a open day: scheduled and job-based tasks are assigned', before[0] > 0 && before[1] > 0, `scheduled ${before[0]}, job ${before[1]}`)
  check('1b marked Holiday: no scheduled and no job-based tasks', add.status === 201 && during[0] === 0 && during[1] === 0, `scheduled ${during[0]}, job ${during[1]}`)
  check('1c holiday removed: both kinds of tasks are assigned again', del.status === 200 && after[0] === before[0] && after[1] > 0 && (await stateOf(OPEN)).closed === false, `scheduled ${after[0]}, job ${after[1]}`)
}

// ---- 2. Plant closed (not a holiday): Plant Closed with a reason, and Shutdown
{
  const closed = await mark(OPEN, 'CLOSED', 'Power cut')
  const st = await stateOf(OPEN)
  const during = [await scheduledSlots(OPEN), await jobChecks(OPEN)]
  check('2a marked Plant Closed with a reason: saved with the reason; no scheduled or job-based tasks', closed.status === 201 && st.closed && st.label === 'Plant Closed' && st.entry?.reason === 'Power cut' && during[0] === 0 && during[1] === 0, `${st.label} "${st.entry?.reason}"; scheduled ${during[0]}, job ${during[1]}`)
  const shut = await mark(OPEN, 'SHUTDOWN', 'Maintenance shutdown')
  const dur2 = [await scheduledSlots(OPEN), await jobChecks(OPEN)]
  check('2b changed to Shutdown: still no tasks', shut.status === 201 && (await stateOf(OPEN)).label === 'Shutdown' && dur2[0] === 0 && dur2[1] === 0, `scheduled ${dur2[0]}, job ${dur2[1]}`)
  const hol = await mark(OPEN, 'HOLIDAY', 'Declared holiday')
  check('2c the same date changed to Holiday: updated in place (one entry)', hol.status === 201 && hol.json?.updated === 1 && (await stateOf(OPEN)).label === 'Holiday')
  await unmark(OPEN)

  // Tasks already created for that day are taken away when it is closed; a job's start and end checks stay with the job.
  const at = atTime(parseDateKey(OPEN), '10:00')
  const base = { machineId: machine.id, activityId: jobType.id, module: 'IPQC' as const, workerId: worker.id, scheduledAt: at, windowEndsAt: new Date(at.getTime() + 900_000), status: 'PENDING' as const }
  // One open check per schedule: the server's own open one for this schedule makes way for the test's.
  await db.delete(qualityChecks).where(and(eq(qualityChecks.scheduleId, sched.schedule.id), inArray(qualityChecks.status, ['PENDING', 'DUE', 'IN_PROGRESS'])))
  const made = await db
    .insert(qualityChecks)
    .values([
      { ...base, code: `TEST-CAL-S-${Date.now()}`, scheduleId: sched.schedule.id, activityId: sched.schedule.activityId },
      { ...base, code: `TEST-CAL-J-${Date.now()}`, jobId: job.id, kind: 'JOB_INTERVAL' as const },
      { ...base, code: `TEST-CAL-START-${Date.now()}`, jobId: job.id, kind: 'JOB_START' as const }
    ])
    .returning({ id: qualityChecks.id, kind: qualityChecks.kind })
  const r = await mark(OPEN, 'CLOSED', 'Power cut')
  const left = await db.select({ kind: qualityChecks.kind }).from(qualityChecks).where(inArray(qualityChecks.id, made.map((m) => m.id)))
  check('2d tasks already assigned for that day are removed (scheduled and job interval); the job\'s start check stays', r.json?.removedChecks >= 2 && left.length === 1 && left[0].kind === 'JOB_START', `removed ${r.json?.removedChecks}, left ${left.map((l) => l.kind).join(',')}`)
  await unmark(OPEN)
  await db.delete(qualityChecks).where(inArray(qualityChecks.id, made.map((m) => m.id)))
}

// ---- 3. Adjustment Working Day
{
  const before = [await scheduledSlots(WEEKLY), await jobChecks(WEEKLY)]
  const add = await mark(WEEKLY, 'WORKING', 'Adjustment for a holiday')
  const st = await stateOf(WEEKLY)
  const during = [await scheduledSlots(WEEKLY), await jobChecks(WEEKLY)]
  const del = await unmark(WEEKLY)
  const after = [await scheduledSlots(WEEKLY), await jobChecks(WEEKLY)]
  check('3a weekly off: no tasks', before[0] === 0 && before[1] === 0, `scheduled ${before[0]}, job ${before[1]}`)
  check('3b Adjustment Working Day on the weekly off: a working day; scheduled and job-based tasks are assigned', add.status === 201 && !st.closed && st.label === 'Adjustment Working Day' && during[0] > 0 && during[1] > 0, `closed ${st.closed}; scheduled ${during[0]}, job ${during[1]}`)
  check('3c adjustment removed: the weekly off applies again, no tasks', del.status === 200 && after[0] === 0 && after[1] === 0, `scheduled ${after[0]}, job ${after[1]}`)
  const open = await mark(OPEN, 'WORKING')
  const onOpen = [await scheduledSlots(OPEN), await jobChecks(OPEN)]
  check('3d Adjustment Working Day on an ordinary open day: tasks as usual', open.status === 201 && onOpen[0] > 0 && onOpen[1] > 0, `scheduled ${onOpen[0]}, job ${onOpen[1]}`)
  await unmark(OPEN)
}

// ---- 4. Past dates are locked
{
  const past = await mark(dateKey(addDays(parseDateKey(today), -1)), 'HOLIDAY')
  check('4 past dates cannot be changed (their checks and scores are recorded)', past.status === 409, `${past.status}`)
}

// ---- 5. Today reopened during the day: checks only from that moment on
{
  const now = new Date()
  const win = occurrences(sched.schedule, sched.shift, startOfDay(now), 1).find((o) => dateKey(o.start) === today)
  const inShift = !!win && win.start < now && now < win.end
  results.push(`INFO  now ${now.toISOString()}; today's ${sched.shift.name} window ${win?.start.toISOString()} – ${win?.end.toISOString()} (${inShift ? 'in the shift' : 'outside the shift'})`)
  // A check submitted earlier today must survive closing and reopening (past records are kept).
  await db.delete(qualityChecks).where(and(eq(qualityChecks.scheduleId, sched.schedule.id), inArray(qualityChecks.status, ['PENDING', 'DUE', 'IN_PROGRESS'])))
  const doneAt = new Date(now.getTime() - 2 * 3600_000)
  const [done] = await db
    .insert(qualityChecks)
    .values({ code: `TEST-CAL-DONE-${Date.now()}`, scheduleId: sched.schedule.id, activityId: sched.schedule.activityId, module: sched.schedule.module ?? 'IPQC', workerId: sched.schedule.workerId, scheduledAt: doneAt, windowEndsAt: new Date(doneAt.getTime() + 900_000), status: 'COMPLETED', submittedAt: doneAt })
    .returning()
  /** Today's checks the generator would make for the schedule now: none may end before `since`. */
  const todays = async () =>
    (await planChecks(new Date(), { ignoreOpen: true })).filter((p) => p.scheduleId === sched.schedule.id && dateKey(p.scheduledAt as Date) === today)
  const fmt = (list: any[]) => list.map((p) => `${(p.scheduledAt as Date).toISOString().slice(11, 16)}Z ${p.status}`).join(', ')

  // a) Holiday today, removed now.
  await mark(today, 'HOLIDAY', 'Test holiday today')
  const closedPlan = await todays()
  const reopenAt = new Date()
  await unmark(today)
  const plan = await todays()
  const early = plan.filter((p) => (p.windowEndsAt as Date) <= reopenAt)
  check('5a today is a holiday: no checks today', closedPlan.length === 0, fmt(closedPlan))
  check(
    '5b holiday removed during the day: nothing before the reopening is created or Missed; checks continue from now',
    early.length === 0 && plan.every((p) => p.status !== 'MISSED') && (!inShift || plan.length >= 1),
    fmt(plan) || 'none (outside the shift)'
  )
  // b) Holiday today, changed to an Adjustment Working Day.
  await mark(today, 'HOLIDAY', 'Test holiday today')
  const reopen2 = new Date()
  await mark(today, 'WORKING', 'Adjustment')
  const plan2 = await todays()
  check(
    '5c Holiday changed to Adjustment Working Day today: same, checks only from now',
    plan2.every((p) => (p.windowEndsAt as Date) > reopen2 && p.status !== 'MISSED') && (!inShift || plan2.length >= 1),
    fmt(plan2) || 'none (outside the shift)'
  )
  await unmark(today)
  const [kept] = await db.select().from(qualityChecks).where(eq(qualityChecks.id, done.id))
  check('5d a check submitted earlier today is kept, with its result', kept?.status === 'COMPLETED')
  // Future dates are not affected by today's reopening.
  check('5e future dates still get every check', (await scheduledSlots(OPEN)) === openDaySlots && openDaySlots > 0, `${openDaySlots} slots`)
  await db.delete(qualityChecks).where(eq(qualityChecks.id, done.id))
}

await db.delete(qualityChecks).where(eq(qualityChecks.jobId, job.id))
await db.delete(jobs).where(eq(jobs.id, job.id))
console.log(results.join('\n'))
console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
await pool.end()
