import React, { useId } from 'react'

/** Shared form controls so every admin form looks and behaves the same. */

/**
 * Below the lg breakpoint controls are 40px tall with 16px text (pixel values, because the
 * root font size is 13.5px and rem-based heights would come out too small to tap): easy to tap, and phones
 * do not zoom into a focused field. From lg up they keep the compact desktop size.
 */
export const inputClass =
  'w-full min-w-0 h-[40px] lg:h-8 px-2.5 text-[16px] lg:text-[13px] border border-line-strong rounded-md bg-white text-ink shadow-[0_1px_1px_rgb(15_23_42/0.03)] transition-[border-color,box-shadow] duration-150 hover:border-ink-faint/50 placeholder:text-ink-faint focus:outline-none focus:ring-2 focus:ring-accent/25 focus:border-accent disabled:bg-subtle disabled:text-ink-muted aria-[invalid=true]:border-missed'

interface FieldProps {
  label: string
  required?: boolean
  hint?: string
  error?: string | null
  className?: string
  children: React.ReactNode
}

/**
 * A labelled form control. The hint or error under it is linked to the control (aria-describedby),
 * and an error also marks the control invalid, so screen readers read both with the field.
 */
export const Field: React.FC<FieldProps> = ({ label, required, hint, error, className = '', children }) => {
  const noteId = useId()
  const note = error || hint
  const control = React.isValidElement<{ 'aria-describedby'?: string; 'aria-invalid'?: boolean; required?: boolean }>(children)
    ? React.cloneElement(children, {
        'aria-describedby': note ? noteId : undefined,
        'aria-invalid': error ? true : undefined
      })
    : children
  return (
    <label className={`block ${className}`}>
      <span className="block text-[13px] lg:text-[12.5px] font-medium text-ink-secondary mb-1.5">
        {label}
        {required && (
          <>
            <span className="text-missed" aria-hidden>
              {' '}
              *
            </span>
            <span className="sr-only"> (required)</span>
          </>
        )}
      </span>
      {control}
      {error ? (
        <span id={noteId} className="block text-[11px] text-missed mt-1" role="alert">
          {error}
        </span>
      ) : hint ? (
        <span id={noteId} className="block text-[11px] text-ink-muted mt-1">
          {hint}
        </span>
      ) : null}
    </label>
  )
}

export const TextInput: React.FC<React.ComponentProps<'input'>> = ({ className = '', ...props }) => (
  <input type="text" className={`${inputClass} ${className}`} {...props} />
)

export const Select: React.FC<React.SelectHTMLAttributes<HTMLSelectElement>> = ({ className = '', children, ...props }) => (
  <select className={`${inputClass} px-2 ${className}`} {...props}>
    {children}
  </select>
)

export const TextArea: React.FC<React.TextareaHTMLAttributes<HTMLTextAreaElement>> = ({ className = '', ...props }) => (
  <textarea
    className={`w-full px-2.5 py-2 text-[16px] lg:text-[13px] border border-line-strong rounded-md bg-white text-ink placeholder:text-ink-faint focus:outline-none focus:ring-2 focus:ring-accent/25 focus:border-accent aria-[invalid=true]:border-missed ${className}`}
    rows={3}
    {...props}
  />
)

interface ToggleProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  description?: string
  disabled?: boolean
}

/** Checkbox with a label and optional description. */
export const Toggle: React.FC<ToggleProps> = ({ checked, onChange, label, description, disabled }) => (
  <label className={`flex items-start gap-2.5 lg:gap-2 py-1 lg:py-0 ${disabled ? 'opacity-60' : 'cursor-pointer'}`}>
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
      className="mt-0.5 h-4 w-4 lg:h-3.5 lg:w-3.5 shrink-0 rounded border-line-strong accent-accent"
    />
    <span>
      <span className="block text-sm lg:text-xs font-medium text-ink">{label}</span>
      {description && <span className="block text-[11px] text-ink-muted">{description}</span>}
    </span>
  </label>
)

/** Scrollable list of checkboxes for picking several items (machines, activities…). */
export const MultiSelectList: React.FC<{
  items: { id: string; label: string; detail?: string | null }[]
  selected: string[]
  onChange: (ids: string[]) => void
  emptyText?: string
  disabled?: boolean
}> = ({ items, selected, onChange, emptyText = 'Nothing to choose from', disabled }) => (
  <div className="max-h-44 overflow-y-auto border border-line-strong rounded-md divide-y divide-line bg-white">
    {items.length === 0 ? (
      <div className="px-3 py-2.5 text-[11px] text-ink-muted">{emptyText}</div>
    ) : (
      items.map((item) => {
        const isOn = selected.includes(item.id)
        return (
          <label key={item.id} className={`flex items-center gap-2 px-3 py-2.5 lg:py-1.5 text-sm lg:text-xs ${disabled ? '' : 'cursor-pointer hover:bg-subtle'}`}>
            <input
              type="checkbox"
              checked={isOn}
              disabled={disabled}
              onChange={() => onChange(isOn ? selected.filter((id) => id !== item.id) : [...selected, item.id])}
              className="h-4 w-4 lg:h-3.5 lg:w-3.5 shrink-0 accent-accent"
            />
            <span className="flex-1 min-w-0 text-ink">{item.label}</span>
            {item.detail && <span className="text-[11px] text-ink-muted">{item.detail}</span>}
          </label>
        )
      })
    )}
  </div>
)

/** Error banner shown at the top of a form. */
export const FormError: React.FC<{ message: string | null }> = ({ message }) =>
  message ? (
    <div className="px-3 py-2 rounded-md border border-failed-line bg-failed-bg text-[12.5px] text-missed" role="alert">
      {message}
    </div>
  ) : null
