import React from 'react'
import { View, Text, Pressable, Image } from 'react-native'
import { VideoView, useVideoPlayer } from 'expo-video'
import { cssInterop } from 'nativewind'
import { Capture } from '../types'
import { formatDuration } from '../utils/format'
import { FieldLabel } from './ui/FieldLabel'

cssInterop(VideoView, { className: 'style' })

interface Props {
  kind: 'photo' | 'video'
  capture: Capture | null
  required: boolean
  onOpenCamera: () => void
}

const VideoPreview: React.FC<{ uri: string }> = ({ uri }) => {
  const player = useVideoPlayer(uri, (p) => {
    p.loop = false
  })
  return <VideoView player={player} nativeControls contentFit="cover" className="h-52 w-full bg-black" />
}

/** "Click Image" / "Record Video" action, or the captured preview with a retake option. */
export const EvidenceField: React.FC<Props> = ({ kind, capture, required, onOpenCamera }) => {
  const isPhoto = kind === 'photo'

  return (
    <View>
      <FieldLabel label={isPhoto ? 'Photo' : 'Video'} required={required} />

      {capture ? (
        <View className="overflow-hidden rounded-xl border border-line bg-surface">
          {isPhoto ? (
            <Image source={{ uri: capture.uri }} className="h-52 w-full bg-subtle" resizeMode="cover" />
          ) : (
            <VideoPreview uri={capture.uri} />
          )}
          <View className="flex-row items-center justify-between px-4 py-2">
            <Text className="text-[16px] text-ink-secondary">
              {isPhoto
                ? 'Photo taken'
                : `Video recorded${capture.durationSeconds != null ? ` · ${formatDuration(capture.durationSeconds)}` : ''}`}
            </Text>
            <Pressable onPress={onOpenCamera} accessibilityRole="button" className="h-11 justify-center pl-4 active:opacity-50">
              <Text className="text-[17px] font-semibold text-accent">{isPhoto ? 'Retake' : 'Record again'}</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <Pressable
          onPress={onOpenCamera}
          accessibilityRole="button"
          className="h-16 flex-row items-center justify-center rounded-xl border-2 border-dashed border-accent bg-surface active:bg-subtle"
        >
          {!isPhoto ? <View className="mr-2.5 h-3 w-3 rounded-full bg-failed" /> : null}
          <Text className="text-[18px] font-semibold text-accent">{isPhoto ? 'Click Image' : 'Record Video'}</Text>
        </Pressable>
      )}
    </View>
  )
}
