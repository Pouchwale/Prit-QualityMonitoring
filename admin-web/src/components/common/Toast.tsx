import React, { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { CheckCircle2, AlertTriangle, AlertCircle, Info, X } from 'lucide-react'
import { DialogHost, openDialog } from './AppDialog'

export interface ToastMessage {
  id: string
  type: 'success' | 'warning' | 'error' | 'info'
  title: string
  message?: string
}

type Notify = (type: ToastMessage['type'], title: string, message?: string) => void

const ToastContext = createContext<Notify | null>(null)

/** Provides `useToast()` to every page. */
export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastMessage[]>([])

  const notify = useCallback<Notify>((type, title, message) => {
    // Errors need reading and an answer, so they open the error popup instead of a toast.
    if (type === 'error') {
      openDialog({ tone: 'error', title, message, actions: [{ label: 'OK', variant: 'primary' }] })
      return
    }
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    setToasts((prev) => [...prev, { id, type, title, message }])
  }, [])

  const dismiss = useCallback((id: string) => setToasts((prev) => prev.filter((t) => t.id !== id)), [])

  return (
    <ToastContext.Provider value={notify}>
      {children}
      <DialogHost />
      {/* A polite live region: new toasts are read out without moving focus. */}
      <div
        className="fixed bottom-4 right-4 left-4 sm:left-auto z-[60] flex flex-col gap-2 sm:max-w-sm sm:w-full pointer-events-none"
        role="status"
        aria-live="polite"
        aria-relevant="additions"
      >
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used inside ToastProvider')
  return ctx
}

const ToastItem: React.FC<{ toast: ToastMessage; onDismiss: (id: string) => void }> = ({ toast, onDismiss }) => {
  useEffect(() => {
    // Warnings and errors often explain what to do next, so they stay up longer.
    const timer = setTimeout(() => onDismiss(toast.id), toast.type === 'error' || toast.type === 'warning' ? 12000 : 4000)
    return () => clearTimeout(timer)
  }, [onDismiss, toast.id, toast.type])

  const icons = {
    success: <CheckCircle2 className="w-4 h-4 text-success shrink-0" />,
    warning: <AlertTriangle className="w-4 h-4 text-exception shrink-0" />,
    error: <AlertCircle className="w-4 h-4 text-missed shrink-0" />,
    info: <Info className="w-4 h-4 text-accent shrink-0" />
  }

  const borderStyles = {
    success: 'border-line bg-white text-ink border-l-[3px] border-l-[var(--color-chart-completed)]',
    warning: 'border-line bg-white text-ink border-l-[3px] border-l-[var(--color-chart-exception)]',
    error: 'border-line bg-white text-ink border-l-[3px] border-l-[var(--color-chart-missed)]',
    info: 'border-line bg-white text-ink border-l-[3px] border-l-[var(--color-chart-primary)]'
  }

  return (
    <div className={`pointer-events-auto flex items-start gap-2.5 p-3 rounded-lg border shadow-[var(--shadow-pop)] text-[12.5px] ${borderStyles[toast.type]}`}>
      {icons[toast.type]}
      <div className="flex-1 min-w-0 [overflow-wrap:anywhere]">
        <div className="font-semibold">{toast.title}</div>
        {toast.message && <div className="text-[12px] text-ink-muted mt-0.5">{toast.message}</div>}
      </div>
      <button
        onClick={() => onDismiss(toast.id)}
        className="-m-1.5 w-7 h-7 shrink-0 flex items-center justify-center text-ink-muted hover:text-ink hover:bg-subtle rounded transition-colors"
        aria-label="Dismiss notification"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}
