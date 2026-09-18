import type { CheckResult, ClosureType, ParameterType, QualityCheckStatus, Role } from './types'

// Same labels and formats as the web admin panel (admin-web/src/lib/format.ts).

export const formatDateTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString([], { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'

export const formatTime = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—')

export const formatDate = (iso: string | Date | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' }) : '—'

/** YYYY-MM-DD as "14 Jan 2027". */
export const formatKey = (key: string | null | undefined) => (key ? formatDate(keyToDate(key)) : '—')

/** Local date as YYYY-MM-DD, the format the API expects. */
export function dateKey(date = new Date()) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function keyToDate(key: string) {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d)
}

export function addDaysKey(key: string, days: number) {
  const [y, m, d] = key.split('-').map(Number)
  return dateKey(new Date(y, m - 1, d + days))
}

/** "1 exception", "2 exceptions". */
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export const ROLE_LABEL: Record<Role, string> = {
  SUPER_ADMIN: 'Super Admin',
  ADMIN: 'Admin',
  MANAGER: 'Manager',
  WORKER: 'Worker'
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

export const checkStatusLabel = (status: QualityCheckStatus) => RESULT_LABEL[status as CheckResult] ?? ''

export const EXCEPTION_STATUS_LABEL: Record<string, string> = {
  UNDER_REVIEW: 'Under review',
  ACKNOWLEDGED: 'Acknowledged',
  ACTION_TAKEN: 'Action taken',
  RESOLVED: 'Resolved'
}

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

/** Rows as CSV text (same escaping as the web panel's exports). */
export function toCsv(headers: string[], rows: (string | number | null | undefined)[][]) {
  const escape = (v: string | number | null | undefined) => {
    const s = v === null || v === undefined ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return [headers, ...rows].map((r) => r.map(escape).join(',')).join('\n')
}

export type Tone = 'neutral' | 'success' | 'due' | 'missed' | 'exception' | 'accent' | 'dark'

export const TONE_CLASS: Record<Tone, { bg: string; text: string; border: string }> = {
  neutral: { bg: 'bg-subtle', text: 'text-ink-secondary', border: 'border-line' },
  success: { bg: 'bg-success-bg', text: 'text-success', border: 'border-success-line' },
  due: { bg: 'bg-due-bg', text: 'text-due', border: 'border-due-line' },
  missed: { bg: 'bg-missed-bg', text: 'text-missed', border: 'border-missed-line' },
  exception: { bg: 'bg-exception-bg', text: 'text-exception', border: 'border-exception-line' },
  // Quiet pills: the accent and dark tones are tinted too, never solid fills.
  accent: { bg: 'bg-accent-soft', text: 'text-accent', border: 'border-accent' },
  dark: { bg: 'bg-subtle', text: 'text-ink', border: 'border-line-strong' }
}

export function statusTone(status: string): Tone {
  switch (status.toUpperCase()) {
    case 'COMPLETED':
    case 'ACTIVE':
    case 'RESOLVED':
    case 'PASS':
      return 'success'
    case 'MISSED':
    case 'FAIL':
    case 'DISABLED':
      return 'missed'
    case 'EXCEPTION':
    case 'MAINTENANCE':
    case 'UNDER_REVIEW':
    case 'PAUSED':
      return 'exception'
    case 'ACKNOWLEDGED':
    case 'ACTION_TAKEN':
    case 'DUE':
      return 'due'
    default:
      return 'neutral'
  }
}

export const STATUS_LABEL: Record<string, string> = {
  COMPLETED: 'Completed',
  MISSED: 'Missed',
  EXCEPTION: 'Exception',
  ACTIVE: 'Active',
  INACTIVE: 'Inactive',
  DISABLED: 'Disabled',
  MAINTENANCE: 'Maintenance',
  IDLE: 'Idle',
  PAUSED: 'Paused',
  PASS: 'Within limits',
  FAIL: 'Outside limits',
  NA: 'Recorded',
  ...EXCEPTION_STATUS_LABEL
}

/** Plant Calendar entry types, as in the web panel. */
export const CLOSURE_META: Record<ClosureType, { label: string; short: string; dot: string; bg: string; text: string }> = {
  HOLIDAY: { label: 'Holiday', short: 'Holiday', dot: 'bg-success', bg: 'bg-success-bg', text: 'text-success' },
  SHUTDOWN: { label: 'Shutdown', short: 'Shutdown', dot: 'bg-missed', bg: 'bg-missed-bg', text: 'text-missed' },
  CLOSED: { label: 'Plant Closed', short: 'Closed', dot: 'bg-ink-secondary', bg: 'bg-subtle', text: 'text-ink-secondary' },
  WORKING: { label: 'Adjustment Working Day', short: 'Working day', dot: 'bg-due', bg: 'bg-due-bg', text: 'text-due' }
}

export const isClosedType = (type: ClosureType) => type !== 'WORKING'
