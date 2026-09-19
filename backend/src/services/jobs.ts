import { and, desc, eq, inArray } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { db } from '../db/client'
import { jobs, users } from '../db/schema'
import { RUNNING_STATUSES } from './jobMonitoring'

/**
 * Production jobs: planned by an Admin/Manager or started by the worker, then checked at start,
 * at intervals and at end (services/jobMonitoring.ts). Every check done during a job records it.
 */

export type Job = typeof jobs.$inferSelect

export interface JobDto {
  id: string
  machineId: string
  itemCode: string | null
  jobNo: string
  status: Job['status']
  startedAt: Date | null
  startedById: string | null
  startedByName: string | null
  /** When the Job Start check was completed and interval checks began. */
  activatedAt: Date | null
  endRequestedAt: Date | null
  endedAt: Date | null
  endedById: string | null
  /** The worker responsible now (notifications and job checks go to them). */
  assignedWorkerId: string | null
  assignedWorkerName: string | null
  plannedFor: string | null
  note: string | null
  forceClosed: boolean
}

export function jobDto(job: Job, names: { startedByName?: string | null; assignedWorkerName?: string | null } = {}): JobDto {
  return {
    id: job.id,
    machineId: job.machineId,
    itemCode: job.itemCode,
    jobNo: job.jobNo,
    status: job.status,
    startedAt: job.startedAt,
    startedById: job.startedById,
    startedByName: names.startedByName ?? null,
    activatedAt: job.activatedAt,
    endRequestedAt: job.endRequestedAt,
    endedAt: job.endedAt,
    endedById: job.endedById,
    assignedWorkerId: job.assignedWorkerId,
    assignedWorkerName: names.assignedWorkerName ?? null,
    plannedFor: job.plannedFor,
    note: job.note,
    forceClosed: job.forceClosed
  }
}

const starter = alias(users, 'starter')
const assignee = alias(users, 'assignee')

async function withNames(where: ReturnType<typeof and>) {
  const rows = await db
    .select({ job: jobs, startedByName: starter.name, assignedWorkerName: assignee.name })
    .from(jobs)
    .leftJoin(starter, eq(jobs.startedById, starter.id))
    .leftJoin(assignee, eq(jobs.assignedWorkerId, assignee.id))
    .where(where)
    .orderBy(desc(jobs.startedAt))
  return rows.map((r) => jobDto(r.job, r))
}

/** The job running on a machine (starting, active or ending), if any. */
export async function runningJob(machineId: string) {
  const [job] = await withNames(and(eq(jobs.machineId, machineId), inArray(jobs.status, [...RUNNING_STATUSES])))
  return job ?? null
}

/** The jobs running on these machines, by machine id. */
export async function runningJobs(machineIds: string[]) {
  if (machineIds.length === 0) return new Map<string, JobDto>()
  const rows = await withNames(and(inArray(jobs.machineId, machineIds), inArray(jobs.status, [...RUNNING_STATUSES])))
  return new Map(rows.map((r) => [r.machineId, r]))
}

/** Planned jobs of these machines, for the worker's "Start Job" list. */
export async function plannedJobs(machineIds: string[]) {
  if (machineIds.length === 0) return []
  return withNames(and(inArray(jobs.machineId, machineIds), eq(jobs.status, 'PLANNED')))
}

export async function jobById(jobId: string) {
  const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId))
  return row ?? null
}

export async function jobDtoById(jobId: string) {
  const [job] = await withNames(and(eq(jobs.id, jobId)))
  return job ?? null
}
