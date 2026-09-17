import React from 'react'
import { View, Text } from 'react-native'
import { QualityCheckStatus } from '../../types'

/** The only statuses shown. A check that is not finished yet has no status label. */
const STATUS: Partial<Record<QualityCheckStatus, { label: string; dot: string; text: string }>> = {
  COMPLETED: { label: 'Completed', dot: 'bg-success', text: 'text-success' },
  MISSED: { label: 'Missed', dot: 'bg-missed', text: 'text-missed' },
  EXCEPTION: { label: 'Exception', dot: 'bg-exception', text: 'text-exception' }
}

export const hasStatusLabel = (status: QualityCheckStatus) => STATUS[status] !== undefined

export const StatusLabel: React.FC<{ status: QualityCheckStatus }> = ({ status }) => {
  const s = STATUS[status]
  if (!s) return null

  return (
    <View className="flex-row items-center">
      <View className={`mr-1.5 h-2 w-2 rounded-full ${s.dot}`} />
      <Text className={`text-[14px] font-semibold ${s.text}`}>{s.label}</Text>
    </View>
  )
}
