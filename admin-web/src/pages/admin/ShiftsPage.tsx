import React, { useMemo, useState } from 'react'
import { Clock3, Moon, Pencil, Plus, Trash2 } from 'lucide-react'
import type { Shift } from '../../types'
import { api, errorText } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { useCanManage } from '../../lib/auth'
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

interface FormState {
  name: string
  code: string
  startTime: string
  endTime: string
  graceMinutes: string
  isActive: boolean
}

const emptyForm: FormState = { name: '', code: '', startTime: '08:00', endTime: '16:00', graceMinutes: '15', isActive: true }

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

export const ShiftsPage: React.FC = () => {
  const canEdit = useCanManage('shifts')
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
      isActive: s.isActive
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

    setSaving(true)
    setFormError(null)
    try {
      const body = {
        name: form.name.trim(),
        code: form.code.trim(),
        startTime: form.startTime,
        endTime: form.endTime,
        graceMinutes: grace,
        isActive: form.isActive
      }
      if (editing === 'new') {
        await api.post('/api/shifts', body)
        notify('success', 'Shift created', body.name)
      } else if (editing) {
        await api.put(`/api/shifts/${editing.id}`, body)
        notify('success', 'Shift updated', `${body.name}. Upcoming checks for this shift will be regenerated.`)
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
          canEdit && (
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
                shifts.length === 0 && canEdit ? (
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
                    <th className="num">Grace</th>
                    <th>Status</th>
                    {canEdit && (
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
                              className="inline-flex items-center gap-1 h-5 px-1.5 rounded-full bg-due-bg text-due ring-1 ring-inset ring-due-line text-[11px] font-medium"
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
                      <td className="num text-ink-secondary whitespace-nowrap">{s.graceMinutes} min</td>
                      <td className="whitespace-nowrap">
                        <StatusBadge status={s.isActive ? 'ACTIVE' : 'INACTIVE'} size="sm" />
                      </td>
                      {canEdit && (
                        <td className="text-right whitespace-nowrap" data-label="">
                          <div className="inline-flex items-center gap-0.5">
                            <IconButton label={`Edit ${s.name}`} onClick={() => openEdit(s)}>
                              <Pencil className="w-3.5 h-3.5" />
                            </IconButton>
                            <IconButton label={`Delete ${s.name}`} tone="danger" onClick={() => setDeleting(s)}>
                              <Trash2 className="w-3.5 h-3.5" />
                            </IconButton>
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

      <ShiftLoginSettingsCard canEdit={canEdit} />

      <WorkerBreaksCard canEdit={canEdit} />

      <Modal
        isOpen={editing !== null}
        onClose={close}
        title={editing === 'new' ? 'Add Shift' : 'Edit Shift'}
        subtitle="Start and end times in plant time"
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
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2 rounded-md border border-line bg-subtle text-[12px] text-ink-secondary" aria-live="polite">
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
          <Toggle checked={form.isActive} onChange={(v) => set('isActive', v)} label="Active" description="Inactive shifts generate no scheduled checks." />
          {editing !== 'new' && <p className="text-[11px] text-ink-muted">Changing shift times replaces upcoming checks for this shift; completed history is kept.</p>}
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
