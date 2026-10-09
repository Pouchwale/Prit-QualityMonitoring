import React from 'react'
import { InfoTip } from '../ui/Card'

interface PageHeaderProps {
  title: string
  /** One short line under the title. Long explanations go in `info`, shown on an info icon. */
  description?: React.ReactNode
  /** Help text for the page, behind an info icon next to the title. */
  info?: string
  /** A small icon tile before the title. */
  icon?: React.ReactNode
  actions?: React.ReactNode
  /** Views of a module with more than one page, shown under the title (Quality Monitoring). */
  tabs?: React.ReactNode
}

/**
 * Page title row (design-system/MASTER.md "Page header"): title with optional icon and info tip, a
 * one-line description, actions on the right and the module's view tabs below.
 */
export const PageHeader: React.FC<PageHeaderProps> = ({ title, description, info, icon, actions, tabs }) => (
  <div className="flex flex-col gap-3">
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
      <div className="flex items-center gap-3 min-w-0">
        {icon && (
          <span className="hidden sm:flex w-9 h-9 shrink-0 rounded-lg bg-white ring-1 ring-line shadow-[var(--shadow-card)] text-accent items-center justify-center" aria-hidden>
            {icon}
          </span>
        )}
        <div className="min-w-0">
          <h1 className="flex items-center gap-1.5 text-[19px] sm:text-[20px] font-semibold text-ink tracking-tight leading-tight">
            {title}
            {info && <InfoTip text={info} />}
          </h1>
          {description && <p className="text-[12.5px] text-ink-muted mt-0.5 line-clamp-2">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex items-center gap-2 flex-wrap">{actions}</div>}
    </div>
    {tabs}
  </div>
)
