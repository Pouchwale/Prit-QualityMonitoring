import { and, eq, gte, lt, sql, type SQL } from 'drizzle-orm'
import { db } from '../db/client'
import { departments, jobs, machines, qualityChecks, shifts, users } from '../db/schema'
import { UNRESTRICTED, type DepartmentScope } from './departmentScope'
import { addDays, dateKey, startOfDay, weekdayOf } from '../lib/time'

/**
 * Worker performance: how many checks a worker was given, how many they did, and the score that
 * follows. Nothing here changes how checks are created, assigned or submitted: it only reads them.
 *
 *   counted  = checks whose time is over: submitted, an exception, Missed, or past their window
 *   done     = completed + exceptions (an exception is a reasoned "could not do it", not a miss)
 *   score    = done / counted as a percentage, minus 100   (8 of 10 done = 80%, score -20)
 *
 * A check still open inside its window is not counted yet, so a worker is never marked down during
 * a shift for a check that is not due or still has time left.
 *
 * Everyone who may see performance sees every worker of every department. The department filter
 * is the department of the work, recorded on each check (quality_checks.department_id), not the
 * department on the worker's account: a worker who does Label and Pouch work is counted under
 * Label for their Label checks and under Pouch for their Pouch checks.
 */

/** The `scope` field of the responses: always unrestricted, kept for older app builds that read it. */
export type PerformanceScope = DepartmentScope

/** What this user may see: every worker, whatever the role. */
export async function performanceScope(_user: { id: string; role: string }): Promise<PerformanceScope> {
  return UNRESTRICTED
}

export interface PerformanceFilters {
  from: Date
  /** Exclusive. */
  to: Date
  workerId?: string
  machineId?: string
  shiftId?: string
  activityId?: string
  jobId?: string
  jobNo?: string
  /** Only checks of this department: the department of the work recorded on the check, not the worker's own. */
  departmentId?: string
}

export interface WorkerPerformance {
  workerId: string
  workerName: string
  employeeId: string
  /** Checks given to this worker in the period whose time is over (see the comment at the top). */
  assigned: number
  completed: number
  /** Missed checks: the only ones that lower the score. */
  missed: number
  /** Same as `missed`, kept for older app builds that read it. */
  missedChecks: number
  exceptions: number
  /** Checks still open inside their window: not counted yet. */
  open: number
  /** (completed + exceptions) / assigned as a percentage, minus 100. 0 when nothing was missed. */
  score: number
  /** (completed + exceptions) / assigned as a percentage. */
  completionRate: number
}

function conditions(f: PerformanceFilters): SQL {
  const where: SQL[] = [
    gte(qualityChecks.scheduledAt, f.from),
    lt(qualityChecks.scheduledAt, f.to),
    sql`${qualityChecks.workerId} is not null`
  ]
  if (f.workerId) where.push(eq(qualityChecks.workerId, f.workerId))
  if (f.departmentId) where.push(eq(qualityChecks.departmentId, f.departmentId))
  if (f.machineId) where.push(eq(qualityChecks.machineId, f.machineId))
  if (f.shiftId) where.push(eq(qualityChecks.shiftId, f.shiftId))
  if (f.activityId) where.push(eq(qualityChecks.activityId, f.activityId))
  if (f.jobId) where.push(eq(qualityChecks.jobId, f.jobId))
  if (f.jobNo) {
    const wanted = f.jobNo.trim().toLowerCase()
    where.push(
      sql`(lower(trim(coalesce(${qualityChecks.jobNo}, ''))) = ${wanted} or exists (select 1 from ${jobs} where ${jobs.id} = ${qualityChecks.jobId} and lower(trim(${jobs.jobNo})) = ${wanted}))`
    )
  }
  return and(...where)!
}

const rate = (done: number, assigned: number) => (assigned ? Math.round((done / assigned) * 100) : 100)

/**
 * Completion % minus 100: 8 of 10 done is -20, everything done is 0, nothing done is -100, and a
 * worker with no counted checks at all is 0 rather than -100.
 */
const scoreOf = (done: number, assigned: number) => rate(done, assigned) - 100

/** One row per worker who had checks in the period, worst score first. */
export async function workerPerformance(filters: PerformanceFilters) {
  // A check counts once its time is over: finished, or past the end of its window.
  const counted = sql`(${qualityChecks.status} in ('COMPLETED', 'MISSED', 'EXCEPTION') or ${qualityChecks.windowEndsAt} < now())`
  const rows = await db
    .select({
      workerId: qualityChecks.workerId,
      workerName: users.name,
      employeeId: users.employeeId,
      assigned: sql<number>`count(*) filter (where ${counted})::int`,
      completed: sql<number>`count(*) filter (where ${qualityChecks.status} = 'COMPLETED')::int`,
      exceptions: sql<number>`count(*) filter (where ${qualityChecks.status} = 'EXCEPTION')::int`,
      // Still open past its window: the scheduler marks it Missed within a minute, so it is missed now.
      missed: sql<number>`count(*) filter (where ${qualityChecks.status} = 'MISSED' or (${qualityChecks.status} in ('PENDING', 'DUE', 'IN_PROGRESS') and ${qualityChecks.windowEndsAt} < now()))::int`,
      open: sql<number>`count(*) filter (where not ${counted})::int`
    })
    .from(qualityChecks)
    .innerJoin(users, eq(users.id, qualityChecks.workerId))
    .where(conditions(filters))
    .groupBy(qualityChecks.workerId, users.name, users.employeeId)

  const workers: WorkerPerformance[] = rows
    .map((r) => ({
      workerId: r.workerId!,
      workerName: r.workerName,
      employeeId: r.employeeId,
      assigned: r.assigned,
      completed: r.completed,
      missed: r.missed,
      missedChecks: r.missed,
      exceptions: r.exceptions,
      open: r.open,
      score: scoreOf(r.completed + r.exceptions, r.assigned),
      completionRate: rate(r.completed + r.exceptions, r.assigned)
    }))
    .sort((a, b) => a.score - b.score || b.assigned - a.assigned || a.workerName.localeCompare(b.workerName))

  const total = (key: 'assigned' | 'completed' | 'missed' | 'exceptions' | 'open') => workers.reduce((n, w) => n + w[key], 0)
  const assigned = total('assigned')
  const done = total('completed') + total('exceptions')
  return {
    totals: {
      workers: workers.length,
      assigned,
      completed: total('completed'),
      missed: total('missed'),
      exceptions: total('exceptions'),
      open: total('open'),
      score: scoreOf(done, assigned),
      completionRate: rate(done, assigned)
    },
    workers
  }
}

/** One worker's own figures; an empty period is reported as zeros, not as "no data". */
export async function performanceOf(workerId: string, filters: Omit<PerformanceFilters, 'workerId'>): Promise<WorkerPerformance> {
  const result = await workerPerformance({ ...filters, workerId })
  const found = result.workers.find((w) => w.workerId === workerId)
  if (found) return found
  const [user] = await db.select({ name: users.name, employeeId: users.employeeId }).from(users).where(eq(users.id, workerId))
  return {
    workerId,
    workerName: user?.name ?? '',
    employeeId: user?.employeeId ?? '',
    assigned: 0,
    completed: 0,
    missed: 0,
    missedChecks: 0,
    exceptions: 0,
    open: 0,
    score: 0,
    completionRate: 100
  }
}

/**
 * Values for the filter dropdowns: the active machines and shifts, every department and every
 * worker. `scope` is sent back for older app builds that still read it.
 */
export async function performanceFilterValues(scope: PerformanceScope) {
  const [machineRows, shiftRows, departmentRows, workerRows] = await Promise.all([
    db.select({ id: machines.id, name: machines.name }).from(machines).where(eq(machines.isActive, true)).orderBy(machines.name),
    db.select({ id: shifts.id, name: shifts.name }).from(shifts).where(eq(shifts.isActive, true)).orderBy(shifts.name),
    db.select({ id: departments.id, name: departments.name }).from(departments).orderBy(departments.name),
    db
      .select({ id: users.id, name: users.name, employeeId: users.employeeId, departmentId: users.departmentId })
      .from(users)
      .where(eq(users.role, 'WORKER'))
      .orderBy(users.name)
  ])
  return { machines: machineRows, shifts: shiftRows, departments: departmentRows, workers: workerRows, scope }
}

// ------------------------------------------------------------------------------- weekly report

export interface DayScore {
  /** Checks whose time is over (completed + exceptions + missed); pending ones are not counted yet. */
  assigned: number
  /** Completed + exceptions: an exception is a reasoned "could not do it", never a miss. */
  done: number
  completed: number
  exceptions: number
  missed: number
  pending: number
  /** Completion % minus 100 (0 = everything done); null on a day with nothing counted. */
  score: number | null
}

const dayScore = (w: WorkerPerformance | undefined): DayScore => {
  const assigned = w?.assigned ?? 0
  const done = (w?.completed ?? 0) + (w?.exceptions ?? 0)
  return {
    assigned,
    done,
    completed: w?.completed ?? 0,
    exceptions: w?.exceptions ?? 0,
    missed: w?.missed ?? 0,
    pending: w?.open ?? 0,
    score: assigned ? scoreOf(done, assigned) : null
  }
}

/**
 * Day-wise scores of every worker for one week, Monday to Saturday (plant time), with the same
 * counts and score as the Performance page. The week score is worked out from the whole week's
 * checks (not an average of the days), so a busy day weighs more than a quiet one. The team average
 * is the mean week score of the workers who had checks.
 */
/** `onlyWorkerId`: one worker's own week (the worker app); without it every worker (Admins). */
export async function weeklyScores(anyDay: Date, onlyWorkerId?: string) {
  const day = startOfDay(anyDay)
  const monday = addDays(day, -((weekdayOf(day) + 6) % 7))
  const days = Array.from({ length: 6 }, (_, i) => addDays(monday, i))
  const [daily, week, people] = await Promise.all([
    Promise.all(days.map((d) => workerPerformance({ from: d, to: addDays(d, 1), workerId: onlyWorkerId }))),
    workerPerformance({ from: monday, to: addDays(monday, 6), workerId: onlyWorkerId }),
    db
      .select({ id: users.id, name: users.name, employeeId: users.employeeId, isActive: users.isActive, department: departments.name })
      .from(users)
      .leftJoin(departments, eq(departments.id, users.departmentId))
      .where(onlyWorkerId ? eq(users.id, onlyWorkerId) : eq(users.role, 'WORKER'))
  ])
  const byDay = daily.map((r) => new Map(r.workers.map((w) => [w.workerId, w])))
  const byWeek = new Map(week.workers.map((w) => [w.workerId, w]))
  const rows = people
    // Every active worker; a disabled one only when they had checks this week.
    .filter((p) => p.isActive || byWeek.has(p.id))
    .map((p) => ({
      workerId: p.id,
      name: p.name,
      employeeId: p.employeeId,
      department: p.department,
      days: byDay.map((m) => dayScore(m.get(p.id))),
      week: dayScore(byWeek.get(p.id))
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
  const scored = rows.map((r) => r.week.score).filter((s): s is number => s !== null)
  return {
    weekStart: dateKey(monday),
    days: days.map((d) => dateKey(d)),
    rows,
    teamAverage: scored.length ? Math.round(scored.reduce((a, b) => a + b, 0) / scored.length) : null
  }
}
