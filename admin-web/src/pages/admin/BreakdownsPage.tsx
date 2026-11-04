import React, { useMemo, useState } from 'react'
import { Camera, Check, CheckCircle2, Eye, Inbox, Timer, Wrench, X, XCircle } from 'lucide-react'
import type { BreakdownCheck, BreakdownStatus, MachineBreakdown } from '../../types'
import { api, errorText, mediaUrl } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { useAuth } from '../../lib/auth'
import { formatDate, formatDateTime, formatTime } from '../../lib/format'
import { Button } from '../../components/common/Button'
import { DataState } from '../../components/common/DataState'
import { Field, FormError, TextArea } from '../../components/common/Form'
import { Modal } from '../../components/common/Modal'
import { PageHeader } from '../../components/common/PageHeader'
import { CheckStatusBadge } from '../../components/common/StatusBadge'
import { useToast } from '../../components/common/Toast'
import { Card, EmptyState } from '../../components/ui/Card'
import { Pill } from '../../components/ui/Chips'
import { StatCard } from '../../components/ui/StatCard'
import { IconButton, ResultCount, SearchInput, Segmented, Toolbar, ToolbarSpacer } from '../../components/ui/Toolbar'

type StatusFilter = BreakdownStatus | 'ALL'

const STATUS_PILL: Record<BreakdownStatus, { label: string; className: string }> = {
  PENDING: { label: 'Waiting', className: 'bg-due-bg text-due ring-due-line' },
  APPROVED: { label: 'Approved', className: 'bg-success-bg text-success ring-success-line' },
  REJECTED: { label: 'Rejected', className: 'bg-missed-bg text-missed ring-missed-line' },
  CANCELLED: { label: 'Withdrawn', className: 'bg-subtle text-ink-muted ring-line' }
}

const BreakdownStatusPill: React.FC<{ status: BreakdownStatus }> = ({ status }) => <Pill className={STATUS_PILL[status].className}>{STATUS_PILL[status].label}</Pill>

/** "4 Nov, 2:00 AM → 8:00 AM" (the end date only when it is another day). */
function period(b: Pick<MachineBreakdown, 'startedAt' | 'endsAt'>) {
  const sameDay = formatDate(b.startedAt) === formatDate(b.endsAt)
  return `${formatDateTime(b.startedAt)} → ${sameDay ? formatTime(b.endsAt) : formatDateTime(b.endsAt)}`
}

/** Approved: the checks it excused. Otherwise: the unsubmitted checks in the period so far. */
const checksLabel = (b: MachineBreakdown) =>
  b.status === 'APPROVED'
    ? `${b.excusedCount} excused`
    : b.status === 'PENDING'
      ? `${b.affectedCount} to excuse`
      : '—'

/**
 * Machine Breakdowns: reports workers make in the app when a machine breaks down during their shift.
 * From the report, "check due" alerts for that machine stop; nothing else changes until a decision.
 * Approving excuses the worker's unsubmitted checks on that machine until the end of their shift
 * (they leave the score); rejecting leaves them as they are. Managers see their department's workers.
 */
export const BreakdownsPage: React.FC<{ onCountsChange?: () => void }> = ({ onCountsChange }) => {
  const { can } = useAuth()
  const canApprove = can('breakdowns', 'approve')
  const [status, setStatus] = useState<StatusFilter>('PENDING')
  const [q, setQ] = useState('')
  const [viewing, setViewing] = useState<MachineBreakdown | null>(null)
  const [deciding, setDeciding] = useState<{ breakdown: MachineBreakdown; approve: boolean } | null>(null)

  const list = useApi<MachineBreakdown[]>('/api/breakdowns', status === 'ALL' ? undefined : { status })
  const all = useApi<MachineBreakdown[]>('/api/breakdowns')

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase()
    const data = list.data ?? []
    if (!term) return data
    return data.filter((b) => [b.workerName, b.workerEmployeeId, b.machineName, b.machineCode, b.reason, b.code].some((v) => v?.toLowerCase().includes(term)))
  }, [list.data, q])

  const kpi = useMemo(() => {
    const data = all.data ?? []
    return {
      pending: data.filter((b) => b.status === 'PENDING').length,
      approved: data.filter((b) => b.status === 'APPROVED').length,
      excused: data.reduce((n, b) => n + b.excusedCount, 0)
    }
  }, [all.data])

  const refresh = () => {
    list.reload()
    all.reload()
    onCountsChange?.()
  }

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<Wrench className="w-4.5 h-4.5" />}
        title="Machine Breakdowns"
        description="Approve or reject breakdowns workers report during their shift"
        info="From the moment a worker reports a breakdown, “check due” alerts for that machine stop. The checks stay as they are until you decide. Approving excuses the worker’s unsubmitted checks on that machine from the report until the end of their shift: they show as Excused with your reason and do not count in the score. Rejecting leaves them as they are, so missed checks count. Managers see their department’s workers."
      />

      {all.data && (
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
          <StatCard label="Waiting for a decision" value={kpi.pending} icon={<Timer className="w-4 h-4" />} tone={kpi.pending ? 'due' : 'neutral'} onClick={() => setStatus('PENDING')} />
          <StatCard label="Approved" value={kpi.approved} icon={<CheckCircle2 className="w-4 h-4" />} tone="success" onClick={() => setStatus('APPROVED')} />
          <StatCard label="Checks excused" value={kpi.excused} icon={<Wrench className="w-4 h-4" />} meta="Not counted in any score" />
        </div>
      )}

      <Card className="overflow-hidden">
        <Toolbar>
          <Segmented<StatusFilter>
            label="Filter by status"
            value={status}
            onChange={setStatus}
            options={[
              { value: 'PENDING', label: 'Waiting', count: kpi.pending || undefined },
              { value: 'APPROVED', label: 'Approved' },
              { value: 'REJECTED', label: 'Rejected' },
              { value: 'CANCELLED', label: 'Withdrawn' },
              { value: 'ALL', label: 'All' }
            ]}
          />
          <SearchInput value={q} onChange={setQ} label="Search by worker, machine or reason" placeholder="Worker, machine or reason…" />
          <ToolbarSpacer />
          <ResultCount shown={rows.length} noun={rows.length === 1 ? 'report' : 'reports'} />
        </Toolbar>

        <DataState loading={list.loading} error={list.error} onRetry={list.reload} flush>
          {rows.length === 0 ? (
            <EmptyState
              icon={<Inbox className="w-5 h-5" />}
              title={status === 'PENDING' && !q ? 'Nothing waiting for a decision' : 'No reports match'}
              hint={status === 'PENDING' && !q ? 'Breakdowns workers report in the app appear here.' : undefined}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table stack-sm">
                <thead>
                  <tr>
                    <th>Worker</th>
                    <th>Machine</th>
                    <th>Period</th>
                    <th>Reason</th>
                    <th className="num">Checks</th>
                    <th>Status</th>
                    <th className="text-right">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((b) => (
                    <tr key={b.id}>
                      <td>
                        <div className="font-semibold text-ink">{b.workerName}</div>
                        <div className="text-[13px] text-ink-muted">
                          {b.workerEmployeeId}
                          {b.shiftName ? ` · ${b.shiftName}` : ''}
                        </div>
                      </td>
                      <td>
                        <div className="text-ink">{b.machineName}</div>
                        <div className="text-[13px] text-ink-muted font-mono">{b.code}</div>
                      </td>
                      <td className="whitespace-nowrap tabular-nums text-ink-secondary">{period(b)}</td>
                      <td className="max-w-[300px]">
                        <div className="flex items-center gap-2.5 min-w-0">
                          {b.photoUrl && (
                            <img
                              src={mediaUrl(b.photoUrl)}
                              alt={`Breakdown photo of ${b.machineName}`}
                              loading="lazy"
                              className="w-10 h-10 shrink-0 rounded-md object-cover ring-1 ring-line bg-subtle"
                            />
                          )}
                          <span className="line-clamp-2 text-ink-secondary" title={b.reason}>
                            {b.reason}
                          </span>
                        </div>
                      </td>
                      <td className="num whitespace-nowrap">{checksLabel(b)}</td>
                      <td className="whitespace-nowrap">
                        <BreakdownStatusPill status={b.status} />
                        {b.decidedByName && <div className="text-[12.5px] text-ink-muted mt-0.5">by {b.decidedByName}</div>}
                      </td>
                      <td className="text-right whitespace-nowrap" data-label="">
                        <div className="inline-flex items-center gap-0.5">
                          <IconButton label={`Review ${b.workerName}'s breakdown report`} onClick={() => setViewing(b)}>
                            <Eye className="w-3.5 h-3.5" />
                          </IconButton>
                          {b.status === 'PENDING' && canApprove && (
                            <>
                              <IconButton label={`Approve ${b.workerName}'s breakdown report`} onClick={() => setDeciding({ breakdown: b, approve: true })} className="hover:!text-success hover:!bg-success-bg">
                                <Check className="w-4 h-4" />
                              </IconButton>
                              <IconButton label={`Reject ${b.workerName}'s breakdown report`} tone="danger" onClick={() => setDeciding({ breakdown: b, approve: false })}>
                                <X className="w-4 h-4" />
                              </IconButton>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </DataState>
      </Card>

      {viewing && (
        <ReviewModal
          breakdown={viewing}
          canApprove={canApprove}
          onClose={() => setViewing(null)}
          onDecide={(approve) => {
            setDeciding({ breakdown: viewing, approve })
            setViewing(null)
          }}
        />
      )}
      {deciding && (
        <DecisionModal
          breakdown={deciding.breakdown}
          approve={deciding.approve}
          onClose={() => setDeciding(null)}
          onDone={() => {
            setDeciding(null)
            refresh()
          }}
        />
      )}
    </div>
  )
}

/** The report, and the worker's checks on that machine in its period (what approving excuses). */
const ReviewModal: React.FC<{ breakdown: MachineBreakdown; canApprove: boolean; onClose: () => void; onDecide: (approve: boolean) => void }> = ({
  breakdown: b,
  canApprove,
  onClose,
  onDecide
}) => {
  const detail = useApi<{ breakdown: MachineBreakdown; checks: BreakdownCheck[] }>(`/api/breakdowns/${b.id}`)
  const d = detail.data?.breakdown ?? b
  const checks = detail.data?.checks ?? []
  const pending = d.status === 'PENDING'
  const excusable = checks.filter((c) => !c.submittedAt && c.status !== 'EXCUSED' && c.status !== 'COMPLETED' && c.status !== 'EXCEPTION').length
  return (
    <Modal
      isOpen
      onClose={onClose}
      title="Machine breakdown"
      subtitle={`${d.workerName} · ${d.machineName} · ${d.code}`}
      maxWidth="lg"
      footer={
        pending && canApprove ? (
          <>
            <Button size="sm" variant="outline" onClick={onClose}>
              Close
            </Button>
            <Button size="sm" variant="danger" icon={<XCircle className="w-3.5 h-3.5" />} onClick={() => onDecide(false)}>
              Reject
            </Button>
            <Button size="sm" variant="primary" icon={<CheckCircle2 className="w-3.5 h-3.5" />} onClick={() => onDecide(true)}>
              Approve
            </Button>
          </>
        ) : (
          <Button size="sm" variant="outline" onClick={onClose}>
            Close
          </Button>
        )
      }
    >
      <div className="space-y-4">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[14px]">
          <dt className="text-ink-muted">Status</dt>
          <dd>
            <BreakdownStatusPill status={d.status} />
          </dd>
          <dt className="text-ink-muted">Reported</dt>
          <dd className="text-ink tabular-nums">{formatDateTime(d.startedAt)}</dd>
          <dt className="text-ink-muted">Period</dt>
          <dd className="text-ink tabular-nums">
            {period(d)}
            {d.shiftName ? <span className="text-ink-muted"> (end of {d.shiftName})</span> : null}
          </dd>
          <dt className="text-ink-muted">Reason</dt>
          <dd className="text-ink">{d.reason}</dd>
          {d.remark && (
            <>
              <dt className="text-ink-muted">Remark</dt>
              <dd className="text-ink-secondary">{d.remark}</dd>
            </>
          )}
          {d.decidedAt && (
            <>
              <dt className="text-ink-muted">{d.status === 'APPROVED' ? 'Approved' : 'Rejected'}</dt>
              <dd className="text-ink-secondary">
                {d.decidedByName}, {formatDateTime(d.decidedAt)}
                {d.decisionComment ? <div className="text-ink mt-0.5">“{d.decisionComment}”</div> : null}
              </dd>
            </>
          )}
        </dl>

        <div>
          <div className="flex items-center gap-1.5 text-[14px] font-semibold text-ink mb-1.5">
            <Camera className="w-4 h-4 text-ink-muted" aria-hidden />
            Photo of the breakdown
          </div>
          {d.photoUrl ? (
            <a href={mediaUrl(d.photoUrl)} target="_blank" rel="noreferrer" className="block w-fit" title="Open the photo full size">
              <img src={mediaUrl(d.photoUrl)} alt={`Breakdown photo of ${d.machineName}`} className="max-h-72 max-w-full rounded-md ring-1 ring-line object-contain bg-subtle" />
            </a>
          ) : (
            <p className="text-[13.5px] text-ink-muted">No photo (reported before photos were required).</p>
          )}
        </div>

        <div>
          <div className="flex items-baseline justify-between gap-2 mb-1.5">
            <h3 className="text-[14px] font-semibold text-ink">Checks on this machine in the period</h3>
            {pending && <span className="text-[13px] text-ink-muted">Approving excuses {excusable} now</span>}
          </div>
          <DataState loading={detail.loading} error={detail.error} onRetry={detail.reload}>
            {checks.length === 0 ? (
              <p className="text-[13.5px] text-ink-muted">No checks in this period yet. Checks created later in an approved period are excused as they appear.</p>
            ) : (
              <div className="rounded-md border border-line overflow-x-auto">
                <table className="data-table">
                  <thead>
                    <tr>
                      {/* Phones: the check type and time identify the check; the code is on wider screens. */}
                      <th className="hidden sm:table-cell">Check</th>
                      <th>Check type</th>
                      <th>Due</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {checks.map((c) => (
                      <tr key={c.id}>
                        <td className="hidden sm:table-cell font-mono text-[13px] whitespace-nowrap">{c.code}</td>
                        <td>{c.activityName}</td>
                        <td className="whitespace-nowrap tabular-nums">{formatTime(c.scheduledAt)}</td>
                        <td>
                          <CheckStatusBadge status={c.status} size="sm" />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </DataState>
          <p className="mt-2 text-[13px] text-ink-muted">Completed checks and exceptions are kept as they are.</p>
        </div>
      </div>
    </Modal>
  )
}

/** Approve or reject, always with a reason: it is kept on the report and on every check it excuses. */
const DecisionModal: React.FC<{ breakdown: MachineBreakdown; approve: boolean; onClose: () => void; onDone: () => void }> = ({ breakdown: b, approve, onClose, onDone }) => {
  const notify = useToast()
  const [comment, setComment] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const submit = async (e: React.SyntheticEvent) => {
    e.preventDefault()
    if (comment.trim().length < 3) return setError(approve ? 'Write the reason for approving; it is kept with every excused check.' : 'Write the reason for the rejection; the worker receives it.')
    setSaving(true)
    setError(null)
    try {
      const res = await api.post<{ breakdown: MachineBreakdown; excused: number }>(`/api/breakdowns/${b.id}/decision`, { approve, comment: comment.trim() })
      notify(
        'success',
        approve ? 'Breakdown approved' : 'Breakdown rejected',
        approve ? `${b.workerName} · ${b.machineName}: ${res.excused} check${res.excused === 1 ? '' : 's'} excused` : `${b.workerName} · ${b.machineName}: checks count as usual`
      )
      onDone()
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
      title={approve ? 'Approve breakdown' : 'Reject breakdown'}
      subtitle={`${b.workerName} · ${b.machineName} · ${period(b)}`}
      footer={
        <>
          <Button size="sm" variant="outline" onClick={onClose} disabled={saving}>
            Back
          </Button>
          <Button size="sm" variant={approve ? 'primary' : 'danger'} type="submit" form="breakdown-decision" loading={saving}>
            {approve ? 'Approve' : 'Reject'}
          </Button>
        </>
      }
    >
      <form id="breakdown-decision" onSubmit={submit} className="space-y-3">
        <FormError message={error} />
        <p className="text-[14px] text-ink-secondary">
          {approve
            ? `${b.workerName}’s unsubmitted checks on ${b.machineName} until ${formatTime(b.endsAt)} become Excused and do not count in the score. Checks already completed are kept.`
            : `Nothing changes: missed checks in this period count as usual, and alerts for ${b.machineName} resume.`}
        </p>
        <Field label={approve ? 'Reason for approving' : 'Reason for rejection'} required hint="Sent to the worker and kept in the audit log, with every excused check.">
          <TextArea value={comment} onChange={(e) => setComment(e.target.value)} rows={3} maxLength={500} autoFocus placeholder={approve ? 'e.g. Main motor tripped, confirmed by maintenance' : 'e.g. Machine was running at 2:30 AM'} />
        </Field>
      </form>
    </Modal>
  )
}
