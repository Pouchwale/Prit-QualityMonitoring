import { formatDate } from './datetime'

/** Local date as YYYY-MM-DD, the format the API expects. */
export function dateKey(date: Date) {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function parseDateKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d)
}

export function daysAgo(days: number) {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return d
}

/** 18/09/2026 */
export function formatDateKey(key: string) {
  return formatDate(parseDateKey(key))
}
