import React from 'react'
import { View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

/** Bottom-pinned bar that holds a screen's primary action. */
export const ActionBar: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const insets = useSafeAreaInsets()

  return (
    <View className="border-t border-line bg-surface px-5 pt-3" style={{ paddingBottom: Math.max(insets.bottom, 14) }}>
      {children}
    </View>
  )
}
