import fs from 'node:fs'
import path from 'node:path'
import pdfmake from 'pdfmake'
import type { Content, TDocumentDefinitions, TableCell } from 'pdfmake/interfaces'
import { dateKey } from '../lib/time'
import type { TraceGroup, TraceReport } from './traceReport'
import {
  formatDate,
  formatDateTime,
  formatTime,
  percentText,
  type GroupRow,
  type ParameterRow,
  type QualityReport
} from './reportData'
import { C, figureStrip, logoDataUri } from './crystalReportPdf'

/**
 * Renders the Quality Monitoring Report (Reports page → Download PDF).
 *
 * It has the look of the Quality Inspection Report (services/crystalReportPdf.ts): the same palette,
 * logo title block with the brand rule, figure strips, brand section titles, tables with
 * horizontal hairlines only, and the same running header and footer.
 *
 * Every page is A4 portrait with the same margins, header and footer — there are no
 * landscape pages. Wide tables are fitted to the portrait width by stacking related
 * fields in one column (machine over code, worker over employee ID, date over time)
 * rather than by rotating the page. Table headers repeat on every page, rows are
 * never split across pages, and every page carries the footer with "Page X of Y".
 */

/** A4 portrait, minus the left and right page margins (as the inspection report). Every table must fit inside this. */
const PAGE_MARGIN_X = 40
const CONTENT_WIDTH = 595.28 - 2 * PAGE_MARGIN_X

/** The evidence appendix: two photos to a row, each boxed to the same size so the grid lines up. */
const PHOTO_GAP = 14
const PHOTO_CELL = (CONTENT_WIDTH - PHOTO_GAP) / 2
const PHOTO_HEIGHT = 190

pdfmake.addFonts({
  Helvetica: {
    normal: 'Helvetica',
    bold: 'Helvetica-Bold',
    italics: 'Helvetica-Oblique',
    bolditalics: 'Helvetica-BoldOblique'
  }
})

// The inspection report's palette (services/crystalReportPdf.ts).
const INK = C.ink
const MUTED = C.muted
const FAINT = C.muted
const LINE = C.line
const HAIRLINE = C.hair
const HEADER_FILL = C.headBg

const STATUS_COLOR: Record<string, string> = {
  COMPLETED: C.pass,
  MISSED: C.fail,
  EXCEPTION: C.warn
}

/** Status is only Completed, Missed or Exception; a check not finished yet shows a dash. */
const STATUS_LABEL: Record<string, string> = {
  COMPLETED: 'Completed',
  MISSED: 'Missed',
  EXCEPTION: 'Exception'
}

const CELL_PAD = 3
/** Tables have horizontal rules only, as in the inspection report. */
const V_LINE = 0

/**
 * How much width a grid table's columns may actually declare.
 *
 * pdfmake treats `widths` as *content* widths and adds the cell padding and the
 * vertical rules on top, so a table with N columns really occupies
 * `sum(widths) + N * (2 * CELL_PAD + V_LINE) + V_LINE`. Ignoring that is what pushes a
 * table past the right margin: pdfmake never shrinks columns, it just runs off the page.
 */
const tableBudget = (columns: number) => CONTENT_WIDTH - columns * (2 * CELL_PAD + V_LINE) - V_LINE

/**
 * Column widths for a grid table, checked against the A4 portrait budget. A warning here
 * means the table would print past the margin and the widths need trimming.
 */
function gridWidths(widths: (number | '*')[]): (number | '*')[] {
  const fixed = widths.reduce<number>((sum, w) => sum + (typeof w === 'number' ? w : 0), 0)
  const budget = tableBudget(widths.length)
  if (fixed > budget) {
    console.warn(
      `Report table is too wide for A4 portrait: ${widths.length} columns declare ${fixed}pt, ${budget.toFixed(1)}pt available.`
    )
  }
  return widths
}

/** The inspection report's table: grey header band, horizontal hairlines, no vertical rules. */
const tableLayout = {
  hLineWidth: (i: number, node: { table: { body: unknown[]; headerRows?: number } }) =>
    i === 0 || i === node.table.body.length ? 0.8 : i === (node.table.headerRows ?? 1) ? 0.8 : 0.5,
  vLineWidth: () => V_LINE,
  hLineColor: (i: number, node: { table: { body: unknown[]; headerRows?: number } }) =>
    i === 0 || i === node.table.body.length || i === (node.table.headerRows ?? 1) ? LINE : HAIRLINE,
  fillColor: (rowIndex: number, node: { table: { headerRows?: number } }) =>
    rowIndex < (node.table.headerRows ?? 1) ? HEADER_FILL : null,
  paddingLeft: () => CELL_PAD,
  paddingRight: () => CELL_PAD,
  paddingTop: () => 4,
  paddingBottom: () => 4
}

/** Borderless layout for the meta and summary blocks. */
const plainLayout = {
  hLineWidth: () => 0,
  vLineWidth: () => 0,
  paddingLeft: () => 0,
  paddingRight: () => 8,
  paddingTop: () => 1.5,
  paddingBottom: () => 1.5
}

/** A numbered section title in the brand colour, as in the inspection report; never left alone at a page bottom. */
const section = (number: number | string, title: string, note?: string): Content => ({
  stack: [
    { text: `${number}.  ${title.toUpperCase()}`, style: 'sectionTitle' },
    ...(note ? [{ text: note, style: 'note', margin: [0, 2, 0, 0] as [number, number, number, number] }] : [])
  ],
  margin: [0, 16, 0, 6],
  headlineLevel: 1
})

/** Label / value pairs, two to a row on hairlines: the inspection report's "Inspection details". */
function detailsGrid(pairs: [string, string | TableCell][]): Content {
  const body: TableCell[][] = []
  for (let i = 0; i < pairs.length; i += 2) {
    body.push(
      [pairs[i], pairs[i + 1]].flatMap((pair): TableCell[] =>
        pair ? [{ text: pair[0], style: 'metaLabel' }, typeof pair[1] === 'string' ? { text: pair[1] || '—', color: INK } : pair[1]] : [{ text: '' }, { text: '' }]
      )
    )
  }
  return {
    table: { widths: [62, '*', 62, '*'], body },
    layout: {
      hLineWidth: (i: number, node: { table: { body: unknown[] } }) => (i === 0 || i === node.table.body.length ? 0.8 : 0.5),
      vLineWidth: () => 0,
      hLineColor: (i: number, node: { table: { body: unknown[] } }) => (i === 0 || i === node.table.body.length ? LINE : HAIRLINE),
      paddingLeft: (i: number) => (i === 0 ? 0 : 6),
      paddingRight: () => 6,
      paddingTop: () => 3,
      paddingBottom: () => 3
    }
  }
}

/** Table header cells: small grey capitals on the grey band. */
const header = (cells: string[]): TableCell[] => cells.map((text) => ({ text: text.toUpperCase(), style: 'th' }))

const statusText = (status: string): Content =>
  STATUS_LABEL[status]
    ? { text: STATUS_LABEL[status], color: STATUS_COLOR[status] ?? INK, bold: true }
    : { text: '—', color: FAINT }


const empty = (text: string): Content => ({ text, style: 'note', margin: [0, 2, 0, 6] })

/**
 * Two related fields in one column, e.g. machine name over machine code. This is how
 * the wide tables are made to fit A4 portrait without dropping any information.
 */
const pair = (main: string, sub: string): TableCell => ({
  stack: [{ text: main }, { text: sub, style: 'sub' }]
})

/** Date over time, so a timestamp needs one narrow column instead of two. */
const when = (value: Date | null): TableCell => ({
  stack: [{ text: formatDate(value) }, { text: formatTime(value), style: 'sub' }]
})

/**
 * A check code on a single line so it stays searchable in the finished PDF.
 * Codes are QC-YYYYMMDD-XXXXXXXX (20 characters), which needs ~70pt at 6pt Helvetica.
 */
const codeCell = (code: string): TableCell => ({ text: code, fontSize: 6, color: FAINT, noWrap: true })
const CODE_WIDTH = 80

/** Small horizontal bar, used for the status breakdown and the trend charts. */
function bar(percent: number, width = 90, color: string = C.brand): Content {
  const filled = Math.max(0, Math.min(100, percent)) / 100
  return {
    canvas: [
      { type: 'rect', x: 0, y: 1, w: width, h: 5, r: 2.5, color: C.hair },
      ...(filled > 0 ? [{ type: 'rect' as const, x: 0, y: 1, w: Math.max(5, width * filled), h: 5, r: 2.5, color }] : [])
    ]
  }
}

function groupTable(rows: GroupRow[], firstColumn: string, extra: { lastCheck?: boolean } = {}): Content {
  if (rows.length === 0) return empty('No records in this period.')
  // 7 columns, 478.1pt to share.
  const widths = gridWidths(extra.lastCheck ? ['*', 44, 50, 42, 50, 50, 80] : ['*', 44, 50, 42, 50, 50, '*'])
  const head = extra.lastCheck
    ? ['Worker / Employee ID', 'Sched.', 'Completed', 'Missed', 'Exception', 'Compl. %', 'Last check']
    : [firstColumn, 'Sched.', 'Completed', 'Missed', 'Exception', 'Compl. %', 'Remarks']

  return {
    table: {
      headerRows: 1,
      keepWithHeaderRows: 1,
      dontBreakRows: true,
      widths,
      body: [
        header(head),
        ...rows.map((r) => [
          {
            stack: [
              { text: r.label, bold: true },
              ...(r.sublabel ? [{ text: r.sublabel, style: 'sub' }] : [])
            ]
          },
          { text: String(r.counts.scheduled), alignment: 'center' as const },
          { text: String(r.counts.completed), alignment: 'center' as const },
          { text: String(r.counts.missed), alignment: 'center' as const, color: r.counts.missed ? C.fail : INK },
          { text: String(r.counts.exception), alignment: 'center' as const, color: r.counts.exception ? C.warn : INK },
          { text: percentText(r.completionRate), alignment: 'right' as const },
          extra.lastCheck ? { text: formatDateTime(r.lastCheckAt) } : { text: r.remark, style: 'sub' }
        ])
      ]
    },
    layout: tableLayout
  }
}

function parameterTable(rows: ParameterRow[]): Content {
  return {
    table: {
      headerRows: 1,
      keepWithHeaderRows: 1,
      dontBreakRows: true,
      widths: gridWidths(['*', 56, 100, 40, 44, 44, 46]),
      body: [
        header(['Parameter', 'Actual', 'Standard / Acceptance', 'Unit', 'Min', 'Max', 'Reading']),
        ...rows.map((p) => [
          { text: p.name },
          // An N/A has no reading; its reason is printed in the Standard column below the rule.
          { text: p.value, alignment: 'right' as const, bold: true, color: p.notApplicable ? MUTED : INK },
          p.notApplicable
            ? {
                stack: [
                  { text: p.standard },
                  { text: `N/A: ${p.naReason}${p.naRemark !== '-' ? ` — ${p.naRemark}` : ''}`, style: 'sub' }
                ]
              }
            : { text: p.standard },
          { text: p.unit, alignment: 'center' as const },
          { text: p.min, alignment: 'center' as const },
          { text: p.max, alignment: 'center' as const },
          {
            text: p.notApplicable ? 'Not applicable' : p.result === 'NA' ? 'No limit' : p.result,
            alignment: 'center' as const,
            bold: !p.notApplicable && p.result !== 'NA',
            color: p.result === 'FAIL' ? C.fail : p.result === 'PASS' ? C.pass : FAINT
          }
        ])
      ]
    },
    layout: tableLayout,
    margin: [0, 3, 0, 0]
  }
}

/** Reads an image from disk as a data URL. Returns null when it is missing or not an image. */
function imageData(filePath: string): string | null {
  try {
    const ext = path.extname(filePath).toLowerCase()
    if (!['.jpg', '.jpeg', '.png'].includes(ext)) return null
    const file = fs.readFileSync(filePath)
    const mime = ext === '.png' ? 'image/png' : 'image/jpeg'
    return `data:${mime};base64,${file.toString('base64')}`
  } catch {
    return null
  }
}

const MAX_EVIDENCE_IMAGES = 40

const longDate = (d: Date) => formatDate(d)

/** "01/09/2026 – 15/09/2026", or a single date when the report covers one day. */
function longPeriod(from: Date, to: Date) {
  return dateKey(from) === dateKey(to) ? longDate(from) : `${longDate(from)} – ${longDate(to)}`
}

const NONE = '(none)'
/** Pass/Fail and Yes/No readings as words ("Pass", "No"); other readings unchanged. */
const readingText = (value: string) => (/^(PASS|FAIL|YES|NO)$/.test(value) ? value[0] + value.slice(1).toLowerCase() : value)
const listText = (values: string[]) => (values.filter(Boolean).length ? values.filter(Boolean).join(', ') : NONE)
const countCell = (n: number, color?: string): TableCell => ({ text: String(n), alignment: 'center', color: n && color ? color : INK })

/** Per Item Code or per PO No.: checks, results, readings, changes, who and where. */
function traceGroupTable(rows: TraceGroup[], first: 'Item Code' | 'PO No.'): Content {
  if (rows.length === 0) return empty('No records.')
  const other = first === 'Item Code' ? 'PO Nos.' : 'Item Codes'
  return {
    table: {
      headerRows: 1,
      keepWithHeaderRows: 1,
      dontBreakRows: true,
      // 10 columns: 356 fixed leaves the rest for workers / machines.
      widths: gridWidths([58, 58, 30, 34, 30, 34, 36, 36, 40, '*']),
      body: [
        header([first, other, 'Checks', 'Compl.', 'Missed', 'Except.', 'Outside limits', 'Changes / Corr.', 'First / Last', 'Workers / Machines']),
        ...rows.map((r) => [
          { text: r.key || NONE, bold: true },
          { text: listText(first === 'Item Code' ? r.jobNos : r.itemCodes), style: 'sub' },
          countCell(r.checks),
          countCell(r.completed),
          countCell(r.missed, C.fail),
          countCell(r.exceptions, C.warn),
          { text: `${r.outsideLimits} of ${r.readings}`, alignment: 'center' as const, color: r.outsideLimits ? C.fail : INK },
          { text: `${r.changes} / ${r.corrections}`, alignment: 'center' as const },
          { stack: [{ text: formatDateTime(r.firstAt), style: 'sub' }, { text: formatDateTime(r.lastAt), style: 'sub' }] },
          { stack: [{ text: listText(r.workers) }, { text: listText(r.machines), style: 'sub' }] }
        ])
      ]
    },
    layout: tableLayout
  }
}

/** The four traceability sections: Item Codes, PO Nos., workers with their items, changes. */
function traceSections(trace: TraceReport): Content[] {
  const c = trace.counts
  return [
    { text: '', pageBreak: 'before' },
    section(
      '8.1',
      'Item Code Traceability',
      `${c.checks} checks · ${c.completed} completed · ${c.missed} missed · ${c.exceptions} exception · ${c.readings} readings (${c.outsideLimits} outside limits, ${c.notApplicable} not applicable) · ${c.changes} changes, ${c.corrections} corrections.`
    ),
    traceGroupTable(trace.items, 'Item Code'),
    section('8.2', 'PO No. Traceability'),
    traceGroupTable(trace.jobs, 'PO No.'),
    section('8.3', 'Worker Activity by Item Code', 'Checks are counted for the worker who submitted them, or the worker they were assigned to.'),
    ...(trace.workers.length === 0
      ? [empty('No records.')]
      : trace.workers.map(
          (w): Content => ({
            margin: [0, 4, 0, 4],
            stack: [
              {
                text: [
                  { text: w.name, bold: true },
                  { text: `${w.employeeId ? `  ${w.employeeId}` : ''}  ·  ${w.checks} checks, ${w.completed} completed, ${w.missed} missed, ${w.exceptions} exception, ${w.changes} changes (${w.corrections} corrections)  ·  ${listText(w.machines)}`, style: 'sub' }
                ],
                margin: [0, 0, 0, 3]
              },
              {
                table: {
                  headerRows: 1,
                  dontBreakRows: true,
                  widths: gridWidths([90, '*', 40, 44, 40, 44, 44]),
                  body: [
                    header(['Item Code', 'PO Nos.', 'Checks', 'Completed', 'Missed', 'Exception', 'Changes']),
                    ...w.items.map((i) => [
                      { text: i.itemCode || NONE, bold: true },
                      { text: listText(i.jobNos) },
                      countCell(i.checks),
                      countCell(i.completed),
                      countCell(i.missed, C.fail),
                      countCell(i.exceptions, C.warn),
                      countCell(i.changes)
                    ])
                  ]
                },
                layout: tableLayout
              }
            ]
          })
        )),
    section(
      '8.4',
      'Changes and Corrections',
      'A change is a reading that differs from the previous reading of the same parameter for the same item, job and machine. A correction is a change from outside limits back within limits.'
    ),
    trace.changes.length === 0
      ? empty('No reading changed in this period.')
      : {
          table: {
            headerRows: 1,
            keepWithHeaderRows: 1,
            dontBreakRows: true,
            widths: gridWidths([40, 58, 64, 56, '*', 70, 58]),
            body: [
              header(['Date / Time', 'Machine', 'Item / PO No.', 'Parameter', 'Change', 'Type', 'By / Previous']),
              ...trace.changes.map((ch) => [
                when(ch.at),
                pair(ch.machineName, ch.machineCode),
                pair(ch.itemCode || NONE, ch.jobNo || NONE),
                { text: ch.parameterName },
                {
                  stack: [
                    { text: `${readingText(ch.from)}${ch.unit ? ` ${ch.unit}` : ''} → ${readingText(ch.to)}${ch.unit ? ` ${ch.unit}` : ''}` },
                    { text: `${ch.fromResult} → ${ch.toResult}`, style: 'sub' }
                  ]
                },
                {
                  text: ch.correction ? 'Correction' : ch.wentOutside ? 'Went outside limits' : 'Change',
                  bold: ch.correction || ch.wentOutside,
                  color: ch.correction ? C.pass : ch.wentOutside ? C.fail : INK
                },
                pair(ch.byName, `after ${ch.previousByName}, ${formatDateTime(ch.previousAt)}`)
              ])
            ]
          },
          layout: tableLayout
        }
  ]
}

export function buildReportDocument(report: QualityReport): TDocumentDefinitions {
  const { meta, counts } = report
  const period = `${formatDate(meta.periodFrom)} – ${formatDate(meta.periodTo)}`

  // The report's identity, in the title block's right column (as the inspection report).
  const metaRows: [string, string][] = [
    ['Report ID', meta.reportId],
    ['Generated On', formatDateTime(meta.generatedAt)],
    ['Reporting Period', period],
    ['Prepared By', meta.preparedBy],
    ['Department', meta.department],
    ['Report Status', meta.status]
  ]
  const logo = logoDataUri()
  const m = (t: number, b = 0): [number, number, number, number] => [0, t, 0, b]

  const content: Content[] = [
    // 1. Report header: logo, company, title and period on the left; the report's identity on the right.
    {
      columns: [
        ...(logo ? [{ width: 46, stack: [{ image: logo, width: 36, height: 36, margin: m(1) }] }] : []),
        {
          width: '*',
          stack: [
            { text: meta.company.toUpperCase(), style: 'company' },
            ...(meta.plant ? [{ text: meta.plant, style: 'sub' }] : []),
            { text: 'Quality Monitoring Report', style: 'title', margin: m(1) },
            { text: 'Production Quality Check & Compliance Report', style: 'subtitle' },
            { text: `Quality Report: ${longPeriod(meta.periodFrom, meta.periodTo)}`, style: 'periodLine' }
          ]
        },
        {
          width: 210,
          table: {
            widths: [62, '*'],
            body: metaRows.map(([label, value]) => [
              { text: label, style: 'metaLabel' },
              { text: value, style: 'metaValue', alignment: 'right' as const }
            ])
          },
          layout: { hLineWidth: () => 0, vLineWidth: () => 0, paddingLeft: () => 0, paddingRight: () => 0, paddingTop: () => 1, paddingBottom: () => 1 }
        }
      ]
    },
    { canvas: [{ type: 'line', x1: 0, y1: 8, x2: CONTENT_WIDTH, y2: 8, lineWidth: 1.5, lineColor: C.brand }], margin: m(0, 4) },
    ...(meta.filters.length
      ? [
          {
            margin: m(6),
            table: {
              widths: [66, '*'],
              body: [[{ text: 'FILTERS APPLIED', style: 'summaryLabel', margin: m(1) }, { text: meta.filters.join(' · '), style: 'metaValue' }]]
            },
            layout: { hLineWidth: () => 0, vLineWidth: () => 0, fillColor: () => C.band, paddingLeft: () => 10, paddingRight: () => 10, paddingTop: () => 5, paddingBottom: () => 5 }
          } as Content
        ]
      : []),

    // 2. Executive summary: the figures in three strips, as the inspection report's summary.
    section(2, 'Executive Summary'),
    {
      stack: [
        figureStrip([
          { label: 'Scheduled', value: String(counts.scheduled) },
          { label: 'Completed', value: String(counts.completed), color: C.pass },
          { label: 'Missed', value: String(counts.missed), color: counts.missed ? C.fail : INK },
          { label: 'Exception', value: String(counts.exception), color: counts.exception ? C.warn : INK }
        ]),
        { ...(figureStrip([
          { label: 'Open (Not Finished)', value: String(counts.open) },
          { label: 'Completion Rate', value: percentText(report.completionRate) },
          { label: 'Readings Within Limits', value: `${report.readings.withinLimits} of ${report.readings.recorded}` },
          { label: 'Readings Outside Limits', value: String(report.readings.outsideLimits), color: report.readings.outsideLimits ? C.fail : INK }
        ]) as object), margin: m(4) } as Content,
        { ...(figureStrip([
          { label: 'Not Applicable Parameters', value: String(report.notApplicable.total) },
          { label: 'Checks With N/A', value: String(report.notApplicable.checks) },
          { label: 'Submitted On Notification', value: String(report.submissionTypes.notification) },
          { label: 'Started Manually', value: String(report.submissionTypes.manual) }
        ]) as object), margin: m(4) } as Content
      ]
    },
    {
      style: 'note',
      margin: [0, 6, 0, 0],
      stack: [
        {
          text: [
            { text: 'Completion Rate', bold: true },
            ` = Completed ÷ Scheduled. The Result only tracks whether the worker did the scheduled check: `,
            { text: 'Completed', bold: true },
            ' — photo/video and form submitted; ',
            { text: 'Missed', bold: true },
            ' — not completed or submitted within the required time; ',
            { text: 'Exception', bold: true },
            ' — check could not be done, exception details and photo/video submitted.'
          ]
        },
        {
          text: `Parameter readings are separate recorded data and do not change the Result: a check with a reading outside its limits is still Completed.`,
          margin: [0, 2, 0, 0]
        },
        {
          text: `A parameter marked Not Applicable carries no reading and is never counted as a failure; the reason the worker gave is printed with the check.`,
          margin: [0, 2, 0, 0]
        },
        {
          text: `Reconciliation: Scheduled ${counts.scheduled} = Completed ${counts.completed} + Missed ${counts.missed} + Exception ${counts.exception} + Open ${counts.open}${report.reconciles ? '' : '  (MISMATCH — please report this)'}`,
          margin: [0, 2, 0, 0],
          color: report.reconciles ? FAINT : C.fail
        }
      ]
    },

    // 3. Check status breakdown
    section(3, 'Check Result Breakdown'),
    {
      table: {
        headerRows: 1,
        keepWithHeaderRows: 1,
        dontBreakRows: true,
        widths: gridWidths([120, 44, 44, 100, '*']),
        body: [
          header(['Result', 'Count', 'Share', 'Distribution', '']),
          ...report.breakdown.map((b) => [
            { text: b.label },
            { text: String(b.count), alignment: 'center' as const },
            { text: `${b.percent}%`, alignment: 'right' as const },
            bar(b.percent, 90, STATUS_COLOR[b.label.toUpperCase().split(' ')[0]] ?? C.muted),
            { text: '' }
          ])
        ]
      },
      layout: tableLayout
    },

    // 4. Department-wise (the Reports page shows it in the PDF only)
    section(4, 'Department-wise Quality Monitoring', 'Each check is counted for the department it was done for.'),
    groupTable(report.byDepartment, 'Department'),

    // 5. Machine-wise
    section(5, 'Machine-wise Quality Monitoring'),
    groupTable(report.byMachine, 'Machine / Code'),

    // 6. Worker-wise
    section(6, 'Worker-wise Monitoring', 'Each check is counted for the worker who submitted it, or the worker it was assigned to.'),
    groupTable(report.byWorker, 'Worker / Employee ID', { lastCheck: true }),

    // 7. Shift-wise
    section(7, 'Shift-wise Summary'),
    groupTable(report.byShift, 'Shift'),

    // 8. Date-wise
    section(8, 'Date-wise Monitoring Summary'),
    groupTable(report.byDate, 'Date')
  ]

  // 8.1–8.4 Traceability, for an Item Code, PO No. or worker report
  if (report.trace) content.push(...traceSections(report.trace))

  // 9. Detailed log — every scheduled check, one row each
  content.push(
    { text: '', pageBreak: 'before' },
    section(9, 'Detailed Quality Check Log', `Every scheduled check in the period (${report.log.length} records).`)
  )
  content.push(
    report.log.length === 0
      ? empty('No scheduled checks in this period.')
      : {
          table: {
            headerRows: 1,
            keepWithHeaderRows: 1,
            dontBreakRows: true,
            // 9 columns, 461.3pt to share: 394 fixed leaves 67pt for the remarks column.
            widths: gridWidths([CODE_WIDTH, 44, 44, 60, 54, 56, 24, 40, '*']),
            body: [
              header([
                'Check ID',
                'Scheduled',
                'Completed',
                'Machine / Code',
                'Check Type',
                'Worker / Emp. ID',
                'Shift',
                'Status',
                'Exception / Remarks'
              ]),
              ...report.log.map((row) => [
                codeCell(row.code),
                when(row.scheduledAt),
                when(row.submittedAt),
                pair(row.machineName, row.machineCode),
                { text: row.activityName },
                pair(row.workerName, row.workerEmployeeId),
                { text: row.shiftName },
                statusText(row.status),
                { stack: [{ text: row.exception, style: 'sub' }, { text: row.remarks, style: 'sub' }] }
              ])
            ]
          },
          layout: tableLayout
        }
  )

  // 10. Completed check details (the readings the worker recorded)
  content.push(
    section(
      10,
      'Completed Check Details',
      'Parameters are those configured for each check type at the time of submission.'
    )
  )
  if (report.completedDetails.length === 0) {
    content.push(empty('No checks were performed in this period.'))
  } else {
    for (const detail of report.completedDetails) {
      content.push({
        margin: [0, 6, 0, 0],
        unbreakable: true,
        stack: [
          detailsGrid([
            ['Check ID', { text: detail.code, bold: true }],
            ['Machine', `${detail.machineName} (${detail.machineCode})`],
            ['Check Type', detail.activityName],
            ['Status', { text: STATUS_LABEL[detail.status] ?? '—', bold: true, color: STATUS_COLOR[detail.status] ?? INK }],
            ['Checked On', formatDateTime(detail.submittedAt)],
            ['Worker', `${detail.workerName} (${detail.workerEmployeeId})`],
            ['Shift', detail.shiftName],
            ['Item Code', detail.itemCode],
            ['PO No.', detail.jobNo],
            ['Evidence', `${detail.photos} photo${detail.photos === 1 ? '' : 's'}${detail.videos ? `, ${detail.videos} video` : ''}`],
            ['Started By', detail.submissionType],
            ['Not Applicable', detail.notApplicable ? `${detail.notApplicable} parameter${detail.notApplicable === 1 ? '' : 's'}` : 'None']
          ]),
          detail.parameters.length
            ? parameterTable(detail.parameters)
            : { text: 'No parameters were configured for this check type.', style: 'note', margin: [0, 3, 0, 0] }
        ]
      })
    }
  }

  // 11. Missed checks
  content.push(section(11, 'Missed Checks', 'The system does not record a reason for a missed check.'))
  content.push(
    report.missed.length === 0
      ? empty('No missed checks in this period.')
      : {
          table: {
            headerRows: 1,
            keepWithHeaderRows: 1,
            dontBreakRows: true,
            // 8 columns, 471.7pt to share: 372 fixed leaves 100pt for the reason column.
            widths: gridWidths([40, 62, 56, 60, 24, 40, '*', 90]),
            body: [
              header([
                'Scheduled',
                'Machine / Code',
                'Check Type',
                'Assigned Worker',
                'Shift',
                'Status',
                'Reason',
                'Remarks'
              ]),
              ...report.missed.map((m) => [
                when(m.scheduledAt),
                pair(m.machineName, m.machineCode),
                { text: m.activityName },
                { text: m.workerName },
                { text: m.shiftName },
                { text: 'Missed', color: C.fail, bold: true },
                { text: m.reason, style: 'sub' },
                { text: `${m.remarks} · ${m.state}`, style: 'sub' }
              ])
            ]
          },
          layout: tableLayout
        }
  )

  // 12. Exceptions
  content.push(section(12, 'Exception Checks', 'Exceptions are not quality failures; the check could not be performed.'))
  content.push(
    report.exceptions.length === 0
      ? empty('No exceptions in this period.')
      : {
          table: {
            headerRows: 1,
            keepWithHeaderRows: 1,
            dontBreakRows: true,
            // 8 columns, 471.7pt to share: 340 fixed leaves 132pt for the description.
            widths: gridWidths([40, 62, 54, 58, '*', 40, 38, 48]),
            body: [
              header([
                'Raised On',
                'Machine / Check Type',
                'Worker / Shift',
                'Exception Type',
                'Description',
                'Evidence',
                'Status',
                'Action Taken'
              ]),
              ...report.exceptions.map((e) => [
                when(e.submittedAt),
                pair(e.machineName, e.activityName),
                pair(e.workerName, e.shiftName),
                { text: e.reason, color: C.warn, bold: true },
                { text: e.description },
                { text: e.evidence, style: 'sub' },
                { text: e.status },
                { text: e.action, style: 'sub' }
              ])
            ]
          },
          layout: tableLayout
        }
  )

  // 13. Performance analysis
  content.push(section(13, 'Performance Analysis'))
  content.push({
    ul: report.analysis,
    style: 'body',
    margin: [0, 2, 0, 0]
  })

  // 14. Trends
  const dateRows = report.byDate.filter((d) => d.counts.scheduled > 0)
  const machineRows = report.byMachine.filter((m) => m.counts.scheduled > 0)
  if (dateRows.length >= 2 || machineRows.length >= 2) {
    content.push(section(14, 'Daily and Machine Trend', 'Completion % = completed checks ÷ scheduled checks.'))
    if (dateRows.length >= 2) {
      content.push({ text: 'Daily completion', style: 'h3', margin: [0, 4, 0, 3] })
      content.push({
        table: {
          widths: [70, 44, 120, '*'],
          body: dateRows.map((d) => [
            { text: d.label },
            { text: percentText(d.completionRate), alignment: 'right' as const },
            bar(d.completionRate ?? 0, 110),
            { text: `${d.counts.completed} of ${d.counts.scheduled}`, style: 'sub' }
          ])
        },
        layout: plainLayout
      })
    }
    if (machineRows.length >= 2) {
      content.push({ text: 'Machine-wise completion', style: 'h3', margin: [0, 8, 0, 3] })
      content.push({
        table: {
          widths: [120, 44, 120, '*'],
          body: machineRows.map((m) => [
            { text: m.label },
            { text: percentText(m.completionRate), alignment: 'right' as const },
            bar(m.completionRate ?? 0, 110),
            { text: `${m.counts.completed} of ${m.counts.scheduled}`, style: 'sub' }
          ])
        },
        layout: plainLayout
      })
    }
  }

  // 15. Evidence appendix (kept at the end so the main report stays readable)
  const images = report.evidence.filter((e) => e.kind === 'PHOTO')
  const videos = report.evidence.filter((e) => e.kind === 'VIDEO')
  if (images.length || videos.length) {
    content.push({ text: '', pageBreak: 'before' })
    content.push(
      section(
        15,
        'Evidence Appendix',
        `${images.length} photo${images.length === 1 ? '' : 's'}${videos.length ? ` and ${videos.length} video${videos.length === 1 ? '' : 's'}` : ''} captured in this period.`
      )
    )

    /**
     * Grouped per parameter, with the evidence captured for the whole check as its own group at
     * the end. The photo budget is shared across the groups so the appendix stays a fixed size.
     */
    let budget = MAX_EVIDENCE_IMAGES
    for (const group of report.evidenceGroups) {
      content.push({
        text: `${group.parameterName} — ${group.photos} photo${group.photos === 1 ? '' : 's'}${group.videos ? `, ${group.videos} video${group.videos === 1 ? '' : 's'}` : ''}`,
        style: 'h3',
        margin: [0, 8, 0, 4]
      })
      const groupImages = group.items.filter((e) => e.kind === 'PHOTO')
      const shown = groupImages.slice(0, Math.max(0, budget))
      budget -= shown.length
      /**
       * Two to a row, each in a column of the same width with the photo centred in it, so a
       * portrait and a landscape shot still line up and their captions start on the same line.
       */
      const cells: (Content & { width?: number })[] = []
      for (const item of shown) {
        const data = imageData(item.path)
        cells.push({
          width: PHOTO_CELL,
          unbreakable: true,
          stack: [
            {
              table: {
                widths: ['*'],
                heights: [PHOTO_HEIGHT],
                body: [[
                  data
                    ? { image: data, fit: [PHOTO_CELL - 8, PHOTO_HEIGHT] as [number, number], alignment: 'center' as const }
                    : { text: 'Image file not available on the server', style: 'note', alignment: 'center' as const, margin: [0, PHOTO_HEIGHT / 2 - 6, 0, 0] as [number, number, number, number] }
                ]]
              },
              layout: { hLineWidth: () => 0.5, vLineWidth: () => 0.5, hLineColor: () => HAIRLINE, vLineColor: () => HAIRLINE, fillColor: () => C.band, paddingLeft: () => 0, paddingRight: () => 0, paddingTop: () => 0, paddingBottom: () => 0 }
            },
            { text: item.code, fontSize: 7, bold: true, color: C.brand, alignment: 'center' as const, margin: [0, 4, 0, 0] as [number, number, number, number] },
            { text: `${item.machineName} · ${item.activityName}`, style: 'sub', alignment: 'center' as const },
            { text: `${formatDateTime(item.capturedAt)} · ${item.workerName}`, style: 'sub', alignment: 'center' as const }
          ]
        })
      }
      for (let i = 0; i < cells.length; i += 2) {
        content.push({
          columns: [cells[i], cells[i + 1] ?? { width: PHOTO_CELL, text: '' }],
          columnGap: PHOTO_GAP,
          margin: [0, 0, 0, 14]
        })
      }
      if (groupImages.length > shown.length) {
        content.push({
          text: `${groupImages.length - shown.length} further photo${groupImages.length - shown.length === 1 ? '' : 's'} of this parameter are stored in the system and not reproduced here.`,
          style: 'note'
        })
      }
      const groupVideos = group.videos
      if (groupVideos) {
        content.push({
          text: `${groupVideos} video recording${groupVideos === 1 ? ' is' : 's are'} stored in the system and can be viewed in the Admin panel.`,
          style: 'note',
          margin: [0, 2, 0, 0]
        })
      }
    }
  }

  return {
    pageSize: 'A4',
    pageOrientation: 'portrait',
    pageMargins: [PAGE_MARGIN_X, 40, PAGE_MARGIN_X, 44],
    defaultStyle: { font: 'Helvetica', fontSize: 7.5, color: C.text, lineHeight: 1.2 },
    // A section title never sits alone at the bottom of a page: it moves to the next page when nothing
    // follows it there, or when it starts in the last 12% of the page (no room for its table's first rows).
    pageBreakBefore: (node, queries) =>
      node.headlineLevel === 1 && (queries.getFollowingNodesOnPage().length === 0 || (node.startPosition?.verticalRatio ?? 0) > 0.88),
    info: {
      title: `Quality Monitoring Report ${meta.reportId}`,
      author: meta.company,
      subject: `Quality monitoring ${period}`
    },
    styles: {
      company: { fontSize: 7.5, bold: true, color: C.muted, characterSpacing: 0.8 },
      title: { fontSize: 18, bold: true, color: C.ink },
      subtitle: { fontSize: 9, color: C.muted, margin: [0, 2, 0, 0] },
      periodLine: { fontSize: 9, bold: true, color: C.ink, margin: [0, 3, 0, 0] },
      sectionTitle: { fontSize: 8.5, bold: true, color: C.brand, characterSpacing: 0.6 },
      h3: { fontSize: 8.5, bold: true, color: C.ink },
      // No extra letter spacing: the narrow date columns must fit SCHEDULED and COMPLETED in capitals.
      th: { fontSize: 6.5, bold: true, color: C.muted },
      sub: { fontSize: 6.5, color: C.muted },
      note: { fontSize: 7, color: C.muted },
      body: { fontSize: 8, lineHeight: 1.35 },
      metaLabel: { fontSize: 7.5, color: C.muted },
      metaValue: { fontSize: 8, bold: true, color: C.ink },
      summaryLabel: { fontSize: 6.5, bold: true, color: C.muted, characterSpacing: 0.4 }
    },
    // The inspection report's running header (from page 2) and footer.
    header: (currentPage: number) =>
      currentPage === 1
        ? undefined
        : {
            margin: [PAGE_MARGIN_X, 18, PAGE_MARGIN_X, 0],
            columns: [
              { text: `${meta.company}  ·  Quality Monitoring Report`, fontSize: 7, color: C.faint },
              { text: `${period}  ·  ${meta.reportId}`, fontSize: 7, color: C.faint, alignment: 'right' }
            ]
          },
    footer: (currentPage: number, pageCount: number) => ({
      margin: [PAGE_MARGIN_X, 14, PAGE_MARGIN_X, 0],
      columns: [
        { text: `Report generated on ${formatDateTime(meta.generatedAt)} by the Quality Monitoring System  ·  System Generated Report`, fontSize: 7, color: C.faint },
        { width: 'auto', text: `Page ${currentPage} of ${pageCount}`, fontSize: 7, color: C.muted, alignment: 'right' }
      ]
    }),
    content
  }
}

/** Renders the report and returns the finished PDF. */
export async function renderQualityReport(report: QualityReport): Promise<Buffer> {
  const pdf = pdfmake.createPdf(buildReportDocument(report))
  return pdf.getBuffer() as unknown as Promise<Buffer>
}
