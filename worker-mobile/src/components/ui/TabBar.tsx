import React from 'react'
import { View, Text, Pressable } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Icon, type IconName } from './Icon'

interface Tab<T extends string> {
  key: T
  label: string
  /** Outline icon; the filled variant (name without "-outline") is shown when active. */
  icon?: IconName
}

interface Props<T extends string> {
  tabs: Tab<T>[]
  active: T
  onChange: (key: T) => void
}

const filled = (name: IconName) => name.replace(/-outline$/, '') as IconName

/** Bottom tab bar: icon over label, the active tab in the accent colour. */
export const TabBar = <T extends string>({ tabs, active, onChange }: Props<T>) => {
  const insets = useSafeAreaInsets()

  return (
    <View
      className="flex-row border-t border-line bg-surface"
      style={{ paddingBottom: Math.max(insets.bottom, 4) }}
      accessibilityRole="tablist"
    >
      {tabs.map((tab) => {
        const isActive = tab.key === active
        return (
          <Pressable
            key={tab.key}
            onPress={() => onChange(tab.key)}
            accessibilityRole="tab"
            accessibilityLabel={tab.label}
            accessibilityState={{ selected: isActive }}
            className="h-[58px] flex-1 items-center justify-center pt-1 active:opacity-60"
          >
            {tab.icon ? (
              <Icon name={isActive ? filled(tab.icon) : tab.icon} size={24} color={isActive ? 'accent' : 'faint'} />
            ) : null}
            <Text className={`mt-0.5 text-[12px] font-medium ${isActive ? 'text-accent' : 'text-ink-muted'}`}>{tab.label}</Text>
          </Pressable>
        )
      })}
    </View>
  )
}
