import { formatLongDate, formatTime as formatClockTime } from './datetime'

/** 2:30 PM */
export function formatTime(iso: string) {
  return formatClockTime(iso)
}

/** Friday, 18/09/2026 */
export function formatDate(date: Date) {
  return formatLongDate(date)
}

export function formatDuration(seconds: number) {
  const s = Math.max(0, Math.round(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
