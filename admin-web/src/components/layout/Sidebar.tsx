import React, { useEffect, useRef } from 'react'
import {
  LayoutDashboard,
  ClipboardCheck,
  Cpu,
  Workflow,
  SlidersHorizontal,
  CalendarClock,
  CalendarOff,
  Users,
  Link2,
  Clock3,
  AlertOctagon,
  FileSpreadsheet,
  History,
  Settings,
  Building2,
  Factory,
  ShieldCheck,
  UserRound,
  X
} from 'lucide-react'
import type { ModuleKey } from '../../types'
import { useAuth } from '../../lib/auth'

export type NavTab =
  | 'dashboard'
  | 'checks'
  | 'exceptions'
  | 'reports'
  | 'machines'
  | 'departments'
  | 'parameters'
  | 'activities'
  | 'schedules'
  | 'calendar'
  | 'workers'
  | 'assignments'
  | 'shifts'
  | 'audit-logs'
  | 'settings'
  | 'access'
  | 'account'

/** Page names, also shown as the title in the compact mobile header. */
export const NAV_LABEL: Record<NavTab, string> = {
  dashboard: 'Dashboard',
  checks: 'Quality Checks',
  exceptions: 'Exceptions',
  reports: 'Reports',
  parameters: 'Parameters',
  activities: 'Check Types',
  machines: 'Machines',
  schedules: 'Schedules',
  calendar: 'Plant Calendar',
  workers: 'Workers & Users',
  assignments: 'Machine Assignment',
  departments: 'Departments',
  shifts: 'Shifts',
  'audit-logs': 'Audit Logs',
  settings: 'Settings',
  access: 'Manager Access',
  account: 'My Account'
}

/** The permission module behind each page. Manager Access and My Account are not modules. */
export const NAV_MODULE: Partial<Record<NavTab, ModuleKey>> = {
  dashboard: 'dashboard',
  checks: 'checks',
  exceptions: 'exceptions',
  reports: 'reports',
  parameters: 'parameters',
  activities: 'activities',
  machines: 'machines',
  schedules: 'schedules',
  calendar: 'calendar',
  workers: 'workers',
  assignments: 'assignments',
  departments: 'departments',
  shifts: 'shifts',
  'audit-logs': 'audit_logs',
  settings: 'settings'
}

/** Pages in menu order, used to find where to land when the current page is not allowed. */
export const NAV_ORDER: NavTab[] = [
  'dashboard', 'checks', 'exceptions', 'reports', 'parameters', 'activities', 'machines', 'schedules', 'calendar',
  'workers', 'assignments', 'departments', 'shifts', 'audit-logs', 'settings', 'access', 'account'
]

/** Whether the signed-in user may open a page. */
export function useCanOpen() {
  const { can, isAdmin } = useAuth()
  return (tab: NavTab) => {
    if (tab === 'account') return true
    if (tab === 'access') return isAdmin
    const module = NAV_MODULE[tab]
    return module ? can(module) : false
  }
}

interface SidebarProps {
  currentTab: NavTab
  onSelectTab: (tab: NavTab) => void
  missedCount: number
  exceptionCount: number
  plantName: string
  /** Below the `lg` breakpoint the sidebar is a slide-in panel opened from the header. */
  mobileOpen: boolean
  onMobileClose: () => void
}

interface NavItem {
  id: NavTab
  icon: React.ReactNode
  badge?: number
  badgeColor?: string
}

export const Sidebar: React.FC<SidebarProps> = ({
  currentTab,
  onSelectTab,
  missedCount,
  exceptionCount,
  plantName,
  mobileOpen,
  onMobileClose
}) => {
  const closeButton = useRef<HTMLButtonElement>(null)
  const canOpen = useCanOpen()

  useEffect(() => {
    if (!mobileOpen) return
    closeButton.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onMobileClose()
    }
    // The panel is only ever open on small screens; close it if the window grows to desktop width.
    const desktop = window.matchMedia('(min-width: 1024px)')
    const onResize = () => desktop.matches && onMobileClose()
    window.addEventListener('keydown', onKey)
    desktop.addEventListener('change', onResize)
    return () => {
      window.removeEventListener('keydown', onKey)
      desktop.removeEventListener('change', onResize)
    }
  }, [mobileOpen, onMobileClose])

  const allGroups: { title: string; items: NavItem[] }[] = [
    {
      title: 'Monitoring',
      items: [
        { id: 'dashboard', icon: <LayoutDashboard className="w-4 h-4" /> },
        {
          id: 'checks',
          icon: <ClipboardCheck className="w-4 h-4" />,
          badge: missedCount || undefined,
          badgeColor: 'bg-red-100 text-red-700 border-red-200'
        },
        {
          id: 'exceptions',
          icon: <AlertOctagon className="w-4 h-4" />,
          badge: exceptionCount || undefined,
          badgeColor: 'bg-amber-100 text-amber-800 border-amber-200'
        },
        { id: 'reports', icon: <FileSpreadsheet className="w-4 h-4" /> }
      ]
    },
    {
      title: 'Configuration',
      items: [
        { id: 'parameters', icon: <SlidersHorizontal className="w-4 h-4" /> },
        { id: 'activities', icon: <Workflow className="w-4 h-4" /> },
        { id: 'machines', icon: <Cpu className="w-4 h-4" /> },
        { id: 'schedules', icon: <CalendarClock className="w-4 h-4" /> },
        { id: 'calendar', icon: <CalendarOff className="w-4 h-4" /> },
        { id: 'workers', icon: <Users className="w-4 h-4" /> },
        { id: 'assignments', icon: <Link2 className="w-4 h-4" /> },
        { id: 'departments', icon: <Building2 className="w-4 h-4" /> },
        { id: 'shifts', icon: <Clock3 className="w-4 h-4" /> }
      ]
    },
    {
      title: 'System',
      items: [
        { id: 'access', icon: <ShieldCheck className="w-4 h-4" /> },
        { id: 'audit-logs', icon: <History className="w-4 h-4" /> },
        { id: 'settings', icon: <Settings className="w-4 h-4" /> },
        { id: 'account', icon: <UserRound className="w-4 h-4" /> }
      ]
    }
  ]
  // Only the pages this user may open; groups left empty are dropped.
  const groups = allGroups
    .map((group) => ({ ...group, items: group.items.filter((item) => canOpen(item.id)) }))
    .filter((group) => group.items.length > 0)

  const brand = (
    <div className="flex items-center gap-2.5">
      <div className="w-8 h-8 rounded bg-ink text-white flex items-center justify-center font-bold text-sm tracking-wider shadow-xs">
        QM
      </div>
      <div>
        <div className="text-[13px] font-semibold tracking-tight text-ink leading-none">Quality Monitoring</div>
        <div className="text-[11px] text-ink-muted tracking-tight mt-1">Admin Panel</div>
      </div>
    </div>
  )

  const nav = (
    <nav className="flex-1 py-3 px-2.5 space-y-4 overflow-y-auto" aria-label="Main">
      {groups.map((group) => (
        <div key={group.title} className="space-y-0.5">
          <div className="px-2 py-1 text-[11px] font-medium text-ink-faint uppercase tracking-wider">{group.title}</div>
          {group.items.map((item) => {
            const isActive = currentTab === item.id
            return (
              <button
                key={item.id}
                onClick={() => onSelectTab(item.id)}
                aria-current={isActive ? 'page' : undefined}
                className={`w-full flex items-center justify-between px-2.5 py-2.5 lg:py-2 rounded text-[14px] lg:text-[13px] font-medium transition-colors text-left ${
                  isActive
                    ? 'bg-subtle text-accent font-semibold border-l-2 border-accent pl-2'
                    : 'text-ink-secondary hover:bg-slate-50 hover:text-ink'
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <span className={isActive ? 'text-accent' : 'text-ink-muted'}>{item.icon}</span>
                  <span>{NAV_LABEL[item.id]}</span>
                </div>
                {item.badge !== undefined && (
                  <span className={`text-[11px] font-mono font-bold px-1.5 rounded border ${item.badgeColor}`}>{item.badge}</span>
                )}
              </button>
            )
          })}
        </div>
      ))}
    </nav>
  )

  const footer = plantName && (
    <div className="p-3 border-t border-line bg-slate-50">
      <div className="flex items-center gap-2 px-1 text-[11px] text-ink-muted">
        <Factory className="w-3.5 h-3.5 text-ink-faint" />
        <span className="truncate">{plantName}</span>
      </div>
    </div>
  )

  return (
    <>
      {/* Desktop: fixed sidebar, unchanged */}
      <aside className="hidden lg:flex w-60 bg-white border-r border-line flex-col shrink-0 select-none no-print">
        <div className="h-14 px-4 border-b border-line flex items-center bg-white">{brand}</div>
        {nav}
        {footer}
      </aside>

      {/* Phone and tablet: slide-in panel over a dimmed backdrop */}
      {mobileOpen && (
        <div className="lg:hidden fixed inset-0 z-40 no-print" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="absolute inset-0 bg-slate-900/50" onClick={onMobileClose} />
          <aside className="absolute inset-y-0 left-0 w-72 max-w-[85vw] bg-white border-r border-line flex flex-col shadow-xl select-none">
            <div className="h-14 pl-4 pr-2 border-b border-line flex items-center justify-between">
              {brand}
              <button
                ref={closeButton}
                onClick={onMobileClose}
                className="w-[40px] h-[40px] rounded flex items-center justify-center text-ink-muted hover:bg-slate-50 hover:text-ink"
                aria-label="Close navigation menu"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            {nav}
            {footer}
          </aside>
        </div>
      )}
    </>
  )
}
