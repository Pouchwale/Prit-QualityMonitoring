import React, { useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, ExternalLink, Eye, Inbox, RefreshCw, Wrench } from 'lucide-react'
import type { ExceptionRecord, ExceptionStatus } from '../../types'
import { useApi } from '../../lib/useApi'
import { addDaysKey, dateKey, formatDateTime } from '../../lib/format'
import { PageHeader } from '../../components/common/PageHeader'
import { DataState } from '../../components/common/DataState'
import { StatusBadge } from '../../components/common/StatusBadge'
import { EvidenceViewer } from '../../components/common/EvidenceViewer'
import { FilterBar, type MonitoringFilters } from '../../components/common/FilterBar'
import { Card, EmptyState } from '../../components/ui/Card'
import { StatCard } from '../../components/ui/StatCard'
import { IconButton, ResultCount, Segmented, Toolbar, ToolbarSpacer } from '../../components/ui/Toolbar'
import { Pagination, usePagination } from '../../components/ui/Pagination'

/** Five KPI tiles with no empty cell: 2 + 2 + 1 (wide) on phones, 3 + 2 on tablets, one row on desktop. */
const KPI_GRID =
  'grid grid-cols-2 md:grid-cols-6 xl:grid-cols-5 gap-3 [&>*:last-child]:col-span-2 md:[&>*]:col-span-2 md:[&>*:nth-child(n+4)]:col-span-3 xl:[&>*]:col-span-1 xl:[&>*:nth-child(n+4)]:col-span-1'

const EXCEPTION_STATUSES: { value: ExceptionStatus; label: string }[] = [
  { value: 'UNDER_REVIEW', label: 'Under review' },
  { value: 'ACKNOWLEDGED', label: 'Acknowledged' },
  { value: 'ACTION_TAKEN', label: 'Action taken' },
  { value: 'RESOLVED', label: 'Resolved' }
]

const defaultFilters = (): MonitoringFilters => {
  const today = dateKey()
  return { from: addDaysKey(today, -6), to: today, shiftId: '', machineId: '', workerId: '', activityId: '', departmentId: '', status: '' }
}

export const ExceptionsPage: React.FC<{ onViewCheck: (id: string) => void }> = ({ onViewCheck }) => {
  const [filters, setFilters] = useState<MonitoringFilters>(defaultFilters)

  const { data, error, loading, reload } = useApi<ExceptionRecord[]>('/api/exceptions', { from: filters.from, to: filters.to })

  const all = useMemo(() => data ?? [], [data])
  const rows = useMemo(() => (filters.status ? all.filter((e) => e.status === filters.status) : all), [all, filters.status])
  const countOf = (status: ExceptionStatus) => all.filter((e) => e.status === status).length
  const open = all.filter((e) => e.status !== 'RESOLVED').length
  const paging = usePagination(rows, 25, JSON.stringify(filters))

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<AlertTriangle className="w-4.5 h-4.5" />}
        title="Exceptions"
        description={
          data === null
            ? 'Checks workers could not perform'
            : `${all.length} in this period${open > 0 ? ` · ${open} not yet resolved` : all.length > 0 ? ' · all resolved' : ''}`
        }
        info="Checks that workers could not perform, with their reason, remark and photo. Open a row's check for the full record."
        actions={
          <IconButton label="Refresh" size="md" onClick={() => reload()} className="border border-line-strong bg-white">
            <RefreshCw className={`w-4 h-4 ${loading && data !== null ? 'animate-spin' : ''}`} />
          </IconButton>
        }
      />

      <FilterBar
        value={filters}
        onChange={setFilters}
        onReset={() => setFilters(defaultFilters())}
        fields={['status']}
        statusOptions={EXCEPTION_STATUSES}
      />

      {/* Review status counts for the period; the status tabs below filter by them. */}
      <div className={KPI_GRID}>
        <StatCard label="Total" value={all.length} icon={<Inbox className="w-4 h-4" />} meta="In this period" />
        <StatCard
          label="Under review"
          value={countOf('UNDER_REVIEW')}
          icon={<AlertTriangle className="w-4 h-4" />}
          tone={countOf('UNDER_REVIEW') > 0 ? 'exception' : 'neutral'}
          meta={countOf('UNDER_REVIEW') > 0 ? 'Waiting for review' : 'None waiting'}
        />
        <StatCard label="Acknowledged" value={countOf('ACKNOWLEDGED')} icon={<Eye className="w-4 h-4" />} tone="accent" meta="Seen by a manager" />
        <StatCard label="Action taken" value={countOf('ACTION_TAKEN')} icon={<Wrench className="w-4 h-4" />} tone="due" meta="Fix in progress" />
        <StatCard label="Resolved" value={countOf('RESOLVED')} icon={<CheckCircle2 className="w-4 h-4" />} tone="success" meta={open > 0 ? `${open} still open` : 'Nothing open'} />
      </div>

      <DataState loading={loading} error={error} onRetry={reload} empty={data === null ? undefined : false}>
        <Card className="overflow-hidden">
          <Toolbar>
            <Segmented
              label="Filter by review status"
              value={filters.status as ExceptionStatus | ''}
              onChange={(status) => setFilters({ ...filters, status })}
              options={[{ value: '' as const, label: 'All', count: all.length }, ...EXCEPTION_STATUSES.map((s) => ({ ...s, count: countOf(s.value) }))]}
            />
            <ToolbarSpacer />
            <ResultCount shown={rows.length} total={all.length} noun="exceptions" />
          </Toolbar>

          {rows.length === 0 ? (
            <EmptyState
              icon={<CheckCircle2 className="w-5 h-5" />}
              title={all.length === 0 ? 'No exceptions in this period.' : 'No exceptions with this status.'}
              hint={all.length === 0 ? 'Checks workers could not perform show up here.' : undefined}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table stack-sm">
                <thead>
                  <tr>
                    <th>Raised</th>
                    <th>Machine</th>
                    <th>Worker</th>
                    <th>Reason</th>
                    <th>Status</th>
                    <th>Photo</th>
                    {/* Named by aria-label, not text: the phone card layout copies header text into each cell. */}
                    <th className="text-right" aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {paging.visible.map((e) => (
                    <tr key={e.id} className="align-top">
                      <td className="whitespace-nowrap tabular-nums">
                        <div className="font-medium text-ink">{formatDateTime(e.createdAt)}</div>
                        <div className="text-[11.5px] text-ink-muted">
                          Slot {formatDateTime(e.scheduledAt)} · <span className="font-mono">{e.checkCode}</span>
                        </div>
                      </td>
                      <td className="whitespace-nowrap">
                        <div className="font-semibold text-ink">{e.machineName}</div>
                        <div className="text-[11.5px] text-ink-muted">{[e.activityName, e.departmentName].filter(Boolean).join(' · ')}</div>
                      </td>
                      <td className="whitespace-nowrap">
                        <div className={e.workerName ? 'font-medium text-ink' : 'text-ink-muted italic'}>{e.workerName ?? 'Unknown'}</div>
                        {e.workerEmployeeId && <div className="text-[11px] text-ink-muted font-mono">{e.workerEmployeeId}</div>}
                      </td>
                      {/* Reason, the worker's remark and any resolution notes in one cell. */}
                      <td className="min-w-[200px] max-w-[340px]">
                        <div className="font-medium text-ink">{e.reason}</div>
                        {e.remark && (
                          <div className="text-[11.5px] text-ink-secondary line-clamp-2" title={e.remark}>
                            {e.remark}
                          </div>
                        )}
                        {e.resolutionNotes && (
                          <div className="mt-1 flex items-start gap-1 text-[11.5px] text-success line-clamp-2" title={e.resolutionNotes}>
                            <CheckCircle2 className="w-3 h-3 mt-0.5 shrink-0" aria-hidden />
                            <span>Resolution: {e.resolutionNotes}</span>
                          </div>
                        )}
                      </td>
                      <td className="whitespace-nowrap">
                        <StatusBadge status={e.status} size="sm" />
                        {e.reviewedByName && <div className="text-[11px] text-ink-muted mt-1">by {e.reviewedByName}</div>}
                      </td>
                      <td className="whitespace-nowrap">{e.media.length > 0 ? <EvidenceViewer media={e.media} compact /> : <span className="text-ink-faint">—</span>}</td>
                      <td className="text-right whitespace-nowrap" data-label="">
                        <IconButton label={`Open check ${e.checkCode}`} onClick={() => onViewCheck(e.checkId)}>
                          <ExternalLink className="w-4 h-4" />
                        </IconButton>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Pagination page={paging.page} pages={paging.pages} total={paging.total} pageSize={paging.pageSize} onPage={paging.setPage} noun="exceptions" />
        </Card>
      </DataState>
    </div>
  )
}
