import type { RequestHandler } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { eq } from 'drizzle-orm'
import { config } from '../config'
import { db } from '../db/client'
import { users } from '../db/schema'
import { HttpError } from './http'
import { loadPermissions, type Permissions, type Role } from './permissions'
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
  /** Effective module permissions, loaded from the database on every request. */
  permissions: Permissions
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
}

interface RefreshPayload {
  sub: string
  ver: number
  type: 'refresh'
  app?: ClientApp
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

export function signTokens(user: { id: string; name: string; employeeId: string; role: Role; tokenVersion: number }, app: ClientApp) {
  const accessToken = jwt.sign(
    { sub: user.id, role: user.role, name: user.name, employeeId: user.employeeId, type: 'access', app } satisfies AccessPayload,
    config.jwtAccessSecret,
    { expiresIn: config.accessTokenTtl }
  )
  const refreshToken = jwt.sign(
    { sub: user.id, ver: user.tokenVersion, type: 'refresh', app } satisfies RefreshPayload,
    config.jwtRefreshSecret,
    { expiresIn: config.refreshTokenTtl }
  )
  return { accessToken, refreshToken }
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
 * Verifies the bearer token and confirms the account is still active. Mobile sessions also need
 * mobile app access, checked on every request so turning it off applies at once.
 */
export const authenticate: RequestHandler = async (req, _res, next) => {
  const header = req.headers.authorization
  const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined
  if (!token) return next(new HttpError(401, 'Please sign in'))

  let payload: AccessPayload
  try {
    payload = jwt.verify(token, config.jwtAccessSecret) as AccessPayload
    if (payload.type !== 'access') throw new Error('wrong token type')
  } catch {
    return next(new HttpError(401, 'Session expired. Please sign in again.'))
  }

  const [user] = await db
    .select({ id: users.id, name: users.name, employeeId: users.employeeId, role: users.role, isActive: users.isActive, appAccess: users.appAccess })
    .from(users)
    .where(eq(users.id, payload.sub))
  if (!user || !user.isActive) return next(new HttpError(401, 'Your account is disabled'))
  const app: ClientApp = payload.app ?? 'web'
  if (app === 'mobile' && !user.appAccess) return next(new HttpError(401, MOBILE_ACCESS_OFF))

  req.user = {
    id: user.id,
    name: user.name,
    employeeId: user.employeeId,
    role: user.role,
    app,
    permissions: await loadPermissions(user.id, user.role)
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
