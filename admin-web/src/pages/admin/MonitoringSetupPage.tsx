import React, { useMemo, useState } from 'react'
import { Check, ChevronRight, Hash, Minus, Pencil, Play, Plus, RefreshCw, Square, Trash2 } from 'lucide-react'
import type { Job, MonitoringOverview, MonitoringReason, OverviewCheckType, OverviewMachine } from '../../types'
import { api, errorText } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { useAuth, useCanManage } from '../../lib/auth'
import { useCanOpen, type NavTab } from '../../components/layout/Sidebar'
import { addDaysKey, dateKey, formatClockRange, formatDateTime, frequencyLabel } from '../../lib/format'
import { Button } from '../../components/common/Button'
import { ConfirmModal } from '../../components/common/ConfirmModal'
import { DataState } from '../../components/common/DataState'
import { Field, FormError, Select, TextInput, Toggle, inputClass } from '../../components/common/Form'
import { Modal } from '../../components/common/Modal'
import { PageHeader } from '../../components/common/PageHeader'
import { StatusBadge } from '../../components/common/StatusBadge'
import { useToast } from '../../components/common/Toast'
import { DateInput } from '../../components/common/DateTimeInputs'

interface MonitoringSetupPageProps {
  /** Opens the Check Types or Schedules page to edit a row. */
  onNavigate: (tab: NavTab) => void
}

/** Yes / no cell of the evidence matrix. The phone card shows the column name in front of it. */
const Flag: React.FC<{ on: boolean }> = ({ on }) =>
  on ? (
    <span className="inline-flex items-center gap-1 text-success font-medium">
      <Check className="w-3.5 h-3.5" />
      Yes
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-ink-faint">
      <Minus className="w-3.5 h-3.5" />
      No
    </span>
  )

/** The mode chip: how this check type is triggered on this machine. */
function modeChip(ct: OverviewCheckType) {
  if (ct.mode === 'JOB') return { label: 'Job-based', tone: 'border-due-line bg-due-bg text-due' }
  if (ct.mode === 'MANUAL') return { label: 'Manual only', tone: 'border-line bg-subtle text-ink-secondary' }
  const intervals = [...new Set(ct.schedules.filter((s) => s.mode === 'INTERVAL').map((s) => s.intervalMinutes))].sort((a, b) => a - b)
  const label =
    intervals.length === 0
      ? 'Every interval'
      : intervals.length === 1
        ? frequencyLabel(intervals[0])
        : `Every ${intervals[0]}–${intervals[intervals.length - 1]} min`
  return { label, tone: 'border-success-line bg-success-bg text-success' }
}

const Chip: React.FC<{ label: string; tone?: string; icon?: React.ReactNode }> = ({ label, tone = 'border-line bg-subtle text-ink-secondary', icon }) => (
  <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[11px] font-medium whitespace-nowrap ${tone}`}>
    {icon}
    {label}
  </span>
)

/** The earliest next due time across a check type's schedules. */
const nextDueOf = (ct: OverviewCheckType) =>
  ct.schedules
    .map((s) => s.nextDueAt)
    .filter((d): d is string => !!d)
    .sort()[0] ?? null

const durationText = (minutes: number | null | undefined) => {
  if (minutes === null || minutes === undefined) return '—'
  const h = Math.floor(minutes / 60)
  return h > 0 ? `${h} h ${minutes % 60} min` : `${minutes} min`
}

interface ReasonForm {
  label: string
  requiresRemark: boolean
  isActive: boolean
  sortOrder: string
}

const emptyReasonForm: ReasonForm = { label: '', requiresRemark: false, isActive: true, sortOrder: '0' }

interface JobFilters {
  from: string
  to: string
  machineId: string
  running: string
}

const defaultJobFilters = (): JobFilters => ({ from: addDaysKey(dateKey(), -6), to: dateKey(), machineId: '', running: '' })

export const MonitoringSetupPage: React.FC<MonitoringSetupPageProps> = ({ onNavigate }) => {
  const { can } = useAuth()
  const canOpen = useCanOpen()
  const canEditSetup = useCanManage('activities')
  const canEndJobs = useCanManage('checks')
  const notify = useToast()

  const overview = useApi<MonitoringOverview>('/api/monitoring-overview')
  // The reasons list is readable with activities, checks or exceptions view.
  const canSeeReasons = can('activities') || can('checks') || can('exceptions')
  const reasons = useApi<MonitoringReason[]>(canSeeReasons ? '/api/monitoring-reasons' : null)

  const [jobFilters, setJobFilters] = useState<JobFilters>(defaultJobFilters)
  const canSeeJobs = can('checks')
  const jobs = useApi<Job[]>(canSeeJobs ? '/api/jobs' : null, {
    from: jobFilters.from,
    to: jobFilters.to,
    machineId: jobFilters.machineId,
    running: jobFilters.running
  })

  const [reasonOpen, setReasonOpen] = useState(false)
  const [editingReason, setEditingReason] = useState<MonitoringReason | null>(null)
  const [reasonForm, setReasonForm] = useState<ReasonForm>(emptyReasonForm)
  const [reasonError, setReasonError] = useState<string | null>(null)
  const [savingReason, setSavingReason] = useState(false)
  const [deletingReason, setDeletingReason] = useState<MonitoringReason | null>(null)
  const [endingJob, setEndingJob] = useState<Job | null>(null)

  const machines = useMemo(() => overview.data?.machines ?? [], [overview.data])

  // ----- N/A reasons -----
  const openAddReason = () => {
    setEditingReason(null)
    setReasonForm({ ...emptyReasonForm, sortOrder: String((reasons.data?.length ?? 0) + 1) })
    setReasonError(null)
    setReasonOpen(true)
  }

  const openEditReason = (r: MonitoringReason) => {
    setEditingReason(r)
    setReasonForm({ label: r.label, requiresRemark: r.requiresRemark, isActive: r.isActive, sortOrder: String(r.sortOrder) })
    setReasonError(null)
    setReasonOpen(true)
  }

  const saveReason = async (e?: React.SyntheticEvent) => {
    e?.preventDefault()
    const label = reasonForm.label.trim()
    if (!label) return setReasonError('Enter the reason workers will see')
    const body = {
      label,
      requiresRemark: reasonForm.requiresRemark,
      isActive: reasonForm.isActive,
      sortOrder: Number(reasonForm.sortOrder) || 0
    }
    setSavingReason(true)
    setReasonError(null)
    try {
      if (editingReason) await api.put(`/api/monitoring-reasons/${editingReason.id}`, body)
      else await api.post('/api/monitoring-reasons', body)
      notify('success', editingReason ? 'Reason updated' : 'Reason added', `${label} — available in the worker app now.`)
      setReasonOpen(false)
      reasons.reload()
    } catch (err) {
      setReasonError(errorText(err))
    } finally {
      setSavingReason(false)
    }
  }

  const removeReason = async () => {
    if (!deletingReason) return
    try {
      await api.del(`/api/monitoring-reasons/${deletingReason.id}`)
      notify('success', 'Reason deactivated', `${deletingReason.label} is no longer offered to workers. Past checks keep it.`)
      reasons.reload()
    } catch (err) {
      notify('error', 'Could not deactivate reason', errorText(err))
    }
  }

  // ----- jobs -----
  const endJob = async () => {
    if (!endingJob) return
    try {
      await api.post(`/api/jobs/${endingJob.id}/end`)
      notify('success', 'Job ended', `Job ${endingJob.jobNo} on ${endingJob.machineName ?? 'the machine'} was closed.`)
      jobs.reload()
      overview.reload()
    } catch (err) {
      notify('error', 'Could not end the job', errorText(err))
    }
  }

  const setJobFilter = (patch: Partial<JobFilters>) => setJobFilters((f) => ({ ...f, ...patch }))

  return (
    <div className="space-y-4">
      <PageHeader
        title="Monitoring Setup"
        description="How each machine is monitored: check types, their mode and intervals, the evidence asked for every parameter, the Not Applicable reasons and the jobs."
        actions={
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              overview.reload()
              reasons.reload()
              jobs.reload()
            }}
            loading={overview.loading && overview.data !== null}
            icon={<RefreshCw className="w-3.5 h-3.5" />}
          >
            Refresh
          </Button>
        }
      />

      <DataState
        loading={overview.loading}
        error={overview.error}
        onRetry={overview.reload}
        empty={overview.data === null ? undefined : machines.length === 0}
        emptyText="No machines are configured yet. Add machines and link check types to them."
      >
        <div className="space-y-3">
          {machines.map((m) => (
            <MachineCard key={m.id} machine={m} onNavigate={onNavigate} canOpen={canOpen} />
          ))}
        </div>
      </DataState>

      {/* ---------- Not Applicable reasons ---------- */}
      {canSeeReasons && (
        <section className="bg-white border border-line rounded-md shadow-2xs overflow-hidden">
          <div className="px-4 py-2.5 border-b border-line bg-slate-50 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-bold text-ink">N/A reasons</h2>
              <p className="text-[11px] text-ink-muted">
                Why a parameter could not be read. A check with Not Applicable parameters still counts as Completed, never as a failure.
              </p>
            </div>
            {canEditSetup && (
              <Button size="sm" variant="primary" onClick={openAddReason} icon={<Plus className="w-3.5 h-3.5" />}>
                Add Reason
              </Button>
            )}
          </div>
          <DataState
            loading={reasons.loading}
            error={reasons.error}
            onRetry={reasons.reload}
            empty={reasons.data === null ? undefined : reasons.data.length === 0}
            emptyText="No reasons yet. Add the first one."
          >
            <div className="overflow-x-auto">
              <table className="stack-sm w-full text-left text-xs border-collapse">
                <thead className="bg-slate-50 border-b border-line text-ink-secondary text-[11px] uppercase tracking-wider">
                  <tr>
                    <th className="py-2 px-3 font-semibold">Reason</th>
                    <th className="py-2 px-3 font-semibold">Requires remark</th>
                    <th className="py-2 px-3 font-semibold">Order</th>
                    <th className="py-2 px-3 font-semibold">Status</th>
                    {canEditSetup && <th className="py-2 px-3 font-semibold text-right">Actions</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {(reasons.data ?? []).map((r) => (
                    <tr key={r.id} className="hover:bg-slate-50 transition-colors">
                      <td className="py-2 px-3 font-medium text-ink">{r.label}</td>
                      <td className="py-2 px-3">
                        <Flag on={r.requiresRemark} />
                      </td>
                      <td className="py-2 px-3 font-mono text-ink-secondary">{r.sortOrder}</td>
                      <td className="py-2 px-3">
                        <StatusBadge status={r.isActive ? 'ACTIVE' : 'DISABLED'} size="sm" />
                      </td>
                      {canEditSetup && (
                        <td className="py-2 px-3 text-right whitespace-nowrap">
                          <div className="inline-flex items-center gap-1">
                            <Button size="sm" variant="outline" onClick={() => openEditReason(r)} icon={<Pencil className="w-3 h-3" />}>
                              Edit
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setDeletingReason(r)}
                              disabled={!r.isActive}
                              icon={<Trash2 className="w-3 h-3 text-failed" />}
                              title="Deactivate reason"
                              aria-label={`Deactivate ${r.label}`}
                            />
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </DataState>
        </section>
      )}

      {/* ---------- Jobs ---------- */}
      {canSeeJobs && (
        <section className="bg-white border border-line rounded-md shadow-2xs overflow-hidden">
          <div className="px-4 py-2.5 border-b border-line bg-slate-50">
            <h2 className="text-sm font-bold text-ink">Jobs</h2>
            <p className="text-[11px] text-ink-muted">Job-based checks are only due while a job is running on the machine.</p>
          </div>

          <div className="p-3 border-b border-line grid grid-cols-2 sm:flex sm:flex-wrap items-end gap-2.5 text-xs">
            <label className="min-w-0">
              <span className="block text-[11px] font-semibold text-ink-secondary mb-1">From</span>
              <DateInput
                value={jobFilters.from}
                max={jobFilters.to}
                onChange={(e) => e.target.value && setJobFilter({ from: e.target.value })}
                className="sm:w-[160px] lg:w-[132px]"
              />
            </label>
            <label className="min-w-0">
              <span className="block text-[11px] font-semibold text-ink-secondary mb-1">To</span>
              <DateInput
                value={jobFilters.to}
                min={jobFilters.from}
                onChange={(e) => e.target.value && setJobFilter({ to: e.target.value })}
                className="sm:w-[160px] lg:w-[132px]"
              />
            </label>
            <label className="min-w-0">
              <span className="block text-[11px] font-semibold text-ink-secondary mb-1">Machine</span>
              <Select value={jobFilters.machineId} onChange={(e) => setJobFilter({ machineId: e.target.value })} className="sm:w-auto sm:min-w-[150px]">
                <option value="">All machines</option>
                {machines.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} ({m.code})
                  </option>
                ))}
              </Select>
            </label>
            <label className="min-w-0">
              <span className="block text-[11px] font-semibold text-ink-secondary mb-1">State</span>
              <Select value={jobFilters.running} onChange={(e) => setJobFilter({ running: e.target.value })} className="sm:w-auto sm:min-w-[130px]">
                <option value="">All jobs</option>
                <option value="true">Running now</option>
                <option value="false">Ended</option>
              </Select>
            </label>
            <Button size="field" variant="ghost" onClick={() => setJobFilters(defaultJobFilters())}>
              Reset
            </Button>
          </div>

          <DataState
            loading={jobs.loading}
            error={jobs.error}
            onRetry={jobs.reload}
            empty={jobs.data === null ? undefined : jobs.data.length === 0}
            emptyText="No jobs in this period."
          >
            <div className="overflow-x-auto">
              <table className="stack-sm w-full text-left text-xs border-collapse">
                <thead className="bg-slate-50 border-b border-line text-ink-secondary text-[11px] uppercase tracking-wider">
                  <tr>
                    <th className="py-2 px-3 font-semibold">Item Code</th>
                    <th className="py-2 px-3 font-semibold">Job No.</th>
                    <th className="py-2 px-3 font-semibold">Machine</th>
                    <th className="py-2 px-3 font-semibold">Started</th>
                    <th className="py-2 px-3 font-semibold">Ended</th>
                    <th className="py-2 px-3 font-semibold">Duration</th>
                    <th className="py-2 px-3 font-semibold">Checks</th>
                    {canEndJobs && <th className="py-2 px-3 font-semibold text-right">Action</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {(jobs.data ?? []).map((j) => (
                    <tr key={j.id} className="hover:bg-slate-50 transition-colors">
                      <td className="py-2 px-3 font-mono text-ink whitespace-nowrap">{j.itemCode ?? <span className="text-ink-faint">—</span>}</td>
                      <td className="py-2 px-3 font-mono font-semibold text-ink whitespace-nowrap">{j.jobNo}</td>
                      <td className="py-2 px-3 whitespace-nowrap">
                        <span className="font-medium text-ink">{j.machineName ?? '—'}</span>
                        {j.machineCode && <span className="block text-[11px] font-mono text-ink-muted">{j.machineCode}</span>}
                      </td>
                      <td className="py-2 px-3 whitespace-nowrap">
                        <span className="font-mono text-ink">{formatDateTime(j.startedAt)}</span>
                        {j.startedByName && <span className="block text-[11px] text-ink-muted">by {j.startedByName}</span>}
                      </td>
                      <td className="py-2 px-3 whitespace-nowrap">
                        {j.endedAt ? (
                          <>
                            <span className="font-mono text-ink">{formatDateTime(j.endedAt)}</span>
                            {j.endedByName && <span className="block text-[11px] text-ink-muted">by {j.endedByName}</span>}
                          </>
                        ) : (
                          <Chip label="Running" tone="border-success-line bg-success-bg text-success" icon={<Play className="w-3 h-3" />} />
                        )}
                      </td>
                      <td className="py-2 px-3 whitespace-nowrap text-ink">{durationText(j.durationMinutes)}</td>
                      <td className="py-2 px-3 font-mono text-ink">{j.checkCount ?? 0}</td>
                      {canEndJobs && (
                        <td className="py-2 px-3 text-right whitespace-nowrap">
                          {j.endedAt ? (
                            <span className="text-ink-faint">—</span>
                          ) : (
                            <Button size="sm" variant="outline" onClick={() => setEndingJob(j)} icon={<Square className="w-3 h-3" />}>
                              Force close
                            </Button>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </DataState>
        </section>
      )}

      {/* Add / edit an N/A reason */}
      <Modal
        isOpen={reasonOpen}
        onClose={() => !savingReason && setReasonOpen(false)}
        title={editingReason ? 'Edit N/A Reason' : 'Add N/A Reason'}
        subtitle="Workers choose one of these when a parameter cannot be read"
        maxWidth="md"
        footer={
          <>
            <Button size="sm" variant="outline" onClick={() => setReasonOpen(false)} disabled={savingReason}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" onClick={() => saveReason()} loading={savingReason}>
              {editingReason ? 'Save Changes' : 'Add Reason'}
            </Button>
          </>
        }
      >
        <form onSubmit={saveReason} className="space-y-3">
          <FormError message={reasonError} />
          <Field label="Reason" required hint="Short and clear, e.g. Machine stopped.">
            <TextInput
              value={reasonForm.label}
              onChange={(e) => setReasonForm((f) => ({ ...f, label: e.target.value }))}
              placeholder="e.g. No production"
              autoFocus
            />
          </Field>
          <Field label="Order" hint="Lower numbers are shown first in the worker app.">
            <input
              type="number"
              min={0}
              step={1}
              value={reasonForm.sortOrder}
              onChange={(e) => setReasonForm((f) => ({ ...f, sortOrder: e.target.value }))}
              className={inputClass}
              aria-label="Order"
            />
          </Field>
          <Toggle
            checked={reasonForm.requiresRemark}
            onChange={(v) => setReasonForm((f) => ({ ...f, requiresRemark: v }))}
            label="Requires remark"
            description="The worker must type an explanation when choosing this reason."
          />
          <Toggle
            checked={reasonForm.isActive}
            onChange={(v) => setReasonForm((f) => ({ ...f, isActive: v }))}
            label="Active"
            description="Inactive reasons are not offered to workers; past checks keep them."
          />
          {/* Allows Enter to submit */}
          <button type="submit" className="hidden" aria-hidden="true" tabIndex={-1} />
        </form>
      </Modal>

      <ConfirmModal
        isOpen={deletingReason !== null}
        title="Deactivate reason?"
        danger
        confirmLabel="Deactivate"
        onConfirm={removeReason}
        onClose={() => setDeletingReason(null)}
        message={
          deletingReason && (
            <p>
              <span className="font-semibold text-ink">{deletingReason.label}</span> will no longer be offered to workers. Checks that already use it keep
              it.
            </p>
          )
        }
      />

      <ConfirmModal
        isOpen={endingJob !== null}
        title="Force close job?"
        confirmLabel="Force close"
        onConfirm={endJob}
        onClose={() => setEndingJob(null)}
        message={
          endingJob && (
            <p>
              Close job <span className="font-semibold text-ink">{endingJob.jobNo}</span> on{' '}
              <span className="font-semibold text-ink">{endingJob.machineName ?? 'this machine'}</span> without its remaining checks? Open checks are
              removed; submitted records stay with the job. Workers normally end a job with its Job End check.
            </p>
          )
        }
      />
    </div>
  )
}

/** One machine with its check types, their mode, shifts and per-parameter evidence matrix. */
const MachineCard: React.FC<{
  machine: OverviewMachine
  onNavigate: (tab: NavTab) => void
  canOpen: (tab: NavTab) => boolean
}> = ({ machine, onNavigate, canOpen }) => (
  <section className="bg-white border border-line rounded-md shadow-2xs overflow-hidden">
    <div className="px-4 py-2.5 border-b border-line bg-slate-50 flex flex-wrap items-center gap-2">
      <div className="min-w-0">
        <h2 className="text-sm font-bold text-ink">
          {machine.name}
          <span className="ml-2 font-mono text-[11px] font-normal text-ink-muted">{machine.code}</span>
        </h2>
        <p className="text-[11px] text-ink-muted">
          {machine.departmentName ?? 'No department'} · {machine.checkTypes.length} check {machine.checkTypes.length === 1 ? 'type' : 'types'}
        </p>
      </div>
      <div className="ml-auto flex flex-wrap items-center gap-2">
        {machine.runningJob ? (
          <Chip
            label={`Job ${machine.runningJob.jobNo} since ${formatDateTime(machine.runningJob.startedAt)}`}
            tone="border-success-line bg-success-bg text-success"
            icon={<Hash className="w-3 h-3" />}
          />
        ) : (
          <Chip label="No job running" />
        )}
        <StatusBadge status={machine.status} size="sm" />
      </div>
    </div>

    {machine.checkTypes.length === 0 ? (
      <div className="px-4 py-5 text-center text-xs text-ink-muted">
        No check types linked to this machine yet.
        {canOpen('activities') && (
          <Button size="sm" variant="outline" className="ml-2" onClick={() => onNavigate('activities')}>
            Open Check Types
          </Button>
        )}
      </div>
    ) : (
      <div className="divide-y divide-line">
        {machine.checkTypes.map((ct) => {
          const chip = modeChip(ct)
          const nextDue = nextDueOf(ct)
          const parameters = ct.parameters.filter((p) => p.isEnabled)
          return (
            <div key={ct.activityId} className="p-3 sm:p-4 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-ink">
                    {ct.activityName}
                    <span className="ml-2 font-mono text-[11px] font-normal text-ink-secondary">{ct.activityCode}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 mt-1">
                    <Chip label={chip.label} tone={chip.tone} />
                    {ct.allowManual && <Chip label="Manual submission on" />}
                    {ct.requireJobNo && <Chip label="Job No. required" />}
                    {ct.requirePhoto && <Chip label="Overall photo" />}
                    {ct.requireVideo && <Chip label="Overall video" />}
                    {!ct.isActive && <Chip label="Check type disabled" tone="border-line bg-slate-50 text-ink-muted" />}
                  </div>
                </div>
                <div className="ml-auto flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] text-ink-muted">
                    Next due <span className="font-mono text-ink">{nextDue ? formatDateTime(nextDue) : '—'}</span>
                  </span>
                  {canOpen('activities') && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => onNavigate('activities')}
                      iconRight={<ChevronRight className="w-3 h-3" />}
                      title={`Edit ${ct.activityName} in Check Types`}
                    >
                      Edit check type
                    </Button>
                  )}
                  {canOpen('schedules') && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => onNavigate('schedules')}
                      iconRight={<ChevronRight className="w-3 h-3" />}
                      title={`Edit the schedules of ${ct.activityName}`}
                    >
                      Edit schedule
                    </Button>
                  )}
                </div>
              </div>

              {/* Shifts and intervals */}
              {ct.schedules.length === 0 ? (
                <p className="text-[11px] text-ink-muted">
                  No schedule on this machine.{' '}
                  {ct.allowManual ? 'Workers submit it manually whenever they need to.' : 'Nothing is generated and manual submission is off.'}
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="stack-sm w-full text-left text-xs border-collapse">
                    <thead className="bg-slate-50 border-y border-line text-ink-secondary text-[11px] uppercase tracking-wider">
                      <tr>
                        <th className="py-1.5 px-3 font-semibold">Shift</th>
                        <th className="py-1.5 px-3 font-semibold">Mode</th>
                        <th className="py-1.5 px-3 font-semibold">Interval</th>
                        <th className="py-1.5 px-3 font-semibold">Time window</th>
                        <th className="py-1.5 px-3 font-semibold">Assigned to</th>
                        <th className="py-1.5 px-3 font-semibold">Next due</th>
                        <th className="py-1.5 px-3 font-semibold">Last submitted</th>
                        <th className="py-1.5 px-3 font-semibold">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {ct.schedules.map((s) => (
                        <tr key={s.id}>
                          <td className="py-1.5 px-3 font-medium text-ink whitespace-nowrap">{s.shiftName}</td>
                          <td className="py-1.5 px-3 whitespace-nowrap text-ink-secondary">{s.mode === 'JOB' ? 'Job-based' : 'Every interval'}</td>
                          <td className="py-1.5 px-3 whitespace-nowrap text-ink">{frequencyLabel(s.intervalMinutes)}</td>
                          <td className="py-1.5 px-3 whitespace-nowrap">
                            {s.startTime && s.endTime ? (
                              <span className="font-mono text-ink">{formatClockRange(s.startTime, s.endTime)}</span>
                            ) : (
                              <span className="text-ink-muted">Whole shift</span>
                            )}
                          </td>
                          <td className="py-1.5 px-3 whitespace-nowrap">
                            {s.workerName ?? <span className="text-ink-muted">Worker on this shift</span>}
                          </td>
                          <td className="py-1.5 px-3 whitespace-nowrap font-mono text-ink">{s.nextDueAt ? formatDateTime(s.nextDueAt) : '—'}</td>
                          <td className="py-1.5 px-3 whitespace-nowrap font-mono text-ink-secondary">
                            {s.lastSubmittedAt ? formatDateTime(s.lastSubmittedAt) : '—'}
                          </td>
                          <td className="py-1.5 px-3 whitespace-nowrap">
                            <StatusBadge status={s.isActive ? 'ACTIVE' : 'Paused'} size="sm" />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Per-parameter evidence matrix */}
              {parameters.length === 0 ? (
                <p className="text-[11px] text-ink-muted">No parameters on this check type yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="stack-sm w-full text-left text-xs border-collapse">
                    <thead className="bg-slate-50 border-y border-line text-ink-secondary text-[11px] uppercase tracking-wider">
                      <tr>
                        <th className="py-1.5 px-3 font-semibold">Parameter</th>
                        <th className="py-1.5 px-3 font-semibold">Required</th>
                        <th className="py-1.5 px-3 font-semibold">Photo</th>
                        <th className="py-1.5 px-3 font-semibold">Video</th>
                        <th className="py-1.5 px-3 font-semibold">N/A allowed</th>
                        <th className="py-1.5 px-3 font-semibold">Only during a job</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {parameters.map((p) => (
                        <tr key={p.parameterId}>
                          <td className="py-1.5 px-3">
                            <span className="font-medium text-ink">{p.name}</span>
                            <span className="block text-[11px] text-ink-muted">
                              {p.rule ?? 'No limits'}
                              {p.unit ? ` · ${p.unit}` : ''}
                            </span>
                          </td>
                          <td className="py-1.5 px-3">
                            <Flag on={p.isRequired} />
                          </td>
                          <td className="py-1.5 px-3">
                            <Flag on={p.requirePhoto} />
                          </td>
                          <td className="py-1.5 px-3">
                            <Flag on={p.requireVideo} />
                          </td>
                          <td className="py-1.5 px-3">
                            <Flag on={p.allowNa} />
                          </td>
                          <td className="py-1.5 px-3">
                            <Flag on={p.appliesWhen === 'JOB_RUNNING'} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )
        })}
      </div>
    )}
  </section>
)
