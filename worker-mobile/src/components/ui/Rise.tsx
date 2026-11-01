import React, { useEffect } from 'react'
import type { StyleProp, ViewStyle } from 'react-native'
import Animated, { Easing, ReduceMotion, useAnimatedStyle, useSharedValue, withDelay, withTiming } from 'react-native-reanimated'

/**
 * Fades its content in and lifts it a few pixels when it first appears: cards and list groups rise
 * gently as a screen opens. Short (under 0.3 s) and off when the phone is set to reduce motion.
 * (Plain animated values rather than an "entering" animation: on the web app those leave the box
 * positioned on top of what follows.)
 */
export const Rise: React.FC<{ children: React.ReactNode; delay?: number; style?: StyleProp<ViewStyle> }> = ({ children, delay = 0, style }) => {
  const shown = useSharedValue(0)
  useEffect(() => {
    shown.value = withDelay(delay, withTiming(1, { duration: 260, easing: Easing.out(Easing.cubic), reduceMotion: ReduceMotion.System }), ReduceMotion.System)
  }, [delay, shown])
  const rise = useAnimatedStyle(() => ({ opacity: shown.value, transform: [{ translateY: (1 - shown.value) * 10 }] }))
  return <Animated.View style={[style, rise]}>{children}</Animated.View>
}
