import React, { useEffect, useRef } from 'react'
import { Platform } from 'react-native'
import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker'

interface Props {
  value: Date
  maximumDate?: Date
  minimumDate?: Date
  onChange: (date: Date) => void
  /** Android: the date dialog was closed without choosing a date. */
  onDismiss?: () => void
}

/**
 * The date picker on phones. iOS shows the date wheel inline. Android has no inline picker: it opens
 * the system date dialog once when this appears (mount it again, e.g. with a new key, to reopen it).
 * The web app uses DatePicker.web.tsx.
 */
export const DatePicker: React.FC<Props> = ({ value, maximumDate, minimumDate, onChange, onDismiss }) => {
  // The dialog reports back through the latest callbacks, not the ones from when it opened.
  const latest = useRef({ onChange, onDismiss })
  latest.current = { onChange, onDismiss }

  useEffect(() => {
    if (Platform.OS !== 'android') return
    DateTimePickerAndroid.open({
      value,
      mode: 'date',
      minimumDate,
      maximumDate,
      onChange: (event, date) => {
        if (event.type === 'set' && date) latest.current.onChange(date)
        else latest.current.onDismiss?.()
      }
    })
    // Opened once per mount on purpose: re-rendering must not open a second dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (Platform.OS === 'android') return null
  return (
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
}
