import React from 'react'
import { View, Text, ActivityIndicator } from 'react-native'
import { Button } from './Button'

export const Loading: React.FC = () => (
  <View className="flex-1 items-center justify-center py-16">
    <ActivityIndicator size="large" color="#64748B" />
  </View>
)

export const ErrorState: React.FC<{ message: string; onRetry: () => void }> = ({ message, onRetry }) => (
  <View className="items-center rounded-xl border border-line bg-surface px-6 py-10">
    <Text className="text-center text-[18px] font-semibold text-ink">Could not load</Text>
    <Text className="mt-1.5 text-center text-[16px] text-ink-muted">{message}</Text>
    <Button label="Try Again" variant="secondary" onPress={onRetry} className="mt-6 self-stretch" />
  </View>
)

export const EmptyState: React.FC<{ title: string; message?: string }> = ({ title, message }) => (
  <View className="items-center rounded-xl border border-line bg-surface px-6 py-10">
    <Text className="text-center text-[18px] font-semibold text-ink">{title}</Text>
    {message ? <Text className="mt-1.5 text-center text-[16px] text-ink-muted">{message}</Text> : null}
  </View>
)
