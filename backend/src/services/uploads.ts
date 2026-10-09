import fsp from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import multer from 'multer'
import sharp from 'sharp'
import { inArray, or } from 'drizzle-orm'
import { config } from '../config'
import { db } from '../db/client'
import { media } from '../db/schema'
import { HttpError, badRequest, conflict } from '../lib/http'
import { MINUTE } from '../lib/time'
import { storage } from '../storage'
import type { StorageCategory } from '../storage/StorageService'
import { optimizePhoto, sha256File, videoOptimizationEnabled, type MediaProcessing } from './mediaOptimizer'

const UUID = '[0-9a-fA-F-]{36}'
const FIELD_REGEX = new RegExp(`^(photo|video)(:${UUID})?$`)

/** The parameter a `photo:<parameterId>` / `video:<parameterId>` field belongs to, or null. */
export function fieldParameterId(field: string): string | null {
  const match = FIELD_REGEX.exec(field)
  return match?.[2] ? match[2].slice(1) : null
}

export const fieldKind = (field: string): 'PHOTO' | 'VIDEO' => (field.startsWith('video') ? 'VIDEO' : 'PHOTO')

/**
 * Evidence for a check: the overall `photo` / `video` fields plus one `photo:<parameterId>` and
 * `video:<parameterId>` per parameter that needs it. `maxFiles` is 2 x parameters + 2.
 */
export function checkEvidenceUpload(maxFiles: number) {
  const seen = new WeakMap<object, Set<string>>()
  return multer({
    dest: path.join(config.uploadDir, '.tmp'),
    limits: { fileSize: config.maxVideoBytes, files: Math.max(2, maxFiles) },
    fileFilter: (req, file, cb) => {
      const match = FIELD_REGEX.exec(file.fieldname)
      if (!match) return cb(new HttpError(400, `Unexpected file "${file.fieldname}"`))
      const kind = fieldKind(file.fieldname)
      const expected = kind === 'PHOTO' ? 'image/' : 'video/'
      if (!file.mimetype.startsWith(expected)) return cb(new HttpError(400, `Unsupported file for "${file.fieldname}"`))
      const fields = seen.get(req) ?? new Set<string>()
      if (fields.has(file.fieldname)) return cb(new HttpError(400, `Only one file for "${file.fieldname}"`))
      fields.add(file.fieldname)
      seen.set(req, fields)
      cb(null, true)
    }
  }).any()
}

/** Accepts one `photo` (image/*) and one `video` (video/*) field. */
export const evidenceUpload = multer({
  dest: path.join(config.uploadDir, '.tmp'),
  limits: { fileSize: config.maxVideoBytes, files: 2 },
  fileFilter: (_req, file, cb) => {
    if (file.fieldname === 'photo' && file.mimetype.startsWith('image/')) return cb(null, true)
    if (file.fieldname === 'video' && file.mimetype.startsWith('video/')) return cb(null, true)
    cb(new HttpError(400, `Unsupported file for "${file.fieldname}"`))
  }
}).fields([
  { name: 'photo', maxCount: 1 },
  { name: 'video', maxCount: 1 }
])

export type UploadedFiles = Partial<Record<'photo' | 'video', Express.Multer.File[]>> | Express.Multer.File[]

/** Uploaded files by field name, for both `.fields()` and `.any()` uploads. */
export function filesByField(files: UploadedFiles | undefined): Map<string, Express.Multer.File> {
  const map = new Map<string, Express.Multer.File>()
  for (const file of allFiles(files)) map.set(file.fieldname, file)
  return map
}

function allFiles(files: UploadedFiles | undefined): Express.Multer.File[] {
  if (!files) return []
  if (Array.isArray(files)) return files
  return [...(files.photo ?? []), ...(files.video ?? [])]
}

/**
 * Server-side checks for live evidence. The app only offers the camera, but the backend
 * still requires a fresh capture time and rejects files that were uploaded before.
 */
function parseCapturedAt(raw: unknown, label: string): Date {
  const date = typeof raw === 'string' ? new Date(raw) : new Date(NaN)
  if (Number.isNaN(date.getTime())) throw badRequest(`${label} capture time is missing`)
  const now = Date.now()
  if (date.getTime() > now + 5 * MINUTE) throw badRequest(`${label} capture time is in the future. Check the phone clock.`)
  if (date.getTime() < now - config.captureFreshnessMinutes * MINUTE) {
    throw badRequest(`${label} is too old. Please take a new one.`)
  }
  return date
}

export interface EvidenceInput {
  file: Express.Multer.File
  kind: 'PHOTO' | 'VIDEO'
  capturedAt: unknown
  durationSeconds?: number
  /** The parameter this file belongs to; null for the overall check photo/video. */
  parameterId?: string | null
  /** Name shown in error messages, e.g. the parameter name. */
  label?: string
}

export interface StoredEvidence {
  kind: 'PHOTO' | 'VIDEO'
  parameterId: string | null
  path: string
  mimeType: string
  sizeBytes: number
  /** Hash of the stored file. */
  sha256: string
  capturedAt: Date
  durationSeconds: number | null
  /** Compression (services/mediaOptimizer.ts): photos are done here, videos wait (PENDING). */
  processing: MediaProcessing
  originalSizeBytes: number
  /** Hash of the file as received, used to refuse a capture that is sent again. */
  originalSha256: string
  width: number | null
  height: number | null
  /** Photos: hash of the decoded pixels (see pixelHash). */
  contentSha256: string | null
}

interface DetectedType {
  extension: string
  mimeType: string
}

/** Photo formats accepted as evidence, by sharp's format name. SVG, GIF, TIFF and others are refused. */
const PHOTO_FORMATS: Record<string, DetectedType> = {
  jpeg: { extension: 'jpg', mimeType: 'image/jpeg' },
  png: { extension: 'png', mimeType: 'image/png' },
  webp: { extension: 'webp', mimeType: 'image/webp' },
  heif: { extension: 'heic', mimeType: 'image/heic' }
}

/**
 * What an uploaded file really is, from its content. The file name and the type the phone sent are
 * never trusted: the stored extension decides how the file is served (lib/mediaLinks.ts).
 */
async function detectType(file: Express.Multer.File, kind: 'PHOTO' | 'VIDEO', label: string): Promise<DetectedType> {
  if (kind === 'PHOTO') {
    const meta = await sharp(file.path, { limitInputPixels: 100_000_000 })
      .metadata()
      .catch(() => null)
    const type = meta?.format ? PHOTO_FORMATS[meta.format] : undefined
    if (!type || !meta?.width || !meta.height) throw badRequest(`${label} is not a photo. Please take it with the camera.`)
    return type
  }
  const handle = await fsp.open(file.path, 'r')
  const head = Buffer.alloc(12)
  try {
    await handle.read(head, 0, 12, 0)
  } finally {
    await handle.close()
  }
  // MP4, MOV and 3GP are ISO media files ("ftyp" box); WebM starts with the EBML signature.
  if (head.toString('latin1', 4, 8) === 'ftyp') {
    const brand = head.toString('latin1', 8, 12)
    if (brand === 'qt  ') return { extension: 'mov', mimeType: 'video/quicktime' }
    if (brand.startsWith('3g')) return { extension: '3gp', mimeType: 'video/3gpp' }
    return { extension: 'mp4', mimeType: 'video/mp4' }
  }
  if (head.readUInt32BE(0) === 0x1a45dfa3) return { extension: 'webm', mimeType: 'video/webm' }
  throw badRequest(`${label} is not a video. Please record it with the camera.`)
}

/**
 * SHA-256 of a photo's pixels (upright, scaled to a fixed size). Unlike the file hash it does not
 * change when metadata is edited or bytes are appended, so a photo sent before cannot be passed off
 * as new that way.
 */
async function pixelHash(filePath: string): Promise<string> {
  const pixels = await sharp(filePath, { limitInputPixels: 100_000_000 })
    .rotate()
    .resize(256, 256, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer()
  return createHash('sha256').update(pixels).digest('hex')
}

/** Validates and moves evidence into storage. Returns rows ready to insert into `media`. */
export async function storeEvidence(items: EvidenceInput[], category: StorageCategory): Promise<StoredEvidence[]> {
  const prepared = await Promise.all(
    items.map(async (item) => {
      const label = item.label ?? (item.kind === 'PHOTO' ? 'Photo' : 'Video')
      if (item.kind === 'PHOTO' && item.file.size > config.maxPhotoBytes) throw badRequest('Photo is too large')
      if (item.file.size === 0) throw badRequest(`${label} is empty. Please try again.`)
      if (item.kind === 'VIDEO' && item.durationSeconds != null && item.durationSeconds > config.maxVideoSeconds + 2) {
        throw badRequest(`Video must be ${config.maxVideoSeconds} seconds or shorter`)
      }
      const capturedAt = parseCapturedAt(item.capturedAt, label)
      const type = await detectType(item.file, item.kind, label)
      return {
        item,
        label,
        capturedAt,
        type,
        hash: await sha256File(item.file.path),
        contentHash: item.kind === 'PHOTO' ? await pixelHash(item.file.path) : null
      }
    })
  )

  if (prepared.length) {
    // The same file (or the same picture) sent twice in one submission is a reuse as well.
    const hashes = new Set<string>()
    for (const p of prepared) {
      for (const h of [p.hash, p.contentHash]) {
        if (!h) continue
        if (hashes.has(h)) throw conflict(`${p.label} was already used. Please take a new one.`)
        hashes.add(h)
      }
    }
    // Compared with the files as received and as stored (a stored photo may be compressed), and with
    // the pixels of every photo stored before.
    const hashList = prepared.map((p) => p.hash)
    const pixelList = prepared.map((p) => p.contentHash).filter((h): h is string => !!h)
    const reused = await db
      .select({ kind: media.kind })
      .from(media)
      .where(
        or(
          inArray(media.sha256, hashList),
          inArray(media.originalSha256, hashList),
          ...(pixelList.length ? [inArray(media.contentSha256, pixelList)] : [])
        )
      )
    if (reused.length) {
      throw conflict(`This ${reused[0].kind === 'VIDEO' ? 'video' : 'photo'} was already used. Please take a new one.`)
    }
  }

  // Photos are compressed now (in parallel, off the main thread); videos after the check is saved.
  const photos = await Promise.all(
    prepared.map((p) => (p.item.kind === 'PHOTO' ? optimizePhoto({ ...p.item.file, mimetype: p.type.mimeType }, p.type.extension) : null))
  )
  const videosWait = videoOptimizationEnabled()

  const stored: StoredEvidence[] = []
  try {
    for (const [i, p] of prepared.entries()) {
      const photo = photos[i]
      const saved = await storage.save(photo?.path ?? p.item.file.path, { category, extension: photo?.extension ?? p.type.extension })
      stored.push({
        kind: p.item.kind,
        parameterId: p.item.parameterId ?? null,
        path: saved.path,
        mimeType: photo?.mimeType ?? p.type.mimeType,
        sizeBytes: photo?.sizeBytes ?? p.item.file.size,
        sha256: photo?.processing === 'COMPRESSED' ? await sha256File(storage.localPath(saved.path)) : p.hash,
        capturedAt: p.capturedAt,
        durationSeconds: p.item.durationSeconds ?? null,
        processing: photo?.processing ?? (videosWait ? 'PENDING' : 'ORIGINAL'),
        originalSizeBytes: p.item.file.size,
        originalSha256: p.hash,
        width: photo?.width ?? null,
        height: photo?.height ?? null,
        contentSha256: p.contentHash
      })
    }
  } catch (err) {
    await removeStored(stored)
    throw err
  } finally {
    // Compressed copies that were not moved into storage (the uploads are cleaned by cleanupTemp).
    await Promise.all(photos.map((ph, i) => (ph && ph.path !== prepared[i].item.file.path ? fsp.rm(ph.path, { force: true }) : undefined)))
  }
  return stored
}

export async function removeStored(stored: StoredEvidence[]) {
  await Promise.all(stored.map((s) => storage.remove(s.path).catch(() => undefined)))
}

/** Deletes any multer temp files that were not moved into storage. */
export async function cleanupTemp(files: UploadedFiles | undefined) {
  await Promise.all(allFiles(files).map((f) => fsp.rm(f.path, { force: true })))
}
