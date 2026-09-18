import React, { forwardRef, useState } from 'react'
import { View, Text, TextInput, TextInputProps, Platform } from 'react-native'

interface Props extends Omit<TextInputProps, 'className'> {
  suffix?: string | null
  multiline?: boolean
  /** Draws the field in the "still needed" colour. */
  invalid?: boolean
  /** "filled" (grey) inside a white group; "outlined" (white with a hairline) on the grey page. */
  variant?: 'filled' | 'outlined'
  className?: string
}

export const PLACEHOLDER_COLOR = '#8E8E93' // ink-faint

/** Large input used across the worker app: grey fill, accent outline while typing. */
export const TextField = forwardRef<TextInput, Props>(
  ({ suffix, multiline, invalid = false, variant = 'filled', className = '', onFocus, onBlur, ...props }, ref) => {
    const [focused, setFocused] = useState(false)
    const frame = invalid ? 'border-missed bg-surface' : focused ? 'border-accent bg-surface' : variant === 'outlined' ? 'border-line bg-surface' : 'border-transparent bg-subtle'

    return (
      <View
        className={`flex-row rounded-xl border px-4 ${frame} ${multiline ? 'min-h-[104px] items-start py-3' : 'h-[52px] items-center'} ${className}`}
      >
        <TextInput
          ref={ref}
          placeholderTextColor={PLACEHOLDER_COLOR}
          multiline={multiline}
          textAlignVertical={multiline ? 'top' : 'center'}
          className={`flex-1 text-[17px] text-ink ${multiline ? 'min-h-[80px] py-0' : 'h-full py-0'}`}
          // The browser focus ring is replaced by the accent border.
          style={Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : undefined}
          onFocus={(e) => {
            setFocused(true)
            onFocus?.(e)
          }}
          onBlur={(e) => {
            setFocused(false)
            onBlur?.(e)
          }}
          {...props}
        />
        {suffix ? <Text className="ml-2 text-[17px] text-ink-muted">{suffix}</Text> : null}
      </View>
    )
  }
)

TextField.displayName = 'TextField'
