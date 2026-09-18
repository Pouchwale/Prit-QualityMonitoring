import React from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { Icon, ICON_COLOR, type IconName } from './Icon'

/**
 * primary   filled accent, one per screen
 * tinted    accent-soft fill with accent text (secondary action)
 * secondary grey fill with ink text
 * plain     accent text only (tertiary)
 * warning / warningOutline: kept for older callers; drawn as the exception tint.
 */
type Variant = 'primary' | 'tinted' | 'secondary' | 'plain' | 'destructive' | 'warning' | 'warningOutline'

const CONTAINER: Record<Variant, string> = {
  primary: 'bg-accent active:bg-accent-press',
  tinted: 'bg-accent-soft active:opacity-80',
  secondary: 'bg-subtle active:opacity-80',
  plain: 'bg-transparent active:opacity-60',
  destructive: 'bg-missed-bg active:opacity-80',
  warning: 'bg-exception-bg active:opacity-80',
  warningOutline: 'bg-exception-bg active:opacity-80'
}

const LABEL: Record<Variant, string> = {
  primary: 'text-white',
  tinted: 'text-accent',
  secondary: 'text-ink',
  plain: 'text-accent',
  destructive: 'text-missed',
  warning: 'text-exception',
  warningOutline: 'text-exception'
}

const TINT: Record<Variant, string> = {
  primary: ICON_COLOR.white,
  tinted: ICON_COLOR.accent,
  secondary: ICON_COLOR.ink,
  plain: ICON_COLOR.accent,
  destructive: ICON_COLOR.missed,
  warning: ICON_COLOR.exception,
  warningOutline: ICON_COLOR.exception
}

interface Props {
  label: string
  onPress: () => void
  /** Screen-reader name when the visible label needs more context, e.g. which check type. */
  accessibilityLabel?: string
  variant?: Variant
  loading?: boolean
  disabled?: boolean
  /** Optional leading icon (Ionicons outline). */
  icon?: IconName
  /** "compact" is 48 tall for secondary actions; default is 52. */
  size?: 'default' | 'compact'
  className?: string
}

export const Button: React.FC<Props> = ({
  label,
  onPress,
  accessibilityLabel,
  variant = 'primary',
  loading = false,
  disabled = false,
  icon,
  size = 'default',
  className = ''
}) => (
  <Pressable
    onPress={onPress}
    disabled={disabled || loading}
    accessibilityRole="button"
    accessibilityLabel={accessibilityLabel ?? label}
    accessibilityState={{ disabled: disabled || loading, busy: loading }}
    className={`${size === 'compact' ? 'h-12' : 'h-[52px]'} flex-row items-center justify-center rounded-[14px] px-5 ${CONTAINER[variant]} ${disabled ? 'opacity-40' : ''} ${className}`}
  >
    {loading ? (
      <View className="mr-2">
        <ActivityIndicator color={TINT[variant]} />
      </View>
    ) : icon ? (
      <View className="mr-2">
        <Icon name={icon} size={20} color={TINT[variant]} />
      </View>
    ) : null}
    <Text className={`text-[17px] font-semibold ${LABEL[variant]}`} numberOfLines={1}>
      {label}
    </Text>
  </Pressable>
)
