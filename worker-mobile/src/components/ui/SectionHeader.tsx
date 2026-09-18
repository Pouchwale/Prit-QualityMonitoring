import React from 'react'
import { View, Text } from 'react-native'

interface Props {
  title: string
  detail?: string
  className?: string
  /** "large" for a screen's main groups (e.g. "Due now"), default for grouped-list captions. */
  size?: 'default' | 'large'
}

/** Sentence-case heading above a grouped list. */
export const SectionHeader: React.FC<Props> = ({ title, detail, className = '', size = 'default' }) => (
  <View className={`mb-2 flex-row items-baseline justify-between ${size === 'large' ? 'px-1' : 'px-4'} ${className}`}>
    <Text
      className={size === 'large' ? 'text-[20px] font-semibold tracking-[-0.2px] text-ink' : 'text-[15px] font-semibold text-ink-muted'}
      accessibilityRole="header"
    >
      {title}
    </Text>
    {detail ? <Text className="text-[15px] text-ink-muted">{detail}</Text> : null}
  </View>
)
