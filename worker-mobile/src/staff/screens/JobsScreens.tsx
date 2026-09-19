import React, { useMemo, useState } from 'react'
import { Text, View } from 'react-native'
import type { CheckKind, JobHandover, JobRow, JobStatus, Machine, QualityCheck, Shift, User } from '../types'
import { api } from '../../services/api'
import { useStaff } from '../nav'
import { useQuery, errorText } from '../useQuery'
import { dateKey, formatDateTime, formatKey, plural, type Tone } from '../format'
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
  Section,
  SelectField,
  SmallButton,
  StatusBadge,
  confirm,
  useToast
} from '../ui'

// Same data and rules as the web panel's Jobs page (admin-web/src/pages/admin/JobsPage.tsx).

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
  { value: 'all', label: 'All', statuses: [] }
]
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
  const [filter, setFilter] = useState('running')
  const statuses = FILTERS.find((f) => f.value === filter)!.statuses
  const { data, error, loading, reload } = useQuery<JobRow[]>(can('checks') ? '/api/jobs' : null, {
    status: statuses.join(','),
    // Finished jobs of the last 30 days; running and planned jobs whenever they started.
    ...(filter === 'completed' || filter === 'all' ? { from: dateKey(new Date(Date.now() - 29 * 86_400_000)), to: dateKey() } : {})
  })
  if (!can('checks')) {
    return (
      <Screen title="Jobs">
        <AccessDenied title="You do not have permission to see jobs." message="It needs view access to Quality Checks." />
      </Screen>
    )
  }
  const jobs = data ?? []
  return (
    <Screen
      title="Jobs"
      subtitle="Start and end checks, scheduled checks and handovers"
      right={can('checks', 'manage') ? { label: 'Plan', icon: 'add', onPress: () => push('jobPlan', {}) } : null}
      onRefresh={reload}
      refreshing={loading && !!data}
    >
      <Chips options={FILTERS.map((f) => ({ value: f.value, label: f.label }))} value={filter} onChange={setFilter} />
      <DataState loading={loading} error={error} onRetry={reload} hasData={!!data} empty={!!data && jobs.length === 0} emptyText="No jobs here." emptyIcon="briefcase-outline">
        <List>
          {jobs.map((j) => (
            <Row
              key={j.id}
              title={`Job No. ${j.jobNo}${j.itemCode ? ` · ${j.itemCode}` : ''}`}
              subtitle={`${j.machineName} · ${j.assignedWorkerName ?? 'Any worker'}`}
              detail={[
                j.startedAt ? `Started ${formatDateTime(j.startedAt)}` : j.plannedFor ? `Planned for ${formatKey(j.plannedFor)}` : 'Planned',
                j.status === 'PLANNED' ? null : checksLine(j),
                j.handovers ? plural(j.handovers, 'handover') : null
              ]
                .filter(Boolean)
                .join('\n')}
              detailLines={3}
              right={<Badge label={STATUS[j.status].label} tone={STATUS[j.status].tone} />}
              onPress={() => push('jobDetail', { id: j.id })}
            />
          ))}
        </List>
      </DataState>
    </Screen>
  )
}

/** One job: details, handovers and every check with its readings; plan, handover and force close. */
const JobDetailScreen: React.FC<{ params: { id: string } }> = ({ params }) => {
  const { can, push } = useStaff()
  const notify = useToast()
  const { data, error, loading, reload } = useQuery<{ job: JobRow; checks: QualityCheck[]; handovers: JobHandover[] }>(`/api/jobs/${params.id}`)
  const [closing, setClosing] = useState(false)
  const job = data?.job
  const canManage = can('checks', 'manage')
  const running = !!job && ['STARTING', 'ACTIVE', 'ENDING'].includes(job.status)

  const close = async () => {
    if (!job) return
    const planned = job.status === 'PLANNED'
    const ok = await confirm(
      planned ? 'Cancel planned job?' : 'Force close job?',
      planned
        ? `Job No. ${job.jobNo} is removed from the worker's list.`
        : `Job No. ${job.jobNo} is closed without its remaining checks. Open checks are removed; submitted records stay with the job.`,
      planned ? 'Cancel job' : 'Force close',
      true
    )
    if (!ok) return
    setClosing(true)
    try {
      await api.post(`/api/jobs/${job.id}/end`, {})
      notify('success', planned ? 'Job cancelled' : 'Job closed', `Job No. ${job.jobNo}`)
      reload()
    } catch (err) {
      notify('error', 'Could not close the job', errorText(err))
    } finally {
      setClosing(false)
    }
  }

  return (
    <Screen title={job ? `Job No. ${job.jobNo}` : 'Job'} subtitle={job ? `${job.machineName} · ${job.machineCode}` : null} onRefresh={reload} refreshing={loading && !!data}>
      <DataState loading={loading} error={error} onRetry={reload} hasData={!!data}>
        {job && data ? (
          <>
            <Section title="Job">
              <List>
                <KV label="Status" value={<Badge label={`${STATUS[job.status].label}${job.forceClosed ? ' · force closed' : ''}`} tone={STATUS[job.status].tone} />} />
                <KV label="Item Code" value={job.itemCode ?? '—'} />
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

/** Plan a job (or edit a planned one): machine, Job No., Item Code, worker, date and note. */
const JobPlanScreen: React.FC<{ params: { id?: string } }> = ({ params }) => {
  const { can, pop } = useStaff()
  const notify = useToast()
  const existing = useQuery<{ job: JobRow }>(params.id ? `/api/jobs/${params.id}` : null)
  const machines = useQuery<Machine[]>('/api/machines')
  const workers = useQuery<User[]>('/api/users', { role: 'WORKER' })
  const [form, setForm] = useState<{ machineId: string; jobNo: string; itemCode: string; assignedWorkerId: string; plannedFor: string; note: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const job = existing.data?.job
  const value =
    form ??
    (params.id
      ? job
        ? { machineId: job.machineId, jobNo: job.jobNo, itemCode: job.itemCode ?? '', assignedWorkerId: job.assignedWorkerId ?? '', plannedFor: job.plannedFor ?? '', note: job.note ?? '' }
        : null
      : { machineId: '', jobNo: '', itemCode: '', assignedWorkerId: '', plannedFor: dateKey(), note: '' })
  const set = (patch: Partial<NonNullable<typeof value>>) => value && setForm({ ...value, ...patch })
  const onMachine = useMemo(() => (workers.data ?? []).filter((w) => w.isActive && value && w.machineIds.includes(value.machineId)), [workers.data, value])

  if (!can('checks', 'manage')) {
    return (
      <Screen title="Plan job">
        <AccessDenied title="You do not have permission to plan jobs." message="It needs manage access to Quality Checks." />
      </Screen>
    )
  }

  const save = async () => {
    if (!value) return
    if (!value.machineId) return setError('Choose the machine')
    if (!value.jobNo.trim()) return setError('Enter the Job No.')
    setSaving(true)
    setError(null)
    const body = {
      machineId: value.machineId,
      jobNo: value.jobNo.trim(),
      itemCode: value.itemCode.trim() || null,
      assignedWorkerId: value.assignedWorkerId || null,
      plannedFor: value.plannedFor || null,
      note: value.note.trim() || null
    }
    try {
      if (params.id) await api.put(`/api/jobs/${params.id}`, body)
      else await api.post('/api/jobs', body)
      notify('success', params.id ? 'Job updated' : 'Job planned', `Job No. ${body.jobNo}`)
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
            onChange={(machineId) => set({ machineId, assignedWorkerId: '' })}
          />
          <Input label="Job No." required value={value.jobNo} onChangeText={(jobNo) => set({ jobNo })} autoCapitalize="characters" maxLength={60} />
          <Input label="Item Code" value={value.itemCode} onChangeText={(itemCode) => set({ itemCode })} autoCapitalize="characters" maxLength={60} />
          <SelectField
            label="Worker"
            hint="Only workers assigned to this machine"
            value={value.assignedWorkerId}
            emptyLabel="Any worker on the machine"
            disabled={!value.machineId}
            options={onMachine.map((w) => ({ value: w.id, label: w.name, detail: w.employeeId }))}
            onChange={(assignedWorkerId) => set({ assignedWorkerId })}
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
  if (!can('checks', 'manage')) {
    return (
      <Screen title="Handover job">
        <AccessDenied title="You do not have permission to hand over jobs." message="It needs manage access to Quality Checks." />
      </Screen>
    )
  }
  const options = (workers.data ?? [])
    .filter((w) => job && w.isActive && w.appAccess && w.machineIds.includes(job.machineId) && w.id !== job.assignedWorkerId)
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
      subtitle={job ? `Job No. ${job.jobNo} stays running; its open checks move to the chosen worker` : null}
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
