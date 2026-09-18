import React, { useMemo, useState } from 'react'
import { Download, Eye, FlaskConical, RefreshCw } from 'lucide-react'
import type { CheckResult, QualityCheck, QualityCheckStatus } from '../../types'
import { useApi } from '../../lib/useApi'
import { useCanManage } from '../../lib/auth'
import { CreateTestCheckModal } from './CreateTestCheckModal'
import { mediaUrl } from '../../lib/api'
import { CHECK_STATUSES, RESULT_HINT, RESULT_LABEL, checkStatusLabel, dateKey, downloadCsv, formatDateTime, formatTime } from '../../lib/format'
import { Button } from '../../components/common/Button'
import { PageHeader } from '../../components/common/PageHeader'
import { DataState } from '../../components/common/DataState'
import { CheckStatusBadge, StatusBadge } from '../../components/common/StatusBadge'
import { EvidenceViewer } from '../../components/common/EvidenceViewer'
import { FilterBar, type MonitoringFilters } from '../../components/common/FilterBar'

const CHIP_STYLE: Record<CheckResult, { idle: string; active: string }> = {
  COMPLETED: { idle: 'bg-success-bg text-success border-success-line', active: 'bg-success text-white border-success' },
  MISSED: { idle: 'bg-missed-bg text-missed border-missed-line', active: 'bg-missed text-white border-missed' },
  EXCEPTION: { idle: 'bg-exception-bg text-exception border-exception-line', active: 'bg-exception text-white border-exception' }
}

const statusOptions = CHECK_STATUSES.map((s) => ({ value: s, label: RESULT_LABEL[s] }))

const defaultFilters = (): MonitoringFilters => {
  const today = dateKey()
  return { from: today, to: today, shiftId: '', machineId: '', workerId: '', activityId: '', departmentId: '', status: '' }
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

export const QualityChecksPage: React.FC<{ onViewCheck: (id: string) => void }> = ({ onViewCheck }) => {
  const [filters, setFilters] = useState<MonitoringFilters>(defaultFilters)
  const [testOpen, setTestOpen] = useState(false)
  const canEdit = useCanManage('checks')

  // Status is applied client-side so the summary chips can show counts for every status.
  const { data, error, loading, reload } = useApi<QualityCheck[]>('/api/quality-checks', {
    from: filters.from,
    to: filters.to,
    shiftId: filters.shiftId,
    machineId: filters.machineId,
    workerId: filters.workerId,
    activityId: filters.activityId,
    departmentId: filters.departmentId
  })

  const all = useMemo(() => data ?? [], [data])
  const counts = useMemo(() => {
    const map = new Map<QualityCheckStatus, number>()
    for (const c of all) map.set(c.status, (map.get(c.status) ?? 0) + 1)
    return map
  }, [all])
  const rows = useMemo(() => (filters.status ? all.filter((c) => c.status === filters.status) : all), [all, filters.status])
  const multiDay = filters.from !== filters.to

  const exportCsv = () => {
    downloadCsv(
      `quality-checks_${filters.from}_${filters.to}${filters.status ? `_${filters.status.toLowerCase()}` : ''}.csv`,
      // prettier-ignore
      ['Scheduled at', 'Check code', 'Machine', 'Machine code', 'Department', 'Check type', 'Worker', 'Employee ID', 'Shift', 'Status', 'Result', 'Submission type', 'Item Code', 'Job No.', 'Submitted at', 'Parameters', 'Parameters outside limits', 'N/A parameters', 'Exception reason', 'Evidence URLs'],
      rows.map((c) => [
        formatDateTime(c.scheduledAt),
        c.code,
        c.machineName,
        c.machineCode,
        c.departmentName,
        c.activityName,
        workerLabel(c),
        c.submittedByEmployeeId ?? c.workerEmployeeId,
        c.shiftName,
        checkStatusLabel(c.status),
        c.result ? RESULT_LABEL[c.result] : '',
        c.submissionType ? SUBMISSION_LABEL[c.submissionType] : '',
        c.itemCode,
        c.jobNo,
        c.submittedAt ? formatDateTime(c.submittedAt) : '',
        valueText(c),
        outsideLimitsText(c),
        notApplicableText(c),
        c.exception?.reason,
        c.media.map((m) => mediaUrl(m.url)).join(' ')
      ])
    )
  }

  const chip = (status: CheckResult | '', label: string, count: number) => {
    const active = filters.status === status
    const style = status
      ? active
        ? CHIP_STYLE[status].active
        : `${CHIP_STYLE[status].idle} hover:border-line-strong`
      : active
        ? 'bg-ink text-white border-ink'
        : 'bg-white text-ink-secondary border-line hover:border-line-strong'
    return (
      <button
        key={status || 'ALL'}
        type="button"
        onClick={() => setFilters({ ...filters, status: active && status ? '' : status })}
        className={`inline-flex items-center gap-1.5 h-[36px] lg:h-7 px-2.5 rounded border text-xs font-medium whitespace-nowrap transition-colors ${style}`}
      >
        {label}
        <span className="font-mono font-semibold">{count}</span>
      </button>
    )
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Quality Check Monitoring"
        description="Every scheduled check for the selected period, with submitted values and live evidence"
        actions={
          <>
            <Button size="sm" variant="outline" onClick={() => reload()} loading={loading && data !== null} icon={<RefreshCw className="w-3.5 h-3.5" />}>
              Refresh
            </Button>
            <Button size="sm" variant="outline" onClick={exportCsv} disabled={rows.length === 0} icon={<Download className="w-3.5 h-3.5" />}>
              Export CSV
            </Button>
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
        fields={['shift', 'machine', 'worker', 'activity', 'department', 'status']}
        statusOptions={statusOptions}
      />

      <div className="flex flex-wrap items-center gap-2">
        {chip('', 'All', all.length)}
        {CHECK_STATUSES.map((s) => chip(s, RESULT_LABEL[s], counts.get(s) ?? 0))}
        <span className="ml-auto text-[11px] text-ink-muted">
          Showing {rows.length} of {all.length} checks
        </span>
      </div>

      <DataState loading={loading} error={error} onRetry={reload} empty={data === null ? undefined : rows.length === 0} emptyText="No quality checks match these filters.">
        <div className="bg-white border border-line rounded-md shadow-2xs overflow-hidden">
          <div className="overflow-x-auto">
            <table className="stack-sm w-full text-left text-xs border-collapse">
              <thead className="bg-slate-50 border-b border-line text-ink-secondary text-[11px] uppercase tracking-wider">
                <tr>
                  <th className="py-2.5 px-3 font-semibold">Scheduled</th>
                  <th className="py-2.5 px-3 font-semibold">Code</th>
                  <th className="py-2.5 px-3 font-semibold">Machine</th>
                  <th className="py-2.5 px-3 font-semibold">Check type</th>
                  <th className="py-2.5 px-3 font-semibold">Worker</th>
                  <th className="py-2.5 px-3 font-semibold">Shift</th>
                  <th className="py-2.5 px-3 font-semibold">Status</th>
                  <th className="py-2.5 px-3 font-semibold" title={RESULT_HINT}>Result</th>
                  <th className="py-2.5 px-3 font-semibold">Item Code</th>
                  <th className="py-2.5 px-3 font-semibold">Job No.</th>
                  <th className="py-2.5 px-3 font-semibold">Evidence</th>
                  <th className="py-2.5 px-3 font-semibold">Submitted</th>
                  <th className="py-2.5 px-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((c) => (
                  <tr key={c.id} className="hover:bg-slate-50 transition-colors">
                    <td className="py-2 px-3 font-mono text-ink whitespace-nowrap">
                      {multiDay ? formatDateTime(c.scheduledAt) : formatTime(c.scheduledAt)}
                    </td>
                    <td className="py-2 px-3 font-mono text-ink-secondary whitespace-nowrap">{c.code}</td>
                    <td className="py-2 px-3 whitespace-nowrap">
                      <div className="font-semibold text-ink">{c.machineName}</div>
                      <div className="text-[11px] text-ink-muted">
                        {c.machineCode}
                        {c.departmentName ? ` · ${c.departmentName}` : ''}
                      </div>
                    </td>
                    <td className="py-2 px-3 text-ink-secondary whitespace-nowrap">{c.activityName}</td>
                    <td className="py-2 px-3 whitespace-nowrap">
                      <span className={c.submittedByName || c.workerName ? 'font-medium text-ink' : 'text-ink-faint italic'}>{workerLabel(c)}</span>
                    </td>
                    <td className="py-2 px-3 text-ink-secondary whitespace-nowrap">{c.shiftName ?? '—'}</td>
                    <td className="py-2 px-3 whitespace-nowrap">
                      <CheckStatusBadge status={c.status} size="sm" />
                    </td>
                    <td className="py-2 px-3 whitespace-nowrap">
                      {c.result ? <StatusBadge status={c.result} size="sm" showDot={false} /> : <span className="text-ink-faint">—</span>}
                    </td>
                    <td className="py-2 px-3 font-mono text-ink whitespace-nowrap">{c.itemCode ?? <span className="text-ink-faint">—</span>}</td>
                    <td className="py-2 px-3 font-mono text-ink whitespace-nowrap">{c.jobNo ?? <span className="text-ink-faint">—</span>}</td>
                    <td className="py-2 px-3 whitespace-nowrap">
                      {c.media.length > 0 ? <EvidenceViewer media={c.media} compact /> : <span className="text-ink-faint">—</span>}
                    </td>
                    <td className="py-2 px-3 font-mono text-ink-secondary whitespace-nowrap">
                      {c.submittedAt ? (multiDay ? formatDateTime(c.submittedAt) : formatTime(c.submittedAt)) : '—'}
                    </td>
                    <td className="py-2 px-3 text-right whitespace-nowrap">
                      <Button size="sm" variant="outline" onClick={() => onViewCheck(c.id)} icon={<Eye className="w-3 h-3" />}>
                        View
                      </Button>
                    </td>
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
