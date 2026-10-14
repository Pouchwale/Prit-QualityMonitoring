import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { Access, Action, CurrentUser, ModuleKey, Role } from '../types'
import { ApiError, api, clearTokens, errorText, hasSession, isSessionChange, login as apiLogin, logout as apiLogout, onUnauthorized } from './api'
import { sessionEnded, signOutIntent } from './routes'

interface AuthContextValue {
  user: CurrentUser | null
  loading: boolean
  /**
   * Set when the saved session could not be checked because the server was unreachable or failed
   * (not because it was refused): the tokens are kept and the app offers "Try again".
   */
  connectionError: string | null
  /** True when the user has at least `level` on the module. */
  can: (module: ModuleKey, level?: Exclude<Access, 'none'> | Action) => boolean
  /** Admin or Super Admin: every module, and the Manager and Worker accounts. */
  isAdmin: boolean
  /** Super Admin: every permission, and the only one who changes roles and permissions (Roles & Permissions). */
  isSuperAdmin: boolean
  login: (employeeId: string, password: string) => Promise<void>
  logout: () => Promise<void>
  /** Re-reads the signed-in user, so permission changes made by the Super Admin show up. */
  refresh: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export const isAdminRole = (role: Role | undefined) => role === 'ADMIN' || role === 'SUPER_ADMIN'

/**
 * The panel's name under "Quality Monitoring", for the signed-in user's role. Supervisor is
 * listed for when that role is added; any other role gets the neutral "Staff Portal".
 */
export function portalLabel(role: Role | 'SUPERVISOR' | undefined): string {
  switch (role) {
    case 'SUPER_ADMIN':
    case 'ADMIN':
      return 'Admin Panel'
    case 'MANAGER':
      return 'Manager Portal'
    case 'SUPERVISOR':
      return 'Supervisor Portal'
    default:
      return 'Staff Portal'
  }
}

/** How often an open session re-reads its permissions. The backend enforces them on every request anyway. */
const PERMISSION_REFRESH_MS = 60_000

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<CurrentUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [connectionError, setConnectionError] = useState<string | null>(null)
  // Who is signed in, for the cross-tab check below (which is set up once).
  const userId = useRef<string | null>(null)
  useEffect(() => {
    userId.current = user?.id ?? null
  }, [user])

  const refresh = useCallback(async () => {
    try {
      const me = await api.get<CurrentUser>('/api/auth/me')
      setConnectionError(null)
      if (me.role === 'WORKER') {
        clearTokens()
        setUser(null)
        return
      }
      setUser(me)
    } catch (err) {
      // A 401 clears the session through onUnauthorized. Other errors (server down, 5xx) keep the
      // tokens and the current view; with nobody shown yet, the app offers to try again.
      setConnectionError(err instanceof ApiError && err.status === 401 ? null : errorText(err))
    }
  }, [])

  useEffect(() => {
    onUnauthorized(() => {
      // Tell the sign-in page why it is shown, unless the user is signing out on purpose.
      if (!signOutIntent.active) sessionEnded.active = true
      setUser(null)
    })
    if (!hasSession()) {
      setLoading(false)
      return
    }
    refresh().finally(() => setLoading(false))
  }, [refresh])

  /*
   * Keeps tabs in step: signing out in another tab signs out here too, and when another tab signs
   * in (or someone else signs in there) this tab re-reads who is signed in. A different account
   * reloads the page so nothing loaded for the previous account stays on screen.
   */
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (!isSessionChange(e)) return
      if (!hasSession()) {
        setUser(null)
        return
      }
      const before = userId.current
      api
        .get<CurrentUser>('/api/auth/me')
        .then((me) => {
          if (before && me.id !== before) window.location.reload()
          else if (me.role !== 'WORKER') setUser(me)
        })
        .catch(() => {
          /* a 401 signs out through onUnauthorized; other errors keep the current view */
        })
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

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
    setConnectionError(null)
  }, [])

  const logout = useCallback(async () => {
    await apiLogout()
    setUser(null)
    setConnectionError(null)
  }, [])

  /**
   * Whether the user may do `level` in the module: view, create, edit or delete, or "manage" for any
   * of create, edit and delete. The server checks the same on every request.
   */
  const can = useCallback(
    (module: ModuleKey, level: Exclude<Access, 'none'> | Action = 'view') => {
      const actions = user?.actions?.[module]
      if (actions) return level === 'manage' ? actions.create || actions.edit || actions.delete : !!actions[level]
      // A server without the action matrix: the one-word summary.
      const access = user?.permissions?.[module] ?? 'none'
      return level === 'view' ? access !== 'none' : access === 'manage'
    },
    [user]
  )

  return (
    <AuthContext.Provider value={{ user, loading, connectionError, can, isAdmin: isAdminRole(user?.role), isSuperAdmin: user?.role === 'SUPER_ADMIN', login, logout, refresh }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}

/** Whether the signed-in user may change anything in this module (create, edit or delete). */
export function useCanManage(module: ModuleKey) {
  return useAuth().can(module, 'manage')
}

/**
 * Whether the signed-in user may activate or deactivate records (accounts, machines, check types, …):
 * the Super Admin only, never part of the permission matrix. The server refuses everyone else.
 */
export function useCanActivate() {
  return useAuth().user?.role === 'SUPER_ADMIN'
}

/** Shown on an active switch for everyone but the Super Admin. */
export const ACTIVATION_HINT = 'Only the Super Admin can activate or deactivate.'

/** Whether the signed-in user may do one action in the module. */
export function useCan(module: ModuleKey, action: Action) {
  return useAuth().can(module, action)
}

/** Each write action in the module, and whether any is allowed (e.g. to show an Actions column). */
export function useModuleActions(module: ModuleKey) {
  const { can } = useAuth()
  const canCreate = can(module, 'create')
  const canEdit = can(module, 'edit')
  const canDelete = can(module, 'delete')
  return { canCreate, canEdit, canDelete, canWrite: canCreate || canEdit || canDelete }
}

export const ROLE_LABEL: Record<Role, string> = {
  SUPER_ADMIN: 'Super Admin',
  ADMIN: 'Admin',
  MANAGER: 'Manager',
  WORKER: 'Worker'
}
