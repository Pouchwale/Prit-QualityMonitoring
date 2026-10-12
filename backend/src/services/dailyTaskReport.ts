import { and, eq, isNull, ne, or } from 'drizzle-orm'
import { db } from '../db/client'
import { reportEmailLogs, reportEmailSettings } from '../db/schema'
import { addDays, atTime, dateKey, formatDateKey, startOfDay } from '../lib/time'
import { getCompanyPlantName, getReportSharingSettings, sampleEligibleChecks } from './automatedReports'
import { renderCrystalReportPdf } from './crystalReportPdf'
import { createTransporter, resolveSmtpConfig, scoreSummary, scoreSummaryHtml } from './reportEmailer'

/**
 * Daily previous-day task report: when the Automated schedule's Email frequency is "Daily
 * previous-day task report" (frequency_mode DAILY_REPORT), every day at its send time the recipients get each worker's checks of the day before (plant time): assigned,
 * completed, exceptions, missed, pending, completion % and score, with the same counts and score as
 * the Performance page (services/performance.ts). Workers with missed checks are listed first in a
 * note, so the coordinator knows whom to ask. Runs from the scheduler tick (index.ts), once a day:
 * the day is claimed in one conditional update, so several processes or a restart never send twice.
 *
 * The previous day's Quality Inspection Report is attached as a PDF, exactly as the automated report
 * emails make it: the day's completed and exception checks, sampled at the configured percentage.
 * A day without such checks, or a PDF that cannot be made, still sends the task report (the body says why).
 */
export async function executeDailyTaskReport(now = new Date()): Promise<boolean> {
  const settings = await getReportSharingSettings()
  if (!settings.isEnabled || settings.frequencyMode !== 'DAILY_REPORT' || !settings.recipients.length) return false

  const today = startOfDay(now)
  const todayKey = dateKey(today)
  if (now < atTime(today, settings.dailyReportTime || '08:30')) return false

  // Claim today's report; nothing happens when it was already sent (or is being sent) today.
  const claimed = await db
    .update(reportEmailSettings)
    // nextRunAt is only shown on the page ("Next dispatch"): tomorrow at the send time.
    .set({ dailyReportLastDate: todayKey, nextRunAt: atTime(addDays(today, 1), settings.dailyReportTime || '08:30') })
    .where(
      and(
        eq(reportEmailSettings.id, settings.id!),
        or(isNull(reportEmailSettings.dailyReportLastDate), ne(reportEmailSettings.dailyReportLastDate, todayKey))
      )
    )
    .returning({ id: reportEmailSettings.id })
  if (!claimed.length) return false
  return (await sendDailyTaskReport(settings, now)).success
}

/**
 * Sends today's report again (Report Sharing → "Resend today's report"): the previous day's task
 * report with its Quality Inspection Report PDF, to the configured recipients. It does not change
 * the schedule: the next automatic report still goes out at the send time tomorrow.
 */
export async function resendDailyTaskReport(by: { id?: string; name?: string }, now = new Date()) {
  const settings = await getReportSharingSettings()
  if (!settings.recipients.length) return { success: false, error: 'Add at least one recipient first.', subject: null }
  return sendDailyTaskReport(settings, now, by)
}

type Settings = Awaited<ReturnType<typeof getReportSharingSettings>>

/** Builds and sends the previous day's report, and records it in the email log. */
async function sendDailyTaskReport(settings: Settings, now: Date, by?: { id?: string; name?: string }) {
  const today = startOfDay(now)
  const day = addDays(today, -1)
  const dayKey = dateKey(day)
  const rows = (await scoreSummary(day, today)) ?? []
  const missed = rows.filter((r) => r.missed > 0)
  const assigned = rows.reduce((n, r) => n + r.assigned, 0)
  const subject = `Daily Task Report - ${formatDateKey(dayKey)}${missed.length ? ` - ${missed.length} worker${missed.length === 1 ? '' : 's'} with missed checks` : ''}`

  // The previous day's Quality Inspection Report (PDF), as the automated report emails attach it.
  let attachment: { reportId: string; pdf: Buffer; checks: number; eligible: number; checkIds: string[] } | null = null
  let attachmentNote = ''
  try {
    const sampling = await sampleEligibleChecks({ periodFrom: day, periodTo: today, percentage: settings.percentage })
    if (sampling.checks.length) {
      const { company, plant } = await getCompanyPlantName()
      const reportId = `QIR-${dayKey.replace(/-/g, '')}-${String(Math.floor(1000 + Math.random() * 9000))}`
      const pdf = await renderCrystalReportPdf({
        reportId,
        generatedAt: now,
        companyName: company,
        plantName: plant,
        periodFrom: day,
        periodTo: today,
        samplePercentage: settings.percentage,
        totalEligible: sampling.eligibleTotal,
        checks: sampling.checks
      })
      attachment = { reportId, pdf, checks: sampling.checks.length, eligible: sampling.eligibleTotal, checkIds: sampling.sampledCheckIds }
      attachmentNote = `The Quality Inspection Report for ${formatDateKey(dayKey)} is attached (${attachment.checks} of ${attachment.eligible} completed and exception checks, ${settings.percentage}% sample).`
    } else {
      attachmentNote = `No Quality Inspection Report is attached: no checks were completed or reported as exceptions on ${formatDateKey(dayKey)}.`
    }
  } catch (err) {
    console.error('[Daily task report] Quality Inspection Report PDF failed:', err)
    attachmentNote = 'The Quality Inspection Report could not be attached this time; it can be sent from Report Sharing → Manual send.'
  }

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Daily Task Report</title></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; margin: 0; padding: 24px; background-color: #f1f5f9; color: #1e293b;">
  <table width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width: 780px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; overflow: hidden; border: 1px solid #cbd5e1;">
    <tr>
      <td style="background-color: #1e3a8a; padding: 24px 32px; color: #ffffff;">
        <h1 style="margin: 0; font-size: 20px; font-weight: 700; letter-spacing: 0.5px;">DAILY TASK REPORT</h1>
        <p style="margin: 4px 0 0 0; font-size: 13px; color: #93c5fd;">Previous day: ${formatDateKey(dayKey)} &middot; every worker's checks</p>
      </td>
    </tr>
    <tr>
      <td style="padding: 20px 32px 0 32px; font-size: 14px; line-height: 1.5; color: #334155;">
        Dear Coordinator,<br><br>
        Below is each worker's task performance for <strong>${formatDateKey(dayKey)}</strong>: ${assigned} check${assigned === 1 ? '' : 's'} assigned in total.
        <div style="margin-top: 10px; font-size: 13px; color: #475569;">${attachmentNote}</div>
        ${
          missed.length
            ? `<div style="margin-top: 12px; padding: 10px 14px; background-color: #fef2f2; border-left: 4px solid #dc2626; border-radius: 4px; color: #991b1b;">
                 <strong>Missed checks:</strong> ${missed.map((r) => `${r.name} (${r.missed})`).join(', ')}. Please ask them for an explanation.
               </div>`
            : `<div style="margin-top: 12px; padding: 10px 14px; background-color: #f0fdf4; border-left: 4px solid #16a34a; border-radius: 4px; color: #166534;">No checks were missed.</div>`
        }
      </td>
    </tr>
    ${scoreSummaryHtml(rows, `TASK PERFORMANCE: ${formatDateKey(dayKey)}`)}
    <tr>
      <td style="padding: 20px 32px 24px 32px; font-size: 11px; color: #94a3b8;">Sent automatically every day by the Quality Monitoring System.</td>
    </tr>
  </table>
</body>
</html>`

  let status = 'SUCCESS'
  let errorMessage: string | null = null
  try {
    const smtp = { host: settings.smtpHost, port: settings.smtpPort, secure: settings.smtpSecure, user: settings.smtpUser, pass: settings.smtpPass, from: settings.smtpFrom }
    await createTransporter(smtp).sendMail({
      from: resolveSmtpConfig(smtp).from,
      to: settings.recipients.join(', '),
      subject,
      html,
      attachments: attachment ? [{ filename: `Quality_Inspection_Report_${attachment.reportId}.pdf`, content: attachment.pdf, contentType: 'application/pdf' }] : []
    })
    console.log(`[Daily task report] Sent the ${dayKey} report to ${settings.recipients.length} recipient(s).`)
  } catch (err) {
    // ponytail: no retry later the same day (it would resend every minute while the mail server is
    // down); the FAILED row in the email log shows it, and the next day's report goes out as usual.
    status = 'FAILED'
    errorMessage = err instanceof Error ? err.message : String(err)
    console.error('[Daily task report] Sending failed:', err)
  }
  await db.insert(reportEmailLogs).values({
    trigger: 'DAILY',
    status,
    recipients: settings.recipients,
    subject,
    // The checks in the attached Quality Inspection Report (none when nothing was attached).
    checkIds: attachment?.checkIds ?? [],
    checksCount: assigned,
    percentage: attachment ? settings.percentage : null,
    pdfSizeBytes: attachment?.pdf.length ?? null,
    periodFrom: day,
    periodTo: today,
    errorMessage,
    ...(by ? { sentById: by.id ?? null, sentByName: by.name ?? null } : {})
  })
  return { success: status === 'SUCCESS', error: errorMessage, subject, attached: attachment ? attachment.checks : 0 }
}
