import React from 'react'
import { View, Text } from 'react-native'

interface Props {
  eyebrow?: string
  title: string
  subtitle?: string
}

export const LargeHeader: React.FC<Props> = ({ eyebrow, title, subtitle }) => (
  <View className="pb-7 pt-4">
    {eyebrow ? (
      <Text className="text-[12px] font-medium uppercase tracking-[0.6px] text-ink-muted">{eyebrow}</Text>
    ) : null}
    <Text className="mt-1 text-[32px] font-bold tracking-[-0.6px] text-ink">{title}</Text>
    {subtitle ? <Text className="mt-1 text-[15px] text-ink-secondary">{subtitle}</Text> : null}
  </View>
)
