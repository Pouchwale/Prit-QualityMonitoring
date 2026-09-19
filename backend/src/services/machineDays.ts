import { and, asc, eq, gte, inArray, lte } from 'drizzle-orm'
import { db } from '../db/client'
import { machineDayPlanMachines, machineDayPlans, machines, users } from '../db/schema'
import { dateKey } from '../lib/time'
import { invalidateCheckGeneration } from './checkGenerator'
import { closureOn, machineOffFn, plansBetween, removeChecksIfClosed } from './plantCalendar'

/**
 * Machine day plans: an Admin or Manager chooses, for one date, exactly which machines run.
 *
 *  - A date with a plan: the listed machines run, even on a weekly off, holiday or shutdown; every
 *    other machine is off that day, even when the plant is open. Off machines get no checks, no
 *    due alerts and cannot be started by hand.
 *  - A date without a plan: the plant calendar decides for every machine, as before.
 *
 * Plans are made for today and later only, so past checks, Missed counts and reports never change.
 * The per-machine decision itself lives in plantCalendar.ts (plansBetween, machineOffFn), which
 * the scheduler, the alerts and the closed-day cleanup all use.
 */

export { machineOffFn, plansBetween }

/** Shown when a plan leaves a machine out. */
export const NOT_SCHEDULED_LABEL = 'Not scheduled to run'

export interface MachineClosure {
  date: string
  label: string
  reason: string | null
  /** True when a machine day plan leaves the machine out; false when the plant is closed. */
  planned: boolean
  /** The plant calendar's closure, when the plant itself is closed that day. */
  plantClosed: boolean
}

/**
 * Why a machine does not run at an instant's date, or null when it runs: a plan for the date
 * decides (listed: runs; unlisted: "Not scheduled to run"), otherwise the plant calendar.
 */
export async function machineClosureOn(machineId: string, at: Date): Promise<MachineClosure | null> {
  return (await machineClosuresOn([machineId], at)).get(machineId) ?? null
}

/** machineClosureOn for several machines at once. Machines that run are absent from the map. */
export async function machineClosuresOn(machineIds: string[], at: Date) {
  const key = dateKey(at)
  const [plans, closure] = await Promise.all([plansBetween(key, key), closureOn(at)])
  const plan = plans.get(key)
  const result = new Map<string, MachineClosure>()
  for (const id of machineIds) {
    if (plan) {
      if (!plan.has(id)) result.set(id, { date: key, label: NOT_SCHEDULED_LABEL, reason: null, planned: true, plantClosed: !!closure })
    } else if (closure) {
      result.set(id, { date: key, label: closure.label, reason: closure.reason, planned: false, plantClosed: true })
    }
  }
  return { get: (id: string) => result.get(id) ?? null, plan: plan ?? null, closure }
}

export interface PlanDto {
  date: string
  note: string | null
  machineIds: string[]
  machines: { id: string; name: string; code: string }[]
  updatedAt: Date
  updatedByName: string | null
}

/** The plans between two date keys (inclusive), oldest first. */
export async function listPlans(fromKey: string, toKey: string): Promise<PlanDto[]> {
  const [plans, links] = await Promise.all([
    db
      .select({ date: machineDayPlans.date, note: machineDayPlans.note, updatedAt: machineDayPlans.updatedAt, updatedByName: users.name })
      .from(machineDayPlans)
      .leftJoin(users, eq(machineDayPlans.updatedById, users.id))
      .where(and(gte(machineDayPlans.date, fromKey), lte(machineDayPlans.date, toKey)))
      .orderBy(asc(machineDayPlans.date)),
    db
      .select({ date: machineDayPlanMachines.date, id: machines.id, name: machines.name, code: machines.code })
      .from(machineDayPlanMachines)
      .innerJoin(machines, eq(machineDayPlanMachines.machineId, machines.id))
      .where(and(gte(machineDayPlanMachines.date, fromKey), lte(machineDayPlanMachines.date, toKey)))
      .orderBy(asc(machines.name))
  ])
  return plans.map((p) => {
    const list = links.filter((l) => l.date === p.date).map(({ id, name, code }) => ({ id, name, code }))
    return { ...p, machineIds: list.map((m) => m.id), machines: list }
  })
}

export async function planOn(key: string) {
  return (await listPlans(key, key))[0] ?? null
}

/** Creates or replaces the plan of a date. Returns the plan before and after. */
export async function savePlan(date: string, machineIds: string[], note: string | null, userId: string) {
  const before = await planOn(date)
  const ids = [...new Set(machineIds)]
  await db.transaction(async (tx) => {
    await tx
      .insert(machineDayPlans)
      .values({ date, note, updatedById: userId, updatedAt: new Date() })
      .onConflictDoUpdate({ target: machineDayPlans.date, set: { note, updatedById: userId, updatedAt: new Date() } })
    await tx.delete(machineDayPlanMachines).where(eq(machineDayPlanMachines.date, date))
    if (ids.length) await tx.insert(machineDayPlanMachines).values(ids.map((machineId) => ({ date, machineId })))
  })
  return { before, after: (await planOn(date))! }
}

/** Removes a date's plan: the plant calendar decides again. Returns the removed plan, if any. */
export async function deletePlan(date: string) {
  const before = await planOn(date)
  if (before) await db.delete(machineDayPlans).where(eq(machineDayPlans.date, date))
  return before
}

/** Which of these machine ids exist. */
export async function existingMachineIds(ids: string[]) {
  if (ids.length === 0) return new Set<string>()
  const rows = await db.select({ id: machines.id }).from(machines).where(inArray(machines.id, ids))
  return new Set(rows.map((r) => r.id))
}

/**
 * After a plan changes: removes the unsubmitted checks (open ones, and ones already marked Missed
 * today) of machines that no longer run on these dates, and lets the scheduler create checks for
 * the machines that now run. Returns how many checks were removed.
 */
export async function removeChecksForPlanDates(keys: string[]) {
  const removed = await removeChecksIfClosed(keys)
  invalidateCheckGeneration()
  return removed
}
