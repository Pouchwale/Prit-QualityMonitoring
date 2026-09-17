import React from 'react'
import { View, Text, Pressable } from 'react-native'
import { FormParameter } from '../types'
import { FieldLabel } from './ui/FieldLabel'
import { TextField } from './ui/TextField'

interface Props {
  parameter: FormParameter
  value: string
  onChange: (value: string) => void
}

export function numberStatus(p: FormParameter, raw: string): 'ok' | 'out' | null {
  if (raw.trim() === '' || (p.minValue == null && p.maxValue == null)) return null
  const n = Number(raw.replace(',', '.'))
  if (!Number.isFinite(n)) return 'out'
  const ok = (p.minValue == null || n >= p.minValue) && (p.maxValue == null || n <= p.maxValue)
  return ok ? 'ok' : 'out'
}

/** Two large choices, e.g. Pass / Fail or Yes / No. */
const Choice: React.FC<{
  options: { value: string; label: string; selectedClass: string }[]
  value: string
  onChange: (value: string) => void
}> = ({ options, value, onChange }) => (
  <View className="flex-row gap-3">
    {options.map((o) => {
      const selected = value === o.value
      return (
        <Pressable
          key={o.value}
          onPress={() => onChange(o.value)}
          accessibilityRole="radio"
          accessibilityState={{ checked: selected }}
          className={`h-14 flex-1 items-center justify-center rounded-xl border ${selected ? o.selectedClass : 'border-line-strong bg-surface active:bg-subtle'}`}
        >
          <Text className={`text-[18px] font-semibold ${selected ? 'text-white' : 'text-ink'}`}>{o.label}</Text>
        </Pressable>
      )
    })}
  </View>
)

export const ParameterField: React.FC<Props> = ({ parameter: p, value, onChange }) => {
  const status = p.type === 'NUMBER' ? numberStatus(p, value) : null

  return (
    <View>
      <FieldLabel label={p.name} required={p.isRequired} hint={p.type === 'DROPDOWN' || p.type === 'YES_NO' || p.type === 'PASS_FAIL' ? null : p.rule} />

      {p.type === 'NUMBER' && (
        <>
          <TextField
            keyboardType="decimal-pad"
            placeholder="Enter value"
            value={value}
            onChangeText={onChange}
            suffix={p.unit}
          />
          {status ? (
            <Text className={`mt-2 text-[15px] font-semibold ${status === 'ok' ? 'text-success' : 'text-failed'}`}>
              {status === 'ok' ? 'Within range' : 'Out of range'}
            </Text>
          ) : null}
        </>
      )}

      {p.type === 'TEXT' && <TextField placeholder="Type here" value={value} onChangeText={onChange} />}

      {p.type === 'PASS_FAIL' && (
        <Choice
          value={value}
          onChange={onChange}
          options={[
            { value: 'PASS', label: 'Pass', selectedClass: 'border-success bg-success' },
            { value: 'FAIL', label: 'Fail', selectedClass: 'border-failed bg-failed' }
          ]}
        />
      )}

      {p.type === 'YES_NO' && (
        <Choice
          value={value}
          onChange={onChange}
          options={[
            { value: 'YES', label: 'Yes', selectedClass: 'border-accent bg-accent' },
            { value: 'NO', label: 'No', selectedClass: 'border-accent bg-accent' }
          ]}
        />
      )}

      {p.type === 'DROPDOWN' && (
        <View className="flex-row flex-wrap gap-3">
          {p.options.map((option) => {
            const selected = value === option
            return (
              <Pressable
                key={option}
                onPress={() => onChange(selected && !p.isRequired ? '' : option)}
                accessibilityRole="radio"
                accessibilityState={{ checked: selected }}
                className={`h-12 min-w-[30%] items-center justify-center rounded-xl border px-4 ${selected ? 'border-accent bg-accent' : 'border-line-strong bg-surface active:bg-subtle'}`}
              >
                <Text className={`text-[17px] font-semibold ${selected ? 'text-white' : 'text-ink'}`}>{option}</Text>
              </Pressable>
            )
          })}
        </View>
      )}
    </View>
  )
}
