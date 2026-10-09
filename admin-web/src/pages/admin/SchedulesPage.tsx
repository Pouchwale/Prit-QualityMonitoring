import React, { useEffect, useMemo, useState } from 'react'
import { Briefcase, CalendarClock, CalendarRange, Clock3, Cpu, Pencil, Plus, Repeat, Search, Trash2 } from 'lucide-react'
import type { Activity, Department, Machine, QualityModule, Schedule, ScheduleMode, Shift, User, WorkerQualityRole } from '../../types'
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
import { TimeInput } from '../../components/common/DateTimeInputs'
import { Card, EmptyState } from '../../components/ui/Card'
import { IconButton, ResultCount, SearchInput, Segmented, Toolbar, ToolbarSpacer } from '../../components/ui/Toolbar'
import { Pagination, usePagination } from '../../components/ui/Pagination'

const PRESETS: { minutes: number; label: string }[] = [
  { minutes: 15, label: 'Every 15 min' },
  { minutes: 30, label: 'Every 30 min' },
  { minutes: 45, label: 'Every 45 min' },
  { minutes: 60, label: 'Every 1 hour' },
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

function slotTimes(start: string, end: string, interval: number) {
  const s = toMinutes(start)
  let e = toMinutes(end)
  if (e <= s) e += 1440
  const times: string[] = []
  for (let t = s; t < e; t += Math.max(interval, 5)) times.push(fromMinutes(t))
  return times
}

/** Role / module pills: the label names the role; the tint only groups them (same look as Check Types). */
const QUALITY_ROLE_BADGE: Record<WorkerQualityRole, string> = {
  IPQC: 'bg-accent-soft text-accent-strong ring-accent-line',
  QC: 'bg-white text-ink ring-line-strong',
  BOTH: 'bg-subtle text-ink-secondary ring-line'
}

const pill = 'inline-flex items-center gap-1 h-5 px-2 rounded-full ring-1 ring-inset text-[11px] font-semibold whitespace-nowrap'

const QUALITY_ROLE_LABEL: Record<WorkerQualityRole, string> = {
  IPQC: 'IPQC',
  QC: 'QC',
  BOTH: 'IPQC + QC'
}

type TabType = 'ALL' | 'IPQC' | 'QC'

interface FormState {
  targetType: 'WORKER' | 'MACHINE'
  workerId: string
  module: QualityModule
  departmentId: string
  activityId: string
  machineId: string
  shiftId: string
  mode: ScheduleMode
  preset: string
  intervalMinutes: string
  startTime: string
  endTime: string
  isActive: boolean
}

const emptyForm: FormState = {
  targetType: 'WORKER',
  workerId: '',
  module: 'IPQC',
  departmentId: '',
  activityId: '',
  machineId: '',
  shiftId: '',
  mode: 'INTERVAL',
  preset: '30',
  intervalMinutes: '30',
  startTime: '',
  endTime: '',
  isActive: true
}

export const SchedulesPage: React.FC = () => {
  const canEdit = useCanManage('schedules')
  const notify = useToast()
  const schedulesApi = useApi<Schedule[]>('/api/schedules')
  const usersApi = useApi<User[]>('/api/users')
  const departmentsApi = useApi<Department[]>('/api/departments')
  const activitiesApi = useApi<Activity[]>('/api/activities')
  const machinesApi = useApi<Machine[]>('/api/machines')
  const shiftsApi = useApi<Shift[]>('/api/shifts')

  const [tab, setTab] = useState<TabType>('ALL')
  const [search, setSearch] = useState('')
  const [workerFilter, setWorkerFilter] = useState('ALL')
  const [departmentFilter, setDepartmentFilter] = useState('ALL')
  const [editing, setEditing] = useState<Schedule | 'new' | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm)
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState<Schedule | null>(null)

  const schedules = useMemo(() => schedulesApi.data ?? [], [schedulesApi.data])
  const users = useMemo(() => usersApi.data ?? [], [usersApi.data])
  const workers = useMemo(() => users.filter((u) => u.role === 'WORKER' && u.isActive), [users])
  const departments = useMemo(() => departmentsApi.data ?? [], [departmentsApi.data])
  const activities = useMemo(() => activitiesApi.data ?? [], [activitiesApi.data])
  const machines = useMemo(() => machinesApi.data ?? [], [machinesApi.data])
  const shifts = useMemo(() => shiftsApi.data ?? [], [shiftsApi.data])

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }))

  const resolveShift = (shiftId?: string | null, workerId?: string | null): Shift | undefined => {
    if (workerId) {
      const w = workers.find((u) => u.id === workerId)
      if (w?.shiftId) {
        const match = shifts.find((s) => s.id === w.shiftId)
        if (match) return match
      }
    }
    if (shiftId) {
      const match = shifts.find((s) => s.id === shiftId)
      if (match) return match
    }
    return shifts.find((s) => s.isActive) ?? shifts[0]
  }

  const selectedShift = useMemo(() => shifts.find((s) => s.id === form.shiftId), [shifts, form.shiftId])

  const counts = useMemo(() => {
    let all = 0
    let ipqc = 0
    let qc = 0
    for (const s of schedules) {
      all++
      const m = s.module ?? s.activityModule ?? 'IPQC'
      if (m === 'IPQC') ipqc++
      else if (m === 'QC') qc++
    }
    return { ALL: all, IPQC: ipqc, QC: qc }
  }, [schedules])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return schedules.filter((s) => {
      const mod = s.module ?? s.activityModule ?? 'IPQC'
      if (tab !== 'ALL' && mod !== tab) return false
      if (workerFilter !== 'ALL' && s.workerId !== workerFilter) return false
      if (departmentFilter !== 'ALL' && s.departmentId !== departmentFilter) return false
      if (!q) return true
      return [
        s.workerName,
        s.workerEmployeeId,
        s.activityName,
        s.departmentName,
        s.machineName,
        s.shiftName,
        mod
      ].some((v) => v?.toLowerCase().includes(q))
    })
  }, [schedules, tab, workerFilter, departmentFilter, search])
  const page = usePagination(filtered, 25, `${tab}|${workerFilter}|${departmentFilter}|${search}`)
  const activeCount = schedules.filter((s) => s.isActive).length

  const openNew = () => {
    const firstWorker = workers[0]
    const initialRole: QualityModule = firstWorker?.workerQualityRole === 'QC' ? 'QC' : 'IPQC'
    const matchedShift = resolveShift(firstWorker?.shiftId, firstWorker?.id)
    setForm({
      ...emptyForm,
      targetType: 'WORKER',
      workerId: firstWorker?.id ?? '',
      module: initialRole,
      departmentId: firstWorker?.departmentId ?? '',
      activityId: '',
      shiftId: matchedShift?.id ?? '',
      startTime: matchedShift?.startTime ?? '',
      endTime: matchedShift?.endTime ?? ''
    })
    setFormError(null)
    setEditing('new')
  }

  const openEdit = (s: Schedule) => {
    const preset = PRESETS.some((p) => p.minutes === s.intervalMinutes) ? String(s.intervalMinutes) : 'custom'
    const isWorkerSched = Boolean(s.workerId) || !s.machineId
    const mod = s.module ?? s.activityModule ?? 'IPQC'
    const matchedShift = isWorkerSched ? resolveShift(null, s.workerId) : resolveShift(s.shiftId, null)

    const startTime = matchedShift?.startTime ?? s.startTime ?? ''
    const endTime = matchedShift?.endTime ?? s.endTime ?? ''

    setForm({
      targetType: isWorkerSched ? 'WORKER' : 'MACHINE',
      workerId: s.workerId ?? '',
      module: mod,
      departmentId: s.departmentId ?? '',
      activityId: s.activityId,
      machineId: s.machineId ?? '',
      shiftId: matchedShift?.id ?? s.shiftId ?? '',
      mode: s.mode ?? 'INTERVAL',
      preset,
      intervalMinutes: String(s.intervalMinutes),
      startTime,
      endTime,
      isActive: s.isActive
    })
    setFormError(null)
    setEditing(s)
  }

  const close = () => setEditing(null)

  const changePreset = (value: string) =>
    setForm((f) => ({ ...f, preset: value, intervalMinutes: value === 'custom' ? f.intervalMinutes : value }))

  const onWorkerChange = (wId: string) => {
    const w = workers.find((u) => u.id === wId)
    const allowed = w?.workerQualityRole ?? 'IPQC'
    let newMod: QualityModule = form.module
    if (allowed === 'QC') newMod = 'QC'
    else if (allowed === 'IPQC') newMod = 'IPQC'

    // Automatically use Worker's assigned Shift and populate Schedule Window from that Shift
    const targetShift = resolveShift(w?.shiftId, wId)

    setForm((f) => ({
      ...f,
      workerId: wId,
      module: newMod,
      departmentId: w?.departmentId ?? f.departmentId,
      activityId: '', // reset activity selection when worker changes
      shiftId: targetShift?.id ?? '',
      startTime: targetShift?.startTime ?? '',
      endTime: targetShift?.endTime ?? ''
    }))
  }

  const onShiftChange = (shiftId: string) => {
    const s = shifts.find((sh) => sh.id === shiftId)
    setForm((f) => ({
      ...f,
      shiftId,
      startTime: s?.startTime ?? '',
      endTime: s?.endTime ?? ''
    }))
  }

  const onTargetTypeChange = (targetType: 'WORKER' | 'MACHINE') => {
    if (targetType === 'WORKER') {
      const w = workers.find((u) => u.id === form.workerId) ?? workers[0]
      const targetShift = resolveShift(w?.shiftId, w?.id)
      setForm((f) => ({
        ...f,
        targetType,
        workerId: w?.id ?? '',
        shiftId: targetShift?.id ?? '',
        startTime: targetShift?.startTime ?? '',
        endTime: targetShift?.endTime ?? ''
      }))
    } else {
      const targetShift = resolveShift(form.shiftId, null)
      setForm((f) => ({
        ...f,
        targetType,
        shiftId: targetShift?.id ?? f.shiftId,
        startTime: targetShift?.startTime ?? f.startTime,
        endTime: targetShift?.endTime ?? f.endTime
      }))
    }
  }

  // Automatically keep Shift and Schedule Window in sync with the selected worker's assigned shift
  useEffect(() => {
    if (!editing) return
    if (form.targetType === 'WORKER' && form.workerId) {
      const w = workers.find((u) => u.id === form.workerId)
      if (w?.shiftId) {
        const targetShift = shifts.find((sh) => sh.id === w.shiftId)
        if (targetShift) {
          if (form.shiftId !== targetShift.id || form.startTime !== targetShift.startTime || form.endTime !== targetShift.endTime) {
            setForm((f) => ({
              ...f,
              shiftId: targetShift.id,
              startTime: targetShift.startTime,
              endTime: targetShift.endTime
            }))
          }
        }
      }
    }
  }, [editing, form.targetType, form.workerId, workers, shifts, form.shiftId, form.startTime, form.endTime])

  const onModuleChange = (newMod: QualityModule) => {
    setForm((f) => ({
      ...f,
      module: newMod,
      activityId: '' // reset activity when switching module
    }))
  }

  const interval = Number(form.intervalMinutes)
  const intervalValid = Number.isInteger(interval) && interval >= 5 && interval <= 1440
  const windowValid = HHMM.test(form.startTime) && HHMM.test(form.endTime) && form.startTime !== form.endTime

  const submit = async (e: React.SyntheticEvent) => {
    e.preventDefault()
    if (!form.shiftId) return setFormError('Choose a shift for this schedule')
    if (form.targetType === 'WORKER') {
      if (!form.workerId) return setFormError('Choose a worker')
      if (!form.activityId) return setFormError('Choose a check name')
      if (!windowValid) return setFormError('Valid start and end times are required from the selected shift')
      if (!intervalValid) return setFormError('Frequency must be a whole number of minutes between 5 and 1440')
    } else {
      if (!form.machineId) return setFormError('Choose a machine')
      if (!form.activityId) return setFormError('Choose a check type')
      if (!windowValid) return setFormError('Valid start and end times are required from the selected shift')
      if (!intervalValid) return setFormError('Frequency must be between 5 and 1440 minutes')
    }

    setSaving(true)
    setFormError(null)
    try {
      let finalShiftId = form.shiftId
      let finalStartTime = form.startTime
      let finalEndTime = form.endTime

      if (form.targetType === 'WORKER') {
        const w = workers.find((u) => u.id === form.workerId)
        if (w?.shiftId) {
          const targetShift = shifts.find((s) => s.id === w.shiftId)
          if (targetShift) {
            finalShiftId = targetShift.id
            finalStartTime = targetShift.startTime
            finalEndTime = targetShift.endTime
          }
        }
      }

      const body = {
        workerId: form.targetType === 'WORKER' ? form.workerId : null,
        module: form.module,
        departmentId: form.departmentId || null,
        activityId: form.activityId,
        machineId: form.targetType === 'MACHINE' ? form.machineId : null,
        shiftId: finalShiftId,
        mode: form.mode,
        intervalMinutes: interval,
        startTime: finalStartTime,
        endTime: finalEndTime,
        isActive: form.isActive
      }
      if (editing === 'new') {
        await api.post('/api/schedules', body)
        notify('success', 'Schedule created', 'Check reminders will be generated based on the configured schedule.')
      } else if (editing) {
        await api.put(`/api/schedules/${editing.id}`, body)
        notify('success', 'Schedule updated', 'Upcoming checks were updated; completed history is kept.')
      }
      setEditing(null)
      schedulesApi.reload()
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
      notify('success', 'Schedule deleted', `${deleting.activityName}. Upcoming checks were removed.`)
      schedulesApi.reload()
    } catch (err) {
      notify('error', 'Could not delete schedule', errorText(err))
    }
  }

  // Filtered check activities for the selected module
  const currentWorker = workers.find((w) => w.id === form.workerId)
  const workerAllowedModules: QualityModule[] = currentWorker?.workerQualityRole === 'BOTH'
    ? ['IPQC', 'QC']
    : currentWorker?.workerQualityRole === 'QC'
      ? ['QC']
      : ['IPQC']

  const eligibleActivities = useMemo(() => {
    return activities.filter((a) => {
      if (a.module !== form.module) return false
      if (!a.isActive && a.id !== form.activityId) return false
      return true
    })
  }, [activities, form.module, form.activityId])

  // Preview
  const preview = useMemo(() => {
    if (!intervalValid || !windowValid) return null
    const times = slotTimes(form.startTime, form.endTime, interval)
    const shown = times.length <= 4 ? times.join(', ') : `${times.slice(0, 3).join(', ')} … ${times[times.length - 1]}`
    return { times, text: `${times.length === 1 ? 'Check at' : 'Checks at'} ${shown} (${times.length} checks/day)` }
  }, [intervalValid, windowValid, form.startTime, form.endTime, interval])

  const pickerError = schedulesApi.error || usersApi.error || activitiesApi.error

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<CalendarClock className="w-4.5 h-4.5" />}
        title="Check Schedules"
        description={schedulesApi.data ? `${schedules.length} schedules · ${activeCount} active` : 'Routine IPQC and QC check reminders'}
        info="Schedule-based quality checks and routine reminders for IPQC and QC workers."
        actions={
          canEdit && (
            <Button size="sm" variant="primary" onClick={openNew} icon={<Plus className="w-3.5 h-3.5" />}>
              Add Schedule
            </Button>
          )
        }
      />

      <DataState
        loading={schedulesApi.loading}
        error={schedulesApi.error}
        onRetry={schedulesApi.reload}
        empty={!schedulesApi.loading && schedules.length === 0}
        emptyText="No schedules configured yet. Click Add Schedule to create one."
      >
        <Card className="overflow-hidden">
          <Toolbar>
            <Segmented
              label="Filter by quality role"
              value={tab}
              onChange={setTab}
              options={(['ALL', 'IPQC', 'QC'] as TabType[]).map((t) => ({ value: t, label: t === 'ALL' ? 'All Roles' : t, count: counts[t] }))}
            />
            <SearchInput value={search} onChange={setSearch} label="Search schedules" placeholder="Search schedules…" />
            <Select value={workerFilter} onChange={(e) => setWorkerFilter(e.target.value)} className="sm:w-auto sm:min-w-[150px] sm:max-w-[220px]" aria-label="Worker">
              <option value="ALL">All workers</option>
              {workers.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name} ({w.workerQualityRole ?? 'IPQC'})
                </option>
              ))}
            </Select>
            <Select value={departmentFilter} onChange={(e) => setDepartmentFilter(e.target.value)} className="sm:w-auto sm:min-w-[150px]" aria-label="Department">
              <option value="ALL">All departments</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
            <ToolbarSpacer />
            <ResultCount shown={filtered.length} total={schedules.length} noun="schedules" />
          </Toolbar>

          {filtered.length === 0 ? (
            <EmptyState icon={<Search className="w-5 h-5" />} title="No schedules match the filters" compact />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table stack-sm">
                <thead>
                  <tr>
                    <th>Worker</th>
                    <th>Role</th>
                    <th>Check type</th>
                    <th>Shift window</th>
                    <th>Interval</th>
                    <th>Next due</th>
                    <th>Status</th>
                    {canEdit && <th className="text-right">Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {page.visible.map((s) => {
                    const mod = s.module ?? s.activityModule ?? 'IPQC'
                    return (
                      <tr key={s.id}>
                        <td className="whitespace-nowrap">
                          {s.workerName ? (
                            <div>
                              <div className="flex items-center gap-1.5">
                                <span className="font-semibold text-ink">{s.workerName}</span>
                                {s.workerQualityRole && (
                                  <span className={`${pill} font-medium ${QUALITY_ROLE_BADGE[s.workerQualityRole]}`} title="Worker quality role">
                                    {QUALITY_ROLE_LABEL[s.workerQualityRole]}
                                  </span>
                                )}
                              </div>
                              <span className="block font-mono text-[11.5px] text-ink-muted">{s.workerEmployeeId}</span>
                            </div>
                          ) : (
                            <div>
                              <span className="inline-flex items-center gap-1.5 font-semibold text-ink">
                                <Cpu className="w-3.5 h-3.5 text-ink-muted" aria-hidden />
                                {s.machineName ?? 'Machine schedule'}
                              </span>
                              <span className="block text-[11.5px] text-ink-muted">Legacy machine target</span>
                            </div>
                          )}
                        </td>
                        <td>
                          <span className={`${pill} tracking-wide ${QUALITY_ROLE_BADGE[mod]}`}>{mod}</span>
                        </td>
                        <td>
                          <span className="font-medium text-ink whitespace-nowrap">{s.activityName}</span>
                          {s.departmentName && <span className="block text-[11.5px] text-ink-muted whitespace-nowrap">{s.departmentName}</span>}
                        </td>
                        <td className="whitespace-nowrap">
                          {s.shiftName ? (
                            <div>
                              <span className="font-medium text-ink">{s.shiftName}</span>
                              <span className="block font-mono text-[11.5px] text-ink-muted tabular-nums">
                                {formatClockRange(s.startTime || s.shiftStartTime, s.endTime || s.shiftEndTime)}
                              </span>
                            </div>
                          ) : s.startTime && s.endTime ? (
                            <span className="font-mono text-ink tabular-nums">{formatClockRange(s.startTime, s.endTime)}</span>
                          ) : (
                            <span className="text-ink-muted">Whole day</span>
                          )}
                        </td>
                        <td>
                          <div className="flex flex-wrap items-center gap-1">
                            <span className={`${pill} font-medium bg-subtle text-ink ring-line`}>
                              <Repeat className="w-3 h-3 text-ink-muted" aria-hidden />
                              {frequencyLabel(s.intervalMinutes)}
                            </span>
                            {s.mode === 'JOB' && (
                              <span className={`${pill} font-medium bg-white text-ink-secondary ring-line-strong`} title="Job-based schedule">
                                <Briefcase className="w-3 h-3" aria-hidden />
                                Job
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="whitespace-nowrap">
                          {s.nextDueAt ? (
                            <span className="inline-flex items-center gap-1 text-ink tabular-nums">
                              <Clock3 className="w-3 h-3 text-ink-muted" aria-hidden />
                              {formatDateTime(s.nextDueAt)}
                            </span>
                          ) : (
                            <span className="text-ink-faint">—</span>
                          )}
                          {s.lastSubmittedAt && <span className="block text-[11.5px] text-ink-muted">Last submitted {formatDateTime(s.lastSubmittedAt)}</span>}
                        </td>
                        <td>
                          <StatusBadge status={s.isActive ? 'ACTIVE' : 'Paused'} size="sm" />
                        </td>
                        {canEdit && (
                          <td className="text-right whitespace-nowrap" data-label="">
                            <div className="inline-flex gap-0.5">
                              <IconButton label={`Edit ${s.activityName} schedule`} onClick={() => openEdit(s)}>
                                <Pencil className="w-3.5 h-3.5" />
                              </IconButton>
                              <IconButton label={`Delete ${s.activityName} schedule`} tone="danger" onClick={() => setDeleting(s)}>
                                <Trash2 className="w-3.5 h-3.5" />
                              </IconButton>
                            </div>
                          </td>
                        )}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          <Pagination page={page.page} pages={page.pages} total={page.total} pageSize={page.pageSize} onPage={page.setPage} noun="schedules" />
        </Card>
      </DataState>

      <Modal
        isOpen={editing !== null}
        onClose={close}
        title={editing === 'new' ? 'Add Check Schedule' : 'Edit Check Schedule'}
        subtitle="Configure schedule-based IPQC or QC checks for a worker without job dependency"
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
          {pickerError && <FormError message={`Could not load master data: ${pickerError}`} />}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Schedule Target" required>
              <Select
                value={form.targetType}
                onChange={(e) => onTargetTypeChange(e.target.value as 'WORKER' | 'MACHINE')}
              >
                <option value="WORKER">Worker Schedule (Schedule-Based IPQC/QC)</option>
                <option value="MACHINE">Machine Schedule (Legacy)</option>
              </Select>
            </Field>

            {form.targetType === 'WORKER' ? (
              <Field
                label="Worker"
                required
                hint={
                  currentWorker
                    ? `Quality Role: ${QUALITY_ROLE_LABEL[currentWorker.workerQualityRole ?? 'IPQC']}${
                        currentWorker.shiftName ? ` · Shift: ${currentWorker.shiftName}` : ''
                      }`
                    : undefined
                }
              >
                <Select value={form.workerId} onChange={(e) => onWorkerChange(e.target.value)} autoFocus>
                  <option value="">Choose worker…</option>
                  {workers.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name} ({w.employeeId}) — {QUALITY_ROLE_LABEL[w.workerQualityRole ?? 'IPQC']}{w.shiftName ? ` [${w.shiftName}]` : ''}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : (
              <Field label="Machine" required>
                <Select value={form.machineId} onChange={(e) => set('machineId', e.target.value)} autoFocus>
                  <option value="">Choose machine…</option>
                  {machines.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name} ({m.code})
                    </option>
                  ))}
                </Select>
              </Field>
            )}

            <Field
              label="Shift (Working Hours Source)"
              required
              hint={
                form.targetType === 'WORKER' && currentWorker?.shiftId
                  ? `Automatically selected from ${currentWorker.name}'s assigned shift (${currentWorker.shiftName || selectedShift?.name || 'Shift'})`
                  : form.targetType === 'WORKER'
                    ? 'Worker has no assigned shift in Workers master. Please select a shift.'
                    : 'Start and End times are taken directly from this shift'
              }
            >
              <Select
                value={form.shiftId}
                onChange={(e) => onShiftChange(e.target.value)}
                disabled={form.targetType === 'WORKER' && Boolean(currentWorker?.shiftId)}
              >
                <option value="">Choose shift…</option>
                {shifts.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({formatClockRange(s.startTime, s.endTime)}){s.isActive ? '' : ' (inactive)'}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Role / Module" required hint="Separate IPQC and QC configurations">
              <Select
                value={form.module}
                onChange={(e) => onModuleChange(e.target.value as QualityModule)}
                disabled={form.targetType === 'WORKER' && currentWorker?.workerQualityRole !== 'BOTH' && workerAllowedModules.length === 1}
              >
                {workerAllowedModules.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </Select>
            </Field>

            <div className="col-span-1 sm:col-span-2">
              <Field label="Department">
                <Select value={form.departmentId} onChange={(e) => set('departmentId', e.target.value)}>
                  <option value="">Choose department (or inherit from check)…</option>
                  {departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            <div className="col-span-1 sm:col-span-2">
              <Field label="Check Name / Parameters" required hint={`Configured ${form.module} check parameters`}>
                <Select value={form.activityId} onChange={(e) => set('activityId', e.target.value)}>
                  <option value="">Choose a check configuration…</option>
                  {eligibleActivities.map((a) => {
                    const paramsList = a.parameters
                      .filter((p) => p.isEnabled)
                      .map((p) => p.name)
                      .join(', ')
                    return (
                      <option key={a.id} value={a.id}>
                        {a.name} ({a.module}) — {paramsList || 'No parameters'}
                      </option>
                    )
                  })}
                </Select>
                {activities.find((a) => a.id === form.activityId) && (
                  <div className="mt-2 p-2.5 rounded-md bg-subtle/60 border border-line text-[12px]">
                    <span className="font-semibold text-ink block mb-1">
                      Parameters for this check ({activities.find((a) => a.id === form.activityId)!.parameters.filter((p) => p.isEnabled).length}):
                    </span>
                    <div className="flex flex-wrap gap-1.5">
                      {activities.find((a) => a.id === form.activityId)!.parameters
                        .filter((p) => p.isEnabled)
                        .map((p, idx) => (
                          <span
                            key={p.parameterId}
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-white ring-1 ring-inset ring-line text-ink text-[11px] font-medium"
                          >
                            <span className="text-[11px] text-accent font-semibold tabular-nums">{idx + 1}.</span>
                            {p.name}
                            {p.type === 'NUMBER' && p.unit && (
                              <span className="text-[11px] text-ink-muted">({p.unit})</span>
                            )}
                          </span>
                        ))}
                    </div>
                  </div>
                )}
              </Field>
            </div>

            <div className="col-span-1 sm:col-span-2">
              <Field label="Interval (Frequency)" required hint="How often reminders trigger (e.g. Every 30 minutes, Every 1 hour)">
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
                    <div className="relative w-28 shrink-0">
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

            <div className="col-span-1 sm:col-span-2 rounded-md border border-line p-3 space-y-2.5 bg-subtle/60">
              <div className="flex flex-wrap items-center justify-between gap-1.5">
                <div>
                  <span className="flex items-center gap-1.5 text-[12.5px] font-semibold text-ink">
                    <CalendarRange className="w-3.5 h-3.5 text-ink-muted" aria-hidden />
                    Schedule Window (Start Time & End Time)
                  </span>
                  <span className="text-[11px] text-ink-secondary">
                    {selectedShift ? (
                      <>Directly synchronized from <strong>{selectedShift.name}</strong> ({formatClockRange(selectedShift.startTime, selectedShift.endTime)})</>
                    ) : (
                      'Please select a shift to populate the schedule window'
                    )}
                  </span>
                </div>
                {selectedShift && (
                  <span className="inline-flex items-center gap-1 h-5 px-2 rounded-full text-[11px] font-semibold bg-success-bg text-success ring-1 ring-inset ring-success-line">
                    Source: Shift Timings
                  </span>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Start Time" required hint={selectedShift ? `Shift start: ${selectedShift.startTime}` : undefined}>
                  <TimeInput label="Start time" value={form.startTime} disabled={true} onChange={(v) => set('startTime', v)} />
                </Field>
                <Field label="End Time" required hint={selectedShift ? `Shift end: ${selectedShift.endTime}` : undefined}>
                  <TimeInput label="End time" value={form.endTime} disabled={true} onChange={(v) => set('endTime', v)} />
                </Field>
              </div>
            </div>
          </div>

          <Toggle checked={form.isActive} onChange={(v) => set('isActive', v)} label="Active" description="Inactive schedules do not generate notifications or checks." />

          {preview && (
            <div className="rounded-md border border-accent-line bg-accent-soft px-3 py-2 space-y-1 text-[12px]" role="status">
              <div className="flex items-start gap-1.5 text-ink">
                <CalendarClock className="w-3.5 h-3.5 shrink-0 mt-px text-accent" aria-hidden />
                <span>
                  <span className="font-mono font-medium">{preview.text}</span>
                </span>
              </div>
              <div className="text-ink-secondary">
                Notifications will be sent to the assigned worker's phone when each check becomes due.
              </div>
              {!form.isActive && <div className="text-ink-muted">Schedule is paused: no notifications or checks will be generated.</div>}
            </div>
          )}
        </form>
      </Modal>

      <ConfirmModal
        isOpen={deleting !== null}
        title="Delete check schedule"
        danger
        confirmLabel="Delete"
        message={
          <>
            Delete the <span className="font-semibold text-ink">{deleting?.activityName}</span> schedule? Upcoming checks are removed; completed history is kept.
          </>
        }
        onConfirm={remove}
        onClose={() => setDeleting(null)}
      />
    </div>
  )
}
