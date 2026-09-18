import React, { useMemo, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import type { CalendarYearSummary, ClosureType, DayState, PlantClosure, WeeklyRule } from '../types'
import { api } from '../../services/api'
import { useStaff } from '../nav'
import { useQuery, errorText } from '../useQuery'
import { WEEKDAY_NAMES, addDaysKey, dateKey, keyToDate, type Tone } from '../format'
import {
  AccessDenied,
  Badge,
  Card,
  DataState,
  DateField,
  FieldLabel,
  FormError,
  FormSection,
  Icon,
  IconButton,
  Input,
  List,
  Notice,
  PrimaryButton,
  Row,
  Screen,
  Section,
  Segmented,
  SelectField,
  SmallButton,
  ToggleField,
  confirm,
  useToast
} from '../ui'
import { ActionGroup, ActionItem } from './adminParts'

/** First date managed by annual calendars; earlier dates keep the original Plant Calendar setup. */
const CALENDAR_V2_START = '2027-01-01'
const LAST_LEGACY_DATE = '2026-12-31'

// ---------------------------------------------------------------- shared helpers

const TYPE_ORDER: ClosureType[] = ['HOLIDAY', 'SHUTDOWN', 'CLOSED', 'WORKING']
const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']

/**
 * Look of each entry type, same wording as the web calendar. Days get a soft fill from the status
 * tokens (holiday green, shutdown red, adjustment working day blue, closed grey) and a small dot.
 */
const CLOSURE_TYPES: Record<ClosureType, { label: string; hint: string; cell: string; dot: string }> = {
  CLOSED: { label: 'Plant Closed', hint: 'Weekly off or unplanned closure', cell: 'bg-subtle', dot: 'bg-ink-secondary' },
  HOLIDAY: { label: 'Holiday', hint: 'Festival or public holiday', cell: 'bg-success-bg', dot: 'bg-success' },
  SHUTDOWN: { label: 'Shutdown', hint: 'Maintenance or production shutdown', cell: 'bg-missed-bg', dot: 'bg-missed' },
  WORKING: { label: 'Adjustment Working Day', hint: 'Plant runs normally: checks and alerts as scheduled', cell: 'bg-due-bg', dot: 'bg-due' }
}
const WEEKLY_OFF_STYLE = { label: 'Weekly Off', cell: '', dot: 'bg-staff-faint' }

const isClosedType = (type: ClosureType) => type !== 'WORKING'
const longDate = (key: string) => keyToDate(key).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
const shortDate = (key: string, withYear = true) =>
  keyToDate(key).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}) })
const monthTitle = (monthKey: string) => keyToDate(`${monthKey}-01`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
const daysBetween = (from: string, to: string) => Math.round((keyToDate(to).getTime() - keyToDate(from).getTime()) / 86_400_000) + 1
const shiftMonth = (monthKey: string, offset: number) => {
  const [y, m] = monthKey.split('-').map(Number)
  return dateKey(new Date(y, m - 1 + offset, 1)).slice(0, 7)
}

/** The 6-week grid (Monday first) that shows a month. */
function monthGrid(monthKey: string) {
  const first = keyToDate(`${monthKey}-01`)
  const start = addDaysKey(dateKey(first), -((first.getDay() + 6) % 7))
  return Array.from({ length: 42 }, (_, i) => addDaysKey(start, i))
}

/** Consecutive days with the same type and reason, shown as one entry. */
function groupRanges(rows: { date: string; type: ClosureType; reason: string | null }[]) {
  const ranges: { from: string; to: string; type: ClosureType; reason: string | null }[] = []
  for (const row of rows) {
    const last = ranges[ranges.length - 1]
    if (last && addDaysKey(last.to, 1) === row.date && last.type === row.type && last.reason === row.reason) last.to = row.date
    else ranges.push({ from: row.date, to: row.date, type: row.type, reason: row.reason })
  }
  return ranges
}

const rangeTitle = (from: string, to: string) => (from === to ? shortDate(from) : `${shortDate(from, from.slice(0, 4) !== to.slice(0, 4))} – ${shortDate(to)}`)

/**
 * The month and day the calendar showed, kept while the app runs so the calendar opens where the
 * user left it after a form screen pops (screens remount on pop).
 */
let remembered: { month: string; selected: string; at: number } | null = null
const remember = (selected: string) => {
  remembered = { month: selected.slice(0, 7), selected, at: Date.now() }
}

/** Asks, then removes a calendar entry; the date follows the weekly off again. Resolves true when removed. */
async function removeEntry(closure: { id: string; date: string; type: ClosureType }, weeklyOff: boolean, notify: ReturnType<typeof useToast>) {
  const today = dateKey()
  const closed = isClosedType(closure.type)
  const day = longDate(closure.date)
  const ok = await confirm(
    !closed ? 'Remove this adjustment working day?' : weeklyOff ? 'Remove this calendar date?' : 'Open the plant on this day?',
    weeklyOff
      ? `${day} is a weekly off, so without this entry the plant is closed on this date: its checks are removed and workers get no alerts.`
      : !closed
        ? `${day} is removed from the calendar. The plant keeps running normally on this date.`
        : `${day} will no longer be a closed day. Its quality checks are scheduled again from the schedules and workers get alerts as usual.${
            closure.date <= today ? ' Checks whose time has already passed will show as Missed.' : ''
          }`,
    !closed || weeklyOff ? 'Remove' : 'Open the plant',
    true
  )
  if (!ok) return false
  try {
    await api.del(`/api/plant-closures/${closure.id}`)
    notify(
      'success',
      `${shortDate(closure.date)} removed from the calendar`,
      weeklyOff
        ? `${WEEKDAY_NAMES[keyToDate(closure.date).getDay()]} is a weekly off, so the plant is closed on this date: no checks or alerts.`
        : 'The plant is open on this date: checks and alerts as scheduled.'
    )
    return true
  } catch (err) {
    notify('error', 'Could not remove the closed day', errorText(err))
    return false
  }
}

const Dot: React.FC<{ className: string }> = ({ className }) => <View className={`h-2 w-2 rounded-full ${className}`} />

/** One choice of a single-select list of entry types (radio). */
const TypeOption: React.FC<{ type: ClosureType; active: boolean; onPress: () => void }> = ({ type, active, onPress }) => (
  <Pressable
    onPress={onPress}
    accessibilityRole="radio"
    accessibilityState={{ checked: active }} aria-checked={active}
    accessibilityLabel={CLOSURE_TYPES[type].label}
    className={`min-h-[56px] flex-row items-center gap-3 rounded-xl border px-3.5 py-2.5 active:bg-staff-fill ${
      active ? 'border-2 border-staff-accent bg-staff-accent-soft' : 'border-staff-field bg-staff-card'
    }`}
  >
    <View className={`h-3 w-3 rounded-full ${CLOSURE_TYPES[type].dot}`} />
    <View className="flex-1">
      <Text className="text-[15px] font-semibold leading-[20px] text-staff-ink">{CLOSURE_TYPES[type].label}</Text>
      <Text className="text-[13px] leading-[18px] text-staff-muted">{CLOSURE_TYPES[type].hint}</Text>
    </View>
    {active ? <Icon name="checkmark-circle" size={22} color="accent" /> : null}
  </Pressable>
)

// ---------------------------------------------------------------- calendar

/** Plant Calendar: the month grid, the selected day, links to annual calendars and weekly rules, and the entries. */
export const CalendarScreen: React.FC<{ params: Record<string, unknown> }> = () => {
  const { can, push } = useStaff()
  const notify = useToast()
  const canEdit = can('calendar', 'manage')
  const today = dateKey()
  const start = remembered && Date.now() - remembered.at < 30 * 60_000 ? remembered : null
  const [monthKey, setMonthKey] = useState(start?.month ?? today.slice(0, 7))
  const [selected, setSelected] = useState(start?.selected ?? today)
  const [listMode, setListMode] = useState<'month' | 'upcoming'>('month')

  const grid = useMemo(() => monthGrid(monthKey), [monthKey])
  // Open or closed, and why, for every day shown: decided by the backend (entries, weekly off, weekly rules).
  const monthData = useQuery<DayState[]>('/api/plant-closures/days', { from: grid[0], to: grid[grid.length - 1] })
  const upcoming = useQuery<PlantClosure[]>('/api/plant-closures', { from: today, to: addDaysKey(today, 365) })
  const years = useQuery<{ firstYear: number; years: CalendarYearSummary[] }>('/api/calendar-years')
  const rules = useQuery<{ rules: WeeklyRule[] }>('/api/weekly-rules')
  const legacy = useQuery<{ weeklyOffDays: number[] }>('/api/plant-closures/settings')

  const stateByDate = useMemo(() => new Map((monthData.data ?? []).map((s) => [s.date, s])), [monthData.data])
  const isWeeklyOff = (key: string) => stateByDate.get(key)?.weeklyClosed ?? false
  const yearOf = (key: string) => (years.data?.years ?? []).find((y) => y.year === Number(key.slice(0, 4))) ?? null
  const managedByYear = (key: string) => key >= CALENDAR_V2_START
  const monthStates = (monthData.data ?? []).filter((s) => s.date.startsWith(monthKey))
  const closedThisMonth = monthStates.filter((s) => s.closed).length
  const workingThisMonth = monthStates.filter((s) => s.entry?.type === 'WORKING').length
  const viewedYear = Number(monthKey.slice(0, 4))
  const viewedCalendar = viewedYear >= Number(CALENDAR_V2_START.slice(0, 4)) ? yearOf(monthKey) : null
  const selectedState = stateByDate.get(selected) ?? null
  const selectedEntry = selectedState?.entry ?? null
  const monthRanges = useMemo(
    () => groupRanges(monthStates.filter((s) => s.entry).map((s) => ({ date: s.date, type: s.entry!.type, reason: s.entry!.reason }))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [monthData.data, monthKey]
  )
  const upcomingRanges = useMemo(() => groupRanges(upcoming.data ?? []), [upcoming.data])

  const reload = () => {
    monthData.reload()
    upcoming.reload()
    years.reload()
    rules.reload()
    legacy.reload()
  }
  const goToDate = (key: string) => {
    setMonthKey(key.slice(0, 7))
    setSelected(key)
    remember(key)
  }
  const goToMonth = (offset: number) => {
    const next = shiftMonth(monthKey, offset)
    setMonthKey(next)
    remembered = { month: next, selected, at: Date.now() }
  }
  const openYears = (key: string) => {
    const id = yearOf(key)?.id
    if (id) push('calendarYearDetail', { id })
    else push('calendarYears')
  }
  const openNew = (from: string) => {
    if (managedByYear(from)) return openYears(from)
    remember(from)
    push('calendarDayForm', { mode: 'new', from, weeklyOff: isWeeklyOff(from) })
  }
  const openEdit = () => {
    if (!selectedEntry) return
    if (managedByYear(selected)) return openYears(selected)
    remember(selected)
    push('calendarDayForm', { mode: 'edit', id: selectedEntry.id, date: selected, type: selectedEntry.type, reason: selectedEntry.reason ?? '', weeklyOff: isWeeklyOff(selected) })
  }
  const removeSelected = async () => {
    if (!selectedEntry) return
    if (await removeEntry({ id: selectedEntry.id, date: selected, type: selectedEntry.type }, isWeeklyOff(selected), notify)) {
      monthData.reload()
      upcoming.reload()
    }
  }

  const when = selected === today ? 'Today' : selected === addDaysKey(today, 1) ? 'Tomorrow' : selected === addDaysKey(today, -1) ? 'Yesterday' : 'Selected day'
  const weekday = WEEKDAY_NAMES[keyToDate(selected).getDay()]
  const managedYear = managedByYear(selected) ? Number(selected.slice(0, 4)) : null
  const legacyDays = legacy.data?.weeklyOffDays ?? null
  const currentRules = (rules.data?.rules ?? []).filter((r) => !r.effectiveTo || r.effectiveTo >= (today > CALENDAR_V2_START ? today : CALENDAR_V2_START))
  const monthSummary =
    monthData.loading && !monthData.data
      ? 'Loading…'
      : closedThisMonth || workingThisMonth
        ? [
            closedThisMonth ? `${closedThisMonth} closed day${closedThisMonth === 1 ? '' : 's'}` : null,
            workingThisMonth ? `${workingThisMonth} adjustment working day${workingThisMonth === 1 ? '' : 's'}` : null
          ]
            .filter(Boolean)
            .join(' · ') + ' this month'
        : 'Plant open every day this month'

  // Dates from 2027 are changed in the annual calendar, never here.
  const yearLink = managedYear ? (
    <View className="gap-2 border-t border-staff-line pt-3">
      <Text className="text-[13px] leading-[18px] text-staff-muted">
        {yearOf(selected)
          ? yearOf(selected)!.status === 'APPROVED'
            ? `From the approved ${managedYear} calendar. Change it there and approve again.`
            : `The ${managedYear} calendar is still a draft; its dates apply after approval.`
          : `No ${managedYear} calendar yet: only the weekly rules apply to this date.`}
      </Text>
      <SmallButton
        label={yearOf(selected) ? `Open ${managedYear} calendar` : 'Open annual calendars'}
        icon="open-outline"
        onPress={() => openYears(selected)}
        className="self-start"
      />
    </View>
  ) : null

  /** Status line of the selected day: coloured dot, title and an optional second line. */
  const dayStatus = (dot: string, title: string, line?: React.ReactNode) => (
    <View className="flex-row items-start gap-3">
      <View className="mt-[5px]">
        <Dot className={dot} />
      </View>
      <View className="flex-1">
        <Text className="text-[16px] font-semibold leading-[21px] text-staff-ink">{title}</Text>
        {line}
      </View>
    </View>
  )

  return (
    <Screen
      title="Plant Calendar"
      right={canEdit && today <= LAST_LEGACY_DATE ? { label: 'Add', icon: 'add', onPress: () => openNew(selected < today || managedByYear(selected) ? today : selected) } : null}
      onRefresh={reload}
      refreshing={monthData.loading && !!monthData.data}
    >
      <Card>
        <View className="flex-row items-center gap-2 px-3 pt-3">
          <IconButton icon="chevron-back" variant="plain" tone="accent" accessibilityLabel="Previous month" onPress={() => goToMonth(-1)} />
          <Text className="flex-1 text-center text-[17px] font-bold leading-[22px] text-staff-ink" accessibilityLiveRegion="polite" numberOfLines={1}>
            {monthTitle(monthKey)}
          </Text>
          <IconButton icon="chevron-forward" variant="plain" tone="accent" accessibilityLabel="Next month" onPress={() => goToMonth(1)} />
        </View>
        <View className="flex-row items-center gap-2 px-4 pb-3 pt-2">
          <Text className="flex-1 text-[13px] leading-[18px] text-staff-muted">{monthSummary}</Text>
          <SmallButton label="Today" tone="ghost" onPress={() => goToDate(today)} disabled={monthKey === today.slice(0, 7) && selected === today} className="px-3" />
        </View>

        {viewedYear >= Number(CALENDAR_V2_START.slice(0, 4)) && years.data && (!viewedCalendar || viewedCalendar.status !== 'APPROVED' || viewedCalendar.pendingChanges) ? (
          <View className="mx-3 mb-3 flex-row gap-3 rounded-xl bg-exception-bg px-3.5 py-3">
            <Icon name="warning-outline" size={20} color="exception" />
            <View className="flex-1 gap-2">
              <Text className="text-[13px] leading-[18px] text-staff-ink2">
                {!viewedCalendar
                  ? `No ${viewedYear} company calendar yet: only the weekly rules apply. Holidays and adjustment working days take effect once the ${viewedYear} calendar is approved.`
                  : viewedCalendar.status !== 'APPROVED'
                    ? `The ${viewedYear} calendar is a draft: its holidays are not in use until it is approved.`
                    : `The ${viewedYear} calendar has changes awaiting approval. The dates shown are the approved ones.`}
              </Text>
              <SmallButton
                label={viewedCalendar ? `Review ${viewedYear}` : 'Open annual calendars'}
                onPress={() => (viewedCalendar ? push('calendarYearDetail', { id: viewedCalendar.id }) : push('calendarYears'))}
                className="self-start"
              />
            </View>
          </View>
        ) : null}

        {monthData.error ? (
          <View className="mx-3 mb-3 flex-row items-center gap-2 rounded-xl bg-missed-bg py-2 pl-3.5 pr-2">
            <Icon name="cloud-offline-outline" size={20} color="missed" />
            <Text className="flex-1 text-[13px] leading-[18px] text-missed">{monthData.error}</Text>
            <SmallButton label="Retry" onPress={monthData.reload} />
          </View>
        ) : null}

        <View className="px-1.5">
          <View className="flex-row border-t border-staff-line pt-1">
            {WEEKDAYS.map((d, i) => (
              <Text key={i} style={{ width: `${100 / 7}%` }} className="py-1.5 text-center text-[12px] font-medium text-staff-muted">
                {d}
              </Text>
            ))}
          </View>

          <View className="flex-row flex-wrap">
            {grid.map((key) => {
              const state = stateByDate.get(key)
              const entry = state?.entry ?? null
              const inMonth = key.startsWith(monthKey)
              const isToday = key === today
              const isSelected = key === selected
              const weeklyOff = !entry && (state?.weeklyClosed ?? false)
              const style = entry ? CLOSURE_TYPES[entry.type] : weeklyOff ? WEEKLY_OFF_STYLE : null
              const label = `${longDate(key)}${entry ? `, ${CLOSURE_TYPES[entry.type].label}${entry.reason ? `: ${entry.reason}` : ''}` : weeklyOff ? ', Weekly Off' : ', plant open'}`
              return (
                <Pressable
                  key={key}
                  onPress={() => goToDate(key)}
                  accessibilityRole="button"
                  accessibilityLabel={label}
                  accessibilityState={{ selected: isSelected }} aria-selected={isSelected}
                  style={{ width: `${100 / 7}%` }}
                  className={`h-[52px] items-center justify-center ${inMonth ? '' : 'opacity-40'}`}
                >
                  <View
                    className={`h-9 w-9 items-center justify-center rounded-full ${
                      isSelected ? 'bg-staff-accent' : style ? style.cell : ''
                    } ${isToday && !isSelected ? 'border-2 border-staff-accent' : ''}`}
                  >
                    <Text
                      className={`text-[15px] ${isSelected ? 'font-semibold text-white' : isToday ? 'font-semibold text-staff-accent' : inMonth ? (key < today && !entry ? 'text-staff-muted' : 'text-staff-ink') : 'text-staff-faint'}`}
                    >
                      {keyToDate(key).getDate()}
                    </Text>
                  </View>
                  <View className={`mt-0.5 h-1.5 w-1.5 rounded-full ${style ? style.dot : ''}`} />
                </Pressable>
              )
            })}
          </View>
        </View>

        <View className="mt-1 flex-row flex-wrap gap-x-3 gap-y-1 px-4 pb-3 pt-2">
          {TYPE_ORDER.map((t) => (
            <View key={t} className="flex-row items-center gap-1">
              <Dot className={CLOSURE_TYPES[t].dot} />
              <Text className="text-[12px] leading-[16px] text-staff-muted">{CLOSURE_TYPES[t].label}</Text>
            </View>
          ))}
          {(monthData.data ?? []).some((s) => s.source === 'WEEKLY') ? (
            <View className="flex-row items-center gap-1">
              <Dot className={WEEKLY_OFF_STYLE.dot} />
              <Text className="text-[12px] leading-[16px] text-staff-muted">Weekly Off</Text>
            </View>
          ) : null}
          <View className="flex-row items-center gap-1">
            <View className="h-2.5 w-2.5 rounded-full border-2 border-staff-accent" />
            <Text className="text-[12px] leading-[16px] text-staff-muted">Today</Text>
          </View>
        </View>
        {canEdit ? <Text className="px-4 pb-3 text-[12px] leading-[16px] text-staff-muted">Tap a day to mark or edit it</Text> : null}
      </Card>

      <Section title={when}>
        <Card className="gap-3 p-4">
          <Text className="text-[13px] font-medium leading-[18px] text-staff-muted">{longDate(selected)}</Text>
          {monthData.loading && !monthData.data ? (
            <Text className="text-[14px] text-staff-muted">Loading…</Text>
          ) : selectedEntry ? (
            <>
              {dayStatus(
                CLOSURE_TYPES[selectedEntry.type].dot,
                CLOSURE_TYPES[selectedEntry.type].label,
                selectedEntry.reason || isClosedType(selectedEntry.type) ? (
                  <Text className={`text-[14px] leading-[19px] ${selectedEntry.reason ? 'text-staff-ink2' : 'text-staff-muted'}`}>{selectedEntry.reason || 'No reason added'}</Text>
                ) : null
              )}
              <Text className="text-[13px] leading-[18px] text-staff-muted">
                {isClosedType(selectedEntry.type)
                  ? 'No checks are scheduled and no alerts are sent on this day.'
                  : isWeeklyOff(selected)
                    ? `Opens the plant on this ${weekday}, normally a weekly off: checks are scheduled and workers get alerts.`
                    : 'The plant runs normally: checks are scheduled and workers get alerts.'}
              </Text>
              {managedYear ? (
                yearLink
              ) : canEdit ? (
                <View className="flex-row gap-2">
                  <SmallButton label="Edit" icon="create-outline" onPress={openEdit} className="flex-1" />
                  <SmallButton label="Remove" icon="trash-outline" tone="danger" onPress={removeSelected} className="flex-1" />
                </View>
              ) : null}
            </>
          ) : isWeeklyOff(selected) ? (
            <>
              {dayStatus(
                WEEKLY_OFF_STYLE.dot,
                'Weekly Off · Plant closed',
                <Text className="text-[14px] leading-[19px] text-staff-ink2">Every {weekday} is closed unless marked as an Adjustment Working Day.</Text>
              )}
              <Text className="text-[13px] leading-[18px] text-staff-muted">No checks are scheduled and no alerts are sent on this day.</Text>
              {managedYear ? yearLink : canEdit ? <SmallButton label="Mark as Adjustment Working Day" tone="primary" onPress={() => openNew(selected)} /> : null}
            </>
          ) : (
            <>
              {dayStatus('bg-success', 'Plant open · checks run as scheduled')}
              {managedYear ? yearLink : canEdit ? <SmallButton label="Add to calendar" icon="add" tone="primary" onPress={() => openNew(selected)} /> : null}
            </>
          )}
        </Card>
      </Section>

      <View className="gap-2">
        <ActionGroup>
          <ActionItem
            label="Annual calendars"
            description={`Company holidays from ${years.data?.firstYear ?? 2027}: import, check, approve`}
            onPress={() => push('calendarYears')}
          />
          <ActionItem
            label="Weekly rules"
            description={`Up to 2026: ${legacyDays === null ? '…' : legacyDays.length ? legacyDays.map((d) => WEEKDAY_NAMES[d]).join(', ') : 'None'} (locked)\nFrom 2027: ${
              rules.data === null ? '…' : currentRules.length ? currentRules.map((r) => `${WEEKDAY_NAMES[r.weekday]}${r.effectiveTo ? ` until ${r.effectiveTo}` : ''}`).join(', ') : 'None'
            }`}
            onPress={() => push('weeklyRules')}
          />
        </ActionGroup>
        {canEdit ? (
          <Text className="px-1 text-[13px] leading-[18px] text-staff-muted">Dates up to 31 Dec 2026 are edited here. From 2027, dates come from the approved annual calendar.</Text>
        ) : null}
      </View>

      <Section title="Calendar dates">
        <View className="gap-3">
          <Segmented
            value={listMode}
            onChange={setListMode}
            options={[
              { value: 'month', label: monthTitle(monthKey) },
              { value: 'upcoming', label: 'Next 12 months' }
            ]}
          />
          {listMode === 'month' ? (
            <DataState
              loading={monthData.loading}
              error={monthData.error}
              onRetry={monthData.reload}
              hasData={!!monthData.data}
              empty={!!monthData.data && monthRanges.length === 0}
              emptyText="No holidays or working days this month."
              emptyIcon="calendar-outline"
            >
              <List>
                {monthRanges.map((r) => (
                  <Row
                    key={r.from}
                    title={rangeTitle(r.from, r.to)}
                    subtitle={`${CLOSURE_TYPES[r.type].label}${r.reason ? ` · ${r.reason}` : ''}${r.from !== r.to ? ` · ${daysBetween(r.from, r.to)} days` : ''}`}
                    right={<Dot className={CLOSURE_TYPES[r.type].dot} />}
                    onPress={() => goToDate(r.from)}
                  />
                ))}
              </List>
            </DataState>
          ) : (
            <DataState
              loading={upcoming.loading}
              error={upcoming.error}
              onRetry={upcoming.reload}
              hasData={!!upcoming.data}
              empty={!!upcoming.data && upcomingRanges.length === 0}
              emptyText="No holidays or working days planned."
              emptyIcon="calendar-outline"
            >
              <List>
                {upcomingRanges.map((r) => (
                  <Row
                    key={r.from}
                    title={rangeTitle(r.from, r.to)}
                    subtitle={`${CLOSURE_TYPES[r.type].label}${r.reason ? ` · ${r.reason}` : ''}${r.from !== r.to ? ` · ${daysBetween(r.from, r.to)} days` : ''}`}
                    right={r.from === today ? <Badge label="Today" tone="accent" /> : <Dot className={CLOSURE_TYPES[r.type].dot} />}
                    onPress={() => goToDate(r.from)}
                  />
                ))}
              </List>
            </DataState>
          )}
        </View>
      </Section>

      <Notice title="On a closed day (weekly off, holiday, shutdown)">
        <View className="mt-1 gap-1">
          <Text className="text-[14px] leading-[19px] text-staff-ink2">• Scheduled checks are skipped</Text>
          <Text className="text-[14px] leading-[19px] text-staff-ink2">• Workers get no check alerts</Text>
          <Text className="text-[14px] leading-[19px] text-staff-ink2">• Nothing is marked Missed</Text>
          <Text className="text-[14px] leading-[19px] text-staff-ink2">• Completed and Exception records are kept</Text>
          <Text className="mt-1.5 text-[14px] leading-[19px] text-staff-ink2">
            <Text className="font-semibold text-due">Adjustment working days</Text> are normal working days: checks are scheduled, workers get alerts and Missed checks count as usual.
          </Text>
        </View>
      </Notice>
    </Screen>
  )
}

type DayFormParams =
  | { mode: 'new'; from: string; weeklyOff?: boolean }
  | { mode: 'edit'; id: string; date: string; type: ClosureType; reason: string; weeklyOff?: boolean }

/** Adds dates up to 31 Dec 2026 to the Plant Calendar, or edits / removes one entry. */
export const CalendarDayFormScreen: React.FC<{ params: DayFormParams }> = ({ params }) => {
  const { can, pop } = useStaff()
  const notify = useToast()
  const canEdit = can('calendar', 'manage')
  const today = dateKey()
  const isNew = params.mode === 'new'
  // On a weekly off the usual change is to open the plant for that day.
  const [type, setType] = useState<ClosureType>(params.mode === 'edit' ? params.type : params.weeklyOff ? 'WORKING' : 'HOLIDAY')
  const [from, setFrom] = useState(params.mode === 'edit' ? params.date : params.from)
  const [to, setTo] = useState(params.mode === 'edit' ? params.date : params.from)
  const [multiDay, setMultiDay] = useState(false)
  const [reason, setReason] = useState(params.mode === 'edit' ? params.reason : '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const end = isNew && multiDay ? to : from
  const valid = !!from && !!end && end >= from
  const days = valid ? daysBetween(from, end) : 0
  const closing = isClosedType(type)
  const includesPast = closing && valid && from < today
  const includesToday = closing && valid && from <= today && end >= today
  const removedText = (n: number) => (n ? ` ${n} open or missed check${n === 1 ? ' was' : 's were'} removed.` : '')

  const save = async () => {
    const cleanReason = reason.trim() || null
    setError(null)
    try {
      setSaving(true)
      if (params.mode === 'new') {
        if (!from || !end) return setError('Choose the date')
        if (end < from) return setError('End date must be on or after the start date')
        if (daysBetween(from, end) > 366) return setError('Mark at most 366 days at a time')
        const result = await api.post<{ dates: string[]; removedChecks: number }>('/api/plant-closures', { from, to: end, type, reason: cleanReason })
        const count = result.dates.length
        notify(
          'success',
          `${count === 1 ? shortDate(from) : `${count} days`} marked as ${CLOSURE_TYPES[type].label}`,
          closing ? `No checks or alerts on ${count === 1 ? 'this date' : 'these dates'}.${removedText(result.removedChecks)}` : 'The plant runs normally: checks and alerts as scheduled.'
        )
      } else {
        if (!from) return setError('Choose the date')
        const result = await api.put<{ removedChecks: number }>(`/api/plant-closures/${params.id}`, { date: from, type, reason: cleanReason })
        notify(
          'success',
          'Calendar date updated',
          `${shortDate(from)} · ${CLOSURE_TYPES[type].label}.${from !== params.date ? ` ${shortDate(params.date)} is open again.` : ''}${removedText(result.removedChecks)}`
        )
      }
      remember(from)
      pop()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (params.mode !== 'edit') return
    if (await removeEntry({ id: params.id, date: params.date, type: params.type }, !!params.weeklyOff, notify)) {
      remember(params.date)
      pop()
    }
  }

  if (!canEdit) {
    return (
      <Screen title="Plant Calendar">
        <AccessDenied title="You can view the Plant Calendar but not change it." />
      </Screen>
    )
  }

  return (
    <Screen
      title={isNew ? 'Add to plant calendar' : 'Edit calendar date'}
      subtitle={params.mode === 'edit' ? longDate(params.date) : 'Holidays and closed days skip checks and alerts'}
      footer={
        <PrimaryButton
          label={isNew ? (closing ? (days > 1 ? `Mark ${days} days closed` : 'Mark closed') : days > 1 ? `Mark ${days} working days` : 'Mark working day') : 'Save changes'}
          onPress={save}
          loading={saving}
          disabled={!valid}
        />
      }
    >
      <FormError message={error} />

      <FormSection title="Type">
        <View>
          <FieldLabel label="Type" required />
          <View className="gap-2" accessibilityRole="radiogroup">
            {TYPE_ORDER.map((t) => (
              <TypeOption key={t} type={t} active={type === t} onPress={() => setType(t)} />
            ))}
          </View>
        </View>
      </FormSection>

      <FormSection title={isNew && multiDay ? 'Dates' : 'Date'}>
        {isNew ? (
          <>
            <DateField
              label={multiDay ? 'From date' : 'Date'}
              required
              value={from}
              max={LAST_LEGACY_DATE}
              onChange={(v) => {
                setFrom(v)
                if (to < v) setTo(v)
              }}
            />
            {multiDay ? (
              <View>
                <DateField label="To date" required value={to} min={from} max={LAST_LEGACY_DATE} onChange={setTo} />
                {to && to < from ? <Text className="mt-1 text-[13px] text-missed">Must be on or after the From date</Text> : null}
              </View>
            ) : null}
            <ToggleField
              label="Several days in a row"
              value={multiDay}
              onChange={(next) => {
                setMultiDay(next)
                if (next && to < from) setTo(from)
              }}
              description={multiDay && valid ? `${days} day${days === 1 ? '' : 's'} · every date in the range is marked` : 'For a shutdown week or a long holiday'}
            />
          </>
        ) : (
          <DateField label="Date" required value={from} max={LAST_LEGACY_DATE} onChange={setFrom} hint="Moving a date clears the old date from the calendar" />
        )}
      </FormSection>

      <FormSection title="Details">
        <Input
          label="Reason"
          hint="Optional · shown on the calendar and in the worker app"
          value={reason}
          onChangeText={setReason}
          maxLength={200}
          placeholder={type === 'HOLIDAY' ? 'e.g. Diwali' : type === 'SHUTDOWN' ? 'e.g. Annual maintenance' : type === 'WORKING' ? 'e.g. Adjustment working day' : 'e.g. Sunday weekly off'}
        />
      </FormSection>

      {includesPast || includesToday ? (
        <Notice
          tone="exception"
          message={`${includesToday ? 'Today’s open checks are removed and workers get no more alerts today. ' : ''}${
            includesPast ? 'On past dates, checks that were never submitted — including Missed checks — are removed from monitoring and reports. ' : ''
          }Completed and Exception records are kept.`}
        />
      ) : null}

      {!isNew ? (
        <ActionGroup>
          <ActionItem label="Remove from calendar" tone="danger" onPress={remove} />
        </ActionGroup>
      ) : null}
    </Screen>
  )
}

// ---------------------------------------------------------------- weekly rules

interface RulesResponse {
  startsOn: string
  earliestChange: string
  rules: WeeklyRule[]
}

type RuleStatus = 'ACTIVE' | 'SCHEDULED' | 'ENDED'
const statusOf = (rule: WeeklyRule, today: string): RuleStatus =>
  rule.effectiveFrom > today ? 'SCHEDULED' : rule.effectiveTo && rule.effectiveTo < today ? 'ENDED' : 'ACTIVE'
const STATUS_STYLE: Record<RuleStatus, { label: string; tone: Tone }> = {
  ACTIVE: { label: 'Active', tone: 'success' },
  SCHEDULED: { label: 'Starts later', tone: 'due' },
  ENDED: { label: 'Ended', tone: 'neutral' }
}
// Monday first, like the calendar.
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0]
const rulesRemovedText = (n: number) => (n ? ` ${n} upcoming check${n === 1 ? ' was' : 's were'} removed from newly closed days.` : '')

/**
 * Weekly rules: recurring weekly closures from 2027. Every change applies from a date that is not
 * in the past, so earlier dates keep the rules that applied to them.
 */
export const WeeklyRulesScreen: React.FC<{ params: Record<string, unknown> }> = () => {
  const { can, push } = useStaff()
  const notify = useToast()
  const canEdit = can('calendar', 'manage')
  const { data, error, loading, reload } = useQuery<RulesResponse>('/api/weekly-rules')
  const legacy = useQuery<{ weeklyOffDays: number[] }>('/api/plant-closures/settings')
  const today = dateKey()
  const rules = data?.rules ?? []
  const earliest = data?.earliestChange ?? today

  const remove = async (rule: WeeklyRule) => {
    const ok = await confirm(
      'Delete this weekly rule?',
      `The ${WEEKDAY_NAMES[rule.weekday]} closure from ${shortDate(rule.effectiveFrom)} has not started yet, so it is removed completely.`,
      'Delete rule',
      true
    )
    if (!ok) return
    try {
      const result = await api.del<{ removedChecks: number }>(`/api/weekly-rules/${rule.id}`)
      notify('success', 'Weekly rule deleted', `${WEEKDAY_NAMES[rule.weekday]} closure removed.${rulesRemovedText(result.removedChecks)}`)
      reload()
    } catch (err) {
      notify('error', 'Could not delete the rule', errorText(err))
    }
  }

  return (
    <Screen
      title="Weekly rules"
      subtitle="Plant Calendar"
      right={canEdit && data ? { label: 'Add', icon: 'add', onPress: () => push('weeklyRuleForm', { earliest }) } : null}
      onRefresh={() => {
        reload()
        legacy.reload()
      }}
      refreshing={loading && !!data}
    >
      <Text className="px-1 text-[14px] leading-[19px] text-staff-ink2">
        The plant is closed on these weekdays from {data ? shortDate(data.startsOn) : '1 Jan 2027'} onwards, in every year, unless a date in the annual calendar says otherwise (an
        Adjustment Working Day opens it).
      </Text>

      <DataState
        loading={loading}
        error={error}
        onRetry={reload}
        hasData={!!data}
        empty={!!data && rules.length === 0}
        emptyText="No weekly rules: from 2027 the plant is open every day unless a date is marked closed."
        emptyIcon="repeat-outline"
      >
        <View className="gap-3">
          {rules.map((rule) => {
            const status = statusOf(rule, today)
            const started = rule.effectiveFrom < earliest
            return (
              <Card key={rule.id}>
                <View className="flex-row items-center gap-3 px-4 pb-1 pt-3.5">
                  <Text className={`flex-1 text-[16px] font-semibold leading-[21px] ${status === 'ENDED' ? 'text-staff-muted' : 'text-staff-ink'}`}>
                    Closed every {WEEKDAY_NAMES[rule.weekday]}
                  </Text>
                  {status !== 'ACTIVE' ? <Badge label={STATUS_STYLE[status].label} tone={STATUS_STYLE[status].tone} /> : null}
                </View>
                <View className="pb-1.5">
                  <KVLine label="From" value={shortDate(rule.effectiveFrom)} />
                  <KVLine label="Until" value={rule.effectiveTo ? shortDate(rule.effectiveTo) : 'No end date'} />
                  {rule.note ? <KVLine label="Note" value={rule.note} /> : null}
                </View>
                {canEdit && (status !== 'ENDED' || !started) ? (
                  <View className="flex-row gap-2 border-t border-staff-line px-4 py-3">
                    {status !== 'ENDED' ? (
                      <SmallButton
                        label={rule.effectiveTo ? 'Change end' : 'End rule'}
                        icon="stop-circle-outline"
                        onPress={() => push('weeklyRuleEnd', { rule, earliest })}
                        className="flex-1"
                      />
                    ) : null}
                    {!started ? <SmallButton label="Delete" icon="trash-outline" tone="danger" onPress={() => remove(rule)} className="flex-1" /> : null}
                  </View>
                ) : null}
              </Card>
            )
          })}
        </View>
      </DataState>

      <Notice title="Up to 31 Dec 2026" icon="lock-closed-outline">
        <Text className="mt-0.5 text-[14px] leading-[19px] text-staff-ink2">
          {legacy.data
            ? legacy.data.weeklyOffDays.length
              ? `Closed every ${legacy.data.weeklyOffDays.map((d) => WEEKDAY_NAMES[d]).join(' and ')}, with the 2026 holidays and adjustment working days as they are.`
              : 'No weekly off.'
            : 'Loading…'}{' '}
          This is locked so 2026 check statuses, Missed counts and reports never change.
        </Text>
      </Notice>

      <ActionGroup>
        <ActionItem label="Annual calendars" description="Holidays and adjustment working days per year" onPress={() => push('calendarYears')} />
      </ActionGroup>
    </Screen>
  )
}

/** A compact label / value line inside a rule card. */
const KVLine: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <View className="flex-row px-4 py-1">
    <Text className="w-16 text-[14px] leading-[19px] text-staff-muted">{label}</Text>
    <Text className="flex-1 text-[14px] font-medium leading-[19px] text-staff-ink">{value}</Text>
  </View>
)

/** Adds a weekly rule: the plant is closed on this weekday between the dates. */
export const WeeklyRuleFormScreen: React.FC<{ params: { earliest: string } }> = ({ params }) => {
  const { can, pop } = useStaff()
  const notify = useToast()
  const earliest = params.earliest
  const [weekday, setWeekday] = useState('4')
  const [from, setFrom] = useState(earliest)
  const [to, setTo] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const result = await api.post<{ rule: WeeklyRule; removedChecks: number }>('/api/weekly-rules', {
        weekday: Number(weekday),
        effectiveFrom: from,
        effectiveTo: to || null,
        note: note.trim() || null
      })
      notify('success', 'Weekly rule added', `Closed every ${WEEKDAY_NAMES[result.rule.weekday]} from ${shortDate(result.rule.effectiveFrom)}.${rulesRemovedText(result.removedChecks)}`)
      pop()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  if (!can('calendar', 'manage')) {
    return (
      <Screen title="Add weekly rule">
        <AccessDenied title="You can view weekly rules but not change them." />
      </Screen>
    )
  }

  return (
    <Screen title="Add weekly rule" subtitle="The plant is closed on this weekday between the dates" footer={<PrimaryButton label="Add rule" onPress={save} loading={saving} disabled={!from} />}>
      <FormError message={error} />
      <FormSection title="Closure">
        <SelectField label="Closed every" required value={weekday} options={WEEKDAY_ORDER.map((d) => ({ value: String(d), label: WEEKDAY_NAMES[d] }))} onChange={(v) => v && setWeekday(v)} />
      </FormSection>
      <FormSection title="Dates">
        <DateField
          label="From"
          required
          value={from}
          min={earliest}
          hint={`${shortDate(earliest)} at the earliest`}
          onChange={(v) => {
            setFrom(v)
            if (to && to < v) setTo(v)
          }}
        />
        <DateField label="Until" value={to} min={from} hint="Leave empty for no end date" clearable onChange={setTo} />
      </FormSection>
      <FormSection title="Details">
        <Input label="Note" hint="Optional" value={note} maxLength={200} placeholder="e.g. Weekly off" onChangeText={setNote} />
      </FormSection>
    </Screen>
  )
}

/** Sets, changes or removes the end date of a weekly rule; dates already passed keep the rule. */
export const WeeklyRuleEndScreen: React.FC<{ params: { rule: WeeklyRule; earliest: string } }> = ({ params }) => {
  const { can, pop } = useStaff()
  const notify = useToast()
  const { rule, earliest } = params
  const lastAllowed = addDaysKey(earliest, -1)
  const minEnd = rule.effectiveFrom > lastAllowed ? rule.effectiveFrom : lastAllowed
  const [to, setTo] = useState(rule.effectiveTo ?? minEnd)
  const [openEnded, setOpenEnded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const day = WEEKDAY_NAMES[rule.weekday]

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const result = await api.put<{ rule: WeeklyRule; removedChecks: number }>(`/api/weekly-rules/${rule.id}`, { effectiveTo: openEnded ? null : to })
      const saved = result.rule
      notify(
        'success',
        saved.effectiveTo ? 'Weekly rule ends' : 'Weekly rule has no end date',
        saved.effectiveTo
          ? `The last closed ${WEEKDAY_NAMES[saved.weekday]} is ${shortDate(saved.effectiveTo)}. Later ${WEEKDAY_NAMES[saved.weekday]}s are working days.${rulesRemovedText(result.removedChecks)}`
          : `Every ${WEEKDAY_NAMES[saved.weekday]} stays closed.${rulesRemovedText(result.removedChecks)}`
      )
      pop()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  if (!can('calendar', 'manage')) {
    return (
      <Screen title={`End the ${day} rule`}>
        <AccessDenied title="You can view weekly rules but not change them." />
      </Screen>
    )
  }

  return (
    <Screen
      title={`End the ${day} rule`}
      subtitle={`Started ${shortDate(rule.effectiveFrom)}`}
      footer={<PrimaryButton label={openEnded ? 'Remove end date' : 'Save end date'} onPress={save} loading={saving} disabled={!openEnded && !to} />}
    >
      <FormError message={error} />
      <FormSection title="End date">
        {openEnded ? (
          <Notice tone="accent" message={`Every ${day} stays closed with no end date.`} />
        ) : (
          <DateField
            label={`Last closed ${day} on or before`}
            required
            value={to}
            min={minEnd}
            hint={`${shortDate(minEnd)} at the earliest — dates already passed keep this rule`}
            onChange={setTo}
          />
        )}
        {rule.effectiveTo ? <ToggleField label="Remove the end date (keep the rule going)" value={openEnded} onChange={setOpenEnded} /> : null}
      </FormSection>
    </Screen>
  )
}

export const CALENDAR_SCREENS = {
  calendar: CalendarScreen,
  calendarDayForm: CalendarDayFormScreen,
  weeklyRules: WeeklyRulesScreen,
  weeklyRuleForm: WeeklyRuleFormScreen,
  weeklyRuleEnd: WeeklyRuleEndScreen
}
