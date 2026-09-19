import React, { useMemo, useState } from 'react'
import { ArrowLeftRight, Briefcase, ExternalLink, Pencil, Plus, RefreshCw, StopCircle } from 'lucide-react'
import type { CheckKind, JobHandover, JobRow, JobStatus, Machine, QualityCheck, Shift, User } from '../../types'
import { api, errorText } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { useCanManage } from '../../lib/auth'
import { addDaysKey, dateKey, formatDate, formatDateTime } from '../../lib/format'
import { Button } from '../../components/common/Button'
import { PageHeader } from '../../components/common/PageHeader'
import { DataState } from '../../components/common/DataState'
import { Drawer } from '../../components/common/Drawer'
import { Modal } from '../../components/common/Modal'
import { ConfirmModal } from '../../components/common/ConfirmModal'
import { StatusBadge } from '../../components/common/StatusBadge'
import { useToast } from '../../components/common/Toast'
import { Field, FormError, Select, TextArea, TextInput, inputClass } from '../../components/common/Form'
import { DateInput } from '../../components/common/DateTimeInputs'

const STATUS: Record<JobStatus, { label: string; cls: string }> = {
  PLANNED: { label: 'Planned', cls: 'bg-slate-50 text-ink-secondary border-line' },
  STARTING: { label: 'Job Start check', cls: 'bg-due-bg text-due border-due-line' },
  ACTIVE: { label: 'Running', cls: 'bg-success-bg text-success border-success-line' },
  ENDING: { label: 'Job End check', cls: 'bg-due-bg text-due border-due-line' },
  COMPLETED: { label: 'Completed', cls: 'bg-slate-50 text-ink border-line' },
  CANCELLED: { label: 'Cancelled', cls: 'bg-slate-50 text-ink-muted border-line' }
}

const KIND_LABEL: Record<CheckKind, string> = {
  SCHEDULED: 'Scheduled',
  JOB_START: 'Job start',
  JOB_INTERVAL: 'Scheduled',
  JOB_END: 'Job end'
}

const FILTERS: { key: string; label: string; statuses: JobStatus[] }[] = [
  { key: 'running', label: 'Active', statuses: ['STARTING', 'ACTIVE', 'ENDING'] },
  { key: 'planned', label: 'Planned', statuses: ['PLANNED'] },
  { key: 'completed', label: 'Completed', statuses: ['COMPLETED'] },
  { key: 'cancelled', label: 'Cancelled', statuses: ['CANCELLED'] },
  { key: 'all', label: 'All', statuses: [] }
]

const StatusPill: React.FC<{ status: JobStatus; forced?: boolean }> = ({ status, forced }) => (
  <span className={`inline-flex items-center px-1.5 py-px rounded border text-[11px] font-semibold whitespace-nowrap ${STATUS[status].cls}`}>
    {STATUS[status].label}
    {forced ? ' · force closed' : ''}
  </span>
)

const EdgeState: React.FC<{ state: JobRow['startCheck'] }> = ({ state }) =>
  state === 'NONE' ? (
    <span className="text-ink-faint">—</span>
  ) : state === 'DONE' ? (
    <span className="text-success font-semibold">Done</span>
  ) : (
    <span className="text-due font-semibold">Pending</span>
  )

const duration = (minutes: number) => (minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`)

interface PlanForm {
  machineId: string
  jobNo: string
  itemCode: string
  assignedWorkerId: string
  plannedFor: string
  note: string
}
const emptyPlan: PlanForm = { machineId: '', jobNo: '', itemCode: '', assignedWorkerId: '', plannedFor: '', note: '' }

/**
 * Jobs: plan and assign jobs, follow every running job (worker, Job Start / End check, pending,
 * missed and overdue checks, handovers), open one job with all its records, hand it over, or
 * force-close a stuck job.
 */
export const JobsPage: React.FC<{ onViewCheck: (id: string) => void }> = ({ onViewCheck }) => {
  const canManage = useCanManage('checks')
  const notify = useToast()
  const [filter, setFilter] = useState('running')
  const [machineId, setMachineId] = useState('')
  const [from, setFrom] = useState(addDaysKey(dateKey(), -29))
  const [to, setTo] = useState(dateKey())
  const statuses = FILTERS.find((f) => f.key === filter)!.statuses
  // Running and planned jobs are shown whenever they started; finished ones by date.
  const dated = filter !== 'running' && filter !== 'planned'
  const { data, error, loading, reload } = useApi<JobRow[]>('/api/jobs', {
    status: statuses.join(','),
    machineId,
    ...(dated ? { from, to } : {})
  })
  const { data: machines } = useApi<Machine[]>('/api/machines')
  const { data: workers } = useApi<User[]>(canManage ? '/api/users' : null, { role: 'WORKER' })
  const { data: shifts } = useApi<Shift[]>(canManage ? '/api/shifts' : null)

  const [openId, setOpenId] = useState<string | null>(null)
  const detail = useApi<{ job: JobRow; checks: QualityCheck[]; handovers: JobHandover[] }>(openId ? `/api/jobs/${openId}` : null)

  const [planOpen, setPlanOpen] = useState(false)
  const [editing, setEditing] = useState<JobRow | null>(null)
  const [plan, setPlan] = useState<PlanForm>(emptyPlan)
  const [planError, setPlanError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [handover, setHandover] = useState<{ job: JobRow; toUserId: string; shiftId: string; note: string; error: string | null } | null>(null)
  const [closing, setClosing] = useState<JobRow | null>(null)

  const rows = useMemo(() => data ?? [], [data])
  const workersOn = (id: string) => (workers ?? []).filter((w) => w.isActive && w.machineIds.includes(id))
  const refreshAll = () => {
    reload()
    if (openId) detail.reload()
  }

  const openPlan = (job: JobRow | null) => {
    setEditing(job)
    setPlan(
      job
        ? { machineId: job.machineId, jobNo: job.jobNo, itemCode: job.itemCode ?? '', assignedWorkerId: job.assignedWorkerId ?? '', plannedFor: job.plannedFor ?? '', note: job.note ?? '' }
        : { ...emptyPlan, machineId: machineId || '', plannedFor: dateKey() }
    )
    setPlanError(null)
    setPlanOpen(true)
  }

  const savePlan = async () => {
    if (!plan.machineId) return setPlanError('Choose the machine')
    if (!plan.jobNo.trim()) return setPlanError('Enter the Job No.')
    setSaving(true)
    setPlanError(null)
    const body = {
      machineId: plan.machineId,
      jobNo: plan.jobNo.trim(),
      itemCode: plan.itemCode.trim() || null,
      assignedWorkerId: plan.assignedWorkerId || null,
      plannedFor: plan.plannedFor || null,
      note: plan.note.trim() || null
    }
    try {
      if (editing) await api.put(`/api/jobs/${editing.id}`, body)
      else await api.post('/api/jobs', body)
      notify('success', editing ? 'Job updated' : 'Job planned', `Job No. ${body.jobNo}${body.assignedWorkerId ? '' : ' — any worker on the machine can start it'}`)
      setPlanOpen(false)
      refreshAll()
    } catch (err) {
      setPlanError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  const sendHandover = async () => {
    if (!handover) return
    if (!handover.toUserId) return setHandover({ ...handover, error: 'Choose the worker' })
    try {
      await api.post(`/api/jobs/${handover.job.id}/handover`, { toUserId: handover.toUserId, shiftId: handover.shiftId || null, note: handover.note.trim() || undefined })
      notify('success', 'Job handed over', `Job No. ${handover.job.jobNo} and its open checks moved; the worker was notified.`)
      setHandover(null)
      refreshAll()
    } catch (err) {
      setHandover({ ...handover, error: errorText(err) })
    }
  }

  const machineOptions = (machines ?? []).filter((m) => m.isActive)
  const job = detail.data?.job

  return (
    <div className="space-y-4">
      <PageHeader
        title="Jobs"
        description="Plan and assign jobs, follow running jobs, their start and end checks, scheduled checks and handovers"
        actions={
          <>
            <Button size="sm" variant="ghost" onClick={refreshAll} loading={loading && data !== null} icon={<RefreshCw className="w-3.5 h-3.5" />}>
              Refresh
            </Button>
            {canManage && (
              <Button size="sm" variant="primary" onClick={() => openPlan(null)} icon={<Plus className="w-3.5 h-3.5" />}>
                Plan Job
              </Button>
            )}
          </>
        }
      />

      <section className="bg-white border border-line rounded-md p-3 shadow-2xs flex flex-wrap items-end gap-3 text-xs">
        <div className="flex rounded border border-line-strong overflow-hidden" role="tablist" aria-label="Job status">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              role="tab"
              aria-selected={filter === f.key}
              onClick={() => setFilter(f.key)}
              className={`px-3 h-[40px] lg:h-8 text-[12px] lg:text-[11px] font-medium border-r border-line last:border-r-0 ${filter === f.key ? 'bg-accent text-white' : 'bg-white text-ink-secondary hover:bg-slate-50'}`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <label className="min-w-0">
          <span className="block text-[11px] font-semibold text-ink-secondary mb-1">Machine</span>
          <select value={machineId} onChange={(e) => setMachineId(e.target.value)} className={`${inputClass} px-2 sm:w-auto sm:min-w-[160px]`}>
            <option value="">All machines</option>
            {(machines ?? []).map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} ({m.code})
              </option>
            ))}
          </select>
        </label>
        {dated && (
          <>
            <label className="min-w-0">
              <span className="block text-[11px] font-semibold text-ink-secondary mb-1">From</span>
              <DateInput value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} className="sm:w-[140px]" />
            </label>
            <label className="min-w-0">
              <span className="block text-[11px] font-semibold text-ink-secondary mb-1">To</span>
              <DateInput value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} className="sm:w-[140px]" />
            </label>
          </>
        )}
      </section>

      <DataState loading={loading} error={error} onRetry={reload} empty={data === null ? undefined : rows.length === 0} emptyText="No jobs for these filters.">
        <div className="bg-white border border-line rounded-md shadow-2xs overflow-x-auto">
          <table className="stack-sm w-full text-left text-xs border-collapse">
            <thead className="bg-slate-50 border-b border-line text-ink-secondary text-[11px] uppercase tracking-wider">
              <tr>
                <th className="py-2 px-3 font-semibold">Job No. / Item</th>
                <th className="py-2 px-3 font-semibold">Machine</th>
                <th className="py-2 px-3 font-semibold">Status</th>
                <th className="py-2 px-3 font-semibold">Worker now</th>
                <th className="py-2 px-3 font-semibold">Start check</th>
                <th className="py-2 px-3 font-semibold">End check</th>
                <th className="py-2 px-3 font-semibold">Checks</th>
                <th className="py-2 px-3 font-semibold">Handovers</th>
                <th className="py-2 px-3 font-semibold">Started / planned</th>
                <th className="py-2 px-3 font-semibold text-right">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((j) => (
                <tr key={j.id} className="hover:bg-slate-50">
                  <td className="py-2 px-3">
                    <div className="font-mono font-semibold text-ink">{j.jobNo}</div>
                    <div className="font-mono text-[11px] text-ink-muted">{j.itemCode ?? '—'}</div>
                  </td>
                  <td className="py-2 px-3 whitespace-nowrap">
                    {j.machineName}
                    <div className="text-[11px] text-ink-muted font-mono">{j.machineCode}</div>
                  </td>
                  <td className="py-2 px-3">
                    <StatusPill status={j.status} forced={j.forceClosed} />
                  </td>
                  <td className="py-2 px-3 whitespace-nowrap">{j.assignedWorkerName ?? <span className="text-ink-faint">Any worker</span>}</td>
                  <td className="py-2 px-3">
                    <EdgeState state={j.startCheck} />
                  </td>
                  <td className="py-2 px-3">
                    <EdgeState state={j.endCheck} />
                  </td>
                  <td className="py-2 px-3 whitespace-nowrap">
                    <span className="text-success font-semibold">{j.counts.completed} done</span>
                    {j.counts.due + j.counts.pending > 0 && <span className="text-due"> · {j.counts.due + j.counts.pending} pending</span>}
                    {j.counts.overdue > 0 && <span className="text-missed font-semibold"> · {j.counts.overdue} overdue</span>}
                    {j.counts.missed > 0 && <span className="text-missed"> · {j.counts.missed} missed</span>}
                    {j.counts.exception > 0 && <span className="text-exception"> · {j.counts.exception} exception</span>}
                  </td>
                  <td className="py-2 px-3 text-center font-mono">{j.handovers || <span className="text-ink-faint">0</span>}</td>
                  <td className="py-2 px-3 font-mono whitespace-nowrap text-ink-secondary">
                    {j.startedAt ? formatDateTime(j.startedAt) : j.plannedFor ? `Planned ${formatDate(j.plannedFor)}` : 'Planned'}
                    {j.startedAt && <div className="text-[11px] text-ink-muted font-sans">{duration(j.durationMinutes ?? 0)}</div>}
                  </td>
                  <td className="py-2 px-3 text-right">
                    <Button size="sm" variant="outline" onClick={() => setOpenId(j.id)} aria-label={`Open job ${j.jobNo}`}>
                      View
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </DataState>

      {/* One job with all its records */}
      <Drawer isOpen={!!openId} onClose={() => setOpenId(null)} title={job ? `Job No. ${job.jobNo}` : 'Job'} subtitle={job ? `${job.machineName} · ${job.machineCode}` : undefined} width="xl"
        footer={
          job && canManage ? (
            <div className="flex flex-wrap gap-2 justify-end">
              {job.status === 'PLANNED' && (
                <Button size="sm" variant="outline" icon={<Pencil className="w-3.5 h-3.5" />} onClick={() => openPlan(job)}>
                  Edit
                </Button>
              )}
              {['STARTING', 'ACTIVE', 'ENDING'].includes(job.status) && (
                <Button
                  size="sm"
                  variant="outline"
                  icon={<ArrowLeftRight className="w-3.5 h-3.5" />}
                  onClick={() => setHandover({ job, toUserId: '', shiftId: '', note: '', error: null })}
                >
                  Handover
                </Button>
              )}
              {!['COMPLETED', 'CANCELLED'].includes(job.status) && (
                <Button size="sm" variant="danger" icon={<StopCircle className="w-3.5 h-3.5" />} onClick={() => setClosing(job)}>
                  {job.status === 'PLANNED' ? 'Cancel job' : 'Force close'}
                </Button>
              )}
            </div>
          ) : undefined
        }
      >
        <DataState loading={detail.loading && !detail.data} error={detail.error} onRetry={detail.reload}>
          {job && detail.data && (
            <div className="space-y-5 text-xs">
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
                <div>
                  <dt className="text-ink-muted">Status</dt>
                  <dd><StatusPill status={job.status} forced={job.forceClosed} /></dd>
                </div>
                <div>
                  <dt className="text-ink-muted">Item Code</dt>
                  <dd className="font-mono">{job.itemCode ?? '—'}</dd>
                </div>
                <div>
                  <dt className="text-ink-muted">Worker now</dt>
                  <dd>{job.assignedWorkerName ?? 'Any worker on the machine'}</dd>
                </div>
                <div>
                  <dt className="text-ink-muted">Started</dt>
                  <dd>{job.startedAt ? `${formatDateTime(job.startedAt)}${job.startedByName ? ` · ${job.startedByName}` : ''}` : job.plannedFor ? `Planned for ${formatDate(job.plannedFor)}` : 'Not started'}</dd>
                </div>
                <div>
                  <dt className="text-ink-muted">Job Start check</dt>
                  <dd><EdgeState state={job.startCheck} /></dd>
                </div>
                <div>
                  <dt className="text-ink-muted">Job End check</dt>
                  <dd><EdgeState state={job.endCheck} /></dd>
                </div>
                {job.endedAt && (
                  <div>
                    <dt className="text-ink-muted">Ended</dt>
                    <dd>{formatDateTime(job.endedAt)}{job.endedByName ? ` · ${job.endedByName}` : ''}</dd>
                  </div>
                )}
                {job.note && (
                  <div className="col-span-2">
                    <dt className="text-ink-muted">Note</dt>
                    <dd>{job.note}</dd>
                  </div>
                )}
              </dl>

              <section>
                <h3 className="text-[11px] font-bold uppercase tracking-wider text-ink-secondary mb-1.5">Handovers ({detail.data.handovers.length})</h3>
                {detail.data.handovers.length === 0 ? (
                  <p className="text-ink-muted">No handovers.</p>
                ) : (
                  <ul className="divide-y divide-line border border-line rounded">
                    {detail.data.handovers.map((h) => (
                      <li key={h.id} className="px-3 py-2">
                        <div className="font-semibold text-ink">{h.fromName ?? '—'} → {h.toName ?? '—'}</div>
                        <div className="text-ink-muted">
                          {formatDateTime(h.at)}
                          {h.shiftName ? ` · ${h.shiftName}` : ''} · by {h.byName ?? '—'} · {h.movedChecks} open check{h.movedChecks === 1 ? '' : 's'} moved
                        </div>
                        {h.note && <div className="text-ink-secondary">{h.note}</div>}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section>
                <h3 className="text-[11px] font-bold uppercase tracking-wider text-ink-secondary mb-1.5">Quality checks ({detail.data.checks.length})</h3>
                {detail.data.checks.length === 0 ? (
                  <p className="text-ink-muted">No checks yet.</p>
                ) : (
                  <ul className="divide-y divide-line border border-line rounded">
                    {detail.data.checks.map((c) => {
                      const open = ['PENDING', 'DUE', 'IN_PROGRESS'].includes(c.status)
                      return (
                        <li key={c.id} className="px-3 py-2">
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-ink">{KIND_LABEL[c.kind ?? 'SCHEDULED']}</span>
                            <span className="text-ink-muted">{c.activityName}</span>
                            <span className="ml-auto">
                              {c.result ? <StatusBadge status={c.result} size="sm" /> : <span className="text-due font-semibold">{c.status === 'PENDING' ? 'Upcoming' : 'Due'}</span>}
                            </span>
                          </div>
                          <div className="text-ink-muted">
                            {open ? `Due ${formatDateTime(c.scheduledAt)}` : formatDateTime(c.submittedAt ?? c.scheduledAt)} · {c.submittedByName ?? c.workerName ?? '—'}
                          </div>
                          {c.values.length > 0 ? (
                            <div className="mt-1 flex flex-wrap gap-1">
                              {c.values.map((v, i) => (
                                <span key={i} className={`px-1.5 py-0.5 rounded border ${v.result === 'FAIL' ? 'border-missed-line bg-missed-bg text-missed' : 'border-line bg-white'}`}>
                                  {v.parameterName}: <span className="font-mono font-semibold">{v.notApplicable ? 'N/A' : v.value && /^(PASS|FAIL|YES|NO)$/.test(v.value) ? v.value[0] + v.value.slice(1).toLowerCase() : v.value ?? '—'}{v.unit && v.value ? ` ${v.unit}` : ''}</span>
                                </span>
                              ))}
                            </div>
                          ) : open && c.parameterIds?.length ? (
                            <div className="mt-1 text-ink-secondary">{c.parameterIds.length} parameter{c.parameterIds.length === 1 ? '' : 's'} to check</div>
                          ) : null}
                          {c.exception && <div className="mt-1 text-exception">Exception: {[c.exception.reason, c.exception.remark].filter(Boolean).join(' — ')}</div>}
                          {!open && (
                            <button type="button" className="mt-1 inline-flex items-center gap-1 text-accent hover:underline" onClick={() => onViewCheck(c.id)}>
                              Open check <ExternalLink className="w-3 h-3" />
                            </button>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                )}
              </section>
            </div>
          )}
        </DataState>
      </Drawer>

      {/* Plan / edit a job */}
      <Modal
        isOpen={planOpen}
        onClose={() => !saving && setPlanOpen(false)}
        title={editing ? 'Edit Planned Job' : 'Plan Job'}
        subtitle="The worker starts it on the machine; the Job Start check comes first"
        footer={
          <>
            <Button size="sm" variant="outline" onClick={() => setPlanOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" onClick={savePlan} loading={saving} icon={<Briefcase className="w-3.5 h-3.5" />}>
              {editing ? 'Save Changes' : 'Plan Job'}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <FormError message={planError} />
          <Field label="Machine" required>
            <Select value={plan.machineId} onChange={(e) => setPlan({ ...plan, machineId: e.target.value, assignedWorkerId: '' })}>
              <option value="">Choose a machine…</option>
              {machineOptions.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} ({m.code})
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Job No." required>
              <TextInput value={plan.jobNo} onChange={(e) => setPlan({ ...plan, jobNo: e.target.value })} className="font-mono" maxLength={60} />
            </Field>
            <Field label="Item Code">
              <TextInput value={plan.itemCode} onChange={(e) => setPlan({ ...plan, itemCode: e.target.value })} className="font-mono" maxLength={60} />
            </Field>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Worker" hint="Only workers assigned to this machine. Leave empty for any of them.">
              <Select value={plan.assignedWorkerId} onChange={(e) => setPlan({ ...plan, assignedWorkerId: e.target.value })} disabled={!plan.machineId}>
                <option value="">Any worker on the machine</option>
                {workersOn(plan.machineId).map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name} ({w.employeeId})
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Planned for">
              <DateInput value={plan.plannedFor} onChange={(e) => setPlan({ ...plan, plannedFor: e.target.value })} />
            </Field>
          </div>
          <Field label="Note">
            <TextArea rows={2} value={plan.note} onChange={(e) => setPlan({ ...plan, note: e.target.value })} maxLength={500} placeholder="Shown to the worker with the job" />
          </Field>
        </div>
      </Modal>

      {/* Handover by an Admin / Manager */}
      <Modal
        isOpen={!!handover}
        onClose={() => setHandover(null)}
        title="Handover Job"
        subtitle={handover ? `Job No. ${handover.job.jobNo} stays running; its open checks move to the chosen worker` : undefined}
        footer={
          <>
            <Button size="sm" variant="outline" onClick={() => setHandover(null)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" onClick={sendHandover} icon={<ArrowLeftRight className="w-3.5 h-3.5" />}>
              Hand over
            </Button>
          </>
        }
      >
        {handover && (
          <div className="space-y-3">
            <FormError message={handover.error} />
            <Field label="Next shift">
              <Select value={handover.shiftId} onChange={(e) => setHandover({ ...handover, shiftId: e.target.value })}>
                <option value="">Not specified</option>
                {(shifts ?? []).filter((s) => s.isActive).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Worker who takes over" required>
              <Select value={handover.toUserId} onChange={(e) => setHandover({ ...handover, toUserId: e.target.value, error: null })}>
                <option value="">Choose a worker…</option>
                {workersOn(handover.job.machineId)
                  .filter((w) => w.id !== handover.job.assignedWorkerId && w.appAccess)
                  .sort((a, b) => Number(b.shiftId === handover.shiftId) - Number(a.shiftId === handover.shiftId))
                  .map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name} ({w.employeeId})
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label="Note">
              <TextArea rows={2} value={handover.note} onChange={(e) => setHandover({ ...handover, note: e.target.value })} maxLength={500} />
            </Field>
          </div>
        )}
      </Modal>

      <ConfirmModal
        isOpen={!!closing}
        title={closing?.status === 'PLANNED' ? 'Cancel planned job?' : 'Force close job?'}
        message={
          closing?.status === 'PLANNED'
            ? `Job No. ${closing?.jobNo} is removed from the worker's list.`
            : `Job No. ${closing?.jobNo} is closed without its remaining checks. Open checks are removed; every submitted record stays with the job. This is recorded in the audit log.`
        }
        confirmLabel={closing?.status === 'PLANNED' ? 'Cancel job' : 'Force close'}
        danger
        onConfirm={async () => {
          if (!closing) return
          try {
            await api.post(`/api/jobs/${closing.id}/end`)
            notify('success', closing.status === 'PLANNED' ? 'Job cancelled' : 'Job closed', `Job No. ${closing.jobNo}`)
            refreshAll()
          } catch (err) {
            notify('error', 'Could not close the job', errorText(err))
          }
        }}
        onClose={() => setClosing(null)}
      />
    </div>
  )
}
