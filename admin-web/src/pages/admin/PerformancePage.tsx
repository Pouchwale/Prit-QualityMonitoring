import React, { useState } from 'react'
import { Gauge, History, RefreshCw, Save, SlidersHorizontal, Users } from 'lucide-react'
import type { PerformanceFilterValues, PerformanceResult, PenaltyChange, ScoreSetting } from '../../types'
import { api, errorText } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { useAuth } from '../../lib/auth'
import { addDaysKey, dateKey, formatDateTime } from '../../lib/format'
import { Button } from '../../components/common/Button'
import { DataState } from '../../components/common/DataState'
import { PageHeader } from '../../components/common/PageHeader'
import { Section } from '../../components/common/Section'
import { inputClass } from '../../components/common/Form'
import { DateInput } from '../../components/common/DateTimeInputs'
import { useToast } from '../../components/common/Toast'

/** Negative scores in red, zero in green: "0" means every assigned check was done. */
const scoreClass = (score: number) => (score < 0 ? 'text-failed' : 'text-success')

const PRESETS = [
  { label: 'Today', from: () => dateKey(), to: () => dateKey() },
  { label: 'Last 7 days', from: () => addDaysKey(dateKey(), -6), to: () => dateKey() },
  { label: 'Last 30 days', from: () => addDaysKey(dateKey(), -29), to: () => dateKey() }
]

export const PerformancePage: React.FC = () => {
  const { isAdmin } = useAuth()
  const notify = useToast()
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
  const penalty = data?.penaltyPerMissed ?? -1

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
        description="Assigned, completed and missed checks per worker, with the score from the missed ones"
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
          <div className="text-[11px] font-semibold text-ink-secondary mb-1">Job No.</div>
          <div className="flex gap-1.5">
            <input
              type="text"
              value={jobSearch}
              onChange={(e) => setJobSearch(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && searchJob()}
              onBlur={searchJob}
              placeholder="e.g. J-4417"
              aria-label="Job No."
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
          <Stat label="Total score" value={data.totals.score} className={scoreClass(data.totals.score)} />
        </div>
      )}

      <DataState loading={loading} error={error} onRetry={reload} empty={data === null ? undefined : rows.length === 0} emptyText="No checks were assigned in this period.">
        <div className="bg-white border border-line rounded-md shadow-2xs overflow-hidden">
          <div className="px-3 py-2 border-b border-line bg-slate-50 text-[11px] text-ink-muted">
            Score = missed checks × <span className="font-mono text-ink">{penalty}</span> (set in Score settings). Missed = assigned − completed.
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
                    <td className={`py-2 px-3 text-right tabular-nums font-semibold ${scoreClass(w.score)}`}>{w.score}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </DataState>

      {isAdmin && <ScoreSettings onSaved={reload} notify={notify} />}
    </div>
  )
}

const Stat: React.FC<{ label: string; value: number; className?: string }> = ({ label, value, className = 'text-ink' }) => (
  <div className="bg-white border border-line rounded-md px-3 py-2.5 shadow-2xs">
    <div className="text-[11px] text-ink-muted">{label}</div>
    <div className={`text-lg font-semibold tabular-nums ${className}`}>{value}</div>
  </div>
)

/** Admin only: the penalty per missed check, and every change made to it. */
const ScoreSettings: React.FC<{ onSaved: () => void; notify: ReturnType<typeof useToast> }> = ({ onSaved, notify }) => {
  const setting = useApi<ScoreSetting>('/api/performance/settings')
  const history = useApi<PenaltyChange[]>('/api/performance/settings/history')
  const [value, setValue] = useState<string>('')
  const [saving, setSaving] = useState(false)
  const current = setting.data?.penaltyPerMissed ?? -1
  const entered = value === '' ? current : Number(value)
  const invalid = !Number.isInteger(entered) || entered > 0 || entered < -1000

  const save = async () => {
    if (invalid || entered === current) return
    setSaving(true)
    try {
      await api.put('/api/performance/settings', { penaltyPerMissed: entered })
      setValue('')
      await Promise.all([setting.reload(), history.reload()])
      onSaved()
      notify('success', 'Score settings saved', `Every score now uses ${entered} point${entered === -1 || entered === 1 ? '' : 's'} per missed check.`)
    } catch (err) {
      notify('error', 'Could not save the score settings', errorText(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Section icon={<SlidersHorizontal className="w-3.5 h-3.5" />} title="Score settings" description="How many points a worker loses for each missed check. Applies everywhere at once; no new app build is needed.">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="penalty" className="block text-[11px] font-semibold text-ink-secondary mb-1">
            Penalty per missed check
          </label>
          <input
            id="penalty"
            type="number"
            max={0}
            min={-1000}
            step={1}
            value={value === '' ? current : value}
            onChange={(e) => setValue(e.target.value)}
            aria-label="Penalty per missed check"
            className="h-[40px] w-[110px] lg:h-[34px] lg:w-[96px] rounded border border-line-strong bg-white px-2 text-center font-mono text-[16px] lg:text-[14px] tabular-nums text-ink focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </div>
        <Button size="sm" variant="primary" onClick={save} loading={saving} disabled={invalid || entered === current} icon={<Save className="w-3.5 h-3.5" />}>
          Save
        </Button>
        <p className="text-[11px] text-ink-muted max-w-md">
          {invalid ? (
            <span className="text-failed">Enter a whole number of 0 or less, for example −1 or −2.</span>
          ) : (
            <>
              10 missed checks would score <span className="font-mono text-ink">{10 * entered}</span>. 0 means nothing is deducted.
              {setting.data?.updatedAt ? ` Last changed ${formatDateTime(setting.data.updatedAt)}.` : ''}
            </>
          )}
        </p>
      </div>

      <div className="mt-4">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold text-ink-secondary mb-1.5">
          <History className="w-3.5 h-3.5" />
          Change history
        </div>
        {history.data?.length ? (
          <div className="border border-line rounded-md overflow-hidden">
            <table className="w-full text-left text-xs border-collapse">
              <thead className="bg-slate-50 border-b border-line text-ink-secondary text-[11px] uppercase tracking-wider">
                <tr>
                  <th className="py-2 px-3 font-semibold">Changed by</th>
                  <th className="py-2 px-3 font-semibold text-right">Previous</th>
                  <th className="py-2 px-3 font-semibold text-right">New</th>
                  <th className="py-2 px-3 font-semibold text-right">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {history.data.map((h) => (
                  <tr key={h.id}>
                    <td className="py-2 px-3 text-ink">{h.changedByName ?? 'Unknown'}</td>
                    <td className="py-2 px-3 text-right font-mono tabular-nums text-ink-secondary">{h.previousPenalty ?? '—'}</td>
                    <td className="py-2 px-3 text-right font-mono tabular-nums text-ink">{h.newPenalty}</td>
                    <td className="py-2 px-3 text-right text-ink-muted whitespace-nowrap">{formatDateTime(h.changedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-[11px] text-ink-muted">
            <Gauge className="w-3.5 h-3.5 inline mr-1 -mt-0.5" />
            The penalty has not been changed yet; every score uses the default of −1 per missed check.
          </p>
        )}
      </div>
    </Section>
  )
}
