import React from 'react'
import { View, Text, Pressable, type LayoutChangeEvent } from 'react-native'
import { Capture, FormParameter } from '../types'
import { Icon } from './ui/Icon'
import { ParameterInput } from './ParameterField'
import { EvidenceButton } from './EvidenceButton'

/** What the worker chose when marking a parameter Not Applicable. */
export interface NaChoice {
  reasonId: string
  reasonLabel: string
  remark: string
}

interface Props {
  parameter: FormParameter
  /** Position in the form. */
  index: number
  value: string
  na: NaChoice | null
  photo: Capture | null
  video: Capture | null
  /** Everything this parameter needs is filled in. */
  done: boolean
  /** What is still missing after a failed submit, e.g. ["Value", "Photo"]. */
  missing?: string[]
  /** Which evidence step is the next one to do in the whole form (drawn in the accent tint). */
  highlight?: 'photo' | 'video' | null
  onChange: (value: string) => void
  onCapture: (kind: 'photo' | 'video') => void
  onMarkNa: () => void
  onClearNa: () => void
  onLayout?: (event: LayoutChangeEvent) => void
}

/**
 * One parameter on the check form: name and limit, its reading, the evidence it needs and the
 * quiet Not applicable action. A small green tick shows once it is complete.
 */
export const ParameterCard: React.FC<Props> = ({
  parameter: p,
  value,
  na,
  photo,
  video,
  done,
  missing = [],
  highlight = null,
  onChange,
  onCapture,
  onMarkNa,
  onClearNa,
  onLayout
}) => {
  const hasMissing = missing.length > 0

  return (
    <View onLayout={onLayout} className={`rounded-2xl border bg-surface p-4 ${hasMissing ? 'border-missed' : 'border-transparent'}`}>
      <View className="flex-row items-start">
        <View className="flex-1">
          <Text className={`text-[17px] font-semibold leading-[22px] ${p.applicable ? 'text-ink' : 'text-ink-muted'}`}>{p.name}</Text>
          {p.rule && p.applicable && p.type !== 'PASS_FAIL' && p.type !== 'YES_NO' && p.type !== 'DROPDOWN' ? <Text className="mt-0.5 text-[15px] text-ink-muted">{p.rule}</Text> : null}
          {!p.isRequired && p.applicable && !na ? <Text className="mt-0.5 text-[13px] text-ink-muted">Optional</Text> : null}
        </View>
        {done && p.applicable ? (
          <View
            className="ml-3 mt-0.5 h-6 w-6 items-center justify-center rounded-full bg-success"
            accessibilityLabel="Done"
            accessible
          >
            <Icon name="checkmark" size={15} color="white" />
          </View>
        ) : null}
      </View>

      {!p.applicable ? (
        // "Only while a job is running" and no job: nothing to fill in, recorded as Not Applicable.
        <View className="mt-3 flex-row items-center">
          <Icon name="remove-circle-outline" size={18} color="muted" />
          <Text className="ml-2 flex-1 text-[15px] text-ink-muted">Not applicable: {p.notApplicableReason ?? 'No job running'}</Text>
        </View>
      ) : na ? (
        <View className="mt-3 flex-row items-center rounded-xl bg-subtle py-1 pl-3">
          <View className="flex-1 py-2">
            <Text className="text-[15px] font-semibold text-ink-secondary">Not applicable: {na.reasonLabel}</Text>
            {na.remark ? <Text className="mt-0.5 text-[14px] text-ink-muted">{na.remark}</Text> : null}
          </View>
          <Pressable
            onPress={onClearNa}
            accessibilityRole="button"
            accessibilityLabel={`Undo not applicable for ${p.name}`}
            className="h-12 items-center justify-center px-4 active:opacity-50"
          >
            <Text className="text-[16px] font-semibold text-accent">Undo</Text>
          </Pressable>
        </View>
      ) : (
        <View className="mt-3 gap-2.5">
          <ParameterInput parameter={p} value={value} onChange={onChange} invalid={missing.includes('Value')} />

          {p.requirePhoto || photo ? (
            <EvidenceButton
              kind="photo"
              capture={photo}
              required={p.requirePhoto}
              forName={p.name}
              missing={missing.includes('Photo')}
              highlight={highlight === 'photo'}
              onOpenCamera={() => onCapture('photo')}
            />
          ) : null}
          {p.requireVideo || video ? (
            <EvidenceButton
              kind="video"
              capture={video}
              required={p.requireVideo}
              forName={p.name}
              missing={missing.includes('Video')}
              highlight={highlight === 'video'}
              onOpenCamera={() => onCapture('video')}
            />
          ) : null}

          {hasMissing ? <Text className="text-[14px] font-medium text-missed">Still needed: {missing.join(', ')}</Text> : null}

          {p.allowNa ? (
            <Pressable
              onPress={onMarkNa}
              accessibilityRole="button"
              accessibilityLabel={`Not applicable: ${p.name}`}
              className="-mb-2 h-11 justify-center self-start active:opacity-50"
            >
              <Text className="text-[15px] text-ink-muted">Not applicable?</Text>
            </Pressable>
          ) : null}
        </View>
      )}
    </View>
  )
}
