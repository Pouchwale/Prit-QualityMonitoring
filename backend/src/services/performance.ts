import { and, count, desc, eq, gte, lt, sql, type SQL } from 'drizzle-orm'
import { db } from '../db/client'
import { departments, jobs, machines, qualityChecks, scoreSettingHistory, scoreSettings, shifts, users } from '../db/schema'

/**
 * Worker performance: how many checks a worker was given, how many were completed, and the score
 * that follows from the missed ones. The scoring rule lives in the database (score_settings), so an
 * Admin changes it in the admin panel without a new build.
 *
 *   missed = assigned - completed
 *   score  = missed x penaltyPerMissed        (default penalty -1, so 10 missed = -10)
 *
 * Nothing here changes how checks are created, assigned or submitted: it only reads them.
 *
 * Departments decide who may see whom: an Admin or the Super Admin sees every worker and can
 * filter by department; a Manager only ever sees the workers of their own department, whatever the
 * request asks for.
 */

export interface PerformanceScope {
  /** The department a Manager is limited to; null for an Admin (no limit). */
  departmentId: string | null
  departmentName: string | null
  /** True when the caller only sees one department. */
  restricted: boolean
  /** A Manager whose account has no department sees nobody until an Admin sets one. */
  missingDepartment: boolean
}

/** What this user may see. Read from the database each time, so a change applies at once. */
export async function performanceScope(user: { id: string; role: string }): Promise<PerformanceScope> {
  if (user.role !== 'MANAGER') return { departmentId: null, departmentName: null, restricted: false, missingDepartment: false }
  const [row] = await db
    .select({ departmentId: users.departmentId, departmentName: departments.name })
    .from(users)
    .leftJoin(departments, eq(departments.id, users.departmentId))
    .where(eq(users.id, user.id))
  return {
    departmentId: row?.departmentId ?? null,
    departmentName: row?.departmentName ?? null,
    restricted: true,
    missingDepartment: !row?.departmentId
  }
}

/** The department a worker belongs to, for checking a Manager may open them. */
export async function departmentOfWorker(workerId: string): Promise<string | null> {
  const [row] = await db.select({ departmentId: users.departmentId }).from(users).where(eq(users.id, workerId))
  return row?.departmentId ?? null
}

export interface ScoreSetting {
  penaltyPerMissed: number
  updatedAt: Date
  updatedById: string | null
}

/** The scoring rule in force. Created with the default penalty of -1 the first time it is needed. */
export async function activeScoreSetting(): Promise<ScoreSetting> {
  const [row] = await db.select().from(scoreSettings).where(eq(scoreSettings.isActive, true)).limit(1)
  if (row) return { penaltyPerMissed: row.penaltyPerMissed, updatedAt: row.updatedAt, updatedById: row.updatedById }
  const [created] = await db.insert(scoreSettings).values({}).onConflictDoNothing().returning()
  if (created) return { penaltyPerMissed: created.penaltyPerMissed, updatedAt: created.updatedAt, updatedById: created.updatedById }
  // Another request created it at the same moment.
  const [existing] = await db.select().from(scoreSettings).where(eq(scoreSettings.isActive, true)).limit(1)
  return { penaltyPerMissed: existing.penaltyPerMissed, updatedAt: existing.updatedAt, updatedById: existing.updatedById }
}

/** Changes the penalty and records what it was, what it became and who changed it. */
export async function setPenaltyPerMissed(penaltyPerMissed: number, userId: string): Promise<{ previous: number; current: number }> {
  const before = await activeScoreSetting()
  if (before.penaltyPerMissed === penaltyPerMissed) return { previous: before.penaltyPerMissed, current: penaltyPerMissed }
  await db.transaction(async (tx) => {
    await tx
      .update(scoreSettings)
      .set({ penaltyPerMissed, updatedById: userId, updatedAt: new Date() })
      .where(eq(scoreSettings.isActive, true))
    await tx.insert(scoreSettingHistory).values({ previousPenalty: before.penaltyPerMissed, newPenalty: penaltyPerMissed, changedById: userId })
  })
  return { previous: before.penaltyPerMissed, current: penaltyPerMissed }
}

/** Every change of the scoring rule, newest first. */
export async function penaltyHistory(limit = 50) {
  const rows = await db
    .select({
      id: scoreSettingHistory.id,
      previousPenalty: scoreSettingHistory.previousPenalty,
      newPenalty: scoreSettingHistory.newPenalty,
      changedAt: scoreSettingHistory.changedAt,
      changedById: scoreSettingHistory.changedById,
      changedByName: users.name,
      changedByEmployeeId: users.employeeId
    })
    .from(scoreSettingHistory)
    .leftJoin(users, eq(users.id, scoreSettingHistory.changedById))
    .orderBy(desc(scoreSettingHistory.changedAt))
    .limit(limit)
  return rows
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
  /** Only workers of this department (the worker's own department, not the machine's). */
  departmentId?: string
  /** Nobody may be seen (a Manager without a department). */
  none?: boolean
}

export interface WorkerPerformance {
  workerId: string
  workerName: string
  employeeId: string
  /** Every check given to this worker in the period. */
  assigned: number
  completed: number
  /** assigned - completed: what the score is based on. */
  missed: number
  /** The breakdown of those missed: gone past their time, an exception, or still open. */
  missedChecks: number
  exceptions: number
  open: number
  /** missed x penaltyPerMissed. */
  score: number
  /** For reference only; the score is not a percentage. */
  completionRate: number
}

function conditions(f: PerformanceFilters): SQL {
  if (f.none) return sql`false`
  const where: SQL[] = [
    gte(qualityChecks.scheduledAt, f.from),
    lt(qualityChecks.scheduledAt, f.to),
    sql`${qualityChecks.workerId} is not null`
  ]
  if (f.workerId) where.push(eq(qualityChecks.workerId, f.workerId))
  if (f.departmentId) where.push(eq(users.departmentId, f.departmentId))
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

const rate = (completed: number, assigned: number) => (assigned ? Math.round((completed / assigned) * 100) : 100)

/**
 * One row per worker who had checks in the period, worst score first. `penaltyPerMissed` is the
 * rule that was applied, so the caller can show it next to the numbers.
 */
export async function workerPerformance(filters: PerformanceFilters) {
  const { penaltyPerMissed } = await activeScoreSetting()
  if (filters.none) {
    return { penaltyPerMissed, totals: { workers: 0, assigned: 0, completed: 0, missed: 0, score: 0, completionRate: 100 }, workers: [] as WorkerPerformance[] }
  }
  const rows = await db
    .select({
      workerId: qualityChecks.workerId,
      workerName: users.name,
      employeeId: users.employeeId,
      assigned: count(),
      completed: sql<number>`count(*) filter (where ${qualityChecks.status} = 'COMPLETED')::int`,
      missedChecks: sql<number>`count(*) filter (where ${qualityChecks.status} = 'MISSED')::int`,
      exceptions: sql<number>`count(*) filter (where ${qualityChecks.status} = 'EXCEPTION')::int`,
      open: sql<number>`count(*) filter (where ${qualityChecks.status} in ('PENDING', 'DUE', 'IN_PROGRESS'))::int`
    })
    .from(qualityChecks)
    .innerJoin(users, eq(users.id, qualityChecks.workerId))
    .where(conditions(filters))
    .groupBy(qualityChecks.workerId, users.name, users.employeeId)

  const workers: WorkerPerformance[] = rows
    .map((r) => {
      const missed = r.assigned - r.completed
      return {
        workerId: r.workerId!,
        workerName: r.workerName,
        employeeId: r.employeeId,
        assigned: r.assigned,
        completed: r.completed,
        missed,
        missedChecks: r.missedChecks,
        exceptions: r.exceptions,
        open: r.open,
        score: missed * penaltyPerMissed,
        completionRate: rate(r.completed, r.assigned)
      }
    })
    .sort((a, b) => a.score - b.score || b.assigned - a.assigned || a.workerName.localeCompare(b.workerName))

  const assigned = workers.reduce((n, w) => n + w.assigned, 0)
  const completed = workers.reduce((n, w) => n + w.completed, 0)
  return {
    penaltyPerMissed,
    totals: {
      workers: workers.length,
      assigned,
      completed,
      missed: assigned - completed,
      score: (assigned - completed) * penaltyPerMissed,
      completionRate: rate(completed, assigned)
    },
    workers
  }
}

/** One worker's own figures; an empty period is reported as zeros, not as "no data". */
export async function performanceOf(workerId: string, filters: Omit<PerformanceFilters, 'workerId'>): Promise<WorkerPerformance & { penaltyPerMissed: number }> {
  const result = await workerPerformance({ ...filters, workerId })
  const found = result.workers.find((w) => w.workerId === workerId)
  if (found) return { ...found, penaltyPerMissed: result.penaltyPerMissed }
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
    completionRate: 100,
    penaltyPerMissed: result.penaltyPerMissed
  }
}

/**
 * Values for the filter dropdowns. A Manager only gets their own department and its workers, so
 * the page cannot even offer another department.
 */
export async function performanceFilterValues(scope: PerformanceScope) {
  const [machineRows, shiftRows, departmentRows, workerRows] = await Promise.all([
    db.select({ id: machines.id, name: machines.name }).from(machines).where(eq(machines.isActive, true)).orderBy(machines.name),
    db.select({ id: shifts.id, name: shifts.name }).from(shifts).where(eq(shifts.isActive, true)).orderBy(shifts.name),
    scope.restricted
      ? scope.departmentId
        ? db.select({ id: departments.id, name: departments.name }).from(departments).where(eq(departments.id, scope.departmentId))
        : Promise.resolve([])
      : db.select({ id: departments.id, name: departments.name }).from(departments).orderBy(departments.name),
    db
      .select({ id: users.id, name: users.name, employeeId: users.employeeId, departmentId: users.departmentId })
      .from(users)
      .where(
        scope.restricted
          ? scope.departmentId
            ? and(eq(users.role, 'WORKER'), eq(users.departmentId, scope.departmentId))!
            : sql`false`
          : eq(users.role, 'WORKER')
      )
      .orderBy(users.name)
  ])
  return { machines: machineRows, shifts: shiftRows, departments: departmentRows, workers: workerRows, scope }
}
