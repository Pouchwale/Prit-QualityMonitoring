import React from 'react'
import { Pressable, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Icon, type IconName } from './Icon'
import type { TabKey } from './nav'

/** Outline icon for each tab, and the filled one shown when it is active. */
const TAB_ICON: Record<TabKey, { outline: IconName; filled: IconName }> = {
  home: { outline: 'home-outline', filled: 'home' },
  checks: { outline: 'clipboard-outline', filled: 'clipboard' },
  exceptions: { outline: 'alert-circle-outline', filled: 'alert-circle' },
  reports: { outline: 'bar-chart-outline', filled: 'bar-chart' },
  more: { outline: 'ellipsis-horizontal-circle-outline', filled: 'ellipsis-horizontal-circle' }
}

interface Props {
  tabs: { key: TabKey; label: string }[]
  active: TabKey
  onChange: (key: TabKey) => void
}

/**
 * Bottom navigation of the staff app: icon + label tabs (the worker app keeps components/ui/TabBar).
 * The active tab is the accent colour with a filled icon; the others are a light outline.
 */
export const StaffTabBar: React.FC<Props> = ({ tabs, active, onChange }) => {
  const insets = useSafeAreaInsets()
  return (
    <View className="flex-row border-t border-staff-line bg-staff-card" style={{ paddingBottom: insets.bottom }} accessibilityRole="tablist">
      {tabs.map((tab) => {
        const on = tab.key === active
        return (
          <Pressable
            key={tab.key}
            onPress={() => onChange(tab.key)}
            accessibilityRole="tab"
            accessibilityLabel={tab.label}
            accessibilityState={{ selected: on }} aria-selected={on}
            className="h-[56px] flex-1 items-center justify-center gap-0.5 active:opacity-60"
          >
            <Icon name={on ? TAB_ICON[tab.key].filled : TAB_ICON[tab.key].outline} size={24} color={on ? 'accent' : 'faint'} />
            <Text className={`text-[11px] font-medium leading-[14px] ${on ? 'text-staff-accent' : 'text-staff-muted'}`} numberOfLines={1}>
              {tab.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}
