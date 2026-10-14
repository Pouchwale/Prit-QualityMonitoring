import type { RequestHandler } from 'express'
import { randomUUID } from 'node:crypto'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { eq } from 'drizzle-orm'
import { config } from '../config'
import { db } from '../db/client'
import { users } from '../db/schema'
import { HttpError } from './http'
import { loadAccess, type ActionMatrix, type Permissions, type Role } from './permissions'
import { encryptPassword } from './passwordVault'

export type { Role } from './permissions'

/** Which client a session belongs to: the mobile app (all roles) or the web admin panel. */
export type ClientApp = 'mobile' | 'web'

export interface AuthUser {
  id: string
  name: string
  employeeId: string
  role: Role
  app: ClientApp
  /** What the user may do in each module (view, create, edit, delete), loaded from the database on every request. */
  actions: ActionMatrix
  /** The same as one word per module (none / view / manage), for older readers. */
  permissions: Permissions
  /** A worker's sign-in tied to their shift: when it ends (ISO). Null when not limited by a shift. */
  sessionEndsAt?: string | null
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser
    }
  }
}

interface AccessPayload {
  sub: string
  role: Role
  name: string
  employeeId: string
  type: 'access'
  /** Missing on tokens issued before the mobile app served every role: treated as web. */
  app?: ClientApp
  /**
   * The account's token version when the token was issued. A password change or reset, disabling the
   * account or removing mobile access raises the version, which ends every session at once.
   */
  ver: number
  /** Shift end (epoch seconds) of a worker's sign-in: refused from then on (services/workerShifts.ts). */
  sx?: number
}

export interface RefreshPayload {
  sub: string
  ver: number
  type: 'refresh'
  app?: ClientApp
  /** Identifies this refresh token so signing out can revoke it (revoked_tokens). */
  jti?: string
  exp?: number
  /** Shift end (epoch seconds), carried over to every refreshed token. */
  sx?: number
}

export const hashPassword = (password: string) => bcrypt.hash(password, 10)
export const verifyPassword = (password: string, hash: string) => bcrypt.compare(password, hash)

/**
 * Columns to store whenever a password is set: the bcrypt hash used to sign in, and the
 * encrypted copy the Super Admin can view (lib/passwordVault.ts).
 */
export async function passwordColumns(password: string) {
  return { passwordHash: await hashPassword(password), passwordEncrypted: encryptPassword(password) }
}

/** The message and code a worker gets once their shift is over. */
export const SHIFT_ENDED = 'SHIFT_ENDED'
export const shiftEndedError = () => new HttpError(401, 'Your shift has ended. Please sign in again at the start of your next shift.', SHIFT_ENDED)

/**
 * Signs a session's tokens. `sessionEndsAt` ties a worker's sign-in to their shift: both tokens
 * carry it, and the access token never lives past it.
 */
export function signTokens(
  user: { id: string; name: string; employeeId: string; role: Role; tokenVersion: number },
  app: ClientApp,
  sessionEndsAt: Date | null = null
) {
  const sx = sessionEndsAt ? Math.floor(sessionEndsAt.getTime() / 1000) : undefined
  const untilShiftEnd = sx ? Math.max(60, sx - Math.floor(Date.now() / 1000)) : null
  const accessTtl = untilShiftEnd !== null ? Math.min(untilShiftEnd, 12 * 60 * 60) : config.accessTokenTtl
  const accessToken = jwt.sign(
    { sub: user.id, role: user.role, name: user.name, employeeId: user.employeeId, type: 'access', app, ver: user.tokenVersion, ...(sx ? { sx } : {}) } satisfies AccessPayload,
    config.jwtAccessSecret,
    { expiresIn: accessTtl }
  )
  const refreshToken = jwt.sign(
    { sub: user.id, ver: user.tokenVersion, type: 'refresh', app, jti: randomUUID(), ...(sx ? { sx } : {}) } satisfies RefreshPayload,
    config.jwtRefreshSecret,
    { expiresIn: config.refreshTokenTtl }
  )
  return { accessToken, refreshToken, sessionEndsAt: sessionEndsAt?.toISOString() ?? null }
}

export function verifyRefreshToken(token: string): RefreshPayload {
  try {
    const payload = jwt.verify(token, config.jwtRefreshSecret) as RefreshPayload
    if (payload.type !== 'refresh') throw new Error('wrong token type')
    return payload
  } catch {
    throw new HttpError(401, 'Session expired. Please sign in again.')
  }
}

/** The mobile app needs the account's "Mobile app access" switch on, for every role. */
export const MOBILE_ACCESS_OFF = 'Mobile app access is turned off for this account. Please contact your administrator.'

/**
 * Verifies the bearer token and confirms the account is still active and the token still current.
 * Mobile sessions also need mobile app access, checked on every request so turning it off applies
 * at once. The token is only read from the Authorization header: a token in a URL ends up in browser
 * history and server logs.
 */
export const authenticate: RequestHandler = async (req, _res, next) => {
  const header = req.headers.authorization
  const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined
  if (!token) return next(new HttpError(401, 'Please sign in'))

  let payload: AccessPayload
  try {
    payload = jwt.verify(token, config.jwtAccessSecret) as AccessPayload
    if (payload.type !== 'access') throw new Error('wrong token type')
  } catch (err) {
    // A worker's access token runs out with their shift: say so, so the app does not try to refresh.
    // The token is still checked (signature, type); this only picks the message.
    if (err instanceof jwt.TokenExpiredError) {
      try {
        const expired = jwt.verify(token, config.jwtAccessSecret, { ignoreExpiration: true }) as AccessPayload
        if (expired.type === 'access' && expired.sx && Date.now() >= expired.sx * 1000) return next(shiftEndedError())
      } catch {
        // Not a token of ours: the general answer below.
      }
    }
    return next(new HttpError(401, 'Session expired. Please sign in again.'))
  }

  const [user] = await db
    .select({
      id: users.id,
      name: users.name,
      employeeId: users.employeeId,
      role: users.role,
      isActive: users.isActive,
      appAccess: users.appAccess,
      tokenVersion: users.tokenVersion
    })
    .from(users)
    .where(eq(users.id, payload.sub))
  if (!user || !user.isActive) return next(new HttpError(401, 'Your account is disabled'))
  // Issued before the password was changed or reset (or before tokens carried a version): the app
  // refreshes, which also fails after a password change, and the user signs in again.
  if (payload.ver !== user.tokenVersion) return next(new HttpError(401, 'Session expired. Please sign in again.'))
  // A worker's sign-in ends with their shift, whatever the phone's own timer does.
  if (payload.sx && Date.now() >= payload.sx * 1000) return next(shiftEndedError())
  const app: ClientApp = payload.app ?? 'web'
  if (app === 'mobile' && !user.appAccess) return next(new HttpError(401, MOBILE_ACCESS_OFF))

  req.user = {
    id: user.id,
    name: user.name,
    employeeId: user.employeeId,
    role: user.role,
    app,
    ...(await loadAccess(user.id, user.role)),
    sessionEndsAt: payload.sx ? new Date(payload.sx * 1000).toISOString() : null
  }
  next()
}

export const requireRole =
  (...roles: Role[]): RequestHandler =>
  (req, _res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return next(new HttpError(403, 'You do not have permission for this action'))
    }
    next()
  }
