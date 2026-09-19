import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Modal, View, Text, Pressable } from 'react-native'
import { Capture } from '../types'
import { CameraTopBar, ReviewBar, Shutter, ShutterCaption } from './CameraControls'
import { Icon, ICON_COLOR } from './ui/Icon'
import { compressPhoto } from '../services/photoCompress'

/**
 * Recording bitrate: clear 720p for inspection at about a third of a phone's default; the backend
 * compresses videos further before storing them (README "Photo and video storage").
 */
const VIDEO_BITS_PER_SECOND = 3_000_000

interface Props {
  visible: boolean
  mode: 'photo' | 'video'
  maxVideoSeconds: number
  onCancel: () => void
  onDone: (capture: Capture) => void
}

/** A file picked in the fallback must be this fresh; older ones are gallery/PC files, not live captures. */
const FALLBACK_MAX_AGE_MS = 10 * 60 * 1000

type Stage = 'starting' | 'live' | 'fallback' | 'review'

function preferredVideoType() {
  if (typeof MediaRecorder === 'undefined') return undefined
  // MP4 plays everywhere (Safari included); Chrome records WebM when MP4 is not available.
  return ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t))
}

function videoDuration(url: string): Promise<number> {
  return new Promise((resolve) => {
    const v = document.createElement('video')
    v.preload = 'metadata'
    v.onloadedmetadata = () => resolve(Number.isFinite(v.duration) ? v.duration : 0)
    v.onerror = () => resolve(0)
    v.src = url
  })
}

const fullScreen: React.CSSProperties = { position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', background: '#000' }

/**
 * Camera for the web app (iPhone, Android browsers, PCs). Same rule as the phone app:
 * photos and videos are captured now, never picked from the gallery.
 *
 * With HTTPS (or localhost) the page shows a live camera preview. Browsers block that on
 * plain HTTP, so there the phone's own camera is opened through a capture input instead,
 * and anything that is not a fresh capture is refused.
 */
export const CameraModal: React.FC<Props> = ({ visible, mode, maxVideoSeconds, onCancel, onDone }) => {
  const isPhoto = mode === 'photo'
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const startedAt = useRef(0)
  const [stage, setStage] = useState<Stage>('starting')
  const [recording, setRecording] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [result, setResult] = useState<Capture | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [fallbackReason, setFallbackReason] = useState<string | null>(null)

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
  }, [])

  const startLive = useCallback(async () => {
    setError(null)
    setResult(null)
    const canLive = typeof window !== 'undefined' && window.isSecureContext && !!navigator.mediaDevices?.getUserMedia
    if (!canLive) {
      setFallbackReason('Live camera preview needs a secure (HTTPS) connection.')
      setStage('fallback')
      return
    }
    setStage('starting')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        // Photos at 1080p; videos at 720p like the phone app (the stored size).
        video: isPhoto
          ? { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }
          : { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
      })
      streamRef.current = stream
      setStage('live')
    } catch (err) {
      const name = (err as DOMException)?.name
      setFallbackReason(
        name === 'NotAllowedError'
          ? 'Camera access was blocked. Allow the camera for this site, or use the button below.'
          : name === 'NotFoundError'
            ? 'No camera was found on this device.'
            : 'The live camera could not start.'
      )
      setStage('fallback')
    }
  }, [isPhoto])

  // Start when opened, clean up when closed.
  useEffect(() => {
    if (!visible) {
      recorderRef.current?.state === 'recording' && recorderRef.current.stop()
      stopStream()
      setRecording(false)
      setElapsed(0)
      setResult(null)
      setError(null)
      return
    }
    startLive()
    return stopStream
  }, [visible, startLive, stopStream])

  // Attach the stream once the <video> element exists.
  useEffect(() => {
    if (stage === 'live' && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current
      videoRef.current.play().catch(() => undefined)
    }
  }, [stage])

  useEffect(() => {
    if (!recording) return
    const timer = setInterval(() => {
      const seconds = (Date.now() - startedAt.current) / 1000
      setElapsed(seconds)
      if (seconds >= maxVideoSeconds) recorderRef.current?.state === 'recording' && recorderRef.current.stop()
    }, 250)
    return () => clearInterval(timer)
  }, [recording, maxVideoSeconds])

  const review = (capture: Capture) => {
    stopStream()
    setResult(capture)
    setStage('review')
  }

  const takePhoto = () => {
    const video = videoRef.current
    if (!video || !video.videoWidth) return
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    canvas.getContext('2d')!.drawImage(video, 0, 0)
    const capturedAt = new Date().toISOString()
    canvas.toBlob(
      (blob) => {
        if (!blob) return setError('Could not take the photo. Please try again.')
        review({ uri: URL.createObjectURL(blob), capturedAt, blob, mimeType: 'image/jpeg' })
      },
      'image/jpeg',
      0.85
    )
  }

  const startRecording = () => {
    if (!streamRef.current) return
    const mimeType = preferredVideoType()
    let recorder: MediaRecorder
    try {
      recorder = new MediaRecorder(streamRef.current, { ...(mimeType ? { mimeType } : {}), videoBitsPerSecond: VIDEO_BITS_PER_SECOND })
    } catch {
      setFallbackReason('This browser cannot record video here.')
      stopStream()
      setStage('fallback')
      return
    }
    const chunks: Blob[] = []
    const capturedAt = new Date().toISOString()
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data)
    recorder.onstop = () => {
      setRecording(false)
      const type = recorder.mimeType || mimeType || 'video/webm'
      const blob = new Blob(chunks, { type })
      const durationSeconds = Math.round(Math.min((Date.now() - startedAt.current) / 1000, maxVideoSeconds))
      if (blob.size === 0) return setError('Nothing was recorded. Please try again.')
      review({ uri: URL.createObjectURL(blob), capturedAt, durationSeconds, blob, mimeType: type.split(';')[0] })
    }
    recorderRef.current = recorder
    startedAt.current = Date.now()
    setElapsed(0)
    recorder.start(1000)
    setRecording(true)
  }

  const stopRecording = () => recorderRef.current?.state === 'recording' && recorderRef.current.stop()

  /** Fallback: the phone's camera app through <input capture>. */
  const onFilePicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setError(null)
    const expected = isPhoto ? 'image/' : 'video/'
    if (!file.type.startsWith(expected)) return setError(isPhoto ? 'Please take a photo.' : 'Please record a video.')
    const age = Date.now() - file.lastModified
    if (age > FALLBACK_MAX_AGE_MS) {
      return setError(`This is an older ${isPhoto ? 'photo' : 'video'}, not a new one. Take a new ${isPhoto ? 'photo' : 'video'} with the camera.`)
    }
    const uri = URL.createObjectURL(file)
    const capturedAt = new Date(Math.min(file.lastModified || Date.now(), Date.now())).toISOString()
    // Camera-app photos are full size: made smaller here, before the upload.
    if (isPhoto) return review(await compressPhoto({ uri, capturedAt, blob: file, mimeType: file.type }))

    const seconds = await videoDuration(uri)
    if (seconds > maxVideoSeconds + 1) {
      URL.revokeObjectURL(uri)
      return setError(`The video is ${Math.round(seconds)} seconds. Record ${maxVideoSeconds} seconds or less.`)
    }
    review({ uri, capturedAt, durationSeconds: Math.round(seconds), blob: file, mimeType: file.type })
  }

  const retake = () => {
    if (result) URL.revokeObjectURL(result.uri)
    setResult(null)
    // Tries the live camera again; falls back to the capture input when it is unavailable.
    startLive()
  }

  const cancel = () => {
    stopRecording()
    if (result) URL.revokeObjectURL(result.uri)
    onCancel()
  }

  const title = isPhoto ? 'Take Photo' : 'Record Video'

  let content: React.ReactNode
  if (stage === 'review' && result) {
    content = (
      <View className="flex-1 bg-black">
        <View className="relative flex-1">
          {isPhoto ? (
            <img src={result.uri} alt="Captured photo" style={fullScreen} />
          ) : (
            <video src={result.uri} controls playsInline style={fullScreen} />
          )}
        </View>
        <View className="bg-black pb-6">
          <ReviewBar isPhoto={isPhoto} onRetake={retake} onUse={() => onDone(result)} />
        </View>
      </View>
    )
  } else if (stage === 'fallback') {
    content = (
      <View className="flex-1 bg-canvas px-5 pb-8 pt-2">
        <Pressable
          onPress={cancel}
          accessibilityRole="button"
          accessibilityLabel="Cancel"
          className="h-12 justify-center self-start active:opacity-50"
        >
          <Text className="text-[17px] text-accent">Cancel</Text>
        </Pressable>
        <View className="flex-1 items-center justify-center px-2">
          <View className="h-16 w-16 items-center justify-center rounded-full bg-accent-soft">
            <Icon name={isPhoto ? 'camera-outline' : 'videocam-outline'} size={30} color="accent" />
          </View>
          <Text className="mt-5 text-center text-[24px] font-bold text-ink">{title}</Text>
          <Text className="mt-2 text-center text-[17px] leading-[24px] text-ink-secondary">
            {isPhoto ? 'Opens the camera. Take a new photo now.' : `Opens the camera. Record up to ${maxVideoSeconds} seconds.`}
          </Text>
          {fallbackReason ? <Text className="mt-3 text-center text-[14px] leading-[20px] text-ink-muted">{fallbackReason}</Text> : null}
          {error ? <Text className="mt-4 text-center text-[16px] font-medium text-missed">{error}</Text> : null}
        </View>
        {/* A real <label> around the input: tapping it opens the camera on iPhone and Android. */}
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: 52,
            borderRadius: 14,
            background: ICON_COLOR.accent,
            color: '#FFFFFF',
            fontSize: 17,
            fontWeight: 600,
            cursor: 'pointer',
            userSelect: 'none'
          }}
        >
          {isPhoto ? 'Open Camera' : 'Open Camera to Record'}
          <input
            type="file"
            accept={isPhoto ? 'image/*' : 'video/*'}
            capture="environment"
            onChange={onFilePicked}
            style={{ display: 'none' }}
            aria-label={title}
          />
        </label>
      </View>
    )
  } else {
    content = (
      <View className="flex-1 bg-black">
        <View className="relative flex-1">
          <video ref={videoRef} autoPlay playsInline muted style={{ ...fullScreen, objectFit: 'cover' }} />
          {stage === 'starting' ? (
            <View className="absolute inset-0 items-center justify-center">
              <Text className="text-[17px] text-white/80">Starting camera…</Text>
            </View>
          ) : null}
          <View className="absolute left-0 right-0 top-0 bg-black/40 pt-1">
            <CameraTopBar title={title} recording={recording} elapsed={elapsed} maxSeconds={maxVideoSeconds} onCancel={cancel} />
          </View>
        </View>
        <View className="items-center bg-black px-8 pb-7 pt-5">
          {error ? <Text className="mb-3 text-center text-[15px] text-white">{error}</Text> : null}
          {isPhoto ? (
            <Shutter kind="photo" label="Capture Photo" onPress={takePhoto} disabled={stage !== 'live'} />
          ) : recording ? (
            <Shutter kind="stop" label="Stop" onPress={stopRecording} />
          ) : (
            <Shutter kind="record" label="Record Video" onPress={startRecording} disabled={stage !== 'live'} />
          )}
          <ShutterCaption text={isPhoto ? 'Photo' : recording ? 'Tap to stop' : `Up to ${maxVideoSeconds} seconds`} />
        </View>
      </View>
    )
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={cancel}>
      {content}
    </Modal>
  )
}
