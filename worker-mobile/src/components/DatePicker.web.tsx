import React from 'react'
import { dateKey, parseDateKey } from '../utils/dates'

interface Props {
  value: Date
  maximumDate?: Date
  minimumDate?: Date
  onChange: (date: Date) => void
}

/** The browser's own date picker, which on phones opens the system date wheel. */
export const DatePicker: React.FC<Props> = ({ value, maximumDate, minimumDate, onChange }) => (
  <input
    type="date"
    value={dateKey(value)}
    max={maximumDate ? dateKey(maximumDate) : undefined}
    min={minimumDate ? dateKey(minimumDate) : undefined}
    onChange={(e) => {
      if (e.target.value) onChange(parseDateKey(e.target.value))
    }}
    style={{
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
  />
)
