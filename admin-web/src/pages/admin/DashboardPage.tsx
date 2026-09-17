import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowRight, CalendarOff, RefreshCw, Repeat } from 'lucide-react'
import type { DashboardData, QualityCheck } from '../../types'
import { useCanOpen, type NavTab } from '../../components/layout/Sidebar'
import { useApi } from '../../lib/useApi'
import { addDaysKey, dateKey, formatDate, formatTime } from '../../lib/format'
import { Button } from '../../components/common/Button'
import { PageHeader } from '../../components/common/PageHeader'
import { DataState } from '../../components/common/DataState'
import { CheckStatusBadge } from '../../components/common/StatusBadge'
import { inputClass } from '../../components/common/Form'
import { CLOSURE_TYPES } from '../../lib/closureTypes'
import { WorkerCoverageAlert } from '../../components/common/WorkerCoverageAlert'

const REFRESH_MS = 60_000
const REPEAT_WINDOW_DAYS = 7

interface DashboardPageProps {
  onViewCheck: (id: string) => void
  onNavigate: (tab: NavTab) => void
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

export const DashboardPage: React.FC<DashboardPageProps> = ({ onViewCheck, onNavigate }) => {
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
  const reloadDashboard = dashboard.reload
  const reloadMissed = missed.reload

  const refresh = useCallback(async () => {
    await Promise.all([reloadDashboard(), reloadMissed()])
    setUpdatedAt(new Date())
  }, [reloadDashboard, reloadMissed])

  useEffect(() => {
    const timer = setInterval(refresh, REFRESH_MS)
    return () => clearInterval(timer)
  }, [refresh])

  const missedChecks = useMemo(() => missed.data ?? [], [missed.data])
  const missedOnDay = useMemo(() => missedChecks.filter((c) => dateKey(new Date(c.scheduledAt)) === date), [missedChecks, date])
  const repeatByMachine = useMemo(
    () => groupMisses(missedChecks, date, (c) => ({ key: c.machineId, name: c.machineName, detail: c.machineCode })),
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
  const machines = useMemo(
    () => [...(data?.byMachine ?? [])].sort((a, b) => b.missed + b.exceptions - (a.missed + a.exceptions) || a.machineName.localeCompare(b.machineName)),
    [data]
  )

  return (
    <div className="space-y-4">
      <PageHeader
        title="Quality Monitoring"
        description={`${isToday ? "Today's" : formatDate(new Date(`${date}T00:00:00`))} monitoring status · auto-refreshes every minute · updated ${formatTime(updatedAt.toISOString())}`}
        actions={
          <>
            <input type="date" value={date} max={addDaysKey(dateKey(), 7)} onChange={(e) => {
                if (!e.target.value) return
                setDate(e.target.value)
                setUpdatedAt(new Date())
              }} className={`${inputClass} w-full sm:w-[160px] lg:w-[140px]`} />
            {!isToday && (
              <Button size="sm" variant="ghost" onClick={() => setDate(dateKey())}>
                Today
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => refresh()} loading={dashboard.loading && data !== null} icon={<RefreshCw className="w-3.5 h-3.5" />}>
              Refresh
            </Button>
            {canOpen('checks') && (
              <Button size="sm" variant="primary" onClick={() => onNavigate('checks')} iconRight={<ArrowRight className="w-3.5 h-3.5" />}>
                All checks
              </Button>
            )}
          </>
        }
      />

      {data && (
        <WorkerCoverageAlert
          gaps={data.workerGaps ?? []}
          action={
            canOpen('assignments') ? (
              <Button size="sm" variant="outline" onClick={() => onNavigate('assignments')} className="hidden sm:inline-flex">
                Machine Assignment
              </Button>
            ) : undefined
          }
        />
      )}

      {data?.closure && (
        <div className="flex items-center gap-3 px-4 py-3 rounded-lg border border-line bg-white shadow-2xs" role="status">
          <span className={`w-9 h-9 shrink-0 rounded-full flex items-center justify-center ${CLOSURE_TYPES[data.closure.type].chip}`} aria-hidden>
            {CLOSURE_TYPES[data.closure.type].icon}
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-ink">
              Plant closed {isToday ? 'today' : `on ${formatDate(new Date(`${date}T00:00:00`))}`} · {data.closure.label}
              {data.closure.reason ? ` · ${data.closure.reason}` : ''}
            </div>
            <div className="text-xs text-ink-muted">No quality checks are scheduled, no alerts are sent and nothing is marked Missed on this day.</div>
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
          <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-7 gap-3">
            <Kpi label="Scheduled" value={kpi.scheduled} hint="checks planned" />
            <Kpi label="Completed" value={kpi.completed} hint="checks submitted" tone="success" />
            <Kpi label="Missed" value={kpi.missed} hint="window closed" tone="missed" />
            <Kpi label="Exceptions" value={kpi.exceptions} hint="raised by workers" tone="exception" />
            <Kpi label="Open" value={kpi.open} hint="not finished yet" />
            <div className="bg-white border border-line-strong p-3 rounded-md shadow-2xs">
              <div className="text-xs text-ink-secondary">Completion rate</div>
              <div className="mt-1 text-2xl font-bold font-mono text-accent">{kpi.completionRate}%</div>
              <div className="w-full bg-line h-1.5 rounded-full mt-2 overflow-hidden">
                <div className="bg-accent h-full rounded-full" style={{ width: `${Math.min(100, kpi.completionRate)}%` }} />
              </div>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 xl:grid-cols-5 gap-4">
          {/* Machine-wise status */}
          <Panel
            className="xl:col-span-3"
            title="Machine-wise status"
            subtitle="Checks per machine for the selected day · click a row to open monitoring"
            action={
              canOpen('machines') && (
                <Button size="sm" variant="ghost" onClick={() => onNavigate('machines')}>
                  Machines
                </Button>
              )
            }
          >
            {machines.length === 0 ? (
              <Empty text="No checks are scheduled for this day." />
            ) : (
              <div className="overflow-x-auto">
                <table className="stack-sm w-full text-left text-xs border-collapse">
                  <thead className="bg-slate-50 border-b border-line text-ink-secondary text-[11px] uppercase tracking-wider">
                    <tr>
                      <th className="py-2 px-3 font-semibold">Machine</th>
                      <th className="py-2 px-3 font-semibold text-right">Total</th>
                      <th className="py-2 px-3 font-semibold text-right">Completed</th>
                      <th className="py-2 px-3 font-semibold text-right">Missed</th>
                      <th className="py-2 px-3 font-semibold text-right">Exceptions</th>
                      <th className="py-2 px-3 font-semibold text-right">Open</th>
                      <th className="py-2 px-3 font-semibold w-32">Done</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {machines.map((m) => {
                      const done = m.total ? Math.round((m.completed / m.total) * 100) : 0
                      return (
                        <tr key={m.machineId} className={canOpen('checks') ? 'hover:bg-slate-50 cursor-pointer' : ''} onClick={() => onNavigate('checks')}>
                          <td className="py-2 px-3 font-semibold text-ink whitespace-nowrap">
                            {m.machineName}
                            {repeatMachineIds.has(m.machineId) && (
                              <span className="ml-1.5 text-[11px] lg:text-[10px] font-medium px-1 py-px rounded border border-missed-line bg-missed-bg text-missed">repeat misses</span>
                            )}
                          </td>
                          <td className="py-2 px-3 text-right font-mono text-ink">{m.total}</td>
                          <td className="py-2 px-3 text-right font-mono text-success">{m.completed}</td>
                          <Num value={m.missed} tone="text-missed" />
                          <Num value={m.exceptions} tone="text-exception" />
                          <td className="py-2 px-3 text-right font-mono text-ink-secondary">{m.open}</td>
                          <td className="py-2 px-3">
                            <div className="flex items-center gap-2">
                              <div className="flex-1 min-w-[96px] lg:min-w-0 bg-line h-1.5 rounded-full overflow-hidden">
                                <div className="bg-success h-full" style={{ width: `${done}%` }} />
                              </div>
                              <span className="font-mono text-[11px] text-ink-muted w-8 text-right">{done}%</span>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          {/* Recent submissions */}
          <Panel
            className="xl:col-span-2"
            title="Recent submissions"
            subtitle="Latest checks submitted by workers"
            action={
              canOpen('checks') && (
                <Button size="sm" variant="ghost" onClick={() => onNavigate('checks')}>
                  View all
                </Button>
              )
            }
          >
            {(data?.recent ?? []).length === 0 ? (
              <Empty text="Nothing submitted yet for this day." />
            ) : (
              <ul className="divide-y divide-line">
                {data?.recent.map((c) => (
                  <li key={c.id}>
                    <button type="button" onClick={() => onViewCheck(c.id)} className="w-full text-left px-4 py-2 hover:bg-slate-50 flex items-center gap-3">
                      <div className="w-12 shrink-0 font-mono text-xs text-ink">{formatTime(c.submittedAt)}</div>
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-semibold text-ink truncate">
                          {c.machineName} <span className="font-normal text-ink-muted">· {c.activityName}</span>
                        </div>
                        <div className="text-[11px] text-ink-muted truncate">
                          {workerLabel(c)}
                          {c.jobNo ? ` · Job ${c.jobNo}` : ''} · <span className="font-mono">{c.code}</span>
                        </div>
                      </div>
                      <CheckStatusBadge status={c.status} size="sm" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </DataState>

      {/* Missed checks */}
      <div className="grid grid-cols-1 xl:grid-cols-5 gap-4">
        <Panel
          className="xl:col-span-3"
          title={`Missed checks · ${isToday ? 'today' : formatDate(new Date(`${date}T00:00:00`))}`}
          subtitle="Checks whose time window closed without a submission"
          action={<span className="text-xs font-mono font-semibold text-missed">{missedOnDay.length}</span>}
        >
          {missed.data === null ? (
            <Empty text={missed.error ?? 'Loading…'} />
          ) : missedOnDay.length === 0 ? (
            <Empty text="No missed checks for this day." />
          ) : (
            <div className="overflow-x-auto lg:max-h-80 lg:overflow-y-auto">
              <table className="stack-sm w-full text-left text-xs border-collapse">
                <thead className="bg-slate-50 border-b border-line text-ink-secondary text-[11px] uppercase tracking-wider sticky top-0">
                  <tr>
                    <th className="py-2 px-3 font-semibold">Scheduled</th>
                    <th className="py-2 px-3 font-semibold">Machine</th>
                    <th className="py-2 px-3 font-semibold">Check type</th>
                    <th className="py-2 px-3 font-semibold">Worker</th>
                    <th className="py-2 px-3 font-semibold">Shift</th>
                    <th className="py-2 px-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {missedOnDay.map((c) => (
                    <tr key={c.id} className="hover:bg-slate-50">
                      <td className="py-2 px-3 font-mono text-ink whitespace-nowrap">
                        {formatTime(c.scheduledAt)}–{formatTime(c.windowEndsAt)}
                      </td>
                      <td className="py-2 px-3 whitespace-nowrap">
                        <span className={repeatMachineIds.has(c.machineId) ? 'font-semibold text-missed' : 'font-medium text-ink'}>{c.machineName}</span>
                      </td>
                      <td className="py-2 px-3 text-ink-secondary whitespace-nowrap">{c.activityName}</td>
                      <td className="py-2 px-3 whitespace-nowrap">
                        <span className={repeatWorkerIds.has(c.submittedById ?? c.workerId ?? '—') ? 'font-semibold text-missed' : c.workerName ? 'text-ink' : 'text-ink-faint italic'}>
                          {c.submittedByName ?? c.workerName ?? '—'}
                        </span>
                      </td>
                      <td className="py-2 px-3 text-ink-secondary whitespace-nowrap">{c.shiftName ?? '—'}</td>
                      <td className="py-2 px-3 text-right">
                        <Button size="sm" variant="ghost" onClick={() => onViewCheck(c.id)}>
                          View
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel
          className="xl:col-span-2"
          title="Repeated misses"
          subtitle={`Machines and workers with 2 or more missed checks in the ${REPEAT_WINDOW_DAYS} days to ${formatDate(new Date(`${date}T00:00:00`))}`}
          action={<Repeat className="w-4 h-4 text-missed" />}
        >
          {missed.data === null ? (
            <Empty text={missed.error ? 'Could not load missed checks.' : 'Loading…'} />
          ) : repeatByMachine.length === 0 && repeatByWorker.length === 0 ? (
            <Empty text="No repeated misses in this period." />
          ) : (
            <div className="divide-y divide-line">
              <RepeatList title="By machine" rows={repeatByMachine} />
              <RepeatList title="By worker" rows={repeatByWorker} />
            </div>
          )}
        </Panel>
      </div>
    </div>
  )
}

const KPI_TONE = {
  neutral: { box: 'border-line', label: 'text-ink-secondary', value: 'text-ink' },
  success: { box: 'border-success-line', label: 'text-success', value: 'text-success' },
  failed: { box: 'border-failed-line', label: 'text-failed', value: 'text-failed' },
  due: { box: 'border-due-line', label: 'text-due', value: 'text-due' },
  missed: { box: 'border-missed-line', label: 'text-missed', value: 'text-missed' },
  exception: { box: 'border-exception-line', label: 'text-exception', value: 'text-exception' }
}

const Kpi: React.FC<{ label: string; value: number; hint: string; tone?: keyof typeof KPI_TONE }> = ({ label, value, hint, tone = 'neutral' }) => {
  const t = KPI_TONE[tone]
  return (
    <div className={`bg-white border ${t.box} p-3 rounded-md shadow-2xs`}>
      <div className={`text-xs font-medium ${t.label}`}>{label}</div>
      <div className={`mt-1 text-2xl font-bold font-mono ${t.value}`}>{value}</div>
      <div className="text-[11px] text-ink-muted mt-0.5">{hint}</div>
    </div>
  )
}

const Panel: React.FC<{ title: string; subtitle?: string; action?: React.ReactNode; className?: string; children: React.ReactNode }> = ({
  title,
  subtitle,
  action,
  className = '',
  children
}) => (
  <section className={`bg-white border border-line rounded-md shadow-2xs overflow-hidden flex flex-col ${className}`}>
    <div className="px-4 py-2.5 border-b border-line bg-slate-50 flex items-center justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-sm font-bold text-ink tracking-tight">{title}</h2>
        {subtitle && <p className="text-[11px] text-ink-muted truncate">{subtitle}</p>}
      </div>
      {action}
    </div>
    <div className="flex-1">{children}</div>
  </section>
)

const Empty: React.FC<{ text: string }> = ({ text }) => <div className="px-4 py-8 text-center text-xs text-ink-muted">{text}</div>

const Num: React.FC<{ value: number; tone: string }> = ({ value, tone }) => (
  <td className={`py-2 px-3 text-right font-mono ${value > 0 ? `${tone} font-semibold` : 'text-ink-faint'}`}>{value}</td>
)

const RepeatList: React.FC<{ title: string; rows: RepeatRow[] }> = ({ title, rows }) => (
  <div className="px-4 py-3">
    <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-secondary mb-1.5">{title}</div>
    {rows.length === 0 ? (
      <div className="text-xs text-ink-faint">None</div>
    ) : (
      <ul className="space-y-1">
        {rows.slice(0, 6).map((r) => (
          <li key={r.key} className="flex items-center gap-2 text-xs">
            <span className="flex-1 min-w-0 truncate">
              <span className="font-medium text-ink">{r.name}</span>
              {r.detail && <span className="text-ink-muted"> · {r.detail}</span>}
            </span>
            {r.onDay > 0 && <span className="text-[11px] text-ink-muted">{r.onDay} on day</span>}
            <span className={`font-mono font-semibold px-1.5 rounded border ${r.total >= 3 ? 'bg-missed text-white border-missed' : 'bg-missed-bg text-missed border-missed-line'}`}>{r.total}×</span>
          </li>
        ))}
      </ul>
    )}
  </div>
)
