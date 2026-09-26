import { Router } from 'express'
import { z } from 'zod'
import { audit } from '../lib/audit'
import { requireAdmin, requireModule } from '../lib/permissions'
import { badRequest, HttpError } from '../lib/http'
import { addDays, parseDateKey, startOfDay } from '../lib/time'
import {
  activeScoreSetting,
  departmentOfWorker,
  performanceScope,
  penaltyHistory,
  performanceFilterValues,
  performanceOf,
  setPenaltyPerMissed,
  workerPerformance
} from '../services/performance'

export const performanceRouter = Router()

/**
 * Worker performance for Admins and Managers. Workers never reach this router (the admin API
 * refuses them); they read their own figures from GET /api/worker/performance.
 *
 * Viewing needs the "performance" module; only an Admin or the Super Admin may change the scoring
 * rule (requireAdmin), whatever the module says.
 *
 * Departments: an Admin sees every worker and may filter by department. A Manager only ever sees
 * their own department, whatever `departmentId` or `workerId` the request contains.
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
  // A Manager's own department wins over anything the request asks for.
  const departmentId = scope.restricted ? (scope.departmentId ?? undefined) : q.departmentId
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
      departmentId,
      none: scope.missingDepartment
    }))
  })
})

/** One worker's figures. A Manager may only open a worker of their own department. */
performanceRouter.get('/workers/:id', view, async (req, res) => {
  const id = z.uuid().parse(req.params.id)
  const q = filterQuery.parse(req.query)
  const { from, to } = performanceRange(q)
  const scope = await performanceScope(req.user!)
  if (scope.restricted) {
    const department = await departmentOfWorker(id)
    if (!scope.departmentId || department !== scope.departmentId) {
      throw new HttpError(403, 'This worker is in another department')
    }
  }
  res.json(await performanceOf(id, { from, to, machineId: q.machineId, shiftId: q.shiftId, activityId: q.activityId, jobId: q.jobId, jobNo: q.jobNo }))
})

performanceRouter.get('/filter-values', view, async (req, res) => {
  res.json(await performanceFilterValues(await performanceScope(req.user!)))
})

/** The scoring rule. Anyone who may see performance may see which rule produced the numbers. */
performanceRouter.get('/settings', view, async (_req, res) => {
  const setting = await activeScoreSetting()
  res.json(setting)
})

/** Changing the rule is Admin only; Managers get 403 even with the performance module. */
performanceRouter.put('/settings', requireAdmin, async (req, res) => {
  const { penaltyPerMissed } = z
    .object({ penaltyPerMissed: z.coerce.number().int().min(-1000).max(0) })
    .parse(req.body)
  const { previous, current } = await setPenaltyPerMissed(penaltyPerMissed, req.user!.id)
  await audit(req, 'UPDATE_SCORE_SETTINGS', 'ScoreSettings', 'penaltyPerMissed', {
    oldValue: { penaltyPerMissed: previous },
    newValue: { penaltyPerMissed: current }
  })
  res.json(await activeScoreSetting())
})

/** Who changed the scoring rule, when, and from what to what. Admin only. */
performanceRouter.get('/settings/history', requireAdmin, async (_req, res) => {
  res.json(await penaltyHistory())
})
