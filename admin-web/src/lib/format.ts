import type { ParameterType, CheckResult, QualityCheckStatus } from '../types'

/*
 * Display formats used everywhere in the panel: dates as DD/MM/YYYY and times as 12-hour with
 * AM/PM (e.g. 18/09/2026, 2:30 PM). Only what is shown changes: the API still sends and receives
 * ISO timestamps, YYYY-MM-DD date keys and HH:MM shift times.
 */
const pad2 = (n: number) => String(n).padStart(2, '0')
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const toDate = (value: string | Date) => {
  if (value instanceof Date) return value
  // A bare date key is a local calendar day, not midnight UTC.
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? keyToLocalDate(value) : new Date(value)
}
const keyToLocalDate = (key: string) => {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d)
}

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
  const d = toDate(iso)
  return Number.isNaN(d.getTime()) ? '—' : `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`
}

/** 2:30 PM */
export const formatTime = (iso: string | Date | null | undefined, withSeconds = false) => {
  if (!iso) return '—'
  const d = toDate(iso)
  return Number.isNaN(d.getTime()) ? '—' : formatClock(`${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`, withSeconds)
}

/** 18/09/2026, 2:30 PM */
export const formatDateTime = (iso: string | Date | null | undefined) => (iso ? `${formatDate(iso)}, ${formatTime(iso)}` : '—')

/** A YYYY-MM-DD key for display: 18/09/2026. */
export const formatDateKey = (key: string | null | undefined) => (key ? formatDate(key) : '—')

/** Friday, 18/09/2026 */
export const formatLongDate = (iso: string | Date | null | undefined) => (iso ? `${WEEKDAYS[toDate(iso).getDay()]}, ${formatDate(iso)}` : '—')

/** "08:00–16:00" shift or window times as "8:00 AM – 4:00 PM". */
export const formatClockRange = (start: string | null | undefined, end: string | null | undefined) =>
  `${formatClock(start)} – ${formatClock(end)}`

/** Local date as YYYY-MM-DD, the format the API expects. */
export function dateKey(date = new Date()) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function addDaysKey(key: string, days: number) {
  const [y, m, d] = key.split('-').map(Number)
  return dateKey(new Date(y, m - 1, d + days))
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

/** Downloads rows as a CSV file. */
export function downloadCsv(filename: string, headers: string[], rows: (string | number | null | undefined)[][]) {
  const escape = (v: string | number | null | undefined) => {
    const s = v === null || v === undefined ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const csv = [headers, ...rows].map((r) => r.map(escape).join(',')).join('\n')
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
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
