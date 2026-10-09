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
  let dotClass = 'bg-[var(--color-chart-open)]'
  let label = status

  switch (normalized) {
    case 'COMPLETED':
      bgClass = 'bg-success-bg'
      textClass = 'text-success'
      borderClass = 'border-success-line'
      dotClass = 'bg-[var(--color-chart-completed)]'
      label = 'Completed'
      break

    case 'MISSED':
      bgClass = 'bg-missed-bg'
      textClass = 'text-missed'
      borderClass = 'border-missed-line'
      dotClass = 'bg-[var(--color-chart-missed)]'
      label = 'Missed'
      break

    case 'EXCEPTION':
      bgClass = 'bg-exception-bg'
      textClass = 'text-exception'
      borderClass = 'border-exception-line'
      dotClass = 'bg-[var(--color-chart-exception)]'
      label = 'Exception'
      break

    // Machine / Entity statuses
    case 'ACTIVE':
      bgClass = 'bg-success-bg'
      textClass = 'text-success'
      borderClass = 'border-success-line'
      dotClass = 'bg-[var(--color-chart-completed)]'
      label = 'Active'
      break

    case 'MAINTENANCE':
      bgClass = 'bg-exception-bg'
      textClass = 'text-exception'
      borderClass = 'border-exception-line'
      dotClass = 'bg-[var(--color-chart-exception)]'
      label = 'Maintenance'
      break

    case 'IDLE':
      bgClass = 'bg-subtle'
      textClass = 'text-ink-muted'
      borderClass = 'border-line'
      dotClass = 'bg-[var(--color-chart-open)]'
      label = 'Idle'
      break

    case 'PAUSED':
      bgClass = 'bg-exception-bg'
      textClass = 'text-exception'
      borderClass = 'border-exception-line'
      dotClass = 'bg-[var(--color-chart-exception)]'
      label = 'Paused'
      break

    case 'INACTIVE':
    case 'DISABLED':
      bgClass = 'bg-subtle'
      textClass = 'text-ink-muted'
      borderClass = 'border-line'
      dotClass = 'bg-[var(--color-chart-open)]'
      label = normalized === 'DISABLED' ? 'Disabled' : 'Inactive'
      break

    // Parameter reading results (not a check Result)
    case 'PASS':
      bgClass = 'bg-success-bg'
      textClass = 'text-success'
      borderClass = 'border-success-line'
      dotClass = 'bg-[var(--color-chart-completed)]'
      label = 'Within limits'
      break

    case 'FAIL':
      bgClass = 'bg-missed-bg'
      textClass = 'text-failed'
      borderClass = 'border-failed-line'
      dotClass = 'bg-[var(--color-chart-missed)]'
      label = 'Outside limits'
      break

    case 'NA':
      bgClass = 'bg-subtle'
      textClass = 'text-ink-muted'
      borderClass = 'border-line'
      dotClass = 'bg-[var(--color-chart-open)]'
      label = 'Recorded'
      break

    case 'ACTION_TAKEN':
      bgClass = 'bg-accent-soft'
      textClass = 'text-accent-strong'
      borderClass = 'border-accent-line'
      dotClass = 'bg-accent'
      label = 'Action Taken'
      break

    case 'UNDER_REVIEW':
    case 'UNDER REVIEW':
      bgClass = 'bg-exception-bg'
      textClass = 'text-exception'
      borderClass = 'border-exception-line'
      dotClass = 'bg-[var(--color-chart-exception)]'
      label = 'Under Review'
      break

    case 'ACKNOWLEDGED':
      bgClass = 'bg-accent-soft'
      textClass = 'text-accent-strong'
      borderClass = 'border-accent-line'
      dotClass = 'bg-accent'
      label = 'Acknowledged'
      break

    case 'RESOLVED':
      bgClass = 'bg-success-bg'
      textClass = 'text-success'
      borderClass = 'border-success-line'
      dotClass = 'bg-[var(--color-chart-completed)]'
      label = 'Resolved'
      break
  }

  const sizeClass = size === 'sm' ? 'text-[11px] h-5 px-1.5' : 'text-[12px] h-[22px] px-2'

  // Soft pill: tinted background, hairline ring, a dot and the label (never colour alone).
  return (
    <span
      className={`inline-flex items-center gap-1.5 font-medium rounded-full ring-1 ring-inset whitespace-nowrap leading-none ${sizeClass} ${bgClass} ${textClass} ${borderClass.replace('border-', 'ring-')} ${className}`}
    >
      {showDot && <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotClass}`} aria-hidden />}
      <span>{label}</span>
    </span>
  )
}

/**
 * A quality check's Status: Completed, Missed or Exception. A check that is not finished yet has
 * no result; it shows a neutral "Open" pill so pending work is still visible at a glance.
 */
export const CheckStatusBadge: React.FC<{ status: QualityCheckStatus; size?: 'sm' | 'md'; className?: string }> = ({ status, size, className }) =>
  FINISHED.includes(status) ? (
    <StatusBadge status={status} size={size} className={className} />
  ) : (
    <span
      className={`inline-flex items-center gap-1.5 font-medium rounded-full ring-1 ring-inset ring-line-strong bg-white text-ink-muted whitespace-nowrap leading-none ${
        size === 'sm' ? 'text-[11px] h-5 px-1.5' : 'text-[12px] h-[22px] px-2'
      } ${className ?? ''}`}
      title="Not finished yet"
    >
      <span className="w-1.5 h-1.5 rounded-full shrink-0 border border-ink-faint" aria-hidden />
      Open
    </span>
  )
