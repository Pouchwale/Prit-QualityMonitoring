import React, { useMemo, useState } from 'react'
import { CalendarDays, Check, FileSpreadsheet, FileText, Printer, RefreshCw, RotateCcw } from 'lucide-react'
import type { CheckResult, QualityCheck } from '../../types'
import { useApi } from '../../lib/useApi'
import { download, errorText, mediaUrl } from '../../lib/api'
import { RESULT_HINT, checkStatusLabel, RESULT_LABEL, RESULT_OPTIONS, addDaysKey, dateKey, downloadCsv, formatDate, formatDateTime } from '../../lib/format'
import { Button } from '../../components/common/Button'
import { PageHeader } from '../../components/common/PageHeader'
import { DataState } from '../../components/common/DataState'
import { StatusBadge } from '../../components/common/StatusBadge'
import { FilterBar, type MonitoringFilters } from '../../components/common/FilterBar'
import { useToast } from '../../components/common/Toast'
import { inputClass } from '../../components/common/Form'

/** The page opens on today's report. */
const defaultFilters = (): MonitoringFilters => {
  const today = dateKey()
  return { from: today, to: today, shiftId: '', machineId: '', workerId: '', activityId: '', departmentId: '', status: '' }
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
const keyDate = (key: string) => formatDate(new Date(`${key}T00:00:00`))

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

interface ParameterRow {
  name: string
  unit: string | null
  readings: number
  within: number
  outside: number
  /** Times the worker marked this parameter Not Applicable. Never counted as a failure. */
  notApplicable: number
  /** Numeric readings only, for lowest / highest / average. */
  numbers: number[]
}

const emptyParameterRow = (name: string, unit: string | null): ParameterRow => ({
  name,
  unit,
  readings: 0,
  within: 0,
  outside: 0,
  notApplicable: 0,
  numbers: []
})

/** Readings recorded per parameter in completed checks, with the Not Applicable count. */
function parameterResults(checks: QualityCheck[]) {
  const map = new Map<string, ParameterRow>()
  for (const c of checks) {
    if (c.result !== 'COMPLETED') continue
    for (const v of c.values) {
      const key = v.parameterId ?? v.parameterName
      if (v.notApplicable) {
        const naRow = map.get(key) ?? emptyParameterRow(v.parameterName, v.unit)
        naRow.notApplicable++
        map.set(key, naRow)
        continue
      }
      if (v.value === null || v.value === '') continue
      const row = map.get(key) ?? emptyParameterRow(v.parameterName, v.unit)
      row.readings++
      if (v.result === 'PASS') row.within++
      if (v.result === 'FAIL') row.outside++
      if (v.parameterType === 'NUMBER' && Number.isFinite(Number(v.value))) row.numbers.push(Number(v.value))
      map.set(key, row)
    }
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

const formatReading = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, ''))

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
  const notify = useToast()

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
        result: filters.status
      }, `QMR-${filters.from.replace(/-/g, '')}-${filters.to.replace(/-/g, '')}.pdf`)
      notify('success', 'Report downloaded', name)
    } catch (err) {
      notify('error', 'Could not generate the report', errorText(err))
    } finally {
      setDownloading(false)
    }
  }

  const { data, error, loading, reload } = useApi<QualityCheck[]>('/api/quality-checks', {
    from: filters.from,
    to: filters.to,
    shiftId: filters.shiftId,
    machineId: filters.machineId,
    workerId: filters.workerId,
    activityId: filters.activityId,
    departmentId: filters.departmentId,
    // On this page the status select filters by overall result.
    result: filters.status
  })

  const checks = useMemo(() => data ?? [], [data])

  const totals = useMemo(() => {
    const t = emptyTotals()
    for (const c of checks) addTo(t, c)
    return t
  }, [checks])

  const byMachine = useMemo(() => groupBy(checks, (c) => ({ key: c.machineId, name: c.machineName, detail: c.machineCode })), [checks])
  const byWorker = useMemo(
    () =>
      groupBy(checks, (c) => ({
        key: c.submittedById ?? c.workerId ?? '—',
        name: workerLabel(c),
        detail: c.submittedByEmployeeId ?? c.workerEmployeeId
      })),
    [checks]
  )
  const parameters = useMemo(() => parameterResults(checks), [checks])
  const nonConformances = useMemo(() => checks.filter((c) => c.result === 'MISSED' || c.result === 'EXCEPTION'), [checks])

  const hasOtherFilters = !!(filters.shiftId || filters.machineId || filters.workerId || filters.activityId || filters.departmentId || filters.status)
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
      'Job No.',
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
        c.itemCode ?? c.job?.itemCode ?? '',
        c.jobNo,
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

    downloadCsv(`quality-report_${filters.from}_${filters.to}.csv`, headers, rows)
  }

  return (
    <div className="space-y-4">
      <div className="no-print">
        <PageHeader
          title="Quality Reports"
          description="Summaries and exports of scheduled quality checks for any period"
          actions={
            <>
              <Button size="sm" variant="ghost" onClick={() => reload()} loading={loading && data !== null} icon={<RefreshCw className="w-3.5 h-3.5" />}>
                Refresh
              </Button>
              <Button
                size="sm"
                variant="primary"
                onClick={downloadReport}
                loading={downloading}
                icon={<FileText className="w-3.5 h-3.5" />}
                title="Full Quality Monitoring Report as a PDF"
              >
                Download Report (PDF)
              </Button>
              <Button size="sm" variant="outline" onClick={() => window.print()} disabled={checks.length === 0} icon={<Printer className="w-3.5 h-3.5" />}>
                Print / Save as PDF
              </Button>
              <Button size="sm" variant="primary" onClick={exportCsv} disabled={checks.length === 0} icon={<FileSpreadsheet className="w-3.5 h-3.5" />}>
                Download CSV (opens in Excel)
              </Button>
            </>
          }
        />
      </div>

      <section className="bg-white border border-line rounded-md p-3 shadow-2xs no-print" aria-label="Report date range">
        {/* Phones: range summary, then From/To, Apply/Reset and the quick ranges as two-column rows. From sm up: one row. */}
        <form
          className="grid grid-cols-2 sm:flex sm:flex-wrap items-end gap-2.5 text-xs"
          onSubmit={(e) => {
            e.preventDefault()
            applyRange(draft)
          }}
        >
          <label className="min-w-0">
            <span className="block text-[11px] font-semibold text-ink-secondary mb-1">From Date</span>
            <input
              type="date"
              value={draft.from}
              onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))}
              aria-invalid={!!draftError}
              className={`${inputClass} sm:w-[160px] lg:w-[140px] ${draftError ? 'border-failed' : ''}`}
            />
          </label>
          <label className="min-w-0">
            <span className="block text-[11px] font-semibold text-ink-secondary mb-1">To Date</span>
            <input
              type="date"
              value={draft.to}
              onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))}
              aria-invalid={!!draftError}
              className={`${inputClass} sm:w-[160px] lg:w-[140px] ${draftError ? 'border-failed' : ''}`}
            />
          </label>
          <Button type="submit" size="field" variant={draftChanged ? 'primary' : 'outline'} disabled={!!draftError} icon={<Check className="w-3.5 h-3.5" />}>
            Apply Filter
          </Button>
          <Button type="button" size="field" variant="ghost" className="border-line sm:border-transparent" onClick={resetAll} icon={<RotateCcw className="w-3 h-3" />}>
            Reset
          </Button>

          <div className="col-span-2 grid grid-cols-2 sm:flex items-center rounded border border-line-strong overflow-hidden lg:h-8">
            {PRESETS.map((p) => {
              const range = p.range()
              const active = filters.from === range.from && filters.to === range.to
              return (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => applyRange(range)}
                  className={`px-2.5 h-[40px] lg:h-full text-[12px] lg:text-[11px] font-medium whitespace-nowrap border-line max-sm:odd:border-r max-sm:[&:nth-child(-n+2)]:border-b sm:border-r sm:last:border-r-0 transition-colors ${
                    active ? 'bg-accent text-white' : 'bg-white text-ink-secondary hover:bg-slate-50'
                  }`}
                >
                  {p.label}
                </button>
              )
            })}
          </div>

          <div className="col-span-2 order-first sm:order-none sm:ml-auto flex items-center gap-1.5 sm:h-8 text-ink-secondary">
            <CalendarDays className="w-3.5 h-3.5 text-ink-muted" />
            <span>
              Showing <span className="font-semibold text-ink">{period}</span>
            </span>
          </div>
        </form>
        {draftError ? (
          <p className="mt-2 text-[11px] font-medium text-failed" role="alert">
            {draftError}
          </p>
        ) : (
          draftChanged && <p className="mt-2 text-[11px] text-ink-muted">Click Apply Filter to update the report for these dates.</p>
        )}
      </section>

      <FilterBar
        value={filters}
        onChange={setFilters}
        fields={['machine', 'worker', 'shift', 'activity', 'department', 'status']}
        statusOptions={RESULT_OPTIONS}
        statusLabel="Result"
        showDates={false}
      />

      {/* Print-only report heading */}
      <div className="hidden print:block border-b border-ink pb-2">
        <h1 className="text-lg font-bold">Quality Report: {period}</h1>
        <p className="text-xs">
          Period: {period}
          {filters.status ? ` · Result: ${RESULT_LABEL[filters.status as CheckResult] ?? filters.status}` : ''} · Generated {formatDateTime(new Date().toISOString())}
        </p>
      </div>

      <DataState loading={loading} error={error} onRetry={reload} empty={data === null ? undefined : checks.length === 0} emptyText={hasOtherFilters ? 'No quality records found for the selected date range and filters.' : 'No quality records found for the selected date range.'}>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3 printable-card">
          <Tile label="Scheduled" value={totals.scheduled} />
          <Tile label="Completed" value={totals.completed} tone="text-success" />
          <Tile label="Missed" value={totals.missed} tone="text-missed" />
          <Tile label="Exception" value={totals.exceptions} tone="text-exception" />
          <Tile label="Completion" value={`${completion(totals)}%`} tone="text-accent" hint={totals.open ? `${totals.open} still open` : undefined} />
          <Tile
            label="Started manually"
            value={totals.manual}
            hint={`${totals.notification} from a notification`}
          />
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <BreakdownTable title="By machine" nameHeader="Machine" rows={byMachine} />
          <BreakdownTable title="By worker" nameHeader="Worker" rows={byWorker} />
        </div>

        <ParameterTable rows={parameters} period={period} />

        <section className="bg-white border border-line rounded-md shadow-2xs overflow-hidden printable-card">
          <div className="px-4 py-2.5 border-b border-line bg-slate-50 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-bold text-ink">Missed and exception checks</h2>
              <p className="text-[11px] text-ink-muted">Checks whose result is Missed or Exception in {period}</p>
            </div>
            <span className="text-xs font-mono font-semibold text-ink">{nonConformances.length}</span>
          </div>
          {nonConformances.length === 0 ? (
            <div className="px-4 py-6 text-center text-xs text-ink-muted">No missed or exception checks.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="stack-sm w-full text-left text-xs border-collapse">
                <thead className="bg-slate-50 border-b border-line text-ink-secondary text-[11px] uppercase tracking-wider">
                  <tr>
                    <th className="py-2 px-3 font-semibold">Scheduled</th>
                    <th className="py-2 px-3 font-semibold">Code</th>
                    <th className="py-2 px-3 font-semibold">Machine</th>
                    <th className="py-2 px-3 font-semibold">Check type</th>
                    <th className="py-2 px-3 font-semibold">Worker</th>
                    <th className="py-2 px-3 font-semibold">Shift</th>
                    <th className="py-2 px-3 font-semibold" title={RESULT_HINT}>Result</th>
                    <th className="py-2 px-3 font-semibold">Details</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {nonConformances.map((c) => (
                    <tr key={c.id}>
                      <td className="py-2 px-3 font-mono whitespace-nowrap">{formatDateTime(c.scheduledAt)}</td>
                      <td className="py-2 px-3 font-mono text-ink-secondary whitespace-nowrap">{c.code}</td>
                      <td className="py-2 px-3 font-medium text-ink whitespace-nowrap">{c.machineName}</td>
                      <td className="py-2 px-3 text-ink-secondary whitespace-nowrap">{c.activityName}</td>
                      <td className="py-2 px-3 whitespace-nowrap">{workerLabel(c)}</td>
                      <td className="py-2 px-3 text-ink-secondary whitespace-nowrap">{c.shiftName ?? '—'}</td>
                      <td className="py-2 px-3 whitespace-nowrap">
                        {c.result && <StatusBadge status={c.result} size="sm" />}
                      </td>
                      <td className="py-2 px-3 text-ink-secondary">
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
        </section>
      </DataState>
    </div>
  )
}

const Tile: React.FC<{ label: string; value: number | string; tone?: string; hint?: string }> = ({ label, value, tone = 'text-ink', hint }) => (
  <div className="bg-white border border-line rounded-md px-3 py-2.5 shadow-2xs">
    <div className="text-[11px] font-medium text-ink-secondary">{label}</div>
    <div className={`text-2xl font-bold font-mono ${tone}`}>{value}</div>
    {hint && <div className="text-[11px] text-ink-muted">{hint}</div>}
  </div>
)

const BreakdownTable: React.FC<{ title: string; nameHeader: string; rows: GroupRow[] }> = ({ title, nameHeader, rows }) => (
  <section className="bg-white border border-line rounded-md shadow-2xs overflow-hidden printable-card">
    <div className="px-4 py-2.5 border-b border-line bg-slate-50">
      <h2 className="text-sm font-bold text-ink">{title}</h2>
    </div>
    <div className="overflow-x-auto">
      <table className="pin-first w-full text-left text-xs border-collapse">
        <thead className="border-b border-line text-ink-secondary text-[11px] uppercase tracking-wider">
          <tr>
            <th className="py-2 px-3 font-semibold">{nameHeader}</th>
            <th className="py-2 px-2 font-semibold text-right">Sched.</th>
            <th className="py-2 px-2 font-semibold text-right">Completed</th>
            <th className="py-2 px-2 font-semibold text-right">Missed</th>
            <th className="py-2 px-2 font-semibold text-right">Exception</th>
            <th className="py-2 px-3 font-semibold text-right">Compl.</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((r) => {
            const pct = completion(r)
            return (
              <tr key={r.key}>
                <td className="py-1.5 px-3 whitespace-nowrap">
                  <span className="font-medium text-ink">{r.name}</span>
                  {r.detail && <span className="text-[11px] text-ink-muted font-mono"> · {r.detail}</span>}
                </td>
                <td className="py-1.5 px-2 text-right font-mono">{r.scheduled}</td>
                <td className="py-1.5 px-2 text-right font-mono text-success">{r.completed}</td>
                <Count value={r.missed} tone="text-missed" />
                <Count value={r.exceptions} tone="text-exception" />
                <td className="py-1.5 px-3 text-right font-mono font-semibold text-ink" title={r.open ? `${r.open} still open` : undefined}>
                  {pct}%
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  </section>
)

const ParameterTable: React.FC<{ rows: ParameterRow[]; period: string }> = ({ rows, period }) => (
  <section className="bg-white border border-line rounded-md shadow-2xs overflow-hidden printable-card">
    <div className="px-4 py-2.5 border-b border-line bg-slate-50">
      <h2 className="text-sm font-bold text-ink">Quality parameter readings</h2>
      <p className="text-[11px] text-ink-muted">
        Readings recorded in completed checks in {period}, with the parameters workers marked Not Applicable. Recorded separately — a reading outside
        limits does not change the check Result.
      </p>
    </div>
    {rows.length === 0 ? (
      <div className="px-4 py-6 text-center text-xs text-ink-muted">No parameter readings were submitted in this period.</div>
    ) : (
      <div className="overflow-x-auto">
        <table className="pin-first w-full text-left text-xs border-collapse">
          <thead className="border-b border-line text-ink-secondary text-[11px] uppercase tracking-wider">
            <tr>
              <th className="py-2 px-3 font-semibold">Parameter</th>
              <th className="py-2 px-2 font-semibold text-right">Readings</th>
              <th className="py-2 px-2 font-semibold text-right">Within limits</th>
              <th className="py-2 px-2 font-semibold text-right">Outside limits</th>
              <th className="py-2 px-2 font-semibold text-right" title="Marked Not Applicable by the worker; never counted as a failure">
                Not applicable
              </th>
              <th className="py-2 px-2 font-semibold text-right">Lowest</th>
              <th className="py-2 px-2 font-semibold text-right">Highest</th>
              <th className="py-2 px-3 font-semibold text-right">Average</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((r) => {
              const has = r.numbers.length > 0
              const avg = has ? r.numbers.reduce((a, b) => a + b, 0) / r.numbers.length : 0
              return (
                <tr key={r.name}>
                  <td className="py-1.5 px-3 whitespace-nowrap">
                    <span className="font-medium text-ink">{r.name}</span>
                    {r.unit && <span className="text-[11px] text-ink-muted font-mono"> · {r.unit}</span>}
                  </td>
                  <td className="py-1.5 px-2 text-right font-mono">{r.readings}</td>
                  <Count value={r.within} tone="text-success" />
                  <Count value={r.outside} tone="text-failed" />
                  <Count value={r.notApplicable} tone="text-ink-secondary" />
                  <td className="py-1.5 px-2 text-right font-mono">{has ? formatReading(Math.min(...r.numbers)) : '—'}</td>
                  <td className="py-1.5 px-2 text-right font-mono">{has ? formatReading(Math.max(...r.numbers)) : '—'}</td>
                  <td className="py-1.5 px-3 text-right font-mono font-semibold text-ink">{has ? formatReading(avg) : '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    )}
  </section>
)

const Count: React.FC<{ value: number; tone: string }> = ({ value, tone }) => (
  <td className={`py-1.5 px-2 text-right font-mono ${value > 0 ? `${tone} font-semibold` : 'text-ink-faint'}`}>{value}</td>
)
