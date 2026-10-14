import { Router, type RequestHandler } from 'express'
import { z } from 'zod'
import { asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { auditLogs, rolePermissions, userPermissions, users } from '../db/schema'
import { idParam } from '../lib/validate'
import { HttpError, badRequest, notFound } from '../lib/http'
import { audit } from '../lib/audit'
import {
  ACTIONS,
  MATRIX_ROLES,
  MODULES,
  MODULE_INFO,
  loadActions,
  loadRoleMatrix,
  loadUserOverrides,
  normalize,
  requireSuperAdmin,
  saveRoleModules,
  saveUserModules,
  summarize,
  type ActionMatrix,
  type ActionSet,
  type MatrixRole,
  type Module
} from '../lib/permissions'
import { DELETE_PERMISSIONS, DELETE_PERMISSION_LABEL, loadDeletePermissions, type DeletePermission } from '../lib/deletePermissions'

/**
 * Roles & Permissions. Only the Super Admin may see or change them (everyone else gets 403):
 *  - each role's permissions (Admin, Manager): per module, view / create / edit / delete
 *  - one Admin's or Manager's own permissions for some modules, replacing their role's
 * Every change is saved in one transaction and written to the audit log with what changed.
 * Roles themselves are changed on Employee Management (PUT /api/users/:id/role).
 *
 * The module list is the one exception: every staff member may read it.
 */
export const accessRouter = Router()

/** The modules with the actions that apply to each, for building the permission screens. Open to all staff. */
accessRouter.get('/modules', (_req, res) => {
  res.json(MODULES.map((key) => ({ key, ...MODULE_INFO[key] })))
})

const onlySuperAdmin = requireSuperAdmin('Only the Super Admin can manage roles and permissions')
/** Super Admin only; a refused attempt to change permissions is written to the audit log (PERMISSION_CHANGE_DENIED). */
const superAdminOnly: RequestHandler = (req, res, next) =>
  onlySuperAdmin(req, res, (err?: unknown) => {
    if (err && req.method !== 'GET') {
      void audit(req, 'PERMISSION_CHANGE_DENIED', 'Access', null, { newValue: { method: req.method, path: req.originalUrl } }).catch(() => {})
    }
    next(err)
  })
const ROLE_NAME: Record<MatrixRole, string> = { ADMIN: 'Admin', MANAGER: 'Manager', WORKER: 'Worker' }

/**
 * Audit actions about roles and permissions: the Super Admin's history (GET /history). The audit log
 * page hides them from everyone else (routes/monitoring.ts).
 */
export const PERMISSION_AUDIT_ACTIONS = [
  'UPDATE_ROLE_PERMISSIONS',
  'UPDATE_USER_PERMISSIONS',
  'CHANGE_ROLE',
  'GRANT_DELETE_PERMISSION',
  'REVOKE_DELETE_PERMISSION',
  'PERMISSION_CHANGE_DENIED',
  'ROLE_CHANGE_DENIED',
  'ACTIVATION_DENIED'
]

// Every action of the matrix; an action that does not apply to a module is dropped by normalize().
const actionSet = z.object(Object.fromEntries(ACTIONS.map((a) => [a, z.boolean()])) as Record<(typeof ACTIONS)[number], z.ZodBoolean>).partial()
const roleParam = (value: unknown): MatrixRole => {
  const parsed = z.enum(MATRIX_ROLES).safeParse(String(value ?? '').toUpperCase())
  if (!parsed.success) throw badRequest('Permissions are set for the Admin and Manager roles only')
  return parsed.data
}

/** "View, Create" / "No access", for the audit log and the answers. */
const describe = (s: ActionSet | undefined) => {
  const on = ACTIONS.filter((a) => s?.[a]).map((a) => a[0].toUpperCase() + a.slice(1))
  return on.length ? on.join(', ') : 'No access'
}
const same = (a: ActionSet | undefined, b: ActionSet | undefined) => ACTIONS.every((x) => !!a?.[x] === !!b?.[x])

/** The accounts a role's permissions apply to. */
const accountsOf = (roles: MatrixRole[]) =>
  db
    .select({
      id: users.id,
      employeeId: users.employeeId,
      name: users.name,
      role: users.role,
      designation: users.designation,
      isActive: users.isActive,
      lastLoginAt: users.lastLoginAt
    })
    .from(users)
    .where(inArray(users.role, roles))
    .orderBy(asc(users.name))

// ---------------------------------------------------------------------------- Role permissions

/** Both roles' permissions, the number of accounts of each, and how many have their own permissions. */
accessRouter.get('/matrix', superAdminOnly, async (_req, res) => {
  const [admin, manager, worker, accounts, own] = await Promise.all([
    loadRoleMatrix('ADMIN'),
    loadRoleMatrix('MANAGER'),
    loadRoleMatrix('WORKER'),
    accountsOf(['ADMIN', 'MANAGER']),
    db.select({ userId: userPermissions.userId, n: sql<number>`count(*)::int` }).from(userPermissions).groupBy(userPermissions.userId)
  ])
  const ownCount = new Map(own.map((o) => [o.userId, o.n]))
  res.json({
    roles: { ADMIN: admin, MANAGER: manager, WORKER: worker },
    users: accounts.map((u) => ({ ...u, overrides: ownCount.get(u.id) ?? 0 }))
  })
})

/**
 * Changes a role's permissions for the modules sent; modules left out keep theirs. Every account of
 * the role gets the new permissions on its next request (users with their own row for a module keep it).
 */
accessRouter.put('/roles/:role', superAdminOnly, async (req, res, next) => {
  // Older app builds save the Manager role as one word per module at /roles/manager (below).
  if (req.params.role === 'manager' && req.body && 'permissions' in req.body) return next('route')
  const role = roleParam(req.params.role)
  const body = z.object({ modules: z.partialRecord(z.enum(MODULES), actionSet) }).parse(req.body)

  const result = await db.transaction(async (tx) => {
    // One save at a time, so two saves at the same moment cannot undo each other's changes.
    await tx.execute(sql`lock table ${rolePermissions} in share row exclusive mode`)
    const before = await loadRoleMatrix(role, tx)
    const next: ActionMatrix = { ...before }
    for (const m of MODULES) if (body.modules[m]) next[m] = normalize(m, body.modules[m]!)
    const changedModules = MODULES.filter((m) => !same(before[m], next[m]))
    if (!changedModules.length) return { matrix: before, changed: [] as string[] }
    await saveRoleModules(role, Object.fromEntries(changedModules.map((m) => [m, next[m]])), tx)
    const changed = changedModules.map((m) => `${MODULE_INFO[m].label}: ${describe(before[m])} → ${describe(next[m])}`)
    await audit(
      req,
      'UPDATE_ROLE_PERMISSIONS',
      'Role',
      role,
      {
        oldValue: { role: ROLE_NAME[role], permissions: Object.fromEntries(changedModules.map((m) => [m, before[m]])) },
        newValue: { role: ROLE_NAME[role], permissions: Object.fromEntries(changedModules.map((m) => [m, next[m]])), changed }
      },
      tx
    )
    return { matrix: next, changed }
  })
  res.json({ role, permissions: result.matrix, changed: result.changed })
})

/**
 * The history of role and permission changes, and of refused attempts, newest first: who, what,
 * before and after, when. The Super Admin only.
 */
accessRouter.get('/history', superAdminOnly, async (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200))
  res.json(
    await db
      .select()
      .from(auditLogs)
      .where(inArray(auditLogs.action, PERMISSION_AUDIT_ACTIONS))
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
      .limit(limit)
  )
})

// ---------------------------------------------------------------------------- One user's own permissions

/** An Admin or Manager account, or 404 / 400. */
async function matrixUser(id: string, tx: Pick<typeof db, 'select'> = db, lock = false) {
  const query = tx.select({ id: users.id, name: users.name, employeeId: users.employeeId, role: users.role, isActive: users.isActive }).from(users).where(eq(users.id, id))
  const [user] = lock ? await query.for('update') : await query
  if (!user) throw notFound('User')
  if (user.role !== 'ADMIN' && user.role !== 'MANAGER') {
    throw badRequest(user.role === 'SUPER_ADMIN' ? 'The Super Admin always has every permission' : 'Workers use the worker app only: they have no panel permissions')
  }
  return user as typeof user & { role: MatrixRole }
}

/** One Admin's or Manager's permissions: their role's, their own rows, and the result. */
accessRouter.get('/users/:id', superAdminOnly, async (req, res) => {
  const user = await matrixUser(idParam(req))
  const [role, overrides, effective] = await Promise.all([loadRoleMatrix(user.role), loadUserOverrides(user.id), loadActions(user.id, user.role)])
  res.json({ user, role, overrides, effective })
})

/**
 * Sets one user's own permissions for the modules sent: an action set replaces the role's for that
 * module, null goes back to the role's. Modules left out keep what they have.
 */
accessRouter.put('/users/:id', superAdminOnly, async (req, res) => {
  const id = idParam(req)
  if (id === req.user!.id) throw new HttpError(403, 'You cannot change your own permissions')
  const body = z.object({ modules: z.partialRecord(z.enum(MODULES), actionSet.nullable()) }).parse(req.body)

  const result = await db.transaction(async (tx) => {
    const user = await matrixUser(id, tx, true)
    const [role, before] = await Promise.all([loadRoleMatrix(user.role, tx), loadUserOverrides(id, tx)])
    const updates: Partial<Record<Module, ActionSet | null>> = {}
    const changed: string[] = []
    for (const m of MODULES) {
      if (!(m in body.modules)) continue
      const sent = body.modules[m]
      const next = sent ? normalize(m, sent) : null
      const was = before[m] ?? null
      if (next === null ? was === null : was !== null && same(was, next)) continue
      updates[m] = next
      changed.push(
        `${MODULE_INFO[m].label}: ${was ? describe(was) : `role (${describe(role[m])})`} → ${next ? describe(next) : `role (${describe(role[m])})`}`
      )
    }
    if (changed.length) {
      await saveUserModules(id, updates, tx)
      await audit(
        req,
        'UPDATE_USER_PERMISSIONS',
        'User',
        id,
        {
          oldValue: { user: `${user.name} (${user.employeeId})`, role: ROLE_NAME[user.role], own: before },
          newValue: { user: `${user.name} (${user.employeeId})`, role: ROLE_NAME[user.role], own: await loadUserOverrides(id, tx), changed }
        },
        tx
      )
    }
    return { user, role, changed, overrides: await loadUserOverrides(id, tx), effective: await loadActions(id, user.role, tx) }
  })
  res.json(result)
})

// ---------------------------------------------------------------------------- Older app builds

/**
 * The mobile app's staff screens before the permission matrix: the Manager role as one word per
 * module, and each Admin's delete permissions. Read and written through the matrix.
 */
accessRouter.get('/roles/manager', superAdminOnly, async (_req, res) => {
  const [matrix, managers] = await Promise.all([loadRoleMatrix('MANAGER'), accountsOf(['MANAGER'])])
  res.json({ permissions: summarize(matrix), managers })
})

/**
 * none / view / manage per module: "manage" keeps the write actions the role already has, or gives
 * create and edit (never a permanent delete of checks or jobs) when it had none.
 */
accessRouter.put('/roles/manager', superAdminOnly, async (req, res) => {
  const body = z.object({ permissions: z.partialRecord(z.enum(MODULES), z.enum(['none', 'view', 'manage'])) }).parse(req.body)
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`lock table ${rolePermissions} in share row exclusive mode`)
    const before = await loadRoleMatrix('MANAGER', tx)
    const next: ActionMatrix = { ...before }
    for (const m of MODULES) {
      const level = body.permissions[m]
      if (level === undefined) continue
      const had = before[m]
      const writes = had.create || had.edit || had.delete
      next[m] = normalize(
        m,
        level === 'none'
          ? {}
          : level === 'view'
            ? { view: true }
            : writes
              ? had
              : { view: true, create: true, edit: true, delete: m !== 'checks' && m !== 'jobs' }
      )
    }
    const changedModules = MODULES.filter((m) => !same(before[m], next[m]))
    if (changedModules.length) {
      await saveRoleModules('MANAGER', Object.fromEntries(changedModules.map((m) => [m, next[m]])), tx)
      const changed = changedModules.map((m) => `${MODULE_INFO[m].label}: ${describe(before[m])} → ${describe(next[m])}`)
      await audit(
        req,
        'UPDATE_ROLE_PERMISSIONS',
        'Role',
        'MANAGER',
        {
          oldValue: { role: 'Manager', permissions: Object.fromEntries(changedModules.map((m) => [m, before[m]])) },
          newValue: { role: 'Manager', permissions: Object.fromEntries(changedModules.map((m) => [m, next[m]])), changed }
        },
        tx
      )
    }
    return next
  })
  res.json({ permissions: summarize(result) })
})

accessRouter.get('/managers', superAdminOnly, async (_req, res) => {
  const [matrix, managers] = await Promise.all([loadRoleMatrix('MANAGER'), accountsOf(['MANAGER'])])
  const permissions = summarize(matrix)
  res.json(managers.map((m) => ({ ...m, permissions })))
})

accessRouter.put('/managers/:id', superAdminOnly, () => {
  throw new HttpError(410, 'Permissions are now set on Roles & Permissions in the web panel. Update the app.')
})

const GRANTABLE = ['DELETE_JOBS', 'DELETE_CHECKS'] as const
const DELETE_MODULE: Record<(typeof GRANTABLE)[number], Module> = { DELETE_JOBS: 'jobs', DELETE_CHECKS: 'checks' }

accessRouter.get('/admins', superAdminOnly, async (_req, res) => {
  const admins = await accountsOf(['ADMIN'])
  res.json(await Promise.all(admins.map(async (a) => ({ ...a, deletePermissions: await loadDeletePermissions(a.id, 'ADMIN') }))))
})

/** An Admin's Delete Jobs / Delete Checks: set as that Admin's own Delete action for the module. */
accessRouter.put('/admins/:id/delete-permissions', superAdminOnly, async (req, res) => {
  const id = idParam(req)
  const body = z.object({ permissions: z.partialRecord(z.enum(GRANTABLE), z.boolean()) }).parse(req.body)
  const result = await db.transaction(async (tx) => {
    const user = await matrixUser(id, tx, true)
    if (user.role !== 'ADMIN') throw badRequest('Delete permissions can only be given to Admin accounts')
    const before = await loadDeletePermissions(id, 'ADMIN', tx)
    const effective = await loadActions(id, 'ADMIN', tx)
    for (const p of GRANTABLE) {
      const want = body.permissions[p]
      if (want === undefined || want === before[p]) continue
      const m = DELETE_MODULE[p]
      await saveUserModules(id, { [m]: normalize(m, { ...effective[m], delete: want }) }, tx)
      await audit(
        req,
        want ? 'GRANT_DELETE_PERMISSION' : 'REVOKE_DELETE_PERMISSION',
        'User',
        id,
        {
          oldValue: { admin: `${user.name} (${user.employeeId})`, permission: p, granted: before[p] },
          newValue: { admin: `${user.name} (${user.employeeId})`, permission: p, label: DELETE_PERMISSION_LABEL[p as DeletePermission], granted: want }
        },
        tx
      )
    }
    return loadDeletePermissions(id, 'ADMIN', tx)
  })
  res.json({ id, deletePermissions: result, all: DELETE_PERMISSIONS })
})
