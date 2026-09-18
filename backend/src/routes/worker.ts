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
import { MINUTE, addDays, parseDateKey, startOfDay } from '../lib/time'
import { countChecks, listChecks, type CheckDto } from '../services/checks'
import {
  MIN_MANUAL_WINDOW_MINUTES,
  currentSchedule,
  makeCheckCode,
  openCheckOfSchedule,
  prepareChecks,
  refreshStatuses
} from '../services/checkGenerator'
import { emptyValue, isEmpty, notApplicableValue, readingValue, ruleText } from '../services/evaluate'
import { endJob, jobById, runningJob, runningJobs, startJob, type JobDto } from '../services/jobs'
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
import { shiftAt } from '../services/workerAssignment'
import { loadProfile } from './auth'
import { webPushPublicKey } from '../services/webPush'
import { closureOn } from '../services/plantCalendar'

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

async function formParameters(activityId: string) {
  return db
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

/** Refuses anything that would start a check or a job while the plant is closed. */
async function assertPlantOpen(at: Date) {
  const closure = await closureOn(at)
  if (closure) {
    throw badRequest(`The plant is closed today (${closure.label}${closure.reason ? `: ${closure.reason}` : ''}).`)
  }
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

  const [rows, links, scheduleRows, openChecks, lastDone, jobs, closure] = await Promise.all([
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
        requireJobNo: activities.requireJobNo
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
        submissionType: qualityChecks.submissionType
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
    closureOn(new Date())
  ])

  res.json(
    rows.map((machine) => {
      const job = jobs.get(machine.id) ?? null
      const checkTypes = links
        .filter((l) => l.machineId === machine.id)
        .map((link) => {
          const forType = scheduleRows.filter((s) => s.schedule.machineId === machine.id && s.schedule.activityId === link.activityId)
          const open = openChecks.find((c) => c.machineId === machine.id && c.activityId === link.activityId) ?? null
          const last = lastDone.find((l) => l.machineId === machine.id && l.activityId === link.activityId)?.at ?? null
          const mode = forType.length === 0 ? 'MANUAL' : forType.some((s) => s.schedule.mode === 'JOB') ? 'JOB' : 'INTERVAL'
          const canStart = link.allowManual && !closure && machine.isActive && machine.status === 'ACTIVE'
          return {
            activityId: link.activityId,
            activityName: link.name,
            activityCode: link.code,
            description: link.description,
            allowManual: link.allowManual,
            requireJobNo: link.requireJobNo,
            /** INTERVAL: every interval during the shift. JOB: only while a job runs. MANUAL: no schedule. */
            mode,
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
                ? `The plant is closed today (${closure.label}).`
                : !link.allowManual
                  ? 'This check can only be done when it is due.'
                  : 'This machine is not running.'
          }
        })
      return {
        id: machine.id,
        name: machine.name,
        code: machine.code,
        status: machine.status,
        runningJob: job,
        /** True when at least one check type on this machine only runs during a job. */
        jobBased: checkTypes.some((c) => c.mode === 'JOB'),
        checkTypes
      }
    })
  )
})

/**
 * Starts a job on the machine. JOB schedules become due from here, and every check submitted
 * while it runs records the job number.
 */
workerRouter.post('/machines/:machineId/jobs', async (req, res) => {
  const machineId = idParam(req, 'machineId')
  const body = z
    .object({ itemCode: z.string().trim().max(60).optional(), jobNo: z.string().trim().min(1, 'Enter the Job No.').max(60) })
    .parse(req.body)
  await assertAssigned(req.user!.id, machineId)
  const [machine] = await db.select().from(machines).where(eq(machines.id, machineId))
  if (!machine) throw notFound('Machine')
  await assertPlantOpen(new Date())

  const job = await startJob(machineId, body.jobNo, req.user!.id, body.itemCode || null)
  await audit(req, 'START_JOB', 'Job', job.id, {
    newValue: { machine: machine.name, itemCode: job.itemCode, jobNo: job.jobNo, startedAt: job.startedAt }
  })
  await prepareChecks([new Date()])
  res.status(201).json(job)
})

/** Ends the running job. Checks nobody was told about disappear with it. */
workerRouter.post('/jobs/:id/end', async (req, res) => {
  const jobId = idParam(req)
  const job = await jobById(jobId)
  if (!job) throw notFound('Job')
  await assertAssigned(req.user!.id, job.machineId)
  const ended = await endJob(jobId, req.user!.id)
  await audit(req, 'END_JOB', 'Job', jobId, {
    oldValue: { jobNo: job.jobNo, startedAt: job.startedAt },
    newValue: { endedAt: ended.job.endedAt, removedChecks: ended.removedChecks }
  })
  res.json(ended.job)
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
  await assertPlantOpen(now)
  await refreshStatuses()

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

/** Whether the plant is closed today (Plant Calendar), shown at the top of the worker app. */
workerRouter.get('/plant-status', async (_req, res) => {
  const closure = await closureOn(new Date())
  res.json(
    closure
      ? { closed: true, date: closure.date, type: closure.type, label: closure.label, reason: closure.reason, weeklyOff: closure.weeklyOff }
      : { closed: false }
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
    formParameters(activity.id),
    activeNaReasons(),
    runningJob(check.machineId)
  ])

  res.json({
    check: summary(check),
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
    const [params, reasons, job] = await Promise.all([
      formParameters(check.activityId),
      db.select().from(monitoringReasons),
      runningJob(check.machineId)
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

    // Create the next check straight away and record when it is really due.
    const settled = await settleNextDue({ id: checkId, scheduleId: check.scheduleId, machineId: check.machineId, activityId: check.activityId })

    const [result] = await listChecks({ ids: [checkId] })
    res.json({
      ...summary(result),
      nextDueAt: settled,
      notApplicableCount: valueRows.filter((v) => v.notApplicable).length
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
