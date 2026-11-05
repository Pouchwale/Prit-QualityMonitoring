import React, { useMemo, useState } from 'react'
import { AlarmClock, CheckCircle2, ClipboardX, Download, FileText, LogIn, LogOut, Timer, Users, X } from 'lucide-react'
import type { User } from '../../../types'
import { useApi } from '../../../lib/useApi'
import { download, errorText } from '../../../lib/api'
import { dateKey, downloadCsv, formatClock, formatDateKey, formatDateTime, formatTime } from '../../../lib/format'
import { Button } from '../../../components/common/Button'
import { DataState } from '../../../components/common/DataState'
import { DateInput } from '../../../components/common/DateTimeInputs'
import { Select } from '../../../components/common/Form'
import { useToast } from '../../../components/common/Toast'
import { Card, CardHeader, EmptyState } from '../../../components/ui/Card'
import { Pill } from '../../../components/ui/Chips'
import { StatCard } from '../../../components/ui/StatCard'
import { LeaveStatusBadge } from './shared'

type Kind = 'LATE_ENTRY' | 'EARLY_EXIT'
type Status = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED'

interface TimeRecord {
  id: string
  date: string
  kind: Kind
  typeName: string
  workerId: string
  workerName: string
  employeeId: string
  department: string | null
  requestedTime: string | null
  shiftTime: string | null
  minutes: number | null
  reason: string
  status: Status
  appliedAt: string
  decidedByName: string | null
  decidedAt: string | null
  decisionComment: string | null
  tasksRemoved: number | null
}

interface TimeWorker {
  workerId: string
  name: string
  employeeId: string
  department: string | null
  lateEntries: number
  earlyExits: number
  approved: number
  rejected: number
  pending: number
  cancelled: number
  lateMinutes: number
  earlyMinutes: number
  tasksExcused: number
}

interface TimeReport {
  from: string
  to: string
  worker: { id: string; name: string; employeeId: string } | null
  totals: { records: number; lateEntries: number; earlyExits: number; approved: number; rejected: number; pending: number; cancelled: number; lateMinutes: number; earlyMinutes: number; tasksExcused: number; workers: number }
  workers: TimeWorker[]
  records: TimeRecord[]
}

const duration = (m: number | null) => (m === null ? '—' : m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`)
const STATUS_TEXT: Record<Status, string> = { PENDING: 'Pending', APPROVED: 'Approved', REJECTED: 'Rejected', CANCELLED: 'Cancelled' }
const firstOfMonth = () => `${dateKey().slice(0, 8)}01`

/**
 * Late Entry & Early Exit records (GET /api/leave/time-report[.pdf]): every request in the chosen
 * dates, with the time entered, how late or early against the shift, the decision and the tasks it
 * excused; a summary per employee; CSV and PDF downloads.
 */
export const TimeRequestReport: React.FC<{ canExport: boolean }> = ({ canExport }) => {
  const [from, setFrom] = useState(firstOfMonth)
  const [to, setTo] = useState(() => dateKey())
  const [workerId, setWorkerId] = useState('')
  const [kind, setKind] = useState<'' | Kind>('')
  const [status, setStatus] = useState<'' | Status>('')
  const params = { from, to, workerId: workerId || undefined, kind: kind || undefined, status: status || undefined }
  const valid = !!from && !!to && from <= to
  const { data, error, loading, reload } = useApi<TimeReport>(valid ? '/api/leave/time-report' : null, params)
  const workers = useApi<User[]>('/api/users', { role: 'WORKER' })
  const [downloading, setDownloading] = useState(false)
  const notify = useToast()
  const filtered = !!(workerId || kind || status)

  const period = from === to ? formatDateKey(from) : `${formatDateKey(from)} – ${formatDateKey(to)}`
  const workerOptions = useMemo(() => {
    // Workers the user may not list (no Users permission) still come from the report itself.
    const list = (workers.data ?? []).map((w) => ({ id: w.id, label: `${w.name} (${w.employeeId})${w.isActive === false ? ' · disabled' : ''}` }))
    if (!list.length) for (const w of data?.workers ?? []) list.push({ id: w.workerId, label: `${w.name} (${w.employeeId})` })
    return list
  }, [workers.data, data])

  const downloadPdf = async () => {
    setDownloading(true)
    try {
      const name = await download('/api/leave/time-report.pdf', params, `Late-Entry-Early-Exit-Report-${from.replace(/-/g, '')}.pdf`)
      notify('success', 'Late Entry & Early Exit Report downloaded', name)
    } catch (err) {
      notify('error', 'Could not create the PDF', errorText(err))
    } finally {
      setDownloading(false)
    }
  }

  const exportCsv = () => {
    if (!data) return
    downloadCsv(
      `late-entry-early-exit_${from}_${to}.csv`,
      ['Date', 'Employee ID', 'Employee', 'Department', 'Type', 'Time', 'Shift start / end', 'Late / early by (min)', 'Reason', 'Status', 'Decided by', 'Decided at', 'Remarks', 'Tasks excused', 'Applied'],
      data.records.map((r) => [
        formatDateKey(r.date),
        r.employeeId,
        r.workerName,
        r.department,
        r.typeName,
        r.requestedTime ? formatClock(r.requestedTime) : '',
        r.shiftTime ?? '',
        r.minutes ?? '',
        r.reason,
        STATUS_TEXT[r.status],
        r.decidedByName,
        r.decidedAt ? formatDateTime(r.decidedAt) : '',
        r.decisionComment,
        r.status === 'APPROVED' ? (r.tasksRemoved ?? 0) : '',
        formatDateTime(r.appliedAt)
      ])
    )
  }

  const t = data?.totals

  return (
    <div className="space-y-5">
      <section className="card px-3 py-2.5 flex flex-wrap items-end gap-2.5" aria-label="Report filters">
        <label className="min-w-0 w-[calc(50%-5px)] sm:w-auto">
          <span className="block text-[12.5px] font-medium text-ink-muted mb-1">From</span>
          <DateInput value={from} max={to} onChange={(e) => setFrom(e.target.value)} className="sm:w-[150px]" />
        </label>
        <label className="min-w-0 w-[calc(50%-5px)] sm:w-auto">
          <span className="block text-[12.5px] font-medium text-ink-muted mb-1">To</span>
          <DateInput value={to} min={from} onChange={(e) => setTo(e.target.value)} className="sm:w-[150px]" />
        </label>
        <label className="min-w-0 flex-1 sm:flex-none">
          <span className="block text-[12.5px] font-medium text-ink-muted mb-1">Employee</span>
          <Select value={workerId} onChange={(e) => setWorkerId(e.target.value)} className="w-full sm:w-56">
            <option value="">All employees</option>
            {workerOptions.map((w) => (
              <option key={w.id} value={w.id}>
                {w.label}
              </option>
            ))}
          </Select>
        </label>
        <label className="min-w-0 w-[calc(50%-5px)] sm:w-auto">
          <span className="block text-[12.5px] font-medium text-ink-muted mb-1">Type</span>
          <Select value={kind} onChange={(e) => setKind(e.target.value as '' | Kind)} className="w-full sm:w-40">
            <option value="">Both</option>
            <option value="LATE_ENTRY">Late Entry</option>
            <option value="EARLY_EXIT">Early Exit</option>
          </Select>
        </label>
        <label className="min-w-0 w-[calc(50%-5px)] sm:w-auto">
          <span className="block text-[12.5px] font-medium text-ink-muted mb-1">Status</span>
          <Select value={status} onChange={(e) => setStatus(e.target.value as '' | Status)} className="w-full sm:w-36">
            <option value="">All</option>
            <option value="APPROVED">Approved</option>
            <option value="PENDING">Pending</option>
            <option value="REJECTED">Rejected</option>
            <option value="CANCELLED">Cancelled</option>
          </Select>
        </label>
        {filtered && (
          <Button
            size="field"
            variant="ghost"
            onClick={() => {
              setWorkerId('')
              setKind('')
              setStatus('')
            }}
            icon={<X className="w-3.5 h-3.5" />}
          >
            Clear
          </Button>
        )}
        {canExport && (
          <div className="flex gap-2 sm:ml-auto">
            <Button size="field" variant="outline" onClick={exportCsv} disabled={!data?.records.length} icon={<Download className="w-3.5 h-3.5" />}>
              CSV
            </Button>
            <Button size="field" variant="primary" onClick={downloadPdf} loading={downloading} disabled={!data} icon={<FileText className="w-3.5 h-3.5" />}>
              Download PDF
            </Button>
          </div>
        )}
        {!valid && <p className="basis-full text-[13px] text-missed">The start date must be on or before the end date.</p>}
      </section>

      {t && (
        <div className="grid grid-cols-2 lg:grid-cols-4 xl:grid-cols-6 gap-3">
          <StatCard label="Late entries" value={t.lateEntries} icon={<LogIn className="w-4 h-4" />} tone="accent" meta={period} />
          <StatCard label="Early exits" value={t.earlyExits} icon={<LogOut className="w-4 h-4" />} tone="accent" meta={`${t.workers} employee${t.workers === 1 ? '' : 's'}`} />
          <StatCard label="Approved" value={t.approved} icon={<CheckCircle2 className="w-4 h-4" />} tone="success" meta={`${t.rejected} rejected · ${t.pending} pending`} />
          <StatCard label="Approved late time" value={duration(t.lateMinutes)} icon={<AlarmClock className="w-4 h-4" />} meta="arrival less shift start" />
          <StatCard label="Approved early time" value={duration(t.earlyMinutes)} icon={<Timer className="w-4 h-4" />} meta="shift end less leaving" />
          <StatCard label="Tasks excused" value={t.tasksExcused} icon={<ClipboardX className="w-4 h-4" />} meta="by approved requests" />
        </div>
      )}

      <DataState loading={loading && !data} error={error} onRetry={reload} empty={data ? false : undefined}>
        {data && data.records.length === 0 ? (
          <Card>
            <EmptyState icon={<Users className="w-5 h-5" />} title="No Late Entry or Early Exit requests" hint={`Nothing in ${period}${filtered ? ' with these filters' : ''}.`} />
          </Card>
        ) : data ? (
          <>
            <Card className="overflow-hidden">
              <CardHeader icon={<Users className="w-4 h-4" />} title="Employee summary" subtitle="Time totals and tasks excused count approved requests only" />
              <div className="overflow-x-auto">
                <table className="data-table stack-sm">
                  <thead>
                    <tr>
                      <th>Employee</th>
                      <th className="num">Late entries</th>
                      <th className="num">Early exits</th>
                      <th className="num">Approved</th>
                      <th className="num">Rejected</th>
                      <th className="num">Pending</th>
                      <th className="num">Late time</th>
                      <th className="num">Early time</th>
                      <th className="num">Tasks excused</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {data.workers.map((w) => (
                      <tr key={w.workerId}>
                        <td>
                          <div className="font-semibold text-ink">{w.name}</div>
                          <div className="text-[13px] text-ink-muted">
                            {w.employeeId}
                            {w.department ? ` · ${w.department}` : ''}
                          </div>
                        </td>
                        <td className="num" data-label="Late entries">{w.lateEntries}</td>
                        <td className="num" data-label="Early exits">{w.earlyExits}</td>
                        <td className="num text-success" data-label="Approved">{w.approved}</td>
                        <td className={`num ${w.rejected ? 'text-missed' : 'text-ink-faint'}`} data-label="Rejected">{w.rejected}</td>
                        <td className={`num ${w.pending ? 'text-exception' : 'text-ink-faint'}`} data-label="Pending">{w.pending}</td>
                        <td className="num whitespace-nowrap" data-label="Late time">{w.lateMinutes ? duration(w.lateMinutes) : '—'}</td>
                        <td className="num whitespace-nowrap" data-label="Early time">{w.earlyMinutes ? duration(w.earlyMinutes) : '—'}</td>
                        <td className="num" data-label="Tasks excused">{w.tasksExcused}</td>
                        <td className="text-right">
                          {workerId !== w.workerId && (
                            <Button size="sm" variant="ghost" onClick={() => setWorkerId(w.workerId)}>
                              Only this employee
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>

            <Card className="overflow-hidden">
              <CardHeader icon={<AlarmClock className="w-4 h-4" />} title={`All records (${data.records.length})`} subtitle={period} />
              <div className="overflow-x-auto">
                <table className="data-table stack-sm">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Employee</th>
                      <th>Type</th>
                      <th>Time</th>
                      <th className="num">Late / early by</th>
                      <th>Reason</th>
                      <th>Status</th>
                      <th>Decided by</th>
                      <th className="num">Tasks excused</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.records.map((r) => (
                      <tr key={r.id}>
                        <td className="whitespace-nowrap" data-label="Date">
                          <div>{formatDateKey(r.date)}</div>
                          <div className="text-[12.5px] text-ink-muted">Applied {formatTime(r.appliedAt)}</div>
                        </td>
                        <td data-label="Employee">
                          <div className="font-semibold text-ink">{r.workerName}</div>
                          <div className="text-[13px] text-ink-muted">
                            {r.employeeId}
                            {r.department ? ` · ${r.department}` : ''}
                          </div>
                        </td>
                        <td data-label="Type">
                          <Pill className="bg-due-bg text-due ring-due-line">{r.kind === 'LATE_ENTRY' ? 'Late entry' : 'Early exit'}</Pill>
                        </td>
                        <td className="whitespace-nowrap" data-label="Time">
                          <div className="font-semibold text-ink">{r.requestedTime ? formatClock(r.requestedTime) : '—'}</div>
                          <div className="text-[12.5px] text-ink-muted">
                            {r.shiftTime ? `${r.kind === 'LATE_ENTRY' ? 'Shift starts' : 'Shift ends'} ${r.shiftTime}` : 'No shift'}
                          </div>
                        </td>
                        <td className="num whitespace-nowrap" data-label="Late / early by">
                          {r.minutes === null ? <span className="text-ink-faint">—</span> : `${duration(r.minutes)} ${r.kind === 'LATE_ENTRY' ? 'late' : 'early'}`}
                        </td>
                        <td className="max-w-[260px]" data-label="Reason">
                          <span className="whitespace-pre-wrap">{r.reason}</span>
                        </td>
                        <td data-label="Status">
                          <LeaveStatusBadge status={r.status} />
                          {r.decisionComment && <div className="text-[12.5px] text-ink-muted mt-0.5 max-w-[200px]">{r.decisionComment}</div>}
                        </td>
                        <td className="whitespace-nowrap" data-label="Decided by">
                          {r.decidedByName ? (
                            <>
                              <div>{r.decidedByName}</div>
                              <div className="text-[12.5px] text-ink-muted">{r.decidedAt ? formatDateTime(r.decidedAt) : ''}</div>
                            </>
                          ) : (
                            <span className="text-ink-faint">—</span>
                          )}
                        </td>
                        <td className="num" data-label="Tasks excused">
                          {r.status === 'APPROVED' ? (r.tasksRemoved ?? 0) : <span className="text-ink-faint">—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </>
        ) : null}
      </DataState>
    </div>
  )
}
