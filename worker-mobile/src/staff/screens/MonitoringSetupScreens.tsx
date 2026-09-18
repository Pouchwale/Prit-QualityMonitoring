import React, { useMemo, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import type { Job, MonitoringOverview, MonitoringReason, OverviewCheckType, OverviewMachine, OverviewParameter, OverviewSchedule } from '../types'
import { api } from '../../services/api'
import { useStaff } from '../nav'
import { useQuery, errorText } from '../useQuery'
import { FilterPanel, todayFilters, type MonitoringFilters } from '../Filters'
import { PARAMETER_TYPE_LABEL, addDaysKey, dateKey, formatDateTime, formatTime, plural } from '../format'
import {
  AccessDenied,
  Badge,
  Card,
  Chips,
  DataState,
  Empty,
  FormError,
  FormSection,
  Icon,
  Input,
  List,
  Notice,
  PrimaryButton,
  Row,
  Screen,
  SearchField,
  Section,
  ToggleField,
  confirm,
  useToast,
  type IconName
} from '../ui'
import { ActionGroup, ActionItem, facts } from './adminParts'

// ---------------------------------------------------------------- labels

/** "2 h 15 min" from a number of minutes. */
function durationLabel(minutes: number) {
  const total = Math.max(0, Math.round(minutes))
  const h = Math.floor(total / 60)
  const m = total % 60
  if (!h) return `${m} min`
  return m ? `${h} h ${m} min` : `${h} h`
}

/** The interval schedules of a check type; the shortest one drives the mode chip. */
const intervalMinutesOf = (ct: OverviewCheckType) => {
  const intervals = ct.schedules.filter((s) => s.mode === 'INTERVAL').map((s) => s.intervalMinutes)
  return intervals.length ? Math.min(...intervals) : null
}

/** The mode chip on a check type row: "Every 60 min", "Job-based" or "Manual only". */
function modeLabel(ct: OverviewCheckType) {
  if (ct.mode === 'JOB') return 'Job-based'
  if (ct.mode === 'MANUAL') return 'Manual only'
  const minutes = intervalMinutesOf(ct)
  return minutes ? `Every ${minutes} min` : 'Every interval'
}

const modeTone = (ct: OverviewCheckType) => (ct.mode === 'JOB' ? 'due' : 'neutral')

/** One line per shift: "Shift A · Every 60 min · 08:00–16:00". */
const scheduleLine = (s: OverviewSchedule) =>
  [
    s.shiftName,
    s.mode === 'JOB' ? 'Job-based' : `Every ${s.intervalMinutes} min`,
    s.startTime && s.endTime ? `${s.startTime}–${s.endTime}` : 'Whole shift',
    s.workerName ? `Worker ${s.workerName}` : null,
    s.isActive ? null : 'Paused'
  ]
    .filter(Boolean)
    .join(' · ')

/** The earliest next due time across a check type's schedules. */
function nextDueOf(ct: OverviewCheckType) {
  const times = ct.schedules.map((s) => s.nextDueAt).filter((t): t is string => !!t)
  if (times.length === 0) return null
  return times.reduce((a, b) => (a < b ? a : b))
}

/** The latest submission across a check type's schedules. */
function lastSubmittedOf(ct: OverviewCheckType) {
  const times = ct.schedules.map((s) => s.lastSubmittedAt).filter((t): t is string => !!t)
  if (times.length === 0) return null
  return times.reduce((a, b) => (a > b ? a : b))
}

/** "Photo 3 · Video 1 · N/A 2" — how many parameters ask for each kind of evidence. */
function evidenceSummary(parameters: OverviewParameter[]) {
  const on = parameters.filter((p) => p.isEnabled)
  const photo = on.filter((p) => p.requirePhoto).length
  const video = on.filter((p) => p.requireVideo).length
  const na = on.filter((p) => p.allowNa).length
  const jobOnly = on.filter((p) => p.appliesWhen === 'JOB_RUNNING').length
  const parts = [photo && `Photo ${photo}`, video && `Video ${video}`, na && `N/A ${na}`, jobOnly && `Job only ${jobOnly}`].filter((x): x is string => !!x)
  return parts.length ? parts.join(' · ') : 'No per-parameter evidence'
}

// ---------------------------------------------------------------- small local pieces

/** A tiny flag pill for the parameter matrix (the shared kit has no chip this small). */
const Flag: React.FC<{ label: string; icon?: IconName; on?: boolean }> = ({ label, icon, on = true }) => (
  <View className={`flex-row items-center gap-1 rounded-full px-2 py-0.5 ${on ? 'bg-staff-accent-soft' : 'bg-staff-fill'}`}>
    {icon ? <Icon name={icon} size={12} color={on ? 'accent' : 'faint'} /> : null}
    <Text className={`text-[12px] font-semibold leading-[16px] ${on ? 'text-staff-accent' : 'text-staff-muted'}`}>{label}</Text>
  </View>
)

/** The running job of a machine, or nothing. */
const RunningJobLine: React.FC<{ machine: OverviewMachine }> = ({ machine }) =>
  machine.runningJob ? (
    <View className="flex-row items-center gap-2 border-t border-staff-line px-4 py-2.5">
      <Icon name="play-circle-outline" size={18} color="success" />
      <Text className="flex-1 text-[13px] leading-[18px] text-staff-ink2">
        Job <Text className="font-semibold text-staff-ink">{machine.runningJob.jobNo}</Text> running since {formatTime(machine.runningJob.startedAt)}
        {machine.runningJob.startedByName ? ` · ${machine.runningJob.startedByName}` : ''}
      </Text>
    </View>
  ) : null

interface CheckTypeBlockProps {
  machine: OverviewMachine
  checkType: OverviewCheckType
  onOpenCheckType: () => void
  onOpenSchedule: (schedule: OverviewSchedule) => void
  canOpenSchedule: boolean
  /** False when the block is the first thing in its card, so it needs no separator. */
  separator?: boolean
}

/** One check type on one machine: mode chip, shift/interval lines, next due and the evidence summary. */
const CheckTypeBlock: React.FC<CheckTypeBlockProps> = ({ machine, checkType, onOpenCheckType, onOpenSchedule, canOpenSchedule, separator = true }) => {
  const nextDue = nextDueOf(checkType)
  const lastSubmitted = lastSubmittedOf(checkType)
  return (
    <View className={separator ? 'border-t border-staff-line' : ''}>
      <Pressable
        onPress={onOpenCheckType}
        accessibilityRole="button"
        accessibilityLabel={`${checkType.activityName} on ${machine.name}`}
        className="min-h-[60px] gap-1 px-4 py-3 active:bg-staff-fill"
      >
        <View className="flex-row items-start gap-2">
          <View className="flex-1">
            <Text className={`text-[15px] font-semibold leading-[20px] ${checkType.isActive ? 'text-staff-ink' : 'text-staff-muted'}`} numberOfLines={2}>
              {checkType.activityName}
            </Text>
            <Text className="text-[13px] leading-[17px] text-staff-muted">
              {checkType.activityCode}
              {checkType.isActive ? '' : ' · Disabled'}
            </Text>
          </View>
          <Badge label={modeLabel(checkType)} tone={modeTone(checkType)} />
        </View>
        <View className="flex-row flex-wrap gap-1.5">
          {checkType.allowManual ? <Flag label="Manual allowed" icon="hand-left-outline" /> : <Flag label="Notification only" icon="notifications-outline" on={false} />}
          {checkType.requireJobNo ? <Flag label="Job No." icon="pricetag-outline" on={false} /> : null}
          {checkType.requirePhoto || checkType.requireVideo ? (
            <Flag label={`Overall ${[checkType.requirePhoto && 'photo', checkType.requireVideo && 'video'].filter(Boolean).join(' + ')}`} icon="camera-outline" on={false} />
          ) : null}
        </View>
        <Text className="text-[13px] leading-[18px] text-staff-ink2">
          {nextDue ? `Next check due ${formatDateTime(nextDue)}` : checkType.mode === 'MANUAL' ? 'Started by the worker only' : 'No next check due yet'}
          {lastSubmitted ? ` · Last ${formatDateTime(lastSubmitted)}` : ''}
        </Text>
        <Text className="text-[12px] leading-[16px] text-staff-muted">{evidenceSummary(checkType.parameters)}</Text>
      </Pressable>
      {checkType.schedules.map((s) => (
        <Pressable
          key={s.id}
          onPress={() => onOpenSchedule(s)}
          disabled={!canOpenSchedule}
          accessibilityRole="button"
          accessibilityLabel={`${checkType.activityName} schedule on ${machine.name}, ${s.shiftName}`}
          className="min-h-[44px] flex-row items-center gap-2 border-t border-staff-line bg-staff-fill px-4 py-2 active:opacity-70"
        >
          <Text className="flex-1 text-[13px] leading-[18px] text-staff-ink2">{scheduleLine(s)}</Text>
          {canOpenSchedule ? <Icon name="chevron-forward" size={16} color="faint" /> : null}
        </Pressable>
      ))}
      {checkType.schedules.length === 0 ? (
        <View className="border-t border-staff-line bg-staff-fill px-4 py-2">
          <Text className="text-[13px] leading-[18px] text-staff-muted">No schedule on this machine — the worker starts it by hand.</Text>
        </View>
      ) : null}
    </View>
  )
}

/** Machine header: name, code, department and a status only when not running, tappable to open the full matrix. */
const MachineHeader: React.FC<{ machine: OverviewMachine; onPress: () => void }> = ({ machine, onPress }) => (
  <Pressable
    onPress={onPress}
    accessibilityRole="button"
    accessibilityLabel={`${machine.name} monitoring details`}
    className="min-h-[60px] flex-row items-center gap-3 px-4 py-3 active:bg-staff-fill"
  >
    <View className="flex-1">
      <Text className="text-[17px] font-semibold leading-[22px] text-staff-ink" numberOfLines={2}>
        {machine.name}
      </Text>
      <Text className="text-[13px] leading-[18px] text-staff-muted">
        {facts(machine.code, machine.departmentName, `${machine.checkTypes.length} ${machine.checkTypes.length === 1 ? 'check type' : 'check types'}`)}
      </Text>
    </View>
    {machine.status === 'MAINTENANCE' ? <Badge label="Maintenance" tone="exception" /> : machine.status === 'IDLE' ? <Badge label="Idle" tone="neutral" /> : null}
    <Icon name="chevron-forward" size={18} color="faint" />
  </Pressable>
)

// ---------------------------------------------------------------- overview

/**
 * Monitoring Setup: what is monitored on each machine — check types with their mode, shifts and
 * intervals, the next due time, the running job and the per-parameter evidence. Rows open the
 * existing Check Type and Schedule editors.
 */
export const MonitoringSetupScreen: React.FC<{ params: Record<string, unknown> }> = () => {
  const { can, push } = useStaff()
  const canView = can('activities') || can('schedules')
  const canEditActivities = can('activities', 'manage')
  const canEditSchedules = can('schedules', 'manage')
  const { data, error, loading, reload } = useQuery<MonitoringOverview>(canView ? '/api/monitoring-overview' : null)
  const [search, setSearch] = useState('')

  const machines = useMemo(() => data?.machines ?? [], [data])
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return machines
    return machines.filter((m) =>
      [m.name, m.code, m.departmentName ?? '', m.runningJob?.jobNo ?? '', ...m.checkTypes.flatMap((c) => [c.activityName, c.activityCode])].some((s) =>
        s.toLowerCase().includes(q)
      )
    )
  }, [machines, search])

  const counts = useMemo(() => {
    let job = 0
    let manual = 0
    let interval = 0
    for (const m of machines) {
      for (const c of m.checkTypes) {
        if (c.mode === 'JOB') job++
        else if (c.mode === 'MANUAL') manual++
        else interval++
      }
    }
    return { job, manual, interval, running: machines.filter((m) => m.runningJob).length }
  }, [machines])

  if (!canView) {
    return (
      <Screen title="Monitoring Setup">
        <AccessDenied title="You do not have permission to see the monitoring setup." message="It needs view access to Check Types or Schedules." />
      </Screen>
    )
  }

  return (
    <Screen title="Monitoring Setup" subtitle="Photo, video, intervals and N/A reasons" onRefresh={reload} refreshing={loading && !!data}>
      <View className="gap-2">
        <SearchField value={search} onChangeText={setSearch} placeholder="Search machine, check type or job" accessibilityLabel="Search" />
        <Text className="px-1 text-[13px] leading-[18px] text-staff-muted">
          {data
            ? `${plural(counts.interval, 'interval check')} · ${counts.job} job-based · ${counts.manual} manual only${counts.running ? ` · ${counts.running} running ${counts.running === 1 ? 'job' : 'jobs'}` : ''}. `
            : ''}
          Tap a check type to change its parameters and evidence, or a shift line to change its timing.
        </Text>
      </View>

      <ActionGroup>
        <ActionItem
          label="N/A reasons"
          description="Why a parameter can be marked not applicable"
          accessibilityLabel="N/A reasons"
          onPress={() => push('monitoringReasons')}
        />
        <ActionItem label="Jobs" description="Production jobs and their checks" accessibilityLabel="Jobs" onPress={() => push('monitoringJobs')} />
      </ActionGroup>

      <DataState
        loading={loading}
        error={error}
        onRetry={reload}
        hasData={!!data}
        empty={!!data && visible.length === 0}
        emptyText={machines.length === 0 ? 'No machines with check types yet. Link check types to machines first.' : 'No machines match the search.'}
        emptyIcon="construct-outline"
      >
        {visible.map((machine) => (
          <View key={machine.id}>
            <Card>
              <MachineHeader machine={machine} onPress={() => push('monitoringMachine', { machineId: machine.id })} />
              <RunningJobLine machine={machine} />
              {machine.checkTypes.length === 0 ? (
                <View className="border-t border-staff-line px-4 py-3">
                  <Text className="text-[14px] leading-[19px] text-staff-muted">No check types on this machine yet.</Text>
                </View>
              ) : (
                machine.checkTypes.map((ct) => (
                  <CheckTypeBlock
                    key={ct.activityId}
                    machine={machine}
                    checkType={ct}
                    canOpenSchedule={canEditSchedules}
                    onOpenCheckType={() => (canEditActivities ? push('activityForm', { id: ct.activityId }) : push('activityDetail', { id: ct.activityId }))}
                    onOpenSchedule={(s) => push('scheduleForm', { id: s.id })}
                  />
                ))
              )}
            </Card>
          </View>
        ))}
      </DataState>
    </Screen>
  )
}

// ---------------------------------------------------------------- one machine

/** One machine: every check type with the full parameter matrix (Required / Photo / Video / N/A / job only). */
export const MonitoringMachineScreen: React.FC<{ params: { machineId: string } }> = ({ params }) => {
  const { can, push } = useStaff()
  const canView = can('activities') || can('schedules')
  const canEditActivities = can('activities', 'manage')
  const canEditSchedules = can('schedules', 'manage')
  const { data, error, loading, reload } = useQuery<MonitoringOverview>(canView ? '/api/monitoring-overview' : null)
  const machine = (data?.machines ?? []).find((m) => m.id === params.machineId) ?? null

  if (!canView) {
    return (
      <Screen title="Machine monitoring">
        <AccessDenied title="You do not have permission to see the monitoring setup." message="It needs view access to Check Types or Schedules." />
      </Screen>
    )
  }

  return (
    <Screen
      title={machine?.name ?? 'Machine monitoring'}
      subtitle={machine ? [machine.code, machine.departmentName].filter(Boolean).join(' · ') : null}
      onRefresh={reload}
      refreshing={loading && !!data}
    >
      <DataState
        loading={loading}
        error={error}
        onRetry={reload}
        hasData={!!data}
        empty={!!data && !machine}
        emptyText="This machine could not be found."
        emptyIcon="construct-outline"
      >
        {machine ? (
          <>
            {machine.runningJob ? (
              <Notice
                tone="success"
                icon="play-circle-outline"
                title={`Job ${machine.runningJob.jobNo} is running`}
                message={`Started ${formatDateTime(machine.runningJob.startedAt)}${machine.runningJob.startedByName ? ` by ${machine.runningJob.startedByName}` : ''}. Job-based checks only run while a job is open.`}
              />
            ) : (
              <Notice message="No job is running on this machine, so job-based checks are not generated." />
            )}

            {machine.checkTypes.length === 0 ? (
              <Empty text="No check types on this machine yet." icon="list-outline" />
            ) : (
              machine.checkTypes.map((ct) => (
                <Section key={ct.activityId} title={ct.activityName} detail={`${ct.activityCode} · ${modeLabel(ct)}`}>
                  <Card>
                    <CheckTypeBlock
                      machine={machine}
                      checkType={ct}
                      separator={false}
                      canOpenSchedule={canEditSchedules}
                      onOpenCheckType={() => (canEditActivities ? push('activityForm', { id: ct.activityId }) : push('activityDetail', { id: ct.activityId }))}
                      onOpenSchedule={(s) => push('scheduleForm', { id: s.id })}
                    />
                    {ct.parameters.length === 0 ? (
                      <View className="border-t border-staff-line px-4 py-3">
                        <Text className="text-[14px] leading-[19px] text-staff-muted">No parameters on this check type.</Text>
                      </View>
                    ) : (
                      ct.parameters.map((p) => (
                        <View key={p.parameterId} className="gap-1.5 border-t border-staff-line px-4 py-3">
                          <Text className={`text-[14px] font-semibold leading-[19px] ${p.isEnabled ? 'text-staff-ink' : 'text-staff-muted'}`}>
                            {p.name}
                            {p.unit ? ` · ${p.unit}` : ''}
                          </Text>
                          <Text className="text-[12px] leading-[16px] text-staff-muted">
                            {PARAMETER_TYPE_LABEL[p.type]}
                            {p.rule ? ` · ${p.rule}` : ''}
                            {p.isEnabled ? '' : ' · Off on this form'}
                          </Text>
                          <View className="flex-row flex-wrap gap-1.5">
                            <Flag label="Required" on={p.isRequired} />
                            <Flag label="Photo" icon="image-outline" on={p.requirePhoto} />
                            <Flag label="Video" icon="videocam-outline" on={p.requireVideo} />
                            <Flag label="N/A allowed" on={p.allowNa} />
                            {p.appliesWhen === 'JOB_RUNNING' ? <Flag label="Only during a job" icon="briefcase-outline" /> : null}
                          </View>
                        </View>
                      ))
                    )}
                  </Card>
                </Section>
              ))
            )}
          </>
        ) : null}
      </DataState>
    </Screen>
  )
}

// ---------------------------------------------------------------- N/A reasons

/** N/A reasons: why a worker may mark a parameter "Not applicable" instead of raising an exception. */
export const MonitoringReasonsScreen: React.FC<{ params: Record<string, unknown> }> = () => {
  const { can, push } = useStaff()
  const canView = can('activities') || can('checks') || can('exceptions')
  const canEdit = can('activities', 'manage')
  const { data, error, loading, reload } = useQuery<MonitoringReason[]>(canView ? '/api/monitoring-reasons' : null)
  const reasons = useMemo(() => [...(data ?? [])].sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label)), [data])
  const active = reasons.filter((r) => r.isActive).length

  if (!canView) {
    return (
      <Screen title="N/A reasons">
        <AccessDenied title="You do not have permission to see the N/A reasons." />
      </Screen>
    )
  }

  return (
    <Screen
      title="N/A reasons"
      onRefresh={reload}
      refreshing={loading && !!data}
      right={canEdit ? { label: 'Add', icon: 'add', onPress: () => push('monitoringReasonForm', {}) } : null}
    >
      <Text className="px-1 text-[13px] leading-[18px] text-staff-muted">
        {data ? `${active} active of ${reasons.length}. ` : ''}
        Workers pick one of these when a parameter cannot be measured. A not-applicable reading never counts as outside limits.
      </Text>
      <DataState
        loading={loading}
        error={error}
        onRetry={reload}
        hasData={!!data}
        empty={!!data && reasons.length === 0}
        emptyText="No N/A reasons yet. Add the first one."
        emptyIcon="close-circle-outline"
      >
        <List>
          {reasons.map((r) => (
            <Row
              key={r.id}
              title={r.label}
              titleClassName={r.isActive ? '' : 'text-staff-muted'}
              subtitle={facts(r.requiresRemark ? 'Worker must write a remark' : 'Remark optional', `Order ${r.sortOrder}`)}
              right={r.isActive ? undefined : <Badge label="Inactive" tone="neutral" />}
              onPress={canEdit ? () => push('monitoringReasonForm', { reason: r }) : undefined}
              accessibilityLabel={canEdit ? `Edit ${r.label}` : undefined}
            />
          ))}
        </List>
      </DataState>
    </Screen>
  )
}

interface ReasonForm {
  label: string
  requiresRemark: boolean
  isActive: boolean
  sortOrder: string
}

/** Add or edit an N/A reason. Deactivating keeps the reason text on old submissions. */
export const MonitoringReasonFormScreen: React.FC<{ params: { reason?: MonitoringReason } }> = ({ params }) => {
  const { can, pop } = useStaff()
  const notify = useToast()
  const canEdit = can('activities', 'manage')
  const editing = params.reason ?? null
  const [form, setForm] = useState<ReasonForm>(() =>
    editing
      ? { label: editing.label, requiresRemark: editing.requiresRemark, isActive: editing.isActive, sortOrder: String(editing.sortOrder) }
      : { label: '', requiresRemark: false, isActive: true, sortOrder: '0' }
  )
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const set = <K extends keyof ReasonForm>(key: K, value: ReasonForm[K]) => setForm((f) => ({ ...f, [key]: value }))

  if (!canEdit) {
    return (
      <Screen title={editing ? 'Edit N/A reason' : 'Add N/A reason'}>
        <AccessDenied title="You do not have permission to change the N/A reasons." message="It needs manage access to Check Types." />
      </Screen>
    )
  }

  const submit = async () => {
    const label = form.label.trim()
    const sortOrder = Number(form.sortOrder || '0')
    if (!label) return setFormError('Enter the reason shown to workers')
    if (!Number.isInteger(sortOrder) || sortOrder < 0) return setFormError('Order must be a whole number, 0 or more')
    setSaving(true)
    setFormError(null)
    try {
      const body = { label, requiresRemark: form.requiresRemark, isActive: form.isActive, sortOrder }
      if (editing) {
        await api.put(`/api/monitoring-reasons/${editing.id}`, body)
        notify('success', 'N/A reason updated', label)
      } else {
        await api.post('/api/monitoring-reasons', body)
        notify('success', 'N/A reason added', label)
      }
      pop()
    } catch (err) {
      setFormError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!editing) return
    const ok = await confirm(
      'Deactivate N/A reason?',
      `${editing.label} will no longer be offered to workers. Checks that already used it keep the reason, so history stays complete.`,
      'Deactivate',
      true
    )
    if (!ok) return
    setDeleting(true)
    try {
      await api.del(`/api/monitoring-reasons/${editing.id}`)
      notify('success', 'N/A reason deactivated', editing.label)
      pop()
    } catch (err) {
      notify('error', 'Could not deactivate the reason', errorText(err))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <Screen
      title={editing ? 'Edit N/A reason' : 'Add N/A reason'}
      subtitle={editing?.label ?? 'Shown to workers when a parameter cannot be measured'}
      footer={<PrimaryButton label={editing ? 'Save changes' : 'Add reason'} onPress={submit} loading={saving} disabled={deleting} />}
    >
      <FormError message={formError} />
      <FormSection title="Details">
        <Input
          label="Reason"
          required
          value={form.label}
          onChangeText={(v) => set('label', v)}
          placeholder="e.g. Machine under maintenance"
          maxLength={120}
        />
        <Input
          label="Order"
          hint="Lower numbers appear first in the worker's list."
          value={form.sortOrder}
          onChangeText={(v) => set('sortOrder', v.replace(/\D/g, ''))}
          keyboardType="number-pad"
          maxLength={3}
        />
        <ToggleField
          label="Requires remark"
          description="The worker must also write what happened, e.g. for “Other”."
          value={form.requiresRemark}
          onChange={(v) => set('requiresRemark', v)}
        />
        <ToggleField label="Active" description="Inactive reasons are not offered to workers." value={form.isActive} onChange={(v) => set('isActive', v)} />
      </FormSection>

      {editing ? (
        <ActionGroup>
          <ActionItem
            label={deleting ? 'Deactivating…' : 'Deactivate reason'}
            accessibilityLabel="Deactivate reason"
            description="Kept on old submissions; workers no longer see it."
            tone="danger"
            onPress={remove}
            disabled={deleting || saving}
          />
        </ActionGroup>
      ) : null}
    </Screen>
  )
}

// ---------------------------------------------------------------- jobs

/** Jobs: production runs per machine, with their checks; staff with manage can close a forgotten job. */
export const MonitoringJobsScreen: React.FC<{ params: Record<string, unknown> }> = () => {
  const { can } = useStaff()
  const notify = useToast()
  const canView = can('checks')
  const canEnd = can('checks', 'manage')
  const [filters, setFilters] = useState<MonitoringFilters>(() => ({ ...todayFilters(), from: addDaysKey(dateKey(), -6), to: dateKey() }))
  const [running, setRunning] = useState('')
  const [ending, setEnding] = useState<string | null>(null)
  const { data, error, loading, reload } = useQuery<Job[]>(canView ? '/api/jobs' : null, {
    from: filters.from,
    to: filters.to,
    machineId: filters.machineId,
    running: running === 'running' ? 'true' : ''
  })

  const jobs = useMemo(() => data ?? [], [data])
  const openJobs = jobs.filter((j) => !j.endedAt).length

  const endJob = async (job: Job) => {
    const ok = await confirm(
      'End job?',
      `Job ${job.jobNo} on ${job.machineName} will be closed. Job-based checks that were never notified are removed, so nothing is counted as Missed.`,
      'End job',
      true
    )
    if (!ok) return
    setEnding(job.id)
    try {
      await api.post(`/api/jobs/${job.id}/end`, {})
      notify('success', 'Job ended', `${job.jobNo} on ${job.machineName}`)
      reload()
    } catch (err) {
      notify('error', 'Could not end the job', errorText(err))
    } finally {
      setEnding(null)
    }
  }

  if (!canView) {
    return (
      <Screen title="Jobs">
        <AccessDenied title="You do not have permission to see jobs." message="It needs view access to Quality Checks." />
      </Screen>
    )
  }

  return (
    <Screen title="Jobs" onRefresh={reload} refreshing={loading && !!data}>
      <View className="gap-2">
        <FilterPanel
          value={filters}
          onChange={setFilters}
          onReset={() => setFilters({ ...todayFilters(), from: addDaysKey(dateKey(), -6), to: dateKey() })}
          fields={['machine']}
        />
        <Chips
          value={running}
          onChange={setRunning}
          options={[
            { value: '', label: 'All jobs', count: jobs.length },
            { value: 'running', label: 'Running', count: openJobs }
          ]}
        />
      </View>
      <DataState
        loading={loading}
        error={error}
        onRetry={reload}
        hasData={!!data}
        empty={!!data && jobs.length === 0}
        emptyText="No jobs in this period."
        emptyIcon="briefcase-outline"
      >
        {jobs.map((job) => (
          <Section key={job.id} title={`Job No. ${job.jobNo}`} detail={[job.itemCode ? `Item Code ${job.itemCode}` : null, `${job.machineName} · ${job.machineCode}`].filter(Boolean).join(' · ')}>
            <View className="gap-2">
              <Card>
                <Row
                  title={job.machineName}
                  subtitle={`Started ${formatDateTime(job.startedAt)}${job.startedByName ? ` · ${job.startedByName}` : ''}`}
                  detail={
                    job.endedAt
                      ? `Ended ${formatDateTime(job.endedAt)}${job.endedByName ? ` · ${job.endedByName}` : ''} · ${durationLabel(job.durationMinutes)} · ${plural(job.checkCount, 'check')}`
                      : `Running for ${durationLabel(job.durationMinutes)} · ${plural(job.checkCount, 'check')}`
                  }
                  right={job.endedAt ? undefined : <Badge label="Running" tone="success" />}
                />
              </Card>
              {!job.endedAt && canEnd ? (
                <ActionGroup>
                  <ActionItem
                    label={ending === job.id ? 'Ending…' : 'End job'}
                    accessibilityLabel={`End job ${job.jobNo}`}
                    description="Closes the run; un-notified job checks are removed."
                    tone="danger"
                    onPress={() => endJob(job)}
                    disabled={ending === job.id}
                  />
                </ActionGroup>
              ) : null}
            </View>
          </Section>
        ))}
      </DataState>
    </Screen>
  )
}

export const MONITORING_SCREENS = {
  monitoringSetup: MonitoringSetupScreen,
  monitoringMachine: MonitoringMachineScreen,
  monitoringReasons: MonitoringReasonsScreen,
  monitoringReasonForm: MonitoringReasonFormScreen,
  monitoringJobs: MonitoringJobsScreen
}
