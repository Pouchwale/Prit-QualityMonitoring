import type { ParameterType, CheckResult, QualityCheckStatus } from '../types'

/*
 * Display formats used everywhere in the panel: dates as DD/MM/YYYY and times as 12-hour with
 * AM/PM (e.g. 18/09/2026, 2:30 PM). Only what is shown changes: the API still sends and receives
 * ISO timestamps, YYYY-MM-DD date keys and HH:MM shift times.
 *
 * Every date and time is shown in the plant's time zone, the one the backend schedules in, not the
 * browser's: someone opening the panel from another zone still sees the plant's day and clock.
 */
const pad2 = (n: number) => String(n).padStart(2, '0')
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** The plant's time zone (IANA name). Set VITE_PLANT_TIMEZONE to override; must match the backend. */
export const PLANT_TIMEZONE = (import.meta.env.VITE_PLANT_TIMEZONE as string | undefined) || 'Asia/Kolkata'

const plantFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: PLANT_TIMEZONE,
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
  hourCycle: 'h23'
})

/** The calendar date and wall-clock time of an instant at the plant. */
function plantParts(date: Date) {
  const parts: Record<string, number> = {}
  for (const p of plantFormat.formatToParts(date)) if (p.type !== 'literal') parts[p.type] = Number(p.value)
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour % 24, minute: parts.minute, second: parts.second }
}

const isKey = (value: string | Date): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)

/** Calendar date of a value: a bare date key is that day as it is; an instant is the plant's day. */
function dayOf(value: string | Date) {
  if (isKey(value)) {
    const [year, month, day] = value.split('-').map(Number)
    return { year, month, day }
  }
  const d = value instanceof Date ? value : new Date(value)
  return Number.isNaN(d.getTime()) ? null : plantParts(d)
}

/** Day of the week (0 = Sunday) of a calendar date, independent of any time zone. */
const weekdayOf = (year: number, month: number, day: number) => new Date(Date.UTC(year, month - 1, day)).getUTCDay()

/** "14:30" → "2:30 PM"; seconds are added when asked, e.g. "2:30:05 PM". */
export function formatClock(hhmm: string | null | undefined, withSeconds = false): string {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(hhmm ?? '')
  if (!match) return hhmm || '—'
  const hour = Number(match[1]) % 24
  return `${hour % 12 || 12}:${match[2]}${withSeconds ? `:${match[3] ?? '00'}` : ''} ${hour < 12 ? 'AM' : 'PM'}`
}

/** 18/09/2026 */
export const formatDate = (iso: string | Date | null | undefined) => {
  if (!iso) return '—'
  const d = dayOf(iso)
  return d ? `${pad2(d.day)}/${pad2(d.month)}/${d.year}` : '—'
}

/** 2:30 PM, at the plant. A bare date key is that day's midnight. */
export const formatTime = (iso: string | Date | null | undefined, withSeconds = false) => {
  if (!iso) return '—'
  if (isKey(iso)) return formatClock('00:00:00', withSeconds)
  const d = iso instanceof Date ? iso : new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const t = plantParts(d)
  return formatClock(`${pad2(t.hour)}:${pad2(t.minute)}:${pad2(t.second)}`, withSeconds)
}

/** 18/09/2026, 2:30 PM */
export const formatDateTime = (iso: string | Date | null | undefined) => (iso ? `${formatDate(iso)}, ${formatTime(iso)}` : '—')

/** A YYYY-MM-DD key for display: 18/09/2026. */
export const formatDateKey = (key: string | null | undefined) => (key ? formatDate(key) : '—')

/** Friday, 18/09/2026 */
export const formatLongDate = (iso: string | Date | null | undefined) => {
  const d = iso ? dayOf(iso) : null
  return d ? `${WEEKDAYS[weekdayOf(d.year, d.month, d.day)]}, ${formatDate(iso)}` : '—'
}

/** "08:00–16:00" shift or window times as "8:00 AM – 4:00 PM". */
export const formatClockRange = (start: string | null | undefined, end: string | null | undefined) =>
  `${formatClock(start)} – ${formatClock(end)}`

/** The plant's date of an instant (default: now) as YYYY-MM-DD, the format the API expects. */
export function dateKey(date = new Date()) {
  const d = plantParts(date)
  return `${d.year}-${pad2(d.month)}-${pad2(d.day)}`
}

/**
 * A Date built from calendar parts in the browser (new Date(y, m, d)) as YYYY-MM-DD, taken as it
 * is. For calendar grids; use dateKey() for real moments in time.
 */
export const calendarKey = (date: Date) => `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`

/** A date key moved by whole days (calendar arithmetic, no time zone involved). */
export function addDaysKey(key: string, days: number) {
  const [y, m, d] = key.split('-').map(Number)
  const next = new Date(Date.UTC(y, m - 1, d + days))
  return `${next.getUTCFullYear()}-${pad2(next.getUTCMonth() + 1)}-${pad2(next.getUTCDate())}`
}

/** An instant as the plant's wall-clock time, "YYYY-MM-DDTHH:mm", for a datetime-local input. */
export function toPlantInput(date: Date) {
  const d = plantParts(date)
  return `${d.year}-${pad2(d.month)}-${pad2(d.day)}T${pad2(d.hour)}:${pad2(d.minute)}`
}

/**
 * The instant a datetime-local value ("YYYY-MM-DDTHH:mm[:ss]") means when read as the plant's
 * wall-clock time. The value is first taken as UTC, then moved back by the plant's offset from UTC
 * at that moment; the second pass settles a zone that changes its clocks in between.
 */
export function fromPlantInput(value: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(value)
  if (!m) return new Date(NaN)
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0))
  // The plant's offset from UTC at instant t (whole seconds), e.g. +5:30 for Asia/Kolkata.
  const offsetAt = (t: number) => {
    const p = plantParts(new Date(t))
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000
  }
  let t = wall - offsetAt(wall)
  t = wall - offsetAt(t)
  return new Date(t)
}

export const PARAMETER_TYPE_LABEL: Record<ParameterType, string> = {
  NUMBER: 'Number',
  TEXT: 'Text',
  DROPDOWN: 'Dropdown',
  YES_NO: 'Yes / No',
  PASS_FAIL: 'Pass / Fail',
  PHOTO: 'Photo'
}

export const RESULT_LABEL: Record<CheckResult, string> = {
  COMPLETED: 'Completed',
  MISSED: 'Missed',
  EXCEPTION: 'Exception'
}

export const RESULT_OPTIONS = (Object.keys(RESULT_LABEL) as CheckResult[]).map((r) => ({ value: r, label: RESULT_LABEL[r] }))

/** The only status values shown: Completed, Missed, Exception. */
export const CHECK_STATUSES: CheckResult[] = ['COMPLETED', 'MISSED', 'EXCEPTION']

/** Status label for display and exports; empty for a check that is not finished yet. */
export const checkStatusLabel = (status: QualityCheckStatus) => RESULT_LABEL[status as CheckResult] ?? ''

export function frequencyLabel(minutes: number) {
  if (minutes % 1440 === 0) return minutes === 1440 ? 'Daily' : `Every ${minutes / 1440} days`
  if (minutes % 60 === 0) return minutes === 60 ? 'Every hour' : `Every ${minutes / 60} hours`
  return `Every ${minutes} min`
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * Downloads rows as a CSV file. Text that a spreadsheet would run as a formula (starting with =,
 * +, -, @, tab or carriage return) gets a leading apostrophe so it shows as plain text; plain
 * numbers such as -5 are left alone. A byte-order mark makes Excel read the file as UTF-8.
 */
export function downloadCsv(filename: string, headers: string[], rows: (string | number | null | undefined)[][]) {
  const escape = (v: string | number | null | undefined) => {
    let s = v === null || v === undefined ? '' : String(v)
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s) && !/^[+-]?\d+(\.\d+)?$/.test(s)) s = `'${s}`
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const csv = [headers, ...rows].map((r) => r.map(escape).join(',')).join('\r\n')
  const url = URL.createObjectURL(new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

/** What the check Result means. Parameter readings (within/outside limits) never change it. */
export const RESULT_HINT =
  'Completed: photo/video and form submitted. Missed: not completed or submitted in time. Exception: check could not be done, exception details and photo/video submitted. Readings outside limits do not change the Result.'
