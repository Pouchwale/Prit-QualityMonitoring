import React, { useState } from 'react'
import { CalendarDays, Check, Clock3, FileText, Paperclip, X } from 'lucide-react'
import type { LeaveRequest, LeaveStatus, ShiftChangeRequest } from '../../../types'
import { api, errorText, fetchBlob } from '../../../lib/api'
import { formatClockRange, formatDateKey, formatDateTime } from '../../../lib/format'
import { Button } from '../../../components/common/Button'
import { Field, FormError, TextArea } from '../../../components/common/Form'
import { Modal } from '../../../components/common/Modal'
import { useToast } from '../../../components/common/Toast'
import { Pill } from '../../../components/ui/Chips'

/** Leave Management pages of the admin panel (backend routes/leave.ts). */

export type RequestKind = 'leave' | 'shift'
export type AnyRequest = LeaveRequest | ShiftChangeRequest

export const isLeave = (r: AnyRequest): r is LeaveRequest => 'leaveTypeId' in r

/** The API path of a kind of request. */
export const requestPath = (kind: RequestKind) => (kind === 'leave' ? '/api/leave/requests' : '/api/leave/shift-changes')

export const STATUS_LABEL: Record<LeaveStatus, string> = { PENDING: 'Pending', APPROVED: 'Approved', REJECTED: 'Rejected', CANCELLED: 'Cancelled' }

const STATUS_TONE: Record<LeaveStatus, string> = {
  PENDING: 'bg-due-bg text-due ring-due-line',
  APPROVED: 'bg-success-bg text-success ring-success-line',
  REJECTED: 'bg-missed-bg text-failed ring-failed-line',
  CANCELLED: 'bg-subtle text-ink-muted ring-line'
}

export const LeaveStatusBadge: React.FC<{ status: LeaveStatus }> = ({ status }) => <Pill className={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Pill>

export const dateRange = (start: string, end: string) => (start === end ? formatDateKey(start) : `${formatDateKey(start)} – ${formatDateKey(end)}`)

export const daysLabel = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`

/** "08:00–16:00" as "08:00 – 16:00" in the panel's clock format. */
export const shiftTime = (range: string | null) => {
  if (!range) return ''
  const [a, b] = range.split('–')
  return formatClockRange(a, b)
}

/** Opens a request's document (PDF or photo) in a new tab; it needs the signed-in user's token. */
export async function openAttachment(kind: RequestKind, id: string) {
  // Opened first, synchronously, so the browser does not block it as a popup.
  const tab = window.open('', '_blank')
  try {
    const blob = await fetchBlob(`/api/leave/attachment/${kind}/${id}`)
    const url = URL.createObjectURL(blob)
    if (tab) tab.location.href = url
    else window.location.href = url
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  } catch (err) {
    tab?.close()
    throw err
  }
}

const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="grid grid-cols-[130px_1fr] gap-3 py-2 border-b border-line last:border-0 text-[13px]">
    <dt className="text-ink-muted">{label}</dt>
    <dd className="text-ink min-w-0 break-words">{children}</dd>
  </div>
)

/** Everything about one request, with Approve / Reject (approve permission) and Cancel (edit permission). */
export const RequestDetailModal: React.FC<{
  kind: RequestKind
  request: AnyRequest | null
  onClose: () => void
  canApprove: boolean
  canCancel: boolean
  onDecide: (approve: boolean) => void
  onCancelRequest: () => void
}> = ({ kind, request: r, onClose, canApprove, canCancel, onDecide, onCancelRequest }) => {
  const notify = useToast()
  if (!r) return null
  const pending = r.status === 'PENDING'
  const cancellable = canCancel && (pending || r.status === 'APPROVED')
  return (
    <Modal
      isOpen
      onClose={onClose}
      title={kind === 'leave' ? 'Leave Request' : 'Shift Change Request'}
      subtitle={`${r.workerName} · ${r.workerEmployeeId}`}
      maxWidth="lg"
      footer={
        <>
          {cancellable && (
            <Button size="sm" variant="ghost" onClick={onCancelRequest} className="mr-auto">
              Cancel request
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={onClose}>
            Close
          </Button>
          {pending && canApprove && (
            <>
              <Button size="sm" variant="danger" icon={<X className="w-3.5 h-3.5" />} onClick={() => onDecide(false)}>
                Reject
              </Button>
              <Button size="sm" variant="primary" icon={<Check className="w-3.5 h-3.5" />} onClick={() => onDecide(true)}>
                Approve
              </Button>
            </>
          )}
        </>
      }
    >
      <dl>
        <Row label="Status">
          <LeaveStatusBadge status={r.status} />
        </Row>
        <Row label="Employee">
          {r.workerName} <span className="text-ink-muted">({r.workerEmployeeId})</span>
        </Row>
        {(r.workerDesignation || r.departmentName) && <Row label="Designation">{[r.workerDesignation, r.departmentName].filter(Boolean).join(' · ')}</Row>}
        {isLeave(r) ? (
          <>
            <Row label="Leave type">
              {r.leaveTypeName} <span className="text-ink-muted">({r.leaveTypeCode}{r.isPaid ? '' : ', unpaid'})</span>
            </Row>
            <Row label="Dates">{dateRange(r.startDate, r.endDate)}</Row>
            <Row label="Duration">
              {r.dayPartLabel} · <span className="font-semibold">{daysLabel(r.days)}</span>
            </Row>
          </>
        ) : (
          <>
            <Row label="Current shift">{r.currentShiftName ? `${r.currentShiftName} (${shiftTime(r.currentShiftTime)})` : '—'}</Row>
            <Row label="Requested shift">
              <span className="font-semibold">{r.requestedShiftName}</span> ({shiftTime(r.requestedShiftTime)})
            </Row>
            <Row label="Dates">{dateRange(r.startDate, r.endDate)}</Row>
          </>
        )}
        <Row label="Reason">
          <span className="whitespace-pre-wrap">{r.reason}</span>
        </Row>
        {r.hasAttachment && (
          <Row label="Document">
            <button
              type="button"
              className="inline-flex items-center gap-1.5 text-accent font-medium hover:underline"
              onClick={() => openAttachment(kind, r.id).catch((err) => notify('error', 'Could not open the document', errorText(err)))}
            >
              <Paperclip className="w-3.5 h-3.5" aria-hidden />
              {r.attachmentName ?? 'Open document'}
            </button>
          </Row>
        )}
        <Row label="Applied">{formatDateTime(r.createdAt)}</Row>
        {r.decidedAt && (
          <Row label={r.status === 'REJECTED' ? 'Rejected by' : 'Approved by'}>
            {r.decidedByName ?? '—'} <span className="text-ink-muted">· {formatDateTime(r.decidedAt)}</span>
          </Row>
        )}
        {r.decisionComment && (
          <Row label="Remarks">
            <span className="whitespace-pre-wrap">{r.decisionComment}</span>
          </Row>
        )}
        {r.cancelledAt && <Row label="Cancelled">{formatDateTime(r.cancelledAt)}</Row>}
      </dl>
    </Modal>
  )
}

/** Approve or reject with remarks; a rejection needs a reason, which the worker receives. */
export const DecisionModal: React.FC<{
  kind: RequestKind
  request: AnyRequest | null
  approve: boolean
  onClose: () => void
  onDone: (saved: AnyRequest) => void
}> = ({ kind, request: r, approve, onClose, onDone }) => {
  const notify = useToast()
  const [comment, setComment] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  if (!r) return null
  const submit = async (e: React.SyntheticEvent) => {
    e.preventDefault()
    if (!approve && comment.trim().length < 3) return setError('Write the reason for the rejection; the worker receives it.')
    setSaving(true)
    setError(null)
    try {
      const saved = await api.post<AnyRequest>(`${requestPath(kind)}/${r.id}/decision`, { approve, comment: comment.trim() || undefined })
      notify('success', approve ? 'Approved' : 'Rejected', `${r.workerName}: ${kind === 'leave' ? 'leave' : 'shift change'} ${dateRange(r.startDate, r.endDate)}`)
      setComment('')
      onDone(saved)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setSaving(false)
    }
  }
  const what = kind === 'leave' && isLeave(r) ? `${r.leaveTypeName}, ${daysLabel(r.days)}` : !isLeave(r) ? `to ${r.requestedShiftName}` : ''
  return (
    <Modal
      isOpen
      onClose={onClose}
      title={`${approve ? 'Approve' : 'Reject'} ${kind === 'leave' ? 'leave' : 'shift change'}`}
      subtitle={`${r.workerName} · ${dateRange(r.startDate, r.endDate)} · ${what}`}
      footer={
        <>
          <Button size="sm" variant="outline" onClick={onClose} disabled={saving}>
            Back
          </Button>
          <Button size="sm" variant={approve ? 'primary' : 'danger'} type="submit" form="leave-decision" loading={saving}>
            {approve ? 'Approve' : 'Reject'}
          </Button>
        </>
      }
    >
      <form id="leave-decision" onSubmit={submit} className="space-y-3">
        <FormError message={error} />
        <Field label={approve ? 'Remarks (optional)' : 'Reason for rejection'} required={!approve} hint="Included in the email to the worker and kept in the audit log.">
          <TextArea value={comment} onChange={(e) => setComment(e.target.value)} rows={3} maxLength={1000} autoFocus />
        </Field>
      </form>
    </Modal>
  )
}

export const KindIcon: React.FC<{ kind: RequestKind; className?: string }> = ({ kind, className = 'w-4.5 h-4.5' }) =>
  kind === 'leave' ? <CalendarDays className={className} /> : <Clock3 className={className} />

export const DocIcon = FileText
