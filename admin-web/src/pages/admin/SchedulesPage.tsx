import React, { useMemo, useState } from 'react'
import { AlertTriangle, CalendarClock, Edit2, Plus, Search, Trash2 } from 'lucide-react'
import type { Activity, Machine, Schedule, ScheduleMode, Shift, User } from '../../types'
import { api, errorText } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { useCanManage } from '../../lib/auth'
import { formatClockRange, formatDateTime, frequencyLabel } from '../../lib/format'
import { Button } from '../../components/common/Button'
import { ConfirmModal } from '../../components/common/ConfirmModal'
import { DataState } from '../../components/common/DataState'
import { Field, FormError, Select, Toggle, inputClass } from '../../components/common/Form'
import { Modal } from '../../components/common/Modal'
import { PageHeader } from '../../components/common/PageHeader'
import { StatusBadge } from '../../components/common/StatusBadge'
import { useToast } from '../../components/common/Toast'
import { WorkerCoverageAlert } from '../../components/common/WorkerCoverageAlert'
import { TimeInput } from '../../components/common/DateTimeInputs'

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

interface FormState {
  machineId: string
  activityId: string
  shiftId: string
  workerId: string
  mode: ScheduleMode
  preset: string
  intervalMinutes: string
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
  mode: 'INTERVAL',
  preset: '60',
  intervalMinutes: '60',
  useWindow: false,
  startTime: '',
  endTime: '',
  isActive: true
}

/** Monitoring mode wording, shared by the list and the form. */
const MODE_LABEL: Record<ScheduleMode, string> = {
  INTERVAL: 'Every interval',
  JOB: 'Job-based'
}

export const SchedulesPage: React.FC = () => {
  const canEdit = useCanManage('schedules')
  const notify = useToast()
  const schedulesApi = useApi<Schedule[]>('/api/schedules')
  const machinesApi = useApi<Machine[]>('/api/machines')
  const activitiesApi = useApi<Activity[]>('/api/activities')
  const shiftsApi = useApi<Shift[]>('/api/shifts')
  const workersApi = useApi<User[]>('/api/users', { role: 'WORKER' })

  const [search, setSearch] = useState('')
  const [shiftFilter, setShiftFilter] = useState('ALL')
  const [editing, setEditing] = useState<Schedule | 'new' | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm)
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState<Schedule | null>(null)

  const schedules = useMemo(() => schedulesApi.data ?? [], [schedulesApi.data])
  const machines = useMemo(() => machinesApi.data ?? [], [machinesApi.data])
  const activities = activitiesApi.data ?? []
  const shifts = shiftsApi.data ?? []
  const workers = workersApi.data ?? []

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }))

  const groups = useMemo(() => {
    const q = search.trim().toLowerCase()
    const map = new Map<string, { machineId: string; machineName: string; rows: Schedule[] }>()
    for (const s of schedules) {
      if (shiftFilter !== 'ALL' && s.shiftId !== shiftFilter) continue
      if (q && ![s.machineName, s.activityName, s.shiftName, s.workerName, s.workerEmployeeId].some((v) => v?.toLowerCase().includes(q))) continue
      const g = map.get(s.machineId) ?? { machineId: s.machineId, machineName: s.machineName, rows: [] }
      g.rows.push(s)
      map.set(s.machineId, g)
    }
    return [...map.values()].sort((a, b) => a.machineName.localeCompare(b.machineName))
  }, [schedules, search, shiftFilter])

  const machineById = useMemo(() => new Map(machines.map((m) => [m.id, m])), [machines])

  const openNew = () => {
    setForm({ ...emptyForm, shiftId: shifts.find((s) => s.isActive)?.id ?? '' })
    setFormError(null)
    setEditing('new')
  }

  const openEdit = (s: Schedule) => {
    const preset = PRESETS.some((p) => p.minutes === s.intervalMinutes) ? String(s.intervalMinutes) : 'custom'
    setForm({
      machineId: s.machineId,
      activityId: s.activityId,
      shiftId: s.shiftId,
      workerId: s.workerId ?? '',
      mode: s.mode ?? 'INTERVAL',
      preset,
      intervalMinutes: String(s.intervalMinutes),
      useWindow: s.startTime !== null && s.endTime !== null,
      startTime: s.startTime ?? '',
      endTime: s.endTime ?? '',
      isActive: s.isActive
    })
    setFormError(null)
    setEditing(s)
  }

  const close = () => setEditing(null)

  const changePreset = (value: string) =>
    setForm((f) => ({ ...f, preset: value, intervalMinutes: value === 'custom' ? f.intervalMinutes : value }))

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

  const submit = async (e: React.SyntheticEvent) => {
    e.preventDefault()
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
        mode: form.mode,
        intervalMinutes: interval,
        startTime: form.useWindow ? form.startTime : null,
        endTime: form.useWindow ? form.endTime : null,
        isActive: form.isActive
      }
      if (editing === 'new') {
        await api.post('/api/schedules', body)
        notify('success', 'Schedule created', 'Checks will be generated for the selected shift.')
      } else if (editing) {
        await api.put(`/api/schedules/${editing.id}`, body)
        notify('success', 'Schedule updated', 'Upcoming checks were replaced; completed history is kept.')
      }
      setEditing(null)
      schedulesApi.reload()
      machinesApi.reload()
    } catch (err) {
      setFormError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!deleting) return
    try {
      await api.del(`/api/schedules/${deleting.id}`)
      notify('success', 'Schedule deleted', `${deleting.activityName} on ${deleting.machineName}. Upcoming checks were removed.`)
      schedulesApi.reload()
    } catch (err) {
      notify('error', 'Could not delete schedule', errorText(err))
    }
  }

  // ---- Form option lists ----
  const selectedMachine = machineById.get(form.machineId)
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

  return (
    <div className="space-y-4">
      <PageHeader
        title="Schedules"
        description="How often each quality check runs on each machine, per shift"
        actions={
          canEdit && (
            <Button size="sm" variant="primary" onClick={openNew} icon={<Plus className="w-3.5 h-3.5" />}>
              Add Schedule
            </Button>
          )
        }
      />

      <WorkerCoverageAlert
        gaps={(schedulesApi.data ?? [])
          .filter((s) => s.isActive && s.checkWorkers.length === 0)
          .map((s) => ({ scheduleId: s.id, machineName: s.machineName, shiftName: s.shiftName, activityName: s.activityName }))}
      />

      <div className="flex flex-wrap items-center justify-between gap-3 bg-white p-3 border border-line rounded-md shadow-2xs text-xs">
        <div className="relative min-w-[220px] flex-1 max-w-sm">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 lg:top-2.5 lg:translate-y-0 text-ink-faint pointer-events-none" />
          <input
            type="text"
            placeholder="Search machine, check type, worker…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full h-[40px] lg:h-8 pl-8 pr-3 border border-line-strong rounded text-[16px] lg:text-xs bg-white placeholder:text-ink-faint focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-ink-muted">Shift:</span>
          <Select value={shiftFilter} onChange={(e) => setShiftFilter(e.target.value)} className="w-auto min-w-[140px]">
            <option value="ALL">All shifts</option>
            {shifts.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <DataState
        loading={schedulesApi.loading}
        error={schedulesApi.error}
        onRetry={schedulesApi.reload}
        empty={!schedulesApi.loading && groups.length === 0}
        emptyText={schedules.length === 0 ? 'No schedules yet. Add one to start generating quality checks.' : 'No schedules match the filters'}
      >
        <div className="bg-white border border-line rounded-md shadow-2xs overflow-x-auto">
          <table className="stack-sm w-full text-left text-xs border-collapse">
            <thead className="bg-slate-50 border-b border-line text-ink-secondary font-mono text-[11px] uppercase tracking-wider">
              <tr>
                <th className="py-2.5 px-3.5">Check type</th>
                <th className="py-2.5 px-3.5">Shift</th>
                <th className="py-2.5 px-3.5">Time window</th>
                <th className="py-2.5 px-3.5">Frequency</th>
                <th className="py-2.5 px-3.5">Next due</th>
                <th className="py-2.5 px-3.5">Assigned to</th>
                <th className="py-2.5 px-3.5">Status</th>
                {canEdit && <th className="py-2.5 px-3.5 text-right">Action</th>}
              </tr>
            </thead>
            {groups.map((g) => {
              const machine = machineById.get(g.machineId)
              const blocked = machine && (machine.status !== 'ACTIVE' || !machine.isActive)
              return (
                <tbody key={g.machineId} className="divide-y divide-line border-b border-line last:border-b-0">
                  <tr className="bg-subtle">
                    <td colSpan={canEdit ? 8 : 7} className="py-1.5 px-3.5">
                      <span className="font-semibold text-ink">{g.machineName}</span>
                      {machine && <span className="ml-2 font-mono text-[11px] text-ink-muted">{machine.code}</span>}
                      <span className="ml-2 text-[11px] text-ink-muted">
                        {g.rows.length} {g.rows.length === 1 ? 'schedule' : 'schedules'}
                      </span>
                      {blocked && machine && (
                        <span className="ml-2 inline-flex items-center gap-1 text-[11px] text-exception">
                          <AlertTriangle className="w-3 h-3" />
                          {machine.isActive ? `Machine is ${machine.status === 'MAINTENANCE' ? 'in maintenance' : 'idle'}` : 'Machine is disabled'} — no
                          checks generated
                        </span>
                      )}
                    </td>
                  </tr>
                  {g.rows.map((s) => (
                    <tr key={s.id} className="hover:bg-slate-50 transition-colors">
                      <td className="py-2.5 px-3.5 pl-6 font-medium text-ink whitespace-nowrap">
                        {s.activityName}
                        <span className="block text-[11px] font-normal text-ink-muted">{MODE_LABEL[s.mode ?? 'INTERVAL']}</span>
                      </td>
                      <td className="py-2.5 px-3.5 whitespace-nowrap">
                        <span className="text-slate-700">{s.shiftName}</span>
                        <span className="ml-1.5 font-mono text-[11px] text-ink-muted">
                          {formatClockRange(s.shiftStartTime, s.shiftEndTime)}
                        </span>
                      </td>
                      <td className="py-2.5 px-3.5 whitespace-nowrap">
                        {s.startTime && s.endTime ? (
                          <span className="font-mono text-ink">{formatClockRange(s.startTime, s.endTime)}</span>
                        ) : (
                          <span className="text-ink-muted">Whole shift</span>
                        )}
                      </td>
                      <td className="py-2.5 px-3.5 whitespace-nowrap text-ink">{frequencyLabel(s.intervalMinutes)}</td>
                      <td className="py-2.5 px-3.5 whitespace-nowrap">
                        {s.nextDueAt ? <span className="font-mono text-ink">{formatDateTime(s.nextDueAt)}</span> : <span className="text-ink-faint">—</span>}
                        {s.lastSubmittedAt && (
                          <span className="block text-[11px] text-ink-muted">Last submitted {formatDateTime(s.lastSubmittedAt)}</span>
                        )}
                      </td>
                      <td className="py-2.5 px-3.5 whitespace-nowrap">
                        {s.checkWorkers.length === 0 ? (
                          <span className="inline-flex items-center gap-1 text-failed font-medium">
                            <AlertTriangle className="w-3.5 h-3.5" /> No worker on {s.shiftName}
                          </span>
                        ) : (
                          <>
                            <span className="text-ink">{s.checkWorkers.map((w) => w.name).join(', ')}</span>
                            {s.checkWorkers.length === 1 && <span className="ml-1.5 font-mono text-[11px] text-ink-muted">{s.checkWorkers[0].employeeId}</span>}
                            {!s.workerId && <span className="ml-1.5 text-[11px] text-ink-muted">(by shift)</span>}
                          </>
                        )}
                      </td>
                      <td className="py-2.5 px-3.5 whitespace-nowrap">
                        <StatusBadge status={s.isActive ? 'ACTIVE' : 'Paused'} size="sm" />
                      </td>
                      {canEdit && (
                        <td className="py-2 px-3.5 text-right whitespace-nowrap">
                          <div className="inline-flex gap-1.5">
                            <Button size="sm" variant="outline" onClick={() => openEdit(s)} icon={<Edit2 className="w-3 h-3 text-ink-muted" />}>
                              Edit
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setDeleting(s)} title="Delete" aria-label="Delete schedule" icon={<Trash2 className="w-3.5 h-3.5 text-failed" />} />
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              )
            })}
          </table>
        </div>
      </DataState>

      <Modal
        isOpen={editing !== null}
        onClose={close}
        title={editing === 'new' ? 'Add Schedule' : 'Edit Schedule'}
        subtitle="Changing a schedule replaces its upcoming checks; completed history is kept."
        maxWidth="lg"
        footer={
          <>
            <Button size="sm" variant="outline" onClick={close} disabled={saving}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" type="submit" form="schedule-form" loading={saving}>
              {editing === 'new' ? 'Create Schedule' : 'Save Changes'}
            </Button>
          </>
        }
      >
        <form id="schedule-form" onSubmit={submit} className="space-y-3">
          <FormError message={formError} />
          {pickerError && <FormError message={`Could not load lists: ${pickerError}`} />}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Machine" required>
              <Select value={form.machineId} onChange={(e) => set('machineId', e.target.value)} autoFocus>
                <option value="">Choose a machine…</option>
                {machineOptions.map((m) => (
                  <option key={m.id} value={m.id}>
                    {machineLabel(m)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Check type"
              required
              hint={activityNotLinked ? 'Not yet on this machine — it will be linked automatically' : undefined}
            >
              <Select value={form.activityId} onChange={(e) => set('activityId', e.target.value)}>
                <option value="">Choose a check type…</option>
                {selectedMachine ? (
                  <>
                    {linkedActivities.length > 0 && (
                      <optgroup label="On this machine">
                        {linkedActivities.map((a) => (
                          <option key={a.id} value={a.id}>
                            {activityLabel(a)}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    {otherActivities.length > 0 && (
                      <optgroup label="Other check types (linked on save)">
                        {otherActivities.map((a) => (
                          <option key={a.id} value={a.id}>
                            {activityLabel(a)}
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </>
                ) : (
                  otherActivities.map((a) => (
                    <option key={a.id} value={a.id}>
                      {activityLabel(a)}
                    </option>
                  ))
                )}
              </Select>
            </Field>
            <Field label="Shift" required>
              <Select value={form.shiftId} onChange={(e) => set('shiftId', e.target.value)}>
                <option value="">Choose a shift…</option>
                {shiftOptions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {`${s.name} (${formatClockRange(s.startTime, s.endTime)})${s.isActive ? '' : ' (inactive)'}`}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Monitoring mode"
              required
              hint={
                form.mode === 'JOB'
                  ? 'Job-based: checks are only due while a job is running on the machine.'
                  : 'Every interval: checks are due right through the shift.'
              }
            >
              <Select value={form.mode} onChange={(e) => set('mode', e.target.value as ScheduleMode)}>
                {(Object.keys(MODE_LABEL) as ScheduleMode[]).map((m) => (
                  <option key={m} value={m}>
                    {MODE_LABEL[m]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Frequency" required hint="The timer restarts when the worker submits, so the next check is due one interval after that submission.">
              <div className="flex gap-2">
                <Select value={form.preset} onChange={(e) => changePreset(e.target.value)} className="flex-1">
                  {PRESETS.map((p) => (
                    <option key={p.minutes} value={String(p.minutes)}>
                      {p.label}
                    </option>
                  ))}
                  <option value="custom">Custom…</option>
                </Select>
                {form.preset === 'custom' && (
                  <div className="relative w-24 shrink-0">
                    <input
                      type="number"
                      min={5}
                      max={1440}
                      step={1}
                      value={form.intervalMinutes}
                      onChange={(e) => set('intervalMinutes', e.target.value)}
                      className={`${inputClass} pr-9`}
                      aria-label="Interval in minutes"
                    />
                    <span className="absolute right-2 top-2 text-[11px] text-ink-muted pointer-events-none">min</span>
                  </div>
                )}
              </div>
            </Field>
          </div>

          <div className="rounded border border-line p-3 space-y-2">
            <Toggle
              checked={form.useWindow}
              onChange={toggleWindow}
              label="Only part of the shift"
              description={
                selectedShift
                  ? `Off: checks run across the whole shift (${formatClockRange(selectedShift.startTime, selectedShift.endTime)}).`
                  : 'Off: checks run across the whole shift.'
              }
            />
            {form.useWindow && (
              <div className="grid grid-cols-2 gap-3">
                <Field label="Window start" required>
                  <TimeInput label="Window start" value={form.startTime} onChange={(v) => set('startTime', v)} />
                </Field>
                <Field label="Window end" required>
                  <TimeInput label="Window end" value={form.endTime} onChange={(v) => set('endTime', v)} />
                </Field>
              </div>
            )}
          </div>

          <Field label="Assigned worker" hint="Optional. Leave on automatic to give the checks to the worker assigned to this machine on this shift.">
            <Select value={form.workerId} onChange={(e) => set('workerId', e.target.value)}>
              <option value="">Automatic: worker on this shift</option>
              {workerOptions.map((w) => (
                <option key={w.id} value={w.id}>
                  {`${w.name} (${w.employeeId})${w.shiftName ? ` · ${w.shiftName}` : ''}${w.isActive ? '' : ' (disabled)'}`}
                </option>
              ))}
            </Select>
          </Field>

          <Toggle checked={form.isActive} onChange={(v) => set('isActive', v)} label="Active" description="Paused schedules generate no new checks." />

          {preview && (
            <div className="rounded border border-line bg-subtle px-3 py-2 space-y-1 text-[11px]">
              <div className="flex items-start gap-1.5 text-ink">
                <CalendarClock className="w-3.5 h-3.5 shrink-0 mt-px text-accent" />
                <span>
                  <span className="font-mono">{preview.text}</span>
                </span>
              </div>
              <div className="text-ink-secondary">
                {form.mode === 'JOB'
                  ? `Job-based: nothing is due until a job is running on the machine. The next check is then due ${interval} minutes after each submission.`
                  : `The timer restarts on submission: the next check is due ${interval} minutes after the worker submits.`}
              </div>
              {machineBlocked && selectedMachine && (
                <div className="flex items-start gap-1.5 text-exception">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
                  <span>
                    {selectedMachine.isActive
                      ? `${selectedMachine.name} is ${selectedMachine.status === 'MAINTENANCE' ? 'in maintenance' : 'idle'}`
                      : `${selectedMachine.name} is disabled`}
                    , so no checks are generated until it is Active again.
                  </span>
                </div>
              )}
              {!form.isActive && <div className="text-ink-muted">Schedule is paused: nothing will be generated.</div>}
              {form.machineId &&
                (assignedWorker ? (
                  <div className="text-ink-secondary">Checks are assigned to {assignedWorker.name}.</div>
                ) : eligibleWorkers.length > 0 ? (
                  <div className="text-ink-secondary">
                    {eligibleWorkers.length === 1
                      ? `Checks are assigned to ${eligibleWorkers[0].name}.`
                      : `Checks are shared between ${eligibleWorkers.map((w) => w.name).join(', ')}.`}
                  </div>
                ) : (
                  !workersApi.loading && (
                    <div className="flex items-start gap-1.5 text-failed">
                      <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
                      <span>
                        No worker on {selectedShift?.name ?? 'this shift'} is assigned to {selectedMachine?.name ?? 'this machine'}. No checks are created until you
                        assign one in Machine Assignment.
                      </span>
                    </div>
                  )
                ))}
            </div>
          )}
        </form>
      </Modal>

      <ConfirmModal
        isOpen={deleting !== null}
        title="Delete schedule"
        danger
        confirmLabel="Delete"
        message={
          <>
            Delete the <span className="font-semibold text-ink">{deleting?.activityName}</span> schedule on{' '}
            <span className="font-semibold text-ink">{deleting?.machineName}</span> ({deleting?.shiftName})? Upcoming checks are removed; completed
            history is kept. To stop it temporarily, edit it and turn off Active instead.
          </>
        }
        onConfirm={remove}
        onClose={() => setDeleting(null)}
      />
    </div>
  )
}
