import fs from 'node:fs'
import path from 'node:path'
import pdfmake from 'pdfmake'
import type { Content, TDocumentDefinitions, TableCell } from 'pdfmake/interfaces'
import {
  formatDate,
  formatDateTime,
  formatTime,
  percentText,
  type GroupRow,
  type ParameterRow,
  type QualityReport
} from './reportData'

/**
 * Renders the Quality Monitoring Report.
 *
 * Every page is A4 portrait with the same margins, header and footer — there are no
 * landscape pages. Wide tables are fitted to the portrait width by stacking related
 * fields in one column (machine over code, worker over employee ID, date over time)
 * rather than by rotating the page. Table headers repeat on every page, rows are
 * never split across pages, and every page carries the footer with "Page X of Y".
 */

/** A4 portrait, minus the left and right page margins. Every table must fit inside this. */
const CONTENT_WIDTH = 523

pdfmake.addFonts({
  Helvetica: {
    normal: 'Helvetica',
    bold: 'Helvetica-Bold',
    italics: 'Helvetica-Oblique',
    bolditalics: 'Helvetica-BoldOblique'
  }
})

const INK = '#111827'
const MUTED = '#4B5563'
const FAINT = '#6B7280'
const LINE = '#9CA3AF'
const HAIRLINE = '#D1D5DB'
const HEADER_FILL = '#F3F4F6'

const STATUS_COLOR: Record<string, string> = {
  COMPLETED: '#15803D',
  MISSED: '#B91C1C',
  EXCEPTION: '#B45309'
}

/** Status is only Completed, Missed or Exception; a check not finished yet shows a dash. */
const STATUS_LABEL: Record<string, string> = {
  COMPLETED: 'Completed',
  MISSED: 'Missed',
  EXCEPTION: 'Exception'
}

const CELL_PAD = 3
const V_LINE = 0.4

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

/** Thin corporate table: hairline grid, grey header band, compact padding. */
const tableLayout = {
  hLineWidth: (i: number, node: { table: { body: unknown[]; headerRows?: number } }) =>
    i === 0 || i === node.table.body.length ? 0.8 : i === (node.table.headerRows ?? 1) ? 0.8 : 0.4,
  vLineWidth: () => V_LINE,
  hLineColor: (i: number, node: { table: { body: unknown[]; headerRows?: number } }) =>
    i === 0 || i === node.table.body.length || i === (node.table.headerRows ?? 1) ? LINE : HAIRLINE,
  vLineColor: () => HAIRLINE,
  fillColor: (rowIndex: number, node: { table: { headerRows?: number } }) =>
    rowIndex < (node.table.headerRows ?? 1) ? HEADER_FILL : null,
  paddingLeft: () => CELL_PAD,
  paddingRight: () => CELL_PAD,
  paddingTop: () => 3,
  paddingBottom: () => 3
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

const section = (number: number, title: string, note?: string): Content => ({
  stack: [
    {
      table: {
        widths: ['*'],
        body: [[{ text: `${number}.  ${title.toUpperCase()}`, style: 'sectionTitle', border: [false, false, false, true] }]]
      },
      layout: {
        hLineWidth: () => 0.8,
        vLineWidth: () => 0,
        hLineColor: () => INK,
        paddingLeft: () => 0,
        paddingRight: () => 0,
        paddingTop: () => 0,
        paddingBottom: () => 2
      }
    },
    ...(note ? [{ text: note, style: 'note', margin: [0, 3, 0, 0] as [number, number, number, number] }] : [])
  ],
  margin: [0, 14, 0, 6]
})

const header = (cells: string[]): TableCell[] => cells.map((text) => ({ text, style: 'th' }))

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
function bar(percent: number, width = 90, color = '#374151'): Content {
  const filled = Math.max(0, Math.min(100, percent)) / 100
  return {
    canvas: [
      { type: 'rect', x: 0, y: 0, w: width, h: 5, lineWidth: 0.4, lineColor: HAIRLINE, color: '#F3F4F6' },
      ...(filled > 0 ? [{ type: 'rect' as const, x: 0, y: 0, w: width * filled, h: 5, color }] : [])
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
          { text: String(r.counts.missed), alignment: 'center' as const, color: r.counts.missed ? '#B91C1C' : INK },
          { text: String(r.counts.exception), alignment: 'center' as const, color: r.counts.exception ? '#B45309' : INK },
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
          { text: p.value, alignment: 'right' as const, bold: true },
          { text: p.standard },
          { text: p.unit, alignment: 'center' as const },
          { text: p.min, alignment: 'center' as const },
          { text: p.max, alignment: 'center' as const },
          {
            text: p.result === 'NA' ? 'No limit' : p.result,
            alignment: 'center' as const,
            bold: p.result !== 'NA',
            color: p.result === 'FAIL' ? '#B91C1C' : p.result === 'PASS' ? '#15803D' : FAINT
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

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const longDate = (d: Date) => `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`

/** "01 Sep 2026 – 15 Sep 2026", or a single date when the report covers one day. */
function longPeriod(from: Date, to: Date) {
  return from.toDateString() === to.toDateString() ? longDate(from) : `${longDate(from)} – ${longDate(to)}`
}

export function buildReportDocument(report: QualityReport): TDocumentDefinitions {
  const { meta, counts } = report
  const period = `${formatDate(meta.periodFrom)} – ${formatDate(meta.periodTo)}`

  const metaRows: TableCell[][] = [
    [
      { text: 'Reporting Period', style: 'metaLabel' },
      { text: period, style: 'metaValue' },
      { text: 'Report ID', style: 'metaLabel' },
      { text: meta.reportId, style: 'metaValue' }
    ],
    [
      { text: 'Generated On', style: 'metaLabel' },
      { text: formatDateTime(meta.generatedAt), style: 'metaValue' },
      { text: 'Prepared By', style: 'metaLabel' },
      { text: meta.preparedBy, style: 'metaValue' }
    ],
    [
      { text: 'Department', style: 'metaLabel' },
      { text: meta.department, style: 'metaValue' },
      { text: 'Report Status', style: 'metaLabel' },
      { text: meta.status, style: 'metaValue' }
    ]
  ]
  if (meta.filters.length) {
    metaRows.push([
      { text: 'Filters Applied', style: 'metaLabel' },
      { text: meta.filters.join(' · '), style: 'metaValue', colSpan: 3 },
      {},
      {}
    ])
  }

  const summaryValue = (label: string, value: string, color = INK): TableCell => ({
    stack: [
      { text: label.toUpperCase(), style: 'summaryLabel' },
      { text: value, style: 'summaryValue', color }
    ]
  })

  const content: Content[] = [
    // 1. Report header
    {
      stack: [
        { text: meta.company.toUpperCase(), style: 'company' },
        ...(meta.plant ? [{ text: meta.plant, style: 'sub' }] : []),
        { text: 'QUALITY MONITORING REPORT', style: 'title', margin: [0, 8, 0, 0] as [number, number, number, number] },
        { text: 'Production Quality Check & Compliance Report', style: 'subtitle' },
        { text: `Quality Report: ${longPeriod(meta.periodFrom, meta.periodTo)}`, style: 'periodLine' }
      ]
    },
    {
      table: { widths: [72, '*', 62, '*'], body: metaRows },
      layout: plainLayout,
      margin: [0, 10, 0, 0]
    },
    {
      canvas: [{ type: 'line', x1: 0, y1: 0, x2: CONTENT_WIDTH, y2: 0, lineWidth: 1, lineColor: INK }],
      margin: [0, 8, 0, 0]
    },

    // 2. Executive summary
    section(2, 'Executive Summary'),
    {
      table: {
        widths: ['*', '*', '*', '*'],
        body: [
          [
            summaryValue('Scheduled', String(counts.scheduled)),
            summaryValue('Completed', String(counts.completed), '#15803D'),
            summaryValue('Missed', String(counts.missed), counts.missed ? '#B91C1C' : INK),
            summaryValue('Exception', String(counts.exception), counts.exception ? '#B45309' : INK)
          ],
          [
            summaryValue('Open (Not Finished)', String(counts.open)),
            summaryValue('Completion Rate', percentText(report.completionRate)),
            summaryValue('Readings Within Limits', `${report.readings.withinLimits} of ${report.readings.recorded}`),
            summaryValue(
              'Readings Outside Limits',
              String(report.readings.outsideLimits),
              report.readings.outsideLimits ? '#B91C1C' : INK
            )
          ]
        ]
      },
      layout: {
        ...tableLayout,
        fillColor: () => null,
        paddingLeft: () => 6,
        paddingRight: () => 6,
        paddingTop: () => 5,
        paddingBottom: () => 5
      }
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
          text: `Parameter readings are separate recorded data and do not change the Result: a check with a reading outside its limits is still Completed.${report.readings.checksWithOutside ? ` ${report.readings.checksWithOutside} completed check${report.readings.checksWithOutside === 1 ? ' has' : 's have'} a reading outside limits (section 10).` : ''}`,
          margin: [0, 2, 0, 0]
        },
        {
          text: `Reconciliation: Scheduled ${counts.scheduled} = Completed ${counts.completed} + Missed ${counts.missed} + Exception ${counts.exception} + Open ${counts.open}${report.reconciles ? '' : '  (MISMATCH — please report this)'}`,
          margin: [0, 2, 0, 0],
          color: report.reconciles ? FAINT : '#B91C1C'
        }
      ]
    },

    // 3. Check status breakdown
    section(3, 'Check Result Breakdown'),
    {
      table: {
        headerRows: 1,
        widths: gridWidths([120, 44, 44, 100, '*']),
        body: [
          header(['Result', 'Count', 'Share', 'Distribution', '']),
          ...report.breakdown.map((b) => [
            { text: b.label },
            { text: String(b.count), alignment: 'center' as const },
            { text: `${b.percent}%`, alignment: 'right' as const },
            bar(b.percent, 90, STATUS_COLOR[b.label.toUpperCase().split(' ')[0]] ?? '#374151'),
            { text: '' }
          ])
        ]
      },
      layout: tableLayout
    },

    // 4. Machine-wise
    section(4, 'Machine-wise Quality Monitoring'),
    groupTable(report.byMachine, 'Machine / Code'),

    // 5. Worker-wise
    section(5, 'Worker-wise Monitoring', 'Each check is counted for the worker who submitted it, or the worker it was assigned to.'),
    groupTable(report.byWorker, 'Worker / Employee ID', { lastCheck: true }),

    // 6. Shift-wise
    section(6, 'Shift-wise Summary'),
    groupTable(report.byShift, 'Shift'),

    // 7. Date-wise
    section(7, 'Date-wise Monitoring Summary'),
    groupTable(report.byDate, 'Date')
  ]

  // 8. Detailed log — every scheduled check, one row each
  content.push(
    { text: '', pageBreak: 'before' },
    section(8, 'Detailed Quality Check Log', `Every scheduled check in the period (${report.log.length} records).`)
  )
  content.push(
    report.log.length === 0
      ? empty('No scheduled checks in this period.')
      : {
          table: {
            headerRows: 1,
            keepWithHeaderRows: 1,
            dontBreakRows: true,
            // 9 columns, 465.3pt to share: 386 fixed leaves 79pt for the remarks column.
            widths: gridWidths([CODE_WIDTH, 40, 40, 60, 54, 56, 24, 40, '*']),
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

  // 9. Completed check details (the readings the worker recorded)
  content.push(
    section(
      9,
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
          {
            table: {
              widths: ['*', '*', '*', '*'],
              body: [
                [
                  { text: [{ text: 'Check ID: ', style: 'metaLabel' }, { text: detail.code, bold: true }] },
                  { text: [{ text: 'Machine: ', style: 'metaLabel' }, `${detail.machineName} (${detail.machineCode})`] },
                  { text: [{ text: 'Check Type: ', style: 'metaLabel' }, detail.activityName] },
                  { text: [{ text: 'Status: ', style: 'metaLabel' }, STATUS_LABEL[detail.status] ?? '—'] }
                ],
                [
                  { text: [{ text: 'Checked On: ', style: 'metaLabel' }, formatDateTime(detail.submittedAt)] },
                  { text: [{ text: 'Worker: ', style: 'metaLabel' }, `${detail.workerName} (${detail.workerEmployeeId})`] },
                  { text: [{ text: 'Shift: ', style: 'metaLabel' }, detail.shiftName] },
                  {
                    text: [
                      { text: 'Job No.: ', style: 'metaLabel' },
                      detail.jobNo,
                      { text: '   Evidence: ', style: 'metaLabel' },
                      `${detail.photos} photo${detail.photos === 1 ? '' : 's'}${detail.videos ? `, ${detail.videos} video` : ''}`
                    ]
                  }
                ]
              ]
            },
            layout: plainLayout
          },
          detail.parameters.length
            ? parameterTable(detail.parameters)
            : { text: 'No parameters were configured for this check type.', style: 'note', margin: [0, 3, 0, 0] }
        ]
      })
    }
  }

  // 10. Parameter readings outside limits (recorded data; these checks are still Completed)
  content.push(
    section(
      10,
      'Parameter Readings Outside Limits',
      'Readings recorded outside their acceptance limits. These checks were done and submitted, so their Result stays Completed.'
    )
  )
  content.push(
    report.outOfLimits.length === 0
      ? empty(
          report.readings.recorded
            ? `All ${report.readings.recorded} recorded readings were within limits or had no limits.`
            : 'No parameter readings were recorded in this period.'
        )
      : {
          table: {
            headerRows: 1,
            keepWithHeaderRows: 1,
            dontBreakRows: true,
            widths: gridWidths([CODE_WIDTH, 44, 70, 64, '*', 44]),
            body: [
              header(['Check ID', 'Checked On', 'Machine / Check Type', 'Worker / Shift', 'Readings Outside Limits', 'Result']),
              ...report.outOfLimits.map((o) => [
                codeCell(o.code),
                when(o.submittedAt),
                pair(o.machineName, o.activityName),
                pair(o.workerName, o.shiftName),
                {
                  stack: o.parameters.map((p) => ({
                    text: [
                      { text: `${p.name}: `, bold: true },
                      { text: `${p.value}${p.unit !== '—' ? ` ${p.unit}` : ''}`, color: '#B91C1C', bold: true },
                      { text: `  (limit ${p.standard})`, style: 'sub' }
                    ]
                  }))
                },
                { text: 'Completed', color: '#15803D', bold: true }
              ])
            ]
          },
          layout: tableLayout
        }
  )

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
                { text: 'Missed', color: '#B91C1C', bold: true },
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
                { text: e.reason, color: '#B45309', bold: true },
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

  // 13. Quality issues requiring attention
  content.push(
    section(
      13,
      'Quality Issues Requiring Attention',
      'Missed checks, exception checks and readings outside limits, kept as separate issue types.'
    )
  )
  content.push(
    report.issues.length === 0
      ? empty('No issues recorded in this period.')
      : {
          table: {
            headerRows: 1,
            keepWithHeaderRows: 1,
            dontBreakRows: true,
            // 9 columns, 465.3pt to share: 390 fixed leaves 75pt for the description.
            widths: gridWidths([46, CODE_WIDTH, 40, 58, 50, '*', 40, 44, 40]),
            body: [
              header([
                'Issue Type',
                'Check ID',
                'Date / Time',
                'Machine / Check Type',
                'Worker / Shift',
                'Description',
                'Status',
                'Action / Remarks',
                'CAPA Ref.'
              ]),
              ...report.issues.map((i) => [
                { text: i.type, bold: true, color: STATUS_COLOR[i.type] ?? '#B91C1C' },
                codeCell(i.code),
                when(i.when),
                pair(i.machineName, i.activityName),
                pair(i.workerName, i.shiftName),
                { text: i.description },
                { text: i.status },
                { text: i.action, style: 'sub' },
                { text: i.capa, style: 'sub' }
              ])
            ]
          },
          layout: tableLayout
        }
  )

  // 14. Performance analysis
  content.push(section(14, 'Performance Analysis'))
  content.push({
    ul: report.analysis,
    style: 'body',
    margin: [0, 2, 0, 0]
  })

  // 15. Trends
  const dateRows = report.byDate.filter((d) => d.counts.scheduled > 0)
  const machineRows = report.byMachine.filter((m) => m.counts.scheduled > 0)
  if (dateRows.length >= 2 || machineRows.length >= 2) {
    content.push(section(15, 'Daily and Machine Trend', 'Completion % = completed checks ÷ scheduled checks.'))
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

  // 16. Evidence appendix (kept at the end so the main report stays readable)
  const images = report.evidence.filter((e) => e.kind === 'PHOTO')
  const videos = report.evidence.filter((e) => e.kind === 'VIDEO')
  if (images.length || videos.length) {
    content.push({ text: '', pageBreak: 'before' })
    content.push(
      section(
        16,
        'Evidence Appendix',
        `${images.length} photo${images.length === 1 ? '' : 's'}${videos.length ? ` and ${videos.length} video${videos.length === 1 ? '' : 's'}` : ''} captured in this period.`
      )
    )

    const shown = images.slice(0, MAX_EVIDENCE_IMAGES)
    const cells: Content[] = []
    for (const item of shown) {
      const data = imageData(item.path)
      cells.push({
        unbreakable: true,
        stack: [
          data
            ? { image: data, fit: [235, 175] as [number, number] }
            : { text: 'Image file not available on the server', style: 'note' },
          { text: item.code, style: 'sub', bold: true, margin: [0, 3, 0, 0] as [number, number, number, number] },
          { text: `${item.machineName} · ${item.activityName}`, style: 'sub' },
          { text: `${formatDateTime(item.capturedAt)} · ${item.workerName}`, style: 'sub' }
        ]
      })
    }
    for (let i = 0; i < cells.length; i += 2) {
      content.push({
        columns: [cells[i], cells[i + 1] ?? { text: '' }],
        columnGap: 14,
        margin: [0, 0, 0, 12]
      })
    }
    if (images.length > shown.length) {
      content.push({
        text: `${images.length - shown.length} further photo${images.length - shown.length === 1 ? '' : 's'} are stored in the system and not reproduced here.`,
        style: 'note'
      })
    }
    if (videos.length) {
      content.push({
        text: `${videos.length} video recording${videos.length === 1 ? ' is' : 's are'} stored in the system and can be viewed in the Admin panel.`,
        style: 'note',
        margin: [0, 4, 0, 0]
      })
    }
  }

  // 17. Sign-off
  const signature = (role: string): TableCell => ({
    stack: [
      { text: ' ', margin: [0, 16, 0, 0] as [number, number, number, number] },
      { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 150, y2: 0, lineWidth: 0.6, lineColor: LINE }] },
      { text: role, style: 'sub', margin: [0, 3, 0, 0] as [number, number, number, number] }
    ]
  })
  content.push(section(17, 'Sign-off'))
  content.push({
    unbreakable: true,
    table: {
      widths: ['*', '*', '*'],
      body: [
        [signature('Prepared By'), signature('Checked By'), signature('Quality HOD')],
        [signature('Date'), signature('Signature'), { text: '' }]
      ]
    },
    layout: plainLayout,
    margin: [0, 4, 0, 0]
  })

  return {
    pageSize: 'A4',
    pageOrientation: 'portrait',
    pageMargins: [36, 40, 36, 46],
    defaultStyle: { font: 'Helvetica', fontSize: 7.5, color: INK, lineHeight: 1.15 },
    info: {
      title: `Quality Monitoring Report ${meta.reportId}`,
      author: meta.company,
      subject: `Quality monitoring ${period}`
    },
    styles: {
      company: { fontSize: 12, bold: true, characterSpacing: 0.4 },
      title: { fontSize: 16, bold: true, characterSpacing: 0.6 },
      subtitle: { fontSize: 9, color: MUTED, margin: [0, 2, 0, 0] },
      periodLine: { fontSize: 10, bold: true, margin: [0, 6, 0, 0] },
      sectionTitle: { fontSize: 9.5, bold: true, characterSpacing: 0.5 },
      h3: { fontSize: 8.5, bold: true },
      th: { fontSize: 7, bold: true, color: MUTED, characterSpacing: 0.3 },
      sub: { fontSize: 6.5, color: FAINT },
      note: { fontSize: 7, color: MUTED },
      body: { fontSize: 8, lineHeight: 1.3 },
      metaLabel: { fontSize: 7, color: FAINT },
      metaValue: { fontSize: 8, bold: true },
      summaryLabel: { fontSize: 6.5, color: FAINT, characterSpacing: 0.4 },
      summaryValue: { fontSize: 14, bold: true, margin: [0, 2, 0, 0] }
    },
    header: (currentPage: number) =>
      currentPage === 1
        ? undefined
        : {
            margin: [36, 18, 36, 0],
            columns: [
              { text: 'Quality Monitoring Report', fontSize: 7, bold: true, color: MUTED },
              { text: `${period}  ·  ${meta.reportId}`, fontSize: 7, color: FAINT, alignment: 'right' }
            ]
          },
    footer: (currentPage: number, pageCount: number) => ({
      margin: [36, 8, 36, 0],
      stack: [
        { canvas: [{ type: 'line', x1: 0, y1: 0, x2: CONTENT_WIDTH, y2: 0, lineWidth: 0.5, lineColor: HAIRLINE }] },
        {
          margin: [0, 4, 0, 0],
          columns: [
            {
              width: '*',
              stack: [
                { text: meta.company, fontSize: 6.5, bold: true, color: MUTED },
                { text: 'Quality Monitoring System  ·  System Generated Report', fontSize: 6.5, color: FAINT }
              ]
            },
            {
              width: 'auto',
              alignment: 'right',
              stack: [
                { text: `Report generated on ${formatDateTime(meta.generatedAt)}`, fontSize: 6.5, color: FAINT },
                { text: `Page ${currentPage} of ${pageCount}`, fontSize: 6.5, bold: true, color: MUTED }
              ]
            }
          ]
        }
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
