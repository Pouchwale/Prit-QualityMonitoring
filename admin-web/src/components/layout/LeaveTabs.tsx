import React from 'react'
import { Link } from 'react-router-dom'
import { LEAVE_TABS, LEAVE_TAB_LABEL, NAV_PATH, type LeaveTab } from '../../lib/routes'
import { useCanOpen } from './Sidebar'

/**
 * The views of the Leave Management module: the leave pages and the Plant Calendar. Each keeps its
 * own address, so the tabs are ordinary links and bookmarks keep working. Only the views this
 * account may open are offered (each keeps its own permission); with just one there are no tabs.
 */
export const LeaveTabs: React.FC<{ current: LeaveTab; pending?: { leave: number; shiftChanges: number } }> = ({ current, pending }) => {
  const canOpen = useCanOpen()
  const tabs = LEAVE_TABS.filter(canOpen)
  if (tabs.length < 2) return null
  const count: Partial<Record<LeaveTab, number>> = { 'leave-approval': (pending?.leave ?? 0) + (pending?.shiftChanges ?? 0) }

  return (
    <nav aria-label="Leave Management views" className="scroll-hint flex items-center gap-1 border-b border-line max-w-full overflow-x-auto">
      {tabs.map((tab) => {
        const active = tab === current
        const n = count[tab]
        return (
          <Link
            key={tab}
            to={NAV_PATH[tab]}
            aria-current={active ? 'page' : undefined}
            className={`relative inline-flex items-center gap-1.5 h-10 lg:h-9 px-3 text-[13px] font-medium whitespace-nowrap transition-colors ${
              active ? 'text-accent-strong' : 'text-ink-muted hover:text-ink'
            }`}
          >
            {LEAVE_TAB_LABEL[tab]}
            {n ? (
              <span className="min-w-5 h-5 px-1.5 inline-flex items-center justify-center rounded-full text-[11px] font-semibold tabular-nums ring-1 ring-inset bg-due-bg text-due ring-due-line">
                {n}
                <span className="sr-only"> pending</span>
              </span>
            ) : null}
            {active && <span className="absolute left-2 right-2 -bottom-px h-[2px] rounded-full bg-accent" aria-hidden />}
          </Link>
        )
      })}
    </nav>
  )
}
