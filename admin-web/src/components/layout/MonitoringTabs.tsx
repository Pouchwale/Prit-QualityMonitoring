import React from 'react'
import { Link } from 'react-router-dom'
import { MONITORING_TABS, MONITORING_TAB_LABEL, NAV_PATH, type MonitoringTab } from '../../lib/routes'
import { useCanOpen } from './Sidebar'

/**
 * The views of the Quality Monitoring module: Overview, Checks and Jobs. Each is its own address,
 * so the tabs are ordinary links and bookmarks keep working.
 *
 * Only the views the account may open are offered, and a user who may open just one sees no tabs
 * at all. Permissions are unchanged by the merge: Overview needs the dashboard module, Checks and
 * Jobs the checks module, and the backend still checks every request.
 */
export const MonitoringTabs: React.FC<{ current: MonitoringTab }> = ({ current }) => {
  const canOpen = useCanOpen()
  const tabs = MONITORING_TABS.filter(canOpen)
  if (tabs.length < 2) return null

  return (
    <nav aria-label="Quality Monitoring views" className="flex items-center gap-0.5 p-0.5 rounded-md border border-line bg-subtle self-start max-w-full overflow-x-auto">
      {tabs.map((tab) => {
        const active = tab === current
        return (
          <Link
            key={tab}
            to={NAV_PATH[tab]}
            aria-current={active ? 'page' : undefined}
            className={`inline-flex items-center justify-center h-[36px] lg:h-7 px-3 rounded text-xs font-semibold whitespace-nowrap transition-colors ${
              active ? 'bg-white text-ink border border-line-strong shadow-2xs' : 'text-ink-secondary hover:text-ink'
            }`}
          >
            {MONITORING_TAB_LABEL[tab]}
          </Link>
        )
      })}
    </nav>
  )
}
