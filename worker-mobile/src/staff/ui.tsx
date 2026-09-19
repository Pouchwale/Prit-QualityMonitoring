import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  Switch,
  Text,
  TextInput,
  View,
  type KeyboardTypeOptions
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { VideoView, useVideoPlayer } from 'expo-video'
import { cssInterop } from 'nativewind'
import { DatePicker } from '../components/DatePicker'
import { TimePicker } from '../components/TimePicker'
import { fileUrl } from '../services/api'
import { showDialog } from '../utils/dialog'
import { STATUS_LABEL, TONE_CLASS, dateKey, formatBytes, formatClock, formatDateTime, formatKey, keyToDate, statusTone, type Tone } from './format'
import type { MediaFile } from './types'
import { useStaff } from './nav'
import { ICON_COLOR, Icon, type IconColor, type IconName } from './Icon'

export { Icon, type IconName } from './Icon'

cssInterop(VideoView, { className: 'style' })

/*
 * Staff (Admin / Manager) UI kit. Calm, Apple-inspired: white inset grouped lists on the #F5F5F7
 * page, hairlines inside groups, no shadows, one maroon accent for actions and selection, and
 * status colours only for status. Every colour comes from the tokens in tailwind.config.js.
 */

/** Placeholder text (ink-faint). */
const PLACEHOLDER = ICON_COLOR.faint
/** Switch tracks: accent when on, the field grey when off (tokens staff-primary / staff-field). */
const TRACK_ON = ICON_COLOR.accent
const TRACK_OFF = '#D1D1D6'
const isWeb = Platform.OS === 'web'
const HIT = { top: 4, bottom: 4, left: 4, right: 4 }

/** Tones for leading icons and small dots. */
export type IconTone = 'neutral' | 'accent' | 'success' | 'due' | 'missed' | 'exception' | 'dark'

const ICON_CIRCLE: Record<IconTone, { bg: string; color: IconColor }> = {
  neutral: { bg: 'bg-staff-fill', color: 'ink2' },
  accent: { bg: 'bg-staff-accent-soft', color: 'accent' },
  success: { bg: 'bg-success-bg', color: 'success' },
  due: { bg: 'bg-due-bg', color: 'due' },
  missed: { bg: 'bg-missed-bg', color: 'missed' },
  exception: { bg: 'bg-exception-bg', color: 'exception' },
  dark: { bg: 'bg-staff-primary', color: 'white' }
}

/** Colour of a plain (un-circled) leading icon. Neutral icons stay muted so they never compete with text. */
const PLAIN_ICON: Record<IconTone, IconColor> = {
  neutral: 'muted',
  accent: 'accent',
  success: 'success',
  due: 'due',
  missed: 'missed',
  exception: 'exception',
  dark: 'ink'
}

/** A round tinted icon, for rows whose icon carries a status. */
const IconCircle: React.FC<{ icon: IconName; tone?: IconTone }> = ({ icon, tone = 'neutral' }) => (
  <View className={`h-8 w-8 items-center justify-center rounded-full ${ICON_CIRCLE[tone].bg}`}>
    <Icon name={icon} size={18} color={ICON_CIRCLE[tone].color} />
  </View>
)

/** Hairline between rows of a grouped list, inset from the left edge. */
const Hairline: React.FC<{ inset?: number }> = ({ inset = 16 }) => <View className="h-px bg-staff-line" style={{ marginLeft: inset }} />

const Chevron: React.FC = () => <Icon name="chevron-forward" size={16} color="faint" />

// ---------------------------------------------------------------- layout

export interface HeaderAction {
  label: string
  onPress: () => void
  tone?: 'accent' | 'danger'
  disabled?: boolean
  /** Shows an icon button (named by `label`) instead of a text button. */
  icon?: IconName
}

interface HeaderProps {
  title: string
  subtitle?: string | null
  /** Shows a back button (defaults to the navigator's stack). */
  back?: boolean
  right?: HeaderAction | HeaderAction[] | null
  /** Custom content on the right, after `right` (e.g. a date chip). */
  rightElement?: React.ReactNode
}

/** Plain accent header action: an icon or a word, never a boxed button. */
const HeaderButton: React.FC<{ action: HeaderAction }> = ({ action }) =>
  action.icon ? (
    <IconButton
      icon={action.icon}
      onPress={action.onPress}
      accessibilityLabel={action.label}
      disabled={action.disabled}
      variant="plain"
      tone={action.tone === 'danger' ? 'danger' : 'accent'}
    />
  ) : (
    <Pressable
      onPress={action.onPress}
      disabled={action.disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!action.disabled }} aria-disabled={!!action.disabled}
      hitSlop={HIT}
      className={`h-11 justify-center rounded-xl px-2 active:opacity-60 ${action.disabled ? 'opacity-40' : ''}`}
    >
      <Text className={`text-[17px] font-semibold ${action.tone === 'danger' ? 'text-missed' : 'text-staff-accent'}`}>{action.label}</Text>
    </Pressable>
  )

/** "‹ Back" in the accent colour. Its accessible name is exactly "Back". */
export const BackButton: React.FC<{ onPress: () => void }> = ({ onPress }) => (
  <Pressable
    onPress={onPress}
    accessibilityRole="button"
    accessibilityLabel="Back"
    hitSlop={HIT}
    className="h-11 flex-row items-center pl-1 pr-2 active:opacity-60"
  >
    <Icon name="chevron-back" size={24} color="accent" />
    <Text className="text-[17px] leading-[22px] text-staff-accent">Back</Text>
  </Pressable>
)

/**
 * Screen header. Tab roots get a large title (28/34) on the page background; pushed screens get a
 * slim bar with "‹ Back" and plain accent actions, and a compact title underneath.
 */
export const Header: React.FC<HeaderProps> = ({ title, subtitle, back, right, rightElement }) => {
  const insets = useSafeAreaInsets()
  const nav = useStaff()
  const showBack = back ?? nav.canGoBack
  const actions = right ? (Array.isArray(right) ? right : [right]) : []
  const trailing =
    actions.length || rightElement ? (
      <View className="flex-row items-center gap-1">
        {actions.map((a) => (
          <HeaderButton key={a.label} action={a} />
        ))}
        {rightElement}
      </View>
    ) : null

  if (showBack) {
    return (
      <View className="bg-staff-bg" style={{ paddingTop: insets.top }}>
        <View className="min-h-[48px] flex-row items-center justify-between gap-2 pl-2 pr-3">
          <BackButton onPress={nav.pop} />
          {trailing}
        </View>
        <View className="px-4 pb-2">
          <Text className="text-[22px] font-semibold leading-[28px] text-staff-ink" numberOfLines={2} accessibilityRole="header">
            {title}
          </Text>
          {subtitle ? (
            <Text className="mt-0.5 text-[15px] leading-[20px] text-staff-muted" numberOfLines={2}>
              {subtitle}
            </Text>
          ) : null}
        </View>
      </View>
    )
  }

  return (
    <View className="bg-staff-bg" style={{ paddingTop: insets.top }}>
      <View className="min-h-[64px] flex-row items-end gap-3 px-4 pb-2 pt-4">
        <View className="flex-1">
          <Text className="text-[28px] font-bold leading-[34px] text-staff-ink" numberOfLines={2} accessibilityRole="header">
            {title}
          </Text>
          {subtitle ? (
            <Text className="mt-0.5 text-[15px] leading-[20px] text-staff-muted" numberOfLines={2}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        {trailing}
      </View>
    </View>
  )
}

interface ScreenProps extends HeaderProps {
  children: React.ReactNode
  onRefresh?: () => void | Promise<void>
  refreshing?: boolean
  /** Pinned at the bottom (e.g. a Save button). */
  footer?: React.ReactNode
  /** Content that manages its own scrolling. */
  scroll?: boolean
}

export const Screen: React.FC<ScreenProps> = ({ children, onRefresh, refreshing = false, footer, scroll = true, ...header }) => {
  const insets = useSafeAreaInsets()
  const body = scroll ? (
    <ScrollView
      className="flex-1"
      contentContainerClassName="px-4 pt-2 gap-6"
      contentContainerStyle={{ paddingBottom: footer ? 24 : Math.max(insets.bottom, 16) + 16 }}
      keyboardShouldPersistTaps="handled"
      refreshControl={onRefresh ? <RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} tintColor={ICON_COLOR.muted} /> : undefined}
    >
      {children}
    </ScrollView>
  ) : (
    <View className="flex-1">{children}</View>
  )
  return (
    <KeyboardAvoidingView className="flex-1 bg-staff-bg" behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Header {...header} />
      {body}
      {footer ? (
        <View className="border-t border-staff-line bg-staff-card px-4 pt-3" style={{ paddingBottom: Math.max(insets.bottom, 12) }}>
          {footer}
        </View>
      ) : null}
    </KeyboardAvoidingView>
  )
}

/**
 * A titled block; `seeAll` adds a "See all" link on the right. `small` gives the quiet grouped-list
 * caption (13px muted, inset to line up with the rows) instead of a section heading.
 */
export const Section: React.FC<{
  title?: string
  detail?: string
  action?: React.ReactNode
  seeAll?: { label?: string; onPress: () => void; accessibilityLabel?: string } | null
  small?: boolean
  children: React.ReactNode
}> = ({ title, detail, action, seeAll, small, children }) => (
  <View>
    {title || action || seeAll || detail ? (
      <View className={`mb-2 flex-row items-end justify-between gap-3 ${small ? 'px-4' : ''}`}>
        <View className="flex-1">
          {title ? (
            <Text
              className={small ? 'text-[13px] font-medium leading-[18px] text-staff-muted' : 'text-[20px] font-semibold leading-[25px] text-staff-ink'}
              accessibilityRole="header"
            >
              {title}
            </Text>
          ) : null}
          {detail ? <Text className="mt-0.5 text-[13px] leading-[18px] text-staff-muted">{detail}</Text> : null}
        </View>
        {action}
        {seeAll ? (
          <Pressable
            onPress={seeAll.onPress}
            accessibilityRole="button"
            accessibilityLabel={seeAll.accessibilityLabel ?? seeAll.label ?? 'See all'}
            hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
            className="min-h-[44px] justify-center active:opacity-60"
          >
            <Text className="text-[15px] text-staff-accent">{seeAll.label ?? 'See all'}</Text>
          </Pressable>
        ) : null}
      </View>
    ) : null}
    {children}
  </View>
)

/** White rounded group on the page background. No border, no shadow. */
export const Card: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = '' }) => (
  <View className={`overflow-hidden rounded-2xl bg-staff-card ${className}`}>{children}</View>
)

/** An inset grouped list: one white group whose rows are separated by inset hairlines. */
export const List: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const rows = React.Children.toArray(children).filter(Boolean)
  return (
    <Card>
      {rows.map((row, i) => (
        <React.Fragment key={i}>
          {i > 0 ? <Hairline /> : null}
          {row}
        </React.Fragment>
      ))}
    </Card>
  )
}

interface RowProps {
  title: string
  subtitle?: string | null
  detail?: string | null
  right?: React.ReactNode
  onPress?: () => void
  titleClassName?: string
  accessibilityLabel?: string
  /** Leading icon; pass it only when it helps recognition. */
  icon?: IconName
  iconTone?: IconTone
  /** `plain` (default for neutral icons) or a tinted `circle` (default when a status tone is given). */
  iconVariant?: 'plain' | 'circle'
  /** Caps the detail line count (e.g. a long remark). */
  detailLines?: number
  /** Title lines (default 1). */
  titleLines?: number
  /** Subtitle lines (default 1). */
  subtitleLines?: number
}

export const Row: React.FC<RowProps> = ({
  title,
  subtitle,
  detail,
  right,
  onPress,
  titleClassName = '',
  accessibilityLabel,
  icon,
  iconTone,
  iconVariant,
  detailLines,
  titleLines = 1,
  subtitleLines = 1
}) => {
  const variant = iconVariant ?? (iconTone && iconTone !== 'neutral' ? 'circle' : 'plain')
  const content = (
    <View className="min-h-[52px] flex-row items-center gap-3 px-4 py-3">
      {icon ? variant === 'circle' ? <IconCircle icon={icon} tone={iconTone} /> : <Icon name={icon} size={22} color={PLAIN_ICON[iconTone ?? 'neutral']} /> : null}
      <View className="flex-1">
        <Text className={`text-[16px] font-semibold leading-[21px] text-staff-ink ${titleClassName}`} numberOfLines={titleLines}>
          {title}
        </Text>
        {subtitle ? (
          <Text className="mt-0.5 text-[14px] leading-[19px] text-staff-muted" numberOfLines={subtitleLines}>
            {subtitle}
          </Text>
        ) : null}
        {detail ? (
          <Text className="mt-0.5 text-[13px] leading-[18px] text-staff-muted" numberOfLines={detailLines}>
            {detail}
          </Text>
        ) : null}
      </View>
      {right}
      {onPress ? <Chevron /> : null}
    </View>
  )
  return onPress ? (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? title} className="active:bg-staff-fill">
      {content}
    </Pressable>
  ) : (
    content
  )
}

const DOT: Record<IconTone, string> = {
  neutral: 'bg-staff-faint',
  accent: 'bg-staff-accent',
  success: 'bg-success',
  due: 'bg-due',
  missed: 'bg-missed',
  exception: 'bg-exception',
  dark: 'bg-staff-ink'
}

/**
 * A quiet status label: a soft pill (tinted background + coloured text), or with `dot` a coloured
 * dot followed by coloured text and no background.
 */
export const Badge: React.FC<{ label: string; tone?: Tone; dot?: boolean }> = ({ label, tone = 'neutral', dot }) => {
  const c = TONE_CLASS[tone]
  if (dot) {
    return (
      <View className="flex-row items-center gap-1.5 self-start">
        <View className={`h-2 w-2 rounded-full ${DOT[tone]}`} />
        <Text className={`text-[13px] font-medium leading-[18px] ${tone === 'neutral' ? 'text-staff-muted' : c.text}`} numberOfLines={1}>
          {label}
        </Text>
      </View>
    )
  }
  return (
    <View className={`self-start rounded-full px-2 py-[3px] ${c.bg}`}>
      <Text className={`text-[12px] font-semibold leading-[16px] ${c.text}`} numberOfLines={1}>
        {label}
      </Text>
    </View>
  )
}

export const StatusBadge: React.FC<{ status: string | null | undefined; empty?: string; dot?: boolean }> = ({ status, empty = '—', dot }) =>
  status ? (
    <Badge label={STATUS_LABEL[status.toUpperCase()] ?? status} tone={statusTone(status)} dot={dot} />
  ) : (
    <Text className="text-[14px] text-staff-muted">{empty}</Text>
  )

/** Label / value pairs, e.g. check information. `stacked` puts the label above a long value. */
export const KV: React.FC<{ label: string; value: React.ReactNode; detail?: string | null; stacked?: boolean }> = ({ label, value, detail, stacked }) => {
  const plain = typeof value === 'string' || typeof value === 'number' || value === null || value === undefined
  const body = (
    <>
      {plain ? (
        <Text className="text-[15px] leading-[21px] text-staff-ink">{value === null || value === undefined || value === '' ? '—' : String(value)}</Text>
      ) : (
        value
      )}
      {detail ? <Text className="text-[13px] leading-[18px] text-staff-muted">{detail}</Text> : null}
    </>
  )
  if (stacked) {
    return (
      <View className="px-4 py-3">
        <Text className="mb-0.5 text-[13px] leading-[18px] text-staff-muted">{label}</Text>
        {body}
      </View>
    )
  }
  return (
    <View className="flex-row px-4 py-3">
      <Text className="w-[38%] pr-2 text-[15px] leading-[21px] text-staff-muted">{label}</Text>
      <View className="flex-1">{body}</View>
    </View>
  )
}

const NOTICE_STYLE: Record<Tone, { bg: string; text: string; icon: IconName; color: IconColor }> = {
  neutral: { bg: 'bg-staff-card', text: 'text-staff-ink', icon: 'information-circle-outline', color: 'muted' },
  success: { bg: 'bg-success-bg', text: 'text-success', icon: 'checkmark-circle-outline', color: 'success' },
  due: { bg: 'bg-due-bg', text: 'text-due', icon: 'information-circle-outline', color: 'due' },
  missed: { bg: 'bg-missed-bg', text: 'text-missed', icon: 'warning-outline', color: 'missed' },
  exception: { bg: 'bg-exception-bg', text: 'text-exception', icon: 'warning-outline', color: 'exception' },
  accent: { bg: 'bg-staff-accent-soft', text: 'text-staff-accent', icon: 'information-circle-outline', color: 'accent' },
  dark: { bg: 'bg-staff-accent-soft', text: 'text-staff-accent', icon: 'information-circle-outline', color: 'accent' }
}

export const Notice: React.FC<{ tone?: Tone; title?: string; message?: string | null; icon?: IconName; children?: React.ReactNode }> = ({
  tone = 'neutral',
  title,
  message,
  icon,
  children
}) => {
  const s = NOTICE_STYLE[tone]
  return (
    <View className={`flex-row gap-3 rounded-2xl px-4 py-3 ${s.bg}`} accessibilityRole="summary">
      <View className="pt-px">
        <Icon name={icon ?? s.icon} size={20} color={s.color} />
      </View>
      <View className="flex-1">
        {title ? <Text className={`text-[15px] font-semibold leading-[20px] ${s.text}`}>{title}</Text> : null}
        {message ? <Text className="mt-0.5 text-[14px] leading-[19px] text-staff-ink2">{message}</Text> : null}
        {children}
      </View>
    </View>
  )
}

/** Empty state: an icon, an optional title, one line of text and an optional action. */
export const Empty: React.FC<{ text: string; title?: string; icon?: IconName; action?: { label: string; onPress: () => void; icon?: IconName } | null }> = ({
  text,
  title,
  icon,
  action
}) => (
  <Card>
    <View className="items-center px-6 py-8">
      {icon ? (
        <View className="mb-3 h-12 w-12 items-center justify-center rounded-full bg-staff-fill">
          <Icon name={icon} size={24} color="muted" />
        </View>
      ) : null}
      {title ? <Text className="mb-1 text-center text-[17px] font-semibold leading-[22px] text-staff-ink">{title}</Text> : null}
      <Text className="text-center text-[15px] leading-[21px] text-staff-muted">{text}</Text>
      {action ? <SmallButton label={action.label} icon={action.icon} tone="tinted" onPress={action.onPress} className="mt-4" /> : null}
    </View>
  </Card>
)

/** Grey placeholder rows shown in place of a list while it loads (static, no looping animation). */
export const SkeletonRows: React.FC<{ rows?: number }> = ({ rows = 3 }) => (
  <View accessible accessibilityRole="progressbar" accessibilityLabel="Loading" aria-busy>
    <Card>
      {Array.from({ length: rows }).map((_, i) => (
        <React.Fragment key={i}>
          {i > 0 ? <Hairline /> : null}
          <View className="gap-2 px-4 py-4">
            <View className="h-3.5 rounded-full bg-staff-fill" style={{ width: `${[62, 48, 56][i % 3]}%` }} />
            <View className="h-3 rounded-full bg-staff-fill" style={{ width: `${[38, 30, 44][i % 3]}%` }} />
          </View>
        </React.Fragment>
      ))}
    </Card>
  </View>
)

/** Loading / error / empty wrapper, like the web panel's DataState. */
export const DataState: React.FC<{
  loading: boolean
  error: string | null
  onRetry?: () => void
  empty?: boolean
  emptyText?: string
  emptyTitle?: string
  emptyIcon?: IconName
  emptyAction?: { label: string; onPress: () => void; icon?: IconName } | null
  hasData?: boolean
  /** Skeleton rows (default) or a spinner while loading. */
  loadingVariant?: 'skeleton' | 'spinner'
  children: React.ReactNode
}> = ({ loading, error, onRetry, empty, emptyText = 'Nothing to show', emptyTitle, emptyIcon, emptyAction, hasData, loadingVariant = 'skeleton', children }) => {
  if (error && !hasData) {
    return (
      <Card>
        <View className="items-center px-6 py-8">
          <View className="mb-3 h-12 w-12 items-center justify-center rounded-full bg-missed-bg">
            <Icon name="cloud-offline-outline" size={24} color="missed" />
          </View>
          <Text className="text-center text-[17px] font-semibold leading-[22px] text-staff-ink">Could not load</Text>
          <Text className="mt-1 text-center text-[14px] leading-[19px] text-staff-muted">{error}</Text>
          {onRetry ? <SmallButton label="Try again" icon="refresh-outline" tone="tinted" onPress={onRetry} className="mt-4" /> : null}
        </View>
      </Card>
    )
  }
  if (loading && !hasData) {
    return loadingVariant === 'spinner' ? (
      <View className="items-center py-12">
        <ActivityIndicator color={ICON_COLOR.muted} accessibilityLabel="Loading" />
      </View>
    ) : (
      <SkeletonRows />
    )
  }
  if (empty) return <Empty text={emptyText} title={emptyTitle} icon={emptyIcon} action={emptyAction} />
  return <>{children}</>
}

// On a white card the filled tones (accent, dark) would be white text, so stats use their own colours.
const STAT_TEXT: Record<Tone, string> = {
  neutral: 'text-staff-ink',
  success: 'text-success',
  due: 'text-due',
  missed: 'text-missed',
  exception: 'text-exception',
  accent: 'text-staff-accent',
  dark: 'text-staff-ink'
}

export const Stat: React.FC<{ label: string; value: string | number; hint?: string; tone?: Tone }> = ({ label, value, hint, tone }) => (
  <View className="min-w-[45%] flex-1 rounded-2xl bg-staff-card px-4 py-3.5">
    <Text className="text-[13px] leading-[18px] text-staff-muted">{label}</Text>
    <Text className={`mt-1 text-[24px] font-bold leading-[30px] ${STAT_TEXT[tone ?? 'neutral']}`}>{value}</Text>
    {hint ? <Text className="text-[12px] leading-[16px] text-staff-muted">{hint}</Text> : null}
  </View>
)

/** A thin progress bar in the accent colour (0–100). */
export const ProgressBar: React.FC<{ value: number; accessibilityLabel?: string }> = ({ value, accessibilityLabel }) => {
  const pct = Math.max(0, Math.min(100, value))
  return (
    <View
      className="h-1.5 overflow-hidden rounded-full bg-staff-fill"
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(pct) }}
    >
      <View className="h-1.5 rounded-full bg-staff-accent" style={{ width: `${pct}%` }} />
    </View>
  )
}

/** A small figure with a coloured dot, for a row of figures inside a MetricCard. */
export const MiniStat: React.FC<{ label: string; value: string | number; tone?: IconTone; onPress?: () => void; accessibilityLabel?: string }> = ({
  label,
  value,
  tone = 'neutral',
  onPress,
  accessibilityLabel
}) => {
  const content = (
    <>
      <Text className="text-[22px] font-semibold leading-[28px] text-staff-ink">{value}</Text>
      <View className="flex-row items-center gap-1.5">
        <View className={`h-1.5 w-1.5 rounded-full ${DOT[tone]}`} />
        <Text className="shrink text-[12px] leading-[16px] text-staff-muted" numberOfLines={1}>
          {label}
        </Text>
      </View>
    </>
  )
  return onPress ? (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? `${label}: ${value}`}
      className="min-h-[52px] flex-1 justify-start rounded-xl px-2 py-1.5 active:bg-staff-fill"
    >
      {content}
    </Pressable>
  ) : (
    <View className="min-h-[52px] flex-1 justify-start px-2 py-1.5" accessible accessibilityLabel={accessibilityLabel ?? `${label}: ${value}`}>
      {content}
    </View>
  )
}

/** The main figure of a screen: label, big number, optional thin progress (0–100), mini stats and one action. */
export const MetricCard: React.FC<{
  label: string
  value: string | number
  suffix?: string
  caption?: string | null
  /** Progress bar fill, 0–100. */
  progress?: number | null
  children?: React.ReactNode
  action?: { label: string; onPress: () => void; icon?: IconName } | null
}> = ({ label, value, suffix, caption, progress, children, action }) => (
  <Card className="gap-3 px-4 pb-3 pt-4">
    <View>
      <Text className="text-[15px] font-medium leading-[20px] text-staff-muted">{label}</Text>
      <View className="mt-0.5 flex-row items-baseline">
        <Text className="text-[34px] font-bold leading-[41px] text-staff-ink">{value}</Text>
        {suffix ? <Text className={`text-[17px] font-medium text-staff-muted ${suffix.startsWith('%') ? '' : 'ml-1.5'}`}>{suffix}</Text> : null}
      </View>
      {caption ? <Text className="mt-0.5 text-[14px] leading-[19px] text-staff-muted">{caption}</Text> : null}
    </View>
    {progress != null ? <ProgressBar value={progress} /> : null}
    {children ? <View className="-mx-2 flex-row">{children}</View> : null}
    {action ? <SmallButton label={action.label} icon={action.icon} tone="tinted" onPress={action.onPress} className="h-12" /> : null}
  </Card>
)

/** Signed-in person: initials, name, role and employee ID. */
export const ProfileCard: React.FC<{ name: string; role: string; employeeId?: string | null; onPress?: () => void }> = ({ name, role, employeeId, onPress }) => {
  const initials =
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]!.toUpperCase())
      .join('') || '?'
  const content = (
    <View className="flex-row items-center gap-3.5 px-4 py-3.5">
      <View className="h-14 w-14 items-center justify-center rounded-full bg-staff-accent-soft">
        <Text className="text-[20px] font-semibold text-staff-accent">{initials}</Text>
      </View>
      <View className="flex-1">
        <Text className="text-[17px] font-semibold leading-[22px] text-staff-ink" numberOfLines={1}>
          {name}
        </Text>
        <Text className="mt-0.5 text-[14px] leading-[19px] text-staff-muted" numberOfLines={1}>
          {role}
          {employeeId ? ` · ID ${employeeId}` : ''}
        </Text>
      </View>
      {onPress ? <Chevron /> : null}
    </View>
  )
  return (
    <Card>
      {onPress ? (
        <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={name} className="active:bg-staff-fill">
          {content}
        </Pressable>
      ) : (
        content
      )}
    </Card>
  )
}

/** "Show more" style link at the bottom of a list. */
export const ListFooterLink: React.FC<{ label: string; onPress: () => void; icon?: IconName; accessibilityLabel?: string }> = ({ label, onPress, icon, accessibilityLabel }) => (
  <Pressable
    onPress={onPress}
    accessibilityRole="button"
    accessibilityLabel={accessibilityLabel ?? label}
    className="h-12 flex-row items-center justify-center gap-1 active:bg-staff-fill"
  >
    <Text className="text-[15px] text-staff-accent">{label}</Text>
    {icon ? <Icon name={icon} size={16} color="accent" /> : null}
  </Pressable>
)

/** Plain accent text button (tertiary action), 44pt tall. */
export const LinkButton: React.FC<{ label: string; onPress: () => void; icon?: IconName; accessibilityLabel?: string; className?: string; tone?: 'accent' | 'danger' }> = ({
  label,
  onPress,
  icon,
  accessibilityLabel,
  className = '',
  tone = 'accent'
}) => (
  <Pressable
    onPress={onPress}
    accessibilityRole="button"
    accessibilityLabel={accessibilityLabel ?? label}
    hitSlop={HIT}
    className={`min-h-[44px] flex-row items-center gap-1 active:opacity-60 ${className}`}
  >
    {icon ? <Icon name={icon} size={18} color={tone === 'danger' ? 'missed' : 'accent'} /> : null}
    <Text className={`text-[15px] font-semibold ${tone === 'danger' ? 'text-missed' : 'text-staff-accent'}`}>{label}</Text>
  </Pressable>
)

/** Shared "no permission" state. */
export const AccessDenied: React.FC<{ title?: string; message?: string | null }> = ({
  title = 'You do not have permission for this action',
  message = 'Ask an Admin for access.'
}) => (
  <Card>
    <View className="items-center px-6 py-8" accessibilityRole="summary">
      <View className="mb-3 h-12 w-12 items-center justify-center rounded-full bg-staff-fill">
        <Icon name="lock-closed-outline" size={24} color="muted" />
      </View>
      <Text className="text-center text-[17px] font-semibold leading-[22px] text-staff-ink">{title}</Text>
      {message ? <Text className="mt-1 text-center text-[14px] leading-[19px] text-staff-muted">{message}</Text> : null}
    </View>
  </Card>
)

/** A titled white card grouping form fields. */
export const FormSection: React.FC<{ title: string; description?: string | null; children: React.ReactNode }> = ({ title, description, children }) => (
  <Card className="gap-4 p-4">
    <View>
      <Text className="text-[17px] font-semibold leading-[22px] text-staff-ink" accessibilityRole="header">
        {title}
      </Text>
      {description ? <Text className="mt-0.5 text-[13px] leading-[18px] text-staff-muted">{description}</Text> : null}
    </View>
    {children}
  </Card>
)

// ---------------------------------------------------------------- buttons

/** primary = accent fill · secondary = grey fill · tinted = soft accent · danger = soft red · ghost = accent text. */
type ButtonTone = 'primary' | 'secondary' | 'tinted' | 'danger' | 'ghost'

const SMALL_BUTTON: Record<ButtonTone, { box: string; text: string; icon: IconColor }> = {
  primary: { box: 'bg-staff-primary', text: 'text-white', icon: 'white' },
  secondary: { box: 'bg-staff-fill', text: 'text-staff-ink', icon: 'ink' },
  tinted: { box: 'bg-staff-accent-soft', text: 'text-staff-accent', icon: 'accent' },
  danger: { box: 'bg-missed-bg', text: 'text-missed', icon: 'missed' },
  ghost: { box: '', text: 'text-staff-accent', icon: 'accent' }
}

export const SmallButton: React.FC<{
  label: string
  onPress: () => void
  tone?: ButtonTone
  loading?: boolean
  disabled?: boolean
  className?: string
  accessibilityLabel?: string
  icon?: IconName
}> = ({ label, onPress, tone = 'secondary', loading, disabled, className = '', accessibilityLabel, icon }) => {
  const s = SMALL_BUTTON[tone]
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: !!(disabled || loading), busy: !!loading }} aria-disabled={!!(disabled || loading)} aria-busy={!!loading}
      hitSlop={HIT}
      className={`h-11 flex-row items-center justify-center gap-1.5 rounded-xl px-4 active:opacity-70 ${s.box} ${disabled ? 'opacity-40' : ''} ${className}`}
    >
      {loading ? (
        <ActivityIndicator size="small" color={tone === 'primary' ? ICON_COLOR.white : tone === 'secondary' ? ICON_COLOR.ink : ICON_COLOR.accent} />
      ) : icon ? (
        <Icon name={icon} size={18} color={s.icon} />
      ) : null}
      <Text className={`text-[15px] font-semibold ${s.text}`}>{label}</Text>
    </Pressable>
  )
}

/** The one filled button of a screen: accent fill, white 17pt semibold, 48pt tall. */
export const PrimaryButton: React.FC<{
  label: string
  onPress: () => void
  loading?: boolean
  disabled?: boolean
  tone?: 'primary' | 'danger'
  icon?: IconName
  accessibilityLabel?: string
}> = ({ label, onPress, loading, disabled, tone = 'primary', icon, accessibilityLabel }) => (
  <Pressable
    onPress={onPress}
    disabled={disabled || loading}
    accessibilityRole="button"
    accessibilityLabel={accessibilityLabel ?? label}
    accessibilityState={{ disabled: !!(disabled || loading), busy: !!loading }} aria-disabled={!!(disabled || loading)} aria-busy={!!loading}
    className={`h-12 flex-row items-center justify-center gap-2 rounded-[14px] px-5 active:opacity-80 ${tone === 'danger' ? 'bg-missed' : 'bg-staff-primary'} ${disabled ? 'opacity-40' : ''}`}
  >
    {loading ? <ActivityIndicator color={ICON_COLOR.white} /> : icon ? <Icon name={icon} size={20} color="white" /> : null}
    <Text className="text-[17px] font-semibold text-white">{label}</Text>
  </Pressable>
)

/** Round icon-only button; `accessibilityLabel` is its name. `outline` is a quiet grey fill. */
export const IconButton: React.FC<{
  icon: IconName
  onPress: () => void
  accessibilityLabel: string
  variant?: 'outline' | 'filled' | 'plain'
  tone?: 'default' | 'danger' | 'accent'
  disabled?: boolean
}> = ({ icon, onPress, accessibilityLabel, variant = 'outline', tone = 'default', disabled }) => {
  const box = variant === 'filled' ? 'bg-staff-primary active:opacity-80' : variant === 'outline' ? 'bg-staff-fill active:bg-staff-press' : 'active:opacity-60'
  const color: IconColor = variant === 'filled' ? 'white' : tone === 'danger' ? 'missed' : tone === 'accent' ? 'accent' : 'ink'
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: !!disabled }} aria-disabled={!!disabled}
      hitSlop={HIT}
      className={`h-11 w-11 items-center justify-center rounded-full ${box} ${disabled ? 'opacity-40' : ''}`}
    >
      <Icon name={icon} size={22} color={color} />
    </Pressable>
  )
}

/** True inside an ActionList: rows then draw no background of their own. */
const InGroup = createContext(false)

/** A tappable row with a small muted leading icon, e.g. a link to another screen or an action. */
export const ActionRow: React.FC<{
  icon: IconName
  label: string
  description?: string | null
  onPress: () => void
  tone?: 'default' | 'danger'
  right?: React.ReactNode
  disabled?: boolean
  accessibilityLabel?: string
}> = ({ icon, label, description, onPress, tone = 'default', right, disabled, accessibilityLabel }) => {
  const grouped = useContext(InGroup)
  const danger = tone === 'danger'
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: !!disabled }} aria-disabled={!!disabled}
      className={`min-h-[52px] flex-row items-center gap-3 px-4 py-3 active:bg-staff-fill ${grouped ? '' : 'rounded-2xl bg-staff-card'} ${disabled ? 'opacity-40' : ''}`}
    >
      <Icon name={icon} size={22} color={danger ? 'missed' : 'muted'} />
      <View className="flex-1">
        <Text className={`text-[16px] leading-[21px] ${danger ? 'font-medium text-missed' : 'font-semibold text-staff-ink'}`}>{label}</Text>
        {description ? <Text className="mt-0.5 text-[13px] leading-[18px] text-staff-muted">{description}</Text> : null}
      </View>
      {right}
      {danger ? null : <Chevron />}
    </Pressable>
  )
}

/** ActionRows as one inset grouped list. */
export const ActionList: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const rows = React.Children.toArray(children).filter(Boolean)
  return (
    <InGroup.Provider value>
      <Card>
        {rows.map((row, i) => (
          <React.Fragment key={i}>
            {i > 0 ? <Hairline inset={50} /> : null}
            {row}
          </React.Fragment>
        ))}
      </Card>
    </InGroup.Provider>
  )
}

// ---------------------------------------------------------------- form fields

export const FieldLabel: React.FC<{ label: string; required?: boolean; hint?: string | null; error?: string | null }> = ({ label, required, hint, error }) => (
  <View className="mb-1.5">
    <Text className="text-[14px] font-medium leading-[19px] text-staff-ink2">
      {label}
      {required ? <Text className="text-missed"> *</Text> : null}
    </Text>
    {error ? <Text className="text-[13px] leading-[18px] text-missed">{error}</Text> : hint ? <Text className="text-[13px] leading-[18px] text-staff-muted">{hint}</Text> : null}
  </View>
)

export const Input: React.FC<{
  label: string
  value: string
  onChangeText: (v: string) => void
  placeholder?: string
  required?: boolean
  hint?: string | null
  error?: string | null
  secure?: boolean
  multiline?: boolean
  keyboardType?: KeyboardTypeOptions
  autoCapitalize?: 'none' | 'characters' | 'words' | 'sentences'
  editable?: boolean
  maxLength?: number
}> = ({ label, value, onChangeText, placeholder, required, hint, error, secure, multiline, keyboardType, autoCapitalize, editable = true, maxLength }) => {
  const [focused, setFocused] = useState(false)
  const border = error ? 'border-missed' : focused ? 'border-staff-accent' : 'border-staff-field'
  return (
    <View>
      <FieldLabel label={label} required={required} hint={hint} error={error} />
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={PLACEHOLDER}
        secureTextEntry={secure}
        multiline={multiline}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
        editable={editable}
        maxLength={maxLength}
        accessibilityLabel={label}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        textAlignVertical={multiline ? 'top' : 'center'}
        className={`rounded-xl border px-3.5 text-[16px] ${border} ${multiline ? 'min-h-[96px] py-2.5' : 'h-12'} ${editable ? 'bg-staff-card text-staff-ink' : 'bg-staff-fill text-staff-muted'}`}
      />
    </View>
  )
}

/** Search box with a leading icon and a clear button. */
export const SearchField: React.FC<{ value: string; onChangeText: (v: string) => void; placeholder?: string; accessibilityLabel?: string }> = ({
  value,
  onChangeText,
  placeholder = 'Search',
  accessibilityLabel
}) => (
  <View className="h-11 flex-row items-center gap-2 rounded-xl bg-staff-card pl-3 pr-1">
    <Icon name="search-outline" size={18} color="muted" />
    <TextInput
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={PLACEHOLDER}
      autoCorrect={false}
      autoCapitalize="none"
      accessibilityLabel={accessibilityLabel ?? placeholder}
      className="h-11 flex-1 text-[16px] text-staff-ink"
    />
    {value ? (
      <Pressable onPress={() => onChangeText('')} accessibilityRole="button" accessibilityLabel="Clear search" className="h-11 w-11 items-center justify-center rounded-lg active:opacity-60">
        <Icon name="close-circle" size={18} color="faint" />
      </Pressable>
    ) : null}
  </View>
)

export interface Option<T extends string = string> {
  value: T
  label: string
  detail?: string | null
  /** Only used by Segmented: the option cannot be chosen. */
  disabled?: boolean
}

/** Sheet top: grab handle, title and a plain accent close/done button. */
const SheetTop: React.FC<{ title: string; actionLabel: string; onAction: () => void }> = ({ title, actionLabel, onAction }) => (
  <>
    <View className="items-center pt-2">
      <View className="h-[5px] w-9 rounded-full bg-staff-field" />
    </View>
    <View className="min-h-[52px] flex-row items-center px-4 pb-1">
      <Text className="flex-1 text-[17px] font-semibold text-staff-ink" accessibilityRole="header" numberOfLines={1}>
        {title}
      </Text>
      <Pressable onPress={onAction} accessibilityRole="button" hitSlop={HIT} className="h-11 justify-center px-1 active:opacity-60">
        <Text className="text-[17px] font-semibold text-staff-accent">{actionLabel}</Text>
      </Pressable>
    </View>
  </>
)

/** Bottom sheet frame: grab handle, rounded top, title and a close/done text button. */
export const Sheet: React.FC<{ title: string; onClose: () => void; closeLabel?: string; children: React.ReactNode; footer?: React.ReactNode }> = ({
  title,
  onClose,
  closeLabel = 'Close',
  children,
  footer
}) => {
  const insets = useSafeAreaInsets()
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable className="flex-1 bg-black/40" onPress={onClose} accessibilityLabel="Close" />
      <View className="max-h-[85%] rounded-t-[20px] bg-staff-card" style={{ paddingBottom: footer ? 0 : Math.max(insets.bottom, 12) }}>
        <SheetTop title={title} actionLabel={closeLabel} onAction={onClose} />
        {children}
        {footer ? (
          <View className="border-t border-staff-line px-4 pt-3" style={{ paddingBottom: Math.max(insets.bottom, 12) }}>
            {footer}
          </View>
        ) : null}
      </View>
    </Modal>
  )
}

function OptionSheet<T extends string>({
  title,
  options,
  selected,
  multiple,
  onSelect,
  onClose
}: {
  title: string
  options: Option<T>[]
  selected: T[]
  multiple?: boolean
  onSelect: (value: T) => void
  onClose: () => void
}) {
  const [search, setSearch] = useState('')
  const filtered = search ? options.filter((o) => `${o.label} ${o.detail ?? ''}`.toLowerCase().includes(search.toLowerCase())) : options
  return (
    <Sheet title={title} onClose={onClose} closeLabel={multiple ? 'Done' : 'Close'}>
      {options.length > 8 ? (
        <View className="px-4 pb-2">
          <View className="h-11 flex-row items-center gap-2 rounded-xl bg-staff-fill px-3">
            <Icon name="search-outline" size={18} color="muted" />
            <TextInput
              value={search}
              onChangeText={setSearch}
              placeholder="Search"
              placeholderTextColor={PLACEHOLDER}
              autoCorrect={false}
              accessibilityLabel="Search options"
              className="h-11 flex-1 text-[16px] text-staff-ink"
            />
          </View>
        </View>
      ) : null}
      <ScrollView keyboardShouldPersistTaps="handled" className="border-t border-staff-line">
        {filtered.map((o, i) => {
          const on = selected.includes(o.value)
          return (
            <React.Fragment key={o.value || '__empty'}>
              {i > 0 ? <Hairline /> : null}
              <Pressable
                onPress={() => onSelect(o.value)}
                accessibilityRole={multiple ? 'checkbox' : 'radio'}
                accessibilityState={{ checked: on }} aria-checked={on}
                accessibilityLabel={o.label}
                className="min-h-[52px] flex-row items-center gap-3 px-4 py-2.5 active:bg-staff-fill"
              >
                <View className="flex-1">
                  <Text className={`text-[16px] leading-[21px] text-staff-ink ${on ? 'font-semibold' : ''}`}>{o.label}</Text>
                  {o.detail ? <Text className="text-[13px] leading-[18px] text-staff-muted">{o.detail}</Text> : null}
                </View>
                {on ? <Icon name="checkmark" size={20} color="accent" /> : null}
              </Pressable>
            </React.Fragment>
          )
        })}
        {filtered.length === 0 ? <Text className="px-4 py-6 text-center text-[15px] text-staff-muted">No matches</Text> : null}
      </ScrollView>
    </Sheet>
  )
}

export function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
  placeholder = 'Choose…',
  emptyLabel,
  required,
  hint,
  error,
  disabled
}: {
  label: string
  value: T | ''
  options: Option<T>[]
  onChange: (value: T | '') => void
  placeholder?: string
  /** Adds a first option that clears the value (e.g. "All machines"). */
  emptyLabel?: string
  required?: boolean
  hint?: string | null
  error?: string | null
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const current = options.find((o) => o.value === value)
  const all: Option<T | ''>[] = emptyLabel ? [{ value: '', label: emptyLabel }, ...options] : options
  const shown = current?.label ?? (value === '' && emptyLabel ? emptyLabel : placeholder)
  return (
    <View>
      <FieldLabel label={label} required={required} hint={hint} error={error} />
      <Pressable
        onPress={() => !disabled && setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${shown}`}
        accessibilityState={{ disabled: !!disabled }} aria-disabled={!!disabled}
        className={`h-12 flex-row items-center gap-2 rounded-xl border bg-staff-card px-3.5 active:bg-staff-fill ${error ? 'border-missed' : 'border-staff-field'} ${disabled ? 'opacity-40' : ''}`}
      >
        <Text className={`flex-1 text-[16px] ${current || (value === '' && emptyLabel) ? 'text-staff-ink' : 'text-staff-muted'}`} numberOfLines={1}>
          {shown}
        </Text>
        <Icon name="chevron-down" size={18} color="muted" />
      </Pressable>
      {open ? (
        <OptionSheet
          title={label}
          options={all}
          selected={[value]}
          onSelect={(v) => {
            onChange(v)
            setOpen(false)
          }}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </View>
  )
}

export function MultiSelectField<T extends string>({
  label,
  values,
  options,
  onChange,
  hint,
  placeholder = 'None selected'
}: {
  label: string
  values: T[]
  options: Option<T>[]
  onChange: (values: T[]) => void
  hint?: string | null
  placeholder?: string
}) {
  const [open, setOpen] = useState(false)
  const chosen = options.filter((o) => values.includes(o.value))
  return (
    <View>
      <FieldLabel label={label} hint={hint} />
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${chosen.length} selected`}
        className="min-h-[48px] flex-row items-center gap-2 rounded-xl border border-staff-field bg-staff-card px-3.5 py-2 active:bg-staff-fill"
      >
        <Text className={`flex-1 text-[16px] leading-[21px] ${chosen.length ? 'text-staff-ink' : 'text-staff-muted'}`}>
          {chosen.length ? chosen.map((o) => o.label).join(', ') : placeholder}
        </Text>
        <Icon name="chevron-down" size={18} color="muted" />
      </Pressable>
      {open ? (
        <OptionSheet
          title={label}
          options={options}
          selected={values}
          multiple
          onSelect={(v) => onChange(values.includes(v) ? values.filter((x) => x !== v) : [...values, v])}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </View>
  )
}

/**
 * A date as YYYY-MM-DD. Phones show the date wheel in a sheet; the web app uses the browser's input.
 * `variant="chip"` shows a compact pill (e.g. a header date switcher) labelled `chipLabel` or the date.
 */
export const DateField: React.FC<{
  label: string
  value: string
  onChange: (key: string) => void
  min?: string
  max?: string
  required?: boolean
  hint?: string | null
  clearable?: boolean
  variant?: 'field' | 'chip'
  chipLabel?: string
}> = ({ label, value, onChange, min, max, required, hint, clearable, variant = 'field', chipLabel }) => {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<Date>(value ? keyToDate(value) : new Date())
  const insets = useSafeAreaInsets()
  const shown = value ? formatKey(value) : 'Choose a date'
  const chip = variant === 'chip'
  const openSheet = () => {
    setDraft(value ? keyToDate(value) : new Date())
    setOpen(true)
  }
  const chipBody = (
    <>
      <Icon name="calendar-outline" size={16} color="accent" />
      <Text className="text-[15px] font-medium text-staff-ink" numberOfLines={1}>
        {chipLabel ?? shown}
      </Text>
      <Icon name="chevron-down" size={14} color="muted" />
    </>
  )

  if (isWeb) {
    const picker = (
      <DatePicker
        value={value ? keyToDate(value) : new Date()}
        minimumDate={min ? keyToDate(min) : undefined}
        maximumDate={max ? keyToDate(max) : undefined}
        onChange={(d) => onChange(dateKey(d))}
      />
    )
    if (chip) {
      // The browser's date input sits invisibly over the pill so a tap opens the system picker.
      return (
        <View className="h-11 flex-row items-center gap-1.5 self-start overflow-hidden rounded-full bg-staff-card px-3.5">
          {chipBody}
          <View className="absolute bottom-0 left-0 right-0 top-0 opacity-0" aria-label={`${label}: ${shown}`}>
            {picker}
          </View>
        </View>
      )
    }
    return (
      <View>
        <FieldLabel label={label} required={required} hint={hint} />
        {picker}
      </View>
    )
  }

  const sheet = open ? (
    <Modal visible transparent animationType="slide" onRequestClose={() => setOpen(false)}>
      <Pressable className="flex-1 bg-black/40" onPress={() => setOpen(false)} accessibilityLabel="Close" />
      <View className="rounded-t-[20px] bg-staff-card px-4" style={{ paddingBottom: Math.max(insets.bottom, 12) }}>
        <View className="-mx-4">
          <SheetTop
            title={label}
            actionLabel="Done"
            onAction={() => {
              onChange(dateKey(draft))
              setOpen(false)
            }}
          />
        </View>
        <DatePicker
          value={draft}
          minimumDate={min ? keyToDate(min) : undefined}
          maximumDate={max ? keyToDate(max) : undefined}
          onChange={(d) => {
            setDraft(d)
            // Android shows its own date dialog: the chosen date applies straight away.
            if (Platform.OS === 'android') {
              onChange(dateKey(d))
              setOpen(false)
            }
          }}
          onDismiss={() => setOpen(false)}
        />
      </View>
    </Modal>
  ) : null

  if (chip) {
    return (
      <>
        <Pressable
          onPress={openSheet}
          accessibilityRole="button"
          accessibilityLabel={`${label}: ${shown}`}
          hitSlop={HIT}
          className="h-11 flex-row items-center gap-1.5 self-start rounded-full bg-staff-card px-3.5 active:bg-staff-fill"
        >
          {chipBody}
        </Pressable>
        {sheet}
      </>
    )
  }
  return (
    <View>
      <FieldLabel label={label} required={required} hint={hint} />
      <View className="flex-row gap-2">
        <Pressable
          onPress={openSheet}
          accessibilityRole="button"
          accessibilityLabel={`${label}: ${value ? formatKey(value) : 'not set'}`}
          className="h-12 flex-1 flex-row items-center gap-2.5 rounded-xl border border-staff-field bg-staff-card px-3.5 active:bg-staff-fill"
        >
          <Icon name="calendar-outline" size={20} color="muted" />
          <Text className={`flex-1 text-[16px] ${value ? 'text-staff-ink' : 'text-staff-muted'}`} numberOfLines={1}>
            {shown}
          </Text>
        </Pressable>
        {clearable && value ? <SmallButton label="Clear" tone="ghost" onPress={() => onChange('')} className="h-12" /> : null}
      </View>
      {sheet}
    </View>
  )
}

/**
 * A time as HH:MM (24-hour, as stored), shown and picked in 12-hour AM/PM. Phones show the time
 * wheel in a sheet; the web app shows hour, minute and AM/PM selects.
 */
export const TimeField: React.FC<{
  label: string
  value: string
  onChange: (hhmm: string) => void
  required?: boolean
  hint?: string | null
  error?: string | null
}> = ({ label, value, onChange, required, hint, error }) => {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(value)
  const insets = useSafeAreaInsets()
  const shown = value ? formatClock(value) : 'Choose a time'

  if (isWeb) {
    return (
      <View>
        <FieldLabel label={label} required={required} hint={hint} />
        <TimePicker label={label} value={value} onChange={onChange} />
        {error ? <Text className="mt-1.5 text-[13px] leading-[18px] text-missed">{error}</Text> : null}
      </View>
    )
  }

  return (
    <View>
      <FieldLabel label={label} required={required} hint={hint} />
      <Pressable
        onPress={() => {
          setDraft(value)
          setOpen(true)
        }}
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${value ? formatClock(value) : 'not set'}`}
        className="h-12 flex-row items-center gap-2.5 rounded-xl border border-staff-field bg-staff-card px-3.5 active:bg-staff-fill"
      >
        <Icon name="time-outline" size={20} color="muted" />
        <Text className={`flex-1 text-[16px] ${value ? 'text-staff-ink' : 'text-staff-muted'}`} numberOfLines={1}>
          {shown}
        </Text>
      </Pressable>
      {error ? <Text className="mt-1.5 text-[13px] leading-[18px] text-missed">{error}</Text> : null}
      {open ? (
        <Modal visible transparent animationType="slide" onRequestClose={() => setOpen(false)}>
          <Pressable className="flex-1 bg-black/40" onPress={() => setOpen(false)} accessibilityLabel="Close" />
          <View className="rounded-t-[20px] bg-staff-card px-4" style={{ paddingBottom: Math.max(insets.bottom, 12) }}>
            <View className="-mx-4">
              <SheetTop
                title={label}
                actionLabel="Done"
                onAction={() => {
                  onChange(draft)
                  setOpen(false)
                }}
              />
            </View>
            <TimePicker label={label} value={draft} onChange={setDraft} />
          </View>
        </Modal>
      ) : null}
    </View>
  )
}

/**
 * The visual part of a switch row. The surrounding Pressable is the one accessible switch, so this is
 * hidden from assistive tech and ignores touches. The web draws its own knob (RN-web's Switch renders a
 * focusable checkbox input that cannot be hidden); phones use the native Switch with a white thumb.
 */
export const SwitchKnob: React.FC<{ value: boolean; disabled?: boolean }> = ({ value, disabled }) => {
  const hidden = {
    accessible: false,
    importantForAccessibility: 'no-hide-descendants' as const,
    accessibilityElementsHidden: true,
    'aria-hidden': true,
    pointerEvents: 'none' as const
  }
  if (isWeb) {
    return (
      <View {...hidden} className={`h-[28px] w-[48px] justify-center rounded-full px-[2px] ${value ? 'items-end bg-staff-primary' : 'items-start bg-staff-field'}`}>
        <View className="h-6 w-6 rounded-full bg-white" />
      </View>
    )
  }
  return (
    <View {...hidden}>
      <Switch
        value={value}
        disabled={disabled}
        trackColor={{ true: TRACK_ON, false: TRACK_OFF }}
        thumbColor={ICON_COLOR.white}
        ios_backgroundColor={TRACK_OFF}
        {...hidden}
      />
    </View>
  )
}

export const ToggleField: React.FC<{ label: string; description?: string | null; value: boolean; onChange: (v: boolean) => void; disabled?: boolean }> = ({
  label,
  description,
  value,
  onChange,
  disabled
}) => (
  <Pressable
    onPress={() => !disabled && onChange(!value)}
    accessibilityRole="switch"
    accessibilityState={{ checked: value, disabled }} aria-checked={value} aria-disabled={disabled}
    accessibilityLabel={label}
    className={`min-h-[56px] flex-row items-center rounded-xl bg-staff-fill px-3.5 py-3 ${disabled ? 'opacity-40' : ''}`}
  >
    <View className="flex-1 pr-3">
      <Text className="text-[16px] font-medium leading-[21px] text-staff-ink">{label}</Text>
      {description ? <Text className="mt-0.5 text-[13px] leading-[18px] text-staff-muted">{description}</Text> : null}
    </View>
    <SwitchKnob value={value} disabled={disabled} />
  </Pressable>
)

/** iOS-style segmented control: grey track, the chosen segment raised in white. */
export function Segmented<T extends string>({ options, value, onChange }: { options: Option<T>[]; value: T; onChange: (v: T) => void }) {
  return (
    <View className="flex-row rounded-xl bg-staff-press p-[3px]" accessibilityRole="tablist">
      {options.map((o) => {
        const on = o.value === value
        return (
          <Pressable
            key={o.value}
            onPress={() => !o.disabled && onChange(o.value)}
            disabled={o.disabled}
            accessibilityRole="tab"
            accessibilityState={{ selected: on, disabled: !!o.disabled }} aria-selected={on} aria-disabled={!!o.disabled}
            className={`min-h-[42px] flex-1 items-center justify-center rounded-[10px] px-2 ${on ? 'bg-staff-card' : 'active:opacity-60'} ${o.disabled ? 'opacity-40' : ''}`}
          >
            <Text className={`text-center text-[14px] ${on ? 'font-semibold text-staff-ink' : 'font-medium text-staff-ink2'}`} numberOfLines={1}>
              {o.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

/**
 * Horizontal filter chips. The chosen chip is filled with the accent; `tone: 'missed'` makes an
 * unselected chip with a count stand out in the Missed colour (e.g. the Missed filter).
 */
export function Chips<T extends string>({
  options,
  value,
  onChange
}: {
  options: (Option<T> & { count?: number; tone?: 'missed' | 'exception' })[]
  value: T
  onChange: (v: T) => void
}) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="gap-2">
      {options.map((o) => {
        const on = o.value === value
        const alert = !on && !!o.tone && !!o.count
        const box = on ? 'bg-staff-primary' : alert ? (o.tone === 'missed' ? 'bg-missed-bg active:opacity-70' : 'bg-exception-bg active:opacity-70') : 'bg-staff-card active:bg-staff-fill'
        const text = on ? 'text-white' : alert ? (o.tone === 'missed' ? 'text-missed' : 'text-exception') : 'text-staff-ink'
        return (
          <Pressable
            key={o.value || 'all'}
            onPress={() => onChange(o.value)}
            accessibilityRole="button"
            accessibilityState={{ selected: on }} aria-selected={on}
            hitSlop={{ top: 4, bottom: 4 }}
            className={`h-10 flex-row items-center rounded-full px-3.5 ${box}`}
          >
            <Text className={`text-[14px] ${on || alert ? 'font-semibold' : 'font-medium'} ${text}`}>
              {o.label}
              {o.count !== undefined ? <Text className={on || alert ? '' : 'text-staff-muted'}>{` ${o.count}`}</Text> : null}
            </Text>
          </Pressable>
        )
      })}
    </ScrollView>
  )
}

export const FormError: React.FC<{ message: string | null }> = ({ message }) =>
  message ? (
    <View className="flex-row gap-2.5 rounded-xl bg-missed-bg px-3.5 py-3" accessibilityRole="alert">
      <Icon name="alert-circle-outline" size={20} color="missed" />
      <Text className="flex-1 text-[14px] font-medium leading-[20px] text-missed">{message}</Text>
    </View>
  ) : null

// ---------------------------------------------------------------- dialogs and toasts

/** Asks before doing something; resolves true when confirmed. */
export function confirm(title: string, message: string, confirmLabel = 'OK', destructive = false) {
  return new Promise<boolean>((resolve) => {
    showDialog(title, message, [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      { text: confirmLabel, style: destructive ? 'destructive' : 'default', onPress: () => resolve(true) }
    ])
  })
}

type ToastKind = 'success' | 'error' | 'warning'
interface ToastItem {
  id: number
  kind: ToastKind
  title: string
  message?: string
}

const ToastContext = createContext<(kind: ToastKind, title: string, message?: string) => void>(() => undefined)

// Light status tints (the -line tokens) read well on the dark toast.
const TOAST_ICON: Record<ToastKind, { name: IconName; color: string }> = {
  success: { name: 'checkmark-circle', color: '#CBE7D2' },
  error: { name: 'alert-circle', color: '#F3CBC7' },
  warning: { name: 'warning', color: '#F2D7B8' }
}

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [items, setItems] = useState<ToastItem[]>([])
  const nextId = useRef(1)
  const insets = useSafeAreaInsets()
  const notify = useCallback((kind: ToastKind, title: string, message?: string) => {
    const id = nextId.current++
    setItems((list) => [...list.slice(-2), { id, kind, title, message }])
    setTimeout(() => setItems((list) => list.filter((t) => t.id !== id)), kind === 'success' ? 3500 : 7000)
  }, [])
  return (
    <ToastContext.Provider value={notify}>
      {children}
      <View pointerEvents="box-none" className="absolute left-0 right-0 gap-2 px-4" style={{ top: insets.top + 8 }}>
        {items.map((t) => (
          <Pressable
            key={t.id}
            onPress={() => setItems((list) => list.filter((x) => x.id !== t.id))}
            accessibilityRole="alert"
            className="flex-row gap-3 rounded-2xl bg-staff-ink px-4 py-3"
          >
            <Icon name={TOAST_ICON[t.kind].name} size={20} color={TOAST_ICON[t.kind].color} />
            <View className="flex-1">
              <Text className="text-[15px] font-semibold leading-[20px] text-white">{t.title}</Text>
              {t.message ? <Text className="mt-0.5 text-[14px] leading-[19px] text-staff-field">{t.message}</Text> : null}
            </View>
          </Pressable>
        ))}
      </View>
    </ToastContext.Provider>
  )
}

export const useToast = () => useContext(ToastContext)

// ---------------------------------------------------------------- evidence

const VideoBlock: React.FC<{ uri: string }> = ({ uri }) => {
  const player = useVideoPlayer(uri, (p) => {
    p.loop = false
  })
  return <VideoView player={player} nativeControls contentFit="contain" className="h-56 w-full bg-black" />
}

/** Live-captured photo and video evidence with capture details. */
export const EvidenceGallery: React.FC<{ media: MediaFile[]; workerName?: string | null; deviceInfo?: string | null }> = ({ media, workerName, deviceInfo }) => {
  const [zoom, setZoom] = useState<string | null>(null)
  const ordered = useMemo(() => [...media.filter((m) => m.kind === 'PHOTO'), ...media.filter((m) => m.kind === 'VIDEO')], [media])
  if (media.length === 0) return <Empty text="No photo or video attached" icon="image-outline" />
  return (
    <Card>
      {ordered.map((file, i) => (
        <View key={file.id} className={i > 0 ? 'border-t border-staff-line' : ''}>
          {file.kind === 'PHOTO' ? (
            <Pressable onPress={() => setZoom(fileUrl(file.url))} accessibilityRole="imagebutton" accessibilityLabel="Evidence photo, tap to enlarge">
              <Image source={{ uri: fileUrl(file.url) }} resizeMode="contain" className="h-64 w-full bg-black" accessibilityLabel="Evidence photo" />
            </Pressable>
          ) : (
            <VideoBlock uri={fileUrl(file.url)} />
          )}
          <View className="flex-row flex-wrap px-4 py-3">
            <View className="w-1/2 flex-row gap-2 pr-2">
              <Icon name={file.kind === 'PHOTO' ? 'image-outline' : 'videocam-outline'} size={18} color="muted" />
              <Text className="flex-1 text-[12px] leading-[16px] text-staff-muted">
                {file.kind === 'PHOTO' ? 'Photo' : 'Video'} captured{'\n'}
                <Text className="text-[14px] font-medium leading-[19px] text-staff-ink">{formatDateTime(file.capturedAt)}</Text>
              </Text>
            </View>
            <Text className="w-1/2 text-[12px] leading-[16px] text-staff-muted">
              Size{'\n'}
              <Text className="text-[14px] font-medium leading-[19px] text-staff-ink">
                {formatBytes(file.sizeBytes)}
                {file.durationSeconds != null ? ` · ${Math.round(file.durationSeconds)} s` : ''}
              </Text>
            </Text>
          </View>
        </View>
      ))}
      {workerName || deviceInfo ? (
        <View className="gap-0.5 border-t border-staff-line px-4 py-3">
          {workerName ? (
            <Text className="text-[13px] text-staff-muted">
              Captured by <Text className="font-medium text-staff-ink">{workerName}</Text>
            </Text>
          ) : null}
          {deviceInfo ? (
            <Text className="text-[13px] text-staff-muted">
              Device <Text className="font-medium text-staff-ink">{deviceInfo}</Text>
            </Text>
          ) : null}
        </View>
      ) : null}
      {zoom ? (
        <Modal visible transparent onRequestClose={() => setZoom(null)}>
          <Pressable className="flex-1 items-center justify-center bg-black" onPress={() => setZoom(null)} accessibilityLabel="Close photo">
            <Image source={{ uri: zoom }} resizeMode="contain" className="h-full w-full" />
          </Pressable>
        </Modal>
      ) : null}
    </Card>
  )
}
