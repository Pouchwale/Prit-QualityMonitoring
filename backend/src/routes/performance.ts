import { Router } from 'express'
import { z } from 'zod'
import ExcelJS from 'exceljs'
import { requireModule } from '../lib/permissions'
import { badRequest } from '../lib/http'
import { addDays, dateKey, formatDateKey, parseDateKey, startOfDay } from '../lib/time'
import { overallScores, performanceScope, performanceFilterValues, performanceOf, weeklyScores, workerPerformance, type DayScore } from '../services/performance'

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

/**
 * Day-wise weekly scores (Sunday to Saturday) of every worker: Worker Performance view (the permission
 * matrix). `?week=YYYY-MM-DD` is any day of the week; nothing means this week.
 */
const weekQuery = z.object({ week: z.string().optional() })
function weekOf(q: z.infer<typeof weekQuery>) {
  try {
    return q.week ? parseDateKey(q.week) : startOfDay(new Date())
  } catch {
    throw badRequest('Invalid week date')
  }
}

performanceRouter.get('/weekly', view, async (req, res) => {
  res.json(await weeklyScores(weekOf(weekQuery.parse(req.query))))
})

/** Every worker's overall score, from their first check up to now: Worker Performance view. */
performanceRouter.get('/overall', view, async (_req, res) => {
  res.json({ asOf: dateKey(new Date()), rows: await overallScores() })
})

/** The same report as an Excel file (Worker Performance export): one row per worker, a cell per day and the week. */
performanceRouter.get('/weekly.xlsx', requireModule('performance', 'export'), async (req, res) => {
  const report = await weeklyScores(weekOf(weekQuery.parse(req.query)))
  const book = new ExcelJS.Workbook()
  const sheet = book.addWorksheet('Weekly scores')
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  sheet.addRow([`Worker scores, week of ${formatDateKey(report.days[0])} to ${formatDateKey(report.days[report.days.length - 1])}`])
  sheet.addRow(['Score = done / assigned as a percentage, minus 100 (0% = every check done). Done = completed + exceptions; pending checks are not counted yet.'])
  sheet.addRow([])
  const header = sheet.addRow(['Worker', 'Employee ID', 'Department', ...report.days.map((d, i) => `${dayNames[i]} ${formatDateKey(d)}`), 'Week', 'Week done / assigned', 'Completed', 'Exceptions', 'Missed', 'Pending'])
  header.font = { bold: true }
  const fill = (score: number | null) =>
    score === null ? undefined : score === 0 ? 'FFDCFCE7' : score >= -20 ? 'FFFEF3C7' : 'FFFEE2E2'
  const text = (d: DayScore) => (d.score === null ? '—' : `${d.score}% (${d.done}/${d.assigned})`)
  for (const r of report.rows) {
    const row = sheet.addRow([
      r.name,
      r.employeeId,
      r.department ?? '',
      ...r.days.map(text),
      r.week.score === null ? '—' : `${r.week.score}%`,
      `${r.week.done}/${r.week.assigned}`,
      r.week.completed,
      r.week.exceptions,
      r.week.missed,
      r.week.pending
    ])
    ;[...r.days, r.week].forEach((d, i) => {
      const color = fill(d.score)
      if (color) row.getCell(4 + i).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: color } }
    })
  }
  sheet.columns.forEach((c, i) => (c.width = i === 0 ? 22 : i < 3 ? 14 : 16))
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', `attachment; filename="worker-scores-${report.weekStart}.xlsx"`)
  res.send(Buffer.from(await book.xlsx.writeBuffer()))
})
