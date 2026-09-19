import React from 'react'
import { dateKey, formatDateKey, parseDateKey } from '../utils/dates'

interface Props {
  value: Date
  maximumDate?: Date
  minimumDate?: Date
  onChange: (date: Date) => void
}

/**
 * The browser's own date picker (on phones it opens the system date wheel), drawn as DD/MM/YYYY
 * whatever the browser's region is: the native input sits invisibly on top of the formatted text.
 */
export const DatePicker: React.FC<Props> = ({ value, maximumDate, minimumDate, onChange }) => (
  <div style={{ position: 'relative', width: '100%', height: 52 }}>
    <div
      aria-hidden="true"
      style={{
        display: 'flex',
        alignItems: 'center',
        width: '100%',
        height: 52,
        fontSize: 17,
        padding: '0 14px',
        border: '1px solid #E3E3E8',
        borderRadius: 12,
        background: '#F0F0F3',
        color: '#1D1D1F',
        boxSizing: 'border-box'
      }}
    >
      {formatDateKey(dateKey(value))}
    </div>
    <input
      type="date"
      value={dateKey(value)}
      max={maximumDate ? dateKey(maximumDate) : undefined}
      min={minimumDate ? dateKey(minimumDate) : undefined}
      onChange={(e) => {
        if (e.target.value) onChange(parseDateKey(e.target.value))
      }}
      onClick={(e) => {
        try {
          e.currentTarget.showPicker?.()
        } catch {
          // Older browsers: the field still accepts keyboard entry.
        }
      }}
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0, cursor: 'pointer' }}
    />
  </div>
)
