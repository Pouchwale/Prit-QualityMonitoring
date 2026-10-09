import React, { useEffect, useState } from 'react'
import { ChevronDown, ChevronLeft, ChevronRight, RefreshCw, RotateCcw, ScrollText } from 'lucide-react'
import type { AuditLog } from '../../types'
import { api, type Page } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { addDaysKey, dateKey, formatDate, formatDateKey, formatTime } from '../../lib/format'
import { Button } from '../../components/common/Button'
import { PageHeader } from '../../components/common/PageHeader'
import { DataState } from '../../components/common/DataState'
import { inputClass } from '../../components/common/Form'
import { DateInput } from '../../components/common/DateTimeInputs'
import { Card } from '../../components/ui/Card'
import { IconButton, ResultCount, SearchInput, Toolbar, ToolbarSpacer } from '../../components/ui/Toolbar'

/** Every entity name the backend writes to the audit log (the Entity filter). */
const ENTITIES = [
  'User',
  'Role',
  'Parameter',
  'Activity',
  'Machine',
  'MachineDayPlan',
  'Schedule',
  'Shift',
  'Department',
  'DepartmentMapping',
  'PlantCalendar',
  'Job',
  'QualityCheck',
  'Exception',
  'ExceptionReason',
  'MonitoringReason',
  'ModuleNotificationAssignments',
  'Report',
  'ReportSharing',
  'Settings'
]
const PER_PAGE = [25, 50, 100, 200]

/** The server pages the log, so only one page of entries is ever loaded. */
const loadPage = (path: string, query?: Record<string, string | number | boolean | null | undefined>) => api.getPage<AuditLog>(path, query)

/** "UPDATE_MACHINE" as "Update machine"; the stored code stays in the tooltip and the details. */
const actionLabel = (action: string) => {
  const words = action.toLowerCase().split('_').filter(Boolean)
  return words.length ? `${words[0][0].toUpperCase()}${words[0].slice(1)} ${words.slice(1).join(' ')}`.trim() : action
}

/** Pill colour by what the action did: added (green), removed or refused (red), changed (blue), anything else neutral. */
const actionTone = (action: string) => {
  if (/_DENIED$/.test(action) || /^(DELETE|REMOVE|DISABLE)/.test(action)) return 'bg-missed-bg text-missed ring-missed-line'
  if (/^(CREATE|ADD|APPROVE|CONFIRM|START)/.test(action)) return 'bg-success-bg text-success ring-success-line'
  if (/^(UPDATE|EDIT|CHANGE|REORDER)/.test(action)) return 'bg-accent-soft text-accent-strong ring-accent-line'
  return 'bg-subtle text-ink-secondary ring-line'
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const valueText = (v: unknown) => (v === undefined ? '—' : v === null ? 'null' : typeof v === 'string' ? v : JSON.stringify(v))

export const AuditLogsPage: React.FC = () => {
  const [search, setSearch] = useState('')
  const [q, setQ] = useState('')
  const [entity, setEntity] = useState('')
  const [from, setFrom] = useState(() => addDaysKey(dateKey(), -29))
  const [to, setTo] = useState(dateKey)
  const [perPage, setPerPage] = useState(25)
  const [page, setPage] = useState(1)
  const [open, setOpen] = useState<Set<string>>(() => new Set())

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

  const toggle = (id: string) =>
    setOpen((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  // Up to 5 page buttons around the current page, as in the shared Pagination.
  const start = Math.max(1, Math.min(page - 2, totalPages - 4))
  const numbers = Array.from({ length: Math.min(5, totalPages) }, (_, i) => start + i)
  const pageBtn = 'h-8 min-w-8 px-2 inline-flex items-center justify-center rounded-md text-[12.5px] font-medium tabular-nums transition-colors disabled:opacity-40 disabled:cursor-not-allowed'

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<ScrollText className="w-4.5 h-4.5" />}
        title="Audit Logs"
        description={
          <span className="inline-flex items-center gap-1.5 flex-wrap">
            <span className="font-medium text-ink-secondary">
              {from && to ? (from === to ? formatDateKey(from) : `${formatDateKey(from)} – ${formatDateKey(to)}`) : 'All dates'}
            </span>
            <span aria-hidden>·</span>
            {total.toLocaleString('en-IN')} {total === 1 ? 'entry' : 'entries'}
          </span>
        }
        info="Who changed what and when — configuration edits, check submissions and exception reviews. Open a row to see the entity ID, IP address and the values before and after the change."
        actions={
          <IconButton label="Refresh" size="md" onClick={() => reload()} className="border border-line-strong bg-white">
            <RefreshCw className={`w-4 h-4 ${loading && data !== null ? 'animate-spin' : ''}`} />
          </IconButton>
        }
      />

      <Card className="overflow-hidden">
        <Toolbar className="items-end sm:items-center">
          <SearchInput value={search} onChange={setSearch} label="Search audit log" placeholder="Action, user, entity or ID…" className="sm:w-60" />
          <select
            value={entity}
            aria-label="Filter by entity"
            onChange={(e) => {
              setEntity(e.target.value)
              setPage(1)
            }}
            className={`${inputClass} px-2 w-full sm:w-auto sm:max-w-[200px] ${entity ? 'border-accent bg-accent-soft/40' : ''}`}
          >
            <option value="">All entities</option>
            {ENTITIES.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
          <div className="grid grid-cols-2 sm:flex items-center gap-1.5 w-full sm:w-auto">
            <DateInput
              value={from}
              max={to}
              aria-label="From date"
              onChange={(e) => {
                const v = e.target.value
                setFrom(v)
                if (v && to && v > to) setTo(v)
                setPage(1)
              }}
              className="sm:w-[150px] lg:w-[128px]"
            />
            <DateInput
              value={to}
              min={from}
              aria-label="To date"
              onChange={(e) => {
                const v = e.target.value
                setTo(v)
                if (v && from && v < from) setFrom(v)
                setPage(1)
              }}
              className="sm:w-[150px] lg:w-[128px]"
            />
          </div>
          <Button size="field" variant="ghost" onClick={reset} icon={<RotateCcw className="w-3 h-3" />}>
            Reset
          </Button>
          <ToolbarSpacer />
          <ResultCount shown={total} noun={total === 1 ? 'entry' : 'entries'} />
        </Toolbar>

        {/* The loading / error / empty block sits flush inside this card instead of drawing a second card. */}
        <div className="[&>.card]:border-0 [&>.card]:shadow-none [&>.card]:rounded-none">
        <DataState loading={loading} error={error} onRetry={reload} empty={data === null ? undefined : logs.length === 0} emptyText="No audit entries match these filters.">
          <div className="overflow-x-auto">
            <table className="data-table stack-sm">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Action</th>
                  <th>Entity</th>
                  <th>User</th>
                  <th className="text-right">
                    <span className="sr-only">Details</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => {
                  const expanded = open.has(log.id)
                  return (
                    <React.Fragment key={log.id}>
                      <tr className="cursor-pointer" onClick={() => toggle(log.id)}>
                        <td className="whitespace-nowrap tabular-nums">
                          <div className="text-ink">{formatDate(log.createdAt)}</div>
                          <div className="text-[11.5px] text-ink-muted">{formatTime(log.createdAt, true)}</div>
                        </td>
                        <td className="whitespace-nowrap">
                          <span
                            className={`inline-flex items-center h-5 px-2 rounded-full text-[11.5px] font-medium ring-1 ring-inset ${actionTone(log.action)}`}
                            title={log.action}
                          >
                            {actionLabel(log.action)}
                          </span>
                        </td>
                        <td>
                          <div className="font-medium text-ink">{log.entity}</div>
                          {log.entityId && (
                            <div className="max-w-[200px] text-[11.5px] text-ink-muted font-mono truncate" title={log.entityId}>
                              {log.entityId}
                            </div>
                          )}
                        </td>
                        <td className="whitespace-nowrap">
                          <div className="font-medium text-ink">{log.userName ?? <span className="text-ink-muted italic">System</span>}</div>
                          {log.role && <div className="text-[11.5px] text-ink-muted">{log.role}</div>}
                        </td>
                        <td className="text-right" data-label="">
                          <IconButton
                            label={expanded ? 'Hide details' : 'Show details'}
                            aria-expanded={expanded}
                            onClick={(e) => {
                              e.stopPropagation()
                              toggle(log.id)
                            }}
                          >
                            <ChevronDown className={`w-4 h-4 transition-transform ${expanded ? 'rotate-180' : ''}`} />
                          </IconButton>
                        </td>
                      </tr>
                      {expanded && (
                        <tr>
                          <td colSpan={5} className="bg-subtle/60">
                            <AuditDetails log={log} />
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        </DataState>
        </div>

        <nav aria-label="Audit log pages" className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 border-t border-line">
          <div className="flex items-center gap-2 text-[12px] text-ink-muted">
            <select
              aria-label="Rows per page"
              value={perPage}
              onChange={(e) => {
                setPerPage(Number(e.target.value))
                setPage(1)
              }}
              className={`${inputClass} px-2 !w-[104px]`}
            >
              {PER_PAGE.map((l) => (
                <option key={l} value={l}>
                  {l} rows
                </option>
              ))}
            </select>
            <span className="tabular-nums whitespace-nowrap">
              {firstOnPage.toLocaleString('en-IN')}–{lastOnPage.toLocaleString('en-IN')} of {total.toLocaleString('en-IN')}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              className={`${pageBtn} text-ink-secondary hover:bg-subtle`}
              disabled={page <= 1 || loading}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              aria-label="Previous page"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            {numbers.map((n) => (
              <button
                key={n}
                type="button"
                className={`${pageBtn} ${n === page ? 'bg-accent-soft text-accent-strong ring-1 ring-accent-line' : 'text-ink-secondary hover:bg-subtle'}`}
                disabled={loading && n !== page}
                onClick={() => setPage(n)}
                aria-current={n === page ? 'page' : undefined}
                aria-label={`Page ${n}`}
              >
                {n}
              </button>
            ))}
            <button
              type="button"
              className={`${pageBtn} text-ink-secondary hover:bg-subtle`}
              disabled={page >= totalPages || loading}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              aria-label="Next page"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
            <span className="sr-only" aria-live="polite">
              Page {page} of {totalPages}
            </span>
          </div>
        </nav>
      </Card>
    </div>
  )
}

/** The expanded row: identifiers, then each field whose value changed (before → after), then the raw values. */
const AuditDetails: React.FC<{ log: AuditLog }> = ({ log }) => {
  const before = log.oldValue
  const after = log.newValue
  const fields =
    isRecord(before) || isRecord(after)
      ? [...new Set([...Object.keys(isRecord(before) ? before : {}), ...Object.keys(isRecord(after) ? after : {})])].filter(
          (k) => JSON.stringify(isRecord(before) ? before[k] : undefined) !== JSON.stringify(isRecord(after) ? after[k] : undefined)
        )
      : []
  const hasValues = (before !== null && before !== undefined) || (after !== null && after !== undefined)
  return (
    <div className="py-1 space-y-3 text-left">
      <dl className="flex flex-wrap gap-x-6 gap-y-1.5 text-[12px]">
        <Meta label="Action code" value={log.action} mono />
        <Meta label="Entity ID" value={log.entityId ?? '—'} mono />
        <Meta label="IP address" value={log.ipAddress ?? '—'} mono />
        {log.role && <Meta label="Role" value={log.role} />}
      </dl>
      {!hasValues ? (
        <p className="text-[12px] text-ink-muted">No values recorded for this entry.</p>
      ) : fields.length > 0 ? (
        // Divs, not a nested table: the phone layout of the log table restyles every cell inside it.
        <div className="rounded-md border border-line bg-white text-[12px] divide-y divide-line" role="list" aria-label="Changed fields">
          <div className="hidden sm:grid grid-cols-[minmax(120px,1fr)_2fr_2fr] gap-3 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-muted" aria-hidden>
            <span>Field</span>
            <span>Before</span>
            <span>After</span>
          </div>
          {fields.map((k) => (
            <div key={k} role="listitem" className="grid grid-cols-1 sm:grid-cols-[minmax(120px,1fr)_2fr_2fr] gap-x-3 gap-y-0.5 px-3 py-1.5">
              <span className="font-medium text-ink [overflow-wrap:anywhere]">{k}</span>
              <span className="font-mono text-ink-muted [overflow-wrap:anywhere]">
                <span className="sm:sr-only">Before: </span>
                {valueText(isRecord(before) ? before[k] : undefined)}
              </span>
              <span className="font-mono text-ink [overflow-wrap:anywhere]">
                <span className="sm:sr-only">After: </span>
                {valueText(isRecord(after) ? after[k] : undefined)}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-[12px] text-ink-muted">No field changed between the recorded values.</p>
      )}
      {hasValues && (
        <details className="text-[12px]">
          <summary className="cursor-pointer text-ink-secondary font-medium w-fit">Raw values</summary>
          <div className="mt-2 grid grid-cols-1 lg:grid-cols-2 gap-2">
            <RawValue label="Before" value={before} />
            <RawValue label="After" value={after} />
          </div>
        </details>
      )}
    </div>
  )
}

const Meta: React.FC<{ label: string; value: string; mono?: boolean }> = ({ label, value, mono }) => (
  <div className="min-w-0">
    <dt className="text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-muted">{label}</dt>
    <dd className={`text-ink [overflow-wrap:anywhere] ${mono ? 'font-mono text-[11.5px]' : ''}`}>{value}</dd>
  </div>
)

const RawValue: React.FC<{ label: string; value: unknown }> = ({ label, value }) => (
  <div className="min-w-0">
    <div className="text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-muted mb-1">{label}</div>
    <pre className="max-h-64 overflow-auto rounded-md border border-line bg-white p-2.5 font-mono text-[11.5px] text-ink whitespace-pre-wrap [overflow-wrap:anywhere]">
      {value === null || value === undefined ? '—' : JSON.stringify(value, null, 2)}
    </pre>
  </div>
)
