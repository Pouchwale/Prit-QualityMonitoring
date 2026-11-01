import React, { useMemo, useState } from 'react'
import { Coffee } from 'lucide-react'
import { useApi } from '../../lib/useApi'
import { formatClockRange } from '../../lib/format'
import { DataState } from '../../components/common/DataState'
import { Card, CardHeader, EmptyState } from '../../components/ui/Card'
import { ResultCount, SearchInput, Toolbar, ToolbarSpacer } from '../../components/ui/Toolbar'
import { Pagination, usePagination } from '../../components/ui/Pagination'
import { CodeChip, UserAvatar } from '../../components/ui/Chips'

/*
 * Shifts page: each worker's daily break, as it comes from their shift (backend services/workerBreaks.ts).
 * Read only: a break is set on the shift, and a worker moved to another shift takes that shift's break.
 */

interface WorkerBreakRow {
  workerId: string
  name: string
  employeeId: string
  shiftId: string | null
  shiftName: string | null
  startTime: string | null
  endTime: string | null
  durationMinutes: number | null
}

const durationText = (minutes: number) => (minutes >= 60 ? `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''}` : `${minutes} min`)

export const WorkerBreaksCard: React.FC = () => {
  const { data, error, loading, reload } = useApi<WorkerBreakRow[]>('/api/shifts/breaks')
  const [search, setSearch] = useState('')

  const rows = useMemo(() => data ?? [], [data])
  const withBreak = rows.filter((r) => r.startTime).length
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return rows.filter((r) => !q || r.name.toLowerCase().includes(q) || r.employeeId.toLowerCase().includes(q) || (r.shiftName ?? '').toLowerCase().includes(q))
  }, [rows, search])
  const paging = usePagination(filtered, 25, search)

  return (
    <Card className="overflow-hidden">
      <CardHeader
        icon={<Coffee className="w-4 h-4" />}
        title="Worker break times"
        subtitle={`From each worker's shift${rows.length ? ` · ${withBreak} of ${rows.length} workers have a break` : ''}`}
        info="Every worker has the break of their shift (plant time, every day). To change a break, edit the shift above; to give a worker another break, move them to another shift on Workers & Users. During a break the worker gets no check notifications and no check is marked Missed: a check due then is due at the end of the break."
      />
      <DataState loading={loading && !data} error={error} onRetry={reload} empty={data ? false : undefined}>
        <Toolbar>
          <SearchInput value={search} onChange={setSearch} label="Search workers" placeholder="Search name, ID or shift…" className="w-full sm:w-56" />
          <ToolbarSpacer />
          <ResultCount shown={filtered.length} total={rows.length} noun={rows.length === 1 ? 'worker' : 'workers'} />
        </Toolbar>
        {filtered.length === 0 ? (
          <EmptyState icon={<Coffee className="w-5 h-5" />} title={rows.length === 0 ? 'No active workers' : 'No workers match the search'} />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table stack-sm">
              <thead>
                <tr>
                  <th>Worker</th>
                  <th>Shift</th>
                  <th>Break</th>
                  <th>Duration</th>
                </tr>
              </thead>
              <tbody>
                {paging.visible.map((r) => (
                  <tr key={r.workerId}>
                    <td>
                      <div className="flex items-center gap-2.5 min-w-0">
                        <UserAvatar name={r.name} muted={!r.startTime} />
                        <div className="min-w-0">
                          <div className="font-semibold text-ink truncate">{r.name}</div>
                          <CodeChip>{r.employeeId}</CodeChip>
                        </div>
                      </div>
                    </td>
                    <td className="whitespace-nowrap" data-label="Shift">
                      {r.shiftName ?? <span className="text-ink-muted">No shift</span>}
                    </td>
                    <td className="whitespace-nowrap tabular-nums" data-label="Break">
                      {r.startTime && r.endTime ? formatClockRange(r.startTime, r.endTime) : <span className="text-ink-muted">{r.shiftName ? 'Shift has no break' : 'No break'}</span>}
                    </td>
                    <td className="whitespace-nowrap tabular-nums" data-label="Duration">
                      {r.durationMinutes ? durationText(r.durationMinutes) : <span className="text-ink-muted">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination page={paging.page} pages={paging.pages} total={paging.total} pageSize={paging.pageSize} onPage={paging.setPage} noun="workers" />
      </DataState>
    </Card>
  )
}
