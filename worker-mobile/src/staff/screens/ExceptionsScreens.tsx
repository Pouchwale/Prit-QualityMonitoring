import React, { useMemo, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import type { ExceptionRecord, ExceptionStatus } from '../types'
import { api } from '../../services/api'
import { useStaff } from '../nav'
import { useQuery, errorText } from '../useQuery'
import { FilterPanel, todayFilters, type MonitoringFilters } from '../Filters'
import { EXCEPTION_STATUS_LABEL, addDaysKey, dateKey, formatDateTime } from '../format'
import { ActionList, ActionRow, Card, Chips, DataState, EvidenceGallery, FieldLabel, FormError, Icon, Input, KV, List, PrimaryButton, Row, Screen, Section, StatusBadge, useToast } from '../ui'

const STATUSES: ExceptionStatus[] = ['UNDER_REVIEW', 'ACKNOWLEDGED', 'ACTION_TAKEN', 'RESOLVED']

/** Exceptions: checks workers could not perform, with reason, remark and photo. */
export const ExceptionsScreen: React.FC<{ params: { status?: string; from?: string; to?: string } }> = ({ params }) => {
  const { push } = useStaff()
  const [filters, setFilters] = useState<MonitoringFilters>(() => ({
    ...todayFilters(7),
    ...(params?.from && params?.to ? { from: params.from, to: params.to } : {}),
    status: params?.status ?? ''
  }))
  const { data, error, loading, reload } = useQuery<ExceptionRecord[]>('/api/exceptions', { from: filters.from, to: filters.to })
  const all = useMemo(() => data ?? [], [data])
  const rows = filters.status ? all.filter((e) => e.status === filters.status) : all
  const open = all.filter((e) => e.status !== 'RESOLVED').length

  return (
    <Screen title="Exceptions" onRefresh={reload} refreshing={loading && !!data}>
      <View className="-mt-2 gap-3">
        <FilterPanel value={filters} onChange={setFilters} onReset={() => setFilters(todayFilters(7))} fields={[]} />
        <Chips
          value={filters.status}
          onChange={(status) => setFilters({ ...filters, status })}
          options={[{ value: '', label: 'All', count: all.length }, ...STATUSES.map((s) => ({ value: s, label: EXCEPTION_STATUS_LABEL[s], count: all.filter((e) => e.status === s).length, tone: s === 'UNDER_REVIEW' ? ('exception' as const) : undefined }))]}
        />
        {open > 0 ? (
          <Text className="px-1 text-[13px] leading-[18px] text-staff-muted">
            {open} exception{open === 1 ? '' : 's'} not yet resolved in this period.
          </Text>
        ) : null}
      </View>
      <DataState
        loading={loading}
        error={error}
        onRetry={reload}
        hasData={!!data}
        empty={!!data && rows.length === 0}
        emptyText="No exceptions in this period."
        emptyIcon="alert-circle-outline"
      >
        <List>
          {rows.map((e) => (
            <Row
              key={e.id}
              title={e.machineName}
              subtitle={`${e.activityName} · ${e.reason}`}
              detail={`${e.workerName ?? 'Unknown'} · ${formatDateTime(e.createdAt)}${e.media.length ? ' · photo' : ''}`}
              detailLines={1}
              accessibilityLabel={`${e.machineName} · ${e.activityName}`}
              right={<StatusBadge status={e.status} />}
              onPress={() => push('exceptionDetail', { id: e.id, from: dateKey(new Date(e.createdAt)) })}
            />
          ))}
        </List>
      </DataState>
    </Screen>
  )
}

/** Two-column radio choice of review statuses (four labels do not fit a segmented control at 360px). */
const StatusChoice: React.FC<{ value: ExceptionStatus | undefined; onChange: (s: ExceptionStatus) => void }> = ({ value, onChange }) => (
  <View accessibilityRole="radiogroup" accessibilityLabel="Status" className="flex-row flex-wrap gap-2">
    {STATUSES.map((s) => {
      const on = s === value
      return (
        <Pressable
          key={s}
          onPress={() => onChange(s)}
          accessibilityRole="radio"
          accessibilityLabel={EXCEPTION_STATUS_LABEL[s]}
          accessibilityState={{ checked: on }} aria-checked={on}
          className={`min-h-[48px] basis-[47%] flex-grow flex-row items-center gap-2 rounded-xl border px-3 py-1.5 ${on ? 'border-staff-accent bg-staff-accent-soft' : 'border-transparent bg-staff-fill active:bg-staff-press'}`}
        >
          <Icon name={on ? 'checkmark-circle' : 'ellipse-outline'} size={20} color={on ? 'accent' : 'faint'} />
          <Text className={`flex-1 text-[15px] leading-[19px] ${on ? 'font-semibold text-staff-accent' : 'font-medium text-staff-ink'}`} numberOfLines={2}>
            {EXCEPTION_STATUS_LABEL[s]}
          </Text>
        </Pressable>
      )
    })}
  </View>
)

/** One exception with its evidence; users with "manage" review it here. */
export const ExceptionDetailScreen: React.FC<{ params: { id: string; from: string } }> = ({ params }) => {
  const { can, push, pop } = useStaff()
  const notify = useToast()
  const canEdit = can('exceptions', 'manage')
  // The exceptions list is filtered by day; load a small window around the day it was raised.
  const { data, error, loading, reload } = useQuery<ExceptionRecord[]>('/api/exceptions', { from: addDaysKey(params.from, -1), to: addDaysKey(params.from, 1) })
  const record = (data ?? []).find((e) => e.id === params.id) ?? null
  const [status, setStatus] = useState<ExceptionStatus | ''>('')
  const [notes, setNotes] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const currentStatus = (status || record?.status) as ExceptionStatus | undefined
  const currentNotes = notes ?? record?.resolutionNotes ?? ''
  const changed = !!record && (currentStatus !== record.status || currentNotes !== (record.resolutionNotes ?? ''))

  const save = async () => {
    if (!record || !currentStatus) return
    setSaving(true)
    setFormError(null)
    try {
      await api.patch(`/api/exceptions/${record.id}`, { status: currentStatus, resolutionNotes: currentNotes.trim() })
      notify('success', 'Exception updated', `${record.machineName} · ${EXCEPTION_STATUS_LABEL[currentStatus]}`)
      pop()
    } catch (err) {
      setFormError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Screen
      title="Exception"
      subtitle={record ? `${record.checkCode} · ${record.machineName}` : null}
      onRefresh={reload}
      refreshing={loading && !!data}
      footer={canEdit && record && (changed || saving) ? <PrimaryButton label="Save review" icon="checkmark" onPress={save} loading={saving} /> : undefined}
    >
      <DataState loading={loading} error={error} onRetry={reload} hasData={!!data} empty={!!data && !record} emptyText="This exception could not be found." emptyIcon="alert-circle-outline">
        {record ? (
          <>
            <Card className="gap-3 p-4">
              <View className="flex-row items-start gap-3">
                <View className="flex-1">
                  <Text className="text-[20px] font-semibold leading-[25px] text-staff-ink">{record.machineName}</Text>
                  <Text className="mt-0.5 text-[15px] leading-[20px] text-staff-muted">{record.activityName}</Text>
                </View>
                <StatusBadge status={record.status} />
              </View>
              <View className="rounded-xl bg-exception-bg px-3.5 py-3">
                <Text className="text-[13px] font-medium leading-[18px] text-exception">Reason</Text>
                <Text className="mt-0.5 text-[16px] font-semibold leading-[21px] text-staff-ink">{record.reason}</Text>
              </View>
              <Text className="text-[13px] leading-[18px] text-staff-muted">
                Raised {formatDateTime(record.createdAt)} · {record.workerName ?? 'Unknown'}
                {record.reviewedByName ? ` · reviewed by ${record.reviewedByName}` : ''}
              </Text>
            </Card>

            <Section title="Photo">
              <EvidenceGallery media={record.media} workerName={record.workerName} />
            </Section>

            {canEdit ? (
              <Section title="Review">
                <Card className="gap-4 p-4">
                  <FormError message={formError} />
                  <View>
                    <FieldLabel label="Status" required />
                    <StatusChoice value={currentStatus} onChange={setStatus} />
                  </View>
                  <Input
                    label="Resolution notes"
                    value={currentNotes}
                    onChangeText={setNotes}
                    multiline
                    maxLength={1000}
                    hint="What was checked or done about this exception"
                    placeholder="e.g. Machine restarted after maintenance"
                  />
                </Card>
              </Section>
            ) : null}

            <Section title="Details">
              <List>
                <KV label="Status" value={<StatusBadge status={record.status} />} detail={record.reviewedByName ? `by ${record.reviewedByName}` : null} />
                <KV label="Machine" value={record.machineName} detail={record.departmentName} />
                <KV label="Check type" value={record.activityName} />
                <KV label="Worker" value={record.workerName ?? 'Unknown'} detail={record.workerEmployeeId} />
                <KV label="Raised" value={formatDateTime(record.createdAt)} detail={`Slot ${formatDateTime(record.scheduledAt)}`} />
                <KV label="Reason" value={record.reason} />
                <KV label="Worker remark" value={record.remark} stacked />
                <KV label="Resolution" value={record.resolutionNotes} stacked />
              </List>
            </Section>

            {can('checks') || can('dashboard') || can('reports') || can('exceptions') ? (
              <ActionList>
                <ActionRow icon="clipboard-outline" label="Open quality check" description={record.checkCode} onPress={() => push('checkDetail', { id: record.checkId })} />
              </ActionList>
            ) : null}
          </>
        ) : null}
      </DataState>
    </Screen>
  )
}
