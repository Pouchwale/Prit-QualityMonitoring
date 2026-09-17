import React, { createContext, useCallback, useContext, useEffect, useState } from 'react'
import type { Access, CurrentUser, ModuleKey, Role } from '../types'
import { api, clearTokens, hasSession, login as apiLogin, logout as apiLogout, onUnauthorized } from './api'

interface AuthContextValue {
  user: CurrentUser | null
  loading: boolean
  /** True when the user has at least `level` on the module. */
  can: (module: ModuleKey, level?: Exclude<Access, 'none'>) => boolean
  /** Admin or Super Admin: manages accounts and manager permissions. */
  isAdmin: boolean
  login: (employeeId: string, password: string) => Promise<void>
  logout: () => Promise<void>
  /** Re-reads the signed-in user, so permission changes made by an Admin show up. */
  refresh: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export const isAdminRole = (role: Role | undefined) => role === 'ADMIN' || role === 'SUPER_ADMIN'

/** How often an open session re-reads its permissions. The backend enforces them on every request anyway. */
const PERMISSION_REFRESH_MS = 60_000

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<CurrentUser | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const me = await api.get<CurrentUser>('/api/auth/me')
      if (me.role === 'WORKER') {
        clearTokens()
        setUser(null)
        return
      }
      setUser(me)
    } catch {
      /* a 401 clears the session through onUnauthorized; other errors keep the current view */
    }
  }, [])

  useEffect(() => {
    onUnauthorized(() => setUser(null))
    if (!hasSession()) {
      setLoading(false)
      return
    }
    refresh().finally(() => setLoading(false))
  }, [refresh])

  const signedIn = !!user
  useEffect(() => {
    if (!signedIn) return
    const timer = setInterval(refresh, PERMISSION_REFRESH_MS)
    const onFocus = () => document.visibilityState === 'visible' && refresh()
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onFocus)
    }
  }, [signedIn, refresh])

  const login = useCallback(async (employeeId: string, password: string) => {
    setUser(await apiLogin(employeeId, password))
  }, [])

  const logout = useCallback(async () => {
    await apiLogout()
    setUser(null)
  }, [])

  const can = useCallback(
    (module: ModuleKey, level: Exclude<Access, 'none'> = 'view') => {
      const access = user?.permissions?.[module] ?? 'none'
      return level === 'manage' ? access === 'manage' : access !== 'none'
    },
    [user]
  )

  return (
    <AuthContext.Provider value={{ user, loading, can, isAdmin: isAdminRole(user?.role), login, logout, refresh }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}

/** Whether the signed-in user may change things in this module. */
export function useCanManage(module: ModuleKey) {
  return useAuth().can(module, 'manage')
}

export const ROLE_LABEL: Record<Role, string> = {
  SUPER_ADMIN: 'Super Admin',
  ADMIN: 'Admin',
  MANAGER: 'Manager',
  WORKER: 'Worker'
}
