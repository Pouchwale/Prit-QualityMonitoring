import React from 'react'
import { AlertCircle, Inbox, Loader2 } from 'lucide-react'
import { Button } from './Button'

interface DataStateProps {
  loading: boolean
  error: string | null
  onRetry?: () => void
  /** True when data loaded but there is nothing to show. */
  empty?: boolean
  emptyText?: string
  /** Inside a card already: draw the states without their own card frame. */
  flush?: boolean
  children: React.ReactNode
}

/** Shows loading / error / empty states, otherwise renders children. */
export const DataState: React.FC<DataStateProps> = ({ loading, error, onRetry, empty, emptyText = 'No records found', flush = false, children }) => {
  const frame = flush ? '' : 'card'
  if (error) {
    return (
      <div className={`${frame} p-8 text-center`} role="alert">
        <span className="mx-auto mb-3 w-10 h-10 rounded-full bg-missed-bg text-missed flex items-center justify-center" aria-hidden>
          <AlertCircle className="w-5 h-5" />
        </span>
        <div className="text-sm font-semibold text-ink">Could not load data</div>
        <div className="text-[12.5px] text-ink-muted mt-1 max-w-md mx-auto">{error}</div>
        {onRetry && (
          <Button size="sm" variant="outline" className="mt-4" onClick={onRetry}>
            Try again
          </Button>
        )}
      </div>
    )
  }
  if (loading && empty !== false) {
    return (
      // Skeleton rows keep the page's shape while it loads, instead of a jumping spinner box.
      <div className={`${frame} p-4 space-y-3`} role="status" aria-live="polite" aria-busy="true">
        <span className="sr-only">Loading…</span>
        <div className="flex items-center gap-2 text-[12px] text-ink-muted" aria-hidden>
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Loading
        </div>
        {[72, 92, 84, 64].map((w, i) => (
          <div key={i} className="h-3 rounded bg-subtle animate-pulse" style={{ width: `${w}%` }} aria-hidden />
        ))}
      </div>
    )
  }
  if (empty) {
    return (
      <div className={`${frame} py-12 px-6 text-center`} role="status">
        <span className="mx-auto mb-3 w-10 h-10 rounded-full bg-subtle text-ink-faint flex items-center justify-center" aria-hidden>
          <Inbox className="w-5 h-5" />
        </span>
        <div className="text-[13px] font-medium text-ink-secondary">{emptyText}</div>
      </div>
    )
  }
  return <>{children}</>
}

/**
 * Warns that the server sent only part of a long list (it caps how many rows one request
 * returns), so counts and totals worked out from the rows are not exact.
 */
export const TruncatedNotice: React.FC<{ shown: number; total: number; noun?: string }> = ({ shown, total, noun = 'checks' }) => (
  <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg border border-exception-line bg-exception-bg text-[12.5px] text-ink" role="status">
    <AlertCircle className="w-4 h-4 shrink-0 text-exception" />
    <span>
      Showing the first {shown.toLocaleString('en-IN')} of {total.toLocaleString('en-IN')} {noun} — narrow the date range or filters for exact totals.
    </span>
  </div>
)
