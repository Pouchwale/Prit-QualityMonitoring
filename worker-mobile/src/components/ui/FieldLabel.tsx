import React from 'react'
import { View, Text } from 'react-native'

interface Props {
  label: string
  required?: boolean
  hint?: string | null
}

/** Plain label above a form field. Optional fields say so; required ones stay quiet. */
export const FieldLabel: React.FC<Props> = ({ label, required = true, hint }) => (
  <View className="mb-2">
    <View className="flex-row items-baseline">
      <Text className="flex-1 text-[15px] font-semibold text-ink-secondary">{label}</Text>
      {!required ? <Text className="text-[13px] text-ink-muted">Optional</Text> : null}
    </View>
    {hint ? <Text className="mt-0.5 text-[13px] text-ink-muted">{hint}</Text> : null}
  </View>
)
