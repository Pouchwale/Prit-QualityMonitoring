import { DATE_HINT, normalizeDigits, type Cell, type SourceRow } from './calendarExtraction'

/**
 * Turns rows read from a company calendar document into calendar items for review.
 *
 * The document is the source of truth, so nothing is guessed: a value that cannot be read
 * exactly is left empty or kept as read and marked uncertain, and uncertain items can never be
 * approved without the admin checking them. Understood layout (the company sheet and similar):
 *
 *   No. | Date | Day | Holiday | Adjustment date | Adjustment day
 *
 * Columns are found from the header (English or Gujarati); without a header, from the content.
 * Each holiday row becomes a HOLIDAY item, and its adjustment date (if any) a WORKING item
 * linked to that holiday. Dates are read day first (DD/MM/YYYY), as written in India.
 */

export interface ImportedItem {
  type: 'HOLIDAY' | 'WORKING'
  date: string | null
  name: string | null
  forHolidayDate: string | null
  printedWeekday: string | null
  sourceText: string
  sourceRow: number
  uncertainFields: string[]
}

/** OCR readings below this confidence are never trusted without the admin checking them. */
const MIN_CONFIDENCE = 85

type Column = 'serial' | 'date' | 'weekday' | 'name' | 'adjDate' | 'adjWeekday'

const squash = (text: string) => text.toLowerCase().replace(/[\s._:()-]/g, '')

function headerColumn(text: string): Column | null {
  const t = squash(text)
  if (!t) return null
  const adjust = /એડજસ્ટ|એડજેસ્ટ|adjust|compensat|બદલ/.test(t)
  if (/^(અનુ|ક્રમ|sr|srno|no|#|sno|serial)/.test(t)) return 'serial'
  if (/તારીખ|date/.test(t)) return adjust ? 'adjDate' : 'date'
  if (/તહેવાર|તેહવાર|તહેવાર|holiday|festival|occasion|name|રજા|વિગત|particular|description/.test(t)) return 'name'
  if (/દિવસ|^day|weekday|^વાર/.test(t)) return adjust ? 'adjWeekday' : 'weekday'
  return null
}

/** The header row: the first row naming a date column and at least one other known column. */
function findHeader(rows: SourceRow[]) {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const columns = rows[i].cells.map((c) => headerColumn(c.text))
    const found = new Set(columns.filter(Boolean))
    if (found.has('date') && found.size >= 2) return { index: i, columns }
  }
  return null
}

const WEEKDAYS: { day: number; names: string[] }[] = [
  { day: 0, names: ['રવિવાર', 'sunday', 'sun'] },
  { day: 1, names: ['સોમવાર', 'monday', 'mon'] },
  { day: 2, names: ['મંગળવાર', 'tuesday', 'tue', 'tues'] },
  { day: 3, names: ['બુધવાર', 'wednesday', 'wed'] },
  { day: 4, names: ['ગુરુવાર', 'thursday', 'thu', 'thur', 'thurs'] },
  { day: 5, names: ['શુક્રવાર', 'friday', 'fri'] },
  { day: 6, names: ['શનિવાર', 'saturday', 'sat'] }
]
export const WEEKDAY_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function editDistance(a: string, b: string) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
  }
  return d[a.length][b.length]
}

/** Weekday printed on the document (English or Gujarati, tolerating small OCR slips), or null. */
export function readWeekday(text: string): number | null {
  const t = squash(text).replace(/[^a-z઀-૿]/g, '')
  if (!t) return null
  let best: { day: number; distance: number } | null = null
  for (const { day, names } of WEEKDAYS) {
    for (const name of names) {
      const distance = editDistance(t, name)
      const allowed = name.length <= 4 ? 0 : name.length <= 6 ? 1 : 2
      if (distance <= allowed && (!best || distance < best.distance)) best = { day, distance }
    }
  }
  return best?.day ?? null
}

/** Characters OCR confuses with digits in a date cell. Any replacement makes the date uncertain. */
const LOOKALIKES: Record<string, string> = {
  'ર': '૨', 'O': '0', 'o': '0', 'D': '0', 'l': '1', 'I': '1', '|': '1', 'i': '1', 'S': '5', 's': '5', 'B': '8', 'Z': '2', 'z': '2'
}

export interface ReadDate {
  date: string | null
  /** The reading needed a correction, disagreed with a second reading, or could not be read. */
  uncertain: boolean
}

function parseDateText(raw: string, year: number | null): { date: string | null; corrected: boolean } {
  let corrected = false
  const cleaned = raw.replace(/[ર OoDlI|iSsBZz]/g, (ch) => {
    if (ch === ' ') return ' '
    corrected = true
    return LOOKALIKES[ch] ?? ch
  })
  const text = normalizeDigits(cleaned)
  let m = /(\d{1,2})\s*[/\-.]\s*(\d{1,2})\s*[/\-.]\s*(\d{4}|\d{2})(?!\d)/.exec(text)
  let day: number, month: number, y: number
  if (m) {
    day = Number(m[1])
    month = Number(m[2])
    y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])
  } else if ((m = /(\d{4})\s*[/\-.]\s*(\d{1,2})\s*[/\-.]\s*(\d{1,2})(?!\d)/.exec(text))) {
    y = Number(m[1])
    month = Number(m[2])
    day = Number(m[3])
  } else {
    return { date: null, corrected }
  }
  const asDate = new Date(y, month - 1, day)
  if (asDate.getFullYear() !== y || asDate.getMonth() !== month - 1 || asDate.getDate() !== day) return { date: null, corrected }
  void year
  return { date: `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`, corrected }
}

/** Reads a date cell. OCR dates must be confident and agree with the digits-only reading. */
export function readDate(cell: Cell | undefined, year: number | null): ReadDate {
  if (!cell || !cell.text) return { date: null, uncertain: false }
  const first = parseDateText(cell.text, year)
  if (cell.confidence === null) return { date: first.date, uncertain: first.date === null }
  let uncertain = first.corrected || cell.confidence < MIN_CONFIDENCE || first.date === null
  if (cell.digits !== undefined) {
    const second = parseDateText(cell.digits, year)
    if (second.date !== first.date) uncertain = true
  } else {
    uncertain = true
  }
  return { date: first.date, uncertain }
}

const hasDigits = (cell: Cell | undefined) => !!cell && /[0-9૦-૯]/.test(cell.text)
const textOf = (cell: Cell | undefined) => cell?.text.replace(/\s+/g, ' ').trim() ?? ''
const shortDay = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`

/** Without a header: date columns are the ones mostly holding dates, the name column the most text. */
function inferColumns(rows: SourceRow[]): (Column | null)[] {
  const width = Math.max(...rows.map((r) => r.cells.length))
  const stats = Array.from({ length: width }, (_, i) => {
    const cells = rows.map((r) => r.cells[i]).filter((c) => c && c.text)
    return {
      i,
      dates: cells.filter((c) => DATE_HINT.test(normalizeDigits(c!.text))).length,
      weekdays: cells.filter((c) => readWeekday(c!.text) !== null).length,
      letters: cells.reduce((n, c) => n + (c!.text.match(/[a-z઀-૿]/gi)?.length ?? 0), 0)
    }
  })
  const columns: (Column | null)[] = Array(width).fill(null)
  const dateCols = stats.filter((s) => s.dates >= Math.max(1, rows.length * 0.2)).map((s) => s.i)
  if (dateCols[0] !== undefined) columns[dateCols[0]] = 'date'
  if (dateCols[1] !== undefined) columns[dateCols[1]] = 'adjDate'
  const weekdayCols = stats.filter((s) => columns[s.i] === null && s.weekdays >= Math.max(1, rows.length * 0.3)).map((s) => s.i)
  for (const i of weekdayCols) columns[i] = dateCols[1] !== undefined && i > dateCols[1] ? 'adjWeekday' : 'weekday'
  const name = stats.filter((s) => columns[s.i] === null).sort((a, b) => b.letters - a.letters)[0]
  if (name && name.letters > 0) columns[name.i] = 'name'
  return columns
}

export function itemsFromRows(rows: SourceRow[], year: number): { items: ImportedItem[]; layout: 'HEADER' | 'INFERRED' | 'LINES' } {
  const header = findHeader(rows)
  let columns: (Column | null)[]
  let data: SourceRow[]
  let layout: 'HEADER' | 'INFERRED' | 'LINES'
  if (header) {
    columns = [...header.columns]
    data = rows.slice(header.index + 1)
    layout = 'HEADER'
    // A header cell OCR could not read: recognise weekday columns from their content.
    const width = Math.max(columns.length, ...data.map((r) => r.cells.length))
    for (let i = 0; i < width; i++) {
      if (columns[i]) continue
      const filled = data.map((r) => r.cells[i]).filter((c) => c && c.text)
      if (filled.length && filled.filter((c) => readWeekday(c!.text) !== null).length >= filled.length * 0.6) {
        const adjIndex = columns.indexOf('adjDate')
        columns[i] = adjIndex >= 0 && i > adjIndex ? 'adjWeekday' : 'weekday'
      }
    }
  } else {
    const tabular = rows.filter((r) => r.cells.length >= 3)
    if (tabular.length >= rows.length * 0.6 && tabular.length > 0) {
      columns = inferColumns(tabular)
      data = rows
      layout = 'INFERRED'
    } else {
      return { items: itemsFromLines(rows, year), layout: 'LINES' }
    }
  }
  const at = (row: SourceRow, column: Column) => {
    const index = columns.indexOf(column)
    return index >= 0 ? row.cells[index] : undefined
  }

  const items: ImportedItem[] = []
  for (const row of data) {
    const dateCell = at(row, 'date')
    const adjCell = at(row, 'adjDate')
    // Only rows that carry a date are calendar rows (skips titles, notes and blank lines).
    if (!hasDigits(dateCell) && !hasDigits(adjCell)) continue
    const sourceText = row.cells.map(textOf).filter(Boolean).join(' | ')

    const holiday = readDate(dateCell, year)
    const nameCell = at(row, 'name')
    const name = textOf(nameCell) || null
    const weekdayCell = at(row, 'weekday')
    const weekday = weekdayCell?.text ? readWeekday(weekdayCell.text) : null
    const uncertain: string[] = []
    if (holiday.uncertain || !holiday.date) uncertain.push('date')
    if (!name || (nameCell?.confidence !== null && nameCell?.confidence !== undefined && nameCell.confidence < MIN_CONFIDENCE)) uncertain.push('name')
    if (weekdayCell?.text && weekday === null) uncertain.push('printedWeekday')

    if (hasDigits(dateCell)) {
      items.push({
        type: 'HOLIDAY',
        date: holiday.date,
        name,
        forHolidayDate: null,
        printedWeekday: weekday === null ? (textOf(weekdayCell) || null) : WEEKDAY_EN[weekday],
        sourceText,
        sourceRow: row.row,
        uncertainFields: uncertain
      })
    }

    if (hasDigits(adjCell)) {
      const adjustment = readDate(adjCell, year)
      const adjWeekdayCell = at(row, 'adjWeekday')
      const adjWeekday = adjWeekdayCell?.text ? readWeekday(adjWeekdayCell.text) : null
      const adjUncertain: string[] = []
      if (adjustment.uncertain || !adjustment.date) adjUncertain.push('date')
      if (holiday.uncertain || !holiday.date) adjUncertain.push('forHolidayDate')
      if (adjWeekdayCell?.text && adjWeekday === null) adjUncertain.push('printedWeekday')
      items.push({
        type: 'WORKING',
        date: adjustment.date,
        name: name && holiday.date ? `Adjustment for ${name} (${shortDay(holiday.date)})` : name ? `Adjustment for ${name}` : null,
        forHolidayDate: holiday.date,
        printedWeekday: adjWeekday === null ? (textOf(adjWeekdayCell) || null) : WEEKDAY_EN[adjWeekday],
        sourceText,
        sourceRow: row.row,
        uncertainFields: adjUncertain
      })
    }
  }
  return { items, layout }
}

/** Plain text lines (no table): every date on a line, the rest is the name; always checked by the admin. */
function itemsFromLines(rows: SourceRow[], year: number): ImportedItem[] {
  const items: ImportedItem[] = []
  for (const row of rows) {
    const line = row.cells.map(textOf).join(' ')
    const normalized = normalizeDigits(line)
    const matches = [...normalized.matchAll(/\d{1,2}\s*[/\-.]\s*\d{1,2}\s*[/\-.]\s*\d{2,4}/g)]
    if (matches.length === 0) continue
    const minConfidence = Math.min(...row.cells.map((c) => c.confidence ?? 100))
    const dates = matches.map((m) => parseDateText(m[0], year).date)
    const words = line.split(/\s+/).filter((w) => !/[0-9૦-૯]/.test(w))
    const weekday = words.map(readWeekday).find((d) => d !== null) ?? null
    const name = words.filter((w) => readWeekday(w) === null).join(' ').trim() || null
    const uncertain = ['date', 'name', ...(minConfidence < MIN_CONFIDENCE ? ['source'] : [])]
    items.push({ type: 'HOLIDAY', date: dates[0], name, forHolidayDate: null, printedWeekday: weekday === null ? null : WEEKDAY_EN[weekday], sourceText: line, sourceRow: row.row, uncertainFields: uncertain })
    if (dates.length > 1) {
      items.push({ type: 'WORKING', date: dates[1], name: name ? `Adjustment for ${name}` : null, forHolidayDate: dates[0], printedWeekday: null, sourceText: line, sourceRow: row.row, uncertainFields: ['date', 'forHolidayDate'] })
    }
  }
  return items
}
