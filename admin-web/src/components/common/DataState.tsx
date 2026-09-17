import React from 'react'
import { AlertCircle, Loader2 } from 'lucide-react'
import { Button } from './Button'

interface DataStateProps {
  loading: boolean
  error: string | null
  onRetry?: () => void
  /** True when data loaded but there is nothing to show. */
  empty?: boolean
  emptyText?: string
  children: React.ReactNode
}

/** Shows loading / error / empty states, otherwise renders children. */
export const DataState: React.FC<DataStateProps> = ({ loading, error, onRetry, empty, emptyText = 'No records found', children }) => {
  if (error) {
    return (
      <div className="bg-white border border-line rounded-md p-8 text-center">
        <AlertCircle className="w-5 h-5 text-failed mx-auto mb-2" />
        <div className="text-sm font-semibold text-ink">Could not load data</div>
        <div className="text-xs text-ink-muted mt-1">{error}</div>
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
      <div className="bg-white border border-line rounded-md p-10 flex items-center justify-center text-xs text-ink-muted gap-2">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading…
      </div>
    )
  }
  if (empty) {
    return <div className="bg-white border border-line rounded-md p-10 text-center text-xs text-ink-muted">{emptyText}</div>
  }
  return <>{children}</>
}
