import React, { useMemo, useState } from 'react'
import { Text, View } from 'react-native'
import type { CheckKind, Department, JobHandover, JobRow, JobStatus, Machine, QualityCheck, Shift, User } from '../types'
import { api } from '../../services/api'
import { useStaff } from '../nav'
import { useQuery, errorText } from '../useQuery'
import { addDaysKey, dateKey, formatDateTime, formatKey, plural, type Tone } from '../format'
import { DeleteSheet, SelectMark, SelectionFooter, deletedMessage, useDeletePermissions, useSelection } from '../deletion'
import {
  AccessDenied,
  Badge,
  Chips,
  DataState,
  DateField,
  FormError,
  FormSection,
  Input,
  KV,
  List,
  Notice,
  PrimaryButton,
  Row,
  Screen,
  SearchField,
  Section,
  SelectField,
  SmallButton,
  StatusBadge,
  confirm,
  useToast
} from '../ui'

// Same data and rules as the web panel's Jobs page (admin-web/src/pages/admin/JobsPage.tsx).
// View needs the Jobs module; planning, handover and force close need Jobs manage. Nobody picks a
// job's department: the server works it out from the Item Code prefix set on Departments.

const STATUS: Record<JobStatus, { label: string; tone: Tone }> = {
  PLANNED: { label: 'Planned', tone: 'neutral' },
  STARTING: { label: 'Job Start check', tone: 'due' },
  ACTIVE: { label: 'Running', tone: 'success' },
  ENDING: { label: 'Job End check', tone: 'due' },
  COMPLETED: { label: 'Completed', tone: 'neutral' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' }
}
const KIND_LABEL: Record<CheckKind, string> = { SCHEDULED: 'Scheduled check', JOB_START: 'Job Start check', JOB_INTERVAL: 'Scheduled check', JOB_END: 'Job End check' }
const FILTERS: { value: string; label: string; statuses: JobStatus[] }[] = [
  { value: 'running', label: 'Active', statuses: ['STARTING', 'ACTIVE', 'ENDING'] },
  { value: 'planned', label: 'Planned', statuses: ['PLANNED'] },
  { value: 'completed', label: 'Completed', statuses: ['COMPLETED'] },
  { value: 'cancelled', label: 'Cancelled', statuses: ['CANCELLED'] },
  { value: 'all', label: 'All', statuses: [] }
]
/** A running job is never deleted: it has to be force-closed first (the server refuses too). */
const RUNNING: JobStatus[] = ['STARTING', 'ACTIVE', 'ENDING']
const JOB_NOUN: [string, string] = ['job', 'jobs']
const edgeText = (state: JobRow['startCheck']) => (state === 'NONE' ? 'None' : state === 'DONE' ? 'Done' : 'Pending')
const readingText = (value: string | null) => (value && /^(PASS|FAIL|YES|NO)$/.test(value) ? value[0] + value.slice(1).toLowerCase() : value ?? '—')

const checksLine = (j: JobRow) =>
  [
    `${j.counts.completed} done`,
    j.counts.due + j.counts.pending ? `${j.counts.due + j.counts.pending} pending` : null,
    j.counts.overdue ? `${j.counts.overdue} overdue` : null,
    j.counts.missed ? `${j.counts.missed} missed` : null,
    j.counts.exception ? plural(j.counts.exception, 'exception') : null
  ]
    .filter(Boolean)
    .join(' · ')

/** Jobs: active, planned and finished jobs with their worker, start/end check and check counts. */
const JobsScreen: React.FC = () => {
  const { can, push } = useStaff()
  const notify = useToast()
  const [filter, setFilter] = useState('running')
  const [machineId, setMachineId] = useState('')
  const [departmentId, setDepartmentId] = useState('')
  const [search, setSearch] = useState('')
  const [from, setFrom] = useState(addDaysKey(dateKey(), -29))
  const [to, setTo] = useState(dateKey())
  const statuses = FILTERS.find((f) => f.value === filter)!.statuses
  // Same as the web panel: running and planned jobs whenever they started, finished ones by date.
  const dated = filter !== 'running' && filter !== 'planned'
  const { data, error, loading, reload } = useQuery<JobRow[]>(can('jobs') ? '/api/jobs' : null, {
    status: statuses.join(','),
    machineId,
    ...(dated ? { from, to } : {})
  })
  const machines = useQuery<Machine[]>(can('jobs') ? '/api/machines' : null)
  const departments = useQuery<Department[]>(can('jobs') ? '/api/departments' : null)

  // The search and department narrow the loaded list as the user types, like the web panel.
  const jobs = useMemo(() => {
    const q = search.trim().toLowerCase()
    return (data ?? []).filter(
      (j) =>
        (!departmentId || j.departmentId === departmentId) &&
        (!q || j.jobNo.toLowerCase().includes(q) || (j.itemCode ?? '').toLowerCase().includes(q))
    )
  }, [data, search, departmentId])

  // Permanent delete: needs Delete Jobs (the server checks it again).
  const canDeleteJobs = useDeletePermissions().DELETE_JOBS
  const selection = useSelection(useMemo(() => (canDeleteJobs ? jobs.filter((j) => !RUNNING.includes(j.status)).map((j) => j.id) : []), [jobs, canDeleteJobs]))
  const [deleting, setDeleting] = useState(false)

  if (!can('jobs')) {
    return (
      <Screen title="Jobs">
        <AccessDenied title="You do not have permission to see jobs." message="It needs view access to Jobs." />
      </Screen>
    )
  }
  return (
    <Screen
      title="Jobs"
      subtitle="Start and end checks, scheduled checks and handovers"
      right={can('jobs', 'manage') && !selection.active ? { label: 'Plan', icon: 'add', onPress: () => push('jobPlan', {}) } : null}
      onRefresh={reload}
      refreshing={loading && !!data}
      footer={
        selection.active ? (
          <SelectionFooter
            count={selection.selected.length}
            noun={JOB_NOUN}
            allSelected={selection.allSelected}
            onToggleAll={selection.toggleAll}
            onCancel={selection.stop}
            onDelete={() => setDeleting(true)}
          />
        ) : undefined
      }
    >
      <SearchField value={search} onChangeText={setSearch} placeholder="Search by PO No. / Item" />
      <Chips options={FILTERS.map((f) => ({ value: f.value, label: f.label }))} value={filter} onChange={setFilter} />
      <SelectField
        label="Machine"
        value={machineId}
        emptyLabel="All machines"
        options={(machines.data ?? []).map((m) => ({ value: m.id, label: m.name, detail: m.code }))}
        onChange={setMachineId}
      />
      <SelectField
        label="Department"
        value={departmentId}
        emptyLabel="All departments"
        options={(departments.data ?? []).map((d) => ({ value: d.id, label: d.name }))}
        onChange={setDepartmentId}
      />
      {dated ? (
        <View className="flex-row gap-3">
          <View className="flex-1">
            <DateField label="From" value={from} onChange={(v) => v && setFrom(v)} />
          </View>
          <View className="flex-1">
            <DateField label="To" value={to} onChange={(v) => v && setTo(v)} />
          </View>
        </View>
      ) : null}
      {canDeleteJobs && !selection.active && jobs.some((j) => !RUNNING.includes(j.status)) ? (
        <SmallButton label="Select jobs to delete" icon="checkmark-circle-outline" onPress={selection.start} className="self-start" />
      ) : null}
      <DataState
        loading={loading}
        error={error}
        onRetry={reload}
        hasData={!!data}
        empty={!!data && jobs.length === 0}
        emptyText={search.trim() ? `No jobs match “${search.trim()}”.` : 'No jobs for these filters.'}
        emptyIcon="briefcase-outline"
      >
        <List>
          {jobs.map((j) => {
            const selectable = selection.active && !RUNNING.includes(j.status)
            return (
            <Row
              key={j.id}
              title={`PO No. ${j.jobNo}${j.itemCode ? ` · ${j.itemCode}` : ''}`}
              subtitle={`${j.machineName} · ${j.assignedWorkerName ?? 'Any worker'}`}
              detail={[
                j.startedAt ? `Started ${formatDateTime(j.startedAt)}` : j.plannedFor ? `Planned for ${formatKey(j.plannedFor)}` : 'Planned',
                j.status === 'PLANNED' ? null : checksLine(j),
                j.handovers ? plural(j.handovers, 'handover') : null
              ]
                .filter(Boolean)
                .join('\n')}
              detailLines={3}
              right={
                selection.active ? (
                  <SelectMark selected={selection.isSelected(j.id)} disabled={!selectable} />
                ) : (
                  <Badge label={STATUS[j.status].label} tone={STATUS[j.status].tone} />
                )
              }
              accessibilityLabel={
                selection.active ? `${selectable ? (selection.isSelected(j.id) ? 'Unselect' : 'Select') : 'Running, cannot select'} job ${j.jobNo}` : undefined
              }
              onPress={selection.active ? (selectable ? () => selection.toggle(j.id) : undefined) : () => push('jobDetail', { id: j.id })}
            />
            )
          })}
        </List>
      </DataState>
      {deleting ? (
        <DeleteSheet
          type="jobs"
          ids={selection.selected}
          bulk
          onClose={() => setDeleting(false)}
          onDeleted={(r) => {
            const m = deletedMessage(r, JOB_NOUN)
            notify('success', m.title, m.message)
            selection.stop()
            reload()
          }}
        />
      ) : null}
    </Screen>
  )
}

/** One job: details, handovers and every check with its readings; plan, handover and force close. */
const JobDetailScreen: React.FC<{ params: { id: string } }> = ({ params }) => {
  const { can, push, pop } = useStaff()
  const notify = useToast()
  const canDeleteJobs = useDeletePermissions().DELETE_JOBS
  const [deleting, setDeleting] = useState(false)
  const { data, error, loading, reload } = useQuery<{ job: JobRow; checks: QualityCheck[]; handovers: JobHandover[] }>(`/api/jobs/${params.id}`)
  const [closing, setClosing] = useState(false)
  const job = data?.job
  const canManage = can('jobs', 'manage')
  const running = !!job && ['STARTING', 'ACTIVE', 'ENDING'].includes(job.status)

  const close = async () => {
    if (!job) return
    const planned = job.status === 'PLANNED'
    const ok = await confirm(
      planned ? 'Cancel planned job?' : 'Force close job?',
      planned
        ? `PO No. ${job.jobNo} is removed from the worker's list.`
        : `PO No. ${job.jobNo} is closed without its remaining checks. Open checks are removed; submitted records stay with the job.`,
      planned ? 'Cancel job' : 'Force close',
      true
    )
    if (!ok) return
    setClosing(true)
    try {
      await api.post(`/api/jobs/${job.id}/end`, {})
      notify('success', planned ? 'Job cancelled' : 'Job closed', `PO No. ${job.jobNo}`)
      reload()
    } catch (err) {
      notify('error', 'Could not close the job', errorText(err))
    } finally {
      setClosing(false)
    }
  }

  return (
    <Screen title={job ? `PO No. ${job.jobNo}` : 'Job'} subtitle={job ? `${job.machineName} · ${job.machineCode}` : null} onRefresh={reload} refreshing={loading && !!data}>
      <DataState loading={loading} error={error} onRetry={reload} hasData={!!data}>
        {job && data ? (
          <>
            <Section title="Job">
              <List>
                <KV label="Status" value={<Badge label={`${STATUS[job.status].label}${job.forceClosed ? ' · force closed' : ''}`} tone={STATUS[job.status].tone} />} />
                <KV label="Item Code" value={job.itemCode ?? '—'} />
                <KV label="Department" value={job.departmentName ?? '—'} />
                <KV label="Worker now" value={job.assignedWorkerName ?? 'Any worker on the machine'} />
                <KV
                  label="Started"
                  value={job.startedAt ? formatDateTime(job.startedAt) : job.plannedFor ? `Planned for ${formatKey(job.plannedFor)}` : 'Not started'}
                  detail={job.startedByName}
                />
                <KV label="Job Start check" value={edgeText(job.startCheck)} />
                <KV label="Job End check" value={edgeText(job.endCheck)} />
                {job.endedAt ? <KV label="Ended" value={formatDateTime(job.endedAt)} detail={job.endedByName} /> : null}
                <KV label="Checks" value={checksLine(job)} />
                {job.note ? <KV label="Note" value={job.note} stacked /> : null}
              </List>
            </Section>

            {canManage && (job.status === 'PLANNED' || running) ? (
              <View className="flex-row flex-wrap gap-2">
                {job.status === 'PLANNED' ? <SmallButton label="Edit" icon="create-outline" onPress={() => push('jobPlan', { id: job.id })} /> : null}
                {running ? <SmallButton label="Handover" icon="swap-horizontal-outline" onPress={() => push('jobHandover', { id: job.id })} /> : null}
                <SmallButton label={job.status === 'PLANNED' ? 'Cancel job' : 'Force close'} tone="danger" icon="stop-circle-outline" loading={closing} onPress={close} />
              </View>
            ) : null}

            {canDeleteJobs ? (
              running ? (
                <Text className="text-[14px] leading-[19px] text-staff-muted">Force-close this job before deleting it.</Text>
              ) : (
                <SmallButton label="Delete job" tone="danger" icon="trash-outline" onPress={() => setDeleting(true)} className="self-start" />
              )
            ) : null}
            {deleting ? (
              <DeleteSheet
                type="jobs"
                ids={[job.id]}
                onClose={() => setDeleting(false)}
                onDeleted={(r) => {
                  const m = deletedMessage(r, JOB_NOUN)
                  notify('success', m.title, m.message)
                  pop()
                }}
              />
            ) : null}

            <Section title="Handovers" detail={plural(data.handovers.length, 'handover')}>
              {data.handovers.length === 0 ? (
                <Notice title="No handovers." />
              ) : (
                <List>
                  {data.handovers.map((h) => (
                    <Row
                      key={h.id}
                      title={`${h.fromName ?? '—'} → ${h.toName ?? '—'}`}
                      subtitle={`${formatDateTime(h.at)}${h.shiftName ? ` · ${h.shiftName}` : ''} · by ${h.byName ?? '—'}`}
                      detail={h.note}
                      detailLines={3}
                    />
                  ))}
                </List>
              )}
            </Section>

            <Section title="Quality checks" detail={plural(data.checks.length, 'check')}>
              {data.checks.length === 0 ? (
                <Notice title="No checks yet." />
              ) : (
                <List>
                  {data.checks.map((c) => {
                    const open = ['PENDING', 'DUE', 'IN_PROGRESS'].includes(c.status)
                    return (
                      <Row
                        key={c.id}
                        title={KIND_LABEL[c.kind ?? 'SCHEDULED']}
                        subtitle={`${open ? `Due ${formatDateTime(c.scheduledAt)}` : formatDateTime(c.submittedAt ?? c.scheduledAt)} · ${c.submittedByName ?? c.workerName ?? '—'}`}
                        detail={
                          [
                            c.values
                              .map((v) => `${v.parameterName}: ${v.notApplicable ? 'N/A' : `${readingText(v.value)}${v.unit && v.value ? ` ${v.unit}` : ''}`}${v.result === 'FAIL' ? ' (outside limits)' : ''}`)
                              .join('\n'),
                            c.exception ? `Exception: ${[c.exception.reason, c.exception.remark].filter(Boolean).join(' — ')}` : null
                          ]
                            .filter(Boolean)
                            .join('\n') || null
                        }
                        detailLines={30}
                        right={c.result ? <StatusBadge status={c.result} /> : <Badge label={c.status === 'PENDING' ? 'Upcoming' : 'Due'} tone="due" />}
                        onPress={open ? undefined : () => push('checkDetail', { id: c.id })}
                      />
                    )
                  })}
                </List>
              )}
            </Section>
          </>
        ) : null}
      </DataState>
    </Screen>
  )
}

/**
 * Plan a job (or edit a planned one): machine, PO No., Item Code, date and note. The Item Code is
 * required: the server works out the job's department from its prefix and refuses an Item Code
 * that matches no department, or a department with no quality checks on the machine.
 */
const JobPlanScreen: React.FC<{ params: { id?: string } }> = ({ params }) => {
  const { can, pop } = useStaff()
  const notify = useToast()
  const existing = useQuery<{ job: JobRow }>(params.id ? `/api/jobs/${params.id}` : null)
  const machines = useQuery<Machine[]>('/api/machines')
  const [form, setForm] = useState<{ machineId: string; jobNo: string; itemCode: string; plannedFor: string; note: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const job = existing.data?.job
  const value =
    form ??
    (params.id
      ? job
        ? { machineId: job.machineId, jobNo: job.jobNo, itemCode: job.itemCode ?? '', plannedFor: job.plannedFor ?? '', note: job.note ?? '' }
        : null
      : { machineId: '', jobNo: '', itemCode: '', plannedFor: dateKey(), note: '' })
  const set = (patch: Partial<NonNullable<typeof value>>) => value && setForm({ ...value, ...patch })

  if (!can('jobs', 'manage')) {
    return (
      <Screen title="Plan job">
        <AccessDenied title="You do not have permission to plan jobs." message="It needs manage access to Jobs." />
      </Screen>
    )
  }

  const save = async () => {
    if (!value) return
    if (!value.machineId) return setError('Choose the machine')
    if (!value.jobNo.trim()) return setError('Enter the PO No.')
    if (!value.itemCode.trim()) return setError('Enter the Item Code.')
    setSaving(true)
    setError(null)
    const body = {
      machineId: value.machineId,
      jobNo: value.jobNo.trim(),
      itemCode: value.itemCode.trim(),
      plannedFor: value.plannedFor || null,
      note: value.note.trim() || null
    }
    try {
      const saved = params.id ? await api.put<JobRow>(`/api/jobs/${params.id}`, body) : await api.post<JobRow>('/api/jobs', body)
      // The department the server worked out from the Item Code.
      const department = saved.departmentName ? ` · ${saved.departmentName}` : ''
      notify('success', params.id ? 'Job updated' : 'Job planned', `PO No. ${body.jobNo}${department} — any worker can start it on the machine`)
      pop()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Screen
      title={params.id ? 'Edit planned job' : 'Plan job'}
      subtitle="The worker starts it on the machine; the Job Start check comes first"
      footer={<PrimaryButton label={params.id ? 'Save changes' : 'Plan job'} onPress={save} loading={saving} disabled={!value} />}
    >
      <FormError message={error} />
      {value ? (
        <FormSection title="Job">
          <SelectField
            label="Machine"
            required
            value={value.machineId}
            placeholder="Choose a machine"
            options={(machines.data ?? []).filter((m) => m.isActive).map((m) => ({ value: m.id, label: m.name, detail: m.code }))}
            onChange={(machineId) => set({ machineId })}
          />
          <Input label="PO No." required value={value.jobNo} onChangeText={(jobNo) => set({ jobNo })} autoCapitalize="characters" maxLength={60} />
          <Input
            label="Item Code"
            required
            hint="The department is set automatically from the Item Code prefix (see Department Configuration in the admin panel)."
            value={value.itemCode}
            onChangeText={(itemCode) => set({ itemCode })}
            autoCapitalize="characters"
            maxLength={60}
          />
          <DateField label="Planned for" value={value.plannedFor} clearable onChange={(plannedFor) => set({ plannedFor })} />
          <Input label="Note" value={value.note} onChangeText={(note) => set({ note })} multiline maxLength={500} placeholder="Shown to the worker with the job" />
        </FormSection>
      ) : null}
    </Screen>
  )
}

/** An Admin / Manager hands a running job to another worker on the machine. */
const JobHandoverScreen: React.FC<{ params: { id: string } }> = ({ params }) => {
  const { can, pop } = useStaff()
  const notify = useToast()
  const detail = useQuery<{ job: JobRow }>(`/api/jobs/${params.id}`)
  const workers = useQuery<User[]>('/api/users', { role: 'WORKER' })
  const shifts = useQuery<Shift[]>('/api/shifts')
  const [toUserId, setToUserId] = useState('')
  const [shiftId, setShiftId] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const job = detail.data?.job
  if (!can('jobs', 'manage')) {
    return (
      <Screen title="Handover job">
        <AccessDenied title="You do not have permission to hand over jobs." message="It needs manage access to Jobs." />
      </Screen>
    )
  }
  const options = (workers.data ?? [])
    .filter((w) => job && w.isActive && w.appAccess && w.id !== job.assignedWorkerId)
    .sort((a, b) => Number(b.shiftId === shiftId) - Number(a.shiftId === shiftId))
  const save = async () => {
    if (!toUserId) return setError('Choose the worker')
    setSaving(true)
    setError(null)
    try {
      await api.post(`/api/jobs/${params.id}/handover`, { toUserId, shiftId: shiftId || null, note: note.trim() || undefined })
      notify('success', 'Job handed over', 'The job and its open checks moved; the worker was notified.')
      pop()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setSaving(false)
    }
  }
  return (
    <Screen
      title="Handover job"
      subtitle={job ? `PO No. ${job.jobNo} stays running; its open checks move to the chosen worker` : null}
      footer={<PrimaryButton label="Hand over" onPress={save} loading={saving} />}
    >
      <FormError message={error} />
      <FormSection title="Next worker">
        <SelectField
          label="Next shift"
          value={shiftId}
          emptyLabel="Not specified"
          options={(shifts.data ?? []).filter((s) => s.isActive).map((s) => ({ value: s.id, label: s.name }))}
          onChange={setShiftId}
        />
        <SelectField
          label="Worker who takes over"
          required
          value={toUserId}
          placeholder="Choose a worker"
          options={options.map((w) => ({ value: w.id, label: w.name, detail: w.employeeId }))}
          onChange={setToUserId}
        />
        <Input label="Note" value={note} onChangeText={setNote} multiline maxLength={500} />
        {job && options.length === 0 ? (
          <Text className="text-[14px] leading-[19px] text-staff-muted">No other worker with app access is assigned to this machine.</Text>
        ) : null}
      </FormSection>
    </Screen>
  )
}

export const JOBS_SCREENS = {
  jobs: JobsScreen,
  jobDetail: JobDetailScreen,
  jobPlan: JobPlanScreen,
  jobHandover: JobHandoverScreen
}
