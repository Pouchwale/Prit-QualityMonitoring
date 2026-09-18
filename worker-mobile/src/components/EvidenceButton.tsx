import React from 'react'
import { View, Text, Pressable, Image } from 'react-native'
import { Capture } from '../types'
import { formatDuration, formatTime } from '../utils/format'
import { Icon } from './ui/Icon'

interface Props {
  kind: 'photo' | 'video'
  capture: Capture | null
  required: boolean
  /** Parameter this evidence belongs to; used for the accessible names. */
  forName: string
  onOpenCamera: () => void
  /** Drawn in red after a failed submit when this file is still missing. */
  missing?: boolean
  /** The next photo/video step of the form: drawn in the accent tint. */
  highlight?: boolean
}

/**
 * The photo or video one parameter needs: a "Take photo" / "Record video" row that becomes a
 * thumbnail with Retake. The camera only opens when the worker taps it.
 */
export const EvidenceButton: React.FC<Props> = ({
  kind,
  capture,
  required,
  forName,
  onOpenCamera,
  missing = false,
  highlight = false
}) => {
  const isPhoto = kind === 'photo'

  if (capture) {
    return (
      <View className="min-h-[60px] flex-row items-center rounded-xl bg-subtle py-2 pl-2 pr-1">
        {isPhoto ? (
          <Image source={{ uri: capture.uri }} className="h-11 w-11 rounded-lg bg-line" resizeMode="cover" />
        ) : (
          <View className="h-11 w-11 items-center justify-center rounded-lg bg-ink">
            <Icon name="play" size={18} color="white" />
          </View>
        )}
        <View className="ml-3 flex-1">
          <View className="flex-row items-center">
            <Icon name="checkmark-circle" size={16} color="success" />
            <Text className="ml-1 text-[15px] font-semibold text-ink">{isPhoto ? 'Photo taken' : 'Video recorded'}</Text>
          </View>
          <Text className="mt-0.5 text-[13px] text-ink-muted">
            {!isPhoto && capture.durationSeconds != null
              ? `${formatDuration(capture.durationSeconds)} · ${formatTime(capture.capturedAt)}`
              : formatTime(capture.capturedAt)}
          </Text>
        </View>
        <Pressable
          onPress={onOpenCamera}
          accessibilityRole="button"
          accessibilityLabel={isPhoto ? `Retake photo for ${forName}` : `Record video again for ${forName}`}
          className="h-12 min-w-[48px] items-center justify-center px-3 active:opacity-50"
        >
          <Text className="text-[16px] font-semibold text-accent">Retake</Text>
        </Pressable>
      </View>
    )
  }

  const box = missing ? 'bg-missed-bg' : highlight ? 'border-accent bg-accent-soft' : 'bg-subtle'
  return (
    <Pressable
      onPress={onOpenCamera}
      accessibilityRole="button"
      accessibilityLabel={isPhoto ? `Take photo for ${forName}` : `Record video for ${forName}`}
      className={`h-[52px] flex-row items-center rounded-xl border px-3 active:opacity-70 ${highlight && !missing ? '' : 'border-transparent'} ${box}`}
    >
      <View className={`h-8 w-8 items-center justify-center rounded-full ${highlight || missing ? 'bg-surface' : 'bg-accent-soft'}`}>
        <Icon name={isPhoto ? 'camera-outline' : 'videocam-outline'} size={18} color={missing ? 'missed' : 'accent'} />
      </View>
      <Text className={`ml-3 flex-1 text-[17px] font-semibold ${missing ? 'text-missed' : highlight ? 'text-accent' : 'text-ink'}`}>
        {isPhoto ? 'Take photo' : 'Record video'}
      </Text>
      <Text className={`mr-1 text-[13px] ${missing ? 'text-missed' : 'text-ink-muted'}`}>{required ? 'Required' : 'Optional'}</Text>
      <Icon name="chevron-forward" size={18} color={missing ? 'missed' : highlight ? 'accent' : 'faint'} />
    </Pressable>
  )
}
