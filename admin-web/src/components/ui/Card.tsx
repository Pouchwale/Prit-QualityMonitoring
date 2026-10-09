import React from 'react'

/**
 * The surface every page section sits on (design-system/MASTER.md "Cards"): white, hairline border,
 * 10px radius, one soft shadow. `padded` adds the standard inner padding; leave it off when the card
 * holds a full-bleed table or list.
 */
export const Card: React.FC<{ className?: string; padded?: boolean; children: React.ReactNode } & React.HTMLAttributes<HTMLElement>> = ({
  className = '',
  padded = false,
  children,
  ...rest
}) => (
  <section className={`card min-w-0 ${padded ? 'p-4' : ''} ${className}`} {...rest}>
    {children}
  </section>
)

interface CardHeaderProps {
  title: React.ReactNode
  /** One short line under the title; longer explanations belong in `info` (shown on hover/focus). */
  subtitle?: React.ReactNode
  /** Explanation shown as a tooltip on an info icon, so the card itself stays compact. */
  info?: string
  icon?: React.ReactNode
  /** Right side: a count, a link-button or a small control. */
  actions?: React.ReactNode
  className?: string
}

/** Card title row: optional icon tile, title, one-line subtitle and actions on the right. */
export const CardHeader: React.FC<CardHeaderProps> = ({ title, subtitle, info, icon, actions, className = '' }) => (
  <div className={`flex items-center justify-between gap-3 px-4 pt-3.5 pb-3 border-b border-line ${className}`}>
    <div className="flex items-center gap-2.5 min-w-0">
      {icon && (
        <span className="w-7 h-7 shrink-0 rounded-md bg-subtle text-ink-secondary flex items-center justify-center" aria-hidden>
          {icon}
        </span>
      )}
      <div className="min-w-0">
        <h2 className="flex items-center gap-1.5 text-[13.5px] font-semibold text-ink leading-tight truncate">
          {title}
          {info && <InfoTip text={info} />}
        </h2>
        {subtitle && <p className="text-[12px] text-ink-muted leading-snug line-clamp-2 mt-0.5">{subtitle}</p>}
      </div>
    </div>
    {actions && <div className="flex items-center gap-1.5 shrink-0">{actions}</div>}
  </div>
)

/**
 * A small "i" that shows an explanation on hover or keyboard focus (and to screen readers), so
 * long help text does not fill the page.
 */
export const InfoTip: React.FC<{ text: string; className?: string }> = ({ text, className = '' }) => (
  <span className={`relative inline-flex group/tip ${className}`}>
    <button
      type="button"
      className="w-4 h-4 inline-flex items-center justify-center rounded-full text-ink-faint hover:text-ink-secondary focus-visible:text-ink-secondary"
      aria-label={text}
    >
      <svg viewBox="0 0 16 16" className="w-3.5 h-3.5" aria-hidden="true">
        <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <path d="M8 7.2v3.6M8 5.1v.1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </button>
    <span
      aria-hidden="true"
      className="pointer-events-none absolute left-1/2 top-full z-30 mt-1.5 w-64 -translate-x-1/2 rounded-md bg-ink px-2.5 py-2 text-[11.5px] font-normal leading-snug text-white opacity-0 shadow-[var(--shadow-pop)] transition-opacity duration-150 group-hover/tip:opacity-100 group-focus-within/tip:opacity-100 normal-case tracking-normal text-left"
    >
      {text}
    </span>
  </span>
)

/** Empty or "nothing to show" content inside a card, with an optional icon and action. */
export const EmptyState: React.FC<{ icon?: React.ReactNode; title: string; hint?: string; action?: React.ReactNode; compact?: boolean }> = ({
  icon,
  title,
  hint,
  action,
  compact = false
}) => (
  <div className={`flex flex-col items-center justify-center text-center ${compact ? 'py-6 px-4' : 'py-10 px-6'}`} role="status">
    {icon && (
      <span className="mb-2.5 w-9 h-9 rounded-full bg-subtle text-ink-faint flex items-center justify-center" aria-hidden>
        {icon}
      </span>
    )}
    <div className="text-[13px] font-medium text-ink-secondary">{title}</div>
    {hint && <div className="mt-0.5 text-[12px] text-ink-muted max-w-sm">{hint}</div>}
    {action && <div className="mt-3">{action}</div>}
  </div>
)
