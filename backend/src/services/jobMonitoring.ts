import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { db } from '../db/client'
import {
  activities,
  activityParameters,
  jobHandovers,
  jobs,
  machineActivities,
  parameters,
  qualityChecks,
  shifts,
  users,
  workerMachines
} from '../db/schema'
import { badRequest, conflict, forbidden, notFound } from '../lib/http'
import { MINUTE, addDays, dateKey, startOfDay } from '../lib/time'
import { invalidateCheckGeneration, makeCheckCode } from './checkGenerator'
import { machineOffBetween } from './plantCalendar'
import { shiftAt, shiftFor } from './workerAssignment'

/**
 * Job-based quality monitoring.
 *
 * A check type with monitoring = JOB is checked per job, not per shift schedule. Each of its
 * parameters says when it is checked: at job start, every N minutes while the job runs, or at job
 * end. A job goes:
 *
 *   PLANNED  (optional: planned by an Admin/Manager)
 *   STARTING Start Job: one Job Start check per check type with Job Start parameters
 *   ACTIVE   once every Job Start check is submitted; interval checks from then on
 *   ENDING   End Job: open interval checks are withdrawn, one Job End check per check type
 *   COMPLETED once every Job End check is submitted (or an Admin/Manager force-closes the job)
 *
 * Every job check lists exactly the parameters it asks for (quality_checks.parameter_ids), so a
 * notification shows only what is due. Checks go to the job's assigned worker; a handover moves
 * the job and its open checks to the next worker.
 */

export const RUNNING_STATUSES = ['STARTING', 'ACTIVE', 'ENDING'] as const
const OPEN_STATUSES = ['PENDING', 'DUE', 'IN_PROGRESS'] as const
/** Job Start / Job End checks do not expire: the job waits for them. */
const START_END_WINDOW_DAYS = 7
/**
 * Parameters due within this long of each other are "due at the same time" and share one check.
 * Kept short so a check never asks for a parameter that is not due yet.
 */
export const SAME_TIME_MS = 60_000

type JobRow = typeof jobs.$inferSelect

export interface JobParameter {
  parameterId: string
  name: string
  frequency: 'JOB_START' | 'INTERVAL' | 'JOB_END'
  intervalMinutes: number
}

export interface JobCheckType {
  activityId: string
  name: string
  graceMinutes: number
  parameters: JobParameter[]
}

/** The job-based check types of a machine, with their enabled parameters and frequencies. */
export async function jobCheckTypes(machineIds: string[]): Promise<Map<string, JobCheckType[]>> {
  const result = new Map<string, JobCheckType[]>()
  if (machineIds.length === 0) return result
  const rows = await db
    .select({
      machineId: machineActivities.machineId,
      activityId: activities.id,
      name: activities.name,
      graceMinutes: activities.graceMinutes,
      parameterId: parameters.id,
      parameterName: parameters.name,
      frequency: activityParameters.frequency,
      intervalMinutes: activityParameters.intervalMinutes,
      sortOrder: activityParameters.sortOrder
    })
    .from(machineActivities)
    .innerJoin(activities, eq(machineActivities.activityId, activities.id))
    .innerJoin(activityParameters, eq(activityParameters.activityId, activities.id))
    .innerJoin(parameters, eq(activityParameters.parameterId, parameters.id))
    .where(
      and(
        inArray(machineActivities.machineId, machineIds),
        eq(activities.monitoring, 'JOB'),
        eq(activities.isActive, true),
        eq(activityParameters.isEnabled, true),
        eq(parameters.isActive, true)
      )
    )
    .orderBy(asc(activities.name), asc(activityParameters.sortOrder))
  for (const r of rows) {
    const list = result.get(r.machineId) ?? []
    let type = list.find((t) => t.activityId === r.activityId)
    if (!type) {
      type = { activityId: r.activityId, name: r.name, graceMinutes: r.graceMinutes, parameters: [] }
      list.push(type)
    }
    type.parameters.push({
      parameterId: r.parameterId,
      name: r.parameterName,
      frequency: r.frequency,
      intervalMinutes: Math.max(5, r.intervalMinutes)
    })
    result.set(r.machineId, list)
  }
  return result
}

async function lockJob(tx: Tx, jobId: string) {
  const [job] = await tx.select().from(jobs).where(eq(jobs.id, jobId)).for('update')
  if (!job) throw notFound('Job')
  return job
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/** Creates one Job Start or Job End check per check type that has parameters for it. */
async function createEdgeChecks(tx: Tx, job: JobRow, kind: 'JOB_START' | 'JOB_END', types: JobCheckType[], shiftId: string | null) {
  const now = new Date()
  const frequency = kind === 'JOB_START' ? 'JOB_START' : 'JOB_END'
  const created: string[] = []
  for (const type of types) {
    const ids = type.parameters.filter((p) => p.frequency === frequency).map((p) => p.parameterId)
    if (ids.length === 0) continue
    const [row] = await tx
      .insert(qualityChecks)
      .values({
        code: makeCheckCode(now),
        machineId: job.machineId,
        activityId: type.activityId,
        workerId: job.assignedWorkerId,
        shiftId,
        scheduledAt: now,
        windowEndsAt: addDays(now, START_END_WINDOW_DAYS),
        status: 'DUE',
        kind,
        parameterIds: ids,
        jobId: job.id,
        itemCode: job.itemCode,
        jobNo: job.jobNo,
        submissionType: 'MANUAL',
        // The worker is on the screen that opens it; a handover resets this so the next worker is told.
        notifiedAt: now
      })
      .onConflictDoNothing()
      .returning({ id: qualityChecks.id })
    if (row) created.push(row.id)
  }
  return created
}

/** Open job checks of a kind for a job. */
async function openJobChecks(tx: Tx | typeof db, jobId: string, kind: 'JOB_START' | 'JOB_INTERVAL' | 'JOB_END') {
  return tx
    .select({ id: qualityChecks.id, activityId: qualityChecks.activityId })
    .from(qualityChecks)
    .where(and(eq(qualityChecks.jobId, jobId), eq(qualityChecks.kind, kind), inArray(qualityChecks.status, [...OPEN_STATUSES])))
}

export interface StartInput {
  machineId: string
  userId: string
  /** Start a planned job; otherwise a new job is created from jobNo / itemCode. */
  plannedJobId?: string | null
  jobNo?: string | null
  itemCode?: string | null
}

/**
 * Start Job. The job becomes STARTING with its Job Start checks, or ACTIVE straight away when no
 * check type of the machine has Job Start parameters.
 */
export async function startJob(input: StartInput): Promise<{ job: JobRow; startCheckIds: string[] }> {
  const types = (await jobCheckTypes([input.machineId])).get(input.machineId) ?? []
  // Read before the transaction: everything inside it goes through the transaction's connection.
  const shiftId = (await shiftAt(new Date()))?.id ?? null
  const result = await db.transaction(async (tx) => {
    const now = new Date()
    let job: JobRow
    if (input.plannedJobId) {
      const planned = await lockJob(tx, input.plannedJobId)
      if (planned.machineId !== input.machineId) throw badRequest('This job is planned for another machine')
      if (planned.status !== 'PLANNED') throw conflict('This job has already been started')
      if (planned.assignedWorkerId && planned.assignedWorkerId !== input.userId) throw forbidden('This job is assigned to another worker')
      const [updated] = await tx
        .update(jobs)
        .set({ status: 'STARTING', startedAt: now, startedById: input.userId, assignedWorkerId: input.userId, updatedAt: now })
        .where(eq(jobs.id, planned.id))
        .returning()
        .catch((err) => {
          throw runningConflict(err)
        })
      job = updated
    } else {
      const jobNo = input.jobNo?.trim()
      if (!jobNo) throw badRequest('Enter the Job No.')
      const [created] = await tx
        .insert(jobs)
        .values({
          machineId: input.machineId,
          jobNo,
          itemCode: input.itemCode?.trim() || null,
          status: 'STARTING',
          startedAt: now,
          startedById: input.userId,
          assignedWorkerId: input.userId
        })
        .onConflictDoNothing()
        .returning()
      if (!created) throw conflict('A job is already running on this machine. End it before starting a new one.')
      job = created
    }
    const startCheckIds = await createEdgeChecks(tx, job, 'JOB_START', types, shiftId)
    if (startCheckIds.length === 0) {
      ;[job] = await tx.update(jobs).set({ status: 'ACTIVE', activatedAt: now, updatedAt: now }).where(eq(jobs.id, job.id)).returning()
    }
    return { job, startCheckIds }
  })
  invalidateCheckGeneration()
  return result
}

function runningConflict(err: unknown) {
  const code = (err as { code?: string; cause?: { code?: string } })?.code ?? (err as { cause?: { code?: string } })?.cause?.code
  return code === '23505' ? conflict('A job is already running on this machine. End it before starting a new one.') : err
}

/** After a Job Start check is submitted: the job becomes ACTIVE once no Job Start check is open. */
export async function activateIfStarted(jobId: string) {
  const activated = await db.transaction(async (tx) => {
    const job = await lockJob(tx, jobId)
    if (job.status !== 'STARTING') return false
    if ((await openJobChecks(tx, jobId, 'JOB_START')).length) return false
    const now = new Date()
    await tx.update(jobs).set({ status: 'ACTIVE', activatedAt: now, updatedAt: now }).where(eq(jobs.id, jobId))
    return true
  })
  if (activated) invalidateCheckGeneration()
  return activated
}

/**
 * End Job. Open interval checks are withdrawn (the Job End check follows) and the Job End checks
 * are created; with no Job End parameters the job completes at once.
 */
export async function requestEnd(jobId: string, userId: string): Promise<{ job: JobRow; endCheckIds: string[]; withdrawn: number }> {
  const [first] = await db.select({ machineId: jobs.machineId }).from(jobs).where(eq(jobs.id, jobId))
  if (!first) throw notFound('Job')
  const types = (await jobCheckTypes([first.machineId])).get(first.machineId) ?? []
  const shiftId = (await shiftAt(new Date()))?.id ?? null
  return db.transaction(async (tx) => {
    let job = await lockJob(tx, jobId)
    if (job.status === 'ENDING') {
      // Asked twice (e.g. two taps): return the Job End checks already open.
      return { job, endCheckIds: (await openJobChecks(tx, jobId, 'JOB_END')).map((c) => c.id), withdrawn: 0 }
    }
    if (job.status === 'STARTING') throw conflict('Submit the Job Start check before ending the job.')
    if (job.status !== 'ACTIVE') throw conflict('This job is not running')
    const now = new Date()
    const withdrawn = await tx
      .delete(qualityChecks)
      .where(
        and(
          eq(qualityChecks.jobId, jobId),
          eq(qualityChecks.kind, 'JOB_INTERVAL'),
          inArray(qualityChecks.status, [...OPEN_STATUSES]),
          isNull(qualityChecks.submittedAt)
        )
      )
      .returning({ id: qualityChecks.id })
    ;[job] = await tx
      .update(jobs)
      .set({ status: 'ENDING', endRequestedAt: now, endRequestedById: userId, updatedAt: now })
      .where(eq(jobs.id, jobId))
      .returning()
    const endCheckIds = await createEdgeChecks(tx, job, 'JOB_END', types, shiftId)
    if (endCheckIds.length === 0) {
      ;[job] = await tx
        .update(jobs)
        .set({ status: 'COMPLETED', endedAt: now, endedById: userId, updatedAt: now })
        .where(eq(jobs.id, jobId))
        .returning()
    }
    return { job, endCheckIds, withdrawn: withdrawn.length }
  })
}

/** After a Job End check is submitted: the job completes once no Job End check is open. */
export async function completeIfEnded(jobId: string, userId: string) {
  return db.transaction(async (tx) => {
    const job = await lockJob(tx, jobId)
    if (job.status !== 'ENDING') return false
    if ((await openJobChecks(tx, jobId, 'JOB_END')).length) return false
    const now = new Date()
    await tx.update(jobs).set({ status: 'COMPLETED', endedAt: now, endedById: userId, updatedAt: now }).where(eq(jobs.id, jobId))
    // A completed job keeps no scheduled check (none should be left after End Job; this makes sure).
    await tx
      .delete(qualityChecks)
      .where(and(eq(qualityChecks.jobId, jobId), eq(qualityChecks.kind, 'JOB_INTERVAL'), inArray(qualityChecks.status, [...OPEN_STATUSES]), isNull(qualityChecks.submittedAt)))
    return true
  })
}

/**
 * An Admin/Manager closes a job without its remaining checks (e.g. a stuck Job End check), or
 * cancels a planned job. Open job checks are removed; submitted records stay with the job.
 */
export async function forceClose(jobId: string, userId: string) {
  return db.transaction(async (tx) => {
    const job = await lockJob(tx, jobId)
    if (job.status === 'COMPLETED' || job.status === 'CANCELLED') throw conflict('This job is already closed')
    const now = new Date()
    const removed = await tx
      .delete(qualityChecks)
      .where(and(eq(qualityChecks.jobId, jobId), ne(qualityChecks.kind, 'SCHEDULED'), inArray(qualityChecks.status, [...OPEN_STATUSES]), isNull(qualityChecks.submittedAt)))
      .returning({ id: qualityChecks.id })
    const planned = job.status === 'PLANNED'
    const [updated] = await tx
      .update(jobs)
      .set(planned ? { status: 'CANCELLED', updatedAt: now } : { status: 'COMPLETED', endedAt: now, endedById: userId, forceClosed: true, updatedAt: now })
      .where(eq(jobs.id, jobId))
      .returning()
    return { job: updated, removedChecks: removed.length, previousStatus: job.status }
  })
}

export interface HandoverInput {
  jobId: string
  toUserId: string
  shiftId: string | null
  note: string | null
  byUserId: string
  /** A worker may only hand over a job assigned to them; staff may hand over any running job. */
  asWorker: boolean
}

/**
 * Hands a running job to another worker: the job, its open checks and their notifications move
 * to that worker. The history stays with the job; every handover is recorded.
 */
export async function handover(input: HandoverInput) {
  return db.transaction(async (tx) => {
    const job = await lockJob(tx, input.jobId)
    if (!RUNNING_STATUSES.includes(job.status as (typeof RUNNING_STATUSES)[number])) throw conflict('Only a running job can be handed over')
    if (input.asWorker && job.assignedWorkerId !== input.byUserId) throw forbidden('This job is assigned to another worker')
    if (input.toUserId === job.assignedWorkerId) throw badRequest('This worker already has the job')
    const [target] = await tx
      .select({ id: users.id, role: users.role, isActive: users.isActive, appAccess: users.appAccess, name: users.name })
      .from(users)
      .where(eq(users.id, input.toUserId))
    if (!target || target.role !== 'WORKER' || !target.isActive || !target.appAccess) throw badRequest('Choose an active worker with app access')
    const [assigned] = await tx
      .select({ userId: workerMachines.userId })
      .from(workerMachines)
      .where(and(eq(workerMachines.userId, target.id), eq(workerMachines.machineId, job.machineId)))
    if (!assigned) throw badRequest(`${target.name} is not assigned to this machine. Assign the machine first in Machine Assignment.`)
    if (input.shiftId) {
      const [shift] = await tx.select({ id: shifts.id }).from(shifts).where(eq(shifts.id, input.shiftId))
      if (!shift) throw badRequest('Choose a shift')
    }
    const now = new Date()
    await tx.update(jobs).set({ assignedWorkerId: target.id, updatedAt: now }).where(eq(jobs.id, job.id))
    // Open checks move too; a due one is notified again, now to the new worker.
    const moved = await tx
      .update(qualityChecks)
      .set({ workerId: target.id, notifiedAt: sql`case when ${qualityChecks.status} = 'DUE' then null else ${qualityChecks.notifiedAt} end` })
      .where(and(eq(qualityChecks.jobId, job.id), ne(qualityChecks.kind, 'SCHEDULED'), inArray(qualityChecks.status, [...OPEN_STATUSES]), isNull(qualityChecks.submittedAt)))
      .returning({ id: qualityChecks.id })
    const [record] = await tx
      .insert(jobHandovers)
      .values({
        jobId: job.id,
        fromUserId: job.assignedWorkerId,
        toUserId: target.id,
        toShiftId: input.shiftId,
        note: input.note,
        createdById: input.byUserId,
        movedChecks: moved.length
      })
      .returning()
    return { job: { ...job, assignedWorkerId: target.id }, handover: record, movedChecks: moved.length, toName: target.name }
  })
}

/** A job interval check as the scheduler sees it. */
interface IntervalCheck {
  id: string
  activityId: string
  status: string
  parameterIds: string[] | null
  scheduledAt: Date
  windowEndsAt: Date
  submittedAt: Date | null
}

/**
 * When one interval parameter is next due, from the job's interval checks: its interval after the
 * last submission of it (or after the job became active); after a missed check or an exception,
 * its interval after that slot, but not before the slot's window closed.
 */
function parameterDue(p: JobParameter, activatedAt: Date, history: IntervalCheck[]) {
  const interval = p.intervalMinutes * MINUTE
  let next = activatedAt.getTime() + interval
  let lastAt = -Infinity
  for (const c of history) {
    if (!c.parameterIds?.includes(p.parameterId)) continue
    const at = (c.submittedAt ?? c.scheduledAt).getTime()
    if (at < lastAt) continue
    lastAt = at
    next =
      c.status === 'COMPLETED' && c.submittedAt
        ? c.submittedAt.getTime() + interval
        : Math.max(c.scheduledAt.getTime() + interval, c.windowEndsAt.getTime())
  }
  return next
}

/**
 * Plans one job and check type. Every interval parameter runs on its own frequency:
 *  - a parameter that is already in an open interval check waits for that check;
 *  - the other ("free") parameters are due at their own times; those due at the same time
 *    (within SAME_TIME_MS, or already overdue) share one check, so one notification asks for exactly
 *    the parameters due then and nothing that is not due yet;
 *  - only the next future check is kept (a later one is planned once it is next), so parameters that
 *    fall due together later still end up in the same check.
 */
function planIntervalChecks(params: JobParameter[], activatedAt: Date, checks: IntervalCheck[], now: Date) {
  const open = checks.filter((c) => (OPEN_STATUSES as readonly string[]).includes(c.status))
  const busy = new Set(open.flatMap((c) => c.parameterIds ?? []))
  const free = params
    .filter((p) => !busy.has(p.parameterId))
    .map((p) => ({ p, due: Math.max(parameterDue(p, activatedAt, checks.filter((c) => !(OPEN_STATUSES as readonly string[]).includes(c.status))), now.getTime()) }))
  if (free.length === 0) return null
  const earliest = Math.min(...free.map((f) => f.due))
  const group = free.filter((f) => f.due <= earliest + SAME_TIME_MS).map((f) => f.p.parameterId)
  const upcoming = open.filter((c) => c.status === 'PENDING' && c.scheduledAt.getTime() > now.getTime()).sort((a, b) => +a.scheduledAt - +b.scheduledAt)[0]
  if (upcoming) {
    // Due together with the next planned check: it asks for these too (it has not been notified yet).
    if (Math.abs(upcoming.scheduledAt.getTime() - earliest) <= SAME_TIME_MS) return { addTo: upcoming, parameterIds: group }
    // Due later than the next planned check: planned once that one is due.
    if (earliest > upcoming.scheduledAt.getTime()) return null
  }
  return { at: new Date(earliest), parameterIds: group }
}

/**
 * Creates the interval checks of every active job. Each job is planned in its own transaction with
 * the job row locked, so a job being ended, completed, force-closed or handed over at the same moment
 * is never given a new check: only an ACTIVE job (read under the lock) gets one.
 */
export async function generateJobIntervalChecks(now: Date): Promise<number> {
  const active = await db.select({ id: jobs.id, machineId: jobs.machineId }).from(jobs).where(eq(jobs.status, 'ACTIVE'))
  if (active.length === 0) return 0
  const [typesByMachine, shiftRows, machineOff] = await Promise.all([
    jobCheckTypes([...new Set(active.map((j) => j.machineId))]),
    db.select().from(shifts).where(eq(shifts.isActive, true)),
    machineOffBetween(addDays(startOfDay(now), -1), addDays(startOfDay(now), 2))
  ])

  let created = 0
  for (const { id } of active) {
    created += await db.transaction(async (tx) => {
      const [job] = await tx.select().from(jobs).where(eq(jobs.id, id)).for('update')
      // Ended, completed or closed since the list was read: nothing more is scheduled for it.
      if (!job || job.status !== 'ACTIVE') return 0
      const activatedAt = job.activatedAt ?? job.startedAt ?? now
      const checks = await tx
        .select({
          id: qualityChecks.id,
          activityId: qualityChecks.activityId,
          status: qualityChecks.status,
          parameterIds: qualityChecks.parameterIds,
          scheduledAt: qualityChecks.scheduledAt,
          windowEndsAt: qualityChecks.windowEndsAt,
          submittedAt: qualityChecks.submittedAt
        })
        .from(qualityChecks)
        .where(and(eq(qualityChecks.jobId, job.id), eq(qualityChecks.kind, 'JOB_INTERVAL')))
      let made = 0
      for (const type of typesByMachine.get(job.machineId) ?? []) {
        const params = type.parameters.filter((p) => p.frequency === 'INTERVAL')
        if (params.length === 0) continue
        const plan = planIntervalChecks(params, activatedAt, checks.filter((c) => c.activityId === type.activityId), now)
        if (!plan) continue
        if ('addTo' in plan && plan.addTo) {
          await tx
            .update(qualityChecks)
            .set({ parameterIds: [...new Set([...(plan.addTo.parameterIds ?? []), ...plan.parameterIds])] })
            .where(and(eq(qualityChecks.id, plan.addTo.id), eq(qualityChecks.status, 'PENDING'), isNull(qualityChecks.notifiedAt)))
          continue
        }
        if (machineOff(job.machineId, dateKey(plan.at))) continue
        const [row] = await tx
          .insert(qualityChecks)
          .values({
            code: makeCheckCode(plan.at),
            machineId: job.machineId,
            activityId: type.activityId,
            workerId: job.assignedWorkerId,
            shiftId: shiftFor(shiftRows, plan.at)?.id ?? null,
            scheduledAt: plan.at,
            windowEndsAt: new Date(plan.at.getTime() + type.graceMinutes * MINUTE),
            status: plan.at <= now ? 'DUE' : 'PENDING',
            kind: 'JOB_INTERVAL',
            parameterIds: plan.parameterIds,
            jobId: job.id,
            itemCode: job.itemCode,
            jobNo: job.jobNo
          })
          .onConflictDoNothing()
          .returning({ id: qualityChecks.id })
        if (row) made++
      }
      return made
    })
  }
  return created
}

/**
 * The worker checks early ("Click Image" before a notification): the due interval check of this job
 * and check type when there is one; otherwise the planned (not yet notified) interval checks give way
 * to one check now with every interval parameter, and each parameter's frequency restarts from it.
 */
export async function startIntervalCheckNow(jobId: string, activityId: string) {
  const [first] = await db.select({ machineId: jobs.machineId }).from(jobs).where(eq(jobs.id, jobId))
  if (!first) throw notFound('Job')
  const type = ((await jobCheckTypes([first.machineId])).get(first.machineId) ?? []).find((t) => t.activityId === activityId)
  if (!type) throw badRequest('This check type is not job-based on this machine')
  const ids = type.parameters.filter((p) => p.frequency === 'INTERVAL').map((p) => p.parameterId)
  if (ids.length === 0) throw badRequest('This check type has no interval parameters')
  const shiftId = (await shiftAt(new Date()))?.id ?? null

  return db.transaction(async (tx) => {
    const [job] = await tx.select().from(jobs).where(eq(jobs.id, jobId)).for('update')
    if (!job || job.status !== 'ACTIVE') throw conflict(job?.status === 'STARTING' ? 'Submit the Job Start check first.' : 'No active job on this machine')
    const open = await tx
      .select({ id: qualityChecks.id, status: qualityChecks.status, parameterIds: qualityChecks.parameterIds, scheduledAt: qualityChecks.scheduledAt })
      .from(qualityChecks)
      .where(
        and(
          eq(qualityChecks.jobId, jobId),
          eq(qualityChecks.activityId, activityId),
          eq(qualityChecks.kind, 'JOB_INTERVAL'),
          inArray(qualityChecks.status, [...OPEN_STATUSES])
        )
      )
    const due = open.filter((c) => c.status !== 'PENDING').sort((a, b) => +a.scheduledAt - +b.scheduledAt)[0]
    if (due) return { id: due.id, created: false }
    // Nothing is due yet: the planned checks are replaced by one check now.
    if (open.length) await tx.delete(qualityChecks).where(inArray(qualityChecks.id, open.map((c) => c.id)))
    const now = new Date()
    const [row] = await tx
      .insert(qualityChecks)
      .values({
        code: makeCheckCode(now),
        machineId: job.machineId,
        activityId,
        workerId: job.assignedWorkerId,
        shiftId,
        scheduledAt: now,
        windowEndsAt: new Date(now.getTime() + type.graceMinutes * MINUTE),
        status: 'DUE',
        kind: 'JOB_INTERVAL',
        parameterIds: ids,
        jobId,
        itemCode: job.itemCode,
        jobNo: job.jobNo,
        submissionType: 'MANUAL',
        notifiedAt: now
      })
      .returning({ id: qualityChecks.id })
    return { id: row.id, created: true }
  })
}

/** A job's handovers, oldest first. */
export async function jobHandoverList(jobId: string) {
  const fromUser = alias(users, 'from_user')
  const toUser = alias(users, 'to_user')
  const byUser = alias(users, 'by_user')
  return db
    .select({
      id: jobHandovers.id,
      at: jobHandovers.createdAt,
      fromName: fromUser.name,
      toName: toUser.name,
      byName: byUser.name,
      shiftName: shifts.name,
      note: jobHandovers.note,
      movedChecks: jobHandovers.movedChecks
    })
    .from(jobHandovers)
    .leftJoin(fromUser, eq(jobHandovers.fromUserId, fromUser.id))
    .leftJoin(toUser, eq(jobHandovers.toUserId, toUser.id))
    .leftJoin(byUser, eq(jobHandovers.createdById, byUser.id))
    .leftJoin(shifts, eq(jobHandovers.toShiftId, shifts.id))
    .where(eq(jobHandovers.jobId, jobId))
    .orderBy(asc(jobHandovers.createdAt))
}
