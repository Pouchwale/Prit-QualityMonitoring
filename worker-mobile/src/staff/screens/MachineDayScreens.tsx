import React, { useEffect, useMemo, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import type { Machine, MachineDayPlan } from '../types'
import { api } from '../../services/api'
import { useStaff } from '../nav'
import { useQuery, errorText } from '../useQuery'
import { dateKey } from '../format'
import { AccessDenied, DataState, FormError, FormSection, Icon, Input, List, Notice, PrimaryButton, Screen, SearchField, SmallButton, confirm, useToast } from '../ui'
import { ActionGroup, ActionItem } from './adminParts'
import { formatDate, formatLongDate } from '../../utils/datetime'

const longDate = (key: string) => formatLongDate(key)
const shortDate = (key: string) => formatDate(key)
const machinesText = (n: number) => `${n} machine${n === 1 ? '' : 's'}`
const removedText = (n: number) => (n > 0 ? ` ${n} open check${n === 1 ? '' : 's'} removed for machines that are not running.` : '')

/** One machine of the checklist: the whole row is the checkbox (44px+ touch target). */
const MachineCheck: React.FC<{ machine: Machine; checked: boolean; disabled?: boolean; onToggle: () => void }> = ({ machine, checked, disabled, onToggle }) => (
  <Pressable
    onPress={onToggle}
    disabled={disabled}
    accessibilityRole="checkbox"
    accessibilityLabel={machine.name}
    accessibilityHint={checked ? 'Runs on this day' : 'Off on this day'}
    accessibilityState={{ checked, disabled: !!disabled }}
    aria-checked={checked}
    aria-disabled={!!disabled}
    className="min-h-[56px] flex-row items-center gap-3 px-4 py-2.5 active:bg-staff-fill"
  >
    <Icon name={checked ? 'checkmark-circle' : 'ellipse-outline'} size={24} color={checked ? 'accent' : 'faint'} />
    <View className="flex-1">
      <Text className="text-[16px] font-semibold leading-[21px] text-staff-ink" numberOfLines={1}>
        {machine.name}
      </Text>
      <Text className="mt-0.5 text-[13px] leading-[18px] text-staff-muted" numberOfLines={1}>
        {[machine.code, machine.departmentName, machine.line].filter(Boolean).join(' · ')}
      </Text>
    </View>
    <Text className={`text-[13px] font-semibold ${checked ? 'text-staff-accent' : 'text-staff-muted'}`}>{checked ? 'ON' : 'OFF'}</Text>
  </Pressable>
)

/**
 * Chooses which machines run on one date. With a plan exactly the ticked machines run (even on a
 * closed day); "Reset to default" removes the plan so the plant calendar decides again.
 */
export const MachineDayPlanScreen: React.FC<{ params: { date: string; closed?: boolean } }> = ({ params }) => {
  const { can, pop } = useStaff()
  const notify = useToast()
  const date = params.date
  const today = dateKey()
  const past = date < today
  const canEdit = can('calendar', 'manage') && !past

  const machinesApi = useQuery<Machine[]>('/api/machines')
  const planApi = useQuery<MachineDayPlan[]>('/api/machine-days', { from: date, to: date })
  const plan = (planApi.data ?? []).find((p) => p.date === date) ?? null
  const active = useMemo(() => (machinesApi.data ?? []).filter((m) => m.isActive).sort((a, b) => a.name.localeCompare(b.name)), [machinesApi.data])

  const [chosen, setChosen] = useState<Set<string> | null>(null)
  const [note, setNote] = useState('')
  const [search, setSearch] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Start from the saved plan, or from the default: every machine on an open day, none on a closed day.
  useEffect(() => {
    if (chosen || !machinesApi.data || !planApi.data) return
    setChosen(new Set(plan ? plan.machineIds : params.closed ? [] : active.map((m) => m.id)))
    setNote(plan?.note ?? '')
  }, [machinesApi.data, planApi.data, plan, active, chosen, params.closed])

  const selected = chosen ?? new Set<string>()
  const selectedActive = active.filter((m) => selected.has(m.id))
  const q = search.trim().toLowerCase()
  const shown = q ? active.filter((m) => [m.name, m.code, m.departmentName ?? '', m.line ?? ''].some((v) => v.toLowerCase().includes(q))) : active

  const toggle = (id: string) => {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setChosen(next)
  }
  const setMany = (ids: string[], on: boolean) => {
    const next = new Set(selected)
    for (const id of ids) {
      if (on) next.add(id)
      else next.delete(id)
    }
    setChosen(next)
  }

  const save = async () => {
    setError(null)
    setSaving(true)
    try {
      const machineIds = selectedActive.map((m) => m.id)
      const result = await api.put<{ plan: MachineDayPlan; removedChecks: number }>(`/api/machine-days/${date}`, { machineIds, note: note.trim() || null })
      notify(
        'success',
        `Machines saved for ${shortDate(date)}`,
        `${machineIds.length} of ${machinesText(active.length)} running.${removedText(result.removedChecks)}`
      )
      pop()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  const reset = async () => {
    const ok = await confirm(
      'Reset to default?',
      `The machine plan for ${longDate(date)} is removed. The plant calendar decides again: ${
        params.closed ? 'the plant is closed on this day, so no machines run.' : 'all machines run as scheduled.'
      }`,
      'Reset',
      true
    )
    if (!ok) return
    try {
      const result = await api.del<{ removed: boolean; removedChecks: number }>(`/api/machine-days/${date}`)
      notify('success', `${shortDate(date)} reset to default`, `The plant calendar decides which machines run.${removedText(result.removedChecks ?? 0)}`)
      pop()
    } catch (err) {
      notify('error', 'Could not reset the machine plan', errorText(err))
    }
  }

  if (!can('calendar', 'manage')) {
    return (
      <Screen title="Machines running" subtitle={longDate(date)}>
        <AccessDenied title="You can view the Plant Calendar but not change which machines run." />
      </Screen>
    )
  }

  const loading = machinesApi.loading || planApi.loading
  const loadError = machinesApi.error ?? planApi.error

  return (
    <Screen
      title={plan ? 'Edit machines' : 'Choose machines'}
      subtitle={longDate(date)}
      footer={canEdit ? <PrimaryButton label="Save machines" onPress={save} loading={saving} disabled={!chosen || !machinesApi.data} /> : null}
    >
      <FormError message={error} />

      {past ? <Notice tone="neutral" icon="lock-closed-outline" message="Past dates cannot be changed. Choose today or a later date." /> : null}

      <DataState
        loading={loading && !chosen}
        error={chosen ? null : loadError}
        onRetry={() => {
          machinesApi.reload()
          planApi.reload()
        }}
        hasData={!!chosen}
        empty={!!chosen && active.length === 0}
        emptyText="No active machines."
        emptyIcon="hardware-chip-outline"
      >
        <View className="gap-3">
          <Text className="px-1 text-[14px] leading-[19px] text-staff-ink2" accessibilityLiveRegion="polite">
            {`${selectedActive.length} of ${machinesText(active.length)} running`}
            {plan ? ' · custom plan' : ' · not saved yet'}
          </Text>
          <SearchField value={search} onChangeText={setSearch} placeholder="Search machines" />
          {canEdit ? (
            <View className="flex-row gap-2">
              <SmallButton
                label="Select all"
                icon="checkmark-done-outline"
                tone="tinted"
                onPress={() => setMany(shown.map((m) => m.id), true)}
                disabled={shown.every((m) => selected.has(m.id))}
                className="flex-1"
              />
              <SmallButton label="Clear" icon="close-outline" onPress={() => setMany(shown.map((m) => m.id), false)} disabled={!shown.some((m) => selected.has(m.id))} className="flex-1" />
            </View>
          ) : null}
          {shown.length ? (
            <List>
              {shown.map((m) => (
                <MachineCheck key={m.id} machine={m} checked={selected.has(m.id)} disabled={!canEdit} onToggle={() => toggle(m.id)} />
              ))}
            </List>
          ) : (
            <Text className="px-1 text-[14px] text-staff-muted">No machines match “{search}”.</Text>
          )}
          {chosen && selectedActive.length === 0 ? (
            <Notice tone="exception" message="No machine runs on this day: no checks are scheduled and no reminders are sent." />
          ) : null}
        </View>
      </DataState>

      {chosen ? (
        <FormSection title="Note">
          <Input label="Note" hint="Optional · e.g. why these machines run" value={note} onChangeText={setNote} maxLength={200} editable={canEdit} placeholder="e.g. Extra production run" />
        </FormSection>
      ) : null}

      <Text className="px-1 text-[13px] leading-[18px] text-staff-muted">
        Only the machines that are ON get checks and reminders on this day, even on a weekly off or holiday. Machines that are OFF get no checks and no notifications.
      </Text>

      {canEdit && plan ? (
        <ActionGroup>
          <ActionItem label="Reset to default" tone="danger" icon="refresh-outline" description="Remove this plan; the plant calendar decides again" onPress={reset} />
        </ActionGroup>
      ) : null}
    </Screen>
  )
}

export const MACHINE_DAY_SCREENS = {
  machineDayPlan: MachineDayPlanScreen
}
