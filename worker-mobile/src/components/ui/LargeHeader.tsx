import React from 'react'
import { View, Text } from 'react-native'

interface Props {
  eyebrow?: string
  title: string
  subtitle?: string
  /** Replaces the subtitle line, e.g. an icon plus text. */
  children?: React.ReactNode
}

/** Large title at the top of a tab screen. */
export const LargeHeader: React.FC<Props> = ({ eyebrow, title, subtitle, children }) => (
  <View className="pb-6 pt-5">
    {eyebrow ? <Text className="text-[15px] font-medium text-ink-muted">{eyebrow}</Text> : null}
    <Text className="mt-0.5 text-[32px] font-bold leading-[38px] tracking-[-0.6px] text-ink" accessibilityRole="header">
      {title}
    </Text>
    {subtitle ? <Text className="mt-1 text-[15px] text-ink-secondary">{subtitle}</Text> : null}
    {children}
  </View>
)
