import React from 'react'
import { View, Text, Pressable } from 'react-native'
import { CheckSummary } from '../../types'
import { formatTime } from '../../utils/format'
import { StatusLabel, hasStatusLabel } from './StatusLabel'

interface Props {
  check: CheckSummary
  onPress?: () => void
  /** Replaces the activity name on the second line. */
  detail?: string
}

export const CheckRow: React.FC<Props> = ({ check, onPress, detail }) => {
  const [clock, period] = formatTime(check.scheduledAt).split(' ')

  const content = (
    <View className="min-h-[72px] flex-row items-center px-4 py-3.5">
      <View className="w-[68px]">
        <Text className={`text-[17px] font-semibold ${check.status === 'DUE' ? 'text-accent' : 'text-ink'}`}>{clock}</Text>
        {period ? <Text className="text-[13px] text-ink-muted">{period}</Text> : null}
      </View>

      <View className="flex-1">
        <Text className="text-[17px] font-semibold text-ink" numberOfLines={1}>
          {check.machineName}
        </Text>
        <View className="mt-1 flex-row items-center">
          <StatusLabel status={check.status} />
          {hasStatusLabel(check.status) ? <Text className="mx-1.5 text-[14px] text-ink-faint">·</Text> : null}
          <Text className="flex-1 text-[14px] text-ink-muted" numberOfLines={1}>
            {detail ?? check.activityName}
          </Text>
        </View>
      </View>

      {onPress ? <Text className="ml-2 text-[24px] text-ink-faint">›</Text> : null}
    </View>
  )

  if (!onPress) return content

  return (
    <Pressable onPress={onPress} accessibilityRole="button" className="active:bg-subtle">
      {content}
    </Pressable>
  )
}
