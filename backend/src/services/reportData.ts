import { db } from '../db/client'
import { mediaPathFromUrl } from '../lib/mediaLinks'
import { parameters, settings, shifts } from '../db/schema'
import { PLANT_TIMEZONE, dateKey, formatClock, formatLocalDate, formatLocalTime, localParts } from '../lib/time'
import { listChecks, type CheckDto } from '../services/checks'
import { buildTraceReport, itemCodeOf, jobNoOf, type TraceReport } from './traceReport'
import type { CheckFilters } from '../services/checks'
import { RESULT_LABEL, resultOf } from '../lib/result'

/**
 * Everything the Quality Monitoring Report shows, assembled from the database in one
 * place so that every section reconciles with the detailed check log.
 *
 * Every check has one Result (lib/result.ts), which only tracks whether the worker did it:
 *   Scheduled = Completed + Missed + Exception + Open
 *
 *   Completed  the worker completed the check and submitted the photo/video and form
 *   Missed     not completed or submitted within the required time
 *   Exception  the worker could not do the check and submitted exception details and evidence
 *   Open       not finished yet at the time of generation, so no status to show
 *
 *   Completion Rate = Completed / Scheduled
 *
 * Parameter readings are reported separately with their own PASS/FAIL against the limits.
 * They never change a check's Result: a check with a reading outside limits is still Completed.
 *
 * Nothing is invented: fields the system does not hold are reported as "Not Available".
 */

export const NOT_AVAILABLE = 'Not Available'
export const NO_REASON = 'Reason not provided'
const DASH = '-'

export interface ReportFilters extends CheckFilters {
  from: Date
  to: Date
}

export interface StatusCounts {
  scheduled: number
  completed: number
  exception: number
  missed: number
  open: number
}

export interface GroupRow {
  label: string
  sublabel: string
  /** Used for ordering when the label is not sortable, e.g. DD/MM/YYYY dates. */
  sortKey?: string
  counts: StatusCounts
  completionRate: number | null
  remark: string
  lastCheckAt: Date | null
}

export interface ReportMeta {
  company: string
  department: string
  plant: string | null
  periodFrom: Date
  /** Inclusive last day of the period. */
  periodTo: Date
  generatedAt: Date
  reportId: string
  preparedBy: string
  status: string
  filters: string[]
}

export interface LogRow {
  code: string
  scheduledAt: Date
  submittedAt: Date | null
  machineName: string
  machineCode: string
  activityName: string
  workerName: string
  workerEmployeeId: string
  shiftName: string
  status: CheckDto['status']
  /** Completed, Missed, Exception, or "-" while open. */
  result: string
  exception: string
  remarks: string
}

export interface ParameterRow {
  name: string
  value: string
  standard: string
  unit: string
  min: string
  max: string
  /** The reading's own result against its limits (NA when the parameter has no limits). */
  result: 'PASS' | 'FAIL' | 'NA'
  /**
   * The parameter was recorded as Not Applicable: either the worker chose a reason, or it only
   * applies while a job runs and none was running. An N/A is never a failed reading.
   */
  notApplicable: boolean
  /** Reason label recorded with the N/A, and the worker's remark. */
  naReason: string
  naRemark: string
}

/** Recorded parameter readings in completed checks, counted separately from check Results. */
export interface ReadingSummary {
  recorded: number
  withinLimits: number
  outsideLimits: number
  /** Readings of parameters that have no acceptance limits. */
  noLimits: number
  checksWithOutside: number
  /** Parameters recorded as Not Applicable. They carry no reading and never count as a failure. */
  notApplicable: number
}

/** One parameter that was marked Not Applicable, with the reasons the workers gave. */
export interface NotApplicableRow {
  parameterId: string | null
  name: string
  count: number
  /** How many of those N/A records used each reason. */
  reasons: { reason: string; count: number }[]
}

/** Not Applicable records in the period, per parameter and per reason. */
export interface NotApplicableSummary {
  /** Parameters recorded as Not Applicable. */
  total: number
  /** Completed checks with at least one Not Applicable parameter. */
  checks: number
  byParameter: NotApplicableRow[]
}

/** How the completed checks were started: by a notification, or by the worker. */
export interface SubmissionTypeCounts {
  notification: number
  manual: number
}

/** A completed check with at least one reading outside its limits. Its Result is still Completed. */
export interface OutOfLimitsRow {
  code: string
  submittedAt: Date | null
  machineName: string
  activityName: string
  workerName: string
  shiftName: string
  parameters: ParameterRow[]
}

export interface CompletedDetail {
  code: string
  machineName: string
  machineCode: string
  activityName: string
  submittedAt: Date | null
  scheduledAt: Date
  workerName: string
  workerEmployeeId: string
  shiftName: string
  itemCode: string
  jobNo: string
  status: CheckDto['status']
  parameters: ParameterRow[]
  photos: number
  videos: number
  /** "Notification" or "Manual": how the worker came to this check. */
  submissionType: string
  /** Parameters recorded as Not Applicable in this check. */
  notApplicable: number
}

export interface EvidenceItem {
  code: string
  machineName: string
  activityName: string
  workerName: string
  capturedAt: Date | null
  /** Absolute path on disk; the renderer embeds the image. */
  path: string
  kind: 'PHOTO' | 'VIDEO'
  /** The parameter this evidence was captured for; null for overall (or legacy) check evidence. */
  parameterId: string | null
  /** The parameter's name, or "Overall check evidence" when it belongs to the whole check. */
  parameterName: string
}

/** Evidence of one parameter. Media captured for the whole check forms its own group. */
export interface EvidenceGroup {
  parameterId: string | null
  parameterName: string
  photos: number
  videos: number
  items: EvidenceItem[]
}

export interface IssueRow {
  type: 'MISSED' | 'EXCEPTION' | 'OUT OF LIMITS'
  code: string
  when: Date
  machineName: string
  activityName: string
  workerName: string
  shiftName: string
  description: string
  status: string
  action: string
  capa: string
}

export interface QualityReport {
  meta: ReportMeta
  counts: StatusCounts
  completionRate: number | null
  reconciles: boolean
  breakdown: { label: string; count: number; percent: number }[]
  byMachine: GroupRow[]
  byWorker: GroupRow[]
  byShift: GroupRow[]
  byDate: GroupRow[]
  log: LogRow[]
  completedDetails: CompletedDetail[]
  missed: {
    code: string
    scheduledAt: Date
    machineName: string
    machineCode: string
    activityName: string
    workerName: string
    shiftName: string
    reason: string
    remarks: string
    state: string
  }[]
  exceptions: {
    code: string
    submittedAt: Date | null
    machineName: string
    activityName: string
    workerName: string
    shiftName: string
    reason: string
    description: string
    evidence: string
    remarks: string
    status: string
    action: string
  }[]
  evidence: EvidenceItem[]
  /** The same evidence, grouped per parameter, with the overall check evidence as its own group. */
  evidenceGroups: EvidenceGroup[]
  issues: IssueRow[]
  readings: ReadingSummary
  /** Per-parameter Not Applicable counts with the reasons given. */
  notApplicable: NotApplicableSummary
  /** Reason label → how many times it was used, most used first. */
  naReasons: { reason: string; count: number }[]
  submissionTypes: SubmissionTypeCounts
  outOfLimits: OutOfLimitsRow[]
  analysis: string[]
  /** Traceability for an Item Code, Job No. or worker report; null for a general report. */
  trace: TraceReport | null
}

const rate = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null)

const emptyCounts = (): StatusCounts => ({ scheduled: 0, completed: 0, exception: 0, missed: 0, open: 0 })

function tally(counts: StatusCounts, status: CheckDto['status']) {
  counts.scheduled++
  const result = resultOf(status)
  if (result === 'COMPLETED') counts.completed++
  else if (result === 'EXCEPTION') counts.exception++
  else if (result === 'MISSED') counts.missed++
  else counts.open++
}

/** Short factual note pointing at monitoring gaps. */
function remarkFor(counts: StatusCounts) {
  const parts: string[] = []
  if (counts.missed) parts.push(`${counts.missed} missed`)
  if (counts.exception) parts.push(`${counts.exception} exception${counts.exception === 1 ? '' : 's'}`)
  if (counts.open) parts.push(`${counts.open} open`)
  return parts.length ? parts.join(', ') : 'No gaps'
}

function group(
  checks: CheckDto[],
  keyOf: (c: CheckDto) => { key: string; label: string; sublabel: string; sortKey?: string }
): GroupRow[] {
  const rows = new Map<string, GroupRow>()
  for (const check of checks) {
    const { key, label, sublabel, sortKey } = keyOf(check)
    const row = rows.get(key) ?? {
      label,
      sublabel,
      sortKey,
      counts: emptyCounts(),
      completionRate: null,
      remark: '',
      lastCheckAt: null
    }
    tally(row.counts, check.status)
    const submitted = check.submittedAt ? new Date(check.submittedAt) : null
    if (submitted && (!row.lastCheckAt || submitted > row.lastCheckAt)) row.lastCheckAt = submitted
    rows.set(key, row)
  }
  for (const row of rows.values()) {
    row.completionRate = rate(row.counts.completed, row.counts.scheduled)
    row.remark = remarkFor(row.counts)
  }
  return [...rows.values()].sort((a, b) => (a.sortKey ?? a.label).localeCompare(b.sortKey ?? b.label))
}

const workerOf = (c: CheckDto) => ({
  name: c.submittedByName ?? c.workerName ?? DASH,
  employeeId: c.submittedByEmployeeId ?? c.workerEmployeeId ?? DASH
})

const resultLabel = (c: CheckDto) => (c.result ? RESULT_LABEL[c.result] : DASH)

const EXCEPTION_STATE: Record<string, string> = {
  UNDER_REVIEW: 'Under review',
  ACKNOWLEDGED: 'Acknowledged',
  ACTION_TAKEN: 'Action taken',
  RESOLVED: 'Resolved'
}

/** Label shown for a parameter the worker did not record a reading for. */
export const NOT_APPLICABLE = 'Not Applicable'
/** Evidence that belongs to the whole check rather than to one parameter. */
export const OVERALL_EVIDENCE = 'Overall check evidence'

function parameterRows(check: CheckDto, limits: Map<string, { min: number | null; max: number | null }>): ParameterRow[] {
  return check.values.map((v) => {
    const limit = v.parameterId ? limits.get(v.parameterId) : undefined
    return {
      name: v.parameterName,
      // An N/A parameter has no reading; the reason is printed next to it.
      value: v.notApplicable ? NOT_APPLICABLE : (v.value ?? DASH),
      standard: v.rule ?? DASH,
      unit: v.unit ?? DASH,
      min: limit?.min != null ? String(limit.min) : DASH,
      max: limit?.max != null ? String(limit.max) : DASH,
      result: v.result,
      notApplicable: v.notApplicable,
      naReason: v.naReason ?? (v.notApplicable ? NO_REASON : DASH),
      naRemark: v.naRemark ?? DASH
    }
  })
}

const SUBMISSION_LABEL: Record<string, string> = { NOTIFICATION: 'Notification', MANUAL: 'Manual' }

/** Builds the whole report for a date range. */
export async function buildQualityReport(
  filters: ReportFilters,
  context: {
    preparedBy: string
    uploadDir: string
    filterLabels: string[]
    /**
     * Add the traceability sections (per Item Code, Job No. and worker, changes and corrections).
     * `context` holds the checks that can precede the reported ones (same filters without the
     * worker filter); the reported checks themselves are used when it is left out.
     */
    trace?: { context?: CheckDto[] }
  }
): Promise<QualityReport> {
  const [checks, settingRows, allShifts, allParameters] = await Promise.all([
    listChecks(filters, { order: 'asc' }),
    db.select().from(settings),
    db.select().from(shifts),
    db
      .select({ id: parameters.id, name: parameters.name, minValue: parameters.minValue, maxValue: parameters.maxValue })
      .from(parameters)
  ])

  const setting = (key: string) => {
    const row = settingRows.find((s) => s.key === key)
    return row && typeof row.value === 'object' && row.value !== null ? (row.value as Record<string, unknown>) : undefined
  }
  const company = (setting('company')?.name as string) ?? 'Gujarat Print Pack Publications Pvt. Ltd.'
  const plant = (setting('plant')?.name as string) ?? null
  const department = (setting('company')?.department as string) ?? 'Quality / IPQC'

  const limits = new Map(allParameters.map((p) => [p.id, { min: p.minValue, max: p.maxValue }]))
  const parameterNames = new Map(allParameters.map((p) => [p.id, p.name]))
  const generatedAt = new Date()
  const lastDay = new Date(filters.to.getTime() - 1)

  const counts = emptyCounts()
  for (const check of checks) tally(counts, check.status)

  const breakdown = [
    { label: 'Completed', count: counts.completed },
    { label: 'Missed', count: counts.missed },
    { label: 'Exception', count: counts.exception },
    { label: 'Open (not finished)', count: counts.open }
  ].map((b) => ({ ...b, percent: rate(b.count, counts.scheduled) ?? 0 }))

  // Every shift in the period, including shifts with no checks at all.
  const shiftRows = group(checks, (c) => ({
    key: c.shiftId ?? 'none',
    label: c.shiftName ?? 'No shift',
    sublabel: ''
  }))
  for (const shift of allShifts) {
    if (!shiftRows.some((r) => r.label === shift.name)) continue
    const row = shiftRows.find((r) => r.label === shift.name)!
    row.sublabel = `${formatClock(shift.startTime)} – ${formatClock(shift.endTime)}`
  }

  const log: LogRow[] = checks.map((c) => {
    const worker = workerOf(c)
    return {
      code: c.code,
      scheduledAt: new Date(c.scheduledAt),
      submittedAt: c.submittedAt ? new Date(c.submittedAt) : null,
      machineName: c.machineName,
      machineCode: c.machineCode,
      activityName: c.activityName,
      workerName: worker.name,
      workerEmployeeId: worker.employeeId,
      shiftName: c.shiftName ?? DASH,
      status: c.status,
      result: resultLabel(c),
      exception: c.exception?.reason ?? DASH,
      remarks: [itemCodeOf(c) ? `Item Code ${itemCodeOf(c)}` : null, jobNoOf(c) ? `Job No. ${jobNoOf(c)}` : null].filter(Boolean).join(' · ') || DASH
    }
  })

  const completedDetails: CompletedDetail[] = checks
    .filter((c) => c.result === 'COMPLETED')
    .map((c) => {
      const worker = workerOf(c)
      return {
        code: c.code,
        machineName: c.machineName,
        machineCode: c.machineCode,
        activityName: c.activityName,
        submittedAt: c.submittedAt ? new Date(c.submittedAt) : null,
        scheduledAt: new Date(c.scheduledAt),
        workerName: worker.name,
        workerEmployeeId: worker.employeeId,
        shiftName: c.shiftName ?? DASH,
        itemCode: itemCodeOf(c) || DASH,
        jobNo: jobNoOf(c) || DASH,
        status: c.status,
        parameters: parameterRows(c, limits),
        photos: c.media.filter((m) => m.kind === 'PHOTO').length,
        videos: c.media.filter((m) => m.kind === 'VIDEO').length,
        submissionType: c.submissionType ? (SUBMISSION_LABEL[c.submissionType] ?? c.submissionType) : NOT_AVAILABLE,
        notApplicable: c.values.filter((v) => v.notApplicable).length
      }
    })

  const missed = checks
    .filter((c) => c.status === 'MISSED')
    .map((c) => {
      const worker = workerOf(c)
      return {
        code: c.code,
        scheduledAt: new Date(c.scheduledAt),
        machineName: c.machineName,
        machineCode: c.machineCode,
        activityName: c.activityName,
        workerName: `${worker.name} (${worker.employeeId})`,
        shiftName: c.shiftName ?? DASH,
        // The system records no reason for a missed check; nothing is assumed here.
        reason: NO_REASON,
        remarks: `Window closed ${formatDateTime(new Date(c.windowEndsAt))}`,
        state: 'Open'
      }
    })

  const exceptions = checks
    .filter((c) => c.exception)
    .map((c) => {
      const worker = workerOf(c)
      const exc = c.exception!
      return {
        code: c.code,
        submittedAt: c.submittedAt ? new Date(c.submittedAt) : null,
        machineName: c.machineName,
        activityName: c.activityName,
        workerName: `${worker.name} (${worker.employeeId})`,
        shiftName: c.shiftName ?? DASH,
        reason: exc.reason,
        description: exc.remark ?? NO_REASON,
        evidence: exc.media.length ? `${exc.media.length} photo${exc.media.length === 1 ? '' : 's'}` : 'None',
        remarks: exc.reviewedByName ? `Reviewed by ${exc.reviewedByName}` : DASH,
        status: EXCEPTION_STATE[exc.status] ?? exc.status,
        action: exc.resolutionNotes ?? NOT_AVAILABLE
      }
    })

  const evidence: EvidenceItem[] = []
  for (const c of checks) {
    const worker = workerOf(c)
    for (const m of [...c.media, ...(c.exception?.media ?? [])]) {
      // The parameter name comes from the check's own snapshot first, so it survives a rename.
      const name = m.parameterId
        ? (c.values.find((v) => v.parameterId === m.parameterId)?.parameterName ??
          parameterNames.get(m.parameterId) ??
          NOT_AVAILABLE)
        : OVERALL_EVIDENCE
      evidence.push({
        code: c.code,
        machineName: `${c.machineName} (${c.machineCode})`,
        activityName: c.activityName,
        workerName: `${worker.name} (${worker.employeeId})`,
        capturedAt: m.capturedAt ? new Date(m.capturedAt) : null,
        path: `${context.uploadDir}/${mediaPathFromUrl(m.url) ?? ''}`,
        kind: m.kind,
        parameterId: m.parameterId,
        parameterName: name
      })
    }
  }

  // Grouped per parameter for the appendix; the overall (and legacy) evidence is its own group,
  // kept last so the per-parameter evidence reads first.
  const evidenceGroups: EvidenceGroup[] = []
  for (const item of evidence) {
    const key = item.parameterId ?? ''
    let group = evidenceGroups.find((g) => (g.parameterId ?? '') === key)
    if (!group) {
      group = { parameterId: item.parameterId, parameterName: item.parameterName, photos: 0, videos: 0, items: [] }
      evidenceGroups.push(group)
    }
    group.items.push(item)
    if (item.kind === 'PHOTO') group.photos++
    else group.videos++
  }
  evidenceGroups.sort((a, b) =>
    a.parameterId === null ? 1 : b.parameterId === null ? -1 : a.parameterName.localeCompare(b.parameterName)
  )

  // Parameter readings: separate recorded data, never part of a check's Result.
  const completedChecks = checks.filter((c) => c.result === 'COMPLETED')
  const allReadings = completedChecks.flatMap((c) => c.values.filter((v) => v.value !== null && v.value !== ''))
  const readings: ReadingSummary = {
    recorded: allReadings.length,
    withinLimits: allReadings.filter((v) => v.result === 'PASS').length,
    outsideLimits: allReadings.filter((v) => v.result === 'FAIL').length,
    noLimits: allReadings.filter((v) => v.result === 'NA').length,
    checksWithOutside: completedChecks.filter((c) => c.values.some((v) => v.result === 'FAIL')).length,
    notApplicable: completedChecks.flatMap((c) => c.values).filter((v) => v.notApplicable).length
  }

  // Not Applicable, per parameter and per reason. An N/A carries no reading, so it is counted
  // here and never in `readings.recorded` — the reading totals stay reconcilable.
  const naValues = completedChecks.flatMap((c) => c.values).filter((v) => v.notApplicable)
  const naByParameter: NotApplicableRow[] = []
  for (const v of naValues) {
    const key = v.parameterId ?? v.parameterName
    let row = naByParameter.find((r) => (r.parameterId ?? r.name) === key)
    if (!row) {
      row = { parameterId: v.parameterId, name: v.parameterName, count: 0, reasons: [] }
      naByParameter.push(row)
    }
    row.count++
    const reason = v.naReason ?? NO_REASON
    const entry = row.reasons.find((r) => r.reason === reason)
    if (entry) entry.count++
    else row.reasons.push({ reason, count: 1 })
  }
  for (const row of naByParameter) row.reasons.sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
  naByParameter.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))

  const notApplicable: NotApplicableSummary = {
    total: naValues.length,
    checks: completedChecks.filter((c) => c.values.some((v) => v.notApplicable)).length,
    byParameter: naByParameter
  }

  const naReasons: { reason: string; count: number }[] = []
  for (const v of naValues) {
    const reason = v.naReason ?? NO_REASON
    const entry = naReasons.find((r) => r.reason === reason)
    if (entry) entry.count++
    else naReasons.push({ reason, count: 1 })
  }
  naReasons.sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))

  // How the workers came to the checks they submitted. Checks nobody submitted have no type.
  const submitted = checks.filter((c) => c.submittedAt)
  const submissionTypes: SubmissionTypeCounts = {
    notification: submitted.filter((c) => c.submissionType !== 'MANUAL').length,
    manual: submitted.filter((c) => c.submissionType === 'MANUAL').length
  }
  const outOfLimits: OutOfLimitsRow[] = completedChecks
    .filter((c) => c.values.some((v) => v.result === 'FAIL'))
    .map((c) => {
      const worker = workerOf(c)
      return {
        code: c.code,
        submittedAt: c.submittedAt ? new Date(c.submittedAt) : null,
        machineName: `${c.machineName} (${c.machineCode})`,
        activityName: c.activityName,
        workerName: `${worker.name} (${worker.employeeId})`,
        shiftName: c.shiftName ?? DASH,
        parameters: parameterRows(c, limits).filter((p) => p.result === 'FAIL')
      }
    })

  const issues: IssueRow[] = [
    ...checks
      .filter((c) => c.status === 'MISSED')
      .map<IssueRow>((c) => ({
        type: 'MISSED',
        code: c.code,
        when: new Date(c.scheduledAt),
        machineName: `${c.machineName} (${c.machineCode})`,
        activityName: c.activityName,
        workerName: workerOf(c).name,
        shiftName: c.shiftName ?? DASH,
        description: 'Scheduled check not submitted before the window closed',
        status: 'Open',
        action: NOT_AVAILABLE,
        capa: NOT_AVAILABLE
      })),
    ...checks
      .filter((c) => c.exception)
      .map<IssueRow>((c) => ({
        type: 'EXCEPTION',
        code: c.code,
        when: new Date(c.submittedAt ?? c.scheduledAt),
        machineName: `${c.machineName} (${c.machineCode})`,
        activityName: c.activityName,
        workerName: workerOf(c).name,
        shiftName: c.shiftName ?? DASH,
        description: `${c.exception!.reason}${c.exception!.remark ? ` — ${c.exception!.remark}` : ''}`,
        status: EXCEPTION_STATE[c.exception!.status] ?? c.exception!.status,
        action: c.exception!.resolutionNotes ?? NOT_AVAILABLE,
        capa: NOT_AVAILABLE
      })),
    ...outOfLimits.map<IssueRow>((row) => {
      const check = completedChecks.find((c) => c.code === row.code)!
      return {
        type: 'OUT OF LIMITS',
        code: row.code,
        when: row.submittedAt ?? new Date(check.scheduledAt),
        machineName: row.machineName,
        activityName: row.activityName,
        workerName: workerOf(check).name,
        shiftName: row.shiftName,
        description: row.parameters.map((p) => `${p.name}: ${p.value}${p.unit !== DASH ? ` ${p.unit}` : ''} (limit ${p.standard})`).join('; '),
        status: 'Check completed',
        action: NOT_AVAILABLE,
        capa: NOT_AVAILABLE
      }
    })
  ].sort((a, b) => a.when.getTime() - b.when.getTime())

  const completionRate = rate(counts.completed, counts.scheduled)

  const analysis = [
    `Completed: ${counts.completed} of ${counts.scheduled} scheduled checks were completed${completionRate !== null ? ` (${completionRate}%)` : ''}.`,
    `Missed: ${counts.missed} scheduled check${counts.missed === 1 ? ' was' : 's were'} missed in this period.`,
    `Exception: ${counts.exception} scheduled check${counts.exception === 1 ? ' was' : 's were'} reported as an exception by the worker.`,
    `Open at time of generation: ${counts.open} check${counts.open === 1 ? '' : 's'} were not finished yet and have no status.`,
    `Parameter readings (separate from the Result): ${readings.recorded} recorded in completed checks — ${readings.withinLimits} within limits, ${readings.outsideLimits} outside limits${readings.noLimits ? `, ${readings.noLimits} without limits` : ''}. ${readings.checksWithOutside} completed check${readings.checksWithOutside === 1 ? ' has' : 's have'} at least one reading outside limits.`,
    `Not Applicable: ${notApplicable.total} parameter${notApplicable.total === 1 ? ' was' : 's were'} recorded as Not Applicable in ${notApplicable.checks} completed check${notApplicable.checks === 1 ? '' : 's'}${naReasons.length ? ` — ${naReasons.map((r) => `${r.reason} (${r.count})`).join(', ')}` : ''}. An N/A carries no reading and is never counted as a failure.`,
    `Submission: ${submissionTypes.notification} completed check${submissionTypes.notification === 1 ? ' was' : 's were'} submitted after a notification and ${submissionTypes.manual} ${submissionTypes.manual === 1 ? 'was' : 'were'} started manually by the worker.`
  ]

  return {
    meta: {
      company,
      department,
      plant,
      periodFrom: filters.from,
      periodTo: lastDay,
      generatedAt,
      reportId: `QMR-${dateKey(filters.from).replace(/-/g, '')}-${dateKey(lastDay).replace(/-/g, '')}-${String(localParts(generatedAt).hour).padStart(2, '0')}${String(localParts(generatedAt).minute).padStart(2, '0')}`,
      preparedBy: context.preparedBy,
      status: 'System Generated',
      filters: context.filterLabels
    },
    counts,
    completionRate,
    reconciles: counts.scheduled === counts.completed + counts.missed + counts.exception + counts.open,
    breakdown,
    byMachine: group(checks, (c) => ({
      key: c.machineId,
      label: c.machineName,
      sublabel: c.machineCode
    })),
    byWorker: group(checks, (c) => {
      const worker = workerOf(c)
      return {
        key: c.submittedById ?? c.workerId ?? DASH,
        label: worker.name,
        sublabel: worker.employeeId
      }
    }),
    byShift: shiftRows,
    byDate: group(checks, (c) => {
      const day = new Date(c.scheduledAt)
      return {
        key: dateKey(day),
        label: formatDate(day),
        sublabel: day.toLocaleDateString('en-GB', { weekday: 'short', timeZone: PLANT_TIMEZONE }),
        sortKey: dateKey(day)
      }
    }),
    log,
    completedDetails,
    missed,
    exceptions,
    evidence,
    evidenceGroups,
    issues,
    readings,
    notApplicable,
    naReasons,
    submissionTypes,
    outOfLimits,
    analysis,
    trace: context.trace ? buildTraceReport(checks, context.trace.context ?? checks) : null
  }
}

export function formatDateTime(date: Date | null): string {
  if (!date) return DASH
  return `${formatDate(date)} ${formatTime(date)}`
}

export function formatDate(date: Date | null): string {
  return date ? formatLocalDate(date) : DASH
}

export function formatTime(date: Date | null): string {
  return date ? formatLocalTime(date) : DASH
}

export const percentText = (value: number | null) => (value === null ? DASH : `${value}%`)
