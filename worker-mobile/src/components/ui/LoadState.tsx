import React from 'react'
import { View, Text, ActivityIndicator } from 'react-native'
import { Button } from './Button'
import { Icon, ICON_COLOR, type IconName } from './Icon'

/** Spinner in place of the content that is loading. */
export const Loading: React.FC<{ label?: string }> = ({ label }) => (
  <View className="flex-1 items-center justify-center py-16" accessibilityRole="progressbar" accessibilityLabel={label ?? 'Loading'}>
    <ActivityIndicator size="large" color={ICON_COLOR.muted} />
    {label ? <Text className="mt-3 text-[15px] text-ink-muted">{label}</Text> : null}
  </View>
)

/** Could not load: what went wrong and a way to try again. */
export const ErrorState: React.FC<{ message: string; onRetry: () => void }> = ({ message, onRetry }) => (
  <View className="items-center rounded-2xl bg-surface px-6 py-9">
    <View className="h-14 w-14 items-center justify-center rounded-full bg-subtle">
      <Icon name="cloud-offline-outline" size={26} color="muted" />
    </View>
    <Text className="mt-4 text-center text-[17px] font-semibold text-ink">Could not load</Text>
    <Text className="mt-1 text-center text-[15px] leading-[20px] text-ink-muted">{message}</Text>
    <Button label="Try Again" variant="tinted" size="compact" onPress={onRetry} className="mt-5 self-stretch" />
  </View>
)

/** Nothing to show yet: an icon, one line and, when useful, an action. */
export const EmptyState: React.FC<{
  title: string
  message?: string
  icon?: IconName
  action?: { label: string; onPress: () => void }
}> = ({ title, message, icon = 'file-tray-outline', action }) => (
  <View className="items-center rounded-2xl bg-surface px-6 py-9">
    <View className="h-14 w-14 items-center justify-center rounded-full bg-subtle">
      <Icon name={icon} size={26} color="muted" />
    </View>
    <Text className="mt-4 text-center text-[17px] font-semibold text-ink">{title}</Text>
    {message ? <Text className="mt-1 text-center text-[15px] leading-[20px] text-ink-muted">{message}</Text> : null}
    {action ? (
      <Button label={action.label} variant="tinted" size="compact" onPress={action.onPress} className="mt-5 self-stretch" />
    ) : null}
  </View>
)
