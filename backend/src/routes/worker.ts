import { Router } from 'express'
import { z } from 'zod'
import { and, asc, eq, gte, inArray, isNotNull, lt, sql, type SQL } from 'drizzle-orm'
import { config } from '../config'
import { db } from '../db/client'
import {
  activities,
  activityParameters,
  departments,
  machines,
  checkExceptions,
  media,
  parameters,
  pushTokens,
  qualityCheckValues,
  qualityChecks,
  users,
  workerMachines
} from '../db/schema'
import { idParam } from '../lib/validate'
import { badRequest, conflict, notFound } from '../lib/http'
import { audit } from '../lib/audit'
import { MINUTE, addDays, parseDateKey, startOfDay } from '../lib/time'
import { countChecks, listChecks, type CheckDto } from '../services/checks'
import { prepareChecks, refreshStatuses } from '../services/checkGenerator'
import { evaluateValue, isEmpty, ruleText } from '../services/evaluate'
import {
  cleanupTemp,
  evidenceUpload,
  removeStored,
  storeEvidence,
  type StoredEvidence,
  type UploadedFiles
} from '../services/uploads'
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

function openState(check: CheckDto): { canSubmit: boolean; message: string | null } {
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
    machineId: check.machineId,
    machineName: check.machineName,
    machineCode: check.machineCode,
    departmentName: check.departmentName,
    activityName: check.activityName,
    scheduledAt: check.scheduledAt,
    windowEndsAt: check.windowEndsAt,
    status: check.status,
    result: check.result,
    jobNo: check.jobNo,
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

/** Machines the admin has assigned to this worker, shown on the profile screen. */
workerRouter.get('/machines', async (req, res) => {
  const ids = await assignedMachineIds(req.user!.id)
  if (ids.length === 0) return res.json([])
  const rows = await db
    .select({ id: machines.id, name: machines.name, code: machines.code })
    .from(machines)
    .where(inArray(machines.id, ids))
    .orderBy(asc(machines.name))
  res.json(rows)
})

/** Whether the plant is closed today (Plant Calendar), shown at the top of the worker app. */
workerRouter.get('/plant-status', async (_req, res) => {
  const closure = await closureOn(new Date())
  res.json(closure ? { closed: true, date: closure.date, type: closure.type, label: closure.label, reason: closure.reason } : { closed: false })
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

/** The check with its current form configuration. Always read fresh from the database. */
workerRouter.get('/checks/:id', async (req, res) => {
  await refreshStatuses()
  const check = await loadWorkerCheck(req.user!.id, idParam(req))
  const [activity] = await db.select().from(activities).where(eq(activities.id, check.activityId))
  if (!activity) throw notFound('Quality check type')
  const params = await formParameters(activity.id)

  res.json({
    check: summary(check),
    activity: {
      id: activity.id,
      name: activity.name,
      description: activity.description,
      requirePhoto: activity.requirePhoto,
      requireVideo: activity.requireVideo,
      requireJobNo: activity.requireJobNo
    },
    parameters: params.map((p) => ({ ...p, rule: ruleText(p) })),
    exceptionReasons: EXCEPTION_REASONS,
    maxVideoSeconds: config.maxVideoSeconds
  })
})

async function assertOpen(userId: string, checkId: string) {
  await refreshStatuses()
  const check = await loadWorkerCheck(userId, checkId)
  const state = openState(check)
  if (!state.canSubmit) throw conflict(state.message ?? 'This check cannot be submitted')
  return check
}

workerRouter.post('/checks/:id/submit', evidenceUpload, async (req, res) => {
  const files = req.files as UploadedFiles | undefined
  let stored: StoredEvidence[] = []
  try {
    const checkId = idParam(req)
    const body = z
      .object({
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
          .pipe(z.array(z.object({ parameterId: z.uuid(), value: z.union([z.string(), z.number(), z.null()]) }))),
        photoCapturedAt: z.string().optional(),
        videoCapturedAt: z.string().optional(),
        videoDurationSeconds: z.coerce.number().min(0).optional(),
        deviceInfo: z.string().trim().max(200).optional()
      })
      .parse(req.body)

    const check = await assertOpen(req.user!.id, checkId)
    const [activity] = await db.select().from(activities).where(eq(activities.id, check.activityId))
    const params = await formParameters(check.activityId)

    const missing: string[] = []
    if (activity.requireJobNo && !body.jobNo) missing.push('Job No.')

    const submitted = new Map(body.values.map((v) => [v.parameterId, v.value]))
    const valueRows: (typeof qualityCheckValues.$inferInsert)[] = []
    for (const [index, p] of params.entries()) {
      const raw = submitted.get(p.id)
      const base = { checkId, parameterId: p.id, parameterName: p.name, parameterType: p.type, unit: p.unit, rule: ruleText(p), sortOrder: index }
      if (isEmpty(raw)) {
        if (p.isRequired) missing.push(p.name)
        else valueRows.push({ ...base, value: null, result: 'NA' })
        continue
      }
      valueRows.push({ ...base, ...evaluateValue(p, raw) })
    }
    if (missing.length) throw badRequest(`Please fill: ${missing.join(', ')}`)

    const photo = files?.photo?.[0]
    const video = files?.video?.[0]
    if (activity.requirePhoto && !photo) throw badRequest('Please take a photo')
    if (activity.requireVideo && !video) throw badRequest('Please record a video')

    stored = await storeEvidence(
      [
        ...(photo ? [{ file: photo, kind: 'PHOTO' as const, capturedAt: body.photoCapturedAt }] : []),
        ...(video
          ? [{ file: video, kind: 'VIDEO' as const, capturedAt: body.videoCapturedAt, durationSeconds: body.videoDurationSeconds }]
          : [])
      ],
      'quality-checks'
    )

    // A submitted check is Completed. Readings outside limits stay recorded as FAIL on the reading.
    const failed = valueRows.some((v) => v.result === 'FAIL')
    const status = 'COMPLETED'

    await db.transaction(async (tx) => {
      const updated = await tx
        .update(qualityChecks)
        .set({
          status,
          overallResult: failed ? 'FAIL' : 'PASS',
          jobNo: body.jobNo || null,
          submittedAt: new Date(),
          submittedById: req.user!.id,
          workerId: check.workerId ?? req.user!.id,
          deviceInfo: body.deviceInfo ?? null
        })
        .where(and(eq(qualityChecks.id, checkId), inArray(qualityChecks.status, ['PENDING', 'DUE', 'IN_PROGRESS'])))
        .returning({ id: qualityChecks.id })
      if (!updated.length) throw conflict('This check was already submitted')

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
          newValue: { status, jobNo: body.jobNo, values: valueRows.map((v) => ({ name: v.parameterName, value: v.value, result: v.result })) }
        },
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
    const photo = files?.photo?.[0]
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
