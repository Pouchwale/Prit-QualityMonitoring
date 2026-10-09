import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  Building2,
  CalendarOff,
  CheckCircle2,
  ClipboardList,
  Clock3,
  Cpu,
  Gauge,
  History,
  PieChart,
  RefreshCw,
  Repeat,
  ShieldAlert,
  Users,
  XCircle
} from 'lucide-react'
import type { DashboardData, ExceptionRecord, ExceptionStatus, QualityCheck } from '../../types'
import { useCanOpen, type NavTab } from '../../components/layout/Sidebar'
import { useApi } from '../../lib/useApi'
import { api } from '../../lib/api'
import { addDaysKey, dateKey, formatDateKey, formatTime } from '../../lib/format'
import { Button } from '../../components/common/Button'
import { PageHeader } from '../../components/common/PageHeader'
import { DataState } from '../../components/common/DataState'
import { CheckStatusBadge } from '../../components/common/StatusBadge'
import { CLOSURE_TYPES } from '../../lib/closureTypes'
import { DateInput } from '../../components/common/DateTimeInputs'
import { Card, CardHeader, EmptyState } from '../../components/ui/Card'
import { StatCard } from '../../components/ui/StatCard'
import { BarList, ChartLegend, DonutChart, ProgressBar, SegmentBar, STATUS_SERIES, StackedBarChart, type BarListRow } from '../../components/ui/charts'
import { IconButton } from '../../components/ui/Toolbar'

const REFRESH_MS = 60_000
const REPEAT_WINDOW_DAYS = 7
const TREND_DAYS = 7

interface DashboardPageProps {
  onViewCheck: (id: string) => void
  onNavigate: (tab: NavTab) => void
  /** The Quality Monitoring tabs (Overview, Checks, Jobs); this page is the Overview. */
  tabs?: React.ReactNode
}

const workerLabel = (c: QualityCheck) => c.submittedByName ?? c.workerName ?? '—'

interface RepeatRow {
  key: string
  name: string
  detail: string | null
  total: number
  onDay: number
}

function groupMisses(checks: QualityCheck[], day: string, pick: (c: QualityCheck) => { key: string; name: string; detail: string | null }) {
  const map = new Map<string, RepeatRow>()
  for (const c of checks) {
    const { key, name, detail } = pick(c)
    const row = map.get(key) ?? { key, name, detail, total: 0, onDay: 0 }
    row.total++
    if (dateKey(new Date(c.scheduledAt)) === day) row.onDay++
    map.set(key, row)
  }
  return [...map.values()].filter((r) => r.total >= 2).sort((a, b) => b.total - a.total || b.onDay - a.onDay)
}

/** A check's status bucket for the charts: completed, exceptions, missed or open. */
const bucketOf = (c: QualityCheck) => (c.status === 'COMPLETED' ? 'completed' : c.status === 'EXCEPTION' ? 'exceptions' : c.status === 'MISSED' ? 'missed' : 'open')

/** Checks of one day grouped by a key (department, worker), counted per status, worst first. */
function breakdown(checks: QualityCheck[], pick: (c: QualityCheck) => { key: string; label: string; detail?: string | null } | null): BarListRow[] {
  const map = new Map<string, BarListRow & { total: number }>()
  for (const c of checks) {
    const g = pick(c)
    if (!g) continue
    const row = map.get(g.key) ?? { key: g.key, label: g.label, detail: g.detail ?? null, values: { completed: 0, exceptions: 0, missed: 0, open: 0 }, value: '', total: 0 }
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
}

const EXCEPTION_STATUS: { key: ExceptionStatus; label: string; color: string }[] = [
  { key: 'UNDER_REVIEW', label: 'Under review', color: 'var(--color-chart-exception)' },
  { key: 'ACKNOWLEDGED', label: 'Acknowledged', color: 'var(--color-chart-primary)' },
  { key: 'ACTION_TAKEN', label: 'Action taken', color: '#6D5BD0' },
  { key: 'RESOLVED', label: 'Resolved', color: 'var(--color-chart-completed)' }
]

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const weekdayOf = (key: string) => WEEKDAY[new Date(`${key}T12:00:00Z`).getUTCDay()]

/**
 * The last TREND_DAYS days' figures, one dashboard request per day (the same numbers the KPI cards
 * show for a single day), for the trend chart and the KPI sparklines.
 */
function useTrend(endDate: string) {
  const [days, setDays] = useState<{ date: string; kpi: DashboardData['kpi'] }[] | null>(null)
  const load = useCallback(async () => {
    const dates = Array.from({ length: TREND_DAYS }, (_, i) => addDaysKey(endDate, i - (TREND_DAYS - 1)))
    try {
      const results = await Promise.all(dates.map((date) => api.get<DashboardData>('/api/dashboard', { date })))
      setDays(results.map((r, i) => ({ date: dates[i], kpi: r.kpi })))
    } catch {
      // The trend is extra context: the rest of the dashboard still works without it.
      setDays(null)
    }
  }, [endDate])
  useEffect(() => {
    load()
  }, [load])
  return { days, reload: load }
}

export const DashboardPage: React.FC<DashboardPageProps> = ({ onViewCheck, onNavigate, tabs }) => {
  // Links to other pages only appear for pages this user may open.
  const canOpen = useCanOpen()
  const [date, setDate] = useState(dateKey)
  const [updatedAt, setUpdatedAt] = useState(() => new Date())

  const dashboard = useApi<DashboardData>('/api/dashboard', { date })
  const missed = useApi<QualityCheck[]>('/api/quality-checks', {
    from: addDaysKey(date, -(REPEAT_WINDOW_DAYS - 1)),
    to: date,
    status: 'MISSED'
  })
  // Every check of the day, for the department, worker and status breakdowns.
  const dayChecks = useApi<QualityCheck[]>('/api/quality-checks', { date })
  // Exception review status needs the Exceptions module; the panel is left out without it.
  const exceptions = useApi<ExceptionRecord[]>(canOpen('exceptions') ? '/api/exceptions' : null, {
    from: addDaysKey(date, -(REPEAT_WINDOW_DAYS - 1)),
    to: date
  })
  const trend = useTrend(date)
  const reloadDashboard = dashboard.reload
  const reloadMissed = missed.reload
  const reloadDay = dayChecks.reload
  const reloadExceptions = exceptions.reload
  const reloadTrend = trend.reload

  const refresh = useCallback(async () => {
    await Promise.all([reloadDashboard(), reloadMissed(), reloadDay(), reloadExceptions(), reloadTrend()])
    setUpdatedAt(new Date())
  }, [reloadDashboard, reloadMissed, reloadDay, reloadExceptions, reloadTrend])

  useEffect(() => {
    const timer = setInterval(refresh, REFRESH_MS)
    return () => clearInterval(timer)
  }, [refresh])

  const missedChecks = useMemo(() => missed.data ?? [], [missed.data])
  const missedOnDay = useMemo(() => missedChecks.filter((c) => dateKey(new Date(c.scheduledAt)) === date), [missedChecks, date])
  const repeatByMachine = useMemo(
    () =>
      groupMisses(
        missedChecks.filter((c) => Boolean(c.machineId)),
        date,
        (c) => ({ key: c.machineId!, name: c.machineName ?? '—', detail: c.machineCode ?? null })
      ),
    [missedChecks, date]
  )
  const repeatByWorker = useMemo(
    () =>
      groupMisses(missedChecks, date, (c) => ({
        key: c.submittedById ?? c.workerId ?? '—',
        name: c.submittedByName ?? c.workerName ?? '—',
        detail: c.workerEmployeeId
      })),
    [missedChecks, date]
  )
  const repeatMachineIds = new Set(repeatByMachine.map((r) => r.key))
  const repeatWorkerIds = new Set(repeatByWorker.map((r) => r.key))

  const data = dashboard.data
  const kpi = data?.kpi
  const isToday = date === dateKey()
  const dayLabel = isToday ? 'Today' : formatDateKey(date)
  const machines = useMemo(
    () => [...(data?.byMachine ?? [])].sort((a, b) => b.missed + b.exceptions - (a.missed + a.exceptions) || a.machineName.localeCompare(b.machineName)),
    [data]
  )
  const day = useMemo(() => dayChecks.data ?? [], [dayChecks.data])
  const byDepartment = useMemo(() => breakdown(day, (c) => ({ key: c.departmentId ?? 'none', label: c.departmentName ?? 'No department' })), [day])
  const byWorker = useMemo(
    () =>
      breakdown(day, (c) => {
        const id = c.submittedById ?? c.workerId
        return id ? { key: id, label: c.submittedByName ?? c.workerName ?? '—', detail: c.submittedByEmployeeId ?? c.workerEmployeeId } : null
      }).slice(0, 6),
    [day]
  )
  const exceptionCounts = useMemo(() => {
    const counts = Object.fromEntries(EXCEPTION_STATUS.map((s) => [s.key, 0])) as Record<ExceptionStatus, number>
    for (const e of exceptions.data ?? []) counts[e.status]++
    return counts
  }, [exceptions.data])

  const series = (key: keyof DashboardData['kpi']) => trend.days?.map((d) => d.kpi[key] as number)
  const done = kpi ? Math.round((kpi.completed / Math.max(kpi.scheduled, 1)) * 100) : 0
  const attentionCount = missedOnDay.length + repeatByMachine.length + repeatByWorker.length + (exceptionCounts.UNDER_REVIEW ?? 0)

  return (
    <div className="space-y-5">
      <PageHeader
        tabs={tabs}
        title={dashboard.data?.scope?.restricted && dashboard.data.scope.departmentName ? `Quality Monitoring · ${dashboard.data.scope.departmentName}` : 'Quality Monitoring'}
        description={
          <span className="inline-flex items-center gap-1.5 flex-wrap">
            <span className="font-medium text-ink-secondary">{dayLabel}</span>
            <span aria-hidden>·</span>
            <span className="inline-flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-chart-completed)]" aria-hidden />
              Updated {formatTime(updatedAt.toISOString())}
            </span>
            {dashboard.data?.scope?.restricted && (
              <>
                <span aria-hidden>·</span>
                {dashboard.data.scope.missingDepartment ? 'Your account has no department yet' : `${dashboard.data.scope.departmentName} only`}
              </>
            )}
          </span>
        }
        info="Live status of the day's quality checks. The page refreshes every minute; pick another date to look back or up to a week ahead."
        actions={
          <>
            <DateInput
              value={date}
              max={addDaysKey(dateKey(), 7)}
              onChange={(e) => {
                if (!e.target.value) return
                setDate(e.target.value)
                setUpdatedAt(new Date())
              }}
              className="w-full sm:w-[160px] lg:w-[140px]"
              aria-label="Dashboard date"
            />
            {!isToday && (
              <Button size="sm" variant="outline" onClick={() => setDate(dateKey())}>
                Today
              </Button>
            )}
            <IconButton label="Refresh now" size="md" onClick={() => refresh()} className="border border-line-strong bg-white">
              <RefreshCw className={`w-4 h-4 ${dashboard.loading && data !== null ? 'animate-spin' : ''}`} />
            </IconButton>
            {canOpen('checks') && (
              <Button size="sm" variant="primary" onClick={() => onNavigate('checks')} iconRight={<ArrowRight className="w-3.5 h-3.5" />}>
                All checks
              </Button>
            )}
          </>
        }
      />

      {data?.closure && (
        <div className="card flex items-center gap-3 px-4 py-3" role="status">
          <span className={`w-9 h-9 shrink-0 rounded-lg flex items-center justify-center ${CLOSURE_TYPES[data.closure.type].chip}`} aria-hidden>
            {CLOSURE_TYPES[data.closure.type].icon}
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[13.5px] font-semibold text-ink">
              Plant closed {isToday ? 'today' : `on ${formatDateKey(date)}`} · {data.closure.label}
              {data.closure.reason ? ` · ${data.closure.reason}` : ''}
            </div>
            <div className="text-[12px] text-ink-muted">No checks scheduled, no alerts sent, nothing marked Missed.</div>
          </div>
          {canOpen('calendar') && (
            <Button size="sm" variant="outline" onClick={() => onNavigate('calendar')} icon={<CalendarOff className="w-3.5 h-3.5" />} className="hidden sm:inline-flex">
              Plant Calendar
            </Button>
          )}
        </div>
      )}

      <DataState loading={dashboard.loading} error={dashboard.error} onRetry={dashboard.reload} empty={data === null ? undefined : false}>
        {kpi && (
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
            <StatCard label="Scheduled" value={kpi.scheduled} icon={<ClipboardList className="w-4 h-4" />} meta={dayLabel} trend={series('scheduled')} />
            <StatCard
              label="Completed"
              value={kpi.completed}
              icon={<CheckCircle2 className="w-4 h-4" />}
              tone="success"
              meta={`${done}% of scheduled`}
              trend={series('completed')}
            />
            <StatCard
              label="Missed"
              value={kpi.missed}
              icon={<XCircle className="w-4 h-4" />}
              tone={kpi.missed > 0 ? 'missed' : 'neutral'}
              alert={kpi.missed > 0}
              meta={kpi.missed > 0 ? 'Needs follow-up' : 'None'}
              trend={series('missed')}
              onClick={canOpen('checks') ? () => onNavigate('checks') : undefined}
              title={canOpen('checks') ? 'Open Quality Checks' : undefined}
            />
            <StatCard
              label="Exceptions"
              value={kpi.exceptions}
              icon={<AlertTriangle className="w-4 h-4" />}
              tone={kpi.exceptions > 0 ? 'exception' : 'neutral'}
              meta="Raised by workers"
              trend={series('exceptions')}
              onClick={canOpen('exceptions') ? () => onNavigate('exceptions') : undefined}
              title={canOpen('exceptions') ? 'Open Exceptions' : undefined}
            />
            <StatCard label="Open" value={kpi.open} icon={<Clock3 className="w-4 h-4" />} tone="due" meta="Not finished yet" trend={series('open')} />
            <StatCard
              label="Completion rate"
              value={`${kpi.completionRate}%`}
              icon={<Gauge className="w-4 h-4" />}
              tone="accent"
              footer={<ProgressBar value={kpi.completionRate} label="Completion rate" tone={kpi.completionRate >= 90 ? 'success' : kpi.completionRate >= 70 ? 'accent' : 'missed'} />}
            />
          </div>
        )}

        {/* Trend + status distribution */}
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-4">
          <Card className="xl:col-span-8">
            <CardHeader
              icon={<BarChart3 className="w-4 h-4" />}
              title={`Checks · last ${TREND_DAYS} days`}
              subtitle="Completed, exceptions, missed and open per day"
              info="Each column is one day's scheduled checks split by status. Hover or focus a column for its numbers; click it to show that day on the dashboard."
              actions={<ChartLegend items={STATUS_SERIES} className="hidden md:flex" />}
            />
            <div className="p-4 pt-5">
              {trend.days ? (
                <StackedBarChart
                  height={200}
                  series={STATUS_SERIES}
                  summary={`Checks per day for the ${TREND_DAYS} days ending ${formatDateKey(date)}, by status`}
                  data={trend.days.map((d) => ({
                    label: `${weekdayOf(d.date)} ${d.date.slice(8)}`,
                    fullLabel: `${weekdayOf(d.date)} ${formatDateKey(d.date)}`,
                    highlight: d.date === date,
                    values: { completed: d.kpi.completed, exceptions: d.kpi.exceptions, missed: d.kpi.missed, open: d.kpi.open }
                  }))}
                  onSelect={(i) => trend.days && setDate(trend.days[i].date)}
                />
              ) : (
                <div className="h-[220px] rounded-lg bg-subtle animate-pulse" aria-label="Loading trend" />
              )}
              <ChartLegend items={STATUS_SERIES} className="md:hidden mt-3" />
            </div>
          </Card>

          <Card className="xl:col-span-4">
            <CardHeader icon={<PieChart className="w-4 h-4" />} title="Status distribution" subtitle={dayLabel} />
            <div className="p-4 flex flex-col sm:flex-row xl:flex-col 2xl:flex-row items-center gap-5">
              <DonutChart
                segments={STATUS_SERIES.map((s) => ({ ...s, value: kpi?.[s.key as 'completed' | 'exceptions' | 'missed' | 'open'] ?? 0 }))}
                centerValue={kpi?.scheduled ?? 0}
                centerLabel="checks"
                summary={`${kpi?.completed ?? 0} completed, ${kpi?.exceptions ?? 0} exceptions, ${kpi?.missed ?? 0} missed, ${kpi?.open ?? 0} open`}
              />
              <ul className="w-full space-y-2.5">
                {STATUS_SERIES.map((s) => {
                  const v = kpi?.[s.key as 'completed' | 'exceptions' | 'missed' | 'open'] ?? 0
                  const pct = kpi?.scheduled ? Math.round((v / kpi.scheduled) * 100) : 0
                  return (
                    <li key={s.key} className="flex items-center gap-2.5 text-[12.5px]">
                      <span className="w-2.5 h-2.5 rounded-[3px] shrink-0" style={{ backgroundColor: s.color }} aria-hidden />
                      <span className="flex-1 text-ink-secondary">{s.label}</span>
                      <span className="font-semibold text-ink tabular-nums">{v}</span>
                      <span className="w-10 text-right text-ink-muted tabular-nums">{pct}%</span>
                    </li>
                  )
                })}
              </ul>
            </div>
          </Card>
        </div>

        {/* Departments, workers, attention */}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-12 gap-4">
          <Card className="xl:col-span-4">
            <CardHeader icon={<Building2 className="w-4 h-4" />} title="Department performance" subtitle={`${dayLabel} · completion rate`} />
            <div className="px-4 py-3">
              {dayChecks.data === null ? (
                <LoadingRows />
              ) : (
                <BarList rows={byDepartment} series={STATUS_SERIES} labelHeader="Department" valueLabel="Completion" emptyText="No checks for this day" />
              )}
            </div>
          </Card>

          <Card className="xl:col-span-4">
            <CardHeader
              icon={<Users className="w-4 h-4" />}
              title="Worker performance"
              subtitle={`${dayLabel} · most missed first`}
              actions={
                canOpen('performance') && (
                  <Button size="sm" variant="ghost" onClick={() => onNavigate('performance')} iconRight={<ArrowRight className="w-3.5 h-3.5" />}>
                    Scores
                  </Button>
                )
              }
            />
            <div className="px-4 py-3">
              {dayChecks.data === null ? (
                <LoadingRows />
              ) : (
                <BarList rows={byWorker} series={STATUS_SERIES} labelHeader="Worker" valueLabel="Completion" emptyText="No worker checks for this day" />
              )}
            </div>
          </Card>

          <Card className="md:col-span-2 xl:col-span-4">
            <CardHeader
              icon={<ShieldAlert className="w-4 h-4" />}
              title="Attention needed"
              subtitle={`Last ${REPEAT_WINDOW_DAYS} days to ${formatDateKey(date)}`}
              actions={
                attentionCount > 0 ? (
                  <span className="h-5 min-w-5 px-1.5 inline-flex items-center justify-center rounded-full bg-missed-bg text-missed ring-1 ring-inset ring-missed-line text-[11px] font-semibold tabular-nums">
                    {attentionCount}
                  </span>
                ) : null
              }
            />
            <div className="p-3 space-y-2">
              <AlertRow
                tone={missedOnDay.length > 0 ? 'critical' : 'ok'}
                icon={<XCircle className="w-4 h-4" />}
                title={missedOnDay.length > 0 ? `${missedOnDay.length} missed ${missedOnDay.length === 1 ? 'check' : 'checks'} ${isToday ? 'today' : `on ${formatDateKey(date)}`}` : `No missed checks ${isToday ? 'today' : 'on this day'}`}
                detail={missedOnDay.length > 0 ? 'Listed below with machine, worker and shift' : undefined}
              />
              {canOpen('exceptions') && (
                <AlertRow
                  tone={exceptionCounts.UNDER_REVIEW > 0 ? 'warning' : 'ok'}
                  icon={<AlertTriangle className="w-4 h-4" />}
                  title={exceptionCounts.UNDER_REVIEW > 0 ? `${exceptionCounts.UNDER_REVIEW} ${exceptionCounts.UNDER_REVIEW === 1 ? 'exception' : 'exceptions'} under review` : 'No exceptions waiting for review'}
                  detail={
                    (exceptions.data?.length ?? 0) > 0 ? (
                      <span className="block mt-1.5">
                        <SegmentBar
                          values={exceptionCounts}
                          series={EXCEPTION_STATUS.map((s) => ({ key: s.key, label: s.label, color: s.color }))}
                          height={6}
                        />
                        <span className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-ink-muted">
                          {EXCEPTION_STATUS.filter((s) => exceptionCounts[s.key] > 0).map((s) => (
                            <span key={s.key}>
                              {s.label} <span className="font-semibold text-ink tabular-nums">{exceptionCounts[s.key]}</span>
                            </span>
                          ))}
                        </span>
                      </span>
                    ) : undefined
                  }
                  onClick={() => onNavigate('exceptions')}
                />
              )}
              {missed.data === null ? (
                <LoadingRows />
              ) : repeatByMachine.length === 0 && repeatByWorker.length === 0 ? (
                <AlertRow tone="ok" icon={<Repeat className="w-4 h-4" />} title="No repeated misses" detail="No machine or worker missed 2 or more checks" />
              ) : (
                <div className="rounded-lg border border-line">
                  <div className="flex items-center gap-2 px-3 pt-2.5 pb-1.5 text-[12px] font-semibold text-ink">
                    <Repeat className="w-3.5 h-3.5 text-missed" aria-hidden />
                    Repeated misses
                  </div>
                  <RepeatList title="Machines" rows={repeatByMachine} />
                  <RepeatList title="Workers" rows={repeatByWorker} />
                </div>
              )}
            </div>
          </Card>
        </div>

        {/* Machines + recent activity: each card keeps its own height */}
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 items-start">
          <Card className="xl:col-span-8 overflow-hidden">
            <CardHeader
              icon={<Cpu className="w-4 h-4" />}
              title="Machine status"
              subtitle={`${machines.length} ${machines.length === 1 ? 'machine' : 'machines'} with checks · ${dayLabel}`}
              actions={
                canOpen('machines') && (
                  <Button size="sm" variant="ghost" onClick={() => onNavigate('machines')} iconRight={<ArrowRight className="w-3.5 h-3.5" />}>
                    Machines
                  </Button>
                )
              }
            />
            {machines.length === 0 ? (
              <EmptyState icon={<Cpu className="w-5 h-5" />} title="No checks scheduled for this day" compact />
            ) : (
              <div className="overflow-x-auto lg:max-h-[360px] lg:overflow-y-auto">
                <table className="data-table stack-sm">
                  <thead>
                    <tr>
                      <th>Machine</th>
                      <th className="num">Total</th>
                      <th className="num">Done</th>
                      <th className="num">Missed</th>
                      <th className="num">Exc.</th>
                      <th className="num">Open</th>
                      <th className="w-[30%]">Progress</th>
                    </tr>
                  </thead>
                  <tbody>
                    {machines.map((m) => {
                      const pct = m.total ? Math.round((m.completed / m.total) * 100) : 0
                      return (
                        <tr
                          key={m.machineId}
                          className={canOpen('checks') ? 'cursor-pointer' : ''}
                          // The whole row is a mouse shortcut; the machine name is the keyboard-reachable button.
                          onClick={canOpen('checks') ? () => onNavigate('checks') : undefined}
                        >
                          <td className="font-medium whitespace-nowrap">
                            {canOpen('checks') ? (
                              <button
                                type="button"
                                className="font-semibold text-ink hover:text-accent text-left"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  onNavigate('checks')
                                }}
                              >
                                {m.machineName}
                              </button>
                            ) : (
                              <span className="font-semibold">{m.machineName}</span>
                            )}
                            {repeatMachineIds.has(m.machineId) && (
                              <span className="ml-2 inline-flex items-center h-[18px] px-1.5 rounded-full text-[10.5px] font-semibold bg-missed-bg text-missed ring-1 ring-inset ring-missed-line">
                                Repeat misses
                              </span>
                            )}
                          </td>
                          <td className="num">{m.total}</td>
                          <td className="num text-success font-medium">{m.completed}</td>
                          <Num value={m.missed} tone="text-missed" />
                          <Num value={m.exceptions} tone="text-exception" />
                          <td className="num text-ink-secondary">{m.open}</td>
                          <td>
                            <div className="flex items-center gap-2.5">
                              <SegmentBar
                                values={{ completed: m.completed, exceptions: m.exceptions, missed: m.missed, open: m.open }}
                                series={STATUS_SERIES}
                                className="min-w-[96px]"
                              />
                              <span className="w-9 text-right text-[12px] font-semibold text-ink tabular-nums">{pct}%</span>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card className="xl:col-span-4 overflow-hidden flex flex-col xl:max-h-[520px]">
            <CardHeader
              icon={<History className="w-4 h-4" />}
              title="Recent activity"
              subtitle="Latest submissions"
              actions={
                canOpen('checks') && (
                  <Button size="sm" variant="ghost" onClick={() => onNavigate('checks')} iconRight={<ArrowRight className="w-3.5 h-3.5" />}>
                    All
                  </Button>
                )
              }
            />
            {(data?.recent ?? []).length === 0 ? (
              <EmptyState icon={<History className="w-5 h-5" />} title="Nothing submitted yet" compact />
            ) : (
              <ol className="flex-1 px-2 py-2 overflow-y-auto">
                {data?.recent.map((c, i) => (
                  <li key={c.id} className="relative">
                    {/* Timeline rail */}
                    {i < (data?.recent.length ?? 0) - 1 && <span className="absolute left-[19px] top-8 bottom-0 w-px bg-line" aria-hidden />}
                    <button type="button" onClick={() => onViewCheck(c.id)} className="w-full text-left flex items-start gap-3 px-2 py-2 rounded-md hover:bg-subtle">
                      <span
                        className={`relative mt-0.5 w-[22px] h-[22px] shrink-0 rounded-full flex items-center justify-center ring-4 ring-white ${
                          c.status === 'COMPLETED' ? 'bg-success-bg text-success' : c.status === 'EXCEPTION' ? 'bg-exception-bg text-exception' : 'bg-subtle text-ink-muted'
                        }`}
                        aria-hidden
                      >
                        {c.status === 'EXCEPTION' ? <AlertTriangle className="w-3 h-3" /> : <CheckCircle2 className="w-3 h-3" />}
                      </span>
                      <span className="flex-1 min-w-0">
                        <span className="flex items-center justify-between gap-2">
                          <span className="text-[12.5px] font-semibold text-ink truncate">{c.machineName ?? c.departmentName ?? '—'}</span>
                          <span className="text-[11px] text-ink-muted tabular-nums shrink-0">{formatTime(c.submittedAt)}</span>
                        </span>
                        <span className="block text-[12px] text-ink-secondary truncate">{c.activityName}</span>
                        <span className="block text-[11px] text-ink-muted truncate">
                          {workerLabel(c)}
                          {c.jobNo ? ` · PO ${c.jobNo}` : ''}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </div>
      </DataState>

      {/* Missed checks of the day */}
      <Card className="overflow-hidden">
        <CardHeader
          icon={<XCircle className="w-4 h-4" />}
          title={`Missed checks · ${isToday ? 'today' : formatDateKey(date)}`}
          subtitle="Time window closed without a submission"
          actions={
            <span
              className={`h-5 min-w-5 px-1.5 inline-flex items-center justify-center rounded-full text-[11px] font-semibold tabular-nums ring-1 ring-inset ${
                missedOnDay.length > 0 ? 'bg-missed-bg text-missed ring-missed-line' : 'bg-subtle text-ink-muted ring-line'
              }`}
            >
              {missedOnDay.length}
            </span>
          }
        />
        {missed.data === null ? (
          <div className="p-4">{missed.error ? <div className="text-[12.5px] text-missed">{missed.error}</div> : <LoadingRows />}</div>
        ) : missedOnDay.length === 0 ? (
          <EmptyState icon={<CheckCircle2 className="w-5 h-5" />} title="No missed checks for this day" compact />
        ) : (
          <div className="overflow-x-auto lg:max-h-[360px] lg:overflow-y-auto">
            <table className="data-table stack-sm">
              <thead>
                <tr>
                  <th>Window</th>
                  <th>Machine</th>
                  <th>Check type</th>
                  <th>Worker</th>
                  <th>Shift</th>
                  {/* Named for screen readers only; an empty header keeps the phone card free of a label. */}
                  <th className="text-right" aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {missedOnDay.map((c) => (
                  <tr key={c.id}>
                    <td className="tabular-nums whitespace-nowrap">
                      {formatTime(c.scheduledAt)}–{formatTime(c.windowEndsAt)}
                    </td>
                    <td className="whitespace-nowrap">
                      <span className={c.machineId && repeatMachineIds.has(c.machineId) ? 'font-semibold text-missed' : 'font-medium text-ink'}>
                        {c.machineName ?? c.departmentName ?? '—'}
                      </span>
                    </td>
                    <td className="text-ink-secondary whitespace-nowrap">{c.activityName}</td>
                    <td className="whitespace-nowrap">
                      <span className={repeatWorkerIds.has(c.submittedById ?? c.workerId ?? '—') ? 'font-semibold text-missed' : c.workerName ? 'text-ink' : 'text-ink-faint italic'}>
                        {c.submittedByName ?? c.workerName ?? '—'}
                      </span>
                    </td>
                    <td className="text-ink-secondary whitespace-nowrap">{c.shiftName ?? '—'}</td>
                    <td className="text-right" data-label="">
                      <div className="inline-flex items-center gap-2">
                        <CheckStatusBadge status={c.status} size="sm" />
                        <Button size="sm" variant="outline" onClick={() => onViewCheck(c.id)} aria-label={`View missed check ${c.code}`}>
                          View
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}

const Num: React.FC<{ value: number; tone: string }> = ({ value, tone }) => (
  <td className={`num ${value > 0 ? `${tone} font-semibold` : 'text-ink-faint'}`}>{value}</td>
)

const ALERT_TONE = {
  critical: 'border-missed-line bg-missed-bg/60 text-missed',
  warning: 'border-exception-line bg-exception-bg/70 text-exception',
  ok: 'border-line bg-white text-success'
}

/** One line of the "Attention needed" card: severity icon, headline and optional detail. */
const AlertRow: React.FC<{ tone: keyof typeof ALERT_TONE; icon: React.ReactNode; title: string; detail?: React.ReactNode; onClick?: () => void }> = ({
  tone,
  icon,
  title,
  detail,
  onClick
}) => {
  const body = (
    <>
      <span className="mt-px shrink-0" aria-hidden>
        {icon}
      </span>
      <span className="flex-1 min-w-0 text-left">
        <span className="block text-[12.5px] font-semibold text-ink">{title}</span>
        {detail && <span className="block text-[11.5px] text-ink-muted">{detail}</span>}
      </span>
    </>
  )
  const cls = `w-full flex items-start gap-2.5 px-3 py-2.5 rounded-lg border ${ALERT_TONE[tone]}`
  return onClick ? (
    <button type="button" onClick={onClick} className={`${cls} hover:shadow-[var(--shadow-card)] transition-shadow`}>
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  )
}

const RepeatList: React.FC<{ title: string; rows: RepeatRow[] }> = ({ title, rows }) => (
  <div className="px-3 pb-2.5">
    <div className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-ink-muted mb-1">{title}</div>
    {rows.length === 0 ? (
      <div className="text-[12px] text-ink-faint">None</div>
    ) : (
      <ul className="space-y-1">
        {rows.slice(0, 4).map((r) => (
          <li key={r.key} className="flex items-center gap-2 text-[12.5px]">
            <span className="flex-1 min-w-0 truncate">
              <span className="font-medium text-ink">{r.name}</span>
              {r.detail && <span className="text-ink-muted"> · {r.detail}</span>}
            </span>
            {r.onDay > 0 && <span className="text-[11px] text-ink-muted whitespace-nowrap">{r.onDay} on day</span>}
            <span
              className={`h-5 px-1.5 inline-flex items-center rounded-full text-[11px] font-semibold tabular-nums ${
                r.total >= 3 ? 'bg-[var(--color-chart-missed)] text-white' : 'bg-missed-bg text-missed ring-1 ring-inset ring-missed-line'
              }`}
            >
              {r.total}×
            </span>
          </li>
        ))}
        {rows.length > 4 && <li className="text-[11px] text-ink-muted">+{rows.length - 4} more</li>}
      </ul>
    )}
  </div>
)

const LoadingRows: React.FC = () => (
  <div className="space-y-2.5 py-1" aria-hidden>
    {[80, 62, 72].map((w) => (
      <div key={w} className="h-3 rounded bg-subtle animate-pulse" style={{ width: `${w}%` }} />
    ))}
  </div>
)
