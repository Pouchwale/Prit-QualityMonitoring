import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import sharp, { type Metadata } from 'sharp'
import ffmpegStatic from 'ffmpeg-static'
import { and, asc, eq } from 'drizzle-orm'
import { config } from '../config'
import { db } from '../db/client'
import { media } from '../db/schema'
import { storage } from '../storage'
import type { StorageCategory } from '../storage/StorageService'

/**
 * Photos and videos are compressed before they are stored, keeping what an inspection needs
 * (fine print, registration, scratches, colour) while cutting storage and loading time.
 *
 * Photos: compressed while the check is submitted. Upright (the phone's rotation is applied to
 * the pixels, so every viewer and the PDF report show it the right way up), longest side at most
 * 3072 px, JPEG quality 80 with full colour resolution, metadata such as GPS removed. A photo that is
 * already that small (the app compresses on the phone) is stored as it is, so it is never
 * compressed twice.
 *
 * Videos: compressed in the background after the check is saved, one at a time with a limited
 * number of CPU threads, so a submission never waits for it. H.264 (plays in every browser and
 * phone), longest side at most 1280 px (720p), at most 30 frames per second, upright, fast start
 * for streaming. The upload stays the stored file until the compressed one is ready, and is kept if
 * compression fails.
 *
 * Settings: config.media (environment variables MEDIA_*).
 */

export type MediaProcessing = 'PENDING' | 'COMPRESSED' | 'ORIGINAL' | 'FAILED'

sharp.cache(false)
sharp.concurrency(Math.max(1, Math.min(4, os.availableParallelism() - 1)))

/** A photo is not decoded when it has more pixels than this (protects the server's memory). */
const MAX_INPUT_PIXELS = 100_000_000
/**
 * Bytes per pixel above which a photo counts as "not compressed yet": the app's own JPEGs at
 * quality 80 are about 0.1, a camera's JPEG at quality 95 about 0.4.
 */
const COMPRESSED_BYTES_PER_PIXEL = 0.3

export function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    fs.createReadStream(filePath)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject)
  })
}

export interface OptimizedPhoto {
  /** The file to store: the compressed one, or the upload itself. */
  path: string
  mimeType: string
  extension: string
  sizeBytes: number
  width: number | null
  height: number | null
  processing: Exclude<MediaProcessing, 'PENDING'>
}

/**
 * Compresses one uploaded photo into a new temporary file next to it. Never throws: when the
 * photo cannot be read or compressed, the upload is kept as it was (processing FAILED).
 */
export async function optimizePhoto(upload: { path: string; mimetype: string; size: number }, extension: string): Promise<OptimizedPhoto> {
  const asUploaded = (processing: OptimizedPhoto['processing'], width: number | null = null, height: number | null = null): OptimizedPhoto => ({
    path: upload.path,
    mimeType: upload.mimetype,
    extension,
    sizeBytes: upload.size,
    width,
    height,
    processing
  })
  let meta: Metadata
  try {
    meta = await sharp(upload.path, { limitInputPixels: MAX_INPUT_PIXELS }).metadata()
  } catch (err) {
    console.warn(`Photo could not be read for compression; stored as uploaded: ${(err as Error).message}`)
    return asUploaded('FAILED')
  }
  // Orientations 5-8 turn the picture a quarter: the upright width is the stored height.
  const turned = (meta.orientation ?? 1) >= 5
  const width = (turned ? meta.height : meta.width) ?? null
  const height = (turned ? meta.width : meta.height) ?? null
  if (!config.media.optimize || !width || !height) return asUploaded('ORIGINAL', width, height)

  const { photoMaxEdge, photoQuality } = config.media
  const upright = (meta.orientation ?? 1) === 1
  const fits = Math.max(width, height) <= photoMaxEdge
  const light = upload.size / (width * height) <= COMPRESSED_BYTES_PER_PIXEL
  // Already compressed (by the app): storing it again would only lose quality.
  if (meta.format === 'jpeg' && upright && fits && light) return asUploaded('ORIGINAL', width, height)

  const out = `${upload.path}.${randomUUID()}.jpg`
  try {
    const info = await sharp(upload.path, { limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .resize({ width: photoMaxEdge, height: photoMaxEdge, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: photoQuality, mozjpeg: true, chromaSubsampling: '4:4:4' })
      .toFile(out)
    // Not smaller and nothing to fix (size, rotation, format): keep the upload.
    if (info.size >= upload.size && meta.format === 'jpeg' && upright && fits) {
      await fsp.rm(out, { force: true })
      return asUploaded('ORIGINAL', width, height)
    }
    return { path: out, mimeType: 'image/jpeg', extension: 'jpg', sizeBytes: info.size, width: info.width, height: info.height, processing: 'COMPRESSED' }
  } catch (err) {
    await fsp.rm(out, { force: true })
    console.warn(`Photo compression failed; stored as uploaded: ${(err as Error).message}`)
    return asUploaded('FAILED', width, height)
  }
}

// ---------------------------------------------------------------------------------------------
// Videos

const ffmpegPath = () => config.media.ffmpegPath ?? (ffmpegStatic as unknown as string | null)

/** Whether uploaded videos are compressed (optimisation on and ffmpeg present). */
export function videoOptimizationEnabled(): boolean {
  const bin = ffmpegPath()
  return config.media.optimize && !!bin && fs.existsSync(bin)
}

export interface VideoInfo {
  codec: string | null
  width: number
  height: number
  durationSeconds: number
  /** Degrees the player turns the picture (phones record portrait videos sideways). */
  rotation: number
}

function runFfmpeg(args: string[], timeoutMs: number): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath()!, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    // Below-normal priority: checks and the admin panel stay responsive while a video compresses.
    try {
      if (child.pid) os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL)
    } catch {
      // Not allowed on this system: runs at normal priority.
    }
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-20_000)
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stderr })
    })
  })
}

/** Reads a video's codec, size, duration and rotation from ffmpeg's description of it. */
export async function probeVideo(filePath: string): Promise<VideoInfo | null> {
  const { stderr } = await runFfmpeg(['-hide_banner', '-i', filePath], 30_000)
  const video = /Stream #[^\n]*Video: (\w+)[^\n]*?, (\d{2,5})x(\d{2,5})/.exec(stderr)
  const duration = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr)
  if (!video) return null
  const rotation = /rotation of (-?\d+(?:\.\d+)?) degrees/.exec(stderr)
  return {
    codec: video[1] ?? null,
    width: Number(video[2]),
    height: Number(video[3]),
    durationSeconds: duration ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) : 0,
    rotation: rotation ? Math.round(Number(rotation[1])) : 0
  }
}

/** Compresses a video into `out` (MP4, H.264). Throws when ffmpeg fails. */
export async function compressVideo(input: string, out: string, durationSeconds: number) {
  const { videoMaxEdge, videoCrf, videoMaxKbps, videoThreads } = config.media
  // Keeps the aspect ratio; both sides even, as H.264 needs. ffmpeg turns the picture upright first.
  const scale = `scale='trunc(min(1,${videoMaxEdge}/max(iw,ih))*iw/2)*2':'trunc(min(1,${videoMaxEdge}/max(iw,ih))*ih/2)*2'`
  const args = [
    '-hide_banner', '-nostdin', '-y',
    '-i', input,
    '-map', '0:v:0', '-an', '-sn', '-dn', '-map_metadata', '-1',
    '-vf', scale,
    '-fpsmax', '30',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', String(videoCrf), '-profile:v', 'high', '-pix_fmt', 'yuv420p',
    '-maxrate', `${videoMaxKbps}k`, '-bufsize', `${videoMaxKbps * 2}k`,
    '-threads', String(videoThreads),
    '-movflags', '+faststart',
    out
  ]
  // About a second of work per second of 720p video on two threads; generous so slow PCs finish.
  const timeoutMs = Math.min(30 * 60_000, Math.max(3 * 60_000, (durationSeconds || 60) * 20_000))
  const { code, stderr } = await runFfmpeg(args, timeoutMs)
  if (code !== 0) {
    const reason = stderr.trim().split('\n').slice(-2).join(' ').slice(0, 300)
    throw new Error(code === null ? 'compression took too long and was stopped' : `ffmpeg failed: ${reason}`)
  }
}

type MediaRow = typeof media.$inferSelect

/** Compresses one stored video and swaps it in. Always leaves the row out of PENDING. */
async function optimizeStoredVideo(row: MediaRow) {
  const finish = (processing: MediaProcessing, extra: Partial<MediaRow> = {}) =>
    db.update(media).set({ processing, ...extra }).where(and(eq(media.id, row.id), eq(media.processing, 'PENDING')))
  const source = storage.localPath(row.path)
  const out = path.join(config.uploadDir, '.tmp', `video-${randomUUID()}.mp4`)
  const started = Date.now()
  try {
    const before = await probeVideo(source)
    if (!before) throw new Error('not a readable video')
    await fsp.mkdir(path.dirname(out), { recursive: true })
    await compressVideo(source, out, before.durationSeconds)
    const after = await probeVideo(out)
    const size = (await fsp.stat(out)).size
    if (!after || size === 0 || (before.durationSeconds > 0 && Math.abs(after.durationSeconds - before.durationSeconds) > 1.5)) {
      throw new Error('the compressed video is not complete')
    }
    // H.264 plays everywhere; HEVC (iPhone) and WebM (some browsers) do not, so those are always converted.
    const playsEverywhere = before.codec === 'h264'
    if (size >= row.sizeBytes * 0.95 && playsEverywhere) {
      await fsp.rm(out, { force: true })
      const turned = Math.abs(before.rotation) === 90 || Math.abs(before.rotation) === 270
      await finish('ORIGINAL', { width: turned ? before.height : before.width, height: turned ? before.width : before.height })
      return
    }
    const category = row.path.split('/')[0] as StorageCategory
    const saved = await storage.save(out, { category, extension: 'mp4' })
    const hash = await sha256File(storage.localPath(saved.path))
    const updated = await db
      .update(media)
      .set({ path: saved.path, mimeType: 'video/mp4', sizeBytes: size, sha256: hash, processing: 'COMPRESSED', width: after.width, height: after.height })
      .where(and(eq(media.id, row.id), eq(media.path, row.path), eq(media.processing, 'PENDING')))
      .returning({ id: media.id })
    // Deleted (or changed) meanwhile: the new file is not needed.
    await storage.remove(updated.length ? row.path : saved.path).catch(() => undefined)
    console.log(
      `Video compressed: ${row.path} ${(row.sizeBytes / 1048576).toFixed(1)} MB -> ${(size / 1048576).toFixed(1)} MB (${after.width}x${after.height}) in ${((Date.now() - started) / 1000).toFixed(1)} s`
    )
  } catch (err) {
    await fsp.rm(out, { force: true }).catch(() => undefined)
    console.warn(`Video compression failed for ${row.path}; the uploaded video is kept: ${(err as Error).message}`)
    await finish('FAILED')
  }
}

let running: Promise<void> | null = null
let again = false

/**
 * Compresses every waiting video, oldest first, one at a time. Called after a submission and
 * at start-up (videos left waiting by a restart). Returns when the queue is empty.
 */
export function kickVideoOptimization(): Promise<void> {
  if (running) {
    again = true
    return running
  }
  running = (async () => {
    try {
      do {
        again = false
        for (;;) {
          const [row] = await db.select().from(media).where(eq(media.processing, 'PENDING')).orderBy(asc(media.createdAt)).limit(1)
          if (!row) break
          if (!videoOptimizationEnabled() || row.kind !== 'VIDEO') {
            await db.update(media).set({ processing: 'ORIGINAL' }).where(eq(media.id, row.id))
            continue
          }
          await optimizeStoredVideo(row)
        }
      } while (again)
    } catch (err) {
      // Database unavailable: the videos stay waiting and are picked up on the next kick.
      console.error('Video compression queue stopped', err)
    } finally {
      running = null
    }
  })()
  return running
}

/** Removes temporary files older than a day (left by a crash or a stopped server). */
export async function cleanOldTempFiles() {
  const dir = path.join(config.uploadDir, '.tmp')
  const entries = await fsp.readdir(dir).catch(() => [] as string[])
  const cutoff = Date.now() - 24 * 60 * 60_000
  await Promise.all(
    entries.map(async (name) => {
      const file = path.join(dir, name)
      const stat = await fsp.stat(file).catch(() => null)
      if (stat?.isFile() && stat.mtimeMs < cutoff) await fsp.rm(file, { force: true }).catch(() => undefined)
    })
  )
}
