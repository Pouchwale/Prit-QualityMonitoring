import { and, asc, count, desc, eq, gte, inArray, lt, or, type SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { db } from '../db/client'
import {
  activities,
  checkExceptions,
  departments,
  machines,
  media,
  qualityCheckValues,
  qualityChecks,
  shifts,
  users
} from '../db/schema'
import { storage } from '../storage'
import { resultOf } from '../lib/result'

const worker = alias(users, 'worker')
const submitter = alias(users, 'submitter')
const reviewer = alias(users, 'reviewer')

export interface CheckFilters {
  from?: Date
  to?: Date
  statuses?: (typeof qualityChecks.$inferSelect.status)[]
  machineId?: string
  workerId?: string
  shiftId?: string
  activityId?: string
  departmentId?: string
  ids?: string[]
  /** Extra condition, e.g. a worker's visibility scope. */
  where?: SQL
}

export function mediaDto(row: typeof media.$inferSelect) {
  return {
    id: row.id,
    kind: row.kind,
    url: storage.publicUrl(row.path),
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    durationSeconds: row.durationSeconds,
    capturedAt: row.capturedAt,
    createdAt: row.createdAt
  }
}

export interface ListOptions {
  order?: 'asc' | 'desc'
  /** Column to sort on. History is sorted by submission time. */
  orderBy?: 'scheduledAt' | 'submittedAt'
  limit?: number
  offset?: number
}

function buildWhere(filters: CheckFilters) {
  const where: SQL[] = []
  if (filters.from) where.push(gte(qualityChecks.scheduledAt, filters.from))
  if (filters.to) where.push(lt(qualityChecks.scheduledAt, filters.to))
  if (filters.statuses?.length) where.push(inArray(qualityChecks.status, filters.statuses))
  if (filters.machineId) where.push(eq(qualityChecks.machineId, filters.machineId))
  if (filters.workerId) {
    // Assigned worker, or the worker who actually submitted it.
    where.push(or(eq(qualityChecks.workerId, filters.workerId), eq(qualityChecks.submittedById, filters.workerId))!)
  }
  if (filters.shiftId) where.push(eq(qualityChecks.shiftId, filters.shiftId))
  if (filters.activityId) where.push(eq(qualityChecks.activityId, filters.activityId))
  if (filters.departmentId) where.push(eq(machines.departmentId, filters.departmentId))
  if (filters.where) where.push(filters.where)
  if (filters.ids) where.push(inArray(qualityChecks.id, filters.ids.length ? filters.ids : ['00000000-0000-0000-0000-000000000000']))

  return where.length ? and(...where) : undefined
}

/** Number of checks matching the filters, for pagination. */
export async function countChecks(filters: CheckFilters) {
  const [row] = await db
    .select({ n: count() })
    .from(qualityChecks)
    .innerJoin(machines, eq(qualityChecks.machineId, machines.id))
    .where(buildWhere(filters))
  return row?.n ?? 0
}

/** Lists checks with names, submitted values, media and exception details. */
export async function listChecks(filters: CheckFilters, options: ListOptions = {}) {
  const { order = 'asc', orderBy = 'scheduledAt', limit = 5000, offset = 0 } = options
  const sortColumn = orderBy === 'submittedAt' ? qualityChecks.submittedAt : qualityChecks.scheduledAt

  const rows = await db
    .select({
      check: qualityChecks,
      machineName: machines.name,
      machineCode: machines.code,
      departmentId: departments.id,
      departmentName: departments.name,
      activityName: activities.name,
      workerName: worker.name,
      workerEmployeeId: worker.employeeId,
      shiftName: shifts.name,
      submittedByName: submitter.name,
      submittedByEmployeeId: submitter.employeeId
    })
    .from(qualityChecks)
    .innerJoin(machines, eq(qualityChecks.machineId, machines.id))
    .leftJoin(departments, eq(machines.departmentId, departments.id))
    .innerJoin(activities, eq(qualityChecks.activityId, activities.id))
    .leftJoin(worker, eq(qualityChecks.workerId, worker.id))
    .leftJoin(shifts, eq(qualityChecks.shiftId, shifts.id))
    .leftJoin(submitter, eq(qualityChecks.submittedById, submitter.id))
    .where(buildWhere(filters))
    .orderBy(order === 'asc' ? asc(sortColumn) : desc(sortColumn))
    .limit(limit)
    .offset(offset)

  const ids = rows.map((r) => r.check.id)
  const [values, mediaRows, exceptionRows] = ids.length
    ? await Promise.all([
        db.select().from(qualityCheckValues).where(inArray(qualityCheckValues.checkId, ids)).orderBy(asc(qualityCheckValues.sortOrder)),
        db.select().from(media).where(inArray(media.checkId, ids)),
        db
          .select({ exception: checkExceptions, reviewedByName: reviewer.name })
          .from(checkExceptions)
          .leftJoin(reviewer, eq(checkExceptions.reviewedById, reviewer.id))
          .where(inArray(checkExceptions.checkId, ids))
      ])
    : [[], [], []]

  const exceptionIds = exceptionRows.map((e) => e.exception.id)
  const exceptionMedia = exceptionIds.length
    ? await db.select().from(media).where(inArray(media.exceptionId, exceptionIds))
    : []

  return rows.map((r) => {
    const exc = exceptionRows.find((e) => e.exception.checkId === r.check.id)
    return {
      id: r.check.id,
      code: r.check.code,
      scheduleId: r.check.scheduleId,
      machineId: r.check.machineId,
      machineName: r.machineName,
      machineCode: r.machineCode,
      departmentId: r.departmentId,
      departmentName: r.departmentName,
      activityId: r.check.activityId,
      activityName: r.activityName,
      workerId: r.check.workerId,
      workerName: r.workerName,
      workerEmployeeId: r.workerEmployeeId,
      shiftId: r.check.shiftId,
      shiftName: r.shiftName,
      scheduledAt: r.check.scheduledAt,
      windowEndsAt: r.check.windowEndsAt,
      status: r.check.status,
      /** Overall result: Completed, Missed or Exception (null while still open). */
      result: resultOf(r.check.status),
      jobNo: r.check.jobNo,
      submittedAt: r.check.submittedAt,
      submittedById: r.check.submittedById,
      submittedByName: r.submittedByName,
      submittedByEmployeeId: r.submittedByEmployeeId,
      deviceInfo: r.check.deviceInfo,
      values: values
        .filter((v) => v.checkId === r.check.id)
        .map((v) => ({
          parameterId: v.parameterId,
          parameterName: v.parameterName,
          parameterType: v.parameterType,
          unit: v.unit,
          rule: v.rule,
          value: v.value,
          result: v.result
        })),
      media: mediaRows.filter((m) => m.checkId === r.check.id).map(mediaDto),
      exception: exc
        ? {
            id: exc.exception.id,
            reason: exc.exception.reason,
            remark: exc.exception.remark,
            status: exc.exception.status,
            reviewedByName: exc.reviewedByName,
            resolutionNotes: exc.exception.resolutionNotes,
            createdAt: exc.exception.createdAt,
            media: exceptionMedia.filter((m) => m.exceptionId === exc.exception.id).map(mediaDto)
          }
        : null
    }
  })
}

export type CheckDto = Awaited<ReturnType<typeof listChecks>>[number]
