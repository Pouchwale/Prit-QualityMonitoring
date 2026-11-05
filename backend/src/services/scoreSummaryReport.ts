import pdfmake from 'pdfmake'
import type { Content, TDocumentDefinitions, TableCell } from 'pdfmake/interfaces'
import { and, asc, eq, gte, isNotNull, lt, sql, type SQL } from 'drizzle-orm'
import { db } from '../db/client'
import { activities, jobs, machines, qualityChecks, shifts, users } from '../db/schema'
import { addDays, dateKey, formatDateKey, formatLocalDate, formatLocalTime } from '../lib/time'
import { rate, scoreOf } from './performance'
import { getCompanyPlantName } from './automatedReports'
import { C, figureStrip, logoDataUri } from './crystalReportPdf'

pdfmake.addFonts({
  Helvetica: { normal: 'Helvetica', bold: 'Helvetica-Bold', italics: 'Helvetica-Oblique', bolditalics: 'Helvetica-BoldOblique' }
})

/**
 * Worker Score Report (Reports → Score Summary): each worker's score and the tasks behind it, for a
 * period, optionally one worker. Text only: no photos.
 *
 * The score is the Performance page's (services/performance.ts), so every number matches it:
 *   assigned   = tasks whose time is over: completed + exceptions + missed
 *   missed     = marked Missed, or still open after its window closed
 *   completion = (completed + exceptions) ÷ assigned, as a whole percentage
 *   score      = completion − 100: 0 is every task done, −100 is none done
 * Each assigned task is worth 100 ÷ assigned points: a missed task deducts that, a completed or
 * exception task keeps it. Tasks still inside their window are pending and not counted yet; tasks
 * excused by an approved machine breakdown, Late Entry or Early Exit are never counted.
 */

/** A check submitted at least this long after its scheduled time is shown as late (as in the Missed Tasks Report). */
const LATE_AFTER_MS = 60_000

export type TaskOutcome = 'COMPLETED' | 'EXCEPTION' | 'MISSED'

export interface ScoreTask {
  id: string
  code: string
  task: string
  machine: string | null
  shift: string | null
  jobNo: string | null
  scheduledAt: Date
  /** End of the window to submit it: a missed task was not submitted by then. */
  dueBy: Date | null
  submittedAt: Date | null
  outcome: TaskOutcome
  /** Completed or exception tasks submitted a minute or more after their time; null otherwise. */
  lateMinutes: number | null
  /** Its effect on the score: +points kept (done) or −points deducted (missed), 2 decimals. */
  points: number
}

export interface WorkerScore {
  workerId: string
  name: string
  employeeId: string
  assigned: number
  completed: number
  exceptions: number
  missed: number
  /** Still inside their window: not counted yet. */
  pending: number
  /** Whole %. */
  completionRate: number
  /** Points one task is worth: 100 ÷ assigned (2 decimals; 0 without assigned tasks). */
  pointsPerTask: number
  /** Points lost to missed tasks: missed × points per task (2 decimals). */
  deduction: number
  /** The final score, as on the Performance page. */
  score: number
  /** Only with details: missed tasks, then completed and exception tasks, each in time order. */
  missedTasks?: ScoreTask[]
  completedTasks?: ScoreTask[]
}

export interface ScoreReport {
  /** Inclusive dates, YYYY-MM-DD (plant time). */
  from: string
  to: string
  /** The worker the report was filtered to; null for all workers. */
  worker: { id: string; name: string; employeeId: string } | null
  totals: { workers: number; assigned: number; completed: number; exceptions: number; missed: number; pending: number; completionRate: number; score: number }
  /** Lowest score first. */
  workers: WorkerScore[]
}

const round2 = (n: number) => Math.round(n * 100) / 100

export async function scoreReport(from: Date, to: Date, opts: { where?: SQL; workerId?: string; details?: boolean } = {}): Promise<ScoreReport> {
  const counted = sql<boolean>`(${qualityChecks.status} in ('COMPLETED', 'MISSED', 'EXCEPTION') or ${qualityChecks.windowEndsAt} < now())`
  const conditions: SQL[] = [
    gte(qualityChecks.scheduledAt, from),
    lt(qualityChecks.scheduledAt, to),
    isNotNull(qualityChecks.workerId),
    sql`${qualityChecks.status} <> 'EXCUSED'`
  ]
  if (opts.where) conditions.push(opts.where)
  if (opts.workerId) conditions.push(eq(qualityChecks.workerId, opts.workerId))

  const rows = await db
    .select({
      id: qualityChecks.id,
      workerId: qualityChecks.workerId,
      name: users.name,
      employeeId: users.employeeId,
      code: qualityChecks.code,
      task: activities.name,
      machineName: machines.name,
      machineCode: machines.code,
      shift: shifts.name,
      jobNo: sql<string | null>`coalesce(nullif(trim(${qualityChecks.jobNo}), ''), ${jobs.jobNo})`,
      status: qualityChecks.status,
      scheduledAt: qualityChecks.scheduledAt,
      dueBy: qualityChecks.windowEndsAt,
      submittedAt: qualityChecks.submittedAt,
      counted
    })
    .from(qualityChecks)
    .innerJoin(users, eq(users.id, qualityChecks.workerId))
    .innerJoin(activities, eq(activities.id, qualityChecks.activityId))
    .leftJoin(machines, eq(machines.id, qualityChecks.machineId))
    .leftJoin(shifts, eq(shifts.id, qualityChecks.shiftId))
    .leftJoin(jobs, eq(jobs.id, qualityChecks.jobId))
    .where(and(...conditions))
    .orderBy(asc(qualityChecks.scheduledAt), asc(qualityChecks.code))

  type Acc = WorkerScore & { tasks: (Omit<ScoreTask, 'points'>)[] }
  const byWorker = new Map<string, Acc>()
  for (const r of rows) {
    let w = byWorker.get(r.workerId!)
    if (!w) {
      w = { workerId: r.workerId!, name: r.name, employeeId: r.employeeId, assigned: 0, completed: 0, exceptions: 0, missed: 0, pending: 0, completionRate: 100, pointsPerTask: 0, deduction: 0, score: 0, tasks: [] }
      byWorker.set(r.workerId!, w)
    }
    if (!r.counted) {
      w.pending++
      continue
    }
    w.assigned++
    const outcome: TaskOutcome = r.status === 'COMPLETED' ? 'COMPLETED' : r.status === 'EXCEPTION' ? 'EXCEPTION' : 'MISSED'
    if (outcome === 'COMPLETED') w.completed++
    else if (outcome === 'EXCEPTION') w.exceptions++
    else w.missed++
    const late = outcome !== 'MISSED' && r.submittedAt && r.submittedAt.getTime() - r.scheduledAt.getTime() >= LATE_AFTER_MS
    w.tasks.push({
      id: r.id,
      code: r.code,
      task: r.task,
      machine: r.machineName ? `${r.machineName}${r.machineCode ? ` (${r.machineCode})` : ''}` : null,
      shift: r.shift,
      jobNo: r.jobNo,
      scheduledAt: r.scheduledAt,
      dueBy: r.dueBy,
      submittedAt: outcome === 'MISSED' ? null : r.submittedAt,
      outcome,
      lateMinutes: late ? Math.round((r.submittedAt!.getTime() - r.scheduledAt.getTime()) / 60_000) : null
    })
  }

  const workers: WorkerScore[] = [...byWorker.values()].map(({ tasks, ...w }) => {
    const done = w.completed + w.exceptions
    const pointsPerTask = w.assigned ? round2(100 / w.assigned) : 0
    const out: WorkerScore = {
      ...w,
      completionRate: rate(done, w.assigned),
      pointsPerTask,
      deduction: w.assigned ? round2((w.missed * 100) / w.assigned) : 0,
      score: scoreOf(done, w.assigned)
    }
    if (opts.details) {
      const withPoints = tasks.map((t) => ({ ...t, points: t.outcome === 'MISSED' ? -pointsPerTask : pointsPerTask }))
      out.missedTasks = withPoints.filter((t) => t.outcome === 'MISSED')
      out.completedTasks = withPoints.filter((t) => t.outcome !== 'MISSED')
    }
    return out
  })
  workers.sort((a, b) => a.score - b.score || b.missed - a.missed || a.name.localeCompare(b.name))

  const sum = (k: 'assigned' | 'completed' | 'exceptions' | 'missed' | 'pending') => workers.reduce((n, w) => n + w[k], 0)
  const assigned = sum('assigned')
  const done = sum('completed') + sum('exceptions')
  let worker: ScoreReport['worker'] = null
  if (opts.workerId) {
    const [u] = await db.select({ id: users.id, name: users.name, employeeId: users.employeeId }).from(users).where(eq(users.id, opts.workerId))
    worker = u ?? null
  }
  return {
    from: dateKey(from),
    to: dateKey(addDays(to, -1)),
    worker,
    totals: {
      workers: workers.length,
      assigned,
      completed: sum('completed'),
      exceptions: sum('exceptions'),
      missed: sum('missed'),
      pending: sum('pending'),
      completionRate: rate(done, assigned),
      score: scoreOf(done, assigned)
    },
    workers
  }
}

// ---------------------------------------------------------------------------- PDF

const pts = (n: number) => (n > 0 ? `+${n.toFixed(2)}` : n < 0 ? `-${Math.abs(n).toFixed(2)}` : '0.00')
const scoreColor = (s: number) => (s === 0 ? C.pass : s >= -20 ? C.warn : C.fail)
const lateText = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min late` : `${m} min late`)

const head = (text: string, alignment: 'left' | 'right' | 'center' = 'left'): TableCell => ({ text, bold: true, fontSize: 7.5, color: C.muted, alignment, characterSpacing: 0.3 })
const n = (v: number | string, opts: { color?: string; bold?: boolean } = {}): TableCell => ({ text: String(v), alignment: 'right', color: opts.color ?? C.ink, bold: opts.bold })
const when = (d: Date | null): TableCell => (d ? { stack: [{ text: formatLocalDate(d) }, { text: formatLocalTime(d), color: C.muted, fontSize: 7.5 }] } : { text: '—', color: C.faint })

/** Hairline table: header band, thin lines between rows, optional shaded total row. */
function table(widths: (number | '*')[], body: TableCell[][], totalRow = false): Content {
  const last = body.length - 1
  return {
    table: { headerRows: 1, dontBreakRows: true, widths, body },
    layout: {
      hLineWidth: (i: number) => (i === 1 || (totalRow && i === last) ? 0.8 : i === 0 || i === body.length ? 0 : 0.4),
      hLineColor: (i: number) => (i === 1 || (totalRow && i === last) ? C.line : C.hair),
      vLineWidth: () => 0,
      fillColor: (i: number) => (i === 0 ? C.headBg : totalRow && i === last ? C.band : null),
      paddingTop: () => 4.5,
      paddingBottom: () => 4.5,
      paddingLeft: () => 4,
      paddingRight: () => 4
    },
    fontSize: 8.5
  } as Content
}

const sectionTitle = (text: string, margin: [number, number, number, number] = [0, 18, 0, 6]): Content => ({ text: text.toUpperCase(), fontSize: 9.5, bold: true, color: C.brand, characterSpacing: 0.5, margin })

function workerTable(workers: WorkerScore[], totals: ScoreReport['totals']): Content {
  const body: TableCell[][] = [
    [head('#'), head('WORKER'), head('ASSIGNED', 'right'), head('COMPLETED', 'right'), head('EXCEPTION', 'right'), head('MISSED', 'right'), head('PER TASK', 'right'), head('DEDUCTION', 'right'), head('COMPLETION', 'right'), head('SCORE', 'right')],
    ...workers.map((w, i): TableCell[] => [
      { text: String(i + 1), color: C.muted },
      { stack: [{ text: w.name, bold: true }, { text: w.employeeId, color: C.muted, fontSize: 7.5 }] },
      n(w.assigned),
      n(w.completed, { color: C.pass }),
      n(w.exceptions, { color: w.exceptions ? C.warn : C.faint }),
      n(w.missed, { color: w.missed ? C.fail : C.faint, bold: w.missed > 0 }),
      n(w.pointsPerTask.toFixed(2), { color: C.muted }),
      n(w.deduction ? pts(-w.deduction) : '0.00', { color: w.deduction ? C.fail : C.faint }),
      n(`${w.completionRate}%`),
      n(w.score, { color: scoreColor(w.score), bold: true })
    ])
  ]
  if (workers.length > 1) {
    body.push([
      { text: '' },
      { text: 'All workers', bold: true },
      n(totals.assigned, { bold: true }),
      n(totals.completed, { color: C.pass, bold: true }),
      n(totals.exceptions, { color: C.warn, bold: true }),
      n(totals.missed, { color: totals.missed ? C.fail : C.ink, bold: true }),
      { text: '' },
      { text: '' },
      n(`${totals.completionRate}%`, { bold: true }),
      n(totals.score, { color: scoreColor(totals.score), bold: true })
    ])
  }
  return table([14, '*', 42, 50, 48, 36, 42, 50, 56, 32], body, workers.length > 1)
}

function workerDetail(w: WorkerScore, first: boolean): Content[] {
  const missed = w.missedTasks ?? []
  const done = w.completedTasks ?? []
  const out: Content[] = [
    {
      ...(sectionTitle(`Task details: ${w.name} (${w.employeeId})`, [0, first ? 18 : 0, 0, 6]) as object),
      ...(first ? {} : { pageBreak: 'before' })
    } as Content,
    figureStrip([
      { label: 'Assigned', value: String(w.assigned) },
      { label: 'Completed', value: String(w.completed), color: C.pass },
      { label: 'Exception', value: String(w.exceptions), color: w.exceptions ? C.warn : C.ink },
      { label: 'Missed', value: String(w.missed), color: w.missed ? C.fail : C.ink },
      { label: 'Points per task', value: w.pointsPerTask.toFixed(2) },
      { label: 'Final score', value: String(w.score), color: scoreColor(w.score) }
    ]),
    {
      text: `Score: ${w.completed + w.exceptions} of ${w.assigned} tasks done = ${w.completionRate}% completion; ${w.completionRate}% - 100 = ${w.score}. Each missed task deducted ${w.pointsPerTask.toFixed(2)} points (${w.missed} × ${w.pointsPerTask.toFixed(2)} = ${w.deduction.toFixed(2)}).${w.pending ? ` ${w.pending} task${w.pending === 1 ? ' is' : 's are'} still open and not counted yet.` : ''}`,
      fontSize: 8,
      color: C.muted,
      margin: [0, 6, 0, 0]
    },
    sectionTitle(`Missed tasks (${missed.length})`, [0, 12, 0, 5])
  ]
  out.push(
    missed.length
      ? table(
          [16, 58, 44, '*', 110, 46, 50],
          [
            [head('#'), head('SCHEDULED'), head('DUE BY'), head('TASK'), head('MACHINE'), head('SHIFT'), head('DEDUCTION', 'right')],
            ...missed.map((t, i): TableCell[] => [
              { text: String(i + 1), color: C.muted },
              when(t.scheduledAt),
              { text: t.dueBy ? formatLocalTime(t.dueBy) : '—', color: C.text },
              { stack: [{ text: t.task, bold: true }, { text: [t.code, t.jobNo && `PO ${t.jobNo}`].filter(Boolean).join(' · '), color: C.muted, fontSize: 7 }] },
              { text: t.machine ?? '—' },
              { text: t.shift ?? '—' },
              n(pts(t.points), { color: C.fail, bold: true })
            ]),
            [{ text: '' }, { text: 'Total deduction', bold: true, colSpan: 5 }, {}, {}, {}, {}, n(pts(-w.deduction), { color: C.fail, bold: true })]
          ],
          true
        )
      : { text: 'No missed tasks.', color: C.pass, fontSize: 8.5 }
  )
  out.push(sectionTitle(`Completed tasks (${done.length})`, [0, 14, 0, 5]))
  out.push(
    done.length
      ? table(
          [16, 58, 58, '*', 100, 66, 42],
          [
            [head('#'), head('SCHEDULED'), head('SUBMITTED'), head('TASK'), head('MACHINE'), head('STATUS'), head('EARNED', 'right')],
            ...done.map((t, i): TableCell[] => [
              { text: String(i + 1), color: C.muted },
              when(t.scheduledAt),
              when(t.submittedAt),
              { stack: [{ text: t.task, bold: true }, { text: [t.code, t.jobNo && `PO ${t.jobNo}`].filter(Boolean).join(' · '), color: C.muted, fontSize: 7 }] },
              { text: t.machine ?? '—' },
              {
                stack: [
                  { text: t.outcome === 'EXCEPTION' ? 'Exception' : 'Completed', bold: true, color: t.outcome === 'EXCEPTION' ? C.warn : C.pass },
                  { text: t.lateMinutes !== null ? lateText(t.lateMinutes) : 'On time', color: t.lateMinutes !== null ? C.warn : C.muted, fontSize: 7 }
                ]
              },
              n(pts(t.points), { color: C.pass, bold: true })
            ]),
            [{ text: '' }, { text: 'Total earned', bold: true, colSpan: 5 }, {}, {}, {}, {}, n(pts(round2((done.length * 100) / w.assigned)), { color: C.pass, bold: true })]
          ],
          true
        )
      : { text: 'No completed tasks.', color: C.muted, fontSize: 8.5 }
  )
  return out
}

/** The report as an A4 PDF: score summary, worker scores, then each worker's missed and completed tasks. */
export async function renderScoreReportPdf(report: ScoreReport, generatedBy: string): Promise<Buffer> {
  const { company, plant } = await getCompanyPlantName()
  const period = report.from === report.to ? formatDateKey(report.from) : `${formatDateKey(report.from)} – ${formatDateKey(report.to)}`
  const scope = report.worker ? `${report.worker.name} (${report.worker.employeeId})` : 'All workers'
  const logo = logoDataUri()
  const t = report.totals

  const content: Content[] = [
    {
      columns: [
        ...(logo ? [{ image: logo, fit: [44, 44] as [number, number], width: 52 }] : []),
        {
          stack: [
            { text: 'WORKER SCORE REPORT', fontSize: 17, bold: true, color: C.ink, characterSpacing: 0.4 },
            { text: `${company} · ${plant}`, fontSize: 9.5, color: C.muted, margin: [0, 2, 0, 0] }
          ]
        },
        {
          width: 'auto',
          stack: [
            { text: period, fontSize: 10, bold: true, alignment: 'right' },
            { text: scope, fontSize: 9, alignment: 'right', margin: [0, 2, 0, 0] },
            { text: `Generated ${formatLocalDate(new Date())}, ${formatLocalTime(new Date())} by ${generatedBy}`, fontSize: 7.5, color: C.muted, alignment: 'right', margin: [0, 2, 0, 0] }
          ]
        }
      ],
      columnGap: 10
    },
    { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 1.5, lineColor: C.brand }], margin: [0, 10, 0, 0] },
    sectionTitle('1. Score summary'),
    figureStrip([
      { label: 'Assigned tasks', value: String(t.assigned) },
      { label: 'Completed', value: String(t.completed), color: C.pass },
      { label: 'Exception', value: String(t.exceptions), color: t.exceptions ? C.warn : C.ink },
      { label: 'Missed', value: String(t.missed), color: t.missed ? C.fail : C.ink },
      { label: 'Completion', value: `${t.completionRate}%` },
      { label: report.worker ? 'Final score' : 'Overall score', value: String(t.score), color: scoreColor(t.score) }
    ]),
    {
      text: 'How the score works: each assigned task is worth 100 ÷ assigned tasks points. A missed task deducts its points; a completed or exception task keeps them. Score = completion % - 100, so 0 is every task done and -100 is none. Assigned tasks are those whose time is over; open tasks are not counted yet, and tasks excused by an approved machine breakdown, Late Entry or Early Exit are never counted.',
      fontSize: 7.5,
      color: C.muted,
      margin: [0, 6, 0, 0]
    },
    sectionTitle('2. Worker scores'),
    report.workers.length ? workerTable(report.workers, t) : { text: 'No assigned tasks in this period.', color: C.muted, fontSize: 9 }
  ]
  if (report.workers.length) {
    content.push({ text: '3. DETAILED TASK REPORT', fontSize: 9.5, bold: true, color: C.brand, characterSpacing: 0.5, pageBreak: 'before', margin: [0, 0, 0, 0] })
    report.workers.forEach((w, i) => content.push(...workerDetail(w, i === 0)))
  }

  const doc: TDocumentDefinitions = {
    pageSize: 'A4',
    pageMargins: [40, 44, 40, 48],
    defaultStyle: { font: 'Helvetica', fontSize: 9, color: C.ink },
    info: { title: `Worker Score Report ${period}` },
    footer: (page, pages) => ({
      columns: [
        { text: `${company} · Worker Score Report · ${period} · ${scope}`, fontSize: 7, color: C.muted },
        { text: `Page ${page} of ${pages}`, fontSize: 7, color: C.muted, alignment: 'right', width: 'auto' }
      ],
      margin: [40, 18, 40, 0]
    }),
    content
  }
  return (await pdfmake.createPdf(doc).getBuffer()) as unknown as Buffer
}
