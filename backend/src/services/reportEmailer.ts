import fs from 'node:fs'
import path from 'node:path'
import nodemailer from 'nodemailer'
import type { Attachment } from 'nodemailer/lib/mailer'
import { config } from '../config'
import type { CrystalReportCheck } from './crystalReportPdf'
import { formatDate, formatDateTime } from './reportData'

export interface SmtpConfig {
  host?: string | null
  port?: number | null
  secure?: boolean | null
  user?: string | null
  pass?: string | null
  from?: string | null
}

export interface SendReportEmailOptions {
  recipients: string[]
  subject?: string
  reportId: string
  periodFrom?: Date
  periodTo?: Date
  samplePercentage?: number
  totalEligible?: number
  checks: CrystalReportCheck[]
  pdfBuffer: Buffer
  smtpConfig?: SmtpConfig
}

export interface SendEmailResult {
  success: boolean
  messageId?: string
  error?: string
  videoCount: number
  pdfSizeBytes: number
  recipientCount: number
}

/** Text from the database (worker-entered PO No., Item Code, names) made safe to put into the email HTML. */
const esc = (value: unknown) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

/** Resolves effective SMTP settings from DB settings or process.env */
export function resolveSmtpConfig(custom?: SmtpConfig): {
  host: string
  port: number
  secure: boolean
  user: string
  pass: string
  from: string
} {
  const host = custom?.host || process.env.SMTP_HOST || 'smtp.gmail.com'
  const port = custom?.port || Number(process.env.SMTP_PORT) || 587
  const secure = custom?.secure ?? (process.env.SMTP_SECURE === 'true' || port === 465)
  const user = custom?.user || process.env.SMTP_USER || ''
  const pass = custom?.pass || process.env.SMTP_PASS || ''
  const from = custom?.from || process.env.SMTP_FROM || user || 'Quality Monitoring <quality@company.com>'

  return { host, port, secure, user, pass, from }
}

/** Creates a nodemailer transporter */
export function createTransporter(custom?: SmtpConfig) {
  const resolved = resolveSmtpConfig(custom)
  if (!resolved.user || !resolved.pass) {
    throw new Error(
      'SMTP credentials are missing. Please configure SMTP User and Password in the Admin Email Settings or environment variables (SMTP_USER, SMTP_PASS).'
    )
  }

  return nodemailer.createTransport({
    host: resolved.host,
    port: resolved.port,
    secure: resolved.secure,
    auth: {
      user: resolved.user,
      pass: resolved.pass
    },
    // The server's certificate is checked, so the password cannot be read by a machine in between.
    // SMTP_ALLOW_SELF_SIGNED=1 accepts a company mail server's own certificate.
    tls: {
      rejectUnauthorized: process.env.SMTP_ALLOW_SELF_SIGNED !== '1'
    }
  })
}

/** Verifies SMTP connection */
export async function verifySmtpConnection(custom?: SmtpConfig): Promise<{ ok: boolean; message: string }> {
  try {
    const transporter = createTransporter(custom)
    await transporter.verify()
    return { ok: true, message: 'SMTP connection verified successfully.' }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, message: `SMTP verification failed: ${msg}` }
  }
}

/** Builds a professional business HTML email body */
function buildEmailHtml(opts: SendReportEmailOptions, videoCount: number): string {
  const { checks, samplePercentage, totalEligible, periodFrom, periodTo, reportId } = opts

  const totalPassed = checks.filter((c) => c.status === 'COMPLETED' && !c.values.some((v) => v.result === 'FAIL')).length
  const totalDeviations = checks.filter((c) => c.values.some((v) => v.result === 'FAIL')).length
  const totalExceptions = checks.filter((c) => c.status === 'EXCEPTION').length
  const passRate = checks.length ? Math.round((totalPassed / checks.length) * 100) : 100

  const periodText =
    periodFrom && periodTo
      ? `${formatDateTime(periodFrom)} to ${formatDateTime(periodTo)}`
      : `Generated on ${formatDateTime(new Date())}`

  const tableRows = checks
    .slice(0, 50)
    .map((c, i) => {
      const hasFail = c.values.some((v) => v.result === 'FAIL')
      const statusColor = hasFail ? '#dc2626' : c.status === 'EXCEPTION' ? '#d97706' : '#16a34a'
      const statusText = hasFail ? 'LIMIT DEFECT' : c.status === 'EXCEPTION' ? 'EXCEPTION' : 'CONFORMING'
      const bg = i % 2 === 1 ? '#f8fafc' : '#ffffff'

      return `
      <tr style="background-color: ${bg}; border-bottom: 1px solid #e2e8f0; font-size: 12px;">
        <td style="padding: 8px 10px; font-weight: 600; color: #1e293b;">${esc(c.code)}</td>
        <td style="padding: 8px 10px; color: #334155;">${c.submittedAt ? formatDateTime(c.submittedAt) : '—'}</td>
        <td style="padding: 8px 10px; font-weight: 600; color: #1e3a8a;">${esc(c.itemCode || '—')}</td>
        <td style="padding: 8px 10px; color: #334155;">${esc(c.jobNo || '—')}</td>
        <td style="padding: 8px 10px; color: #334155;">${esc(c.machineName)} (${esc(c.machineCode)})</td>
        <td style="padding: 8px 10px; color: #334155;">${esc(c.workerName)}</td>
        <td style="padding: 8px 10px; text-align: center;">
          <span style="display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 700; color: ${statusColor}; background: #f1f5f9;">
            ${statusText}
          </span>
        </td>
        <td style="padding: 8px 10px; text-align: center; color: #64748b;">
          ${c.photos.length}P${c.videos.length ? ` · <strong style="color: #2563eb;">${c.videos.length}V</strong>` : ''}
        </td>
      </tr>
    `
    })
    .join('')

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Quality Inspection Report</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; margin: 0; padding: 24px; background-color: #f1f5f9; color: #1e293b;">
  <table width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width: 780px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; overflow: hidden; border: 1px solid #cbd5e1; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05);">
    
    <!-- Corporate Header Banner -->
    <tr>
      <td style="background-color: #1e3a8a; padding: 24px 32px; color: #ffffff;">
        <table width="100%" border="0" cellspacing="0" cellpadding="0">
          <tr>
            <td>
              <h1 style="margin: 0; font-size: 20px; font-weight: 700; letter-spacing: 0.5px;">QUALITY INSPECTION REPORT</h1>
              <p style="margin: 4px 0 0 0; font-size: 13px; color: #93c5fd;">Automated Quality Verification & Compliance Record</p>
            </td>
            <td align="right" style="font-size: 12px; color: #bfdbfe;">
              <div><strong>Doc Ref:</strong> ${reportId}</div>
              <div><strong>Period:</strong> ${periodText}</div>
            </td>
          </tr>
        </table>
      </td>
    </tr>

    <!-- Summary Metrics Card -->
    <tr>
      <td style="padding: 24px 32px 16px 32px;">
        <p style="margin: 0 0 16px 0; font-size: 14px; line-height: 1.5; color: #334155;">
          Dear Team,<br><br>
          Please find attached the official <strong>Crystal Reports-format Quality Inspection Report (PDF)</strong> covering 
          <strong>${checks.length} randomly selected checks</strong> (${samplePercentage ?? 20}% random sample of ${totalEligible ?? checks.length} eligible checks) 
          for the specified inspection interval.
        </p>

        <!-- KPI Grid -->
        <table width="100%" border="0" cellspacing="8" cellpadding="0" style="margin-bottom: 20px;">
          <tr>
            <td width="25%" style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 12px; text-align: center;">
              <div style="font-size: 11px; font-weight: 600; color: #64748b; text-transform: uppercase;">Sampled Checks</div>
              <div style="font-size: 22px; font-weight: 700; color: #1e3a8a; margin: 4px 0;">${checks.length}</div>
              <div style="font-size: 11px; color: #64748b;">${samplePercentage ?? 20}% Sample Rate</div>
            </td>
            <td width="25%" style="background-color: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 6px; padding: 12px; text-align: center;">
              <div style="font-size: 11px; font-weight: 600; color: #166534; text-transform: uppercase;">Conforming</div>
              <div style="font-size: 22px; font-weight: 700; color: #16a34a; margin: 4px 0;">${totalPassed}</div>
              <div style="font-size: 11px; color: #166534;">${passRate}% Pass Rate</div>
            </td>
            <td width="25%" style="background-color: ${totalDeviations ? '#fef2f2' : '#f8fafc'}; border: 1px solid ${totalDeviations ? '#fecaca' : '#e2e8f0'}; border-radius: 6px; padding: 12px; text-align: center;">
              <div style="font-size: 11px; font-weight: 600; color: ${totalDeviations ? '#991b1b' : '#64748b'}; text-transform: uppercase;">Outside Limits</div>
              <div style="font-size: 22px; font-weight: 700; color: ${totalDeviations ? '#dc2626' : '#64748b'}; margin: 4px 0;">${totalDeviations}</div>
              <div style="font-size: 11px; color: ${totalDeviations ? '#991b1b' : '#64748b'};">${totalDeviations ? 'Action Needed' : 'Zero Defects'}</div>
            </td>
            <td width="25%" style="background-color: #eff6ff; border: 1px solid #bfdbfe; border-radius: 6px; padding: 12px; text-align: center;">
              <div style="font-size: 11px; font-weight: 600; color: #1e40af; text-transform: uppercase;">Video Recordings</div>
              <div style="font-size: 22px; font-weight: 700; color: #2563eb; margin: 4px 0;">${videoCount}</div>
              <div style="font-size: 11px; color: #1e40af;">Attached to Email</div>
            </td>
          </tr>
        </table>

        ${
          videoCount > 0
            ? `
          <div style="background-color: #eff6ff; border-left: 4px solid #2563eb; padding: 12px 16px; border-radius: 4px; margin-bottom: 20px; font-size: 13px; color: #1e3a8a;">
            <strong>📹 Video Attachments:</strong> ${videoCount} inspection video file(s) are attached directly to this email for full-resolution playback.
          </div>
        `
            : ''
        }

        <!-- Tabular Overview of Sampled Checks -->
        <h3 style="font-size: 14px; font-weight: 700; color: #1e3a8a; margin: 16px 0 8px 0;">INSPECTION BATCH OVERVIEW</h3>
        <table width="100%" border="0" cellspacing="0" cellpadding="0" style="border: 1px solid #cbd5e1; border-radius: 4px; overflow: hidden; border-collapse: collapse;">
          <thead>
            <tr style="background-color: #1e3a8a; color: #ffffff; font-size: 11px; font-weight: 700; text-align: left;">
              <th style="padding: 8px 10px;">Check ID</th>
              <th style="padding: 8px 10px;">Date / Time</th>
              <th style="padding: 8px 10px;">Item Code</th>
              <th style="padding: 8px 10px;">PO No.</th>
              <th style="padding: 8px 10px;">Machine</th>
              <th style="padding: 8px 10px;">Worker</th>
              <th style="padding: 8px 10px; text-align: center;">Status</th>
              <th style="padding: 8px 10px; text-align: center;">Media</th>
            </tr>
          </thead>
          <tbody>
            ${tableRows}
          </tbody>
        </table>

        ${
          checks.length > 50
            ? `<p style="font-size: 12px; color: #64748b; font-style: italic; margin-top: 8px;">(Displaying first 50 checks. Please see attached PDF for all ${checks.length} complete inspection sheets.)</p>`
            : ''
        }

      </td>
    </tr>

    <!-- Footer -->
    <tr>
      <td style="background-color: #f8fafc; border-top: 1px solid #e2e8f0; padding: 16px 32px; font-size: 11px; color: #64748b;">
        <table width="100%" border="0" cellspacing="0" cellpadding="0">
          <tr>
            <td>
              Quality Monitoring System &bull; Confidential Inspection Document<br>
              Generated on ${formatDateTime(new Date())}
            </td>
            <td align="right">
              &copy; ${new Date().getFullYear()} Quality Assurance Department
            </td>
          </tr>
        </table>
      </td>
    </tr>

  </table>
</body>
</html>
`
}

/** Dispatches the Quality Inspection Report with PDF and optional Video attachments */
export async function sendReportEmail(options: SendReportEmailOptions): Promise<SendEmailResult> {
  const { recipients, subject, reportId, pdfBuffer, checks, smtpConfig } = options

  if (!recipients.length) {
    return {
      success: false,
      error: 'No email recipients specified.',
      videoCount: 0,
      pdfSizeBytes: pdfBuffer.length,
      recipientCount: 0
    }
  }

  try {
    const transporter = createTransporter(smtpConfig)
    const resolved = resolveSmtpConfig(smtpConfig)

    const attachments: Attachment[] = [
      {
        filename: `Quality_Inspection_Report_${reportId}.pdf`,
        content: pdfBuffer,
        contentType: 'application/pdf'
      }
    ]

    // Attach video recordings if any exist on disk
    let videoCount = 0
    let totalVideoBytes = 0
    const MAX_TOTAL_ATTACHMENT_BYTES = 45 * 1024 * 1024 // 45 MB total attachment limit for safety

    for (const check of checks) {
      for (const vid of check.videos) {
        try {
          const fullPath = path.isAbsolute(vid.path) ? vid.path : path.resolve(config.uploadDir, vid.path)
          if (fs.existsSync(fullPath)) {
            const stat = fs.statSync(fullPath)
            if (totalVideoBytes + stat.size < MAX_TOTAL_ATTACHMENT_BYTES) {
              attachments.push({
                filename: `${check.code}_${path.basename(vid.path)}`,
                path: fullPath,
                contentType: vid.mimeType || 'video/mp4'
              })
              totalVideoBytes += stat.size
              videoCount++
            } else {
              console.warn(`Video attachment ${vid.path} skipped: exceeds email attachment size limit.`)
            }
          }
        } catch (vidErr) {
          console.error(`Error attaching video ${vid.path}:`, vidErr)
        }
      }
    }

    const emailSubject =
      subject ||
      `Quality Inspection Report - ${checks.length} Check${checks.length === 1 ? '' : 's'} (${options.samplePercentage ?? 20}% Sample) - ${formatDate(new Date())}`

    const html = buildEmailHtml(options, videoCount)

    const info = await transporter.sendMail({
      from: resolved.from,
      to: recipients.join(', '),
      subject: emailSubject,
      html,
      attachments
    })

    return {
      success: true,
      messageId: info.messageId,
      videoCount,
      pdfSizeBytes: pdfBuffer.length,
      recipientCount: recipients.length
    }
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    console.error('Failed to send report email:', err)
    return {
      success: false,
      error: errorMsg,
      videoCount: 0,
      pdfSizeBytes: pdfBuffer.length,
      recipientCount: recipients.length
    }
  }
}
