import { Router, type Request } from 'express'
import { z } from 'zod'
import { and, asc, desc, eq, gte, ilike, inArray, lt, or, type SQL } from 'drizzle-orm'
import { db } from '../db/client'
import {
  activities,
  auditLogs,
  checkExceptions,
  departments,
  machineActivities,
  machines,
  monitoringReasons,
  qualityChecks,
  schedules,
  settings,
  shifts,
  users,
  workerMachines
} from '../db/schema'
import { idParam, optionalUuid } from '../lib/validate'
import { badRequest, notFound } from '../lib/http'
import { audit } from '../lib/audit'
import { requireAnyView, requireModule } from '../lib/permissions'
import { CHECK_RESULTS, RESULT_LABEL, RESULT_STATUSES, resultOf } from '../lib/result'
import { PLANT_TIMEZONE, addDays, parseDateKey, startOfDay } from '../lib/time'
import { listChecks } from '../services/checks'
import { buildQualityReport } from '../services/reportData'
import { renderQualityReport } from '../services/reportPdf'
import { config } from '../config'
import { coverageGaps, eligibleWorkers, loadWorkers, shiftAt } from '../services/workerAssignment'
import { closureOn } from '../services/plantCalendar'
import { invalidateCheckGeneration, makeCheckCode, prepareChecks } from '../services/checkGenerator'
import { endJob, jobById } from '../services/jobs'
import {
  listJobs,
  listMonitoringReasons,
  monitoringOverview,
  monitoringReasonById,
  reasonDto
} from '../services/monitoringConfig'

export const monitoringRouter = Router()

/** Schedules that create no checks because their machine has no worker on that shift. */
async function gapDetails() {
  const ids = await coverageGaps()
  if (ids.length === 0) return []
  return db
    .select({ scheduleId: schedules.id, machineName: machines.name, shiftName: shifts.name, activityName: activities.name })
    .from(schedules)
    .innerJoin(machines, eq(schedules.machineId, machines.id))
    .innerJoin(shifts, eq(schedules.shiftId, shifts.id))
    .innerJoin(activities, eq(schedules.activityId, activities.id))
    .where(inArray(schedules.id, ids))
    .orderBy(asc(machines.name), asc(shifts.startTime))
}

const formatDay = (d: Date) =>
  d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: PLANT_TIMEZONE })

/** The only statuses that can be filtered on or shown. Unfinished checks have no status yet. */
const CHECK_STATUSES = ['COMPLETED', 'MISSED', 'EXCEPTION'] as const

/** Reads ?date=YYYY-MM-DD or ?from=&to= (inclusive dates). Defaults to today. */
function dateRange(req: Request) {
  const q = z
    .object({ date: z.string().optional(), from: z.string().optional(), to: z.string().optional() })
    .parse(req.query)
  try {
    const from = q.from ? parseDateKey(q.from) : q.date ? parseDateKey(q.date) : startOfDay(new Date())
    const toInclusive = q.to ? parseDateKey(q.to) : q.date ? parseDateKey(q.date) : from
    if (toInclusive < from) throw badRequest('"to" date must be on or after "from" date')
    return { from, to: addDays(toInclusive, 1) }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Invalid date')) throw badRequest(err.message)
    throw err
  }
}

/** Makes sure scheduled checks exist for the requested days (up to one week ahead). */
async function prepareRange(from: Date, to: Date) {
  const limit = addDays(startOfDay(new Date()), 8)
  const days: Date[] = []
  for (let d = from; d < to && d < limit && days.length < 62; d = addDays(d, 1)) days.push(d)
  await prepareChecks(days.length ? days : [new Date()])
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
  departmentId: z.uuid().optional()
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
  res.json(await listChecks({ ...f, from, to, ...statusScope(f) }))
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

  const closure = await closureOn(scheduledAt)
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

  let shiftId: string | null = null
  let workerId = body.workerId
  if (body.workerId) {
    const [worker] = await db.select().from(users).where(eq(users.id, body.workerId))
    if (!worker || worker.role !== 'WORKER') throw badRequest('Choose a worker account')
    if (!worker.isActive || !worker.appAccess) throw badRequest('This worker cannot sign in to the app')
    const [access] = await db
      .select({ machineId: workerMachines.machineId })
      .from(workerMachines)
      .where(and(eq(workerMachines.userId, body.workerId), eq(workerMachines.machineId, machine.id)))
    if (!access) throw badRequest(`${worker.name} is not assigned to ${machine.name}. Assign the machine to the worker first.`)
    shiftId = worker.shiftId
  } else {
    // "Any worker": the check goes to the worker on the machine for the shift running at its start time.
    const shift = await shiftAt(scheduledAt)
    shiftId = shift?.id ?? null
    const [candidate] = eligibleWorkers(await loadWorkers(), machine.id, shiftId, null)
    if (!candidate) {
      throw badRequest(
        `No worker is assigned to ${machine.name}${shift ? ` on ${shift.name}` : ''}. Assign a worker in Machine Assignment, or choose a worker.`
      )
    }
    workerId = candidate.id
  }

  await db.insert(machineActivities).values({ machineId: machine.id, activityId: activity.id }).onConflictDoNothing()

  const [row] = await db
    .insert(qualityChecks)
    .values({
      code: makeCheckCode(scheduledAt),
      machineId: machine.id,
      activityId: activity.id,
      workerId,
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

// The detail page opens from the check list, the dashboard, exceptions and reports.
monitoringRouter.get('/quality-checks/:id', requireAnyView('checks', 'dashboard', 'exceptions', 'reports'), async (req, res) => {
  const id = idParam(req)
  const [check] = await listChecks({ ids: [id] })
  if (!check) throw notFound('Quality check')
  res.json(check)
})

monitoringRouter.get('/exceptions', requireModule('exceptions', 'view'), async (req, res) => {
  const { from, to } = dateRange(req)
  const checks = await listChecks({ from, to, statuses: ['EXCEPTION'] }, { order: 'desc' })
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
  const checks = await listChecks({ from, to })

  // Status: Completed, Missed, Exception. Checks not finished yet have no status and count as open.
  const count = (status: string) => checks.filter((c) => resultOf(c.status) === status).length
  const completed = count('COMPLETED')
  const kpi = {
    scheduled: checks.length,
    completed,
    missed: count('MISSED'),
    exceptions: count('EXCEPTION'),
    open: checks.filter((c) => resultOf(c.status) === null).length,
    completionRate: checks.length ? Math.round((completed / checks.length) * 100) : 0
  }

  const byMachine = new Map<string, { machineId: string; machineName: string; total: number; completed: number; missed: number; exceptions: number; open: number }>()
  for (const c of checks) {
    const m = byMachine.get(c.machineId) ?? { machineId: c.machineId, machineName: c.machineName, total: 0, completed: 0, missed: 0, exceptions: 0, open: 0 }
    m.total++
    const result = resultOf(c.status)
    if (result === 'COMPLETED') m.completed++
    else if (result === 'MISSED') m.missed++
    else if (result === 'EXCEPTION') m.exceptions++
    else m.open++
    byMachine.set(c.machineId, m)
  }

  const recent = checks
    .filter((c) => c.submittedAt)
    .sort((a, b) => +new Date(b.submittedAt!) - +new Date(a.submittedAt!))
    .slice(0, 10)

  // Plant Calendar: tells the dashboard when the chosen day is a closed day.
  const closure = await closureOn(from)
  const workerGaps = await gapDetails()
  res.json({ from, to, kpi, byMachine: [...byMachine.values()], recent, closure, workerGaps })
})

/**
 * The Quality Monitoring Report as a PDF. Same filters as the checks list, so the
 * report always matches what the admin sees on screen.
 */
monitoringRouter.get('/reports/quality-monitoring.pdf', requireModule('reports', 'view'), async (req, res) => {
  const { from, to } = dateRange(req)
  const f = checkFilters.parse(req.query)
  await prepareRange(from, to)

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
  if (f.status.length) labels.push(`Status: ${f.status.map((s) => RESULT_LABEL[s]).join(', ')}`)
  if (f.result.length) labels.push(`Result: ${f.result.map((r) => RESULT_LABEL[r]).join(', ')}`)

  const report = await buildQualityReport(
    { from, to, ...statusScope(f), machineId: f.machineId, workerId: f.workerId, shiftId: f.shiftId, activityId: f.activityId, departmentId: f.departmentId },
    {
      preparedBy: `${req.user!.name} (${req.user!.employeeId})`,
      uploadDir: config.uploadDir,
      filterLabels: labels
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

/** Optional from/to day filter. Unlike the checks list this does not default to today. */
function optionalRange(q: { from?: string; to?: string }) {
  try {
    const from = q.from ? parseDateKey(q.from) : undefined
    const to = q.to ? addDays(parseDateKey(q.to), 1) : undefined
    if (from && to && to <= from) throw badRequest('"to" date must be on or after "from" date')
    return { from, to }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Invalid date')) throw badRequest(err.message)
    throw err
  }
}

/** The production jobs log. Same data the worker app records when it starts and ends a job. */
monitoringRouter.get('/jobs', requireModule('checks', 'view'), async (req, res) => {
  const q = z
    .object({
      from: z.string().optional(),
      to: z.string().optional(),
      machineId: z.uuid().optional(),
      running: z
        .enum(['true', 'false'])
        .optional()
        .transform((v) => (v === undefined ? undefined : v === 'true'))
    })
    .parse(req.query)
  res.json(await listJobs({ ...optionalRange(q), machineId: q.machineId, running: q.running }))
})

/**
 * Ends a job from the admin panel, e.g. when a worker left it running. Exactly like the worker
 * endpoint: the JOB-schedule checks nobody was told about are removed, so nothing is counted as
 * Missed on a machine that is not running (services/jobs.ts → removePendingJobChecks).
 */
monitoringRouter.post('/jobs/:id/end', requireModule('checks', 'manage'), async (req, res) => {
  const id = idParam(req)
  const job = await jobById(id)
  if (!job) throw notFound('Job')
  if (job.endedAt) throw badRequest('This job is already finished')
  const ended = await endJob(id, req.user!.id)
  // The generator must forget its plan: a JOB schedule stops producing checks from here.
  invalidateCheckGeneration()
  await audit(req, 'END_JOB', 'Job', id, {
    oldValue: { jobNo: job.jobNo, startedAt: job.startedAt },
    newValue: { endedAt: ended.job.endedAt, removedChecks: ended.removedChecks }
  })
  // Answer with the same shape the jobs list uses, so the screen can refresh one row.
  const row = (await listJobs({ machineId: job.machineId })).find((r) => r.id === id)
  res.json(row ?? ended.job)
})

/**
 * Machine-wise monitoring configuration for the admin Monitoring Setup screen: the check types on
 * each machine with their mode, schedules (including the live rolling timer) and parameters.
 */
monitoringRouter.get('/monitoring-overview', requireAnyView('activities', 'schedules'), async (_req, res) => {
  res.json({ machines: await monitoringOverview() })
})

monitoringRouter.get('/audit-logs', requireModule('audit_logs', 'view'), async (req, res) => {
  const q = z
    .object({
      q: z.string().trim().optional(),
      entity: z.string().trim().optional(),
      limit: z.coerce.number().int().min(1).max(1000).default(300),
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
  if (q.from) where.push(gte(auditLogs.createdAt, parseDateKey(q.from)))
  if (q.to) where.push(lt(auditLogs.createdAt, addDays(parseDateKey(q.to), 1)))

  const rows = await db
    .select()
    .from(auditLogs)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(auditLogs.createdAt))
    .limit(q.limit)
  res.json(rows)
})

// Readable by every admin-panel user: the header shows the plant name.
monitoringRouter.get('/settings', async (_req, res) => {
  const rows = await db.select().from(settings)
  res.json(Object.fromEntries(rows.map((r) => [r.key, r.value])))
})

monitoringRouter.put('/settings', requireModule('settings', 'manage'), async (req, res) => {
  const body = z.record(z.string().min(1).max(60), z.unknown()).parse(req.body)
  const before = await db.select().from(settings)
  for (const [key, value] of Object.entries(body)) {
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
