import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pdfmake from 'pdfmake'
import sharp from 'sharp'
import type { Content, ContentTable, TDocumentDefinitions, TableCell } from 'pdfmake/interfaces'
import { asc, desc, eq, inArray } from 'drizzle-orm'
import { db } from '../db/client'
import { activities, checkExceptions, departments, jobs, machines, media, qualityCheckValues, qualityChecks, shifts, users } from '../db/schema'
import { config } from '../config'
import { formatDateTime, formatDate, formatTime } from './reportData'
import { resultOf } from '../lib/result'
import { weeklyScores, type DayScore } from './performance'
import { formatDateKey } from '../lib/time'

/*
 * The Quality Inspection Report (PDF): one sheet per check, with a batch summary in front when the
 * report holds several checks. Used by the report preview, the report e-mails and the automated
 * reports. Presentation only: every value comes from the check as it was recorded.
 *
 * Photos are read from upload storage and re-encoded as JPEG before they go into the PDF (the PDF
 * library only understands JPEG and PNG; phones also send WebP and HEIC), turned upright and sized
 * down to what the page needs, so the report stays small enough to e-mail.
 */

pdfmake.addFonts({
  Helvetica: {
    normal: 'Helvetica',
    bold: 'Helvetica-Bold',
    italics: 'Helvetica-Oblique',
    bolditalics: 'Helvetica-BoldOblique'
  }
})
// Photos and the logo are embedded as data, so the PDF library never needs to open a file or URL;
// only the built-in PDF fonts above are looked up by name.
const BUILT_IN_FONTS = new Set(['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique'])
pdfmake.setUrlAccessPolicy(() => false)
pdfmake.setLocalAccessPolicy((file) => BUILT_IN_FONTS.has(file))

// A4 portrait
const PAGE_MARGIN_X = 40
const CONTENT_WIDTH = 595.28 - 2 * PAGE_MARGIN_X

// Print-friendly greys with the brand colour (the app's accent) for rules and section titles.
const C = {
  ink: '#111827',
  text: '#1F2937',
  muted: '#6B7280',
  faint: '#9CA3AF',
  line: '#D1D5DB',
  hair: '#E5E7EB',
  headBg: '#F3F4F6',
  band: '#F9FAFB',
  brand: '#7F3D40',
  pass: '#15803D',
  passBg: '#DCFCE7',
  fail: '#B91C1C',
  failBg: '#FEF2F2',
  warn: '#B45309',
  warnBg: '#FFFBEB',
  warnLine: '#F59E0B'
}

/** Longest side of a photo in the PDF: sharp at the printed size, small enough to e-mail. */
const PHOTO_MAX_PIXELS = 1200
const PHOTO_GAP = 12
const PHOTO_CELL_WIDTH = (CONTENT_WIDTH - PHOTO_GAP) / 2
const PHOTO_MAX_HEIGHT = 190

export interface CrystalReportPhoto {
  id: string
  parameterId: string | null
  path: string
  mimeType: string
  capturedAt: Date | null
  sizeBytes: number
}

export interface CrystalReportCheck {
  id: string
  code: string
  scheduledAt: Date
  submittedAt: Date | null
  status: string
  result: string | null
  itemCode: string | null
  jobNo: string | null
  submissionType: string | null
  kind: string | null
  machineName: string
  machineCode: string
  workerName: string
  workerEmployeeId: string | null
  shiftName: string
  activityName: string
  departmentName: string
  module: string
  values: {
    parameterId: string | null
    parameterName: string
    parameterType: string
    unit: string | null
    rule: unknown
    value: string | null
    result: string | null
    notApplicable: boolean
    naReason: string | null
    naRemark: string | null
  }[]
  /** Photos of the check itself (per parameter, or for the whole check). */
  photos: CrystalReportPhoto[]
  videos: {
    id: string
    path: string
    mimeType: string
    durationSeconds: number | null
    sizeBytes: number
    capturedAt: Date | null
  }[]
  exception: {
    id: string
    reason: string
    remark: string | null
    status: string
    createdAt: Date
    /** Photos taken with the exception (stored against the exception, not the check). */
    photos?: CrystalReportPhoto[]
  } | null
}

export interface CrystalReportBatchData {
  reportId: string
  generatedAt: Date
  companyName: string
  plantName: string
  periodFrom?: Date
  periodTo?: Date
  samplePercentage?: number
  totalEligible?: number
  checks: CrystalReportCheck[]
  /** Day-wise scores of every worker for the report's week (services/performance.ts weeklyScores). */
  weekly?: WeeklyReport | null
}

type WeeklyReport = Awaited<ReturnType<typeof weeklyScores>>

const photoOf = (m: typeof media.$inferSelect): CrystalReportPhoto => ({
  id: m.id,
  parameterId: m.parameterId,
  path: m.path,
  mimeType: m.mimeType,
  capturedAt: m.capturedAt,
  sizeBytes: m.sizeBytes
})

/** Fetches full structured check details for the report. */
export async function getChecksForCrystalReport(checkIds: string[]): Promise<CrystalReportCheck[]> {
  if (!checkIds.length) return []

  const rows = await db
    .select({
      check: qualityChecks,
      machineName: machines.name,
      machineCode: machines.code,
      departmentName: departments.name,
      activityName: activities.name,
      workerName: users.name,
      workerEmployeeId: users.employeeId,
      shiftName: shifts.name,
      jobItemCode: jobs.itemCode,
      jobJobNo: jobs.jobNo
    })
    .from(qualityChecks)
    .leftJoin(machines, eq(qualityChecks.machineId, machines.id))
    .leftJoin(departments, eq(qualityChecks.departmentId, departments.id))
    .innerJoin(activities, eq(qualityChecks.activityId, activities.id))
    .leftJoin(users, eq(qualityChecks.workerId, users.id))
    .leftJoin(shifts, eq(qualityChecks.shiftId, shifts.id))
    .leftJoin(jobs, eq(qualityChecks.jobId, jobs.id))
    .where(inArray(qualityChecks.id, checkIds))
    .orderBy(desc(qualityChecks.scheduledAt))

  const ids = rows.map((r) => r.check.id)
  const [valuesRows, mediaRows, exceptionRows] = ids.length
    ? await Promise.all([
        db.select().from(qualityCheckValues).where(inArray(qualityCheckValues.checkId, ids)).orderBy(asc(qualityCheckValues.sortOrder)),
        db.select().from(media).where(inArray(media.checkId, ids)).orderBy(asc(media.createdAt)),
        db.select().from(checkExceptions).where(inArray(checkExceptions.checkId, ids))
      ])
    : [[], [], []]
  // Exception photos are stored against the exception (check_id is empty), so they are read by it.
  const exceptionMedia = exceptionRows.length
    ? await db
        .select()
        .from(media)
        .where(
          inArray(
            media.exceptionId,
            exceptionRows.map((e) => e.id)
          )
        )
        .orderBy(asc(media.createdAt))
    : []

  return rows.map((r) => {
    const checkValues = valuesRows.filter((v) => v.checkId === r.check.id)
    const checkMedia = mediaRows.filter((m) => m.checkId === r.check.id && !m.exceptionId)
    const exc = exceptionRows.find((e) => e.checkId === r.check.id)

    const photos = checkMedia.filter((m) => m.kind === 'PHOTO').map(photoOf)

    const videos = checkMedia
      .filter((m) => m.kind === 'VIDEO')
      .map((m) => ({
        id: m.id,
        path: m.path,
        mimeType: m.mimeType,
        durationSeconds: m.durationSeconds,
        sizeBytes: m.sizeBytes,
        capturedAt: m.capturedAt
      }))

    return {
      id: r.check.id,
      code: r.check.code,
      scheduledAt: r.check.scheduledAt,
      submittedAt: r.check.submittedAt,
      status: r.check.status,
      result: resultOf(r.check.status),
      itemCode: r.check.itemCode || r.jobItemCode || null,
      jobNo: r.check.jobNo || r.jobJobNo || null,
      submissionType: r.check.submissionType,
      kind: r.check.kind,
      machineName: r.machineName ?? '—',
      machineCode: r.machineCode ?? '—',
      workerName: r.workerName ?? '—',
      workerEmployeeId: r.workerEmployeeId,
      shiftName: r.shiftName ?? '—',
      activityName: r.activityName ?? '—',
      departmentName: r.departmentName ?? '—',
      module: r.check.module ?? 'IPQC',
      values: checkValues.map((v) => ({
        parameterId: v.parameterId,
        parameterName: v.parameterName,
        parameterType: v.parameterType,
        unit: v.unit,
        rule: v.rule,
        value: v.value,
        result: v.result,
        notApplicable: v.notApplicable,
        naReason: v.naReason,
        naRemark: v.naRemark
      })),
      photos,
      videos,
      exception: exc
        ? {
            id: exc.id,
            reason: exc.reason,
            remark: exc.remark,
            status: exc.status,
            createdAt: exc.createdAt,
            photos: exceptionMedia.filter((m) => m.exceptionId === exc.id && m.kind === 'PHOTO').map(photoOf)
          }
        : null
    }
  })
}

// ------------------------------------------------------------------------------------- photos

type PreparedPhoto =
  | { status: 'ok'; dataUri: string; width: number; height: number }
  /** The file is not in upload storage any more. */
  | { status: 'missing' }
  /** The file is there but is not an image this server can read (e.g. HEIC without HEIF support). */
  | { status: 'unreadable' }

export type ReportPhotos = Map<string, PreparedPhoto>

/** Reads one stored photo and returns it as an upright JPEG sized for the page. */
async function preparePhoto(relPath: string): Promise<PreparedPhoto> {
  const root = path.resolve(config.uploadDir)
  const full = path.resolve(root, relPath)
  // Only files inside upload storage.
  if (!full.startsWith(root + path.sep)) return { status: 'unreadable' }
  if (!fs.existsSync(full)) return { status: 'missing' }
  try {
    const { data, info } = await sharp(full, { failOn: 'none' })
      .rotate() // EXIF orientation, so phone photos are not sideways
      .resize({ width: PHOTO_MAX_PIXELS, height: PHOTO_MAX_PIXELS, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#FFFFFF' }) // transparent PNG/WebP on white, not black
      .jpeg({ quality: 80, mozjpeg: true })
      .toBuffer({ resolveWithObject: true })
    return { status: 'ok', dataUri: `data:image/jpeg;base64,${data.toString('base64')}`, width: info.width, height: info.height }
  } catch (err) {
    console.warn(`Report: photo ${relPath} could not be read: ${(err as Error).message}`)
    return { status: 'unreadable' }
  }
}

/** Prepares every photo of these checks (a few at a time, to keep memory in check). */
export async function prepareReportPhotos(checks: CrystalReportCheck[]): Promise<ReportPhotos> {
  const all = checks.flatMap((c) => [...c.photos, ...(c.exception?.photos ?? [])])
  const result: ReportPhotos = new Map()
  let next = 0
  const worker = async () => {
    while (next < all.length) {
      const photo = all[next++]
      result.set(photo.id, await preparePhoto(photo.path))
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, all.length) }, worker))
  return result
}

let logoCache: string | null | undefined
/** The app logo (backend/assets/report-logo.png), or null when it is not there. */
function logoDataUri(): string | null {
  if (logoCache !== undefined) return logoCache
  try {
    const file = fileURLToPath(new URL('../../assets/report-logo.png', import.meta.url))
    logoCache = `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`
  } catch {
    logoCache = null
  }
  return logoCache
}

// ------------------------------------------------------------------------------------- helpers

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDuration(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds)) return null
  const s = Math.round(seconds)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** "UNDER_REVIEW" -> "Under review" */
const humanize = (value: string) => value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, ' ')

/** The acceptance rule as recorded with the reading (a text snapshot, e.g. "18 – 22 sec"). */
function specificationText(rule: unknown): string {
  if (typeof rule === 'string' && rule.trim()) return rule.trim()
  return '—'
}

/** How a check's status is shown: colour and words. */
function statusStyle(status: string) {
  switch (status) {
    case 'COMPLETED':
      return { label: 'Completed', color: C.pass, bg: C.passBg }
    case 'EXCEPTION':
      return { label: 'Exception', color: C.warn, bg: C.warnBg }
    case 'MISSED':
      return { label: 'Missed', color: C.fail, bg: C.failBg }
    default:
      return { label: humanize(status), color: C.muted, bg: C.headBg }
  }
}

/** A reading's result in the app's words: PASS / FAIL against limits, RECORDED when there are none. */
function readingResult(v: CrystalReportCheck['values'][number]) {
  if (v.notApplicable) return { text: 'N/A', color: C.muted }
  if (v.value === null || v.value === '') return { text: '—', color: C.faint }
  if (v.result === 'PASS') return { text: 'PASS', color: C.pass }
  if (v.result === 'FAIL') return { text: 'FAIL', color: C.fail }
  return { text: 'RECORDED', color: C.muted }
}

const sectionTitle = (text: string, margin: [number, number, number, number] = [0, 16, 0, 6]): Content => ({
  text: text.toUpperCase(),
  fontSize: 8,
  bold: true,
  color: C.brand,
  characterSpacing: 0.6,
  margin,
  // Kept with what follows (see pageBreakBefore).
  headlineLevel: 1
})

const hairlineLayout = {
  hLineWidth: (i: number, node: ContentTable) => (i === 0 || i === node.table.body.length ? 0.8 : 0.5),
  vLineWidth: () => 0,
  hLineColor: (i: number, node: ContentTable) => (i === 0 || i === node.table.body.length ? C.line : C.hair),
  paddingLeft: (i: number) => (i === 0 ? 0 : 6),
  paddingRight: () => 6,
  paddingTop: () => 4,
  paddingBottom: () => 4
}

/** Label / value pairs, two per row. */
function detailsGrid(pairs: [string, string][]): Content {
  const body: TableCell[][] = []
  for (let i = 0; i < pairs.length; i += 2) {
    const row: TableCell[] = []
    for (const pair of [pairs[i], pairs[i + 1]]) {
      row.push(
        pair ? { text: pair[0], fontSize: 7.5, color: C.muted } : { text: '' },
        pair ? { text: pair[1] || '—', fontSize: 8.5, color: pair[1] ? C.ink : C.faint, bold: !!pair[1] && i === 0 } : { text: '' }
      )
    }
    body.push(row)
  }
  return { table: { widths: [78, '*', 78, '*'], body }, layout: hairlineLayout }
}

/** The title block at the top of a sheet (and of the batch summary). */
function titleBlock(data: CrystalReportBatchData, subtitle: string, right: Content, rightWidth: number | 'auto' = 'auto'): Content {
  const logo = logoDataUri()
  return {
    stack: [
      {
        columns: [
          ...(logo ? [{ width: 46, stack: [{ image: logo, width: 36, height: 36, margin: [0, 1, 0, 0] as [number, number, number, number] }] }] : []),
          {
            width: '*',
            stack: [
              { text: data.companyName.toUpperCase(), fontSize: 7.5, bold: true, color: C.muted, characterSpacing: 0.8 },
              { text: 'Quality Inspection Report', fontSize: 18, bold: true, color: C.ink, margin: [0, 1, 0, 0] },
              { text: subtitle, fontSize: 9, color: C.muted, margin: [0, 2, 0, 0] }
            ]
          },
          { width: rightWidth, stack: [right] }
        ]
      },
      { canvas: [{ type: 'line', x1: 0, y1: 8, x2: CONTENT_WIDTH, y2: 8, lineWidth: 1.5, lineColor: C.brand }], margin: [0, 0, 0, 4] }
    ]
  }
}

/** A coloured status label. */
function statusPill(label: string, color: string, bg: string): Content {
  return {
    table: { body: [[{ text: label.toUpperCase(), fontSize: 8, bold: true, color, characterSpacing: 0.5 }]] },
    layout: { hLineWidth: () => 0, vLineWidth: () => 0, fillColor: () => bg, paddingLeft: () => 8, paddingRight: () => 8, paddingTop: () => 3, paddingBottom: () => 3 },
    alignment: 'right'
  }
}

/** Small figures in a row, e.g. readings / pass / fail. */
function figureStrip(items: { label: string; value: string; color?: string }[]): Content {
  return {
    table: {
      widths: items.map(() => '*'),
      body: [
        items.map((it) => ({
          stack: [
            { text: it.value, fontSize: 13, bold: true, color: it.color ?? C.ink },
            { text: it.label.toUpperCase(), fontSize: 6.5, bold: true, color: C.muted, characterSpacing: 0.4, margin: [0, 1, 0, 0] }
          ]
        }))
      ]
    },
    layout: {
      hLineWidth: () => 0,
      vLineWidth: (i: number, node: ContentTable) => (i === 0 || i === (node.table.widths?.length ?? 0) ? 0 : 0.5),
      vLineColor: () => C.hair,
      fillColor: () => C.band,
      paddingLeft: () => 10,
      paddingRight: () => 10,
      paddingTop: () => 6,
      paddingBottom: () => 6
    }
  }
}

interface NumberedPhoto {
  photo: CrystalReportPhoto
  number: number
  /** What the photo belongs to, e.g. "3. Label" or "Whole check". */
  caption: string
}

/**
 * Photos two per row, each scaled to fit its box with its own proportions. A row never splits over
 * two pages; photos that cannot be shown are listed underneath instead of leaving an empty frame.
 */
function photoGrid(list: NumberedPhoto[], prepared: ReportPhotos, title?: Content): Content[] {
  const shown = list.filter((p) => prepared.get(p.photo.id)?.status === 'ok')
  const notShown = list.filter((p) => prepared.get(p.photo.id)?.status !== 'ok')
  const cell = (p: NumberedPhoto): Content => {
    const img = prepared.get(p.photo.id) as Extract<PreparedPhoto, { status: 'ok' }>
    const scale = Math.min((PHOTO_CELL_WIDTH - 2) / img.width, PHOTO_MAX_HEIGHT / img.height, 1)
    return {
      width: PHOTO_CELL_WIDTH,
      stack: [
        {
          table: {
            widths: [PHOTO_CELL_WIDTH - 2],
            body: [[{ image: img.dataUri, width: img.width * scale, height: img.height * scale, alignment: 'center' }]]
          },
          layout: {
            hLineWidth: () => 0.5,
            vLineWidth: () => 0.5,
            hLineColor: () => C.hair,
            vLineColor: () => C.hair,
            fillColor: () => C.band,
            paddingLeft: () => 0,
            paddingRight: () => 0,
            // Centred in a frame of the same height for every photo.
            paddingTop: () => Math.max(0, (PHOTO_MAX_HEIGHT - img.height * scale) / 2),
            paddingBottom: () => Math.max(0, (PHOTO_MAX_HEIGHT - img.height * scale) / 2)
          }
        },
        {
          text: [
            { text: `Photo ${p.number}`, bold: true, color: C.brand },
            { text: `  ·  ${p.caption}`, bold: true, color: C.ink }
          ],
          fontSize: 7.5,
          margin: [0, 4, 0, 0]
        },
        ...(p.photo.capturedAt ? [{ text: `Captured ${formatDateTime(p.photo.capturedAt)}`, fontSize: 7, color: C.muted, margin: [0, 1, 0, 0] as [number, number, number, number] }] : [])
      ]
    } as Content
  }
  const rows: Content[] = []
  for (let i = 0; i < shown.length; i += 2) {
    const row: Content = {
      columns: [cell(shown[i]), shown[i + 1] ? cell(shown[i + 1]) : { width: PHOTO_CELL_WIDTH, text: '' }],
      columnGap: PHOTO_GAP,
      margin: [0, 0, 0, 10]
    }
    // The title stays with the first row of photos.
    rows.push(i === 0 && title ? { stack: [title, row], unbreakable: true } : { stack: [row], unbreakable: true })
  }
  // A photo that cannot be shown keeps its number and reading, with the reason; it is never just dropped.
  const unavailable: Content[] = notShown.map((p) => ({
    table: {
      widths: ['*'],
      body: [
        [
          {
            stack: [
              {
                text: [
                  { text: 'Image unavailable', bold: true, color: C.fail },
                  { text: `  ·  Photo ${p.number}  ·  ${p.caption}`, bold: true, color: C.ink }
                ],
                fontSize: 8
              },
              {
                text: `${prepared.get(p.photo.id)?.status === 'missing' ? 'The photo file is no longer on the server.' : 'The photo file could not be read as an image.'} File: ${path.basename(p.photo.path)}${p.photo.capturedAt ? `  ·  captured ${formatDateTime(p.photo.capturedAt)}` : ''}`,
                fontSize: 7,
                color: C.muted,
                margin: [0, 2, 0, 0]
              }
            ]
          }
        ]
      ]
    },
    layout: {
      hLineWidth: () => 0.5,
      vLineWidth: () => 0.5,
      hLineColor: () => C.line,
      vLineColor: () => C.line,
      fillColor: () => C.band,
      paddingLeft: () => 8,
      paddingRight: () => 8,
      paddingTop: () => 5,
      paddingBottom: () => 5
    },
    margin: [0, 0, 0, 6],
    unbreakable: true
  }))
  if (!shown.length && unavailable.length && title) {
    // The section title stays with the first note.
    rows.push({ stack: [title, unavailable[0]], unbreakable: true }, ...unavailable.slice(1))
  } else {
    if (!shown.length && title) rows.push(title)
    rows.push(...unavailable)
  }
  return rows
}

// ------------------------------------------------------------------------------------- one check

function buildCheckSheet(check: CrystalReportCheck, data: CrystalReportBatchData, prepared: ReportPhotos): Content[] {
  const content: Content[] = []
  const status = statusStyle(check.status)

  // Photos are numbered in the order they appear: per parameter (table order), then the whole check.
  const paramIndex = new Map(check.values.map((v, i) => [v.parameterId, i]))
  const byParam = new Map<number, CrystalReportPhoto[]>()
  const general: CrystalReportPhoto[] = []
  const seen = new Set<string>()
  for (const p of check.photos) {
    if (seen.has(p.id)) continue // each stored photo once
    seen.add(p.id)
    const idx = p.parameterId ? paramIndex.get(p.parameterId) : undefined
    if (idx === undefined) general.push(p)
    else byParam.set(idx, [...(byParam.get(idx) ?? []), p])
  }
  let counter = 0
  const groups = [...byParam.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([idx, list]) => ({
      idx,
      photos: list.map((photo): NumberedPhoto => ({ photo, number: ++counter, caption: `${idx + 1}. ${check.values[idx].parameterName}` }))
    }))
  const checkPhotos = [...groups.flatMap((g) => g.photos), ...general.map((photo): NumberedPhoto => ({ photo, number: ++counter, caption: 'Whole check' }))]
  const checkPhotoIds = new Set(check.photos.map((p) => p.id))
  const exceptionPhotos = (check.exception?.photos ?? [])
    .filter((p) => !checkPhotoIds.has(p.id))
    .map((photo): NumberedPhoto => ({ photo, number: ++counter, caption: 'Exception' }))
  const photoNumbersOf = new Map(groups.map((g) => [g.idx, g.photos.map((p) => p.number)]))

  // Title
  content.push(
    titleBlock(data, `${check.module} inspection  ·  ${check.activityName}`, {
      stack: [
        statusPill(status.label, status.color, status.bg),
        { text: check.code, fontSize: 9.5, bold: true, color: C.ink, alignment: 'right', margin: [0, 5, 0, 0] },
        { text: formatDateTime(check.submittedAt ?? check.scheduledAt), fontSize: 8, color: C.muted, alignment: 'right', margin: [0, 1, 0, 0] }
      ]
    })
  )

  // Details
  content.push(sectionTitle('Inspection details', [0, 12, 0, 4]))
  content.push(
    detailsGrid([
      ['Check ID', check.code],
      ['Item code', check.itemCode ?? ''],
      ['Job / PO no.', check.jobNo ?? ''],
      ['Machine', check.machineName === '—' ? '' : `${check.machineName}${check.machineCode && check.machineCode !== '—' ? ` (${check.machineCode})` : ''}`],
      ['Department', check.departmentName === '—' ? '' : check.departmentName],
      ['Shift', check.shiftName === '—' ? '' : check.shiftName],
      ['Worker', check.workerName === '—' ? '' : `${check.workerName}${check.workerEmployeeId ? ` (${check.workerEmployeeId})` : ''}`],
      ['Inspection type', check.activityName],
      ['Scheduled for', formatDateTime(check.scheduledAt)],
      ['Submitted', check.submittedAt ? formatDateTime(check.submittedAt) : 'Not submitted'],
      ['Started from', check.submissionType === 'NOTIFICATION' ? 'Scheduled alert' : check.submissionType === 'MANUAL' ? 'Started by the worker' : ''],
      ['Status', status.label]
    ])
  )

  // Summary figures
  const failCount = check.values.filter((v) => !v.notApplicable && v.result === 'FAIL').length
  const passCount = check.values.filter((v) => !v.notApplicable && v.result === 'PASS' && v.value).length
  const naCount = check.values.filter((v) => v.notApplicable).length
  const photoCount = check.photos.length + (check.exception?.photos?.length ?? 0)
  if (check.values.length) {
    content.push({
      margin: [0, 10, 0, 0],
      ...(figureStrip([
        { label: 'Readings', value: String(check.values.length) },
        { label: 'Pass', value: String(passCount), color: passCount ? C.pass : C.ink },
        { label: 'Fail', value: String(failCount), color: failCount ? C.fail : C.ink },
        { label: 'Not applicable', value: String(naCount) },
        { label: 'Photos', value: String(photoCount) }
      ]) as object)
    } as Content)
  }

  // Readings
  content.push(sectionTitle('Readings'))
  if (check.values.length) {
    const header: TableCell[] = ['#', 'Parameter', 'Specification', 'Reading', 'Result'].map((t, i) => ({
      text: t.toUpperCase(),
      fontSize: 7,
      bold: true,
      color: C.muted,
      characterSpacing: 0.4,
      alignment: i === 0 || i === 4 ? 'center' : 'left'
    }))
    const rows: TableCell[][] = check.values.map((v, idx) => {
      const res = readingResult(v)
      const fill = v.result === 'FAIL' && !v.notApplicable ? C.failBg : undefined
      const photos = photoNumbersOf.get(idx)
      const reading = v.notApplicable ? 'Not applicable' : v.value ? `${v.value}${v.unit ? ` ${v.unit}` : ''}` : '—'
      return [
        { text: String(idx + 1), fontSize: 8, color: C.muted, alignment: 'center', fillColor: fill },
        {
          stack: [
            { text: v.parameterName, fontSize: 8.5, bold: true, color: C.ink },
            ...(v.notApplicable && (v.naReason || v.naRemark)
              ? [{ text: [v.naReason, v.naRemark].filter(Boolean).join(' — '), fontSize: 7, italics: true, color: C.muted, margin: [0, 1, 0, 0] as [number, number, number, number] }]
              : []),
            ...(photos?.length
              ? [{ text: `Photo ${photos.join(', ')}`, fontSize: 7, color: C.brand, margin: [0, 1, 0, 0] as [number, number, number, number] }]
              : [])
          ],
          fillColor: fill
        },
        { text: specificationText(v.rule), fontSize: 8, color: C.text, fillColor: fill },
        { text: reading, fontSize: 8.5, bold: !v.notApplicable && !!v.value, color: v.notApplicable || !v.value ? C.muted : res.color === C.fail ? C.fail : C.ink, fillColor: fill },
        { text: res.text, fontSize: 7.5, bold: true, color: res.color, alignment: 'center', fillColor: fill }
      ]
    })
    content.push({
      table: { headerRows: 1, dontBreakRows: true, widths: [18, '*', 130, 110, 56], body: [header, ...rows] },
      layout: {
        hLineWidth: (i: number, node: ContentTable) => (i === 0 || i === 1 || i === node.table.body.length ? 0.8 : 0.5),
        vLineWidth: () => 0,
        hLineColor: (i: number, node: ContentTable) => (i === 0 || i === 1 || i === node.table.body.length ? C.line : C.hair),
        fillColor: (i: number) => (i === 0 ? C.headBg : null),
        paddingLeft: () => 6,
        paddingRight: () => 6,
        paddingTop: () => 4.5,
        paddingBottom: () => 4.5
      }
    })
  } else {
    content.push({ text: 'No readings were recorded for this check.', fontSize: 8.5, italics: true, color: C.muted })
  }

  // Evidence photos, two per row in reading order; each caption names the reading it belongs to.
  if (checkPhotos.length) {
    content.push(...photoGrid(checkPhotos, prepared, sectionTitle(`Evidence photos (${checkPhotos.length})`)))
  }

  // Exception (only when there is one)
  if (check.exception) {
    const exc = check.exception
    const box: Content = {
      table: {
        widths: ['*'],
        body: [
          [
            {
              stack: [
                {
                  columns: [
                    { text: exc.reason, fontSize: 9.5, bold: true, color: C.ink },
                    { width: 'auto', text: humanize(exc.status), fontSize: 8, bold: true, color: C.warn }
                  ]
                },
                ...(exc.remark ? [{ text: exc.remark, fontSize: 8.5, color: C.text, margin: [0, 3, 0, 0] as [number, number, number, number] }] : []),
                { text: `Reported ${formatDateTime(exc.createdAt)}`, fontSize: 7.5, color: C.muted, margin: [0, 4, 0, 0] }
              ]
            }
          ]
        ]
      },
      layout: {
        hLineWidth: () => 0,
        vLineWidth: (i: number) => (i === 0 ? 2.5 : 0),
        vLineColor: () => C.warnLine,
        fillColor: () => C.warnBg,
        paddingLeft: () => 10,
        paddingRight: () => 10,
        paddingTop: () => 7,
        paddingBottom: () => 7
      },
      margin: [0, 0, 0, exceptionPhotos.length ? 10 : 0]
    }
    content.push({ stack: [sectionTitle('Exception'), box], unbreakable: true })
    if (exceptionPhotos.length) content.push(...photoGrid(exceptionPhotos, prepared))
  }

  // Videos (listed: a PDF cannot play them)
  if (check.videos.length) {
    content.push({
      unbreakable: true,
      stack: [
        sectionTitle(`Videos (${check.videos.length})`),
        ...check.videos.map((v, i) => ({
          text: [
            { text: `Video ${i + 1}`, bold: true, color: C.ink },
            {
              text: [formatDuration(v.durationSeconds), formatFileSize(v.sizeBytes), v.capturedAt ? formatDateTime(v.capturedAt) : null]
                .filter(Boolean)
                .map((s) => `  ·  ${s}`)
                .join(''),
              color: C.muted
            }
          ],
          fontSize: 8,
          margin: [0, 0, 0, 2] as [number, number, number, number]
        })),
        { text: 'Videos are not part of the PDF. They are kept with the check in the Quality Monitoring app.', fontSize: 7, italics: true, color: C.muted, margin: [0, 3, 0, 0] }
      ]
    })
  }

  return content
}

// ------------------------------------------------------------------------------------- batch summary

function buildBatchSummary(data: CrystalReportBatchData): Content[] {
  const { checks, samplePercentage, totalEligible, periodFrom, periodTo, reportId, generatedAt } = data

  const totalCompleted = checks.filter((c) => c.status === 'COMPLETED').length
  const totalExceptions = checks.filter((c) => c.status === 'EXCEPTION').length
  const totalPassed = checks.filter((c) => c.result === 'COMPLETED' && !c.values.some((v) => v.result === 'FAIL')).length
  const totalFailed = checks.filter((c) => c.values.some((v) => v.result === 'FAIL')).length
  const totalPhotos = checks.reduce((sum, c) => sum + c.photos.length + (c.exception?.photos?.length ?? 0), 0)
  const totalVideos = checks.reduce((sum, c) => sum + c.videos.length, 0)

  const info: [string, string][] = [
    ['Report no.', reportId],
    ['Generated', formatDateTime(generatedAt)],
    ...(periodFrom && periodTo ? ([['Period', `${formatDate(periodFrom)} – ${formatDate(periodTo)}`]] as [string, string][]) : []),
    ...(samplePercentage !== undefined
      ? ([['Sample', `${samplePercentage}% of ${totalEligible ?? checks.length} checks`]] as [string, string][])
      : [])
  ]
  const content: Content[] = [
    titleBlock(data, `Summary of ${checks.length} checks`, {
      table: {
        widths: [46, '*'],
        body: info.map(([label, value]) => [
          { text: label, fontSize: 7.5, color: C.muted },
          { text: value, fontSize: 8, bold: true, color: C.ink, alignment: 'right' }
        ])
      },
      layout: { hLineWidth: () => 0, vLineWidth: () => 0, paddingLeft: () => 0, paddingRight: () => 0, paddingTop: () => 1, paddingBottom: () => 1 }
    }, 200)
  ]

  content.push({
    margin: [0, 12, 0, 0],
    ...(figureStrip([
      { label: 'Checks', value: String(checks.length) },
      { label: 'Completed', value: String(totalCompleted) },
      { label: 'Conforming', value: String(totalPassed), color: totalPassed ? C.pass : C.ink },
      { label: 'Outside limits', value: String(totalFailed), color: totalFailed ? C.fail : C.ink },
      { label: 'Exceptions', value: String(totalExceptions), color: totalExceptions ? C.warn : C.ink },
      { label: 'Photos / videos', value: `${totalPhotos} / ${totalVideos}` }
    ]) as object)
  } as Content)

  content.push(sectionTitle('Checks in this report'))
  const header: TableCell[] = ['#', 'Check', 'Date / time', 'Item code', 'Job / PO', 'Machine', 'Worker', 'Result', 'Media'].map((t, i) => ({
    text: t.toUpperCase(),
    fontSize: 6.5,
    bold: true,
    color: C.muted,
    characterSpacing: 0.3,
    alignment: i === 0 || i >= 7 ? 'center' : 'left'
  }))
  const rows: TableCell[][] = checks.map((c, i) => {
    const hasFail = c.values.some((v) => v.result === 'FAIL')
    const s = statusStyle(c.status)
    const result = hasFail ? { label: 'Outside limits', color: C.fail } : c.status === 'COMPLETED' ? { label: 'Conforming', color: C.pass } : { label: s.label, color: s.color }
    const photos = c.photos.length + (c.exception?.photos?.length ?? 0)
    return [
      { text: String(i + 1), fontSize: 7.5, color: C.muted, alignment: 'center' },
      { text: c.code, fontSize: 7.5, bold: true, noWrap: true },
      { stack: [formatDate(c.submittedAt ?? c.scheduledAt), { text: formatTime(c.submittedAt ?? c.scheduledAt), color: C.muted }], fontSize: 7.5 },
      { text: c.itemCode || '—', fontSize: 7.5, color: c.itemCode ? C.ink : C.faint },
      { text: c.jobNo || '—', fontSize: 7.5, color: c.jobNo ? C.ink : C.faint },
      { text: c.machineName, fontSize: 7.5 },
      { text: c.workerName, fontSize: 7.5 },
      { text: result.label, fontSize: 7, bold: true, color: result.color, alignment: 'center' },
      // Photos and videos on separate lines, so the narrow column never breaks inside a count.
      {
        stack: [{ text: `${photos} P`, noWrap: true }, ...(c.videos.length ? [{ text: `${c.videos.length} V`, noWrap: true }] : [])],
        fontSize: 7,
        color: C.muted,
        alignment: 'center'
      }
    ]
  })
  content.push({
    table: { headerRows: 1, dontBreakRows: true, widths: [12, 88, 46, 56, 46, '*', 66, 52, 26], body: [header, ...rows] },
    layout: {
      hLineWidth: (i: number, node: ContentTable) => (i === 0 || i === 1 || i === node.table.body.length ? 0.8 : 0.5),
      vLineWidth: () => 0,
      hLineColor: (i: number, node: ContentTable) => (i === 0 || i === 1 || i === node.table.body.length ? C.line : C.hair),
      fillColor: (i: number) => (i === 0 ? C.headBg : null),
      paddingLeft: () => 4,
      paddingRight: () => 4,
      paddingTop: () => 4,
      paddingBottom: () => 4
    }
  })
  return content
}

// ------------------------------------------------------------------------------- weekly report

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** Green for 0%, orange down to -20%, red below (the same colours as the admin panel). */
const scoreColor = (score: number | null) => (score === null ? C.faint : score === 0 ? C.pass : score >= -20 ? C.warn : C.fail)
const scoreText = (d: DayScore) => (d.score === null ? '—' : `${d.score}%`)

const weeklyTableLayout = {
  hLineWidth: (i: number, node: ContentTable) => (i === 0 || i === 1 || i === node.table.body.length ? 0.8 : 0.5),
  vLineWidth: () => 0,
  hLineColor: (i: number, node: ContentTable) => (i === 0 || i === 1 || i === node.table.body.length ? C.line : C.hair),
  fillColor: (i: number, node: ContentTable) => (i === 0 ? C.headBg : i === node.table.body.length - 1 ? C.band : null),
  paddingLeft: () => 5,
  paddingRight: () => 5,
  paddingTop: () => 4,
  paddingBottom: () => 4
}

const headCell = (t: string, align: 'left' | 'center' | 'right' = 'center'): TableCell => ({
  text: t.toUpperCase(),
  fontSize: 6.5,
  bold: true,
  color: C.muted,
  characterSpacing: 0.3,
  alignment: align
})

/**
 * Every worker's week, Monday to Saturday: per day the checks assigned, completed, exceptions and
 * missed, and the score; then the week. Missed checks are in red so the coordinator can ask why.
 * Counts and score are the Performance page's (services/performance.ts): assigned = completed +
 * exceptions + missed; pending checks are not counted yet; exceptions count as done.
 */
function buildWeeklySheet(data: CrystalReportBatchData, weekly: WeeklyReport): Content[] {
  const sum = (key: 'assigned' | 'completed' | 'exceptions' | 'missed') => weekly.rows.reduce((n, r) => n + r.week[key], 0)
  const period = `${formatDateKey(weekly.days[0])} – ${formatDateKey(weekly.days[5])}`
  const content: Content[] = [
    titleBlock(data, `Weekly worker report · ${period}`, statusPill('Weekly report', C.brand, C.band)),
    {
      margin: [0, 12, 0, 0],
      ...(figureStrip([
        { label: 'Workers', value: String(weekly.rows.length) },
        { label: 'Assigned', value: String(sum('assigned')) },
        { label: 'Completed', value: String(sum('completed')), color: C.pass },
        { label: 'Exceptions', value: String(sum('exceptions')), color: sum('exceptions') ? C.warn : C.ink },
        { label: 'Missed', value: String(sum('missed')), color: sum('missed') ? C.fail : C.ink },
        { label: 'Team average', value: weekly.teamAverage === null ? '—' : `${weekly.teamAverage}%`, color: scoreColor(weekly.teamAverage) }
      ]) as object)
    } as Content,
    {
      text: 'Score = done ÷ assigned as a percentage, minus 100: 0% is every check done, -20% is 80% done. Done = completed + exceptions. Assigned counts checks whose time is over; checks still open are not counted yet.',
      fontSize: 7.5,
      color: C.muted,
      margin: [0, 6, 0, 0]
    },
    sectionTitle('Week overview')
  ]

  // One line per worker: the score of each day and of the week.
  content.push({
    table: {
      headerRows: 1,
      dontBreakRows: true,
      widths: ['*', ...weekly.days.map(() => 42), 46],
      body: [
        [headCell('Worker', 'left'), ...weekly.days.map((d, i) => headCell(`${DAY_NAMES[i].slice(0, 3)} ${formatDateKey(d).slice(0, 5)}`)), headCell('Week')],
        ...weekly.rows.map((r) => [
          { stack: [{ text: r.name, bold: true, fontSize: 8 }, { text: [r.employeeId.toLowerCase() === r.name.toLowerCase() ? null : r.employeeId, r.department].filter(Boolean).join(' · ') || ' ', fontSize: 6.5, color: C.muted }] },
          ...r.days.map((d) => ({ text: scoreText(d), fontSize: 8, bold: d.score !== null, color: scoreColor(d.score), alignment: 'center' as const })),
          { text: scoreText(r.week), fontSize: 9, bold: true, color: scoreColor(r.week.score), alignment: 'center' as const }
        ]),
        [
          { text: 'Team average', bold: true, fontSize: 8 },
          ...weekly.days.map(() => ({ text: '' })),
          { text: weekly.teamAverage === null ? '—' : `${weekly.teamAverage}%`, fontSize: 9, bold: true, color: scoreColor(weekly.teamAverage), alignment: 'center' as const }
        ]
      ]
    },
    layout: weeklyTableLayout
  })

  // Then each worker's days in full.
  for (const r of weekly.rows) {
    // The employee ID only when it differs from the name (some accounts use the name as ID).
    const id = r.employeeId.toLowerCase() === r.name.toLowerCase() ? '' : `  ·  ${r.employeeId}`
    content.push(sectionTitle(`${r.name}${id}${r.department ? `  ·  ${r.department}` : ''}`, [0, 18, 0, 6]))
    if (r.week.assigned === 0 && r.week.pending === 0) {
      content.push({ text: 'No checks this week.', fontSize: 8, italics: true, color: C.muted })
      continue
    }
    const num = (n: number, color?: string): TableCell => ({ text: String(n), fontSize: 8, alignment: 'center', color: n ? (color ?? C.ink) : C.faint, bold: !!n && !!color })
    const line = (label: string, d: DayScore, bold = false): TableCell[] => [
      { text: label, fontSize: 8, bold },
      num(d.assigned),
      num(d.completed, C.pass),
      num(d.exceptions, C.warn),
      num(d.missed, C.fail),
      { text: d.assigned ? `${d.done}/${d.assigned} · ${Math.round((d.done / d.assigned) * 100)}%` : '—', fontSize: 8, alignment: 'center', color: d.assigned ? C.ink : C.faint },
      { text: scoreText(d), fontSize: 8.5, bold: true, color: scoreColor(d.score), alignment: 'center' }
    ]
    content.push({
      table: {
        headerRows: 1,
        dontBreakRows: true,
        widths: ['*', 52, 60, 60, 50, 80, 50],
        body: [
          [headCell('Day', 'left'), headCell('Assigned'), headCell('Completed'), headCell('Exceptions'), headCell('Missed'), headCell('Done'), headCell('Score')],
          ...r.days.map((d, i) => line(`${DAY_NAMES[i]} ${formatDateKey(weekly.days[i])}`, d)),
          line('Week', r.week, true)
        ]
      },
      layout: weeklyTableLayout
    })
    if (r.week.pending) {
      content.push({ text: `${r.week.pending} check${r.week.pending === 1 ? ' is' : 's are'} still open and not counted yet.`, fontSize: 7, color: C.muted, margin: [0, 3, 0, 0] })
    }
  }
  return content
}

// ------------------------------------------------------------------------------------- document

/** The complete report document. `photos` comes from prepareReportPhotos (no photos without it). */
export function buildCrystalReportDocument(data: CrystalReportBatchData, photos: ReportPhotos = new Map()): TDocumentDefinitions {
  const content: Content[] = []
  const batch = data.checks.length > 1
  if (batch) content.push(...buildBatchSummary(data))
  // The weekly worker report follows the summary, on its own page.
  if (data.weekly) {
    const sheet = buildWeeklySheet(data, data.weekly)
    content.push(content.length ? { stack: sheet, pageBreak: 'before' } : { stack: sheet })
  }

  data.checks.forEach((check, index) => {
    // Every check starts on its own page.
    const sheet = buildCheckSheet(check, data, photos)
    if (batch || index > 0 || data.weekly) content.push({ stack: sheet, pageBreak: 'before' })
    else content.push(...sheet)
  })

  return {
    pageSize: 'A4',
    pageOrientation: 'portrait',
    pageMargins: [PAGE_MARGIN_X, 40, PAGE_MARGIN_X, 44],
    info: { title: `Quality Inspection Report ${data.reportId}`, author: data.companyName, creator: 'Quality Monitoring System' },
    defaultStyle: { font: 'Helvetica', fontSize: 8.5, color: C.text, lineHeight: 1.2 },
    // A section title never sits alone at the bottom of a page.
    pageBreakBefore: (node, queries) => node.headlineLevel === 1 && queries.getFollowingNodesOnPage().length === 0,
    header: (currentPage: number) =>
      currentPage === 1
        ? null
        : {
            margin: [PAGE_MARGIN_X, 18, PAGE_MARGIN_X, 0],
            columns: [
              { text: `${data.companyName}  ·  Quality Inspection Report`, fontSize: 7, color: C.faint },
              { text: data.reportId, fontSize: 7, color: C.faint, alignment: 'right' }
            ]
          },
    footer: (currentPage: number, pageCount: number) => ({
      margin: [PAGE_MARGIN_X, 14, PAGE_MARGIN_X, 0],
      columns: [
        { text: `Generated ${formatDateTime(data.generatedAt)} by the Quality Monitoring System`, fontSize: 7, color: C.faint },
        { width: 'auto', text: `Page ${currentPage} of ${pageCount}`, fontSize: 7, color: C.muted, alignment: 'right' }
      ]
    }),
    content
  }
}

/** Renders the report PDF to a Buffer, with the checks' photos. */
export async function renderCrystalReportPdf(data: CrystalReportBatchData): Promise<Buffer> {
  const photos = await prepareReportPhotos(data.checks)
  // Every emailed and previewed report carries the week of its period. If the figures cannot be
  // loaded, the report is made exactly as before, without the weekly section.
  const weekly =
    data.weekly !== undefined
      ? data.weekly
      : await weeklyScores(data.periodTo ?? data.generatedAt).catch((err) => {
          console.error('[Report PDF] Weekly worker report failed:', err)
          return null
        })
  const pdf = pdfmake.createPdf(buildCrystalReportDocument({ ...data, weekly }, photos))
  return pdf.getBuffer()
}
