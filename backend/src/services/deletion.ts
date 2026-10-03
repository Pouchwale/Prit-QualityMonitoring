import { createHash } from 'node:crypto'
import { and, count, eq, inArray, sql } from 'drizzle-orm'
import { db, type Transaction } from '../db/client'
import {
  activities,
  checkExceptions,
  departments,
  jobHandovers,
  jobs,
  machines,
  managerPermissions,
  media,
  pushTokens,
  qualityCheckValues,
  qualityChecks,
  users
} from '../db/schema'
import { conflict } from '../lib/http'
import type { AuthUser } from '../lib/auth'
import type { DeletePermission } from '../lib/deletePermissions'
import { storage } from '../storage'

/**
 * Permanent deletion of users, jobs and quality checks (the approved delete flow).
 *
 * Every delete is two steps:
 *  1. impact: read-only. Works out on the server what would be removed, what blocks it, and a
 *     fingerprint (`impactToken`) of that state.
 *  2. delete: in one transaction, locks the records, works the impact out again, and refuses if
 *     anything is blocked or differs from the preview. Then deletes the database rows, writes the
 *     audit entry, and commits. Evidence files are removed from disk only after the commit.
 *
 * Nothing here deletes master data or audit logs, and a job's checks are always deleted with the
 * job, never left detached from it.
 */

export type DeleteType = 'users' | 'jobs' | 'checks'

export const DELETE_TYPE_PERMISSION: Record<DeleteType, DeletePermission> = {
  users: 'DELETE_USERS',
  jobs: 'DELETE_JOBS',
  checks: 'DELETE_CHECKS'
}

/** Most records one request may delete. */
export const MAX_IDS = 200
/** Above either of these a bulk delete needs a second confirmation. */
export const SECOND_CONFIRMATION = { records: 20, files: 100 }

const RUNNING_JOB = ['STARTING', 'ACTIVE', 'ENDING'] as const
const OPEN_CHECK = ['PENDING', 'DUE', 'IN_PROGRESS'] as const

const ROLE_NAME = { WORKER: 'Worker', MANAGER: 'Manager', ADMIN: 'Admin', SUPER_ADMIN: 'Super Admin' } as const
const JOB_STATUS_NAME: Record<string, string> = {
  PLANNED: 'Planned',
  STARTING: 'Starting',
  ACTIVE: 'Active',
  ENDING: 'Ending',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled'
}

type Db = Transaction | typeof db

export interface Dependent {
  label: string
  count: number
}

export interface ImpactItem {
  id: string
  /** What the record is called on screen, e.g. "PO 1235" or "Ravi Kumar (EMP-104)". */
  name: string
  details: { label: string; value: string }[]
  status: string
  /** Rows removed together with the record. */
  dependents: Dependent[]
  /** Kept as they are (users only: their audit entries). */
  preserved: Dependent[]
  files: number
  fileBytes: number
  blockers: string[]
}

export interface Impact {
  type: DeleteType
  permission: DeletePermission
  items: ImpactItem[]
  /** Ids that were asked for but do not exist (already deleted). */
  missing: string[]
  totals: { records: number; files: number; fileBytes: number; dependents: Dependent[] }
  blocked: number
  needsSecondConfirmation: boolean
  thresholds: typeof SECOND_CONFIRMATION
  impactToken: string
}

// ---------------------------------------------------------------------------- shared helpers

const n = (v: unknown) => Number(v ?? 0)

/** Counts rows per key: [{ key, c }] → Map(key → c). */
const tally = (rows: { key: string | null; c: unknown }[]) => {
  const map = new Map<string, number>()
  for (const r of rows) if (r.key) map.set(r.key, (map.get(r.key) ?? 0) + n(r.c))
  return map
}

const at = (map: Map<string, number>, key: string) => map.get(key) ?? 0

const when = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : '')

/**
 * The foreign keys that point at a table, read from the database catalog. Deleting refuses to run
 * if a reference exists that this file does not know how to handle, so a future table can never be
 * orphaned or silently detached by these deletes.
 */
async function referencesTo(tx: Db, table: string) {
  const result = await tx.execute<{ tbl: string; col: string }>(sql`
    select cl.relname as tbl, att.attname as col
    from pg_constraint c
    join pg_class cl on cl.oid = c.conrelid
    join pg_attribute att on att.attrelid = c.conrelid and att.attnum = any (c.conkey)
    where c.contype = 'f' and c.confrelid = ${table}::regclass
  `)
  const rows = (result as unknown as { rows?: { tbl: string; col: string }[] }).rows ?? (result as unknown as { tbl: string; col: string }[])
  return rows.map((r) => `${r.tbl}.${r.col}`)
}

async function assertKnownReferences(tx: Db, table: string, known: string[]) {
  const unknown = (await referencesTo(tx, table)).filter((ref) => !known.includes(ref))
  if (unknown.length) {
    throw conflict(`Deleting is not available: ${unknown.join(', ')} refers to ${table} and is not handled yet`)
  }
}

/** Evidence of a set of checks: their own photos/videos and those of their exceptions. */
async function mediaOfChecks(tx: Db, checkIds: string[]) {
  if (!checkIds.length) return [] as { id: string; path: string; sizeBytes: number; checkId: string }[]
  const own = await tx
    .select({ id: media.id, path: media.path, sizeBytes: media.sizeBytes, checkId: media.checkId })
    .from(media)
    .where(inArray(media.checkId, checkIds))
  const viaException = await tx
    .select({ id: media.id, path: media.path, sizeBytes: media.sizeBytes, checkId: checkExceptions.checkId })
    .from(media)
    .innerJoin(checkExceptions, eq(media.exceptionId, checkExceptions.id))
    .where(inArray(checkExceptions.checkId, checkIds))
  const seen = new Set<string>()
  return [...own, ...viaException]
    .filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)))
    .map((m) => ({ ...m, checkId: m.checkId as string }))
}

async function perCheckCounts(tx: Db, checkIds: string[]) {
  if (!checkIds.length) return { values: new Map<string, number>(), exceptions: new Map<string, number>() }
  const values = tally(
    await tx
      .select({ key: qualityCheckValues.checkId, c: count() })
      .from(qualityCheckValues)
      .where(inArray(qualityCheckValues.checkId, checkIds))
      .groupBy(qualityCheckValues.checkId)
  )
  const exceptions = tally(
    await tx
      .select({ key: checkExceptions.checkId, c: count() })
      .from(checkExceptions)
      .where(inArray(checkExceptions.checkId, checkIds))
      .groupBy(checkExceptions.checkId)
  )
  return { values, exceptions }
}

function finish(type: DeleteType, permission: DeletePermission, ids: string[], items: ImpactItem[], fingerprint: unknown[]): Impact {
  const found = new Set(items.map((i) => i.id))
  const missing = ids.filter((id) => !found.has(id))
  const dependents = new Map<string, number>()
  for (const item of items) for (const d of item.dependents) dependents.set(d.label, (dependents.get(d.label) ?? 0) + d.count)
  const totals = {
    records: items.length,
    files: items.reduce((s, i) => s + i.files, 0),
    fileBytes: items.reduce((s, i) => s + i.fileBytes, 0),
    dependents: [...dependents].map(([label, c]) => ({ label, count: c }))
  }
  const impactToken = createHash('sha256')
    .update(JSON.stringify({ type, ids: [...ids].sort(), missing, fingerprint, items: items.map((i) => ({ ...i, details: undefined })) }))
    .digest('hex')
  return {
    type,
    permission,
    items,
    missing,
    totals,
    blocked: items.filter((i) => i.blockers.length).length,
    needsSecondConfirmation: totals.records > SECOND_CONFIRMATION.records || totals.files > SECOND_CONFIRMATION.files,
    thresholds: SECOND_CONFIRMATION,
    impactToken
  }
}

// ---------------------------------------------------------------------------- checks

async function checkImpact(tx: Db, ids: string[], lock: boolean): Promise<Impact> {
  const query = tx
    .select({
      id: qualityChecks.id,
      code: qualityChecks.code,
      status: qualityChecks.status,
      kind: qualityChecks.kind,
      scheduledAt: qualityChecks.scheduledAt,
      submittedAt: qualityChecks.submittedAt,
      overallResult: qualityChecks.overallResult,
      jobId: qualityChecks.jobId,
      jobNo: qualityChecks.jobNo,
      machineName: machines.name,
      activityName: activities.name,
      workerName: users.name,
      workerEmployeeId: users.employeeId
    })
    .from(qualityChecks)
    .innerJoin(machines, eq(qualityChecks.machineId, machines.id))
    .innerJoin(activities, eq(qualityChecks.activityId, activities.id))
    .leftJoin(users, eq(qualityChecks.workerId, users.id))
    .where(inArray(qualityChecks.id, ids))
  const rows = lock ? await query.for('update', { of: qualityChecks }) : await query

  const jobIds = [...new Set(rows.map((r) => r.jobId).filter((v): v is string => !!v))]
  const jobRows = jobIds.length
    ? await tx.select({ id: jobs.id, status: jobs.status, jobNo: jobs.jobNo }).from(jobs).where(inArray(jobs.id, jobIds))
    : []
  const jobById = new Map(jobRows.map((j) => [j.id, j]))

  const checkIds = rows.map((r) => r.id)
  const { values, exceptions } = await perCheckCounts(tx, checkIds)
  const files = await mediaOfChecks(tx, checkIds)

  const items: ImpactItem[] = rows.map((r) => {
    const job = r.jobId ? jobById.get(r.jobId) : undefined
    const mine = files.filter((f) => f.checkId === r.id)
    const blockers: string[] = []
    const running = job && (RUNNING_JOB as readonly string[]).includes(job.status)
    const open = (OPEN_CHECK as readonly string[]).includes(r.status)
    if (running && open) {
      blockers.push(
        r.kind === 'JOB_START' || r.kind === 'JOB_END'
          ? `This is the open ${r.kind === 'JOB_START' ? 'Job Start' : 'Job End'} check of a running job. Force-close the job first.`
          : 'This check is still open on a running job. Force-close the job first.'
      )
    } else if (r.status === 'IN_PROGRESS') {
      blockers.push('A worker is filling in this check right now.')
    }
    return {
      id: r.id,
      name: r.code,
      status: r.status,
      details: [
        { label: 'Check', value: r.code },
        { label: 'Machine', value: r.machineName },
        { label: 'Check type', value: r.activityName },
        { label: 'Worker', value: r.workerName ? `${r.workerName} (${r.workerEmployeeId})` : '—' },
        { label: 'Status', value: r.status },
        { label: 'Scheduled', value: when(r.scheduledAt) },
        { label: 'Submitted', value: when(r.submittedAt) || '—' },
        { label: 'PO No.', value: job?.jobNo ?? r.jobNo ?? '—' }
      ],
      dependents: [
        { label: 'Parameter values', count: at(values, r.id) },
        { label: 'Exceptions', count: at(exceptions, r.id) },
        { label: 'Evidence files', count: mine.length }
      ],
      preserved: [],
      files: mine.length,
      fileBytes: mine.reduce((s, f) => s + n(f.sizeBytes), 0),
      blockers
    }
  })
  const fingerprint = rows.map((r) => [r.id, r.status, when(r.submittedAt), r.jobId, r.jobId ? jobById.get(r.jobId)?.status : null])
  return finish('checks', 'DELETE_CHECKS', ids, items, fingerprint)
}

// ---------------------------------------------------------------------------- jobs

async function jobImpact(tx: Db, ids: string[], lock: boolean): Promise<Impact> {
  const query = tx
    .select({
      id: jobs.id,
      jobNo: jobs.jobNo,
      itemCode: jobs.itemCode,
      status: jobs.status,
      plannedFor: jobs.plannedFor,
      startedAt: jobs.startedAt,
      endedAt: jobs.endedAt,
      updatedAt: jobs.updatedAt,
      machineName: machines.name,
      departmentName: departments.name,
      workerName: users.name,
      workerEmployeeId: users.employeeId
    })
    .from(jobs)
    .innerJoin(machines, eq(jobs.machineId, machines.id))
    .leftJoin(departments, eq(jobs.departmentId, departments.id))
    .leftJoin(users, eq(jobs.assignedWorkerId, users.id))
    .where(inArray(jobs.id, ids))
  const rows = lock ? await query.for('update', { of: jobs }) : await query

  const jobIds = rows.map((r) => r.id)
  const checks = jobIds.length
    ? await tx
        .select({ id: qualityChecks.id, jobId: qualityChecks.jobId, kind: qualityChecks.kind, status: qualityChecks.status })
        .from(qualityChecks)
        .where(inArray(qualityChecks.jobId, jobIds))
    : []
  const checkIds = checks.map((c) => c.id)
  const { values, exceptions } = await perCheckCounts(tx, checkIds)
  const files = await mediaOfChecks(tx, checkIds)
  const handovers = jobIds.length
    ? tally(
        await tx
          .select({ key: jobHandovers.jobId, c: count() })
          .from(jobHandovers)
          .where(inArray(jobHandovers.jobId, jobIds))
          .groupBy(jobHandovers.jobId)
      )
    : new Map<string, number>()

  const items: ImpactItem[] = rows.map((r) => {
    const own = checks.filter((c) => c.jobId === r.id)
    const ownIds = new Set(own.map((c) => c.id))
    const ownFiles = files.filter((f) => ownIds.has(f.checkId))
    const kind = (k: string) => own.filter((c) => c.kind === k).length
    const blockers = (RUNNING_JOB as readonly string[]).includes(r.status)
      ? [`This job is running (${JOB_STATUS_NAME[r.status]}). Force-close it first.`]
      : []
    return {
      id: r.id,
      name: `PO ${r.jobNo}`,
      status: r.status,
      details: [
        { label: 'PO No.', value: r.jobNo },
        { label: 'Item Code', value: r.itemCode ?? '—' },
        { label: 'Machine', value: r.machineName },
        { label: 'Department', value: r.departmentName ?? '—' },
        { label: 'Assigned worker', value: r.workerName ? `${r.workerName} (${r.workerEmployeeId})` : '—' },
        { label: 'Status', value: JOB_STATUS_NAME[r.status] ?? r.status },
        { label: 'Started', value: when(r.startedAt) || '—' },
        { label: 'Ended', value: when(r.endedAt) || '—' }
      ],
      dependents: [
        { label: 'Quality checks', count: own.length },
        { label: 'Job Start checks', count: kind('JOB_START') },
        { label: 'Interval checks', count: kind('JOB_INTERVAL') },
        { label: 'Job End checks', count: kind('JOB_END') },
        { label: 'Parameter values', count: own.reduce((s, c) => s + at(values, c.id), 0) },
        { label: 'Exceptions', count: own.reduce((s, c) => s + at(exceptions, c.id), 0) },
        { label: 'Handovers', count: at(handovers, r.id) },
        { label: 'Evidence files', count: ownFiles.length }
      ],
      preserved: [],
      files: ownFiles.length,
      fileBytes: ownFiles.reduce((s, f) => s + n(f.sizeBytes), 0),
      blockers
    }
  })
  const fingerprint = rows.map((r) => [r.id, r.status, when(r.updatedAt), checks.filter((c) => c.jobId === r.id).map((c) => `${c.id}:${c.status}`).sort()])
  return finish('jobs', 'DELETE_JOBS', ids, items, fingerprint)
}

// ---------------------------------------------------------------------------- users

/** Labels for the columns that record a user's production history. */
const HISTORY_LABEL: Record<string, string> = {
  'quality_checks.worker_id': 'Quality checks assigned',
  'quality_checks.submitted_by_id': 'Quality checks submitted',
  'jobs.assigned_worker_id': 'Jobs assigned',
  'jobs.started_by_id': 'Jobs started',
  'jobs.ended_by_id': 'Jobs ended',
  'jobs.planned_by_id': 'Jobs planned',
  'jobs.end_requested_by_id': 'Job ends requested',
  'job_handovers.from_user_id': 'Handovers given',
  'job_handovers.to_user_id': 'Handovers received',
  'job_handovers.created_by_id': 'Handovers recorded',
  'exceptions.worker_id': 'Exceptions raised',
  'exceptions.reviewed_by_id': 'Exceptions reviewed',
  'media.uploaded_by_id': 'Evidence files uploaded',
  'schedules.worker_id': 'Schedules assigned',
  'plant_closures.created_by_id': 'Plant Calendar dates created',
  'plant_closures.updated_by_id': 'Plant Calendar dates edited',
  'plant_weekly_rules.created_by_id': 'Weekly-off rules created',
  'plant_weekly_rules.updated_by_id': 'Weekly-off rules edited',
  'calendar_years.created_by_id': 'Annual calendars created',
  'calendar_years.approved_by_id': 'Annual calendars approved',
  'machine_day_plans.updated_by_id': 'Machine day plans edited',
  'score_settings.updated_by_id': 'Score settings changed',
  'score_setting_history.changed_by_id': 'Score setting history entries'
}
/** References removed with the account (their rows belong to it) or kept (audit log). */
const REMOVED_WITH_USER = ['push_tokens.user_id', 'manager_permissions.user_id']
const KEPT_WITH_USER = ['audit_logs.user_id']
const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/

/**
 * Every reference to each user, by column. Read from the catalog so a column added later is
 * counted too (and counts as history, so it blocks the delete).
 */
async function userReferences(tx: Db, userIds: string[]) {
  const refs = await referencesTo(tx, 'users')
  const result = new Map<string, Map<string, number>>()
  for (const ref of refs) {
    const [tbl, col] = ref.split('.')
    if (!SAFE_IDENTIFIER.test(tbl) || !SAFE_IDENTIFIER.test(col)) throw conflict(`Unexpected reference ${ref}`)
    const out = await tx.execute<{ key: string; c: string }>(sql`
      select ${sql.raw(`"${col}"`)}::text as key, count(*) as c
      from ${sql.raw(`"${tbl}"`)}
      where ${sql.raw(`"${col}"`)} in (${sql.join(userIds.map((id) => sql`${id}::uuid`), sql`, `)})
      group by 1
    `)
    const rows = (out as unknown as { rows?: { key: string; c: string }[] }).rows ?? (out as unknown as { key: string; c: string }[])
    result.set(ref, tally(rows))
  }
  return result
}

async function userImpact(tx: Db, ids: string[], lock: boolean, actor: AuthUser): Promise<Impact> {
  const query = tx
    .select({
      id: users.id,
      name: users.name,
      employeeId: users.employeeId,
      role: users.role,
      isActive: users.isActive,
      updatedAt: users.updatedAt,
      departmentName: departments.name
    })
    .from(users)
    .leftJoin(departments, eq(users.departmentId, departments.id))
    .where(inArray(users.id, ids))
  const rows = lock ? await query.for('update', { of: users }) : await query

  const refs = rows.length ? await userReferences(tx, rows.map((r) => r.id)) : new Map<string, Map<string, number>>()
  const [{ c: activeSuperAdmins }] = await tx
    .select({ c: count() })
    .from(users)
    .where(and(eq(users.role, 'SUPER_ADMIN'), eq(users.isActive, true)))
  const superAdminsBeingDeleted = rows.filter((r) => r.role === 'SUPER_ADMIN' && r.isActive).length
  const manageable = actor.role === 'SUPER_ADMIN' ? ['WORKER', 'MANAGER', 'ADMIN', 'SUPER_ADMIN'] : ['WORKER', 'MANAGER']

  const items: ImpactItem[] = rows.map((r) => {
    const history: Dependent[] = []
    for (const [ref, map] of refs) {
      if (REMOVED_WITH_USER.includes(ref) || KEPT_WITH_USER.includes(ref)) continue
      const c = at(map, r.id)
      if (c) history.push({ label: HISTORY_LABEL[ref] ?? ref, count: c })
    }
    const historyTotal = history.reduce((s, h) => s + h.count, 0)
    const blockers: string[] = []
    if (r.id === actor.id) blockers.push('You cannot delete your own account.')
    if (!manageable.includes(r.role)) blockers.push(`You cannot delete ${ROLE_NAME[r.role]} accounts.`)
    if (r.role === 'SUPER_ADMIN' && r.isActive && n(activeSuperAdmins) - superAdminsBeingDeleted < 1) {
      blockers.push('This is the last active Super Admin.')
    }
    if (historyTotal > 0) {
      blockers.push('This user has production history, so the account can only be disabled. Their name stays on every record.')
    }
    return {
      id: r.id,
      name: `${r.name} (${r.employeeId})`,
      status: r.isActive ? 'ACTIVE' : 'DISABLED',
      details: [
        { label: 'Name', value: r.name },
        { label: 'Employee ID', value: r.employeeId },
        { label: 'Role', value: ROLE_NAME[r.role] },
        { label: 'Department', value: r.departmentName ?? '—' },
        { label: 'Account', value: r.isActive ? 'Active' : 'Disabled' }
      ],
      // History blocks the delete; it is listed so the dialog can say why.
      dependents: [
        ...history,
        { label: 'Signed-in devices (push tokens)', count: at(refs.get('push_tokens.user_id') ?? new Map(), r.id) },
        { label: 'Permissions', count: at(refs.get('manager_permissions.user_id') ?? new Map(), r.id) }
      ],
      preserved: [{ label: 'Audit log entries (name and role kept)', count: at(refs.get('audit_logs.user_id') ?? new Map(), r.id) }],
      files: 0,
      fileBytes: 0,
      blockers
    }
  })
  const fingerprint = rows.map((r) => [r.id, r.role, r.isActive, when(r.updatedAt)])
  return finish('users', 'DELETE_USERS', ids, items, fingerprint)
}

// ---------------------------------------------------------------------------- public API

export function deleteImpact(type: DeleteType, ids: string[], actor: AuthUser, tx: Db = db, lock = false) {
  const unique = [...new Set(ids)]
  if (type === 'checks') return checkImpact(tx, unique, lock)
  if (type === 'jobs') return jobImpact(tx, unique, lock)
  return userImpact(tx, unique, lock, actor)
}

export interface DeleteResult {
  deleted: number
  filesRemoved: number
  /** Files whose database row was deleted but which could not be removed from disk. */
  filesNotRemoved: string[]
}

/**
 * Deletes the records inside `tx` after re-checking the impact against the preview.
 * Returns the evidence file paths to remove once the transaction has committed.
 */
export async function deleteInTransaction(
  tx: Transaction,
  type: DeleteType,
  ids: string[],
  actor: AuthUser,
  expectedToken: string
): Promise<{ impact: Impact; filePaths: string[] }> {
  // Refuse if the schema has a reference this code does not handle.
  if (type === 'checks') {
    await assertKnownReferences(tx, 'quality_checks', [
      'quality_check_values.check_id',
      'media.check_id',
      'exceptions.check_id',
      'schedule_timers.last_check_id'
    ])
    await assertKnownReferences(tx, 'exceptions', ['media.exception_id'])
  } else if (type === 'jobs') {
    await assertKnownReferences(tx, 'jobs', ['job_handovers.job_id', 'quality_checks.job_id'])
    await assertKnownReferences(tx, 'quality_checks', [
      'quality_check_values.check_id',
      'media.check_id',
      'exceptions.check_id',
      'schedule_timers.last_check_id'
    ])
    await assertKnownReferences(tx, 'exceptions', ['media.exception_id'])
  }

  const impact = await deleteImpact(type, ids, actor, tx, true)
  if (impact.missing.length) {
    throw conflict(`${impact.missing.length} of the selected records no longer exist. Review the selection again.`)
  }
  if (impact.blocked) {
    const first = impact.items.find((i) => i.blockers.length)!
    throw conflict(`${impact.blocked} record(s) cannot be deleted. ${first.name}: ${first.blockers[0]}`)
  }
  if (impact.impactToken !== expectedToken) {
    throw conflict('These records changed after the preview. Review what will be deleted again.')
  }

  const unique = impact.items.map((i) => i.id)
  let filePaths: string[] = []

  if (type === 'checks' || type === 'jobs') {
    const checkIds =
      type === 'checks'
        ? unique
        : (await tx.select({ id: qualityChecks.id }).from(qualityChecks).where(inArray(qualityChecks.jobId, unique))).map((c) => c.id)
    filePaths = (await mediaOfChecks(tx, checkIds)).map((f) => f.path)
    // Checks first: values, evidence rows and exceptions (with their evidence) go by cascade.
    if (checkIds.length) await tx.delete(qualityChecks).where(inArray(qualityChecks.id, checkIds))
    if (type === 'jobs') {
      // Any check still pointing at these jobs would be detached by the job delete: refuse.
      const [{ c: left }] = await tx.select({ c: count() }).from(qualityChecks).where(inArray(qualityChecks.jobId, unique))
      if (n(left)) throw conflict('New checks were added to these jobs. Review what will be deleted again.')
      // Handovers go by cascade.
      await tx.delete(jobs).where(inArray(jobs.id, unique))
    }
    // Nothing of these checks may be left behind.
    if (checkIds.length) {
      const [{ c: leftValues }] = await tx.select({ c: count() }).from(qualityCheckValues).where(inArray(qualityCheckValues.checkId, checkIds))
      const [{ c: leftExceptions }] = await tx.select({ c: count() }).from(checkExceptions).where(inArray(checkExceptions.checkId, checkIds))
      const [{ c: leftMedia }] = await tx.select({ c: count() }).from(media).where(inArray(media.checkId, checkIds))
      if (n(leftValues) || n(leftExceptions) || n(leftMedia)) throw conflict('Deleting would leave records behind; nothing was deleted.')
    }
  } else {
    // Users: only accounts without history reach this point. Their devices and permissions
    // go by cascade; their audit entries stay, with the name and role snapshot.
    await tx.delete(pushTokens).where(inArray(pushTokens.userId, unique))
    await tx.delete(managerPermissions).where(inArray(managerPermissions.userId, unique))
    await tx.delete(users).where(inArray(users.id, unique))
  }

  return { impact, filePaths }
}

/** Removes evidence files after the commit. A failure is reported, never undone in the database. */
export async function removeFiles(paths: string[]): Promise<Pick<DeleteResult, 'filesRemoved' | 'filesNotRemoved'>> {
  const filesNotRemoved: string[] = []
  let filesRemoved = 0
  for (const p of [...new Set(paths)]) {
    try {
      await storage.remove(p)
      filesRemoved++
    } catch (err) {
      console.error(`Could not remove evidence file ${p} after deleting its record:`, err)
      filesNotRemoved.push(p)
    }
  }
  return { filesRemoved, filesNotRemoved }
}

/** Counts shown in the audit entry: the record's identity and what went with it. */
export const auditSnapshot = (item: ImpactItem) => ({
  id: item.id,
  name: item.name,
  status: item.status,
  details: Object.fromEntries(item.details.map((d) => [d.label, d.value])),
  removed: Object.fromEntries(item.dependents.filter((d) => d.count).map((d) => [d.label, d.count])),
  files: item.files,
  fileBytes: item.fileBytes
})
