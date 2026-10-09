import { and, asc, eq, exists, inArray } from 'drizzle-orm'
import { db } from '../db/client'
import { activities, activityParameters, departments, machineActivities, parameters, users } from '../db/schema'

/**
 * Departments decide which quality checks are done. Workers and machines are shared, so the
 * department belongs to the work: a job's department comes from its Item Code prefix (RMLA -> Label,
 * RMPO -> Pouch, RMSL -> Sleeve; services/itemCodeDepartment.ts), worked out by the backend when the
 * job is planned or started, and only the check types of that department are done on the job
 * (services/jobMonitoring.ts). Nobody picks the department by hand, and the worker's account never
 * decides a job's department.
 *
 * A check type that names a department is only done for that department's work; a check type with
 * no department belongs to the whole plant and is done on every job, whatever its department.
 *
 * This is enforced in the API, not in the apps: the worker app only ever receives the check types
 * it may show, so an older installed app is scoped too.
 */
export const checkTypeInDepartment = (activityDepartmentId: string | null, workDepartmentId: string | null) =>
  activityDepartmentId === null || activityDepartmentId === workDepartmentId

export interface JobDepartment {
  id: string
  name: string
}

/**
 * The departments a job on each machine can be for: the active departments with at least one active
 * check type on the machine that has enabled parameters. A check type with no department serves
 * every job, so with one of those every active department is on the list. A job whose Item Code
 * names a department that is not on it is refused when it is planned or started
 * (services/jobMonitoring.ts).
 */
export async function jobDepartmentOptions(machineIds: string[]): Promise<Map<string, JobDepartment[]>> {
  const result = new Map<string, JobDepartment[]>()
  if (machineIds.length === 0) return result
  const [links, active] = await Promise.all([
    db
      .selectDistinct({ machineId: machineActivities.machineId, departmentId: activities.departmentId })
      .from(machineActivities)
      .innerJoin(activities, eq(machineActivities.activityId, activities.id))
      .where(
        and(
          inArray(machineActivities.machineId, machineIds),
          eq(activities.isActive, true),
          exists(
            db
              .select({ id: activityParameters.parameterId })
              .from(activityParameters)
              .innerJoin(parameters, eq(activityParameters.parameterId, parameters.id))
              .where(and(eq(activityParameters.activityId, activities.id), eq(activityParameters.isEnabled, true), eq(parameters.isActive, true)))
          )
        )
      ),
    db.select({ id: departments.id, name: departments.name }).from(departments).where(eq(departments.isActive, true)).orderBy(asc(departments.name))
  ])
  for (const machineId of machineIds) {
    const mine = links.filter((l) => l.machineId === machineId)
    const plantWide = mine.some((l) => l.departmentId === null)
    result.set(machineId, active.filter((d) => plantWide || mine.some((l) => l.departmentId === d.id)))
  }
  return result
}

/**
 * The department on a user's account, or null when they have none. It never decides a job's
 * department; it is only used for a shift check type started by hand when no job is running.
 */
export async function userDepartmentId(userId: string): Promise<string | null> {
  const [row] = await db.select({ departmentId: users.departmentId }).from(users).where(eq(users.id, userId))
  return row?.departmentId ?? null
}
