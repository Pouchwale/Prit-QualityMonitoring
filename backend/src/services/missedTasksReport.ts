import { and, asc, eq, gte, isNotNull, lt, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { db } from '../db/client'
import { activities, departments, jobs, machines, qualityChecks, shifts, users } from '../db/schema'
import { formatLocalTime } from '../lib/time'

/**
 * The Missed Tasks Report in the daily task report email (services/dailyTaskReport.ts): for every
 * team member, each check they missed and each check they submitted late, in time order, so the
 * coordinator knows whom to follow up with and about which task.
 *
 * Missed: the same rule as the Performance page (services/performance.ts), so the totals match the
 * table above it: marked Missed, or still open after its window closed. A missed check cannot be
 * submitted afterwards (its window is over), so it has no completion time.
 * Late: completed (or reported as an exception) a minute or more after its scheduled time, inside
 * its window.
 */

/** A check submitted at least this long after its scheduled time counts as late. */
const LATE_AFTER_MS = 60_000

export interface MissedTaskEntry {
  code: string
  task: string
  machine: string | null
  shift: string | null
  jobNo: string | null
  itemCode: string | null
  scheduledAt: Date
  /** Late completions only: when it was submitted. */
  submittedAt: Date | null
  kind: 'MISSED' | 'LATE'
}

export interface MissedTasksByMember {
  name: string
  employeeId: string
  department: string | null
  missed: number
  late: number
  /** Missed and late tasks together, earliest first. */
  entries: MissedTaskEntry[]
}

/** Every team member with a missed or late task scheduled in [from, to): most missed first. */
export async function missedTasksReport(from: Date, to: Date): Promise<MissedTasksByMember[]> {
  const workerDept = alias(departments, 'worker_department')
  const missed = sql<boolean>`(${qualityChecks.status} = 'MISSED' or (${qualityChecks.status} in ('PENDING', 'DUE', 'IN_PROGRESS') and ${qualityChecks.windowEndsAt} < now()))`
  const rows = await db
    .select({
      workerId: qualityChecks.workerId,
      name: users.name,
      employeeId: users.employeeId,
      department: workerDept.name,
      code: qualityChecks.code,
      task: activities.name,
      machineName: machines.name,
      machineCode: machines.code,
      shift: shifts.name,
      jobNo: sql<string | null>`coalesce(nullif(trim(${qualityChecks.jobNo}), ''), ${jobs.jobNo})`,
      itemCode: sql<string | null>`coalesce(nullif(trim(${qualityChecks.itemCode}), ''), ${jobs.itemCode})`,
      scheduledAt: qualityChecks.scheduledAt,
      submittedAt: qualityChecks.submittedAt,
      missed
    })
    .from(qualityChecks)
    .innerJoin(users, eq(users.id, qualityChecks.workerId))
    .innerJoin(activities, eq(activities.id, qualityChecks.activityId))
    .leftJoin(workerDept, eq(workerDept.id, users.departmentId))
    .leftJoin(machines, eq(machines.id, qualityChecks.machineId))
    .leftJoin(shifts, eq(shifts.id, qualityChecks.shiftId))
    .leftJoin(jobs, eq(jobs.id, qualityChecks.jobId))
    .where(
      and(
        gte(qualityChecks.scheduledAt, from),
        lt(qualityChecks.scheduledAt, to),
        isNotNull(qualityChecks.workerId),
        or(
          missed,
          sql`${qualityChecks.status} in ('COMPLETED', 'EXCEPTION') and ${qualityChecks.submittedAt} >= ${qualityChecks.scheduledAt} + make_interval(secs => ${LATE_AFTER_MS / 1000})`
        )
      )
    )
    .orderBy(asc(qualityChecks.scheduledAt), asc(qualityChecks.code))

  const members = new Map<string, MissedTasksByMember>()
  for (const r of rows) {
    let m = members.get(r.workerId!)
    if (!m) members.set(r.workerId!, (m = { name: r.name, employeeId: r.employeeId, department: r.department, missed: 0, late: 0, entries: [] }))
    const kind = r.missed ? 'MISSED' : 'LATE'
    if (kind === 'MISSED') m.missed++
    else m.late++
    m.entries.push({
      code: r.code,
      task: r.task,
      machine: r.machineName ? `${r.machineName}${r.machineCode ? ` (${r.machineCode})` : ''}` : null,
      shift: r.shift,
      jobNo: r.jobNo,
      itemCode: r.itemCode,
      scheduledAt: r.scheduledAt,
      submittedAt: kind === 'LATE' ? r.submittedAt : null,
      kind
    })
  }
  return [...members.values()].sort((a, b) => b.missed - a.missed || b.late - a.late || a.name.localeCompare(b.name))
}

const esc = (value: unknown) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

const lateBy = (e: MissedTaskEntry) => {
  const minutes = Math.round((e.submittedAt!.getTime() - e.scheduledAt.getTime()) / 60_000)
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min late` : `${minutes} min late`
}

/** The Missed Tasks Report section of the daily email (rows of the email's outer table). */
export function missedTasksHtml(members: MissedTasksByMember[] | null, dayLabel: string): string {
  if (!members) return ''
  const th = 'padding: 8px 10px; text-align: left;'
  const td = 'padding: 7px 10px; border-top: 1px solid #e2e8f0; vertical-align: top;'
  const num = 'text-align: right; font-variant-numeric: tabular-nums;'
  const totalMissed = members.reduce((n, m) => n + m.missed, 0)
  const totalLate = members.reduce((n, m) => n + m.late, 0)
  const missedPeople = members.filter((m) => m.missed).length
  const latePeople = members.filter((m) => m.late).length

  const heading = `
    <tr>
      <td style="padding: 28px 32px 0 32px;">
        <h3 style="font-size: 14px; font-weight: 700; color: #991b1b; margin: 0 0 4px 0;">MISSED TASKS REPORT: ${esc(dayLabel)}</h3>
        <p style="margin: 0 0 10px 0; font-size: 12px; color: #475569;">
          ${
            members.length
              ? `<strong>${totalMissed}</strong> missed task${totalMissed === 1 ? '' : 's'} (${missedPeople} team member${missedPeople === 1 ? '' : 's'}) &middot;
                 <strong>${totalLate}</strong> task${totalLate === 1 ? '' : 's'} completed late (${latePeople} team member${latePeople === 1 ? '' : 's'})`
              : `Every task was completed on time on ${esc(dayLabel)}.`
          }
        </p>`

  if (!members.length) return `${heading}</td></tr>`

  // Who to follow up with: one line per team member.
  const summary = `
        <table width="100%" border="0" cellspacing="0" cellpadding="0" style="border: 1px solid #cbd5e1; border-collapse: collapse;">
          <thead>
            <tr style="background-color: #991b1b; color: #ffffff; font-size: 11px; font-weight: 700;">
              <th style="${th}">Team member</th>
              <th style="${th}">Employee ID</th>
              <th style="${th}">Department</th>
              <th style="${th} ${num}">Missed tasks</th>
              <th style="${th} ${num}">Completed late</th>
            </tr>
          </thead>
          <tbody>${members
            .map(
              (m) => `
            <tr style="font-size: 12px; color: #1e293b;">
              <td style="${td}"><strong>${esc(m.name)}</strong></td>
              <td style="${td} font-family: monospace;">${esc(m.employeeId)}</td>
              <td style="${td}">${esc(m.department) || '—'}</td>
              <td style="${td} ${num} font-weight: 700; color: ${m.missed ? '#dc2626' : '#64748b'};">${m.missed}</td>
              <td style="${td} ${num} color: ${m.late ? '#b45309' : '#64748b'};">${m.late}</td>
            </tr>`
            )
            .join('')}
            <tr style="font-size: 12px; color: #1e293b; background-color: #f8fafc;">
              <td colspan="3" style="${td} font-weight: 700;">Total</td>
              <td style="${td} ${num} font-weight: 700; color: #dc2626;">${totalMissed}</td>
              <td style="${td} ${num} font-weight: 700; color: #b45309;">${totalLate}</td>
            </tr>
          </tbody>
        </table>`

  // Each team member's tasks, in time order.
  const details = members
    .map((m) => {
      const rows = m.entries
        .map((e, i) => {
          const isMissed = e.kind === 'MISSED'
          const po = [e.jobNo, e.itemCode].filter(Boolean).map(esc).join('<br><span style="color: #64748b;">') + (e.jobNo && e.itemCode ? '</span>' : '')
          return `
            <tr style="font-size: 12px; color: #1e293b; background-color: ${i % 2 ? '#f8fafc' : '#ffffff'};">
              <td style="${td} color: #64748b;">${i + 1}</td>
              <td style="${td}"><strong>${esc(e.task)}</strong><br><span style="font-family: monospace; font-size: 11px; color: #64748b;">${esc(e.code)}</span></td>
              <td style="${td}">${esc(e.machine) || '—'}${e.shift ? `<br><span style="font-size: 11px; color: #64748b;">${esc(e.shift)}</span>` : ''}</td>
              <td style="${td}">${po || '—'}</td>
              <td style="${td} white-space: nowrap; font-weight: 600;">${formatLocalTime(e.scheduledAt)}</td>
              <td style="${td} white-space: nowrap;">${
                isMissed
                  ? '<span style="color: #dc2626; font-weight: 600;">Not completed</span>'
                  : `${formatLocalTime(e.submittedAt!)}<br><span style="font-size: 11px; color: #b45309;">${lateBy(e)}</span>`
              }</td>
              <td style="${td}">
                <span style="display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 700; white-space: nowrap; color: ${isMissed ? '#dc2626' : '#b45309'}; background: ${isMissed ? '#fef2f2' : '#fffbeb'};">${isMissed ? 'MISSED' : 'LATE'}</span>
              </td>
            </tr>`
        })
        .join('')
      return `
        <table width="100%" border="0" cellspacing="0" cellpadding="0" style="margin-top: 16px; border: 1px solid #cbd5e1; border-collapse: collapse;">
          <tr>
            <td colspan="7" style="padding: 9px 10px; background-color: #f1f5f9; font-size: 13px; color: #1e293b;">
              <strong>${esc(m.name)}</strong> <span style="font-family: monospace; color: #64748b;">${esc(m.employeeId)}</span>${m.department ? ` &middot; ${esc(m.department)}` : ''}
              <span style="float: right; font-size: 12px;"><strong style="color: #dc2626;">${m.missed} missed</strong>${m.late ? ` &middot; <span style="color: #b45309;">${m.late} late</span>` : ''}</span>
            </td>
          </tr>
          <tr style="background-color: #e2e8f0; color: #334155; font-size: 11px; font-weight: 700;">
            <td style="${th}">#</td>
            <td style="${th}">Task</td>
            <td style="${th}">Machine / Shift</td>
            <td style="${th}">PO No. / Item</td>
            <td style="${th}">Scheduled</td>
            <td style="${th}">Completed</td>
            <td style="${th}">Status</td>
          </tr>
          ${rows}
          <tr style="font-size: 12px; background-color: #fef2f2;">
            <td colspan="7" style="${td} color: #991b1b;"><strong>Total missed tasks: ${m.missed}</strong>${m.late ? ` &middot; completed late: ${m.late}` : ''}</td>
          </tr>
        </table>`
    })
    .join('')

  return `${heading}${summary}${details}
        <p style="margin: 8px 0 0 0; font-size: 11px; color: #64748b; line-height: 1.5;">
          Missed: the task's time window closed before it was done; the app then locks it, so it has no completion time.
          Late: done within its window, but a minute or more after its scheduled time.
        </p>
      </td>
    </tr>`
}
