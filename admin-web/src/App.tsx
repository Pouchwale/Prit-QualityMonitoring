import React, { useCallback, useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { DashboardData, Settings } from './types'
import { api } from './lib/api'
import { dateKey } from './lib/format'
import { AuthProvider, useAuth } from './lib/auth'
import { ToastProvider } from './components/common/Toast'
import { Sidebar, NAV_LABEL, NAV_ORDER, useCanOpen, type NavTab } from './components/layout/Sidebar'
import { Topbar } from './components/layout/Topbar'
import { LoginPage } from './pages/LoginPage'

import { DashboardPage } from './pages/admin/DashboardPage'
import { QualityChecksPage } from './pages/admin/QualityChecksPage'
import { QualityCheckDetailPage } from './pages/admin/QualityCheckDetailPage'
import { ExceptionsPage } from './pages/admin/ExceptionsPage'
import { ReportsPage } from './pages/admin/ReportsPage'
import { MachinesPage } from './pages/admin/MachinesPage'
import { DepartmentsPage } from './pages/admin/DepartmentsPage'
import { ParametersPage } from './pages/admin/ParametersPage'
import { ActivitiesPage } from './pages/admin/ActivitiesPage'
import { SchedulesPage } from './pages/admin/SchedulesPage'
import { MonitoringSetupPage } from './pages/admin/MonitoringSetupPage'
import { WorkersPage } from './pages/admin/WorkersPage'
import { AssignmentsPage } from './pages/admin/AssignmentsPage'
import { ShiftsPage } from './pages/admin/ShiftsPage'
import { PlantCalendarPage } from './pages/admin/PlantCalendarPage'
import { AuditLogsPage } from './pages/admin/AuditLogsPage'
import { SettingsPage } from './pages/admin/SettingsPage'
import { ManagerAccessPage } from './pages/admin/ManagerAccessPage'
import { AccountPage } from './pages/admin/AccountPage'

const Shell: React.FC = () => {
  const { user, loading, logout, can } = useAuth()
  const canOpen = useCanOpen()
  const [tab, setTab] = useState<NavTab>('dashboard')
  const [checkId, setCheckId] = useState<string | null>(null)
  const [plantName, setPlantName] = useState('')
  const [counts, setCounts] = useState({ missed: 0, exceptions: 0 })
  const [menuOpen, setMenuOpen] = useState(false)
  const closeMenu = useCallback(() => setMenuOpen(false), [])

  // The header's missed/exception counts come from the dashboard summary.
  const seesCounts = can('dashboard') || can('checks') || can('exceptions')
  const refreshCounts = useCallback(async () => {
    if (!seesCounts) return setCounts({ missed: 0, exceptions: 0 })
    try {
      const data = await api.get<DashboardData>('/api/dashboard', { date: dateKey() })
      setCounts({ missed: data.kpi.missed, exceptions: data.kpi.exceptions })
    } catch {
      /* badges are best-effort */
    }
  }, [seesCounts])

  useEffect(() => {
    if (!user) return
    api
      .get<Settings>('/api/settings')
      .then((s) => {
        const plant = s.plant as { name?: string } | undefined
        if (plant?.name) setPlantName(plant.name)
      })
      .catch(() => undefined)
    refreshCounts()
    const timer = setInterval(refreshCounts, 60_000)
    return () => clearInterval(timer)
  }, [user, refreshCounts])

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center text-xs text-ink-muted gap-2">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading…
      </div>
    )
  }

  if (!user) return <LoginPage />

  // A page the user may not open (e.g. access was just removed) falls back to the first one they can.
  const current: NavTab = canOpen(tab) ? tab : (NAV_ORDER.find(canOpen) ?? 'account')

  const navigate = (next: NavTab) => {
    if (!canOpen(next)) return
    setCheckId(null)
    setTab(next)
    setMenuOpen(false)
    document.querySelector('main')?.scrollTo({ top: 0 })
  }

  let page: React.ReactNode
  if (checkId) {
    page = <QualityCheckDetailPage checkId={checkId} onBack={() => setCheckId(null)} />
  } else {
    switch (current) {
      case 'dashboard':
        page = <DashboardPage onViewCheck={setCheckId} onNavigate={navigate} />
        break
      case 'checks':
        page = <QualityChecksPage onViewCheck={setCheckId} />
        break
      case 'exceptions':
        page = <ExceptionsPage onViewCheck={setCheckId} />
        break
      case 'reports':
        page = <ReportsPage />
        break
      case 'machines':
        page = <MachinesPage />
        break
      case 'departments':
        page = <DepartmentsPage />
        break
      case 'parameters':
        page = <ParametersPage />
        break
      case 'activities':
        page = <ActivitiesPage />
        break
      case 'calendar':
        page = <PlantCalendarPage />
        break
      case 'schedules':
        page = <SchedulesPage />
        break
      case 'monitoring-setup':
        page = <MonitoringSetupPage onNavigate={navigate} />
        break
      case 'workers':
        page = <WorkersPage />
        break
      case 'assignments':
        page = <AssignmentsPage />
        break
      case 'shifts':
        page = <ShiftsPage />
        break
      case 'audit-logs':
        page = <AuditLogsPage />
        break
      case 'settings':
        page = <SettingsPage onPlantNameChange={(name) => setPlantName(name)} />
        break
      case 'access':
        page = <ManagerAccessPage />
        break
      case 'account':
        page = <AccountPage />
        break
    }
  }

  return (
    <div className="app-shell flex h-screen bg-canvas text-ink font-sans antialiased overflow-hidden">
      <Sidebar
        currentTab={current}
        onSelectTab={navigate}
        missedCount={counts.missed}
        exceptionCount={counts.exceptions}
        plantName={plantName}
        mobileOpen={menuOpen}
        onMobileClose={closeMenu}
      />
      <div className="app-shell flex-1 flex flex-col min-w-0 overflow-hidden">
        <Topbar
          user={user}
          plantName={plantName}
          pageTitle={checkId ? 'Check Details' : NAV_LABEL[current]}
          missedCount={counts.missed}
          exceptionCount={counts.exceptions}
          onOpenAlerts={() => {
            const target = (counts.missed > 0 ? ['checks', 'exceptions', 'dashboard'] : ['exceptions', 'checks', 'dashboard']) as NavTab[]
            const allowed = target.find(canOpen)
            if (allowed) navigate(allowed)
          }}
          onOpenMenu={() => setMenuOpen(true)}
          onLogout={logout}
        />
        {/* overflow-x-hidden: a wide table scrolls inside its own container, never the whole page */}
        <main className="app-shell flex-1 overflow-y-auto overflow-x-hidden p-3 sm:p-5 lg:p-6">{page}</main>
      </div>
    </div>
  )
}

export const App: React.FC = () => (
  <ToastProvider>
    <AuthProvider>
      <Shell />
    </AuthProvider>
  </ToastProvider>
)

export default App
