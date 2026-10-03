import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native'
import { api } from '../services/api'
import { useQuery, errorText } from './useQuery'
import { formatBytes, formatDateTime, plural } from './format'
import { FormError, Icon, Input, Notice, PrimaryButton, Sheet, SmallButton } from './ui'

/**
 * Permanent delete of users, jobs and quality checks, the same flow as the web panel
 * (admin-web/src/components/common/DeleteRecordsModal.tsx) on the same backend
 * (backend/src/routes/deletions.ts):
 *
 *   1. POST /api/deletions/:type/impact  the server works out what would be deleted and what blocks it
 *   2. POST /api/deletions/:type         deletes with a reason; bulk also needs "DELETE <count>"
 *                                        and, above the threshold, a second confirmation
 *
 * The Super Admin always has the delete permissions; an Admin only those a Super Admin granted;
 * Managers and Workers none. This only decides what the app shows: the backend checks the
 * permission again on every request and answers 403 without it.
 */
export type DeletePermission = 'DELETE_USERS' | 'DELETE_JOBS' | 'DELETE_CHECKS'
export type DeletePermissions = Record<DeletePermission, boolean>
export type DeleteType = 'users' | 'jobs' | 'checks'

export const DELETE_PERMISSIONS: DeletePermission[] = ['DELETE_USERS', 'DELETE_JOBS', 'DELETE_CHECKS']
export const DELETE_PERMISSION_LABEL: Record<DeletePermission, string> = {
  DELETE_USERS: 'Delete Users',
  DELETE_JOBS: 'Delete Jobs',
  DELETE_CHECKS: 'Delete Checks'
}
/** Most records one bulk delete may take; the server refuses more. */
export const MAX_BULK = 200

const NONE: DeletePermissions = { DELETE_USERS: false, DELETE_JOBS: false, DELETE_CHECKS: false }

export function useDeletePermissions(): DeletePermissions {
  const { data } = useQuery<{ permissions: DeletePermissions }>('/api/deletions/permissions')
  return data?.permissions ?? NONE
}

interface ImpactItem {
  id: string
  name: string
  details: { label: string; value: string }[]
  status: string
  dependents: { label: string; count: number }[]
  preserved: { label: string; count: number }[]
  files: number
  fileBytes: number
  blockers: string[]
}

interface Impact {
  type: DeleteType
  permission: DeletePermission
  items: ImpactItem[]
  missing: string[]
  totals: { records: number; files: number; fileBytes: number; dependents: { label: string; count: number }[] }
  blocked: number
  needsSecondConfirmation: boolean
  thresholds: { records: number; files: number }
  impactToken: string
}

export interface DeleteResult {
  deleted: number
  filesRemoved: number
  filesNotRemoved: string[]
}

// ---------------------------------------------------------------------------- selection

/**
 * Selection for bulk delete. Only records currently listed count: one that is filtered away drops
 * out of the selection, so nothing hidden is ever deleted. There is no "select everything".
 */
export function useSelection(visibleIds: string[]) {
  const [active, setActive] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const visibleKey = visibleIds.join(',')
  const selected = useMemo(() => {
    const visible = new Set(visibleKey ? visibleKey.split(',') : [])
    return [...picked].filter((id) => visible.has(id))
  }, [picked, visibleKey])
  const toggle = useCallback((id: string) => {
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else if (next.size < MAX_BULK) next.add(id)
      return next
    })
  }, [])
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => picked.has(id))
  const toggleAll = useCallback(() => setPicked(allSelected ? new Set() : new Set(visibleIds.slice(0, MAX_BULK))), [allSelected, visibleIds])
  const stop = useCallback(() => {
    setActive(false)
    setPicked(new Set())
  }, [])
  return { active, start: () => setActive(true), stop, selected, isSelected: (id: string) => picked.has(id), toggle, toggleAll, allSelected, selectable: (id: string) => visibleIds.includes(id) }
}

/** The tick shown on a row while selecting. */
export const SelectMark: React.FC<{ selected: boolean; disabled?: boolean }> = ({ selected, disabled }) => (
  <Icon name={disabled ? 'remove-circle-outline' : selected ? 'checkmark-circle' : 'ellipse-outline'} size={26} color={disabled ? 'faint' : selected ? 'missed' : 'faint'} />
)

/** Pinned at the bottom while selecting: count, Select shown / Clear, Delete selected. */
export const SelectionFooter: React.FC<{
  count: number
  noun: [string, string]
  allSelected: boolean
  onToggleAll: () => void
  onCancel: () => void
  onDelete: () => void
}> = ({ count, noun, allSelected, onToggleAll, onCancel, onDelete }) => (
  <View className="gap-2">
    <View className="flex-row items-center justify-between">
      <Text className="text-[15px] font-semibold text-staff-ink" accessibilityLiveRegion="polite">
        {count} {count === 1 ? noun[0] : noun[1]} selected{count >= MAX_BULK ? ` (most at once: ${MAX_BULK})` : ''}
      </Text>
      <Pressable onPress={onToggleAll} accessibilityRole="button" className="h-11 justify-center px-1 active:opacity-60">
        <Text className="text-[15px] font-semibold text-staff-accent">{allSelected ? 'Clear' : 'Select shown'}</Text>
      </Pressable>
    </View>
    <View className="flex-row gap-2">
      <SmallButton label="Cancel" onPress={onCancel} className="flex-1" />
      <SmallButton label="Delete selected" tone="danger" icon="trash-outline" onPress={onDelete} disabled={count === 0} className="flex-1" />
    </View>
  </View>
)

// ---------------------------------------------------------------------------- the delete sheet

const NOUN: Record<DeleteType, [string, string]> = {
  users: ['user', 'users'],
  jobs: ['job', 'jobs'],
  checks: ['quality check', 'quality checks']
}
const STATUS_LABEL: Record<string, string> = {
  PLANNED: 'Planned',
  STARTING: 'Starting',
  ACTIVE: 'Active',
  ENDING: 'Ending',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
  PENDING: 'Pending',
  DUE: 'Due',
  IN_PROGRESS: 'In progress',
  MISSED: 'Missed',
  EXCEPTION: 'Exception',
  DISABLED: 'Disabled'
}
const statusText = (s: string) => STATUS_LABEL[s] ?? s
const showValue = (v: string) => (/^\d{4}-\d{2}-\d{2}T/.test(v) ? formatDateTime(v) : v)

const Counts: React.FC<{ title: string; rows: { label: string; count: number }[] }> = ({ title, rows }) => {
  const shown = rows.filter((r) => r.count > 0)
  if (!shown.length) return null
  return (
    <View className="gap-1">
      <Text className="text-[14px] font-semibold text-staff-ink2">{title}</Text>
      {shown.map((r) => (
        <View key={r.label} className="flex-row justify-between border-b border-staff-line py-1">
          <Text className="text-[14px] text-staff-muted">{r.label}</Text>
          <Text className="text-[14px] font-semibold text-staff-ink">{r.count}</Text>
        </View>
      ))}
    </View>
  )
}

/**
 * The permanent-delete sheet: shows the server's delete impact (record, what goes with it,
 * evidence files and size, blockers, required permission), asks for a reason and, for bulk
 * deletes, "DELETE <count>" and a second confirmation above the threshold.
 */
export const DeleteSheet: React.FC<{
  type: DeleteType
  ids: string[]
  bulk?: boolean
  onClose: () => void
  onDeleted: (result: DeleteResult) => void
  /** Users only: offered when the account has history and can only be disabled. */
  onDisableInstead?: () => void
}> = ({ type, ids, bulk = false, onClose, onDeleted, onDisableInstead }) => {
  const [impact, setImpact] = useState<Impact | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [typed, setTyped] = useState('')
  const [step, setStep] = useState<'review' | 'large'>('review')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const idsKey = ids.join(',')
  // The sheet's content scrolls within a fixed share of the screen, so the footer button always shows.
  const { height: windowHeight } = useWindowDimensions()

  const load = useCallback(async () => {
    setLoadError(null)
    setError(null)
    setStep('review')
    try {
      setImpact(await api.post<Impact>(`/api/deletions/${type}/impact`, { ids: idsKey.split(',') }))
    } catch (err) {
      setImpact(null)
      setLoadError(errorText(err))
    }
  }, [type, idsKey])
  useEffect(() => {
    load()
  }, [load])

  const [one, many] = NOUN[type]
  const count = ids.length
  const phrase = `DELETE ${count}`
  const ready = !!impact && impact.blocked === 0 && impact.missing.length === 0 && impact.items.length > 0
  const canDelete = ready && reason.trim().length > 0 && (!bulk || typed.trim() === phrase)
  const single = !bulk ? impact?.items[0] : undefined
  const historyBlock = type === 'users' && !!impact?.items.some((i) => i.blockers.some((b) => /production history/.test(b)))

  const submit = async () => {
    if (!impact) return
    if (bulk && impact.needsSecondConfirmation && step === 'review') return setStep('large')
    setBusy(true)
    setError(null)
    try {
      const result = await api.post<DeleteResult>(`/api/deletions/${type}`, {
        ids,
        reason: reason.trim(),
        impactToken: impact.impactToken,
        bulk,
        ...(bulk ? { confirmation: typed.trim(), confirmLarge: step === 'large' } : {})
      })
      onDeleted(result)
      onClose()
    } catch (err) {
      setError(errorText(err))
      setStep('review')
    } finally {
      setBusy(false)
    }
  }

  const title = bulk ? `Delete ${count} ${count === 1 ? one : many}` : `Delete ${one}`
  const footer =
    step === 'large' ? (
      <View className="flex-row gap-2">
        <SmallButton label="Back" onPress={() => setStep('review')} disabled={busy} className="flex-1" />
        <SmallButton label={`Yes, delete ${impact?.totals.records ?? count}`} tone="danger" onPress={submit} loading={busy} className="flex-1" />
      </View>
    ) : (
      <PrimaryButton label={bulk ? `Delete ${count} ${count === 1 ? one : many}` : `Delete ${one}`} tone="danger" icon="trash-outline" onPress={submit} loading={busy} disabled={!canDelete} />
    )

  return (
    <Sheet title={title} onClose={busy ? () => undefined : onClose} closeLabel="Cancel" footer={impact ? footer : undefined}>
      {/* Shrinks inside the sheet so the Delete button in the footer always stays on screen. */}
      <ScrollView className="px-4" style={{ flexGrow: 0, flexShrink: 1, minHeight: 0, maxHeight: Math.round(windowHeight * 0.62) }} contentContainerClassName="gap-4 pb-4" keyboardShouldPersistTaps="handled">
        <Text className="text-[14px] leading-[19px] text-staff-muted">This cannot be undone. The audit log keeps a record of who deleted what and why.</Text>
        {!impact && !loadError ? <Text className="text-[15px] text-staff-muted">Working out what will be deleted…</Text> : null}
        {loadError ? (
          <View className="gap-2">
            <FormError message={loadError} />
            <SmallButton label="Try again" onPress={load} />
          </View>
        ) : null}

        {impact && step === 'large' ? (
          <Notice tone="missed" title="Large deletion: second confirmation" icon="warning-outline">
            <Text className="text-[14px] leading-[19px] text-staff-ink2">
              You are about to permanently delete {impact.totals.records} {many} and {impact.totals.files} evidence files ({formatBytes(impact.totals.fileBytes)}). This is above the
              safety limit of {impact.thresholds.records} records or {impact.thresholds.files} evidence files.{'\n'}Reason: “{reason.trim()}”
            </Text>
          </Notice>
        ) : null}

        {impact && step === 'review' ? (
          <>
            <Notice
              tone="missed"
              icon="warning-outline"
              message={
                type === 'users'
                  ? `The ${count === 1 ? 'account is' : 'accounts are'} removed with ${count === 1 ? 'its' : 'their'} signed-in devices and permissions. Only accounts without production history can be deleted. Audit log entries keep the name and role.`
                  : `The ${count === 1 ? one : many} and everything listed below are removed from the database, and the evidence files are removed from the server. Reports for that period will no longer include ${count === 1 ? 'it' : 'them'}.`
              }
            />
            {impact.missing.length ? <FormError message={`${impact.missing.length} of the selected records no longer exist. Close and select again.`} /> : null}

            {single ? (
              <View className="gap-3">
                <View className="gap-1.5 rounded-xl border border-staff-line p-3">
                  {single.details.map((d) => (
                    <View key={d.label} className="flex-row justify-between gap-3">
                      <Text className="text-[14px] text-staff-muted">{d.label}</Text>
                      <Text className="flex-1 text-right text-[14px] font-medium text-staff-ink">{d.label === 'Status' ? statusText(d.value) : showValue(d.value)}</Text>
                    </View>
                  ))}
                  {type !== 'users' ? (
                    <View className="flex-row justify-between gap-3">
                      <Text className="text-[14px] text-staff-muted">Evidence files</Text>
                      <Text className="text-[14px] font-medium text-staff-ink">
                        {single.files} ({formatBytes(single.fileBytes)})
                      </Text>
                    </View>
                  ) : null}
                </View>
                <Counts title={single.blockers.some((b) => /history/.test(b)) ? 'Linked records' : 'Also deleted'} rows={single.dependents} />
                <Counts title="Kept" rows={single.preserved} />
                {single.blockers.map((b) => (
                  <Text key={b} className="text-[14px] leading-[19px] text-missed">
                    • {b}
                  </Text>
                ))}
              </View>
            ) : (
              <View className="gap-3">
                <View className="flex-row flex-wrap gap-2">
                  {[
                    ['Records', String(impact.totals.records)],
                    ['Evidence files', type === 'users' ? '—' : String(impact.totals.files)],
                    ['File size', type === 'users' ? '—' : formatBytes(impact.totals.fileBytes)],
                    ['Blocked', String(impact.blocked)]
                  ].map(([label, value]) => (
                    <View key={label} className="min-w-[45%] flex-1 rounded-xl bg-staff-fill px-3 py-2">
                      <Text className="text-[12px] text-staff-muted">{label}</Text>
                      <Text className={`text-[17px] font-semibold ${label === 'Blocked' && impact.blocked ? 'text-missed' : 'text-staff-ink'}`}>{value}</Text>
                    </View>
                  ))}
                </View>
                <Counts title="Also deleted" rows={impact.totals.dependents} />
                <View className="rounded-xl border border-staff-line">
                  {impact.items.map((i) => (
                    <View key={i.id} className={`border-b border-staff-line px-3 py-2 ${i.blockers.length ? 'bg-missed-bg' : ''}`}>
                      <Text className="text-[14px] font-medium text-staff-ink" numberOfLines={1}>
                        {i.name} · {statusText(i.status)}
                        {i.files ? ` · ${plural(i.files, 'file')}` : ''}
                      </Text>
                      {i.blockers.map((b) => (
                        <Text key={b} className="text-[13px] leading-[18px] text-missed">
                          {b}
                        </Text>
                      ))}
                    </View>
                  ))}
                </View>
              </View>
            )}

            {impact.blocked ? (
              <Notice tone="missed" title={bulk ? `${impact.blocked} of the selected records cannot be deleted` : 'This record cannot be deleted'} icon="ban-outline">
                {bulk ? <Text className="text-[14px] text-staff-ink2">Clear those from the selection and try again. Nothing has been deleted.</Text> : null}
                {historyBlock && onDisableInstead ? <SmallButton label="Disable the account instead" onPress={onDisableInstead} className="mt-2 self-start" /> : null}
              </Notice>
            ) : null}

            <Text className="text-[14px] text-staff-muted">
              Required permission: <Text className="font-semibold text-staff-ink2">{DELETE_PERMISSION_LABEL[impact.permission]}</Text>
            </Text>

            {ready ? (
              <>
                <Input label="Reason for deleting" required value={reason} onChangeText={setReason} multiline maxLength={500} placeholder="e.g. Test data created during training" hint="Saved in the audit log." />
                {bulk ? <Input label={`Type ${phrase} to confirm`} value={typed} onChangeText={setTyped} autoCapitalize="characters" maxLength={20} /> : null}
                {bulk && impact.needsSecondConfirmation ? <Text className="text-[14px] text-staff-muted">This is a large deletion. You will be asked to confirm a second time.</Text> : null}
              </>
            ) : null}
          </>
        ) : null}
        <FormError message={error} />
      </ScrollView>
    </Sheet>
  )
}

/** The toast after a delete. */
export const deletedMessage = (result: DeleteResult, noun: [string, string]) => ({
  title: result.deleted === 1 ? `${noun[0][0].toUpperCase()}${noun[0].slice(1)} deleted` : `${result.deleted} ${noun[1]} deleted`,
  message:
    result.filesNotRemoved.length > 0
      ? `${result.filesRemoved} evidence files removed; ${result.filesNotRemoved.length} could not be removed from the server.`
      : `${plural(result.filesRemoved, 'evidence file')} removed. Recorded in the audit log.`
})
