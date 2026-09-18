import { and, asc, eq, gte, inArray, isNull, lt, lte, max, min, or } from 'drizzle-orm'
import { db } from '../db/client'
import { plantClosures, qualityChecks, settings } from '../db/schema'
import { addDays, dateKey, parseDateKey, startOfDay, weekdayOf } from '../lib/time'
import { CALENDAR_V2_START, WEEKDAY_NAMES, ruleCloses, rulesBetween } from './weeklyRules'

export { WEEKDAY_NAMES }

/**
 * Plant Calendar: whether the plant is open on a date. The most specific setting wins:
 *   1. a calendar entry for that date: Adjustment Working Day (WORKING) opens the plant;
 *      Plant Closed, Holiday or Shutdown closes it;
 *   2. otherwise the weekly closure applies:
 *        - dates before 2027: the original weekly off setting (Thursday), kept exactly as it was;
 *        - from 2027-01-01: the dated weekly rules (services/weeklyRules.ts);
 *   3. every other day is open.
 * From 2027 the calendar entries come only from approved calendar years (calendarYears.ts).
 * So a Thursday marked as an Adjustment Working Day runs normally, and all other Thursdays are
 * closed. On an open day checks are generated, alerts are sent and Missed works as usual.
 *
 * On a closed date, judged by the local date of each check's scheduled time:
 *  - no scheduled checks are generated (checkGenerator.ensureChecksForDay),
 *  - checks that were already generated and not submitted are removed, so none is ever marked
 *    Missed and no due alert is sent (removeChecksOnClosedDays, run before every status refresh),
 *  - the due-alert sender skips the date as well, in case a check slips through.
 * Submitted checks (Completed / Exception) are real records and are never removed.
 * Removing a closure lets the day's checks be generated again from the schedules.
 */

export type ClosureType = (typeof plantClosures.type.enumValues)[number]

export const CLOSURE_LABEL: Record<ClosureType, string> = {
  CLOSED: 'Plant Closed',
  HOLIDAY: 'Holiday',
  SHUTDOWN: 'Shutdown',
  WORKING: 'Adjustment Working Day'
}

/** Whether an entry type closes the plant. */
export const isClosedType = (type: ClosureType) => type !== 'WORKING'

/** Checks are generated up to a week ahead; the full purge looks a little further. */
const PURGE_AHEAD_DAYS = 9

// ---- Weekly off days ----

const WEEKLY_OFF_KEY = 'plant_weekly_off'
/** 0 = Sunday … 6 = Saturday. The plant is normally closed on Thursdays. */
export const DEFAULT_WEEKLY_OFF_DAYS = [4]

/** The weekdays the plant is normally closed. */
export async function weeklyOffDays(): Promise<number[]> {
  const [row] = await db.select().from(settings).where(eq(settings.key, WEEKLY_OFF_KEY))
  const days = (row?.value as { days?: unknown } | undefined)?.days
  if (!Array.isArray(days)) return DEFAULT_WEEKLY_OFF_DAYS
  return days.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6).sort()
}

export async function setWeeklyOffDays(days: number[]) {
  const value = { days: [...new Set(days)].sort() }
  await db
    .insert(settings)
    .values({ key: WEEKLY_OFF_KEY, value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } })
  return value.days
}

/** Stores the default weekly off (Thursday) the first time, so it shows and can be changed. */
export async function ensureWeeklyOffSetting() {
  const [row] = await db.select().from(settings).where(eq(settings.key, WEEKLY_OFF_KEY))
  if (!row) await setWeeklyOffDays(DEFAULT_WEEKLY_OFF_DAYS)
}

const weeklyOffLabel = (day: Date) => `Weekly Off (${WEEKDAY_NAMES[weekdayOf(day)]})`

// ---- Open or closed ----

export interface DayState {
  date: string
  closed: boolean
  /** ENTRY: a calendar entry decides; WEEKLY: the weekly closure; OPEN: a normal working day. */
  source: 'ENTRY' | 'WEEKLY' | 'OPEN'
  /** The weekly closure falls on this date (an entry may still override it). */
  weeklyClosed: boolean
  entry: { id: string; type: ClosureType; reason: string | null; calendarYearId: string | null } | null
  label: string | null
}

/** Whether the plant is open, and why, for every date between two dates (inclusive). */
export async function dayStates(from: Date, to: Date): Promise<DayState[]> {
  const fromKey = dateKey(from)
  const toKey = dateKey(to)
  const [entries, offDays, rules] = await Promise.all([
    db
      .select({ id: plantClosures.id, date: plantClosures.date, type: plantClosures.type, reason: plantClosures.reason, calendarYearId: plantClosures.calendarYearId })
      .from(plantClosures)
      .where(and(gte(plantClosures.date, fromKey), lte(plantClosures.date, toKey))),
    fromKey < CALENDAR_V2_START ? weeklyOffDays() : Promise.resolve([] as number[]),
    toKey >= CALENDAR_V2_START ? rulesBetween(fromKey, toKey) : Promise.resolve([])
  ])
  const byDate = new Map(entries.map((e) => [e.date, e]))
  const states: DayState[] = []
  for (let d = startOfDay(from); d <= to; d = addDays(d, 1)) {
    const key = dateKey(d)
    const entry = byDate.get(key)
    const weekly = key < CALENDAR_V2_START ? offDays.includes(weekdayOf(d)) : ruleCloses(rules, key)
    if (entry) {
      const { date: _date, ...rest } = entry
      states.push({ date: key, closed: isClosedType(entry.type), source: 'ENTRY', weeklyClosed: weekly, entry: rest, label: CLOSURE_LABEL[entry.type] })
      continue
    }
    states.push(
      weekly
        ? { date: key, closed: true, source: 'WEEKLY', weeklyClosed: true, entry: null, label: weeklyOffLabel(d) }
        : { date: key, closed: false, source: 'OPEN', weeklyClosed: false, entry: null, label: null }
    )
  }
  return states
}

/** Closed dates (YYYY-MM-DD) between two dates, inclusive, from the entries and the weekly closures. */
export async function closedDateKeys(from: Date, to: Date): Promise<Set<string>> {
  return new Set((await dayStates(from, to)).filter((s) => s.closed).map((s) => s.date))
}

/** Why the plant is closed on a date (an entry or the weekly closure), or null when it is open. */
export async function closureOn(day: Date) {
  const [state] = await dayStates(day, day)
  if (!state?.closed) return null
  if (state.entry) {
    return { id: state.entry.id, date: state.date, type: state.entry.type, reason: state.entry.reason, label: state.label!, weeklyOff: false }
  }
  return { id: null, date: state.date, type: 'CLOSED' as const, reason: null, label: state.label!, weeklyOff: true }
}

/** Removes unsubmitted checks on whichever of these dates are closed now. */
export async function removeChecksIfClosed(keys: string[]) {
  const unique = [...new Set(keys)].sort()
  if (unique.length === 0) return 0
  const closed = await closedDateKeys(parseDateKey(unique[0]), parseDateKey(unique[unique.length - 1]))
  return removeChecksOnClosedDays(unique.filter((k) => closed.has(k)))
}

/** Checks on these dates that were never submitted: open ones and ones already marked Missed. */
function unsubmittedOn(keys: string[]) {
  const days = keys.map((key) => parseDateKey(key))
  return and(
    or(...days.map((day) => and(gte(qualityChecks.scheduledAt, day), lt(qualityChecks.scheduledAt, addDays(day, 1)))))!,
    isNull(qualityChecks.submittedAt),
    inArray(qualityChecks.status, ['PENDING', 'DUE', 'IN_PROGRESS', 'MISSED'])
  )
}

/** Removes the unsubmitted checks on closed dates. Returns how many were removed. */
export async function removeChecksOnClosedDays(keys: string[]) {
  if (keys.length === 0) return 0
  let removed = 0
  for (let i = 0; i < keys.length; i += 50) {
    const rows = await db.delete(qualityChecks).where(unsubmittedOn(keys.slice(i, i + 50))).returning({ id: qualityChecks.id })
    removed += rows.length
  }
  return removed
}

/**
 * Run before statuses are refreshed: nothing on a closed day may become Due or Missed. Looks at
 * the dates of the checks that are still open (and would change status next), however old.
 */
export async function purgeClosedDays() {
  const [range] = await db
    .select({ from: min(qualityChecks.scheduledAt), to: max(qualityChecks.scheduledAt) })
    .from(qualityChecks)
    .where(and(isNull(qualityChecks.submittedAt), inArray(qualityChecks.status, ['PENDING', 'DUE', 'IN_PROGRESS'])))
  if (!range?.from || !range.to) return 0
  const keys = await closedDateKeys(startOfDay(new Date(range.from)), new Date(range.to))
  return removeChecksOnClosedDays([...keys])
}

/**
 * Every closed date that still holds unsubmitted checks, back to the oldest one. Used at startup
 * and when the weekly off days change, which can close many past and future dates at once.
 */
export async function purgeAllClosedDays() {
  const [oldest] = await db
    .select({ at: min(qualityChecks.scheduledAt) })
    .from(qualityChecks)
    .where(and(isNull(qualityChecks.submittedAt), inArray(qualityChecks.status, ['PENDING', 'DUE', 'IN_PROGRESS', 'MISSED'])))
  if (!oldest?.at) return 0
  const today = startOfDay(new Date())
  const keys = await closedDateKeys(startOfDay(new Date(oldest.at)), addDays(today, PURGE_AHEAD_DAYS))
  return removeChecksOnClosedDays([...keys])
}

/** Closures in a date range, oldest first. */
export async function listClosures(from: string, to: string) {
  return db
    .select({
      id: plantClosures.id,
      date: plantClosures.date,
      type: plantClosures.type,
      reason: plantClosures.reason,
      updatedAt: plantClosures.updatedAt
    })
    .from(plantClosures)
    .where(and(gte(plantClosures.date, from), lte(plantClosures.date, to)))
    .orderBy(asc(plantClosures.date))
}
