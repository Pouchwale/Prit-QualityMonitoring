import { Router, type Request } from 'express'
import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/client'
import { jobs, machines, qualityChecks, users } from '../db/schema'
import { idParam, optionalText, optionalUuid } from '../lib/validate'
import { badRequest, conflict, HttpError, notFound } from '../lib/http'
import { audit } from '../lib/audit'
import { requireModule } from '../lib/permissions'
import { addDays, parseDateKey } from '../lib/time'
import { invalidateCheckGeneration, removePendingJobChecks } from '../services/checkGenerator'
import { listChecks } from '../services/checks'
import { blockAll, departmentScope, seesNothing, UNRESTRICTED } from '../services/departmentScope'
import { forceClose, handover, jobHandoverList } from '../services/jobMonitoring'
import { jobById } from '../services/jobs'
import { listJobs } from '../services/monitoringConfig'
import { sendToUser } from '../services/notifications'

/**
 * Jobs for Admins and Managers: plan and assign jobs, see every job with its start / end check
 * status, pending, missed and overdue checks and handovers, open one job with all its records,
 * hand a running job to another worker, and force-close a stuck job.
 * View needs Quality Checks view; changes need Quality Checks manage.
 */
export const jobsRouter = Router()

const JOB_STATUSES = ['PLANNED', 'STARTING', 'ACTIVE', 'ENDING', 'COMPLETED', 'CANCELLED'] as const

/** Optional from/to day filter (inclusive days). */
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

jobsRouter.get('/', requireModule('checks', 'view'), async (req, res) => {
  const q = z
    .object({
      from: z.string().optional(),
      to: z.string().optional(),
      machineId: z.uuid().optional(),
      running: z
        .enum(['true', 'false'])
        .optional()
        .transform((v) => (v === undefined ? undefined : v === 'true')),
      status: z
        .string()
        .optional()
        .transform((v) => (v ? v.split(',') : []))
        .pipe(z.array(z.enum(JOB_STATUSES)))
    })
    .parse(req.query)
  // A Manager only sees the jobs of their own department's machines.
  const scope = await departmentScope(req.user!)
  res.json(
    await listJobs({
      ...optionalRange(q),
      machineId: q.machineId,
      running: q.running,
      statuses: q.status,
      departmentId: scope.departmentId ?? undefined,
      where: seesNothing(scope) ? blockAll : undefined
    })
  )
})

/** One job, or "not found" when it belongs to another department. */
async function jobRow(id: string, req?: Request) {
  const scope = req ? await departmentScope(req.user!) : UNRESTRICTED
  const [row] = await listJobs({ ids: [id], departmentId: scope.departmentId ?? undefined, where: seesNothing(scope) ? blockAll : undefined })
  if (!row) throw notFound('Job')
  return row
}

/** One job with every check recorded against it and its handovers. */
jobsRouter.get('/:id', requireModule('checks', 'view'), async (req, res) => {
  const id = idParam(req)
  const job = await jobRow(id, req)
  const [checks, handovers] = await Promise.all([listChecks({ where: eq(qualityChecks.jobId, id) }, { order: 'asc' }), jobHandoverList(id)])
  res.json({ job, checks, handovers })
})

const planInput = z.object({
  machineId: z.uuid('Choose the machine'),
  jobNo: z.string().trim().min(1, 'Enter the PO No.').max(60),
  itemCode: optionalText(60),
  plannedFor: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose a date')
    .nullish(),
  note: optionalText(500),
  /**
   * Which department the job is for. Optional: a planned job with none takes the department of
   * the worker who starts it. A Manager always plans in their own department.
   */
  departmentId: optionalUuid
})

/** The department a planned job belongs to. A Manager may only plan for their own. */
async function plannedDepartment(req: Request, requested?: string | null) {
  const scope = await departmentScope(req.user!)
  if (!scope.restricted) return requested ?? null
  if (requested && requested !== scope.departmentId) throw new HttpError(403, 'This department is not yours')
  return scope.departmentId ?? null
}

/** Plans a job: it waits on the machine for the worker to start it. */
jobsRouter.post('/', requireModule('checks', 'manage'), async (req, res) => {
  const body = planInput.parse(req.body)
  const [machine] = await db.select().from(machines).where(eq(machines.id, body.machineId))
  if (!machine) throw notFound('Machine')
  const [row] = await db
    .insert(jobs)
    .values({
      machineId: body.machineId,
      jobNo: body.jobNo,
      itemCode: body.itemCode,
      plannedFor: body.plannedFor ?? null,
      note: body.note,
      status: 'PLANNED',
      startedAt: null,
      departmentId: await plannedDepartment(req, body.departmentId),
      plannedById: req.user!.id
    })
    .returning()
  await audit(req, 'PLAN_JOB', 'Job', row.id, {
    newValue: { machine: machine.name, jobNo: row.jobNo, itemCode: row.itemCode, assignedWorkerId: row.assignedWorkerId, plannedFor: row.plannedFor }
  })
  res.status(201).json(await jobRow(row.id))
})

/** Edits a planned job (machine, numbers, worker, date, note). Started jobs cannot be edited. */
jobsRouter.put('/:id', requireModule('checks', 'manage'), async (req, res) => {
  const id = idParam(req)
  const body = planInput.parse(req.body)
  const before = await jobById(id)
  if (!before) throw notFound('Job')
  if (before.status !== 'PLANNED') throw conflict('Only a planned job can be edited. Use Handover to change the worker of a running job.')
  const [row] = await db
    .update(jobs)
    .set({
      machineId: body.machineId,
      jobNo: body.jobNo,
      itemCode: body.itemCode,
      plannedFor: body.plannedFor ?? null,
      note: body.note,
      departmentId: await plannedDepartment(req, body.departmentId),
      updatedAt: new Date()
    })
    .where(and(eq(jobs.id, id), eq(jobs.status, 'PLANNED')))
    .returning()
  if (!row) throw conflict('This job has just been started')
  await audit(req, 'UPDATE_JOB', 'Job', id, {
    oldValue: { machineId: before.machineId, jobNo: before.jobNo, itemCode: before.itemCode, assignedWorkerId: before.assignedWorkerId, plannedFor: before.plannedFor },
    newValue: { machineId: row.machineId, jobNo: row.jobNo, itemCode: row.itemCode, assignedWorkerId: row.assignedWorkerId, plannedFor: row.plannedFor }
  })
  res.json(await jobRow(id, req))
})

/** Hands a running job to another worker (e.g. the previous worker left without a handover). */
jobsRouter.post('/:id/handover', requireModule('checks', 'manage'), async (req, res) => {
  const id = idParam(req)
  const body = z
    .object({ toUserId: z.uuid('Choose the worker'), shiftId: z.uuid().nullish(), note: z.string().trim().max(500).optional() })
    .parse(req.body)
  const job = await jobById(id)
  if (!job) throw notFound('Job')
  const result = await handover({ jobId: id, toUserId: body.toUserId, shiftId: body.shiftId ?? null, note: body.note || null, byUserId: req.user!.id, asWorker: false })
  const [machine] = await db.select({ name: machines.name }).from(machines).where(eq(machines.id, job.machineId))
  await sendToUser(body.toUserId, 'Job handed over to you', `${machine?.name ?? 'Machine'} · Job ${job.jobNo}${job.itemCode ? ` · ${job.itemCode}` : ''} from ${req.user!.name}`, { jobId: id })
  await audit(req, 'HANDOVER_JOB', 'Job', id, {
    oldValue: { assignedWorkerId: job.assignedWorkerId },
    newValue: { assignedWorkerId: body.toUserId, to: result.toName, shiftId: body.shiftId ?? null, note: body.note ?? null, movedChecks: result.movedChecks }
  })
  res.json(await jobRow(id, req))
})

/**
 * Force close: ends a running job without its remaining checks (e.g. a stuck Job End check), or
 * cancels a planned one. Open job checks are removed; submitted records stay with the job.
 */
jobsRouter.post('/:id/end', requireModule('checks', 'manage'), async (req, res) => {
  const id = idParam(req)
  const job = await jobById(id)
  if (!job) throw notFound('Job')
  const closed = await forceClose(id, req.user!.id)
  const legacy = closed.job.status === 'COMPLETED' ? await removePendingJobChecks(job.machineId) : 0
  invalidateCheckGeneration()
  await audit(req, closed.job.status === 'CANCELLED' ? 'CANCEL_JOB' : 'FORCE_END_JOB', 'Job', id, {
    oldValue: { status: closed.previousStatus, jobNo: job.jobNo },
    newValue: { status: closed.job.status, removedChecks: closed.removedChecks + legacy }
  })
  res.json(await jobRow(id, req))
})
