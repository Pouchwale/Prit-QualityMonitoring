import type { CheckDto } from './checks'

/**
 * Traceability for the Quality Reports: what happened to one Item Code, Job No. or worker.
 *
 * Built from the checks of the report (all their readings, exceptions and who did them):
 *  - per Item Code, per Job No. and per worker: how many checks, results, readings and issues;
 *  - changes: a parameter reading that differs from the previous reading of the same parameter
 *    for the same item, job and machine, with who recorded it and when;
 *  - corrections: changes where the previous reading was outside its limits and the new one is
 *    back within them.
 * Submitted checks are never edited, so these are the changes the record can prove.
 */

export interface TraceCounts {
  checks: number
  completed: number
  missed: number
  exceptions: number
  open: number
  /** Parameter readings recorded in completed checks (Not Applicable not included). */
  readings: number
  outsideLimits: number
  notApplicable: number
  changes: number
  corrections: number
}

export interface TraceGroup extends TraceCounts {
  key: string
  itemCodes: string[]
  jobNos: string[]
  workers: string[]
  machines: string[]
  firstAt: Date | null
  lastAt: Date | null
}

export interface WorkerItem {
  itemCode: string
  jobNos: string[]
  checks: number
  completed: number
  missed: number
  exceptions: number
  changes: number
}

export interface TraceWorker extends TraceGroup {
  workerId: string | null
  name: string
  employeeId: string | null
  /** Every Item Code this worker checked, with its Job Nos. and number of checks. */
  items: WorkerItem[]
}

export interface TraceChange {
  at: Date
  checkId: string
  checkCode: string
  machineName: string
  machineCode: string
  itemCode: string
  jobNo: string
  parameterName: string
  unit: string | null
  from: string
  to: string
  fromResult: string
  toResult: string
  /** Previous reading outside limits, this one within: the issue was corrected. */
  correction: boolean
  /** Previous reading within limits (or without limits), this one outside. */
  wentOutside: boolean
  byName: string
  byEmployeeId: string | null
  byId: string | null
  previousAt: Date
  previousByName: string
}

export interface TraceReport {
  counts: TraceCounts
  items: TraceGroup[]
  jobs: TraceGroup[]
  workers: TraceWorker[]
  changes: TraceChange[]
}

/** The Item Code / Job No. of a check: its own, or the job's when it recorded none. */
export const itemCodeOf = (c: CheckDto) => (c.itemCode?.trim() || c.job?.itemCode?.trim() || '')
export const jobNoOf = (c: CheckDto) => (c.jobNo?.trim() || c.job?.jobNo?.trim() || '')
/** Who did the check: the worker who submitted it, else the worker it was assigned to. */
const doerOf = (c: CheckDto) => ({
  id: c.submittedById ?? c.workerId ?? null,
  name: c.submittedByName ?? c.workerName ?? 'Unassigned',
  employeeId: c.submittedByEmployeeId ?? c.workerEmployeeId ?? null
})
const whenOf = (c: CheckDto) => new Date(c.submittedAt ?? c.scheduledAt)

const emptyCounts = (): TraceCounts => ({
  checks: 0,
  completed: 0,
  missed: 0,
  exceptions: 0,
  open: 0,
  readings: 0,
  outsideLimits: 0,
  notApplicable: 0,
  changes: 0,
  corrections: 0
})

function addCheck(t: TraceCounts, c: CheckDto) {
  t.checks++
  if (c.result === 'COMPLETED') t.completed++
  else if (c.result === 'MISSED') t.missed++
  else if (c.result === 'EXCEPTION') t.exceptions++
  else t.open++
  if (c.result !== 'COMPLETED') return
  for (const v of c.values) {
    if (v.notApplicable) t.notApplicable++
    else if (v.value !== null && v.value !== '') {
      t.readings++
      if (v.result === 'FAIL') t.outsideLimits++
    }
  }
}

const sortText = (values: Iterable<string>) => [...values].filter(Boolean).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))

/** Same reading? Numbers compare by value ("20" = "20.0"), everything else as text, ignoring case. */
function sameValue(a: string, b: string) {
  const na = Number(a)
  const nb = Number(b)
  if (a.trim() !== '' && b.trim() !== '' && Number.isFinite(na) && Number.isFinite(nb)) return na === nb
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

const RESULT_TEXT: Record<string, string> = { PASS: 'Within limits', FAIL: 'Outside limits', NA: 'No limits' }

/**
 * Changes between consecutive readings. `context` is every check that can come before a
 * reported check (the same filters without the worker filter), so a change made by the chosen
 * worker is found even when the previous reading was taken by someone else.
 */
export function findChanges(context: CheckDto[]): TraceChange[] {
  const ordered = context.filter((c) => c.result === 'COMPLETED').sort((a, b) => whenOf(a).getTime() - whenOf(b).getTime())
  const last = new Map<string, { value: string; result: string; at: Date; byName: string }>()
  const changes: TraceChange[] = []
  for (const c of ordered) {
    const item = itemCodeOf(c)
    const job = jobNoOf(c)
    const doer = doerOf(c)
    for (const v of c.values) {
      if (v.notApplicable || v.value === null || v.value === '' || v.parameterType === 'PHOTO') continue
      const key = [item.toLowerCase(), job.toLowerCase(), c.machineId, v.parameterId ?? v.parameterName].join('|')
      const previous = last.get(key)
      if (previous && !sameValue(previous.value, v.value)) {
        changes.push({
          at: whenOf(c),
          checkId: c.id,
          checkCode: c.code,
          machineName: c.machineName,
          machineCode: c.machineCode,
          itemCode: item,
          jobNo: job,
          parameterName: v.parameterName,
          unit: v.unit,
          from: previous.value,
          to: v.value,
          fromResult: RESULT_TEXT[previous.result] ?? previous.result,
          toResult: RESULT_TEXT[v.result ?? ''] ?? v.result ?? '',
          correction: previous.result === 'FAIL' && v.result === 'PASS',
          wentOutside: previous.result !== 'FAIL' && v.result === 'FAIL',
          byName: doer.name,
          byEmployeeId: doer.employeeId,
          byId: doer.id,
          previousAt: previous.at,
          previousByName: previous.byName
        })
      }
      last.set(key, { value: v.value, result: v.result ?? 'NA', at: whenOf(c), byName: doer.name })
    }
  }
  return changes
}

function groupChecks(checks: CheckDto[], changes: TraceChange[], keyOf: (c: CheckDto) => string): TraceGroup[] {
  const groups = new Map<string, TraceGroup & { sets: { items: Set<string>; jobs: Set<string>; workers: Set<string>; machines: Set<string> } }>()
  for (const c of checks) {
    const key = keyOf(c)
    const g =
      groups.get(key) ??
      {
        key,
        ...emptyCounts(),
        itemCodes: [],
        jobNos: [],
        workers: [],
        machines: [],
        firstAt: null,
        lastAt: null,
        sets: { items: new Set<string>(), jobs: new Set<string>(), workers: new Set<string>(), machines: new Set<string>() }
      }
    addCheck(g, c)
    g.sets.items.add(itemCodeOf(c))
    g.sets.jobs.add(jobNoOf(c))
    g.sets.workers.add(doerOf(c).name)
    g.sets.machines.add(c.machineName)
    const at = whenOf(c)
    if (!g.firstAt || at < g.firstAt) g.firstAt = at
    if (!g.lastAt || at > g.lastAt) g.lastAt = at
    groups.set(key, g)
  }
  const byCheck = new Map(checks.map((c) => [c.id, c]))
  for (const ch of changes) {
    const c = byCheck.get(ch.checkId)
    const g = c && groups.get(keyOf(c))
    if (!g) continue
    g.changes++
    if (ch.correction) g.corrections++
  }
  return [...groups.values()]
    .map(({ sets, ...g }) => ({ ...g, itemCodes: sortText(sets.items), jobNos: sortText(sets.jobs), workers: sortText(sets.workers), machines: sortText(sets.machines) }))
    .sort((a, b) => (a.key === '' ? 1 : b.key === '' ? -1 : a.key.localeCompare(b.key, undefined, { numeric: true })))
}

/**
 * @param checks  the checks of the report (every filter applied)
 * @param context the checks that can precede them (the same filters without the worker filter)
 */
export function buildTraceReport(checks: CheckDto[], context: CheckDto[]): TraceReport {
  const ids = new Set(checks.map((c) => c.id))
  const changes = findChanges(context).filter((ch) => ids.has(ch.checkId))

  const counts = emptyCounts()
  for (const c of checks) addCheck(counts, c)
  counts.changes = changes.length
  counts.corrections = changes.filter((ch) => ch.correction).length

  const items = groupChecks(checks, changes, (c) => itemCodeOf(c).toLowerCase()).map((g) => ({ ...g, key: g.itemCodes[0] ?? '' }))
  const jobs = groupChecks(checks, changes, (c) => jobNoOf(c).toLowerCase()).map((g) => ({ ...g, key: g.jobNos[0] ?? '' }))

  const workerGroups = groupChecks(checks, changes, (c) => doerOf(c).id ?? doerOf(c).name)
  const workers: TraceWorker[] = workerGroups.map((g) => {
    const mine = checks.filter((c) => (doerOf(c).id ?? doerOf(c).name) === g.key)
    const doer = doerOf(mine[0])
    const perItem = new Map<string, WorkerItem & { jobSet: Set<string> }>()
    for (const c of mine) {
      const code = itemCodeOf(c)
      const row = perItem.get(code.toLowerCase()) ?? { itemCode: code, jobNos: [], checks: 0, completed: 0, missed: 0, exceptions: 0, changes: 0, jobSet: new Set<string>() }
      row.checks++
      if (c.result === 'COMPLETED') row.completed++
      if (c.result === 'MISSED') row.missed++
      if (c.result === 'EXCEPTION') row.exceptions++
      row.changes += changes.filter((ch) => ch.checkId === c.id).length
      row.jobSet.add(jobNoOf(c))
      perItem.set(code.toLowerCase(), row)
    }
    return {
      ...g,
      workerId: doer.id,
      name: doer.name,
      employeeId: doer.employeeId,
      items: [...perItem.values()]
        .map(({ jobSet, ...row }) => ({ ...row, jobNos: sortText(jobSet) }))
        .sort((a, b) => (a.itemCode === '' ? 1 : b.itemCode === '' ? -1 : a.itemCode.localeCompare(b.itemCode, undefined, { numeric: true })))
    }
  })
  workers.sort((a, b) => a.name.localeCompare(b.name))

  return { counts, items, jobs, workers, changes: changes.sort((a, b) => a.at.getTime() - b.at.getTime()) }
}
