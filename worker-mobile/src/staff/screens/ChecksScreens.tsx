import React, { useEffect, useMemo, useState } from 'react'
import { Text, View } from 'react-native'
import type { Activity, CheckResult, CheckValue, Machine, MediaFile, QualityCheck, QualityCheckStatus, User } from '../types'
import { api } from '../../services/api'
import { shareText } from '../../services/files'
import { useStaff } from '../nav'
import { useQuery, errorText } from '../useQuery'
import { FilterPanel, filterQuery, todayFilters, type MonitoringFilters } from '../Filters'
import {
  PARAMETER_TYPE_LABEL,
  RESULT_LABEL,
  checkStatusLabel,
  dateKey,
  formatDateTime,
  formatTime,
  keyToDate,
  toCsv
} from '../format'
import {
  AccessDenied,
  ActionRow,
  Badge,
  Card,
  Chips,
  DataState,
  DateField,
  EvidenceGallery,
  FieldLabel,
  FormError,
  FormSection,
  Input,
  KV,
  List,
  ListFooterLink,
  Notice,
  PrimaryButton,
  Row,
  Screen,
  Section,
  Segmented,
  SelectField,
  StatusBadge,
  TimeField,
  type HeaderAction,
  useToast
} from '../ui'

const workerOf = (c: QualityCheck) => c.submittedByName ?? c.workerName ?? '—'
const reading = (v: QualityCheck['values'][number]) => `${v.parameterName}=${v.value ?? ''}${v.unit ? ` ${v.unit}` : ''}`

/** MANUAL when the worker started the check himself, NOTIFICATION when the scheduler did. */
const submissionLabel = (c: QualityCheck) => (c.submissionType === 'MANUAL' ? 'Manual' : 'Notification')

const hasReading = (v: CheckValue) => v.value !== null && v.value !== ''

interface ChecksParams {
  date?: string
  machineId?: string
  result?: CheckResult
  status?: string
}

/** Quality Checks: every scheduled check for the chosen period, with filters, status counts and CSV export. */
export const ChecksScreen: React.FC<{ params: ChecksParams }> = ({ params }) => {
  const { can, push } = useStaff()
  const notify = useToast()
  const [filters, setFilters] = useState<MonitoringFilters>(() => ({
    ...todayFilters(),
    ...(params.date ? { from: params.date, to: params.date } : {}),
    machineId: params.machineId ?? '',
    // Deep links pass `result` (or `status`); both preselect the same status chip.
    status: params.result ?? params.status ?? ''
  }))
  const [limit, setLimit] = useState(100)
  const { data, error, loading, reload } = useQuery<QualityCheck[]>('/api/quality-checks', filterQuery(filters))

  const all = useMemo(() => data ?? [], [data])
  const counts = useMemo(() => {
    const map = new Map<QualityCheckStatus, number>()
    for (const c of all) map.set(c.status, (map.get(c.status) ?? 0) + 1)
    return map
  }, [all])
  const rows = filters.status ? all.filter((c) => c.status === filters.status) : all
  const multiDay = filters.from !== filters.to

  const exportCsv = async () => {
    const csv = toCsv(
      ['Scheduled at', 'Check code', 'Machine', 'Machine code', 'Department', 'Check type', 'Worker', 'Employee ID', 'Shift', 'Status', 'Result', 'Item Code', 'Job No.', 'Submitted at', 'Parameters', 'Parameters outside limits', 'Exception reason'],
      rows.map((c) => [
        formatDateTime(c.scheduledAt),
        c.code,
        c.machineName,
        c.machineCode,
        c.departmentName,
        c.activityName,
        workerOf(c),
        c.submittedByEmployeeId ?? c.workerEmployeeId,
        c.shiftName,
        checkStatusLabel(c.status),
        c.result ? RESULT_LABEL[c.result] : '',
        c.itemCode,
        c.jobNo,
        c.submittedAt ? formatDateTime(c.submittedAt) : '',
        c.values.map((v) => `${reading(v)} (${v.result === 'PASS' ? 'within limits' : v.result === 'FAIL' ? 'outside limits' : 'no limit'})`).join('; '),
        c.values.filter((v) => v.result === 'FAIL').map(reading).join('; '),
        c.exception?.reason
      ])
    )
    try {
      await shareText(`quality-checks_${filters.from}_${filters.to}.csv`, csv)
    } catch (err) {
      notify('error', 'Could not export', errorText(err))
    }
  }

  const actions: HeaderAction[] = []
  if (rows.length) actions.push({ label: 'CSV', icon: 'download-outline', onPress: exportCsv })
  if (can('checks', 'manage')) actions.push({ label: 'Create test check', icon: 'add', onPress: () => push('testCheck') })

  const missedOnly = filters.status === 'MISSED'
  const missedCount = counts.get('MISSED') ?? 0

  return (
    <Screen title="Quality Checks" right={actions} onRefresh={reload} refreshing={loading && !!data}>
      <View className="-mt-2 gap-3">
        <FilterPanel value={filters} onChange={setFilters} onReset={() => setFilters(todayFilters())} fields={['machine', 'worker', 'activity', 'shift', 'department']} />
        <Chips
          value={filters.status}
          onChange={(status) => setFilters({ ...filters, status })}
          options={[
            { value: '', label: 'All', count: all.length },
            // Missed comes first after All and stands out in red while it has checks.
            { value: 'MISSED', label: RESULT_LABEL.MISSED, count: missedCount, tone: 'missed' as const },
            ...(['COMPLETED', 'EXCEPTION'] as CheckResult[]).map((s) => ({ value: s, label: RESULT_LABEL[s], count: counts.get(s) ?? 0 }))
          ]}
        />
      </View>
      <DataState
        loading={loading}
        error={error}
        onRetry={reload}
        hasData={!!data}
        empty={!!data && rows.length === 0}
        emptyTitle={missedOnly ? 'No missed checks' : undefined}
        emptyText={missedOnly ? 'Every check in this period was done or is still open.' : 'No quality checks match these filters.'}
        emptyIcon={missedOnly ? 'checkmark-circle-outline' : 'clipboard-outline'}
        emptyAction={missedOnly && all.length ? { label: 'Show all checks', onPress: () => setFilters({ ...filters, status: '' }) } : null}
      >
        <List>
          {rows.slice(0, limit).map((c) => (
            <Row
              key={c.id}
              title={c.machineName}
              subtitle={`${c.activityName} · ${multiDay ? formatDateTime(c.scheduledAt) : formatTime(c.scheduledAt)} · ${workerOf(c)}`}
              accessibilityLabel={`${c.machineName} · ${c.activityName}`}
              right={c.result ? <StatusBadge status={c.result} /> : <Badge label="Open" />}
              onPress={() => push('checkDetail', { id: c.id })}
            />
          ))}
          {rows.length > limit ? <ListFooterLink label={`Show more (${rows.length - limit} more)`} icon="chevron-down" onPress={() => setLimit((l) => l + 100)} /> : null}
        </List>
      </DataState>
    </Screen>
  )
}

/** Small label above a value, used in summary cards. */
const SummaryFact: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <View className="flex-1">
    <Text className="text-[13px] leading-[18px] text-staff-muted">{label}</Text>
    <Text className="text-[15px] leading-[20px] text-staff-ink">{value}</Text>
  </View>
)

/**
 * One parameter of a check: its reading or a "Not applicable" badge with the reason, plus the photo
 * and video captured for that parameter alone.
 */
const ParameterCard: React.FC<{ value: CheckValue; media: MediaFile[]; workerName: string | null; deviceInfo: string | null }> = ({
  value,
  media,
  workerName,
  deviceInfo
}) => (
  <Card className="gap-3 p-4">
    <View className="flex-row items-start gap-3">
      <View className="flex-1">
        <Text className="text-[16px] font-semibold leading-[21px] text-staff-ink">{value.parameterName}</Text>
        <Text className="mt-0.5 text-[13px] leading-[17px] text-staff-muted">
          {PARAMETER_TYPE_LABEL[value.parameterType]}
          {value.rule ? ` · ${value.rule}` : ''}
        </Text>
      </View>
      {value.notApplicable ? <Badge label="Not applicable" tone="due" /> : hasReading(value) ? <StatusBadge status={value.result} /> : null}
    </View>

    {value.notApplicable ? (
      <View className="gap-0.5 rounded-xl bg-staff-fill px-3.5 py-2.5">
        <Text className="text-[14px] font-medium leading-[19px] text-staff-ink">{value.naReason ?? 'No reason recorded'}</Text>
        {value.naRemark ? <Text className="text-[13px] leading-[18px] text-staff-ink2">{value.naRemark}</Text> : null}
        {value.appliesWhen === 'JOB_RUNNING' ? (
          <Text className="text-[12px] leading-[16px] text-staff-muted">This parameter only applies while a job is running.</Text>
        ) : null}
      </View>
    ) : (
      <Text className="text-[22px] font-semibold leading-[28px] text-staff-ink">
        {hasReading(value) ? `${value.value}${value.unit ? ` ${value.unit}` : ''}` : '—'}
      </Text>
    )}

    {media.length ? <EvidenceGallery media={media} workerName={workerName} deviceInfo={deviceInfo} /> : null}
  </Card>
)

/** One check: status summary, information, per-parameter readings and evidence, and any exception. */
export const CheckDetailScreen: React.FC<{ params: { id: string } }> = ({ params }) => {
  const { can, push } = useStaff()
  const { data: check, error, loading, reload } = useQuery<QualityCheck>(`/api/quality-checks/${params.id}`)
  const outside = check ? check.values.filter((v) => v.result === 'FAIL').length : 0
  const notApplicable = check ? check.values.filter((v) => v.notApplicable).length : 0
  // Evidence captured for the whole check (or by the old single-photo flow) has no parameter.
  const overallMedia = check ? check.media.filter((m) => !m.parameterId) : []
  const itemCode = check?.itemCode ?? check?.job?.itemCode ?? null
  const jobNo = check?.job?.jobNo ?? check?.jobNo ?? null
  return (
    <Screen title={check?.code ?? 'Quality check'} onRefresh={reload} refreshing={loading && !!check}>
      <DataState loading={loading} error={error} onRetry={reload} hasData={!!check}>
        {check ? (
          <>
            <Card className="gap-3 p-4">
              <View className="flex-row items-start gap-3">
                <View className="flex-1">
                  <Text className="text-[20px] font-semibold leading-[25px] text-staff-ink">{check.machineName}</Text>
                  <Text className="mt-0.5 text-[15px] leading-[20px] text-staff-muted">
                    {check.activityName} · {check.code}
                  </Text>
                </View>
                <StatusBadge status={check.result} empty="Not finished yet" />
              </View>
              <View className="flex-row flex-wrap gap-2">
                <Badge label={submissionLabel(check)} tone={check.submissionType === 'MANUAL' ? 'due' : 'neutral'} />
                {itemCode ? <Badge label={`Item Code ${itemCode}`} /> : null}
                {jobNo ? <Badge label={`Job No. ${jobNo}`} /> : null}
                {check.nextDueAt ? <Badge label={`Next check due ${formatTime(check.nextDueAt)}`} tone="accent" /> : null}
                {notApplicable ? <Badge label={`${notApplicable} not applicable`} tone="exception" /> : null}
              </View>
              <View className="flex-row gap-3 border-t border-staff-line pt-3">
                <SummaryFact label="Scheduled" value={formatDateTime(check.scheduledAt)} />
                <SummaryFact label="Submitted" value={check.submittedAt ? formatDateTime(check.submittedAt) : '—'} />
              </View>
              {outside ? <Notice tone="missed" title={`${outside} reading${outside === 1 ? '' : 's'} outside limits`} /> : null}
            </Card>

            <Section title="Check information">
              <List>
                <KV label="Machine" value={check.machineName} detail={check.machineCode} />
                <KV label="Department" value={check.departmentName} />
                <KV label="Check type" value={check.activityName} />
                <KV label="Shift" value={check.shiftName} />
                <KV label="Scheduled" value={formatDateTime(check.scheduledAt)} />
                <KV label="Window ends" value={formatDateTime(check.windowEndsAt)} />
                <KV label="Assigned worker" value={check.workerName} detail={check.workerEmployeeId} />
                <KV label="Submitted by" value={check.submittedByName} detail={[check.submittedByEmployeeId, check.submittedAt ? formatDateTime(check.submittedAt) : null].filter(Boolean).join(' · ') || null} />
                <KV label="Submission" value={submissionLabel(check)} detail={check.submissionType === 'MANUAL' ? 'Started by the worker' : 'Started by a notification'} />
                <KV label="Item Code" value={itemCode} />
                <KV label="Job No." value={jobNo} detail={check.job ? `Job started ${formatDateTime(check.job.startedAt)}` : null} />
                <KV label="Next check due" value={check.nextDueAt ? formatDateTime(check.nextDueAt) : null} />
                <KV label="Device" value={check.deviceInfo} stacked />
              </List>
            </Section>

            <Section
              title="Parameter values"
              detail={`Readings against the configured rules, with the evidence captured for each one. They do not change the Result.${notApplicable ? ` ${notApplicable} marked not applicable.` : ''}`}
            >
              {check.values.length === 0 ? (
                <Notice title="No parameter values were submitted for this check." />
              ) : (
                <View className="gap-3">
                  {check.values.map((v, i) => (
                    <ParameterCard
                      key={v.parameterId ?? i}
                      value={v}
                      media={v.parameterId ? check.media.filter((m) => m.parameterId === v.parameterId) : []}
                      workerName={check.submittedByName ?? check.workerName}
                      deviceInfo={check.deviceInfo}
                    />
                  ))}
                </View>
              )}
            </Section>

            <Section title="Overall evidence" detail="Live camera evidence for the whole check">
              <EvidenceGallery media={overallMedia} workerName={check.submittedByName ?? check.workerName} deviceInfo={check.deviceInfo} />
            </Section>

            {check.exception ? (
              <Section title="Exception raised">
                <View className="gap-3">
                  <List>
                    <KV label="Status" value={<StatusBadge status={check.exception.status} />} />
                    <KV label="Reason" value={check.exception.reason} />
                    <KV label="Raised" value={formatDateTime(check.exception.createdAt)} />
                    <KV label="Worker remark" value={check.exception.remark} />
                    <KV label="Reviewed by" value={check.exception.reviewedByName} />
                    <KV label="Resolution" value={check.exception.resolutionNotes} />
                  </List>
                  <EvidenceGallery media={check.exception.media} workerName={check.submittedByName ?? check.workerName} />
                  {can('exceptions') ? (
                    <ActionRow
                      icon="alert-circle-outline"
                      label={can('exceptions', 'manage') ? 'Review exception' : 'Open exception'}
                      onPress={() => push('exceptionDetail', { id: check.exception!.id, from: dateKey(new Date(check.exception!.createdAt)) })}
                    />
                  ) : null}
                </View>
              </Section>
            ) : null}
          </>
        ) : null}
      </DataState>
    </Screen>
  )
}

const WINDOW_OPTIONS = [15, 30, 60, 120, 240, 480]
const pad = (n: number) => String(n).padStart(2, '0')

/** Create Test Check: a one-off check sent to the worker app. Needs "manage" on Quality Checks. */
const TestCheckForm: React.FC = () => {
  const { replace } = useStaff()
  const notify = useToast()
  const machines = useQuery<Machine[]>('/api/machines')
  const activities = useQuery<Activity[]>('/api/activities')
  const workers = useQuery<User[]>('/api/users', { role: 'WORKER' })

  const later = new Date(Date.now() + 60 * 60_000)
  const [workerId, setWorkerId] = useState('')
  const [machineId, setMachineId] = useState('')
  const [activityId, setActivityId] = useState('')
  const [status, setStatus] = useState<'DUE' | 'PENDING'>('DUE')
  const [startDate, setStartDate] = useState(dateKey(later))
  const [startTime, setStartTime] = useState(`${pad(later.getHours())}:${pad(later.getMinutes())}`)
  const [windowMinutes, setWindowMinutes] = useState('60')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const activeWorkers = (workers.data ?? []).filter((w) => w.isActive && w.appAccess)
  const activeMachines = useMemo(() => (machines.data ?? []).filter((m) => m.isActive), [machines.data])
  const machine = activeMachines.find((m) => m.id === machineId)
  const orderedActivities = useMemo(() => {
    const active = (activities.data ?? []).filter((a) => a.isActive)
    return [...active.filter((a) => machine?.activityIds.includes(a.id)), ...active.filter((a) => !machine?.activityIds.includes(a.id))]
  }, [activities.data, machine])
  const worker = activeWorkers.find((w) => w.id === workerId)

  useEffect(() => {
    if (!machineId && activeMachines.length) setMachineId((activeMachines.find((m) => worker?.machineIds.includes(m.id)) ?? activeMachines[0]).id)
  }, [machineId, activeMachines, worker])
  useEffect(() => {
    if (machine && orderedActivities.length && !orderedActivities.some((a) => a.id === activityId)) setActivityId(orderedActivities[0].id)
  }, [machine, orderedActivities, activityId])

  const start = status === 'DUE' ? new Date() : (() => {
    const [h, m] = startTime.split(':').map(Number)
    const d = keyToDate(startDate)
    d.setHours(h || 0, m || 0, 0, 0)
    return d
  })()
  const timeValid = status === 'DUE' || /^([01]\d|2[0-3]):[0-5]\d$/.test(startTime)
  const closes = new Date(start.getTime() + Number(windowMinutes) * 60_000)

  const submit = async () => {
    setError(null)
    if (!machineId || !activityId) return setError('Choose a machine and a check type')
    if (!timeValid) return setError('Enter the start time as HH:MM, e.g. 14:30')
    if (status === 'PENDING' && start.getTime() <= Date.now()) return setError('A later check must start in the future')
    setSaving(true)
    try {
      const check = await api.post<QualityCheck>('/api/quality-checks', {
        machineId,
        activityId,
        workerId: workerId || null,
        status,
        scheduledAt: status === 'PENDING' ? start.toISOString() : undefined,
        windowMinutes: Number(windowMinutes)
      })
      notify('success', `Test check ${check.code} created`, status === 'DUE' ? 'It shows now in the worker app.' : 'It opens in the worker app 30 minutes before the start time.')
      replace('checkDetail', { id: check.id })
    } catch (err) {
      setError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Screen
      title="Create test check"
      subtitle="Send a one-off check to the worker app"
      footer={<PrimaryButton label="Create test check" icon="add" onPress={submit} loading={saving} disabled={!machineId || !activityId} />}
    >
      <FormError message={error ?? machines.error ?? activities.error ?? workers.error} />
      <FormSection title="Machine and check">
        <SelectField label="Machine" required value={machineId} options={activeMachines.map((m) => ({ value: m.id, label: m.name, detail: m.code }))} onChange={setMachineId} />
        <SelectField
          label="Check type"
          required
          value={activityId}
          options={orderedActivities.map((a) => ({ value: a.id, label: a.name, detail: machine?.activityIds.includes(a.id) ? 'On this machine' : null }))}
          onChange={setActivityId}
        />
      </FormSection>
      <FormSection title="Worker">
        <SelectField
          label="Worker"
          value={workerId}
          emptyLabel="Automatic: worker on the current shift"
          options={activeWorkers.map((w) => ({ value: w.id, label: w.name, detail: `${w.employeeId}${w.shiftName ? ` · ${w.shiftName}` : ''}` }))}
          onChange={setWorkerId}
        />
        {worker && machine && !worker.machineIds.includes(machine.id) ? (
          <Notice tone="exception" title={`${worker.name} is not assigned to ${machine.name}`} message="Assign the machine to the worker first, or the check is refused." />
        ) : null}
      </FormSection>
      <FormSection title="Timing">
        <View>
          <FieldLabel label="Start" />
          <Segmented
            value={status}
            onChange={setStatus}
            options={[
              { value: 'DUE', label: 'Start now' },
              { value: 'PENDING', label: 'Start later' }
            ]}
          />
        </View>
        {status === 'PENDING' ? (
          <>
            <DateField label="Date" value={startDate} min={dateKey()} onChange={(d) => d && setStartDate(d)} />
            <TimeField label="Time" value={startTime} onChange={setStartTime} error={timeValid ? null : 'Choose a time'} />
          </>
        ) : null}
        <SelectField
          label="Open for"
          value={windowMinutes}
          options={WINDOW_OPTIONS.map((m) => ({ value: String(m), label: m < 60 ? `${m} minutes` : `${m / 60} hour${m === 60 ? '' : 's'}` }))}
          onChange={(v) => v && setWindowMinutes(v)}
        />
        {timeValid ? (
          <Notice
            tone="accent"
            icon="time-outline"
            message={`${status === 'DUE' ? 'Opens now' : `Opens at ${formatDateTime(start.toISOString())}`}, then marked Missed if not submitted by ${formatDateTime(closes.toISOString())}.`}
          />
        ) : null}
      </FormSection>
    </Screen>
  )
}

/** Opened only with manage access; if that access is removed meanwhile, show why instead of a form the server refuses. */
export const TestCheckScreen: typeof TestCheckForm = (props) => {
  const { can } = useStaff()
  return can('checks', 'manage') ? <TestCheckForm {...props} /> : (
    <Screen title="Create test check">
      <AccessDenied />
    </Screen>
  )
}
