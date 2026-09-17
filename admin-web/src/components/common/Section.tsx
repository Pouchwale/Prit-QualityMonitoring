import React from 'react'

/** Titled card used by the Settings and My Account pages. */
export const Section: React.FC<{ icon: React.ReactNode; title: string; description?: string; children: React.ReactNode }> = ({
  icon,
  title,
  description,
  children
}) => (
  <section className="bg-white border border-line rounded-md shadow-2xs">
    <div className="px-4 py-3 border-b border-line flex items-start gap-2">
      <span className="text-accent mt-px">{icon}</span>
      <div>
        <h2 className="text-xs font-bold uppercase tracking-wider text-ink font-mono">{title}</h2>
        {description && <p className="text-[11px] text-ink-muted mt-0.5">{description}</p>}
      </div>
    </div>
    <div className="p-4">{children}</div>
  </section>
)
