import type { Capture } from '../types'

/** Same limits as the phone app (photoCompress.ts) and the backend (config.media). */
export const PHOTO_MAX_EDGE = 3072
const PHOTO_QUALITY = 0.85
/** A JPEG lighter than this per pixel is already compressed (the live camera's own photos). */
const COMPRESSED_BYTES_PER_PIXEL = 0.3

/**
 * Browser: a smaller JPEG of a photo from the phone's camera app (the plain-HTTP fallback, which
 * gives full-size camera files). Upright, longest side at most 3072 px. Never fails: when the
 * browser cannot do it, the photo is sent as taken and the backend compresses it.
 */
export async function compressPhoto(capture: Capture, _size?: { width: number; height: number }): Promise<Capture> {
  const blob = capture.blob
  if (!blob || typeof createImageBitmap === 'undefined') return capture
  let bitmap: ImageBitmap | null = null
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' })
    const { width, height } = bitmap
    const scale = Math.min(1, PHOTO_MAX_EDGE / Math.max(width, height))
    if (scale === 1 && blob.type === 'image/jpeg' && blob.size / (width * height) <= COMPRESSED_BYTES_PER_PIXEL) return capture
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(width * scale)
    canvas.height = Math.round(height * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) return capture
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const out = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', PHOTO_QUALITY))
    // Release the canvas memory at once (large canvases are limited on iPhones).
    canvas.width = canvas.height = 0
    if (!out || out.size >= blob.size) return capture
    URL.revokeObjectURL(capture.uri)
    return { ...capture, uri: URL.createObjectURL(out), blob: out, mimeType: 'image/jpeg' }
  } catch (err) {
    console.warn('Photo compression in the browser failed; sending the photo as taken', err)
    return capture
  } finally {
    bitmap?.close()
  }
}
