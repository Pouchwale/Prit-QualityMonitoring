import React from 'react'
import { Modal, View, Text } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Button } from './ui/Button'
import { Icon } from './ui/Icon'

interface Props {
  visible: boolean
  jobNo: string
  itemCode?: string | null
  ending: boolean
  onContinue: () => void
  onEnd: () => void
}

/**
 * After a scheduled job check: "Continue the job or end the job?". Continue keeps the job running
 * with its scheduled checks; End Job opens the Job End check.
 */
export const ContinueJobSheet: React.FC<Props> = ({ visible, jobNo, itemCode, ending, onContinue, onEnd }) => {
  const insets = useSafeAreaInsets()
  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onContinue}>
      <View className="flex-1 justify-end bg-black/40">
        <View
          className="rounded-t-[24px] bg-canvas px-5 pt-5"
          style={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
          accessibilityViewIsModal
          aria-modal
          role="dialog"
          aria-label="Continue the job or end the job?"
        >
          <View className="items-center">
            <View className="h-14 w-14 items-center justify-center rounded-full bg-accent-soft">
              <Icon name="briefcase-outline" size={28} color="accent" />
            </View>
            <Text className="mt-3 text-center text-[22px] font-bold leading-[28px] text-ink" accessibilityRole="header">
              Continue the job or end the job?
            </Text>
            <Text className="mt-1 text-center text-[16px] text-ink-secondary">
              Job No. {jobNo}
              {itemCode ? ` · ${itemCode}` : ''}
            </Text>
          </View>
          <View className="mt-6 gap-2.5">
            <Button label="Continue Job" icon="play-outline" onPress={onContinue} disabled={ending} />
            <Button label="End Job" icon="stop-circle-outline" variant="secondary" onPress={onEnd} loading={ending} />
          </View>
          <Text className="mt-3 text-center text-[13px] leading-[18px] text-ink-muted">
            End Job opens the Job End check. The job is completed when you submit it.
          </Text>
        </View>
      </View>
    </Modal>
  )
}
