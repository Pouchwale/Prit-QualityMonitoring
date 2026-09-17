import React, { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { CheckCircle2, AlertTriangle, AlertCircle, Info, X } from 'lucide-react'

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
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    setToasts((prev) => [...prev, { id, type, title, message }])
  }, [])

  const dismiss = useCallback((id: string) => setToasts((prev) => prev.filter((t) => t.id !== id)), [])

  return (
    <ToastContext.Provider value={notify}>
      {children}
      <div className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2 max-w-sm w-full pointer-events-none">
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
    success: <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />,
    warning: <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />,
    error: <AlertCircle className="w-4 h-4 text-red-600 shrink-0" />,
    info: <Info className="w-4 h-4 text-blue-600 shrink-0" />
  }

  const borderStyles = {
    success: 'border-emerald-200 bg-emerald-50 text-emerald-950',
    warning: 'border-amber-200 bg-amber-50 text-amber-950',
    error: 'border-red-200 bg-red-50 text-red-950',
    info: 'border-blue-200 bg-blue-50 text-blue-950'
  }

  return (
    <div className={`pointer-events-auto flex items-start gap-2.5 p-3 rounded border shadow-lg text-xs ${borderStyles[toast.type]}`}>
      {icons[toast.type]}
      <div className="flex-1">
        <div className="font-semibold">{toast.title}</div>
        {toast.message && <div className="text-[11px] opacity-90 mt-0.5">{toast.message}</div>}
      </div>
      <button onClick={() => onDismiss(toast.id)} className="text-slate-400 hover:text-slate-700 p-0.5 rounded transition-colors">
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}
