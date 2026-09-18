import React, { useEffect, useRef, useState } from 'react'
import { Modal, View, Text, Pressable, Image } from 'react-native'
import { StatusBar } from 'expo-status-bar'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { VideoView, useVideoPlayer } from 'expo-video'
import { cssInterop } from 'nativewind'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Capture } from '../types'
import { Button } from './ui/Button'
import { CameraTopBar, ReviewBar, Shutter, ShutterCaption } from './CameraControls'

cssInterop(CameraView, { className: 'style' })
cssInterop(VideoView, { className: 'style' })

interface Props {
  visible: boolean
  mode: 'photo' | 'video'
  maxVideoSeconds: number
  onCancel: () => void
  onDone: (capture: Capture) => void
}

const VideoReview: React.FC<{ uri: string }> = ({ uri }) => {
  const player = useVideoPlayer(uri, (p) => {
    p.loop = true
    p.play()
  })
  return <VideoView player={player} nativeControls contentFit="contain" className="flex-1" />
}

/**
 * Live camera only. There is no gallery or file picker on purpose:
 * every photo and video must be captured now.
 */
export const CameraModal: React.FC<Props> = ({ visible, mode, maxVideoSeconds, onCancel, onDone }) => {
  const insets = useSafeAreaInsets()
  const [permission, requestPermission] = useCameraPermissions()
  const cameraRef = useRef<CameraView>(null)
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [recording, setRecording] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [result, setResult] = useState<Capture | null>(null)
  const startedAt = useRef(0)

  useEffect(() => {
    if (!visible) {
      setResult(null)
      setRecording(false)
      setElapsed(0)
      setReady(false)
    }
  }, [visible])

  useEffect(() => {
    if (!recording) return
    const timer = setInterval(() => setElapsed((Date.now() - startedAt.current) / 1000), 250)
    return () => clearInterval(timer)
  }, [recording])

  const takePhoto = async () => {
    if (!cameraRef.current || busy) return
    setBusy(true)
    try {
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.8 })
      if (photo?.uri) setResult({ uri: photo.uri, capturedAt: new Date().toISOString() })
    } catch (err) {
      console.error('Camera capture error', err)
    } finally {
      setBusy(false)
    }
  }

  const startRecording = async () => {
    if (!cameraRef.current || recording) return
    const capturedAt = new Date().toISOString()
    startedAt.current = Date.now()
    setElapsed(0)
    setRecording(true)
    try {
      // Resolves when stopRecording() is called or the time limit is reached.
      const video = await cameraRef.current.recordAsync({ maxDuration: maxVideoSeconds })
      const durationSeconds = Math.min((Date.now() - startedAt.current) / 1000, maxVideoSeconds)
      if (video?.uri) setResult({ uri: video.uri, capturedAt, durationSeconds: Math.round(durationSeconds) })
    } catch (err) {
      console.error('Video recording error', err)
    } finally {
      setRecording(false)
    }
  }

  const stopRecording = () => cameraRef.current?.stopRecording()

  const cancel = () => {
    if (recording) stopRecording()
    onCancel()
  }

  const isPhoto = mode === 'photo'

  let content: React.ReactNode
  if (!permission) {
    content = <View className="flex-1 bg-black" />
  } else if (!permission.granted) {
    content = (
      <View className="flex-1 bg-canvas px-8" style={{ paddingTop: insets.top, paddingBottom: insets.bottom + 24 }}>
        <Pressable onPress={onCancel} className="h-12 justify-center self-start active:opacity-50">
          <Text className="text-[17px] text-accent">Cancel</Text>
        </Pressable>
        <View className="flex-1 items-center justify-center">
          <Text className="text-center text-[22px] font-semibold text-ink">Allow the camera</Text>
          <Text className="mt-2 text-center text-[17px] leading-[24px] text-ink-muted">
            The camera is needed to take the photo or video for this check.
          </Text>
        </View>
        <Button label="Allow Camera" onPress={requestPermission} />
      </View>
    )
  } else if (result) {
    content = (
      <View className="flex-1 bg-black" style={{ paddingTop: insets.top }}>
        {isPhoto ? (
          <Image source={{ uri: result.uri }} className="flex-1" resizeMode="contain" />
        ) : (
          <VideoReview uri={result.uri} />
        )}
        <View style={{ paddingBottom: insets.bottom + 16 }}>
          <ReviewBar isPhoto={isPhoto} onRetake={() => setResult(null)} onUse={() => onDone(result)} />
        </View>
      </View>
    )
  } else {
    content = (
      <View className="flex-1 bg-black">
        <CameraView
          ref={cameraRef}
          className="flex-1"
          facing="back"
          mode={isPhoto ? 'picture' : 'video'}
          videoQuality="720p"
          mute
          onCameraReady={() => setReady(true)}
        />

        {/* Top bar over the preview */}
        <View className="absolute left-0 right-0 top-0 bg-black/40" style={{ paddingTop: insets.top }}>
          <CameraTopBar
            title={isPhoto ? 'Take Photo' : 'Record Video'}
            recording={recording}
            elapsed={elapsed}
            maxSeconds={maxVideoSeconds}
            onCancel={cancel}
          />
        </View>

        {/* Shutter */}
        <View className="absolute bottom-0 left-0 right-0 items-center bg-black/40 pt-5" style={{ paddingBottom: insets.bottom + 20 }}>
          {isPhoto ? (
            <Shutter kind="photo" label="Capture Photo" onPress={takePhoto} disabled={!ready || busy} />
          ) : recording ? (
            <Shutter kind="stop" label="Stop" onPress={stopRecording} />
          ) : (
            <Shutter kind="record" label="Record Video" onPress={startRecording} disabled={!ready} />
          )}
          <ShutterCaption
            text={isPhoto ? (busy ? 'Taking photo…' : 'Photo') : recording ? 'Tap to stop' : `Up to ${maxVideoSeconds} seconds`}
          />
        </View>
      </View>
    )
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={cancel}>
      <StatusBar style={permission?.granted ? 'light' : 'dark'} />
      {content}
    </Modal>
  )
}
