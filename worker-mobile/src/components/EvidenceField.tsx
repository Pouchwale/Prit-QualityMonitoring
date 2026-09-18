import React from 'react'
import { View, Text, Pressable, Image } from 'react-native'
import { VideoView, useVideoPlayer } from 'expo-video'
import { cssInterop } from 'nativewind'
import { Capture } from '../types'
import { formatDuration, formatTime } from '../utils/format'
import { Icon } from './ui/Icon'

cssInterop(VideoView, { className: 'style' })

interface Props {
  kind: 'photo' | 'video'
  capture: Capture | null
  required: boolean
  onOpenCamera: () => void
  /** Drawn in the accent tint as the next step to do. */
  highlight?: boolean
}

const VideoPreview: React.FC<{ uri: string }> = ({ uri }) => {
  const player = useVideoPlayer(uri, (p) => {
    p.loop = false
  })
  return <VideoView player={player} nativeControls contentFit="cover" className="h-52 w-full bg-black" />
}

/** "Click Image" / "Record Video" action, or the captured preview with a retake option. */
export const EvidenceField: React.FC<Props> = ({ kind, capture, required, onOpenCamera, highlight = true }) => {
  const isPhoto = kind === 'photo'

  if (capture) {
    return (
      <View className="overflow-hidden rounded-2xl bg-surface">
        {isPhoto ? (
          <Image source={{ uri: capture.uri }} className="h-52 w-full bg-subtle" resizeMode="cover" />
        ) : (
          <VideoPreview uri={capture.uri} />
        )}
        <View className="min-h-[56px] flex-row items-center py-1 pl-4">
          <Icon name="checkmark-circle" size={18} color="success" />
          <Text className="ml-1.5 flex-1 text-[15px] font-medium text-ink">
            {isPhoto
              ? `Photo taken · ${formatTime(capture.capturedAt)}`
              : `Video recorded${capture.durationSeconds != null ? ` · ${formatDuration(capture.durationSeconds)}` : ''}`}
          </Text>
          <Pressable
            onPress={onOpenCamera}
            accessibilityRole="button"
            accessibilityLabel={isPhoto ? 'Retake photo' : 'Record video again'}
            className="h-12 justify-center px-4 active:opacity-50"
          >
            <Text className="text-[16px] font-semibold text-accent">Retake</Text>
          </Pressable>
        </View>
      </View>
    )
  }

  return (
    <Pressable
      onPress={onOpenCamera}
      accessibilityRole="button"
      className={`h-[60px] flex-row items-center rounded-2xl border px-4 active:opacity-70 ${
        highlight ? 'border-accent bg-accent-soft' : 'border-transparent bg-surface'
      }`}
    >
      <View className={`h-9 w-9 items-center justify-center rounded-full ${highlight ? 'bg-surface' : 'bg-accent-soft'}`}>
        <Icon name={isPhoto ? 'camera-outline' : 'videocam-outline'} size={20} color="accent" />
      </View>
      <Text className="ml-3 flex-1 text-[17px] font-semibold text-accent">{isPhoto ? 'Click Image' : 'Record Video'}</Text>
      <Text className="mr-1 text-[13px] text-ink-muted">{required ? 'Required' : 'Optional'}</Text>
      <Icon name="chevron-forward" size={18} color="accent" />
    </Pressable>
  )
}
