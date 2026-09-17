import React from 'react'
import { QualityCheckStatus, MachineStatus, ExceptionStatus } from '../../types'

const FINISHED: string[] = ['COMPLETED', 'MISSED', 'EXCEPTION']

type BadgeType = QualityCheckStatus | MachineStatus | ExceptionStatus | 'ACTIVE' | 'INACTIVE' | 'MAINTENANCE' | 'IDLE'

interface StatusBadgeProps {
  status: BadgeType | string
  size?: 'sm' | 'md'
  showDot?: boolean
  className?: string
}

export const StatusBadge: React.FC<StatusBadgeProps> = ({
  status,
  size = 'md',
  showDot = true,
  className = ''
}) => {
  const normalized = status.toUpperCase()

  let bgClass = 'bg-subtle'
  let textClass = 'text-ink-secondary'
  let borderClass = 'border-line'
  let dotClass = 'bg-ink-muted'
  let label = status

  switch (normalized) {
    case 'COMPLETED':
      bgClass = 'bg-success-bg'
      textClass = 'text-success'
      borderClass = 'border-success-line'
      dotClass = 'bg-green-600'
      label = 'Completed'
      break

    case 'MISSED':
      bgClass = 'bg-missed-bg'
      textClass = 'text-missed'
      borderClass = 'border-missed-line'
      dotClass = 'bg-failed'
      label = 'Missed'
      break

    case 'EXCEPTION':
      bgClass = 'bg-exception-bg'
      textClass = 'text-exception'
      borderClass = 'border-exception-line'
      dotClass = 'bg-amber-600'
      label = 'Exception'
      break

    // Machine / Entity statuses
    case 'ACTIVE':
      bgClass = 'bg-success-bg'
      textClass = 'text-success'
      borderClass = 'border-success-line'
      dotClass = 'bg-green-600'
      label = 'Active'
      break

    case 'MAINTENANCE':
      bgClass = 'bg-exception-bg'
      textClass = 'text-exception'
      borderClass = 'border-exception-line'
      dotClass = 'bg-amber-600'
      label = 'Maintenance'
      break

    case 'IDLE':
      bgClass = 'bg-slate-50'
      textClass = 'text-ink-muted'
      borderClass = 'border-line'
      dotClass = 'bg-ink-faint'
      label = 'Idle'
      break

    case 'PAUSED':
      bgClass = 'bg-exception-bg'
      textClass = 'text-exception'
      borderClass = 'border-exception-line'
      dotClass = 'bg-amber-600'
      label = 'Paused'
      break

    case 'INACTIVE':
    case 'DISABLED':
      bgClass = 'bg-slate-50'
      textClass = 'text-ink-muted'
      borderClass = 'border-line'
      dotClass = 'bg-ink-faint'
      label = normalized === 'DISABLED' ? 'Disabled' : 'Inactive'
      break

    // Parameter reading results (not a check Result)
    case 'PASS':
      bgClass = 'bg-success-bg'
      textClass = 'text-success'
      borderClass = 'border-success-line'
      dotClass = 'bg-green-600'
      label = 'Within limits'
      break

    case 'FAIL':
      bgClass = 'bg-missed-bg'
      textClass = 'text-failed'
      borderClass = 'border-failed-line'
      dotClass = 'bg-failed'
      label = 'Outside limits'
      break

    case 'NA':
      bgClass = 'bg-slate-50'
      textClass = 'text-ink-muted'
      borderClass = 'border-line'
      dotClass = 'bg-ink-faint'
      label = 'Recorded'
      break

    case 'ACTION_TAKEN':
      bgClass = 'bg-blue-50'
      textClass = 'text-blue-700'
      borderClass = 'border-blue-200'
      dotClass = 'bg-blue-600'
      label = 'Action Taken'
      break

    case 'UNDER_REVIEW':
    case 'UNDER REVIEW':
      bgClass = 'bg-exception-bg'
      textClass = 'text-exception'
      borderClass = 'border-exception-line'
      dotClass = 'bg-amber-600'
      label = 'Under Review'
      break

    case 'ACKNOWLEDGED':
      bgClass = 'bg-blue-50'
      textClass = 'text-blue-700'
      borderClass = 'border-blue-200'
      dotClass = 'bg-blue-600'
      label = 'Acknowledged'
      break

    case 'RESOLVED':
      bgClass = 'bg-success-bg'
      textClass = 'text-success'
      borderClass = 'border-success-line'
      dotClass = 'bg-green-600'
      label = 'Resolved'
      break
  }

  const sizeClass = size === 'sm' 
    ? 'text-[11px] px-1.5 py-0.5' 
    : 'text-[12px] px-2 py-0.5'

  return (
    <span
      className={`inline-flex items-center gap-1.5 font-medium rounded border tracking-tight ${sizeClass} ${bgClass} ${textClass} ${borderClass} ${className}`}
    >
      {showDot && (
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotClass}`} />
      )}
      <span>{label}</span>
    </span>
  )
}

/** A quality check's Status: Completed, Missed or Exception, or "—" while it is not finished. */
export const CheckStatusBadge: React.FC<{ status: QualityCheckStatus; size?: 'sm' | 'md'; className?: string }> = ({ status, size, className }) =>
  FINISHED.includes(status) ? (
    <StatusBadge status={status} size={size} className={className} />
  ) : (
    <span className={`text-ink-faint ${className ?? ''}`} title="Not finished yet">—</span>
  )
