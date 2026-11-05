import pdfmake from 'pdfmake'
import type { Content, TDocumentDefinitions, TableCell } from 'pdfmake/interfaces'
import { and, asc, eq, gte, inArray, lte, type SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { db } from '../db/client'
import { departments, leaveRequests, leaveTypes, users, type RequestStatus } from '../db/schema'
import { addDays, formatDateKey, formatLocalDate, formatLocalTime, parseDateKey, startOfDay } from '../lib/time'
import { getCompanyPlantName } from './automatedReports'
import { C, figureStrip, logoDataUri } from './crystalReportPdf'
import { clock12, type TimeKind } from './leave'

pdfmake.addFonts({
  Helvetica: { normal: 'Helvetica', bold: 'Helvetica-Bold', italics: 'Helvetica-Oblique', bolditalics: 'Helvetica-BoldOblique' }
})

/**
 * Late Entry & Early Exit Report (Leave Reports): every Late Entry and Early Exit request in a
 * period, whatever its status, with the time entered, how late or how early that was against the
 * worker's shift, the decision and the tasks it excused; and a summary per worker. Text only.
 *
 *  - Late by: the arrival time less the shift start. Early by: the shift end less the leaving time.
 *    Both come from the stretch worked out when the request was sent (leave_requests.affects_*).
 *    A worker with no shift has no shift times: shown as "—".
 *  - Totals of minutes count approved requests only (rejected and cancelled ones did not happen).
 */

export interface TimeRecord {
  id: string
  date: string
  kind: TimeKind
  typeName: string
  workerId: string
  workerName: string
  employeeId: string
  department: string | null
  /** HH:MM as entered. */
  requestedTime: string | null
  /** Late Entry: the shift start; Early Exit: the shift end (null: no shift). */
  shiftTime: string | null
  /** How late (Late Entry) or how early (Early Exit), in minutes; null: no shift. */
  minutes: number | null
  reason: string
  status: RequestStatus
  appliedAt: Date
  decidedByName: string | null
  decidedAt: Date | null
  decisionComment: string | null
  tasksRemoved: number | null
}

export interface TimeWorkerSummary {
  workerId: string
  name: string
  employeeId: string
  department: string | null
  lateEntries: number
  earlyExits: number
  approved: number
  rejected: number
  pending: number
  cancelled: number
  /** Approved requests only. */
  lateMinutes: number
  earlyMinutes: number
  tasksExcused: number
}

export interface TimeReport {
  from: string
  to: string
  kind: TimeKind | null
  status: RequestStatus | null
  worker: { id: string; name: string; employeeId: string } | null
  totals: { records: number; lateEntries: number; earlyExits: number; approved: number; rejected: number; pending: number; cancelled: number; lateMinutes: number; earlyMinutes: number; tasksExcused: number; workers: number }
  workers: TimeWorkerSummary[]
  records: TimeRecord[]
}

const worker = alias(users, 'tr_worker')
const decider = alias(users, 'tr_decider')
const MIN = 60_000

export async function timeRequestReport(opts: { from: string; to: string; workerId?: string; kind?: TimeKind; status?: RequestStatus; workerIds?: string[] | null }): Promise<TimeReport> {
  const where: (SQL | undefined)[] = [
    inArray(leaveTypes.kind, opts.kind ? [opts.kind] : ['LATE_ENTRY', 'EARLY_EXIT']),
    gte(leaveRequests.startDate, opts.from),
    lte(leaveRequests.startDate, opts.to),
    opts.workerId ? eq(leaveRequests.workerId, opts.workerId) : undefined,
    opts.status ? eq(leaveRequests.status, opts.status) : undefined,
    opts.workerIds ? inArray(leaveRequests.workerId, opts.workerIds.length ? opts.workerIds : ['00000000-0000-0000-0000-000000000000']) : undefined
  ]
  const rows = await db
    .select({
      r: leaveRequests,
      kind: leaveTypes.kind,
      typeName: leaveTypes.name,
      workerName: worker.name,
      employeeId: worker.employeeId,
      department: departments.name,
      decidedByName: decider.name
    })
    .from(leaveRequests)
    .innerJoin(leaveTypes, eq(leaveTypes.id, leaveRequests.leaveTypeId))
    .innerJoin(worker, eq(worker.id, leaveRequests.workerId))
    .leftJoin(departments, eq(departments.id, worker.departmentId))
    .leftJoin(decider, eq(decider.id, leaveRequests.decidedById))
    .where(and(...where))
    .orderBy(asc(leaveRequests.startDate), asc(worker.name), asc(leaveRequests.createdAt))

  const records: TimeRecord[] = rows.map(({ r, kind, typeName, workerName, employeeId, department, decidedByName }) => {
    const late = kind === 'LATE_ENTRY'
    // No shift: the stretch is the calendar day (midnight), so there is no shift time to compare with.
    const day = startOfDay(parseDateKey(r.startDate))
    const noShift = !r.affectsFrom || !r.affectsTo || (late ? r.affectsFrom.getTime() === day.getTime() : r.affectsTo.getTime() === addDays(day, 1).getTime())
    const edge = noShift ? null : late ? r.affectsFrom! : r.affectsTo!
    return {
      id: r.id,
      date: r.startDate,
      kind: kind as TimeKind,
      typeName,
      workerId: r.workerId,
      workerName,
      employeeId,
      department,
      requestedTime: r.requestedTime,
      shiftTime: edge ? formatLocalTime(edge) : null,
      minutes: noShift ? null : Math.round((r.affectsTo!.getTime() - r.affectsFrom!.getTime()) / MIN),
      reason: r.reason,
      status: r.status,
      appliedAt: r.createdAt,
      decidedByName,
      decidedAt: r.decidedAt,
      decisionComment: r.decisionComment,
      tasksRemoved: r.tasksRemoved
    }
  })

  const byWorker = new Map<string, TimeWorkerSummary>()
  for (const x of records) {
    let w = byWorker.get(x.workerId)
    if (!w) {
      w = { workerId: x.workerId, name: x.workerName, employeeId: x.employeeId, department: x.department, lateEntries: 0, earlyExits: 0, approved: 0, rejected: 0, pending: 0, cancelled: 0, lateMinutes: 0, earlyMinutes: 0, tasksExcused: 0 }
      byWorker.set(x.workerId, w)
    }
    if (x.kind === 'LATE_ENTRY') w.lateEntries++
    else w.earlyExits++
    if (x.status === 'APPROVED') {
      w.approved++
      if (x.kind === 'LATE_ENTRY') w.lateMinutes += x.minutes ?? 0
      else w.earlyMinutes += x.minutes ?? 0
      w.tasksExcused += x.tasksRemoved ?? 0
    } else if (x.status === 'REJECTED') w.rejected++
    else if (x.status === 'PENDING') w.pending++
    else w.cancelled++
  }
  const workers = [...byWorker.values()].sort((a, b) => b.lateEntries + b.earlyExits - (a.lateEntries + a.earlyExits) || a.name.localeCompare(b.name))
  const sum = (k: keyof TimeWorkerSummary) => workers.reduce((n, w) => n + (w[k] as number), 0)
  const [one] = opts.workerId ? await db.select({ id: users.id, name: users.name, employeeId: users.employeeId }).from(users).where(eq(users.id, opts.workerId)) : []

  return {
    from: opts.from,
    to: opts.to,
    kind: opts.kind ?? null,
    status: opts.status ?? null,
    worker: one ?? null,
    totals: {
      records: records.length,
      lateEntries: sum('lateEntries'),
      earlyExits: sum('earlyExits'),
      approved: sum('approved'),
      rejected: sum('rejected'),
      pending: sum('pending'),
      cancelled: sum('cancelled'),
      lateMinutes: sum('lateMinutes'),
      earlyMinutes: sum('earlyMinutes'),
      tasksExcused: sum('tasksExcused'),
      workers: workers.length
    },
    workers,
    records
  }
}

// ---------------------------------------------------------------------------- PDF

/** 95 → "1 h 35 min". */
export const duration = (m: number | null) => (m === null ? '—' : m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`)
const STATUS_LABEL: Record<RequestStatus, string> = { PENDING: 'Pending', APPROVED: 'Approved', REJECTED: 'Rejected', CANCELLED: 'Cancelled' }
const statusColor = (s: RequestStatus) => (s === 'APPROVED' ? C.pass : s === 'REJECTED' ? C.fail : s === 'PENDING' ? C.warn : C.muted)

const head = (text: string, alignment: 'left' | 'right' = 'left'): TableCell => ({ text, bold: true, fontSize: 7, color: C.muted, alignment, characterSpacing: 0.3 })
const n = (v: number | string, opts: { color?: string; bold?: boolean } = {}): TableCell => ({ text: String(v), alignment: 'right', color: opts.color ?? C.ink, bold: opts.bold })
const sectionTitle = (text: string, extra: Record<string, unknown> = {}): Content => ({ text: text.toUpperCase(), fontSize: 9.5, bold: true, color: C.brand, characterSpacing: 0.5, margin: [0, 16, 0, 6], ...extra }) as Content

function table(widths: (number | '*')[], body: TableCell[][], totalRow = false): Content {
  const last = body.length - 1
  return {
    table: { headerRows: 1, dontBreakRows: true, widths, body },
    layout: {
      hLineWidth: (i: number) => (i === 1 || (totalRow && i === last) ? 0.8 : i === 0 || i === body.length ? 0 : 0.4),
      hLineColor: (i: number) => (i === 1 || (totalRow && i === last) ? C.line : C.hair),
      vLineWidth: () => 0,
      fillColor: (i: number) => (i === 0 ? C.headBg : totalRow && i === last ? C.band : null),
      paddingTop: () => 4,
      paddingBottom: () => 4,
      paddingLeft: () => 3.5,
      paddingRight: () => 3.5
    },
    fontSize: 8
  } as Content
}

function workerTable(r: TimeReport): Content {
  const t = r.totals
  const body: TableCell[][] = [
    [head('#'), head('EMPLOYEE'), head('DEPARTMENT'), head('LATE ENTRIES', 'right'), head('EARLY EXITS', 'right'), head('APPROVED', 'right'), head('REJECTED', 'right'), head('PENDING', 'right'), head('CANCELLED', 'right'), head('LATE TIME', 'right'), head('EARLY TIME', 'right'), head('TASKS EXCUSED', 'right')],
    ...r.workers.map((w, i): TableCell[] => [
      { text: String(i + 1), color: C.muted },
      { stack: [{ text: w.name, bold: true }, { text: w.employeeId, color: C.muted, fontSize: 7 }] },
      { text: w.department ?? '—', color: w.department ? C.ink : C.faint },
      n(w.lateEntries, { color: w.lateEntries ? C.ink : C.faint }),
      n(w.earlyExits, { color: w.earlyExits ? C.ink : C.faint }),
      n(w.approved, { color: w.approved ? C.pass : C.faint }),
      n(w.rejected, { color: w.rejected ? C.fail : C.faint }),
      n(w.pending, { color: w.pending ? C.warn : C.faint }),
      n(w.cancelled, { color: C.faint }),
      n(w.lateMinutes ? duration(w.lateMinutes) : '—', { color: w.lateMinutes ? C.ink : C.faint }),
      n(w.earlyMinutes ? duration(w.earlyMinutes) : '—', { color: w.earlyMinutes ? C.ink : C.faint }),
      n(w.tasksExcused, { color: w.tasksExcused ? C.ink : C.faint })
    ])
  ]
  if (r.workers.length > 1) {
    body.push([
      { text: '' },
      { text: 'All employees', bold: true },
      { text: '' },
      n(t.lateEntries, { bold: true }),
      n(t.earlyExits, { bold: true }),
      n(t.approved, { bold: true, color: C.pass }),
      n(t.rejected, { bold: true, color: t.rejected ? C.fail : C.ink }),
      n(t.pending, { bold: true, color: t.pending ? C.warn : C.ink }),
      n(t.cancelled, { bold: true }),
      n(t.lateMinutes ? duration(t.lateMinutes) : '—', { bold: true }),
      n(t.earlyMinutes ? duration(t.earlyMinutes) : '—', { bold: true }),
      n(t.tasksExcused, { bold: true })
    ])
  }
  return table([16, '*', 84, 60, 54, 50, 50, 46, 50, 56, 56, 56], body, r.workers.length > 1)
}

function recordTable(r: TimeReport): Content {
  const body: TableCell[][] = [
    [head('#'), head('DATE'), head('EMPLOYEE'), head('TYPE'), head('TIME'), head('SHIFT'), head('LATE / EARLY BY', 'right'), head('REASON'), head('STATUS'), head('DECIDED BY'), head('TASKS EXCUSED', 'right')],
    ...r.records.map((x, i): TableCell[] => [
      { text: String(i + 1), color: C.muted },
      { stack: [{ text: formatDateKey(x.date) }, { text: `Applied ${formatLocalTime(x.appliedAt)}`, color: C.muted, fontSize: 6.5 }] },
      { stack: [{ text: x.workerName, bold: true }, { text: [x.employeeId, x.department].filter(Boolean).join(' · '), color: C.muted, fontSize: 7 }] },
      { text: x.kind === 'LATE_ENTRY' ? 'Late Entry' : 'Early Exit', bold: true, color: C.text },
      { stack: [{ text: x.requestedTime ? clock12(x.requestedTime) : '—', bold: true }, { text: x.kind === 'LATE_ENTRY' ? 'arrival' : 'leaving', color: C.muted, fontSize: 6.5 }] },
      { stack: [{ text: x.shiftTime ?? '—', color: x.shiftTime ? C.ink : C.faint }, { text: x.shiftTime ? (x.kind === 'LATE_ENTRY' ? 'shift start' : 'shift end') : 'no shift', color: C.muted, fontSize: 6.5 }] },
      n(x.minutes === null ? '—' : `${duration(x.minutes)} ${x.kind === 'LATE_ENTRY' ? 'late' : 'early'}`, { color: x.minutes === null ? C.faint : C.ink }),
      { text: x.reason, fontSize: 7.5 },
      { stack: [{ text: STATUS_LABEL[x.status], bold: true, color: statusColor(x.status) }, ...(x.decisionComment ? [{ text: x.decisionComment, color: C.muted, fontSize: 6.5 }] : [])] },
      x.decidedByName && x.decidedAt
        ? { stack: [{ text: x.decidedByName }, { text: `${formatLocalDate(x.decidedAt)}, ${formatLocalTime(x.decidedAt)}`, color: C.muted, fontSize: 6.5 }] }
        : { text: '—', color: C.faint },
      n(x.status === 'APPROVED' ? (x.tasksRemoved ?? 0) : '—', { color: x.status === 'APPROVED' ? C.ink : C.faint })
    ])
  ]
  return table([16, 52, '*', 50, 44, 50, 62, 120, 66, 80, 44], body)
}

export async function renderTimeReportPdf(r: TimeReport, generatedBy: string): Promise<Buffer> {
  const { company, plant } = await getCompanyPlantName()
  const period = r.from === r.to ? formatDateKey(r.from) : `${formatDateKey(r.from)} – ${formatDateKey(r.to)}`
  const scope = [r.worker ? `${r.worker.name} (${r.worker.employeeId})` : 'All employees', r.kind ? (r.kind === 'LATE_ENTRY' ? 'Late Entry only' : 'Early Exit only') : null, r.status ? `${STATUS_LABEL[r.status]} only` : null]
    .filter(Boolean)
    .join(' · ')
  const logo = logoDataUri()
  const t = r.totals
  const WIDTH = 762

  const content: Content[] = [
    {
      columns: [
        ...(logo ? [{ image: logo, fit: [44, 44] as [number, number], width: 52 }] : []),
        {
          stack: [
            { text: 'LATE ENTRY & EARLY EXIT REPORT', fontSize: 17, bold: true, color: C.ink, characterSpacing: 0.4 },
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
    { canvas: [{ type: 'line', x1: 0, y1: 0, x2: WIDTH, y2: 0, lineWidth: 1.5, lineColor: C.brand }], margin: [0, 10, 0, 0] },
    sectionTitle('1. Summary'),
    figureStrip([
      { label: 'Late entries', value: String(t.lateEntries) },
      { label: 'Early exits', value: String(t.earlyExits) },
      { label: 'Approved', value: String(t.approved), color: C.pass },
      { label: 'Rejected', value: String(t.rejected), color: t.rejected ? C.fail : C.ink },
      { label: 'Pending', value: String(t.pending), color: t.pending ? C.warn : C.ink },
      { label: 'Approved late time', value: duration(t.lateMinutes || 0) },
      { label: 'Approved early time', value: duration(t.earlyMinutes || 0) },
      { label: 'Tasks excused', value: String(t.tasksExcused) }
    ]),
    {
      text: 'Late by = arrival time less the shift start; early by = shift end less the leaving time. Time totals and tasks excused count approved requests only. Approved requests excuse the unfinished tasks before the arrival time (Late Entry) or after the leaving time (Early Exit) on that day.',
      fontSize: 7.5,
      color: C.muted,
      margin: [0, 6, 0, 0]
    }
  ]
  if (!r.records.length) {
    content.push({ text: 'No Late Entry or Early Exit requests in this period.', color: C.muted, fontSize: 9, margin: [0, 16, 0, 0] })
  } else {
    content.push(sectionTitle('2. Employee summary'), workerTable(r), sectionTitle(`3. All records (${t.records})`, { pageBreak: 'before', margin: [0, 0, 0, 6] }), recordTable(r))
  }

  const doc: TDocumentDefinitions = {
    pageSize: 'A4',
    pageOrientation: 'landscape',
    pageMargins: [40, 40, 40, 44],
    defaultStyle: { font: 'Helvetica', fontSize: 8.5, color: C.ink },
    info: { title: `Late Entry & Early Exit Report ${period}` },
    footer: (page, pages) => ({
      columns: [
        { text: `${company} · Late Entry & Early Exit Report · ${period} · ${scope}`, fontSize: 7, color: C.muted },
        { text: `Page ${page} of ${pages}`, fontSize: 7, color: C.muted, alignment: 'right', width: 'auto' }
      ],
      margin: [40, 16, 40, 0]
    }),
    content
  }
  return (await pdfmake.createPdf(doc).getBuffer()) as unknown as Buffer
}
