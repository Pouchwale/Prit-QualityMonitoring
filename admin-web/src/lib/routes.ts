import type { NavTab } from '../components/layout/Sidebar'

/** The URL of every admin panel page. Bookmarks and shared links use these, so keep them stable. */
export const NAV_PATH: Record<NavTab, string> = {
  dashboard: '/dashboard',
  checks: '/quality-checks',
  jobs: '/jobs',
  exceptions: '/exceptions',
  reports: '/reports',
  performance: '/performance',
  parameters: '/parameters',
  activities: '/check-types',
  machines: '/machines',
  schedules: '/schedules',
  calendar: '/plant-calendar',
  workers: '/workers',
  departments: '/departments',
  'department-config': '/department-configuration',
  shifts: '/shifts',
  'audit-logs': '/audit-logs',
  access: '/roles-permissions',
  account: '/account'
}

/**
 * Quality Monitoring is one module with three views. Each keeps its own address, so old links
 * and bookmarks (/dashboard, /quality-checks, /jobs) still open the right tab.
 */
export const MONITORING_TABS = ['dashboard', 'checks', 'jobs'] as const

export type MonitoringTab = (typeof MONITORING_TABS)[number]

export const MONITORING_LABEL = 'Quality Monitoring'

export const MONITORING_TAB_LABEL: Record<MonitoringTab, string> = {
  dashboard: 'Overview',
  checks: 'Checks',
  jobs: 'Jobs'
}

export const isMonitoringTab = (tab: NavTab | null): tab is MonitoringTab =>
  !!tab && (MONITORING_TABS as readonly NavTab[]).includes(tab)

/** One quality check's detail page. */
export const checkPath = (checkId: string) => `${NAV_PATH.checks}/${encodeURIComponent(checkId)}`

export const LOGIN_PATH = '/login'

/** The page a path belongs to (a check's detail belongs to Quality Checks), or null when unknown. */
export function tabFromPath(pathname: string): NavTab | null {
  const clean = pathname.replace(/\/+$/, '') || '/'
  for (const [tab, path] of Object.entries(NAV_PATH) as [NavTab, string][]) {
    if (clean === path || clean.startsWith(`${path}/`)) return tab
  }
  return null
}

/**
 * Where to go after signing in: only a path inside this app, never another site. It must start
 * with a single "/"; "//host", any backslash ("/\host" is read as "//host" by browsers) and control
 * characters (browsers drop tabs and newlines, so "/<tab>/host" becomes "//host") are refused.
 */
export function safeNext(next: string | null): string {
  // eslint-disable-next-line no-control-regex
  if (!next || !/^\/(?!\/)/.test(next) || /[\\\u0000-\u001f]/.test(next) || next.startsWith(LOGIN_PATH)) return '/'
  return next
}

/**
 * Set when the user signs out on purpose: the sign-in page then opens without "?next", so the
 * next person to sign in starts on their own first page instead of the previous user's page.
 */
export const signOutIntent = { active: false }

/**
 * Set when the server ends a signed-in session (a 401 after sign-in: expired, password changed,
 * account disabled), so the sign-in page can say so. Only a message: the session itself is
 * already cleared by lib/api.ts.
 */
export const sessionEnded = { active: false }
