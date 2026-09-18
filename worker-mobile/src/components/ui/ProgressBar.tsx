import React, { useEffect } from 'react'
import { View, Text } from 'react-native'
import { ICON_COLOR as COLOR } from './Icon'
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'

interface Props {
  /** Items finished. */
  done: number
  total: number
  /** Shown above the bar, e.g. "3 of 7 done". */
  label?: string
  /** Text on the right of the label, e.g. "Readings". */
  detail?: string
}

/** How far through a form the worker is: a slim bar that eases to its new width. */
export const ProgressBar: React.FC<Props> = ({ done, total, label, detail }) => {
  const percent = total > 0 ? Math.round((Math.min(done, total) / total) * 100) : 0
  const complete = total > 0 && done >= total
  const width = useSharedValue(percent)

  useEffect(() => {
    // withTiming follows the system "reduce motion" setting by default.
    width.value = withTiming(percent, { duration: 220 })
  }, [percent, width])

  const fill = useAnimatedStyle(() => ({ width: `${width.value}%` }))

  return (
    <View accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: total, now: Math.min(done, total) }}>
      {label ? (
        <View className="mb-2 flex-row items-baseline justify-between">
          <Text className={`text-[15px] font-semibold ${complete ? 'text-success' : 'text-ink-secondary'}`}>{label}</Text>
          {detail ? <Text className="text-[13px] text-ink-muted">{detail}</Text> : null}
        </View>
      ) : null}
      <View className="h-1.5 overflow-hidden rounded-full bg-line">
        <Animated.View style={[{ height: 6, borderRadius: 999, backgroundColor: complete ? COLOR.success : COLOR.accent }, fill]} />
      </View>
    </View>
  )
}
