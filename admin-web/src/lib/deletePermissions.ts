import { useApi } from './useApi'

/**
 * Permanent-delete permissions of the signed-in user. The Super Admin always has all three; an
 * Admin has Delete Jobs/Checks when a Super Admin granted them, never Delete Users; Managers and
 * Workers have none.
 *
 * This only decides which Delete buttons are shown. The backend checks the permission again on
 * every request and answers 403 without it.
 */
export type DeletePermission = 'DELETE_USERS' | 'DELETE_JOBS' | 'DELETE_CHECKS'
export type DeletePermissions = Record<DeletePermission, boolean>
export type DeleteType = 'users' | 'jobs' | 'checks'

export const DELETE_PERMISSIONS: DeletePermission[] = ['DELETE_USERS', 'DELETE_JOBS', 'DELETE_CHECKS']
/** What a Super Admin can grant an Admin. Deleting users stays with the Super Admin. */
export const GRANTABLE_DELETE_PERMISSIONS: DeletePermission[] = ['DELETE_JOBS', 'DELETE_CHECKS']

export const DELETE_PERMISSION_LABEL: Record<DeletePermission, string> = {
  DELETE_USERS: 'Delete Users',
  DELETE_JOBS: 'Delete Jobs',
  DELETE_CHECKS: 'Delete Checks'
}

const NONE: DeletePermissions = { DELETE_USERS: false, DELETE_JOBS: false, DELETE_CHECKS: false }

export function useDeletePermissions(): DeletePermissions {
  const { data } = useApi<{ permissions: DeletePermissions }>('/api/deletions/permissions')
  return data?.permissions ?? NONE
}

/** What the server worked out would be deleted (services/deletion.ts). */
export interface DeleteImpactItem {
  id: string
  name: string
  details: { label: string; value: string }[]
  status: string
  dependents: { label: string; count: number }[]
  preserved: { label: string; count: number }[]
  files: number
  fileBytes: number
  blockers: string[]
}

export interface DeleteImpact {
  type: DeleteType
  permission: DeletePermission
  items: DeleteImpactItem[]
  missing: string[]
  totals: { records: number; files: number; fileBytes: number; dependents: { label: string; count: number }[] }
  blocked: number
  needsSecondConfirmation: boolean
  thresholds: { records: number; files: number }
  impactToken: string
}
