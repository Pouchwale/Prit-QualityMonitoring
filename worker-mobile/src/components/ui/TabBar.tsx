import React from 'react'
import { View, Text, Pressable } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

interface Tab<T extends string> {
  key: T
  label: string
}

interface Props<T extends string> {
  tabs: Tab<T>[]
  active: T
  onChange: (key: T) => void
}

export const TabBar = <T extends string>({ tabs, active, onChange }: Props<T>) => {
  const insets = useSafeAreaInsets()

  return (
    <View className="flex-row border-t border-line bg-surface" style={{ paddingBottom: insets.bottom }}>
      {tabs.map((tab) => {
        const isActive = tab.key === active
        return (
          <Pressable
            key={tab.key}
            onPress={() => onChange(tab.key)}
            accessibilityRole="tab"
            accessibilityState={{ selected: isActive }}
            className="h-14 flex-1 items-center justify-center active:opacity-60"
          >
            <View className={`absolute top-0 h-0.5 w-12 rounded-full ${isActive ? 'bg-accent' : 'bg-transparent'}`} />
            <Text className={`text-[15px] ${isActive ? 'font-semibold text-ink' : 'font-medium text-ink-muted'}`}>
              {tab.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}
