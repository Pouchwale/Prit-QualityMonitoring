import React from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'

type Variant = 'primary' | 'warning' | 'warningOutline' | 'secondary'

const CONTAINER: Record<Variant, string> = {
  primary: 'bg-accent',
  warning: 'bg-exception',
  warningOutline: 'border-2 border-exception bg-surface',
  secondary: 'border border-line-strong bg-surface'
}

const LABEL: Record<Variant, string> = {
  primary: 'text-white',
  warning: 'text-white',
  warningOutline: 'text-exception',
  secondary: 'text-ink'
}

interface Props {
  label: string
  onPress: () => void
  variant?: Variant
  loading?: boolean
  disabled?: boolean
  className?: string
}

export const Button: React.FC<Props> = ({
  label,
  onPress,
  variant = 'primary',
  loading = false,
  disabled = false,
  className = ''
}) => (
  <Pressable
    onPress={onPress}
    disabled={disabled || loading}
    accessibilityRole="button"
    accessibilityState={{ disabled: disabled || loading, busy: loading }}
    className={`h-14 flex-row items-center justify-center rounded-xl px-5 active:opacity-80 ${CONTAINER[variant]} ${disabled ? 'opacity-40' : ''} ${className}`}
  >
    {loading ? (
      <View className="mr-2">
        <ActivityIndicator color={variant === 'secondary' ? '#0F172A' : variant === 'warningOutline' ? '#B45309' : '#FFFFFF'} />
      </View>
    ) : null}
    <Text className={`text-[17px] font-semibold ${LABEL[variant]}`}>{label}</Text>
  </Pressable>
)
