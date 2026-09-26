import React from 'react'

interface PageHeaderProps {
  title: string
  description?: string
  actions?: React.ReactNode
  /** Views of a module with more than one page, shown under the title (Quality Monitoring). */
  tabs?: React.ReactNode
}

export const PageHeader: React.FC<PageHeaderProps> = ({ title, description, actions, tabs }) => (
  <div className="flex flex-col gap-2.5 pb-3 border-b border-line">
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
      <div className="min-w-0">
        <h1 className="text-lg sm:text-xl font-bold text-ink tracking-tight">{title}</h1>
        {description && <p className="text-xs text-ink-muted mt-0.5">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 flex-wrap">{actions}</div>}
    </div>
    {tabs}
  </div>
)
