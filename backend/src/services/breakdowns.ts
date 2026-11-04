import type { Request } from 'express'
import { and, asc, count, desc, eq, gt, gte, inArray, isNull, lt, sql, type SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { db } from '../db/client'
import { activities, machineBreakdowns, machines, qualityChecks, users, type BreakdownStatus } from '../db/schema'
import { audit } from '../lib/audit'
import { signedMediaUrl } from '../lib/mediaLinks'
import { badRequest, conflict, forbidden, notFound } from '../lib/http'
import { loadActions } from '../lib/permissions'
import { addDays, dateKey, formatLocalTime, startOfDay } from '../lib/time'
import { invalidateCheckGeneration } from './checkGenerator'
import { assertWorkerInScope, departmentScope, scopedWorkerIds, type DepartmentScope } from './departmentScope'
import { workerDayPlans } from './leave'
import { sendToUser } from './notifications'
import { shiftBlocksAt, workerShiftList } from './workerShifts'

/**
 * Machine breakdowns (table machine_breakdowns).
 *
 *  1. A worker on shift reports that a machine broke down, with a reason. The period runs from that
 *     moment to the end of their shift. "Check due" alerts for that machine stop at once
 *     (breakdownWindow.ts), but the checks stay as they are: Due, then Missed as usual.
 *  2. A manager of the worker's department (scope as for leave), an Admin or the Super Admin
 *     approves or rejects it, with a reason. They cannot decide their own report.
 *  3. Approved: the worker's unsubmitted checks on that machine in the period (Pending, Due, In
 *     progress or already Missed) become EXCUSED, with breakdownId pointing here: never counted,
 *     never in a score. Checks the scheduler creates later in the period are excused as they appear
 *     (applyApprovedBreakdowns, every minute). Submitted checks (Completed, Exception) are kept.
 *  4. Rejected: nothing changes; missed checks count as usual and alerts resume.
 *
 * Only the reporting worker's checks on that one machine are affected.
 */

/** Unsubmitted check statuses an approved breakdown excuses. */
const EXCUSABLE = ['PENDING', 'DUE', 'IN_PROGRESS', 'MISSED'] as const

type Breakdown = typeof machineBreakdowns.$inferSelect

const workerUser = alias(users, 'breakdown_worker')

/** The worker's checks on the broken machine in the breakdown period. */
function periodWhere(b: Pick<Breakdown, 'workerId' | 'machineId' | 'startedAt' | 'endsAt'>): SQL {
  return and(
    eq(qualityChecks.workerId, b.workerId),
    eq(qualityChecks.machineId, b.machineId),
    gte(qualityChecks.scheduledAt, b.startedAt),
    lt(qualityChecks.scheduledAt, b.endsAt)
  )!
}

/** The shift the worker is on now (leave and shift changes applied), or null. */
export async function currentShiftBlock(workerId: string, now = new Date()) {
  const list = await workerShiftList(workerId)
  if (!list.length) return null
  const today = startOfDay(now)
  const plans = await workerDayPlans([workerId], dateKey(addDays(today, -1)), dateKey(addDays(today, 2)))
  return shiftBlocksAt(list, now, plans.get(workerId)).current
}

const makeCode = (at: Date) => `BD-${dateKey(at).replace(/-/g, '')}-${String(Math.floor(1000 + Math.random() * 9000))}`

// ---------------------------------------------------------------------------- reading

const listSelect = {
  b: machineBreakdowns,
  workerName: workerUser.name,
  workerEmployeeId: workerUser.employeeId,
  machineName: machines.name,
  machineCode: machines.code,
  /** Checks this breakdown excused (approved). */
  excusedCount: sql<number>`(select count(*)::int from ${qualityChecks} where ${qualityChecks.breakdownId} = ${machineBreakdowns.id})`,
  /** Unsubmitted checks in the period so far: what approving would excuse now (pending reports). */
  affectedCount: sql<number>`(select count(*)::int from ${qualityChecks}
    where ${qualityChecks.workerId} = ${machineBreakdowns.workerId}
      and ${qualityChecks.machineId} = ${machineBreakdowns.machineId}
      and ${qualityChecks.scheduledAt} >= ${machineBreakdowns.startedAt}
      and ${qualityChecks.scheduledAt} < ${machineBreakdowns.endsAt}
      and ${qualityChecks.submittedAt} is null
      and ${qualityChecks.status} in ('PENDING', 'DUE', 'IN_PROGRESS', 'MISSED'))`
}

type ListRow = { b: Breakdown; workerName: string; workerEmployeeId: string; machineName: string; machineCode: string; excusedCount: number; affectedCount: number }

function toDto(r: ListRow) {
  return {
    id: r.b.id,
    code: r.b.code,
    workerId: r.b.workerId,
    workerName: r.workerName,
    workerEmployeeId: r.workerEmployeeId,
    machineId: r.b.machineId,
    machineName: r.machineName,
    machineCode: r.machineCode,
    reason: r.b.reason,
    /** Older reports only (the app no longer asks for one). */
    remark: r.b.remark,
    /** The worker's photo of the breakdown: a signed, short-lived link (null on older reports). */
    photoUrl: r.b.photoPath ? signedMediaUrl(r.b.photoPath) : null,
    startedAt: r.b.startedAt,
    endsAt: r.b.endsAt,
    shiftName: r.b.shiftName,
    status: r.b.status,
    decidedByName: r.b.decidedByName,
    decidedAt: r.b.decidedAt,
    decisionComment: r.b.decisionComment,
    createdAt: r.b.createdAt,
    excusedCount: r.excusedCount,
    affectedCount: r.affectedCount
  }
}
export type BreakdownDto = ReturnType<typeof toDto>

function baseQuery() {
  return db
    .select(listSelect)
    .from(machineBreakdowns)
    .innerJoin(workerUser, eq(workerUser.id, machineBreakdowns.workerId))
    .innerJoin(machines, eq(machines.id, machineBreakdowns.machineId))
}

const NO_ONE = ['00000000-0000-0000-0000-000000000000']

/** Breakdown reports, newest first. `workerIds` null: everyone (Admin); otherwise only those workers. */
export async function listBreakdowns(f: { status?: BreakdownStatus; from?: Date; to?: Date; workerIds: string[] | null; workerId?: string; limit?: number }) {
  const where: SQL[] = []
  if (f.status) where.push(eq(machineBreakdowns.status, f.status))
  if (f.from) where.push(gte(machineBreakdowns.startedAt, f.from))
  if (f.to) where.push(lt(machineBreakdowns.startedAt, f.to))
  if (f.workerId) where.push(eq(machineBreakdowns.workerId, f.workerId))
  if (f.workerIds) where.push(inArray(machineBreakdowns.workerId, f.workerIds.length ? f.workerIds : NO_ONE))
  const rows = await baseQuery()
    .where(where.length ? and(...where) : undefined)
    .orderBy(f.status === 'PENDING' ? asc(machineBreakdowns.startedAt) : desc(machineBreakdowns.startedAt))
    .limit(f.limit ?? 500)
  return rows.map(toDto)
}

export async function getBreakdown(id: string) {
  const [row] = await baseQuery().where(eq(machineBreakdowns.id, id))
  if (!row) throw notFound('Breakdown report')
  return toDto(row)
}

/** The worker's checks on that machine in the period, whatever their status (for the decision). */
export async function breakdownChecks(b: Pick<Breakdown, 'workerId' | 'machineId' | 'startedAt' | 'endsAt'>) {
  return db
    .select({
      id: qualityChecks.id,
      code: qualityChecks.code,
      activityName: activities.name,
      scheduledAt: qualityChecks.scheduledAt,
      windowEndsAt: qualityChecks.windowEndsAt,
      status: qualityChecks.status,
      submittedAt: qualityChecks.submittedAt
    })
    .from(qualityChecks)
    .innerJoin(activities, eq(activities.id, qualityChecks.activityId))
    .where(periodWhere(b))
    .orderBy(asc(qualityChecks.scheduledAt))
}

export async function pendingBreakdownCount(workerIds: string[] | null) {
  const [row] = await db
    .select({ n: count() })
    .from(machineBreakdowns)
    .where(
      and(
        eq(machineBreakdowns.status, 'PENDING'),
        workerIds ? inArray(machineBreakdowns.workerId, workerIds.length ? workerIds : NO_ONE) : undefined
      )
    )
  return row?.n ?? 0
}

// ---------------------------------------------------------------------------- worker

/**
 * A worker reports a breakdown of one of their machines, now. Refused outside their shift, and
 * while an earlier report for the same machine still covers now (waiting or approved).
 */
export async function reportBreakdown(
  req: Request,
  input: { machineId: string; reason: string; photo: { path: string; mimeType: string; sizeBytes: number; capturedAt: Date | null } },
  now = new Date()
) {
  const worker = req.user!
  const block = await currentShiftBlock(worker.id, now)
  if (!block) throw badRequest('You can report a machine breakdown only during your shift.')
  if (block.end <= now) throw badRequest('Your shift has already ended.')

  const [open] = await db
    .select({ code: machineBreakdowns.code, status: machineBreakdowns.status, endsAt: machineBreakdowns.endsAt })
    .from(machineBreakdowns)
    .where(
      and(
        eq(machineBreakdowns.workerId, worker.id),
        eq(machineBreakdowns.machineId, input.machineId),
        inArray(machineBreakdowns.status, ['PENDING', 'APPROVED']),
        gt(machineBreakdowns.endsAt, now)
      )
    )
    .limit(1)
  if (open) {
    throw conflict(
      open.status === 'PENDING'
        ? `You already reported a breakdown of this machine (${open.code}). It is waiting for your manager.`
        : `A breakdown of this machine (${open.code}) is already approved until ${formatLocalTime(open.endsAt)}.`
    )
  }

  let created: Breakdown | undefined
  for (let attempt = 0; attempt < 5 && !created; attempt++) {
    ;[created] = await db
      .insert(machineBreakdowns)
      .values({
        code: makeCode(now),
        workerId: worker.id,
        machineId: input.machineId,
        reason: input.reason,
        photoPath: input.photo.path,
        photoMimeType: input.photo.mimeType,
        photoSizeBytes: input.photo.sizeBytes,
        photoCapturedAt: input.photo.capturedAt,
        startedAt: now,
        endsAt: block.end,
        shiftName: block.shiftName
      })
      .onConflictDoNothing({ target: machineBreakdowns.code })
      .returning()
  }
  if (!created) throw conflict('Could not save the report. Please try again.')

  await audit(req, 'REPORT_BREAKDOWN', 'MachineBreakdown', created.id, {
    newValue: { code: created.code, machineId: created.machineId, reason: created.reason, photo: created.photoPath, from: created.startedAt, until: created.endsAt }
  })
  const dto = await getBreakdown(created.id)
  notifyApprovers(dto).catch((err) => console.error(JSON.stringify({ event: 'breakdown_notify_failed', id: dto.id, error: String(err) })))
  return dto
}

/** The worker withdraws their own report while it is still waiting for a decision. */
export async function cancelBreakdown(req: Request, id: string) {
  const [row] = await db
    .update(machineBreakdowns)
    .set({ status: 'CANCELLED' })
    .where(and(eq(machineBreakdowns.id, id), eq(machineBreakdowns.workerId, req.user!.id), eq(machineBreakdowns.status, 'PENDING')))
    .returning()
  if (!row) throw conflict('Only a report that is still waiting for your manager can be withdrawn.')
  await audit(req, 'CANCEL_BREAKDOWN', 'MachineBreakdown', row.id, { oldValue: { status: 'PENDING' }, newValue: { code: row.code, status: 'CANCELLED' } })
  return getBreakdown(row.id)
}

// ---------------------------------------------------------------------------- manager / admin

/**
 * Approves or rejects a report. The row is locked, so two managers deciding at once cannot both
 * succeed. Approved: the worker's unsubmitted checks on that machine in the period become EXCUSED
 * in the same transaction, and the audit entry lists them.
 */
export async function decideBreakdown(req: Request, scope: DepartmentScope, id: string, approve: boolean, comment: string) {
  const actor = req.user!
  const result = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(machineBreakdowns).where(eq(machineBreakdowns.id, id)).for('update')
    if (!row) throw notFound('Breakdown report')
    await assertWorkerInScope(scope, row.workerId)
    if (row.workerId === actor.id) throw forbidden('You cannot decide your own breakdown report.')
    if (row.status !== 'PENDING') {
      throw conflict(row.status === 'CANCELLED' ? 'The worker withdrew this report.' : `This report was already ${row.status === 'APPROVED' ? 'approved' : 'rejected'}.`)
    }
    const status: BreakdownStatus = approve ? 'APPROVED' : 'REJECTED'
    await tx
      .update(machineBreakdowns)
      .set({ status, decidedById: actor.id, decidedByName: actor.name, decidedAt: new Date(), decisionComment: comment })
      .where(eq(machineBreakdowns.id, id))
    const excused = approve
      ? await tx
          .update(qualityChecks)
          .set({ status: 'EXCUSED', breakdownId: id })
          .where(and(periodWhere(row), isNull(qualityChecks.submittedAt), inArray(qualityChecks.status, [...EXCUSABLE])))
          .returning({ code: qualityChecks.code })
      : []
    await audit(
      req,
      approve ? 'APPROVE_BREAKDOWN' : 'REJECT_BREAKDOWN',
      'MachineBreakdown',
      id,
      {
        oldValue: { status: 'PENDING' },
        newValue: { code: row.code, status, comment, period: { from: row.startedAt, until: row.endsAt }, excusedChecks: excused.map((c) => c.code) }
      },
      tx
    )
    return { excused: excused.length }
  })
  // An excused check frees its schedule for the next one.
  if (result.excused) invalidateCheckGeneration()
  const dto = await getBreakdown(id)
  notifyWorker(dto).catch((err) => console.error(JSON.stringify({ event: 'breakdown_notify_failed', id, error: String(err) })))
  return { breakdown: dto, excused: result.excused }
}

// ---------------------------------------------------------------------------- notifications

/** Who may decide this worker's reports: Super Admin, Admins with the permission, and Managers of their department. */
async function approverIds(workerId: string) {
  const staff = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(and(inArray(users.role, ['SUPER_ADMIN', 'ADMIN', 'MANAGER']), eq(users.isActive, true)))
  const result: string[] = []
  for (const u of staff) {
    if (u.id === workerId) continue
    if (u.role === 'MANAGER' && !((await scopedWorkerIds(await departmentScope({ id: u.id, role: 'MANAGER' }))) ?? []).includes(workerId)) continue
    if (u.role === 'SUPER_ADMIN' || (await loadActions(u.id, u.role)).breakdowns.approve) result.push(u.id)
  }
  return result
}

async function notifyApprovers(b: BreakdownDto) {
  const ids = await approverIds(b.workerId)
  await Promise.all(
    ids.map((id) =>
      sendToUser(id, 'Machine breakdown reported', `${b.workerName} · ${b.machineName}: ${b.reason}. Waiting for your approval.`, {
        type: 'BREAKDOWN_REPORTED',
        id: b.id
      }).catch(() => undefined)
    )
  )
}

async function notifyWorker(b: BreakdownDto) {
  const approved = b.status === 'APPROVED'
  await sendToUser(
    b.workerId,
    approved ? 'Breakdown approved' : 'Breakdown rejected',
    approved
      ? `${b.machineName}: your checks until ${formatLocalTime(b.endsAt)} are excused.${b.decisionComment ? ` ${b.decisionComment}` : ''}`
      : `${b.machineName}: missed checks count as usual.${b.decisionComment ? ` ${b.decisionComment}` : ''}`,
    { type: 'BREAKDOWN_DECISION', id: b.id, status: b.status }
  )
}
