import React from 'react'
import { View, Text } from 'react-native'

interface Props {
  label: string
  required?: boolean
  hint?: string | null
}

/** Large, plain label for a form field. Optional fields say so; required ones stay quiet. */
export const FieldLabel: React.FC<Props> = ({ label, required = true, hint }) => (
  <View className="mb-2.5">
    <View className="flex-row items-baseline">
      <Text className="flex-1 text-[18px] font-semibold text-ink">{label}</Text>
      {!required ? <Text className="text-[14px] text-ink-muted">Optional</Text> : null}
    </View>
    {hint ? <Text className="mt-0.5 text-[15px] text-ink-muted">{hint}</Text> : null}
  </View>
)
