import { Router } from 'express'
import { z } from 'zod'
import { requireModule } from '../lib/permissions'
import { badRequest, HttpError } from '../lib/http'
import { audit } from '../lib/audit'
import { dateKey } from '../lib/time'
import {
  MAX_REPORT_CHECKS,
  getReportEmailLogs,
  getReportSharingSettings,
  sampleEligibleChecks,
  updateReportSharingSettings,
  executeManualReportRun
} from '../services/automatedReports'
import { verifySmtpConnection } from '../services/reportEmailer'
import { resendDailyTaskReport } from '../services/dailyTaskReport'
import {
  getChecksForCrystalReport,
  renderCrystalReportPdf,
  type CrystalReportBatchData
} from '../services/crystalReportPdf'
import { db } from '../db/client'
import { settings } from '../db/schema'
import { eq } from 'drizzle-orm'

export const reportSharingRouter = Router()

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const updateSettingsSchema = z.object({
  isEnabled: z.boolean().optional(),
  frequencyHours: z.number().int().min(1).max(168).optional(),
  frequencyMinutes: z.number().int().min(10).max(10080).optional(),
  frequencyMode: z.enum(['INTERVAL', 'DAILY_AT', 'DAILY_REPORT']).optional(),
  scheduledTime: z.string().regex(/^\d{2}:\d{2}$/, 'Time must be in HH:MM format').nullable().optional(),
  percentage: z.number().int().min(1).max(100).optional(),
  recipients: z.array(z.string().regex(emailRegex, 'Invalid email address')).optional(),
  smtpHost: z.string().trim().max(255).nullable().optional(),
  smtpPort: z.number().int().min(1).max(65535).nullable().optional(),
  smtpSecure: z.boolean().optional(),
  smtpUser: z.string().trim().max(255).nullable().optional(),
  smtpPass: z.string().max(500).nullable().optional(),
  smtpFrom: z.string().trim().max(255).nullable().optional(),
  dailyReportTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Daily report time must be in HH:MM format').optional()
})

/** An instant with its timezone (what the admin panel sends), e.g. 2026-10-06T00:00:00+05:30. */
const instant = z.iso.datetime({ offset: true, message: 'Send the period as a date and time with its timezone' })

/** The longest period one report may cover. */
const MAX_PERIOD_DAYS = 366

/** The period of a preview or send, checked: valid, in order, and not longer than MAX_PERIOD_DAYS. */
function period(from: string, to: string) {
  const periodFrom = new Date(from)
  const periodTo = new Date(to)
  if (periodTo <= periodFrom) throw badRequest('"Period To" must be after "Period From".')
  if (periodTo.getTime() - periodFrom.getTime() > MAX_PERIOD_DAYS * 24 * 60 * 60_000) {
    throw badRequest(`Choose a period of at most ${MAX_PERIOD_DAYS} days.`)
  }
  return { periodFrom, periodTo }
}

const sendNowSchema = z.object({
  recipients: z.array(z.string().regex(emailRegex, 'Invalid email address')).min(1, 'At least one recipient is required').max(50),
  periodFrom: instant,
  periodTo: instant,
  percentage: z.number().int().min(1).max(100).default(20),
  customCheckIds: z.array(z.uuid()).max(MAX_REPORT_CHECKS).optional(),
  customSubject: z.string().trim().max(200).optional()
})

const samplePreviewSchema = z.object({
  periodFrom: instant,
  periodTo: instant,
  percentage: z.number().int().min(1).max(100).default(20)
})

/** The settings for the audit log, without the password. */
const auditView = (s: Record<string, unknown>) => ({ ...s, smtpPass: s.smtpPass ? '(set)' : null })

/** Fetch current automated email settings */
reportSharingRouter.get('/settings', requireModule('reports', 'view'), async (_req, res) => {
  const current = await getReportSharingSettings()
  // Mask password for safety in UI
  res.json({
    ...current,
    smtpPass: current.smtpPass ? '••••••••' : null
  })
})

/** Update automated email settings */
reportSharingRouter.put('/settings', requireModule('reports', 'manage'), async (req, res) => {
  const parsed = updateSettingsSchema.safeParse(req.body)
  if (!parsed.success) {
    throw badRequest(parsed.error.issues.map((i) => i.message).join(', '))
  }

  // If smtpPass is unchanged placeholder '••••••••', don't overwrite it
  const updateData = { ...parsed.data }
  if (updateData.smtpPass === '••••••••') {
    delete updateData.smtpPass
  }

  const before = await getReportSharingSettings()
  const updated = await updateReportSharingSettings(updateData)
  // Who changed the recipients, the schedule or the mail server, and when.
  await audit(req, 'UPDATE_REPORT_SHARING', 'ReportSharing', updated.id ?? null, {
    oldValue: auditView({ ...before }),
    newValue: auditView({ ...updated })
  })
  res.json({
    ...updated,
    smtpPass: updated.smtpPass ? '••••••••' : null
  })
})

/**
 * Test SMTP Connection. The stored password is only ever sent to the stored mail server with the
 * stored user: testing another server or user needs its password typed in, so the saved password
 * can never be sent to a server of the caller's choosing.
 */
reportSharingRouter.post('/test-smtp', requireModule('reports', 'manage'), async (req, res) => {
  const settings = await getReportSharingSettings()
  const custom = updateSettingsSchema.parse(req.body ?? {})
  const host = custom.smtpHost ?? settings.smtpHost
  const user = custom.smtpUser ?? settings.smtpUser
  const typed = custom.smtpPass && custom.smtpPass !== '••••••••' ? custom.smtpPass : null
  const sameServer = host === settings.smtpHost && user === settings.smtpUser
  if (!typed && !sameServer) throw badRequest('Enter the password for this mail server to test it.')

  const result = await verifySmtpConnection({
    host,
    port: custom.smtpPort ?? settings.smtpPort,
    secure: custom.smtpSecure ?? settings.smtpSecure,
    user,
    pass: typed ?? settings.smtpPass,
    from: custom.smtpFrom ?? settings.smtpFrom
  })
  await audit(req, 'TEST_SMTP', 'ReportSharing', null, { newValue: { host, user, ok: result.ok } })

  res.json(result)
})

/** Fetch email audit and delivery history */
reportSharingRouter.get('/logs', requireModule('reports', 'view'), async (req, res) => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50))
  const offset = Math.max(0, Number(req.query.offset) || 0)
  const logs = await getReportEmailLogs(limit, offset)
  res.json(logs)
})

/** Preview randomly sampled checks for a given period and percentage */
reportSharingRouter.post('/sample-preview', requireModule('reports', 'view'), async (req, res) => {
  const parsed = samplePreviewSchema.safeParse(req.body)
  if (!parsed.success) {
    throw badRequest(parsed.error.issues.map((i) => i.message).join(', '))
  }

  const { periodFrom, periodTo } = period(parsed.data.periodFrom, parsed.data.periodTo)

  const sampling = await sampleEligibleChecks({
    periodFrom,
    periodTo,
    percentage: parsed.data.percentage
  })

  res.json({
    periodFrom,
    periodTo,
    percentage: parsed.data.percentage,
    eligibleTotal: sampling.eligibleTotal,
    sampleCount: sampling.checks.length,
    sampledCheckIds: sampling.sampledCheckIds,
    checks: sampling.checks.map((c) => ({
      id: c.id,
      code: c.code,
      submittedAt: c.submittedAt,
      scheduledAt: c.scheduledAt,
      itemCode: c.itemCode,
      jobNo: c.jobNo,
      machineName: c.machineName,
      machineCode: c.machineCode,
      workerName: c.workerName,
      status: c.status,
      result: c.result,
      photoCount: c.photos.length,
      videoCount: c.videos.length,
      hasException: !!c.exception,
      outsideLimitsCount: c.values.filter((v) => v.result === 'FAIL').length
    }))
  })
})

/** Manually trigger immediate report generation and email dispatch */
reportSharingRouter.post('/send-now', requireModule('reports', 'manage'), async (req, res) => {
  const parsed = sendNowSchema.safeParse(req.body)
  if (!parsed.success) {
    throw badRequest(parsed.error.issues.map((i) => i.message).join(', '))
  }

  const { periodFrom, periodTo } = period(parsed.data.periodFrom, parsed.data.periodTo)

  const settings = await getReportSharingSettings()

  try {
    const result = await executeManualReportRun({
      recipients: parsed.data.recipients,
      periodFrom,
      periodTo,
      percentage: parsed.data.percentage,
      customCheckIds: parsed.data.customCheckIds,
      customSubject: parsed.data.customSubject,
      sentById: req.user?.id,
      sentByName: req.user?.name,
      smtpConfig: {
        host: settings.smtpHost,
        port: settings.smtpPort,
        secure: settings.smtpSecure,
        user: settings.smtpUser,
        pass: settings.smtpPass,
        from: settings.smtpFrom
      }
    })

    await audit(req, 'SEND_REPORT_EMAIL', 'ReportSharing', null, {
      newValue: { recipients: parsed.data.recipients, periodFrom, periodTo, checks: result.checksCount, ok: result.success }
    })
    if (!result.success) {
      throw badRequest(result.error || 'Failed to dispatch report email.')
    }

    res.json(result)
  } catch (err: unknown) {
    if (err instanceof HttpError) throw err
    const msg = err instanceof Error ? err.message : String(err)
    throw badRequest(msg)
  }
})

/**
 * Report Sharing → "Resend today's report": the previous day's Daily Task Report with its Quality
 * Inspection Report PDF, again, to the configured recipients (services/dailyTaskReport.ts). Same right
 * as Manual send. The daily schedule is not changed.
 */
reportSharingRouter.post('/daily-report/resend', requireModule('reports', 'manage'), async (req, res) => {
  const result = await resendDailyTaskReport({ id: req.user?.id, name: req.user?.name })
  await audit(req, 'RESEND_DAILY_TASK_REPORT', 'ReportSharing', null, { newValue: { subject: result.subject, ok: result.success } })
  if (!result.success) throw badRequest(result.error || 'The daily report could not be sent.')
  res.json(result)
})

/** Stream Crystal Reports PDF directly in browser. A PDF is an export: it needs Export Reports too. */
reportSharingRouter.get('/preview-pdf', requireModule('reports', 'view'), requireModule('export', 'view'), async (req, res) => {
  const checkIds = z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').filter(Boolean) : []))
    .pipe(z.array(z.uuid('Invalid check id')).max(MAX_REPORT_CHECKS, `At most ${MAX_REPORT_CHECKS} checks per report`))
    .parse(req.query.checkIds)

  if (!checkIds.length) {
    throw badRequest('Please provide at least one check ID to generate the report.')
  }

  const checks = await getChecksForCrystalReport(checkIds)
  if (!checks.length) {
    throw badRequest('No matching checks found for the requested IDs.')
  }

  const [row] = await db.select().from(settings).where(eq(settings.key, 'plant'))
  const val = (row?.value ?? {}) as { name?: string; code?: string }
  const companyName = val.name || 'Quality Monitoring System'
  const plantName = val.code || 'Plant 1'

  const now = new Date()
  const reportId = `QIR-PREVIEW-${dateKey(now).replace(/-/g, '')}-${String(Math.floor(1000 + Math.random() * 9000))}`

  const batchData: CrystalReportBatchData = {
    reportId,
    generatedAt: now,
    companyName,
    plantName,
    checks
  }

  const buffer = await renderCrystalReportPdf(batchData)

  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `inline; filename="Quality_Inspection_Report_${reportId}.pdf"`)
  res.setHeader('Content-Length', buffer.length)
  res.send(buffer)
})
