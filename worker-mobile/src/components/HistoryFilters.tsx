import React, { useEffect, useState } from 'react'
import { Modal, View, Text, Pressable, ScrollView } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { HistoryFilterOptions, HistoryQuery } from '../types'
import { dateKey, daysAgo, formatDateKey, parseDateKey } from '../utils/dates'
import { Button } from './ui/Button'
import { DatePicker } from './DatePicker'
import { SectionHeader } from './ui/SectionHeader'
import { ListGroup } from './ui/ListGroup'
import { Icon } from './ui/Icon'

interface Props {
  visible: boolean
  query: HistoryQuery
  options: HistoryFilterOptions | null
  onApply: (next: HistoryQuery) => void
  onClose: () => void
}

interface Preset {
  label: string
  from?: string
  to?: string
}

function presets(): Preset[] {
  const today = dateKey(new Date())
  return [
    { label: 'Any time' },
    { label: 'Today', from: today, to: today },
    { label: 'Last 7 days', from: dateKey(daysAgo(6)), to: today },
    { label: 'Last 30 days', from: dateKey(daysAgo(29)), to: today }
  ]
}

const Row: React.FC<{ label: string; selected: boolean; onPress: () => void }> = ({ label, selected, onPress }) => (
  <Pressable
    onPress={onPress}
    accessibilityRole="radio"
    accessibilityState={{ checked: selected }}
    accessibilityLabel={label}
    className="h-14 flex-row items-center justify-between px-4 active:bg-subtle"
  >
    <Text className={`flex-1 text-[17px] ${selected ? 'font-semibold text-accent' : 'text-ink'}`} numberOfLines={1}>
      {label}
    </Text>
    {selected ? <Icon name="checkmark" size={22} color="accent" /> : null}
  </Pressable>
)

const Chip: React.FC<{ label: string; selected: boolean; onPress: () => void }> = ({ label, selected, onPress }) => (
  <Pressable
    onPress={onPress}
    accessibilityRole="button"
    accessibilityState={{ selected }}
    className={`h-11 items-center justify-center rounded-full border px-4 ${
      selected ? 'border-accent bg-accent-soft' : 'border-transparent bg-surface active:opacity-60'
    }`}
  >
    <Text className={`text-[16px] ${selected ? 'font-semibold text-accent' : 'font-medium text-ink'}`}>{label}</Text>
  </Pressable>
)

/** Filter sheet for the history list: date range, machine and department. */
export const HistoryFilters: React.FC<Props> = ({ visible, query, options, onApply, onClose }) => {
  const insets = useSafeAreaInsets()
  const [draft, setDraft] = useState<HistoryQuery>(query)
  const [picker, setPicker] = useState<'from' | 'to' | null>(null)

  // Start from the current filters each time the sheet opens.
  useEffect(() => {
    if (visible) {
      setDraft(query)
      setPicker(null)
    }
  }, [visible, query])

  const options_ = presets()
  const matchesPreset = (p: Preset) => (draft.from ?? '') === (p.from ?? '') && (draft.to ?? '') === (p.to ?? '')
  const isCustom = !options_.some(matchesPreset)

  const setDate = (which: 'from' | 'to', date: Date) => {
    const key = dateKey(date)
    setDraft((d) => {
      const next = { ...d, [which]: key }
      // Keep the two dates in order.
      if (next.from && next.to && next.from > next.to) {
        if (which === 'from') next.to = key
        else next.from = key
      }
      return next
    })
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View className="flex-1 bg-canvas">
        <View className="h-14 flex-row items-center justify-between border-b border-line px-2" style={{ marginTop: insets.top }}>
          <Pressable onPress={onClose} accessibilityRole="button" className="h-12 min-w-[88px] justify-center px-3 active:opacity-50">
            <Text className="text-[17px] text-accent">Close</Text>
          </Pressable>
          <Text className="text-[17px] font-semibold text-ink">Filters</Text>
          <Pressable
            onPress={() => onApply({ kind: draft.kind })}
            accessibilityRole="button"
            className="h-12 min-w-[88px] items-end justify-center px-3 active:opacity-50"
          >
            <Text className="text-[17px] text-accent">Clear</Text>
          </Pressable>
        </View>

        <ScrollView className="flex-1" contentContainerClassName="px-5 pb-8 pt-5">
          <View className="gap-7">
            <View>
              <SectionHeader title="Date" />
              <View className="flex-row flex-wrap gap-3">
                {options_.map((p) => (
                  <Chip
                    key={p.label}
                    label={p.label}
                    selected={matchesPreset(p)}
                    onPress={() => setDraft((d) => ({ ...d, from: p.from, to: p.to }))}
                  />
                ))}
                <Chip
                  label="Choose dates"
                  selected={isCustom}
                  onPress={() => {
                    setDraft((d) => ({ ...d, from: d.from ?? dateKey(daysAgo(6)), to: d.to ?? dateKey(new Date()) }))
                    setPicker('from')
                  }}
                />
              </View>

              {isCustom && (
                <View className="mt-3">
                  <ListGroup>
                    <Pressable
                      onPress={() => setPicker(picker === 'from' ? null : 'from')}
                      className="h-14 flex-row items-center justify-between px-4 active:bg-subtle"
                    >
                      <Text className="text-[17px] text-ink">From</Text>
                      <Text className={`text-[17px] ${picker === 'from' ? 'font-semibold text-accent' : 'text-ink-secondary'}`}>
                        {draft.from ? formatDateKey(draft.from) : 'Any'}
                      </Text>
                    </Pressable>
                    <Pressable
                      onPress={() => setPicker(picker === 'to' ? null : 'to')}
                      className="h-14 flex-row items-center justify-between px-4 active:bg-subtle"
                    >
                      <Text className="text-[17px] text-ink">To</Text>
                      <Text className={`text-[17px] ${picker === 'to' ? 'font-semibold text-accent' : 'text-ink-secondary'}`}>
                        {draft.to ? formatDateKey(draft.to) : 'Any'}
                      </Text>
                    </Pressable>
                  </ListGroup>

                  {picker ? (
                    <View className="mt-3 items-center rounded-2xl bg-surface px-4 py-3">
                      <DatePicker
                        value={parseDateKey((picker === 'from' ? draft.from : draft.to) ?? dateKey(new Date()))}
                        maximumDate={new Date()}
                        onChange={(date) => setDate(picker, date)}
                      />
                    </View>
                  ) : null}
                </View>
              )}
            </View>

            <View>
              <SectionHeader title="Machine" />
              <ListGroup>
                <Row label="All machines" selected={!draft.machineId} onPress={() => setDraft((d) => ({ ...d, machineId: undefined }))} />
                {(options?.machines ?? []).map((m) => (
                  <Row
                    key={m.id}
                    label={m.name}
                    selected={draft.machineId === m.id}
                    onPress={() => setDraft((d) => ({ ...d, machineId: m.id }))}
                  />
                ))}
              </ListGroup>
            </View>

            <View>
              <SectionHeader title="Department" />
              {(options?.departments ?? []).length === 0 ? (
                <Text className="px-4 text-[15px] text-ink-muted">Your machines do not have a department yet.</Text>
              ) : (
                <ListGroup>
                  <Row
                    label="All departments"
                    selected={!draft.departmentId}
                    onPress={() => setDraft((d) => ({ ...d, departmentId: undefined }))}
                  />
                  {(options?.departments ?? []).map((dept) => (
                    <Row
                      key={dept.id}
                      label={dept.name}
                      selected={draft.departmentId === dept.id}
                      onPress={() => setDraft((d) => ({ ...d, departmentId: dept.id }))}
                    />
                  ))}
                </ListGroup>
              )}
            </View>
          </View>
        </ScrollView>

        <View className="border-t border-line bg-surface px-5 pt-3" style={{ paddingBottom: Math.max(insets.bottom, 12) }}>
          <Button label="Show results" onPress={() => onApply(draft)} />
        </View>
      </View>
    </Modal>
  )
}
