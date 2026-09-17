import type { ParameterType, CheckResult, QualityCheckStatus } from '../types'

export const formatDateTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString([], { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'

export const formatTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'

export const formatDate = (iso: string | Date | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' }) : '—'

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
  PASS_FAIL: 'Pass / Fail'
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
