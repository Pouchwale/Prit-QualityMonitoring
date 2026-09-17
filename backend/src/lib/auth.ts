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

export interface AuthUser {
  id: string
  name: string
  employeeId: string
  role: Role
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
}

interface RefreshPayload {
  sub: string
  ver: number
  type: 'refresh'
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

export function signTokens(user: { id: string; name: string; employeeId: string; role: Role; tokenVersion: number }) {
  const accessToken = jwt.sign(
    { sub: user.id, role: user.role, name: user.name, employeeId: user.employeeId, type: 'access' } satisfies AccessPayload,
    config.jwtAccessSecret,
    { expiresIn: config.accessTokenTtl }
  )
  const refreshToken = jwt.sign(
    { sub: user.id, ver: user.tokenVersion, type: 'refresh' } satisfies RefreshPayload,
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

/** Verifies the bearer token and confirms the account is still active. */
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
    .select({ id: users.id, name: users.name, employeeId: users.employeeId, role: users.role, isActive: users.isActive })
    .from(users)
    .where(eq(users.id, payload.sub))
  if (!user || !user.isActive) return next(new HttpError(401, 'Your account is disabled'))

  req.user = {
    id: user.id,
    name: user.name,
    employeeId: user.employeeId,
    role: user.role,
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
