import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import ExcelJS from 'exceljs'
import { PDFParse } from 'pdf-parse'
import { createCanvas, loadImage, type Canvas } from '@napi-rs/canvas'
import { createWorker, PSM, type Worker } from 'tesseract.js'
import { badRequest } from '../lib/http'

/**
 * Reads a company holiday calendar document into rows of cells. Nothing here decides what a
 * value means; calendarImport.ts turns rows into calendar items and flags anything uncertain.
 *
 *  - Excel (.xlsx) and CSV: read exactly, cell by cell.
 *  - PDF with text: its tables (or tab-separated lines) are read exactly.
 *  - Images, and PDFs without text (scans): offline OCR with Tesseract (English + Gujarati), run
 *    on this server; the document never leaves it. The table grid is detected and each cell is
 *    read on its own; cells with dates are read a second time as digits only, and a date is only
 *    trusted when both readings agree.
 */

export interface Cell {
  text: string
  /** OCR confidence 0–100; null when the value was read exactly (Excel, PDF text). */
  confidence: number | null
  /** OCR: a digits-only reading of the cell, used to cross-check dates. */
  digits?: string
}

export interface SourceRow {
  row: number
  cells: Cell[]
}

export type ExtractionMethod = 'EXCEL' | 'PDF_TEXT' | 'OCR'

export interface ExtractionResult {
  method: ExtractionMethod
  rows: SourceRow[]
  note: string | null
}

const exact = (text: string): Cell => ({ text: text.replace(/\s+/g, ' ').trim(), confidence: null })

export async function extractRows(filePath: string, mimeType: string, originalName: string): Promise<ExtractionResult> {
  const ext = path.extname(originalName).toLowerCase()
  if (ext === '.xlsx' || mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return fromExcel(filePath)
  if (ext === '.csv' || mimeType === 'text/csv') return fromCsv(filePath)
  if (ext === '.xls') throw badRequest('Old .xls files are not supported. Open the file in Excel and save it as .xlsx, then upload again.')
  if (ext === '.pdf' || mimeType === 'application/pdf') return fromPdf(filePath)
  if (mimeType.startsWith('image/') || ['.png', '.jpg', '.jpeg', '.webp', '.bmp'].includes(ext)) {
    const rows = await ocrImage(await fsp.readFile(filePath))
    return { method: 'OCR', rows, note: 'Read with offline OCR. Check every date against the document.' }
  }
  throw badRequest('Upload the calendar as an Excel file (.xlsx), CSV, PDF or image (JPG/PNG).')
}

// ---------------------------------------------------------------- Excel / CSV

function excelCellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) {
    // Excel dates carry no time zone: take the calendar day as stored.
    const d = String(value.getUTCDate()).padStart(2, '0')
    const m = String(value.getUTCMonth() + 1).padStart(2, '0')
    return `${d}/${m}/${value.getUTCFullYear()}`
  }
  if (typeof value === 'object') {
    if ('richText' in value) return value.richText.map((r) => r.text).join('')
    if ('result' in value) return excelCellText(value.result as ExcelJS.CellValue)
    if ('text' in value) return String(value.text)
  }
  return String(value)
}

function rowsFromSheet(sheet: ExcelJS.Worksheet): SourceRow[] {
  const rows: SourceRow[] = []
  sheet.eachRow({ includeEmpty: false }, (row, number) => {
    const cells: Cell[] = []
    for (let c = 1; c <= row.cellCount; c++) cells.push(exact(excelCellText(row.getCell(c).value)))
    if (cells.some((cell) => cell.text)) rows.push({ row: number, cells })
  })
  return rows
}

async function fromExcel(filePath: string): Promise<ExtractionResult> {
  const workbook = new ExcelJS.Workbook()
  try {
    await workbook.xlsx.readFile(filePath)
  } catch {
    throw badRequest('The Excel file could not be read. Save it again as .xlsx and upload it.')
  }
  // The sheet with the most dates is the calendar.
  const sheets = workbook.worksheets.map((sheet) => ({ sheet, rows: rowsFromSheet(sheet) }))
  const dateCount = (rows: SourceRow[]) => rows.reduce((n, r) => n + r.cells.filter((c) => DATE_HINT.test(normalizeDigits(c.text))).length, 0)
  const best = sheets.sort((a, b) => dateCount(b.rows) - dateCount(a.rows))[0]
  if (!best || best.rows.length === 0) throw badRequest('The Excel file has no rows.')
  return { method: 'EXCEL', rows: best.rows, note: sheets.length > 1 ? `Read sheet "${best.sheet.name}".` : null }
}

async function fromCsv(filePath: string): Promise<ExtractionResult> {
  const workbook = new ExcelJS.Workbook()
  const sheet = await workbook.csv.readFile(filePath, { parserOptions: { delimiter: undefined } } as never)
  return { method: 'EXCEL', rows: rowsFromSheet(sheet), note: null }
}

// ---------------------------------------------------------------- PDF

async function fromPdf(filePath: string): Promise<ExtractionResult> {
  const parser = new PDFParse({ data: new Uint8Array(await fsp.readFile(filePath)) })
  try {
    const text = await parser.getText({ cellSeparator: '\t' })
    const plain = text.text.replace(/\s+/g, '')
    if (plain.length >= 20) {
      const tables = await parser.getTable()
      const table = tables.mergedTables.filter((t) => t.length >= 2 && t[0].length >= 3).sort((a, b) => b.length - a.length)[0]
      if (table) {
        return { method: 'PDF_TEXT', rows: table.map((cells, i) => ({ row: i + 1, cells: cells.map(exact) })), note: null }
      }
      const rows = text.text
        .split(/\r?\n/)
        .map((line, i) => ({ row: i + 1, cells: line.split('\t').map(exact).filter((c) => c.text) }))
        .filter((r) => r.cells.length)
      return { method: 'PDF_TEXT', rows, note: null }
    }
    // A scanned PDF: read each page image with OCR.
    const shots = await parser.getScreenshot({ scale: 2 })
    const rows: SourceRow[] = []
    for (const page of shots.pages) {
      const pageRows = await ocrImage(Buffer.from(page.data))
      rows.push(...pageRows.map((r) => ({ ...r, row: rows.length + r.row })))
    }
    return { method: 'OCR', rows, note: 'Scanned PDF read with offline OCR. Check every date against the document.' }
  } finally {
    await parser.destroy()
  }
}

// ---------------------------------------------------------------- OCR

const OCR_LANGS = ['guj', 'eng']
const OCR_DATA_DIR = path.resolve(process.cwd(), '.ocr-data')
let worker: Promise<Worker> | null = null
let idleTimer: NodeJS.Timeout | null = null
let queue: Promise<unknown> = Promise.resolve()

/** Language files ship with the app (npm packages) and are copied next to it once; no download. */
function prepareLanguageData() {
  const require = createRequire(import.meta.url)
  fs.mkdirSync(OCR_DATA_DIR, { recursive: true })
  for (const lang of OCR_LANGS) {
    const target = path.join(OCR_DATA_DIR, `${lang}.traineddata.gz`)
    if (fs.existsSync(target)) continue
    const pkg = path.dirname(require.resolve(`@tesseract.js-data/${lang}/package.json`))
    fs.copyFileSync(path.join(pkg, '4.0.0_best_int', `${lang}.traineddata.gz`), target)
  }
}

function getWorker() {
  if (!worker) {
    prepareLanguageData()
    worker = createWorker(OCR_LANGS, 1, { langPath: OCR_DATA_DIR, cachePath: OCR_DATA_DIR, gzip: true }).then(async (w) => {
      await w.setParameters({ debug_file: '/dev/null' })
      return w
    })
  }
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    const current = worker
    worker = null
    current?.then((w) => w.terminate()).catch(() => undefined)
  }, 120_000)
  idleTimer.unref()
  return worker
}

/** One document at a time: the OCR worker is shared. */
function exclusive<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task)
  queue = run.catch(() => undefined)
  return run
}

interface Gray {
  width: number
  height: number
  data: Uint8Array
}

function toGray(canvas: Canvas): Gray {
  const { width, height } = canvas
  const rgba = canvas.getContext('2d').getImageData(0, 0, width, height).data
  const data = new Uint8Array(width * height)
  for (let i = 0; i < data.length; i++) data[i] = (rgba[i * 4] * 299 + rgba[i * 4 + 1] * 587 + rgba[i * 4 + 2] * 114) / 1000
  return { width, height, data }
}

/** Dark pixels, compared with their surroundings so shadows and uneven light in photos do not matter. */
function binarize(gray: Gray): Uint8Array {
  const { width: w, height: h, data } = gray
  const integral = new Float64Array((w + 1) * (h + 1))
  for (let y = 1; y <= h; y++) {
    let row = 0
    for (let x = 1; x <= w; x++) {
      row += data[(y - 1) * w + (x - 1)]
      integral[y * (w + 1) + x] = integral[(y - 1) * (w + 1) + x] + row
    }
  }
  const r = Math.max(8, Math.round(Math.min(w, h) / 60))
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r)
    const y1 = Math.min(h, y + r + 1)
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r)
      const x1 = Math.min(w, x + r + 1)
      const sum = integral[y1 * (w + 1) + x1] - integral[y0 * (w + 1) + x1] - integral[y1 * (w + 1) + x0] + integral[y0 * (w + 1) + x0]
      const mean = sum / ((y1 - y0) * (x1 - x0))
      const v = data[y * w + x]
      out[y * w + x] = v < mean * 0.82 && v < 180 ? 1 : 0
    }
  }
  return out
}

/** Small rotation of a photographed page, in degrees, found by making text and table lines horizontal. */
function estimateSkew(bin: Uint8Array, w: number, h: number) {
  const step = Math.max(1, Math.round(Math.max(w, h) / 900))
  let best = { angle: 0, score: -1 }
  for (let a = -4; a <= 4.001; a += 0.25) {
    const t = Math.tan((a * Math.PI) / 180)
    const bins = new Float64Array(h + w)
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        if (bin[y * w + x]) {
          const p = Math.round(y - x * t + w)
          if (p >= 0 && p < bins.length) bins[p]++
        }
      }
    }
    let score = 0
    for (const b of bins) score += b * b
    if (score > best.score) best = { angle: a, score }
  }
  return best.angle
}

function groupPositions(positions: number[], gap: number) {
  const groups: number[][] = []
  for (const p of positions) {
    const last = groups[groups.length - 1]
    if (last && p - last[last.length - 1] <= gap) last.push(p)
    else groups.push([p])
  }
  return groups.map((g) => ({ at: Math.round((g[0] + g[g.length - 1]) / 2), from: g[0], to: g[g.length - 1] }))
}

/** Table lines: rows and columns that are mostly dark across the table. */
function findGrid(bin: Uint8Array, w: number, h: number) {
  const rowDark = new Array<number>(h).fill(0)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rowDark[y] += bin[y * w + x]
  const hLines = groupPositions(
    rowDark.map((n, y) => (n > w * 0.4 ? y : -1)).filter((y) => y >= 0),
    3
  )
  if (hLines.length < 3) return null
  const top = hLines[0].from
  const bottom = hLines[hLines.length - 1].to
  const colDark = new Array<number>(w).fill(0)
  for (let x = 0; x < w; x++) for (let y = top; y <= bottom; y++) colDark[x] += bin[y * w + x]
  const vLines = groupPositions(
    colDark.map((n, x) => (n > (bottom - top) * 0.5 ? x : -1)).filter((x) => x >= 0),
    3
  )
  if (vLines.length < 3) return null
  return { hLines, vLines }
}

const GUJARATI_OR_LATIN_DIGIT = /[0-9૦-૯]/g

async function recognizeCell(w: Worker, canvas: Canvas, box: { x0: number; y0: number; x1: number; y1: number }, multiLine: boolean) {
  const cw = box.x1 - box.x0
  const ch = box.y1 - box.y0
  const scale = Math.min(4, Math.max(1, 70 / Math.max(ch, 1)))
  const out = createCanvas(Math.round(cw * scale) + 40, Math.round(ch * scale) + 40)
  const ctx = out.getContext('2d')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, out.width, out.height)
  ctx.drawImage(canvas, box.x0, box.y0, cw, ch, 20, 20, cw * scale, ch * scale)
  const png = out.toBuffer('image/png')

  await w.setParameters({ tessedit_pageseg_mode: multiLine ? PSM.SINGLE_BLOCK : PSM.SINGLE_LINE, tessedit_char_whitelist: '' })
  const { data } = await w.recognize(png)
  const cell: Cell = { text: data.text.replace(/\s+/g, ' ').trim(), confidence: Math.round(data.confidence) }

  // Dates are read again as digits and separators only; calendarImport compares both readings.
  if ((cell.text.match(GUJARATI_OR_LATIN_DIGIT) ?? []).length >= 4) {
    await w.setParameters({ tessedit_char_whitelist: '0123456789૦૧૨૩૪૫૬૭૮૯/-.' })
    const digits = await w.recognize(png)
    cell.digits = digits.data.text.replace(/\s+/g, '').trim()
    await w.setParameters({ tessedit_char_whitelist: '' })
  }
  return cell
}

export async function ocrImage(buffer: Buffer): Promise<SourceRow[]> {
  return exclusive(async () => {
    let image
    try {
      image = await loadImage(buffer)
    } catch {
      throw badRequest('The image could not be read. Upload a JPG or PNG photo or scan of the calendar.')
    }
    // Work at a size where table text is legible but processing stays quick.
    const scale = Math.min(2.5, Math.max(0.5, 1800 / image.width))
    let canvas = createCanvas(Math.round(image.width * scale), Math.round(image.height * scale))
    let ctx = canvas.getContext('2d')
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height)

    let gray = toGray(canvas)
    let bin = binarize(gray)
    const skew = estimateSkew(bin, gray.width, gray.height)
    if (Math.abs(skew) >= 0.25) {
      const rotated = createCanvas(canvas.width, canvas.height)
      const rctx = rotated.getContext('2d')
      rctx.fillStyle = '#fff'
      rctx.fillRect(0, 0, rotated.width, rotated.height)
      rctx.translate(rotated.width / 2, rotated.height / 2)
      rctx.rotate((-skew * Math.PI) / 180)
      rctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2)
      canvas = rotated
      ctx = canvas.getContext('2d')
      gray = toGray(canvas)
      bin = binarize(gray)
    }

    const w = await getWorker()
    const grid = findGrid(bin, gray.width, gray.height)
    if (!grid) {
      // No ruled table: read the page as lines of text; every value will need checking.
      await w.setParameters({ tessedit_pageseg_mode: PSM.AUTO, tessedit_char_whitelist: '' })
      const { data } = await w.recognize(canvas.toBuffer('image/png'), {}, { blocks: true })
      const rows: SourceRow[] = []
      for (const block of data.blocks ?? []) {
        for (const paragraph of block.paragraphs) {
          for (const line of paragraph.lines) {
            const cells = line.words.map((word) => ({ text: word.text, confidence: Math.round(word.confidence) }))
            if (cells.length) rows.push({ row: rows.length + 1, cells })
          }
        }
      }
      return rows
    }

    const { hLines, vLines } = grid
    const heights = hLines.slice(1).map((l, i) => l.from - hLines[i].to)
    const typical = heights.slice().sort((a, b) => a - b)[Math.floor(heights.length / 2)] || 1
    const rows: SourceRow[] = []
    for (let r = 0; r < hLines.length - 1; r++) {
      const y0 = hLines[r].to + 1
      const y1 = hLines[r + 1].from - 1
      if (y1 - y0 < 8) continue
      const cells: Cell[] = []
      for (let c = 0; c < vLines.length - 1; c++) {
        const inset = Math.max(3, Math.round((y1 - y0) * 0.06))
        const box = { x0: vLines[c].to + inset, y0: y0 + inset, x1: vLines[c + 1].from - inset, y1: y1 - inset }
        if (box.x1 - box.x0 < 8 || box.y1 - box.y0 < 6) {
          cells.push({ text: '', confidence: null })
          continue
        }
        let ink = 0
        for (let y = box.y0; y < box.y1; y++) for (let x = box.x0; x < box.x1; x++) ink += bin[y * gray.width + x]
        if (ink / ((box.x1 - box.x0) * (box.y1 - box.y0)) < 0.004) {
          cells.push({ text: '', confidence: null })
          continue
        }
        cells.push(await recognizeCell(w, canvas, box, y1 - y0 > typical * 1.8))
      }
      if (cells.some((cell) => cell.text)) rows.push({ row: r + 1, cells })
    }
    return rows
  })
}

// ---------------------------------------------------------------- shared text helpers

/** Gujarati digits (૦–૯) as ASCII digits. */
export const normalizeDigits = (text: string) => text.replace(/[૦-૯]/g, (d) => String(d.charCodeAt(0) - 0x0ae6))

export const DATE_HINT = /\d{1,2}\s*[/\-.]\s*\d{1,2}\s*[/\-.]\s*\d{2,4}/
