import { sql } from 'drizzle-orm'
import { HttpError } from '../lib/http'
import type { AuthUser } from '../lib/auth'

/**
 * No role is limited to a department any more. An Admin, the Super Admin and every Manager see
 * the whole plant (Label, Pouch, Sleeve and every other department), and the module permissions
 * (lib/permissions.ts) decide which pages and actions a Manager may use.
 *
 * Records still carry their department (the department of the work, e.g. a job's department from
 * its Item Code), and every list can still be filtered by it.
 *
 * The scope and its helpers are kept so the routes keep one shape, and so responses keep their
 * `scope` field (always unrestricted) for older app builds that still read it.
 */
export interface DepartmentScope {
  /** The department the caller is limited to: always null now. */
  departmentId: string | null
  departmentName: string | null
  /** True when the caller only sees one department: always false now. */
  restricted: boolean
  /** True when the caller may see nothing: always false now. */
  missingDepartment: boolean
}

export const UNRESTRICTED: DepartmentScope = { departmentId: null, departmentName: null, restricted: false, missingDepartment: false }

/** What this user may see: the whole plant, whatever the role. */
export async function departmentScope(_user: Pick<AuthUser, 'id' | 'role'>): Promise<DepartmentScope> {
  return UNRESTRICTED
}

/**
 * The department to filter a request by: the one the request asked for. Only a restricted scope
 * would override it, and no scope is restricted any more.
 */
export function scopedDepartmentId(scope: DepartmentScope, requested?: string): string | undefined {
  if (!scope.restricted) return requested
  if (requested && requested !== scope.departmentId) throw new HttpError(403, 'This department is not yours')
  return scope.departmentId ?? undefined
}

/** True when nothing may be returned. Never the case now that nobody is limited to a department. */
export const seesNothing = (scope: DepartmentScope) => scope.restricted && scope.missingDepartment

/** Extra condition for queries that cannot take a departmentId, e.g. when nothing may be returned. */
export const blockAll = sql`false`
