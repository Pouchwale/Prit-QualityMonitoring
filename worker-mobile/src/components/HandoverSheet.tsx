import React, { useEffect, useMemo, useState } from 'react'
import { Modal, View, Text, Pressable, ScrollView, ActivityIndicator } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ApiError, getHandoverOptions, handoverJob } from '../services/api'
import { HandoverOptions, Job } from '../types'
import { formatClockRange } from '../utils/datetime'
import { Button } from './ui/Button'
import { TextField } from './ui/TextField'
import { FieldLabel } from './ui/FieldLabel'
import { RadioMark } from './RadioMark'

interface Props {
  visible: boolean
  job: Job
  onCancel: () => void
  /** The job was handed over to this worker. */
  onDone: (toName: string, movedChecks: number) => void
}

/**
 * Handover Job: choose the next shift and the worker who takes the job over. The job stays
 * running; it and its open checks move to that worker, who is notified.
 */
export const HandoverSheet: React.FC<Props> = ({ visible, job, onCancel, onDone }) => {
  const insets = useSafeAreaInsets()
  const [options, setOptions] = useState<HandoverOptions | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [shiftId, setShiftId] = useState<string | null>(null)
  const [workerId, setWorkerId] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)

  useEffect(() => {
    if (!visible) return
    setWorkerId(null)
    setNote('')
    setError(null)
    setLoadError(null)
    getHandoverOptions(job.id)
      .then((o) => {
        setOptions(o)
        // With a single shift there is nothing to choose.
        setShiftId(o.shifts.length === 1 ? o.shifts[0].id : null)
      })
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : 'Please try again.'))
  }, [visible, job.id])

  // Workers of the chosen shift first; the others stay available (e.g. covering a colleague).
  const workers = useMemo(() => {
    const list = options?.workers ?? []
    if (!shiftId) return list
    return [...list.filter((w) => w.shiftId === shiftId), ...list.filter((w) => w.shiftId !== shiftId)]
  }, [options, shiftId])
  const shiftName = (id: string | null) => options?.shifts.find((s) => s.id === id)?.name ?? null

  const confirm = async () => {
    if (!shiftId) return setError('Choose the next shift.')
    if (!workerId) return setError('Choose the worker who takes over.')
    setSending(true)
    setError(null)
    try {
      const result = await handoverJob(job.id, { toUserId: workerId, shiftId, note: note.trim() })
      onDone(options?.workers.find((w) => w.id === workerId)?.name ?? 'the next worker', result.movedChecks)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Please try again.')
    } finally {
      setSending(false)
    }
  }

  const row = (key: string, label: string, detail: string | null, selected: boolean, onPress: () => void, index: number) => (
    <React.Fragment key={key}>
      {index > 0 ? <View className="ml-[52px] h-px bg-line" /> : null}
      <Pressable
        onPress={onPress}
        accessibilityRole="radio"
        accessibilityState={{ checked: selected }}
        accessibilityLabel={label}
        className="min-h-[56px] flex-row items-center px-4 py-3 active:bg-subtle"
      >
        <RadioMark selected={selected} />
        <View className="ml-3 flex-1">
          <Text className={`text-[17px] text-ink ${selected ? 'font-semibold' : ''}`}>{label}</Text>
          {detail ? <Text className="text-[13px] text-ink-muted">{detail}</Text> : null}
        </View>
      </Pressable>
    </React.Fragment>
  )

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onCancel}>
      <View className="flex-1 justify-end bg-black/40">
        <Pressable className="flex-1" onPress={onCancel} accessible={false} />
        <View className="max-h-[90%] rounded-t-[24px] bg-canvas px-5 pt-2" style={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}>
          <View className="mb-2 h-1.5 w-10 self-center rounded-full bg-line-strong" />
          <View className="flex-row items-center">
            <Pressable onPress={onCancel} accessibilityRole="button" accessibilityLabel="Cancel" className="h-12 min-w-[72px] justify-center active:opacity-50">
              <Text className="text-[17px] text-accent">Cancel</Text>
            </Pressable>
            <Text className="flex-1 text-center text-[17px] font-semibold text-ink">Handover job</Text>
            <View className="min-w-[72px]" />
          </View>
          <Text className="mb-4 mt-1 text-center text-[15px] text-ink-muted" numberOfLines={2}>
            Job No. {job.jobNo}
            {job.itemCode ? ` · ${job.itemCode}` : ''} stays running with its history
          </Text>

          {loadError ? (
            <Text className="mb-4 text-[15px] text-missed">{loadError}</Text>
          ) : !options ? (
            <ActivityIndicator className="my-8" />
          ) : (
            <ScrollView keyboardShouldPersistTaps="handled">
              <Text className="mb-2 px-4 text-[15px] font-semibold text-ink-muted">Next shift</Text>
              <View className="overflow-hidden rounded-2xl bg-surface">
                {options.shifts.map((s, i) =>
                  row(s.id, s.name, formatClockRange(s.startTime, s.endTime), s.id === shiftId, () => {
                    setShiftId(s.id)
                    setError(null)
                  }, i)
                )}
              </View>

              <Text className="mb-2 mt-6 px-4 text-[15px] font-semibold text-ink-muted">Worker who takes over</Text>
              {workers.length === 0 ? (
                <Text className="px-4 text-[15px] leading-[20px] text-ink-muted">
                  No other worker is assigned to this machine. Ask your supervisor to assign one in Machine Assignment.
                </Text>
              ) : (
                <View className="overflow-hidden rounded-2xl bg-surface">
                  {workers.map((w, i) =>
                    row(
                      w.id,
                      w.name,
                      [w.employeeId, shiftName(w.shiftId)].filter(Boolean).join(' · '),
                      w.id === workerId,
                      () => {
                        setWorkerId(w.id)
                        setError(null)
                      },
                      i
                    )
                  )}
                </View>
              )}

              <View className="mt-6">
                <FieldLabel label="Note for the next worker" />
                <TextField multiline placeholder="e.g. Roll 3 running, ink topped up" value={note} onChangeText={setNote} accessibilityLabel="Note for the next worker" variant="outlined" maxLength={500} />
              </View>
              {error ? <Text className="mt-3 text-[15px] font-medium text-missed">{error}</Text> : null}
            </ScrollView>
          )}

          <Button label="Hand over job" icon="swap-horizontal-outline" onPress={confirm} loading={sending} disabled={!options} className="mt-5" />
        </View>
      </View>
    </Modal>
  )
}
