import React from 'react'
import { View, Text, Pressable } from 'react-native'
import { FormParameter } from '../types'
import { FieldLabel } from './ui/FieldLabel'
import { TextField } from './ui/TextField'
import { Icon, type IconColor, type IconName } from './ui/Icon'

interface Props {
  parameter: FormParameter
  value: string
  onChange: (value: string) => void
  /** Drawn in the "still needed" colour after a failed submit. */
  invalid?: boolean
}

export function numberStatus(p: FormParameter, raw: string): 'ok' | 'out' | null {
  if (raw.trim() === '' || (p.minValue == null && p.maxValue == null)) return null
  const n = Number(raw.replace(',', '.'))
  if (!Number.isFinite(n)) return 'out'
  const ok = (p.minValue == null || n >= p.minValue) && (p.maxValue == null || n <= p.maxValue)
  return ok ? 'ok' : 'out'
}

/**
 * A multi-select dropdown keeps its answer as one comma-separated value, exactly as the server
 * stores and the reports show it. An option whose own text has a comma is matched whole first.
 */
export function selectedOptions(p: FormParameter, raw: string): string[] {
  const text = raw.trim()
  if (text === '') return []
  if (p.options.includes(text)) return [text]
  if (!p.multiSelect && !hasMaterial(p)) return [text]
  return text.split(',').map((v) => v.trim()).filter(Boolean)
}

/** Adds or removes one option, keeping the admin's order. */
export function toggleOption(p: FormParameter, chosen: string[], option: string): string {
  const next = chosen.includes(option) ? chosen.filter((c) => c !== option) : [...chosen, option]
  return p.options.filter((o) => next.includes(o)).join(', ')
}

/** This dropdown asks for a material before its options, e.g. Corona Treatment. */
export const hasMaterial = (p: FormParameter) => (p.materialOptions?.length ?? 0) > 0

/** The material and the option already chosen, from the stored "<material>, <option>" value. */
export function materialAnswer(p: FormParameter, raw: string) {
  const chosen = selectedOptions(p, raw)
  return {
    material: chosen.find((c) => p.materialOptions?.includes(c)) ?? null,
    option: chosen.find((c) => p.options.includes(c)) ?? null
  }
}

/** The value after changing one half of the answer; the other half is kept. */
export const materialValue = (material: string | null, option: string | null) => [material, option].filter(Boolean).join(', ')

/** One dropdown choice. Same look as before: tinted with a tick once it is the answer. */
const Chip: React.FC<{
  label: string
  selected: boolean
  invalid?: boolean
  role?: 'radio' | 'checkbox'
  accessibilityLabel: string
  onPress: () => void
}> = ({ label, selected, invalid = false, role = 'radio', accessibilityLabel, onPress }) => (
  <Pressable
    onPress={onPress}
    accessibilityRole={role}
    accessibilityLabel={accessibilityLabel}
    accessibilityState={{ checked: selected }}
    className={`h-12 min-w-[30%] flex-row items-center justify-center rounded-xl border px-4 ${
      selected ? 'border-accent bg-accent-soft' : invalid ? 'border-missed bg-surface' : 'border-transparent bg-subtle active:opacity-60'
    }`}
  >
    {selected ? (
      <View className="mr-1.5">
        <Icon name="checkmark" size={18} color="accent" />
      </View>
    ) : null}
    <Text className={`text-[17px] ${selected ? 'font-semibold text-accent' : 'font-medium text-ink'}`}>{label}</Text>
  </Pressable>
)

type Tone = 'success' | 'missed' | 'accent'

/** Literal class strings per tone (NativeWind needs them written out). */
const SELECTED: Record<Tone, { box: string; text: string; icon: IconColor }> = {
  success: { box: 'border-success-line bg-success-bg', text: 'text-success', icon: 'success' },
  missed: { box: 'border-missed-line bg-missed-bg', text: 'text-missed', icon: 'missed' },
  accent: { box: 'border-accent bg-accent-soft', text: 'text-accent', icon: 'accent' }
}

/** iOS-style segmented control: grey track, the chosen side tinted. */
const Segmented: React.FC<{
  options: { value: string; label: string; tone: Tone; icon?: IconName }[]
  value: string
  /** Parameter name, so a screen reader says "Pass for TEAP Test". */
  forName: string
  onChange: (value: string) => void
  invalid?: boolean
}> = ({ options, value, forName, onChange, invalid }) => (
  <View
    accessibilityRole="radiogroup"
    className={`h-[52px] flex-row rounded-xl border p-1 ${invalid ? 'border-missed bg-surface' : 'border-transparent bg-subtle'}`}
  >
    {options.map((o) => {
      const selected = value === o.value
      const tone = SELECTED[o.tone]
      return (
        <Pressable
          key={o.value}
          onPress={() => onChange(o.value)}
          accessibilityRole="radio"
          accessibilityLabel={`${o.label} for ${forName}`}
          accessibilityState={{ checked: selected }}
          className={`flex-1 flex-row items-center justify-center rounded-[9px] border ${
            selected ? tone.box : 'border-transparent active:opacity-60'
          }`}
        >
          {selected && o.icon ? (
            <View className="mr-1.5">
              <Icon name={o.icon} size={18} color={tone.icon} />
            </View>
          ) : null}
          <Text className={`text-[17px] ${selected ? `font-semibold ${tone.text}` : 'font-medium text-ink-secondary'}`}>{o.label}</Text>
        </Pressable>
      )
    })}
  </View>
)

/** The input itself, without a label: number, text, pass/fail, yes/no or a dropdown. */
export const ParameterInput: React.FC<Props> = ({ parameter: p, value, onChange, invalid = false }) => {
  const status = p.type === 'NUMBER' ? numberStatus(p, value) : null

  return (
    <View>
      {p.type === 'NUMBER' && (
        <>
          <TextField
            keyboardType="decimal-pad"
            placeholder="Enter value"
            value={value}
            onChangeText={onChange}
            suffix={p.unit}
            invalid={invalid}
            accessibilityLabel={p.name}
          />
          {status ? (
            <View className="mt-2 flex-row items-center">
              <View className={`mr-1.5 h-2 w-2 rounded-full ${status === 'ok' ? 'bg-success' : 'bg-missed'}`} />
              <Text className={`text-[15px] font-medium ${status === 'ok' ? 'text-success' : 'text-missed'}`}>
                {status === 'ok' ? 'Within range' : 'Out of range'}
              </Text>
            </View>
          ) : null}
        </>
      )}

      {p.type === 'TEXT' && (
        <TextField placeholder="Type here" value={value} onChangeText={onChange} invalid={invalid} accessibilityLabel={p.name} />
      )}

      {p.type === 'PASS_FAIL' && (
        <Segmented
          value={value}
          forName={p.name}
          onChange={onChange}
          invalid={invalid}
          options={[
            { value: 'PASS', label: 'Pass', tone: 'success', icon: 'checkmark' },
            { value: 'FAIL', label: 'Fail', tone: 'missed', icon: 'close' }
          ]}
        />
      )}

      {p.type === 'YES_NO' && (
        <Segmented
          value={value}
          forName={p.name}
          onChange={onChange}
          invalid={invalid}
          options={[
            { value: 'YES', label: 'Yes', tone: 'accent' },
            { value: 'NO', label: 'No', tone: 'accent' }
          ]}
        />
      )}

      {p.type === 'DROPDOWN' && hasMaterial(p) ? (
        // Two answers, in order: the material, then the option. The options never depend on the
        // material, they simply wait until one is chosen so the worker answers in the right order.
        <View className="gap-3">
          <View>
            <Text className="mb-1.5 text-[15px] font-medium text-ink-muted">Material</Text>
            <View className="flex-row flex-wrap gap-2" accessibilityRole="radiogroup">
              {(p.materialOptions ?? []).map((material) => {
                const answer = materialAnswer(p, value)
                const selected = answer.material === material
                return (
                  <Chip
                    key={material}
                    label={material}
                    selected={selected}
                    invalid={invalid && !answer.material}
                    accessibilityLabel={`${material} for ${p.name}`}
                    onPress={() => onChange(materialValue(selected && !p.isRequired ? null : material, answer.option))}
                  />
                )
              })}
            </View>
          </View>
          {materialAnswer(p, value).material ? (
            <View>
              {/* No label: the card is already headed with the parameter's name. */}
              <View className="flex-row flex-wrap gap-2" accessibilityRole="radiogroup">
                {p.options.map((option) => {
                  const answer = materialAnswer(p, value)
                  const selected = answer.option === option
                  return (
                    <Chip
                      key={option}
                      label={option}
                      selected={selected}
                      invalid={invalid && !answer.option}
                      accessibilityLabel={`${option} for ${p.name}`}
                      onPress={() => onChange(materialValue(answer.material, selected && !p.isRequired ? null : option))}
                    />
                  )
                })}
              </View>
            </View>
          ) : (
            <Text className="text-[15px] text-ink-muted">Choose the material first.</Text>
          )}
        </View>
      ) : null}

      {p.type === 'DROPDOWN' && !hasMaterial(p) && (
        <View className="flex-row flex-wrap gap-2" accessibilityRole={p.multiSelect ? undefined : 'radiogroup'}>
          {p.options.map((option) => {
            const chosen = selectedOptions(p, value)
            const selected = chosen.includes(option)
            return (
              <Chip
                key={option}
                label={option}
                selected={selected}
                invalid={invalid}
                role={p.multiSelect ? 'checkbox' : 'radio'}
                accessibilityLabel={`${option} for ${p.name}`}
                onPress={() => onChange(p.multiSelect ? toggleOption(p, chosen, option) : selected && !p.isRequired ? '' : option)}
              />
            )
          })}
        </View>
      )}
    </View>
  )
}

/** Label plus input, used where a parameter needs no evidence card of its own. */
export const ParameterField: React.FC<Props> = ({ parameter: p, value, onChange, invalid }) => (
  <View>
    <FieldLabel
      label={p.name}
      required={p.isRequired}
      hint={p.type === 'DROPDOWN' ? (p.multiSelect ? 'Select all that apply' : null) : p.type === 'YES_NO' || p.type === 'PASS_FAIL' ? null : p.rule}
    />
    <ParameterInput parameter={p} value={value} onChange={onChange} invalid={invalid} />
  </View>
)
