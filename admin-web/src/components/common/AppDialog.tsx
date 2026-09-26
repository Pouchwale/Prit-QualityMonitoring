import React, { useEffect, useState } from 'react'
import { AlertCircle, AlertTriangle, ArrowRight, CheckCircle2, HelpCircle, Info, type LucideIcon } from 'lucide-react'
import { Button } from './Button'

export type DialogTone = 'error' | 'warning' | 'success' | 'info' | 'question'

export interface DialogAction {
  label: string
  /** primary: the suggested next step; cancel: closes; danger: cannot be undone. */
  variant?: 'primary' | 'secondary' | 'cancel' | 'danger'
  icon?: React.ReactNode
  onClick?: () => void
}

export interface DialogItem {
  label: string
  detail?: string
}

export interface DialogOptions {
  tone?: DialogTone
  title: string
  message?: React.ReactNode
  /** What to do next, shown under the message with an arrow. */
  next?: string | null
  items?: DialogItem[]
  actions?: DialogAction[]
}

const TONE: Record<DialogTone, { Icon: LucideIcon; icon: string; ring: string }> = {
  error: { Icon: AlertCircle, icon: 'text-failed', ring: 'bg-failed-bg' },
  warning: { Icon: AlertTriangle, icon: 'text-exception', ring: 'bg-exception-bg' },
  success: { Icon: CheckCircle2, icon: 'text-success', ring: 'bg-success-bg' },
  info: { Icon: Info, icon: 'text-due', ring: 'bg-due-bg' },
  question: { Icon: HelpCircle, icon: 'text-accent', ring: 'bg-blue-50' }
}

// ---- one host for the whole panel; dialogs opened anywhere are shown one after the other ----

type Entry = DialogOptions & { id: number }
let queue: Entry[] = []
let nextId = 1
const listeners = new Set<(entries: Entry[]) => void>()
const emit = () => listeners.forEach((l) => l(queue))

/** Opens a dialog from anywhere (pages, event handlers). Rendered by <DialogHost />. */
export function openDialog(options: DialogOptions) {
  queue = [...queue, { ...options, id: nextId++ }]
  emit()
}

function close(id: number) {
  queue = queue.filter((e) => e.id !== id)
  emit()
}

/** Asks a question; resolves true when the main action is chosen. */
export function askConfirm(options: Omit<DialogOptions, 'actions'> & { confirmLabel?: string; cancelLabel?: string; danger?: boolean }) {
  return new Promise<boolean>((resolve) =>
    openDialog({
      tone: options.tone ?? (options.danger ? 'warning' : 'question'),
      title: options.title,
      message: options.message,
      next: options.next,
      items: options.items,
      actions: [
        { label: options.cancelLabel ?? 'Cancel', variant: 'cancel', onClick: () => resolve(false) },
        { label: options.confirmLabel ?? 'OK', variant: options.danger ? 'danger' : 'primary', onClick: () => resolve(true) }
      ]
    })
  )
}

/** Renders the open dialog. Mounted once (Toast.tsx provider), above every page. */
export const DialogHost: React.FC = () => {
  const [entries, setEntries] = useState<Entry[]>(queue)
  useEffect(() => {
    listeners.add(setEntries)
    return () => {
      listeners.delete(setEntries)
    }
  }, [])
  const current = entries[0]
  return current ? <DialogCard key={current.id} entry={current} /> : null
}

/** Escape, the backdrop or Close: the cancel action runs (or the dialog just closes). */
function dismiss(entry: Entry) {
  close(entry.id)
  entry.actions?.find((a) => a.variant === 'cancel')?.onClick?.()
}

const DialogCard: React.FC<{ entry: Entry }> = ({ entry }) => {
  const tone = TONE[entry.tone ?? 'info']
  const actions = entry.actions?.length ? entry.actions : [{ label: 'OK', variant: 'primary' as const }]
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        dismiss(entry)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [entry])

  const press = (action: DialogAction) => {
    close(entry.id)
    action.onClick?.()
  }
  // Main action on the right; secondary and Close/Cancel to its left.
  const rank = (a: DialogAction) => (a.variant === 'cancel' ? 0 : a.variant === 'secondary' ? 1 : 2)
  const ordered = [...actions].sort((a, b) => rank(a) - rank(b))
  const main = ordered[ordered.length - 1]

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-slate-900/50 animate-in fade-in duration-150" onMouseDown={(e) => e.target === e.currentTarget && dismiss(entry)}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`dialog-title-${entry.id}`}
        aria-describedby={`dialog-body-${entry.id}`}
        className="w-full max-w-[420px] bg-white rounded-xl border border-line shadow-2xl flex flex-col max-h-[calc(100dvh-2rem)] overflow-hidden"
      >
        <div className="px-5 pt-5 pb-4 overflow-y-auto">
          <div className="flex items-start gap-3">
            <div className={`shrink-0 w-9 h-9 rounded-full flex items-center justify-center ${tone.ring}`}>
              <tone.Icon className={`w-[18px] h-[18px] ${tone.icon}`} aria-hidden />
            </div>
            <div className="min-w-0 flex-1 pt-1.5" id={`dialog-body-${entry.id}`}>
              <h3 id={`dialog-title-${entry.id}`} className="text-[15px] font-semibold text-ink leading-snug">
                {entry.title}
              </h3>
              {entry.message ? <div className="mt-1.5 text-[13px] leading-relaxed text-ink-secondary">{entry.message}</div> : null}

              {entry.items?.length ? (
                <ul className="mt-3 rounded-md border border-line divide-y divide-line bg-subtle/60">
                  {entry.items.map((item, i) => (
                    <li key={`${item.label}-${i}`} className="px-3 py-2">
                      <div className="text-[13px] font-medium text-ink">{item.label}</div>
                      {item.detail ? <div className="text-[12px] text-ink-muted">{item.detail}</div> : null}
                    </li>
                  ))}
                </ul>
              ) : null}

              {entry.next ? (
                <p className="mt-3 flex items-start gap-1.5 text-[12px] leading-relaxed text-ink-muted">
                  <ArrowRight className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden />
                  <span>{entry.next}</span>
                </p>
              ) : null}
            </div>
          </div>
        </div>
        <div className="px-5 py-3 border-t border-line bg-slate-50 flex flex-wrap justify-end gap-2">
          {ordered.map((action) => (
            <Button
              key={action.label}
              autoFocus={action === main}
              size="sm"
              variant={action.variant === 'danger' ? 'danger' : action.variant === 'primary' ? 'primary' : 'outline'}
              icon={action.icon}
              onClick={() => press(action)}
            >
              {action.label}
            </Button>
          ))}
        </div>
      </div>
    </div>
  )
}
