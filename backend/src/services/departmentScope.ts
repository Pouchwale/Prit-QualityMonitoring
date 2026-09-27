import { eq, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { departments, machines, users } from '../db/schema'
import { HttpError } from '../lib/http'
import type { AuthUser } from '../lib/auth'

/**
 * Departments decide how much of the plant a Manager sees. An Admin or the Super Admin sees
 * everything; a Manager only ever sees their own department's data (the department on their
 * account). The department is read from the database on every request, so an Admin moving a
 * Manager to another department takes effect immediately.
 *
 * Data belongs to the department of the **machine** it happened on (checks, exceptions, jobs and
 * everything on the dashboard). Worker Performance also looks at the worker's own department
 * (services/performance.ts), because it is about people rather than machines.
 */
export interface DepartmentScope {
  /** The department a Manager is limited to; null for an Admin (no limit). */
  departmentId: string | null
  departmentName: string | null
  /** True when the caller only sees one department. */
  restricted: boolean
  /** A Manager whose account has no department sees nothing until an Admin sets one. */
  missingDepartment: boolean
}

export const UNRESTRICTED: DepartmentScope = { departmentId: null, departmentName: null, restricted: false, missingDepartment: false }

/** What this user may see. */
export async function departmentScope(user: Pick<AuthUser, 'id' | 'role'>): Promise<DepartmentScope> {
  if (user.role !== 'MANAGER') return UNRESTRICTED
  const [row] = await db
    .select({ departmentId: users.departmentId, departmentName: departments.name })
    .from(users)
    .leftJoin(departments, eq(departments.id, users.departmentId))
    .where(eq(users.id, user.id))
  return {
    departmentId: row?.departmentId ?? null,
    departmentName: row?.departmentName ?? null,
    restricted: true,
    missingDepartment: !row?.departmentId
  }
}

/**
 * The department to filter a request by. A Manager always gets their own, whatever the request
 * asked for; asking for another department is refused rather than quietly answered.
 */
export function scopedDepartmentId(scope: DepartmentScope, requested?: string): string | undefined {
  if (!scope.restricted) return requested
  if (requested && requested !== scope.departmentId) throw new HttpError(403, 'This department is not yours')
  return scope.departmentId ?? undefined
}

/** A Manager with no department: nothing may be returned. */
export const seesNothing = (scope: DepartmentScope) => scope.restricted && scope.missingDepartment

/** Extra condition for queries that cannot take a departmentId, e.g. a Manager who sees nothing. */
export const blockAll = sql`false`

/**
 * Refuses a Manager who tries to open a machine that belongs to another department. A machine with
 * no department is shared by the whole plant (the usual case: the same machine runs Pouch work one
 * day and Label work the next), so it is open to every Manager.
 */
export async function assertMachineInScope(scope: DepartmentScope, machineId: string) {
  if (!scope.restricted) return
  const [row] = await db.select({ departmentId: machines.departmentId }).from(machines).where(eq(machines.id, machineId))
  if (!row || row.departmentId === null) return
  if (row.departmentId !== scope.departmentId) throw new HttpError(403, 'This machine is in another department')
}
