import React from 'react'
import { CalendarDays } from 'lucide-react'
import { formatDateKey } from '../../lib/format'
import { inputClass } from './Form'

type NativeDateProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange'>

interface DateInputProps extends NativeDateProps {
  /** YYYY-MM-DD, or '' when empty. */
  value: string
  onChange: (event: React.ChangeEvent<HTMLInputElement>) => void
}

/**
 * A date field that always reads DD/MM/YYYY, whatever the computer's region setting is.
 * The browser's own date input sits invisibly on top, so clicking anywhere opens the usual
 * calendar picker and keyboard entry still works; the value stays YYYY-MM-DD for the API.
 */
export const DateInput: React.FC<DateInputProps> = ({ value, onChange, className = '', disabled, ...props }) => {
  // aria-invalid on the field also draws the red border, as on the other inputs.
  const invalid = props['aria-invalid'] === true || props['aria-invalid'] === 'true'
  return (
    <span className={`relative block min-w-0 ${className}`}>
      <span
        className={`${inputClass} flex items-center justify-between gap-1.5 ${disabled ? 'bg-subtle text-ink-muted' : ''} ${invalid ? 'border-failed' : ''}`}
        aria-hidden="true"
      >
        <span className={value ? '' : 'text-ink-faint'}>{value ? formatDateKey(value) : 'DD/MM/YYYY'}</span>
        <CalendarDays className="w-3.5 h-3.5 shrink-0 text-ink-muted" />
      </span>
      <input
        {...props}
        type="date"
        value={value}
        disabled={disabled}
        onChange={onChange}
        onClick={(e) => {
          try {
            e.currentTarget.showPicker?.()
          } catch {
            // Older browsers: the field still accepts keyboard entry.
          }
        }}
        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-not-allowed"
      />
    </span>
  )
}

const HOURS = Array.from({ length: 12 }, (_, i) => i + 1)
const MINUTES = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, '0'))

interface TimeInputProps {
  /** HH:MM (24-hour, as stored), or '' when empty. */
  value: string
  onChange: (value: string) => void
  /** Accessible name, e.g. "Start time". */
  label: string
  disabled?: boolean
  className?: string
}

/**
 * A 12-hour time field: hour, minute and AM/PM. It reads and writes the stored 24-hour HH:MM
 * value, so shifts and schedule windows keep working exactly as before.
 */
export const TimeInput: React.FC<TimeInputProps> = ({ value, onChange, label, disabled, className = '' }) => {
  const match = /^(\d{1,2}):(\d{2})/.exec(value)
  const h24 = match ? Number(match[1]) % 24 : 8
  const minute = match ? match[2] : '00'
  const hour12 = h24 % 12 || 12
  const pm = h24 >= 12
  const emit = (hour: number, min: string, isPm: boolean) => {
    const h = (hour % 12) + (isPm ? 12 : 0)
    onChange(`${String(h).padStart(2, '0')}:${min}`)
  }
  const select = `${inputClass} flex-1 min-w-0 pl-2 pr-0.5`
  return (
    <span className={`flex w-full min-w-0 items-center gap-1 ${className}`} role="group" aria-label={label}>
      <select aria-label={`${label} hour`} disabled={disabled} value={hour12} onChange={(e) => emit(Number(e.target.value), minute, pm)} className={select}>
        {HOURS.map((h) => (
          <option key={h} value={h}>
            {h}
          </option>
        ))}
      </select>
      <span className="text-ink-muted">:</span>
      <select aria-label={`${label} minute`} disabled={disabled} value={minute} onChange={(e) => emit(hour12, e.target.value, pm)} className={select}>
        {MINUTES.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
      <select aria-label={`${label} AM or PM`} disabled={disabled} value={pm ? 'PM' : 'AM'} onChange={(e) => emit(hour12, minute, e.target.value === 'PM')} className={select}>
        <option value="AM">AM</option>
        <option value="PM">PM</option>
      </select>
    </span>
  )
}
