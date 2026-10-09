import React, { useEffect } from 'react'
import { AlertOctagon, Building2, CalendarClock, CalendarOff, Clock3, Cpu, Factory, FileSpreadsheet, Gauge, History, LayoutDashboard, ShieldCheck, SlidersHorizontal, Tags, UserRound, Users, Workflow, X } from 'lucide-react'
import type { ModuleKey } from '../../types'
import { portalLabel, useAuth } from '../../lib/auth'
import { Link } from 'react-router-dom'
import { MONITORING_LABEL, MONITORING_TABS, NAV_PATH } from '../../lib/routes'
import { useDialogFocus } from '../../lib/useDialogFocus'

export type NavTab =
  | 'dashboard'
  | 'checks'
  | 'jobs'
  | 'exceptions'
  | 'reports'
  | 'performance'
  | 'machines'
  | 'departments'
  | 'department-config'
  | 'parameters'
  | 'activities'
  | 'schedules'
  | 'calendar'
  | 'workers'
  | 'shifts'
  | 'audit-logs'
  | 'access'
  | 'account'

/** Page names, also shown as the title in the compact mobile header. */
export const NAV_LABEL: Record<NavTab, string> = {
  dashboard: 'Dashboard',
  checks: 'Quality Checks',
  jobs: 'Jobs',
  exceptions: 'Exceptions',
  reports: 'Reports',
  performance: 'Worker Performance',
  parameters: 'Parameters',
  activities: 'Check Types',
  machines: 'Machines',
  schedules: 'Schedules',
  calendar: 'Plant Calendar',
  workers: 'Workers & Users',
  departments: 'Departments',
  'department-config': 'Department Configuration',
  shifts: 'Shifts',
  'audit-logs': 'Audit Logs',
  access: 'Manager Access',
  account: 'My Account'
}

/** The permission module behind each page. Manager Access (Super Admin only) and My Account are not modules. */
export const NAV_MODULE: Partial<Record<NavTab, ModuleKey>> = {
  dashboard: 'dashboard',
  checks: 'checks',
  // Jobs have their own module: view to follow them, manage to plan / hand over / close.
  jobs: 'jobs',
  exceptions: 'exceptions',
  reports: 'reports',
  performance: 'performance',
  parameters: 'parameters',
  activities: 'activities',
  machines: 'machines',
  schedules: 'schedules',
  calendar: 'calendar',
  workers: 'workers',
  departments: 'departments',
  // Item Code prefix -> department mappings: view to see them, manage (Departments) to change them.
  'department-config': 'departments',
  shifts: 'shifts',
  'audit-logs': 'audit_logs'
}

/** Pages in menu order, used to find where to land when the current page is not allowed. */
export const NAV_ORDER: NavTab[] = [
  'dashboard', 'checks', 'jobs', 'exceptions', 'reports', 'performance', 'parameters', 'activities', 'machines', 'schedules', 'calendar',
  'workers', 'departments', 'department-config', 'shifts', 'audit-logs', 'access', 'account'
]

/** Whether the signed-in user may open a page. */
export function useCanOpen() {
  const { can, isSuperAdmin } = useAuth()
  return (tab: NavTab) => {
    if (tab === 'account') return true
    // Only the Super Admin sets the Manager role's permissions (the backend refuses everyone else).
    if (tab === 'access') return isSuperAdmin
    const module = NAV_MODULE[tab]
    return module ? can(module) : false
  }
}

interface SidebarProps {
  /** The page being shown; null for an unknown address. */
  currentTab: NavTab | null
  /** A menu item was chosen (the link itself changes the page). */
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
  /** What the badge counts, read out after the number by screen readers. */
  badgeLabel?: string
  badgeColor?: string
  /** Shown instead of the page name, for an entry that stands for several pages. */
  label?: string
  /** The pages this entry covers; it is highlighted on any of them. Defaults to its own page. */
  matches?: NavTab[]
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
  const canOpen = useCanOpen()
  const { user } = useAuth()
  // Focus moves into the panel and stays there; Escape closes it; focus returns to the menu button.
  const panelRef = useDialogFocus<HTMLDivElement>(mobileOpen, onMobileClose)

  useEffect(() => {
    if (!mobileOpen) return
    // The panel is only ever open on small screens; close it if the window grows to desktop width.
    const desktop = window.matchMedia('(min-width: 1024px)')
    const onResize = () => desktop.matches && onMobileClose()
    desktop.addEventListener('change', onResize)
    return () => desktop.removeEventListener('change', onResize)
  }, [mobileOpen, onMobileClose])

  // Quality Monitoring is one entry for three pages (Overview, Checks, Jobs). It opens the first
  // one this account may see; the page itself offers the others as tabs.
  const monitoringTab = MONITORING_TABS.find(canOpen)
  const monitoringItem: NavItem[] = monitoringTab
    ? [
        {
          id: monitoringTab,
          label: MONITORING_LABEL,
          matches: [...MONITORING_TABS],
          icon: <LayoutDashboard className="w-4 h-4" />,
          badge: missedCount || undefined,
          badgeLabel: 'missed today',
          badgeColor: 'bg-missed-bg text-missed ring-missed-line'
        }
      ]
    : []

  const allGroups: { title: string; items: NavItem[] }[] = [
    {
      title: 'Monitoring',
      items: [
        ...monitoringItem,
        {
          id: 'exceptions',
          icon: <AlertOctagon className="w-4 h-4" />,
          badge: exceptionCount || undefined,
          badgeLabel: 'exceptions today',
          badgeColor: 'bg-exception-bg text-exception ring-exception-line'
        },
        { id: 'reports', icon: <FileSpreadsheet className="w-4 h-4" /> },
        { id: 'performance', icon: <Gauge className="w-4 h-4" /> }
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
        { id: 'departments', icon: <Building2 className="w-4 h-4" /> },
        { id: 'department-config', icon: <Tags className="w-4 h-4" /> },
        { id: 'shifts', icon: <Clock3 className="w-4 h-4" /> }
      ]
    },
    {
      title: 'System',
      items: [
        { id: 'access', icon: <ShieldCheck className="w-4 h-4" /> },
        { id: 'audit-logs', icon: <History className="w-4 h-4" /> },
        { id: 'account', icon: <UserRound className="w-4 h-4" /> }
      ]
    }
  ]
  // Only the pages this user may open; groups left empty are dropped.
  const groups = allGroups
    .map((group) => ({ ...group, items: group.items.filter((item) => canOpen(item.id)) }))
    .filter((group) => group.items.length > 0)

  const brand = (
    <div className="flex items-center gap-2.5 min-w-0">
      <img src="/logo.png" alt="" className="w-8 h-8 rounded-lg ring-1 ring-line" />
      <div className="min-w-0">
        <div className="text-[13.5px] font-semibold tracking-tight text-ink leading-none truncate">Quality Monitoring</div>
        <div className="text-[11.5px] text-ink-muted mt-1 truncate">{portalLabel(user?.role)}</div>
      </div>
    </div>
  )

  // Design: quiet group labels, 36px rows, a tinted pill with a blue edge marks the current page
  // (design-system/MASTER.md "Navigation").
  const nav = (
    <nav className="flex-1 py-3 px-3 space-y-5 overflow-y-auto" aria-label="Main">
      {groups.map((group) => (
        <div key={group.title}>
          <div className="px-2.5 pb-1.5 text-[10.5px] font-semibold text-ink-faint uppercase tracking-[0.08em]">{group.title}</div>
          <div className="space-y-0.5">
            {group.items.map((item) => {
              const isActive = (item.matches ?? [item.id]).includes(currentTab as NavTab)
              return (
                <Link
                  key={item.id}
                  to={NAV_PATH[item.id]}
                  onClick={() => onSelectTab(item.id)}
                  aria-current={isActive ? 'page' : undefined}
                  className={`group relative w-full flex items-center justify-between gap-2 h-10 lg:h-9 px-2.5 rounded-md text-[14px] lg:text-[13px] font-medium transition-colors ${
                    isActive ? 'bg-accent-soft text-accent-strong' : 'text-ink-secondary hover:bg-subtle hover:text-ink'
                  }`}
                >
                  {isActive && <span className="absolute left-0 top-2 bottom-2 w-[3px] rounded-r-full bg-accent" aria-hidden />}
                  <span className="flex items-center gap-2.5 min-w-0">
                    <span className={`shrink-0 transition-colors ${isActive ? 'text-accent' : 'text-ink-faint group-hover:text-ink-secondary'}`} aria-hidden>
                      {item.icon}
                    </span>
                    <span className="truncate">{item.label ?? NAV_LABEL[item.id]}</span>
                  </span>
                  {item.badge !== undefined && (
                    <span className={`min-w-5 h-5 px-1.5 inline-flex items-center justify-center rounded-full text-[11px] font-semibold tabular-nums ring-1 ring-inset ${item.badgeColor}`}>
                      {item.badge}
                      {item.badgeLabel && <span className="sr-only"> {item.badgeLabel}</span>}
                    </span>
                  )}
                </Link>
              )
            })}
          </div>
        </div>
      ))}
    </nav>
  )

  const footer = plantName && (
    <div className="p-3 border-t border-line">
      <div className="flex items-center gap-2 px-2.5 py-2 rounded-md bg-subtle text-[12px] text-ink-secondary">
        <Factory className="w-3.5 h-3.5 text-ink-faint shrink-0" aria-hidden />
        <span className="truncate font-medium">{plantName}</span>
      </div>
    </div>
  )

  return (
    <>
      {/* Desktop: fixed sidebar */}
      <aside className="hidden lg:flex w-[248px] bg-white border-r border-line flex-col shrink-0 select-none no-print">
        <div className="h-14 px-4 border-b border-line flex items-center">{brand}</div>
        {nav}
        {footer}
      </aside>

      {/* Phone and tablet: slide-in panel over a dimmed backdrop */}
      {mobileOpen && (
        <div className="lg:hidden fixed inset-0 z-40 no-print outline-none" role="dialog" aria-modal="true" aria-label="Navigation" ref={panelRef} tabIndex={-1}>
          <div className="absolute inset-0 bg-slate-900/45 backdrop-blur-[2px]" onClick={onMobileClose} />
          <aside className="absolute inset-y-0 left-0 w-72 max-w-[85vw] bg-white border-r border-line flex flex-col shadow-[var(--shadow-pop)] select-none">
            <div className="h-14 pl-4 pr-2 border-b border-line flex items-center justify-between">
              {brand}
              <button
                data-autofocus
                onClick={onMobileClose}
                className="w-[40px] h-[40px] rounded-md flex items-center justify-center text-ink-muted hover:bg-subtle hover:text-ink"
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
