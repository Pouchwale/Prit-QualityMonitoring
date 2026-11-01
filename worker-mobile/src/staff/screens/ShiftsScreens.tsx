import React, { useState } from 'react'
import { Text, View } from 'react-native'
import type { Shift } from '../types'
import { api } from '../../services/api'
import { useStaff } from '../nav'
import { useQuery, errorText } from '../useQuery'
import { Badge, DataState, FormError, FormSection, Input, List, PrimaryButton, Row, Screen, Segmented, TimeField, ToggleField, confirm, useToast } from '../ui'
import { ActionGroup, ActionItem, facts } from './adminParts'
import { formatClockRange } from '../../utils/datetime'

interface FormState {
  name: string
  code: string
  startTime: string
  endTime: string
  graceMinutes: string
  isActive: boolean
  /** The break question: '' until answered (a new shift must answer it). */
  breakMode: 'set' | 'none' | ''
  breakStart: string
  breakEnd: string
}

const emptyForm: FormState = { name: '', code: '', startTime: '08:00', endTime: '16:00', graceMinutes: '15', isActive: true, breakMode: '', breakStart: '12:00', breakEnd: '12:30' }

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
  if (f.breakMode === '') return 'Set the break time of this shift, or choose "No break".'
  if (f.breakMode === 'none') return null
  if (!HHMM.test(f.breakStart) || !HHMM.test(f.breakEnd)) return 'Choose the break start and end.'
  if (f.breakStart === f.breakEnd) return 'The break must end after it starts.'
  const length = span(f.breakStart, f.breakEnd)
  if (length > 240) return 'A break can be at most 4 hours.'
  const offset = (toMinutes(f.breakStart) - toMinutes(f.startTime) + 1440) % 1440
  if (offset + length > shiftLength(f.startTime, f.endTime)) return "The break must be inside the shift's hours. Change the break or the shift times."
  return null
}

/** Shifts: working shifts define when scheduled quality checks are generated. */
export const ShiftsScreen: React.FC<{ params: Record<string, unknown> }> = () => {
  const { can, push } = useStaff()
  const canEdit = can('shifts', 'manage')
  const { data, error, loading, reload } = useQuery<Shift[]>('/api/shifts')
  const shifts = data ?? []

  return (
    <Screen title="Shifts" onRefresh={reload} refreshing={loading && !!data} right={canEdit ? { label: 'Add', icon: 'add', onPress: () => push('shiftForm', {}) } : null}>
      <DataState loading={loading} error={error} onRetry={reload} hasData={!!data} empty={!!data && shifts.length === 0} emptyText="No shifts yet" emptyIcon="time-outline">
        <List>
          {shifts.map((s) => (
            <Row
              key={s.id}
              title={s.name}
              titleClassName={s.isActive ? '' : 'text-staff-muted'}
              subtitle={facts(
                `${formatClockRange(s.startTime, s.endTime)}${isOvernight(s) ? ' (next day)' : ''}`,
                durationLabel(shiftLength(s.startTime, s.endTime)),
                s.breakStartTime && s.breakEndTime ? `Break ${formatClockRange(s.breakStartTime, s.breakEndTime)}` : 'No break',
                `Code ${s.code}`,
                `Grace ${s.graceMinutes} min`
              )}
              right={s.isActive ? undefined : <Badge label="Inactive" tone="neutral" />}
              onPress={canEdit ? () => push('shiftForm', { shift: s }) : undefined}
              accessibilityLabel={canEdit ? `Edit ${s.name}` : undefined}
            />
          ))}
        </List>
      </DataState>
    </Screen>
  )
}

/** Add or edit a shift; editing also offers Delete (in-use shifts are disabled instead). */
export const ShiftFormScreen: React.FC<{ params: { shift?: Shift } }> = ({ params }) => {
  const { can, pop } = useStaff()
  const notify = useToast()
  const canEdit = can('shifts', 'manage')
  const editing = params.shift ?? null
  const [form, setForm] = useState<FormState>(() =>
    editing
      ? {
          name: editing.name,
          code: editing.code,
          startTime: editing.startTime,
          endTime: editing.endTime,
          graceMinutes: String(editing.graceMinutes),
          isActive: editing.isActive,
          // A shift without a break is asked again: set one, or confirm "No break".
          breakMode: editing.breakStartTime && editing.breakEndTime ? 'set' : '',
          breakStart: editing.breakStartTime ?? '12:00',
          breakEnd: editing.breakEndTime ?? '12:30'
        }
      : emptyForm
  )
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }))

  const submit = async () => {
    const grace = Number(form.graceMinutes)
    if (!form.name.trim() || !form.code.trim()) return setFormError('Name and code are required')
    if (!HHMM.test(form.startTime) || !HHMM.test(form.endTime)) return setFormError('Choose a start and an end time')
    if (form.startTime === form.endTime) return setFormError('Start and end time cannot be the same')
    if (form.graceMinutes.trim() === '' || !Number.isInteger(grace) || grace < 0 || grace > 240) {
      return setFormError('Grace period must be a whole number between 0 and 240 minutes')
    }
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
      if (!editing) {
        await api.post('/api/shifts', body)
        notify('success', 'Shift created', body.name)
      } else {
        await api.put(`/api/shifts/${editing.id}`, body)
        notify('success', 'Shift updated', `${body.name}. Upcoming checks for this shift will be regenerated.`)
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
      'Delete shift',
      `Delete ${editing.name}? Its upcoming checks are removed. If schedules, users or check history still reference it, it will be marked inactive instead.`,
      'Delete',
      true
    )
    if (!ok) return
    setDeleting(true)
    try {
      const { result } = await api.del(`/api/shifts/${editing.id}`)
      if (result === 'disabled') {
        notify('warning', 'Shift disabled', `${editing.name} is in use by schedules, users or check history, so it was marked inactive instead of deleted.`)
      } else {
        notify('success', 'Shift deleted', editing.name)
      }
      pop()
    } catch (err) {
      notify('error', 'Could not delete shift', errorText(err))
    } finally {
      setDeleting(false)
    }
  }

  const formValid = HHMM.test(form.startTime) && HHMM.test(form.endTime) && form.startTime !== form.endTime
  const breakIssue = form.breakMode === 'set' ? breakProblem(form) : null
  const chooseBreak = (mode: 'set' | 'none') =>
    setForm((f) => {
      if (mode === 'none' || f.breakMode === 'set') return { ...f, breakMode: mode }
      // First time: suggest 30 minutes, 4 hours into the shift (or halfway through a short one).
      const breakStart = toHHMM(toMinutes(f.startTime) + Math.min(240, Math.floor(shiftLength(f.startTime, f.endTime) / 2)))
      return { ...f, breakMode: 'set', breakStart, breakEnd: toHHMM(toMinutes(breakStart) + 30) }
    })

  return (
    <Screen
      title={editing ? 'Edit Shift' : 'Add Shift'}
      subtitle={editing?.name}
      footer={canEdit ? <PrimaryButton label={editing ? 'Save changes' : 'Create shift'} onPress={submit} loading={saving} disabled={deleting} /> : undefined}
    >
      <FormError message={formError} />
      <FormSection title="Details">
        <Input label="Name" required value={form.name} onChangeText={(v) => set('name', v)} placeholder="e.g. Shift A" maxLength={100} />
        <Input label="Code" required value={form.code} onChangeText={(v) => set('code', v)} placeholder="e.g. A" maxLength={30} autoCapitalize="characters" />
      </FormSection>

      <FormSection title="Hours" description="Plant time">
        <TimeField label="Start time" required value={form.startTime} onChange={(v) => set('startTime', v)} />
        <TimeField label="End time" required value={form.endTime} onChange={(v) => set('endTime', v)} />
        {formValid ? (
          <View className="rounded-xl bg-staff-fill px-3.5 py-2.5">
            <Text className="text-[14px] leading-[19px] text-staff-ink2">
              {durationLabel(shiftLength(form.startTime, form.endTime))} shift
              {isOvernight(form) ? ' — overnight: ends the next day, which is allowed.' : ''}
            </Text>
          </View>
        ) : null}
        <Input
          label="Grace period (minutes)"
          hint="Minutes a check stays open after its scheduled time before it is marked Missed."
          value={form.graceMinutes}
          onChangeText={(v) => set('graceMinutes', v.replace(/\D/g, ''))}
          keyboardType="number-pad"
          maxLength={3}
        />
        {editing ? <Text className="text-[13px] leading-[18px] text-staff-muted">Changing shift times replaces upcoming checks for this shift; completed history is kept.</Text> : null}
      </FormSection>

      <FormSection title="Break time" description="Every worker on this shift gets this break. Moving a worker to another shift gives them that shift's break.">
        <Segmented<'set' | 'none' | ''>
          options={[
            { value: 'set', label: 'Set a break time' },
            { value: 'none', label: 'No break' }
          ]}
          value={form.breakMode}
          onChange={(v) => v && chooseBreak(v)}
        />
        {form.breakMode === '' ? <Text className="text-[13px] leading-[18px] text-due">Required: choose a break time, or No break.</Text> : null}
        {form.breakMode === 'set' ? (
          <>
            <TimeField
              label="Break start"
              required
              value={form.breakStart}
              onChange={(v) => setForm((f) => ({ ...f, breakStart: v, breakEnd: toHHMM(toMinutes(v) + span(f.breakStart, f.breakEnd)) }))}
            />
            <TimeField label="Break end" required value={form.breakEnd} onChange={(v) => set('breakEnd', v)} />
            <Text className={`text-[13px] leading-[18px] ${breakIssue ? 'text-missed' : 'text-staff-muted'}`}>
              {breakIssue ?? `${span(form.breakStart, form.breakEnd)} min break. No check notifications and no Missed checks during it.`}
            </Text>
          </>
        ) : null}
      </FormSection>

      <FormSection title="Status">
        <ToggleField label="Active" description="Inactive shifts generate no scheduled checks." value={form.isActive} onChange={(v) => set('isActive', v)} disabled={!canEdit} />
      </FormSection>

      {canEdit && editing ? (
        <ActionGroup>
          <ActionItem
            label={deleting ? 'Deleting…' : 'Delete shift'}
            accessibilityLabel="Delete shift"
            description="Shifts still in use are marked inactive instead."
            tone="danger"
            onPress={remove}
            disabled={deleting || saving}
          />
        </ActionGroup>
      ) : null}
    </Screen>
  )
}

export const SHIFTS_SCREENS = {
  shifts: ShiftsScreen,
  shiftForm: ShiftFormScreen
}
