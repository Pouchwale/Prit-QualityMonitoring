import { Router } from 'express'
import { z } from 'zod'
import { asc, eq } from 'drizzle-orm'
import { db } from '../db/client'
import { managerPermissions, users } from '../db/schema'
import { idParam } from '../lib/validate'
import { badRequest, notFound } from '../lib/http'
import { audit } from '../lib/audit'
import { MODULES, MODULE_INFO, loadPermissions, requireAdmin, type Access, type Module } from '../lib/permissions'

/** Manager access control. Only Admins and Super Admins may see or change it. */
export const accessRouter = Router()

/** The modules that can be granted, with labels, for building the permission screen. */
accessRouter.get('/modules', (_req, res) => {
  res.json(MODULES.map((key) => ({ key, ...MODULE_INFO[key] })))
})

accessRouter.use(requireAdmin)

/** Every manager account with its current permissions. */
accessRouter.get('/managers', async (_req, res) => {
  const managers = await db
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

  res.json(await Promise.all(managers.map(async (m) => ({ ...m, permissions: await loadPermissions(m.id, 'MANAGER') }))))
})

const accessValue = z.enum(['none', 'view', 'manage'])

/** Updates a manager's permissions; modules left out keep their current access. Takes effect on the manager's next request. */
accessRouter.put('/managers/:id', async (req, res) => {
  const id = idParam(req)
  const body = z
    .object({ permissions: z.partialRecord(z.enum(MODULES), accessValue) })
    .parse(req.body)

  const [user] = await db.select({ id: users.id, role: users.role, name: users.name }).from(users).where(eq(users.id, id))
  if (!user) throw notFound('Manager')
  if (user.role !== 'MANAGER') throw badRequest('Permissions can only be set for Manager accounts')

  const before = await loadPermissions(id, 'MANAGER')
  const next = { ...before }
  for (const module of MODULES) {
    const requested = body.permissions[module]
    if (requested === undefined) continue
    // View-only modules (dashboard, reports, audit logs) have nothing to manage.
    next[module] = requested === 'manage' && MODULE_INFO[module].viewOnly ? 'view' : requested
  }

  await db.transaction(async (tx) => {
    await tx.delete(managerPermissions).where(eq(managerPermissions.userId, id))
    const rows = (Object.entries(next) as [Module, Access][])
      .filter(([, access]) => access !== 'none')
      .map(([module, access]) => ({ userId: id, module, canView: true, canManage: access === 'manage' }))
    if (rows.length) await tx.insert(managerPermissions).values(rows)
  })

  const changed = MODULES.filter((m) => before[m] !== next[m]).map((m) => `${MODULE_INFO[m].label}: ${before[m]} → ${next[m]}`)
  await audit(req, 'UPDATE_PERMISSIONS', 'User', id, {
    oldValue: before,
    newValue: { manager: user.name, permissions: next, changed }
  })
  res.json({ id, permissions: next })
})
