import React from 'react'
import Ionicons from '@expo/vector-icons/Ionicons'

/** Any Ionicons glyph name, e.g. "camera-outline". */
export type IconName = React.ComponentProps<typeof Ionicons>['name']

/** Icon colours, matching the worker tokens in tailwind.config.js. */
export const ICON_COLOR = {
  ink: '#1D1D1F',
  secondary: '#48484A',
  muted: '#6E6E73',
  faint: '#8E8E93',
  accent: '#7F3D40',
  white: '#FFFFFF',
  success: '#1E7B34',
  due: '#0B64B8',
  missed: '#C1271D',
  exception: '#A85200',
  failed: '#C1271D'
} as const

export type IconColor = keyof typeof ICON_COLOR

/** Decorative icon. Hidden from screen readers — the surrounding control carries the name. */
export const Icon: React.FC<{ name: IconName; size?: number; color?: IconColor | (string & {}) }> = ({
  name,
  size = 20,
  color = 'ink'
}) => (
  <Ionicons
    name={name}
    size={size}
    color={ICON_COLOR[color as IconColor] ?? color}
    accessible={false}
    accessibilityElementsHidden
    importantForAccessibility="no-hide-descendants"
    aria-hidden
  />
)
