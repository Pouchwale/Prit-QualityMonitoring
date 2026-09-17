/** Time helpers. All schedule times are interpreted in the server's local timezone (the plant PC). */

export const MINUTE = 60_000

export function parseHHMM(value: string): { h: number; m: number } {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value)
  if (!match) throw new Error(`Invalid time "${value}"`)
  return { h: Number(match[1]), m: Number(match[2]) }
}

export const HHMM_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/

export function startOfDay(date: Date): Date {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  return d
}

export function addDays(date: Date, days: number): Date {
  const d = new Date(date)
  d.setDate(d.getDate() + days)
  return d
}

export function atTime(day: Date, hhmm: string): Date {
  const { h, m } = parseHHMM(hhmm)
  const d = startOfDay(day)
  d.setHours(h, m, 0, 0)
  return d
}

export function dateKey(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** Parses YYYY-MM-DD as a local date. */
export function parseDateKey(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) throw new Error(`Invalid date "${value}"`)
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
}
