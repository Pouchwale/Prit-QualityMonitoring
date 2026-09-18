import React from 'react'
import { View } from 'react-native'

/** The circle of a radio list row: empty ring, or an accent disc with a white dot when chosen. */
export const RadioMark: React.FC<{ selected: boolean }> = ({ selected }) => (
  <View
    className={`h-6 w-6 items-center justify-center rounded-full border-2 ${selected ? 'border-accent bg-accent' : 'border-line-strong bg-surface'}`}
  >
    {selected ? <View className="h-2.5 w-2.5 rounded-full bg-white" /> : null}
  </View>
)
