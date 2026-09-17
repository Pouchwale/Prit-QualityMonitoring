import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm'
import { db } from '../db/client'
import { qualityChecks, schedules, shifts, users, workerMachines } from '../db/schema'
import { parseHHMM } from '../lib/time'

/**
 * Who does a quality check. Every check is stored with the worker responsible for it.
 *
 * The worker is chosen from the Machine Assignment (the machines each worker handles) and
 * each worker's shift, in this order:
 *   1. the worker named on the schedule, if that worker can still use the app and is assigned
 *      to the machine;
 *   2. workers assigned to the machine who work the check's shift;
 *   3. workers assigned to the machine who have no fixed shift.
 * When several workers qualify, checks are shared: each slot goes to the one with the fewest
 * checks so far. When nobody qualifies, the shift has no worker for that machine: no checks
 * are created for it and the admin sees the gap on the Schedules, Machine Assignment and
 * Dashboard pages (coverageGaps). Nothing is ever left "unassigned".
 *
 * Open checks follow assignment changes: reassignOpenChecks() moves them to the right worker
 * (or removes them when nobody can do them) before statuses are refreshed.
 */

export interface EligibleWorker {
  id: string
  name: string
  employeeId: string
  shiftId: string | null
  machineIds: Set<string>
}

/** Active workers who can sign in to the app, with their machines. */
export async function loadWorkers(): Promise<EligibleWorker[]> {
  const rows = await db
    .select({ id: users.id, name: users.name, employeeId: users.employeeId, shiftId: users.shiftId })
    .from(users)
    .where(and(eq(users.role, 'WORKER'), eq(users.isActive, true), eq(users.appAccess, true)))
  if (rows.length === 0) return []
  const access = await db
    .select()
    .from(workerMachines)
    .where(inArray(workerMachines.userId, rows.map((r) => r.id)))
  return rows
    .map((r) => ({ ...r, machineIds: new Set(access.filter((a) => a.userId === r.id).map((a) => a.machineId)) }))
    .sort((a, b) => a.employeeId.localeCompare(b.employeeId))
}

/**
 * Workers who may do a check on this machine and shift, best match first.
 * `shiftId` null (a one-off check with no shift) accepts any worker assigned to the machine.
 */
export function eligibleWorkers(workers: EligibleWorker[], machineId: string, shiftId: string | null, preferredWorkerId: string | null) {
  const onMachine = workers.filter((w) => w.machineIds.has(machineId))
  if (preferredWorkerId) {
    const preferred = onMachine.find((w) => w.id === preferredWorkerId)
    if (preferred) return [preferred]
  }
  if (shiftId === null) return onMachine
  const onShift = onMachine.filter((w) => w.shiftId === shiftId)
  return onShift.length ? onShift : onMachine.filter((w) => w.shiftId === null)
}

/** Picks the candidate with the fewest checks counted in `load`, and counts the new one. */
export function pickWorker(candidates: EligibleWorker[], load: Map<string, number>) {
  if (candidates.length === 0) return null
  const chosen = candidates.reduce((best, w) => ((load.get(w.id) ?? 0) < (load.get(best.id) ?? 0) ? w : best))
  load.set(chosen.id, (load.get(chosen.id) ?? 0) + 1)
  return chosen
}

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`

/**
 * Makes every open check (not submitted, still pending or due) belong to the right worker:
 * keeps the current worker while still eligible, otherwise moves the check to an eligible one,
 * and removes it when no worker can do it.
 */
export async function reassignOpenChecks() {
  const open = await db
    .select({
      id: qualityChecks.id,
      machineId: qualityChecks.machineId,
      shiftId: qualityChecks.shiftId,
      workerId: qualityChecks.workerId,
      scheduleId: qualityChecks.scheduleId,
      scheduledAt: qualityChecks.scheduledAt,
      scheduleWorkerId: schedules.workerId
    })
    .from(qualityChecks)
    .leftJoin(schedules, eq(qualityChecks.scheduleId, schedules.id))
    .where(and(inArray(qualityChecks.status, ['PENDING', 'DUE', 'IN_PROGRESS']), isNull(qualityChecks.submittedAt)))
  if (open.length === 0) return { moved: 0, removed: 0 }
  return settle(open, await loadWorkers())
}

type OpenCheck = {
  id: string
  machineId: string
  shiftId: string | null
  workerId: string | null
  scheduleId: string | null
  scheduledAt: Date
  scheduleWorkerId: string | null
}

async function settle(checks: OpenCheck[], workers: EligibleWorker[]) {
  // Existing assignments count towards each worker's load for the day.
  const load = new Map<string, Map<string, number>>()
  const loadFor = (d: Date) => {
    const key = dayKey(d)
    if (!load.has(key)) load.set(key, new Map())
    return load.get(key)!
  }

  const moves = new Map<string, string[]>()
  const remove: string[] = []
  const pending: { check: OpenCheck; candidates: EligibleWorker[] }[] = []

  for (const check of checks) {
    // A one-off check keeps the worker the admin chose, if still eligible.
    const preferred = check.scheduleId ? check.scheduleWorkerId : check.workerId
    const candidates = eligibleWorkers(workers, check.machineId, check.shiftId, preferred)
    if (candidates.length === 0) remove.push(check.id)
    else if (check.workerId && candidates.some((w) => w.id === check.workerId)) {
      const day = loadFor(check.scheduledAt)
      day.set(check.workerId, (day.get(check.workerId) ?? 0) + 1)
    } else pending.push({ check, candidates })
  }

  for (const { check, candidates } of pending.sort((a, b) => a.check.scheduledAt.getTime() - b.check.scheduledAt.getTime())) {
    const worker = pickWorker(candidates, loadFor(check.scheduledAt))!
    moves.set(worker.id, [...(moves.get(worker.id) ?? []), check.id])
  }

  for (const [workerId, ids] of moves) {
    // notifiedAt is cleared so the new worker still gets the alert for a check that is already due.
    await db.update(qualityChecks).set({ workerId, notifiedAt: null }).where(inArray(qualityChecks.id, ids))
  }
  if (remove.length) await db.delete(qualityChecks).where(inArray(qualityChecks.id, remove))
  return { moved: pending.length, removed: remove.length }
}

/**
 * One-off repair for checks stored before every check had a worker (runs at startup, safe to
 * repeat):
 *  - submitted checks take the worker who submitted them;
 *  - missed checks take the worker responsible under the current Machine Assignment;
 *  - missed checks that no worker could ever have done (their shift has no worker on that
 *    machine) are removed, the same as checks that are no longer created for such shifts;
 *  - open checks are settled by reassignOpenChecks().
 */
export async function repairCheckWorkers() {
  const fromSubmitter = await db
    .update(qualityChecks)
    .set({ workerId: qualityChecks.submittedById })
    .where(and(isNull(qualityChecks.workerId), isNotNull(qualityChecks.submittedById)))
    .returning({ id: qualityChecks.id })

  const missed = await db
    .select({
      id: qualityChecks.id,
      machineId: qualityChecks.machineId,
      shiftId: qualityChecks.shiftId,
      workerId: qualityChecks.workerId,
      scheduleId: qualityChecks.scheduleId,
      scheduledAt: qualityChecks.scheduledAt,
      scheduleWorkerId: schedules.workerId
    })
    .from(qualityChecks)
    .leftJoin(schedules, eq(qualityChecks.scheduleId, schedules.id))
    .where(and(isNull(qualityChecks.workerId), isNull(qualityChecks.submittedAt)))

  const settled = missed.length ? await settle(missed, await loadWorkers()) : { moved: 0, removed: 0 }
  const open = await reassignOpenChecks()
  const total = fromSubmitter.length + settled.moved + settled.removed + open.moved + open.removed
  if (total) {
    console.log(
      `Check workers repaired: ${fromSubmitter.length} from the submitter, ${settled.moved + open.moved} assigned from Machine Assignment, ` +
        `${settled.removed + open.removed} removed (no worker on that machine and shift)`
    )
  }
  return { fromSubmitter: fromSubmitter.length, assigned: settled.moved + open.moved, removed: settled.removed + open.removed }
}

/** Whether HH:MM falls inside a shift (overnight shifts wrap past midnight). */
function inShift(minutes: number, start: string, end: string) {
  const s = parseHHMM(start)
  const e = parseHHMM(end)
  const from = s.h * 60 + s.m
  const to = e.h * 60 + e.m
  return from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to
}

/** The active shift running at a moment, used for one-off checks. */
export async function shiftAt(moment: Date) {
  const minutes = moment.getHours() * 60 + moment.getMinutes()
  const rows = await db.select().from(shifts).where(eq(shifts.isActive, true))
  return rows.find((s) => inShift(minutes, s.startTime, s.endTime)) ?? null
}

/** Active schedules that cannot create checks because no worker covers their machine and shift. */
export async function coverageGaps() {
  const [workers, rows] = await Promise.all([
    loadWorkers(),
    db
      .select({ id: schedules.id, machineId: schedules.machineId, shiftId: schedules.shiftId, workerId: schedules.workerId })
      .from(schedules)
      .where(eq(schedules.isActive, true))
  ])
  return rows.filter((s) => eligibleWorkers(workers, s.machineId, s.shiftId, s.workerId).length === 0).map((s) => s.id)
}
