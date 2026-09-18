import path from 'node:path'
import { Router } from 'express'
import multer from 'multer'
import { z } from 'zod'
import { config } from '../config'
import { idParam } from '../lib/validate'
import { HttpError, notFound } from '../lib/http'
import { audit } from '../lib/audit'
import { requireModule } from '../lib/permissions'
import { addDays, dateKey, parseDateKey, startOfDay } from '../lib/time'
import { invalidateCheckGeneration } from '../services/checkGenerator'
import { removeChecksIfClosed } from '../services/plantCalendar'
import {
  CALENDAR_V2_START,
  WEEKDAY_NAMES,
  createWeeklyRule,
  deleteWeeklyRule,
  earliestChangeDate,
  listWeeklyRules,
  updateWeeklyRule
} from '../services/weeklyRules'
import {
  ACCEPTED_DOCUMENTS,
  FIRST_CALENDAR_YEAR,
  addItem,
  approveYear,
  confirmItem,
  createYear,
  deleteItem,
  deleteYear,
  documentFile,
  getYear,
  importDocument,
  listYears,
  updateItem,
  yearDetail
} from '../services/calendarYears'

/** Annual company calendars (2027 onwards) and weekly closure rules. View to read, manage to change. */
export const calendarYearsRouter = Router()
export const weeklyRulesRouter = Router()

const view = requireModule('calendar', 'view')
const manage = requireModule('calendar', 'manage')

const dateString = z.string().refine((v) => {
  try {
    return dateKey(parseDateKey(v)) === v
  } catch {
    return false
  }
}, 'Enter a valid date')

const documentUpload = multer({
  dest: path.join(config.uploadDir, '.tmp'),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) =>
    ACCEPTED_DOCUMENTS.test(file.originalname) ? cb(null, true) : cb(new HttpError(400, 'Upload the calendar as an Excel file (.xlsx), CSV, PDF or image (JPG/PNG).'))
}).single('document')

// ---------------------------------------------------------------- years

calendarYearsRouter.get('/', view, async (_req, res) => {
  res.json({ firstYear: FIRST_CALENDAR_YEAR, years: await listYears() })
})

calendarYearsRouter.post('/', manage, async (req, res) => {
  const { year } = z.object({ year: z.coerce.number().int() }).parse(req.body)
  const row = await createYear(year, req.user!.id)
  await audit(req, 'CREATE_CALENDAR_YEAR', 'PlantCalendar', String(year))
  res.status(201).json(await yearDetail(row.id))
})

calendarYearsRouter.get('/:id', view, async (req, res) => {
  res.json(await yearDetail(idParam(req)))
})

calendarYearsRouter.delete('/:id', manage, async (req, res) => {
  const year = await deleteYear(idParam(req))
  await audit(req, 'DELETE_CALENDAR_YEAR', 'PlantCalendar', String(year.year))
  res.json({ result: 'deleted' })
})

/** Reads the company document (Excel, CSV, PDF or image) into dates for review. Nothing is approved. */
calendarYearsRouter.post('/:id/import', manage, documentUpload, async (req, res) => {
  const id = idParam(req)
  if (!req.file) throw new HttpError(400, 'Choose the calendar document to upload.')
  const replace = z.object({ replace: z.enum(['true', 'false']).optional() }).parse(req.query).replace === 'true'
  const year = await getYear(id)
  const summary = await importDocument(id, req.file, replace)
  await audit(req, 'IMPORT_CALENDAR_DOCUMENT', 'PlantCalendar', String(year.year), {
    newValue: { file: req.file.originalname, ...summary }
  })
  res.json({ summary, ...(await yearDetail(id)) })
})

/** The uploaded company document, for side-by-side review. Only for signed-in users with Plant Calendar access. */
calendarYearsRouter.get('/:id/document', view, async (req, res) => {
  const file = await documentFile(idParam(req))
  res.setHeader('Content-Type', file.mimeType)
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.name)}"`)
  res.setHeader('Cache-Control', 'private, no-store')
  res.sendFile(file.path)
})

// ---------------------------------------------------------------- items

const itemInput = z
  .object({
    type: z.enum(['HOLIDAY', 'WORKING', 'CLOSED', 'SHUTDOWN'], 'Choose the type'),
    date: dateString,
    name: z
      .string()
      .trim()
      .max(200)
      .nullish()
      .transform((v) => v || null),
    forHolidayDate: dateString.nullish().or(z.literal('')).transform((v) => v || null)
  })

calendarYearsRouter.post('/:id/items', manage, async (req, res) => {
  const id = idParam(req)
  const item = await addItem(id, itemInput.parse(req.body))
  const year = await getYear(id)
  await audit(req, 'ADD_CALENDAR_DATE', 'PlantCalendar', String(year.year), { newValue: item })
  res.status(201).json(await yearDetail(id))
})

calendarYearsRouter.put('/:id/items/:itemId', manage, async (req, res) => {
  const id = idParam(req)
  const itemId = idParam(req, 'itemId')
  const { before, after } = await updateItem(id, itemId, itemInput.parse(req.body))
  const year = await getYear(id)
  await audit(req, 'EDIT_CALENDAR_DATE', 'PlantCalendar', String(year.year), { oldValue: before, newValue: after })
  res.json(await yearDetail(id))
})

calendarYearsRouter.post('/:id/items/:itemId/confirm', manage, async (req, res) => {
  const id = idParam(req)
  const item = await confirmItem(id, idParam(req, 'itemId'))
  const year = await getYear(id)
  await audit(req, 'CONFIRM_CALENDAR_DATE', 'PlantCalendar', String(year.year), { newValue: { date: item.date, type: item.type, name: item.name } })
  res.json(await yearDetail(id))
})

calendarYearsRouter.delete('/:id/items/:itemId', manage, async (req, res) => {
  const id = idParam(req)
  const item = await deleteItem(id, idParam(req, 'itemId'))
  const year = await getYear(id)
  await audit(req, 'DELETE_CALENDAR_DATE', 'PlantCalendar', String(year.year), { oldValue: item })
  res.json(await yearDetail(id))
})

/** Publishes the reviewed dates: from now on they decide scheduling for this year. */
calendarYearsRouter.post('/:id/approve', manage, async (req, res) => {
  const id = idParam(req)
  const year = await getYear(id)
  const result = await approveYear(id, req.user!.id)
  await audit(req, 'APPROVE_CALENDAR_YEAR', 'PlantCalendar', String(year.year), {
    oldValue: result.before.length ? { dates: result.before.map((e) => `${e.date} ${e.type} ${e.reason ?? ''}`.trim()) } : undefined,
    newValue: { dates: result.items.map((i) => `${i.date} ${i.type} ${i.name ?? ''}`.trim()), removedChecks: result.removedChecks }
  })
  res.json({ removedChecks: result.removedChecks, ...(await yearDetail(id)) })
})

// ---------------------------------------------------------------- weekly rules

const ruleInput = z.object({
  weekday: z.number().int().min(0).max(6),
  effectiveFrom: dateString,
  effectiveTo: dateString.nullish().or(z.literal('')).transform((v) => v || null),
  note: z
    .string()
    .trim()
    .max(200)
    .nullish()
    .transform((v) => v || null)
})

/** Weekly rules only affect today onwards: re-check the dates checks are already generated for. */
async function afterRuleChange() {
  invalidateCheckGeneration()
  const from = startOfDay(new Date())
  const keys: string[] = []
  for (let i = 0; i <= 10; i++) {
    const key = dateKey(addDays(from, i))
    if (key >= CALENDAR_V2_START) keys.push(key)
  }
  return removeChecksIfClosed(keys)
}

const describeRule = (r: { weekday: number; effectiveFrom: string; effectiveTo: string | null }) =>
  `${WEEKDAY_NAMES[r.weekday]} from ${r.effectiveFrom}${r.effectiveTo ? ` to ${r.effectiveTo}` : ''}`

weeklyRulesRouter.get('/', view, async (_req, res) => {
  res.json({ startsOn: CALENDAR_V2_START, earliestChange: earliestChangeDate(), rules: await listWeeklyRules() })
})

weeklyRulesRouter.post('/', manage, async (req, res) => {
  const rule = await createWeeklyRule(ruleInput.parse(req.body), req.user!.id)
  const removedChecks = await afterRuleChange()
  await audit(req, 'CREATE_WEEKLY_RULE', 'PlantCalendar', rule.id, { newValue: { rule: describeRule(rule), note: rule.note, removedChecks } })
  res.status(201).json({ rule, removedChecks })
})

weeklyRulesRouter.put('/:id', manage, async (req, res) => {
  const id = idParam(req)
  const input = ruleInput.partial().parse(req.body)
  const result = await updateWeeklyRule(id, input, req.user!.id)
  if (!result) throw notFound('Weekly rule')
  const removedChecks = await afterRuleChange()
  await audit(req, 'UPDATE_WEEKLY_RULE', 'PlantCalendar', id, {
    oldValue: { rule: describeRule(result.before), note: result.before.note },
    newValue: { rule: describeRule(result.after), note: result.after.note, removedChecks }
  })
  res.json({ rule: result.after, removedChecks })
})

weeklyRulesRouter.delete('/:id', manage, async (req, res) => {
  const id = idParam(req)
  const rule = await deleteWeeklyRule(id)
  if (!rule) throw notFound('Weekly rule')
  const removedChecks = await afterRuleChange()
  await audit(req, 'DELETE_WEEKLY_RULE', 'PlantCalendar', id, { oldValue: { rule: describeRule(rule), note: rule.note } })
  res.json({ result: 'deleted', removedChecks })
})
