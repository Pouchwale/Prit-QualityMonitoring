import React, { useEffect, useState } from 'react'
import { BackHandler, Modal, Pressable, ScrollView, Text, View } from 'react-native'
import { Icon, IconName } from './Icon'

export type DialogTone = 'error' | 'warning' | 'success' | 'info' | 'question'

export interface DialogAction {
  text: string
  /** primary: the suggested next step; cancel: closes; destructive: a step that cannot be undone. */
  style?: 'primary' | 'default' | 'cancel' | 'destructive'
  icon?: IconName
  onPress?: () => void
}

export interface DialogItem {
  label: string
  /** e.g. "Photo required" */
  detail?: string
  icon?: IconName
}

export interface DialogOptions {
  tone?: DialogTone
  title: string
  message?: string
  /** What to do next, shown under the message with an arrow. */
  next?: string | null
  /** A short list, e.g. the photos and videos still needed. */
  items?: DialogItem[]
  actions?: DialogAction[]
}

const TONE: Record<DialogTone, { icon: IconName; color: string; bg: string }> = {
  error: { icon: 'alert-circle', color: 'missed', bg: 'bg-missed-bg' },
  warning: { icon: 'warning', color: 'exception', bg: 'bg-exception-bg' },
  success: { icon: 'checkmark-circle', color: 'success', bg: 'bg-success-bg' },
  info: { icon: 'information-circle', color: 'due', bg: 'bg-due-bg' },
  question: { icon: 'help-circle', color: 'accent', bg: 'bg-accent-soft' }
}

// ---- one host for the whole app; dialogs opened anywhere are shown one after the other ----

type Entry = DialogOptions & { id: number }
let queue: Entry[] = []
let nextId = 1
const listeners = new Set<(entries: Entry[]) => void>()
const emit = () => listeners.forEach((l) => l(queue))

/** Opens a dialog (see utils/dialog.ts for the helpers screens use). */
export function openDialog(options: DialogOptions) {
  queue = [...queue, { ...options, id: nextId++ }]
  emit()
}

function close(id: number) {
  queue = queue.filter((e) => e.id !== id)
  emit()
}

/**
 * Renders the dialogs. Mounted once at the root of the app (App.tsx), above every screen,
 * the same on Android, iPhone and the web app.
 */
export const DialogHost: React.FC = () => {
  const [entries, setEntries] = useState<Entry[]>(queue)
  useEffect(() => {
    listeners.add(setEntries)
    return () => {
      listeners.delete(setEntries)
    }
  }, [])
  const current = entries[0]

  // Android Back closes the dialog the way Cancel/Close would.
  useEffect(() => {
    if (!current) return
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      dismiss(current)
      return true
    })
    return () => sub.remove()
  }, [current])

  if (!current) return null
  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => dismiss(current)} statusBarTranslucent>
      <DialogCard entry={current} />
    </Modal>
  )
}

/** Back, the backdrop or a missing Cancel: the cancel action runs (or the dialog just closes). */
function dismiss(entry: Entry) {
  close(entry.id)
  entry.actions?.find((a) => a.style === 'cancel')?.onPress?.()
}

const DialogCard: React.FC<{ entry: Entry }> = ({ entry }) => {
  const tone = TONE[entry.tone ?? 'info']
  const actions = entry.actions?.length ? entry.actions : [{ text: 'OK', style: 'primary' as const }]
  const press = (action: DialogAction) => {
    close(entry.id)
    action.onPress?.()
  }
  // Two short actions sit side by side; three, or long labels, stack (primary first).
  const stacked = actions.length > 2 || actions.some((a) => a.text.length > 16)
  const ordered = stacked ? [...actions].sort((a, b) => rank(a) - rank(b)) : [...actions].sort((a, b) => rank(b) - rank(a))

  return (
    <View className="flex-1 items-center justify-center bg-black/40 px-5">
      <Pressable className="absolute inset-0" onPress={() => dismiss(entry)} accessibilityLabel="Close" />
      <View
        className="w-full max-w-[400px] rounded-[20px] bg-surface px-5 pb-4 pt-5"
        style={{ maxHeight: '86%', shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 24, shadowOffset: { width: 0, height: 8 }, elevation: 12 }}
        accessibilityViewIsModal
        aria-modal
        role="alertdialog"
        aria-label={entry.title}
      >
        <ScrollView bounces={false} showsVerticalScrollIndicator={false} contentContainerStyle={{ flexGrow: 0 }}>
          <View className="flex-row items-start">
            <View className={`h-10 w-10 items-center justify-center rounded-full ${tone.bg}`}>
              <Icon name={tone.icon} size={22} color={tone.color} />
            </View>
            <View className="ml-3 flex-1 pt-1.5">
              <Text className="text-[18px] font-semibold leading-[23px] text-ink" accessibilityRole="header">
                {entry.title}
              </Text>
            </View>
          </View>

          {entry.message ? <Text className="mt-3 text-[15px] leading-[21px] text-ink-secondary">{entry.message}</Text> : null}

          {entry.items?.length ? (
            <View className="mt-3 overflow-hidden rounded-xl bg-subtle">
              {entry.items.map((item, i) => (
                <View key={`${item.label}-${i}`} className={`flex-row items-center px-3 py-2.5 ${i ? 'border-t border-line' : ''}`}>
                  <Icon name={item.icon ?? 'ellipse-outline'} size={18} color="secondary" />
                  <View className="ml-2.5 flex-1">
                    <Text className="text-[15px] font-medium leading-[20px] text-ink">{item.label}</Text>
                    {item.detail ? <Text className="text-[13px] leading-[17px] text-ink-muted">{item.detail}</Text> : null}
                  </View>
                </View>
              ))}
            </View>
          ) : null}

          {entry.next ? (
            <View className="mt-3 flex-row items-start">
              <Icon name="arrow-forward-circle-outline" size={18} color="muted" />
              <Text className="ml-2 flex-1 text-[14px] leading-[19px] text-ink-muted">{entry.next}</Text>
            </View>
          ) : null}
        </ScrollView>

        <View className={`mt-5 gap-2 ${stacked ? '' : 'flex-row'}`}>
          {ordered.map((action) => (
            <DialogButton key={action.text} action={action} fill={!stacked} onPress={() => press(action)} />
          ))}
        </View>
      </View>
    </View>
  )
}

/** Primary first when stacked, last (right) when side by side. */
const rank = (a: DialogAction) => (a.style === 'primary' || a.style === 'destructive' ? 0 : a.style === 'cancel' ? 2 : 1)

const BUTTON: Record<NonNullable<DialogAction['style']>, { box: string; label: string; icon: string }> = {
  primary: { box: 'bg-accent active:bg-accent-press', label: 'text-white', icon: 'white' },
  destructive: { box: 'bg-missed active:opacity-85', label: 'text-white', icon: 'white' },
  default: { box: 'bg-subtle active:opacity-80', label: 'text-ink', icon: 'ink' },
  cancel: { box: 'bg-subtle active:opacity-80', label: 'text-ink', icon: 'ink' }
}

const DialogButton: React.FC<{ action: DialogAction; fill: boolean; onPress: () => void }> = ({ action, fill, onPress }) => {
  const style = BUTTON[action.style ?? 'default']
  // Side by side on a narrow phone there is no room for an icon next to the label.
  const icon = fill ? undefined : action.icon
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={action.text}
      className={`h-11 flex-row items-center justify-center rounded-xl px-4 ${style.box} ${fill ? 'flex-1' : ''}`}
    >
      {icon ? <Icon name={icon} size={18} color={style.icon} /> : null}
      <Text className={`text-[16px] font-semibold ${style.label} ${icon ? 'ml-1.5' : ''}`} numberOfLines={1}>
        {action.text}
      </Text>
    </Pressable>
  )
}
