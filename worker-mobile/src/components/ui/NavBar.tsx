import React from 'react'
import { View, Text, Pressable } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Icon } from './Icon'

interface Props {
  /** Where Back goes, e.g. "Machines". Shown next to a back chevron. */
  leftLabel: string
  onLeftPress: () => void
  title?: string
  rightLabel?: string
  onRightPress?: () => void
  rightTone?: 'accent' | 'exception'
  /** Icon shown before the right label. */
  rightIcon?: React.ComponentProps<typeof Icon>['name']
}

/** Top bar of a pushed screen: back link, optional centred title and one text action. */
export const NavBar: React.FC<Props> = ({
  leftLabel,
  onLeftPress,
  title,
  rightLabel,
  onRightPress,
  rightTone = 'accent',
  rightIcon
}) => {
  const insets = useSafeAreaInsets()

  return (
    <View className="border-b border-line bg-canvas" style={{ paddingTop: insets.top }}>
      <View className="h-12 flex-row items-center justify-between px-1.5">
        <Pressable
          onPress={onLeftPress}
          accessibilityRole="button"
          accessibilityLabel={leftLabel}
          className="h-12 min-w-[96px] flex-row items-center pr-3 active:opacity-50"
        >
          <Icon name="chevron-back" size={26} color="accent" />
          <Text className="text-[17px] text-accent">{leftLabel}</Text>
        </Pressable>

        {title ? (
          <Text className="flex-1 text-center text-[17px] font-semibold text-ink" numberOfLines={1}>
            {title}
          </Text>
        ) : (
          <View className="flex-1" />
        )}

        <View className="min-w-[96px] items-end">
          {rightLabel && onRightPress ? (
            <Pressable
              onPress={onRightPress}
              accessibilityRole="button"
              accessibilityLabel={rightLabel}
              className="h-12 flex-row items-center px-3 active:opacity-50"
            >
              {rightIcon ? (
                <View className="mr-1.5">
                  <Icon name={rightIcon} size={20} color={rightTone === 'exception' ? 'exception' : 'accent'} />
                </View>
              ) : null}
              <Text className={`text-[17px] ${rightTone === 'exception' ? 'text-exception' : 'text-accent'}`}>{rightLabel}</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    </View>
  )
}
