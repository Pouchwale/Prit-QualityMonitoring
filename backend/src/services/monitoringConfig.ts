import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, sql, type SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { db } from '../db/client'
import {
  activities,
  activityParameters,
  departments,
  jobHandovers,
  jobs,
  machineActivities,
  machines,
  monitoringReasons,
  parameters,
  qualityChecks,
  scheduleTimers,
  schedules,
  shifts,
  users
} from '../db/schema'
import { ruleText } from './evaluate'
import { RUNNING_STATUSES } from './jobMonitoring'

/**
 * Reference data behind the Monitoring Setup screens: the Not Applicable reasons, the
 * production jobs log and the machine-wise overview of check types, schedules and parameters.
 *
 * The worker app reads the same tables (routes/worker.ts), so everything here is a read of the
 * live configuration — nothing is cached.
 */

const starter = alias(users, 'job_starter')
const ender = alias(users, 'job_ender')

export interface MonitoringReasonDto {
  id: string
  label: string
  requiresRemark: boolean
  isActive: boolean
  sortOrder: number
}

const reasonDto = (row: typeof monitoringReasons.$inferSelect): MonitoringReasonDto => ({
  id: row.id,
  label: row.label,
  requiresRemark: row.requiresRemark,
  isActive: row.isActive,
  sortOrder: row.sortOrder
})

/**
 * Every reason, active ones first in their sort order. Admins see the disabled ones too, so a
 * reason a worker picked months ago can still be recognised.
 *
 * There is deliberately no "keep at least one" rule: an admin may disable them all. The worker
 * app then simply offers no reason list, so a parameter cannot be marked Not Applicable by hand
 * (a JOB_RUNNING parameter is still skipped automatically with its built-in reason).
 */
export async function listMonitoringReasons(): Promise<MonitoringReasonDto[]> {
  const rows = await db
    .select()
    .from(monitoringReasons)
    .orderBy(desc(monitoringReasons.isActive), asc(monitoringReasons.sortOrder), asc(monitoringReasons.label))
  return rows.map(reasonDto)
}

export async function monitoringReasonById(id: string) {
  const [row] = await db.select().from(monitoringReasons).where(eq(monitoringReasons.id, id))
  return row ?? null
}

export { reasonDto }

export interface JobCheckCounts {
  /** Every check recorded against the job. */
  total: number
  /** Open: not due yet, or due and not submitted. */
  pending: number
  due: number
  /** Due and past its window grace, still not done (Job Start / End checks stay open). */
  overdue: number
  completed: number
  missed: number
  exception: number
}

export interface JobRow {
  id: string
  machineId: string
  machineName: string
  machineCode: string
  itemCode: string | null
  jobNo: string
  status: (typeof jobs.$inferSelect)['status']
  /** Null while the job is only planned. */
  startedAt: Date | null
  startedById: string | null
  startedByName: string | null
  activatedAt: Date | null
  endRequestedAt: Date | null
  endedAt: Date | null
  endedById: string | null
  endedByName: string | null
  /** The worker responsible now. */
  assignedWorkerId: string | null
  assignedWorkerName: string | null
  plannedFor: string | null
  note: string | null
  forceClosed: boolean
  /** NONE: no Job Start/End parameters. PENDING: open. DONE: submitted. */
  startCheck: 'NONE' | 'PENDING' | 'DONE'
  endCheck: 'NONE' | 'PENDING' | 'DONE'
  handovers: number
  counts: JobCheckCounts
  /** Checks recorded against this job (quality_checks.job_id). */
  checkCount: number
  /** Minutes from start to end, or to now while the job is still running (0 while planned). */
  durationMinutes: number
}

export interface JobFilters {
  /** Jobs started (or, when not started, created) on or after this moment. */
  from?: Date
  /** ... and before this moment (exclusive, so callers pass the day after "to"). */
  to?: Date
  machineId?: string
  /** true: only running jobs. false: only finished jobs. Undefined: both. */
  running?: boolean
  statuses?: (typeof jobs.$inferSelect)['status'][]
  ids?: string[]
}

const assignee = alias(users, 'job_assignee')

/** The production jobs log: newest first, with the machine, the workers and the check status. */
export async function listJobs(filters: JobFilters = {}): Promise<JobRow[]> {
  const where: SQL[] = []
  const when = sql`coalesce(${jobs.startedAt}, ${jobs.createdAt})`
  if (filters.from) where.push(sql`${when} >= ${filters.from}`)
  if (filters.to) where.push(sql`${when} < ${filters.to}`)
  if (filters.machineId) where.push(eq(jobs.machineId, filters.machineId))
  if (filters.running === true) where.push(inArray(jobs.status, [...RUNNING_STATUSES]))
  if (filters.running === false) where.push(inArray(jobs.status, ['COMPLETED', 'CANCELLED']))
  if (filters.statuses?.length) where.push(inArray(jobs.status, filters.statuses))
  if (filters.ids) where.push(inArray(jobs.id, filters.ids.length ? filters.ids : ['00000000-0000-0000-0000-000000000000']))

  const rows = await db
    .select({
      job: jobs,
      machineName: machines.name,
      machineCode: machines.code,
      startedByName: starter.name,
      endedByName: ender.name,
      assignedWorkerName: assignee.name
    })
    .from(jobs)
    .innerJoin(machines, eq(jobs.machineId, machines.id))
    .leftJoin(starter, eq(jobs.startedById, starter.id))
    .leftJoin(ender, eq(jobs.endedById, ender.id))
    .leftJoin(assignee, eq(jobs.assignedWorkerId, assignee.id))
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(when))

  const ids = rows.map((r) => r.job.id)
  const [checkRows, handoverRows] = ids.length
    ? await Promise.all([
        db
          .select({
            jobId: qualityChecks.jobId,
            kind: qualityChecks.kind,
            status: qualityChecks.status,
            scheduledAt: qualityChecks.scheduledAt,
            graceMinutes: activities.graceMinutes
          })
          .from(qualityChecks)
          .innerJoin(activities, eq(qualityChecks.activityId, activities.id))
          .where(inArray(qualityChecks.jobId, ids)),
        db.select({ jobId: jobHandovers.jobId }).from(jobHandovers).where(inArray(jobHandovers.jobId, ids))
      ])
    : [[], []]

  const now = Date.now()
  const open = (status: string) => status === 'PENDING' || status === 'DUE' || status === 'IN_PROGRESS'
  const edge = (list: typeof checkRows, kind: 'JOB_START' | 'JOB_END'): JobRow['startCheck'] => {
    const mine = list.filter((c) => c.kind === kind)
    if (mine.length === 0) return 'NONE'
    return mine.some((c) => open(c.status)) ? 'PENDING' : 'DONE'
  }
  return rows.map((r) => {
    const list = checkRows.filter((c) => c.jobId === r.job.id)
    const counts: JobCheckCounts = {
      total: list.length,
      pending: list.filter((c) => c.status === 'PENDING').length,
      due: list.filter((c) => c.status === 'DUE' || c.status === 'IN_PROGRESS').length,
      overdue: list.filter((c) => (c.status === 'DUE' || c.status === 'IN_PROGRESS') && +c.scheduledAt + c.graceMinutes * 60_000 < now).length,
      completed: list.filter((c) => c.status === 'COMPLETED').length,
      missed: list.filter((c) => c.status === 'MISSED').length,
      exception: list.filter((c) => c.status === 'EXCEPTION').length
    }
    return {
      id: r.job.id,
      machineId: r.job.machineId,
      machineName: r.machineName,
      machineCode: r.machineCode,
      itemCode: r.job.itemCode,
      jobNo: r.job.jobNo,
      status: r.job.status,
      startedAt: r.job.startedAt,
      startedById: r.job.startedById,
      startedByName: r.startedByName,
      activatedAt: r.job.activatedAt,
      endRequestedAt: r.job.endRequestedAt,
      endedAt: r.job.endedAt,
      endedById: r.job.endedById,
      endedByName: r.endedByName,
      assignedWorkerId: r.job.assignedWorkerId,
      assignedWorkerName: r.assignedWorkerName,
      plannedFor: r.job.plannedFor,
      note: r.job.note,
      forceClosed: r.job.forceClosed,
      startCheck: edge(list, 'JOB_START'),
      endCheck: edge(list, 'JOB_END'),
      handovers: handoverRows.filter((h) => h.jobId === r.job.id).length,
      counts,
      checkCount: list.length,
      durationMinutes: r.job.startedAt ? Math.max(0, Math.round(((r.job.endedAt ? +r.job.endedAt : now) - +r.job.startedAt) / 60_000)) : 0
    }
  })
}

export interface OverviewSchedule {
  id: string
  shiftId: string
  shiftName: string
  intervalMinutes: number
  mode: 'INTERVAL' | 'JOB'
  startTime: string
  endTime: string
  isActive: boolean
  workerId: string | null
  workerName: string | null
  /** From schedule_timers: when this schedule's next check is due. */
  nextDueAt: Date | null
  lastSubmittedAt: Date | null
}

export interface OverviewParameter {
  parameterId: string
  name: string
  code: string
  type: (typeof parameters.$inferSelect)['type']
  unit: string | null
  /** Human-readable acceptance rule, e.g. "18 – 22 sec". */
  rule: string | null
  isRequired: boolean
  isEnabled: boolean
  requirePhoto: boolean
  requireVideo: boolean
  allowNa: boolean
  appliesWhen: 'ALWAYS' | 'JOB_RUNNING'
  sortOrder: number
}

export interface OverviewCheckType {
  activityId: string
  activityName: string
  activityCode: string
  isActive: boolean
  allowManual: boolean
  requireJobNo: boolean
  requirePhoto: boolean
  requireVideo: boolean
  /** JOB when any schedule on this machine is JOB, INTERVAL when there are interval schedules, else MANUAL. */
  mode: 'INTERVAL' | 'JOB' | 'MANUAL'
  schedules: OverviewSchedule[]
  parameters: OverviewParameter[]
}

export interface OverviewMachine {
  id: string
  name: string
  code: string
  status: (typeof machines.$inferSelect)['status']
  departmentName: string | null
  runningJob: {
    id: string
    machineId: string
    itemCode: string | null
    jobNo: string
    startedAt: Date | null
    startedById: string | null
    startedByName: string | null
    endedAt: Date | null
  } | null
  checkTypes: OverviewCheckType[]
}

/**
 * The whole monitoring configuration, machine by machine: which check types run on each machine,
 * in which mode, on which schedules (with the live rolling timer) and with which parameters.
 * This is the admin-side mirror of GET /api/worker/machines.
 */
export async function monitoringOverview(): Promise<OverviewMachine[]> {
  const [machineRows, links, scheduleRows, paramRows, runningRows] = await Promise.all([
    db
      .select({ machine: machines, departmentName: departments.name })
      .from(machines)
      .leftJoin(departments, eq(machines.departmentId, departments.id))
      .orderBy(asc(machines.name)),
    db
      .select({ machineId: machineActivities.machineId, activity: activities })
      .from(machineActivities)
      .innerJoin(activities, eq(machineActivities.activityId, activities.id))
      .orderBy(asc(activities.name)),
    db
      .select({
        schedule: schedules,
        shiftName: shifts.name,
        shiftStart: shifts.startTime,
        shiftEnd: shifts.endTime,
        workerName: users.name,
        nextDueAt: scheduleTimers.nextDueAt,
        lastSubmittedAt: scheduleTimers.lastSubmittedAt
      })
      .from(schedules)
      .innerJoin(shifts, eq(schedules.shiftId, shifts.id))
      .leftJoin(users, eq(schedules.workerId, users.id))
      .leftJoin(scheduleTimers, eq(scheduleTimers.scheduleId, schedules.id))
      .orderBy(asc(shifts.startTime)),
    db
      .select({
        activityId: activityParameters.activityId,
        parameterId: activityParameters.parameterId,
        sortOrder: activityParameters.sortOrder,
        isRequired: activityParameters.isRequired,
        isEnabled: activityParameters.isEnabled,
        requirePhoto: activityParameters.requirePhoto,
        requireVideo: activityParameters.requireVideo,
        allowNa: activityParameters.allowNa,
        appliesWhen: activityParameters.appliesWhen,
        name: parameters.name,
        code: parameters.code,
        type: parameters.type,
        unit: parameters.unit,
        minValue: parameters.minValue,
        maxValue: parameters.maxValue,
        options: parameters.options
      })
      .from(activityParameters)
      .innerJoin(parameters, eq(activityParameters.parameterId, parameters.id))
      .orderBy(asc(activityParameters.sortOrder)),
    db
      .select({ job: jobs, startedByName: users.name })
      .from(jobs)
      .leftJoin(users, eq(jobs.startedById, users.id))
      .where(inArray(jobs.status, [...RUNNING_STATUSES]))
  ])

  return machineRows.map(({ machine, departmentName }) => {
    const job = runningRows.find((r) => r.job.machineId === machine.id) ?? null
    return {
      id: machine.id,
      name: machine.name,
      code: machine.code,
      status: machine.status,
      departmentName,
      runningJob: job
        ? {
            id: job.job.id,
            machineId: job.job.machineId,
            itemCode: job.job.itemCode,
            jobNo: job.job.jobNo,
            startedAt: job.job.startedAt,
            startedById: job.job.startedById,
            startedByName: job.startedByName,
            endedAt: job.job.endedAt
          }
        : null,
      checkTypes: links
        .filter((l) => l.machineId === machine.id)
        .map(({ activity }) => {
          const forType = scheduleRows.filter(
            (s) => s.schedule.machineId === machine.id && s.schedule.activityId === activity.id
          )
          // Same derivation as the worker app, so both screens show the same mode.
          const active = forType.filter((s) => s.schedule.isActive)
          const mode =
            active.length === 0 ? 'MANUAL' : active.some((s) => s.schedule.mode === 'JOB') ? 'JOB' : 'INTERVAL'
          return {
            activityId: activity.id,
            activityName: activity.name,
            activityCode: activity.code,
            isActive: activity.isActive,
            allowManual: activity.allowManual,
            requireJobNo: activity.requireJobNo,
            /** "Overall check photo/video", next to the per-parameter evidence rules below. */
            requirePhoto: activity.requirePhoto,
            requireVideo: activity.requireVideo,
            mode: mode as 'INTERVAL' | 'JOB' | 'MANUAL',
            schedules: forType.map((s) => ({
              id: s.schedule.id,
              shiftId: s.schedule.shiftId,
              shiftName: s.shiftName,
              intervalMinutes: s.schedule.intervalMinutes,
              mode: s.schedule.mode,
              startTime: s.schedule.startTime ?? s.shiftStart,
              endTime: s.schedule.endTime ?? s.shiftEnd,
              isActive: s.schedule.isActive,
              workerId: s.schedule.workerId,
              workerName: s.workerName,
              nextDueAt: s.nextDueAt ?? null,
              lastSubmittedAt: s.lastSubmittedAt ?? null
            })),
            parameters: paramRows
              .filter((p) => p.activityId === activity.id)
              .map((p) => ({
                parameterId: p.parameterId,
                name: p.name,
                code: p.code,
                type: p.type,
                unit: p.unit,
                rule: ruleText({
                  name: p.name,
                  type: p.type,
                  unit: p.unit,
                  minValue: p.minValue,
                  maxValue: p.maxValue,
                  options: p.options
                }),
                isRequired: p.isRequired,
                isEnabled: p.isEnabled,
                requirePhoto: p.requirePhoto,
                requireVideo: p.requireVideo,
                allowNa: p.allowNa,
                appliesWhen: p.appliesWhen,
                sortOrder: p.sortOrder
              }))
          }
        })
    }
  })
}
