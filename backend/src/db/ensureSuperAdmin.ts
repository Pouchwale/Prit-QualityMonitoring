import { and, asc, eq } from 'drizzle-orm'
import { db } from './client'
import { users } from './schema'

/**
 * There must always be a Super Admin: only a Super Admin can manage Admin accounts.
 * Databases created before the role existed have Admins only, so the earliest active Admin
 * (normally the seeded "ADMIN" account) is promoted once. Nothing happens if one exists.
 */
export async function ensureSuperAdmin() {
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.role, 'SUPER_ADMIN')).limit(1)
  if (existing) return null

  const [first] = await db
    .select({ id: users.id, employeeId: users.employeeId })
    .from(users)
    .where(and(eq(users.role, 'ADMIN'), eq(users.isActive, true)))
    .orderBy(asc(users.createdAt))
    .limit(1)
  if (!first) return null

  await db.update(users).set({ role: 'SUPER_ADMIN' }).where(eq(users.id, first.id))
  console.log(`No Super Admin existed; ${first.employeeId} is now the Super Admin.`)
  return first.employeeId
}
