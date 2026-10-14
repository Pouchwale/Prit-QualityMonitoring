import type { RequestHandler } from 'express'
import { and, eq } from 'drizzle-orm'
import { db, type Transaction } from '../db/client'
import { rolePermissions, userPermissions } from '../db/schema'
import { HttpError } from './http'

/**
 * Roles and the permission matrix.
 *
 *  SUPER_ADMIN  everything, always; the only role that changes roles and permissions
 *               (routes/access.ts, PUT /api/users/:id/role) and the only one that activates or
 *               deactivates records (lib/activation.ts: never part of the matrix)
 *  ADMIN        the Admin role's permissions, plus any set for that Admin alone
 *  MANAGER      the Manager role's permissions, plus any set for that Manager alone
 *  WORKER       the worker app only: the Worker role's switchable app features (app_*); doing
 *               checks and reporting exceptions are always allowed; never an admin-panel module
 *
 * Each module has the actions that mean something for it (view, create, edit, delete, approve,
 * export; e.g. the dashboard can only be viewed). Every action is denied unless granted, and any
 * other action includes view. A user's own row for a module (user_permissions) replaces the role's
 * row for that module.
 *
 * Both are read from the database on every request, so a change by the Super Admin applies on the
 * user's next click, without signing out.
 */

export type Role = 'WORKER' | 'MANAGER' | 'ADMIN' | 'SUPER_ADMIN'

export const MODULES = [
  'dashboard',
  'checks',
  'jobs',
  'exceptions',
  'reports',
  'machines',
  'parameters',
  'activities',
  'schedules',
  'shifts',
  'departments',
  'workers',
  'audit_logs',
  'settings',
  'calendar',
  'performance',
  'shift_signin',
  'wifi_rule',
  // The worker app's switchable features (Worker role only).
  'app_jobs',
  'app_performance',
  'app_history'
] as const

export type Module = (typeof MODULES)[number]
export const ACTIONS = ['view', 'create', 'edit', 'delete', 'approve', 'export'] as const
export type Action = (typeof ACTIONS)[number]
export type WriteAction = Exclude<Action, 'view'>
/** What a user may do in each module. */
export type ActionSet = Record<Action, boolean>
export type ActionMatrix = Record<Module, ActionSet>

/** The older summary per module, still read by the mobile staff screens: manage = any write action. */
export type Access = 'none' | 'view' | 'manage'
export type Permissions = Record<Module | 'export', Access>

const ALL: Action[] = ['view', 'create', 'edit', 'delete']

export interface ModuleMeta {
  label: string
  description: string
  actions: Action[]
  /** panel: the admin panel (Admin, Manager); worker: a worker app feature (Worker). */
  audience: 'panel' | 'worker'
  /** Has an active switch: activating / deactivating its records is the Super Admin's alone. */
  activation?: boolean
  viewOnly?: boolean
  notes?: Partial<Record<Action, string>>
}

type ModuleDef = Omit<ModuleMeta, 'audience'> & { audience?: ModuleMeta['audience'] }

const DEFS: Record<Module, ModuleDef> = {
  dashboard: { label: 'Dashboard', description: 'Live status of today’s checks', actions: ['view'] },
  checks: {
    label: 'Quality Checks',
    description: 'All checks with values and evidence',
    actions: ['view', 'create', 'delete', 'export'],
    notes: { create: 'Create test checks', delete: 'Permanently delete checks and their evidence', export: 'Download the check list (CSV) and check reports' }
  },
  jobs: {
    label: 'Jobs',
    description: 'Jobs and their checks',
    actions: ALL,
    notes: { create: 'Plan jobs', edit: 'Edit, hand over and close jobs', delete: 'Permanently delete jobs and their checks' }
  },
  exceptions: {
    label: 'Exceptions',
    description: 'Worker exceptions',
    actions: ['view', 'edit', 'approve'],
    notes: { edit: 'Review: acknowledge, action taken', approve: 'Resolve (close) exceptions, or reopen a resolved one' }
  },
  reports: {
    label: 'Reports',
    description: 'Summaries and traceability reports',
    actions: ['view', 'edit', 'export'],
    notes: { edit: 'Report sharing settings, sending reports by email', export: 'Download reports: PDF, CSV and print' }
  },
  machines: { label: 'Machines', description: 'Machines and the check types on each', actions: ALL, activation: true },
  parameters: { label: 'Parameters', description: 'Quality parameters and their limits', actions: ALL, activation: true },
  activities: { label: 'Check Types', description: 'Check types, their parameters, evidence rules and reasons', actions: ALL, activation: true },
  schedules: { label: 'Schedules', description: 'When checks are due', actions: ALL, activation: true },
  shifts: { label: 'Shifts', description: 'Shift timings and worker break times', actions: ALL, activation: true },
  departments: {
    label: 'Departments',
    description: 'Departments, and the Department Configuration: the Item Code prefixes that decide a job’s department',
    actions: ALL,
    activation: true
  },
  workers: {
    label: 'Employee Management',
    description: 'Worker and staff accounts',
    // Disabling an account is deactivating it: the Super Admin's alone, so there is no Delete here.
    actions: ['view', 'create', 'edit'],
    activation: true,
    notes: {
      create: 'Add Worker accounts',
      edit: 'Edit accounts (an Admin: Workers and Managers; a Manager: Workers)'
    }
  },
  audit_logs: { label: 'Audit Logs', description: 'Who changed what and when', actions: ['view'] },
  settings: { label: 'Settings', description: 'Plant settings and notification devices', actions: ['view', 'edit'] },
  calendar: {
    label: 'Plant Calendar',
    description: 'Plant closed, holiday and shutdown dates, annual calendars and weekly rules',
    actions: [...ALL, 'approve'],
    notes: { approve: 'Approve an annual calendar so its dates apply' }
  },
  performance: {
    label: 'Worker Performance',
    description: 'Each worker’s checks and scores, weekly and overall',
    actions: ['view', 'export'],
    notes: { export: 'Download the weekly scores (Excel)' }
  },
  shift_signin: {
    label: 'Shift Sign-In',
    description: 'Who is signed in for their shift, and the sign-in rules',
    actions: ['view', 'edit'],
    notes: { view: 'Sign-in status and records', edit: 'Sign-in rules: reminders, auto logout, early sign-in' }
  },
  wifi_rule: {
    label: 'Company Wi-Fi',
    description: 'The Company Wi-Fi rule for check alerts',
    actions: ['view', 'edit'],
    notes: { view: 'The rule and when each phone was last on the company network', edit: 'Turn the rule on or off and change its timings' }
  },
  app_jobs: {
    label: 'Jobs in the app',
    description: 'Start, end and hand over jobs on a machine',
    actions: ['create', 'edit'],
    audience: 'worker',
    notes: { create: 'Start a job', edit: 'End a job, hand it over' }
  },
  app_performance: { label: 'My performance', description: 'The worker’s own checks and scores', actions: ['view'], audience: 'worker' },
  app_history: { label: 'My check history', description: 'The worker’s own past checks and their records', actions: ['view'], audience: 'worker' }
}

export const MODULE_INFO = Object.fromEntries(
  MODULES.map((m) => [m, { ...DEFS[m], audience: DEFS[m].audience ?? 'panel', viewOnly: DEFS[m].actions.length === 1 && DEFS[m].actions[0] === 'view' }])
) as Record<Module, ModuleMeta>

/** The modules a role's permissions are made of: admin-panel modules for Admin and Manager, app features for Worker. */
export const modulesFor = (role: Role) => MODULES.filter((m) => MODULE_INFO[m].audience === (role === 'WORKER' ? 'worker' : 'panel'))

export const isAdminRole = (role: Role) => role === 'ADMIN' || role === 'SUPER_ADMIN'
/** Roles whose permissions the Super Admin sets (the Super Admin always has everything). */
export const MATRIX_ROLES = ['ADMIN', 'MANAGER', 'WORKER'] as const
export type MatrixRole = (typeof MATRIX_ROLES)[number]

export const applies = (module: Module, action: Action) => MODULE_INFO[module].actions.includes(action)

const noActions = (): ActionSet => ({ view: false, create: false, edit: false, delete: false, approve: false, export: false })
const emptyMatrix = () => Object.fromEntries(MODULES.map((m) => [m, noActions()])) as ActionMatrix
const fullMatrix = () =>
  Object.fromEntries(MODULES.map((m) => [m, Object.fromEntries(ACTIONS.map((a) => [a, applies(m, a)])) as ActionSet])) as ActionMatrix

/** Keeps only the actions that apply to the module; any write includes view. */
export function normalize(module: Module, set: Partial<ActionSet>): ActionSet {
  const result = noActions()
  for (const a of ACTIONS) result[a] = !!set[a] && applies(module, a)
  // Any other action includes view (for app features without a view action there is nothing to add).
  if (ACTIONS.some((a) => a !== 'view' && result[a]) && applies(module, 'view')) result.view = true
  return result
}

const isModule = (value: string): value is Module => (MODULES as readonly string[]).includes(value)

type Db = Transaction | typeof db

/** A role's stored permissions (missing modules: nothing). */
export async function loadRoleMatrix(role: MatrixRole, tx: Db = db): Promise<ActionMatrix> {
  const rows = await tx.select().from(rolePermissions).where(eq(rolePermissions.role, role))
  const result = emptyMatrix()
  const own = new Set<string>(modulesFor(role))
  for (const r of rows) {
    if (!isModule(r.module) || !own.has(r.module)) continue
    result[r.module] = normalize(r.module, rowActions(r))
  }
  return result
}

const rowActions = (r: { canView: boolean; canCreate: boolean; canEdit: boolean; canDelete: boolean; canApprove: boolean; canExport: boolean }): ActionSet => ({
  view: r.canView,
  create: r.canCreate,
  edit: r.canEdit,
  delete: r.canDelete,
  approve: r.canApprove,
  export: r.canExport
})
const any = (s: ActionSet) => ACTIONS.some((a) => s[a])

/** One user's own rows: only the modules set for them. */
export async function loadUserOverrides(userId: string, tx: Db = db): Promise<Partial<ActionMatrix>> {
  const rows = await tx.select().from(userPermissions).where(eq(userPermissions.userId, userId))
  const result: Partial<ActionMatrix> = {}
  for (const r of rows) {
    if (!isModule(r.module)) continue
    result[r.module] = normalize(r.module, rowActions(r))
  }
  return result
}

/** Replaces a role's row for each module given. */
export async function saveRoleModules(role: MatrixRole, next: Partial<ActionMatrix>, tx: Transaction) {
  for (const m of modulesFor(role)) {
    const set = next[m]
    if (!set) continue
    const s = normalize(m, set)
    await tx.delete(rolePermissions).where(and(eq(rolePermissions.role, role), eq(rolePermissions.module, m)))
    if (!any(s)) continue
    await tx.insert(rolePermissions).values({
      role,
      module: m,
      canView: s.view,
      canManage: s.create || s.edit || s.delete || s.approve,
      canCreate: s.create,
      canEdit: s.edit,
      canDelete: s.delete,
      canApprove: s.approve,
      canExport: s.export,
      updatedAt: new Date()
    })
  }
}

/** Sets (an action set) or removes (null: back to the role's) a user's own row for each module given. */
export async function saveUserModules(userId: string, next: Partial<Record<Module, ActionSet | null>>, tx: Transaction) {
  for (const m of MODULES) {
    if (!(m in next)) continue
    await tx.delete(userPermissions).where(and(eq(userPermissions.userId, userId), eq(userPermissions.module, m)))
    const set = next[m]
    if (!set) continue
    const s = normalize(m, set)
    await tx.insert(userPermissions).values({
      userId,
      module: m,
      canView: s.view,
      canCreate: s.create,
      canEdit: s.edit,
      canDelete: s.delete,
      canApprove: s.approve,
      canExport: s.export,
      updatedAt: new Date()
    })
  }
}

/** Removes every permission set for one user alone (e.g. when their role changes). */
export async function clearUserModules(userId: string, tx: Db = db) {
  await tx.delete(userPermissions).where(eq(userPermissions.userId, userId))
}

/** What a user may do, read fresh from the database: their role's set with their own rows on top. */
export async function loadActions(userId: string, role: Role, tx: Db = db): Promise<ActionMatrix> {
  if (role === 'SUPER_ADMIN') return fullMatrix()
  if (role === 'WORKER') return loadRoleMatrix('WORKER', tx)
  if (role !== 'ADMIN' && role !== 'MANAGER') return emptyMatrix()
  const [base, own] = await Promise.all([loadRoleMatrix(role, tx), loadUserOverrides(userId, tx)])
  const panel = new Set<string>(modulesFor(role))
  return { ...base, ...Object.fromEntries(Object.entries(own).filter(([m]) => panel.has(m))) }
}

/**
 * The older one-word summary per module (none / view / manage = any write), read by the mobile
 * app's staff screens. `export` is kept for them: whether the user may export anything.
 */
export function summarize(actions: ActionMatrix): Permissions {
  const map = Object.fromEntries(
    MODULES.map((m) => {
      const a = actions[m]
      return [m, a.create || a.edit || a.delete || a.approve ? 'manage' : a.view || a.export ? 'view' : 'none']
    })
  ) as Permissions
  map.export = MODULES.some((m) => actions[m].export) ? 'view' : 'none'
  return map
}

/** Both forms of a user's permissions, for the session (lib/auth.ts) and /me. */
export async function loadAccess(userId: string, role: Role) {
  const actions = await loadActions(userId, role)
  return { actions, permissions: summarize(actions) }
}

/** The older summary only. */
export async function loadPermissions(userId: string, role: Role): Promise<Permissions> {
  return summarize(await loadActions(userId, role))
}

export const can = (actions: ActionMatrix | undefined, module: Module, action: Action) => !!actions?.[module]?.[action]
export const canView = (permissions: Permissions, module: Module) => permissions[module] !== 'none'
export const canManage = (permissions: Permissions, module: Module) => permissions[module] === 'manage'

const forbidden = () => new HttpError(403, 'You do not have permission for this action')

const METHOD_ACTION: Record<string, WriteAction> = { POST: 'create', PUT: 'edit', PATCH: 'edit', DELETE: 'delete' }

/**
 * The action a write request needs: from its method (POST create, PUT/PATCH edit, DELETE delete),
 * or edit when that action does not apply to the module (e.g. POST "send now" on Reports).
 */
export function actionFor(module: Module, method: string): Action {
  const fromMethod = METHOD_ACTION[method.toUpperCase()] ?? 'edit'
  if (applies(module, fromMethod)) return fromMethod
  if (applies(module, 'edit')) return 'edit'
  return MODULE_INFO[module].actions.find((a) => a !== 'view') ?? 'edit'
}

/**
 * Allows the request when the user may do `level` in the module. `manage` takes the action from
 * the request's method (actionFor); a route that is not what its method says names the action.
 */
export const requireModule =
  (module: Module, level: Action | 'manage'): RequestHandler =>
  (req, _res, next) => {
    const action = level === 'manage' ? actionFor(module, req.method) : level
    if (can(req.user?.actions, module, action)) return next()
    next(forbidden())
  }

/** Allows the request when the user can view any of the modules. */
export const requireAnyView =
  (...modules: Module[]): RequestHandler =>
  (req, _res, next) => {
    if (modules.some((m) => can(req.user?.actions, m, 'view'))) return next()
    next(forbidden())
  }

export const requireAdmin: RequestHandler = (req, _res, next) => {
  if (req.user && isAdminRole(req.user.role)) return next()
  next(new HttpError(403, 'Only an Admin can do this'))
}

/** Allows the request for the Super Admin only; everyone else, Admins included, gets 403 with `message`. */
export const requireSuperAdmin =
  (message = 'Only the Super Admin can do this'): RequestHandler =>
  (req, _res, next) =>
    req.user?.role === 'SUPER_ADMIN' ? next() : next(new HttpError(403, message))

/**
 * Guard for a master-data router such as /api/machines.
 *
 * Reading the list is allowed for anyone who can view a module that needs it, because pages
 * load these lists for their dropdowns: a manager with "Schedules" needs machine and shift
 * names even without the "Machines" module. The module's own page and every change still
 * require the module itself: create, edit or delete by the request's method.
 */
export function masterData(owner: Module, readers: Module[]): RequestHandler {
  const read = requireAnyView(owner, ...readers)
  const write = requireModule(owner, 'manage')
  return (req, res, next) => (req.method === 'GET' ? read(req, res, next) : write(req, res, next))
}
