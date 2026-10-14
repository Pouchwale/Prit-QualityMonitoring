import React, { useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, ClipboardCheck, ClipboardList, Clock3, Download, Eye, FlaskConical, Pencil, RefreshCw, SearchX, Trash2, XCircle } from 'lucide-react'
import type { CheckResult, QualityCheck, QualityCheckStatus } from '../../types'
import { useApi } from '../../lib/useApi'
import { useAuth, useCan } from '../../lib/auth'
import { CreateTestCheckModal } from './CreateTestCheckModal'
import { EditCheckModal } from './EditCheckModal'
import { api, mediaUrl, type Page } from '../../lib/api'
import { CHECK_STATUSES, RESULT_HINT, RESULT_LABEL, checkStatusLabel, dateKey, downloadCsv, formatDateKey, formatDateTime, formatTime } from '../../lib/format'
import { Button } from '../../components/common/Button'
import { PageHeader } from '../../components/common/PageHeader'
import { DataState, TruncatedNotice } from '../../components/common/DataState'
import { CheckStatusBadge, StatusBadge } from '../../components/common/StatusBadge'
import { Card, EmptyState, InfoTip } from '../../components/ui/Card'
import { StatCard } from '../../components/ui/StatCard'
import { IconButton, ResultCount, Segmented, Toolbar, ToolbarSpacer } from '../../components/ui/Toolbar'
import { Pagination, usePagination } from '../../components/ui/Pagination'
import { EvidenceViewer } from '../../components/common/EvidenceViewer'
import { FilterBar, type MonitoringFilters } from '../../components/common/FilterBar'
import { DeleteRecordsModal } from '../../components/common/DeleteRecordsModal'
import { BulkDeleteBar, RowCheckbox, useSelection } from '../../components/common/BulkSelection'
import { useToast } from '../../components/common/Toast'
import { useDeletePermissions } from '../../lib/deletePermissions'

/** Five KPI tiles with no empty cell: 2 + 2 + 1 (wide) on phones, 3 + 2 on tablets, one row on desktop. */
const KPI_GRID =
  'grid grid-cols-2 md:grid-cols-6 xl:grid-cols-5 gap-3 [&>*:last-child]:col-span-2 md:[&>*]:col-span-2 md:[&>*:nth-child(n+4)]:col-span-3 xl:[&>*]:col-span-1 xl:[&>*:nth-child(n+4)]:col-span-1'

const statusOptions = CHECK_STATUSES.map((s) => ({ value: s, label: RESULT_LABEL[s] }))

const defaultFilters = (): MonitoringFilters => {
  const today = dateKey()
  return { from: today, to: today, shiftId: '', machineId: '', workerId: '', activityId: '', departmentId: '', status: '', module: '' }
}

const workerLabel = (c: QualityCheck) => c.submittedByName ?? c.workerName ?? '—'

const reading = (v: QualityCheck['values'][number]) => `${v.parameterName}=${v.value ?? ''}${v.unit ? ` ${v.unit}` : ''}`

// Readings and their within/outside-limits result are separate recorded data, not the check Result.
const valueText = (c: QualityCheck) =>
  c.values
    .map((v) =>
      v.notApplicable
        ? `${v.parameterName}=not applicable (${v.naReason ?? 'no reason'})`
        : `${reading(v)} (${v.result === 'PASS' ? 'within limits' : v.result === 'FAIL' ? 'outside limits' : 'no limit'})`
    )
    .join('; ')

const outsideLimitsText = (c: QualityCheck) => c.values.filter((v) => v.result === 'FAIL').map(reading).join('; ')

/** Parameters the worker marked Not Applicable, e.g. "Viscosity: Machine stopped". */
const notApplicableText = (c: QualityCheck) =>
  c.values
    .filter((v) => v.notApplicable)
    .map((v) => `${v.parameterName}: ${v.naReason ?? 'no reason'}${v.naRemark ? ` (${v.naRemark})` : ''}`)
    .join('; ')

/** How the check was started: by the worker, or from the due notification. */
const SUBMISSION_LABEL = { MANUAL: 'Manual', NOTIFICATION: 'Notification' } as const

/** Loads the checks with the total the filters match and whether the server capped the list. */
const loadPage = (path: string, query?: Record<string, string | number | boolean | null | undefined>) => api.getPage<QualityCheck>(path, query)

export const QualityChecksPage: React.FC<{ onViewCheck: (id: string) => void; tabs?: React.ReactNode }> = ({ onViewCheck, tabs }) => {
  const [filters, setFilters] = useState<MonitoringFilters>(defaultFilters)
  const [testOpen, setTestOpen] = useState(false)
  // Creating test checks: Quality Checks create in Roles & Permissions.
  const canEdit = useCan('checks', 'create')
  // The CSV needs the Export Reports module.
  const canExport = useAuth().can('checks', 'export')
  // Correcting a submitted check is the Super Admin's alone; the server refuses everyone else.
  const canCorrect = useAuth().isSuperAdmin
  const [editingId, setEditingId] = useState<string | null>(null)

  // Status is applied client-side so the summary chips can show counts for every status.
  // Loaded with the total too: the server caps the list and says so (X-Truncated).
  const { data, error, loading, reload } = useApi<Page<QualityCheck>>('/api/quality-checks', {
    from: filters.from,
    to: filters.to,
    shiftId: filters.shiftId,
    machineId: filters.machineId,
    workerId: filters.workerId,
    activityId: filters.activityId,
    departmentId: filters.departmentId,
    module: filters.module || undefined
  }, loadPage)

  const all = useMemo(() => data?.rows ?? [], [data])
  const counts = useMemo(() => {
    const map = new Map<QualityCheckStatus, number>()
    for (const c of all) map.set(c.status, (map.get(c.status) ?? 0) + 1)
    return map
  }, [all])
  const rows = useMemo(() => (filters.status ? all.filter((c) => c.status === filters.status) : all), [all, filters.status])
  const multiDay = filters.from !== filters.to
  // Checks not finished yet (no Completed / Missed / Exception status), for the KPI strip.
  const openCount = all.length - CHECK_STATUSES.reduce((n, s) => n + (counts.get(s) ?? 0), 0)
  const completedCount = counts.get('COMPLETED') ?? 0
  const missedCount = counts.get('MISSED') ?? 0
  const exceptionCount = counts.get('EXCEPTION') ?? 0
  const period = multiDay ? `${formatDateKey(filters.from)} – ${formatDateKey(filters.to)}` : formatDateKey(filters.from)

  // Only one page of rows is rendered; the CSV below still uses every filtered row.
  const paging = usePagination(rows, 25, JSON.stringify(filters))

  // Permanent delete: needs Delete Checks (checked again by the server). Only rows on the current
  // page can be selected, so nothing out of sight is ever deleted.
  const notify = useToast()
  const canDeleteChecks = useDeletePermissions().DELETE_CHECKS
  const selection = useSelection(useMemo(() => (canDeleteChecks ? paging.visible.map((c) => c.id) : []), [paging.visible, canDeleteChecks]))
  const [deleting, setDeleting] = useState<{ ids: string[]; bulk: boolean } | null>(null)

  const exportCsv = () => {
    downloadCsv(
      `quality-checks_${filters.from}_${filters.to}${filters.status ? `_${filters.status.toLowerCase()}` : ''}.csv`,
      // prettier-ignore
      ['Scheduled at', 'Check code', 'Type', 'Worker', 'Employee ID', 'Check type', 'Item Code', 'PO No.', 'Status', 'Result', 'Department', 'Machine', 'Machine code', 'Shift', 'Submission type', 'Submitted at', 'Parameters', 'Parameters outside limits', 'N/A parameters', 'Exception reason', 'Exception reading', 'Evidence URLs'],
      rows.map((c) => [
        formatDateTime(c.scheduledAt),
        c.code,
        c.module ?? 'IPQC',
        workerLabel(c),
        c.submittedByEmployeeId ?? c.workerEmployeeId,
        c.activityName,
        c.itemCode,
        c.jobNo,
        checkStatusLabel(c.status),
        c.result ? RESULT_LABEL[c.result] : '',
        c.departmentName,
        c.machineName,
        c.machineCode,
        c.shiftName,
        c.submissionType ? SUBMISSION_LABEL[c.submissionType] : '',
        c.submittedAt ? formatDateTime(c.submittedAt) : '',
        valueText(c),
        outsideLimitsText(c),
        notApplicableText(c),
        c.exception?.reason,
        c.exception?.reading,
        c.media.map((m) => mediaUrl(m.url)).join(' ')
      ])
    )
  }

  // The status tabs filter the loaded list; each shows how many checks it holds.
  const statusTabs: { value: CheckResult | ''; label: string; count: number }[] = [
    { value: '', label: 'All', count: all.length },
    ...CHECK_STATUSES.map((s) => ({ value: s, label: RESULT_LABEL[s], count: counts.get(s) ?? 0 }))
  ]
  const pct = (n: number) => (all.length ? Math.round((n / all.length) * 100) : 0)

  return (
    <div className="space-y-5">
      <PageHeader
        tabs={tabs}
        icon={<ClipboardCheck className="w-4.5 h-4.5" />}
        title="Quality Monitoring"
        description={`${period} · ${all.length.toLocaleString('en-IN')} ${all.length === 1 ? 'check' : 'checks'}`}
        info="Every scheduled check for the selected period, with submitted values and live evidence."
        actions={
          <>
            <IconButton label="Refresh" size="md" onClick={() => reload()} className="border border-line-strong bg-white">
              <RefreshCw className={`w-4 h-4 ${loading && data !== null ? 'animate-spin' : ''}`} />
            </IconButton>
            {canExport && (
              <Button size="sm" variant="outline" onClick={exportCsv} disabled={rows.length === 0} icon={<Download className="w-3.5 h-3.5" />}>
                Export CSV
              </Button>
            )}
            {canEdit && (
              <Button size="sm" variant="primary" onClick={() => setTestOpen(true)} icon={<FlaskConical className="w-3.5 h-3.5" />}>
                Create Test Check
              </Button>
            )}
          </>
        }
      />

      <CreateTestCheckModal
        isOpen={testOpen}
        onClose={() => setTestOpen(false)}
        onCreated={() => {
          const today = dateKey()
          setFilters({ ...defaultFilters(), from: today, to: today })
          reload()
        }}
      />

      <FilterBar
        value={filters}
        onChange={setFilters}
        onReset={() => setFilters(defaultFilters())}
        fields={['module', 'worker', 'department', 'activity', 'status', 'shift', 'machine']}
        statusOptions={statusOptions}
      />

      {/* KPI strip for the filtered period (before the status tab narrows it). */}
      {data !== null && (
        <div className={KPI_GRID}>
          <StatCard label="Total checks" value={all.length} icon={<ClipboardList className="w-4 h-4" />} meta={period} />
          <StatCard label="Completed" value={completedCount} icon={<CheckCircle2 className="w-4 h-4" />} tone="success" meta={`${pct(completedCount)}% of checks`} />
          <StatCard
            label="Missed"
            value={missedCount}
            icon={<XCircle className="w-4 h-4" />}
            tone={missedCount > 0 ? 'missed' : 'neutral'}
            alert={missedCount > 0}
            meta={missedCount > 0 ? `${pct(missedCount)}% · needs follow-up` : 'None'}
          />
          <StatCard
            label="Exceptions"
            value={exceptionCount}
            icon={<AlertTriangle className="w-4 h-4" />}
            tone={exceptionCount > 0 ? 'exception' : 'neutral'}
            meta={exceptionCount > 0 ? 'Could not be done' : 'None'}
          />
          <StatCard label="Open" value={openCount} icon={<Clock3 className="w-4 h-4" />} tone="due" meta="Not finished yet" />
        </div>
      )}

      {data?.truncated && <TruncatedNotice shown={all.length} total={data.total} />}

      {canDeleteChecks && (
        <BulkDeleteBar
          count={selection.selected.length}
          noun={selection.selected.length === 1 ? 'check' : 'checks'}
          onClear={selection.clear}
          onDelete={() => setDeleting({ ids: selection.selected, bulk: true })}
        />
      )}

      <DataState loading={loading} error={error} onRetry={reload} empty={data === null ? undefined : false}>
        <Card className="overflow-hidden">
          <Toolbar>
            <Segmented
              label="Filter by status"
              value={filters.status as CheckResult | ''}
              onChange={(status) => setFilters({ ...filters, status })}
              options={statusTabs}
            />
            <InfoTip text={RESULT_HINT} />
            <ToolbarSpacer />
            <ResultCount shown={rows.length} total={all.length} noun="checks" />
          </Toolbar>

          {rows.length === 0 ? (
            <EmptyState icon={<SearchX className="w-5 h-5" />} title="No quality checks match these filters." hint="Try another status, date range or filter." />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table stack-sm">
                <thead>
                  <tr>
                    {canDeleteChecks && (
                      <th className="w-8 !pr-0">
                        <RowCheckbox checked={selection.allChecked} indeterminate={selection.partial} onChange={selection.toggleAll} label="Select all checks shown" />
                      </th>
                    )}
                    <th>Time</th>
                    <th>Check</th>
                    <th>Worker</th>
                    <th>PO / Item</th>
                    <th>Department</th>
                    <th>Status</th>
                    <th>Evidence</th>
                    {/* Named by aria-label, not text: the phone card layout copies header text into each cell. */}
                    <th className="text-right" aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {paging.visible.map((c) => (
                    <tr key={c.id}>
                      {canDeleteChecks && (
                        <td className="!pr-0">
                          <RowCheckbox checked={selection.isSelected(c.id)} onChange={() => selection.toggle(c.id)} label={`Select check ${c.code}`} />
                        </td>
                      )}
                      <td className="whitespace-nowrap tabular-nums">
                        <div className="font-medium text-ink">{multiDay ? formatDateTime(c.scheduledAt) : formatTime(c.scheduledAt)}</div>
                        <div className="text-[11.5px] text-ink-muted">
                          {c.submittedAt ? `Submitted ${multiDay ? formatDateTime(c.submittedAt) : formatTime(c.submittedAt)}` : 'Not submitted'}
                        </div>
                      </td>
                      <td className="whitespace-nowrap">
                        <div className="flex items-center gap-1.5">
                          <ModulePill module={c.module ?? 'IPQC'} />
                          <button type="button" onClick={() => onViewCheck(c.id)} className="font-medium text-ink hover:text-accent text-left">
                            {c.activityName}
                          </button>
                        </div>
                        <div className="font-mono text-[11px] text-ink-muted">{c.code}</div>
                      </td>
                      <td className="whitespace-nowrap">
                        <div className={c.submittedByName || c.workerName ? 'font-medium text-ink' : 'text-ink-muted italic'}>{workerLabel(c)}</div>
                        {c.workerEmployeeId && <div className="font-mono text-[11px] text-ink-muted">{c.workerEmployeeId}</div>}
                      </td>
                      <td className="whitespace-nowrap">
                        {c.jobNo || c.itemCode ? (
                          <>
                            <div className="font-mono font-medium text-ink">{c.jobNo ?? '—'}</div>
                            <div className="font-mono text-[11px] text-ink-muted">{c.itemCode ?? '—'}</div>
                          </>
                        ) : (
                          <span className="text-ink-faint">—</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap">
                        <div className="text-ink-secondary">{c.departmentName ?? '—'}</div>
                        {c.machineName && <div className="text-[11.5px] text-ink-muted">{c.machineName}</div>}
                      </td>
                      <td className="whitespace-nowrap">
                        <CheckStatusBadge status={c.status} size="sm" />
                        {/* The Result is normally the same as the status; only shown when it differs. */}
                        {c.result && c.result !== c.status && (
                          <div className="mt-1 flex items-center gap-1 text-[11px] text-ink-muted">
                            Result <StatusBadge status={c.result} size="sm" showDot={false} />
                          </div>
                        )}
                      </td>
                      <td className="whitespace-nowrap">{c.media.length > 0 ? <EvidenceViewer media={c.media} compact /> : <span className="text-ink-faint">—</span>}</td>
                      <td className="text-right whitespace-nowrap" data-label="">
                        <div className="inline-flex items-center gap-0.5">
                          <IconButton label={`View check ${c.code}`} onClick={() => onViewCheck(c.id)}>
                            <Eye className="w-4 h-4" />
                          </IconButton>
                          {canCorrect && (c.status === 'COMPLETED' || c.status === 'EXCEPTION') && (
                            <IconButton label={`Correct check ${c.code}`} onClick={() => setEditingId(c.id)}>
                              <Pencil className="w-4 h-4" />
                            </IconButton>
                          )}
                          {canDeleteChecks && (
                            <IconButton label={`Delete check ${c.code} permanently`} tone="danger" onClick={() => setDeleting({ ids: [c.id], bulk: false })}>
                              <Trash2 className="w-4 h-4" />
                            </IconButton>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Pagination page={paging.page} pages={paging.pages} total={paging.total} pageSize={paging.pageSize} onPage={paging.setPage} noun="checks" />
        </Card>
      </DataState>
      <EditCheckModal
        checkId={editingId}
        onClose={() => setEditingId(null)}
        onSaved={() => {
          setEditingId(null)
          notify('success', 'Check corrected', 'The old and new values are recorded in the audit log.')
          reload()
        }}
      />
      <DeleteRecordsModal
        type={deleting ? 'checks' : null}
        ids={deleting?.ids ?? []}
        bulk={deleting?.bulk}
        onClose={() => setDeleting(null)}
        onDeleted={(r) => {
          notify('success', r.deleted === 1 ? 'Check deleted' : `${r.deleted} checks deleted`, `${r.filesRemoved} evidence file${r.filesRemoved === 1 ? '' : 's'} removed. Recorded in the audit log.`)
          if (r.filesNotRemoved.length) notify('error', 'Some files could not be removed', `${r.filesNotRemoved.length} evidence file(s) are still on the server.`)
          selection.clear()
          reload()
        }}
      />
    </div>
  )
}

/** IPQC / QC tag in front of the check type: accent for IPQC, neutral for QC, always with its text. */
const ModulePill: React.FC<{ module: 'IPQC' | 'QC' }> = ({ module }) => (
  <span
    className={`inline-flex items-center h-[18px] px-1.5 rounded text-[10.5px] font-semibold tracking-wide ring-1 ring-inset ${
      module === 'QC' ? 'bg-subtle text-ink-secondary ring-line-strong' : 'bg-accent-soft text-accent-strong ring-accent-line'
    }`}
  >
    {module}
  </span>
)
