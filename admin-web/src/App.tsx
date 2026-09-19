import React, { useCallback, useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { DashboardData, Settings } from './types'
import { api } from './lib/api'
import { dateKey } from './lib/format'
import { AuthProvider, useAuth } from './lib/auth'
import { ToastProvider } from './components/common/Toast'
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Sidebar, NAV_LABEL, NAV_ORDER, useCanOpen, type NavTab } from './components/layout/Sidebar'
import { LOGIN_PATH, NAV_PATH, checkPath, safeNext, signOutIntent, tabFromPath } from './lib/routes'
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
import { JobsPage } from './pages/admin/JobsPage'
import { WorkersPage } from './pages/admin/WorkersPage'
import { AssignmentsPage } from './pages/admin/AssignmentsPage'
import { ShiftsPage } from './pages/admin/ShiftsPage'
import { PlantCalendarPage } from './pages/admin/PlantCalendarPage'
import { AuditLogsPage } from './pages/admin/AuditLogsPage'
import { SettingsPage } from './pages/admin/SettingsPage'
import { ManagerAccessPage } from './pages/admin/ManagerAccessPage'
import { AccountPage } from './pages/admin/AccountPage'

/** Redirects to the first page this user may open (e.g. "/" or a page whose access was removed). */
const FirstAllowed: React.FC = () => {
  const canOpen = useCanOpen()
  return <Navigate to={NAV_PATH[NAV_ORDER.find(canOpen) ?? 'account']} replace />
}

/** A page the user may open, or a redirect to one they can. */
const Guard: React.FC<{ tab: NavTab; children: React.ReactNode }> = ({ tab, children }) => {
  const canOpen = useCanOpen()
  return canOpen(tab) ? <>{children}</> : <FirstAllowed />
}

/** A quality check's detail page, opened from Quality Checks, the Dashboard, Exceptions or Jobs. */
const CheckDetailRoute: React.FC = () => {
  const { checkId = '' } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const canOpen = useCanOpen()
  if (!(['checks', 'dashboard', 'exceptions', 'jobs'] as NavTab[]).some(canOpen)) return <FirstAllowed />
  // Back returns to where the check was opened; a bookmarked detail page goes to Quality Checks.
  const back = () => (location.key !== 'default' ? navigate(-1) : navigate(NAV_PATH.checks))
  return <QualityCheckDetailPage key={checkId} checkId={checkId} onBack={back} />
}

const NotFoundPage: React.FC = () => (
  <div className="max-w-md mx-auto mt-16 text-center space-y-2">
    <h1 className="text-lg font-bold text-ink">Page not found</h1>
    <p className="text-xs text-ink-muted">This address is not a page of the admin panel. It may have been mistyped or moved.</p>
    <Link to="/" className="inline-block mt-2 text-xs font-semibold text-accent hover:underline">
      Go to the start page
    </Link>
  </div>
)

const Shell: React.FC = () => {
  const { user, logout, can } = useAuth()
  const canOpen = useCanOpen()
  const navigateTo = useNavigate()
  const location = useLocation()
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

  // The page for the sidebar and header; a check's detail belongs to where it was opened from.
  const fromTab = (location.state as { from?: NavTab } | null)?.from
  const isDetail = /^\/quality-checks\/[^/]+/.test(location.pathname)
  const current: NavTab | null = isDetail ? (fromTab ?? 'checks') : tabFromPath(location.pathname)
  const title = isDetail ? 'Check Details' : current ? NAV_LABEL[current] : 'Page not found'

  // Every page starts at the top (the menu closes from its own link), and the browser tab names the page.
  useEffect(() => {
    document.querySelector('main')?.scrollTo({ top: 0 })
  }, [location.pathname])
  useEffect(() => {
    document.title = `${title} · Quality Monitoring`
  }, [title])

  if (!user) return null

  const navigate = (next: NavTab) => {
    if (canOpen(next)) navigateTo(NAV_PATH[next])
  }
  const viewCheck = (id: string) => navigateTo(checkPath(id), { state: { from: current ?? 'checks' } })

  return (
    <div className="app-shell flex h-screen bg-canvas text-ink font-sans antialiased overflow-hidden">
      <Sidebar
        currentTab={current}
        onSelectTab={closeMenu}
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
          pageTitle={title}
          missedCount={counts.missed}
          exceptionCount={counts.exceptions}
          onOpenAlerts={() => {
            const target = (counts.missed > 0 ? ['checks', 'exceptions', 'dashboard'] : ['exceptions', 'checks', 'dashboard']) as NavTab[]
            const allowed = target.find(canOpen)
            if (allowed) navigate(allowed)
          }}
          onOpenMenu={() => setMenuOpen(true)}
          onLogout={() => {
            signOutIntent.active = true
            return logout()
          }}
        />
        {/* overflow-x-hidden: a wide table scrolls inside its own container, never the whole page */}
        <main className="app-shell flex-1 overflow-y-auto overflow-x-hidden p-3 sm:p-5 lg:p-6">
          <Routes>
            <Route index element={<FirstAllowed />} />
            <Route path={NAV_PATH.dashboard} element={<Guard tab="dashboard"><DashboardPage onViewCheck={viewCheck} onNavigate={navigate} /></Guard>} />
            <Route path={NAV_PATH.checks} element={<Guard tab="checks"><QualityChecksPage onViewCheck={viewCheck} /></Guard>} />
            <Route path={`${NAV_PATH.checks}/:checkId`} element={<CheckDetailRoute />} />
            <Route path={NAV_PATH.jobs} element={<Guard tab="jobs"><JobsPage onViewCheck={viewCheck} /></Guard>} />
            <Route path={NAV_PATH.exceptions} element={<Guard tab="exceptions"><ExceptionsPage onViewCheck={viewCheck} /></Guard>} />
            <Route path={NAV_PATH.reports} element={<Guard tab="reports"><ReportsPage /></Guard>} />
            <Route path={NAV_PATH.machines} element={<Guard tab="machines"><MachinesPage /></Guard>} />
            <Route path={NAV_PATH.departments} element={<Guard tab="departments"><DepartmentsPage /></Guard>} />
            <Route path={NAV_PATH.parameters} element={<Guard tab="parameters"><ParametersPage /></Guard>} />
            <Route path={NAV_PATH.activities} element={<Guard tab="activities"><ActivitiesPage /></Guard>} />
            <Route path={NAV_PATH.calendar} element={<Guard tab="calendar"><PlantCalendarPage /></Guard>} />
            <Route path={NAV_PATH.schedules} element={<Guard tab="schedules"><SchedulesPage /></Guard>} />
            <Route path={NAV_PATH['monitoring-setup']} element={<Guard tab="monitoring-setup"><MonitoringSetupPage onNavigate={navigate} /></Guard>} />
            <Route path={NAV_PATH.workers} element={<Guard tab="workers"><WorkersPage /></Guard>} />
            <Route path={NAV_PATH.assignments} element={<Guard tab="assignments"><AssignmentsPage /></Guard>} />
            <Route path={NAV_PATH.shifts} element={<Guard tab="shifts"><ShiftsPage /></Guard>} />
            <Route path={NAV_PATH['audit-logs']} element={<Guard tab="audit-logs"><AuditLogsPage /></Guard>} />
            <Route path={NAV_PATH.settings} element={<Guard tab="settings"><SettingsPage onPlantNameChange={(name) => setPlantName(name)} /></Guard>} />
            <Route path={NAV_PATH.access} element={<Guard tab="access"><ManagerAccessPage /></Guard>} />
            <Route path={NAV_PATH.account} element={<AccountPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </main>
      </div>
    </div>
  )
}

/** Signed out: every page asks for sign-in first and comes back to it afterwards. */
const AppRoutes: React.FC = () => {
  const { user, loading } = useAuth()
  const location = useLocation()
  const [params] = useSearchParams()
  // The redirect below has read the sign-out flag by the time this runs.
  useEffect(() => {
    if (!user) signOutIntent.active = false
  }, [user])

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center text-xs text-ink-muted gap-2">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading…
      </div>
    )
  }

  return (
    <Routes>
      <Route path={LOGIN_PATH} element={user ? <Navigate to={safeNext(params.get('next'))} replace /> : <LoginPage />} />
      <Route
        path="*"
        element={
          user ? (
            <Shell />
          ) : (
            <Navigate
              to={
                location.pathname === '/' || signOutIntent.active
                  ? LOGIN_PATH
                  : `${LOGIN_PATH}?next=${encodeURIComponent(location.pathname + location.search)}`
              }
              replace
            />
          )
        }
      />
    </Routes>
  )
}

export const App: React.FC = () => (
  <BrowserRouter>
    <ToastProvider>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </ToastProvider>
  </BrowserRouter>
)

export default App
