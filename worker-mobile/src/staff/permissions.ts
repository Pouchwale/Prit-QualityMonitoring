import type { Profile } from '../types'
import type { ModuleKey } from './types'

/**
 * What the signed-in Admin or Manager may open, from their module permissions (the same ones
 * the web panel uses). This only decides what the app shows; the backend checks every request.
 */
export type Level = 'view' | 'manage'

export const isAdmin = (profile: Profile) => profile.role === 'ADMIN' || profile.role === 'SUPER_ADMIN'
export const isSuperAdmin = (profile: Profile) => profile.role === 'SUPER_ADMIN'

export function can(profile: Profile, module: ModuleKey, level: Level = 'view') {
  const access = profile.permissions?.[module] ?? 'none'
  return level === 'manage' ? access === 'manage' : access !== 'none'
}

export const canAny = (profile: Profile, ...modules: ModuleKey[]) => modules.some((m) => can(profile, m))
