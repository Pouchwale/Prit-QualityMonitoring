import type { RequestHandler } from 'express'
import { eq } from 'drizzle-orm'
import { db } from '../db/client'
import { managerPermissions } from '../db/schema'
import { HttpError } from './http'

/**
 * Roles and module permissions.
 *
 *  SUPER_ADMIN  full access, including Admin accounts
 *  ADMIN        full access to every module; manages Managers, Workers and manager permissions
 *  MANAGER      only the modules an Admin granted, each as "view" or "manage"
 *  WORKER       the worker app only
 *
 * Permissions live in the database (manager_permissions) and are read on every request,
 * so a change made by an Admin applies to the manager's next click, without signing out.
 */

export type Role = 'WORKER' | 'MANAGER' | 'ADMIN' | 'SUPER_ADMIN'

export const MODULES = [
  'dashboard',
  'checks',
  'exceptions',
  'reports',
  'machines',
  'parameters',
  'activities',
  'schedules',
  'shifts',
  'departments',
  'workers',
  'assignments',
  'audit_logs',
  'settings',
  'calendar'
] as const

export type Module = (typeof MODULES)[number]
export type Access = 'none' | 'view' | 'manage'
export type Permissions = Record<Module, Access>

export const MODULE_INFO: Record<Module, { label: string; viewOnly?: boolean; description: string }> = {
  dashboard: { label: 'Dashboard', viewOnly: true, description: 'Live status of today’s checks' },
  checks: { label: 'Quality Checks', description: 'All checks with values and evidence; manage creates test checks' },
  exceptions: { label: 'Exceptions', description: 'Worker exceptions; manage reviews and closes them' },
  reports: { label: 'Reports', viewOnly: true, description: 'Summaries, CSV export and the PDF report' },
  machines: { label: 'Machines', description: 'Machines and the check types on each' },
  parameters: { label: 'Parameters', description: 'Quality parameters and their limits' },
  activities: { label: 'Check Types', description: 'Check types, their parameters and evidence rules' },
  schedules: { label: 'Schedules', description: 'When checks are due' },
  shifts: { label: 'Shifts', description: 'Shift timings' },
  departments: { label: 'Departments', description: 'Departments' },
  workers: { label: 'Workers', description: 'Worker accounts' },
  assignments: { label: 'Machine Assignment', description: 'Which machines each worker handles' },
  audit_logs: { label: 'Audit Logs', viewOnly: true, description: 'Who changed what and when' },
  settings: { label: 'Settings', description: 'Plant settings' },
  calendar: { label: 'Plant Calendar', description: 'Plant closed, holiday and shutdown dates; manage marks and removes them' }
}

export const isAdminRole = (role: Role) => role === 'ADMIN' || role === 'SUPER_ADMIN'

const fill = (access: Access) => Object.fromEntries(MODULES.map((m) => [m, access])) as Permissions

/** The effective permissions of a user, read fresh from the database. */
export async function loadPermissions(userId: string, role: Role): Promise<Permissions> {
  if (isAdminRole(role)) return fill('manage')
  if (role !== 'MANAGER') return fill('none')

  const rows = await db.select().from(managerPermissions).where(eq(managerPermissions.userId, userId))
  const result = fill('none')
  for (const row of rows) {
    if (!(MODULES as readonly string[]).includes(row.module)) continue
    const module = row.module as Module
    // Manage always includes view; view-only modules have nothing to manage.
    result[module] = row.canManage && !MODULE_INFO[module].viewOnly ? 'manage' : row.canView || row.canManage ? 'view' : 'none'
  }
  return result
}

export const canView = (permissions: Permissions, module: Module) => permissions[module] !== 'none'
export const canManage = (permissions: Permissions, module: Module) => permissions[module] === 'manage'

const forbidden = () => new HttpError(403, 'You do not have permission for this action')

/** Allows the request when the user has at least `level` on the module. */
export const requireModule =
  (module: Module, level: 'view' | 'manage'): RequestHandler =>
  (req, _res, next) => {
    const p = req.user?.permissions
    if (!p) return next(forbidden())
    if (level === 'manage' ? canManage(p, module) : canView(p, module)) return next()
    next(forbidden())
  }

/** Allows the request when the user can view any of the modules. */
export const requireAnyView =
  (...modules: Module[]): RequestHandler =>
  (req, _res, next) => {
    const p = req.user?.permissions
    if (p && modules.some((m) => canView(p, m))) return next()
    next(forbidden())
  }

export const requireAdmin: RequestHandler = (req, _res, next) => {
  if (req.user && isAdminRole(req.user.role)) return next()
  next(new HttpError(403, 'Only an Admin can do this'))
}

/**
 * Guard for a master-data router such as /api/machines.
 *
 * Reading the list is allowed for anyone who can view a module that needs it, because pages
 * load these lists for their dropdowns: a manager with "Schedules" needs machine and shift
 * names even without the "Machines" module. The module's own page and every change still
 * require the module itself.
 */
export function masterData(owner: Module, readers: Module[]): RequestHandler {
  const read = requireAnyView(owner, ...readers)
  const write = requireModule(owner, 'manage')
  return (req, res, next) => (req.method === 'GET' ? read(req, res, next) : write(req, res, next))
}
