import React from 'react'
import { Link } from 'react-router-dom'
import { MONITORING_TABS, MONITORING_TAB_LABEL, NAV_PATH, type MonitoringTab } from '../../lib/routes'
import { useCanOpen } from './Sidebar'

/**
 * The views of the Quality Monitoring module: Overview, Checks and Jobs. Each is its own address,
 * so the tabs are ordinary links and bookmarks keep working.
 *
 * Only the views the account may open are offered, and a user who may open just one sees no tabs
 * at all. Permissions are unchanged by the merge: Overview needs the dashboard module, Checks the
 * checks module and Jobs the jobs module, and the backend still checks every request.
 */
export const MonitoringTabs: React.FC<{ current: MonitoringTab }> = ({ current }) => {
  const canOpen = useCanOpen()
  const tabs = MONITORING_TABS.filter(canOpen)
  if (tabs.length < 2) return null

  return (
    <nav aria-label="Quality Monitoring views" className="flex items-center gap-1 border-b border-line max-w-full overflow-x-auto -mb-px">
      {tabs.map((tab) => {
        const active = tab === current
        return (
          <Link
            key={tab}
            to={NAV_PATH[tab]}
            aria-current={active ? 'page' : undefined}
            className={`relative inline-flex items-center h-10 lg:h-9 px-3 text-[13px] font-medium whitespace-nowrap transition-colors ${
              active ? 'text-accent-strong' : 'text-ink-muted hover:text-ink'
            }`}
          >
            {MONITORING_TAB_LABEL[tab]}
            {active && <span className="absolute left-2 right-2 -bottom-px h-[2px] rounded-full bg-accent" aria-hidden />}
          </Link>
        )
      })}
    </nav>
  )
}
