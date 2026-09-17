import React from 'react'
import { dateKey, parseDateKey } from '../utils/dates'

interface Props {
  value: Date
  maximumDate?: Date
  onChange: (date: Date) => void
}

/** The browser's own date picker, which on phones opens the system date wheel. */
export const DatePicker: React.FC<Props> = ({ value, maximumDate, onChange }) => (
  <input
    type="date"
    value={dateKey(value)}
    max={maximumDate ? dateKey(maximumDate) : undefined}
    onChange={(e) => {
      if (e.target.value) onChange(parseDateKey(e.target.value))
    }}
    style={{
      width: '100%',
      height: 52,
      fontSize: 18,
      padding: '0 14px',
      border: '1px solid #CBD5E1',
      borderRadius: 12,
      background: '#FFFFFF',
      color: '#0F172A',
      boxSizing: 'border-box'
    }}
  />
)
