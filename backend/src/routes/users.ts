import { Router, type RequestHandler } from 'express'
import { z } from 'zod'
import { and, asc, eq, inArray, notInArray } from 'drizzle-orm'
import { db } from '../db/client'
import { departments, machines, managerPermissions, schedules, shifts, users, workerMachines } from '../db/schema'
import { idParam, optionalText, optionalUuid } from '../lib/validate'
import { HttpError, badRequest, notFound } from '../lib/http'
import { audit, snapshot } from '../lib/audit'
import { passwordColumns, verifyPassword, type AuthUser } from '../lib/auth'
import { decryptPassword } from '../lib/passwordVault'
import { canManage, isAdminRole, requireAnyView, requireModule, type Role } from '../lib/permissions'
import { invalidateCheckGeneration, removeUpcomingChecks } from '../services/checkGenerator'
import { sendTestNotification } from '../services/notifications'

export const usersRouter = Router()

const ROLES = ['WORKER', 'MANAGER', 'ADMIN', 'SUPER_ADMIN'] as const

const ROLE_NAME: Record<Role, string> = { WORKER: 'Worker', MANAGER: 'Manager', ADMIN: 'Admin', SUPER_ADMIN: 'Super Admin' }

/**
 * Which accounts the signed-in user may create, edit or disable:
 *  - Super Admin: any account
 *  - Admin: Managers and Workers
 *  - Manager with "Workers: manage": Workers only
 * Checked for both the account's current role and the role it is being given.
 */
function assertCanManageAccount(actor: AuthUser, ...roles: Role[]) {
  const allowed: Role[] =
    actor.role === 'SUPER_ADMIN'
      ? [...ROLES]
      : actor.role === 'ADMIN'
        ? ['MANAGER', 'WORKER']
        : canManage(actor.permissions, 'workers')
          ? ['WORKER']
          : []
  const blocked = roles.find((r) => !allowed.includes(r))
  if (blocked) {
    throw new HttpError(
      403,
      allowed.length ? `You cannot manage ${ROLE_NAME[blocked]} accounts` : 'You do not have permission for this action'
    )
  }
}

/** Creating, editing or disabling accounts: Admins, or Managers allowed to manage workers. */
const manageWorkers = requireModule('workers', 'manage')
const accountManagers: RequestHandler = (req, res, next) =>
  isAdminRole(req.user!.role) ? next() : manageWorkers(req, res, next)

const base = {
  employeeId: z.string().trim().min(1, 'Employee ID is required').max(40),
  name: z.string().trim().min(1, 'Name is required').max(120),
  role: z.enum(ROLES).default('WORKER'),
  designation: optionalText(100),
  departmentId: optionalUuid,
  shiftId: optionalUuid,
  phone: optionalText(30),
  isActive: z.boolean().default(true),
  appAccess: z.boolean().default(true),
  machineIds: z.array(z.uuid()).default([])
}

const createInput = z.object({ ...base, password: z.string().min(6, 'Password must be at least 6 characters') })
const updateInput = z.object({
  ...base,
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
  designation: users.designation,
  departmentId: users.departmentId,
  shiftId: users.shiftId,
  phone: users.phone,
  isActive: users.isActive,
  appAccess: users.appAccess,
  lastLoginAt: users.lastLoginAt,
  createdAt: users.createdAt
}

// Pages that filter or assign by worker read this list; only Admins see non-worker accounts.
usersRouter.get('/', requireAnyView('workers', 'assignments', 'schedules', 'checks', 'exceptions', 'reports'), async (req, res) => {
  const requested = z.enum(ROLES).optional().parse(req.query.role)
  const role = isAdminRole(req.user!.role) ? requested : 'WORKER'
  if (!isAdminRole(req.user!.role) && requested && requested !== 'WORKER') return res.json([])
  const [rows, access] = await Promise.all([
    db
      .select({ ...publicColumns, departmentName: departments.name, shiftName: shifts.name })
      .from(users)
      .leftJoin(departments, eq(users.departmentId, departments.id))
      .leftJoin(shifts, eq(users.shiftId, shifts.id))
      .where(role ? eq(users.role, role) : undefined)
      .orderBy(asc(users.name)),
    db.select().from(workerMachines)
  ])
  res.json(
    rows.map((u) => ({ ...u, machineIds: access.filter((a) => a.userId === u.id).map((a) => a.machineId) }))
  )
})

async function setMachines(userId: string, machineIds: string[]) {
  await db.delete(workerMachines).where(eq(workerMachines.userId, userId))
  const unique = [...new Set(machineIds)]
  if (unique.length) await db.insert(workerMachines).values(unique.map((machineId) => ({ userId, machineId })))
  invalidateCheckGeneration()
  return releaseOrphanSchedules(userId, unique)
}

/**
 * A schedule may name a worker. When a machine is taken away from that worker the
 * schedule would send checks nobody can see, so the worker is removed from it and the
 * checks go to the worker assigned to that machine on the shift (services/workerAssignment.ts).
 */
async function releaseOrphanSchedules(userId: string, machineIds: string[]) {
  const orphans = await db
    .select({ id: schedules.id, machineId: schedules.machineId })
    .from(schedules)
    .where(
      and(
        eq(schedules.workerId, userId),
        machineIds.length ? notInArray(schedules.machineId, machineIds) : undefined
      )
    )
  if (orphans.length === 0) return []

  await db
    .update(schedules)
    .set({ workerId: null })
    .where(inArray(schedules.id, orphans.map((o) => o.id)))
  for (const o of orphans) await removeUpcomingChecks({ scheduleId: o.id })
  return orphans.map((o) => o.id)
}

usersRouter.post('/', accountManagers, async (req, res) => {
  const { password, machineIds, ...data } = createInput.parse(req.body)
  assertCanManageAccount(req.user!, data.role)
  const [row] = await db
    .insert(users)
    .values({ ...data, ...(await passwordColumns(password)) })
    .returning(publicColumns)
  await setMachines(row.id, machineIds)
  await audit(req, 'CREATE_USER', 'User', row.id, { newValue: { ...row, machineIds } })
  res.status(201).json(row)
})

usersRouter.put('/:id', accountManagers, async (req, res) => {
  const id = idParam(req)
  const { password, machineIds, ...data } = updateInput.parse(req.body)
  const [before] = await db.select().from(users).where(eq(users.id, id))
  if (!before) throw notFound('User')
  assertCanManageAccount(req.user!, before.role, data.role)
  if (password !== undefined) {
    // Everyone changes their own password in My Account, which asks for the current one.
    if (id === req.user!.id) throw badRequest('Change your own password in My Account')
    // Only the Super Admin may set or reset another user's password.
    if (req.user!.role !== 'SUPER_ADMIN') throw new HttpError(403, "Only the Super Admin can change another user's password")
  }
  if (id === req.user!.id && (!data.isActive || data.role !== before.role)) {
    throw badRequest('You cannot disable your own account or change your own role')
  }

  // Changing the password or disabling the account signs the user out everywhere.
  const signOut = password !== undefined || (before.isActive && !data.isActive) || (before.appAccess && !data.appAccess)
  const [row] = await db
    .update(users)
    .set({
      ...data,
      ...(password ? await passwordColumns(password) : {}),
      ...(signOut ? { tokenVersion: before.tokenVersion + 1 } : {})
    })
    .where(eq(users.id, id))
    .returning(publicColumns)
  const released = await setMachines(id, machineIds)
  // A former manager keeps no module permissions.
  if (before.role === 'MANAGER' && data.role !== 'MANAGER') {
    await db.delete(managerPermissions).where(eq(managerPermissions.userId, id))
  }
  await audit(req, password ? 'UPDATE_USER_AND_PASSWORD' : 'UPDATE_USER', 'User', id, {
    oldValue: snapshot(before),
    newValue: { ...row, machineIds, releasedSchedules: released.length || undefined }
  })
  res.json({ ...row, releasedSchedules: released.length })
})

/**
 * Machine assignment. This decides which checks the worker sees, can submit and
 * is notified about, so it has its own endpoint for the assignment screen.
 */
usersRouter.put('/:id/machines', requireModule('assignments', 'manage'), async (req, res) => {
  const id = idParam(req)
  const { machineIds } = z.object({ machineIds: z.array(z.uuid()) }).parse(req.body)

  const [user] = await db.select().from(users).where(eq(users.id, id))
  if (!user) throw notFound('User')
  if (user.role !== 'WORKER') throw badRequest('Only workers are assigned to machines')

  const before = await db.select({ machineId: workerMachines.machineId }).from(workerMachines).where(eq(workerMachines.userId, id))
  const released = await setMachines(id, machineIds)

  const names = machineIds.length
    ? (await db.select({ name: machines.name }).from(machines).where(inArray(machines.id, machineIds))).map((m) => m.name)
    : []
  await audit(req, 'ASSIGN_MACHINES', 'User', id, {
    oldValue: { machineIds: before.map((b) => b.machineId) },
    newValue: { machineIds, machines: names, releasedSchedules: released.length || undefined }
  })
  res.json({ id, machineIds, releasedSchedules: released.length })
})

/** Sends a test notification to the worker's phones so the admin can verify the setup. */
usersRouter.post('/:id/test-notification', requireModule('assignments', 'manage'), async (req, res) => {
  const id = idParam(req)
  const [user] = await db.select().from(users).where(eq(users.id, id))
  if (!user) throw notFound('User')

  const assigned = await db
    .select({ name: machines.name })
    .from(workerMachines)
    .innerJoin(machines, eq(workerMachines.machineId, machines.id))
    .where(eq(workerMachines.userId, id))

  const result = await sendTestNotification(id, assigned.map((a) => a.name).join(', ') || undefined)
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
usersRouter.delete('/:id', accountManagers, async (req, res) => {
  const id = idParam(req)
  if (id === req.user!.id) throw badRequest('You cannot disable your own account')
  const [before] = await db.select().from(users).where(eq(users.id, id))
  if (!before) throw notFound('User')
  assertCanManageAccount(req.user!, before.role)
  await db
    .update(users)
    .set({ isActive: false, tokenVersion: before.tokenVersion + 1 })
    .where(eq(users.id, id))
  await audit(req, 'DISABLE_USER', 'User', id, { oldValue: snapshot(before) })
  res.json({ result: 'disabled' })
})
