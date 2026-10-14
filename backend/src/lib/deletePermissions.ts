import type { RequestHandler } from 'express'
import { db, type Transaction } from '../db/client'
import { HttpError } from './http'
import { loadActions, type Role } from './permissions'

/**
 * Permanent-delete permissions.
 *
 *  DELETE_USERS   the Super Admin only: it removes an account together with its history
 *                 (services/deletion.ts), so it is never granted
 *  DELETE_JOBS    the Delete action of Jobs in the permission matrix (lib/permissions.ts)
 *  DELETE_CHECKS  the Delete action of Quality Checks in the permission matrix
 *
 * The Super Admin always has all three. Admins and Managers have Delete Jobs / Checks only when the
 * Super Admin grants it, for their role or for them alone; Workers never. Like every permission
 * they are read from the database on every request, so a grant or a revoke applies on the next click.
 */
export const DELETE_PERMISSIONS = ['DELETE_USERS', 'DELETE_JOBS', 'DELETE_CHECKS'] as const
export type DeletePermission = (typeof DELETE_PERMISSIONS)[number]
export type DeletePermissions = Record<DeletePermission, boolean>

export const DELETE_PERMISSION_LABEL: Record<DeletePermission, string> = {
  DELETE_USERS: 'Delete Users',
  DELETE_JOBS: 'Delete Jobs',
  DELETE_CHECKS: 'Delete Checks'
}

/** The effective delete permissions of a user, read fresh from the database. */
export async function loadDeletePermissions(userId: string, role: Role, tx: Transaction | typeof db = db): Promise<DeletePermissions> {
  const actions = await loadActions(userId, role, tx)
  return {
    DELETE_USERS: role === 'SUPER_ADMIN',
    DELETE_JOBS: actions.jobs.delete,
    DELETE_CHECKS: actions.checks.delete
  }
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
