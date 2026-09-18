import { createContext, useContext } from 'react'
import type { Profile } from '../types'
import type { ModuleKey } from './types'
import type { Level } from './permissions'

/**
 * A small tab + stack navigator for the Admin/Manager part of the app (the worker part uses the
 * same hand-rolled approach). Each tab keeps its own stack of screens; Android's back button pops.
 */
export type TabKey = 'home' | 'checks' | 'exceptions' | 'reports' | 'more'

export interface Route {
  key: string
  name: string
  params?: Record<string, unknown>
}

export interface StaffContextValue {
  profile: Profile
  can: (module: ModuleKey, level?: Level) => boolean
  isAdmin: boolean
  isSuperAdmin: boolean
  push: (name: string, params?: Record<string, unknown>) => void
  pop: () => void
  /** Replaces the current screen, e.g. after creating a record. */
  replace: (name: string, params?: Record<string, unknown>) => void
  canGoBack: boolean
  switchTab: (tab: TabKey, route?: { name: string; params?: Record<string, unknown> }) => void
  /** Re-reads the signed-in user (permissions may have changed). */
  refreshProfile: () => Promise<void>
  signOut: () => Promise<void>
}

export const StaffContext = createContext<StaffContextValue | null>(null)

export function useStaff() {
  const ctx = useContext(StaffContext)
  if (!ctx) throw new Error('useStaff must be used inside StaffApp')
  return ctx
}

/** A screen of the staff app. */
export type StaffScreen<P = Record<string, unknown>> = React.FC<{ params: P }>
