import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { and, asc, eq, gte, isNull, lte, max } from 'drizzle-orm'
import { db } from '../db/client'
import { calendarYearItems, calendarYears, plantClosures } from '../db/schema'
import { badRequest, conflict, notFound } from '../lib/http'
import { addDays, dateKey, formatDateKey, parseDateKey, startOfDay, weekdayOf } from '../lib/time'
import { invalidateCheckGeneration } from './checkGenerator'
import { extractRows, type ExtractionMethod } from './calendarExtraction'
import { itemsFromRows } from './calendarImport'
import { CLOSURE_LABEL, removeChecksIfClosed, type ClosureType } from './plantCalendar'
import { CALENDAR_V2_START, ruleCloses, rulesBetween, WEEKDAY_NAMES } from './weeklyRules'

/**
 * Annual company calendars (2027 onwards): create a year, import the company document, review
 * every date, then approve. Only approval publishes the dates to plant_closures, which is what
 * scheduling, alerts and Missed use. Until then, and while later edits await approval, the
 * published dates stay exactly as they were.
 *
 * Past dates are protected: an approval can never add, change or remove a date before today,
 * so earlier check statuses, Missed counts and reports are never rewritten.
 */

export const FIRST_CALENDAR_YEAR = Number(CALENDAR_V2_START.slice(0, 4))
export const CALENDAR_DOCS_DIR = path.resolve(process.cwd(), 'calendar-documents')

export type Item = typeof calendarYearItems.$inferSelect
export type Year = typeof calendarYears.$inferSelect

export type IssueSeverity = 'BLOCKING' | 'CHECK' | 'INFO'
export interface Issue {
  code: string
  severity: IssueSeverity
  message: string
  itemId: string | null
}

const today = () => dateKey(startOfDay(new Date()))
const shortDate = (iso: string) => formatDateKey(iso)
const weekdayIndex = (iso: string) => weekdayOf(parseDateKey(iso))

export async function getYear(id: string) {
  const [year] = await db.select().from(calendarYears).where(eq(calendarYears.id, id))
  if (!year) throw notFound('Calendar year')
  return year
}

export async function yearItems(id: string) {
  return db.select().from(calendarYearItems).where(eq(calendarYearItems.calendarYearId, id)).orderBy(asc(calendarYearItems.position), asc(calendarYearItems.date))
}

async function liveEntries(year: Year) {
  return db
    .select()
    .from(plantClosures)
    .where(and(gte(plantClosures.date, `${year.year}-01-01`), lte(plantClosures.date, `${year.year}-12-31`)))
}

// ---------------------------------------------------------------- review

/**
 * Everything the admin must look at before a year can be approved.
 *  BLOCKING  must be fixed (missing or impossible dates, duplicates, changes to past dates)
 *  CHECK     must be confirmed on the item (uncertain readings, weekday mismatches, adjustment
 *            days that fall on an open day or have no matching holiday)
 *  INFO      shown for awareness only
 */
export async function reviewIssues(year: Year, items: Item[]): Promise<Issue[]> {
  const issues: Issue[] = []
  const add = (severity: IssueSeverity, code: string, message: string, item: Item | null) =>
    issues.push({ severity, code, message, itemId: item?.id ?? null })
  const rules = await rulesBetween(`${year.year}-01-01`, `${year.year}-12-31`)
  const now = today()

  const byDate = new Map<string, Item[]>()
  for (const item of items) if (item.date) byDate.set(item.date, [...(byDate.get(item.date) ?? []), item])
  const holidays = items.filter((i) => i.type !== 'WORKING' && i.date)

  for (const item of items) {
    const label = item.date ? shortDate(item.date) : 'An item'
    if (!item.date) {
      add('BLOCKING', 'MISSING_DATE', `${item.type === 'WORKING' ? 'An adjustment working day' : `"${item.name ?? 'A holiday'}"`} has no date. Enter the date from the document or delete the row.`, item)
      continue
    }
    if (!item.date.startsWith(`${year.year}-`)) {
      add('BLOCKING', 'OUTSIDE_YEAR', `${label} is not in ${year.year}. Correct the date or delete the row.`, item)
    }
    const same = byDate.get(item.date) ?? []
    if (same.length > 1 && same[0].id === item.id) {
      const kinds = same.map((s) => CLOSURE_LABEL[s.type]).join(' and ')
      add('BLOCKING', 'DUPLICATE_DATE', `${label} is listed ${same.length} times (${kinds}). Keep one entry for this date.`, item)
    }

    if (!item.confirmed) {
      const fields = (item.uncertainFields ?? []).map((f) => ({ date: 'date', name: 'name', forHolidayDate: 'holiday it replaces', printedWeekday: 'weekday', source: 'text' })[f] ?? f)
      if (fields.length) add('CHECK', 'UNCERTAIN', `${label}: the ${fields.join(', ')} could not be read with certainty. Check it against the document.`, item)
      if (item.printedWeekday) {
        const printed = WEEKDAY_NAMES.indexOf(item.printedWeekday)
        if (printed >= 0 && printed !== weekdayIndex(item.date)) {
          add('CHECK', 'WEEKDAY_MISMATCH', `${label} is a ${WEEKDAY_NAMES[weekdayIndex(item.date)]}, but the document says ${item.printedWeekday}. Check which is right.`, item)
        }
      }
      if (item.type === 'WORKING') {
        if (!ruleCloses(rules, item.date)) {
          add('CHECK', 'WORKING_ON_OPEN_DAY', `${label} is a ${WEEKDAY_NAMES[weekdayIndex(item.date)]}, a normal working day, so marking it as an Adjustment Working Day changes nothing. Adjustment days are usually weekly off days — check the date.`, item)
        }
        const matches = holidays.filter((h) => h.date === item.forHolidayDate)
        if (!item.forHolidayDate || matches.length === 0) {
          add('CHECK', 'WORKING_WITHOUT_HOLIDAY', `${label}: the holiday this adjustment day replaces is not in the list. Check the holiday date.`, item)
        }
      }
      if (item.type !== 'WORKING' && !item.name?.trim()) add('CHECK', 'MISSING_NAME', `${label} has no holiday name.`, item)
    }
    if (item.type !== 'WORKING' && ruleCloses(rules, item.date)) {
      add('INFO', 'HOLIDAY_ON_WEEKLY_OFF', `${label} (${item.name ?? 'holiday'}) is on a ${WEEKDAY_NAMES[weekdayIndex(item.date)]}, already a weekly off.`, item)
    }
  }

  const adjustmentsByHoliday = new Map<string, Item[]>()
  for (const w of items.filter((i) => i.type === 'WORKING' && i.forHolidayDate)) {
    adjustmentsByHoliday.set(w.forHolidayDate!, [...(adjustmentsByHoliday.get(w.forHolidayDate!) ?? []), w])
  }
  for (const [holiday, list] of adjustmentsByHoliday) {
    if (list.length > 1 && list.some((w) => !w.confirmed)) {
      add('CHECK', 'HOLIDAY_ADJUSTED_TWICE', `The holiday on ${shortDate(holiday)} has ${list.length} adjustment working days. Check the document.`, list.find((w) => !w.confirmed)!)
    }
  }

  // Past dates already applied to checks and reports: they can never change here.
  const live = await liveEntries(year)
  const liveByDate = new Map(live.map((e) => [e.date, e]))
  for (const item of items) {
    if (!item.date || item.date >= now) continue
    const entry = liveByDate.get(item.date)
    if (!entry || entry.type !== item.type || (entry.reason ?? '') !== (item.name ?? '')) {
      add('BLOCKING', 'PAST_DATE', `${shortDate(item.date)} has already passed, so it cannot be added or changed now. Delete this row.`, item)
    }
  }
  for (const entry of live) {
    if (entry.date < now && !items.some((i) => i.date === entry.date)) {
      add('BLOCKING', 'PAST_DATE_REMOVED', `${shortDate(entry.date)} (${entry.reason ?? CLOSURE_LABEL[entry.type]}) has already passed and must stay in the calendar. Add it back.`, null)
    }
  }
  return issues
}

export const blocksApproval = (issues: Issue[]) => issues.some((i) => i.severity !== 'INFO')

export async function yearDetail(id: string) {
  const year = await getYear(id)
  const items = await yearItems(id)
  const issues = await reviewIssues(year, items)
  const live = await liveEntries(year)
  return { year: publicYear(year), items, issues, canApprove: !blocksApproval(issues) && (items.length > 0 || year.status !== 'APPROVED'), publishedCount: live.length }
}

export function publicYear(year: Year) {
  const { sourcePath, ...rest } = year
  return { ...rest, hasDocument: !!sourcePath }
}

export async function listYears() {
  const years = await db.select().from(calendarYears).orderBy(asc(calendarYears.year))
  return Promise.all(
    years.map(async (year) => {
      const items = await yearItems(year.id)
      const issues = await reviewIssues(year, items)
      return {
        ...publicYear(year),
        holidays: items.filter((i) => i.type !== 'WORKING').length,
        workingDays: items.filter((i) => i.type === 'WORKING').length,
        openIssues: issues.filter((i) => i.severity !== 'INFO').length
      }
    })
  )
}

// ---------------------------------------------------------------- years

export async function createYear(yearNumber: number, userId: string) {
  const maxYear = new Date().getFullYear() + 10
  if (yearNumber < FIRST_CALENDAR_YEAR) throw badRequest(`Annual calendars start from ${FIRST_CALENDAR_YEAR}. Earlier years keep their existing Plant Calendar dates.`)
  if (yearNumber > maxYear) throw badRequest(`Choose a year up to ${maxYear}`)
  const [existing] = await db.select().from(calendarYears).where(eq(calendarYears.year, yearNumber))
  if (existing) throw conflict(`The ${yearNumber} calendar already exists.`)
  const [row] = await db.insert(calendarYears).values({ year: yearNumber, createdById: userId, extractionMethod: 'MANUAL' }).returning()
  return row
}

export async function deleteYear(id: string) {
  const year = await getYear(id)
  if ((await liveEntries(year)).some((e) => e.calendarYearId === id) || year.status === 'APPROVED') {
    throw conflict(`The ${year.year} calendar has been approved and is in use, so it cannot be deleted. Edit its dates and approve again instead.`)
  }
  await db.delete(calendarYears).where(eq(calendarYears.id, id))
  if (year.sourcePath) await fsp.rm(path.join(CALENDAR_DOCS_DIR, year.sourcePath), { force: true })
  return year
}

async function markEdited(year: Year) {
  await db
    .update(calendarYears)
    .set({ pendingChanges: year.status === 'APPROVED', updatedAt: new Date() })
    .where(eq(calendarYears.id, year.id))
}

// ---------------------------------------------------------------- document import

export const ACCEPTED_DOCUMENTS = /\.(xlsx|csv|pdf|png|jpe?g|webp|bmp)$/i

export async function importDocument(id: string, file: Express.Multer.File, replace: boolean) {
  const year = await getYear(id)
  try {
    if (!ACCEPTED_DOCUMENTS.test(file.originalname)) {
      throw badRequest('Upload the calendar as an Excel file (.xlsx), CSV, PDF or image (JPG/PNG).')
    }
    const existing = await yearItems(id)
    if (existing.length && !replace) {
      throw conflict(`The ${year.year} calendar already has ${existing.length} dates. Importing replaces them with the dates read from the new document.`)
    }

    const extraction = await extractRows(file.path, file.mimetype, file.originalname)
    const { items, layout } = itemsFromRows(extraction.rows, year.year)

    await fsp.mkdir(CALENDAR_DOCS_DIR, { recursive: true })
    const ext = path.extname(file.originalname).toLowerCase()
    const stored = `${year.year}-${Date.now()}-${randomBytes(4).toString('hex')}${ext}`
    await fsp.copyFile(file.path, path.join(CALENDAR_DOCS_DIR, stored))
    const previousDocument = year.sourcePath

    const note = [
      extraction.note,
      layout === 'LINES' ? 'No table was found, so dates were taken from lines of text; check every row.' : null,
      items.length === 0 ? 'No dates could be read from this document. Add the dates by hand, or upload a clearer copy.' : null
    ]
      .filter(Boolean)
      .join(' ')

    await db.transaction(async (tx) => {
      await tx.delete(calendarYearItems).where(eq(calendarYearItems.calendarYearId, id))
      if (items.length) {
        await tx.insert(calendarYearItems).values(
          items.map((item, position) => ({ ...item, calendarYearId: id, position, confirmed: false }))
        )
      }
      await tx
        .update(calendarYears)
        .set({
          sourceFileName: file.originalname,
          sourcePath: stored,
          sourceMimeType: file.mimetype,
          extractionMethod: extraction.method as ExtractionMethod,
          extractionNote: note || null,
          pendingChanges: year.status === 'APPROVED',
          updatedAt: new Date()
        })
        .where(eq(calendarYears.id, id))
    })
    if (previousDocument) await fsp.rm(path.join(CALENDAR_DOCS_DIR, previousDocument), { force: true })
    return {
      method: extraction.method,
      rowsRead: extraction.rows.length,
      datesFound: items.length,
      uncertain: items.filter((i) => i.uncertainFields.length > 0).length
    }
  } finally {
    await fsp.rm(file.path, { force: true })
  }
}

export async function documentFile(id: string) {
  const year = await getYear(id)
  if (!year.sourcePath) throw notFound('Document')
  const full = path.join(CALENDAR_DOCS_DIR, year.sourcePath)
  if (!fs.existsSync(full)) throw notFound('Document')
  return { path: full, name: year.sourceFileName ?? path.basename(full), mimeType: year.sourceMimeType ?? 'application/octet-stream' }
}

// ---------------------------------------------------------------- items

export interface ItemInput {
  type: ClosureType
  date: string | null
  name: string | null
  forHolidayDate: string | null
}

export async function addItem(id: string, input: ItemInput) {
  const year = await getYear(id)
  const [last] = await db.select({ position: max(calendarYearItems.position) }).from(calendarYearItems).where(eq(calendarYearItems.calendarYearId, id))
  const [row] = await db
    .insert(calendarYearItems)
    .values({ ...input, forHolidayDate: input.type === 'WORKING' ? input.forHolidayDate : null, calendarYearId: id, confirmed: true, position: (last?.position ?? -1) + 1 })
    .returning()
  await markEdited(year)
  return row
}

async function getItem(id: string, itemId: string) {
  const [item] = await db.select().from(calendarYearItems).where(and(eq(calendarYearItems.id, itemId), eq(calendarYearItems.calendarYearId, id)))
  if (!item) throw notFound('Calendar date')
  return item
}

/** Saving an item means the admin has checked it: it becomes confirmed and nothing stays uncertain. */
export async function updateItem(id: string, itemId: string, input: ItemInput) {
  const year = await getYear(id)
  const before = await getItem(id, itemId)
  const [row] = await db
    .update(calendarYearItems)
    .set({ ...input, forHolidayDate: input.type === 'WORKING' ? input.forHolidayDate : null, confirmed: true, uncertainFields: [], updatedAt: new Date() })
    .where(eq(calendarYearItems.id, itemId))
    .returning()
  await markEdited(year)
  return { before, after: row }
}

export async function confirmItem(id: string, itemId: string) {
  const year = await getYear(id)
  const item = await getItem(id, itemId)
  if (!item.date) throw badRequest('Enter the date before confirming this row.')
  const [row] = await db.update(calendarYearItems).set({ confirmed: true, updatedAt: new Date() }).where(eq(calendarYearItems.id, itemId)).returning()
  await markEdited(year)
  return row
}

export async function deleteItem(id: string, itemId: string) {
  const year = await getYear(id)
  const item = await getItem(id, itemId)
  await db.delete(calendarYearItems).where(eq(calendarYearItems.id, itemId))
  await markEdited(year)
  return item
}

// ---------------------------------------------------------------- approval

export async function approveYear(id: string, userId: string) {
  const year = await getYear(id)
  const items = await yearItems(id)
  const issues = await reviewIssues(year, items)
  if (blocksApproval(issues)) {
    throw conflict(`The ${year.year} calendar still has ${issues.filter((i) => i.severity !== 'INFO').length} item(s) to fix or confirm.`)
  }
  const before = await liveEntries(year)

  await db.transaction(async (tx) => {
    await tx.delete(plantClosures).where(and(gte(plantClosures.date, `${year.year}-01-01`), lte(plantClosures.date, `${year.year}-12-31`)))
    if (items.length) {
      await tx.insert(plantClosures).values(
        items.map((item) => ({ date: item.date!, type: item.type, reason: item.name, calendarYearId: id, createdById: userId, updatedById: userId }))
      )
    }
    await tx
      .update(calendarYears)
      .set({ status: 'APPROVED', pendingChanges: false, approvedById: userId, approvedAt: new Date(), updatedAt: new Date() })
      .where(eq(calendarYears.id, id))
  })

  // Today onwards follows the approved dates: generated checks on dates that are now closed go.
  invalidateCheckGeneration()
  const now = today()
  const changed = [...new Set([...before.map((e) => e.date), ...items.map((i) => i.date!)])].filter((d) => d >= now)
  const soon = dateKey(addDays(startOfDay(new Date()), 10))
  const removedChecks = await removeChecksIfClosed(changed.filter((d) => d <= soon))
  return { before, items, removedChecks }
}

/**
 * Dates from 2027 that were entered directly in the Plant Calendar before annual calendars
 * existed become an approved calendar year, so every 2027+ date is managed in one place.
 */
export async function adoptExistingFutureEntries() {
  const loose = await db
    .select()
    .from(plantClosures)
    .where(and(gte(plantClosures.date, CALENDAR_V2_START), isNull(plantClosures.calendarYearId)))
  if (loose.length === 0) return 0
  const byYear = new Map<number, typeof loose>()
  for (const e of loose) byYear.set(Number(e.date.slice(0, 4)), [...(byYear.get(Number(e.date.slice(0, 4))) ?? []), e])
  for (const [yearNumber, entries] of byYear) {
    await db.transaction(async (tx) => {
      let [year] = await tx.select().from(calendarYears).where(eq(calendarYears.year, yearNumber))
      if (!year) {
        ;[year] = await tx
          .insert(calendarYears)
          .values({ year: yearNumber, status: 'APPROVED', approvedAt: new Date(), extractionMethod: 'MANUAL', extractionNote: 'Dates entered in the Plant Calendar before annual calendars were introduced.' })
          .returning()
      }
      const [last] = await tx.select({ position: max(calendarYearItems.position) }).from(calendarYearItems).where(eq(calendarYearItems.calendarYearId, year.id))
      await tx.insert(calendarYearItems).values(
        entries.map((e, i) => ({ calendarYearId: year.id, type: e.type, date: e.date, name: e.reason, confirmed: true, position: (last?.position ?? -1) + 1 + i }))
      )
      for (const e of entries) await tx.update(plantClosures).set({ calendarYearId: year.id }).where(eq(plantClosures.id, e.id))
    })
  }
  return loose.length
}
