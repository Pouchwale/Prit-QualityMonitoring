import React from 'react'
import { Sparkline } from './charts'

const TONE = {
  neutral: { icon: 'bg-subtle text-ink-secondary', value: 'text-ink', spark: 'var(--color-chart-primary)' },
  accent: { icon: 'bg-accent-soft text-accent', value: 'text-ink', spark: 'var(--color-chart-primary)' },
  success: { icon: 'bg-success-bg text-success', value: 'text-ink', spark: 'var(--color-chart-completed)' },
  missed: { icon: 'bg-missed-bg text-missed', value: 'text-missed', spark: 'var(--color-chart-missed)' },
  exception: { icon: 'bg-exception-bg text-exception', value: 'text-exception', spark: 'var(--color-chart-exception)' },
  due: { icon: 'bg-due-bg text-due', value: 'text-ink', spark: 'var(--color-chart-open)' }
} as const

export type StatTone = keyof typeof TONE

interface StatCardProps {
  label: string
  value: React.ReactNode
  icon: React.ReactNode
  tone?: StatTone
  /** A short secondary figure under the value, e.g. "92% of scheduled". */
  meta?: React.ReactNode
  /** Recent values for a small trend line (oldest first). */
  trend?: number[]
  /** Something under the value instead of the meta line, e.g. a progress bar. */
  footer?: React.ReactNode
  /** Draws attention: a non-zero Missed count, for example. */
  alert?: boolean
  onClick?: () => void
  title?: string
}

/**
 * A KPI tile (design-system/MASTER.md "KPI cards"): icon, label, big tabular number, an optional
 * meta line and trend. The value's colour only changes for Missed / Exception, so the numbers that
 * need action stand out and everything else stays calm.
 */
export const StatCard: React.FC<StatCardProps> = ({ label, value, icon, tone = 'neutral', meta, trend, footer, alert, onClick, title }) => {
  const t = TONE[tone]
  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`w-7 h-7 rounded-md flex items-center justify-center shrink-0 ${t.icon}`} aria-hidden>
            {icon}
          </span>
          <span className="text-[12.5px] font-medium text-ink-secondary truncate">{label}</span>
        </div>
        {alert && <span className="mt-1 w-2 h-2 rounded-full bg-[var(--color-chart-missed)] ring-4 ring-missed-bg shrink-0" aria-hidden />}
      </div>
      <div className="mt-2.5 flex items-end justify-between gap-2">
        <div className={`text-[26px] leading-none font-semibold tracking-tight tabular-nums ${t.value}`}>{value}</div>
        {trend && trend.length > 1 && (
          <div className="shrink-0">
            <Sparkline values={trend} color={t.spark} width={64} height={24} />
          </div>
        )}
      </div>
      {meta && <div className="mt-1.5 text-[12px] text-ink-muted truncate">{meta}</div>}
      {footer && <div className="mt-2.5">{footer}</div>}
    </>
  )
  const cls = `card p-3.5 text-left min-w-0 ${alert ? 'border-missed-line' : ''}`
  return onClick ? (
    <button type="button" onClick={onClick} title={title} className={`${cls} hover:border-line-strong hover:shadow-[var(--shadow-pop)] transition-[box-shadow,border-color] duration-150`}>
      {body}
    </button>
  ) : (
    <div className={cls} title={title}>
      {body}
    </div>
  )
}
