import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import { config } from './config'
import { createApp } from './app'
import { removeLegacyPlantLabel } from './db/cleanupLegacy'
import { ensureSuperAdmin } from './db/ensureSuperAdmin'
import { ensureNewParameters } from './db/ensureNewParameters'
import path from 'node:path'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { db } from './db/client'
import { prepareChecks } from './services/checkGenerator'
import { repairCheckWorkers } from './services/workerAssignment'
import { fixHolidayCalendar2026Adjustments, importHolidayCalendar2026 } from './db/holidayCalendar2026'
import { ensureWeeklyOffSetting, purgeAllClosedDays } from './services/plantCalendar'
import { ensureDefaultWeeklyRules } from './services/weeklyRules'
import { adoptExistingFutureEntries } from './services/calendarYears'
import { checkPushReceipts, notifyDueChecks } from './services/notifications'
import { cleanOldTempFiles, kickVideoOptimization, videoOptimizationEnabled } from './services/mediaOptimizer'

// Bring the database up to date before serving requests. New code can reach a running backend
// (e.g. `npm run dev` reloads on save) before anyone runs `npm run db:migrate`; without this the
// API would query columns that do not exist yet. Already-applied migrations are skipped.
try {
  await migrate(db, { migrationsFolder: path.resolve(process.cwd(), 'drizzle') })
} catch (err) {
  console.error('Database migration failed; the backend cannot start safely.', err)
  process.exit(1)
}

const app = createApp()

/**
 * Every minute: create today's scheduled checks, move them to DUE, and notify the
 * workers assigned to those machines. This runs even when nobody has the app open.
 */
const TICK_MS = 60_000

async function tick() {
  try {
    await prepareChecks([new Date()])
    const sent = await notifyDueChecks()
    if (sent.messages) console.log(`Notified ${sent.messages} device(s) about ${sent.checks} due check(s)`)
    await checkPushReceipts()
  } catch (err) {
    console.error('Scheduler tick failed', err)
  }
}

const addresses = (protocol: string, port: number) =>
  Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => `${protocol}://${i!.address}:${port}`)

// HTTPS alongside HTTP when a certificate is configured (see config.httpsPort).
if (config.httpsKeyFile && config.httpsCertFile) {
  const credentials = { key: fs.readFileSync(config.httpsKeyFile), cert: fs.readFileSync(config.httpsCertFile) }
  https.createServer(credentials, app).listen(config.httpsPort, '0.0.0.0', () => {
    const lan = addresses('https', config.httpsPort)
    console.log(`HTTPS on https://localhost:${config.httpsPort}${lan.length ? ` and ${lan.join(', ')}` : ''}`)
    if (lan.length) console.log(`Worker web app (iPhone/PC): ${lan[0]}/app/`)
  })
}

http.createServer(app).listen(config.port, '0.0.0.0', () => {
  const lan = addresses('http', config.port)
  console.log(`Quality backend running on http://localhost:${config.port}`)
  if (lan.length) console.log(`On the factory network: ${lan.join(', ')}`)
  if (lan.length && !config.httpsKeyFile) {
    console.log(`Worker web app: ${lan[0]}/app/ (set HTTPS_KEY_FILE/HTTPS_CERT_FILE for iPhone camera preview and notifications)`)
  }

  // Videos left waiting for compression by a restart, and old temporary upload files.
  if (config.media.optimize && !videoOptimizationEnabled()) console.warn('Video compression is off: ffmpeg was not found (set FFMPEG_PATH).')
  cleanOldTempFiles()
    .then(() => kickVideoOptimization())
    .catch((err) => console.error('Media clean-up failed', err))
  removeLegacyPlantLabel().catch((err) => console.error('Settings cleanup failed', err))
  ensureSuperAdmin().catch((err) => console.error('Super Admin check failed', err))
  ensureNewParameters()
    .then((added) => added && console.log(`Parameters: added ${added} new quality parameter(s) as optional on every check type.`))
    .catch((err) => console.error('Adding the new parameters failed', err))
  // Load the 2026 company holiday calendar (once), then give every stored check its worker,
  // both before the first scheduler pass.
  ensureWeeklyOffSetting()
    .then(() => importHolidayCalendar2026())
    .then(() => fixHolidayCalendar2026Adjustments())
    // Annual calendars (2027+): Thursday weekly rule, and any 2027+ dates entered before.
    .then(() => ensureDefaultWeeklyRules())
    .then(() => adoptExistingFutureEntries())
    .catch((err) => console.error('Holiday calendar import failed', err))
    // Closed dates (weekly off, holidays) keep no open or Missed checks, however old.
    .then(() => purgeAllClosedDays())
    .then((removed) => removed && console.log(`Plant Calendar: removed ${removed} unsubmitted check(s) on closed dates.`))
    .catch((err) => console.error('Closed-day cleanup failed', err))
    .then(() => repairCheckWorkers())
    .catch((err) => console.error('Check worker repair failed', err))
    .finally(() => {
      tick()
      setInterval(tick, TICK_MS)
    })
})
