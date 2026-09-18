import React from 'react'
import { View } from 'react-native'

interface Props {
  children: React.ReactNode
  /** Left inset of the hairlines between rows (px). */
  inset?: 'default' | 'thumbnail' | 'radio' | 'none'
  className?: string
}

/** Inset grouped list: one white rounded group with hairline dividers between rows. */
export const ListGroup: React.FC<Props> = ({ children, inset = 'default', className = '' }) => {
  const rows = React.Children.toArray(children).filter(Boolean)
  const divider = inset === 'thumbnail' ? 'ml-[76px]' : inset === 'radio' ? 'ml-[52px]' : inset === 'none' ? '' : 'ml-4'

  return (
    <View className={`overflow-hidden rounded-2xl bg-surface ${className}`}>
      {rows.map((row, index) => (
        <React.Fragment key={index}>
          {index > 0 && <View className={`h-px bg-line ${divider}`} />}
          {row}
        </React.Fragment>
      ))}
    </View>
  )
}
