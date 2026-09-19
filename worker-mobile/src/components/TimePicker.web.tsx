import React from 'react'

interface Props {
  /** HH:MM, 24-hour, as stored. */
  value: string
  onChange: (hhmm: string) => void
  label: string
}

const pad = (n: number) => String(n).padStart(2, '0')
const HOURS = Array.from({ length: 12 }, (_, i) => i + 1)
const MINUTES = Array.from({ length: 60 }, (_, i) => pad(i))

const selectStyle: React.CSSProperties = {
  height: 52,
  fontSize: 17,
  padding: '0 10px',
  border: '1px solid #E3E3E8',
  borderRadius: 12,
  background: '#F0F0F3',
  color: '#1D1D1F',
  flex: 1,
  minWidth: 0
}

/** Hour, minute and AM/PM selects for the web app: always 12-hour, whatever the browser's region. */
export const TimePicker: React.FC<Props> = ({ value, onChange, label }) => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value)
  const h24 = match ? Number(match[1]) % 24 : 8
  const minute = match ? match[2] : '00'
  const hour12 = h24 % 12 || 12
  const pm = h24 >= 12
  const emit = (hour: number, min: string, isPm: boolean) => onChange(`${pad((hour % 12) + (isPm ? 12 : 0))}:${min}`)
  return (
    <div role="group" aria-label={label} style={{ display: 'flex', gap: 8, width: '100%' }}>
      <select aria-label={`${label} hour`} value={hour12} onChange={(e) => emit(Number(e.target.value), minute, pm)} style={selectStyle}>
        {HOURS.map((h) => (
          <option key={h} value={h}>
            {h}
          </option>
        ))}
      </select>
      <select aria-label={`${label} minute`} value={minute} onChange={(e) => emit(hour12, e.target.value, pm)} style={selectStyle}>
        {MINUTES.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
      <select aria-label={`${label} AM or PM`} value={pm ? 'PM' : 'AM'} onChange={(e) => emit(hour12, minute, e.target.value === 'PM')} style={selectStyle}>
        <option value="AM">AM</option>
        <option value="PM">PM</option>
      </select>
    </div>
  )
}
