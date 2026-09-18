import React from 'react'
import { View, Text, Pressable } from 'react-native'
import { formatDuration } from '../utils/format'

/**
 * Shared look of the camera screens (phone and web): the top bar with Cancel and the title or
 * the recording timer, the round shutter, and the review bar with Retake / Use Photo.
 * Only presentation lives here; capture logic stays in CameraModal(.web).tsx.
 */

export const CameraTopBar: React.FC<{
  title: string
  recording: boolean
  elapsed: number
  maxSeconds: number
  onCancel: () => void
}> = ({ title, recording, elapsed, maxSeconds, onCancel }) => (
  <View className="flex-row items-center justify-between px-2">
    <Pressable
      onPress={onCancel}
      accessibilityRole="button"
      accessibilityLabel="Cancel"
      className="h-12 min-w-[88px] justify-center px-3 active:opacity-50"
    >
      <Text className="text-[17px] text-white">Cancel</Text>
    </Pressable>
    {recording ? (
      <View className="flex-row items-center rounded-full bg-missed px-3 py-1" accessibilityLiveRegion="polite">
        <View className="mr-2 h-2 w-2 rounded-full bg-white" />
        <Text className="text-[16px] font-semibold text-white" style={{ fontVariant: ['tabular-nums'] }}>
          {formatDuration(elapsed)} / {formatDuration(maxSeconds)}
        </Text>
      </View>
    ) : (
      <Text className="text-[17px] font-semibold text-white">{title}</Text>
    )}
    <View className="min-w-[88px]" />
  </View>
)

/** Large round shutter. Photo: white disc; video: red disc; recording: red square (Stop). */
export const Shutter: React.FC<{
  kind: 'photo' | 'record' | 'stop'
  onPress: () => void
  disabled?: boolean
  label: string
}> = ({ kind, onPress, disabled = false, label }) => (
  <Pressable
    onPress={onPress}
    disabled={disabled}
    accessibilityRole="button"
    accessibilityLabel={label}
    accessibilityState={{ disabled }}
    className={`h-[80px] w-[80px] items-center justify-center rounded-full border-4 border-white active:opacity-70 ${disabled ? 'opacity-40' : ''}`}
  >
    {kind === 'photo' ? (
      <View className="h-[62px] w-[62px] rounded-full bg-white" />
    ) : kind === 'record' ? (
      <View className="h-[62px] w-[62px] rounded-full bg-missed" />
    ) : (
      <View className="h-8 w-8 rounded-md bg-missed" />
    )}
  </Pressable>
)

/** Caption under the shutter, e.g. "Photo" or "Up to 30 seconds". */
export const ShutterCaption: React.FC<{ text: string }> = ({ text }) => (
  <Text className="mt-3 text-center text-[15px] text-white/80">{text}</Text>
)

/** After a capture: Retake on the left, Use Photo / Use Video as the primary on the right. */
export const ReviewBar: React.FC<{ isPhoto: boolean; onRetake: () => void; onUse: () => void }> = ({ isPhoto, onRetake, onUse }) => (
  <View className="flex-row gap-3 px-5 pt-4">
    <Pressable
      onPress={onRetake}
      accessibilityRole="button"
      accessibilityLabel={isPhoto ? 'Retake' : 'Record Again'}
      className="h-[52px] flex-1 items-center justify-center rounded-[14px] bg-white/15 active:opacity-70"
    >
      <Text className="text-[17px] font-semibold text-white">{isPhoto ? 'Retake' : 'Record Again'}</Text>
    </Pressable>
    <Pressable
      onPress={onUse}
      accessibilityRole="button"
      accessibilityLabel={isPhoto ? 'Use Photo' : 'Use Video'}
      className="h-[52px] flex-1 items-center justify-center rounded-[14px] bg-white active:opacity-80"
    >
      <Text className="text-[17px] font-semibold text-ink">{isPhoto ? 'Use Photo' : 'Use Video'}</Text>
    </Pressable>
  </View>
)
