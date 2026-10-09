import React, { useId } from 'react'
import { X } from 'lucide-react'
import { useDialogFocus } from '../../lib/useDialogFocus'

interface ModalProps {
  isOpen: boolean
  onClose: () => void
  title: string
  subtitle?: string
  children: React.ReactNode
  footer?: React.ReactNode
  maxWidth?: 'sm' | 'md' | 'lg' | 'xl' | '2xl'
}

export const Modal: React.FC<ModalProps> = ({
  isOpen,
  onClose,
  title,
  subtitle,
  children,
  footer,
  maxWidth = 'md'
}) => {
  // Focus moves in and stays inside while open; Escape closes; focus returns to the opener.
  const dialogRef = useDialogFocus<HTMLDivElement>(isOpen, onClose)
  const titleId = useId()
  const subtitleId = useId()

  if (!isOpen) return null

  const maxWidthClasses = {
    sm: 'max-w-sm',
    md: 'max-w-md',
    lg: 'max-w-lg',
    xl: 'max-w-xl',
    '2xl': 'max-w-2xl'
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-900/45 backdrop-blur-[2px] animate-in fade-in duration-150">
      <div
        className={`outline-none bg-white rounded-xl border border-line shadow-[var(--shadow-pop)] w-full ${maxWidthClasses[maxWidth]} flex flex-col max-h-[calc(100dvh-1.5rem)] sm:max-h-[90vh] overflow-hidden`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={subtitle ? subtitleId : undefined}
        ref={dialogRef}
        tabIndex={-1}
      >
        {/* Header */}
        <div className="pl-4 pr-2 sm:pl-5 sm:pr-3 py-3 sm:py-3.5 border-b border-line flex items-start justify-between gap-2 bg-white">
          <div className="min-w-0 pt-1.5 sm:pt-0">
            <h2 id={titleId} className="text-[15px] font-semibold text-ink tracking-tight">{title}</h2>
            {subtitle && <p id={subtitleId} className="text-xs text-ink-muted mt-0.5">{subtitle}</p>}
          </div>
          <button
            onClick={onClose}
            className="w-[40px] h-[40px] sm:w-8 sm:h-8 shrink-0 flex items-center justify-center rounded-md text-ink-muted hover:text-ink hover:bg-subtle transition-colors"
            aria-label={`Close ${title}`}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="px-4 sm:px-5 py-4 overflow-y-auto overflow-x-hidden space-y-4 text-[13px]" data-dialog-body>
          {children}
        </div>

        {/* Footer */}
        {footer && (
          <div className="px-4 sm:px-5 py-3 border-t border-line bg-panel flex flex-wrap justify-end gap-2">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}
