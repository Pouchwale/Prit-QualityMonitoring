import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { View, Text, ScrollView, Pressable, Platform, RefreshControl } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { DayPart, LeaveOverview, LeaveStatus, MyLeaveRequest, MyShiftChange } from '../types'
import { applyForLeave, cancelLeaveRequest, cancelShiftChange, getLeaveOverview, previewLeave, requestShiftChange } from '../services/api'
import { dateKey, formatDateKey, parseDateKey } from '../utils/dates'
import { formatClockRange, formatDateTime } from '../utils/datetime'
import { friendlyMessage } from '../utils/friendlyError'
import { showDialog, showError, showSuccess } from '../utils/dialog'
import { useAutoRefresh } from '../hooks/useAutoRefresh'
import { DatePicker } from '../components/DatePicker'
import { KeyboardAwareScrollView } from '../utils/keyboard'
import { ActionBar } from '../components/ui/ActionBar'
import { Button } from '../components/ui/Button'
import { FieldLabel } from '../components/ui/FieldLabel'
import { Icon } from '../components/ui/Icon'
import { ListGroup } from '../components/ui/ListGroup'
import { EmptyState, ErrorState, Loading } from '../components/ui/LoadState'
import { NavBar } from '../components/ui/NavBar'
import { SectionHeader } from '../components/ui/SectionHeader'
import { TextField } from '../components/ui/TextField'

/**
 * The worker's leave: balance, apply for leave, request a shift change for some dates, their
 * requests (cancel) and history. Rules are checked again by the server (backend services/leave.ts).
 */

type Mode = 'home' | 'apply' | 'shift'
type AnyMine = (MyLeaveRequest & { kind: 'leave' }) | (MyShiftChange & { kind: 'shift' })

const STATUS: Record<LeaveStatus, { label: string; box: string; text: string }> = {
  PENDING: { label: 'Pending', box: 'bg-due-bg', text: 'text-due' },
  APPROVED: { label: 'Approved', box: 'bg-success-bg', text: 'text-success' },
  REJECTED: { label: 'Rejected', box: 'bg-missed-bg', text: 'text-missed' },
  CANCELLED: { label: 'Cancelled', box: 'bg-subtle', text: 'text-ink-muted' }
}

const StatusPill: React.FC<{ status: LeaveStatus }> = ({ status }) => (
  <View className={`rounded-full px-2.5 py-1 ${STATUS[status].box}`}>
    <Text className={`text-[13px] font-semibold ${STATUS[status].text}`}>{STATUS[status].label}</Text>
  </View>
)

const range = (a: string, b: string) => (a === b ? formatDateKey(a) : `${formatDateKey(a)} – ${formatDateKey(b)}`)
const num = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1))
const days = (n: number) => `${num(n)} ${n === 1 ? 'day' : 'days'}`
const shiftTime = (r: string) => {
  const [a, b] = r.split('–')
  return formatClockRange(a, b)
}

const Chip: React.FC<{ label: string; detail?: string; selected: boolean; onPress: () => void }> = ({ label, detail, selected, onPress }) => (
  <Pressable
    onPress={onPress}
    accessibilityRole="radio"
    accessibilityState={{ checked: selected }}
    accessibilityLabel={detail ? `${label}, ${detail}` : label}
    className={`min-h-[48px] justify-center rounded-xl border px-4 py-2 ${selected ? 'border-accent bg-accent-soft' : 'border-line bg-surface active:opacity-60'}`}
  >
    <Text className={`text-[16px] ${selected ? 'font-semibold text-accent' : 'font-medium text-ink'}`}>{label}</Text>
    {detail ? <Text className="text-[13px] text-ink-muted">{detail}</Text> : null}
  </Pressable>
)

/** A date field: the browser's date input on the web, a row that opens the date picker on phones. */
const DateField: React.FC<{ label: string; value: string; min?: string; max?: string; onChange: (key: string) => void }> = ({ label, value, min, max, onChange }) => {
  const [open, setOpen] = useState(false)
  const minimumDate = min ? parseDateKey(min) : undefined
  const maximumDate = max ? parseDateKey(max) : undefined
  if (Platform.OS === 'web') {
    return (
      <View className="flex-1">
        <Text className="mb-1.5 text-[13px] font-semibold text-ink-muted">{label}</Text>
        <DatePicker value={parseDateKey(value)} minimumDate={minimumDate} maximumDate={maximumDate} onChange={(d) => onChange(dateKey(d))} />
      </View>
    )
  }
  return (
    <View className="flex-1">
      <Text className="mb-1.5 text-[13px] font-semibold text-ink-muted">{label}</Text>
      <Pressable
        onPress={() => setOpen(!open)}
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${formatDateKey(value)}`}
        className={`h-[52px] flex-row items-center justify-between rounded-xl border px-4 ${open ? 'border-accent bg-surface' : 'border-transparent bg-subtle'}`}
      >
        <Text className="text-[17px] text-ink">{formatDateKey(value)}</Text>
        <Icon name="calendar-outline" size={20} color="muted" />
      </Pressable>
      {open ? (
        <DatePicker
          value={parseDateKey(value)}
          minimumDate={minimumDate}
          maximumDate={maximumDate}
          onChange={(d) => {
            onChange(dateKey(d))
            if (Platform.OS === 'android') setOpen(false)
          }}
          onDismiss={() => setOpen(false)}
        />
      ) : null}
    </View>
  )
}

// ---------------------------------------------------------------------------- Apply for leave

const ApplyLeave: React.FC<{ data: LeaveOverview; onDone: () => void; onBack: () => void }> = ({ data, onDone, onBack }) => {
  const today = dateKey(new Date())
  const [typeId, setTypeId] = useState(data.types[0]?.id ?? '')
  const [dayPart, setDayPart] = useState<DayPart>('FULL')
  const [start, setStart] = useState(today)
  const [end, setEnd] = useState(today)
  const [reason, setReason] = useState('')
  const [customType, setCustomType] = useState('')
  const [preview, setPreview] = useState<{ days: number; skipped: number } | { error: string } | null>(null)
  const [sending, setSending] = useState(false)
  const type = data.types.find((t) => t.id === typeId)
  const balance = data.balances.find((b) => b.leaveTypeId === typeId)
  const half = dayPart !== 'FULL'
  const earliest = dateKey(new Date(Date.now() - data.rules.maxPastDays * 86_400_000))

  // Half days: one date. A type without half days goes back to a full day.
  useEffect(() => {
    if (type && !type.allowHalfDay && half) setDayPart('FULL')
  }, [type, half])
  useEffect(() => {
    if (half && end !== start) setEnd(start)
    if (end < start) setEnd(start)
  }, [half, start, end])

  // What the server would count (and whether it would refuse), while the form is filled in.
  useEffect(() => {
    if (!typeId) return
    let live = true
    const t = setTimeout(() => {
      previewLeave({ leaveTypeId: typeId, dayPart, startDate: start, endDate: half ? start : end })
        .then((p) => live && setPreview(p))
        .catch((err) => live && setPreview({ error: friendlyMessage(err) }))
    }, 250)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [typeId, dayPart, start, end, half])

  const submit = async () => {
    if (!type) return
    if (type.isCustom && customType.trim().length < 2) return showDialog('Enter the leave name', 'Type what kind of leave you need, e.g. Marriage leave.', [], 'warning')
    if (reason.trim().length < 3) return showDialog('Write a reason', 'Tell your supervisor why you need the leave.', [], 'warning')
    setSending(true)
    try {
      const saved = await applyForLeave({ leaveTypeId: type.id, dayPart, startDate: start, endDate: half ? start : end, reason: reason.trim(), customType: type.isCustom ? customType.trim() : undefined }, null)
      showSuccess('Leave applied', `${saved.leaveTypeName}, ${range(saved.startDate, saved.endDate)} (${days(saved.days)}). You get a notification when it is approved or rejected.`, onDone)
    } catch (err) {
      showError(err, { title: 'Leave not applied' })
    } finally {
      setSending(false)
    }
  }

  if (data.types.length === 0) {
    return (
      <View className="flex-1 bg-canvas">
        <NavBar leftLabel="Leave" onLeftPress={onBack} title="Apply for Leave" />
        <View className="p-5">
          <EmptyState icon="calendar-outline" title="No leave types yet" message="Ask your supervisor: leave types are set in the admin panel." />
        </View>
      </View>
    )
  }

  return (
    <View className="flex-1 bg-canvas">
      <NavBar leftLabel="Leave" onLeftPress={onBack} title="Apply for Leave" />
      <KeyboardAwareScrollView className="flex-1" contentContainerClassName="gap-6 px-5 pb-10 pt-5">
        <View>
          <FieldLabel label="Leave type" />
          <View className="gap-2" accessibilityRole="radiogroup">
            {data.types.map((t) => {
              const b = data.balances.find((x) => x.leaveTypeId === t.id)
              return (
                <Chip
                  key={t.id}
                  label={t.isCustom ? t.name : `${t.name} (${t.code})`}
                  detail={[b ? (b.remaining === null ? 'No limit' : `${num(b.remaining)} left`) : null, t.isPaid ? null : 'Unpaid', t.isCustom ? 'Enter your own leave name' : null].filter(Boolean).join(' · ')}
                  selected={typeId === t.id}
                  onPress={() => setTypeId(t.id)}
                />
              )
            })}
          </View>
        </View>

        <View>
          <FieldLabel label="Duration" />
          <View className="flex-row flex-wrap gap-2" accessibilityRole="radiogroup">
            <Chip label="Full Day" selected={dayPart === 'FULL'} onPress={() => setDayPart('FULL')} />
            {type?.allowHalfDay ? (
              <>
                <Chip label="First Half" selected={dayPart === 'FIRST_HALF'} onPress={() => setDayPart('FIRST_HALF')} />
                <Chip label="Second Half" selected={dayPart === 'SECOND_HALF'} onPress={() => setDayPart('SECOND_HALF')} />
              </>
            ) : null}
          </View>
        </View>

        <View>
          <View className="flex-row gap-3">
            <DateField label={half ? 'Date' : 'From'} value={start} min={earliest} onChange={setStart} />
            {!half ? <DateField label="To" value={end} min={start} onChange={setEnd} /> : null}
          </View>
          {preview ? (
            'error' in preview ? (
              <Text className="mt-2 text-[15px] leading-[20px] text-missed" accessibilityLiveRegion="polite">
                {preview.error}
              </Text>
            ) : (
              <Text className="mt-2 text-[15px] leading-[20px] text-ink-secondary" accessibilityLiveRegion="polite">
                <Text className="font-semibold text-ink">{days(preview.days)}</Text> of leave
                {preview.skipped ? ` · ${preview.skipped} weekly off/holiday not counted` : ''}
                {balance && balance.remaining !== null ? ` · ${num(balance.remaining)} left before this` : ''}
              </Text>
            )
          ) : null}
        </View>

        {type?.isCustom ? (
          <View>
            <FieldLabel label="Leave name" hint="Your own type of leave; it goes to your supervisor for approval." />
            <TextField value={customType} onChangeText={setCustomType} maxLength={60} placeholder="e.g. Marriage leave" />
          </View>
        ) : null}

        <View>
          <FieldLabel label="Reason" />
          <TextField value={reason} onChangeText={setReason} multiline maxLength={1000} placeholder="Why you need the leave" />
        </View>

      </KeyboardAwareScrollView>
      <ActionBar>
        <Button label="Apply for Leave" icon="paper-plane-outline" onPress={submit} loading={sending} disabled={!!preview && 'error' in preview} />
      </ActionBar>
    </View>
  )
}

// ---------------------------------------------------------------------------- Shift change

const RequestShift: React.FC<{ data: LeaveOverview; onDone: () => void; onBack: () => void }> = ({ data, onDone, onBack }) => {
  const tomorrow = dateKey(new Date(Date.now() + 86_400_000))
  const today = dateKey(new Date())
  const choices = data.shifts.filter((s) => s.id !== data.currentShiftId)
  const current = data.shifts.find((s) => s.id === data.currentShiftId)
  const [shiftId, setShiftId] = useState(choices[0]?.id ?? '')
  const [start, setStart] = useState(tomorrow)
  const [end, setEnd] = useState(tomorrow)
  const [reason, setReason] = useState('')
  const [sending, setSending] = useState(false)
  useEffect(() => {
    if (end < start) setEnd(start)
  }, [start, end])

  const submit = async () => {
    if (!shiftId) return
    if (reason.trim().length < 3) return showDialog('Write a reason', 'Tell your supervisor why you need the other shift.', [], 'warning')
    setSending(true)
    try {
      const saved = await requestShiftChange({ requestedShiftId: shiftId, startDate: start, endDate: end, reason: reason.trim() }, null)
      showSuccess('Shift change requested', `${saved.requestedShiftName}, ${range(saved.startDate, saved.endDate)}. After these dates you are back on your own shift.`, onDone)
    } catch (err) {
      showError(err, { title: 'Request not sent' })
    } finally {
      setSending(false)
    }
  }

  return (
    <View className="flex-1 bg-canvas">
      <NavBar leftLabel="Leave" onLeftPress={onBack} title="Shift Change" />
      <KeyboardAwareScrollView className="flex-1" contentContainerClassName="gap-6 px-5 pb-10 pt-5">
        <Text className="text-[15px] leading-[21px] text-ink-secondary">
          Your shift: <Text className="font-semibold text-ink">{current ? `${current.name} (${formatClockRange(current.startTime, current.endTime)})` : 'not set'}</Text>. Choose another shift for some dates; afterwards your own shift applies again.
        </Text>
        {choices.length === 0 ? (
          <EmptyState icon="time-outline" title="No other shift to choose" />
        ) : (
          <View>
            <FieldLabel label="Requested shift" />
            <View className="gap-2" accessibilityRole="radiogroup">
              {choices.map((s) => (
                <Chip key={s.id} label={s.name} detail={formatClockRange(s.startTime, s.endTime)} selected={shiftId === s.id} onPress={() => setShiftId(s.id)} />
              ))}
            </View>
          </View>
        )}
        <View>
          <View className="flex-row gap-3">
            <DateField label="From" value={start} min={today} onChange={setStart} />
            <DateField label="To" value={end} min={start} onChange={setEnd} />
          </View>
          <Text className="mt-2 text-[13px] text-ink-muted">At most {data.rules.maxShiftChangeDays} days.</Text>
        </View>
        <View>
          <FieldLabel label="Reason" />
          <TextField value={reason} onChangeText={setReason} multiline maxLength={1000} placeholder="Why you need the other shift" />
        </View>
      </KeyboardAwareScrollView>
      <ActionBar>
        <Button label="Request Shift Change" icon="paper-plane-outline" onPress={submit} loading={sending} disabled={!shiftId} />
      </ActionBar>
    </View>
  )
}

// ---------------------------------------------------------------------------- Overview

const RequestRow: React.FC<{ r: AnyMine; onPress: () => void }> = ({ r, onPress }) => (
  <Pressable onPress={onPress} accessibilityRole="button" className="min-h-[64px] flex-row items-center px-4 py-3 active:bg-subtle">
    <View className={`h-9 w-9 items-center justify-center rounded-full ${r.kind === 'leave' ? 'bg-accent-soft' : 'bg-due-bg'}`}>
      <Icon name={r.kind === 'leave' ? 'calendar-outline' : 'swap-horizontal-outline'} size={18} color={r.kind === 'leave' ? 'accent' : 'due'} />
    </View>
    <View className="ml-3 flex-1">
      <Text className="text-[16px] font-semibold text-ink" numberOfLines={1}>
        {r.kind === 'leave' ? `${r.leaveTypeName}${r.dayPart === 'FULL' ? '' : r.dayPart === 'FIRST_HALF' ? ' · 1st half' : ' · 2nd half'}` : `Shift: ${r.requestedShiftName}`}
      </Text>
      <Text className="text-[14px] text-ink-muted" numberOfLines={1}>
        {range(r.startDate, r.endDate)}
        {r.kind === 'leave' ? ` · ${days(r.days)}` : ''}
      </Text>
    </View>
    <StatusPill status={r.status} />
  </Pressable>
)

/** `onFormChange`: a form is open (the app hides its tab bar, like on a check). */
export const LeaveScreen: React.FC<{ refreshKey?: number; onFormChange?: (open: boolean) => void }> = ({ refreshKey = 0, onFormChange }) => {
  const insets = useSafeAreaInsets()
  const [data, setData] = useState<LeaveOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [mode, setMode] = useState<Mode>('home')
  const [showAll, setShowAll] = useState(false)

  const load = useCallback(async () => {
    try {
      setData(await getLeaveOverview())
      setError(null)
    } catch (err) {
      setError(friendlyMessage(err))
    }
  }, [])
  useEffect(() => {
    load()
  }, [load, refreshKey])
  useAutoRefresh(load, 60_000)
  useEffect(() => {
    onFormChange?.(mode !== 'home')
    return () => onFormChange?.(false)
  }, [mode, onFormChange])

  const today = dateKey(new Date())
  const all: AnyMine[] = useMemo(
    () =>
      data
        ? [...data.leave.map((l) => ({ ...l, kind: 'leave' as const })), ...data.shiftChanges.map((s) => ({ ...s, kind: 'shift' as const }))].sort((a, b) =>
            b.createdAt.localeCompare(a.createdAt)
          )
        : [],
    [data]
  )
  // My requests: waiting, or approved and not over yet. History: everything else.
  const current = all.filter((r) => r.status === 'PENDING' || (r.status === 'APPROVED' && r.endDate >= today))
  const history = all.filter((r) => !current.includes(r))

  const canCancel = (r: AnyMine) => r.status === 'PENDING' || (r.status === 'APPROVED' && !!data?.rules.workerCanCancelApproved && r.startDate > today)

  const cancel = (r: AnyMine) =>
    showDialog('Cancel this request?', r.status === 'APPROVED' ? 'It was approved. Your checks for those days come back.' : undefined, [
      { text: 'Keep', style: 'cancel' },
      {
        text: 'Cancel request',
        style: 'destructive',
        onPress: async () => {
          try {
            if (r.kind === 'leave') await cancelLeaveRequest(r.id)
            else await cancelShiftChange(r.id)
            await load()
          } catch (err) {
            showError(err, { title: 'Not cancelled' })
          }
        }
      }
    ])

  const open = (r: AnyMine) => {
    const lines = [
      r.kind === 'leave' ? `${r.leaveTypeName} (${r.leaveTypeCode}) · ${r.dayPartLabel}` : `${r.currentShiftName ?? 'Your shift'} → ${r.requestedShiftName} (${shiftTime(r.requestedShiftTime)})`,
      `${range(r.startDate, r.endDate)}${r.kind === 'leave' ? ` · ${days(r.days)}` : ''}`,
      `Status: ${STATUS[r.status].label}${r.decidedByName ? ` by ${r.decidedByName}` : ''}${r.decidedAt ? `, ${formatDateTime(r.decidedAt)}` : ''}`,
      r.decisionComment ? `Remarks: ${r.decisionComment}` : null,
      `Reason: ${r.reason}`,
      r.hasAttachment ? `Document: ${r.attachmentName ?? 'attached'}` : null,
      `Applied ${formatDateTime(r.createdAt)}`
    ].filter(Boolean)
    showDialog(r.kind === 'leave' ? 'Leave request' : 'Shift change request', lines.join('\n'), canCancel(r) ? [{ text: 'Close', style: 'cancel' }, { text: 'Cancel request', style: 'destructive', onPress: () => setTimeout(() => cancel(r), 250) }] : [])
  }

  const done = () => {
    setMode('home')
    load()
  }
  if (data && mode === 'apply') return <ApplyLeave data={data} onDone={done} onBack={() => setMode('home')} />
  if (data && mode === 'shift') return <RequestShift data={data} onDone={done} onBack={() => setMode('home')} />

  return (
    <View className="flex-1 bg-canvas" style={{ paddingTop: insets.top }}>
      <ScrollView
        className="flex-1"
        contentContainerClassName="px-5 pb-12"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true)
              await load()
              setRefreshing(false)
            }}
          />
        }
      >
        <View className="pb-5 pt-5">
          <Text className="text-[32px] font-bold leading-[38px] tracking-[-0.6px] text-ink" accessibilityRole="header">
            Leave
          </Text>
          {data ? <Text className="mt-1 text-[15px] text-ink-muted">Leave year {data.year.label}</Text> : null}
        </View>

        {!data ? (
          error ? (
            <ErrorState message={error} onRetry={load} />
          ) : (
            <Loading />
          )
        ) : (
          <View className="gap-8">
            <View className="gap-3">
              <Button label="Apply for Leave" icon="calendar-outline" onPress={() => setMode('apply')} />
              <Button label="Request Shift Change" icon="swap-horizontal-outline" variant="tinted" onPress={() => setMode('shift')} />
            </View>

            <View>
              <SectionHeader title="Leave balance" />
              {data.balances.length === 0 ? (
                <EmptyState icon="calendar-outline" title="No leave types yet" />
              ) : (
                <ListGroup>
                  {data.balances.map((b) => (
                    <View key={b.leaveTypeId} className="min-h-[64px] flex-row items-center px-4 py-3" accessible accessibilityLabel={`${b.name}: ${b.remaining === null ? 'no limit' : `${num(b.remaining)} left`}, ${num(b.used)} used, ${num(b.pending)} pending`}>
                      <View className="flex-1">
                        <Text className="text-[16px] font-semibold text-ink">{b.name}</Text>
                        <Text className="text-[14px] text-ink-muted">
                          {b.allocated === null ? 'No limit' : `${num(b.allocated)} allocated`} · {num(b.used)} used{b.pending ? ` · ${num(b.pending)} pending` : ''}
                          {b.isPaid ? '' : ' · Unpaid'}
                        </Text>
                      </View>
                      <View className="items-end">
                        <Text className="text-[22px] font-bold text-ink">{b.remaining === null ? '∞' : num(b.remaining)}</Text>
                        <Text className="text-[12px] text-ink-muted">left</Text>
                      </View>
                    </View>
                  ))}
                </ListGroup>
              )}
            </View>

            <View>
              <SectionHeader title="My requests" detail={current.length ? String(current.length) : undefined} />
              {current.length === 0 ? (
                <EmptyState icon="file-tray-outline" title="No open requests" message="Pending requests and approved upcoming leave appear here." />
              ) : (
                <ListGroup inset="thumbnail">
                  {current.map((r) => (
                    <RequestRow key={`${r.kind}${r.id}`} r={r} onPress={() => open(r)} />
                  ))}
                </ListGroup>
              )}
            </View>

            <View>
              <SectionHeader title="Leave history" />
              {history.length === 0 ? (
                <EmptyState icon="time-outline" title="Nothing yet" />
              ) : (
                <>
                  <ListGroup inset="thumbnail">
                    {(showAll ? history : history.slice(0, 10)).map((r) => (
                      <RequestRow key={`${r.kind}${r.id}`} r={r} onPress={() => open(r)} />
                    ))}
                  </ListGroup>
                  {history.length > 10 && !showAll ? (
                    <Pressable onPress={() => setShowAll(true)} accessibilityRole="button" className="mt-2 h-11 justify-center self-center active:opacity-50">
                      <Text className="text-[15px] font-semibold text-accent">Show all {history.length}</Text>
                    </Pressable>
                  ) : null}
                </>
              )}
            </View>
          </View>
        )}
      </ScrollView>
    </View>
  )
}
