import { ImageManipulator, SaveFormat } from 'expo-image-manipulator'
import type { Capture } from '../types'

/**
 * Photo size limits, the same as the backend's (config.media): the longest side at most 3072 px.
 * The app compresses on the phone, so the upload is small; the backend then stores it as it is.
 * Tested with fine print, 1-2 px registration offsets, scratches and colour patches (README
 * "Photo and video storage").
 */
export const PHOTO_MAX_EDGE = 3072
const PHOTO_QUALITY = 0.85

/**
 * A smaller JPEG of a photo just taken, upright. The web app uses photoCompress.web.ts.
 * Never fails: when the phone cannot compress it, the photo is sent as taken (the backend
 * compresses it instead).
 */
export async function compressPhoto(capture: Capture, size?: { width: number; height: number }): Promise<Capture> {
  const context = ImageManipulator.manipulate(capture.uri)
  try {
    if (size && Math.max(size.width, size.height) > PHOTO_MAX_EDGE) {
      context.resize(size.width >= size.height ? { width: PHOTO_MAX_EDGE } : { height: PHOTO_MAX_EDGE })
    }
    const image = await context.renderAsync()
    try {
      const result = await image.saveAsync({ compress: PHOTO_QUALITY, format: SaveFormat.JPEG })
      return { ...capture, uri: result.uri, mimeType: 'image/jpeg' }
    } finally {
      image.release()
    }
  } catch (err) {
    console.warn('Photo compression on the phone failed; sending the photo as taken', err)
    return capture
  } finally {
    context.release()
  }
}
