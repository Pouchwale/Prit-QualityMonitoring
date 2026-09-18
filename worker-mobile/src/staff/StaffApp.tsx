import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AppState, BackHandler, Platform, View } from 'react-native'
import type { Profile } from '../types'
import { getMe } from '../services/api'
import { StaffContext, type Route, type StaffContextValue, type TabKey } from './nav'
import { can as canDo, isAdmin as isAdminRole, isSuperAdmin as isSuperAdminRole, type Level } from './permissions'
import type { ModuleKey } from './types'
import { SCREENS } from './screens'
import { StaffTabBar } from './StaffTabBar'
import { Empty, Screen, ToastProvider } from './ui'

const TAB_ROOT: Record<TabKey, string> = {
  home: 'home',
  checks: 'checks',
  exceptions: 'exceptions',
  reports: 'reports',
  more: 'more'
}

/** How often an open session re-reads its permissions. The backend enforces them on every request anyway. */
const PERMISSION_REFRESH_MS = 60_000

let routeSeq = 0
const route = (name: string, params?: Record<string, unknown>): Route => ({ key: `${name}-${++routeSeq}`, name, params })

/**
 * The Admin, Super Admin and Manager part of the mobile app: the same modules as the web admin
 * panel, shown only when this account has access (and refused by the backend otherwise).
 */
export const StaffApp: React.FC<{ profile: Profile; onProfileChange: (p: Profile) => void; onLogout: () => Promise<void> }> = ({
  profile,
  onProfileChange,
  onLogout
}) => {
  const can = useCallback((module: ModuleKey, level: Level = 'view') => canDo(profile, module, level), [profile])

  const tabs = useMemo(() => {
    const list: { key: TabKey; label: string }[] = [{ key: 'home', label: 'Home' }]
    if (can('checks')) list.push({ key: 'checks', label: 'Checks' })
    if (can('exceptions')) list.push({ key: 'exceptions', label: 'Exceptions' })
    if (can('reports')) list.push({ key: 'reports', label: 'Reports' })
    list.push({ key: 'more', label: 'More' })
    return list
  }, [can])

  const [tab, setTab] = useState<TabKey>('home')
  const [stacks, setStacks] = useState<Record<TabKey, Route[]>>(() => ({
    home: [route('home')],
    checks: [route('checks')],
    exceptions: [route('exceptions')],
    reports: [route('reports')],
    more: [route('more')]
  }))

  // A tab that is no longer permitted (an Admin changed the access) falls back to Home.
  const activeTab = tabs.some((t) => t.key === tab) ? tab : 'home'
  const stack = stacks[activeTab]
  const current = stack[stack.length - 1]

  const refreshProfile = useCallback(async () => {
    try {
      onProfileChange(await getMe())
    } catch {
      // A 401 signs out through the session handler; other errors keep the current view.
    }
  }, [onProfileChange])

  useEffect(() => {
    const timer = setInterval(refreshProfile, PERMISSION_REFRESH_MS)
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') refreshProfile()
    })
    return () => {
      clearInterval(timer)
      sub.remove()
    }
  }, [refreshProfile])

  const nav = useRef<StaffContextValue | null>(null)
  const value: StaffContextValue = {
    profile,
    can,
    isAdmin: isAdminRole(profile),
    isSuperAdmin: isSuperAdminRole(profile),
    canGoBack: stack.length > 1,
    push: (name, params) => setStacks((s) => ({ ...s, [activeTab]: [...s[activeTab], route(name, params)] })),
    pop: () => setStacks((s) => (s[activeTab].length > 1 ? { ...s, [activeTab]: s[activeTab].slice(0, -1) } : s)),
    replace: (name, params) => setStacks((s) => ({ ...s, [activeTab]: [...s[activeTab].slice(0, -1), route(name, params)] })),
    switchTab: (next, target) => {
      setTab(next)
      // A link to the tab's own first screen (e.g. Checks with filters) replaces it instead of stacking a second copy.
      setStacks((s) => ({
        ...s,
        [next]: !target ? [route(TAB_ROOT[next])] : target.name === TAB_ROOT[next] ? [route(target.name, target.params)] : [route(TAB_ROOT[next]), route(target.name, target.params)]
      }))
    },
    refreshProfile,
    signOut: onLogout
  }
  nav.current = value

  // Android back button: back within the tab, then to Home, then leave the app.
  useEffect(() => {
    if (Platform.OS !== 'android') return
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      const n = nav.current!
      if (n.canGoBack) {
        n.pop()
        return true
      }
      if (activeTab !== 'home') {
        setTab('home')
        return true
      }
      return false
    })
    return () => sub.remove()
  }, [activeTab])

  const Component = SCREENS[current.name]

  return (
    <StaffContext.Provider value={value}>
      <ToastProvider>
        <View className="flex-1 bg-staff-bg">
          <View className="flex-1">
            {Component ? (
              <Component key={current.key} params={current.params ?? {}} />
            ) : (
              <Screen title="Not available">
                <Empty text="This screen is not available." icon="alert-circle-outline" />
              </Screen>
            )}
          </View>
          <StaffTabBar
            tabs={tabs}
            active={activeTab}
            onChange={(next) => {
              if (next === activeTab) {
                // Tapping the current tab goes back to its first screen in its default view,
                // dropping any filter a link opened it with (e.g. Home's "See all missed checks").
                setStacks((s) => ({ ...s, [next]: [route(TAB_ROOT[next])] }))
              } else {
                setTab(next)
              }
            }}
          />
        </View>
      </ToastProvider>
    </StaffContext.Provider>
  )
}
