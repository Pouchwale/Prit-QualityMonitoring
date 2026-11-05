import React, { useMemo, useState } from 'react'
import { AlarmClock, BarChart3, ChevronLeft, ChevronRight, Download, Tag, Users, Wallet } from 'lucide-react'
import type { LeaveReportData } from '../../../types'
import { useApi } from '../../../lib/useApi'
import { useAuth } from '../../../lib/auth'
import { dateKey, downloadCsv } from '../../../lib/format'
import { Button } from '../../../components/common/Button'
import { DataState } from '../../../components/common/DataState'
import { PageHeader } from '../../../components/common/PageHeader'
import { Card, EmptyState } from '../../../components/ui/Card'
import { StatCard } from '../../../components/ui/StatCard'
import { IconButton, ResultCount, SearchInput, Toolbar, ToolbarSpacer } from '../../../components/ui/Toolbar'
import { TimeRequestReport } from './TimeRequestReport'

const num = (n: number | null) => (n === null ? '∞' : Number.isInteger(n) ? String(n) : n.toFixed(1))

const Tab: React.FC<{ active: boolean; onClick: () => void; icon: React.ReactNode; children: React.ReactNode }> = ({ active, onClick, icon, children }) => (
  <button
    type="button"
    role="tab"
    aria-selected={active}
    onClick={onClick}
    className={`relative inline-flex items-center gap-1.5 h-10 lg:h-9 px-3 text-[14.5px] font-medium whitespace-nowrap transition-colors ${active ? 'text-accent-strong' : 'text-ink-muted hover:text-ink'}`}
  >
    <span aria-hidden>{icon}</span>
    {children}
    {active && <span className="absolute left-2 right-2 -bottom-px h-[2px] rounded-full bg-accent" aria-hidden />}
  </button>
)

/**
 * Leave Reports: every worker's leave balance per type for a leave year (allocated, used, pending,
 * remaining), and every Late Entry / Early Exit request with a PDF download.
 */
export const LeaveReportsPage: React.FC = () => {
  const { can } = useAuth()
  const [tab, setTab] = useState<'balances' | 'time'>(() => (new URLSearchParams(window.location.search).get('tab') === 'time' ? 'time' : 'balances'))
  const [yearOffset, setYearOffset] = useState(0)
  const at = useMemo(() => {
    const d = new Date()
    d.setFullYear(d.getFullYear() + yearOffset)
    return dateKey(d)
  }, [yearOffset])
  const { data, error, loading, reload } = useApi<LeaveReportData>('/api/leave/report', { at })
  const [q, setQ] = useState('')

  const types = useMemo(() => {
    const seen = new Map<string, { id: string; name: string; code: string }>()
    for (const r of data?.rows ?? []) for (const b of r.balances) if (!seen.has(b.leaveTypeId)) seen.set(b.leaveTypeId, { id: b.leaveTypeId, name: b.name, code: b.code })
    return [...seen.values()]
  }, [data])
  const rows = useMemo(() => {
    const term = q.trim().toLowerCase()
    return (data?.rows ?? []).filter((r) => !term || [r.name, r.employeeId, r.department, r.designation].some((v) => v?.toLowerCase().includes(term)))
  }, [data, q])
  const totals = useMemo(
    () =>
      types.map((t) => {
        let used = 0
        let pending = 0
        for (const r of rows) {
          const b = r.balances.find((x) => x.leaveTypeId === t.id)
          used += b?.used ?? 0
          pending += b?.pending ?? 0
        }
        return { ...t, used, pending }
      }),
    [types, rows]
  )

  const exportCsv = () => {
    const headers = ['Employee ID', 'Employee', 'Designation', 'Department', ...types.flatMap((t) => [`${t.code} allocated`, `${t.code} used`, `${t.code} pending`, `${t.code} remaining`])]
    downloadCsv(
      `leave-balances_${data?.year.label.replace(/[^\w-]+/g, '-') ?? at}.csv`,
      headers,
      rows.map((r) => [
        r.employeeId,
        r.name,
        r.designation,
        r.department,
        ...types.flatMap((t) => {
          const b = r.balances.find((x) => x.leaveTypeId === t.id)
          return b ? [b.allocated ?? 'No limit', b.used, b.pending, b.remaining ?? 'No limit'] : ['', '', '', '']
        })
      ])
    )
  }

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<BarChart3 className="w-4.5 h-4.5" />}
        title="Leave Reports"
        description={tab === 'time' ? 'Late Entry and Early Exit records' : data ? `Leave year ${data.year.label}` : 'Leave balances'}
        info={
          tab === 'time'
            ? 'Every Late Entry and Early Exit request in the chosen dates, whatever its status. Late by = arrival time less the shift start; early by = shift end less the leaving time. Download the PDF for the full report.'
            : 'Allocated = the yearly quota plus days carried forward. Used = approved leave in this leave year; Pending = requests waiting for a decision. Set quotas and the leave year in Leave Settings.'
        }
        tabs={
          <div role="tablist" aria-label="Leave report views" className="scroll-hint flex items-center gap-1 border-b border-line max-w-full overflow-x-auto -mb-px">
            <Tab active={tab === 'balances'} onClick={() => setTab('balances')} icon={<Wallet className="w-3.5 h-3.5" />}>
              Leave Balances
            </Tab>
            <Tab active={tab === 'time'} onClick={() => setTab('time')} icon={<AlarmClock className="w-3.5 h-3.5" />}>
              Late Entry &amp; Early Exit
            </Tab>
          </div>
        }
        actions={
          tab === 'balances' && can('leave', 'export') ? (
            <Button size="sm" variant="outline" icon={<Download className="w-3.5 h-3.5" />} onClick={exportCsv} disabled={!rows.length}>
              Export CSV
            </Button>
          ) : undefined
        }
      />

      {tab === 'time' ? (
        <TimeRequestReport canExport={can('leave', 'export')} />
      ) : (
        <>
      {totals.length > 0 && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {totals.map((t) => (
            <StatCard key={t.id} label={`${t.name} used`} value={num(t.used)} icon={t.code.length <= 3 ? <span className="text-[11.5px] font-bold">{t.code}</span> : <Tag className="w-4 h-4" />} tone="accent" meta={t.pending ? `${num(t.pending)} pending` : 'none pending'} />
          ))}
        </div>
      )}

      <Card className="overflow-hidden">
        <Toolbar>
          <div className="flex items-center gap-1">
            <IconButton label="Previous leave year" size="md" onClick={() => setYearOffset((n) => n - 1)}>
              <ChevronLeft className="w-4 h-4" />
            </IconButton>
            <div className="min-w-[120px] text-center text-[15px] font-semibold text-ink">{data?.year.label ?? '…'}</div>
            <IconButton label="Next leave year" size="md" onClick={() => setYearOffset((n) => n + 1)} disabled={yearOffset >= 1}>
              <ChevronRight className="w-4 h-4" />
            </IconButton>
          </div>
          <SearchInput value={q} onChange={setQ} label="Search workers" placeholder="Worker, ID or department…" />
          <ToolbarSpacer />
          <ResultCount shown={rows.length} total={data?.rows.length} noun="workers" />
        </Toolbar>
        <DataState loading={loading && !data} error={error} onRetry={reload} flush>
          {rows.length === 0 ? (
            <EmptyState icon={<Users className="w-5 h-5" />} title="No workers match" />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table stack-sm">
                <thead>
                  <tr>
                    <th>Employee</th>
                    {types.map((t) => (
                      <th key={t.id} className="num" title={t.name}>
                        {t.code}{' '}
                        <span className="block text-[11.5px] font-normal normal-case text-ink-muted">used / allocated</span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.workerId}>
                      <td>
                        <div className="font-semibold text-ink">{r.name}</div>
                        <div className="text-[13px] text-ink-muted">
                          {r.employeeId}
                          {r.department ? ` · ${r.department}` : ''}
                        </div>
                      </td>
                      {types.map((t) => {
                        const b = r.balances.find((x) => x.leaveTypeId === t.id)
                        return (
                          <td key={t.id} className="num whitespace-nowrap" data-label={t.name}>
                            {b ? (
                              <>
                                <span className="font-semibold text-ink">{num(b.used)}</span>
                                <span className="text-ink-muted"> / {num(b.allocated)}</span>
                                <div className="text-[12.5px] text-ink-muted">
                                  {b.remaining === null ? 'no limit' : `${num(b.remaining)} left`}
                                  {b.pending ? ` · ${num(b.pending)} pending` : ''}
                                </div>
                              </>
                            ) : (
                              '—'
                            )}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </DataState>
      </Card>
        </>
      )}
    </div>
  )
}
