import { openDialog, type DialogAction, type DialogItem, type DialogTone } from '../components/ui/AppDialog'
import { describeError } from './friendlyError'

/** The button shape screens already use (the same as React Native's Alert). */
export interface DialogButton {
  text: string
  style?: 'default' | 'cancel' | 'destructive'
  onPress?: () => void
}

/**
 * A message or a choice, in the app's own dialog (the same on Android, iPhone and the web app;
 * components/ui/AppDialog.tsx). With a Cancel and another button it is a question; the other
 * button is then the main action.
 */
export function showDialog(title: string, message?: string, buttons: DialogButton[] = [], tone?: DialogTone) {
  const isChoice = buttons.some((b) => b.style === 'cancel') && buttons.some((b) => b.style !== 'cancel')
  const actions: DialogAction[] = buttons.map((b) => ({
    text: b.text,
    style: b.style === 'cancel' ? 'cancel' : b.style === 'destructive' ? 'destructive' : isChoice || buttons.length === 1 ? 'primary' : 'default',
    onPress: b.onPress
  }))
  openDialog({ tone: tone ?? (isChoice ? 'question' : 'info'), title, message, actions })
}

/** A success message ("Job completed"). */
export const showSuccess = (title: string, message?: string, onClose?: () => void) =>
  openDialog({ tone: 'success', title, message, actions: [{ text: 'OK', style: 'primary', onPress: onClose }] })

/**
 * Something failed: a plain explanation of what went wrong and what to do, never a raw technical
 * message. `onRetry` adds a Try Again button when trying again can help (no connection, server
 * problem).
 */
export function showError(err: unknown, options: { title?: string; onRetry?: () => void; onClose?: () => void } = {}) {
  const e = describeError(err, options.title)
  const actions: DialogAction[] =
    e.retryable && options.onRetry
      ? [
          { text: 'Close', style: 'cancel', onPress: options.onClose },
          { text: 'Try Again', style: 'primary', icon: 'refresh', onPress: options.onRetry }
        ]
      : [{ text: 'OK', style: 'primary', onPress: options.onClose }]
  openDialog({ tone: e.tone, title: e.title, message: e.message, next: e.next, actions })
}

/**
 * Required items are missing, e.g. a parameter's photo or video. Lists each item; `fix` is
 * the main action (e.g. "Take Photo" opens the camera for the first missing photo).
 */
export function showMissingItems(options: {
  title: string
  message?: string
  items: DialogItem[]
  next?: string | null
  fix?: DialogAction
}) {
  openDialog({
    tone: 'warning',
    title: options.title,
    message: options.message,
    items: options.items,
    next: options.next,
    actions: options.fix ? [{ text: 'Close', style: 'cancel' }, { ...options.fix, style: 'primary' }] : [{ text: 'Close', style: 'primary' }]
  })
}
