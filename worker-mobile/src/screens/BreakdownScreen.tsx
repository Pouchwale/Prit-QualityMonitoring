import React, { useCallback, useEffect, useRef, useState } from 'react'
import { View, Text, Pressable, Image, RefreshControl, TextInput } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { cancelBreakdown, fileUrl, getMyBreakdowns, getMyMachines, reportBreakdown } from '../services/api'
import { friendlyMessage } from '../utils/friendlyError'
import { showDialog, showError, showSuccess } from '../utils/dialog'
import { resyncLocalAlerts } from '../services/notifications'
import { AssignedMachine, Breakdown, BreakdownStatus, Capture, MyBreakdowns } from '../types'
import { formatDate, formatDateTime, formatTime } from '../utils/datetime'
import { KeyboardAwareScrollView } from '../utils/keyboard'
import { useAutoRefresh } from '../hooks/useAutoRefresh'
import { SectionHeader } from '../components/ui/SectionHeader'
import { ListGroup } from '../components/ui/ListGroup'
import { Button } from '../components/ui/Button'
import { TextField } from '../components/ui/TextField'
import { Icon } from '../components/ui/Icon'
import { EmptyState, ErrorState, Loading } from '../components/ui/LoadState'
import { RadioMark } from '../components/RadioMark'
import { EvidenceField } from '../components/EvidenceField'
import { CameraModal } from '../components/CameraModal'
import { PhotoViewer } from '../components/PhotoViewer'

/** Quick picks that fill the reason; "Other" leaves it for the worker to type. */
const QUICK_REASONS = ['Mechanical fault', 'Electrical fault', 'Power cut', 'Material jam', 'Other']

const STATUS: Record<BreakdownStatus, { label: string; box: string; text: string }> = {
  PENDING: { label: 'Waiting', box: 'bg-due-bg', text: 'text-due' },
  APPROVED: { label: 'Approved', box: 'bg-success-bg', text: 'text-success' },
  REJECTED: { label: 'Rejected', box: 'bg-missed-bg', text: 'text-missed' },
  CANCELLED: { label: 'Withdrawn', box: 'bg-subtle', text: 'text-ink-muted' }
}

const StatusPill: React.FC<{ status: BreakdownStatus }> = ({ status }) => (
  <View className={`rounded-full px-2.5 py-1 ${STATUS[status].box}`}>
    <Text className={`text-[13px] font-semibold ${STATUS[status].text}`}>{STATUS[status].label}</Text>
  </View>
)

/** "18/09/2026, 2:30 PM – 8:00 PM"; the end gets its date too when it is another day (night shift). */
const period = (b: Breakdown) =>
  `${formatDateTime(b.startedAt)} – ${formatDate(b.startedAt) === formatDate(b.endsAt) ? formatTime(b.endsAt) : formatDateTime(b.endsAt)}`

/** The report that blocks a new one on this machine: waiting, or approved and not over yet. */
const openReport = (items: Breakdown[], machineId: string) =>
  items.find((b) => b.machineId === machineId && (b.status === 'PENDING' || (b.status === 'APPROVED' && new Date(b.endsAt).getTime() > Date.now()))) ?? null

const ReportRow: React.FC<{ b: Breakdown; busy: boolean; onWithdraw: () => void; onOpenPhoto: (uri: string) => void }> = ({ b, busy, onWithdraw, onOpenPhoto }) => {
  const decided = b.status === 'APPROVED' || b.status === 'REJECTED'
  const photo = b.photoUrl ? fileUrl(b.photoUrl) : null
  return (
    <View className="px-4 py-3.5">
      <View className="flex-row items-start">
        {photo ? (
          <Pressable
            onPress={() => onOpenPhoto(photo)}
            accessibilityRole="imagebutton"
            accessibilityLabel={`Breakdown photo of ${b.machineName}, tap to enlarge`}
            className="mr-3 active:opacity-70"
          >
            <Image source={{ uri: photo }} className="h-12 w-12 rounded-[10px] bg-subtle" resizeMode="cover" />
          </Pressable>
        ) : null}
        <View className="flex-1 pr-3">
          <Text className="text-[17px] font-semibold leading-[22px] text-ink" numberOfLines={1}>
            {b.machineName}
          </Text>
          <Text className="mt-0.5 text-[15px] leading-[20px] text-ink-secondary">{b.reason}</Text>
        </View>
        <StatusPill status={b.status} />
      </View>
      {b.remark ? <Text className="mt-1 text-[14px] leading-[19px] text-ink-muted">{b.remark}</Text> : null}
      <Text className="mt-1 text-[14px] text-ink-muted">
        {period(b)}
        {b.shiftName ? ` · ${b.shiftName}` : ''}
      </Text>
      {decided ? (
        <View className="mt-2.5 rounded-xl bg-subtle px-3 py-2.5">
          <Text className="text-[14px] font-semibold text-ink-secondary">
            {b.status === 'APPROVED' ? 'Approved' : 'Rejected'}
            {b.decidedByName ? ` by ${b.decidedByName}` : ''}
            {b.decidedAt ? ` · ${formatDateTime(b.decidedAt)}` : ''}
          </Text>
          {b.decisionComment ? <Text className="mt-0.5 text-[14px] leading-[19px] text-ink-secondary">{b.decisionComment}</Text> : null}
          <Text className="mt-0.5 text-[13px] text-ink-muted">
            {b.status === 'APPROVED' ? `${b.excusedCount} check${b.excusedCount === 1 ? '' : 's'} excused` : 'Missed checks count as usual.'}
          </Text>
        </View>
      ) : null}
      {b.status === 'PENDING' ? (
        <Button
          label="Withdraw"
          variant="destructive"
          size="compact"
          loading={busy}
          accessibilityLabel={`Withdraw breakdown report: ${b.machineName}`}
          onPress={onWithdraw}
          className="mt-3"
        />
      ) : null}
    </View>
  )
}

/**
 * Breakdown tab: report that a machine broke down (machine, reason and a photo taken now as proof),
 * and the worker's reports of the last 30 days. The machine's alerts stop at once; a manager
 * approves or rejects it, and when approved the worker's checks on it until the end of the shift
 * do not count.
 */
export const BreakdownScreen: React.FC<{ refreshKey: number }> = ({ refreshKey }) => {
  const insets = useSafeAreaInsets()
  const [data, setData] = useState<MyBreakdowns | null>(null)
  const [machines, setMachines] = useState<AssignedMachine[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [zoom, setZoom] = useState<string | null>(null)

  // The report form.
  const [machineId, setMachineId] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [photo, setPhoto] = useState<Capture | null>(null)
  const [camera, setCamera] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const reasonRef = useRef<TextInput>(null)

  /** Counts the loads, so an older answer arriving late never replaces a newer one. */
  const requestId = useRef(0)

  const load = useCallback(async () => {
    const id = ++requestId.current
    try {
      const [reports, mine] = await Promise.all([getMyBreakdowns(), getMyMachines()])
      if (id !== requestId.current) return
      setData(reports)
      setMachines(mine)
      setError(null)
    } catch (err) {
      if (id === requestId.current) setError(friendlyMessage(err))
    }
  }, [])

  useEffect(() => {
    load()
  }, [load, refreshKey])

  useAutoRefresh(load)

  // A machine that got an open report meanwhile (e.g. on another phone) can no longer be chosen.
  useEffect(() => {
    if (data && machineId && openReport(data.items, machineId)) setMachineId(null)
  }, [data, machineId])

  const text = reason.trim()
  const ready = !!machineId && text.length >= 3 && !!photo

  const submit = async () => {
    if (!machineId) return setFormError('Choose the machine that broke down.')
    if (text.length < 3) return setFormError('Write the reason (at least 3 characters).')
    if (!photo) return setFormError('Take a photo of the breakdown.')
    setSending(true)
    setFormError(null)
    try {
      const report = await reportBreakdown({ machineId, reason: text, photo })
      setMachineId(null)
      setReason('')
      setPhoto(null)
      await load()
      resyncLocalAlerts()
      showSuccess('Breakdown reported', `Alerts for ${report.machineName} have stopped. Your manager will approve or reject the report.`)
    } catch (err) {
      setFormError(friendlyMessage(err))
      load()
    } finally {
      setSending(false)
    }
  }

  const withdraw = (b: Breakdown) =>
    showDialog('Withdraw this report?', `Alerts for ${b.machineName} start again, and missed checks count as usual.`, [
      { text: 'Keep', style: 'cancel' },
      {
        text: 'Withdraw',
        style: 'destructive',
        onPress: async () => {
          setBusyId(b.id)
          try {
            await cancelBreakdown(b.id)
            resyncLocalAlerts()
          } catch (err) {
            showError(err, { title: 'Not withdrawn' })
          } finally {
            setBusyId(null)
            await load()
          }
        }
      }
    ])

  const shift = data?.shift ?? null

  const form = !data || !machines ? null : !shift ? (
    <View className="flex-row rounded-2xl bg-surface px-4 py-4" accessibilityRole="summary">
      <View className="mr-3 h-10 w-10 items-center justify-center rounded-full bg-subtle">
        <Icon name="moon-outline" size={20} color="secondary" />
      </View>
      <Text className="flex-1 self-center text-[15px] leading-[21px] text-ink-secondary">
        You are not on shift now. A breakdown can only be reported during your shift.
      </Text>
    </View>
  ) : machines.length === 0 ? (
    <EmptyState icon="construct-outline" title="No machine assigned" message="Ask your supervisor to assign your machine." />
  ) : (
    <View className="gap-6">
      <View>
        <SectionHeader title="Machine" />
        <ListGroup inset="radio">
          {machines.map((m) => {
            const open = openReport(data.items, m.id)
            const selected = m.id === machineId
            return (
              <Pressable
                key={m.id}
                onPress={() => {
                  setMachineId(m.id)
                  setFormError(null)
                }}
                disabled={!!open}
                accessibilityRole="radio"
                accessibilityState={{ checked: selected, disabled: !!open }}
                accessibilityLabel={open ? `${m.name}, breakdown already reported` : m.name}
                className="min-h-[56px] flex-row items-center px-4 py-3 active:bg-subtle"
              >
                <View className={open ? 'opacity-40' : ''}>
                  <RadioMark selected={selected} />
                </View>
                <View className="ml-3 flex-1">
                  <Text className={`text-[17px] ${open ? 'text-ink-muted' : 'text-ink'} ${selected ? 'font-semibold' : ''}`}>{m.name}</Text>
                  <Text className="text-[13px] text-ink-muted">
                    {open
                      ? open.status === 'PENDING'
                        ? 'Breakdown reported – waiting for approval'
                        : `Breakdown approved – checks excused until ${formatTime(open.endsAt)}`
                      : m.code}
                  </Text>
                </View>
              </Pressable>
            )
          })}
        </ListGroup>
      </View>

      <View>
        <SectionHeader title="Reason" />
        <View className="flex-row flex-wrap gap-2">
          {QUICK_REASONS.map((label) => {
            const chosen = label !== 'Other' && text === label
            return (
              <Pressable
                key={label}
                onPress={() => {
                  setFormError(null)
                  if (label === 'Other') {
                    setReason('')
                    reasonRef.current?.focus()
                  } else {
                    setReason(label)
                  }
                }}
                accessibilityRole="button"
                accessibilityState={{ selected: chosen }}
                accessibilityLabel={label}
                className={`min-h-[44px] justify-center rounded-xl border px-4 py-2 ${chosen ? 'border-accent bg-accent-soft' : 'border-line bg-surface active:opacity-60'}`}
              >
                <Text className={`text-[16px] ${chosen ? 'font-semibold text-accent' : 'font-medium text-ink'}`}>{label}</Text>
              </Pressable>
            )
          })}
        </View>
        <TextField
          ref={reasonRef}
          placeholder="e.g. Motor stopped, waiting for maintenance"
          value={reason}
          onChangeText={(v) => {
            setReason(v)
            setFormError(null)
          }}
          accessibilityLabel="Reason"
          variant="outlined"
          maxLength={300}
          className="mt-3"
        />
      </View>

      <View>
        <SectionHeader title="Photo" />
        <EvidenceField kind="photo" capture={photo} required highlight={!!machineId && text.length >= 3} onOpenCamera={() => setCamera(true)} />
        {!photo ? <Text className="mt-2 px-4 text-[13px] leading-[18px] text-ink-muted">Take a photo of the breakdown.</Text> : null}
      </View>

      <Text className="px-1 text-[14px] leading-[20px] text-ink-muted">
        Alerts for this machine stop now. Your manager will approve or reject it; if approved, your checks on this machine until the end of your shift (
        {formatTime(shift.end)}) won't count against you.
      </Text>
      {formError ? <Text className="px-1 text-[15px] font-medium text-missed">{formError}</Text> : null}
      <Button label="Report breakdown" icon="construct-outline" onPress={submit} loading={sending} disabled={!ready} />
    </View>
  )

  return (
    <View className="flex-1 bg-canvas" style={{ paddingTop: insets.top }}>
      <KeyboardAwareScrollView
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
        <View className="pb-6 pt-5">
          <Text className="text-[32px] font-bold leading-[38px] tracking-[-0.6px] text-ink" accessibilityRole="header">
            Breakdown
          </Text>
          <Text className="mt-1 text-[15px] text-ink-muted">
            {shift ? `${shift.name} · until ${formatTime(shift.end)}` : 'Report a machine that broke down during your shift'}
          </Text>
        </View>

        {!data || !machines ? (
          error ? (
            <ErrorState message={error} onRetry={load} />
          ) : (
            <Loading />
          )
        ) : (
          <View className="gap-8">
            {form}

            <View>
              <SectionHeader title="My reports" detail={data.items.length ? 'Last 30 days' : undefined} />
              {data.items.length === 0 ? (
                <EmptyState icon="construct-outline" title="No breakdown reports" message="Your reports and your manager's decisions appear here." />
              ) : (
                <ListGroup>
                  {data.items.map((b) => (
                    <ReportRow key={b.id} b={b} busy={busyId === b.id} onWithdraw={() => withdraw(b)} onOpenPhoto={setZoom} />
                  ))}
                </ListGroup>
              )}
            </View>
            {error ? <Text className="px-4 text-[14px] text-missed">Could not refresh: {error}</Text> : null}
          </View>
        )}
      </KeyboardAwareScrollView>

      <CameraModal
        visible={camera}
        mode="photo"
        maxVideoSeconds={60}
        onCancel={() => setCamera(false)}
        onDone={(capture) => {
          setCamera(false)
          setPhoto(capture)
          setFormError(null)
        }}
      />
      <PhotoViewer uri={zoom} label="Breakdown photo" onClose={() => setZoom(null)} />
    </View>
  )
}
