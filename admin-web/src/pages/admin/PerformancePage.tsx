import React, { useMemo, useState } from 'react'
import { AlertTriangle, CalendarDays, CheckCircle2, ClipboardList, Filter, Gauge, RefreshCw, RotateCcw, Trophy, Users, XCircle } from 'lucide-react'
import type { PerformanceFilterValues, PerformanceResult, WorkerPerformance } from '../../types'
import { useApi } from '../../lib/useApi'
import { addDaysKey, dateKey, formatDateKey } from '../../lib/format'
import { Button } from '../../components/common/Button'
import { DataState } from '../../components/common/DataState'
import { PageHeader } from '../../components/common/PageHeader'
import { inputClass } from '../../components/common/Form'
import { DateInput } from '../../components/common/DateTimeInputs'
import { Card, CardHeader } from '../../components/ui/Card'
import { StatCard } from '../../components/ui/StatCard'
import { BarList, ChartLegend, DonutChart, ProgressBar, SegmentBar, STATUS_SERIES, type BarListRow } from '../../components/ui/charts'
import { IconButton, ResultCount, Segmented } from '../../components/ui/Toolbar'
import { Pagination, usePagination } from '../../components/ui/Pagination'
import { useAuth } from '../../lib/auth'
import { WeeklyScores } from './WeeklyScores'
import { ScoreFormulaCard } from './ScoreFormula'
import { OverallScores } from './OverallScores'

/** The score is a percentage, and always carries its sign. */
const scoreText = (score: number) => `${score}%`

/** Negative scores in red, zero in green: "0%" means every assigned check was done. */
const ScorePill: React.FC<{ score: number }> = ({ score }) => (
  <span
    className={`inline-flex items-center gap-1 h-5 px-1.5 rounded-full text-[11.5px] font-semibold tabular-nums ring-1 ring-inset whitespace-nowrap ${
      score < 0 ? 'bg-missed-bg text-missed ring-missed-line' : 'bg-success-bg text-success ring-success-line'
    }`}
  >
    {score < 0 ? <XCircle className="w-3 h-3" aria-hidden /> : <CheckCircle2 className="w-3 h-3" aria-hidden />}
    {scoreText(score)}
  </span>
)

const SCORE_INFO =
  'Assigned = checks whose time window has ended (or that are finished); checks still open are shown but not counted. Score = completion − 100, where an exception counts as done: everything done is 0%; 80 of 100 done is −20%. Missed = checks marked Missed.'

/** This week's Sunday (plant date); a week runs Sunday to Saturday. */
const weekSunday = () => addDaysKey(dateKey(), -new Date(`${dateKey()}T00:00:00Z`).getUTCDay())

const PRESETS = [
  { label: 'Today', from: () => dateKey(), to: () => dateKey() },
  { label: 'This week', from: weekSunday, to: () => addDaysKey(weekSunday(), 6) },
  { label: 'Last 7 days', from: () => addDaysKey(dateKey(), -6), to: () => dateKey() },
  { label: 'Last 30 days', from: () => addDaysKey(dateKey(), -29), to: () => dateKey() }
]

/** How many workers the ranking chart lists; the table below has everyone. */
const RANKING_ROWS = 8

/** Green for 0%, amber down to −20%, red below: the same bands as the weekly scores. */
const scoreTone = (score: number) => (score === 0 ? 'text-success' : score >= -20 ? 'text-exception' : 'text-missed')

const filterLabel = 'block text-[11px] font-medium text-ink-muted mb-1'
/** A filter that is set stands out, as in the shared FilterBar. */
const activeClass = (on: boolean) => (on ? 'border-accent bg-accent-soft/40' : '')

export const PerformancePage: React.FC = () => {
  const { isAdmin } = useAuth()
  const [from, setFrom] = useState(weekSunday)
  const [to, setTo] = useState(() => addDaysKey(weekSunday(), 6))
  const [workerId, setWorkerId] = useState('')
  const [machineId, setMachineId] = useState('')
  const [shiftId, setShiftId] = useState('')
  const [departmentId, setDepartmentId] = useState('')
  const [jobNo, setJobNo] = useState('')
  const [jobSearch, setJobSearch] = useState('')

  const { data, error, loading, reload } = useApi<PerformanceResult>('/api/performance/workers', { from, to, workerId, machineId, shiftId, jobNo, departmentId })
  // Machines, shifts, departments and workers to filter by: all of them, for Managers too. The
  // Department filter counts the checks done for that department (the department on each check).
  const filters = useApi<PerformanceFilterValues>('/api/performance/filter-values')
  const scope = data?.scope ?? filters.data?.scope

  // Lowest score first: the workers who need attention lead the table (it is the ranking).
  const rows = useMemo(
    () => [...(data?.workers ?? [])].sort((a, b) => a.score - b.score || b.missed - a.missed || a.workerName.localeCompare(b.workerName)),
    [data]
  )
  const paging = usePagination(rows, 25, `${from}|${to}|${workerId}|${machineId}|${shiftId}|${departmentId}|${jobNo}`)

  // Score ranking: the workers who need attention first (the table below has everyone).
  const ranking = useMemo<BarListRow[]>(
    () =>
      rows.slice(0, RANKING_ROWS).map((w: WorkerPerformance) => ({
        key: w.workerId,
        label: w.workerName,
        detail: w.employeeId.toLowerCase() === w.workerName.toLowerCase() ? undefined : w.employeeId,
        values: { completed: w.completed, exceptions: w.exceptions, missed: w.missed, open: w.open },
        value: scoreText(w.score),
        valueTone: w.score < 0 ? 'text-missed' : 'text-success'
      })),
    [rows]
  )

  const activePreset = PRESETS.find((p) => p.from() === from && p.to() === to)?.label ?? ''
  const applyPreset = (preset: (typeof PRESETS)[number]) => {
    setFrom(preset.from())
    setTo(preset.to())
  }
  const reset = () => {
    setFrom(weekSunday())
    setTo(addDaysKey(weekSunday(), 6))
    setWorkerId('')
    setMachineId('')
    setShiftId('')
    setDepartmentId('')
    setJobNo('')
    setJobSearch('')
  }
  const searchJob = () => setJobNo(jobSearch.trim())

  const period = from === to ? formatDateKey(from) : `${formatDateKey(from)} – ${formatDateKey(to)}`
  const totals = data?.totals

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<Trophy className="w-4.5 h-4.5" />}
        title="Worker Performance"
        description={
          <span className="inline-flex items-center gap-1.5 flex-wrap">
            <span className="font-medium text-ink-secondary">{period}</span>
            {data && (
              <>
                <span aria-hidden>·</span>
                {data.totals.workers} {data.totals.workers === 1 ? 'worker' : 'workers'}
              </>
            )}
          </span>
        }
        info={`Checks whose time has ended, per worker: completed, exceptions and missed, with the share not done as the score. ${SCORE_INFO}`}
        actions={
          <IconButton label="Refresh" size="md" onClick={() => reload()} className="border border-line-strong bg-white">
            <RefreshCw className={`w-4 h-4 ${loading && data !== null ? 'animate-spin' : ''}`} />
          </IconButton>
        }
      />

      {scope?.restricted ? (
        <div className="card flex items-start gap-2 px-3 py-2.5 text-[12.5px] text-ink-secondary" role="status">
          <Users className="w-3.5 h-3.5 mt-0.5 text-ink-muted shrink-0" aria-hidden />
          {scope.missingDepartment ? (
            <span>Your account has no department yet, so no workers are shown. Ask an Admin to set your department.</span>
          ) : (
            <span>
              You see the <span className="font-semibold text-ink">{scope.departmentName}</span> department only. Workers of other departments are not included.
            </span>
          )}
        </div>
      ) : null}

      {/* 1. Period summary: everything down to the Workers table follows the filters. */}
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <h2 className="text-[15px] font-semibold text-ink">Period summary</h2>
        <p className="inline-flex items-center gap-1.5 text-[12px] text-ink-muted">
          <Filter className="w-3 h-3" aria-hidden />
          The filters apply to this section · {period}
        </p>
      </div>

      {/* Filters */}
      <div className="card px-3 py-2.5">
        <div className="grid grid-cols-2 sm:flex sm:flex-wrap items-end gap-2.5">
          <label className="min-w-0">
            <span className={filterLabel}>From</span>
            <DateInput
              value={from}
              max={to}
              onChange={(e) => {
                const v = e.target.value
                setFrom(v)
                if (v && to && v > to) setTo(v)
              }}
              className="sm:w-[160px] lg:w-[132px]"
            />
          </label>
          <label className="min-w-0">
            <span className={filterLabel}>To</span>
            <DateInput
              value={to}
              min={from}
              onChange={(e) => {
                const v = e.target.value
                setTo(v)
                if (v && from && v < from) setFrom(v)
              }}
              className="sm:w-[160px] lg:w-[132px]"
            />
          </label>
          <Segmented
            label="Date presets"
            className="col-span-2 sm:col-auto"
            value={activePreset}
            onChange={(label) => {
              const preset = PRESETS.find((p) => p.label === label)
              if (preset) applyPreset(preset)
            }}
            options={PRESETS.map((p) => ({ value: p.label, label: p.label.replace('Last ', '') }))}
          />
          <label className="min-w-0">
            <span className={filterLabel}>Department</span>
            <select
              aria-label="Department"
              value={scope?.restricted ? (scope.departmentId ?? '') : departmentId}
              onChange={(e) => setDepartmentId(e.target.value)}
              disabled={scope?.restricted}
              title={scope?.restricted ? 'You see your own department only' : 'Counts only the checks done for this department'}
              className={`${inputClass} px-2 sm:w-auto sm:max-w-[170px] ${activeClass(!scope?.restricted && !!departmentId)}`}
            >
              {scope?.restricted ? null : <option value="">All departments</option>}
              {(filters.data?.departments ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
              {scope?.missingDepartment ? <option value="">No department</option> : null}
            </select>
          </label>
          <label className="min-w-0">
            <span className={filterLabel}>Worker</span>
            <select aria-label="Worker" value={workerId} onChange={(e) => setWorkerId(e.target.value)} className={`${inputClass} px-2 sm:w-auto sm:max-w-[190px] ${activeClass(!!workerId)}`}>
              <option value="">All workers</option>
              {(filters.data?.workers ?? []).map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
          <label className="min-w-0">
            <span className={filterLabel}>Machine</span>
            <select aria-label="Machine" value={machineId} onChange={(e) => setMachineId(e.target.value)} className={`${inputClass} px-2 sm:w-auto sm:max-w-[190px] ${activeClass(!!machineId)}`}>
              <option value="">All machines</option>
              {(filters.data?.machines ?? []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <label className="min-w-0">
            <span className={filterLabel}>Shift</span>
            <select aria-label="Shift" value={shiftId} onChange={(e) => setShiftId(e.target.value)} className={`${inputClass} px-2 sm:w-auto ${activeClass(!!shiftId)}`}>
              <option value="">All shifts</option>
              {(filters.data?.shifts ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="min-w-0">
            <span className={filterLabel}>PO No.</span>
            <input
              type="text"
              value={jobSearch}
              onChange={(e) => setJobSearch(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && searchJob()}
              onBlur={searchJob}
              placeholder="e.g. J-4417"
              aria-label="PO No."
              className={`${inputClass} sm:w-[140px] ${activeClass(!!jobNo)}`}
            />
          </label>
          <Button size="field" variant="ghost" onClick={reset} icon={<RotateCcw className="w-3 h-3" />}>
            Reset
          </Button>
        </div>
      </div>

      {/* Totals for everyone shown */}
      {totals && (
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          {/* Workers spans the row on narrower screens, so the other four sit in a 2 × 2 grid. */}
          <div className="col-span-2 lg:col-span-1 grid">
            <StatCard label="Workers" value={totals.workers} icon={<Users className="w-4 h-4" />} meta="In this period" />
          </div>
          <StatCard label="Assigned" value={totals.assigned} icon={<ClipboardList className="w-4 h-4" />} meta={totals.open ? `${totals.open} still open` : 'Time window ended'} />
          <StatCard label="Completed" value={totals.completed} icon={<CheckCircle2 className="w-4 h-4" />} tone="success" meta={`${totals.completionRate}% completion`} />
          <StatCard
            label="Exceptions"
            value={totals.exceptions}
            icon={<AlertTriangle className="w-4 h-4" />}
            tone={totals.exceptions > 0 ? 'exception' : 'neutral'}
            meta="Counted as done"
          />
          <StatCard
            label="Missed"
            value={totals.missed}
            icon={<XCircle className="w-4 h-4" />}
            tone={totals.missed > 0 ? 'missed' : 'neutral'}
            alert={totals.missed > 0}
            meta={totals.missed > 0 ? 'Not done in time' : 'None'}
          />
        </div>
      )}

      {/* The total score with how the checks split, and the workers who need attention. */}
      {totals && rows.length > 0 && (
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-4">
          <Card className="xl:col-span-5">
            <CardHeader icon={<Gauge className="w-4 h-4" />} title="Total score" subtitle={`All shown workers · ${period}`} info={SCORE_INFO} />
            <div className="p-4 flex flex-col sm:flex-row items-center gap-6">
              <DonutChart
                size={164}
                segments={STATUS_SERIES.map((s) => ({ ...s, value: s.key === 'exceptions' ? totals.exceptions : totals[s.key as 'completed' | 'missed' | 'open'] }))}
                centerValue={<span className={scoreTone(totals.score)}>{scoreText(totals.score)}</span>}
                centerLabel="total score"
                summary={`Total score ${scoreText(totals.score)}: ${totals.completed} completed, ${totals.exceptions} exceptions, ${totals.missed} missed, ${totals.open} open`}
              />
              <div className="w-full min-w-0 flex-1 space-y-3">
                <div>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[12px] font-medium text-ink-secondary">Completion</span>
                    <span className="text-[20px] font-semibold text-ink tabular-nums">{totals.completionRate}%</span>
                  </div>
                  <ProgressBar
                    className="mt-1.5"
                    value={totals.completionRate}
                    label="Completion rate"
                    tone={totals.completionRate >= 90 ? 'success' : totals.completionRate >= 70 ? 'accent' : 'missed'}
                  />
                  <p className="mt-1 text-[11.5px] text-ink-muted tabular-nums">
                    {totals.completed + totals.exceptions} of {totals.assigned} assigned checks done
                  </p>
                </div>
                <ul className="divide-y divide-line border-t border-line">
                  {STATUS_SERIES.map((s) => {
                    const v = s.key === 'exceptions' ? totals.exceptions : totals[s.key as 'completed' | 'missed' | 'open']
                    const all = totals.assigned + totals.open
                    return (
                      <li key={s.key} className="flex items-center gap-2.5 py-2 text-[12.5px]">
                        <span className="w-2.5 h-2.5 rounded-[3px] shrink-0" style={{ backgroundColor: s.color }} aria-hidden />
                        <span className="flex-1 text-ink-secondary">
                          {s.label}
                          {s.key === 'open' && <span className="text-ink-muted"> · not counted yet</span>}
                        </span>
                        <span className="w-10 text-right text-[11.5px] text-ink-muted tabular-nums">{all ? `${Math.round((v / all) * 100)}%` : '—'}</span>
                        <span className="w-8 text-right font-semibold text-ink tabular-nums">{v}</span>
                      </li>
                    )
                  })}
                </ul>
              </div>
            </div>
          </Card>

          <Card className="xl:col-span-7">
            <CardHeader
              icon={<Trophy className="w-4 h-4" />}
              title="Score ranking"
              subtitle={rows.length > RANKING_ROWS ? `Lowest ${RANKING_ROWS} of ${rows.length} workers · all in the table below` : 'Lowest score first'}
              info={SCORE_INFO}
              actions={<ChartLegend items={STATUS_SERIES} className="hidden md:flex" />}
            />
            <div className="px-4 py-3">
              <BarList rows={ranking} series={STATUS_SERIES} labelHeader="Worker" valueLabel="Score" emptyText="No workers in this period" />
              <ChartLegend items={STATUS_SERIES} className="md:hidden mt-3" />
            </div>
          </Card>
        </div>
      )}

      {/* How the score is worked out, with this period's numbers as the example. */}
      <ScoreFormulaCard totals={totals} period={period} />

      <DataState loading={loading} error={error} onRetry={reload} empty={data === null ? undefined : rows.length === 0} emptyText="No checks were assigned in this period.">
        <Card className="overflow-hidden">
          <CardHeader
            icon={<Users className="w-4 h-4" />}
            title="Workers"
            subtitle={`Lowest score first · ${period}`}
            info={SCORE_INFO}
            actions={
              <div className="flex items-center gap-4">
                <ChartLegend items={STATUS_SERIES} className="hidden lg:flex" />
                <ResultCount shown={rows.length} noun={rows.length === 1 ? 'worker' : 'workers'} />
              </div>
            }
          />
          <div className="overflow-x-auto">
            <table className="data-table stack-sm">
              <thead>
                <tr>
                  <th>Worker</th>
                  <th className="num">Assigned</th>
                  <th className="num">Completed</th>
                  <th className="num">Exception</th>
                  <th className="num">Missed</th>
                  <th className="num" title="Still open: not counted yet">
                    Open
                  </th>
                  <th className="hidden lg:table-cell w-[22%]">Checks</th>
                  <th className="num">Done</th>
                  <th className="num">Score</th>
                </tr>
              </thead>
              <tbody>
                {paging.visible.map((w) => (
                  <tr key={w.workerId}>
                    <td>
                      <div className="font-medium text-ink whitespace-nowrap">{w.workerName}</div>
                      {w.employeeId.toLowerCase() !== w.workerName.toLowerCase() && <div className="text-[11.5px] text-ink-muted font-mono">{w.employeeId}</div>}
                    </td>
                    <td className="num">{w.assigned}</td>
                    <td className="num text-success font-medium">{w.completed}</td>
                    <Num value={w.exceptions} tone="text-exception" />
                    <Num value={w.missed} tone="text-missed" />
                    <td className="num text-ink-muted">{w.open}</td>
                    <td className="hidden lg:table-cell">
                      <SegmentBar values={{ completed: w.completed, exceptions: w.exceptions, missed: w.missed, open: w.open }} series={STATUS_SERIES} />
                    </td>
                    <td className="num text-ink-secondary">{w.completionRate}%</td>
                    <td className="num">
                      <ScorePill score={w.score} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={paging.page} pages={paging.pages} total={paging.total} pageSize={paging.pageSize} onPage={paging.setPage} noun="workers" />
        </Card>
      </DataState>

      {/* 2. Overall score: each worker from their first check up to today (not the filters above).
          Admins and the Super Admin only (the API refuses Managers). */}
      {isAdmin && (
        <section aria-labelledby="overall-score-heading" className="space-y-3 pt-5 border-t border-line">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
            <h2 id="overall-score-heading" className="text-[15px] font-semibold text-ink">
              Overall score
            </h2>
            <p className="text-[12px] text-ink-muted">From each worker's first check up to today</p>
          </div>
          <OverallScores />
        </section>
      )}

      {/* 3. Weekly scores: everyone's day-wise scores, with its own week (not the filters above).
          Admins and the Super Admin only (the API refuses Managers). */}
      {isAdmin && (
        <section aria-labelledby="weekly-scores-heading" className="space-y-3 pt-5 border-t border-line">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
            <h2 id="weekly-scores-heading" className="text-[15px] font-semibold text-ink">
              Weekly scores
            </h2>
            <p className="inline-flex items-center gap-1.5 text-[12px] text-ink-muted">
              <CalendarDays className="w-3 h-3" aria-hidden />
              Sunday to Saturday · choose the week with the arrows
            </p>
          </div>
          <WeeklyScores />
        </section>
      )}
    </div>
  )
}

const Num: React.FC<{ value: number; tone: string }> = ({ value, tone }) => (
  <td className={`num ${value > 0 ? `${tone} font-semibold` : 'text-ink-faint'}`}>{value}</td>
)
