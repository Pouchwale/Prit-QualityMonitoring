import React, { useMemo, useState } from 'react'
import { ExternalLink, RefreshCw } from 'lucide-react'
import type { ExceptionRecord, ExceptionStatus } from '../../types'
import { useApi } from '../../lib/useApi'
import { api, errorText } from '../../lib/api'
import { useCanManage } from '../../lib/auth'
import { addDaysKey, dateKey, formatDateTime } from '../../lib/format'
import { Button } from '../../components/common/Button'
import { PageHeader } from '../../components/common/PageHeader'
import { DataState } from '../../components/common/DataState'
import { StatusBadge } from '../../components/common/StatusBadge'
import { EvidenceViewer } from '../../components/common/EvidenceViewer'
import { Modal } from '../../components/common/Modal'
import { Field, FormError, Select, TextArea } from '../../components/common/Form'
import { FilterBar, type MonitoringFilters } from '../../components/common/FilterBar'
import { useToast } from '../../components/common/Toast'

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
  const canEdit = useCanManage('exceptions')
  const [filters, setFilters] = useState<MonitoringFilters>(defaultFilters)
  const [reviewing, setReviewing] = useState<ExceptionRecord | null>(null)

  const { data, error, loading, reload } = useApi<ExceptionRecord[]>('/api/exceptions', { from: filters.from, to: filters.to })

  const all = useMemo(() => data ?? [], [data])
  const rows = useMemo(() => (filters.status ? all.filter((e) => e.status === filters.status) : all), [all, filters.status])
  const countOf = (status: ExceptionStatus) => all.filter((e) => e.status === status).length
  const open = all.filter((e) => e.status !== 'RESOLVED').length

  return (
    <div className="space-y-4">
      <PageHeader
        title="Exceptions"
        description="Checks that workers could not perform, with their reason, remark and photo"
        actions={
          <Button size="sm" variant="outline" onClick={() => reload()} loading={loading && data !== null} icon={<RefreshCw className="w-3.5 h-3.5" />}>
            Refresh
          </Button>
        }
      />

      <FilterBar
        value={filters}
        onChange={setFilters}
        onReset={() => setFilters(defaultFilters())}
        fields={['status']}
        statusOptions={EXCEPTION_STATUSES}
      />

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <StatTile label="Total" value={all.length} active={filters.status === ''} onClick={() => setFilters({ ...filters, status: '' })} />
        {EXCEPTION_STATUSES.map((s) => (
          <StatTile
            key={s.value}
            label={s.label}
            value={countOf(s.value)}
            active={filters.status === s.value}
            onClick={() => setFilters({ ...filters, status: filters.status === s.value ? '' : s.value })}
            highlight={s.value === 'UNDER_REVIEW' && countOf(s.value) > 0}
          />
        ))}
      </div>
      {open > 0 && (
        <div className="text-[11px] text-ink-muted">
          <span className="font-semibold text-exception">{open}</span> exception{open === 1 ? '' : 's'} not yet resolved in this period.
        </div>
      )}

      <DataState loading={loading} error={error} onRetry={reload} empty={data === null ? undefined : rows.length === 0} emptyText="No exceptions in this period.">
        <div className="bg-white border border-line rounded-md shadow-2xs overflow-hidden">
          <div className="overflow-x-auto">
            <table className="stack-sm w-full text-left text-xs border-collapse">
              <thead className="bg-slate-50 border-b border-line text-ink-secondary text-[11px] uppercase tracking-wider">
                <tr>
                  <th className="py-2.5 px-3 font-semibold">Raised</th>
                  <th className="py-2.5 px-3 font-semibold">Machine</th>
                  <th className="py-2.5 px-3 font-semibold">Check type</th>
                  <th className="py-2.5 px-3 font-semibold">Worker</th>
                  <th className="py-2.5 px-3 font-semibold">Reason</th>
                  <th className="py-2.5 px-3 font-semibold">Remark</th>
                  <th className="py-2.5 px-3 font-semibold">Status</th>
                  <th className="py-2.5 px-3 font-semibold">Photo</th>
                  <th className="py-2.5 px-3 font-semibold text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((e) => (
                  <tr key={e.id} className="hover:bg-slate-50 align-top">
                    <td className="py-2 px-3 whitespace-nowrap">
                      <div className="font-mono text-ink">{formatDateTime(e.createdAt)}</div>
                      <div className="text-[11px] text-ink-muted">
                        Slot {formatDateTime(e.scheduledAt)} · <span className="font-mono">{e.checkCode}</span>
                      </div>
                    </td>
                    <td className="py-2 px-3 whitespace-nowrap">
                      <div className="font-semibold text-ink">{e.machineName}</div>
                      {e.departmentName && <div className="text-[11px] text-ink-muted">{e.departmentName}</div>}
                    </td>
                    <td className="py-2 px-3 text-ink-secondary whitespace-nowrap">{e.activityName}</td>
                    <td className="py-2 px-3 whitespace-nowrap">
                      <div className={e.workerName ? 'font-medium text-ink' : 'text-ink-faint italic'}>{e.workerName ?? 'Unknown'}</div>
                      {e.workerEmployeeId && <div className="text-[11px] text-ink-muted font-mono">{e.workerEmployeeId}</div>}
                    </td>
                    <td className="py-2 px-3 font-medium text-ink min-w-[140px]">{e.reason}</td>
                    <td className="py-2 px-3 text-ink-secondary min-w-[160px] max-w-[260px]">
                      <div className="line-clamp-3" title={e.remark ?? undefined}>
                        {e.remark || <span className="text-ink-faint">—</span>}
                      </div>
                      {e.resolutionNotes && (
                        <div className="mt-1 text-[11px] text-success line-clamp-2" title={e.resolutionNotes}>
                          Resolution: {e.resolutionNotes}
                        </div>
                      )}
                    </td>
                    <td className="py-2 px-3 whitespace-nowrap">
                      <StatusBadge status={e.status} size="sm" />
                      {e.reviewedByName && <div className="text-[11px] text-ink-muted mt-1">by {e.reviewedByName}</div>}
                    </td>
                    <td className="py-2 px-3 whitespace-nowrap">
                      {e.media.length > 0 ? <EvidenceViewer media={e.media} compact /> : <span className="text-ink-faint">—</span>}
                    </td>
                    <td className="py-2 px-3 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-1.5">
                        {canEdit && (
                          <Button size="sm" variant="primary" onClick={() => setReviewing(e)}>
                            Review
                          </Button>
                        )}
                        <Button size="sm" variant="outline" onClick={() => onViewCheck(e.checkId)} icon={<ExternalLink className="w-3 h-3" />}>
                          Check
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </DataState>

      {reviewing && (
        <ReviewModal
          record={reviewing}
          onClose={() => setReviewing(null)}
          onSaved={() => {
            setReviewing(null)
            reload()
          }}
        />
      )}
    </div>
  )
}

const StatTile: React.FC<{ label: string; value: number; active: boolean; onClick: () => void; highlight?: boolean }> = ({
  label,
  value,
  active,
  onClick,
  highlight
}) => (
  <button
    type="button"
    onClick={onClick}
    className={`text-left bg-white border rounded-md px-3 py-2 shadow-2xs transition-colors ${
      active ? 'border-accent ring-1 ring-accent' : highlight ? 'border-exception-line hover:border-exception' : 'border-line hover:border-line-strong'
    }`}
  >
    <div className={`text-[11px] font-medium ${highlight ? 'text-exception' : 'text-ink-secondary'}`}>{label}</div>
    <div className={`text-xl font-bold font-mono ${highlight ? 'text-exception' : 'text-ink'}`}>{value}</div>
  </button>
)

const ReviewModal: React.FC<{ record: ExceptionRecord; onClose: () => void; onSaved: () => void }> = ({ record, onClose, onSaved }) => {
  const notify = useToast()
  const [status, setStatus] = useState<ExceptionStatus>(record.status)
  const [notes, setNotes] = useState(record.resolutionNotes ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      await api.patch(`/api/exceptions/${record.id}`, { status, resolutionNotes: notes.trim() })
      notify('success', 'Exception updated', `${record.machineName} · ${EXCEPTION_STATUSES.find((s) => s.value === status)?.label}`)
      onSaved()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="Review exception"
      subtitle={`${record.checkCode} · ${record.machineName} · ${record.activityName}`}
      maxWidth="lg"
      footer={
        <>
          <Button size="sm" variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" onClick={save} loading={saving}>
            Save review
          </Button>
        </>
      }
    >
      <FormError message={error} />
      <div className="grid grid-cols-2 gap-3 p-3 rounded border border-line bg-slate-50 text-xs">
        <div>
          <div className="text-[11px] text-ink-muted">Reason</div>
          <div className="font-medium text-ink">{record.reason}</div>
        </div>
        <div>
          <div className="text-[11px] text-ink-muted">Raised by</div>
          <div className="font-medium text-ink">
            {record.workerName ?? 'Unknown'} · {formatDateTime(record.createdAt)}
          </div>
        </div>
        <div className="col-span-2">
          <div className="text-[11px] text-ink-muted">Worker remark</div>
          <div className="text-ink whitespace-pre-wrap">{record.remark || '—'}</div>
        </div>
      </div>
      {record.media.length > 0 && <EvidenceViewer media={record.media} compact />}
      <Field label="Status" required>
        <Select value={status} onChange={(e) => setStatus(e.target.value as ExceptionStatus)}>
          {EXCEPTION_STATUSES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Resolution notes" hint="What was checked or done about this exception (max 1000 characters)">
        <TextArea value={notes} maxLength={1000} rows={4} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Machine restarted after maintenance; next check performed on time" />
      </Field>
    </Modal>
  )
}
