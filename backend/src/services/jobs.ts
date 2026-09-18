import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '../db/client'
import { jobs, users } from '../db/schema'
import { conflict } from '../lib/http'
import { invalidateCheckGeneration, removePendingJobChecks } from './checkGenerator'

/**
 * Production jobs. The worker starts a job on the machine and ends it when the run is over.
 * JOB schedules only create checks while a job runs (services/checkGenerator.ts), and every
 * submission records the job it belongs to.
 */

export type Job = typeof jobs.$inferSelect

export interface JobDto {
  id: string
  machineId: string
  itemCode: string | null
  jobNo: string
  startedAt: Date
  startedById: string | null
  startedByName: string | null
  endedAt: Date | null
  endedById: string | null
}

export function jobDto(job: Job, startedByName: string | null = null): JobDto {
  return {
    id: job.id,
    machineId: job.machineId,
    itemCode: job.itemCode,
    jobNo: job.jobNo,
    startedAt: job.startedAt,
    startedById: job.startedById,
    startedByName,
    endedAt: job.endedAt,
    endedById: job.endedById
  }
}

/** The job running on a machine, if any. */
export async function runningJob(machineId: string) {
  const [row] = await db
    .select({ job: jobs, startedByName: users.name })
    .from(jobs)
    .leftJoin(users, eq(jobs.startedById, users.id))
    .where(and(eq(jobs.machineId, machineId), isNull(jobs.endedAt)))
    .orderBy(desc(jobs.startedAt))
    .limit(1)
  return row ? jobDto(row.job, row.startedByName) : null
}

/** The jobs running on these machines, by machine id. */
export async function runningJobs(machineIds: string[]) {
  if (machineIds.length === 0) return new Map<string, JobDto>()
  const rows = await db
    .select({ job: jobs, startedByName: users.name })
    .from(jobs)
    .leftJoin(users, eq(jobs.startedById, users.id))
    .where(and(inArray(jobs.machineId, machineIds), isNull(jobs.endedAt)))
  return new Map(rows.map((r) => [r.job.machineId, jobDto(r.job, r.startedByName)]))
}

/** Starts a job. Only one job can run on a machine at a time (unique index). */
export async function startJob(machineId: string, jobNo: string, userId: string, itemCode: string | null = null): Promise<JobDto> {
  const [row] = await db
    .insert(jobs)
    .values({ machineId, itemCode, jobNo, startedAt: new Date(), startedById: userId })
    .onConflictDoNothing()
    .returning()
  if (!row) throw conflict('A job is already running on this machine. End it before starting a new one.')
  // JOB schedules can create their first check straight away.
  invalidateCheckGeneration()
  return jobDto(row)
}

/**
 * Ends a job. Checks of JOB schedules that were never notified are removed, so nothing is
 * counted as Missed on a machine that is not running; checks already due stay until their
 * window closes.
 */
export async function endJob(jobId: string, userId: string): Promise<{ job: JobDto; removedChecks: number }> {
  const [row] = await db
    .update(jobs)
    .set({ endedAt: new Date(), endedById: userId })
    .where(and(eq(jobs.id, jobId), isNull(jobs.endedAt)))
    .returning()
  if (!row) throw conflict('This job is already finished')
  const removedChecks = await removePendingJobChecks(row.machineId)
  return { job: jobDto(row), removedChecks }
}

export async function jobById(jobId: string) {
  const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId))
  return row ?? null
}
