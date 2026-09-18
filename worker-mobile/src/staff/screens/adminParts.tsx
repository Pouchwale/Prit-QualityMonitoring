import React from 'react'
import { Pressable, Text, View } from 'react-native'
import type { Tone } from '../format'
import { Icon, List, type IconName } from '../ui'

/**
 * Small building blocks shared by the admin module screens (machines, check types, users, calendar…):
 * a quiet status label, a summary header for detail screens and a grouped action list.
 */

const DOT: Record<Tone, string> = {
  neutral: 'bg-staff-faint',
  success: 'bg-success',
  due: 'bg-due',
  missed: 'bg-missed',
  exception: 'bg-exception',
  accent: 'bg-staff-accent',
  dark: 'bg-staff-ink'
}

const TEXT: Record<Tone, string> = {
  neutral: 'text-staff-muted',
  success: 'text-success',
  due: 'text-due',
  missed: 'text-missed',
  exception: 'text-exception',
  accent: 'text-staff-accent',
  dark: 'text-staff-ink'
}

/** A quiet status: coloured dot and coloured text. Only shown when the status is worth noticing. */
export const StatusText: React.FC<{ label: string; tone?: Tone }> = ({ label, tone = 'neutral' }) => (
  <View className="flex-row items-center gap-1.5">
    <View className={`h-2 w-2 rounded-full ${DOT[tone]}`} />
    <Text className={`text-[13px] font-semibold leading-[18px] ${TEXT[tone]}`} numberOfLines={1}>
      {label}
    </Text>
  </View>
)

/** Joins the truthy parts with a middle dot, for one-line captions. */
export const facts = (...parts: (string | number | null | undefined | false)[]) =>
  parts.filter((p) => p !== null && p !== undefined && p !== false && p !== '').join(' · ')

/**
 * The top of a detail screen: the record's name large, its key facts as one caption line and a status
 * only when it is not the normal one.
 */
export const SummaryHeader: React.FC<{
  title: string
  caption?: string | null
  status?: { label: string; tone: Tone } | null
  /** Optional leading element, e.g. initials for a person. */
  leading?: React.ReactNode
  children?: React.ReactNode
}> = ({ title, caption, status, leading, children }) => (
  <View className="flex-row items-center gap-3 px-1 pt-1">
    {leading}
    <View className="flex-1 gap-1">
      <Text className="text-[22px] font-semibold leading-[28px] text-staff-ink" numberOfLines={2}>
        {title}
      </Text>
      {caption ? (
        <Text className="text-[13px] leading-[18px] text-staff-muted" numberOfLines={2}>
          {caption}
        </Text>
      ) : null}
      {status ? <StatusText label={status.label} tone={status.tone} /> : null}
      {children}
    </View>
  </View>
)

/** Initials in a soft circle, for rows and headers that stand for a person. */
export const Initials: React.FC<{ name: string; size?: 'sm' | 'lg'; muted?: boolean }> = ({ name, size = 'sm', muted }) => {
  const text =
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]!.toUpperCase())
      .join('') || '?'
  const box = size === 'lg' ? 'h-14 w-14' : 'h-9 w-9'
  const font = size === 'lg' ? 'text-[20px]' : 'text-[14px]'
  return (
    <View className={`items-center justify-center rounded-full ${box} ${muted ? 'bg-staff-fill' : 'bg-staff-accent-soft'}`}>
      <Text className={`font-semibold ${font} ${muted ? 'text-staff-muted' : 'text-staff-accent'}`}>{text}</Text>
    </View>
  )
}

/** A list row for a person: initials, name and one caption line, like the kit's Row. */
export const PersonRow: React.FC<{
  name: string
  title?: string
  subtitle?: string | null
  right?: React.ReactNode
  muted?: boolean
  onPress?: () => void
  accessibilityLabel?: string
}> = ({ name, title, subtitle, right, muted, onPress, accessibilityLabel }) => {
  const content = (
    <View className="min-h-[60px] flex-row items-center gap-3 px-4 py-2.5">
      <Initials name={name} muted={muted} />
      <View className="flex-1">
        <Text className={`text-[15px] font-semibold leading-[20px] ${muted ? 'text-staff-muted' : 'text-staff-ink'}`} numberOfLines={1}>
          {title ?? name}
        </Text>
        {subtitle ? (
          <Text className="mt-0.5 text-[13px] leading-[18px] text-staff-muted" numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right}
      {onPress ? <Icon name="chevron-forward" size={18} color="faint" /> : null}
    </View>
  )
  return onPress ? (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? title ?? name} className="active:bg-staff-fill">
      {content}
    </Pressable>
  ) : (
    content
  )
}

/** A white inset-grouped list of actions (rows separated by hairlines). Put danger actions last. */
export const ActionGroup: React.FC<{ children: React.ReactNode }> = ({ children }) => <List>{children}</List>

/** One action inside an ActionGroup. Danger actions are red text without a chevron. */
export const ActionItem: React.FC<{
  label: string
  onPress: () => void
  description?: string | null
  tone?: 'default' | 'danger'
  icon?: IconName
  right?: React.ReactNode
  disabled?: boolean
  accessibilityLabel?: string
}> = ({ label, onPress, description, tone = 'default', icon, right, disabled, accessibilityLabel }) => {
  const danger = tone === 'danger'
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: !!disabled }}
      aria-disabled={!!disabled}
      className={`min-h-[52px] flex-row items-center gap-3 px-4 py-3 active:bg-staff-fill ${disabled ? 'opacity-40' : ''}`}
    >
      {icon ? <Icon name={icon} size={20} color={danger ? 'missed' : 'accent'} /> : null}
      <View className="flex-1">
        <Text className={`text-[16px] leading-[21px] ${danger ? 'text-missed' : 'text-staff-ink'}`}>{label}</Text>
        {description ? <Text className="mt-0.5 text-[13px] leading-[18px] text-staff-muted">{description}</Text> : null}
      </View>
      {right}
      {danger ? null : <Icon name="chevron-forward" size={18} color="faint" />}
    </Pressable>
  )
}
