import React from 'react'
import { View, Text, Pressable } from 'react-native'
import { CheckSummary } from '../../types'
import { formatTime } from '../../utils/format'
import { StatusLabel, hasStatusLabel } from './StatusLabel'
import { Icon } from './Icon'

interface Props {
  check: CheckSummary
  onPress?: () => void
  /** Replaces the activity name on the second line. */
  detail?: string
}

/** One check in a grouped list: check type and status, time on the right. */
export const CheckRow: React.FC<Props> = ({ check, onPress, detail }) => {
  const time = formatTime(check.submittedAt ?? check.scheduledAt)

  const content = (
    <View className="min-h-[60px] flex-row items-center px-4 py-3">
      <View className="flex-1">
        <Text className="text-[16px] text-ink" numberOfLines={1}>
          {detail ?? check.activityName}
        </Text>
        {hasStatusLabel(check.status) ? (
          <View className="mt-0.5">
            <StatusLabel status={check.status} />
          </View>
        ) : null}
      </View>
      <Text className="ml-3 text-[15px] text-ink-muted">{time}</Text>
      {onPress ? (
        <View className="ml-2">
          <Icon name="chevron-forward" size={18} color="faint" />
        </View>
      ) : null}
    </View>
  )

  if (!onPress) return content

  return (
    <Pressable onPress={onPress} accessibilityRole="button" className="active:bg-subtle">
      {content}
    </Pressable>
  )
}
