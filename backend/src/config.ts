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
