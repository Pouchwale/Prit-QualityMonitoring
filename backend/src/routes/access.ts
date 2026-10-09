import { Router } from 'express'
import { z } from 'zod'
import { asc, eq, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { rolePermissions, users } from '../db/schema'
import { idParam } from '../lib/validate'
import { HttpError, badRequest, notFound } from '../lib/http'
import { audit } from '../lib/audit'
import { MODULES, MODULE_INFO, loadRolePermissions, requireSuperAdmin, saveRolePermissions, type Permissions } from '../lib/permissions'
import {
  DELETE_PERMISSIONS,
  DELETE_PERMISSION_LABEL,
  GRANTABLE_DELETE_PERMISSIONS,
  loadDeletePermissions,
  saveDeletePermissions,
  type DeletePermissions
} from '../lib/deletePermissions'

/**
 * Access control. Only the Super Admin may see or change it:
 *  - Manager permissions: one set for the whole Manager role, the modules every Manager may view
 *    or manage. Admins and Managers get 403. (Admins still create, edit and disable Manager
 *    accounts on the Workers & Users page, routes/users.ts.)
 *  - Delete permissions: which permanent deletes each Admin may use.
 *
 * The module list is the one exception: every staff member may read it.
 */
export const accessRouter = Router()

/**
 * The modules that can be granted, with labels, for building the permission screen. Open to all
 * staff: the account screens use it to show a user their own access.
 */
accessRouter.get('/modules', (_req, res) => {
  res.json(MODULES.map((key) => ({ key, ...MODULE_INFO[key] })))
})

// ---------------------------------------------------------------------------- Manager role permissions

/** Only the Super Admin decides what Managers may use; Admins and Managers get 403. */
const managerAccess = requireSuperAdmin('Only the Super Admin can manage Manager permissions')

const accessValue = z.enum(['none', 'view', 'manage'])

/** Every Manager account: the people the Manager role's permissions apply to. */
const managerAccounts = () =>
  db
    .select({
      id: users.id,
      employeeId: users.employeeId,
      name: users.name,
      designation: users.designation,
      isActive: users.isActive,
      lastLoginAt: users.lastLoginAt
    })
    .from(users)
    .where(eq(users.role, 'MANAGER'))
    .orderBy(asc(users.name))

/** The Manager role's permissions, and the Manager accounts they apply to. */
accessRouter.get('/roles/manager', managerAccess, async (_req, res) => {
  const [permissions, managers] = await Promise.all([loadRolePermissions('MANAGER'), managerAccounts()])
  res.json({ permissions, managers })
})

/**
 * Changes the Manager role's permissions; modules left out keep their current access. Every
 * Manager gets the new access on their next request, without signing out.
 */
accessRouter.put('/roles/manager', managerAccess, async (req, res) => {
  const body = z
    .object({ permissions: z.partialRecord(z.enum(MODULES), accessValue) })
    .parse(req.body)

  const permissions = await db.transaction(async (tx) => {
    // One save at a time, so two saves at the same moment cannot undo each other's changes.
    // Reading the permissions (every Manager request does) is not blocked.
    await tx.execute(sql`lock table ${rolePermissions} in share row exclusive mode`)
    const before = await loadRolePermissions('MANAGER', tx)
    const next: Permissions = { ...before }
    for (const module of MODULES) {
      const requested = body.permissions[module]
      if (requested === undefined) continue
      // View-only modules (dashboard, reports, export, audit logs, performance) have nothing to manage.
      next[module] = requested === 'manage' && MODULE_INFO[module].viewOnly ? 'view' : requested
    }
    await saveRolePermissions('MANAGER', next, tx)

    const changed = MODULES.filter((m) => before[m] !== next[m]).map((m) => `${MODULE_INFO[m].label}: ${before[m]} → ${next[m]}`)
    await audit(req, 'UPDATE_ROLE_PERMISSIONS', 'Role', 'MANAGER', { oldValue: { permissions: before }, newValue: { permissions: next, changed } }, tx)
    return next
  })
  res.json({ permissions })
})

/**
 * Every Manager with their permissions, which are now the Manager role's for all of them. Kept
 * only for older app builds that still show one Manager at a time.
 */
accessRouter.get('/managers', managerAccess, async (_req, res) => {
  const [permissions, managers] = await Promise.all([loadRolePermissions('MANAGER'), managerAccounts()])
  res.json(managers.map((m) => ({ ...m, permissions })))
})

/** One Manager's own permissions no longer exist: older app builds that still save them are told to update. */
accessRouter.put('/managers/:id', managerAccess, () => {
  throw new HttpError(410, 'Manager permissions are now set once for the whole Manager role. Update the app.')
})

// ---------------------------------------------------------------------------- Admin delete permissions

/** Only the Super Admin grants or revokes permanent-delete permissions, and only to Admins. */
const deleteAccess = requireSuperAdmin('Only the Super Admin can manage delete permissions')

/** Every Admin account with its delete permissions. */
accessRouter.get('/admins', deleteAccess, async (_req, res) => {
  const admins = await db
    .select({ id: users.id, employeeId: users.employeeId, name: users.name, designation: users.designation, isActive: users.isActive })
    .from(users)
    .where(eq(users.role, 'ADMIN'))
    .orderBy(asc(users.name))
  res.json(await Promise.all(admins.map(async (a) => ({ ...a, deletePermissions: await loadDeletePermissions(a.id, 'ADMIN') }))))
})

/**
 * Grants or revokes an Admin's delete permissions; permissions left out keep their state.
 * Each change is written to the audit log as GRANT_DELETE_PERMISSION or REVOKE_DELETE_PERMISSION.
 * Delete Users cannot be granted (400): it belongs to the Super Admin only.
 */
accessRouter.put('/admins/:id/delete-permissions', deleteAccess, async (req, res) => {
  const id = idParam(req)
  const body = z.object({ permissions: z.partialRecord(z.enum(GRANTABLE_DELETE_PERMISSIONS), z.boolean()) }).parse(req.body)

  const [user] = await db
    .select({ id: users.id, role: users.role, name: users.name, employeeId: users.employeeId })
    .from(users)
    .where(eq(users.id, id))
  if (!user) throw notFound('Admin')
  // The Super Admin's own permissions are permanent; Managers and Workers can never be given them.
  if (user.role !== 'ADMIN') throw badRequest('Delete permissions can only be given to Admin accounts')

  const result = await db.transaction(async (tx) => {
    const before = await loadDeletePermissions(id, 'ADMIN', tx)
    const next: DeletePermissions = { ...before }
    for (const p of GRANTABLE_DELETE_PERMISSIONS) if (body.permissions[p] !== undefined) next[p] = body.permissions[p]!
    await saveDeletePermissions(id, next, tx)
    for (const p of DELETE_PERMISSIONS.filter((key) => before[key] !== next[key])) {
      await audit(
        req,
        next[p] ? 'GRANT_DELETE_PERMISSION' : 'REVOKE_DELETE_PERMISSION',
        'User',
        id,
        {
          oldValue: { admin: `${user.name} (${user.employeeId})`, permission: p, granted: before[p], permissions: before },
          newValue: { admin: `${user.name} (${user.employeeId})`, permission: p, label: DELETE_PERMISSION_LABEL[p], granted: next[p], permissions: next }
        },
        tx
      )
    }
    return next
  })
  res.json({ id, deletePermissions: result })
})
