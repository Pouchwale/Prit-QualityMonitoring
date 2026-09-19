import 'dotenv/config'

/**
 * Time helpers. Every timestamp is stored as an instant (`timestamptz`); shift times, date keys
 * and "today" are worked out in the **plant timezone**, not in the server's timezone, so a
 * server running in UTC (or a cloud host) still schedules 08:00 for the plant's 08:00.
 *
 * The plant timezone is `PLANT_TIMEZONE` (IANA name), default `Asia/Kolkata`. On a server whose
 * own clock is already in that zone the results are exactly the same as before.
 */

export const MINUTE = 60_000

function resolveZone(name: string | undefined): string {
  const zone = (name ?? '').trim() || 'Asia/Kolkata'
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return zone
  } catch {
    console.error(`Unknown PLANT_TIMEZONE "${zone}"; falling back to Asia/Kolkata.`)
    return 'Asia/Kolkata'
  }
}

export const PLANT_TIMEZONE = resolveZone(process.env.PLANT_TIMEZONE)

const formatter = new Intl.DateTimeFormat('en-US', {
  timeZone: PLANT_TIMEZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit'
})

export interface LocalParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

/** The plant-local calendar parts of an instant. */
export function localParts(date: Date): LocalParts {
  const parts = formatter.formatToParts(date)
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? '0')
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second')
  }
}

/** Offset of the plant timezone at an instant, in milliseconds (UTC + offset = local time). */
function offsetAt(time: number): number {
  const p = localParts(new Date(time))
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return asUtc - Math.floor(time / 1000) * 1000
}

/** The instant of a plant-local wall-clock time. Handles zones with a DST shift. */
function fromLocal(year: number, month: number, day: number, hour = 0, minute = 0, second = 0, ms = 0): Date {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second, ms)
  const guess = wall - offsetAt(wall)
  const offset = offsetAt(guess)
  return new Date(wall - offset)
}

export function parseHHMM(value: string): { h: number; m: number } {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value)
  if (!match) throw new Error(`Invalid time "${value}"`)
  return { h: Number(match[1]), m: Number(match[2]) }
}

export const HHMM_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/

/** Midnight of the plant-local day an instant falls on. */
export function startOfDay(date: Date): Date {
  const p = localParts(date)
  return fromLocal(p.year, p.month, p.day)
}

/** The same plant-local wall-clock time, `days` calendar days later. */
export function addDays(date: Date, days: number): Date {
  const p = localParts(date)
  const shifted = new Date(Date.UTC(p.year, p.month - 1, p.day + days))
  return fromLocal(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    shifted.getUTCDate(),
    p.hour,
    p.minute,
    p.second,
    date.getTime() % 1000
  )
}

/** HH:MM (plant-local) on the plant-local day of `day`. */
export function atTime(day: Date, hhmm: string): Date {
  const { h, m } = parseHHMM(hhmm)
  const p = localParts(day)
  return fromLocal(p.year, p.month, p.day, h, m)
}

/** The plant-local date of an instant, YYYY-MM-DD. */
export function dateKey(date: Date): string {
  const p = localParts(date)
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
}

/** Parses YYYY-MM-DD as midnight of that plant-local date. */
export function parseDateKey(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) throw new Error(`Invalid date "${value}"`)
  return fromLocal(Number(match[1]), Number(match[2]), Number(match[3]))
}

/** Plant-local weekday, 0 = Sunday … 6 = Saturday. */
export function weekdayOf(date: Date): number {
  const p = localParts(date)
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()
}

/** Minutes since plant-local midnight, used to find the shift running at a moment. */
export function minutesOfDay(date: Date): number {
  const p = localParts(date)
  return p.hour * 60 + p.minute
}

/** Plant-local date, DD/MM/YYYY. */
export function formatLocalDate(date: Date): string {
  const p = localParts(date)
  return `${String(p.day).padStart(2, '0')}/${String(p.month).padStart(2, '0')}/${p.year}`
}

/** Plant-local time for display, 12-hour with AM/PM, e.g. "2:30 PM". */
export function formatLocalTime(date: Date): string {
  const p = localParts(date)
  return formatClock(`${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`)
}

/** A stored "HH:MM" wall-clock time (e.g. a shift start) for display: "14:30" → "2:30 PM". */
export function formatClock(hhmm: string): string {
  const match = /^(\d{1,2}):(\d{2})/.exec(hhmm)
  if (!match) return hhmm
  const hour = Number(match[1]) % 24
  return `${hour % 12 || 12}:${match[2]} ${hour < 12 ? 'AM' : 'PM'}`
}

/** A YYYY-MM-DD date key for display: "2026-09-18" → "18/09/2026". */
export function formatDateKey(key: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(key)
  return match ? `${match[3]}/${match[2]}/${match[1]}` : key
}
