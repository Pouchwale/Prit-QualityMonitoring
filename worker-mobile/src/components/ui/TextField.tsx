import React, { forwardRef } from 'react'
import { View, Text, TextInput, TextInputProps } from 'react-native'

interface Props extends Omit<TextInputProps, 'className'> {
  suffix?: string | null
  multiline?: boolean
  className?: string
}

export const PLACEHOLDER_COLOR = '#94A3B8' // ink-faint

/** Large input used across the worker app. */
export const TextField = forwardRef<TextInput, Props>(({ suffix, multiline, className = '', ...props }, ref) => (
  <View
    className={`flex-row rounded-xl border border-line-strong bg-surface px-4 ${multiline ? 'min-h-[104px] items-start py-3' : 'h-14 items-center'} ${className}`}
  >
    <TextInput
      ref={ref}
      placeholderTextColor={PLACEHOLDER_COLOR}
      multiline={multiline}
      textAlignVertical={multiline ? 'top' : 'center'}
      className={`flex-1 text-[18px] text-ink ${multiline ? 'min-h-[80px] py-0' : 'h-full py-0'}`}
      {...props}
    />
    {suffix ? <Text className="ml-2 text-[17px] text-ink-muted">{suffix}</Text> : null}
  </View>
))

TextField.displayName = 'TextField'
