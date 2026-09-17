import { Router } from 'express'
import { z } from 'zod'
import { eq, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { departments, shifts, users } from '../db/schema'
import { authenticate, passwordColumns, signTokens, verifyPassword, verifyRefreshToken } from '../lib/auth'
import { HttpError, notFound } from '../lib/http'
import { audit } from '../lib/audit'
import { loadPermissions } from '../lib/permissions'

export const authRouter = Router()

export async function loadProfile(userId: string) {
  const [row] = await db
    .select({
      id: users.id,
      name: users.name,
      employeeId: users.employeeId,
      role: users.role,
      designation: users.designation,
      departmentName: departments.name,
      shiftName: shifts.name,
      shiftStartTime: shifts.startTime,
      shiftEndTime: shifts.endTime
    })
    .from(users)
    .leftJoin(departments, eq(users.departmentId, departments.id))
    .leftJoin(shifts, eq(users.shiftId, shifts.id))
    .where(eq(users.id, userId))
  if (!row) throw notFound('User')
  // The admin panel uses these to show only the pages and actions this user may use.
  return { ...row, permissions: await loadPermissions(row.id, row.role) }
}

authRouter.post('/login', async (req, res) => {
  const body = z
    .object({
      employeeId: z.string().trim().min(1, 'Enter your employee ID'),
      password: z.string().min(1, 'Enter your password'),
      app: z.enum(['worker', 'admin'])
    })
    .parse(req.body)

  const [user] = await db
    .select()
    .from(users)
    .where(sql`lower(${users.employeeId}) = lower(${body.employeeId})`)

  if (!user || !(await verifyPassword(body.password, user.passwordHash))) {
    throw new HttpError(401, 'Wrong employee ID or password')
  }
  if (!user.isActive) {
    throw new HttpError(403, 'Your account is disabled. Please contact your supervisor.')
  }
  if (body.app === 'worker' && (user.role !== 'WORKER' || !user.appAccess)) {
    throw new HttpError(403, 'This account cannot use the worker app. Please contact your supervisor.')
  }
  if (body.app === 'admin' && user.role === 'WORKER') {
    throw new HttpError(403, 'This account cannot use the admin panel')
  }

  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id))
  req.user = {
    id: user.id,
    name: user.name,
    employeeId: user.employeeId,
    role: user.role,
    permissions: await loadPermissions(user.id, user.role)
  }
  await audit(req, 'LOGIN', 'User', user.id, { newValue: { app: body.app } })

  res.json({ ...signTokens(user), user: await loadProfile(user.id) })
})

authRouter.post('/refresh', async (req, res) => {
  const { refreshToken } = z.object({ refreshToken: z.string().min(1) }).parse(req.body)
  const payload = verifyRefreshToken(refreshToken)

  const [user] = await db.select().from(users).where(eq(users.id, payload.sub))
  if (!user || !user.isActive || user.tokenVersion !== payload.ver) {
    throw new HttpError(401, 'Session expired. Please sign in again.')
  }
  res.json(signTokens(user))
})

authRouter.get('/me', authenticate, async (req, res) => {
  res.json(await loadProfile(req.user!.id))
})

authRouter.post('/logout', authenticate, async (req, res) => {
  await audit(req, 'LOGOUT', 'User', req.user!.id)
  res.status(204).end()
})

authRouter.post('/change-password', authenticate, async (req, res) => {
  const body = z
    .object({
      currentPassword: z.string().min(1),
      newPassword: z.string().min(6, 'Password must be at least 6 characters')
    })
    .parse(req.body)

  const [user] = await db.select().from(users).where(eq(users.id, req.user!.id))
  if (!user || !(await verifyPassword(body.currentPassword, user.passwordHash))) {
    throw new HttpError(400, 'Current password is wrong')
  }
  const [updated] = await db
    .update(users)
    .set({ ...(await passwordColumns(body.newPassword)), tokenVersion: user.tokenVersion + 1 })
    .where(eq(users.id, user.id))
    .returning()
  await audit(req, 'CHANGE_PASSWORD', 'User', user.id)
  res.json(signTokens(updated))
})
