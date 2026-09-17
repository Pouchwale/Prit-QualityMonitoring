export function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export function formatDate(date: Date) {
  return date.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' })
}

export function formatDuration(seconds: number) {
  const s = Math.max(0, Math.round(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
