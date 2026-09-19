import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import type { Activity, Machine, Schedule, ScheduleMode, Shift, User } from '../types'
import { api } from '../../services/api'
import { useStaff } from '../nav'
import { useQuery, errorText } from '../useQuery'
import { formatDateTime, frequencyLabel } from '../format'
import {
  AccessDenied,
  Badge,
  Card,
  Chips,
  DataState,
  FieldLabel,
  FormError,
  FormSection,
  Input,
  List,
  Notice,
  PrimaryButton,
  Row,
  Screen,
  SearchField,
  Section,
  Segmented,
  SelectField,
  TimeField,
  ToggleField,
  confirm,
  useToast
} from '../ui'
import { ActionGroup, ActionItem, facts } from './adminParts'
import { formatClockRange } from '../../utils/datetime'

const PRESETS: { minutes: number; label: string }[] = [
  { minutes: 15, label: 'Every 15 min' },
  { minutes: 30, label: 'Every 30 min' },
  { minutes: 45, label: 'Every 45 min' },
  { minutes: 60, label: 'Every hour' },
  { minutes: 120, label: 'Every 2 hours' },
  { minutes: 240, label: 'Every 4 hours' },
  { minutes: 480, label: 'Once per shift (every 8 hours)' },
  { minutes: 1440, label: 'Daily (once a day)' }
]

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

const fromMinutes = (minutes: number) => {
  const m = ((minutes % 1440) + 1440) % 1440
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

/** Mirrors the server's check generator: slots from start while before end; end at/before start runs past midnight. */
function slotTimes(start: string, end: string, interval: number) {
  const s = toMinutes(start)
  let e = toMinutes(end)
  if (e <= s) e += 1440
  const times: string[] = []
  for (let t = s; t < e; t += Math.max(interval, 5)) times.push(fromMinutes(t))
  return times
}

const machineLabel = (m: Machine) =>
  m.name + (!m.isActive ? ' (disabled)' : m.status === 'MAINTENANCE' ? ' (maintenance)' : m.status === 'IDLE' ? ' (idle)' : '')

const activityLabel = (a: Activity) => a.name + (a.isActive ? '' : ' (inactive)')

/** "Machine is idle — no checks generated", or null when the machine generates checks. */
const blockedText = (m: Machine | undefined) =>
  m && (m.status !== 'ACTIVE' || !m.isActive) ? `${m.isActive ? `Machine is ${m.status === 'MAINTENANCE' ? 'in maintenance' : 'idle'}` : 'Machine is disabled'} — no checks generated` : null

interface FormState {
  machineId: string
  activityId: string
  shiftId: string
  workerId: string
  preset: string
  intervalMinutes: string
  /** INTERVAL: checks all through the shift. JOB: only while a job runs on the machine. */
  mode: ScheduleMode
  useWindow: boolean
  startTime: string
  endTime: string
  isActive: boolean
}

const emptyForm: FormState = {
  machineId: '',
  activityId: '',
  shiftId: '',
  workerId: '',
  preset: '60',
  intervalMinutes: '60',
  mode: 'INTERVAL',
  useWindow: false,
  startTime: '',
  endTime: '',
  isActive: true
}

const formFromSchedule = (s: Schedule): FormState => ({
  machineId: s.machineId,
  activityId: s.activityId,
  shiftId: s.shiftId,
  workerId: s.workerId ?? '',
  preset: PRESETS.some((p) => p.minutes === s.intervalMinutes) ? String(s.intervalMinutes) : 'custom',
  intervalMinutes: String(s.intervalMinutes),
  mode: s.mode ?? 'INTERVAL',
  useWindow: s.startTime !== null && s.endTime !== null,
  startTime: s.startTime ?? '',
  endTime: s.endTime ?? '',
  isActive: s.isActive
})

/** "Every hour" or "Job-based", the way the check generator treats this schedule. */
const modeLabel = (s: Pick<Schedule, 'mode' | 'intervalMinutes'>) => (s.mode === 'JOB' ? 'Job-based' : frequencyLabel(s.intervalMinutes))

/** Rolling timer line for a list row, when the API sends it. */
const timerLine = (s: Schedule) =>
  [s.nextDueAt ? `Next check due ${formatDateTime(s.nextDueAt)}` : null, s.lastSubmittedAt ? `Last submitted ${formatDateTime(s.lastSubmittedAt)}` : null]
    .filter(Boolean)
    .join(' · ') || null

/** Schedules: how often each quality check runs on each machine, per shift. */
export const SchedulesScreen: React.FC<{ params: Record<string, unknown> }> = () => {
  const { can, push } = useStaff()
  const canEdit = can('schedules', 'manage')
  const { data, error, loading, reload } = useQuery<Schedule[]>('/api/schedules')
  const machinesQuery = useQuery<Machine[]>('/api/machines')
  const shiftsQuery = useQuery<Shift[]>('/api/shifts')

  const [search, setSearch] = useState('')
  const [shiftFilter, setShiftFilter] = useState('')
  const [showAllGaps, setShowAllGaps] = useState(false)

  const schedules = useMemo(() => data ?? [], [data])
  const machineById = useMemo(() => new Map((machinesQuery.data ?? []).map((m) => [m.id, m])), [machinesQuery.data])

  const groups = useMemo(() => {
    const q = search.trim().toLowerCase()
    const map = new Map<string, { machineId: string; machineName: string; rows: Schedule[] }>()
    for (const s of schedules) {
      if (shiftFilter && s.shiftId !== shiftFilter) continue
      if (q && ![s.machineName, s.activityName, s.shiftName, s.workerName, s.workerEmployeeId].some((v) => v?.toLowerCase().includes(q))) continue
      const g = map.get(s.machineId) ?? { machineId: s.machineId, machineName: s.machineName, rows: [] }
      g.rows.push(s)
      map.set(s.machineId, g)
    }
    return [...map.values()].sort((a, b) => a.machineName.localeCompare(b.machineName))
  }, [schedules, search, shiftFilter])

  // Schedules whose machine has no worker on that shift create no checks; one line per machine and shift.
  const gaps = [...new Map(schedules.filter((s) => s.isActive && s.checkWorkers.length === 0).map((s) => [`${s.machineName}|${s.shiftName}`, s])).values()]
  const shownGaps = showAllGaps ? gaps : gaps.slice(0, 2)

  const refresh = () => {
    reload()
    machinesQuery.reload()
    shiftsQuery.reload()
  }

  const shiftChips = [{ value: '', label: 'All shifts' }, ...(shiftsQuery.data ?? []).map((s) => ({ value: s.id, label: s.name }))]

  return (
    <Screen
      title="Schedules"
      onRefresh={refresh}
      refreshing={loading && !!data}
      right={canEdit ? { label: 'Add', icon: 'add', onPress: () => push('scheduleForm', {}) } : null}
    >
      {gaps.length > 0 ? (
        <Notice tone="missed" title={gaps.length === 1 ? 'Shift with no worker: its checks are not scheduled' : `${gaps.length} shifts with no worker: their checks are not scheduled`}>
          {shownGaps.map((g) => (
            <Text key={`${g.machineName}|${g.shiftName}`} className="mt-1 text-[14px] leading-[19px] text-staff-ink2">
              <Text className="font-semibold text-staff-ink">{g.machineName}</Text> · {g.shiftName} — assign a worker on {g.shiftName} to {g.machineName} in Machine Assignment.
            </Text>
          ))}
          {gaps.length > 2 ? (
            <Pressable
              onPress={() => setShowAllGaps((v) => !v)}
              accessibilityRole="button"
              hitSlop={{ top: 10, bottom: 10, left: 4, right: 4 }}
              className="min-h-[44px] justify-center self-start active:opacity-60"
            >
              <Text className="text-[14px] font-semibold text-staff-accent">{showAllGaps ? 'Show less' : `Show ${gaps.length - 2} more`}</Text>
            </Pressable>
          ) : null}
        </Notice>
      ) : null}

      <View className="gap-2">
        <SearchField value={search} onChangeText={setSearch} placeholder="Search machine, check type, worker…" accessibilityLabel="Search" />
        {shiftChips.length > 1 ? <Chips options={shiftChips} value={shiftFilter} onChange={setShiftFilter} /> : null}
      </View>

      <DataState
        loading={loading}
        error={error}
        onRetry={reload}
        hasData={!!data}
        empty={!!data && groups.length === 0}
        emptyText={schedules.length === 0 ? 'No schedules yet. Add one to start generating quality checks.' : 'No schedules match the filters'}
        emptyIcon="alarm-outline"
      >
        {groups.map((g) => {
          const machine = machineById.get(g.machineId)
          const blocked = blockedText(machine)
          return (
            <Section key={g.machineId} title={g.machineName} detail={`${machine ? `${machine.code} · ` : ''}${g.rows.length} ${g.rows.length === 1 ? 'schedule' : 'schedules'}`}>
              <View className="gap-2">
                {blocked ? <Notice tone="exception" message={blocked} /> : null}
                <List>
                  {g.rows.map((s) => {
                    const assigned =
                      s.checkWorkers.length === 0
                        ? null
                        : `${s.checkWorkers.map((w) => w.name).join(', ')}${s.checkWorkers.length === 1 ? ` ${s.checkWorkers[0].employeeId}` : ''}${!s.workerId ? ' (by shift)' : ''}`
                    return (
                      <Row
                        key={s.id}
                        title={s.activityName}
                        titleClassName={s.isActive ? '' : 'text-staff-muted'}
                        subtitle={facts(
                          modeLabel(s),
                          s.startTime && s.endTime ? `${formatClockRange(s.startTime, s.endTime)}` : 'Whole shift',
                          `${s.shiftName} ${formatClockRange(s.shiftStartTime, s.shiftEndTime)}`
                        )}
                        detail={facts(assigned ? `Assigned to ${assigned}` : `No worker on ${s.shiftName}`, timerLine(s))}
                        detailLines={2}
                        right={
                          !s.isActive ? (
                            <Badge label="Paused" tone="exception" />
                          ) : s.checkWorkers.length === 0 ? (
                            <Badge label="No worker" tone="missed" />
                          ) : undefined
                        }
                        onPress={canEdit ? () => push('scheduleForm', { schedule: s }) : undefined}
                        accessibilityLabel={canEdit ? `Edit ${s.activityName} schedule on ${s.machineName}` : undefined}
                      />
                    )
                  })}
                </List>
              </View>
            </Section>
          )
        })}
      </DataState>
    </Screen>
  )
}

/**
 * Add or edit a schedule, with a preview of check times and who gets them. Changing it replaces its
 * upcoming checks. Monitoring Setup opens it with only the schedule `id`, which is looked up here.
 */
export const ScheduleFormScreen: React.FC<{ params: { schedule?: Schedule; id?: string } }> = ({ params }) => {
  const { can, pop } = useStaff()
  const notify = useToast()
  const canEdit = can('schedules', 'manage')
  const needsLookup = !params.schedule && !!params.id
  const listApi = useQuery<Schedule[]>(needsLookup ? '/api/schedules' : null)
  const editing = params.schedule ?? (needsLookup ? ((listApi.data ?? []).find((s) => s.id === params.id) ?? null) : null)

  const machinesApi = useQuery<Machine[]>('/api/machines')
  const activitiesApi = useQuery<Activity[]>('/api/activities')
  const shiftsApi = useQuery<Shift[]>('/api/shifts')
  const workersApi = useQuery<User[]>('/api/users', { role: 'WORKER' })

  const [form, setForm] = useState<FormState>(() => (params.schedule ? formFromSchedule(params.schedule) : emptyForm))
  // Filled in once the looked-up schedule arrives, so typed changes are never overwritten.
  const [loaded, setLoaded] = useState(!needsLookup)
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const machines = useMemo(() => machinesApi.data ?? [], [machinesApi.data])
  const activities = activitiesApi.data ?? []
  const shifts = useMemo(() => shiftsApi.data ?? [], [shiftsApi.data])
  const workers = workersApi.data ?? []

  useEffect(() => {
    if (loaded || !editing) return
    setForm(formFromSchedule(editing))
    setLoaded(true)
  }, [editing, loaded])

  // A new schedule starts on the first active shift, as on the web panel.
  const shiftDefaulted = useRef(needsLookup || !!editing)
  useEffect(() => {
    if (shiftDefaulted.current || !shiftsApi.data) return
    shiftDefaulted.current = true
    const first = shiftsApi.data.find((s) => s.isActive)
    if (first) setForm((f) => (f.shiftId ? f : { ...f, shiftId: first.id }))
  }, [shiftsApi.data])

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }))

  const changePreset = (value: string) => setForm((f) => ({ ...f, preset: value, intervalMinutes: value === 'custom' ? f.intervalMinutes : value }))

  const toggleWindow = (on: boolean) => {
    const shift = shifts.find((s) => s.id === form.shiftId)
    setForm((f) => ({
      ...f,
      useWindow: on,
      startTime: on && !f.startTime ? (shift?.startTime ?? '') : f.startTime,
      endTime: on && !f.endTime ? (shift?.endTime ?? '') : f.endTime
    }))
  }

  const interval = Number(form.intervalMinutes)
  const intervalValid = Number.isInteger(interval) && interval >= 5 && interval <= 1440
  const windowValid = !form.useWindow || (HHMM.test(form.startTime) && HHMM.test(form.endTime) && form.startTime !== form.endTime)

  const submit = async () => {
    if (!form.machineId) return setFormError('Choose a machine')
    if (!form.activityId) return setFormError('Choose a check type')
    if (!form.shiftId) return setFormError('Choose a shift')
    if (!intervalValid) return setFormError('Frequency must be a whole number of minutes between 5 and 1440')
    if (form.useWindow && !windowValid) return setFormError('Set both a start and an end time (different from each other), or turn off the custom time window')

    setSaving(true)
    setFormError(null)
    try {
      const body = {
        machineId: form.machineId,
        activityId: form.activityId,
        shiftId: form.shiftId,
        workerId: form.workerId || null,
        intervalMinutes: interval,
        mode: form.mode,
        startTime: form.useWindow ? form.startTime : null,
        endTime: form.useWindow ? form.endTime : null,
        isActive: form.isActive
      }
      if (!editing) {
        await api.post('/api/schedules', body)
        notify('success', 'Schedule created', 'Checks will be generated for the selected shift.')
      } else {
        await api.put(`/api/schedules/${editing.id}`, body)
        notify('success', 'Schedule updated', 'Upcoming checks were replaced; completed history is kept.')
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
      'Delete schedule',
      `Delete the ${editing.activityName} schedule on ${editing.machineName} (${editing.shiftName})? Upcoming checks are removed; completed history is kept. To stop it temporarily, edit it and turn off Active instead.`,
      'Delete',
      true
    )
    if (!ok) return
    setDeleting(true)
    try {
      await api.del(`/api/schedules/${editing.id}`)
      notify('success', 'Schedule deleted', `${editing.activityName} on ${editing.machineName}. Upcoming checks were removed.`)
      pop()
    } catch (err) {
      notify('error', 'Could not delete schedule', errorText(err))
    } finally {
      setDeleting(false)
    }
  }

  // ---- Form option lists ----
  const selectedMachine = machines.find((m) => m.id === form.machineId)
  const selectedShift = shifts.find((s) => s.id === form.shiftId)
  const machineOptions = machines.filter((m) => m.isActive || m.id === form.machineId)
  const activityOptions = activities.filter((a) => a.isActive || a.id === form.activityId)
  const linkedActivities = selectedMachine ? activityOptions.filter((a) => selectedMachine.activityIds.includes(a.id)) : []
  const otherActivities = selectedMachine ? activityOptions.filter((a) => !selectedMachine.activityIds.includes(a.id)) : activityOptions
  const activityNotLinked = !!selectedMachine && !!form.activityId && !selectedMachine.activityIds.includes(form.activityId)
  const shiftOptions = shifts.filter((s) => s.isActive || s.id === form.shiftId)
  const workerOptions = workers.filter((w) => w.isActive || w.id === form.workerId)

  // ---- Preview ----
  const preview = useMemo(() => {
    if (!selectedShift || !intervalValid || !windowValid) return null
    const start = form.useWindow ? form.startTime : selectedShift.startTime
    const end = form.useWindow ? form.endTime : selectedShift.endTime
    const times = slotTimes(start, end, interval)
    const shown = times.length <= 4 ? times.join(', ') : `${times.slice(0, 3).join(', ')} … ${times[times.length - 1]}`
    return { times, text: `${times.length === 1 ? 'Check at' : 'Checks at'} ${shown} (${times.length} per shift)` }
  }, [selectedShift, intervalValid, windowValid, form.useWindow, form.startTime, form.endTime, interval])

  // Same rule as the backend (services/workerAssignment.ts): workers on this shift first, else workers with no fixed shift.
  const onMachine = form.machineId ? workers.filter((w) => w.isActive && w.appAccess && w.machineIds.includes(form.machineId)) : []
  const onShift = onMachine.filter((w) => w.shiftId === form.shiftId)
  const eligibleWorkers = !form.shiftId ? [] : onShift.length ? onShift : onMachine.filter((w) => !w.shiftId)
  const assignedWorker = workers.find((w) => w.id === form.workerId)
  const machineBlocked = selectedMachine && (selectedMachine.status !== 'ACTIVE' || !selectedMachine.isActive)

  const pickerError = machinesApi.error || activitiesApi.error || shiftsApi.error || workersApi.error
  const title = editing ? 'Edit Schedule' : 'Add Schedule'

  if (!canEdit) {
    return (
      <Screen title={title}>
        <AccessDenied title="You do not have permission to change schedules." />
      </Screen>
    )
  }

  // Opened from Monitoring Setup: wait for the schedule to arrive before showing the form.
  if (needsLookup && !loaded) {
    return (
      <Screen title={title}>
        <DataState
          loading={listApi.loading}
          error={listApi.error}
          onRetry={listApi.reload}
          hasData={false}
          empty={!!listApi.data && !editing}
          emptyText="This schedule could not be found."
          emptyIcon="alarm-outline"
        >
          {null}
        </DataState>
      </Screen>
    )
  }

  return (
    <Screen
      title={title}
      subtitle={editing ? `${editing.activityName} · ${editing.machineName}` : null}
      footer={<PrimaryButton label={editing ? 'Save changes' : 'Create schedule'} onPress={submit} loading={saving} disabled={deleting} />}
    >
      <FormError message={formError} />
      {pickerError ? <FormError message={`Could not load lists: ${pickerError}`} /> : null}

      <FormSection title="Machine & check type">
        <SelectField
          label="Machine"
          required
          value={form.machineId}
          placeholder="Choose a machine…"
          options={machineOptions.map((m) => ({ value: m.id, label: machineLabel(m), detail: m.code }))}
          onChange={(v) => set('machineId', v)}
        />
        <SelectField
          label="Check type"
          required
          value={form.activityId}
          placeholder="Choose a check type…"
          hint={activityNotLinked ? 'Not yet on this machine — it will be linked automatically' : null}
          options={
            selectedMachine
              ? [
                  ...linkedActivities.map((a) => ({ value: a.id, label: activityLabel(a), detail: 'On this machine' })),
                  ...otherActivities.map((a) => ({ value: a.id, label: activityLabel(a), detail: 'Other check types (linked on save)' }))
                ]
              : otherActivities.map((a) => ({ value: a.id, label: activityLabel(a) }))
          }
          onChange={(v) => set('activityId', v)}
        />
      </FormSection>

      <FormSection title="Timing" description="Changing a schedule replaces its upcoming checks; completed history is kept.">
        <View>
          <FieldLabel
            label="Monitoring mode"
            hint="The timer restarts at each submission, so the next check is due one interval after the last one was sent. Job-based checks only run while a job is running on the machine."
          />
          <Segmented
            value={form.mode}
            onChange={(mode) => set('mode', mode)}
            options={[
              { value: 'INTERVAL', label: 'Every interval' },
              { value: 'JOB', label: 'Job-based' }
            ]}
          />
        </View>
        <SelectField
          label="Shift"
          required
          value={form.shiftId}
          placeholder="Choose a shift…"
          options={shiftOptions.map((s) => ({ value: s.id, label: `${s.name} (${formatClockRange(s.startTime, s.endTime)})${s.isActive ? '' : ' (inactive)'}` }))}
          onChange={(v) => set('shiftId', v)}
        />
        <SelectField
          label="Frequency"
          required
          value={form.preset}
          options={[...PRESETS.map((p) => ({ value: String(p.minutes), label: p.label })), { value: 'custom', label: 'Custom…' }]}
          onChange={(v) => v && changePreset(v)}
        />
        {form.preset === 'custom' ? (
          <Input
            label="Interval in minutes"
            required
            value={form.intervalMinutes}
            onChangeText={(v) => set('intervalMinutes', v)}
            keyboardType="number-pad"
            hint="Between 5 and 1440 min"
            maxLength={4}
          />
        ) : null}
        <ToggleField
          label="Only part of the shift"
          description={selectedShift ? `Off: checks run across the whole shift (${formatClockRange(selectedShift.startTime, selectedShift.endTime)}).` : 'Off: checks run across the whole shift.'}
          value={form.useWindow}
          onChange={toggleWindow}
        />
        {form.useWindow ? (
          <View className="flex-row gap-3">
            <View className="flex-1">
              <TimeField label="Window start" required value={form.startTime} onChange={(v) => set('startTime', v)} />
            </View>
            <View className="flex-1">
              <TimeField label="Window end" required value={form.endTime} onChange={(v) => set('endTime', v)} />
            </View>
          </View>
        ) : null}
        <ToggleField label="Active" description="Paused schedules generate no new checks." value={form.isActive} onChange={(v) => set('isActive', v)} />
      </FormSection>

      <FormSection title="Worker">
        <SelectField
          label="Assigned worker"
          hint="Optional. Leave on automatic to give the checks to the worker assigned to this machine on this shift."
          value={form.workerId}
          emptyLabel="Automatic: worker on this shift"
          options={workerOptions.map((w) => ({
            value: w.id,
            label: `${w.name} (${w.employeeId})${w.shiftName ? ` · ${w.shiftName}` : ''}${w.isActive ? '' : ' (disabled)'}`
          }))}
          onChange={(v) => set('workerId', v)}
        />
      </FormSection>

      {preview ? (
        <Card className="gap-2 p-4">
          <Text className="text-[13px] font-semibold leading-[18px] text-staff-muted" accessibilityRole="header">
            Preview
          </Text>
          <Text className="text-[15px] font-medium leading-[21px] text-staff-ink">{preview.text}</Text>
          <Text className="text-[14px] leading-[19px] text-staff-ink2">
            {form.mode === 'JOB'
              ? 'Job-based: nothing is created until a job is started on this machine, and the timer restarts at each submission.'
              : 'The timer restarts at each submission, so the next check is due one interval after the last one was sent.'}
          </Text>
          {machineBlocked && selectedMachine ? (
            <Text className="text-[14px] leading-[19px] text-exception">
              {selectedMachine.isActive
                ? `${selectedMachine.name} is ${selectedMachine.status === 'MAINTENANCE' ? 'in maintenance' : 'idle'}`
                : `${selectedMachine.name} is disabled`}
              , so no checks are generated until it is Active again.
            </Text>
          ) : null}
          {!form.isActive ? <Text className="text-[14px] leading-[19px] text-staff-muted">Schedule is paused: nothing will be generated.</Text> : null}
          {form.machineId ? (
            assignedWorker ? (
              <Text className="text-[14px] leading-[19px] text-staff-ink2">Checks are assigned to {assignedWorker.name}.</Text>
            ) : eligibleWorkers.length > 0 ? (
              <Text className="text-[14px] leading-[19px] text-staff-ink2">
                {eligibleWorkers.length === 1
                  ? `Checks are assigned to ${eligibleWorkers[0].name}.`
                  : `Checks are shared between ${eligibleWorkers.map((w) => w.name).join(', ')}.`}
              </Text>
            ) : !workersApi.loading ? (
              <Text className="text-[14px] font-medium leading-[19px] text-missed">
                No worker on {selectedShift?.name ?? 'this shift'} is assigned to {selectedMachine?.name ?? 'this machine'}. No checks are created until you assign one in
                Machine Assignment.
              </Text>
            ) : null
          ) : null}
        </Card>
      ) : null}

      {editing ? (
        <ActionGroup>
          <ActionItem
            label={deleting ? 'Deleting…' : 'Delete schedule'}
            accessibilityLabel="Delete schedule"
            description="Removes upcoming checks; completed history is kept."
            tone="danger"
            onPress={remove}
            disabled={deleting || saving}
          />
        </ActionGroup>
      ) : null}
    </Screen>
  )
}

export const SCHEDULES_SCREENS = {
  schedules: SchedulesScreen,
  scheduleForm: ScheduleFormScreen
}
