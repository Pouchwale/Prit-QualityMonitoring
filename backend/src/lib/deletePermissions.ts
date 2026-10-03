import type { RequestHandler } from 'express'
import { and, eq, inArray } from 'drizzle-orm'
import { db, type Transaction } from '../db/client'
import { managerPermissions } from '../db/schema'
import { HttpError } from './http'
import type { Role } from './permissions'

/**
 * Permanent-delete permissions.
 *
 *  SUPER_ADMIN  always every delete permission; it cannot be revoked
 *  ADMIN        only the permissions a Super Admin granted to that Admin
 *  MANAGER      never (403)
 *  WORKER       never (403)
 *
 * They reuse the manager_permissions table (one row per user and key, `can_manage` = granted),
 * the same store as the Managers' module permissions, so there is no second permission system.
 * The keys below are not modules, so the module permission code ignores them.
 *
 * Like module permissions they are read from the database on every request, so a grant or a
 * revoke applies to the Admin's next click.
 */
export const DELETE_PERMISSIONS = ['DELETE_USERS', 'DELETE_JOBS', 'DELETE_CHECKS'] as const
export type DeletePermission = (typeof DELETE_PERMISSIONS)[number]
export type DeletePermissions = Record<DeletePermission, boolean>

/** The key stored in manager_permissions.module for each permission. */
export const DELETE_PERMISSION_KEY: Record<DeletePermission, string> = {
  DELETE_USERS: 'delete:users',
  DELETE_JOBS: 'delete:jobs',
  DELETE_CHECKS: 'delete:checks'
}
const KEYS = Object.values(DELETE_PERMISSION_KEY)

export const DELETE_PERMISSION_LABEL: Record<DeletePermission, string> = {
  DELETE_USERS: 'Delete Users',
  DELETE_JOBS: 'Delete Jobs',
  DELETE_CHECKS: 'Delete Checks'
}

const all = (value: boolean) => Object.fromEntries(DELETE_PERMISSIONS.map((p) => [p, value])) as DeletePermissions

/** The effective delete permissions of a user, read fresh from the database. */
export async function loadDeletePermissions(userId: string, role: Role, tx: Transaction | typeof db = db): Promise<DeletePermissions> {
  if (role === 'SUPER_ADMIN') return all(true)
  if (role !== 'ADMIN') return all(false)
  const rows = await tx
    .select({ module: managerPermissions.module, canManage: managerPermissions.canManage })
    .from(managerPermissions)
    .where(and(eq(managerPermissions.userId, userId), inArray(managerPermissions.module, KEYS)))
  const result = all(false)
  for (const p of DELETE_PERMISSIONS) result[p] = rows.some((r) => r.module === DELETE_PERMISSION_KEY[p] && r.canManage)
  return result
}

/** Replaces an Admin's stored delete permissions. */
export async function saveDeletePermissions(userId: string, next: DeletePermissions, tx: Transaction) {
  await tx.delete(managerPermissions).where(and(eq(managerPermissions.userId, userId), inArray(managerPermissions.module, KEYS)))
  const rows = DELETE_PERMISSIONS.filter((p) => next[p]).map((p) => ({
    userId,
    module: DELETE_PERMISSION_KEY[p],
    canView: false,
    canManage: true
  }))
  if (rows.length) await tx.insert(managerPermissions).values(rows)
}

/** Removes every delete permission of a user, e.g. when an Admin is given another role. */
export async function clearDeletePermissions(userId: string, tx: Transaction | typeof db = db) {
  await tx.delete(managerPermissions).where(and(eq(managerPermissions.userId, userId), inArray(managerPermissions.module, KEYS)))
}

/** Allows the request only when the signed-in user holds `permission`; otherwise 403. */
export const requireDeletePermission =
  (permission: DeletePermission): RequestHandler =>
  async (req, _res, next) => {
    try {
      const user = req.user
      if (!user) return next(new HttpError(403, 'You do not have permission for this action'))
      const granted = await loadDeletePermissions(user.id, user.role)
      if (granted[permission]) return next()
      next(new HttpError(403, `You do not have the ${DELETE_PERMISSION_LABEL[permission]} permission`))
    } catch (err) {
      next(err)
    }
  }
