import React from 'react'
import DateTimePicker from '@react-native-community/datetimepicker'

interface Props {
  /** HH:MM, 24-hour, as stored. */
  value: string
  onChange: (hhmm: string) => void
  label: string
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Time wheel on phones, in 12-hour AM/PM. The web app uses TimePicker.web.tsx. */
export const TimePicker: React.FC<Props> = ({ value, onChange }) => {
  const [h, m] = (/^\d{1,2}:\d{2}$/.test(value) ? value : '08:00').split(':').map(Number)
  const date = new Date()
  date.setHours(h, m, 0, 0)
  return (
    <DateTimePicker
      value={date}
      mode="time"
      display="spinner"
      is24Hour={false}
      onChange={(_event, picked) => {
        if (picked) onChange(`${pad(picked.getHours())}:${pad(picked.getMinutes())}`)
      }}
    />
  )
}
