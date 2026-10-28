import React, { useEffect, useMemo, useState } from 'react'
import { CalendarCheck, Check, Download, Eye, Inbox, Paperclip, X } from 'lucide-react'
import type { Department, LeavePendingCount, LeaveRequest, LeaveStatus, LeaveType, ShiftChangeRequest } from '../../../types'
import { api, errorText } from '../../../lib/api'
import { useApi } from '../../../lib/useApi'
import { useAuth } from '../../../lib/auth'
import { downloadCsv, formatDateKey, formatDateTime } from '../../../lib/format'
import { ConfirmModal } from '../../../components/common/ConfirmModal'
import { DataState } from '../../../components/common/DataState'
import { DateInput } from '../../../components/common/DateTimeInputs'
import { Select } from '../../../components/common/Form'
import { PageHeader } from '../../../components/common/PageHeader'
import { Button } from '../../../components/common/Button'
import { useToast } from '../../../components/common/Toast'
import { Card, EmptyState } from '../../../components/ui/Card'
import { Pill } from '../../../components/ui/Chips'
import { StatCard } from '../../../components/ui/StatCard'
import { IconButton, ResultCount, SearchInput, Segmented, Toolbar, ToolbarSpacer } from '../../../components/ui/Toolbar'
import {
  type AnyRequest,
  type RequestKind,
  DecisionModal,
  KindIcon,
  LeaveStatusBadge,
  RequestDetailModal,
  STATUS_LABEL,
  dateRange,
  daysLabel,
  isLeave,
  requestPath,
  shiftTime
} from './shared'

type StatusFilter = LeaveStatus | 'ALL'
type TypeFilter = 'ALL' | RequestKind

const kindOf = (r: AnyRequest): RequestKind => (isLeave(r) ? 'leave' : 'shift')

/**
 * Approvals and All Requests: leave and shift change requests in one list, newest first, with
 * filters. Approvals opens on Pending; All Requests on everything, with CSV export.
 */
export const LeaveRequestsPage: React.FC<{ mode: 'approval' | 'all'; onCountsChange?: () => void }> = ({ mode, onCountsChange }) => {
  const { can } = useAuth()
  const notify = useToast()
  const canApprove = can('leave', 'approve')
  const canCancel = can('leave', 'edit')
  const canExport = can('leave', 'export')

  const [status, setStatus] = useState<StatusFilter>(mode === 'approval' ? 'PENDING' : 'ALL')
  const [type, setType] = useState<TypeFilter>('ALL')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [q, setQ] = useState('')
  const [search, setSearch] = useState('')
  const [departmentId, setDepartmentId] = useState('')
  const [leaveTypeId, setLeaveTypeId] = useState('')

  // The search is sent once typing pauses.
  useEffect(() => {
    const t = setTimeout(() => setSearch(q.trim()), 300)
    return () => clearTimeout(t)
  }, [q])

  const query = { status: status === 'ALL' ? undefined : status, from: from || undefined, to: to || undefined, q: search || undefined, departmentId: departmentId || undefined }
  // A leave type filter is about leave only, so it leaves the shift changes out.
  const showLeave = type !== 'shift'
  const showShift = type !== 'leave' && !leaveTypeId
  const leaveList = useApi<LeaveRequest[]>(showLeave ? requestPath('leave') : null, { ...query, leaveTypeId: leaveTypeId || undefined })
  const shiftList = useApi<ShiftChangeRequest[]>(showShift ? requestPath('shift') : null, query)
  const counts = useApi<LeavePendingCount>('/api/leave/pending-count')
  const departments = useApi<Department[]>('/api/departments')
  const types = useApi<LeaveType[]>('/api/leave/types')

  const reload = () => {
    if (showLeave) leaveList.reload()
    if (showShift) shiftList.reload()
    counts.reload()
  }
  // New requests arrive from the worker app: refresh every 30 seconds.
  const reloadRef = React.useRef(reload)
  reloadRef.current = reload
  useEffect(() => {
    const t = setInterval(() => reloadRef.current(), 30_000)
    return () => clearInterval(t)
  }, [])

  const [viewing, setViewing] = useState<AnyRequest | null>(null)
  const [deciding, setDeciding] = useState<{ request: AnyRequest; approve: boolean } | null>(null)
  const [cancelling, setCancelling] = useState<AnyRequest | null>(null)

  const rows = useMemo<AnyRequest[]>(
    () => [...(showLeave ? (leaveList.data ?? []) : []), ...(showShift ? (shiftList.data ?? []) : [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [leaveList.data, shiftList.data, showLeave, showShift]
  )
  const loading = (showLeave && leaveList.loading && !leaveList.data) || (showShift && shiftList.loading && !shiftList.data)
  const error = (showLeave && leaveList.error) || (showShift && shiftList.error) || null

  const refreshAll = () => {
    reload()
    onCountsChange?.()
  }

  const cancel = async () => {
    if (!cancelling) return
    try {
      await api.post(`${requestPath(kindOf(cancelling))}/${cancelling.id}/cancel`)
      notify('success', 'Request cancelled', `${cancelling.workerName}: ${dateRange(cancelling.startDate, cancelling.endDate)}`)
      setViewing(null)
      refreshAll()
    } catch (err) {
      notify('error', 'Could not cancel', errorText(err))
    }
  }

  const exportCsv = () => {
    downloadCsv(
      `leave-and-shift-requests_${formatDateKey(new Date().toISOString().slice(0, 10)).replace(/\//g, '-')}.csv`,
      ['Request', 'Employee ID', 'Employee', 'Designation', 'Department', 'Leave type / requested shift', 'Duration', 'Paid', 'From', 'To', 'Days', 'Reason', 'Status', 'Applied', 'Decided by', 'Decided at', 'Remarks'],
      rows.map((r) => [
        isLeave(r) ? 'Leave' : 'Shift change',
        r.workerEmployeeId,
        r.workerName,
        r.workerDesignation,
        r.departmentName,
        isLeave(r) ? r.leaveTypeName : `${r.currentShiftName ?? '—'} → ${r.requestedShiftName}`,
        isLeave(r) ? r.dayPartLabel : shiftTime(r.requestedShiftTime),
        isLeave(r) ? (r.isPaid ? 'Yes' : 'No') : '',
        formatDateKey(r.startDate),
        formatDateKey(r.endDate),
        isLeave(r) ? r.days : '',
        r.reason,
        STATUS_LABEL[r.status],
        formatDateTime(r.createdAt),
        r.decidedByName,
        r.decidedAt ? formatDateTime(r.decidedAt) : '',
        r.decisionComment
      ])
    )
  }

  const filtered = !!(from || to || search || departmentId || leaveTypeId)
  const resetFilters = () => {
    setFrom('')
    setTo('')
    setQ('')
    setDepartmentId('')
    setLeaveTypeId('')
  }

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<CalendarCheck className="w-4.5 h-4.5" />}
        title={mode === 'approval' ? 'Approvals' : 'All Requests'}
        description={mode === 'approval' ? 'Approve or reject leave and shift change requests from the worker app' : 'Every leave and shift change request, with its decision'}
        info="Approved leave removes the worker’s checks for those days (half a day: that half of the shift). An approved shift change moves the worker’s checks and sign-in to the requested shift on those dates. The worker gets an email (when their account has one) and a notification in the app."
        actions={
          mode === 'all' && canExport ? (
            <Button size="sm" variant="outline" icon={<Download className="w-3.5 h-3.5" />} onClick={exportCsv} disabled={!rows.length}>
              Export CSV
            </Button>
          ) : undefined
        }
      />

      {mode === 'approval' && counts.data && (
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
          <StatCard label="Leave pending" value={counts.data.leave} icon={<KindIcon kind="leave" className="w-4 h-4" />} tone={counts.data.leave ? 'due' : 'neutral'} onClick={() => setType('leave')} />
          <StatCard label="Shift changes pending" value={counts.data.shiftChanges} icon={<KindIcon kind="shift" className="w-4 h-4" />} tone={counts.data.shiftChanges ? 'due' : 'neutral'} onClick={() => setType('shift')} />
        </div>
      )}

      <Card className="overflow-hidden">
        <Toolbar>
          <Segmented<StatusFilter>
            label="Filter by status"
            value={status}
            onChange={setStatus}
            options={[
              { value: 'PENDING', label: 'Pending' },
              { value: 'APPROVED', label: 'Approved' },
              { value: 'REJECTED', label: 'Rejected' },
              { value: 'CANCELLED', label: 'Cancelled' },
              { value: 'ALL', label: 'All' }
            ]}
          />
          <Segmented<TypeFilter>
            label="Filter by request type"
            value={type}
            onChange={(v) => {
              setType(v)
              if (v === 'shift') setLeaveTypeId('')
            }}
            options={[
              { value: 'ALL', label: 'All types' },
              { value: 'leave', label: 'Leave' },
              { value: 'shift', label: 'Shift change' }
            ]}
          />
          <SearchInput value={q} onChange={setQ} label="Search by employee or reason" placeholder="Employee, ID or reason…" />
          <ToolbarSpacer />
          <ResultCount shown={rows.length} noun={rows.length === 1 ? 'request' : 'requests'} />
        </Toolbar>
        <div className="px-3 sm:px-4 py-2.5 border-b border-line grid grid-cols-2 sm:flex sm:flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-[12px] text-ink-muted col-span-1">
            <span className="shrink-0">From</span>
            <DateInput value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From date" className="w-full sm:w-36" />
          </label>
          <label className="flex items-center gap-1.5 text-[12px] text-ink-muted col-span-1">
            <span className="shrink-0">To</span>
            <DateInput value={to} onChange={(e) => setTo(e.target.value)} aria-label="To date" className="w-full sm:w-36" />
          </label>
          <Select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} aria-label="Department" className="sm:w-44">
            <option value="">All departments</option>
            {(departments.data ?? []).map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Select>
          {type !== 'shift' && (
            <Select value={leaveTypeId} onChange={(e) => setLeaveTypeId(e.target.value)} aria-label="Leave type" className="sm:w-44">
              <option value="">All leave types</option>
              {(types.data ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          )}
          {filtered && (
            <Button size="sm" variant="ghost" onClick={resetFilters}>
              Clear filters
            </Button>
          )}
        </div>

        <DataState loading={loading} error={error} onRetry={reload} flush>
          {rows.length === 0 ? (
            <EmptyState
              icon={<Inbox className="w-5 h-5" />}
              title={status === 'PENDING' && !filtered && type === 'ALL' ? 'Nothing waiting for a decision' : 'No requests match the filters'}
              hint={status === 'PENDING' && !filtered && type === 'ALL' ? 'New leave and shift change requests from the worker app appear here.' : undefined}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table stack-sm">
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Request</th>
                    <th>Dates</th>
                    <th className="num">Days</th>
                    <th>Reason</th>
                    <th>Applied</th>
                    <th>Status</th>
                    <th className="text-right">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={`${kindOf(r)}-${r.id}`}>
                      <td>
                        <div className="font-semibold text-ink">{r.workerName}</div>
                        <div className="text-[11.5px] text-ink-muted">
                          {r.workerEmployeeId}
                          {r.departmentName ? ` · ${r.departmentName}` : ''}
                        </div>
                      </td>
                      <td>
                        {isLeave(r) ? (
                          <>
                            <div className="flex items-center gap-1.5 text-ink">
                              <Pill className="bg-accent-soft text-accent-strong ring-accent-line">Leave</Pill>
                              {r.leaveTypeName}
                            </div>
                            <div className="text-[11.5px] text-ink-muted mt-0.5">
                              {r.dayPartLabel}
                              {r.isPaid ? '' : ' · Unpaid'}
                            </div>
                          </>
                        ) : (
                          <>
                            <div className="flex items-center gap-1.5 text-ink">
                              <Pill className="bg-due-bg text-due ring-due-line">Shift change</Pill>
                              <span>
                                {r.currentShiftName ?? '—'} → <span className="font-semibold">{r.requestedShiftName}</span>
                              </span>
                            </div>
                            <div className="text-[11.5px] text-ink-muted mt-0.5">{shiftTime(r.requestedShiftTime)}</div>
                          </>
                        )}
                      </td>
                      <td className="whitespace-nowrap tabular-nums">{dateRange(r.startDate, r.endDate)}</td>
                      <td className="num whitespace-nowrap">{isLeave(r) ? daysLabel(r.days) : '—'}</td>
                      <td className="max-w-[260px]">
                        <span className="line-clamp-2 text-ink-secondary" title={r.reason}>
                          {r.hasAttachment && <Paperclip className="inline w-3 h-3 mr-1 text-ink-muted" aria-label="Has a document" />}
                          {r.reason}
                        </span>
                      </td>
                      <td className="whitespace-nowrap text-ink-secondary">{formatDateTime(r.createdAt)}</td>
                      <td className="whitespace-nowrap">
                        <LeaveStatusBadge status={r.status} />
                        {r.decidedByName && <div className="text-[11px] text-ink-muted mt-0.5">by {r.decidedByName}</div>}
                      </td>
                      <td className="text-right whitespace-nowrap" data-label="">
                        <div className="inline-flex items-center gap-0.5">
                          <IconButton label={`View ${r.workerName}'s request`} onClick={() => setViewing(r)}>
                            <Eye className="w-3.5 h-3.5" />
                          </IconButton>
                          {r.status === 'PENDING' && canApprove && (
                            <>
                              <IconButton label={`Approve ${r.workerName}'s request`} onClick={() => setDeciding({ request: r, approve: true })} className="hover:!text-success hover:!bg-success-bg">
                                <Check className="w-4 h-4" />
                              </IconButton>
                              <IconButton label={`Reject ${r.workerName}'s request`} tone="danger" onClick={() => setDeciding({ request: r, approve: false })}>
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

      <RequestDetailModal
        kind={viewing ? kindOf(viewing) : 'leave'}
        request={viewing}
        onClose={() => setViewing(null)}
        canApprove={canApprove}
        canCancel={canCancel}
        onDecide={(approve) => viewing && setDeciding({ request: viewing, approve })}
        onCancelRequest={() => setCancelling(viewing)}
      />
      {deciding && (
        <DecisionModal
          kind={kindOf(deciding.request)}
          request={deciding.request}
          approve={deciding.approve}
          onClose={() => setDeciding(null)}
          onDone={() => {
            setDeciding(null)
            setViewing(null)
            refreshAll()
          }}
        />
      )}
      <ConfirmModal
        isOpen={cancelling !== null}
        title="Cancel request"
        danger
        confirmLabel="Cancel request"
        message={
          <>
            Cancel <span className="font-semibold text-ink">{cancelling?.workerName}</span>’s {cancelling && isLeave(cancelling) ? 'leave' : 'shift change'} for {cancelling ? dateRange(cancelling.startDate, cancelling.endDate) : ''}?
            {cancelling?.status === 'APPROVED' && ' It was approved: the worker’s checks for those days are planned again.'}
          </>
        }
        onConfirm={cancel}
        onClose={() => setCancelling(null)}
      />
    </div>
  )
}
