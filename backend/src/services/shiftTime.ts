import { eq } from 'drizzle-orm'
import { db } from '../db/client'
import { shifts } from '../db/schema'
import { minutesOfDay, parseHHMM } from '../lib/time'

/**
 * Which shift a moment falls in. Shifts only say *when* work happens; who does a check is
 * decided by the job running on the machine (services/jobMonitoring.ts), not by the shift.
 */

/** Whether HH:MM falls inside a shift (overnight shifts wrap past midnight). */
function inShift(minutes: number, start: string, end: string) {
  const s = parseHHMM(start)
  const e = parseHHMM(end)
  const from = s.h * 60 + s.m
  const to = e.h * 60 + e.m
  return from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to
}

/** The active shift running at a moment, used for one-off checks. */
export async function shiftAt(moment: Date) {
  const rows = await db.select().from(shifts).where(eq(shifts.isActive, true))
  return shiftFor(rows, moment)
}

/** The shift of a list running at a moment, without a query (e.g. inside a transaction). */
export function shiftFor<T extends { startTime: string; endTime: string }>(list: T[], moment: Date): T | null {
  const minutes = minutesOfDay(moment)
  return list.find((s) => inShift(minutes, s.startTime, s.endTime)) ?? null
}
