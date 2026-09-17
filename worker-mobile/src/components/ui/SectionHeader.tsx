import React from 'react'
import { View, Text } from 'react-native'

interface Props {
  title: string
  detail?: string
  className?: string
}

export const SectionHeader: React.FC<Props> = ({ title, detail, className = '' }) => (
  <View className={`mb-2 flex-row items-baseline justify-between px-4 ${className}`}>
    <Text className="text-[12px] font-medium uppercase tracking-[0.6px] text-ink-muted">{title}</Text>
    {detail ? <Text className="text-[13px] text-ink-muted">{detail}</Text> : null}
  </View>
)
