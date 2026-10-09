import { Router } from 'express'
import { z } from 'zod'
import { eq, lt, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { departments, revokedTokens, shifts, users } from '../db/schema'
import {
  MOBILE_ACCESS_OFF,
  authenticate,
  shiftEndedError,
  hashPassword,
  passwordColumns,
  signTokens,
  verifyPassword,
  verifyRefreshToken,
  type ClientApp
} from '../lib/auth'
import { assertLoginAllowed, recordLoginFailure, recordLoginSuccess } from '../lib/loginLimiter'
import { offShiftMessage, recordShiftLogin, recordShiftLogout, signInWindow } from '../services/workerShifts'
import { HttpError, notFound } from '../lib/http'
import { audit } from '../lib/audit'
import { loadPermissions } from '../lib/permissions'

export const authRouter = Router()

/** A bcrypt hash compared against when the employee ID does not exist (see /login). */
const dummyHash = hashPassword('not-a-real-password')

/** True when this refresh token was ended by signing out. */
async function isRevoked(jti: string | undefined) {
  if (!jti) return false
  const [row] = await db.select({ jti: revokedTokens.jti }).from(revokedTokens).where(eq(revokedTokens.jti, jti))
  return !!row
}

/** Removes revoked tokens that have expired anyway (called by the scheduler). */
export async function purgeExpiredRevokedTokens() {
  await db.delete(revokedTokens).where(lt(revokedTokens.expiresAt, new Date()))
}

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
      shiftEndTime: shifts.endTime,
      voiceNotificationLanguage: users.voiceNotificationLanguage,
      workerQualityRole: users.workerQualityRole
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
      /** mobile: the app for every role. worker: older app versions (Workers only). admin: the web panel. */
      app: z.enum(['mobile', 'worker', 'admin'])
    })
    .parse(req.body)

  const ip = req.ip ?? ''
  assertLoginAllowed(ip, body.employeeId)

  const [user] = await db
    .select()
    .from(users)
    .where(sql`lower(${users.employeeId}) = lower(${body.employeeId})`)

  // An unknown employee ID takes as long as a wrong password, so the answer time does not tell
  // which employee IDs exist.
  const passwordOk = await verifyPassword(body.password, user?.passwordHash ?? (await dummyHash))
  if (!user || !passwordOk) {
    recordLoginFailure(ip, body.employeeId)
    throw new HttpError(401, 'Wrong employee ID or password')
  }
  recordLoginSuccess(ip, body.employeeId)
  if (!user.isActive) {
    throw new HttpError(403, 'Your account is disabled. Please contact your supervisor.')
  }
  if (body.app === 'worker' && (user.role !== 'WORKER' || !user.appAccess)) {
    throw new HttpError(403, 'This account cannot use the worker app. Please contact your supervisor.')
  }
  if (body.app === 'mobile' && !user.appAccess) {
    throw new HttpError(403, MOBILE_ACCESS_OFF)
  }
  if (body.app === 'admin' && user.role === 'WORKER') {
    throw new HttpError(403, 'This account cannot use the admin panel')
  }

  const app: ClientApp = body.app === 'admin' ? 'web' : 'mobile'

  // A worker's app sign-in belongs to their shift (services/workerShifts.ts): between shifts it
  // waits for the next one; on shift it lasts until the shift ends.
  const now = new Date()
  const shiftWindow = user.role === 'WORKER' && app === 'mobile' ? await signInWindow(user.id, now) : ({ kind: 'none' } as const)
  if (shiftWindow.kind === 'off') throw new HttpError(403, offShiftMessage(shiftWindow), 'SHIFT_NOT_STARTED')
  const shiftBlock = shiftWindow.kind === 'on' ? shiftWindow.block : null

  await db.update(users).set({ lastLoginAt: now }).where(eq(users.id, user.id))
  req.user = {
    id: user.id,
    name: user.name,
    employeeId: user.employeeId,
    role: user.role,
    app,
    permissions: await loadPermissions(user.id, user.role)
  }
  const shiftLogin = shiftBlock ? await recordShiftLogin(user.id, shiftBlock, now) : null
  await audit(req, 'LOGIN', 'User', user.id, {
    newValue: {
      app: body.app,
      ...(shiftBlock ? { shift: shiftBlock.shiftName, shiftStart: shiftBlock.start, autoLogoutAt: shiftBlock.end } : {})
    }
  })
  if (shiftLogin?.afterReminder) {
    await audit(req, 'LOGIN_AFTER_REMINDER', 'User', user.id, { newValue: { shift: shiftBlock!.shiftName, remindersSent: shiftLogin.remindersSent } })
  }

  const tokens = signTokens(user, app, shiftBlock?.end ?? null)
  res.json({ ...tokens, user: { ...(await loadProfile(user.id)), sessionEndsAt: tokens.sessionEndsAt } })
})

authRouter.post('/refresh', async (req, res) => {
  const { refreshToken } = z.object({ refreshToken: z.string().min(1) }).parse(req.body)
  const payload = verifyRefreshToken(refreshToken)
  if (await isRevoked(payload.jti)) throw new HttpError(401, 'Session expired. Please sign in again.')

  const [user] = await db.select().from(users).where(eq(users.id, payload.sub))
  if (!user || !user.isActive || user.tokenVersion !== payload.ver) {
    throw new HttpError(401, 'Session expired. Please sign in again.')
  }
  const app: ClientApp = payload.app ?? (user.role === 'WORKER' ? 'mobile' : 'web')
  if (app === 'mobile' && !user.appAccess) throw new HttpError(401, MOBILE_ACCESS_OFF)

  // A sign-in tied to a shift ends with it; a refresh never extends it.
  if (payload.sx && Date.now() >= payload.sx * 1000) throw shiftEndedError()
  let sessionEndsAt = payload.sx ? new Date(payload.sx * 1000) : null
  // A worker's sign-in from before shift sign-in existed is tied to the shift now, or ends.
  if (!payload.sx && user.role === 'WORKER' && app === 'mobile') {
    const window = await signInWindow(user.id)
    if (window.kind === 'off') throw shiftEndedError()
    if (window.kind === 'on') {
      sessionEndsAt = window.block.end
      await recordShiftLogin(user.id, window.block)
    }
  }
  res.json(signTokens(user, app, sessionEndsAt))
})

authRouter.get('/me', authenticate, async (req, res) => {
  // sessionEndsAt: when a worker's shift (and so this sign-in) ends; the app logs out then.
  res.json({ ...(await loadProfile(req.user!.id)), sessionEndsAt: req.user!.sessionEndsAt ?? null })
})

/**
 * Signing out ends this device's session: the app sends its refresh token, which is revoked, so a
 * copy of it can no longer be used. It works with an expired access token too (the refresh token
 * itself proves who is signing out); the short-lived access token runs out on its own.
 */
authRouter.post('/logout', async (req, res) => {
  const { refreshToken } = z.object({ refreshToken: z.string().min(1).optional() }).parse(req.body ?? {})
  if (refreshToken) {
    let payload: ReturnType<typeof verifyRefreshToken> | null = null
    try {
      payload = verifyRefreshToken(refreshToken)
    } catch {
      // Already expired or not a token: nothing to revoke.
    }
    if (payload?.jti && payload.exp) {
      await db
        .insert(revokedTokens)
        .values({ jti: payload.jti, userId: payload.sub, expiresAt: new Date(payload.exp * 1000) })
        .onConflictDoNothing()
      const [user] = await db.select().from(users).where(eq(users.id, payload.sub))
      if (user) {
        if (user.role === 'WORKER') await recordShiftLogout(user.id)
        req.user = { id: user.id, name: user.name, employeeId: user.employeeId, role: user.role, app: payload.app ?? 'web', permissions: await loadPermissions(user.id, user.role) }
        await audit(req, 'LOGOUT', 'User', user.id)
      }
    }
  }
  res.status(204).end()
})

/**
 * Password management is Super Admin only: the Super Admin changes their own password here and
 * sets other users' passwords on the Users screen. Every other role is refused, whatever the UI shows.
 */
authRouter.post('/change-password', authenticate, async (req, res) => {
  if (req.user!.role !== 'SUPER_ADMIN') {
    await audit(req, 'CHANGE_PASSWORD_DENIED', 'User', req.user!.id)
    throw new HttpError(403, 'Only the Super Admin can change passwords')
  }
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
  res.json(signTokens(updated, req.user!.app))
})
