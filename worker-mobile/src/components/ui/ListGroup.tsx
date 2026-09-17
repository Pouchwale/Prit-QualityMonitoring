import React from 'react'
import { View } from 'react-native'

interface Props {
  children: React.ReactNode
}

/** Inset grouped list: one bordered container with hairline dividers between rows. */
export const ListGroup: React.FC<Props> = ({ children }) => {
  const rows = React.Children.toArray(children)

  return (
    <View className="overflow-hidden rounded-xl border border-line bg-surface">
      {rows.map((row, index) => (
        <React.Fragment key={index}>
          {index > 0 && <View className="ml-4 h-px bg-line" />}
          {row}
        </React.Fragment>
      ))}
    </View>
  )
}
