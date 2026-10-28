import React from 'react'
import { Search, X } from 'lucide-react'

/**
 * The filter row above a table (design-system/MASTER.md "Toolbars"): search on the left, filters
 * and segmented controls next to it, the count or secondary actions on the right. It wraps on
 * smaller screens instead of scrolling.
 */
export const Toolbar: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = '' }) => (
  <div className={`flex flex-wrap items-center gap-2 px-3 py-2.5 border-b border-line ${className}`}>{children}</div>
)

/** Pushes the following toolbar items to the right edge. */
export const ToolbarSpacer: React.FC = () => <div className="flex-1 min-w-0" />

/** A search field with an icon and a clear button. `label` names it for screen readers. */
export const SearchInput: React.FC<{
  value: string
  onChange: (value: string) => void
  placeholder?: string
  label: string
  className?: string
}> = ({ value, onChange, placeholder = 'Search…', label, className = '' }) => (
  <div className={`relative w-full sm:w-64 ${className}`}>
    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-faint pointer-events-none" aria-hidden />
    <input
      type="search"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      aria-label={label}
      className="w-full h-[40px] lg:h-8 pl-8 pr-8 text-[16px] lg:text-[13px] rounded-md border border-line-strong bg-white text-ink placeholder:text-ink-faint focus:outline-none focus:ring-2 focus:ring-accent/25 focus:border-accent [&::-webkit-search-cancel-button]:hidden"
    />
    {value && (
      <button
        type="button"
        onClick={() => onChange('')}
        className="absolute right-1 top-1/2 -translate-y-1/2 w-7 h-7 lg:w-6 lg:h-6 flex items-center justify-center rounded text-ink-muted hover:text-ink hover:bg-subtle"
        aria-label="Clear search"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    )}
  </div>
)

export interface SegmentOption<T extends string> {
  value: T
  label: React.ReactNode
  /** A count shown after the label. */
  count?: number
}

/**
 * A segmented control for mutually exclusive filters (All / IPQC / QC). Each option is a pressed
 * button, so assistive technology reads which one is on.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  className = ''
}: {
  options: SegmentOption<T>[]
  value: T
  onChange: (value: T) => void
  label: string
  className?: string
}) {
  return (
    <div role="group" aria-label={label} className={`scroll-hint inline-flex items-center gap-0.5 p-0.5 rounded-md bg-subtle border border-line max-w-full overflow-x-auto ${className}`}>
      {options.map((o) => {
        const on = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.value)}
            className={`inline-flex items-center gap-1.5 h-[36px] lg:h-7 px-2.5 rounded text-[12.5px] font-medium whitespace-nowrap transition-colors ${
              on ? 'bg-white text-ink shadow-[var(--shadow-card)] ring-1 ring-line' : 'text-ink-secondary hover:text-ink'
            }`}
          >
            {o.label}
            {o.count !== undefined && (
              <span className={`min-w-5 px-1 rounded text-[11px] tabular-nums ${on ? 'bg-accent-soft text-accent-strong' : 'bg-white/70 text-ink-muted'}`}>{o.count}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}

/**
 * A square icon-only button (row actions, toolbar tools). `label` is required: it is the accessible
 * name and the hover tooltip.
 */
export const IconButton: React.FC<
  React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; tone?: 'neutral' | 'danger'; size?: 'sm' | 'md' }
> = ({ label, tone = 'neutral', size = 'sm', className = '', children, ...rest }) => (
  <button
    type="button"
    aria-label={label}
    title={label}
    className={`inline-flex items-center justify-center shrink-0 rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
      size === 'sm' ? 'w-9 h-9 lg:w-7 lg:h-7' : 'w-10 h-10 lg:w-8 lg:h-8'
    } ${tone === 'danger' ? 'text-ink-muted hover:text-missed hover:bg-missed-bg' : 'text-ink-muted hover:text-ink hover:bg-subtle'} ${className}`}
    {...rest}
  >
    {children}
  </button>
)

/** A "12 results" style count for the right side of a toolbar. */
export const ResultCount: React.FC<{ shown: number; total?: number; noun: string }> = ({ shown, total, noun }) => (
  <span className="text-[12px] text-ink-muted tabular-nums whitespace-nowrap" aria-live="polite">
    {total !== undefined && total !== shown ? `${shown.toLocaleString('en-IN')} of ${total.toLocaleString('en-IN')}` : shown.toLocaleString('en-IN')} {noun}
  </span>
)
