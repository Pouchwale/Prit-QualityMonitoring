import fs from 'node:fs/promises'
import path from 'node:path'
import type Mail from 'nodemailer/lib/mailer'
import MailComposer from 'nodemailer/lib/mail-composer'
import { and, asc, desc, eq, gte, inArray, isNull, lte, ne, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { reportEmailAlerts, reportEmailLogs, reportEmailSettings, type RecipientDelivery } from '../db/schema'
import { config } from '../config'
import { badRequest, conflict, notFound } from '../lib/http'
import { createTransporter, resolveSmtpConfig, type SmtpConfig } from './reportEmailer'
import { formatDateTime } from './reportData'

/**
 * Delivery of report emails, with their status, retries and failure alerts.
 *
 *  PENDING   in the log, waiting to be sent or being sent now
 *  SENT      the mail server accepted it for every recipient. That is all "Sent" means: the app
 *            cannot know whether the email reached an inbox or was read.
 *  RETRYING  a temporary failure (network, timeout, a 4xx reply): sent again after 5, 15 and 30
 *            minutes from the scheduler tick (index.ts), only to the recipients it failed for
 *  FAILED    a permanent failure (wrong login, refused address, a 5xx reply), or every retry used
 *
 * The message is built once and kept as it was sent (config.reportOutboxDir, never served), so a
 * retry sends exactly the same email, and only to the recipients the mail server did not accept:
 * nobody gets it twice. A retry is claimed in one conditional update, so two ticks, two servers or a
 * Retry click at the same moment never send it twice either.
 *
 * An automated email (the schedule's own, not one a person sent) that fails raises one alert per
 * email: a popup for the Super Admin (report_email_alerts) and one failure alert email to the
 * address set in Report Sharing. The alert email is sent directly, never through this delivery, so
 * an alert that cannot be sent is only recorded and can never raise another alert.
 */

export type DeliveryStatus = 'PENDING' | 'SENT' | 'FAILED' | 'RETRYING'
export type FailureKind = 'TEMPORARY' | 'PERMANENT'

/** Minutes before each automatic retry; after the last one a temporary failure is FAILED too. */
export const RETRY_DELAYS_MINUTES = [5, 15, 30] as const
/** The first send and the retries. */
export const MAX_ATTEMPTS = RETRY_DELAYS_MINUTES.length + 1
/** A send still PENDING after this was interrupted (the server stopped while sending). */
const STUCK_AFTER_MS = 30 * 60_000
/** Sent messages are kept this long for Retry Sending. */
const KEEP_OUTBOX_DAYS = 14
/** One alert email per error in this time: a mail server that is down for hours sends one, not one per report. */
const ALERT_EMAIL_QUIET_MS = 6 * 3600_000

export const TRIGGER_NAME: Record<string, string> = {
  AUTO: 'Automated Quality Inspection Report',
  DAILY: 'Daily previous-day task report',
  MANUAL: 'Manual report email',
  LEAVE: 'Leave Management email'
}

type LogRow = typeof reportEmailLogs.$inferSelect
/** What the caller records about the email; the delivery fields are filled in here. */
export type LogFields = Pick<
  typeof reportEmailLogs.$inferInsert,
  'trigger' | 'recipients' | 'subject' | 'checkIds' | 'checksCount' | 'periodFrom' | 'periodTo' | 'percentage' | 'pdfSizeBytes' | 'videoCount' | 'sentAt' | 'sentById' | 'sentByName'
>

export interface DeliveryResult {
  logId: string
  status: DeliveryStatus
  /** Recipients the mail server accepted, this attempt and before. */
  sent: string[]
  failed: { email: string; error: string | null; status: RecipientDelivery['status'] }[]
  /** The first failure of this attempt (null when it was sent). */
  error: string | null
  nextRetryAt: Date | null
}

/** The SMTP settings of the Report Sharing settings, in the shape the mailer takes. */
export const smtpOf = (s: { smtpHost: string | null; smtpPort: number | null; smtpSecure: boolean; smtpUser: string | null; smtpPass: string | null; smtpFrom: string | null }): SmtpConfig => ({
  host: s.smtpHost,
  port: s.smtpPort,
  secure: s.smtpSecure,
  user: s.smtpUser,
  pass: s.smtpPass,
  from: s.smtpFrom
})

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 1000)
const lc = (email: string) => email.trim().toLowerCase()
/** "Quality <qa@x.com>" -> "qa@x.com", for the SMTP envelope. */
const addressOnly = (from: string) => /<([^>]+)>/.exec(from)?.[1]?.trim() ?? from.trim()
const outboxPath = (logId: string) => path.join(config.reportOutboxDir, `${logId}.eml`)
const isAutomated = (row: Pick<LogRow, 'trigger' | 'sentById'>) => (row.trigger === 'AUTO' || row.trigger === 'DAILY') && !row.sentById

/**
 * Whether sending again may help. A reply code decides when there is one (4xx temporary, 5xx
 * permanent); a wrong login, a refused message or missing SMTP credentials are permanent; network
 * errors and timeouts are temporary.
 */
export function classifySmtpError(err: unknown): FailureKind {
  const e = (err ?? {}) as { responseCode?: number; code?: string; message?: string }
  if (typeof e.responseCode === 'number' && e.responseCode >= 400) return e.responseCode >= 500 ? 'PERMANENT' : 'TEMPORARY'
  if (e.code === 'EAUTH' || e.code === 'EENVELOPE' || e.code === 'EMESSAGE') return 'PERMANENT'
  if (/credentials are missing/i.test(e.message ?? '')) return 'PERMANENT'
  return 'TEMPORARY'
}

/** A structured line for the server log (never the SMTP password: it is not in any of these values). */
const logEvent = (event: string, data: Record<string, unknown>) => console.log(JSON.stringify({ event, at: new Date().toISOString(), ...data }))

/**
 * Records a report email in the log as PENDING, builds it, keeps a copy for retries and sends it.
 * The caller gives the content (subject, html, attachments); From and To come from the settings.
 */
export async function sendLoggedEmail(input: { log: LogFields; mail: Omit<Mail.Options, 'from' | 'to' | 'cc' | 'bcc'>; smtp: SmtpConfig }): Promise<DeliveryResult> {
  const recipients = [...new Map(input.log.recipients.map((r) => r.trim()).filter(Boolean).map((r) => [lc(r), r])).values()]
  const [row] = await db
    .insert(reportEmailLogs)
    .values({
      ...input.log,
      recipients,
      subject: input.log.subject,
      status: 'PENDING',
      recipientStatus: recipients.map((email) => ({ email, status: 'PENDING' as const })),
      attempts: 0
    })
    .returning({ id: reportEmailLogs.id })

  let raw: Buffer
  try {
    raw = await new MailComposer({ ...input.mail, from: resolveSmtpConfig(input.smtp).from, to: recipients.join(', ') }).compile().build()
  } catch (err) {
    // Nothing to send (e.g. an attachment that cannot be read): the same thing would fail again.
    await bumpAttempt(row.id)
    return finish(
      row.id,
      recipients.map((email) => ({ email, ok: false, error: `The email could not be prepared: ${errorText(err)}`, kind: 'PERMANENT' as const })),
      null
    )
  }
  try {
    await fs.mkdir(config.reportOutboxDir, { recursive: true })
    await fs.writeFile(outboxPath(row.id), raw)
  } catch (err) {
    // Sent anyway; only a later retry is not possible.
    logEvent('report_email_outbox_write_failed', { logId: row.id, error: errorText(err) })
  }
  return attempt(row.id, raw, recipients, input.smtp)
}

async function bumpAttempt(logId: string) {
  await db
    .update(reportEmailLogs)
    .set({ attempts: sql`${reportEmailLogs.attempts} + 1`, lastAttemptAt: new Date() })
    .where(eq(reportEmailLogs.id, logId))
}

type Outcome = { email: string; ok: boolean; error?: string; kind?: FailureKind }

/** Hands the message to the mail server for `targets` and records what it accepted. */
async function attempt(logId: string, raw: Buffer, targets: string[], smtp: SmtpConfig): Promise<DeliveryResult> {
  await bumpAttempt(logId)
  const outcomes: Outcome[] = []
  let messageId: string | null = null
  type Rejected = { recipient?: string; responseCode?: number; message?: string }
  const rejectedFor = (list: Rejected[] | undefined, email: string) => list?.find((r) => lc(r.recipient ?? '') === lc(email))
  try {
    const transporter = createTransporter(smtp)
    const info = await transporter.sendMail({ envelope: { from: addressOnly(resolveSmtpConfig(smtp).from), to: targets }, raw })
    messageId = info.messageId ?? null
    const accepted = new Set(((info.accepted ?? []) as (string | { address: string })[]).map((a) => lc(typeof a === 'string' ? a : a.address)))
    const rejected = (info as { rejectedErrors?: Rejected[] }).rejectedErrors
    for (const email of targets) {
      if (accepted.has(lc(email))) {
        outcomes.push({ email, ok: true })
        continue
      }
      const r = rejectedFor(rejected, email)
      outcomes.push({ email, ok: false, error: r ? errorText(r) : 'The mail server did not accept this recipient.', kind: r ? classifySmtpError(r) : 'PERMANENT' })
    }
  } catch (err) {
    const rejected = (err as { rejectedErrors?: Rejected[] }).rejectedErrors
    for (const email of targets) {
      const r = rejectedFor(rejected, email)
      outcomes.push({ email, ok: false, error: errorText(r ?? err), kind: classifySmtpError(r ?? err) })
    }
  }
  return finish(logId, outcomes, messageId)
}

/** Saves the outcome of an attempt: each recipient's status, the email's status and the next retry. */
async function finish(logId: string, outcomes: Outcome[], messageId: string | null): Promise<DeliveryResult> {
  const now = new Date()
  const [row] = await db.select().from(reportEmailLogs).where(eq(reportEmailLogs.id, logId))
  const canRetry = row.attempts < MAX_ATTEMPTS
  const byEmail = new Map(outcomes.map((o) => [lc(o.email), o]))
  const before: RecipientDelivery[] = row.recipientStatus.length ? row.recipientStatus : row.recipients.map((email) => ({ email, status: 'PENDING' }))
  const list: RecipientDelivery[] = before.map((r) => {
    const o = byEmail.get(lc(r.email))
    if (!o) return r
    if (o.ok) return { email: r.email, status: 'SENT', error: null, at: now.toISOString() }
    return { email: r.email, status: o.kind === 'TEMPORARY' && canRetry ? 'RETRYING' : 'FAILED', error: o.error ?? null, at: now.toISOString() }
  })
  const status: DeliveryStatus = list.some((r) => r.status === 'RETRYING')
    ? 'RETRYING'
    : list.some((r) => r.status === 'FAILED')
      ? 'FAILED'
      : list.every((r) => r.status === 'SENT')
        ? 'SENT'
        : 'PENDING'
  const failedNow = outcomes.filter((o) => !o.ok)
  const error = failedNow[0]?.error ?? null
  const nextRetryAt = status === 'RETRYING' ? new Date(now.getTime() + RETRY_DELAYS_MINUTES[Math.max(0, row.attempts - 1)] * 60_000) : null
  const failureKind: FailureKind | null = failedNow.length ? (failedNow.every((o) => o.kind === 'TEMPORARY') ? 'TEMPORARY' : 'PERMANENT') : null

  await db
    .update(reportEmailLogs)
    .set({
      status,
      recipientStatus: list,
      // The last failure; a recovered email keeps none here (its alert keeps the original reason).
      errorMessage: status === 'SENT' ? null : (error ?? row.errorMessage),
      failureKind: status === 'SENT' ? null : (failureKind ?? row.failureKind),
      nextRetryAt,
      recoveredAt: status === 'SENT' && row.attempts > 1 ? now : row.recoveredAt,
      messageId: messageId ?? row.messageId
    })
    .where(eq(reportEmailLogs.id, logId))

  if (status === 'SENT') await fs.rm(outboxPath(logId), { force: true }).catch(() => {})
  logEvent('report_email_delivery', {
    logId,
    trigger: row.trigger,
    status,
    attempt: row.attempts,
    sent: outcomes.filter((o) => o.ok).length,
    failed: failedNow.map((o) => ({ email: o.email, kind: o.kind })),
    error,
    nextRetryAt
  })

  const failed = list.filter((r) => r.status !== 'SENT').map((r) => ({ email: r.email, error: r.error ?? null, status: r.status }))
  if (status !== 'SENT' && failedNow.length && isAutomated(row)) {
    await raiseAlert({ ...row, status, nextRetryAt, failureKind }, failed.map((f) => f.email), error).catch((err) =>
      logEvent('report_email_alert_error', { logId, error: errorText(err) })
    )
  }
  return { logId, status, sent: list.filter((r) => r.status === 'SENT').map((r) => r.email), failed, error, nextRetryAt }
}

/** What happens next, in words, for the alert email and the popup. */
export function retryStatusText(row: { status: string; attempts: number; nextRetryAt: Date | null; failureKind: string | null; recoveredAt?: Date | null }) {
  if (row.status === 'SENT') return row.recoveredAt ? `Sent after retrying (${formatDateTime(row.recoveredAt)})` : 'Sent'
  if (row.status === 'RETRYING' && row.nextRetryAt) return `Will be retried automatically (retry ${row.attempts} of ${RETRY_DELAYS_MINUTES.length})`
  if (row.status === 'PENDING') return 'Being sent now'
  if (row.failureKind === 'PERMANENT') return 'Not retried automatically: the error will not go away by itself. Fix the cause, then use Retry Sending.'
  return `Not sent after ${row.attempts} attempts. Use Retry Sending once the mail server works again.`
}

const esc = (value: unknown) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

/**
 * The popup record and the failure alert email for an automated email that failed. Once per email:
 * the unique log_id makes a second call (a later retry failing) do nothing.
 */
async function raiseAlert(row: LogRow, failedRecipients: string[], error: string | null) {
  const [alert] = await db
    .insert(reportEmailAlerts)
    .values({ logId: row.id, errorMessage: error, failedRecipients })
    .onConflictDoNothing()
    .returning()
  if (!alert) return

  const [settingsRow] = await db.select({ to: reportEmailSettings.failureAlertEmail }).from(reportEmailSettings).limit(1)
  const to = settingsRow?.to?.trim() || null
  const record = (values: Partial<typeof reportEmailAlerts.$inferInsert>) =>
    db.update(reportEmailAlerts).set({ alertEmailTo: to, alertEmailAt: new Date(), ...values }).where(eq(reportEmailAlerts.id, alert.id))

  if (!to) {
    await record({ alertEmailStatus: 'NOT_CONFIGURED' })
    logEvent('report_email_alert_not_configured', { alertId: alert.id, logId: row.id })
    return
  }
  // The same error alerted by email a short while ago (e.g. the mail server is down): no second email.
  const recent = await db
    .select({ id: reportEmailAlerts.id })
    .from(reportEmailAlerts)
    .where(
      and(
        ne(reportEmailAlerts.id, alert.id),
        eq(reportEmailAlerts.alertEmailStatus, 'SENT'),
        error === null ? isNull(reportEmailAlerts.errorMessage) : eq(reportEmailAlerts.errorMessage, error),
        gte(reportEmailAlerts.alertEmailAt, new Date(Date.now() - ALERT_EMAIL_QUIET_MS))
      )
    )
    .limit(1)
  if (recent.length) {
    await record({ alertEmailStatus: 'SKIPPED', alertEmailError: 'An alert email for the same error was sent less than 6 hours ago.' })
    return
  }

  const name = TRIGGER_NAME[row.trigger] ?? row.trigger
  const failedAt = new Date()
  const retry = retryStatusText(row)
  const lines: [string, string][] = [
    ['Schedule', name],
    ['Email', row.subject],
    ['Log ID', row.id],
    ['Intended recipient(s)', failedRecipients.join(', ')],
    ['Failed at', formatDateTime(failedAt)],
    ['Error', error ?? 'Unknown error'],
    ['Retry status', retry]
  ]
  try {
    // Imported here: automatedReports uses this module to send.
    const { getReportSharingSettings } = await import('./automatedReports')
    const smtp = smtpOf(await getReportSharingSettings())
    await createTransporter(smtp).sendMail({
      from: resolveSmtpConfig(smtp).from,
      to,
      subject: `Report email failed: ${name}`,
      text: `An automated report email could not be sent.\n\n${lines.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\nThe Super Admin sees this in the admin panel too (Reports → Report Sharing → Delivery log).`,
      html: `<div style="font-family: Arial, sans-serif; font-size: 14px; color: #1e293b">
  <p><strong>An automated report email could not be sent.</strong></p>
  <table cellpadding="6" style="border-collapse: collapse">${lines
    .map(([k, v]) => `<tr><td style="color:#64748b; vertical-align: top">${esc(k)}</td><td>${esc(v)}</td></tr>`)
    .join('')}</table>
  <p style="color:#64748b; font-size: 12px">The Super Admin sees this in the admin panel too (Reports → Report Sharing → Delivery log).</p>
</div>`
    })
    await record({ alertEmailStatus: 'SENT' })
    logEvent('report_email_alert_sent', { alertId: alert.id, logId: row.id, to })
  } catch (err) {
    // Recorded and shown to the Super Admin; never retried and never alerted itself.
    await record({ alertEmailStatus: 'FAILED', alertEmailError: errorText(err) })
    logEvent('report_email_alert_failed', { alertId: alert.id, logId: row.id, to, error: errorText(err) })
  }
}

/**
 * Sends a failed email again. Automatic (the scheduler): only RETRYING emails whose time has come.
 * Manual (Retry Sending): RETRYING or FAILED, now. Only the recipients it was not sent to get it.
 */
export async function resendReportEmail(logId: string, opts: { manual: boolean; now?: Date }): Promise<DeliveryResult | null> {
  const now = opts.now ?? new Date()
  const [row] = await db.select().from(reportEmailLogs).where(eq(reportEmailLogs.id, logId))
  if (!row) {
    if (opts.manual) throw notFound('Report email')
    return null
  }
  if (opts.manual && row.status !== 'FAILED' && row.status !== 'RETRYING') {
    throw conflict(row.status === 'SENT' ? 'This email was already sent.' : 'This email is being sent right now.')
  }
  let raw: Buffer
  try {
    raw = await fs.readFile(outboxPath(logId))
  } catch {
    const message = `The original email is no longer stored (kept ${KEEP_OUTBOX_DAYS} days, for emails sent after delivery tracking started). Send the report again from Report Sharing instead.`
    if (opts.manual) throw badRequest(message)
    await db
      .update(reportEmailLogs)
      .set({ status: 'FAILED', nextRetryAt: null, failureKind: 'PERMANENT', errorMessage: message })
      .where(and(eq(reportEmailLogs.id, logId), eq(reportEmailLogs.status, 'RETRYING')))
    return null
  }

  // Claim it: whoever changes RETRYING/FAILED to PENDING sends it; everyone else does nothing.
  const [claimed] = await db
    .update(reportEmailLogs)
    .set({ status: 'PENDING', nextRetryAt: null })
    .where(
      and(
        eq(reportEmailLogs.id, logId),
        opts.manual ? inArray(reportEmailLogs.status, ['RETRYING', 'FAILED']) : and(eq(reportEmailLogs.status, 'RETRYING'), lte(reportEmailLogs.nextRetryAt, now))
      )
    )
    .returning()
  if (!claimed) {
    if (opts.manual) throw conflict(row.status === 'SENT' ? 'This email was already sent.' : 'This email is being sent right now.')
    return null
  }
  const targets = claimed.recipientStatus.filter((r) => r.status !== 'SENT').map((r) => r.email)
  if (!targets.length) return finish(logId, [], null)
  const { getReportSharingSettings } = await import('./automatedReports')
  return attempt(logId, raw, targets, smtpOf(await getReportSharingSettings()))
}

/**
 * From the scheduler tick: sends the emails due for a retry, marks interrupted sends FAILED (not
 * resent automatically: the mail server may have taken them before the stop), and removes kept
 * messages older than KEEP_OUTBOX_DAYS.
 */
export async function processReportEmailRetries(now = new Date()) {
  const stuck = await db
    .update(reportEmailLogs)
    .set({
      status: 'FAILED',
      failureKind: 'TEMPORARY',
      errorMessage: 'Sending was interrupted (the server stopped while sending). It is not sent again automatically, so nobody gets it twice; use Retry Sending if it did not arrive.'
    })
    .where(and(eq(reportEmailLogs.status, 'PENDING'), lte(reportEmailLogs.lastAttemptAt, new Date(now.getTime() - STUCK_AFTER_MS))))
    .returning()
  for (const row of stuck) {
    const list = row.recipientStatus.map((r) => (r.status === 'PENDING' ? { ...r, status: 'FAILED' as const, error: row.errorMessage, at: now.toISOString() } : r))
    await db.update(reportEmailLogs).set({ recipientStatus: list }).where(eq(reportEmailLogs.id, row.id))
    logEvent('report_email_interrupted', { logId: row.id })
    if (isAutomated(row)) await raiseAlert(row, list.filter((r) => r.status !== 'SENT').map((r) => r.email), row.errorMessage).catch(() => {})
  }

  const due = await db
    .select({ id: reportEmailLogs.id })
    .from(reportEmailLogs)
    .where(and(eq(reportEmailLogs.status, 'RETRYING'), lte(reportEmailLogs.nextRetryAt, now)))
    .orderBy(asc(reportEmailLogs.nextRetryAt))
    .limit(5)
  for (const { id } of due) {
    await resendReportEmail(id, { manual: false, now }).catch((err) => logEvent('report_email_retry_error', { logId: id, error: errorText(err) }))
  }

  await pruneOutbox(now)
  return { retried: due.length, interrupted: stuck.length }
}

async function pruneOutbox(now: Date) {
  let names: string[]
  try {
    names = await fs.readdir(config.reportOutboxDir)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.endsWith('.eml')) continue
    const file = path.join(config.reportOutboxDir, name)
    const stat = await fs.stat(file).catch(() => null)
    if (stat && now.getTime() - stat.mtimeMs > KEEP_OUTBOX_DAYS * 24 * 3600_000) await fs.rm(file, { force: true }).catch(() => {})
  }
}

// ---------------------------------------------------------------------------- Super Admin alerts

/** The alerts with their email's current state: open = not dismissed (the popup), otherwise the latest. */
export async function listReportEmailAlerts(opts: { open: boolean; limit?: number }) {
  const rows = await db
    .select({
      alert: reportEmailAlerts,
      log: {
        id: reportEmailLogs.id,
        trigger: reportEmailLogs.trigger,
        subject: reportEmailLogs.subject,
        recipients: reportEmailLogs.recipients,
        status: reportEmailLogs.status,
        attempts: reportEmailLogs.attempts,
        nextRetryAt: reportEmailLogs.nextRetryAt,
        failureKind: reportEmailLogs.failureKind,
        recoveredAt: reportEmailLogs.recoveredAt,
        errorMessage: reportEmailLogs.errorMessage,
        recipientStatus: reportEmailLogs.recipientStatus,
        sentAt: reportEmailLogs.sentAt
      }
    })
    .from(reportEmailAlerts)
    .innerJoin(reportEmailLogs, eq(reportEmailLogs.id, reportEmailAlerts.logId))
    .where(opts.open ? isNull(reportEmailAlerts.dismissedAt) : undefined)
    .orderBy(desc(reportEmailAlerts.failedAt))
    .limit(opts.limit ?? 50)
  return rows.map(({ alert, log }) => ({
    ...alert,
    scheduleName: TRIGGER_NAME[log.trigger] ?? log.trigger,
    email: { ...log, retryStatus: retryStatusText(log) },
    // The kept message is needed for Retry Sending.
    canRetry: log.status === 'FAILED' || log.status === 'RETRYING'
  }))
}

/** Read (opened) or dismissed (acknowledged: the popup stops showing it). The record stays. */
export async function markReportEmailAlert(id: string, action: 'read' | 'dismiss', userId: string) {
  const now = new Date()
  const [row] = await db
    .update(reportEmailAlerts)
    .set(
      action === 'read'
        ? { readAt: sql`coalesce(${reportEmailAlerts.readAt}, ${now})`, readById: sql`coalesce(${reportEmailAlerts.readById}, ${userId}::uuid)` }
        : {
            dismissedAt: now,
            dismissedById: userId,
            readAt: sql`coalesce(${reportEmailAlerts.readAt}, ${now})`,
            readById: sql`coalesce(${reportEmailAlerts.readById}, ${userId}::uuid)`
          }
    )
    .where(eq(reportEmailAlerts.id, id))
    .returning()
  if (!row) throw notFound('Alert')
  return row
}
