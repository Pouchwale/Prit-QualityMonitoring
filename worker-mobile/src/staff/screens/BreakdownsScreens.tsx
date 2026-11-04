import React, { useMemo, useState } from 'react'
import { Image, Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native'
import type { Breakdown, BreakdownCheck, BreakdownDetail, BreakdownStatus } from '../types'
import { api, fileUrl } from '../../services/api'
import { PhotoViewer } from '../../components/PhotoViewer'
import { useStaff } from '../nav'
import { useQuery, errorText } from '../useQuery'
import { canApproveBreakdowns } from '../permissions'
import { addDaysKey, dateKey, formatDate, formatDateTime, formatTime, plural, type Tone } from '../format'
import {
  AccessDenied,
  Badge,
  Card,
  Chips,
  DataState,
  FormError,
  Input,
  KV,
  List,
  Notice,
  PrimaryButton,
  Row,
  Screen,
  Section,
  Segmented,
  Sheet,
  SmallButton,
  StatusBadge,
  useToast
} from '../ui'

// Same data and rules as the web panel's Machine Breakdowns page (backend routes/breakdowns.ts).

const STATUS: Record<BreakdownStatus, { label: string; tone: Tone }> = {
  PENDING: { label: 'Waiting', tone: 'exception' },
  APPROVED: { label: 'Approved', tone: 'success' },
  REJECTED: { label: 'Rejected', tone: 'missed' },
  CANCELLED: { label: 'Withdrawn', tone: 'neutral' }
}

const DECIDED: BreakdownStatus[] = ['APPROVED', 'REJECTED', 'CANCELLED']

/** "2:30 PM → 8:00 PM", with dates when it is not today or ends another day. */
function period(b: Breakdown) {
  const sameDay = formatDate(b.startedAt) === formatDate(b.endsAt)
  const today = formatDate(new Date()) === formatDate(b.startedAt)
  const start = today ? formatTime(b.startedAt) : formatDateTime(b.startedAt)
  return `${start} → ${sameDay ? formatTime(b.endsAt) : formatDateTime(b.endsAt)}`
}

/** What the report means for the worker's checks. */
const checksLine = (b: Breakdown) =>
  b.status === 'APPROVED' ? `${plural(b.excusedCount, 'check')} excused` : b.status === 'PENDING' ? `${plural(b.affectedCount, 'check')} affected so far` : null

/** Machine breakdowns: Pending (oldest first, waiting for a decision) and Decided (last 30 days). */
export const BreakdownsScreen: React.FC<{ params: { tab?: 'pending' | 'decided' } }> = ({ params }) => {
  const { can, push } = useStaff()
  const [tab, setTab] = useState<'pending' | 'decided'>(params?.tab ?? 'pending')
  const [status, setStatus] = useState<'' | BreakdownStatus>('')
  const allowed = can('breakdowns')
  const pending = useQuery<Breakdown[]>(allowed ? '/api/breakdowns' : null, { status: 'PENDING' })
  const recent = useQuery<Breakdown[]>(allowed && tab === 'decided' ? '/api/breakdowns' : null, { from: addDaysKey(dateKey(), -29), to: dateKey() })
  const decided = useMemo(() => (recent.data ?? []).filter((b) => b.status !== 'PENDING'), [recent.data])

  if (!allowed) {
    return (
      <Screen title="Machine breakdowns">
        <AccessDenied />
      </Screen>
    )
  }

  const current = tab === 'pending' ? pending : recent
  const rows = tab === 'pending' ? pending.data ?? [] : status ? decided.filter((b) => b.status === status) : decided
  const reload = async () => {
    await Promise.all([pending.reload(), tab === 'decided' ? recent.reload() : undefined])
  }

  return (
    <Screen title="Machine breakdowns" onRefresh={reload} refreshing={current.loading && !!current.data}>
      <View className="-mt-2 gap-3">
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: 'pending', label: pending.data ? `Pending (${pending.data.length})` : 'Pending' },
            { value: 'decided', label: 'Decided' }
          ]}
        />
        {tab === 'decided' ? (
          <Chips
            value={status}
            onChange={setStatus}
            options={[
              { value: '' as const, label: 'All', count: decided.length },
              ...DECIDED.map((s) => ({ value: s, label: STATUS[s].label, count: decided.filter((b) => b.status === s).length }))
            ]}
          />
        ) : null}
        <Text className="px-1 text-[13px] leading-[18px] text-staff-muted">
          {tab === 'pending'
            ? 'Reports waiting for a decision, oldest first. Approving excuses the worker’s checks on that machine until the end of their shift.'
            : 'Decided and withdrawn reports of the last 30 days.'}
        </Text>
      </View>
      <DataState
        loading={current.loading}
        error={current.error}
        onRetry={current.reload}
        hasData={!!current.data}
        empty={!!current.data && rows.length === 0}
        emptyTitle={tab === 'pending' ? 'Nothing waiting' : undefined}
        emptyText={tab === 'pending' ? 'No machine breakdown is waiting for a decision.' : 'No decided reports in the last 30 days.'}
        emptyIcon="construct-outline"
      >
        <List>
          {rows.map((b) => (
            <Row
              key={b.id}
              title={`${b.workerName} · ${b.machineName}`}
              subtitle={`${b.reason}${b.remark ? ` — ${b.remark}` : ''}`}
              subtitleLines={2}
              detail={[period(b), checksLine(b)].filter(Boolean).join(' · ')}
              accessibilityLabel={`${b.workerName}, ${b.machineName}, ${STATUS[b.status].label}`}
              right={<Badge label={STATUS[b.status].label} tone={STATUS[b.status].tone} />}
              onPress={() => push('breakdownDetail', { id: b.id })}
            />
          ))}
        </List>
      </DataState>
    </Screen>
  )
}

/** Status of a check in the period: its result, or "Open" while it is not finished. */
const CheckBadge: React.FC<{ check: BreakdownCheck }> = ({ check }) =>
  ['COMPLETED', 'MISSED', 'EXCEPTION', 'EXCUSED'].includes(check.status) ? <StatusBadge status={check.status} /> : <Badge label="Open" />

/** One report: the worker, machine, reason, the checks it covers, and Approve / Reject. */
export const BreakdownDetailScreen: React.FC<{ params: { id: string } }> = ({ params }) => {
  const { profile } = useStaff()
  const notify = useToast()
  const { data, error, loading, reload } = useQuery<BreakdownDetail>(`/api/breakdowns/${params.id}`)
  const [deciding, setDeciding] = useState<'approve' | 'reject' | null>(null)
  const [zoom, setZoom] = useState<string | null>(null)
  const b = data?.breakdown ?? null
  const photo = b?.photoUrl ? fileUrl(b.photoUrl) : null
  const mayDecide = !!b && b.status === 'PENDING' && canApproveBreakdowns(profile)

  return (
    <Screen
      title={b ? b.code : 'Machine breakdown'}
      subtitle={b ? `${b.workerName} · ${b.machineName}` : null}
      onRefresh={reload}
      refreshing={loading && !!data}
      footer={
        mayDecide ? (
          <View className="gap-2">
            <PrimaryButton label="Approve" icon="checkmark-circle-outline" onPress={() => setDeciding('approve')} />
            <SmallButton label="Reject" icon="close-circle-outline" tone="danger" onPress={() => setDeciding('reject')} />
          </View>
        ) : undefined
      }
    >
      {deciding && b ? (
        <DecisionSheet
          breakdown={b}
          approve={deciding === 'approve'}
          onClose={() => setDeciding(null)}
          onDone={(result) => {
            setDeciding(null)
            notify(
              'success',
              result.breakdown.status === 'APPROVED' ? `Approved – ${plural(result.excused, 'check')} excused` : 'Rejected',
              result.breakdown.status === 'APPROVED' ? `${b.workerName}’s checks on ${b.machineName} do not count.` : 'Missed checks count as usual.'
            )
            reload()
          }}
          onStale={reload}
        />
      ) : null}
      <PhotoViewer uri={zoom} label="Breakdown photo" onClose={() => setZoom(null)} />
      <DataState loading={loading} error={error} onRetry={reload} hasData={!!data} empty={!!data && !b} emptyText="This report could not be found." emptyIcon="construct-outline">
        {b && data ? (
          <>
            <Card className="gap-3 p-4">
              <View className="flex-row items-start gap-3">
                <View className="flex-1">
                  <Text className="text-[20px] font-semibold leading-[25px] text-staff-ink">{b.machineName}</Text>
                  <Text className="mt-0.5 text-[15px] leading-[20px] text-staff-muted">
                    {b.workerName} · {b.workerEmployeeId}
                  </Text>
                </View>
                <Badge label={STATUS[b.status].label} tone={STATUS[b.status].tone} />
              </View>
              <View className="rounded-xl bg-exception-bg px-3.5 py-3">
                <Text className="text-[13px] font-medium leading-[18px] text-exception">Reason</Text>
                <Text className="mt-0.5 text-[16px] font-semibold leading-[21px] text-staff-ink">{b.reason}</Text>
                {b.remark ? <Text className="mt-1 text-[14px] leading-[19px] text-staff-ink2">{b.remark}</Text> : null}
              </View>
              {photo ? (
                <Pressable onPress={() => setZoom(photo)} accessibilityRole="imagebutton" accessibilityLabel="Breakdown photo, tap to enlarge" className="active:opacity-80">
                  <Image source={{ uri: photo }} resizeMode="contain" className="h-64 w-full rounded-xl bg-black" accessibilityLabel="Breakdown photo" />
                </Pressable>
              ) : null}
              <Text className="text-[13px] leading-[18px] text-staff-muted">
                Reported {formatDateTime(b.startedAt)} · until {formatDate(b.startedAt) === formatDate(b.endsAt) ? formatTime(b.endsAt) : formatDateTime(b.endsAt)}
                {b.shiftName ? ` (end of ${b.shiftName})` : ''}
              </Text>
            </Card>

            {b.status === 'PENDING' ? (
              <Notice
                tone="due"
                title={`${plural(b.affectedCount, 'check')} would be excused now`}
                message="Approve: the worker’s unsubmitted checks on this machine in this period are excused and leave the score. Reject: nothing changes, missed checks count."
              />
            ) : b.status === 'CANCELLED' ? (
              <Notice title="Withdrawn by the worker" message="Nothing was excused." />
            ) : (
              <Section title="Decision">
                <List>
                  <KV label="Decision" value={<Badge label={STATUS[b.status].label} tone={STATUS[b.status].tone} />} detail={b.decidedAt ? formatDateTime(b.decidedAt) : null} />
                  <KV label="By" value={b.decidedByName} />
                  <KV label="Reason" value={b.decisionComment} stacked />
                  {b.status === 'APPROVED' ? <KV label="Checks excused" value={String(b.excusedCount)} /> : null}
                </List>
              </Section>
            )}

            <Section title="Checks in this period" detail={`${data.checks.length ? plural(data.checks.length, 'check') : 'No checks'} for ${b.workerName} on ${b.machineName}`}>
              {data.checks.length === 0 ? (
                <Notice title="No checks are scheduled for this worker on this machine in this period yet." />
              ) : (
                <List>
                  {data.checks.map((c) => (
                    <Row
                      key={c.id}
                      title={c.activityName}
                      subtitle={`${c.code} · ${formatTime(c.scheduledAt)}${c.submittedAt ? ` · submitted ${formatTime(c.submittedAt)}` : ''}`}
                      accessibilityLabel={`${c.activityName}, ${formatTime(c.scheduledAt)}`}
                      right={<CheckBadge check={c} />}
                    />
                  ))}
                </List>
              )}
            </Section>
          </>
        ) : null}
      </DataState>
    </Screen>
  )
}

/** Approve or reject with a required reason (kept with the report and on every excused check). */
const DecisionSheet: React.FC<{
  breakdown: Breakdown
  approve: boolean
  onClose: () => void
  onDone: (result: { breakdown: Breakdown; excused: number }) => void
  /** Already decided or withdrawn meanwhile: show the latest. */
  onStale: () => void
}> = ({ breakdown, approve, onClose, onDone, onStale }) => {
  const { height } = useWindowDimensions()
  const [comment, setComment] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    if (comment.trim().length < 3) return setError('Give the reason for your decision (at least 3 characters).')
    setSaving(true)
    setError(null)
    try {
      onDone(await api.post<{ breakdown: Breakdown; excused: number }>(`/api/breakdowns/${breakdown.id}/decision`, { approve, comment: comment.trim() }))
    } catch (err) {
      setError(errorText(err))
      onStale()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Sheet
      title={approve ? 'Approve breakdown' : 'Reject breakdown'}
      onClose={saving ? () => undefined : onClose}
      closeLabel="Cancel"
      footer={
        <PrimaryButton
          label={approve ? 'Approve' : 'Reject'}
          tone={approve ? 'primary' : 'danger'}
          icon={approve ? 'checkmark-circle-outline' : 'close-circle-outline'}
          loading={saving}
          onPress={submit}
        />
      }
    >
      <ScrollView className="px-4" style={{ flexGrow: 0, flexShrink: 1, minHeight: 0, maxHeight: Math.round(height * 0.6) }} contentContainerClassName="gap-4 pb-4" keyboardShouldPersistTaps="handled">
        <Text className="text-[14px] leading-[19px] text-staff-muted">
          {breakdown.workerName} · {breakdown.machineName}: {breakdown.reason}.{' '}
          {approve
            ? `Their unsubmitted checks on this machine until ${formatTime(breakdown.endsAt)} are excused and do not count.`
            : 'Nothing changes: missed checks on this machine count as usual.'}
        </Text>
        <Input
          label="Reason for your decision"
          required
          multiline
          value={comment}
          onChangeText={(v) => {
            setComment(v)
            setError(null)
          }}
          placeholder={approve ? 'e.g. Confirmed with maintenance' : 'e.g. Machine was running at 10:30'}
          maxLength={500}
        />
        <FormError message={error} />
      </ScrollView>
    </Sheet>
  )
}

export const BREAKDOWNS_SCREENS = {
  breakdowns: BreakdownsScreen,
  breakdownDetail: BreakdownDetailScreen
}
