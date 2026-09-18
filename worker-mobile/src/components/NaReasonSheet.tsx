import React, { useEffect, useState } from 'react'
import { Modal, View, Text, Pressable, ScrollView } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { NaReason } from '../types'
import { Button } from './ui/Button'
import { TextField } from './ui/TextField'
import { FieldLabel } from './ui/FieldLabel'
import { RadioMark } from './RadioMark'
import type { NaChoice } from './ParameterCard'

interface Props {
  visible: boolean
  /** The parameter being marked, shown in the title. */
  parameterName: string
  reasons: NaReason[]
  current: NaChoice | null
  onCancel: () => void
  onConfirm: (choice: NaChoice) => void
}

/**
 * Why a parameter cannot be measured. The reasons are configured by the admin
 * (Monitoring reasons); some of them ask for a remark.
 */
export const NaReasonSheet: React.FC<Props> = ({ visible, parameterName, reasons, current, onCancel, onConfirm }) => {
  const insets = useSafeAreaInsets()
  const [reasonId, setReasonId] = useState<string | null>(null)
  const [remark, setRemark] = useState('')
  const [error, setError] = useState<string | null>(null)

  // Start from what was chosen before, so reopening the sheet shows it.
  useEffect(() => {
    if (!visible) return
    setReasonId(current?.reasonId ?? null)
    setRemark(current?.remark ?? '')
    setError(null)
  }, [visible, current])

  const reason = reasons.find((r) => r.id === reasonId) ?? null

  const confirm = () => {
    if (!reason) return setError('Choose a reason.')
    if (reason.requiresRemark && !remark.trim()) return setError('Please write a remark.')
    onConfirm({ reasonId: reason.id, reasonLabel: reason.label, remark: remark.trim() })
  }

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onCancel}>
      <View className="flex-1 justify-end bg-black/40">
        <Pressable className="flex-1" onPress={onCancel} accessible={false} />
        <View className="max-h-[88%] rounded-t-[24px] bg-canvas px-5 pt-2" style={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}>
          <View className="mb-2 h-1.5 w-10 self-center rounded-full bg-line-strong" />
          <View className="flex-row items-center">
            <Pressable
              onPress={onCancel}
              accessibilityRole="button"
              accessibilityLabel="Cancel"
              className="h-12 min-w-[72px] justify-center active:opacity-50"
            >
              <Text className="text-[17px] text-accent">Cancel</Text>
            </Pressable>
            <Text className="flex-1 text-center text-[17px] font-semibold text-ink">Not applicable</Text>
            <View className="min-w-[72px]" />
          </View>
          <Text className="mb-4 mt-1 text-center text-[15px] text-ink-muted" numberOfLines={2}>
            {parameterName}
          </Text>

          <ScrollView keyboardShouldPersistTaps="handled">
            <Text className="mb-2 px-4 text-[15px] font-semibold text-ink-muted">Reason</Text>
            <View className="overflow-hidden rounded-2xl bg-surface">
              {reasons.map((r, index) => {
                const selected = r.id === reasonId
                return (
                  <React.Fragment key={r.id}>
                    {index > 0 ? <View className="ml-[52px] h-px bg-line" /> : null}
                    <Pressable
                      onPress={() => {
                        setReasonId(r.id)
                        setError(null)
                      }}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: selected }}
                      accessibilityLabel={r.label}
                      className="min-h-[56px] flex-row items-center px-4 py-3 active:bg-subtle"
                    >
                      <RadioMark selected={selected} />
                      <Text className={`ml-3 flex-1 text-[17px] text-ink ${selected ? 'font-semibold' : ''}`}>{r.label}</Text>
                      {r.requiresRemark ? <Text className="ml-2 text-[13px] text-ink-muted">Remark needed</Text> : null}
                    </Pressable>
                  </React.Fragment>
                )
              })}
            </View>

            <View className="mt-6">
              <FieldLabel label="Remark" required={!!reason?.requiresRemark} />
              <TextField
                multiline
                placeholder="Add a remark"
                value={remark}
                invalid={error === 'Please write a remark.'}
                onChangeText={(text) => {
                  setRemark(text)
                  setError(null)
                }}
                accessibilityLabel="Remark"
                variant="outlined"
              />
            </View>

            {error ? <Text className="mt-3 text-[15px] font-medium text-missed">{error}</Text> : null}
          </ScrollView>

          <Button label="Mark not applicable" onPress={confirm} className="mt-5" />
        </View>
      </View>
    </Modal>
  )
}
