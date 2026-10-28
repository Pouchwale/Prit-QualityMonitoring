import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { qualityChecks, reportEmailLogs, reportEmailSettings, settings } from '../db/schema'
import {
  getChecksForCrystalReport,
  renderCrystalReportPdf,
  type CrystalReportBatchData,
  type CrystalReportCheck
} from './crystalReportPdf'
import { buildReportMail, type SmtpConfig } from './reportEmailer'
import { sendLoggedEmail, smtpOf, type DeliveryStatus } from './reportDelivery'
import { badRequest } from '../lib/http'
import { decryptPassword, encryptPassword } from '../lib/passwordVault'
import { HHMM_REGEX, addDays, atTime, dateKey } from '../lib/time'

/** At most this many checks go into one report (each is a PDF page with its photos). */
export const MAX_REPORT_CHECKS = 200

/** A scheduled run that could not be sent is tried again this long after it started. */
const RETRY_AFTER_MS = 30 * 60_000

export interface ReportSharingSettingsDto {
  id?: string
  isEnabled: boolean
  frequencyHours: number
  frequencyMinutes: number
  /** DAILY_REPORT: the schedule sends the daily previous-day task report instead of inspection reports. */
  frequencyMode: 'INTERVAL' | 'DAILY_AT' | 'DAILY_REPORT'
  scheduledTime: string | null
  percentage: number
  recipients: string[]
  lastRunAt: Date | null
  nextRunAt: Date | null
  smtpHost: string | null
  smtpPort: number | null
  smtpSecure: boolean
  smtpUser: string | null
  smtpPass: string | null
  smtpFrom: string | null
  /** Send time of the daily previous-day task report (frequencyMode DAILY_REPORT). */
  dailyReportTime: string
  /** Where failure alerts of automated report emails go (services/reportDelivery.ts); null: none. */
  failureAlertEmail: string | null
  updatedAt?: Date
}

/** Calculates the next execution timestamp based on frequency mode and settings */
export function calculateNextRunAt(
  mode: 'INTERVAL' | 'DAILY_AT' | 'DAILY_REPORT',
  minutes: number,
  scheduledTime?: string | null,
  fromTime: Date = new Date()
): Date {
  // DAILY_REPORT runs once a day too: `scheduledTime` is then the daily report's send time.
  if ((mode === 'DAILY_AT' || mode === 'DAILY_REPORT') && scheduledTime && HHMM_REGEX.test(scheduledTime)) {
    // The time of day is the plant's (PLANT_TIMEZONE), whatever timezone the server runs in.
    const today = atTime(fromTime, scheduledTime)
    // If target time for today has already passed, schedule for tomorrow
    return today.getTime() > fromTime.getTime() ? today : atTime(addDays(fromTime, 1), scheduledTime)
  }

  // INTERVAL mode: add minutes (default minimum 10 minutes)
  const safeMinutes = Math.max(10, minutes || 60)
  return new Date(fromTime.getTime() + safeMinutes * 60_000)
}

export interface ReportEmailLogDto {
  id: string
  trigger: 'AUTO' | 'MANUAL' | 'DAILY' | 'LEAVE'
  /** PENDING, SENT (accepted by the mail server for every recipient), RETRYING or FAILED: services/reportDelivery.ts. */
  status: DeliveryStatus
  recipients: string[]
  subject: string
  checkIds: string[]
  checksCount: number
  periodFrom: Date | null
  periodTo: Date | null
  percentage: number | null
  pdfSizeBytes: number | null
  videoCount: number
  errorMessage: string | null
  sentAt: Date
  sentById: string | null
  sentByName: string | null
  /** Each recipient's delivery (empty on emails from before delivery tracking). */
  recipientStatus: { email: string; status: string; error?: string | null; at?: string | null }[]
  attempts: number
  lastAttemptAt: Date | null
  nextRetryAt: Date | null
  failureKind: string | null
  recoveredAt: Date | null
}

/** Fisher-Yates random shuffle */
function shuffle<T>(array: T[]): T[] {
  const arr = [...array]
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

/** Fetches company / plant name from global settings */
export async function getCompanyPlantName(): Promise<{ company: string; plant: string }> {
  try {
    const [row] = await db.select().from(settings).where(eq(settings.key, 'plant'))
    const val = (row?.value ?? {}) as { name?: string; code?: string }
    return {
      company: val.name || 'Quality Monitoring System',
      plant: val.code || 'Plant 1'
    }
  } catch {
    return { company: 'Quality Monitoring System', plant: 'Plant 1' }
  }
}

/** The stored SMTP password: encrypted at rest (lib/passwordVault.ts); older rows hold plain text. */
function readSmtpPass(stored: string | null): string | null {
  if (!stored) return null
  return stored.startsWith('v1:') ? decryptPassword(stored) : stored
}

type SettingsRow = typeof reportEmailSettings.$inferSelect

/** The settings as the app uses them. SMTP fields not stored fall back to the SMTP_* environment values. */
function settingsDto(row: SettingsRow): ReportSharingSettingsDto {
  return {
    id: row.id,
    isEnabled: row.isEnabled,
    frequencyHours: row.frequencyHours,
    frequencyMinutes: row.frequencyMinutes ?? row.frequencyHours * 60,
    frequencyMode: (row.frequencyMode as 'INTERVAL' | 'DAILY_AT' | 'DAILY_REPORT') || 'INTERVAL',
    scheduledTime: row.scheduledTime || null,
    percentage: row.percentage,
    recipients: row.recipients || [],
    lastRunAt: row.lastRunAt,
    nextRunAt: row.nextRunAt,
    smtpHost: row.smtpHost || process.env.SMTP_HOST || null,
    smtpPort: row.smtpPort || (process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : null) || 587,
    smtpSecure: row.smtpSecure ?? process.env.SMTP_SECURE === 'true',
    smtpUser: row.smtpUser || process.env.SMTP_USER || null,
    smtpPass: readSmtpPass(row.smtpPass) || process.env.SMTP_PASS || null,
    smtpFrom: row.smtpFrom || process.env.SMTP_FROM || null,
    dailyReportTime: row.dailyReportTime,
    failureAlertEmail: row.failureAlertEmail ?? null,
    updatedAt: row.updatedAt
  }
}

/**
 * Retrieves or initializes the report sharing settings singleton. The environment's SMTP values
 * are read when used, never copied into the database. A password still stored as plain text is
 * encrypted the first time it is read.
 */
export async function getReportSharingSettings(): Promise<ReportSharingSettingsDto> {
  let [row] = await db.select().from(reportEmailSettings).orderBy(asc(reportEmailSettings.updatedAt)).limit(1)
  if (!row) {
    // One row only (unique index report_email_settings_singleton_idx): a second insert at the same
    // moment does nothing, and both read the row that was created.
    await db.insert(reportEmailSettings).values({ isEnabled: false }).onConflictDoNothing()
    ;[row] = await db.select().from(reportEmailSettings).orderBy(asc(reportEmailSettings.updatedAt)).limit(1)
  }
  if (row.smtpPass && !row.smtpPass.startsWith('v1:')) {
    await db.update(reportEmailSettings).set({ smtpPass: encryptPassword(row.smtpPass) }).where(eq(reportEmailSettings.id, row.id))
  }
  return settingsDto(row)
}

/** Updates report sharing settings */
export async function updateReportSharingSettings(
  input: Partial<ReportSharingSettingsDto>
): Promise<ReportSharingSettingsDto> {
  const current = await getReportSharingSettings()

  const freqMode = input.frequencyMode ?? current.frequencyMode ?? 'INTERVAL'
  const freqMinutes = Math.max(
    10,
    input.frequencyMinutes ?? (input.frequencyHours ? input.frequencyHours * 60 : current.frequencyMinutes)
  )
  const freq = Math.max(1, Math.round(freqMinutes / 60))
  const schedTime = input.scheduledTime !== undefined ? input.scheduledTime : current.scheduledTime
  const pct = Math.min(100, Math.max(1, input.percentage ?? current.percentage))
  const isEnabled = input.isEnabled ?? current.isEnabled
  const dailyTime = input.dailyReportTime ?? current.dailyReportTime

  // A changed schedule takes effect now (not after the old due time); otherwise the next run stays.
  const scheduleChanged =
    freqMode !== current.frequencyMode ||
    freqMinutes !== current.frequencyMinutes ||
    schedTime !== current.scheduledTime ||
    dailyTime !== current.dailyReportTime ||
    !current.isEnabled
  let nextRunAt = current.nextRunAt
  if (isEnabled && (scheduleChanged || !nextRunAt || nextRunAt < new Date())) {
    nextRunAt = calculateNextRunAt(freqMode, freqMinutes, freqMode === 'DAILY_REPORT' ? dailyTime : schedTime)
  } else if (!isEnabled) {
    nextRunAt = null
  }

  const [updated] = await db
    .update(reportEmailSettings)
    .set({
      isEnabled,
      frequencyHours: freq,
      frequencyMinutes: freqMinutes,
      frequencyMode: freqMode,
      scheduledTime: schedTime,
      percentage: pct,
      recipients: input.recipients ?? current.recipients,
      nextRunAt,
      ...(input.smtpHost !== undefined ? { smtpHost: input.smtpHost } : {}),
      ...(input.smtpPort !== undefined ? { smtpPort: input.smtpPort } : {}),
      ...(input.smtpSecure !== undefined ? { smtpSecure: input.smtpSecure } : {}),
      ...(input.smtpUser !== undefined ? { smtpUser: input.smtpUser } : {}),
      // Encrypted at rest; an empty value clears it (the environment's SMTP_PASS is used then).
      ...(input.smtpPass !== undefined ? { smtpPass: input.smtpPass ? encryptPassword(input.smtpPass) : null } : {}),
      ...(input.smtpFrom !== undefined ? { smtpFrom: input.smtpFrom } : {}),
      dailyReportTime: dailyTime,
      ...(input.failureAlertEmail !== undefined ? { failureAlertEmail: input.failureAlertEmail?.trim() || null } : {}),
      updatedAt: new Date()
    })
    .where(eq(reportEmailSettings.id, current.id!))
    .returning()

  return settingsDto(updated)
}

/** Fetches recent email delivery audit history */
export async function getReportEmailLogs(limit = 50, offset = 0): Promise<ReportEmailLogDto[]> {
  const rows = await db
    .select()
    .from(reportEmailLogs)
    .orderBy(desc(reportEmailLogs.sentAt))
    .limit(limit)
    .offset(offset)

  return rows.map((r) => ({
    id: r.id,
    trigger: r.trigger as 'AUTO' | 'MANUAL' | 'DAILY' | 'LEAVE',
    // SUCCESS: a row written by an older build while this one ran.
    status: (r.status === 'SUCCESS' ? 'SENT' : r.status) as DeliveryStatus,
    recipients: r.recipients,
    subject: r.subject,
    checkIds: r.checkIds,
    checksCount: r.checksCount,
    periodFrom: r.periodFrom,
    periodTo: r.periodTo,
    percentage: r.percentage,
    pdfSizeBytes: r.pdfSizeBytes,
    videoCount: r.videoCount ?? 0,
    errorMessage: r.errorMessage,
    sentAt: r.sentAt,
    sentById: r.sentById,
    sentByName: r.sentByName,
    recipientStatus: r.recipientStatus,
    attempts: r.attempts,
    lastAttemptAt: r.lastAttemptAt,
    nextRetryAt: r.nextRetryAt,
    failureKind: r.failureKind,
    recoveredAt: r.recoveredAt
  }))
}

/**
 * Samples eligible checks randomly based on configured percentage.
 * Avoids repeatedly selecting the same checks if new eligible checks exist.
 */
export async function sampleEligibleChecks(options: {
  periodFrom: Date
  periodTo: Date
  percentage: number
  customCheckIds?: string[]
}): Promise<{
  eligibleTotal: number
  sampledCheckIds: string[]
  checks: CrystalReportCheck[]
}> {
  const { periodFrom, periodTo, percentage, customCheckIds } = options

  const inPeriod = and(
    inArray(qualityChecks.status, ['COMPLETED', 'EXCEPTION']),
    sql`COALESCE(${qualityChecks.submittedAt}, ${qualityChecks.scheduledAt}) >= ${periodFrom}`,
    sql`COALESCE(${qualityChecks.submittedAt}, ${qualityChecks.scheduledAt}) <= ${periodTo}`
  )

  // Specific checks chosen in the preview: only those that are really submitted in this period.
  if (customCheckIds && customCheckIds.length > 0) {
    const rows = await db
      .select({ id: qualityChecks.id })
      .from(qualityChecks)
      .where(and(inArray(qualityChecks.id, customCheckIds.slice(0, MAX_REPORT_CHECKS)), inPeriod))
    const ids = rows.map((r) => r.id)
    const checks = ids.length ? await getChecksForCrystalReport(ids) : []
    return {
      eligibleTotal: ids.length,
      sampledCheckIds: ids,
      checks
    }
  }

  // Find all checks completed or with exceptions in the given period
  const eligibleRows = await db
    .select({ id: qualityChecks.id })
    .from(qualityChecks)
    .where(inPeriod)

  const allEligibleIds = eligibleRows.map((r) => r.id)
  if (!allEligibleIds.length) {
    return { eligibleTotal: 0, sampledCheckIds: [], checks: [] }
  }

  // Find checks that were recently sent in the last 24 hours to avoid repeating
  const recentLogs = await db
    .select({ checkIds: reportEmailLogs.checkIds })
    .from(reportEmailLogs)
    .where(gte(reportEmailLogs.sentAt, new Date(Date.now() - 24 * 3600_000)))

  const recentlySentSet = new Set<string>()
  for (const log of recentLogs) {
    for (const id of log.checkIds) {
      recentlySentSet.add(id)
    }
  }

  // De-duplicate: prefer fresh checks that haven't been emailed yet
  const freshIds = allEligibleIds.filter((id) => !recentlySentSet.has(id))
  const pool = freshIds.length >= Math.ceil((allEligibleIds.length * percentage) / 100) ? freshIds : allEligibleIds

  // Compute number of checks to sample: e.g. 20% of 100 = 20, 20% of 50 = 10
  // At most MAX_REPORT_CHECKS checks: every one is a PDF page with its photos, built in memory.
  const sampleCount = Math.min(pool.length, MAX_REPORT_CHECKS, Math.max(1, Math.round((allEligibleIds.length * percentage) / 100)))

  // Random selection using Fisher-Yates
  const shuffled = shuffle(pool)
  const sampledIds = shuffled.slice(0, sampleCount)

  const checks = await getChecksForCrystalReport(sampledIds)
  return {
    eligibleTotal: allEligibleIds.length,
    sampledCheckIds: sampledIds,
    checks
  }
}

/** Executes an automated scheduled report email dispatch */
export async function executeAutomatedReportRun(): Promise<boolean> {
  const settings = await getReportSharingSettings()
  if (!settings.isEnabled || !settings.recipients.length) return false
  // "Daily previous-day task report" is chosen: services/dailyTaskReport.ts sends that instead.
  if (settings.frequencyMode === 'DAILY_REPORT') return false

  const now = new Date()
  if (settings.nextRunAt && settings.nextRunAt > now) {
    return false // Not due yet
  }

  // Claim the run first: the due time moves forward in one statement, so a run that takes longer than
  // a scheduler tick, or a second server, never sends the same report twice.
  const claimed = await db
    .update(reportEmailSettings)
    .set({ nextRunAt: new Date(now.getTime() + RETRY_AFTER_MS) })
    .where(
      and(
        eq(reportEmailSettings.id, settings.id!),
        eq(reportEmailSettings.isEnabled, true),
        or(isNull(reportEmailSettings.nextRunAt), lte(reportEmailSettings.nextRunAt, now))
      )
    )
    .returning({ id: reportEmailSettings.id })
  if (!claimed.length) return false

  const periodTo = now
  const intervalMs = (settings.frequencyMinutes || settings.frequencyHours * 60 || 60) * 60_000
  const periodFrom =
    settings.frequencyMode === 'DAILY_AT'
      ? settings.lastRunAt || new Date(now.getTime() - 24 * 3600_000)
      : settings.lastRunAt || new Date(now.getTime() - intervalMs)

  console.log(`[Automated Reports] Running scheduled email dispatch (${settings.percentage}% sample)...`)

  const sampling = await sampleEligibleChecks({
    periodFrom,
    periodTo,
    percentage: settings.percentage
  })

  const nextRun = calculateNextRunAt(
    settings.frequencyMode || 'INTERVAL',
    settings.frequencyMinutes || settings.frequencyHours * 60 || 60,
    settings.scheduledTime,
    now
  )

  if (!sampling.checks.length) {
    console.log('[Automated Reports] No eligible completed checks found for period. Advancing schedule.')
    await db
      .update(reportEmailSettings)
      .set({
        lastRunAt: now,
        nextRunAt: nextRun
      })
      .where(eq(reportEmailSettings.id, settings.id!))
    return false
  }

  const { company, plant } = await getCompanyPlantName()
  const reportId = `QIR-${dateKey(now).replace(/-/g, '')}-${String(Math.floor(1000 + Math.random() * 9000))}`

  const batchData: CrystalReportBatchData = {
    reportId,
    generatedAt: now,
    companyName: company,
    plantName: plant,
    periodFrom,
    periodTo,
    samplePercentage: settings.percentage,
    totalEligible: sampling.eligibleTotal,
    checks: sampling.checks
  }

  let pdfBuffer: Buffer
  try {
    pdfBuffer = await renderCrystalReportPdf(batchData)
  } catch (pdfErr) {
    console.error('[Automated Reports] PDF generation failed:', pdfErr)
    await db.insert(reportEmailLogs).values({
      trigger: 'AUTO',
      status: 'FAILED',
      recipients: settings.recipients,
      subject: `Quality Inspection Report - ${sampling.checks.length} Checks`,
      checkIds: sampling.sampledCheckIds,
      checksCount: sampling.checks.length,
      periodFrom,
      periodTo,
      percentage: settings.percentage,
      errorMessage: `PDF Generation Failed: ${pdfErr instanceof Error ? pdfErr.message : String(pdfErr)}`,
      sentAt: now
    })
    // Tried again after RETRY_AFTER_MS (the claim above), for the same period: lastRunAt stays.
    return false
  }

  const mail = await buildReportMail({
    recipients: settings.recipients,
    reportId,
    periodFrom,
    periodTo,
    samplePercentage: settings.percentage,
    totalEligible: sampling.eligibleTotal,
    checks: sampling.checks,
    pdfBuffer
  })
  // Logged and sent by services/reportDelivery.ts: a failure is retried there (the same email, to
  // the recipients it failed for) and alerts the Super Admin.
  const delivery = await sendLoggedEmail({
    log: {
      trigger: 'AUTO',
      recipients: settings.recipients,
      subject: mail.subject,
      checkIds: sampling.sampledCheckIds,
      checksCount: sampling.checks.length,
      periodFrom,
      periodTo,
      percentage: settings.percentage,
      pdfSizeBytes: mail.pdfSizeBytes,
      videoCount: mail.videoCount,
      sentAt: now,
      sentByName: 'Automated System Scheduler'
    },
    mail: { subject: mail.subject, html: mail.html, attachments: mail.attachments },
    smtp: smtpOf(settings)
  })

  // The next period starts now, also when this email failed: its retries belong to the email, so a
  // new run for the same period would send a second report.
  await db
    .update(reportEmailSettings)
    .set({
      lastRunAt: now,
      nextRunAt: nextRun
    })
    .where(eq(reportEmailSettings.id, settings.id!))

  console.log(`[Automated Reports] Completed scheduled dispatch. Status: ${delivery.status}`)
  return delivery.status === 'SENT'
}

/** Executes a manual report email dispatch initiated by Admin */
export async function executeManualReportRun(options: {
  recipients: string[]
  periodFrom: Date
  periodTo: Date
  percentage: number
  customCheckIds?: string[]
  sentById?: string
  sentByName?: string
  customSubject?: string
  smtpConfig?: SmtpConfig
}): Promise<{
  success: boolean
  status: DeliveryStatus
  error?: string
  checksCount: number
  videoCount: number
  pdfSizeBytes: number
}> {
  const { recipients, periodFrom, periodTo, percentage, customCheckIds, sentById, sentByName, customSubject, smtpConfig } =
    options

  if (!recipients.length) {
    throw badRequest('Please provide at least one recipient email address.')
  }

  const sampling = await sampleEligibleChecks({
    periodFrom,
    periodTo,
    percentage,
    customCheckIds
  })

  if (!sampling.checks.length) {
    throw badRequest(
      'No completed checks or exceptions found for the selected period. Please expand the "Period From" and "Period To" dates or complete a check first.'
    )
  }

  const now = new Date()
  const { company, plant } = await getCompanyPlantName()
  const reportId = `QIR-MAN-${dateKey(now).replace(/-/g, '')}-${String(Math.floor(1000 + Math.random() * 9000))}`

  const batchData: CrystalReportBatchData = {
    reportId,
    generatedAt: now,
    companyName: company,
    plantName: plant,
    periodFrom,
    periodTo,
    samplePercentage: percentage,
    totalEligible: sampling.eligibleTotal,
    checks: sampling.checks
  }

  let pdfBuffer: Buffer
  try {
    pdfBuffer = await renderCrystalReportPdf(batchData)
  } catch (pdfErr) {
    const msg = pdfErr instanceof Error ? pdfErr.message : String(pdfErr)
    throw badRequest(`PDF report generation failed: ${msg}`)
  }

  const mail = await buildReportMail({
    recipients,
    subject: customSubject,
    reportId,
    periodFrom,
    periodTo,
    samplePercentage: percentage,
    totalEligible: sampling.eligibleTotal,
    checks: sampling.checks,
    pdfBuffer
  })
  const delivery = await sendLoggedEmail({
    log: {
      trigger: 'MANUAL',
      recipients,
      subject: mail.subject,
      checkIds: sampling.sampledCheckIds,
      checksCount: sampling.checks.length,
      periodFrom,
      periodTo,
      percentage,
      pdfSizeBytes: mail.pdfSizeBytes,
      videoCount: mail.videoCount,
      sentAt: now,
      sentById: sentById || null,
      sentByName: sentByName || 'Admin'
    },
    mail: { subject: mail.subject, html: mail.html, attachments: mail.attachments },
    smtp: smtpConfig ?? {}
  })

  return {
    success: delivery.status === 'SENT',
    status: delivery.status,
    error: deliveryError(delivery),
    checksCount: sampling.checks.length,
    videoCount: mail.videoCount,
    pdfSizeBytes: mail.pdfSizeBytes
  }
}

/** The failure in words for the person who pressed Send: who it failed for, and whether it is retried. */
export function deliveryError(d: { status: DeliveryStatus; failed: { email: string }[]; sent: string[]; error: string | null; nextRetryAt: Date | null }) {
  if (d.status === 'SENT') return undefined
  const who = d.sent.length ? ` for ${d.failed.map((f) => f.email).join(', ')} (sent to ${d.sent.length} other recipient${d.sent.length === 1 ? '' : 's'})` : ''
  const next = d.status === 'RETRYING' ? ' It will be retried automatically in a few minutes.' : ''
  return `Sending failed${who}: ${d.error ?? 'unknown error'}.${next}`
}
