import { and, asc, eq, gte, isNull, lte, ne, or } from 'drizzle-orm'
import { db } from '../db/client'
import { plantWeeklyRules, settings } from '../db/schema'
import { conflict, badRequest } from '../lib/http'
import { addDays, dateKey, parseDateKey, startOfDay, weekdayOf } from '../lib/time'

/**
 * Recurring weekly closures, from 2027 onwards (see calendarRules for how dates are decided).
 *
 * A rule is a weekday with an inclusive date range (effectiveTo empty = open-ended). Changes are
 * forward-only: a rule can only start or end on today or a later date, never before 2027, so
 * earlier dates keep the rules that applied to them.
 */

/** First date decided by the annual calendar system. Dates before it keep the original setup. */
export const CALENDAR_V2_START = '2027-01-01'
export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export type WeeklyRule = typeof plantWeeklyRules.$inferSelect

export async function listWeeklyRules() {
  return db.select().from(plantWeeklyRules).orderBy(asc(plantWeeklyRules.weekday), asc(plantWeeklyRules.effectiveFrom))
}

/** Rules that apply somewhere between two dates (YYYY-MM-DD, inclusive). */
export async function rulesBetween(from: string, to: string) {
  return db
    .select()
    .from(plantWeeklyRules)
    .where(and(lte(plantWeeklyRules.effectiveFrom, to), or(isNull(plantWeeklyRules.effectiveTo), gte(plantWeeklyRules.effectiveTo, from))))
}

/** Whether a weekly rule closes the plant on this date. */
export function ruleCloses(rules: WeeklyRule[], key: string) {
  if (key < CALENDAR_V2_START) return false
  const weekday = weekdayOf(parseDateKey(key))
  return rules.some((r) => r.weekday === weekday && r.effectiveFrom <= key && (!r.effectiveTo || key <= r.effectiveTo))
}

/** The earliest date a rule change may take effect: today, and never before 2027. */
export const earliestChangeDate = () => {
  const today = dateKey(startOfDay(new Date()))
  return today > CALENDAR_V2_START ? today : CALENDAR_V2_START
}

const rangesOverlap = (aFrom: string, aTo: string | null, bFrom: string, bTo: string | null) =>
  aFrom <= (bTo ?? '9999-12-31') && bFrom <= (aTo ?? '9999-12-31')

async function assertNoOverlap(weekday: number, from: string, to: string | null, exceptId?: string) {
  const same = await db
    .select()
    .from(plantWeeklyRules)
    .where(exceptId ? and(eq(plantWeeklyRules.weekday, weekday), ne(plantWeeklyRules.id, exceptId)) : eq(plantWeeklyRules.weekday, weekday))
  const clash = same.find((r) => rangesOverlap(from, to, r.effectiveFrom, r.effectiveTo))
  if (clash) {
    throw conflict(
      `This overlaps the existing ${WEEKDAY_NAMES[weekday]} rule from ${clash.effectiveFrom}${clash.effectiveTo ? ` to ${clash.effectiveTo}` : ' (no end date)'}. End that rule first or choose other dates.`
    )
  }
}

export async function createWeeklyRule(input: { weekday: number; effectiveFrom: string; effectiveTo: string | null; note: string | null }, userId: string) {
  const earliest = earliestChangeDate()
  if (input.effectiveFrom < earliest) throw badRequest(`A new rule can start on ${earliest} at the earliest. Earlier dates keep the rules that applied then.`)
  if (input.effectiveTo && input.effectiveTo < input.effectiveFrom) throw badRequest('The end date must be on or after the start date')
  await assertNoOverlap(input.weekday, input.effectiveFrom, input.effectiveTo)
  const [row] = await db.insert(plantWeeklyRules).values({ ...input, createdById: userId, updatedById: userId }).returning()
  return row
}

/**
 * Edits a rule. A rule that has already started can only get a new end date (not before
 * yesterday, so today onwards is affected) and a new note; a rule that has not started yet can
 * be changed freely within the forward-only limits.
 */
export async function updateWeeklyRule(
  id: string,
  input: { weekday?: number; effectiveFrom?: string; effectiveTo?: string | null; note?: string | null },
  userId: string
) {
  const [rule] = await db.select().from(plantWeeklyRules).where(eq(plantWeeklyRules.id, id))
  if (!rule) return null
  const earliest = earliestChangeDate()
  const started = rule.effectiveFrom < earliest

  const next = {
    weekday: input.weekday ?? rule.weekday,
    effectiveFrom: input.effectiveFrom ?? rule.effectiveFrom,
    effectiveTo: input.effectiveTo === undefined ? rule.effectiveTo : input.effectiveTo,
    note: input.note === undefined ? rule.note : input.note
  }
  if (started && (next.weekday !== rule.weekday || next.effectiveFrom !== rule.effectiveFrom)) {
    throw badRequest('This rule has already applied to past dates, so its weekday and start date cannot change. End it and add a new rule instead.')
  }
  if (!started && next.effectiveFrom < earliest) throw badRequest(`The rule can start on ${earliest} at the earliest`)
  // Ending a rule: the last closed day may be yesterday at the earliest, so no past date changes.
  const lastAllowedEnd = dateKey(addDays(parseDateKey(earliest), -1))
  const endChanged = next.effectiveTo !== rule.effectiveTo
  if (endChanged) {
    const oldEnd = rule.effectiveTo
    if (oldEnd && oldEnd < lastAllowedEnd) throw badRequest('This rule has already ended; its end date cannot change.')
    if (next.effectiveTo && next.effectiveTo < lastAllowedEnd) throw badRequest(`The rule can end on ${lastAllowedEnd} at the earliest`)
  }
  if (next.effectiveTo && next.effectiveTo < next.effectiveFrom) throw badRequest('The end date must be on or after the start date')
  await assertNoOverlap(next.weekday, next.effectiveFrom, next.effectiveTo, id)

  const [row] = await db
    .update(plantWeeklyRules)
    .set({ ...next, updatedById: userId, updatedAt: new Date() })
    .where(eq(plantWeeklyRules.id, id))
    .returning()
  return { before: rule, after: row }
}

/** Only a rule that has not started yet can be deleted; a started rule is ended instead. */
export async function deleteWeeklyRule(id: string) {
  const [rule] = await db.select().from(plantWeeklyRules).where(eq(plantWeeklyRules.id, id))
  if (!rule) return null
  if (rule.effectiveFrom < earliestChangeDate()) {
    throw badRequest('This rule has already applied to past dates. Set an end date to stop it instead of deleting it.')
  }
  await db.delete(plantWeeklyRules).where(eq(plantWeeklyRules.id, id))
  return rule
}

const SEED_KEY = 'plant_weekly_rules_seeded'

/**
 * The plant is closed every Thursday: that becomes the first rule, from 2027-01-01, open-ended.
 * Seeded once per database, so an admin who later ends or deletes it is not overridden.
 */
export async function ensureDefaultWeeklyRules() {
  const [done] = await db.select().from(settings).where(eq(settings.key, SEED_KEY))
  if (done) return false
  await db.transaction(async (tx) => {
    const existing = await tx.select({ id: plantWeeklyRules.id }).from(plantWeeklyRules).limit(1)
    if (existing.length === 0) {
      await tx.insert(plantWeeklyRules).values({ weekday: 4, effectiveFrom: CALENDAR_V2_START, note: 'Plant closed every Thursday' })
    }
    await tx.insert(settings).values({ key: SEED_KEY, value: { seededAt: new Date().toISOString() } })
  })
  return true
}
