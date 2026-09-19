import 'dotenv/config'
import path from 'node:path'
import { PLANT_TIMEZONE } from './lib/time'

function required(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing environment variable ${name}. Copy .env.example to .env and fill it in.`)
  }
  return value
}

/** A whole number from the environment, kept within [min, max]; the default when unset or invalid. */
function envNumber(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name])
  if (!process.env[name] || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

export const config = {
  databaseUrl: required('DATABASE_URL'),
  port: Number(process.env.PORT ?? 4000),
  /**
   * The plant's timezone (IANA name, e.g. Asia/Kolkata), set with PLANT_TIMEZONE. Shift times,
   * "today" and the Plant Calendar dates are read in this zone, so the schedule is right even
   * when the server's own clock runs in another timezone (lib/time.ts).
   */
  plantTimezone: PLANT_TIMEZONE,
  jwtAccessSecret: process.env.JWT_ACCESS_SECRET ?? 'dev-access-secret',
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET ?? 'dev-refresh-secret',
  accessTokenTtl: '12h' as const,
  refreshTokenTtl: '30d' as const,
  uploadDir: path.resolve(process.cwd(), process.env.UPLOAD_DIR ?? 'uploads'),
  maxVideoSeconds: 60,
  maxPhotoBytes: 15 * 1024 * 1024,
  maxVideoBytes: 500 * 1024 * 1024,
  /** Media must be captured within this many minutes before submission. */
  captureFreshnessMinutes: 30,
  /**
   * Photos and videos are compressed before they are stored (services/mediaOptimizer.ts). The
   * defaults were chosen by testing phone photos and an inspection test sheet (fine print,
   * 1-2 px misregistration, hairline scratches, small colour differences): see README "Photo and
   * video storage". MEDIA_OPTIMIZE=0 stores uploads exactly as received.
   */
  media: {
    optimize: process.env.MEDIA_OPTIMIZE !== '0',
    /** Longest side of a stored photo, in pixels. Phone photos are about 4000 px. */
    photoMaxEdge: envNumber('MEDIA_PHOTO_MAX_EDGE', 3072, 1024, 8192),
    /** JPEG quality 1-100 (mozjpeg, full colour resolution). */
    photoQuality: envNumber('MEDIA_PHOTO_QUALITY', 80, 50, 95),
    /** Longest side of a stored video (1280 = 720p, what the app records). */
    videoMaxEdge: envNumber('MEDIA_VIDEO_MAX_EDGE', 1280, 480, 1920),
    /** H.264 constant quality: lower is better quality and bigger (18-28 is sensible). */
    videoCrf: envNumber('MEDIA_VIDEO_CRF', 23, 16, 32),
    /** Upper limit of the video bitrate, in kbit/s, so a noisy video cannot grow large. */
    videoMaxKbps: envNumber('MEDIA_VIDEO_MAX_KBPS', 4000, 800, 20000),
    /** CPU threads one video compression may use, so the server stays responsive. */
    videoThreads: envNumber('MEDIA_VIDEO_THREADS', 2, 1, 16),
    /** ffmpeg program; the one installed with the backend (ffmpeg-static) by default. */
    ffmpegPath: process.env.FFMPEG_PATH || null
  },
  /** Built worker web app (`npm run build:web` in worker-mobile), served at /app. */
  workerWebDir: path.resolve(process.cwd(), process.env.WORKER_WEB_DIR ?? '../worker-mobile/dist'),
  /**
   * Optional HTTPS listener on its own port, next to plain HTTP on `port`.
   * Browsers only allow the live camera preview, adding the app to the home screen and
   * notifications on HTTPS (or localhost), so the worker web app on iPhones needs it.
   * HTTP stays on for the Android app and the admin panel: Android apps do not trust a
   * company/self-signed certificate installed on the phone.
   */
  httpsPort: Number(process.env.HTTPS_PORT ?? 4443),
  httpsKeyFile: process.env.HTTPS_KEY_FILE ? path.resolve(process.cwd(), process.env.HTTPS_KEY_FILE) : null,
  httpsCertFile: process.env.HTTPS_CERT_FILE ? path.resolve(process.cwd(), process.env.HTTPS_CERT_FILE) : null
}
