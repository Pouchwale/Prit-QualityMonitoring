/*
 * Display formats used everywhere in the app (worker and staff screens), the same as the web
 * admin panel: dates as DD/MM/YYYY and times as 12-hour with AM/PM (e.g. 18/09/2026, 2:30 PM).
 * Only what is shown changes: the API still sends and receives ISO timestamps, YYYY-MM-DD date
 * keys and HH:MM shift times. Built by hand so the phone's region setting cannot change it.
 */
const pad2 = (n: number) => String(n).padStart(2, '0')
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const toDate = (value: string | Date): Date => {
  if (value instanceof Date) return value
  // A bare date key is a local calendar day, not midnight UTC.
  const key = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  return key ? new Date(Number(key[1]), Number(key[2]) - 1, Number(key[3])) : new Date(value)
}
const valid = (d: Date) => !Number.isNaN(d.getTime())

/** "14:30" → "2:30 PM"; with seconds "2:30:05 PM". Anything that is not a time is returned as is. */
export function formatClock(hhmm: string | null | undefined, withSeconds = false): string {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(hhmm ?? '')
  if (!match) return hhmm || '—'
  const hour = Number(match[1]) % 24
  return `${hour % 12 || 12}:${match[2]}${withSeconds ? `:${match[3] ?? '00'}` : ''} ${hour < 12 ? 'AM' : 'PM'}`
}

/** "08:00", "16:00" → "8:00 AM – 4:00 PM". */
export const formatClockRange = (start: string | null | undefined, end: string | null | undefined) => `${formatClock(start)} – ${formatClock(end)}`

/** 18/09/2026 */
export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '—'
  const d = toDate(value)
  return valid(d) ? `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}` : '—'
}

/** 2:30 PM */
export function formatTime(value: string | Date | null | undefined): string {
  if (!value) return '—'
  const d = toDate(value)
  return valid(d) ? formatClock(`${pad2(d.getHours())}:${pad2(d.getMinutes())}`) : '—'
}

/** 18/09/2026, 2:30 PM */
export const formatDateTime = (value: string | Date | null | undefined) => (value ? `${formatDate(value)}, ${formatTime(value)}` : '—')

/** Friday, 18/09/2026 */
export const formatLongDate = (value: string | Date | null | undefined) =>
  value && valid(toDate(value)) ? `${WEEKDAYS[toDate(value).getDay()]}, ${formatDate(value)}` : '—'

/** Fri, 18/09/2026 */
export const formatShortWeekdayDate = (value: string | Date | null | undefined) =>
  value && valid(toDate(value)) ? `${WEEKDAYS_SHORT[toDate(value).getDay()]}, ${formatDate(value)}` : '—'
