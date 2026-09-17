import React, { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, RefreshCw, Search } from 'lucide-react'
import type { AuditLog } from '../../types'
import { useApi } from '../../lib/useApi'
import { addDaysKey, dateKey, formatDateTime } from '../../lib/format'
import { Button } from '../../components/common/Button'
import { PageHeader } from '../../components/common/PageHeader'
import { DataState } from '../../components/common/DataState'
import { inputClass } from '../../components/common/Form'

const ENTITIES = ['User', 'Parameter', 'Activity', 'Machine', 'Schedule', 'Shift', 'Department', 'PlantCalendar', 'QualityCheck', 'Exception', 'Settings']
const LIMITS = [100, 300, 500, 1000]

const pretty = (value: unknown) => (value === null || value === undefined ? null : JSON.stringify(value, null, 2))

export const AuditLogsPage: React.FC = () => {
  const [search, setSearch] = useState('')
  const [q, setQ] = useState('')
  const [entity, setEntity] = useState('')
  const [from, setFrom] = useState(() => addDaysKey(dateKey(), -29))
  const [to, setTo] = useState(dateKey)
  const [limit, setLimit] = useState(300)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    const timer = setTimeout(() => setQ(search.trim()), 350)
    return () => clearTimeout(timer)
  }, [search])

  const { data, error, loading, reload } = useApi<AuditLog[]>('/api/audit-logs', { q, entity, from, to, limit })
  const logs = data ?? []

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const reset = () => {
    setSearch('')
    setQ('')
    setEntity('')
    setFrom(addDaysKey(dateKey(), -29))
    setTo(dateKey())
    setLimit(300)
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
          <select value={entity} onChange={(e) => setEntity(e.target.value)} className={`${inputClass} px-2 sm:w-auto`}>
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
          <input
            type="date"
            value={from}
            max={to}
            onChange={(e) => {
              const v = e.target.value
              setFrom(v)
              if (v && to && v > to) setTo(v)
            }}
            className={`${inputClass} sm:w-[160px] lg:w-[132px]`}
          />
        </div>
        <div className="min-w-0">
          <div className="text-[11px] font-semibold text-ink-secondary mb-1">To</div>
          <input
            type="date"
            value={to}
            min={from}
            onChange={(e) => {
              const v = e.target.value
              setTo(v)
              if (v && from && v < from) setFrom(v)
            }}
            className={`${inputClass} sm:w-[160px] lg:w-[132px]`}
          />
        </div>
        <div className="min-w-0">
          <div className="text-[11px] font-semibold text-ink-secondary mb-1">Show</div>
          <select value={limit} onChange={(e) => setLimit(Number(e.target.value))} className={`${inputClass} px-2 sm:w-auto`}>
            {LIMITS.map((l) => (
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
          {logs.length} entr{logs.length === 1 ? 'y' : 'ies'}
          {logs.length >= limit ? ' (limit reached)' : ''}
        </span>
      </div>

      <DataState loading={loading} error={error} onRetry={reload} empty={data === null ? undefined : logs.length === 0} emptyText="No audit entries match these filters.">
        <div className="bg-white border border-line rounded-md shadow-2xs overflow-hidden">
          <div className="overflow-x-auto">
            <table className="stack-sm w-full text-left text-xs border-collapse">
              <thead className="bg-slate-50 border-b border-line text-ink-secondary text-[11px] uppercase tracking-wider">
                <tr>
                  <th className="py-2.5 pl-3 w-6" />
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
                {logs.map((log) => {
                  const isOpen = expanded.has(log.id)
                  const oldText = pretty(log.oldValue)
                  const newText = pretty(log.newValue)
                  const hasDetail = oldText !== null || newText !== null
                  return (
                    <React.Fragment key={log.id}>
                      <tr
                        className={`${hasDetail ? 'cursor-pointer' : ''} ${isOpen ? 'bg-slate-50' : 'hover:bg-slate-50'}`}
                        onClick={() => hasDetail && toggle(log.id)}
                      >
                        <td className="py-2 pl-3 text-ink-muted">
                          {hasDetail && (isOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />)}
                        </td>
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
                      {isOpen && (
                        <tr className="bg-slate-50">
                          <td />
                          <td colSpan={7} className="pb-3 pr-3">
                            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                              <JsonBlock title="Old value" text={oldText} tone="border-missed-line" />
                              <JsonBlock title="New value" text={newText} tone="border-success-line" />
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      </DataState>
    </div>
  )
}

const JsonBlock: React.FC<{ title: string; text: string | null; tone: string }> = ({ title, text, tone }) => (
  <div className={`bg-white border ${tone} rounded min-w-0`}>
    <div className="px-2.5 py-1 border-b border-line text-[11px] font-semibold text-ink-secondary">{title}</div>
    {text === null ? (
      <div className="px-2.5 py-2 text-[11px] text-ink-faint">—</div>
    ) : (
      <pre className="px-2.5 py-2 text-[11px] leading-snug font-mono text-ink whitespace-pre-wrap break-all max-h-72 overflow-auto">{text}</pre>
    )}
  </div>
)
