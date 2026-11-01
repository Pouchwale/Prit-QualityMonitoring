import { and, eq, inArray, sql, type SQL } from 'drizzle-orm'
import { db } from '../db/client'
import { departments, jobs, qualityChecks, users } from '../db/schema'
import { HttpError } from '../lib/http'
import type { AuthUser } from '../lib/auth'

/**
 * Department-wise access for Managers. A Manager sees only the workers and the work of their own
 * area, set on their account (Workers & Users → Department):
 *
 *   IPQC (Print) Manager → IPQC workers and IPQC checks of Pouch, Label and Sleeve (the departments
 *                          IPQC (Print) covers);
 *   QC (Pouch) Manager   → QC workers of Pouch and the QC checks of Pouch; the same for Label, Sleeve.
 *
 * A worker set to IPQC + QC is seen by both: by the IPQC Manager for IPQC work and by their
 * department's QC Manager for QC work. A Manager with no department set sees nothing.
 * Admins and the Super Admin see the whole plant. Setup pages (machines, check types, parameters,
 * shifts, plant calendar, departments) stay plant-wide; the module permissions decide which pages
 * a Manager may open at all (lib/permissions.ts).
 *
 * Every list, dashboard, report and action on workers or their work goes through this scope, in
 * the API, so no app can see past it.
 */
export type QualityModule = 'IPQC' | 'QC'

export interface DepartmentScope {
  /** The Manager's own department (null: not limited, or not set). */
  departmentId: string | null
  departmentName: string | null
  /** True for a Manager: only their area is visible. */
  restricted: boolean
  /** True for a Manager with no department set: nothing is visible. */
  missingDepartment: boolean
  /** Their department and the ones it covers (IPQC (Print): Pouch, Label, Sleeve). */
  departmentIds: string[]
  /** IPQC, QC or both (from the Manager's quality role). */
  modules: QualityModule[]
}

export const UNRESTRICTED: DepartmentScope = { departmentId: null, departmentName: null, restricted: false, missingDepartment: false, departmentIds: [], modules: ['IPQC', 'QC'] }

/** What this user may see. */
export async function departmentScope(user: Pick<AuthUser, 'id' | 'role'>): Promise<DepartmentScope> {
  if (user.role !== 'MANAGER') return UNRESTRICTED
  const [row] = await db
    .select({ departmentId: users.departmentId, qualityRole: users.workerQualityRole, name: departments.name, covers: departments.coversDepartmentIds })
    .from(users)
    .leftJoin(departments, eq(departments.id, users.departmentId))
    .where(eq(users.id, user.id))
  const modules: QualityModule[] = row?.qualityRole === 'BOTH' ? ['IPQC', 'QC'] : [(row?.qualityRole ?? 'IPQC') as QualityModule]
  if (!row?.departmentId) return { departmentId: null, departmentName: null, restricted: true, missingDepartment: true, departmentIds: [], modules }
  return {
    departmentId: row.departmentId,
    departmentName: row.name,
    restricted: true,
    missingDepartment: false,
    departmentIds: [...new Set([row.departmentId, ...(row.covers ?? [])])],
    modules
  }
}

const FORBIDDEN = 'This belongs to another department'

/** The department a request filters by: any of the caller's departments, never another one. */
export function scopedDepartmentId(scope: DepartmentScope, requested?: string): string | undefined {
  if (!scope.restricted || !requested) return requested
  if (!scope.departmentIds.includes(requested)) throw new HttpError(403, 'This department is not yours')
  return requested
}

/** True when nothing may be returned. */
export const seesNothing = (scope: DepartmentScope) => scope.restricted && scope.missingDepartment

/** Extra condition for queries when nothing may be returned. */
export const blockAll = sql`false`

/** The quality roles of the workers a scope sees: its modules, and workers doing both. */
const workerRoles = (scope: DepartmentScope): ('IPQC' | 'QC' | 'BOTH')[] => [...scope.modules, 'BOTH']

/**
 * The workers this scope sees, as a condition on the users table (undefined: everyone).
 * Workers only: other Managers, Admins and the Super Admin are not in a Manager's scope.
 */
export function workerScopeWhere(scope: DepartmentScope): SQL | undefined {
  if (!scope.restricted) return undefined
  if (scope.missingDepartment) return blockAll
  return and(eq(users.role, 'WORKER'), inArray(users.workerQualityRole, workerRoles(scope)), inArray(users.departmentId, scope.departmentIds))
}

/** The ids of the workers this scope sees; null: everyone. */
export async function scopedWorkerIds(scope: DepartmentScope): Promise<string[] | null> {
  if (!scope.restricted) return null
  if (scope.missingDepartment) return []
  return (await db.select({ id: users.id }).from(users).where(workerScopeWhere(scope))).map((r) => r.id)
}

/**
 * The checks this scope sees, as a condition on quality_checks (undefined: all): their module
 * (IPQC / QC), and the department of the work, or a worker of theirs when the check has none.
 */
export function checkScopeWhere(scope: DepartmentScope): SQL | undefined {
  if (!scope.restricted) return undefined
  if (scope.missingDepartment) return blockAll
  const mods = sql.join(scope.modules.map((m) => sql`${m}`), sql`, `)
  const depts = sql.join(scope.departmentIds.map((d) => sql`${d}::uuid`), sql`, `)
  const roles = sql.join(workerRoles(scope).map((r) => sql`${r}`), sql`, `)
  return sql`(${qualityChecks.module}::text in (${mods}) and (${qualityChecks.departmentId} in (${depts}) or (${qualityChecks.departmentId} is null and ${qualityChecks.workerId} in (select su.id from users su where su.role = 'WORKER' and su.worker_quality_role in (${roles}) and su.department_id in (${depts})))))`
}

/** Refuses a worker outside the scope (403). Admins and the Super Admin pass. */
export async function assertWorkerInScope(scope: DepartmentScope, workerId: string | null | undefined) {
  if (!scope.restricted) return
  const ids = await scopedWorkerIds(scope)
  if (!workerId || !ids!.includes(workerId)) throw new HttpError(403, FORBIDDEN)
}

/** Refuses a check outside the scope (403). */
export async function assertCheckInScope(scope: DepartmentScope, checkId: string) {
  const where = checkScopeWhere(scope)
  if (!where) return
  const [row] = await db.select({ id: qualityChecks.id }).from(qualityChecks).where(and(eq(qualityChecks.id, checkId), where))
  if (!row) throw new HttpError(403, FORBIDDEN)
}

/** Refuses work of a module (IPQC / QC) or department outside the scope (403); a null department passes. */
export function assertWorkInScope(scope: DepartmentScope, module: QualityModule | null | undefined, departmentId?: string | null) {
  if (!scope.restricted) return
  if (scope.missingDepartment) throw new HttpError(403, FORBIDDEN)
  if (module && !scope.modules.includes(module)) throw new HttpError(403, FORBIDDEN)
  if (departmentId && !scope.departmentIds.includes(departmentId)) throw new HttpError(403, FORBIDDEN)
}

/** The jobs this scope sees, as a condition on jobs (undefined: all): jobs of its departments. */
export function jobScopeWhere(scope: DepartmentScope): SQL | undefined {
  if (!scope.restricted) return undefined
  if (scope.missingDepartment) return blockAll
  return inArray(jobs.departmentId, scope.departmentIds)
}

/**
 * Refuses an account a Manager may not create or turn it into: only workers of their own area
 * (their IPQC / QC role and one of their departments). Admins and the Super Admin pass.
 */
export function assertAccountInScope(scope: DepartmentScope, account: { role: string; workerQualityRole?: string | null; departmentId?: string | null }) {
  if (!scope.restricted) return
  const roleOk = workerRoles(scope).includes((account.workerQualityRole ?? 'IPQC') as 'IPQC' | 'QC' | 'BOTH')
  if (scope.missingDepartment || account.role !== 'WORKER' || !roleOk || !account.departmentId || !scope.departmentIds.includes(account.departmentId)) {
    throw new HttpError(403, 'You can only manage workers of your own department')
  }
}
