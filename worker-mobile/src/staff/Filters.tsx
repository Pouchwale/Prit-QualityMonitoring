import React, { useState } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'
import type { Activity, Department, Machine, Shift, User } from './types'
import { useQuery } from './useQuery'
import { addDaysKey, dateKey, formatKey } from './format'
import { Icon } from './Icon'
import { DateField, PrimaryButton, SelectField, Sheet, SmallButton, type Option } from './ui'

/** Filters shared by the monitoring screens, the same as the web panel's FilterBar. Empty string = all. */
export interface MonitoringFilters {
  from: string
  to: string
  shiftId: string
  machineId: string
  workerId: string
  activityId: string
  departmentId: string
  status: string
}

export type FilterField = 'shift' | 'machine' | 'worker' | 'activity' | 'department' | 'status'

export const todayFilters = (days = 1): MonitoringFilters => {
  const today = dateKey()
  return { from: addDaysKey(today, -(days - 1)), to: today, shiftId: '', machineId: '', workerId: '', activityId: '', departmentId: '', status: '' }
}

export const filterQuery = (f: MonitoringFilters) => ({
  from: f.from,
  to: f.to,
  shiftId: f.shiftId,
  machineId: f.machineId,
  workerId: f.workerId,
  activityId: f.activityId,
  departmentId: f.departmentId
})

interface Props {
  value: MonitoringFilters
  onChange: (value: MonitoringFilters) => void
  onReset: () => void
  fields: FilterField[]
  statusOptions?: Option[]
  statusLabel?: string
  presets?: { label: string; range: () => { from: string; to: string } }[]
}

const DEFAULT_PRESETS = [
  { label: 'Today', range: () => ({ from: dateKey(), to: dateKey() }) },
  { label: '7 days', range: () => ({ from: addDaysKey(dateKey(), -6), to: dateKey() }) },
  { label: '30 days', range: () => ({ from: addDaysKey(dateKey(), -29), to: dateKey() }) }
]

const NO_FIELDS = { shiftId: '', machineId: '', workerId: '', activityId: '', departmentId: '', status: '' }

/** A small preset chip: accent fill when chosen, white otherwise. */
const Chip: React.FC<{ label: string; on: boolean; onPress: () => void; icon?: boolean }> = ({ label, on, onPress, icon }) => (
  <Pressable
    onPress={onPress}
    accessibilityRole="button"
    accessibilityLabel={label}
    accessibilityState={{ selected: on }} aria-selected={on}
    hitSlop={{ top: 4, bottom: 4 }}
    className={`h-10 flex-row items-center gap-1.5 rounded-full px-3.5 ${on ? 'bg-staff-primary' : 'bg-staff-card active:bg-staff-fill'}`}
  >
    {icon ? <Icon name="calendar-outline" size={15} color={on ? 'white' : 'accent'} /> : null}
    <Text className={`text-[14px] ${on ? 'font-semibold text-white' : 'font-medium text-staff-ink'}`}>{label}</Text>
  </Pressable>
)

/**
 * Compact filter bar: quick date presets, a "Filters" button that opens a sheet with the date range
 * and the chosen fields, and the active filters as removable chips.
 */
export const FilterPanel: React.FC<Props> = ({ value, onChange, onReset, fields, statusOptions = [], statusLabel = 'Status', presets = DEFAULT_PRESETS }) => {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<MonitoringFilters>(value)
  const [opened, setOpened] = useState(false)
  const has = (f: FilterField) => fields.includes(f)
  // Option lists load once: when the sheet is first opened, or when a filter already has a value (for its chip label).
  const want = (f: FilterField, current: string) => has(f) && (opened || !!current)
  const shifts = useQuery<Shift[]>(want('shift', value.shiftId) ? '/api/shifts' : null)
  const machines = useQuery<Machine[]>(want('machine', value.machineId) ? '/api/machines' : null)
  const workers = useQuery<User[]>(want('worker', value.workerId) ? '/api/users' : null, { role: 'WORKER' })
  const activities = useQuery<Activity[]>(want('activity', value.activityId) ? '/api/activities' : null)
  const departments = useQuery<Department[]>(want('department', value.departmentId) ? '/api/departments' : null)

  const set = (patch: Partial<MonitoringFilters>) => onChange({ ...value, ...patch })
  const setDraftPart = (patch: Partial<MonitoringFilters>) => setDraft((d) => ({ ...d, ...patch }))
  const openSheet = () => {
    setDraft(value)
    setOpened(true)
    setOpen(true)
  }

  const period = value.from === value.to ? formatKey(value.from) : `${formatKey(value.from)} – ${formatKey(value.to)}`
  const presetOn = presets.some((p) => {
    const r = p.range()
    return r.from === value.from && r.to === value.to
  })

  const nameOf = <T extends { id: string; name: string }>(list: T[] | null, id: string) => list?.find((x) => x.id === id)?.name
  const chips: { key: string; label: string; clear: Partial<MonitoringFilters> }[] = []
  if (has('status') && value.status) chips.push({ key: 'status', label: statusOptions.find((o) => o.value === value.status)?.label ?? statusLabel, clear: { status: '' } })
  if (has('machine') && value.machineId) chips.push({ key: 'machine', label: nameOf(machines.data, value.machineId) ?? 'Machine', clear: { machineId: '' } })
  if (has('worker') && value.workerId) chips.push({ key: 'worker', label: nameOf(workers.data, value.workerId) ?? 'Worker', clear: { workerId: '' } })
  if (has('activity') && value.activityId) chips.push({ key: 'activity', label: nameOf(activities.data, value.activityId) ?? 'Check type', clear: { activityId: '' } })
  if (has('shift') && value.shiftId) chips.push({ key: 'shift', label: nameOf(shifts.data, value.shiftId) ?? 'Shift', clear: { shiftId: '' } })
  if (has('department') && value.departmentId) chips.push({ key: 'department', label: nameOf(departments.data, value.departmentId) ?? 'Department', clear: { departmentId: '' } })
  const active = chips.length

  return (
    <View className="gap-2">
      <View className="flex-row items-center gap-3">
        <ScrollView horizontal showsHorizontalScrollIndicator={false} className="flex-1" contentContainerClassName="gap-2 pr-1">
          {presets.map((p) => {
            const r = p.range()
            return <Chip key={p.label} label={p.label} on={r.from === value.from && r.to === value.to} onPress={() => set(r)} />
          })}
          {presetOn ? null : <Chip label={period} on icon onPress={openSheet} />}
        </ScrollView>
        {/* Plain accent text button; the count of active filters follows the word. */}
        <Pressable
          onPress={openSheet}
          accessibilityRole="button"
          accessibilityLabel={active ? `Filters, ${active} active` : 'Filters'}
          hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
          className="h-10 flex-row items-center gap-1 pl-1 active:opacity-60"
        >
          <Icon name="options-outline" size={18} color="accent" />
          <Text className="text-[15px] font-semibold text-staff-accent">{active ? `Filters (${active})` : 'Filters'}</Text>
        </Pressable>
      </View>

      {active ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="items-center gap-2">
          {chips.map((c) => (
            <Pressable
              key={c.key}
              onPress={() => set(c.clear)}
              accessibilityRole="button"
              accessibilityLabel={`Remove filter ${c.label}`}
              hitSlop={{ top: 4, bottom: 4 }}
              className="h-11 max-w-[220px] justify-center"
            >
              {({ pressed }) => (
                <View className={`h-8 flex-row items-center gap-1 rounded-full pl-3 pr-2 ${pressed ? 'opacity-70' : ''} bg-staff-accent-soft`}>
                  <Text className="shrink text-[13px] font-medium text-staff-accent" numberOfLines={1}>
                    {c.label}
                  </Text>
                  <Icon name="close" size={15} color="accent" />
                </View>
              )}
            </Pressable>
          ))}
          {active > 1 ? (
            <Pressable onPress={() => set(NO_FIELDS)} accessibilityRole="button" hitSlop={{ top: 6, bottom: 6 }} className="h-11 justify-center px-2 active:opacity-60">
              <Text className="text-[13px] font-semibold text-staff-accent">Clear all</Text>
            </Pressable>
          ) : null}
        </ScrollView>
      ) : null}

      {open ? (
        <Sheet
          title="Filters"
          onClose={() => setOpen(false)}
          footer={
            <View className="flex-row gap-3">
              <SmallButton
                label="Reset"
                className="h-12 px-5"
                onPress={() => {
                  onReset()
                  setOpen(false)
                }}
              />
              <View className="flex-1">
                <PrimaryButton
                  label="Apply"
                  onPress={() => {
                    onChange(draft)
                    setOpen(false)
                  }}
                />
              </View>
            </View>
          }
        >
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerClassName="gap-4 px-4 pb-4 pt-2">
            <View className="flex-row gap-2">
              <View className="flex-1">
                <DateField label="From" value={draft.from} max={draft.to} onChange={(from) => from && setDraftPart({ from, to: draft.to < from ? from : draft.to })} />
              </View>
              <View className="flex-1">
                <DateField label="To" value={draft.to} min={draft.from} onChange={(to) => to && setDraftPart({ to, from: draft.from > to ? to : draft.from })} />
              </View>
            </View>
            {has('status') ? (
              <SelectField label={statusLabel} value={draft.status} emptyLabel="All" options={statusOptions} onChange={(status) => setDraftPart({ status })} />
            ) : null}
            {has('machine') ? (
              <SelectField
                label="Machine"
                value={draft.machineId}
                emptyLabel="All machines"
                options={(machines.data ?? []).map((m) => ({ value: m.id, label: m.name, detail: m.code }))}
                onChange={(machineId) => setDraftPart({ machineId })}
              />
            ) : null}
            {has('worker') ? (
              <SelectField
                label="Worker"
                value={draft.workerId}
                emptyLabel="All workers"
                options={(workers.data ?? []).map((w) => ({ value: w.id, label: w.name, detail: w.employeeId }))}
                onChange={(workerId) => setDraftPart({ workerId })}
              />
            ) : null}
            {has('activity') ? (
              <SelectField
                label="Check type"
                value={draft.activityId}
                emptyLabel="All check types"
                options={(activities.data ?? []).map((a) => ({ value: a.id, label: a.name }))}
                onChange={(activityId) => setDraftPart({ activityId })}
              />
            ) : null}
            {has('shift') ? (
              <SelectField
                label="Shift"
                value={draft.shiftId}
                emptyLabel="All shifts"
                options={(shifts.data ?? []).map((s) => ({ value: s.id, label: s.name, detail: `${s.startTime}–${s.endTime}` }))}
                onChange={(shiftId) => setDraftPart({ shiftId })}
              />
            ) : null}
            {has('department') ? (
              <SelectField
                label="Department"
                value={draft.departmentId}
                emptyLabel="All departments"
                options={(departments.data ?? []).map((d) => ({ value: d.id, label: d.name }))}
                onChange={(departmentId) => setDraftPart({ departmentId })}
              />
            ) : null}
          </ScrollView>
        </Sheet>
      ) : null}
    </View>
  )
}

/** Same component under the redesign's name. */
export const FilterBar = FilterPanel
