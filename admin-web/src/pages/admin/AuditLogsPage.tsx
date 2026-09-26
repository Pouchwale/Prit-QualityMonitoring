import React, { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, RefreshCw, Search } from 'lucide-react'
import type { AuditLog } from '../../types'
import { api, type Page } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { addDaysKey, dateKey, formatDateTime } from '../../lib/format'
import { Button } from '../../components/common/Button'
import { PageHeader } from '../../components/common/PageHeader'
import { DataState } from '../../components/common/DataState'
import { inputClass } from '../../components/common/Form'
import { DateInput } from '../../components/common/DateTimeInputs'

const ENTITIES = ['User', 'Parameter', 'Activity', 'Machine', 'Schedule', 'Shift', 'Department', 'PlantCalendar', 'QualityCheck', 'Exception', 'Settings']
const PER_PAGE = [25, 50, 100, 200]

/** The server pages the log, so only one page of entries is ever loaded. */
const loadPage = (path: string, query?: Record<string, string | number | boolean | null | undefined>) => api.getPage<AuditLog>(path, query)

export const AuditLogsPage: React.FC = () => {
  const [search, setSearch] = useState('')
  const [q, setQ] = useState('')
  const [entity, setEntity] = useState('')
  const [from, setFrom] = useState(() => addDaysKey(dateKey(), -29))
  const [to, setTo] = useState(dateKey)
  const [perPage, setPerPage] = useState(25)
  const [page, setPage] = useState(1)

  useEffect(() => {
    const timer = setTimeout(() => {
      setQ(search.trim())
      setPage(1)
    }, 350)
    return () => clearTimeout(timer)
  }, [search])

  const { data, error, loading, reload } = useApi<Page<AuditLog>>('/api/audit-logs', { q, entity, from, to, limit: perPage, offset: (page - 1) * perPage }, loadPage)
  const logs = data?.rows ?? []
  const total = data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / perPage))
  const firstOnPage = total === 0 ? 0 : (page - 1) * perPage + 1
  const lastOnPage = (page - 1) * perPage + logs.length

  // Every filter returns to the first page itself; this only catches a page that no longer
  // exists, e.g. when entries are removed while the page is open.
  useEffect(() => {
    if (data && page > totalPages) setPage(totalPages)
  }, [data, page, totalPages])

  const reset = () => {
    setSearch('')
    setQ('')
    setEntity('')
    setFrom(addDaysKey(dateKey(), -29))
    setTo(dateKey())
    setPerPage(25)
    setPage(1)
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Audit Logs"
        description="Who changed what and when — configuration edits, check submissions and exception reviews"
        actions={
          <Button size="sm" variant="outline" onClick={() => reload()} loading={loading && data !== null} icon={<RefreshCw className="w-3.5 h-3.5" />}>
            Refresh
          </Button>
        }
      />

      <div className="bg-white border border-line rounded-md p-3 shadow-2xs grid grid-cols-2 sm:flex sm:flex-wrap items-end gap-2.5 text-xs">
        <div className="col-span-2 sm:flex-1 sm:min-w-[220px] sm:max-w-sm">
          <div className="text-[11px] font-semibold text-ink-secondary mb-1">Search</div>
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 lg:top-2.5 lg:translate-y-0 text-ink-faint pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Action, user, entity or ID…"
              className={`${inputClass} pl-8`}
            />
          </div>
        </div>
        <div className="min-w-0">
          <div className="text-[11px] font-semibold text-ink-secondary mb-1">Entity</div>
          <select
            value={entity}
            onChange={(e) => {
              setEntity(e.target.value)
              setPage(1)
            }}
            className={`${inputClass} px-2 sm:w-auto`}
          >
            <option value="">All entities</option>
            {ENTITIES.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
        </div>
        <div className="min-w-0">
          <div className="text-[11px] font-semibold text-ink-secondary mb-1">From</div>
          <DateInput
            value={from}
            max={to}
            onChange={(e) => {
              const v = e.target.value
              setFrom(v)
              if (v && to && v > to) setTo(v)
              setPage(1)
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
              setPage(1)
            }}
            className="sm:w-[160px] lg:w-[132px]"
          />
        </div>
        <div className="min-w-0">
          <div className="text-[11px] font-semibold text-ink-secondary mb-1">Rows per page</div>
          <select
            aria-label="Rows per page"
            value={perPage}
            onChange={(e) => {
              setPerPage(Number(e.target.value))
              setPage(1)
            }}
            className={`${inputClass} px-2 sm:w-auto`}
          >
            {PER_PAGE.map((l) => (
              <option key={l} value={l}>
                {l} rows
              </option>
            ))}
          </select>
        </div>
        <Button size="field" variant="ghost" onClick={reset}>
          Reset
        </Button>
        <span className="col-span-2 sm:ml-auto self-center text-[11px] text-ink-muted">
          {total} entr{total === 1 ? 'y' : 'ies'}
        </span>
      </div>

      <DataState loading={loading} error={error} onRetry={reload} empty={data === null ? undefined : logs.length === 0} emptyText="No audit entries match these filters.">
        <div className="bg-white border border-line rounded-md shadow-2xs overflow-hidden">
          <div className="overflow-x-auto">
            <table className="stack-sm w-full text-left text-xs border-collapse">
              <thead className="bg-slate-50 border-b border-line text-ink-secondary text-[11px] uppercase tracking-wider">
                <tr>
                  <th className="py-2.5 px-3 font-semibold">Time</th>
                  <th className="py-2.5 px-3 font-semibold">User</th>
                  <th className="py-2.5 px-3 font-semibold">Role</th>
                  <th className="py-2.5 px-3 font-semibold">Action</th>
                  <th className="py-2.5 px-3 font-semibold">Entity</th>
                  <th className="py-2.5 px-3 font-semibold">Entity ID</th>
                  <th className="py-2.5 px-3 font-semibold text-right">IP address</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {logs.map((log) => (
                  <tr key={log.id} className="hover:bg-slate-50">
                    <td className="py-2 px-3 font-mono text-ink whitespace-nowrap">{formatDateTime(log.createdAt)}</td>
                    <td className="py-2 px-3 font-medium text-ink whitespace-nowrap">{log.userName ?? <span className="text-ink-faint italic">System</span>}</td>
                    <td className="py-2 px-3 text-ink-secondary whitespace-nowrap">{log.role ?? '—'}</td>
                    <td className="py-2 px-3 whitespace-nowrap">
                      <span className="px-1.5 py-0.5 rounded bg-blue-50 text-accent border border-blue-200 font-mono text-[11px]">{log.action}</span>
                    </td>
                    <td className="py-2 px-3 text-ink whitespace-nowrap">{log.entity}</td>
                    <td className="py-2 px-3 font-mono text-[11px] text-ink-muted max-w-[220px] truncate" title={log.entityId ?? undefined}>
                      {log.entityId ?? '—'}
                    </td>
                    <td className="py-2 px-3 font-mono text-ink-muted text-right whitespace-nowrap">{log.ipAddress ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <nav
            aria-label="Audit log pages"
            className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 px-3 py-2.5 border-t border-line bg-slate-50 text-[11px] text-ink-muted"
          >
            <span>
              Showing {firstOnPage}–{lastOnPage} of {total}
            </span>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" disabled={page <= 1 || loading} onClick={() => setPage((p) => Math.max(1, p - 1))} icon={<ChevronLeft className="w-3.5 h-3.5" />}>
                Previous
              </Button>
              <span className="font-medium text-ink-secondary whitespace-nowrap" aria-live="polite">
                Page {page} of {totalPages}
              </span>
              <Button size="sm" variant="outline" disabled={page >= totalPages || loading} onClick={() => setPage((p) => Math.min(totalPages, p + 1))} iconRight={<ChevronRight className="w-3.5 h-3.5" />}>
                Next
              </Button>
            </div>
          </nav>
        </div>
      </DataState>
    </div>
  )
}
