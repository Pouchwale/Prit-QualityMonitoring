import { Router } from 'express'
import { z } from 'zod'
import { optionalText } from '../lib/validate'
import { badRequest, notFound } from '../lib/http'
import { audit } from '../lib/audit'
import { requireAnyView, requireModule } from '../lib/permissions'
import { addDays, dateKey, parseDateKey } from '../lib/time'
import { prepareChecks } from '../services/checkGenerator'
import { deletePlan, existingMachineIds, listPlans, removeChecksForPlanDates, savePlan, type PlanDto } from '../services/machineDays'

/**
 * Machine day plans (services/machineDays.ts): which machines run on a date. A date with a plan
 * overrides the plant calendar per machine; without one the plant calendar decides.
 */
export const machineDaysRouter = Router()

const MAX_RANGE_DAYS = 800

/** A real calendar date as YYYY-MM-DD (rejects e.g. 2026-02-31). */
const isDateKey = (v: string) => {
  try {
    return dateKey(parseDateKey(v)) === v
  } catch {
    return false
  }
}
const dateString = (label: string) => z.string().refine(isDateKey, `${label} must be a valid date (YYYY-MM-DD)`)

function dateParam(value: unknown) {
  const date = String(value ?? '')
  if (!isDateKey(date)) throw badRequest('Date must be a valid date (YYYY-MM-DD)')
  return date
}

/** Plans change only for today and later, so past checks, Missed counts and reports stay as they are. */
function assertNotPast(date: string) {
  if (date < dateKey(new Date())) throw badRequest('Past dates cannot be changed. Choose today or a later date.')
}

/** The audit log keeps machine names, which stay readable after a machine is renamed or removed. */
const auditView = (plan: PlanDto | null) =>
  plan ? { date: plan.date, machines: plan.machines.map((m) => m.name), count: plan.machines.length, note: plan.note } : undefined

machineDaysRouter.get('/', requireAnyView('calendar', 'dashboard', 'schedules'), async (req, res) => {
  const q = z.object({ from: dateString('From date'), to: dateString('To date') }).parse(req.query)
  if (q.to < q.from) throw badRequest('"to" date must be on or after "from" date')
  if (addDays(parseDateKey(q.from), MAX_RANGE_DAYS - 1) < parseDateKey(q.to)) throw badRequest('Choose a shorter date range')
  res.json(await listPlans(q.from, q.to))
})

/** Creates or replaces the plan of a date: exactly these machines run that day (an empty list: none). */
machineDaysRouter.put('/:date', requireModule('calendar', 'manage'), async (req, res) => {
  const date = dateParam(req.params.date)
  const body = z
    .object({
      machineIds: z.array(z.uuid('Invalid machine id'), 'Choose the machines that run on this date').max(1000),
      note: optionalText(200)
    })
    .parse(req.body)
  assertNotPast(date)
  const ids = [...new Set(body.machineIds)]
  const known = await existingMachineIds(ids)
  const unknown = ids.filter((id) => !known.has(id))
  if (unknown.length) throw badRequest(`Unknown machine${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`)

  const { before, after } = await savePlan(date, ids, body.note ?? null, req.user!.id)
  const removedChecks = await removeChecksForPlanDates([date])
  if (date === dateKey(new Date())) await prepareChecks([new Date()])
  await audit(req, before ? 'UPDATE' : 'CREATE', 'MachineDayPlan', date, {
    oldValue: auditView(before),
    newValue: { ...auditView(after), removedChecks }
  })
  res.json({ plan: after, removedChecks })
})

/** Removes a date's plan: every machine follows the plant calendar again. */
machineDaysRouter.delete('/:date', requireModule('calendar', 'manage'), async (req, res) => {
  const date = dateParam(req.params.date)
  assertNotPast(date)
  const before = await deletePlan(date)
  if (!before) throw notFound('Machine plan for this date')
  const removedChecks = await removeChecksForPlanDates([date])
  if (date === dateKey(new Date())) await prepareChecks([new Date()])
  await audit(req, 'DELETE', 'MachineDayPlan', date, {
    oldValue: auditView(before),
    newValue: removedChecks ? { removedChecks } : undefined
  })
  res.json({ removed: true, removedChecks })
})
