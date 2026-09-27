import { eq, inArray, isNull, or, type SQL } from 'drizzle-orm'
import { db } from '../db/client'
import { activities, users } from '../db/schema'

/**
 * Departments decide which quality checks a worker does. A check type that names a department is
 * only for the workers of that department (Label workers do the Label check type, Sleeve workers
 * the Sleeve one); a check type with no department belongs to the whole plant, so a plant that
 * does not use departments keeps working exactly as before.
 *
 * This is enforced in the API, not in the apps: the worker app only ever receives the check types
 * it may show, so an older installed app is scoped too.
 */
export const checkTypeInDepartment = (activityDepartmentId: string | null, workerDepartmentId: string | null) =>
  activityDepartmentId === null || activityDepartmentId === workerDepartmentId

/** The same rule as a condition on `activities`, for queries that read check types. */
export const checkTypeDepartmentFilter = (workerDepartmentId: string | null): SQL | undefined =>
  workerDepartmentId ? or(isNull(activities.departmentId), eq(activities.departmentId, workerDepartmentId)) : isNull(activities.departmentId)

/** The department on a user's account, or null when they have none. */
export async function userDepartmentId(userId: string): Promise<string | null> {
  const [row] = await db.select({ departmentId: users.departmentId }).from(users).where(eq(users.id, userId))
  return row?.departmentId ?? null
}

/** The departments of several users at once, for check generation. */
export async function userDepartments(userIds: (string | null)[]): Promise<Map<string, string | null>> {
  const ids = [...new Set(userIds.filter((id): id is string => !!id))]
  if (ids.length === 0) return new Map()
  const rows = await db.select({ id: users.id, departmentId: users.departmentId }).from(users).where(inArray(users.id, ids))
  return new Map(rows.map((r) => [r.id, r.departmentId]))
}
