import React from 'react'
import DateTimePicker from '@react-native-community/datetimepicker'

interface Props {
  value: Date
  maximumDate?: Date
  minimumDate?: Date
  onChange: (date: Date) => void
}

/** Date wheel on phones. The web app uses DatePicker.web.tsx (the browser's date input). */
export const DatePicker: React.FC<Props> = ({ value, maximumDate, minimumDate, onChange }) => (
  <DateTimePicker
    value={value}
    mode="date"
    display="spinner"
    maximumDate={maximumDate}
    minimumDate={minimumDate}
    onChange={(_event, date) => {
      if (date) onChange(date)
    }}
  />
)
