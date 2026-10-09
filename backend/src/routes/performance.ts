import { Router } from 'express'
import { z } from 'zod'
import { requireModule } from '../lib/permissions'
import { badRequest } from '../lib/http'
import { addDays, parseDateKey, startOfDay } from '../lib/time'
import { performanceScope, performanceFilterValues, performanceOf, workerPerformance } from '../services/performance'

export const performanceRouter = Router()

/**
 * Worker performance for Admins and Managers. Workers never reach this router (the admin API
 * refuses them); they read their own figures from GET /api/worker/performance.
 *
 * Viewing needs the "performance" module. How the score is worked out: services/performance.ts.
 *
 * Departments: everyone sees every worker of every department. `departmentId` filters by the
 * department of the work recorded on each check, not by the worker's own department. `scope` is
 * still sent (always unrestricted) for older app builds that read it.
 */

const view = requireModule('performance', 'view')

const filterQuery = z.object({
  date: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  workerId: z.uuid().optional(),
  machineId: z.uuid().optional(),
  shiftId: z.uuid().optional(),
  activityId: z.uuid().optional(),
  jobId: z.uuid().optional(),
  jobNo: z.string().trim().max(60).optional(),
  departmentId: z.uuid().optional()
})

/** `date` alone is one day; `from`/`to` are inclusive dates; nothing given means today. */
export function performanceRange(q: z.infer<typeof filterQuery>) {
  try {
    const from = q.from ? parseDateKey(q.from) : q.date ? parseDateKey(q.date) : startOfDay(new Date())
    const toInclusive = q.to ? parseDateKey(q.to) : q.date ? parseDateKey(q.date) : from
    if (toInclusive < from) throw badRequest('"to" date must be on or after "from" date')
    return { from, to: addDays(toInclusive, 1) }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Invalid date')) throw badRequest(err.message)
    throw err
  }
}

performanceRouter.get('/workers', view, async (req, res) => {
  const q = filterQuery.parse(req.query)
  const { from, to } = performanceRange(q)
  const scope = await performanceScope(req.user!)
  res.json({
    from,
    to,
    scope,
    ...(await workerPerformance({
      from,
      to,
      workerId: q.workerId,
      machineId: q.machineId,
      shiftId: q.shiftId,
      activityId: q.activityId,
      jobId: q.jobId,
      jobNo: q.jobNo,
      departmentId: q.departmentId
    }))
  })
})

/** One worker's figures, with the same filters as the list, so they match the worker's row there. */
performanceRouter.get('/workers/:id', view, async (req, res) => {
  const id = z.uuid().parse(req.params.id)
  const q = filterQuery.parse(req.query)
  const { from, to } = performanceRange(q)
  res.json(
    await performanceOf(id, {
      from,
      to,
      machineId: q.machineId,
      shiftId: q.shiftId,
      activityId: q.activityId,
      jobId: q.jobId,
      jobNo: q.jobNo,
      departmentId: q.departmentId
    })
  )
})

performanceRouter.get('/filter-values', view, async (req, res) => {
  res.json(await performanceFilterValues(await performanceScope(req.user!)))
})
