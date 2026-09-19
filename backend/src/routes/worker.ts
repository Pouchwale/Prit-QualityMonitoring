import { Router } from 'express'
import { z } from 'zod'
import { and, asc, desc, eq, gte, inArray, isNotNull, lt, max, sql, type SQL } from 'drizzle-orm'
import { config } from '../config'
import { db } from '../db/client'
import {
  activities,
  activityParameters,
  departments,
  machineActivities,
  machines,
  checkExceptions,
  media,
  monitoringReasons,
  parameters,
  pushTokens,
  qualityCheckValues,
  qualityChecks,
  schedules,
  shifts,
  users,
  workerMachines
} from '../db/schema'
import { idParam } from '../lib/validate'
import { badRequest, conflict, forbidden, notFound } from '../lib/http'
import { audit } from '../lib/audit'
import { MINUTE, addDays, dateKey, parseDateKey, startOfDay } from '../lib/time'
import { countChecks, listChecks, type CheckDto } from '../services/checks'
import {
  MIN_MANUAL_WINDOW_MINUTES,
  currentSchedule,
  makeCheckCode,
  openCheckOfSchedule,
  prepareChecks,
  refreshStatuses,
  removePendingJobChecks
} from '../services/checkGenerator'
import { emptyValue, isEmpty, notApplicableValue, PHOTO_VALUE, readingValue, ruleText } from '../services/evaluate'
import { jobById, jobDtoById, plannedJobs, runningJob, runningJobs, type JobDto } from '../services/jobs'
import {
  RUNNING_STATUSES,
  activateIfStarted,
  completeIfEnded,
  handover,
  jobCheckTypes,
  jobHandoverList,
  requestEnd,
  startIntervalCheckNow,
  startJob
} from '../services/jobMonitoring'
import { sendToUser } from '../services/notifications'
import { resetScheduleTimer, settleNextDue } from '../services/monitoringTimer'
import {
  checkEvidenceUpload,
  cleanupTemp,
  evidenceUpload,
  fieldKind,
  fieldParameterId,
  filesByField,
  removeStored,
  storeEvidence,
  type EvidenceInput,
  type StoredEvidence,
  type UploadedFiles
} from '../services/uploads'
import { kickVideoOptimization } from '../services/mediaOptimizer'
import { shiftAt } from '../services/workerAssignment'
import { loadProfile } from './auth'
import { webPushPublicKey } from '../services/webPush'
import { machineClosureOn, machineClosuresOn, type MachineClosure } from '../services/machineDays'

export const workerRouter = Router()

export const EXCEPTION_REASONS = [
  'Machine stopped',
  'Machine under maintenance',
  'Worker unavailable',
  'Material unavailable',
  'Production stopped',
  'Other'
] as const

/** A check can be started this many minutes before its scheduled time. */
const EARLY_START_MINUTES = 30

/**
 * Checks a worker may see and submit: the checks assigned to them (every check has its worker,
 * services/workerAssignment.ts), and only on machines still assigned to them, which is the hard
 * limit set by the admin's Machine Assignment.
 */
async function workerScope(userId: string): Promise<SQL> {
  const machineIds = await assignedMachineIds(userId)
  if (machineIds.length === 0) return sql`false`
  return and(inArray(qualityChecks.machineId, machineIds), eq(qualityChecks.workerId, userId))!
}

/** Machines the admin has assigned to this worker. */
export async function assignedMachineIds(userId: string): Promise<string[]> {
  const rows = await db
    .select({ machineId: workerMachines.machineId })
    .from(workerMachines)
    .where(eq(workerMachines.userId, userId))
  return rows.map((r) => r.machineId)
}

function openState(check: { status: CheckDto['status']; scheduledAt: Date }): { canSubmit: boolean; message: string | null } {
  switch (check.status) {
    case 'DUE':
    case 'IN_PROGRESS':
      return { canSubmit: true, message: null }
    case 'PENDING': {
      const opensAt = new Date(check.scheduledAt).getTime() - EARLY_START_MINUTES * MINUTE
      return Date.now() >= opensAt
        ? { canSubmit: true, message: null }
        : { canSubmit: false, message: 'This check is not open yet.' }
    }
    case 'COMPLETED':
      return { canSubmit: false, message: 'This check is already submitted.' }
    case 'EXCEPTION':
      return { canSubmit: false, message: 'An exception was already raised for this check.' }
    case 'MISSED':
      return { canSubmit: false, message: 'This check was missed. The time window is over.' }
  }
}

function summary(check: CheckDto) {
  return {
    id: check.id,
    code: check.code,
    scheduleId: check.scheduleId,
    machineId: check.machineId,
    machineName: check.machineName,
    machineCode: check.machineCode,
    departmentName: check.departmentName,
    activityName: check.activityName,
    scheduledAt: check.scheduledAt,
    windowEndsAt: check.windowEndsAt,
    status: check.status,
    result: check.result,
    itemCode: check.itemCode,
    jobNo: check.jobNo,
    submissionType: check.submissionType,
    /** SCHEDULED, or a job check: JOB_START, JOB_INTERVAL, JOB_END. */
    kind: check.kind,
    jobId: check.jobId,
    nextDueAt: check.nextDueAt,
    submittedAt: check.submittedAt,
    ...openState(check)
  }
}

async function loadWorkerCheck(userId: string, checkId: string) {
  const [check] = await listChecks({ ids: [checkId], where: await workerScope(userId) })
  if (!check) throw notFound('Check')
  return check
}

/** The form's parameters: every enabled one of the check type, or only those a job check asks for. */
async function formParameters(activityId: string, only: string[] | null = null) {
  const rows = await db
    .select({
      id: parameters.id,
      name: parameters.name,
      type: parameters.type,
      unit: parameters.unit,
      minValue: parameters.minValue,
      maxValue: parameters.maxValue,
      options: parameters.options,
      description: parameters.description,
      isRequired: activityParameters.isRequired,
      /** Evidence and applicability rules of this parameter inside this check type. */
      requirePhoto: activityParameters.requirePhoto,
      requireVideo: activityParameters.requireVideo,
      allowNa: activityParameters.allowNa,
      appliesWhen: activityParameters.appliesWhen,
      sortOrder: activityParameters.sortOrder
    })
    .from(activityParameters)
    .innerJoin(parameters, eq(activityParameters.parameterId, parameters.id))
    .where(
      and(
        eq(activityParameters.activityId, activityId),
        eq(activityParameters.isEnabled, true),
        eq(parameters.isActive, true)
      )
    )
    .orderBy(asc(activityParameters.sortOrder))
  return only ? rows.filter((p) => only.includes(p.id)) : rows
}

workerRouter.get('/profile', async (req, res) => {
  res.json(await loadProfile(req.user!.id))
})

/** The device reports whether it could turn on alerts, and if not, why. */
workerRouter.put('/push-status', async (req, res) => {
  const body = z
    .object({
      status: z.enum([
        'registered',
        'permission-denied',
        'no-project-id',
        'expo-go-unsupported',
        'insecure-context',
        'ios-needs-home-screen',
        'unsupported-browser',
        'error'
      ]),
      platform: z.string().trim().max(60).optional(),
      detail: z.string().trim().max(300).optional()
    })
    .parse(req.body)
  await db
    .update(users)
    .set({ alertStatus: { status: body.status, platform: body.platform ?? null, detail: body.detail ?? null, at: new Date().toISOString() } })
    .where(eq(users.id, req.user!.id))
  res.status(204).end()
})

/** Public key the web app needs to subscribe the browser to notifications. */
workerRouter.get('/push/web-key', async (_req, res) => {
  res.json({ publicKey: await webPushPublicKey() })
})

const webSubscription = z.object({
  endpoint: z.url().max(1000),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) })
})

/**
 * Registers this device for "check is due" notifications.
 * The app sends its Expo push token; the web app sends its browser push subscription.
 */
workerRouter.put('/push-token', async (req, res) => {
  const body = z
    .union([
      z.object({ kind: z.literal('web'), subscription: webSubscription, platform: z.string().trim().max(40).optional() }),
      z.object({ kind: z.literal('expo').optional(), token: z.string().trim().min(1).max(255), platform: z.string().trim().max(40).optional() })
    ])
    .parse(req.body)

  const row =
    body.kind === 'web'
      ? { token: body.subscription.endpoint, kind: 'web' as const, subscription: body.subscription, platform: body.platform ?? 'web' }
      : { token: body.token, kind: 'expo' as const, subscription: null, platform: body.platform }

  await db
    .insert(pushTokens)
    .values({ userId: req.user!.id, ...row })
    .onConflictDoUpdate({
      target: pushTokens.token,
      set: { userId: req.user!.id, kind: row.kind, subscription: row.subscription, platform: row.platform, lastSeenAt: new Date() }
    })
  res.status(204).end()
})

/** Stops notifications for this phone, used when the worker signs out. */
workerRouter.delete('/push-token', async (req, res) => {
  // `token` is the Expo push token, or the subscription endpoint for the web app.
  const body = z.object({ token: z.string().trim().min(1) }).parse(req.body)
  await db.delete(pushTokens).where(and(eq(pushTokens.token, body.token), eq(pushTokens.userId, req.user!.id)))
  res.status(204).end()
})

/** The machine must be assigned to this worker; that is the hard limit set by the admin. */
async function assertAssigned(userId: string, machineId: string) {
  const ids = await assignedMachineIds(userId)
  if (!ids.includes(machineId)) throw forbidden('This machine is not assigned to you')
}

/** Why a machine cannot run today, in the worker's words. */
const notRunningMessage = (closure: MachineClosure) =>
  closure.planned
    ? 'This machine is not scheduled to run today.'
    : `The plant is closed today (${closure.label}${closure.reason ? `: ${closure.reason}` : ''}).`

/**
 * Refuses anything that would start a check or a job on a machine that does not run today: the
 * plant is closed, or a machine day plan leaves the machine out. A machine the plan runs can be
 * started even on a closed day.
 */
async function assertMachineRuns(machineId: string, at: Date) {
  const closure = await machineClosureOn(machineId, at)
  if (closure) throw badRequest(notRunningMessage(closure))
}

/**
 * The machines assigned to this worker, with everything the machine screen shows: the running
 * job, and per check type the mode, whether it can be started by hand, the open check and when
 * the next check is due.
 */
workerRouter.get('/machines', async (req, res) => {
  const ids = await assignedMachineIds(req.user!.id)
  if (ids.length === 0) return res.json([])
  await prepareChecks([new Date()])

  const [rows, links, scheduleRows, openChecks, lastDone, jobs, closures, planned, jobTypes] = await Promise.all([
    db
      .select({ id: machines.id, name: machines.name, code: machines.code, status: machines.status, isActive: machines.isActive })
      .from(machines)
      .where(inArray(machines.id, ids))
      .orderBy(asc(machines.name)),
    db
      .select({
        machineId: machineActivities.machineId,
        activityId: activities.id,
        name: activities.name,
        code: activities.code,
        description: activities.description,
        allowManual: activities.allowManual,
        requireJobNo: activities.requireJobNo,
        monitoring: activities.monitoring
      })
      .from(machineActivities)
      .innerJoin(activities, eq(machineActivities.activityId, activities.id))
      .where(and(inArray(machineActivities.machineId, ids), eq(activities.isActive, true)))
      .orderBy(asc(activities.name)),
    db
      .select({ schedule: schedules, shiftName: shifts.name, shiftStart: shifts.startTime, shiftEnd: shifts.endTime })
      .from(schedules)
      .innerJoin(shifts, eq(schedules.shiftId, shifts.id))
      .where(and(inArray(schedules.machineId, ids), eq(schedules.isActive, true), eq(shifts.isActive, true))),
    db
      .select({
        id: qualityChecks.id,
        code: qualityChecks.code,
        machineId: qualityChecks.machineId,
        activityId: qualityChecks.activityId,
        scheduledAt: qualityChecks.scheduledAt,
        windowEndsAt: qualityChecks.windowEndsAt,
        status: qualityChecks.status,
        submissionType: qualityChecks.submissionType,
        kind: qualityChecks.kind,
        parameterIds: qualityChecks.parameterIds,
        jobId: qualityChecks.jobId
      })
      .from(qualityChecks)
      .where(
        and(
          inArray(qualityChecks.machineId, ids),
          eq(qualityChecks.workerId, req.user!.id),
          inArray(qualityChecks.status, ['PENDING', 'DUE', 'IN_PROGRESS'])
        )
      )
      .orderBy(asc(qualityChecks.scheduledAt)),
    db
      .select({ machineId: qualityChecks.machineId, activityId: qualityChecks.activityId, at: max(qualityChecks.submittedAt) })
      .from(qualityChecks)
      .where(and(inArray(qualityChecks.machineId, ids), eq(qualityChecks.status, 'COMPLETED')))
      .groupBy(qualityChecks.machineId, qualityChecks.activityId),
    runningJobs(ids),
    machineClosuresOn(ids, new Date()),
    plannedJobs(ids),
    jobCheckTypes(ids)
  ])
  const me = req.user!.id
  /** Parameter names of a job check, e.g. ["Viscosity", "Printing quality"]. */
  const parameterNames = (machineId: string, ids: string[] | null) => {
    const all = (jobTypes.get(machineId) ?? []).flatMap((t) => t.parameters)
    return (ids ?? []).map((id) => all.find((p) => p.parameterId === id)?.name).filter((n): n is string => !!n)
  }
  const jobCheckSummary = (c: (typeof openChecks)[number]) => ({
    id: c.id,
    code: c.code,
    kind: c.kind,
    activityId: c.activityId,
    status: c.status,
    scheduledAt: c.scheduledAt,
    windowEndsAt: c.windowEndsAt,
    parameterNames: parameterNames(c.machineId, c.parameterIds),
    ...openState(c)
  })

  res.json(
    rows.map((machine) => {
      const job = jobs.get(machine.id) ?? null
      // The plant calendar, or a machine day plan, decides whether this machine runs today.
      const closure = closures.get(machine.id)
      const checkTypes = links
        .filter((l) => l.machineId === machine.id)
        .map((link) => {
          const forType = scheduleRows.filter((s) => s.schedule.machineId === machine.id && s.schedule.activityId === link.activityId)
          const jobBased = link.monitoring === 'JOB'
          // A job-based check type's card shows its next interval check; start / end checks are on the job card.
          const open =
            openChecks.find(
              (c) => c.machineId === machine.id && c.activityId === link.activityId && (jobBased ? c.kind === 'JOB_INTERVAL' : c.kind === 'SCHEDULED')
            ) ?? null
          const last = lastDone.find((l) => l.machineId === machine.id && l.activityId === link.activityId)?.at ?? null
          const mode = jobBased ? 'JOB' : forType.length === 0 ? 'MANUAL' : forType.some((s) => s.schedule.mode === 'JOB') ? 'JOB' : 'INTERVAL'
          const jobActiveForMe = !!job && job.status === 'ACTIVE' && job.assignedWorkerId === me
          const canStart = link.allowManual && !closure && machine.isActive && machine.status === 'ACTIVE' && (!jobBased || jobActiveForMe)
          return {
            activityId: link.activityId,
            activityName: link.name,
            activityCode: link.code,
            description: link.description,
            allowManual: link.allowManual,
            requireJobNo: link.requireJobNo,
            /** INTERVAL: every interval during the shift. JOB: only while a job runs. MANUAL: no schedule. */
            mode,
            /** JOB: checked per job (start, intervals, end), with only the parameters that are due. */
            monitoring: link.monitoring,
            schedules: forType.map((s) => ({
              id: s.schedule.id,
              shiftId: s.schedule.shiftId,
              shiftName: s.shiftName,
              intervalMinutes: s.schedule.intervalMinutes,
              mode: s.schedule.mode,
              startTime: s.schedule.startTime ?? s.shiftStart,
              endTime: s.schedule.endTime ?? s.shiftEnd
            })),
            openCheck: open
              ? {
                  id: open.id,
                  code: open.code,
                  status: open.status,
                  scheduledAt: open.scheduledAt,
                  windowEndsAt: open.windowEndsAt,
                  submissionType: open.submissionType,
                  kind: open.kind,
                  parameterNames: parameterNames(machine.id, open.parameterIds),
                  ...openState(open)
                }
              : null,
            /** When this check type is next due; null when nothing is scheduled (manual, or no job). */
            nextDueAt: open?.scheduledAt ?? null,
            lastSubmittedAt: last,
            canStart,
            startMessage: canStart
              ? null
              : closure
                ? closure.planned
                  ? notRunningMessage(closure)
                  : `The plant is closed today (${closure.label}).`
                : !link.allowManual
                  ? 'This check can only be done when it is due.'
                  : jobBased && !jobActiveForMe
                    ? job
                      ? job.assignedWorkerId !== me
                        ? `The job is with ${job.assignedWorkerName ?? 'another worker'}.`
                        : job.status === 'STARTING'
                          ? 'Submit the Job Start check first.'
                          : 'The job is ending.'
                      : 'Start a job to check this.'
                    : 'This machine is not running.'
          }
        })
      return {
        id: machine.id,
        name: machine.name,
        code: machine.code,
        status: machine.status,
        runningJob: job,
        /** False when the plant is closed today or a machine day plan leaves this machine out. */
        runsToday: !closure,
        /** Why the machine does not run today (null when it runs). */
        notRunning: closure ? { label: closure.label, reason: closure.reason, planned: closure.planned, message: notRunningMessage(closure) } : null,
        /** True when at least one check type on this machine only runs during a job. */
        jobBased: checkTypes.some((c) => c.mode === 'JOB'),
        /** The running job's checks for this worker: Job Start, Job End and the next interval check. */
        jobChecks: job
          ? openChecks.filter((c) => c.machineId === machine.id && c.jobId === job.id && c.kind !== 'SCHEDULED').map(jobCheckSummary)
          : [],
        /** Jobs planned for this machine that this worker may start (assigned to them, or to nobody). */
        plannedJobs: planned.filter((j) => j.machineId === machine.id && (!j.assignedWorkerId || j.assignedWorkerId === me)),
        /** What the job-based check types ask at job start, at intervals and at job end. */
        jobPlan: (jobTypes.get(machine.id) ?? []).map((t) => ({
          activityId: t.activityId,
          name: t.name,
          start: t.parameters.filter((p) => p.frequency === 'JOB_START').map((p) => p.name),
          intervals: [...new Set(t.parameters.filter((p) => p.frequency === 'INTERVAL').map((p) => p.intervalMinutes))]
            .sort((a, b) => a - b)
            .map((minutes) => ({ minutes, parameters: t.parameters.filter((p) => p.frequency === 'INTERVAL' && p.intervalMinutes === minutes).map((p) => p.name) })),
          end: t.parameters.filter((p) => p.frequency === 'JOB_END').map((p) => p.name)
        })),
        checkTypes
      }
    })
  )
})

/** Open job checks of a job for this worker, in the order they should be done. */
async function openJobCheckSummaries(userId: string, jobId: string) {
  const checks = await listChecks({
    where: and(eq(qualityChecks.jobId, jobId), eq(qualityChecks.workerId, userId), inArray(qualityChecks.status, ['PENDING', 'DUE', 'IN_PROGRESS']))!
  })
  const order = { JOB_START: 0, JOB_END: 1, JOB_INTERVAL: 2, SCHEDULED: 3 } as const
  return checks.sort((a, b) => order[a.kind] - order[b.kind] || +new Date(a.scheduledAt) - +new Date(b.scheduledAt)).map(summary)
}

/** The worker responsible for a running job, or 403 for anyone else. */
async function assertJobWorker(userId: string, jobId: string) {
  const job = await jobById(jobId)
  if (!job) throw notFound('Job')
  await assertAssigned(userId, job.machineId)
  if (job.assignedWorkerId && job.assignedWorkerId !== userId) {
    throw forbidden('This job is assigned to another worker. Ask them to hand it over to you.')
  }
  return job
}

/**
 * Start Job: a planned job ({ plannedJobId }) or a new one ({ jobNo, itemCode }). The job
 * waits for its Job Start check(s) before interval checks begin; the response lists them.
 */
workerRouter.post('/machines/:machineId/jobs', async (req, res) => {
  const machineId = idParam(req, 'machineId')
  const body = z
    .object({
      plannedJobId: z.uuid().optional(),
      itemCode: z.string().trim().max(60).optional(),
      jobNo: z.string().trim().max(60).optional()
    })
    .refine((b) => b.plannedJobId || b.jobNo, { message: 'Enter the Job No.' })
    .parse(req.body)
  await assertAssigned(req.user!.id, machineId)
  const [machine] = await db.select().from(machines).where(eq(machines.id, machineId))
  if (!machine) throw notFound('Machine')
  if (!machine.isActive || machine.status !== 'ACTIVE') throw badRequest('This machine is not running.')
  await assertMachineRuns(machineId, new Date())

  const { job, startCheckIds } = await startJob({
    machineId,
    userId: req.user!.id,
    plannedJobId: body.plannedJobId ?? null,
    jobNo: body.jobNo ?? null,
    itemCode: body.itemCode ?? null
  })
  await audit(req, 'START_JOB', 'Job', job.id, {
    newValue: {
      machine: machine.name,
      itemCode: job.itemCode,
      jobNo: job.jobNo,
      planned: !!body.plannedJobId,
      startedAt: job.startedAt,
      startChecks: startCheckIds.length
    }
  })
  await prepareChecks([new Date()])
  const started = await jobDtoById(job.id)
  // The job's own fields stay at the top level for app versions that read the job directly.
  const startChecks = (await openJobCheckSummaries(req.user!.id, job.id)).filter((c) => c.kind === 'JOB_START')
  res.status(201).json({ ...started, job: started, startChecks })
})

/**
 * End Job, from the button or from "Continue or end?" after a check. The Job End check(s) are
 * created; the job completes when they are submitted (at once when there are none).
 */
workerRouter.post('/jobs/:id/end', async (req, res) => {
  const jobId = idParam(req)
  const job = await assertJobWorker(req.user!.id, jobId)
  const ended = await requestEnd(jobId, req.user!.id)
  // Checks of JOB-mode shift schedules nobody was told about go with the job.
  const removedChecks = ended.job.status === 'COMPLETED' ? await removePendingJobChecks(job.machineId) : 0
  await audit(req, ended.job.status === 'COMPLETED' ? 'END_JOB' : 'REQUEST_END_JOB', 'Job', jobId, {
    oldValue: { status: job.status, jobNo: job.jobNo },
    newValue: { status: ended.job.status, endChecks: ended.endCheckIds.length, withdrawnChecks: ended.withdrawn + removedChecks }
  })
  const now = await jobDtoById(jobId)
  // The job's own fields stay at the top level for app versions that read the job directly.
  const endChecks = (await openJobCheckSummaries(req.user!.id, jobId)).filter((c) => c.kind === 'JOB_END')
  res.json({ ...now, job: now, endChecks })
})

/** Workers who can take over a job on this machine, with their shift (for the handover sheet). */
workerRouter.get('/jobs/:id/handover-options', async (req, res) => {
  const job = await assertJobWorker(req.user!.id, idParam(req))
  const [workers, shiftRows] = await Promise.all([
    db
      .select({ id: users.id, name: users.name, employeeId: users.employeeId, shiftId: users.shiftId })
      .from(users)
      .innerJoin(workerMachines, eq(workerMachines.userId, users.id))
      .where(and(eq(workerMachines.machineId, job.machineId), eq(users.role, 'WORKER'), eq(users.isActive, true), eq(users.appAccess, true)))
      .orderBy(asc(users.name)),
    db
      .select({ id: shifts.id, name: shifts.name, startTime: shifts.startTime, endTime: shifts.endTime })
      .from(shifts)
      .where(eq(shifts.isActive, true))
      .orderBy(asc(shifts.startTime))
  ])
  res.json({ shifts: shiftRows, workers: workers.filter((w) => w.id !== req.user!.id) })
})

/** Handover Job: the running job and its open checks move to the chosen worker, who is notified. */
workerRouter.post('/jobs/:id/handover', async (req, res) => {
  const jobId = idParam(req)
  const body = z
    .object({ toUserId: z.uuid('Choose the worker'), shiftId: z.uuid().nullish(), note: z.string().trim().max(500).optional() })
    .parse(req.body)
  const job = await assertJobWorker(req.user!.id, jobId)
  const result = await handover({
    jobId,
    toUserId: body.toUserId,
    shiftId: body.shiftId ?? null,
    note: body.note || null,
    byUserId: req.user!.id,
    asWorker: true
  })
  const [machine] = await db.select({ name: machines.name }).from(machines).where(eq(machines.id, job.machineId))
  await sendToUser(
    body.toUserId,
    'Job handed over to you',
    `${machine?.name ?? 'Machine'} · Job ${job.jobNo}${job.itemCode ? ` · ${job.itemCode}` : ''} from ${req.user!.name}`,
    { jobId }
  )
  await audit(req, 'HANDOVER_JOB', 'Job', jobId, {
    oldValue: { assignedWorkerId: job.assignedWorkerId },
    newValue: { assignedWorkerId: body.toUserId, to: result.toName, shiftId: body.shiftId ?? null, note: body.note ?? null, movedChecks: result.movedChecks }
  })
  res.json({ job: await jobDtoById(jobId), movedChecks: result.movedChecks })
})

/** A job on one of the worker's machines: details, handovers, open checks and history. */
workerRouter.get('/jobs/:id', async (req, res) => {
  const jobId = idParam(req)
  const job = await jobDtoById(jobId)
  if (!job) throw notFound('Job')
  await assertAssigned(req.user!.id, job.machineId)
  const [checks, handovers, machineRow] = await Promise.all([
    listChecks({ where: eq(qualityChecks.jobId, jobId) }, { order: 'desc' }),
    jobHandoverList(jobId),
    db.select({ name: machines.name, code: machines.code }).from(machines).where(eq(machines.id, job.machineId))
  ])
  const isOpen = (status: string) => ['PENDING', 'DUE', 'IN_PROGRESS'].includes(status)
  res.json({
    job,
    machine: machineRow[0] ?? null,
    handovers,
    open: checks.filter((c) => isOpen(c.status) && c.workerId === req.user!.id).map(summary),
    history: checks
      .filter((c) => !isOpen(c.status))
      .map((c) => ({
        ...summary(c),
        workerName: c.submittedByName ?? c.workerName,
        values: c.values.map((v) => ({
          parameterName: v.parameterName,
          value: v.value,
          unit: v.unit,
          result: v.result,
          notApplicable: v.notApplicable,
          naReason: v.naReason
        })),
        exception: c.exception ? { reason: c.exception.reason, remark: c.exception.remark } : null
      }))
  })
})


/**
 * The worker starts a check without waiting for a notification. The schedule's open check is
 * reused when there is one, so a schedule never ends up with two open checks.
 */
workerRouter.post('/machines/:machineId/checks', async (req, res) => {
  const machineId = idParam(req, 'machineId')
  const body = z.object({ activityId: z.uuid('Choose a check type') }).parse(req.body)
  await assertAssigned(req.user!.id, machineId)

  const [machine] = await db.select().from(machines).where(eq(machines.id, machineId))
  if (!machine) throw notFound('Machine')
  if (!machine.isActive || machine.status !== 'ACTIVE') throw badRequest('This machine is not running.')

  const [activity] = await db.select().from(activities).where(eq(activities.id, body.activityId))
  if (!activity || !activity.isActive) throw notFound('Quality check type')
  if (!activity.allowManual) throw badRequest(`${activity.name} can only be done when it is due.`)
  const [link] = await db
    .select({ machineId: machineActivities.machineId })
    .from(machineActivities)
    .where(and(eq(machineActivities.machineId, machineId), eq(machineActivities.activityId, activity.id)))
  if (!link) throw badRequest(`${activity.name} is not set up for ${machine.name}.`)

  const now = new Date()
  await assertMachineRuns(machineId, now)
  await refreshStatuses()

  if (activity.monitoring === 'JOB') {
    // Job-based: checked within the job, by the worker responsible for it. Checking early brings the
    // next interval check forward with every interval parameter (their intervals restart from it).
    const running = await runningJob(machineId)
    if (!running) throw conflict('Start a job on this machine first.')
    if (running.assignedWorkerId !== req.user!.id) throw forbidden(`The job is with ${running.assignedWorkerName ?? 'another worker'}.`)
    const started = await startIntervalCheckNow(running.id, activity.id)
    const [jobCheck] = await listChecks({ ids: [started.id] })
    await audit(req, 'START_MANUAL_CHECK', 'QualityCheck', jobCheck.code, {
      newValue: { machine: machine.name, activity: activity.name, jobId: running.id, kind: 'JOB_INTERVAL', created: started.created }
    })
    return res.status(started.created ? 201 : 200).json({ ...summary(jobCheck), created: started.created })
  }

  const current = await currentSchedule(machineId, activity.id, now)
  const shift = current?.shift ?? (await shiftAt(now))
  const windowMinutes = Math.max(shift?.graceMinutes ?? 0, MIN_MANUAL_WINDOW_MINUTES)
  const windowEndsAt = new Date(now.getTime() + windowMinutes * MINUTE)
  const job = await runningJob(machineId)

  let checkId: string | null = null
  let created = false
  if (current) {
    const open = await openCheckOfSchedule(current.schedule.id)
    if (open && (open.status !== 'PENDING' || open.scheduledAt <= new Date(now.getTime() + EARLY_START_MINUTES * MINUTE))) {
      // A check is already open for this schedule: the worker fills that one in.
      await db
        .update(qualityChecks)
        .set({ submissionType: 'MANUAL', workerId: req.user!.id, jobId: job?.id ?? open.jobId })
        .where(eq(qualityChecks.id, open.id))
      checkId = open.id
    } else if (open) {
      // The next check is further away: it becomes this manual check, so the schedule keeps
      // exactly one open check and the old slot is never notified.
      await db
        .update(qualityChecks)
        .set({
          scheduledAt: now,
          windowEndsAt,
          status: 'DUE',
          submissionType: 'MANUAL',
          notifiedAt: now,
          workerId: req.user!.id,
          jobId: job?.id ?? null
        })
        .where(eq(qualityChecks.id, open.id))
      checkId = open.id
      created = true
    }
  }

  if (!checkId) {
    const [row] = await db
      .insert(qualityChecks)
      .values({
        code: makeCheckCode(now),
        scheduleId: current?.schedule.id ?? null,
        machineId,
        activityId: activity.id,
        workerId: req.user!.id,
        shiftId: current?.schedule.shiftId ?? shift?.id ?? null,
        jobId: job?.id ?? null,
        scheduledAt: now,
        windowEndsAt,
        status: 'DUE',
        submissionType: 'MANUAL',
        // Started by the worker: no "check is due" alert is needed for it.
        notifiedAt: now
      })
      .onConflictDoNothing()
      .returning({ id: qualityChecks.id })
    if (!row) throw conflict('A check is already open for this machine. Open it from the machine screen.')
    checkId = row.id
    created = true
  }

  const [check] = await listChecks({ ids: [checkId] })
  await audit(req, 'START_MANUAL_CHECK', 'QualityCheck', check.code, {
    newValue: { machine: machine.name, activity: activity.name, scheduledAt: check.scheduledAt, jobId: job?.id ?? null, created }
  })
  res.status(created ? 201 : 200).json({ ...summary(check), created })
})

/**
 * Whether the plant is closed today (Plant Calendar), shown at the top of the worker app. When a
 * machine day plan exists for today it decides for this worker's machines: the worker is "closed"
 * only when none of their machines runs, and open when one does, even on a closed plant day.
 */
workerRouter.get('/plant-status', async (req, res) => {
  const ids = await assignedMachineIds(req.user!.id)
  const { plan, closure } = await machineClosuresOn(ids, new Date())
  const plantClosed = closure
    ? { closed: true, date: closure.date, type: closure.type, label: closure.label, reason: closure.reason, weeklyOff: closure.weeklyOff }
    : null
  if (!plan || ids.length === 0) return res.json({ ...(plantClosed ?? { closed: false }), machinePlan: null })

  const running = ids.filter((id) => plan.has(id))
  const machinePlan = { planned: true, runningMachineIds: running, count: running.length }
  if (running.length) return res.json({ closed: false, plantClosed: !!closure, machinePlan })
  res.json(
    plantClosed
      ? { ...plantClosed, planned: true, machinePlan }
      : {
          closed: true,
          date: dateKey(new Date()),
          type: 'CLOSED',
          label: 'Not scheduled to run',
          reason: 'None of your machines is scheduled to run today.',
          weeklyOff: false,
          planned: true,
          machinePlan
        }
  )
})

workerRouter.get('/checks/today', async (req, res) => {
  const today = startOfDay(new Date())
  await prepareChecks([today])
  const checks = await listChecks({ from: today, to: addDays(today, 1), where: await workerScope(req.user!.id) })
  res.json(checks.map(summary))
})

/** Filter options for the history screen: only machines this worker has records for. */
workerRouter.get('/history/filters', async (req, res) => {
  const scope = await workerScope(req.user!.id)
  const rows = await db
    .selectDistinct({
      machineId: machines.id,
      machineName: machines.name,
      departmentId: departments.id,
      departmentName: departments.name
    })
    .from(qualityChecks)
    .innerJoin(machines, eq(qualityChecks.machineId, machines.id))
    .leftJoin(departments, eq(machines.departmentId, departments.id))
    .where(and(scope, isNotNull(qualityChecks.submittedAt)))
    .orderBy(asc(machines.name))

  const departmentList = new Map<string, { id: string; name: string }>()
  for (const r of rows) if (r.departmentId && r.departmentName) departmentList.set(r.departmentId, { id: r.departmentId, name: r.departmentName })

  res.json({
    machines: rows.map((r) => ({ id: r.machineId, name: r.machineName })),
    departments: [...departmentList.values()].sort((a, b) => a.name.localeCompare(b.name))
  })
})

/** Everything this worker has submitted, newest first, one page at a time. */
workerRouter.get('/checks/history', async (req, res) => {
  const q = z
    .object({
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(50).default(10),
      from: z.string().optional(),
      to: z.string().optional(),
      machineId: z.uuid().optional(),
      departmentId: z.uuid().optional(),
      kind: z.enum(['ALL', 'CHECK', 'EXCEPTION']).default('ALL')
    })
    .parse(req.query)

  let from: Date | undefined
  let to: Date | undefined
  try {
    if (q.from) from = parseDateKey(q.from)
    if (q.to) to = addDays(parseDateKey(q.to), 1)
  } catch {
    throw badRequest('Invalid date')
  }
  if (from && to && to <= from) throw badRequest('The "to" date must be on or after the "from" date')

  const statuses =
    q.kind === 'CHECK' ? (['COMPLETED'] as const) : q.kind === 'EXCEPTION' ? (['EXCEPTION'] as const) : (['COMPLETED', 'EXCEPTION'] as const)

  // Dates filter on the submission time, which is what the worker sees in the list.
  const submitted: SQL[] = [eq(qualityChecks.submittedById, req.user!.id)]
  if (from) submitted.push(gte(qualityChecks.submittedAt, from))
  if (to) submitted.push(lt(qualityChecks.submittedAt, to))

  const filters = {
    statuses: [...statuses],
    machineId: q.machineId,
    departmentId: q.departmentId,
    where: and(...submitted)
  }

  const total = await countChecks(filters)
  const totalPages = Math.max(1, Math.ceil(total / q.pageSize))
  const page = Math.min(q.page, totalPages)
  const checks = await listChecks(filters, {
    order: 'desc',
    orderBy: 'submittedAt',
    limit: q.pageSize,
    offset: (page - 1) * q.pageSize
  })

  res.json({
    items: checks.map((c) => ({
      ...summary(c),
      machineName: c.machineName,
      departmentName: c.departmentName,
      exceptionReason: c.exception?.reason ?? null,
      photoUrl: c.media.find((m) => m.kind === 'PHOTO')?.url ?? c.exception?.media.find((m) => m.kind === 'PHOTO')?.url ?? null,
      hasVideo: c.media.some((m) => m.kind === 'VIDEO'),
      valueCount: c.values.length
    })),
    page,
    pageSize: q.pageSize,
    total,
    totalPages
  })
})

/** One submitted record with all its values and evidence. */
workerRouter.get('/checks/:id/record', async (req, res) => {
  const check = await loadWorkerCheck(req.user!.id, idParam(req))
  res.json({
    ...summary(check),
    machineName: check.machineName,
    machineCode: check.machineCode,
    departmentName: check.departmentName,
    shiftName: check.shiftName,
    values: check.values,
    media: check.media,
    exception: check.exception,
    submittedByName: check.submittedByName
  })
})

/** The reasons a worker may pick when marking a parameter Not Applicable. */
async function activeNaReasons() {
  return db
    .select({ id: monitoringReasons.id, label: monitoringReasons.label, requiresRemark: monitoringReasons.requiresRemark })
    .from(monitoringReasons)
    .where(eq(monitoringReasons.isActive, true))
    .orderBy(asc(monitoringReasons.sortOrder), asc(monitoringReasons.label))
}

/** Reason used when a "only while a job is running" parameter is skipped automatically. */
const NO_JOB_REASON = 'No job running'

/** The check with its current form configuration. Always read fresh from the database. */
workerRouter.get('/checks/:id', async (req, res) => {
  await refreshStatuses()
  const check = await loadWorkerCheck(req.user!.id, idParam(req))
  const [activity] = await db.select().from(activities).where(eq(activities.id, check.activityId))
  if (!activity) throw notFound('Quality check type')
  const [params, naReasons, job] = await Promise.all([
    formParameters(activity.id, check.parameterIds),
    activeNaReasons(),
    // A job check belongs to its own job; any other check to the job running now.
    check.jobId && check.kind !== 'SCHEDULED' ? jobDtoById(check.jobId) : runningJob(check.machineId)
  ])

  res.json({
    check: summary(check),
    /** Job Start / Job End checks cannot be skipped with an exception: the job waits for them. */
    allowException: check.kind === 'SCHEDULED' || check.kind === 'JOB_INTERVAL',
    activity: {
      id: activity.id,
      name: activity.name,
      description: activity.description,
      /** "Overall check photo/video", next to the per-parameter evidence below. */
      requirePhoto: activity.requirePhoto,
      requireVideo: activity.requireVideo,
      requireJobNo: activity.requireJobNo,
      allowManual: activity.allowManual
    },
    parameters: params.map((p) => ({
      ...p,
      rule: ruleText(p),
      /** False for a "only while a job is running" parameter when no job runs: it is auto N/A. */
      applicable: p.appliesWhen === 'ALWAYS' || !!job,
      notApplicableReason: p.appliesWhen === 'JOB_RUNNING' && !job ? NO_JOB_REASON : null
    })),
    naReasons,
    job,
    overallEvidence: { photo: activity.requirePhoto, video: activity.requireVideo },
    exceptionReasons: EXCEPTION_REASONS,
    maxVideoSeconds: config.maxVideoSeconds,
    captureFreshnessMinutes: config.captureFreshnessMinutes
  })
})

async function assertOpen(userId: string, checkId: string) {
  await refreshStatuses()
  const check = await loadWorkerCheck(userId, checkId)
  const state = openState(check)
  if (!state.canSubmit) throw conflict(state.message ?? 'This check cannot be submitted')
  return check
}

/**
 * Evidence field names depend on the form, so the file limit is worked out per check:
 * one photo and one video per parameter, plus the overall photo and video.
 */
const submitUpload: import('express').RequestHandler = async (req, res, next) => {
  try {
    const [row] = await db
      .select({ activityId: qualityChecks.activityId })
      .from(qualityChecks)
      .where(eq(qualityChecks.id, idParam(req)))
    const [count] = row
      ? await db
          .select({ n: sql<number>`count(*)::int` })
          .from(activityParameters)
          .where(and(eq(activityParameters.activityId, row.activityId), eq(activityParameters.isEnabled, true)))
      : [{ n: 0 }]
    checkEvidenceUpload(2 * (count?.n ?? 0) + 2)(req, res, next)
  } catch (err) {
    next(err)
  }
}

workerRouter.post('/checks/:id/submit', submitUpload, async (req, res) => {
  const uploaded = req.files as UploadedFiles | undefined
  let stored: StoredEvidence[] = []
  try {
    const checkId = idParam(req)
    const body = z
      .object({
        itemCode: z.string().trim().max(60).default(''),
        jobNo: z.string().trim().max(60).default(''),
        values: z
          .string()
          .default('[]')
          .transform((v, ctx) => {
            try {
              return JSON.parse(v)
            } catch {
              ctx.addIssue({ code: 'custom', message: 'Invalid values' })
              return z.NEVER
            }
          })
          .pipe(
            z.array(
              z.object({
                parameterId: z.uuid(),
                value: z.union([z.string(), z.number(), z.null()]).optional(),
                notApplicable: z.boolean().optional(),
                naReasonId: z.uuid().nullish(),
                naRemark: z.string().trim().max(500).nullish()
              })
            )
          ),
        /** [{ field: "photo:<parameterId>", capturedAt, durationSeconds }] for every file sent. */
        evidence: z
          .string()
          .default('[]')
          .transform((v, ctx) => {
            try {
              return JSON.parse(v)
            } catch {
              ctx.addIssue({ code: 'custom', message: 'Invalid evidence' })
              return z.NEVER
            }
          })
          .pipe(
            z.array(
              z.object({
                field: z.string().min(1).max(80),
                capturedAt: z.string().optional(),
                durationSeconds: z.coerce.number().min(0).optional()
              })
            )
          ),
        photoCapturedAt: z.string().optional(),
        videoCapturedAt: z.string().optional(),
        videoDurationSeconds: z.coerce.number().min(0).optional(),
        deviceInfo: z.string().trim().max(200).optional()
      })
      .parse(req.body)

    const check = await assertOpen(req.user!.id, checkId)
    const [activity] = await db.select().from(activities).where(eq(activities.id, check.activityId))
    const isJobCheck = check.kind !== 'SCHEDULED' && !!check.jobId
    const [params, reasons, job] = await Promise.all([
      formParameters(check.activityId, check.parameterIds),
      db.select().from(monitoringReasons),
      isJobCheck ? jobDtoById(check.jobId!) : runningJob(check.machineId)
    ])

    const files = filesByField(uploaded)
    const byParameter = new Map(params.map((p) => [p.id, p]))
    for (const field of files.keys()) {
      const parameterId = fieldParameterId(field)
      if (parameterId && !byParameter.has(parameterId)) throw badRequest(`Unexpected file for "${field}"`)
    }
    const capture = new Map(body.evidence.map((e) => [e.field, e]))
    const evidenceFor = (field: string, label: string): EvidenceInput | null => {
      const file = files.get(field)
      if (!file) return null
      const kind = fieldKind(field)
      const manifest = capture.get(field)
      const legacy = field === 'photo' ? body.photoCapturedAt : field === 'video' ? body.videoCapturedAt : undefined
      return {
        file,
        kind,
        parameterId: fieldParameterId(field),
        label,
        capturedAt: manifest?.capturedAt ?? legacy,
        durationSeconds: manifest?.durationSeconds ?? (field === 'video' ? body.videoDurationSeconds : undefined)
      }
    }

    // Item Code and Job No. come from the running job when the worker did not type them.
    const itemCode = body.itemCode || job?.itemCode || ''
    const jobNo = body.jobNo || job?.jobNo || ''
    const missing: string[] = []
    const missingMedia: string[] = []
    if (activity.requireJobNo && !jobNo) missing.push('Job No.')

    const submitted = new Map(body.values.map((v) => [v.parameterId, v]))
    const valueRows: (typeof qualityCheckValues.$inferInsert)[] = []
    const evidence: EvidenceInput[] = []
    for (const [index, p] of params.entries()) {
      const entry = submitted.get(p.id)
      const base = {
        checkId,
        parameterId: p.id,
        parameterName: p.name,
        parameterType: p.type,
        unit: p.unit,
        rule: ruleText(p),
        appliesWhen: p.appliesWhen,
        sortOrder: index
      }
      const applicable = p.appliesWhen === 'ALWAYS' || !!job

      if (!applicable) {
        // "Only while a job is running" and no job: recorded as Not Applicable, never Missed or FAIL.
        valueRows.push({ ...base, ...notApplicableValue(NO_JOB_REASON, entry?.naRemark ?? null) })
        continue
      }

      if (entry?.notApplicable) {
        if (!p.allowNa) throw badRequest(`${p.name} cannot be marked Not Applicable`)
        const reason = reasons.find((r) => r.id === entry.naReasonId)
        if (!reason || !reason.isActive) throw badRequest(`Choose a reason for ${p.name}`)
        if (reason.requiresRemark && !entry.naRemark) throw badRequest(`Please write a remark for ${p.name}`)
        valueRows.push({ ...base, ...notApplicableValue(reason.label, entry.naRemark ?? null) })
        continue
      }

      if (p.type === 'PHOTO') {
        // A Photo parameter (e.g. Ink Photo): the photo is the answer, so "Required" means the
        // photo is required. A video is only asked for when the Video rule is on.
        const photo = evidenceFor(`photo:${p.id}`, `${p.name} photo`)
        const video = evidenceFor(`video:${p.id}`, `${p.name} video`)
        if ((p.isRequired || p.requirePhoto) && !photo) missingMedia.push(`${p.name} photo`)
        if (p.requireVideo && !video) missingMedia.push(`${p.name} video`)
        valueRows.push({ ...base, ...(photo ? readingValue(p, PHOTO_VALUE) : emptyValue()) })
        if (photo) evidence.push(photo)
        if (video) evidence.push(video)
        continue
      }

      const raw = entry?.value
      if (isEmpty(raw)) {
        if (p.isRequired) missing.push(p.name)
        else valueRows.push({ ...base, ...emptyValue() })
      } else {
        valueRows.push({ ...base, ...readingValue(p, raw) })
      }

      const photo = evidenceFor(`photo:${p.id}`, `${p.name} photo`)
      const video = evidenceFor(`video:${p.id}`, `${p.name} video`)
      if (p.requirePhoto && !photo) missingMedia.push(`${p.name} photo`)
      if (p.requireVideo && !video) missingMedia.push(`${p.name} video`)
      if (photo) evidence.push(photo)
      if (video) evidence.push(video)
    }
    if (missing.length) throw badRequest(`Please fill: ${missing.join(', ')}`)
    if (missingMedia.length) throw badRequest(`Please add: ${missingMedia.join(', ')}`)

    // Overall check evidence (the legacy `photo` / `video` fields).
    const overallPhoto = evidenceFor('photo', 'Photo')
    const overallVideo = evidenceFor('video', 'Video')
    if (activity.requirePhoto && !overallPhoto) throw badRequest('Please take a photo')
    if (activity.requireVideo && !overallVideo) throw badRequest('Please record a video')
    if (overallPhoto) evidence.push(overallPhoto)
    if (overallVideo) evidence.push(overallVideo)

    stored = await storeEvidence(evidence, 'quality-checks')

    // A submitted check is Completed. Readings outside limits stay recorded as FAIL on the
    // reading; a Not Applicable parameter is never a failure.
    const failed = valueRows.some((v) => v.result === 'FAIL')
    const status = 'COMPLETED'
    const submittedAt = new Date()
    const submissionType = check.submissionType ?? 'NOTIFICATION'
    let nextDueAt: Date | null = null

    await db.transaction(async (tx) => {
      const updated = await tx
        .update(qualityChecks)
        .set({
          status,
          overallResult: failed ? 'FAIL' : 'PASS',
          itemCode: itemCode || null,
          jobNo: jobNo || null,
          jobId: job?.id ?? check.jobId ?? null,
          submissionType,
          submittedAt,
          submittedById: req.user!.id,
          workerId: check.workerId ?? req.user!.id,
          deviceInfo: body.deviceInfo ?? null
        })
        .where(and(eq(qualityChecks.id, checkId), inArray(qualityChecks.status, ['PENDING', 'DUE', 'IN_PROGRESS'])))
        .returning({ id: qualityChecks.id })
      if (!updated.length) throw conflict('This check was already submitted')

      // The monitoring timer restarts from this submission (services/monitoringTimer.ts).
      if (check.scheduleId) {
        nextDueAt = await resetScheduleTimer(tx, check.scheduleId, checkId, submittedAt)
        await tx.update(qualityChecks).set({ nextDueAt }).where(eq(qualityChecks.id, checkId))
      }

      if (valueRows.length) await tx.insert(qualityCheckValues).values(valueRows)
      if (stored.length) {
        await tx.insert(media).values(stored.map((s) => ({ ...s, checkId, uploadedById: req.user!.id })))
      }
      await audit(
        req,
        'SUBMIT_CHECK',
        'QualityCheck',
        check.code,
        {
          oldValue: { status: check.status },
          newValue: {
            status,
            submissionType,
            itemCode,
            jobNo,
            jobId: job?.id ?? null,
            nextDueAt,
            values: valueRows.map((v) => ({
              name: v.parameterName,
              value: v.value,
              result: v.result,
              notApplicable: v.notApplicable ?? false,
              naReason: v.naReason ?? null,
              naRemark: v.naRemark ?? null
            })),
            media: stored.map((m) => ({ kind: m.kind, parameterId: m.parameterId }))
          }
        },
        tx
      )
    })

    // Videos are compressed in the background once the answer has gone to the worker, so it never
    // waits for it and the compression never competes with this submission's own work.
    if (stored.some((m) => m.processing === 'PENDING')) res.once('finish', () => void kickVideoOptimization())

    // The job moves on: active after its Job Start check, completed after its Job End check.
    let jobActivated = false
    let jobCompleted = false
    if (isJobCheck && check.kind === 'JOB_START') jobActivated = await activateIfStarted(check.jobId!)
    if (isJobCheck && check.kind === 'JOB_END') {
      jobCompleted = await completeIfEnded(check.jobId!, req.user!.id)
      if (jobCompleted) await audit(req, 'END_JOB', 'Job', check.jobId!, { newValue: { jobNo: job?.jobNo, completedBy: 'Job End check' } })
    }

    // Create the next check straight away and record when it is really due.
    const settled = await settleNextDue({ id: checkId, scheduleId: check.scheduleId, machineId: check.machineId, activityId: check.activityId })

    const [result] = await listChecks({ ids: [checkId] })
    const jobNow = isJobCheck ? await jobDtoById(check.jobId!) : null
    res.json({
      ...summary(result),
      nextDueAt: settled,
      notApplicableCount: valueRows.filter((v) => v.notApplicable).length,
      job: jobNow,
      jobActivated,
      jobCompleted,
      /** After a scheduled job check: ask the worker "Continue the job or end the job?". */
      askContinue: check.kind === 'JOB_INTERVAL' && jobNow?.status === 'ACTIVE' && jobNow.assignedWorkerId === req.user!.id,
      /** Job checks still open for this job (e.g. another check type's Job Start / Job End check). */
      pendingJobChecks: isJobCheck ? await openJobCheckSummaries(req.user!.id, check.jobId!) : []
    })
  } catch (err) {
    await removeStored(stored)
    throw err
  } finally {
    await cleanupTemp(uploaded)
  }
})

workerRouter.post('/checks/:id/exception', evidenceUpload, async (req, res) => {
  const files = req.files as UploadedFiles | undefined
  let stored: StoredEvidence[] = []
  try {
    const checkId = idParam(req)
    const body = z
      .object({
        reason: z.enum(EXCEPTION_REASONS, 'Please choose a reason'),
        remark: z.string().trim().max(1000).default(''),
        photoCapturedAt: z.string().optional(),
        deviceInfo: z.string().trim().max(200).optional()
      })
      .parse(req.body)
    if (body.reason === 'Other' && !body.remark) throw badRequest('Please write a remark')

    const check = await assertOpen(req.user!.id, checkId)
    if (check.kind === 'JOB_START' || check.kind === 'JOB_END') {
      throw badRequest(
        `The Job ${check.kind === 'JOB_START' ? 'Start' : 'End'} check cannot be skipped. Mark a parameter Not applicable where allowed, or ask a supervisor to close the job.`
      )
    }
    const photo = filesByField(files).get('photo')
    if (!photo) throw badRequest('Please take a photo')

    stored = await storeEvidence([{ file: photo, kind: 'PHOTO', capturedAt: body.photoCapturedAt }], 'exceptions')

    await db.transaction(async (tx) => {
      const updated = await tx
        .update(qualityChecks)
        .set({
          status: 'EXCEPTION',
          overallResult: null,
          submittedAt: new Date(),
          submittedById: req.user!.id,
          workerId: check.workerId ?? req.user!.id,
          deviceInfo: body.deviceInfo ?? null
        })
        .where(and(eq(qualityChecks.id, checkId), inArray(qualityChecks.status, ['PENDING', 'DUE', 'IN_PROGRESS'])))
        .returning({ id: qualityChecks.id })
      if (!updated.length) throw conflict('This check was already submitted')

      const [exception] = await tx
        .insert(checkExceptions)
        .values({ checkId, workerId: req.user!.id, machineId: check.machineId, reason: body.reason, remark: body.remark || null })
        .returning()
      await tx.insert(media).values(stored.map((s) => ({ ...s, exceptionId: exception.id, uploadedById: req.user!.id })))
      await audit(
        req,
        'SUBMIT_EXCEPTION',
        'QualityCheck',
        check.code,
        { oldValue: { status: check.status }, newValue: { status: 'EXCEPTION', reason: body.reason, remark: body.remark } },
        tx
      )
    })

    const [result] = await listChecks({ ids: [checkId] })
    res.json(summary(result))
  } catch (err) {
    await removeStored(stored)
    throw err
  } finally {
    await cleanupTemp(files)
  }
})
