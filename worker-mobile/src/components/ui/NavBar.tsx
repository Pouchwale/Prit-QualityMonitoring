import React from 'react'
import { View, Text, Pressable } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

interface Props {
  leftLabel: string
  onLeftPress: () => void
  title?: string
  rightLabel?: string
  onRightPress?: () => void
  rightTone?: 'accent' | 'exception'
}

export const NavBar: React.FC<Props> = ({
  leftLabel,
  onLeftPress,
  title,
  rightLabel,
  onRightPress,
  rightTone = 'accent'
}) => {
  const insets = useSafeAreaInsets()

  return (
    <View className="border-b border-line bg-canvas" style={{ paddingTop: insets.top }}>
      <View className="h-12 flex-row items-center justify-between px-2">
        <Pressable
          onPress={onLeftPress}
          accessibilityRole="button"
          className="h-11 min-w-[88px] justify-center px-3 active:opacity-50"
        >
          <Text className="text-[17px] text-accent">{leftLabel}</Text>
        </Pressable>

        {title ? (
          <Text className="flex-1 text-center text-[17px] font-semibold text-ink" numberOfLines={1}>
            {title}
          </Text>
        ) : (
          <View className="flex-1" />
        )}

        <View className="min-w-[88px] items-end">
          {rightLabel && onRightPress ? (
            <Pressable
              onPress={onRightPress}
              accessibilityRole="button"
              className="h-11 justify-center px-3 active:opacity-50"
            >
              <Text
                className={`text-[17px] font-medium ${rightTone === 'exception' ? 'text-exception' : 'text-accent'}`}
              >
                {rightLabel}
              </Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    </View>
  )
}
