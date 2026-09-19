import React, { useState } from 'react'
import { Edit2, Moon, Plus, Trash2 } from 'lucide-react'
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
import { formatClock } from '../../lib/format'
import { TimeInput } from '../../components/common/DateTimeInputs'

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

export const ShiftsPage: React.FC = () => {
  const canEdit = useCanManage('shifts')
  const notify = useToast()
  const { data, error, loading, reload } = useApi<Shift[]>('/api/shifts')

  const [editing, setEditing] = useState<Shift | 'new' | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm)
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState<Shift | null>(null)

  const shifts = data ?? []
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
    <div className="space-y-4">
      <PageHeader
        title="Shifts"
        description="Working shifts define when scheduled quality checks are generated"
        actions={
          canEdit && (
            <Button size="sm" variant="primary" onClick={openNew} icon={<Plus className="w-3.5 h-3.5" />}>
              Add Shift
            </Button>
          )
        }
      />

      <DataState loading={loading} error={error} onRetry={reload} empty={!loading && shifts.length === 0} emptyText="No shifts yet">
        <div className="bg-white border border-line rounded-md shadow-2xs overflow-x-auto">
          <table className="stack-sm w-full text-left text-xs border-collapse">
            <thead className="bg-slate-50 border-b border-line text-ink-secondary font-mono text-[11px] uppercase tracking-wider">
              <tr>
                <th className="py-2.5 px-3.5">Shift</th>
                <th className="py-2.5 px-3.5">Code</th>
                <th className="py-2.5 px-3.5">Start</th>
                <th className="py-2.5 px-3.5">End</th>
                <th className="py-2.5 px-3.5">Duration</th>
                <th className="py-2.5 px-3.5">Grace</th>
                <th className="py-2.5 px-3.5">Status</th>
                {canEdit && <th className="py-2.5 px-3.5 text-right">Action</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {shifts.map((s) => (
                <tr key={s.id} className="hover:bg-slate-50 transition-colors">
                  <td className="py-2.5 px-3.5 font-semibold text-ink whitespace-nowrap">{s.name}</td>
                  <td className="py-2.5 px-3.5 font-mono text-ink-secondary whitespace-nowrap">{s.code}</td>
                  <td className="py-2.5 px-3.5 font-mono text-ink whitespace-nowrap">{formatClock(s.startTime)}</td>
                  <td className="py-2.5 px-3.5 font-mono text-ink whitespace-nowrap">
                    {formatClock(s.endTime)}
                    {isOvernight(s) && (
                      <span className="ml-1.5 inline-flex items-center gap-1 font-sans text-[11px] lg:text-[10px] text-ink-muted" title="Ends the next day">
                        <Moon className="w-3 h-3" />
                        next day
                      </span>
                    )}
                  </td>
                  <td className="py-2.5 px-3.5 text-ink-secondary whitespace-nowrap">{durationLabel(shiftLength(s.startTime, s.endTime))}</td>
                  <td className="py-2.5 px-3.5 text-ink-secondary whitespace-nowrap">{s.graceMinutes} min</td>
                  <td className="py-2.5 px-3.5 whitespace-nowrap">
                    <StatusBadge status={s.isActive ? 'ACTIVE' : 'INACTIVE'} size="sm" />
                  </td>
                  {canEdit && (
                    <td className="py-2 px-3.5 text-right whitespace-nowrap">
                      <div className="inline-flex gap-1.5">
                        <Button size="sm" variant="outline" onClick={() => openEdit(s)} icon={<Edit2 className="w-3 h-3 text-ink-muted" />}>
                          Edit
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setDeleting(s)} title="Delete" aria-label={`Delete ${s.name}`} icon={<Trash2 className="w-3.5 h-3.5 text-failed" />} />
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </DataState>

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
            <div className="px-3 py-2 rounded border border-line bg-subtle text-[11px] text-ink-secondary">
              {durationLabel(shiftLength(form.startTime, form.endTime))} shift
              {isOvernight(form) && ' — overnight: ends the next day, which is allowed.'}
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
