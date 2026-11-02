import React, { useMemo, useState } from 'react'
import { Clock3, Coffee, Moon, Pencil, Plus, Trash2 } from 'lucide-react'
import type { Shift } from '../../types'
import { api, errorText } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { useAuth, useModuleActions, useCanActivate, ACTIVATION_HINT } from '../../lib/auth'
import { Button } from '../../components/common/Button'
import { ConfirmModal } from '../../components/common/ConfirmModal'
import { DataState } from '../../components/common/DataState'
import { Field, FormError, TextInput, Toggle, inputClass } from '../../components/common/Form'
import { Modal } from '../../components/common/Modal'
import { PageHeader } from '../../components/common/PageHeader'
import { StatusBadge } from '../../components/common/StatusBadge'
import { useToast } from '../../components/common/Toast'
import { formatClockRange } from '../../lib/format'
import { TimeInput } from '../../components/common/DateTimeInputs'
import { Card, EmptyState } from '../../components/ui/Card'
import { IconButton, ResultCount, Segmented, Toolbar, ToolbarSpacer } from '../../components/ui/Toolbar'
import { CodeChip, matchesStatus, type StatusTab } from '../../components/ui/Chips'
import { ShiftLoginSettingsCard } from './ShiftSignIn'
import { WorkerBreaksCard } from './WorkerBreaks'
import { WifiRuleCard } from './WifiRule'

interface FormState {
  name: string
  code: string
  startTime: string
  endTime: string
  graceMinutes: string
  isActive: boolean
  /** The break question: null until answered (a new shift must answer it). */
  breakMode: 'set' | 'none' | null
  breakStart: string
  breakEnd: string
  breakMinutes: string
}

const emptyForm: FormState = {
  name: '',
  code: '',
  startTime: '08:00',
  endTime: '16:00',
  graceMinutes: '15',
  isActive: true,
  breakMode: null,
  breakStart: '12:00',
  breakEnd: '12:30',
  breakMinutes: '30'
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

/** Shift length in minutes; an end time at or before the start runs past midnight. */
const shiftLength = (start: string, end: string) => {
  const diff = toMinutes(end) - toMinutes(start)
  return diff <= 0 ? diff + 1440 : diff
}

const durationLabel = (minutes: number) => {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m ? `${h} h ${m} min` : `${h} h`
}

const isOvernight = (s: { startTime: string; endTime: string }) => toMinutes(s.endTime) <= toMinutes(s.startTime)

const toHHMM = (minutes: number) => {
  const m = ((minutes % 1440) + 1440) % 1440
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}
/** Minutes from one time to the next (round the clock). */
const span = (from: string, to: string) => (toMinutes(to) - toMinutes(from) + 1440) % 1440 || 1440

/** Why this break does not fit the shift, or null when it does (the server checks the same). */
function breakProblem(f: FormState): string | null {
  if (f.breakMode === null) return 'Set the break time of this shift, or choose "No break".'
  if (f.breakMode === 'none') return null
  if (!HHMM.test(f.breakStart) || !HHMM.test(f.breakEnd)) return 'Choose the break start and end.'
  if (f.breakStart === f.breakEnd) return 'The break must end after it starts.'
  const length = span(f.breakStart, f.breakEnd)
  if (length > 240) return 'A break can be at most 4 hours.'
  const offset = (toMinutes(f.breakStart) - toMinutes(f.startTime) + 1440) % 1440
  if (offset + length > shiftLength(f.startTime, f.endTime)) return "The break must be inside the shift's hours. Change the break or the shift times."
  return null
}

/**
 * Where the shift falls in the day, midnight to midnight; an overnight shift wraps round to the
 * start. Decorative: the times are always written next to it.
 */
const DayBar: React.FC<{ start: string; end: string }> = ({ start, end }) => {
  const from = (toMinutes(start) / 1440) * 100
  const to = (toMinutes(end) / 1440) * 100
  const parts = (isOvernight({ startTime: start, endTime: end }) ? [[from, 100], [0, to]] : [[from, to]]).filter(([x, y]) => y > x)
  return (
    <span className="relative block w-28 h-1.5 rounded-full bg-subtle ring-1 ring-inset ring-line overflow-hidden" aria-hidden>
      {parts.map(([a, b]) => (
        <span key={a} className="absolute inset-y-0 bg-[var(--color-chart-primary)] rounded-full" style={{ left: `${a}%`, width: `${b - a}%` }} />
      ))}
    </span>
  )
}

/**
 * The shift's break, asked together with its hours: every worker on the shift gets it (no checks are
 * due or missed during it), and a worker moved to another shift takes that shift's break.
 */
const BreakFields: React.FC<{ form: FormState; setForm: React.Dispatch<React.SetStateAction<FormState>> }> = ({ form, setForm }) => {
  // Start keeps the length, End sets the length, Length moves the end.
  const setStart = (breakStart: string) =>
    setForm((f) => {
      const m = Number(f.breakMinutes)
      return { ...f, breakStart, breakEnd: Number.isInteger(m) && m > 0 ? toHHMM(toMinutes(breakStart) + m) : f.breakEnd }
    })
  const setEnd = (breakEnd: string) => setForm((f) => ({ ...f, breakEnd, breakMinutes: String(span(f.breakStart, breakEnd)) }))
  const setLength = (breakMinutes: string) =>
    setForm((f) => {
      const m = Number(breakMinutes)
      return { ...f, breakMinutes, breakEnd: Number.isInteger(m) && m > 0 ? toHHMM(toMinutes(f.breakStart) + m) : f.breakEnd }
    })
  const choose = (mode: 'set' | 'none') =>
    setForm((f) => {
      if (mode === 'none' || f.breakMode === 'set') return { ...f, breakMode: mode }
      // First time: suggest 30 minutes, 4 hours into the shift (or halfway through a short one).
      const into = Math.min(240, Math.floor(shiftLength(f.startTime, f.endTime) / 2))
      const breakStart = toHHMM(toMinutes(f.startTime) + into)
      return { ...f, breakMode: 'set', breakStart, breakEnd: toHHMM(toMinutes(breakStart) + 30), breakMinutes: '30' }
    })
  const problem = form.breakMode === 'set' ? breakProblem(form) : null
  return (
    <fieldset className={`rounded-md border p-3 space-y-3 ${form.breakMode === null ? 'border-due-line bg-due-bg' : 'border-line'}`}>
      <legend className="px-1 text-[14px] font-semibold text-ink">
        Break time <span className="text-failed">*</span>
      </legend>
      <p className="text-[13.5px] text-ink-muted -mt-1">Every worker on this shift gets this break. Moving a worker to another shift gives them that shift's break.</p>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Break time">
        {(['set', 'none'] as const).map((m) => (
          <label
            key={m}
            className={`inline-flex items-center gap-2 h-8 px-3 rounded-md border cursor-pointer text-[14.5px] bg-surface ${form.breakMode === m ? 'border-accent text-ink' : 'border-line text-ink-secondary hover:border-line-strong'}`}
          >
            <input type="radio" name="break-mode" checked={form.breakMode === m} onChange={() => choose(m)} />
            {m === 'set' ? 'Set a break time' : 'No break'}
          </label>
        ))}
      </div>
      {form.breakMode === 'set' && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Break start" required>
              <TimeInput label="Break start" value={form.breakStart} onChange={setStart} />
            </Field>
            <Field label="Break end" required>
              <TimeInput label="Break end" value={form.breakEnd} onChange={setEnd} />
            </Field>
          </div>
          <Field label="Length (minutes)" required hint="Changing it moves the break end.">
            <input type="number" min={1} max={240} step={1} value={form.breakMinutes} onChange={(e) => setLength(e.target.value)} className={`${inputClass} sm:max-w-[10rem]`} />
          </Field>
          {problem ? (
            <p className="text-[13.5px] text-failed" role="alert">
              {problem}
            </p>
          ) : (
            <p className="text-[13.5px] text-ink-muted">
              During the break the shift's workers get no check notifications and no check is marked Missed; checks due then are due at the end of the break.
            </p>
          )}
        </>
      )}
    </fieldset>
  )
}

export const ShiftsPage: React.FC = () => {
  const canActivate = useCanActivate()
  const { canCreate, canEdit, canDelete, canWrite } = useModuleActions('shifts')
  const { can } = useAuth()
  const notify = useToast()
  const { data, error, loading, reload } = useApi<Shift[]>('/api/shifts')

  const [editing, setEditing] = useState<Shift | 'new' | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm)
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState<Shift | null>(null)

  const shifts = useMemo(() => data ?? [], [data])
  const [statusTab, setStatusTab] = useState<StatusTab>('ALL')
  const activeCount = shifts.filter((s) => s.isActive).length
  const filtered = useMemo(() => shifts.filter((s) => matchesStatus(statusTab, s.isActive)), [shifts, statusTab])
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }))

  const openNew = () => {
    setForm(emptyForm)
    setFormError(null)
    setEditing('new')
  }

  const openEdit = (s: Shift) => {
    setForm({
      name: s.name,
      code: s.code,
      startTime: s.startTime,
      endTime: s.endTime,
      graceMinutes: String(s.graceMinutes),
      isActive: s.isActive,
      // A shift without a break is asked again: set one, or confirm "No break".
      breakMode: s.breakStartTime && s.breakEndTime ? 'set' : null,
      breakStart: s.breakStartTime ?? '12:00',
      breakEnd: s.breakEndTime ?? '12:30',
      breakMinutes: String(s.breakStartTime && s.breakEndTime ? span(s.breakStartTime, s.breakEndTime) : 30)
    })
    setFormError(null)
    setEditing(s)
  }

  const close = () => setEditing(null)

  const submit = async (e: React.SyntheticEvent) => {
    e.preventDefault()
    const grace = Number(form.graceMinutes)
    if (!form.name.trim() || !form.code.trim()) return setFormError('Name and code are required')
    if (!HHMM.test(form.startTime) || !HHMM.test(form.endTime)) return setFormError('Choose a start and an end time')
    if (form.startTime === form.endTime) return setFormError('Start and end time cannot be the same')
    if (!Number.isInteger(grace) || grace < 0 || grace > 240) return setFormError('Grace period must be a whole number between 0 and 240 minutes')
    const problem = breakProblem(form)
    if (problem) return setFormError(problem)

    setSaving(true)
    setFormError(null)
    try {
      const body = {
        name: form.name.trim(),
        code: form.code.trim(),
        startTime: form.startTime,
        endTime: form.endTime,
        graceMinutes: grace,
        isActive: form.isActive,
        breakStartTime: form.breakMode === 'set' ? form.breakStart : null,
        breakEndTime: form.breakMode === 'set' ? form.breakEnd : null
      }
      if (editing === 'new') {
        await api.post('/api/shifts', body)
        notify('success', 'Shift created', body.name)
      } else if (editing) {
        await api.put(`/api/shifts/${editing.id}`, body)
        notify('success', 'Shift updated', `${body.name}. Upcoming checks for this shift will be regenerated; its workers follow its break.`)
      }
      setEditing(null)
      reload()
    } catch (err) {
      setFormError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!deleting) return
    try {
      const { result } = await api.del(`/api/shifts/${deleting.id}`)
      if (result === 'disabled') {
        notify('warning', 'Shift disabled', `${deleting.name} is in use by schedules, users or check history, so it was marked inactive instead of deleted.`)
      } else {
        notify('success', 'Shift deleted', deleting.name)
      }
      reload()
    } catch (err) {
      notify('error', 'Could not delete shift', errorText(err))
    }
  }

  const formValid = HHMM.test(form.startTime) && HHMM.test(form.endTime) && form.startTime !== form.endTime

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<Clock3 className="w-4.5 h-4.5" />}
        title="Shifts"
        description={data ? `${shifts.length} ${shifts.length === 1 ? 'shift' : 'shifts'} · ${activeCount} active` : 'Working shifts'}
        info="Working shifts define when scheduled quality checks are generated. Times are plant time; an end time at or before the start runs past midnight."
        actions={
          canCreate && (
            <Button size="sm" variant="primary" onClick={openNew} icon={<Plus className="w-3.5 h-3.5" />}>
              Add Shift
            </Button>
          )
        }
      />

      <DataState loading={loading} error={error} onRetry={reload} empty={data ? false : undefined}>
        <Card className="overflow-hidden">
          <Toolbar>
            <Segmented<StatusTab>
              label="Filter by status"
              value={statusTab}
              onChange={setStatusTab}
              options={[
                { value: 'ALL', label: 'All', count: shifts.length },
                { value: 'ACTIVE', label: 'Active', count: activeCount },
                { value: 'INACTIVE', label: 'Inactive', count: shifts.length - activeCount }
              ]}
            />
            <ToolbarSpacer />
            <ResultCount shown={filtered.length} total={shifts.length} noun={shifts.length === 1 ? 'shift' : 'shifts'} />
          </Toolbar>

          {filtered.length === 0 ? (
            <EmptyState
              icon={<Clock3 className="w-5 h-5" />}
              title={shifts.length === 0 ? 'No shifts yet' : 'No shifts match the filter'}
              action={
                shifts.length === 0 && canCreate ? (
                  <Button size="sm" variant="outline" onClick={openNew} icon={<Plus className="w-3.5 h-3.5" />}>
                    Add Shift
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table stack-sm">
                <thead>
                  <tr>
                    <th>Shift</th>
                    <th>Time</th>
                    <th>Timeline</th>
                    <th className="num">Duration</th>
                    <th>Break</th>
                    <th className="num">Grace</th>
                    <th>Status</th>
                    {canWrite && (
                      <th className="text-right">
                        <span className="sr-only">Actions</span>
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((s) => (
                    <tr key={s.id}>
                      <td className="whitespace-nowrap">
                        <div className="inline-flex items-center gap-2">
                          <span className={`font-semibold ${s.isActive ? 'text-ink' : 'text-ink-muted'}`}>{s.name}</span>
                          <CodeChip>{s.code}</CodeChip>
                        </div>
                      </td>
                      <td className="whitespace-nowrap">
                        <div className="inline-flex items-center gap-2">
                          <span className="tabular-nums text-ink">{formatClockRange(s.startTime, s.endTime)}</span>
                          {isOvernight(s) && (
                            <span
                              className="inline-flex items-center gap-1 h-5 px-1.5 rounded-full bg-due-bg text-due ring-1 ring-inset ring-due-line text-[12.5px] font-medium"
                              title="Ends the next day"
                            >
                              <Moon className="w-3 h-3" aria-hidden />
                              Overnight
                            </span>
                          )}
                        </div>
                      </td>
                      {/* Repeats the time column as a picture, so phones leave it out. */}
                      <td data-empty="">
                        <DayBar start={s.startTime} end={s.endTime} />
                      </td>
                      <td className="num text-ink-secondary whitespace-nowrap">{durationLabel(shiftLength(s.startTime, s.endTime))}</td>
                      <td className="whitespace-nowrap" data-label="Break">
                        {s.breakStartTime && s.breakEndTime ? (
                          <span className="inline-flex items-center gap-1.5 tabular-nums text-ink">
                            <Coffee className="w-3.5 h-3.5 text-ink-muted" aria-hidden />
                            {formatClockRange(s.breakStartTime, s.breakEndTime)}
                            <span className="text-ink-muted">· {span(s.breakStartTime, s.breakEndTime)} min</span>
                          </span>
                        ) : (
                          <span className="text-ink-muted">No break</span>
                        )}
                      </td>
                      <td className="num text-ink-secondary whitespace-nowrap">{s.graceMinutes} min</td>
                      <td className="whitespace-nowrap">
                        <StatusBadge status={s.isActive ? 'ACTIVE' : 'INACTIVE'} size="sm" />
                      </td>
                      {canWrite && (
                        <td className="text-right whitespace-nowrap" data-label="">
                          <div className="inline-flex items-center gap-0.5">
                            {canEdit && (<IconButton label={`Edit ${s.name}`} onClick={() => openEdit(s)}>
                              <Pencil className="w-3.5 h-3.5" />
                            </IconButton>)}
                            {canDelete && (<IconButton label={`Delete ${s.name}`} tone="danger" onClick={() => setDeleting(s)}>
                              <Trash2 className="w-3.5 h-3.5" />
                            </IconButton>)}
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </DataState>

      {/* Shift Sign-In and Company Wi-Fi have their own permissions (Roles & Permissions). */}
      {can('shift_signin') && <ShiftLoginSettingsCard canEdit={can('shift_signin', 'edit')} />}

      <WorkerBreaksCard />

      {can('wifi_rule') && <WifiRuleCard />}

      <Modal
        isOpen={editing !== null}
        onClose={close}
        title={editing === 'new' ? 'Add Shift' : 'Edit Shift'}
        subtitle="Hours and break, in plant time"
        footer={
          <>
            <Button size="sm" variant="outline" onClick={close} disabled={saving}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" type="submit" form="shift-form" loading={saving}>
              {editing === 'new' ? 'Create Shift' : 'Save Changes'}
            </Button>
          </>
        }
      >
        <form id="shift-form" onSubmit={submit} className="space-y-3">
          <FormError message={formError} />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Name" required>
              <TextInput value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Shift A" maxLength={100} autoFocus />
            </Field>
            <Field label="Code" required>
              <TextInput value={form.code} onChange={(e) => set('code', e.target.value)} placeholder="e.g. A" maxLength={30} className="font-mono" />
            </Field>
            <Field label="Start time" required>
              <TimeInput label="Start time" value={form.startTime} onChange={(v) => set('startTime', v)} />
            </Field>
            <Field label="End time" required>
              <TimeInput label="End time" value={form.endTime} onChange={(v) => set('endTime', v)} />
            </Field>
          </div>
          {formValid && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2 rounded-md border border-line bg-subtle text-[13.5px] text-ink-secondary" aria-live="polite">
              <span className="inline-flex items-center gap-1.5">
                {isOvernight(form) ? <Moon className="w-3.5 h-3.5 text-due" aria-hidden /> : <Clock3 className="w-3.5 h-3.5 text-ink-muted" aria-hidden />}
                <span>
                  <span className="font-semibold text-ink">{durationLabel(shiftLength(form.startTime, form.endTime))}</span> shift
                  {isOvernight(form) && ' — overnight: ends the next day, which is allowed.'}
                </span>
              </span>
              <span className="ml-auto">
                <DayBar start={form.startTime} end={form.endTime} />
              </span>
            </div>
          )}
          <BreakFields form={form} setForm={setForm} />
          <Field label="Grace period (minutes)" hint="Minutes a check stays open after its scheduled time before it is marked Missed.">
            <input
              type="number"
              min={0}
              max={240}
              step={1}
              value={form.graceMinutes}
              onChange={(e) => set('graceMinutes', e.target.value)}
              className={inputClass}
            />
          </Field>
          <Toggle checked={form.isActive} disabled={!canActivate} onChange={(v) => set('isActive', v)} label="Active" description={canActivate ? 'Inactive shifts generate no scheduled checks.' : ACTIVATION_HINT} />
          {editing !== 'new' && <p className="text-[12.5px] text-ink-muted">Changing shift times replaces upcoming checks for this shift; completed history is kept.</p>}
        </form>
      </Modal>

      <ConfirmModal
        isOpen={deleting !== null}
        title="Delete shift"
        danger
        confirmLabel="Delete"
        message={
          <>
            Delete <span className="font-semibold text-ink">{deleting?.name}</span>? Its upcoming checks are removed. If schedules, users or
            check history still reference it, it will be marked inactive instead.
          </>
        }
        onConfirm={remove}
        onClose={() => setDeleting(null)}
      />
    </div>
  )
}
