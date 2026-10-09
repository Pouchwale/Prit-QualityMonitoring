import { Router, type Request } from 'express'
import { z } from 'zod'
import { and, asc, count, desc, eq, gte, ilike, inArray, isNotNull, isNull, lt, or, sql, type SQL } from 'drizzle-orm'
import { db } from '../db/client'
import {
  activities,
  auditLogs,
  checkExceptions,
  departments,
  jobs,
  machineActivities,
  machines,
  exceptionReasons,
  monitoringReasons,
  qualityChecks,
  schedules,
  settings,
  shifts,
  users,
  moduleNotificationAssignments
} from '../db/schema'
import { idParam, optionalUuid } from '../lib/validate'
import { badRequest, forbidden, notFound } from '../lib/http'
import { audit } from '../lib/audit'
import { canView, requireAnyView, requireModule } from '../lib/permissions'
import { CHECK_RESULTS, RESULT_LABEL, RESULT_STATUSES, resultOf } from '../lib/result'
import { addDays, dateKey, formatLocalDate, parseDateKey, startOfDay } from '../lib/time'
import { countChecks, listChecks } from '../services/checks'
import { blockAll, departmentScope, scopedDepartmentId, seesNothing } from '../services/departmentScope'
import { buildQualityReport } from '../services/reportData'
import { buildTraceReport } from '../services/traceReport'
import { renderQualityReport } from '../services/reportPdf'
import { config } from '../config'
import { shiftAt } from '../services/shiftTime'
import { RUNNING_STATUSES } from '../services/jobMonitoring'
import { closureOn, plansBetween } from '../services/plantCalendar'
import { machineClosureOn } from '../services/machineDays'
import { makeCheckCode, prepareChecksForRead } from '../services/checkGenerator'
import { sendTestNotification } from '../services/notifications'
import {
  exceptionReasonById,
  exceptionReasonDto,
  listExceptionReasons,
  listMonitoringReasons,
  monitoringOverview,
  monitoringReasonById,
  reasonDto
} from '../services/monitoringConfig'

export const monitoringRouter = Router()

/**
 * Department scope of this request. Everything the dashboards, lists and reports read goes
 * through this. No role is limited to a department any more (services/departmentScope.ts), so
 * everyone sees the whole plant: `departmentId` is just the department the request filters by,
 * and `where` adds nothing.
 */
async function scopeFor(req: Request, requested?: string) {
  const scope = await departmentScope(req.user!)
  const departmentId = scopedDepartmentId(scope, requested)
  return { scope, departmentId, where: seesNothing(scope) ? blockAll : undefined }
}

const formatDay = (d: Date) => formatLocalDate(d)

/** At most this many checks are returned by one list request. */
const LIST_LIMIT = 5000

/** The only statuses that can be filtered on or shown. Unfinished checks have no status yet. */
const CHECK_STATUSES = ['COMPLETED', 'MISSED', 'EXCEPTION'] as const

/** The longest period one list, dashboard or report may cover. */
const MAX_RANGE_DAYS = 366

/** Reads ?date=YYYY-MM-DD or ?from=&to= (inclusive dates). Defaults to today. */
function dateRange(req: Request) {
  const q = z
    .object({ date: z.string().optional(), from: z.string().optional(), to: z.string().optional() })
    .parse(req.query)
  try {
    const from = q.from ? parseDateKey(q.from) : q.date ? parseDateKey(q.date) : startOfDay(new Date())
    const toInclusive = q.to ? parseDateKey(q.to) : q.date ? parseDateKey(q.date) : from
    if (toInclusive < from) throw badRequest('"to" date must be on or after "from" date')
    if (toInclusive.getTime() - from.getTime() > MAX_RANGE_DAYS * 24 * 60 * 60_000) {
      throw badRequest(`Choose a period of at most ${MAX_RANGE_DAYS} days`)
    }
    return { from, to: addDays(toInclusive, 1) }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Invalid date')) throw badRequest(err.message)
    throw err
  }
}

/**
 * Brings checks up to date (statuses, the next check of every schedule) before a page reads them.
 * The checks are rolling, one open check per schedule, so the requested days do not matter.
 */
async function prepareRange(_from: Date, _to: Date) {
  await prepareChecksForRead()
}

const checkFilters = z.object({
  status: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',') : []))
    .pipe(z.array(z.enum(CHECK_STATUSES))),
  /** Overall result filter (Completed / Missed / Exception); combines with status. */
  result: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',') : []))
    .pipe(z.array(z.enum(CHECK_RESULTS))),
  machineId: z.uuid().optional(),
  workerId: z.uuid().optional(),
  shiftId: z.uuid().optional(),
  activityId: z.uuid().optional(),
  departmentId: z.uuid().optional(),
  module: z.enum(['IPQC', 'QC']).optional(),
  /** Whole Item Code / PO No., case-insensitive (the check's own, or its job's). */
  itemCode: z.string().trim().max(60).optional(),
  jobNo: z.string().trim().max(60).optional()
})

/**
 * Status and result filters combined into the statuses to query. When both are given, only
 * statuses matching both are kept; if none do, `ids: []` makes the query return nothing.
 */
function statusScope(f: { status: (typeof CHECK_STATUSES)[number][]; result: (typeof CHECK_RESULTS)[number][] }) {
  if (!f.result.length) return { statuses: f.status }
  const fromResult = f.result.flatMap((r) => RESULT_STATUSES[r])
  if (!f.status.length) return { statuses: fromResult }
  const both = f.status.filter((s) => fromResult.includes(s))
  return both.length ? { statuses: both } : { statuses: [], ids: [] as string[] }
}

monitoringRouter.get('/quality-checks', requireAnyView('checks', 'dashboard', 'reports'), async (req, res) => {
  const { from, to } = dateRange(req)
  const f = checkFilters.parse(req.query)
  await prepareRange(from, to)
  const { departmentId, where } = await scopeFor(req, f.departmentId)
  const filters = { ...f, from, to, departmentId, where, ...statusScope(f) }
  const [rows, total] = await Promise.all([listChecks(filters, { limit: LIST_LIMIT }), countChecks(filters)])
  // The list stops at LIST_LIMIT checks; the pages warn when there are more, so totals are never
  // silently computed from part of the period.
  res.setHeader('X-Total-Count', String(total))
  if (total > rows.length) res.setHeader('X-Truncated', '1')
  res.json(rows)
})

/**
 * Creates a one-off check outside the schedules, e.g. to test the worker app end to end.
 * DUE opens immediately; PENDING opens at the chosen start time.
 */
monitoringRouter.post('/quality-checks', requireModule('checks', 'manage'), async (req, res) => {
  const body = z
    .object({
      machineId: z.uuid('Choose a machine'),
      activityId: z.uuid('Choose a check type'),
      workerId: optionalUuid,
      status: z.enum(['DUE', 'PENDING']),
      scheduledAt: z.string().optional(),
      windowMinutes: z.coerce.number().int().min(5, 'Open for at least 5 minutes').max(1440).default(60)
    })
    .parse(req.body)

  const now = new Date()
  let scheduledAt = now
  if (body.status === 'PENDING') {
    scheduledAt = new Date(body.scheduledAt ?? '')
    if (Number.isNaN(scheduledAt.getTime())) throw badRequest('Choose a start time for the check')
    if (scheduledAt <= now) throw badRequest('A later check must start in the future. Use "Start now" to open it immediately.')
  }

  // The plant calendar, or that day's machine day plan, decides whether this machine runs.
  const closure = await machineClosureOn(body.machineId, scheduledAt)
  if (closure?.planned) {
    throw badRequest(
      `This machine is not scheduled to run on ${formatDay(scheduledAt)}. Add it to that day's machine plan in the Plant Calendar to create a check.`
    )
  }
  if (closure) {
    throw badRequest(
      `The plant is closed on ${formatDay(scheduledAt)} (${closure.label}${closure.reason ? `: ${closure.reason}` : ''}). Remove the date from the Plant Calendar to create a check.`
    )
  }

  const [machine] = await db.select().from(machines).where(eq(machines.id, body.machineId))
  if (!machine) throw notFound('Machine')
  const [activity] = await db.select().from(activities).where(eq(activities.id, body.activityId))
  if (!activity) throw notFound('Check type')
  if (!activity.isActive) throw badRequest('This check type is disabled')

  // A test check is only created for a check type set up on the machine (Machines or Check Types page).
  const [link] = await db
    .select({ machineId: machineActivities.machineId })
    .from(machineActivities)
    .where(and(eq(machineActivities.machineId, machine.id), eq(machineActivities.activityId, activity.id)))
  if (!link) throw badRequest(`${activity.name} is not set up on ${machine.name}. Add it on the Machines page first.`)

  let shiftId: string | null = null
  let workerId = body.workerId
  const [running] = await db
    .select({ assignedWorkerId: jobs.assignedWorkerId, departmentId: jobs.departmentId })
    .from(jobs)
    .where(and(eq(jobs.machineId, machine.id), inArray(jobs.status, [...RUNNING_STATUSES])))
  // The department of the work: the job running on the machine (from its Item Code), else the
  // check type's. Never the worker's own account: workers work for any department.
  const departmentId: string | null = running?.departmentId ?? activity.departmentId
  if (body.workerId) {
    const [worker] = await db.select().from(users).where(eq(users.id, body.workerId))
    if (!worker || worker.role !== 'WORKER') throw badRequest('Choose a worker account')
    if (!worker.isActive || !worker.appAccess) throw badRequest('This worker cannot sign in to the app')
    const roleModules: Record<string, string[]> = { IPQC: ['IPQC'], QC: ['QC'], BOTH: ['IPQC', 'QC'] }
    if (!(roleModules[worker.workerQualityRole] ?? ['IPQC']).includes(activity.module)) {
      throw badRequest(`${worker.name} does ${worker.workerQualityRole} checks; ${activity.name} is a ${activity.module} check.`)
    }
    shiftId = worker.shiftId
  } else {
    // "Any worker": the check goes to whoever is running the job on this machine, as usual.
    const shift = await shiftAt(scheduledAt)
    shiftId = shift?.id ?? null
    if (!running?.assignedWorkerId) {
      throw badRequest(`No job is running on ${machine.name}, so no worker is responsible for it. Start a job on the machine, or choose a worker.`)
    }
    workerId = running.assignedWorkerId
  }

  const [row] = await db
    .insert(qualityChecks)
    .values({
      code: makeCheckCode(scheduledAt),
      machineId: machine.id,
      activityId: activity.id,
      module: activity.module,
      workerId,
      departmentId,
      shiftId,
      scheduledAt,
      windowEndsAt: new Date(scheduledAt.getTime() + body.windowMinutes * 60_000),
      status: body.status
    })
    .returning()

  await audit(req, 'CREATE_TEST_CHECK', 'QualityCheck', row.code, {
    newValue: { machine: machine.name, activity: activity.name, workerId, status: body.status, scheduledAt, windowMinutes: body.windowMinutes }
  })

  const [check] = await listChecks({ ids: [row.id] })
  res.status(201).json(check)
})

// The detail page opens from the check list, the dashboard, exceptions, reports and a job's checks.
monitoringRouter.get('/quality-checks/:id', requireAnyView('checks', 'jobs', 'dashboard', 'exceptions', 'reports'), async (req, res) => {
  const id = idParam(req)
  const { departmentId, where } = await scopeFor(req)
  const [check] = await listChecks({ ids: [id], departmentId, where })
  if (!check) throw notFound('Quality check')
  res.json(check)
})

monitoringRouter.get('/exceptions', requireModule('exceptions', 'view'), async (req, res) => {
  const { from, to } = dateRange(req)
  const { departmentId, where } = await scopeFor(req)
  const checks = await listChecks({ from, to, statuses: ['EXCEPTION'], departmentId, where }, { order: 'desc' })
  res.json(
    checks
      .filter((c) => c.exception)
      .map((c) => ({
        ...c.exception!,
        checkId: c.id,
        checkCode: c.code,
        machineId: c.machineId,
        machineName: c.machineName,
        departmentName: c.departmentName,
        activityName: c.activityName,
        workerName: c.submittedByName ?? c.workerName,
        workerEmployeeId: c.submittedByEmployeeId ?? c.workerEmployeeId,
        scheduledAt: c.scheduledAt
      }))
  )
})

monitoringRouter.patch('/exceptions/:id', requireModule('exceptions', 'manage'), async (req, res) => {
  const id = idParam(req)
  const body = z
    .object({
      status: z.enum(['UNDER_REVIEW', 'ACKNOWLEDGED', 'ACTION_TAKEN', 'RESOLVED']),
      resolutionNotes: z.string().trim().max(1000).optional()
    })
    .parse(req.body)
  const [before] = await db.select().from(checkExceptions).where(eq(checkExceptions.id, id))
  if (!before) throw notFound('Exception')
  const [row] = await db
    .update(checkExceptions)
    .set({
      status: body.status,
      resolutionNotes: body.resolutionNotes ?? before.resolutionNotes,
      reviewedById: req.user!.id
    })
    .where(eq(checkExceptions.id, id))
    .returning()
  await audit(req, 'UPDATE_EXCEPTION_STATUS', 'Exception', id, {
    oldValue: { status: before.status },
    newValue: { status: row.status, resolutionNotes: row.resolutionNotes }
  })
  res.json(row)
})

// Also feeds the missed/exception counts in the header, shown to anyone monitoring checks.
monitoringRouter.get('/dashboard', requireAnyView('dashboard', 'checks', 'exceptions'), async (req, res) => {
  const { from, to } = dateRange(req)
  await prepareRange(from, to)
  // Everyone sees the whole plant; `scope` stays in the response for older app builds that read it.
  const { scope, departmentId, where } = await scopeFor(req)

  // Counted in the database, so the figures are exact for any number of checks.
  // Status: Completed, Missed, Exception. Checks not finished yet have no status and count as open.
  const period = and(gte(qualityChecks.scheduledAt, from), lt(qualityChecks.scheduledAt, to), departmentId ? eq(qualityChecks.departmentId, departmentId) : undefined, where)
  const counts = await db
    .select({
      machineId: qualityChecks.machineId,
      machineName: machines.name,
      total: count(),
      completed: sql<number>`count(*) filter (where ${qualityChecks.status} = 'COMPLETED')::int`,
      missed: sql<number>`count(*) filter (where ${qualityChecks.status} = 'MISSED')::int`,
      exceptions: sql<number>`count(*) filter (where ${qualityChecks.status} = 'EXCEPTION')::int`
    })
    .from(qualityChecks)
    .leftJoin(machines, eq(qualityChecks.machineId, machines.id))
    .where(period)
    .groupBy(qualityChecks.machineId, machines.name)
  const byMachine = counts
    .filter((c) => c.machineId)
    .map((c) => ({
      machineId: c.machineId!,
      machineName: c.machineName ?? 'Unassigned',
      total: c.total,
      completed: c.completed,
      missed: c.missed,
      exceptions: c.exceptions,
      open: c.total - c.completed - c.missed - c.exceptions
    }))
    .sort((a, b) => a.machineName.localeCompare(b.machineName))
  const sum = (key: 'total' | 'completed' | 'missed' | 'exceptions') => counts.reduce((n, c) => n + c[key], 0)
  const scheduled = sum('total')
  const completed = sum('completed')
  const kpi = {
    scheduled,
    completed,
    missed: sum('missed'),
    exceptions: sum('exceptions'),
    open: scheduled - completed - sum('missed') - sum('exceptions'),
    completionRate: scheduled ? Math.round((completed / scheduled) * 100) : 0
  }

  const recent = await listChecks(
    { from, to, departmentId, where: and(where, isNotNull(qualityChecks.submittedAt)) },
    { order: 'desc', orderBy: 'submittedAt', limit: 10 }
  )

  // Plant Calendar: tells the dashboard when the chosen day is a closed day.
  const closure = await closureOn(from)
  // Machine day plan of the chosen day: exactly these machines run (null: the plant calendar decides).
  const fromKey = dateKey(from)
  const plan = (await plansBetween(fromKey, fromKey)).get(fromKey)
  const machinePlan = plan ? { machineIds: [...plan], count: plan.size } : null
  res.json({ from, to, scope, kpi, byMachine: [...byMachine.values()], recent, closure, machinePlan })
})

/**
 * Traceability for the Quality Reports: per Item Code, PO No. and worker, and every reading
 * change and correction, for the same filters as the report. The detailed records themselves
 * come from /quality-checks with the same filters.
 */
monitoringRouter.get('/reports/trace', requireModule('reports', 'view'), async (req, res) => {
  const { from, to } = dateRange(req)
  const f = checkFilters.parse(req.query)
  await prepareRange(from, to)
  const { departmentId, where } = await scopeFor(req, f.departmentId)
  const base = {
    from,
    to,
    machineId: f.machineId,
    shiftId: f.shiftId,
    activityId: f.activityId,
    departmentId,
    where,
    itemCode: f.itemCode,
    jobNo: f.jobNo
  }
  const [checks, context] = await Promise.all([
    listChecks({ ...base, workerId: f.workerId, ...statusScope(f) }),
    // What can come before a reported reading: the same item/job/machine by any worker, any result.
    f.workerId || f.status.length || f.result.length ? listChecks(base) : null
  ])
  res.json(buildTraceReport(checks, context ?? checks))
})

/**
 * Item Codes and PO Nos. recorded in a period, for the report filters' suggestion lists: from
 * the checks (submitted values) and from the jobs that ran in the period. Every department's
 * values are suggested, since nobody is limited to a department.
 */
monitoringRouter.get('/reports/filter-values', requireModule('reports', 'view'), async (req, res) => {
  const { from, to } = dateRange(req)
  const { where } = await scopeFor(req)
  const [fromChecks, fromJobs] = await Promise.all([
    db
      .selectDistinct({ itemCode: qualityChecks.itemCode, jobNo: qualityChecks.jobNo })
      .from(qualityChecks)
      .where(and(gte(qualityChecks.scheduledAt, from), lt(qualityChecks.scheduledAt, to), where)),
    db
      .selectDistinct({ itemCode: jobs.itemCode, jobNo: jobs.jobNo })
      .from(jobs)
      .where(and(lt(jobs.startedAt, to), or(isNull(jobs.endedAt), gte(jobs.endedAt, from)), where))
  ])
  const rows = [...fromChecks, ...fromJobs]
  // Distinct ignoring case and spaces; the first spelling seen is kept.
  const distinct = (values: (string | null)[]) => {
    const seen = new Map<string, string>()
    for (const v of values) {
      const t = v?.trim()
      if (t && !seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t)
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  }
  res.json({ itemCodes: distinct(rows.map((r) => r.itemCode)), jobNos: distinct(rows.map((r) => r.jobNo)) })
})

/**
 * The Quality Monitoring Report as a PDF. Same filters as the checks list, so the
 * report always matches what the admin sees on screen. Downloading it needs Export Reports as
 * well as Reports.
 */
monitoringRouter.get('/reports/quality-monitoring.pdf', requireModule('reports', 'view'), requireModule('export', 'view'), async (req, res) => {
  const { from, to } = dateRange(req)
  const f = checkFilters.parse(req.query)
  await prepareRange(from, to)
  const { departmentId: scopedDepartment, where: scopeWhere } = await scopeFor(req, f.departmentId)

  // Human-readable names of the filters, printed in the report header.
  const labels: string[] = []
  const nameOf = async (table: typeof machines | typeof activities, id?: string) => {
    if (!id) return null
    const [row] = await db.select({ name: table.name }).from(table).where(eq(table.id, id))
    return row?.name ?? null
  }
  const machineName = await nameOf(machines, f.machineId)
  if (machineName) labels.push(`Machine: ${machineName}`)
  const activityName = await nameOf(activities, f.activityId)
  if (activityName) labels.push(`Check type: ${activityName}`)
  if (f.workerId) {
    const [row] = await db.select({ name: users.name, employeeId: users.employeeId }).from(users).where(eq(users.id, f.workerId))
    if (row) labels.push(`Worker: ${row.name} (${row.employeeId})`)
  }
  if (f.shiftId) {
    const [row] = await db.select({ name: shifts.name }).from(shifts).where(eq(shifts.id, f.shiftId))
    if (row) labels.push(`Shift: ${row.name}`)
  }
  if (f.departmentId) {
    const [row] = await db.select({ name: departments.name }).from(departments).where(eq(departments.id, f.departmentId))
    if (row) labels.push(`Department: ${row.name}`)
  }
  if (f.itemCode) labels.push(`Item Code: ${f.itemCode}`)
  if (f.jobNo) labels.push(`PO No.: ${f.jobNo}`)
  if (f.status.length) labels.push(`Status: ${f.status.map((s) => RESULT_LABEL[s]).join(', ')}`)
  if (f.result.length) labels.push(`Result: ${f.result.map((r) => RESULT_LABEL[r]).join(', ')}`)

  // An Item Code, PO No. or worker report also gets the traceability sections. With a worker or
  // result filter, the readings that come before (by anyone) are needed to find the changes.
  const traced = !!(f.itemCode || f.jobNo || f.workerId)
  const traceContext =
    traced && (f.workerId || f.status.length || f.result.length)
      ? await listChecks({
          from,
          to,
          machineId: f.machineId,
          shiftId: f.shiftId,
          activityId: f.activityId,
          departmentId: scopedDepartment,
          where: scopeWhere,
          itemCode: f.itemCode,
          jobNo: f.jobNo
        })
      : undefined
  // The PDF lists every check; above LIST_LIMIT it would be cut off, so the period must be narrowed.
  const reportCount = await countChecks({ from, to, ...statusScope(f), machineId: f.machineId, workerId: f.workerId, shiftId: f.shiftId, activityId: f.activityId, departmentId: scopedDepartment, where: scopeWhere, itemCode: f.itemCode, jobNo: f.jobNo })
  if (reportCount > LIST_LIMIT) {
    throw badRequest(`This report would have ${reportCount} checks; one PDF holds at most ${LIST_LIMIT}. Choose a shorter period or more filters.`)
  }
  const report = await buildQualityReport(
    {
      from,
      to,
      ...statusScope(f),
      machineId: f.machineId,
      workerId: f.workerId,
      shiftId: f.shiftId,
      activityId: f.activityId,
      departmentId: scopedDepartment,
      where: scopeWhere,
      itemCode: f.itemCode,
      jobNo: f.jobNo
    },
    {
      preparedBy: `${req.user!.name} (${req.user!.employeeId})`,
      uploadDir: config.uploadDir,
      filterLabels: labels,
      trace: traced ? { context: traceContext } : undefined
    }
  )

  const pdf = await renderQualityReport(report)
  await audit(req, 'EXPORT_REPORT', 'Report', report.meta.reportId, {
    newValue: { from, to, checks: report.counts.scheduled, filters: labels }
  })

  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `attachment; filename="${report.meta.reportId}.pdf"`)
  res.setHeader('Content-Length', pdf.length)
  res.end(pdf)
})

/**
 * Monitoring Setup — the reasons a worker may choose when marking a parameter "Not Applicable".
 *
 * Deleting is soft (isActive = false) so submitted checks keep the reason they recorded. There is
 * deliberately no "keep at least one active" rule: an admin may disable every reason. The worker
 * app still works in that case — it simply offers no reason list, so a parameter cannot be marked
 * Not Applicable by hand. A JOB_RUNNING parameter is still skipped automatically with its own
 * built-in reason (routes/worker.ts), which never comes from this table.
 */
const reasonInput = z.object({
  label: z.string().trim().min(1, 'Enter the reason').max(120),
  requiresRemark: z.boolean().optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.coerce.number().int().min(0).max(9999).optional()
})

// Read by the Monitoring Setup page, the check detail (to explain an N/A) and the reports.
monitoringRouter.get('/monitoring-reasons', requireAnyView('activities', 'checks', 'exceptions'), async (_req, res) => {
  res.json(await listMonitoringReasons())
})

monitoringRouter.post('/monitoring-reasons', requireModule('activities', 'manage'), async (req, res) => {
  const body = reasonInput.parse(req.body)
  const [row] = await db
    .insert(monitoringReasons)
    .values({
      label: body.label,
      requiresRemark: body.requiresRemark ?? false,
      isActive: body.isActive ?? true,
      sortOrder: body.sortOrder ?? 0
    })
    .returning()
  await audit(req, 'CREATE', 'MonitoringReason', row.id, { newValue: reasonDto(row) })
  res.status(201).json(reasonDto(row))
})

monitoringRouter.put('/monitoring-reasons/:id', requireModule('activities', 'manage'), async (req, res) => {
  const id = idParam(req)
  const body = reasonInput.parse(req.body)
  const before = await monitoringReasonById(id)
  if (!before) throw notFound('Reason')
  // Fields the caller did not send keep their stored value.
  const [row] = await db
    .update(monitoringReasons)
    .set({
      label: body.label,
      requiresRemark: body.requiresRemark ?? before.requiresRemark,
      isActive: body.isActive ?? before.isActive,
      sortOrder: body.sortOrder ?? before.sortOrder,
      updatedAt: new Date()
    })
    .where(eq(monitoringReasons.id, id))
    .returning()
  await audit(req, 'UPDATE', 'MonitoringReason', id, { oldValue: reasonDto(before), newValue: reasonDto(row) })
  res.json(reasonDto(row))
})

monitoringRouter.delete('/monitoring-reasons/:id', requireModule('activities', 'manage'), async (req, res) => {
  const id = idParam(req)
  const before = await monitoringReasonById(id)
  if (!before) throw notFound('Reason')
  const [row] = await db
    .update(monitoringReasons)
    .set({ isActive: false, updatedAt: new Date() })
    .where(eq(monitoringReasons.id, id))
    .returning()
  await audit(req, 'DELETE', 'MonitoringReason', id, { oldValue: reasonDto(before), newValue: reasonDto(row) })
  res.json({ result: 'disabled', ...reasonDto(row) })
})

/**
 * Exception reasons: what a worker may choose when a whole check cannot be done. Managed on the
 * Check Types page next to the N/A reasons, and read by the worker app with each check form.
 * Deactivating never deletes, so an exception raised months ago still reads the same.
 */
monitoringRouter.get('/exception-reasons', requireAnyView('activities', 'checks', 'exceptions'), async (_req, res) => {
  res.json(await listExceptionReasons())
})

monitoringRouter.post('/exception-reasons', requireModule('activities', 'manage'), async (req, res) => {
  const body = reasonInput.parse(req.body)
  const [row] = await db
    .insert(exceptionReasons)
    .values({
      label: body.label,
      requiresRemark: body.requiresRemark ?? false,
      isActive: body.isActive ?? true,
      sortOrder: body.sortOrder ?? 0
    })
    .returning()
  await audit(req, 'CREATE', 'ExceptionReason', row.id, { newValue: exceptionReasonDto(row) })
  res.status(201).json(exceptionReasonDto(row))
})

monitoringRouter.put('/exception-reasons/:id', requireModule('activities', 'manage'), async (req, res) => {
  const id = idParam(req)
  const body = reasonInput.parse(req.body)
  const before = await exceptionReasonById(id)
  if (!before) throw notFound('Reason')
  // Fields the caller did not send keep their stored value.
  const [row] = await db
    .update(exceptionReasons)
    .set({
      label: body.label,
      requiresRemark: body.requiresRemark ?? before.requiresRemark,
      isActive: body.isActive ?? before.isActive,
      sortOrder: body.sortOrder ?? before.sortOrder,
      updatedAt: new Date()
    })
    .where(eq(exceptionReasons.id, id))
    .returning()
  await audit(req, 'UPDATE', 'ExceptionReason', id, { oldValue: exceptionReasonDto(before), newValue: exceptionReasonDto(row) })
  res.json(exceptionReasonDto(row))
})

monitoringRouter.delete('/exception-reasons/:id', requireModule('activities', 'manage'), async (req, res) => {
  const id = idParam(req)
  const before = await exceptionReasonById(id)
  if (!before) throw notFound('Reason')
  const [row] = await db
    .update(exceptionReasons)
    .set({ isActive: false, updatedAt: new Date() })
    .where(eq(exceptionReasons.id, id))
    .returning()
  await audit(req, 'DELETE', 'ExceptionReason', id, { oldValue: exceptionReasonDto(before), newValue: exceptionReasonDto(row) })
  res.json({ result: 'disabled', ...exceptionReasonDto(row) })
})

// Jobs (list, plan, detail, handover, force close) are in routes/jobs.ts.

/**
 * Machine-wise monitoring configuration for the admin Monitoring Setup screen: the check types on
 * each machine with their mode, schedules (including the live rolling timer) and parameters.
 */
monitoringRouter.get('/monitoring-overview', requireAnyView('activities', 'schedules'), async (req, res) => {
  // The running job on each machine is Jobs data: only for users who may view Jobs.
  const seesJobs = canView(req.user!.permissions, 'jobs')
  res.json({ machines: (await monitoringOverview()).map((m) => (seesJobs ? m : { ...m, runningJob: null })) })
})

/**
 * The audit log, newest first. `limit` and `offset` page through it; the number of entries the
 * filters match is sent in the `X-Total-Count` header, so the page can show "Page 2 of 17".
 * The body stays a plain array, as it always was, for callers that do not page.
 */
monitoringRouter.get('/audit-logs', requireModule('audit_logs', 'view'), async (req, res) => {
  const q = z
    .object({
      q: z.string().trim().optional(),
      entity: z.string().trim().optional(),
      limit: z.coerce.number().int().min(1).max(1000).default(300),
      offset: z.coerce.number().int().min(0).default(0),
      from: z.string().optional(),
      to: z.string().optional()
    })
    .parse(req.query)

  const where: SQL[] = []
  if (q.entity) where.push(eq(auditLogs.entity, q.entity))
  if (q.q) {
    const term = `%${q.q}%`
    where.push(or(ilike(auditLogs.action, term), ilike(auditLogs.userName, term), ilike(auditLogs.entityId, term), ilike(auditLogs.entity, term))!)
  }
  try {
    if (q.from) where.push(gte(auditLogs.createdAt, parseDateKey(q.from)))
    if (q.to) where.push(lt(auditLogs.createdAt, addDays(parseDateKey(q.to), 1)))
  } catch {
    throw badRequest('Invalid date')
  }

  const filter = where.length ? and(...where) : undefined
  const [rows, [totals]] = await Promise.all([
    db
      .select()
      .from(auditLogs)
      .where(filter)
      // id breaks ties, so paging never shows the same entry twice or skips one.
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
      .limit(q.limit)
      .offset(q.offset),
    db.select({ total: count() }).from(auditLogs).where(filter)
  ])
  res.setHeader('X-Total-Count', String(totals?.total ?? rows.length))
  res.json(rows)
})

// Readable by every admin-panel user: the header shows the plant name.
/**
 * The plant settings pages may read and change: the plant name and the company details on reports.
 * The settings table also holds internal values (the web push key pair, the weekly off, one-time
 * markers), which are never sent out and cannot be changed here: the Plant Calendar has its own,
 * locked, endpoint for the weekly off.
 */
const PUBLIC_SETTINGS = ['plant', 'company'] as const

monitoringRouter.get('/settings', async (_req, res) => {
  const rows = await db.select().from(settings).where(inArray(settings.key, [...PUBLIC_SETTINGS]))
  res.json(Object.fromEntries(rows.map((r) => [r.key, r.value])))
})

monitoringRouter.put('/settings', requireModule('settings', 'manage'), async (req, res) => {
  const body = z.record(z.string().min(1).max(60), z.unknown()).parse(req.body)
  if (Object.keys(body).some((key) => !(PUBLIC_SETTINGS as readonly string[]).includes(key))) {
    throw badRequest('Only the plant and company settings can be changed here')
  }
  const keys = Object.keys(body) as (typeof PUBLIC_SETTINGS)[number][]
  const before = keys.length ? await db.select().from(settings).where(inArray(settings.key, keys)) : []
  for (const key of keys) {
    const value = body[key]
    if (value === null || value === undefined) {
      await db.delete(settings).where(eq(settings.key, key))
      continue
    }
    await db
      .insert(settings)
      .values({ key, value })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } })
  }
  await audit(req, 'UPDATE_SETTINGS', 'Settings', null, {
    oldValue: Object.fromEntries(before.map((r) => [r.key, r.value])),
    newValue: body
  })
  res.json(body)
})

/**
 * Module Notification Devices: IPQC and QC dedicated phones/users.
 * Admin can view and assign which worker receives IPQC push notifications
 * and which worker receives QC push notifications.
 */
monitoringRouter.get('/notifications/module-devices', requireAnyView('settings', 'activities', 'machines', 'workers'), async (_req, res) => {
  const [assignments, workers] = await Promise.all([
    db
      .select({
        module: moduleNotificationAssignments.module,
        userId: moduleNotificationAssignments.userId,
        updatedAt: moduleNotificationAssignments.updatedAt,
        userName: users.name,
        userPhone: users.phone,
        employeeId: users.employeeId
      })
      .from(moduleNotificationAssignments)
      .leftJoin(users, eq(moduleNotificationAssignments.userId, users.id)),
    db
      .select({
        id: users.id,
        name: users.name,
        employeeId: users.employeeId,
        phone: users.phone
      })
      .from(users)
      .where(and(eq(users.isActive, true), eq(users.appAccess, true)))
      .orderBy(asc(users.name))
  ])

  const map = new Map(assignments.map((a) => [a.module, a]))
  res.json({
    ipqc: map.get('IPQC') ?? { module: 'IPQC', userId: null, userName: null, userPhone: null, employeeId: null },
    qc: map.get('QC') ?? { module: 'QC', userId: null, userName: null, userPhone: null, employeeId: null },
    workers
  })
})

const updateModuleDevicesSchema = z.object({
  ipqcUserId: z.string().uuid().nullable().optional(),
  qcUserId: z.string().uuid().nullable().optional()
})

// Choosing who receives every IPQC / QC alert is a plant setting: Settings manage only.
monitoringRouter.put('/notifications/module-devices', requireModule('settings', 'manage'), async (req, res) => {
  const body = updateModuleDevicesSchema.parse(req.body)
  const now = new Date()

  const setAssignment = async (moduleName: 'IPQC' | 'QC', userId: string | null | undefined) => {
    if (userId === undefined) return
    if (userId !== null) {
      const [user] = await db.select({ id: users.id }).from(users).where(and(eq(users.id, userId), eq(users.isActive, true)))
      if (!user) throw badRequest(`Selected user for ${moduleName} does not exist or is inactive`)
    }
    await db
      .insert(moduleNotificationAssignments)
      .values({ module: moduleName, userId, updatedAt: now, updatedById: req.user!.id })
      .onConflictDoUpdate({
        target: moduleNotificationAssignments.module,
        set: { userId, updatedAt: now, updatedById: req.user!.id }
      })
  }

  if (body.ipqcUserId !== undefined) await setAssignment('IPQC', body.ipqcUserId)
  if (body.qcUserId !== undefined) await setAssignment('QC', body.qcUserId)

  await audit(req, 'UPDATE_MODULE_NOTIFICATION_DEVICES', 'ModuleNotificationAssignments', null, { newValue: body })

  const assignments = await db
    .select({
      module: moduleNotificationAssignments.module,
      userId: moduleNotificationAssignments.userId,
      updatedAt: moduleNotificationAssignments.updatedAt,
      userName: users.name,
      userPhone: users.phone,
      employeeId: users.employeeId
    })
    .from(moduleNotificationAssignments)
    .leftJoin(users, eq(moduleNotificationAssignments.userId, users.id))

  const map = new Map(assignments.map((a) => [a.module, a]))
  res.json({
    ipqc: map.get('IPQC') ?? { module: 'IPQC', userId: null, userName: null, userPhone: null, employeeId: null },
    qc: map.get('QC') ?? { module: 'QC', userId: null, userName: null, userPhone: null, employeeId: null }
  })
})

const testModuleNotificationSchema = z.object({
  module: z.enum(['IPQC', 'QC'])
})

monitoringRouter.post('/notifications/module-devices/test', requireModule('settings', 'manage'), async (req, res) => {
  const { module: moduleName } = testModuleNotificationSchema.parse(req.body)

  const [assignment] = await db
    .select({ userId: moduleNotificationAssignments.userId })
    .from(moduleNotificationAssignments)
    .where(eq(moduleNotificationAssignments.module, moduleName))
    .limit(1)

  if (!assignment?.userId) {
    throw badRequest(`No dedicated phone/user configured for ${moduleName} yet. Please assign a user first.`)
  }

  const result = await sendTestNotification(assignment.userId, `${moduleName} Module`)
  await audit(req, 'TEST_MODULE_NOTIFICATION', 'ModuleNotificationAssignments', moduleName, { newValue: result })
  res.json({
    ok: true,
    module: moduleName,
    userId: assignment.userId,
    ...result
  })
})

