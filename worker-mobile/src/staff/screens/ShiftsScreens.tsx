import React, { useState } from 'react'
import { Text, View } from 'react-native'
import type { Shift } from '../types'
import { api } from '../../services/api'
import { useStaff } from '../nav'
import { useQuery, errorText } from '../useQuery'
import { Badge, DataState, FormError, FormSection, Input, List, PrimaryButton, Row, Screen, ToggleField, confirm, useToast } from '../ui'
import { ActionGroup, ActionItem, facts } from './adminParts'

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

/** Formats typed digits as HH:MM (e.g. "0830" → "08:30") so a number pad is enough. */
const typeTime = (text: string) => {
  const digits = text.replace(/\D/g, '').slice(0, 4)
  return digits.length > 2 ? `${digits.slice(0, 2)}:${digits.slice(2)}` : digits
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
                `${s.startTime}–${s.endTime}${isOvernight(s) ? ' (next day)' : ''}`,
                durationLabel(shiftLength(s.startTime, s.endTime)),
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
          isActive: editing.isActive
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
    if (!HHMM.test(form.startTime) || !HHMM.test(form.endTime)) return setFormError('Enter start and end times in 24-hour format, e.g. 08:00')
    if (form.startTime === form.endTime) return setFormError('Start and end time cannot be the same')
    if (form.graceMinutes.trim() === '' || !Number.isInteger(grace) || grace < 0 || grace > 240) {
      return setFormError('Grace period must be a whole number between 0 and 240 minutes')
    }

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
  const timeError = (v: string) => (v.length >= 5 && !HHMM.test(v) ? 'Use 24-hour HH:MM, e.g. 08:00' : null)

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

      <FormSection title="Hours" description="Times use the 24-hour clock of the plant server">
        <Input
          label="Start time"
          required
          value={form.startTime}
          onChangeText={(v) => set('startTime', typeTime(v))}
          placeholder="HH:MM"
          keyboardType="number-pad"
          maxLength={5}
          error={timeError(form.startTime)}
        />
        <Input
          label="End time"
          required
          value={form.endTime}
          onChangeText={(v) => set('endTime', typeTime(v))}
          placeholder="HH:MM"
          keyboardType="number-pad"
          maxLength={5}
          error={timeError(form.endTime)}
        />
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
