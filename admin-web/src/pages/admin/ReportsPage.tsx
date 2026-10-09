import React, { useMemo, useState } from 'react'
import {
  AlertTriangle,
  BarChart3,
  Building2,
  CalendarDays,
  Check,
  CheckCircle2,
  ClipboardList,
  Cpu,
  FileBarChart,
  FileSpreadsheet,
  FileText,
  Gauge,
  Hand,
  Mail,
  PieChart,
  Printer,
  RefreshCw,
  RotateCcw,
  Users,
  XCircle
} from 'lucide-react'
import type { CheckResult, QualityCheck, TraceReport } from '../../types'
import { useApi } from '../../lib/useApi'
import { useAuth } from '../../lib/auth'
import { api, download, errorText, mediaUrl, type Page } from '../../lib/api'
import { RESULT_HINT, checkStatusLabel, RESULT_LABEL, RESULT_OPTIONS, addDaysKey, dateKey, downloadCsv, formatDateKey, formatDateTime, toPlantInput } from '../../lib/format'
import { Button } from '../../components/common/Button'
import { PageHeader } from '../../components/common/PageHeader'
import { DataState, TruncatedNotice } from '../../components/common/DataState'
import { StatusBadge } from '../../components/common/StatusBadge'
import { FilterBar, type MonitoringFilters } from '../../components/common/FilterBar'
import { useToast } from '../../components/common/Toast'
import { DateInput } from '../../components/common/DateTimeInputs'
import { Card, CardHeader, EmptyState } from '../../components/ui/Card'
import { StatCard } from '../../components/ui/StatCard'
import { BarList, ChartLegend, DonutChart, ProgressBar, STATUS_SERIES, StackedBarChart, type BarListRow, type StackedBarDatum } from '../../components/ui/charts'
import { IconButton, Segmented } from '../../components/ui/Toolbar'
import { DetailedRecords, TraceChanges, TraceGroupTable, TraceSummary, TraceWorkers } from './reports/TraceSections'
import { ReportSharingSection } from './reports/ReportSharingSection'
import { itemCodeOf, jobNoOf } from './reports/checkFields'

/** Above this many checks the detailed records are left to the CSV / PDF unless a report is traced. */
const MAX_RECORDS_ON_SCREEN = 300

/** The page opens on today's report. */
const defaultFilters = (): MonitoringFilters => {
  const today = dateKey()
  return { from: today, to: today, shiftId: '', machineId: '', workerId: '', activityId: '', departmentId: '', status: '', itemCode: '', jobNo: '' }
}

interface DateRange {
  from: string
  to: string
}

/** Quick ranges, worked out when used so "Today" stays right after midnight. */
const PRESETS: { label: string; range: () => DateRange }[] = [
  { label: 'Today', range: () => ({ from: dateKey(), to: dateKey() }) },
  { label: 'Yesterday', range: () => ({ from: addDaysKey(dateKey(), -1), to: addDaysKey(dateKey(), -1) }) },
  { label: 'Last 7 Days', range: () => ({ from: addDaysKey(dateKey(), -6), to: dateKey() }) },
  { label: 'This Month', range: () => ({ from: `${dateKey().slice(0, 8)}01`, to: dateKey() }) }
]

/** Why a date range cannot be applied, or null when it is valid. */
function rangeError(range: DateRange) {
  if (!range.from || !range.to) return 'Choose both a From Date and a To Date'
  if (range.from > range.to) return 'From Date cannot be later than To Date'
  return null
}

const workerLabel = (c: QualityCheck) => c.submittedByName ?? c.workerName ?? '—'
const keyDate = (key: string) => formatDateKey(key)

/** How the check was started: by the worker, or from the due notification. */
const SUBMISSION_LABEL = { MANUAL: 'Manual', NOTIFICATION: 'Notification' } as const

/** Counts by overall result: Completed, Missed, Exception, plus checks with no result yet. */
interface Totals {
  scheduled: number
  completed: number
  missed: number
  exceptions: number
  open: number
  /** How submitted checks were started: by the worker, or from a due notification. */
  manual: number
  notification: number
}

const emptyTotals = (): Totals => ({ scheduled: 0, completed: 0, missed: 0, exceptions: 0, open: 0, manual: 0, notification: 0 })

function addTo(t: Totals, c: QualityCheck) {
  t.scheduled++
  if (c.result === 'COMPLETED') t.completed++
  else if (c.result === 'MISSED') t.missed++
  else if (c.result === 'EXCEPTION') t.exceptions++
  else t.open++
  if (c.submissionType === 'MANUAL') t.manual++
  else if (c.submissionType === 'NOTIFICATION') t.notification++
}

/** Share of scheduled checks whose result is Completed, as on the dashboard. */
const completion = (t: Totals) => (t.scheduled ? Math.round((t.completed / t.scheduled) * 100) : 0)

interface GroupRow extends Totals {
  key: string
  name: string
  detail: string | null
}

function groupBy(checks: QualityCheck[], pick: (c: QualityCheck) => { key: string; name: string; detail: string | null }) {
  const map = new Map<string, GroupRow>()
  for (const c of checks) {
    const { key, name, detail } = pick(c)
    const row = map.get(key) ?? { key, name, detail, ...emptyTotals() }
    addTo(row, c)
    map.set(key, row)
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** Parameters the worker marked Not Applicable, e.g. "Viscosity: Machine stopped". */
const notApplicableText = (c: QualityCheck) =>
  c.values
    .filter((v) => v.notApplicable)
    .map((v) => `${v.parameterName}: ${v.naReason ?? 'no reason'}${v.naRemark ? ` (${v.naRemark})` : ''}`)
    .join('; ')

/** Readings outside their limits, e.g. "Viscosity=19 sec; TEAP=FAIL". Separate from the Result. */
const outsideLimitsText = (c: QualityCheck) =>
  c.values
    .filter((v) => v.result === 'FAIL')
    .map((v) => `${v.parameterName}=${v.value ?? ''}${v.unit ? ` ${v.unit}` : ''}`)
    .join('; ')

/** A check's status bucket for the charts, by overall result: completed, exceptions, missed or open. */
const bucketOf = (c: QualityCheck) => (c.result === 'COMPLETED' ? 'completed' : c.result === 'EXCEPTION' ? 'exceptions' : c.result === 'MISSED' ? 'missed' : 'open')
const emptyBuckets = () => ({ completed: 0, exceptions: 0, missed: 0, open: 0 })

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const weekdayOf = (key: string) => WEEKDAY[new Date(`${key}T12:00:00Z`).getUTCDay()]
/** Above this many days the trend chart shows one column per week. */
const MAX_DAY_COLUMNS = 31

/**
 * Checks of the period by status for the trend chart: one column per hour for a single day, per
 * day up to a month, per week beyond that. Every step of the range gets a column, empty or not.
 */
function trendColumns(checks: QualityCheck[], from: string, to: string): { data: StackedBarDatum[]; unit: 'hour' | 'day' | 'week' } {
  if (from === to) {
    const byHour = new Map<number, ReturnType<typeof emptyBuckets>>()
    for (const c of checks) {
      const hour = Number(toPlantInput(new Date(c.scheduledAt)).slice(11, 13))
      const row = byHour.get(hour) ?? emptyBuckets()
      row[bucketOf(c)]++
      byHour.set(hour, row)
    }
    const hours = [...byHour.keys()]
    if (hours.length === 0) return { data: [], unit: 'hour' }
    const first = Math.min(...hours)
    const last = Math.max(...hours)
    return {
      unit: 'hour',
      data: Array.from({ length: last - first + 1 }, (_, i) => {
        const h = first + i
        const label = `${String(h).padStart(2, '0')}:00`
        return { label, fullLabel: `${formatDateKey(from)} ${label}–${String(h + 1).padStart(2, '0')}:00`, values: byHour.get(h) ?? emptyBuckets() }
      })
    }
  }

  const days: string[] = []
  for (let d = from; d <= to && days.length < 400; d = addDaysKey(d, 1)) days.push(d)
  const perDay = new Map<string, ReturnType<typeof emptyBuckets>>()
  for (const c of checks) {
    const key = toPlantInput(new Date(c.scheduledAt)).slice(0, 10)
    const row = perDay.get(key) ?? emptyBuckets()
    row[bucketOf(c)]++
    perDay.set(key, row)
  }
  if (days.length <= MAX_DAY_COLUMNS) {
    const short = days.length > 10
    return {
      unit: 'day',
      data: days.map((d) => ({
        label: short ? d.slice(8) : `${weekdayOf(d)} ${d.slice(8)}`,
        fullLabel: `${weekdayOf(d)} ${formatDateKey(d)}`,
        values: perDay.get(d) ?? emptyBuckets()
      }))
    }
  }
  const weeks: StackedBarDatum[] = []
  for (let i = 0; i < days.length; i += 7) {
    const span = days.slice(i, i + 7)
    const values = emptyBuckets()
    for (const d of span) {
      const v = perDay.get(d)
      if (v) for (const k of Object.keys(values) as (keyof typeof values)[]) values[k] += v[k]
    }
    weeks.push({ label: `${span[0].slice(8)}/${span[0].slice(5, 7)}`, fullLabel: `${formatDateKey(span[0])} – ${formatDateKey(span[span.length - 1])}`, values })
  }
  return { unit: 'week', data: weeks }
}

/** Checks grouped for a BarList, counted per status, most missed first. */
function barRows(checks: QualityCheck[], pick: (c: QualityCheck) => { key: string; label: string; detail?: string | null } | null, limit = 6): BarListRow[] {
  const map = new Map<string, BarListRow & { total: number }>()
  for (const c of checks) {
    const g = pick(c)
    if (!g) continue
    const row = map.get(g.key) ?? { key: g.key, label: g.label, detail: g.detail ?? null, values: emptyBuckets(), value: '', total: 0 }
    row.values[bucketOf(c)]++
    row.total++
    map.set(g.key, row)
  }
  return [...map.values()]
    .map((r) => {
      const rate = r.total ? Math.round((r.values.completed / r.total) * 100) : 0
      return { ...r, value: `${rate}%`, valueTone: r.values.missed > 0 ? 'text-missed' : 'text-ink' }
    })
    .sort((a, b) => b.values.missed - a.values.missed || b.total - a.total || a.label.localeCompare(b.label))
    .slice(0, limit)
}

/** Loads the checks with the total the filters match and whether the server capped the list. */
const loadPage = (path: string, query?: Record<string, string | number | boolean | null | undefined>) => api.getPage<QualityCheck>(path, query)

export const ReportsPage: React.FC = () => {
  /** Filters the report is built from. The dates change only on Apply Filter, a quick range or Reset. */
  const [filters, setFilters] = useState<MonitoringFilters>(defaultFilters)
  /** Dates being edited and not yet applied. */
  const [draft, setDraft] = useState<DateRange>(() => ({ from: filters.from, to: filters.to }))
  const draftError = rangeError(draft)
  const draftChanged = draft.from !== filters.from || draft.to !== filters.to

  const applyRange = (range: DateRange) => {
    if (rangeError(range)) return
    setDraft(range)
    setFilters((f) => ({ ...f, from: range.from, to: range.to }))
  }
  const resetAll = () => {
    const next = defaultFilters()
    setDraft({ from: next.from, to: next.to })
    setFilters(next)
  }
  const [downloading, setDownloading] = useState(false)
  const [activeTab, setActiveTab] = useState<'reports' | 'sharing'>('reports')
  const notify = useToast()
  // PDF, CSV and print need the Export Reports module (the server checks the PDF as well).
  const canExport = useAuth().can('export')

  /** Full Quality Monitoring Report, built on the server from the same filters. */
  const downloadReport = async () => {
    setDownloading(true)
    try {
      const name = await download('/api/reports/quality-monitoring.pdf', {
        from: filters.from,
        to: filters.to,
        shiftId: filters.shiftId,
        machineId: filters.machineId,
        workerId: filters.workerId,
        activityId: filters.activityId,
        departmentId: filters.departmentId,
        itemCode: filters.itemCode,
        jobNo: filters.jobNo,
        result: filters.status
      }, `QMR-${filters.from.replace(/-/g, '')}-${filters.to.replace(/-/g, '')}.pdf`)
      notify('success', 'Report downloaded', name)
    } catch (err) {
      notify('error', 'Could not generate the report', errorText(err))
    } finally {
      setDownloading(false)
    }
  }

  const reportQuery = {
    from: filters.from,
    to: filters.to,
    shiftId: filters.shiftId,
    machineId: filters.machineId,
    workerId: filters.workerId,
    activityId: filters.activityId,
    departmentId: filters.departmentId,
    itemCode: filters.itemCode,
    jobNo: filters.jobNo,
    result: filters.status
  }
  /** An Item Code, PO No. or worker report: adds the traceability sections. */
  const traced = !!(filters.itemCode || filters.jobNo || filters.workerId)
  const trace = useApi<TraceReport>(traced ? '/api/reports/trace' : null, reportQuery)

  // Loaded with the total too: the server caps the list and says so (X-Truncated).
  const { data, error, loading, reload } = useApi<Page<QualityCheck>>('/api/quality-checks', {
    from: filters.from,
    to: filters.to,
    shiftId: filters.shiftId,
    machineId: filters.machineId,
    workerId: filters.workerId,
    activityId: filters.activityId,
    departmentId: filters.departmentId,
    itemCode: filters.itemCode,
    jobNo: filters.jobNo,
    // On this page the status select filters by overall result.
    result: filters.status
  }, loadPage)

  const checks = useMemo(() => data?.rows ?? [], [data])
  const workerName = filters.workerId
    ? (trace.data?.workers.find((w) => w.workerId === filters.workerId)?.name ??
      checks.find((c) => c.submittedById === filters.workerId || c.workerId === filters.workerId)?.workerName ??
      'selected worker')
    : null
  const traceScope = [filters.itemCode && `Item Code ${filters.itemCode}`, filters.jobNo && `PO No. ${filters.jobNo}`, workerName && `Worker ${workerName}`]
    .filter(Boolean)
    .join(' · ')

  const totals = useMemo(() => {
    const t = emptyTotals()
    for (const c of checks) addTo(t, c)
    return t
  }, [checks])

  const byMachine = useMemo(
    () =>
      groupBy(
        checks.filter((c) => Boolean(c.machineId)),
        (c) => ({ key: c.machineId!, name: c.machineName ?? '—', detail: c.machineCode ?? null })
      ),
    [checks]
  )
  const byWorker = useMemo(
    () =>
      groupBy(checks, (c) => ({
        key: c.submittedById ?? c.workerId ?? '—',
        name: workerLabel(c),
        detail: c.submittedByEmployeeId ?? c.workerEmployeeId
      })),
    [checks]
  )
  const nonConformances = useMemo(() => checks.filter((c) => c.result === 'MISSED' || c.result === 'EXCEPTION'), [checks])

  // Charts of the same checks: the trend over the period and who / where checks were missed.
  const trend = useMemo(() => trendColumns(checks, filters.from, filters.to), [checks, filters.from, filters.to])
  const departmentBars = useMemo(() => barRows(checks, (c) => ({ key: c.departmentId ?? 'none', label: c.departmentName ?? 'No department' })), [checks])
  const machineBars = useMemo(
    () => barRows(checks, (c) => (c.machineId ? { key: c.machineId, label: c.machineName ?? '—', detail: c.machineCode ?? null } : null)),
    [checks]
  )
  const workerBars = useMemo(
    () =>
      barRows(checks, (c) => {
        const id = c.submittedById ?? c.workerId
        return id ? { key: id, label: workerLabel(c), detail: c.submittedByEmployeeId ?? c.workerEmployeeId } : null
      }),
    [checks]
  )

  const hasOtherFilters = !!(
    filters.shiftId ||
    filters.machineId ||
    filters.workerId ||
    filters.activityId ||
    filters.departmentId ||
    filters.status ||
    filters.itemCode ||
    filters.jobNo
  )
  const period = filters.from === filters.to ? keyDate(filters.from) : `${keyDate(filters.from)} – ${keyDate(filters.to)}`

  const exportCsv = () => {
    // One column per distinct parameter, in the order they first appear.
    const params: { name: string; unit: string | null }[] = []
    for (const c of checks) {
      for (const v of c.values) {
        if (!params.some((p) => p.name === v.parameterName)) params.push({ name: v.parameterName, unit: v.unit })
      }
    }

    const headers = [
      'Check code',
      'Scheduled at',
      'Machine',
      'Machine code',
      'Department',
      'Check type',
      'Shift',
      'Worker',
      'Employee ID',
      'Status',
      'Result',
      'Submission type',
      'Item Code',
      'PO No.',
      'Submitted at',
      'Parameters outside limits',
      'N/A parameters',
      ...params.map((p) => (p.unit ? `${p.name} (${p.unit})` : p.name)),
      'Exception reason',
      'Exception remark',
      'Exception status',
      'Photo URLs',
      'Video URLs',
      'Exception photo URLs'
    ]

    const rows = checks.map((c) => {
      const media = (kind: 'PHOTO' | 'VIDEO') =>
        c.media
          .filter((m) => m.kind === kind)
          .map((m) => mediaUrl(m.url))
          .join(' ')
      return [
        c.code,
        formatDateTime(c.scheduledAt),
        c.machineName,
        c.machineCode,
        c.departmentName,
        c.activityName,
        c.shiftName,
        workerLabel(c),
        c.submittedByEmployeeId ?? c.workerEmployeeId,
        checkStatusLabel(c.status),
        c.result ? RESULT_LABEL[c.result] : '',
        c.submissionType ? SUBMISSION_LABEL[c.submissionType] : '',
        itemCodeOf(c),
        jobNoOf(c),
        c.submittedAt ? formatDateTime(c.submittedAt) : '',
        outsideLimitsText(c),
        notApplicableText(c),
        ...params.map((p) => {
          const v = c.values.find((x) => x.parameterName === p.name)
          if (v?.notApplicable) return 'N/A'
          return v?.value ?? ''
        }),
        c.exception?.reason,
        c.exception?.remark,
        c.exception?.status,
        media('PHOTO'),
        media('VIDEO'),
        (c.exception?.media ?? []).map((m) => mediaUrl(m.url)).join(' ')
      ]
    })

    const scope = [filters.itemCode && `item-${filters.itemCode}`, filters.jobNo && `job-${filters.jobNo}`].filter(Boolean).join('_').replace(/[^\w.-]+/g, '-')
    downloadCsv(`quality-report_${filters.from}_${filters.to}${scope ? `_${scope}` : ''}.csv`, headers, rows)
  }

  const activePreset = PRESETS.find((p) => {
    const range = p.range()
    return filters.from === range.from && filters.to === range.to
  })?.label ?? ''
  const pct = completion(totals)
  const trendTitle = trend.unit === 'hour' ? 'Checks per hour' : trend.unit === 'week' ? 'Checks per week' : 'Checks per day'

  return (
    <div className="space-y-5">
      <div className="no-print">
        <PageHeader
          icon={<FileBarChart className="w-4.5 h-4.5" />}
          title="Quality Reports"
          description={
            <span className="inline-flex items-center gap-1.5 flex-wrap">
              <span className="font-medium text-ink-secondary">{period}</span>
              {data && (
                <>
                  <span aria-hidden>·</span>
                  {data.total.toLocaleString('en-IN')} {data.total === 1 ? 'check' : 'checks'}
                </>
              )}
              {traceScope && (
                <>
                  <span aria-hidden>·</span>
                  {traceScope}
                </>
              )}
            </span>
          }
          info={
            canExport
              ? 'Summaries and exports of scheduled quality checks for any period. Pick the dates and filters, then download the full PDF report, the CSV (opens in Excel) or print this page.'
              : 'Summaries of scheduled quality checks for any period. Pick the dates and filters to narrow the report.'
          }
          actions={
            <>
              <IconButton
                label="Refresh"
                size="md"
                onClick={() => {
                  reload()
                  if (traced) trace.reload()
                }}
                className="border border-line-strong bg-white"
              >
                <RefreshCw className={`w-4 h-4 ${loading && data !== null ? 'animate-spin' : ''}`} />
              </IconButton>
              {canExport && (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => window.print()}
                    disabled={checks.length === 0}
                    icon={<Printer className="w-3.5 h-3.5" />}
                    title="Print / Save as PDF"
                  >
                    Print
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={exportCsv}
                    disabled={checks.length === 0}
                    icon={<FileSpreadsheet className="w-3.5 h-3.5" />}
                    title="Download CSV (opens in Excel)"
                  >
                    CSV
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={downloadReport}
                    loading={downloading}
                    icon={<FileText className="w-3.5 h-3.5" />}
                    title="Full Quality Monitoring Report as a PDF"
                  >
                    Download PDF
                  </Button>
                </>
              )}
            </>
          }
          tabs={
            <div role="tablist" aria-label="Report views" className="flex items-center gap-1 border-b border-line max-w-full overflow-x-auto -mb-px">
              <ViewTab active={activeTab === 'reports'} onClick={() => setActiveTab('reports')} icon={<BarChart3 className="w-3.5 h-3.5" />}>
                Reports & Analytics
              </ViewTab>
              <ViewTab active={activeTab === 'sharing'} onClick={() => setActiveTab('sharing')} icon={<Mail className="w-3.5 h-3.5" />}>
                Report Sharing & Email
              </ViewTab>
            </div>
          }
        />
      </div>

      {activeTab === 'sharing' ? (
        <ReportSharingSection />
      ) : (
        <>
          <section className="card px-3 py-2.5 no-print" aria-label="Report date range">
            {/* Phones: range summary, then From/To, Apply/Reset and the quick ranges as two-column rows. From sm up: one row. */}
            <form
              className="grid grid-cols-2 sm:flex sm:flex-wrap items-end gap-2.5"
              onSubmit={(e) => {
                e.preventDefault()
                applyRange(draft)
              }}
            >
              <label className="min-w-0">
                <span className="block text-[11px] font-medium text-ink-muted mb-1">From Date</span>
                <DateInput
                  value={draft.from}
                  onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))}
                  aria-invalid={!!draftError}
                  className="sm:w-[160px] lg:w-[136px]"
                />
              </label>
              <label className="min-w-0">
                <span className="block text-[11px] font-medium text-ink-muted mb-1">To Date</span>
                <DateInput
                  value={draft.to}
                  onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))}
                  aria-invalid={!!draftError}
                  className="sm:w-[160px] lg:w-[136px]"
                />
              </label>
              <Button type="submit" size="field" variant={draftChanged ? 'primary' : 'outline'} disabled={!!draftError} icon={<Check className="w-3.5 h-3.5" />}>
                Apply Filter
              </Button>
              <Button type="button" size="field" variant="ghost" onClick={resetAll} icon={<RotateCcw className="w-3 h-3" />}>
                Reset
              </Button>

              <Segmented
                label="Quick date ranges"
                className="col-span-2 sm:col-auto"
                value={activePreset}
                onChange={(label) => {
                  const preset = PRESETS.find((p) => p.label === label)
                  if (preset) applyRange(preset.range())
                }}
                options={PRESETS.map((p) => ({ value: p.label, label: p.label }))}
              />

              <div className="col-span-2 order-first sm:order-none sm:ml-auto flex items-center gap-1.5 sm:h-8 text-[12.5px] text-ink-secondary">
                <CalendarDays className="w-3.5 h-3.5 text-ink-muted" aria-hidden />
                <span>
                  Showing <span className="font-semibold text-ink">{period}</span>
                </span>
              </div>
            </form>
            {draftError ? (
              <p className="mt-2 text-[11.5px] font-medium text-missed" role="alert">
                {draftError}
              </p>
            ) : (
              draftChanged && <p className="mt-2 text-[11.5px] text-ink-muted">Click Apply Filter to update the report for these dates.</p>
            )}
          </section>

          <FilterBar
            value={filters}
            onChange={setFilters}
            fields={['itemCode', 'jobNo', 'worker', 'machine', 'shift', 'activity', 'department', 'status']}
            statusOptions={RESULT_OPTIONS}
            statusLabel="Result"
            showDates={false}
          />

          {/* Print-only report heading */}
          <div className="hidden print:block border-b border-ink pb-2">
            <h1 className="text-lg font-bold">Quality Report: {period}</h1>
            <p className="text-xs">
              Period: {period}
              {filters.itemCode ? ` · Item Code: ${filters.itemCode}` : ''}
              {filters.jobNo ? ` · PO No.: ${filters.jobNo}` : ''}
              {filters.status ? ` · Result: ${RESULT_LABEL[filters.status as CheckResult] ?? filters.status}` : ''} · Generated {formatDateTime(new Date().toISOString())}
            </p>
          </div>

          {data?.truncated && <TruncatedNotice shown={checks.length} total={data.total} />}

          <DataState
            loading={loading}
            error={error}
            onRetry={reload}
            empty={data === null ? undefined : checks.length === 0}
            emptyText={hasOtherFilters ? 'No quality records found for the selected date range and filters.' : 'No quality records found for the selected date range.'}
          >
            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3 printable-card">
              <StatCard label="Scheduled" value={totals.scheduled} icon={<ClipboardList className="w-4 h-4" />} meta={period} />
              <StatCard label="Completed" value={totals.completed} icon={<CheckCircle2 className="w-4 h-4" />} tone="success" meta={`${pct}% of scheduled`} />
              <StatCard
                label="Missed"
                value={totals.missed}
                icon={<XCircle className="w-4 h-4" />}
                tone={totals.missed > 0 ? 'missed' : 'neutral'}
                alert={totals.missed > 0}
                meta={totals.missed > 0 ? 'Not submitted in time' : 'None'}
              />
              <StatCard
                label="Exception"
                value={totals.exceptions}
                icon={<AlertTriangle className="w-4 h-4" />}
                tone={totals.exceptions > 0 ? 'exception' : 'neutral'}
                meta="Raised by workers"
              />
              <StatCard
                label="Completion"
                value={`${pct}%`}
                icon={<Gauge className="w-4 h-4" />}
                tone="accent"
                meta={totals.open ? `${totals.open} still open` : 'Nothing open'}
                footer={<ProgressBar value={pct} label="Completion rate" tone={pct >= 90 ? 'success' : pct >= 70 ? 'accent' : 'missed'} />}
              />
              <StatCard label="Started manually" value={totals.manual} icon={<Hand className="w-4 h-4" />} meta={`${totals.notification} from a notification`} />
            </div>

            {/* Trend + result split (screen only: the printed report keeps the tables) */}
            <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 no-print">
              <Card className="xl:col-span-8">
                <CardHeader
                  icon={<BarChart3 className="w-4 h-4" />}
                  title={trendTitle}
                  subtitle={`${period} · by result`}
                  info="Each column is the checks scheduled in that hour, day or week, split by result. Hover or focus a column for its numbers."
                  actions={<ChartLegend items={STATUS_SERIES} className="hidden md:flex" />}
                />
                <div className="p-4 pt-5">
                  {trend.data.length === 0 ? (
                    <EmptyState icon={<BarChart3 className="w-5 h-5" />} title="No checks in this period" compact />
                  ) : (
                    <StackedBarChart height={200} series={STATUS_SERIES} summary={`${trendTitle} for ${period}, by result`} data={trend.data} />
                  )}
                  <ChartLegend items={STATUS_SERIES} className="md:hidden mt-3" />
                </div>
              </Card>

              <Card className="xl:col-span-4">
                <CardHeader icon={<PieChart className="w-4 h-4" />} title="Result split" subtitle={period} info={RESULT_HINT} />
                <div className="p-4 flex flex-col sm:flex-row xl:flex-col 2xl:flex-row items-center gap-5">
                  <DonutChart
                    segments={STATUS_SERIES.map((s) => ({ ...s, value: totals[s.key as 'completed' | 'exceptions' | 'missed' | 'open'] }))}
                    centerValue={totals.scheduled}
                    centerLabel="checks"
                    summary={`${totals.completed} completed, ${totals.exceptions} exceptions, ${totals.missed} missed, ${totals.open} open`}
                  />
                  <ul className="w-full space-y-2.5">
                    {STATUS_SERIES.map((s) => {
                      const v = totals[s.key as 'completed' | 'exceptions' | 'missed' | 'open']
                      const share = totals.scheduled ? Math.round((v / totals.scheduled) * 100) : 0
                      return (
                        <li key={s.key} className="flex items-center gap-2.5 text-[12.5px]">
                          <span className="w-2.5 h-2.5 rounded-[3px] shrink-0" style={{ backgroundColor: s.color }} aria-hidden />
                          <span className="flex-1 text-ink-secondary">{s.label}</span>
                          <span className="font-semibold text-ink tabular-nums">{v}</span>
                          <span className="w-10 text-right text-ink-muted tabular-nums">{share}%</span>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              </Card>
            </div>

            {/* Where checks were missed: departments, machines, workers */}
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 no-print">
              <BarCard icon={<Building2 className="w-4 h-4" />} title="By department" header="Department" rows={departmentBars} empty="No department checks" />
              <BarCard icon={<Cpu className="w-4 h-4" />} title="By machine" header="Machine" rows={machineBars} empty="No machine checks" />
              <BarCard
                icon={<Users className="w-4 h-4" />}
                title="By worker"
                header="Worker"
                rows={workerBars}
                empty="No worker checks"
                className="md:col-span-2 xl:col-span-1"
              />
            </div>

            {traced && trace.data && (
              <>
                <TraceSummary trace={trace.data} scope={traceScope} />
                <TraceGroupTable kind="item" rows={trace.data.items} onPick={(itemCode) => setFilters((f) => ({ ...f, itemCode }))} />
                <TraceGroupTable kind="job" rows={trace.data.jobs} onPick={(jobNo) => setFilters((f) => ({ ...f, jobNo }))} />
                <TraceWorkers workers={trace.data.workers} onPickItem={(itemCode) => setFilters((f) => ({ ...f, itemCode }))} />
                <TraceChanges changes={trace.data.changes} />
              </>
            )}
            {traced && trace.error && (
              <p className="flex items-center gap-2 px-3 py-2.5 rounded-lg border border-missed-line bg-missed-bg text-[12.5px] text-missed" role="alert">
                <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden />
                Could not load the traceability sections: {trace.error}
              </p>
            )}

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
              <BreakdownTable icon={<Cpu className="w-4 h-4" />} title="Machine summary" nameHeader="Machine" rows={byMachine} />
              <BreakdownTable icon={<Users className="w-4 h-4" />} title="Worker summary" nameHeader="Worker" rows={byWorker} />
            </div>

            <Card className="overflow-hidden printable-card">
              <CardHeader
                icon={<XCircle className="w-4 h-4" />}
                title="Missed and exception checks"
                subtitle={`Result Missed or Exception · ${period}`}
                info={RESULT_HINT}
                actions={<CountPill value={nonConformances.length} tone={nonConformances.length > 0 ? 'missed' : 'neutral'} />}
              />
              {nonConformances.length === 0 ? (
                <EmptyState icon={<CheckCircle2 className="w-5 h-5" />} title="No missed or exception checks." compact />
              ) : (
                <div className="overflow-x-auto lg:max-h-[440px] lg:overflow-y-auto print:max-h-none print:overflow-visible">
                  <table className="data-table stack-sm">
                    <thead>
                      <tr>
                        <th>Scheduled</th>
                        <th>Machine</th>
                        <th>Worker</th>
                        <th title={RESULT_HINT}>Result</th>
                        <th>Details</th>
                      </tr>
                    </thead>
                    <tbody>
                      {nonConformances.map((c) => (
                        <tr key={c.id}>
                          <td className="whitespace-nowrap">
                            <div className="tabular-nums text-ink">{formatDateTime(c.scheduledAt)}</div>
                            <div className="text-[11.5px] text-ink-muted font-mono">{c.code}</div>
                          </td>
                          <td className="whitespace-nowrap">
                            <div className="font-medium text-ink">{c.machineName ?? '—'}</div>
                            <div className="text-[11.5px] text-ink-muted">{c.activityName}</div>
                          </td>
                          <td className="whitespace-nowrap">
                            <div className="text-ink">{workerLabel(c)}</div>
                            <div className="text-[11.5px] text-ink-muted">{c.shiftName ?? 'No shift'}</div>
                          </td>
                          <td className="whitespace-nowrap">{c.result && <StatusBadge status={c.result} size="sm" />}</td>
                          <td className="text-ink-secondary min-w-[180px]">
                            {c.result === 'EXCEPTION'
                              ? [c.exception?.reason, c.exception?.remark].filter(Boolean).join(' — ') || 'Exception'
                              : `Window closed ${formatDateTime(c.windowEndsAt)}`}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            {traced || checks.length <= MAX_RECORDS_ON_SCREEN ? (
              <DetailedRecords checks={checks} />
            ) : (
              <div className="card flex items-start gap-2.5 px-4 py-3 text-[12.5px] text-ink-secondary no-print" role="status">
                <ClipboardList className="w-4 h-4 mt-px shrink-0 text-ink-muted" aria-hidden />
                <span>
                  {checks.length} checks in this period. Choose an Item Code, PO No. or Worker to see every record here
                  {canExport ? ', or download the CSV / PDF for all of them.' : '.'}
                </span>
              </div>
            )}
          </DataState>
        </>
      )}
    </div>
  )
}

/** One of the two views of the page; a tab with an underline when selected. */
const ViewTab: React.FC<{ active: boolean; onClick: () => void; icon: React.ReactNode; children: React.ReactNode }> = ({ active, onClick, icon, children }) => (
  <button
    type="button"
    role="tab"
    aria-selected={active}
    onClick={onClick}
    className={`relative inline-flex items-center gap-1.5 h-10 lg:h-9 px-3 text-[13px] font-medium whitespace-nowrap transition-colors ${
      active ? 'text-accent-strong' : 'text-ink-muted hover:text-ink'
    }`}
  >
    <span aria-hidden>{icon}</span>
    {children}
    {active && <span className="absolute left-2 right-2 -bottom-px h-[2px] rounded-full bg-accent" aria-hidden />}
  </button>
)

const CountPill: React.FC<{ value: number; tone: 'missed' | 'neutral' }> = ({ value, tone }) => (
  <span
    className={`h-5 min-w-5 px-1.5 inline-flex items-center justify-center rounded-full text-[11px] font-semibold tabular-nums ring-1 ring-inset ${
      tone === 'missed' ? 'bg-missed-bg text-missed ring-missed-line' : 'bg-subtle text-ink-muted ring-line'
    }`}
  >
    {value}
  </span>
)

/** A ranked list card: checks by status per department, machine or worker, most missed first. */
const BarCard: React.FC<{ icon: React.ReactNode; title: string; header: string; rows: BarListRow[]; empty: string; className?: string }> = ({
  icon,
  title,
  header,
  rows,
  empty,
  className = ''
}) => (
  <Card className={className}>
    <CardHeader icon={icon} title={title} subtitle="Completion rate · most missed first" />
    <div className="px-4 py-3">
      <BarList rows={rows} series={STATUS_SERIES} labelHeader={header} valueLabel="Completion" emptyText={empty} />
    </div>
  </Card>
)

const BreakdownTable: React.FC<{ icon: React.ReactNode; title: string; nameHeader: string; rows: GroupRow[] }> = ({ icon, title, nameHeader, rows }) => (
  <Card className="overflow-hidden printable-card">
    <CardHeader icon={icon} title={title} subtitle={`${rows.length} ${nameHeader.toLowerCase()}${rows.length === 1 ? '' : 's'}`} />
    {rows.length === 0 ? (
      <EmptyState title="No records." compact />
    ) : (
      <div className="overflow-x-auto lg:max-h-[420px] lg:overflow-y-auto print:max-h-none print:overflow-visible">
        <table className="data-table pin-first">
          <thead>
            <tr>
              <th>{nameHeader}</th>
              <th className="num">Sched.</th>
              <th className="num">Completed</th>
              <th className="num">Missed</th>
              <th className="num">Exception</th>
              <th className="num">Compl.</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const pct = completion(r)
              return (
                <tr key={r.key}>
                  <td className="whitespace-nowrap">
                    <div className="font-medium text-ink">{r.name}</div>
                    {r.detail && <div className="text-[11.5px] text-ink-muted font-mono">{r.detail}</div>}
                  </td>
                  <td className="num">{r.scheduled}</td>
                  <td className="num text-success">{r.completed}</td>
                  <Count value={r.missed} tone="text-missed" />
                  <Count value={r.exceptions} tone="text-exception" />
                  <td className="num font-semibold text-ink" title={r.open ? `${r.open} still open` : undefined}>
                    {pct}%
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    )}
  </Card>
)

const Count: React.FC<{ value: number; tone: string }> = ({ value, tone }) => (
  <td className={`num ${value > 0 ? `${tone} font-semibold` : 'text-ink-faint'}`}>{value}</td>
)
