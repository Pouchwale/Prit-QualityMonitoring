import { Router, type Request } from 'express'
import { z } from 'zod'
import { and, asc, eq, ne, sql } from 'drizzle-orm'
import { db, type Transaction } from '../db/client'
import { departments, shifts, users } from '../db/schema'
import { idParam, optionalText, optionalUuid } from '../lib/validate'
import { HttpError, badRequest, notFound } from '../lib/http'
import { audit, snapshot } from '../lib/audit'
import { passwordColumns, verifyPassword, type AuthUser } from '../lib/auth'
import { decryptPassword } from '../lib/passwordVault'
import { clearUserModules, isAdminRole, requireAnyView, requireModule, type Role } from '../lib/permissions'
import { invalidateCheckGeneration } from '../services/checkGenerator'
import { sendTestNotification } from '../services/notifications'
import { recordShiftLogout, workerShiftStatuses } from '../services/workerShifts'
import { syncWorkerSchedules } from '../services/workerScheduleSync'
import { assertActivation, denyActivation, isSuperAdmin } from '../lib/activation'

export const usersRouter = Router()

const ROLES = ['WORKER', 'MANAGER', 'ADMIN', 'SUPER_ADMIN'] as const

const ROLE_NAME: Record<Role, string> = { WORKER: 'Worker', MANAGER: 'Manager', ADMIN: 'Admin', SUPER_ADMIN: 'Super Admin' }

/**
 * Whose accounts the signed-in user may edit or disable, on top of the Employee Management action
 * (create / edit / delete in the permission matrix, checked by each route):
 *  - Super Admin: any account
 *  - Admin: Managers and Workers
 *  - Manager: Workers only
 * Checked for both the account's current role and the role it is being given. Only the Super Admin
 * gives an account a role other than Worker (changeRole below).
 */
function assertCanManageAccount(actor: AuthUser, ...roles: Role[]) {
  const allowed: Role[] =
    actor.role === 'SUPER_ADMIN' ? [...ROLES] : actor.role === 'ADMIN' ? ['MANAGER', 'WORKER'] : actor.role === 'MANAGER' ? ['WORKER'] : []
  const blocked = roles.find((r) => !allowed.includes(r))
  if (blocked) {
    throw new HttpError(
      403,
      allowed.length ? `You cannot manage ${ROLE_NAME[blocked]} accounts` : 'You do not have permission for this action'
    )
  }
}

/** Employee Management in the permission matrix: create and edit accounts (disabling is activation: lib/activation.ts). */
const createAccounts = requireModule('workers', 'create')
const editAccounts = requireModule('workers', 'edit')

const ONLY_SUPER_ADMIN_ROLES = 'Only the Super Admin can change roles'

/**
 * Gives an account another role, inside the caller's transaction. The account and its history stay
 * (nothing is deleted or recreated); permissions set for the user alone are removed, as they were
 * set for the old role, and the user is signed out everywhere so the next sign-in uses the new role.
 * Super Admin only; never one's own role, and the last active Super Admin keeps theirs.
 */
/** Records a refused role change (ROLE_CHANGE_DENIED) and refuses it. */
async function denyRoleChange(req: Request, id: string | null, role: unknown): Promise<never> {
  await audit(req, 'ROLE_CHANGE_DENIED', 'User', id, { newValue: { requestedRole: role } }).catch(() => {})
  throw new HttpError(403, ONLY_SUPER_ADMIN_ROLES)
}

async function changeRole(req: Request, id: string, role: Role, tx: Transaction) {
  if (req.user!.role !== 'SUPER_ADMIN') throw new HttpError(403, ONLY_SUPER_ADMIN_ROLES)
  if (id === req.user!.id) throw new HttpError(403, 'You cannot change your own role')
  const [before] = await tx.select().from(users).where(eq(users.id, id)).for('update')
  if (!before) throw notFound('User')
  if (before.role === role) return { before, changed: false }
  if (before.role === 'SUPER_ADMIN') {
    // The other Super Admins are locked too, so two demotions at the same moment cannot leave none.
    const others = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.role, 'SUPER_ADMIN'), eq(users.isActive, true), ne(users.id, id)))
      .for('update')
    if (!others.length) throw badRequest('At least one active Super Admin must remain')
  }
  await tx
    .update(users)
    .set({ role, tokenVersion: sql`${users.tokenVersion} + 1` })
    .where(eq(users.id, id))
  await clearUserModules(id, tx)
  await audit(
    req,
    'CHANGE_ROLE',
    'User',
    id,
    {
      oldValue: { user: `${before.name} (${before.employeeId})`, role: before.role },
      newValue: { user: `${before.name} (${before.employeeId})`, role, change: `${ROLE_NAME[before.role]} → ${ROLE_NAME[role]}` }
    },
    tx
  )
  return { before, changed: true }
}

/** An optional email (leave decisions, leave requests for approvers): empty clears it. */
const optionalEmail = z
  .union([z.literal(''), z.string().trim().max(200).email('Invalid email address'), z.null()])
  .transform((v) => v || null)

const base = {
  employeeId: z.string().trim().min(1, 'Employee ID is required').max(40),
  name: z.string().trim().min(1, 'Name is required').max(120),
  role: z.enum(ROLES).default('WORKER'),
  designation: optionalText(100),
  departmentId: optionalUuid,
  shiftId: optionalUuid,
  phone: optionalText(30),
  email: optionalEmail.optional(),
  workerQualityRole: z.enum(['IPQC', 'QC', 'BOTH']).default('IPQC'),
  isActive: z.boolean().default(true),
  appAccess: z.boolean().default(true),
}

const createInput = z.object({ ...base, password: z.string().min(6, 'Password must be at least 6 characters') })
/**
 * An update changes only the fields it sends: a field left out keeps its stored value, so a screen
 * or app version that does not know a field (e.g. the worker's quality role) can never reset it, and
 * never re-enables a disabled account by leaving out isActive.
 */
const updateInput = z.object({
  employeeId: base.employeeId.optional(),
  name: base.name.optional(),
  role: z.enum(ROLES).optional(),
  designation: optionalText(100).optional(),
  departmentId: z.union([z.uuid(), z.literal(''), z.null()]).optional().transform((v) => (v === undefined ? undefined : v || null)),
  shiftId: z.union([z.uuid(), z.literal(''), z.null()]).optional().transform((v) => (v === undefined ? undefined : v || null)),
  phone: optionalText(30).optional(),
  email: optionalEmail.optional(),
  workerQualityRole: z.enum(['IPQC', 'QC', 'BOTH']).optional(),
  isActive: z.boolean().optional(),
  appAccess: z.boolean().optional(),
  password: z
    .string()
    .optional()
    .transform((v) => (v ? v : undefined))
    .refine((v) => v === undefined || v.length >= 6, 'Password must be at least 6 characters')
})

const publicColumns = {
  id: users.id,
  employeeId: users.employeeId,
  name: users.name,
  role: users.role,
  workerQualityRole: users.workerQualityRole,
  designation: users.designation,
  departmentId: users.departmentId,
  shiftId: users.shiftId,
  phone: users.phone,
  email: users.email,
  isActive: users.isActive,
  appAccess: users.appAccess,
  lastLoginAt: users.lastLoginAt,
  createdAt: users.createdAt
}

// Pages that filter or assign by worker read this list; only Admins see non-worker accounts.
usersRouter.get('/', requireAnyView('workers', 'schedules', 'checks', 'jobs', 'exceptions', 'reports'), async (req, res) => {
  const requested = z.enum(ROLES).optional().parse(req.query.role)
  const role = isAdminRole(req.user!.role) ? requested : 'WORKER'
  if (!isAdminRole(req.user!.role) && requested && requested !== 'WORKER') return res.json([])
  const rows = await db
    .select({ ...publicColumns, departmentName: departments.name, shiftName: shifts.name })
    .from(users)
    .leftJoin(departments, eq(users.departmentId, departments.id))
    .leftJoin(shifts, eq(users.shiftId, shifts.id))
    .where(role ? eq(users.role, role) : undefined)
    .orderBy(asc(users.name))
  res.json(rows)
})

usersRouter.post('/', createAccounts, async (req, res) => {
  const { password, ...data } = createInput.parse(req.body)
  // Giving a new account a staff role is a role change: the Super Admin's alone.
  if (data.role !== 'WORKER' && req.user!.role !== 'SUPER_ADMIN') {
    await audit(req, 'ROLE_CHANGE_DENIED', 'User', null, { newValue: { requestedRole: data.role, newAccount: data.employeeId } }).catch(() => {})
    throw new HttpError(403, 'Only the Super Admin can create Manager or Admin accounts')
  }
  // A new account is active; creating one disabled is deactivating it.
  await assertActivation(req, 'User', null, true, data.isActive)
  assertCanManageAccount(req.user!, data.role)
  const [row] = await db
    .insert(users)
    .values({ ...data, ...(await passwordColumns(password)) })
    .returning(publicColumns)
  invalidateCheckGeneration()
  await audit(req, 'CREATE_USER', 'User', row.id, { newValue: row })
  res.status(201).json(row)
})

usersRouter.put('/:id', editAccounts, async (req, res) => {
  const id = idParam(req)
  const { password, ...sent } = updateInput.parse(req.body)
  const [before] = await db.select().from(users).where(eq(users.id, id))
  if (!before) throw notFound('User')
  // Fields not sent keep their stored values (optionalText turns a missing value into null, so the
  // request body decides which fields were sent).
  const body = (req.body ?? {}) as Record<string, unknown>
  const pick = <K extends keyof typeof sent>(key: K) => (key in body && sent[key] !== undefined ? sent[key] : before[key as keyof typeof before])
  const data = {
    employeeId: pick('employeeId') as string,
    name: pick('name') as string,
    role: pick('role') as Role,
    designation: pick('designation') as string | null,
    departmentId: pick('departmentId') as string | null,
    shiftId: pick('shiftId') as string | null,
    phone: pick('phone') as string | null,
    email: pick('email') as string | null,
    workerQualityRole: pick('workerQualityRole') as 'IPQC' | 'QC' | 'BOTH',
    isActive: pick('isActive') as boolean,
    appAccess: pick('appAccess') as boolean
  }
  const roleChange = data.role !== before.role
  if (roleChange && req.user!.role !== 'SUPER_ADMIN') await denyRoleChange(req, id, data.role)
  // Disabling or enabling an account is the Super Admin's alone.
  await assertActivation(req, 'User', id, before.isActive, data.isActive)
  assertCanManageAccount(req.user!, before.role, data.role)
  if (password !== undefined) {
    // The Super Admin changes their own password in My Account, which asks for the current one.
    if (id === req.user!.id) {
      if (req.user!.role !== 'SUPER_ADMIN') throw new HttpError(403, 'Only the Super Admin can change passwords')
      throw badRequest('Change your own password in My Account')
    }
    // Only the Super Admin may set or reset another user's password.
    if (req.user!.role !== 'SUPER_ADMIN') throw new HttpError(403, "Only the Super Admin can change another user's password")
  }
  if (id === req.user!.id && (!data.isActive || data.role !== before.role)) {
    throw badRequest('You cannot disable your own account or change your own role')
  }

  // Changing the password or disabling the account signs the user out everywhere. Turning off
  // mobile app access signs a Worker out; staff keep their web session, and their mobile session
  // is refused on its next request (lib/auth.ts).
  const signOut =
    password !== undefined || (before.isActive && !data.isActive) || (before.role === 'WORKER' && before.appAccess && !data.appAccess)
  // A new shift must be one that is in use (an inactive shift has no checks).
  const shiftChange = data.shiftId !== before.shiftId
  if (shiftChange && data.shiftId) {
    const [shift] = await db.select({ isActive: shifts.isActive }).from(shifts).where(eq(shifts.id, data.shiftId))
    if (!shift) throw badRequest('The chosen shift does not exist')
    if (!shift.isActive) throw badRequest('The chosen shift is inactive. Choose an active shift.')
  }
  const passwordSet = password ? await passwordColumns(password) : {}
  let scheduleSync = { schedules: 0, removedUpcomingChecks: 0 }
  // One transaction: a role change (Super Admin only, audited as CHANGE_ROLE), the other fields and,
  // for a new shift, the worker's Check Schedules (services/workerScheduleSync.ts) are saved
  // together or not at all.
  const row = await db.transaction(async (tx) => {
    if (roleChange) await changeRole(req, id, data.role, tx)
    const [row] = await tx
      .update(users)
      .set({
        ...data,
        ...passwordSet,
        ...(signOut ? { tokenVersion: sql`${users.tokenVersion} + 1` } : {})
      })
      .where(eq(users.id, id))
      .returning(publicColumns)
    await audit(req, password ? 'UPDATE_USER_AND_PASSWORD' : 'UPDATE_USER', 'User', id, { oldValue: snapshot(before), newValue: row }, tx)
    if (shiftChange) {
      try {
        scheduleSync = await syncWorkerSchedules(tx, req, row, data.shiftId)
      } catch (err) {
        console.error(JSON.stringify({ event: 'worker_schedule_sync_failed', workerId: id, shiftId: data.shiftId, error: err instanceof Error ? err.message : String(err) }))
        throw err
      }
    }
    return row
  })
  // Signed out everywhere (a role change does that too): the worker's shift sign-in ends now, or
  // the dashboard keeps showing "Signed in" until the shift ends.
  if ((signOut || roleChange) && before.role === 'WORKER') await recordShiftLogout(id)
  invalidateCheckGeneration()
  // scheduleSync: how many Check Schedules moved to the new shift, for the confirmation message.
  res.json({ ...row, scheduleSync })
})

/**
 * Promotes or demotes an account (Employee Management, one click): Super Admin only. The account,
 * its history and its sign-in details stay; see changeRole.
 */
usersRouter.put('/:id/role', async (req, res) => {
  const id = idParam(req)
  if (req.user!.role !== 'SUPER_ADMIN') await denyRoleChange(req, id, (req.body as { role?: unknown } | undefined)?.role)
  const { role } = z.object({ role: z.enum(ROLES) }).parse(req.body)
  const { before, changed } = await db.transaction((tx) => changeRole(req, id, role, tx))
  if (changed && before.role === 'WORKER') await recordShiftLogout(id)
  if (changed) invalidateCheckGeneration()
  const [row] = await db.select(publicColumns).from(users).where(eq(users.id, id))
  res.json({ ...row, previousRole: before.role, changed })
})

/**
 * Each worker's shift sign-in: on shift or not, signed in or not, when the session ends
 * automatically, and the login reminders sent this shift (services/workerShifts.ts).
 */
usersRouter.get('/shift-status', requireModule('shift_signin', 'view'), async (_req, res) => {
  res.json(await workerShiftStatuses())
})

/** Sends a test notification to the worker's phones so the admin can verify the setup. */
usersRouter.post('/:id/test-notification', requireModule('workers', 'edit'), async (req, res) => {
  const id = idParam(req)
  const [user] = await db.select().from(users).where(eq(users.id, id))
  if (!user) throw notFound('User')

  const result = await sendTestNotification(id)
  await audit(req, 'TEST_NOTIFICATION', 'User', id, { newValue: result })
  // With no registered device, say what the worker's device last reported so the admin knows why.
  res.json({ ...result, lastStatus: user.alertStatus ?? null })
})

/**
 * Shows a user's password. Super Admin only, and the Super Admin must confirm with their own
 * password each time. Every view is written to the audit log (without the password).
 */
usersRouter.post('/:id/password/reveal', async (req, res) => {
  if (req.user!.role !== 'SUPER_ADMIN') throw new HttpError(403, "Only the Super Admin can view other users' passwords")
  const id = idParam(req)
  const { confirmPassword } = z.object({ confirmPassword: z.string().min(1, 'Enter your password to confirm') }).parse(req.body)

  const [me] = await db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, req.user!.id))
  if (!me || !(await verifyPassword(confirmPassword, me.passwordHash))) {
    await audit(req, 'VIEW_PASSWORD_DENIED', 'User', id, { newValue: { reason: 'wrong confirmation password' } })
    throw new HttpError(400, 'Your password is wrong')
  }

  const [user] = await db
    .select({ id: users.id, name: users.name, employeeId: users.employeeId, passwordEncrypted: users.passwordEncrypted })
    .from(users)
    .where(eq(users.id, id))
  if (!user) throw notFound('User')

  const password = decryptPassword(user.passwordEncrypted)
  await audit(req, 'VIEW_PASSWORD', 'User', id, { newValue: { user: `${user.name} (${user.employeeId})`, available: password !== null } })
  res.json({ available: password !== null, password })
})

/** Users are never hard-deleted so check history keeps the worker's name. */
/** Disables an account (deactivating: the Super Admin only). */
usersRouter.delete('/:id', async (req, res) => {
  const id = idParam(req)
  if (!isSuperAdmin(req)) await denyActivation(req, 'User', id, { to: false })
  if (id === req.user!.id) throw badRequest('You cannot disable your own account')
  const [before] = await db.select().from(users).where(eq(users.id, id))
  if (!before) throw notFound('User')
  assertCanManageAccount(req.user!, before.role)
  await db
    .update(users)
    .set({ isActive: false, tokenVersion: before.tokenVersion + 1 })
    .where(eq(users.id, id))
  if (before.role === 'WORKER') await recordShiftLogout(id)
  await audit(req, 'DISABLE_USER', 'User', id, { oldValue: snapshot(before) })
  res.json({ result: 'disabled' })
})
