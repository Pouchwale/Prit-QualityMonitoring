import React, { useState } from 'react'
import { RefreshCw, Users } from 'lucide-react'
import type { PerformanceFilterValues, PerformanceResult } from '../../types'
import { useApi } from '../../lib/useApi'
import { addDaysKey, dateKey } from '../../lib/format'
import { Button } from '../../components/common/Button'
import { DataState } from '../../components/common/DataState'
import { PageHeader } from '../../components/common/PageHeader'
import { inputClass } from '../../components/common/Form'
import { DateInput } from '../../components/common/DateTimeInputs'

/** Negative scores in red, zero in green: "0%" means every assigned check was done. */
const scoreClass = (score: number) => (score < 0 ? 'text-failed' : 'text-success')
/** The score is a percentage, and always carries its sign. */
const scoreText = (score: number) => `${score}%`

const PRESETS = [
  { label: 'Today', from: () => dateKey(), to: () => dateKey() },
  { label: 'Last 7 days', from: () => addDaysKey(dateKey(), -6), to: () => dateKey() },
  { label: 'Last 30 days', from: () => addDaysKey(dateKey(), -29), to: () => dateKey() }
]

export const PerformancePage: React.FC = () => {
  const [from, setFrom] = useState(() => addDaysKey(dateKey(), -6))
  const [to, setTo] = useState(dateKey)
  const [workerId, setWorkerId] = useState('')
  const [machineId, setMachineId] = useState('')
  const [shiftId, setShiftId] = useState('')
  const [departmentId, setDepartmentId] = useState('')
  const [jobNo, setJobNo] = useState('')
  const [jobSearch, setJobSearch] = useState('')

  const { data, error, loading, reload } = useApi<PerformanceResult>('/api/performance/workers', { from, to, workerId, machineId, shiftId, jobNo, departmentId })
  // Machines, shifts, departments and workers the signed-in user may filter by (a Manager gets
  // only their own department and its workers).
  const filters = useApi<PerformanceFilterValues>('/api/performance/filter-values')
  const scope = data?.scope ?? filters.data?.scope

  const rows = data?.workers ?? []

  const applyPreset = (preset: (typeof PRESETS)[number]) => {
    setFrom(preset.from())
    setTo(preset.to())
  }
  const reset = () => {
    setFrom(addDaysKey(dateKey(), -6))
    setTo(dateKey())
    setWorkerId('')
    setMachineId('')
    setShiftId('')
    setDepartmentId('')
    setJobNo('')
    setJobSearch('')
  }
  const searchJob = () => setJobNo(jobSearch.trim())

  return (
    <div className="space-y-4">
      <PageHeader
        title="Worker Performance"
        description="Assigned, completed and missed checks per worker, with the share still not done as the score"
        actions={
          <Button size="sm" variant="outline" onClick={() => reload()} loading={loading && data !== null} icon={<RefreshCw className="w-3.5 h-3.5" />}>
            Refresh
          </Button>
        }
      />

      {scope?.restricted ? (
        <div className="flex items-start gap-2 rounded-md border border-line bg-slate-50 px-3 py-2 text-[12px] text-ink-secondary">
          <Users className="w-3.5 h-3.5 mt-px text-ink-muted shrink-0" />
          {scope.missingDepartment ? (
            <span>Your account has no department yet, so no workers are shown. Ask an Admin to set your department.</span>
          ) : (
            <span>
              You see the <span className="font-semibold text-ink">{scope.departmentName}</span> department only. Workers of other departments are not included.
            </span>
          )}
        </div>
      ) : null}

      {/* Filters */}
      <div className="bg-white border border-line rounded-md p-3 shadow-2xs grid grid-cols-2 sm:flex sm:flex-wrap items-end gap-2.5 text-xs">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold text-ink-secondary mb-1">From</div>
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
        </div>
        <div className="min-w-0">
          <div className="text-[11px] font-semibold text-ink-secondary mb-1">To</div>
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
        </div>
        <div className="min-w-0">
          <div className="text-[11px] font-semibold text-ink-secondary mb-1">Department</div>
          <select
            aria-label="Department"
            value={scope?.restricted ? (scope.departmentId ?? '') : departmentId}
            onChange={(e) => setDepartmentId(e.target.value)}
            disabled={scope?.restricted}
            title={scope?.restricted ? 'You see your own department only' : undefined}
            className={`${inputClass} px-2 sm:w-auto sm:max-w-[170px]`}
          >
            {scope?.restricted ? null : <option value="">All departments</option>}
            {(filters.data?.departments ?? []).map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
            {scope?.missingDepartment ? <option value="">No department</option> : null}
          </select>
        </div>
        <div className="min-w-0">
          <div className="text-[11px] font-semibold text-ink-secondary mb-1">Worker</div>
          <select aria-label="Worker" value={workerId} onChange={(e) => setWorkerId(e.target.value)} className={`${inputClass} px-2 sm:w-auto sm:max-w-[190px]`}>
            <option value="">All workers</option>
            {(filters.data?.workers ?? []).map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </div>
        <div className="min-w-0">
          <div className="text-[11px] font-semibold text-ink-secondary mb-1">Machine</div>
          <select aria-label="Machine" value={machineId} onChange={(e) => setMachineId(e.target.value)} className={`${inputClass} px-2 sm:w-auto sm:max-w-[190px]`}>
            <option value="">All machines</option>
            {(filters.data?.machines ?? []).map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </div>
        <div className="min-w-0">
          <div className="text-[11px] font-semibold text-ink-secondary mb-1">Shift</div>
          <select aria-label="Shift" value={shiftId} onChange={(e) => setShiftId(e.target.value)} className={`${inputClass} px-2 sm:w-auto`}>
            <option value="">All shifts</option>
            {(filters.data?.shifts ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div className="col-span-2 sm:col-auto min-w-0">
          <div className="text-[11px] font-semibold text-ink-secondary mb-1">PO No.</div>
          <div className="flex gap-1.5">
            <input
              type="text"
              value={jobSearch}
              onChange={(e) => setJobSearch(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && searchJob()}
              onBlur={searchJob}
              placeholder="e.g. J-4417"
              aria-label="PO No."
              className={`${inputClass} sm:w-[150px]`}
            />
          </div>
        </div>
        <div className="col-span-2 sm:col-auto flex items-center gap-1.5 sm:ml-auto">
          {PRESETS.map((p) => (
            <Button key={p.label} size="sm" variant="ghost" onClick={() => applyPreset(p)}>
              {p.label}
            </Button>
          ))}
          <Button size="sm" variant="outline" onClick={reset}>
            Reset
          </Button>
        </div>
      </div>

      {/* Totals + the rule that produced the scores */}
      {data && (
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-2.5">
          <Stat label="Workers" value={data.totals.workers} />
          <Stat label="Assigned" value={data.totals.assigned} />
          <Stat label="Completed" value={data.totals.completed} />
          <Stat label="Missed" value={data.totals.missed} />
          <Stat label="Total score" value={scoreText(data.totals.score)} className={scoreClass(data.totals.score)} />
        </div>
      )}

      <DataState loading={loading} error={error} onRetry={reload} empty={data === null ? undefined : rows.length === 0} emptyText="No checks were assigned in this period.">
        <div className="bg-white border border-line rounded-md shadow-2xs overflow-hidden">
          <div className="px-3 py-2 border-b border-line bg-slate-50 text-[11px] text-ink-muted">
            Score = completion − 100: the share of a worker's checks still not done, as a negative percentage. Everything done is 0%; 80 of 100 done
            is −20%. Missed = assigned − completed.
          </div>
          <div className="overflow-x-auto">
            <table className="stack-sm w-full text-left text-xs border-collapse">
              <thead className="bg-slate-50 border-b border-line text-ink-secondary text-[11px] uppercase tracking-wider">
                <tr>
                  <th className="py-2.5 px-3 font-semibold">Worker</th>
                  <th className="py-2.5 px-3 font-semibold text-right">Assigned</th>
                  <th className="py-2.5 px-3 font-semibold text-right">Completed</th>
                  <th className="py-2.5 px-3 font-semibold text-right">Missed</th>
                  <th className="py-2.5 px-3 font-semibold text-right">Of which missed / exception / open</th>
                  <th className="py-2.5 px-3 font-semibold text-right">Completion</th>
                  <th className="py-2.5 px-3 font-semibold text-right">Score</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((w) => (
                  <tr key={w.workerId} className="hover:bg-slate-50">
                    <td className="py-2 px-3">
                      <div className="font-medium text-ink">{w.workerName}</div>
                      <div className="text-[11px] text-ink-muted font-mono">{w.employeeId}</div>
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums text-ink">{w.assigned}</td>
                    <td className="py-2 px-3 text-right tabular-nums text-ink">{w.completed}</td>
                    <td className="py-2 px-3 text-right tabular-nums text-ink">{w.missed}</td>
                    <td className="py-2 px-3 text-right tabular-nums text-ink-muted whitespace-nowrap">
                      {w.missedChecks} / {w.exceptions} / {w.open}
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums text-ink-secondary">{w.completionRate}%</td>
                    <td className={`py-2 px-3 text-right tabular-nums font-semibold ${scoreClass(w.score)}`}>{scoreText(w.score)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </DataState>

    </div>
  )
}

const Stat: React.FC<{ label: string; value: number | string; className?: string }> = ({ label, value, className = 'text-ink' }) => (
  <div className="bg-white border border-line rounded-md px-3 py-2.5 shadow-2xs">
    <div className="text-[11px] text-ink-muted">{label}</div>
    <div className={`text-lg font-semibold tabular-nums ${className}`}>{value}</div>
  </div>
)
