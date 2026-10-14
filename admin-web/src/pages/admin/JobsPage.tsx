import React, { useMemo, useState } from 'react'
import {
  AlarmClock,
  AlertTriangle,
  ArrowLeftRight,
  Briefcase,
  CheckCircle2,
  ChevronRight,
  Clock3,
  ExternalLink,
  Flag,
  ListChecks,
  Pencil,
  Plus,
  RefreshCw,
  StopCircle,
  Trash2,
  XCircle
} from 'lucide-react'
import type { CheckKind, Department, JobHandover, JobRow, JobStatus, Machine, QualityCheck, Shift, User } from '../../types'
import { api, errorText } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { useModuleActions } from '../../lib/auth'
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
import { DeleteRecordsModal } from '../../components/common/DeleteRecordsModal'
import { BulkDeleteBar, RowCheckbox, useSelection } from '../../components/common/BulkSelection'
import { useDeletePermissions } from '../../lib/deletePermissions'
import { Card, EmptyState } from '../../components/ui/Card'
import { StatCard } from '../../components/ui/StatCard'
import { IconButton, ResultCount, SearchInput, Segmented, Toolbar, ToolbarSpacer } from '../../components/ui/Toolbar'
import { Pagination, usePagination } from '../../components/ui/Pagination'
import { itemCodeError } from '../../lib/itemCode'

/** Five KPI tiles with no empty cell: 2 + 2 + 1 (wide) on phones, 3 + 2 on tablets, one row on desktop. */
const KPI_GRID =
  'grid grid-cols-2 md:grid-cols-6 xl:grid-cols-5 gap-3 [&>*:last-child]:col-span-2 md:[&>*]:col-span-2 md:[&>*:nth-child(n+4)]:col-span-3 xl:[&>*]:col-span-1 xl:[&>*:nth-child(n+4)]:col-span-1'

/** A running job is never deleted: it has to be force-closed first (the server refuses too). */
const RUNNING: JobStatus[] = ['STARTING', 'ACTIVE', 'ENDING']

// Job status pills: soft tint, dot and text (never colour alone). Running is green, the Start /
// End check steps are "due" blue, finished and planned jobs stay neutral.
const STATUS: Record<JobStatus, { label: string; cls: string; dot: string }> = {
  PLANNED: { label: 'Planned', cls: 'bg-white text-ink-secondary ring-line-strong', dot: 'border border-ink-faint' },
  STARTING: { label: 'Job Start check', cls: 'bg-due-bg text-due ring-due-line', dot: 'bg-due' },
  ACTIVE: { label: 'Running', cls: 'bg-success-bg text-success ring-success-line', dot: 'bg-[var(--color-chart-completed)]' },
  ENDING: { label: 'Job End check', cls: 'bg-due-bg text-due ring-due-line', dot: 'bg-due' },
  COMPLETED: { label: 'Completed', cls: 'bg-subtle text-ink ring-line', dot: 'bg-ink-muted' },
  CANCELLED: { label: 'Cancelled', cls: 'bg-subtle text-ink-muted ring-line', dot: 'bg-ink-faint' }
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
  <span className={`inline-flex items-center gap-1.5 h-5 px-1.5 rounded-full ring-1 ring-inset text-[11px] font-medium whitespace-nowrap leading-none ${STATUS[status].cls}`}>
    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS[status].dot}`} aria-hidden />
    {STATUS[status].label}
    {forced ? ' · force closed' : ''}
  </span>
)

/** Job Start / Job End check state: Done, Pending, or a dash when the job has none. */
const EdgeState: React.FC<{ state: JobRow['startCheck']; label?: string }> = ({ state, label }) =>
  state === 'NONE' ? (
    <span className="inline-flex items-center gap-1 text-ink-faint" title={label ? `${label}: none` : undefined}>
      {label && <span className="text-[11px] text-ink-muted">{label}</span>}—
    </span>
  ) : state === 'DONE' ? (
    <span className="inline-flex items-center gap-1 text-success font-medium">
      <CheckCircle2 className="w-3.5 h-3.5" aria-hidden />
      {label && <span className="text-[11px] text-ink-muted font-normal">{label}</span>}
      Done
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-due font-medium">
      <Clock3 className="w-3.5 h-3.5" aria-hidden />
      {label && <span className="text-[11px] text-ink-muted font-normal">{label}</span>}
      Pending
    </span>
  )

const duration = (minutes: number) => (minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`)

interface PlanForm {
  machineId: string
  jobNo: string
  /** Required: its prefix decides the job's department, on the server. */
  itemCode: string
  plannedFor: string
  note: string
}
const emptyPlan: PlanForm = { machineId: '', jobNo: '', itemCode: '', plannedFor: '', note: '' }

/**
 * Jobs: plan and assign jobs, follow every running job (worker, Job Start / End check, pending,
 * missed and overdue checks, handovers), open one job with all its records, hand it over, or
 * force-close a stuck job.
 *
 * Nobody picks a job's department: the server works it out from the Item Code prefix, using the
 * prefixes set on the Department Configuration page. View needs the Jobs module; changes need Jobs manage.
 */
export const JobsPage: React.FC<{ onViewCheck: (id: string) => void; tabs?: React.ReactNode }> = ({ onViewCheck, tabs }) => {
  // Jobs in Roles & Permissions: create plans jobs; edit changes, hands over and closes them.
  const { canCreate: canPlan, canEdit: canManage, canWrite: canManageAny } = useModuleActions('jobs')
  const notify = useToast()
  const [filter, setFilter] = useState('running')
  const [machineId, setMachineId] = useState('')
  const [search, setSearch] = useState('')
  const [departmentFilter, setDepartmentFilter] = useState('')
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
  const { data: departments } = useApi<Department[]>('/api/departments')
  const { data: workers } = useApi<User[]>(canManageAny ? '/api/users' : null, { role: 'WORKER' })
  const { data: shifts } = useApi<Shift[]>(canManageAny ? '/api/shifts' : null)

  const [openId, setOpenId] = useState<string | null>(null)
  const detail = useApi<{ job: JobRow; checks: QualityCheck[]; handovers: JobHandover[] }>(openId ? `/api/jobs/${openId}` : null)

  const [planOpen, setPlanOpen] = useState(false)
  const [editing, setEditing] = useState<JobRow | null>(null)
  const [plan, setPlan] = useState<PlanForm>(emptyPlan)
  const [planError, setPlanError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [handover, setHandover] = useState<{ job: JobRow; toUserId: string; shiftId: string; note: string; error: string | null } | null>(null)
  const [handingOver, setHandingOver] = useState(false)
  const [closing, setClosing] = useState<JobRow | null>(null)

  // The list is loaded whole for the chosen status, machine and dates, so the search narrows it
  // as the user types without another request: PO No. or Item Code, any part, any case.
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    return (data ?? []).filter(
      (j) =>
        (!departmentFilter || j.departmentId === departmentFilter) &&
        (!q || j.jobNo.toLowerCase().includes(q) || (j.itemCode ?? '').toLowerCase().includes(q))
    )
  }, [data, search, departmentFilter])
  const refreshAll = () => {
    reload()
    if (openId) detail.reload()
  }

  // Permanent delete: needs Delete Jobs (checked again by the server).
  const canDeleteJobs = useDeletePermissions().DELETE_JOBS
  // Only one page of rows is rendered, and only rows on that page can be selected, so nothing out
  // of sight is ever deleted.
  const paging = usePagination(rows, 25, `${filter}|${machineId}|${search}|${departmentFilter}|${from}|${to}`)
  const selection = useSelection(
    useMemo(() => (canDeleteJobs ? paging.visible.filter((j) => !RUNNING.includes(j.status)).map((j) => j.id) : []), [paging.visible, canDeleteJobs])
  )
  const [deleting, setDeleting] = useState<{ ids: string[]; bulk: boolean } | null>(null)

  const openPlan = (job: JobRow | null) => {
    setEditing(job)
    setPlan(
      job
        ? { machineId: job.machineId, jobNo: job.jobNo, itemCode: job.itemCode ?? '', plannedFor: job.plannedFor ?? '', note: job.note ?? '' }
        : { ...emptyPlan, machineId: machineId || '', plannedFor: dateKey() }
    )
    setPlanError(null)
    setPlanOpen(true)
  }

  const savePlan = async () => {
    if (!plan.machineId) return setPlanError('Choose the machine')
    if (!plan.jobNo.trim()) return setPlanError('Enter the PO No.')
    if (!plan.itemCode.trim()) return setPlanError('Enter the Item Code.')
    if (itemCodeError(plan.itemCode)) return setPlanError(itemCodeError(plan.itemCode))
    setSaving(true)
    setPlanError(null)
    // No department: the server works it out from the Item Code, and refuses an Item Code it cannot place.
    const body = {
      machineId: plan.machineId,
      jobNo: plan.jobNo.trim(),
      itemCode: plan.itemCode.trim().toUpperCase(),
      plannedFor: plan.plannedFor || null,
      note: plan.note.trim() || null
    }
    try {
      const saved = editing ? await api.put<JobRow>(`/api/jobs/${editing.id}`, body) : await api.post<JobRow>('/api/jobs', body)
      notify(
        'success',
        editing ? 'Job updated' : 'Job planned',
        `PO No. ${body.jobNo}${saved?.departmentName ? ` · ${saved.departmentName}` : ''} — any worker can start it on the machine`
      )
      setPlanOpen(false)
      refreshAll()
    } catch (err) {
      setPlanError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  const sendHandover = async () => {
    if (!handover || handingOver) return
    if (!handover.toUserId) return setHandover({ ...handover, error: 'Choose the worker' })
    setHandingOver(true)
    try {
      await api.post(`/api/jobs/${handover.job.id}/handover`, { toUserId: handover.toUserId, shiftId: handover.shiftId || null, note: handover.note.trim() || undefined })
      notify('success', 'Job handed over', `PO No. ${handover.job.jobNo} and its open checks moved; the worker was notified.`)
      setHandover(null)
      refreshAll()
    } catch (err) {
      setHandover({ ...handover, error: errorText(err) })
    } finally {
      setHandingOver(false)
    }
  }

  const machineOptions = (machines ?? []).filter((m) => m.isActive)
  // useApi keeps the previous answer while the next one loads: only the job that is open now is
  // shown and acted on, never the one opened before it.
  const current = detail.data?.job?.id === openId ? detail.data : null
  const job = current?.job

  // KPI strip: worked out from the jobs on screen (the list is loaded for the chosen status tab).
  const kpi = useMemo(() => {
    const k = { running: 0, edge: 0, planned: 0, overdue: 0, missed: 0, handovers: 0 }
    for (const j of rows) {
      if (j.status === 'ACTIVE') k.running++
      if (j.status === 'STARTING' || j.status === 'ENDING') k.edge++
      if (j.status === 'PLANNED') k.planned++
      k.overdue += j.counts.overdue
      k.missed += j.counts.missed
      k.handovers += j.handovers
    }
    return k
  }, [rows])
  const filterLabel = FILTERS.find((f) => f.key === filter)!.label
  const activeSelect = 'border-accent bg-accent-soft/40'

  return (
    <div className="space-y-5">
      <PageHeader
        tabs={tabs}
        icon={<Briefcase className="w-4.5 h-4.5" />}
        title="Quality Monitoring"
        description={data === null ? 'Jobs, their checks and handovers' : `${rows.length} ${rows.length === 1 ? 'job' : 'jobs'} · ${filterLabel.toLowerCase()}${dated ? ` · ${formatDate(from)} – ${formatDate(to)}` : ''}`}
        info="Plan and assign jobs, follow every running job (worker, Job Start / End check, pending, missed and overdue checks, handovers), open one job with all its records, hand it over, or force-close a stuck job. Nobody picks a job's department: it comes from the Item Code prefix set on Department Configuration."
        actions={
          <>
            <IconButton label="Refresh" size="md" onClick={refreshAll} className="border border-line-strong bg-white">
              <RefreshCw className={`w-4 h-4 ${loading && data !== null ? 'animate-spin' : ''}`} />
            </IconButton>
            {canPlan && (
              <Button size="sm" variant="primary" onClick={() => openPlan(null)} icon={<Plus className="w-3.5 h-3.5" />}>
                Plan Job
              </Button>
            )}
          </>
        }
      />

      {data !== null && (
        <div className={KPI_GRID}>
          <StatCard
            label="Jobs"
            value={rows.length}
            icon={<Briefcase className="w-4 h-4" />}
            meta={filter === 'running' ? `${kpi.running} running` : filter === 'all' ? `${kpi.running} running · ${kpi.planned} planned` : filterLabel}
          />
          <StatCard label="Start / End check" value={kpi.edge} icon={<Flag className="w-4 h-4" />} tone="due" meta="Job Start or End check due" />
          <StatCard
            label="Overdue checks"
            value={kpi.overdue}
            icon={<AlarmClock className="w-4 h-4" />}
            tone={kpi.overdue > 0 ? 'missed' : 'neutral'}
            alert={kpi.overdue > 0}
            meta={kpi.overdue > 0 ? 'Past their time window' : 'None'}
          />
          <StatCard label="Missed checks" value={kpi.missed} icon={<XCircle className="w-4 h-4" />} tone={kpi.missed > 0 ? 'missed' : 'neutral'} meta="On these jobs" />
          <StatCard label="Handovers" value={kpi.handovers} icon={<ArrowLeftRight className="w-4 h-4" />} meta="Between workers" />
        </div>
      )}

      {canDeleteJobs && (
        <BulkDeleteBar
          count={selection.selected.length}
          noun={selection.selected.length === 1 ? 'job' : 'jobs'}
          onClear={selection.clear}
          onDelete={() => setDeleting({ ids: selection.selected, bulk: true })}
        />
      )}

      <Card className="overflow-hidden">
        <Toolbar>
          <SearchInput value={search} onChange={setSearch} placeholder="Search by PO No. / Item" label="Search by PO No. / Item" />
          <Segmented label="Filter by job status" value={filter} onChange={setFilter} options={FILTERS.map((f) => ({ value: f.key, label: f.label }))} />
          <select
            value={machineId}
            onChange={(e) => setMachineId(e.target.value)}
            aria-label="Machine"
            className={`${inputClass} px-2 w-full sm:w-auto sm:min-w-[150px] ${machineId ? activeSelect : ''}`}
          >
            <option value="">All machines</option>
            {(machines ?? []).map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} ({m.code})
              </option>
            ))}
          </select>
          <select
            value={departmentFilter}
            onChange={(e) => setDepartmentFilter(e.target.value)}
            aria-label="Department"
            className={`${inputClass} px-2 w-full sm:w-auto sm:min-w-[150px] ${departmentFilter ? activeSelect : ''}`}
          >
            <option value="">All departments</option>
            {(departments ?? []).map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          {/* Finished jobs are listed by date; running and planned ones whenever they started. */}
          {dated && (
            <span className="flex items-center gap-1.5">
              <DateInput value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} aria-label="From" className="w-[150px] lg:w-[132px]" />
              <span className="text-ink-muted" aria-hidden>
                –
              </span>
              <DateInput value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} aria-label="To" className="w-[150px] lg:w-[132px]" />
            </span>
          )}
          <ToolbarSpacer />
          {data !== null && <ResultCount shown={rows.length} total={data.length} noun="jobs" />}
        </Toolbar>

        {error || data === null ? (
          <div className="p-3">
            <DataState loading={loading} error={error} onRetry={reload}>
              {null}
            </DataState>
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Briefcase className="w-5 h-5" />}
            title={search.trim() ? `No jobs match “${search.trim()}”.` : 'No jobs for these filters.'}
            action={
              canPlan && !search.trim() ? (
                <Button size="sm" variant="outline" onClick={() => openPlan(null)} icon={<Plus className="w-3.5 h-3.5" />}>
                  Plan Job
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table stack-sm">
              <thead>
                <tr>
                  {canDeleteJobs && (
                    <th className="w-8 !pr-0">
                      <RowCheckbox checked={selection.allChecked} indeterminate={selection.partial} onChange={selection.toggleAll} label="Select all jobs shown that are not running" />
                    </th>
                  )}
                  <th>PO No. / Item</th>
                  <th>Machine</th>
                  <th>Status</th>
                  <th>Worker / started</th>
                  <th>Checks</th>
                  {/* Named by aria-label, not text: the phone card layout copies header text into each cell. */}
                  <th className="text-right" aria-label="Details" />
                </tr>
              </thead>
              <tbody>
                {paging.visible.map((j) => (
                  <tr key={j.id} className="cursor-pointer" onClick={() => setOpenId(j.id)}>
                    {canDeleteJobs && (
                      <td className="!pr-0">
                        {RUNNING.includes(j.status) ? (
                          <span title="Running jobs must be force-closed before they can be deleted" className="sr-only">
                            Running
                          </span>
                        ) : (
                          <RowCheckbox checked={selection.isSelected(j.id)} onChange={() => selection.toggle(j.id)} label={`Select job ${j.jobNo}`} />
                        )}
                      </td>
                    )}
                    <td className="whitespace-nowrap">
                      <div className="font-mono font-semibold text-ink">{j.jobNo}</div>
                      <div className="font-mono text-[11px] text-ink-muted">{j.itemCode ?? '—'}</div>
                    </td>
                    <td className="whitespace-nowrap">
                      <div className="text-ink">{j.machineName}</div>
                      <div className="text-[11.5px] text-ink-muted">{[j.machineCode, j.departmentName].filter(Boolean).join(' · ')}</div>
                    </td>
                    <td className="whitespace-nowrap">
                      <StatusPill status={j.status} forced={j.forceClosed} />
                      {/* Job Start / Job End check state under the status, instead of two more columns. */}
                      <div className="mt-1 flex items-center gap-2.5 text-[11.5px]">
                        <EdgeState state={j.startCheck} label="Start" />
                        <EdgeState state={j.endCheck} label="End" />
                      </div>
                    </td>
                    <td className="whitespace-nowrap">
                      {j.assignedWorkerName ?? <span className="text-ink-muted">Any worker</span>}
                      {/* When it started (and for how long), or when it is planned for. */}
                      <div className="text-[11.5px] text-ink-muted tabular-nums">
                        {j.startedAt ? `${formatDateTime(j.startedAt)} · ${duration(j.durationMinutes ?? 0)}` : j.plannedFor ? `Planned ${formatDate(j.plannedFor)}` : 'Planned'}
                      </div>
                      {j.handovers > 0 && (
                        <div className="flex items-center gap-1 text-[11.5px] text-ink-muted">
                          <ArrowLeftRight className="w-3 h-3" aria-hidden />
                          {j.handovers} handover{j.handovers === 1 ? '' : 's'}
                        </div>
                      )}
                    </td>
                    <td className="whitespace-nowrap">
                      <CheckCounts counts={j.counts} />
                    </td>
                    <td className="text-right" data-label="">
                      <IconButton
                        label={`Open job ${j.jobNo}`}
                        onClick={(e) => {
                          e.stopPropagation()
                          setOpenId(j.id)
                        }}
                      >
                        <ChevronRight className="w-4 h-4" />
                      </IconButton>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination page={paging.page} pages={paging.pages} total={paging.total} pageSize={paging.pageSize} onPage={paging.setPage} noun="jobs" />
      </Card>

      {/* One job with all its records */}
      <Drawer isOpen={!!openId} onClose={() => setOpenId(null)} title={job ? `PO No. ${job.jobNo}` : 'Job'} subtitle={job ? `${job.machineName} · ${job.machineCode}${job.departmentName ? ` · ${job.departmentName}` : ''}` : undefined} width="xl"
        footer={
          job && (canManage || canDeleteJobs) ? (
            <div className="flex flex-wrap gap-2 justify-end w-full">
              {canDeleteJobs && !RUNNING.includes(job.status) && (
                <Button size="sm" variant="outline" className="mr-auto" icon={<Trash2 className="w-3.5 h-3.5 text-failed" />} onClick={() => setDeleting({ ids: [job.id], bulk: false })}>
                  Delete job
                </Button>
              )}
              {canDeleteJobs && RUNNING.includes(job.status) && (
                <span className="mr-auto self-center text-[11.5px] text-ink-muted">Force-close this job before deleting it.</span>
              )}
              {canManage && job.status === 'PLANNED' && (
                <Button size="sm" variant="outline" icon={<Pencil className="w-3.5 h-3.5" />} onClick={() => openPlan(job)}>
                  Edit
                </Button>
              )}
              {canManage && ['STARTING', 'ACTIVE', 'ENDING'].includes(job.status) && (
                <Button
                  size="sm"
                  variant="outline"
                  icon={<ArrowLeftRight className="w-3.5 h-3.5" />}
                  onClick={() => setHandover({ job, toUserId: '', shiftId: '', note: '', error: null })}
                >
                  Handover
                </Button>
              )}
              {canManage && !['COMPLETED', 'CANCELLED'].includes(job.status) && (
                <Button size="sm" variant="danger" icon={<StopCircle className="w-3.5 h-3.5" />} onClick={() => setClosing(job)}>
                  {job.status === 'PLANNED' ? 'Cancel job' : 'Force close'}
                </Button>
              )}
            </div>
          ) : undefined
        }
      >
        <DataState loading={detail.loading && !current} error={detail.loading ? null : detail.error} onRetry={detail.reload}>
          {job && current && (
            <div className="space-y-5">
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill status={job.status} forced={job.forceClosed} />
                <CheckCounts counts={job.counts} />
              </div>

              <dl className="grid grid-cols-2 gap-px rounded-lg border border-line bg-line overflow-hidden">
                <DrawerFact label="Item Code" value={<span className="font-mono">{job.itemCode ?? '—'}</span>} />
                <DrawerFact label="Worker now" value={job.assignedWorkerName ?? 'Any worker on the machine'} />
                <DrawerFact
                  label="Started"
                  value={job.startedAt ? formatDateTime(job.startedAt) : job.plannedFor ? `Planned for ${formatDate(job.plannedFor)}` : 'Not started'}
                  detail={job.startedAt && job.startedByName ? `by ${job.startedByName}` : undefined}
                />
                <DrawerFact
                  label="Ended"
                  value={job.endedAt ? formatDateTime(job.endedAt) : '—'}
                  detail={job.endedAt && job.endedByName ? `by ${job.endedByName}` : undefined}
                />
                <DrawerFact label="Job Start check" value={<EdgeState state={job.startCheck} />} />
                <DrawerFact label="Job End check" value={<EdgeState state={job.endCheck} />} />
                {job.note && <DrawerFact label="Note" value={job.note} wide />}
              </dl>

              <section>
                <DrawerHeading icon={<ArrowLeftRight className="w-3.5 h-3.5" />} title="Handovers" count={current.handovers.length} />
                {current.handovers.length === 0 ? (
                  <p className="text-[12px] text-ink-muted">No handovers.</p>
                ) : (
                  <ul className="divide-y divide-line border border-line rounded-lg">
                    {current.handovers.map((h) => (
                      <li key={h.id} className="px-3 py-2.5 text-[12.5px]">
                        <div className="font-semibold text-ink">
                          {h.fromName ?? '—'} <span className="text-ink-muted font-normal">→</span> {h.toName ?? '—'}
                        </div>
                        <div className="text-[11.5px] text-ink-muted">
                          {formatDateTime(h.at)}
                          {h.shiftName ? ` · ${h.shiftName}` : ''} · by {h.byName ?? '—'} · {h.movedChecks} open check{h.movedChecks === 1 ? '' : 's'} moved
                        </div>
                        {h.note && <div className="mt-0.5 text-ink-secondary">{h.note}</div>}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section>
                <DrawerHeading icon={<ListChecks className="w-3.5 h-3.5" />} title="Quality checks" count={current.checks.length} />
                {current.checks.length === 0 ? (
                  <p className="text-[12px] text-ink-muted">No checks yet.</p>
                ) : (
                  <ul className="divide-y divide-line border border-line rounded-lg">
                    {current.checks.map((c) => {
                      const open = ['PENDING', 'DUE', 'IN_PROGRESS'].includes(c.status)
                      return (
                        <li key={c.id} className="px-3 py-2.5 text-[12.5px]">
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-ink">{KIND_LABEL[c.kind ?? 'SCHEDULED']}</span>
                            <span className="text-ink-muted truncate">{c.activityName}</span>
                            <span className="ml-auto flex items-center gap-1 shrink-0">
                              {c.result ? (
                                <StatusBadge status={c.result} size="sm" />
                              ) : (
                                <span className="inline-flex items-center gap-1.5 h-5 px-1.5 rounded-full ring-1 ring-inset ring-due-line bg-due-bg text-due text-[11px] font-medium">
                                  <Clock3 className="w-3 h-3" aria-hidden />
                                  {c.status === 'PENDING' ? 'Upcoming' : 'Due'}
                                </span>
                              )}
                              {!open && (
                                <IconButton label={`Open check ${c.code}`} onClick={() => onViewCheck(c.id)}>
                                  <ExternalLink className="w-3.5 h-3.5" />
                                </IconButton>
                              )}
                            </span>
                          </div>
                          <div className="text-[11.5px] text-ink-muted">
                            {open ? `Due ${formatDateTime(c.scheduledAt)}` : formatDateTime(c.submittedAt ?? c.scheduledAt)} · {c.submittedByName ?? c.workerName ?? '—'}
                          </div>
                          {c.values.length > 0 ? (
                            <div className="mt-1.5 flex flex-wrap gap-1">
                              {c.values.map((v, i) => (
                                <span
                                  key={i}
                                  className={`px-1.5 py-0.5 rounded-md text-[11.5px] ring-1 ring-inset ${v.result === 'FAIL' ? 'ring-missed-line bg-missed-bg text-missed' : 'ring-line bg-subtle text-ink-secondary'}`}
                                  title={v.result === 'FAIL' ? 'Outside limits' : undefined}
                                >
                                  {v.parameterName}:{' '}
                                  <span className="font-mono font-semibold">
                                    {v.notApplicable ? 'N/A' : v.value && /^(PASS|FAIL|YES|NO)$/.test(v.value) ? v.value[0] + v.value.slice(1).toLowerCase() : v.value ?? '—'}
                                    {v.unit && v.value ? ` ${v.unit}` : ''}
                                  </span>
                                </span>
                              ))}
                            </div>
                          ) : open && c.parameterIds?.length ? (
                            <div className="mt-1 text-ink-secondary">
                              {c.parameterIds.length} parameter{c.parameterIds.length === 1 ? '' : 's'} to check
                            </div>
                          ) : null}
                          {c.exception && (
                            <div className="mt-1.5 flex items-start gap-1 text-exception">
                              <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" aria-hidden />
                              <span>Exception: {[c.exception.reason, c.exception.reading, c.exception.remark].filter(Boolean).join(' — ')}</span>
                            </div>
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
            <Select value={plan.machineId} onChange={(e) => setPlan({ ...plan, machineId: e.target.value })}>
              <option value="">Choose a machine…</option>
              {machineOptions.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} ({m.code})
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="PO No." required>
              <TextInput value={plan.jobNo} onChange={(e) => setPlan({ ...plan, jobNo: e.target.value })} className="font-mono" maxLength={60} />
            </Field>
            <Field label="Item Code" required hint="Several allowed, separated by commas (FGPO123, FGPO234), all of one department. The department is set automatically from the Item Code prefix (see Department Configuration)." error={itemCodeError(plan.itemCode) ?? undefined}>
              <TextInput value={plan.itemCode} onChange={(e) => setPlan({ ...plan, itemCode: e.target.value })} className="font-mono" maxLength={60} />
            </Field>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Planned for" hint="The worker who starts this job on the machine becomes responsible for it.">
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
        subtitle={handover ? `PO No. ${handover.job.jobNo} stays running; its open checks move to the chosen worker` : undefined}
        footer={
          <>
            <Button size="sm" variant="outline" onClick={() => setHandover(null)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" onClick={sendHandover} loading={handingOver} icon={<ArrowLeftRight className="w-3.5 h-3.5" />}>
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
                {(workers ?? [])
                  .filter((w) => w.isActive && w.appAccess && w.id !== handover.job.assignedWorkerId)
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
            ? `PO No. ${closing?.jobNo} is removed from the worker's list.`
            : `PO No. ${closing?.jobNo} is closed without its remaining checks. Open checks are removed; every submitted record stays with the job. This is recorded in the audit log.`
        }
        confirmLabel={closing?.status === 'PLANNED' ? 'Cancel job' : 'Force close'}
        danger
        onConfirm={async () => {
          if (!closing) return
          try {
            await api.post(`/api/jobs/${closing.id}/end`)
            notify('success', closing.status === 'PLANNED' ? 'Job cancelled' : 'Job closed', `PO No. ${closing.jobNo}`)
            refreshAll()
          } catch (err) {
            notify('error', 'Could not close the job', errorText(err))
          }
        }}
        onClose={() => setClosing(null)}
      />

      <DeleteRecordsModal
        type={deleting ? 'jobs' : null}
        ids={deleting?.ids ?? []}
        bulk={deleting?.bulk}
        onClose={() => setDeleting(null)}
        onDeleted={(r) => {
          notify('success', r.deleted === 1 ? 'Job deleted' : `${r.deleted} jobs deleted`, `${r.filesRemoved} evidence file${r.filesRemoved === 1 ? '' : 's'} removed. Recorded in the audit log.`)
          if (r.filesNotRemoved.length) notify('error', 'Some files could not be removed', `${r.filesNotRemoved.length} evidence file(s) are still on the server.`)
          selection.clear()
          if (deleting && openId && deleting.ids.includes(openId)) setOpenId(null)
          reload()
        }}
      />
    </div>
  )
}

/** A job's check counts as compact pills: done, pending, overdue, missed, exception (zeros left out). */
const CheckCounts: React.FC<{ counts: JobRow['counts'] }> = ({ counts }) => {
  const pending = counts.due + counts.pending
  const pill = 'inline-flex items-center h-5 px-1.5 rounded-full ring-1 ring-inset text-[11px] font-medium tabular-nums whitespace-nowrap'
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span className={`${pill} bg-success-bg text-success ring-success-line`}>{counts.completed} done</span>
      {pending > 0 && <span className={`${pill} bg-due-bg text-due ring-due-line`}>{pending} pending</span>}
      {counts.overdue > 0 && <span className={`${pill} bg-missed-bg text-missed ring-missed-line font-semibold`}>{counts.overdue} overdue</span>}
      {counts.missed > 0 && <span className={`${pill} bg-missed-bg text-missed ring-missed-line`}>{counts.missed} missed</span>}
      {counts.exception > 0 && <span className={`${pill} bg-exception-bg text-exception ring-exception-line`}>{counts.exception} exception</span>}
    </span>
  )
}

/** One fact in the job drawer's summary grid. */
const DrawerFact: React.FC<{ label: string; value: React.ReactNode; detail?: string; wide?: boolean }> = ({ label, value, detail, wide }) => (
  <div className={`bg-white px-3 py-2.5 min-w-0 ${wide ? 'col-span-2' : ''}`}>
    <dt className="text-[11.5px] text-ink-muted">{label}</dt>
    <dd className="mt-0.5 text-[13px] font-medium text-ink break-words">{value}</dd>
    {detail && <dd className="text-[11.5px] text-ink-muted">{detail}</dd>}
  </div>
)

/** Small section heading inside the job drawer, with the number of records. */
const DrawerHeading: React.FC<{ icon: React.ReactNode; title: string; count: number }> = ({ icon, title, count }) => (
  <h3 className="flex items-center gap-1.5 mb-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-muted">
    <span aria-hidden>{icon}</span>
    {title}
    <span className="ml-0.5 min-w-5 h-[18px] px-1 inline-flex items-center justify-center rounded-full bg-subtle text-ink-secondary text-[11px] tabular-nums normal-case tracking-normal">{count}</span>
  </h3>
)
