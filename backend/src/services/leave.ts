import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Request } from 'express'
import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, ne, or, sql, type SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { db, type Transaction } from '../db/client'
import { departments, leaveRequests, leaveTypes, qualityChecks, settings, shiftChangeRequests, shifts, users, type RequestStatus } from '../db/schema'
import { config } from '../config'
import { audit } from '../lib/audit'
import { badRequest, conflict, forbidden, notFound } from '../lib/http'
import { addDays, atTime, dateKey, formatDateKey, parseDateKey, startOfDay } from '../lib/time'
import { loadActions } from '../lib/permissions'
import { dayStates } from './plantCalendar'
import { invalidateCheckGeneration } from './checkGenerator'
import { sendToUser } from './notifications'
import { sendLoggedEmail, smtpOf } from './reportDelivery'

/**
 * Leave Management: workers apply for leave and for shift changes in the worker app; staff with the
 * Leave approve permission (Roles & Permissions) approve or reject them on Leave Approval.
 *
 *  - Days are counted on the plant calendar: weekly offs and holidays are left out unless the Leave
 *    Settings count them; a half day is 0.5 of one day.
 *  - Balances are worked out from the requests, per leave year: allocated (the type's yearly quota
 *    plus what was carried forward), used (approved), pending and remaining. A type without a
 *    quota has no limit and nothing is deducted.
 *  - Approved leave: no checks are created for the worker on those days (half a day: that half of the
 *    shift), so the score is not affected; the worker gets no sign-in reminders. Approved shift
 *    change: on those dates the worker's checks, sign-in and reminders follow the requested shift.
 *    Both through workerDayPlans, read by the check generator and services/workerShifts.ts.
 *  - Every submission, decision, cancellation and settings change is in the audit log. Emails go
 *    through the report email delivery (status, retries; services/reportDelivery.ts) to the
 *    configured recipients only; the worker also gets a push notification.
 */

// ---------------------------------------------------------------------------- Settings

export interface LeaveSettings {
  /** First month of the leave year (1 = January … 4 = April). */
  leaveYearStartMonth: number
  /** Whether weekly offs and holidays inside a leave count as leave days. */
  countWeeklyOffs: boolean
  countHolidays: boolean
  /** How many days back a leave may start (sick leave reported afterwards); 0: from today only. */
  maxPastDays: number
  /** Longest shift change, in days. */
  maxShiftChangeDays: number
  /** A worker may cancel an approved leave or shift change that has not started yet. */
  workerCanCancelApproved: boolean
  /** Who gets emails. The addresses are set by the Super Admin only. */
  notify: {
    /** New requests to the staff who may approve them (those with an email on their account). */
    approvers: boolean
    /** Decisions to the worker, when the worker's account has an email. */
    worker: boolean
    /** Extra addresses for new requests (e.g. HR). */
    approverEmails: string[]
    /** The Super Admin's address, and whether it gets a copy of every leave email. */
    superAdminEmail: string
    copySuperAdmin: boolean
    /** Copied on every leave email. */
    ccEmails: string[]
  }
}

export const LEAVE_DEFAULTS: LeaveSettings = {
  leaveYearStartMonth: 1,
  countWeeklyOffs: false,
  countHolidays: false,
  maxPastDays: 7,
  maxShiftChangeDays: 31,
  workerCanCancelApproved: true,
  notify: { approvers: true, worker: true, approverEmails: [], superAdminEmail: '', copySuperAdmin: true, ccEmails: [] }
}

const SETTINGS_KEY = 'leaveSettings'

export async function getLeaveSettings(): Promise<LeaveSettings> {
  const [row] = await db.select().from(settings).where(eq(settings.key, SETTINGS_KEY))
  // `reminders` was a setting once (removed); an old stored value is left out.
  const { reminders: _old, ...stored } = (row?.value ?? {}) as Partial<LeaveSettings> & { reminders?: unknown }
  return {
    ...LEAVE_DEFAULTS,
    ...stored,
    notify: { ...LEAVE_DEFAULTS.notify, ...(stored.notify ?? {}) }
  }
}

export async function saveLeaveSettings(next: LeaveSettings) {
  await db
    .insert(settings)
    .values({ key: SETTINGS_KEY, value: next })
    .onConflictDoUpdate({ target: settings.key, set: { value: next, updatedAt: new Date() } })
  return next
}

// ---------------------------------------------------------------------------- Dates and days

export type DayPart = 'FULL' | 'FIRST_HALF' | 'SECOND_HALF'
export const DAY_PART_LABEL: Record<DayPart, string> = { FULL: 'Full Day', FIRST_HALF: 'Half Day (First Half)', SECOND_HALF: 'Half Day (Second Half)' }

const todayKey = (now = new Date()) => dateKey(now)
const isDateKey = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && dateKey(parseDateKey(v)) === v

/** The leave year a date falls in: its first and last day and a label ("2026" or "Apr 2026 – Mar 2027"). */
export function leaveYearOf(key: string, startMonth: number) {
  const [y, m] = key.split('-').map(Number)
  const startYear = m >= startMonth ? y : y - 1
  const start = `${startYear}-${String(startMonth).padStart(2, '0')}-01`
  const end = dateKey(addDays(parseDateKey(`${startMonth === 1 ? startYear + 1 : startYear + 1}-${String(startMonth).padStart(2, '0')}-01`), -1))
  const label = startMonth === 1 ? String(startYear) : `${formatMonth(start)} – ${formatMonth(end)}`
  return { start, end, label }
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const formatMonth = (key: string) => `${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`

/**
 * The leave days of a request: every date in the range, less weekly offs and holidays (unless the
 * settings count them); a half day is 0.5. Throws when nothing would be counted.
 */
export async function countLeaveDays(startDate: string, endDate: string, dayPart: DayPart, s: LeaveSettings) {
  const states = await dayStates(parseDateKey(startDate), parseDateKey(endDate))
  const counted = states.filter((d) => !d.closed || (d.source === 'WEEKLY' ? s.countWeeklyOffs : s.countHolidays))
  if (!counted.length) {
    throw badRequest(startDate === endDate ? `${formatDateKey(startDate)} is a ${states[0]?.label ?? 'closed day'}: no leave is needed.` : 'These dates are all weekly offs or holidays: no leave is needed.')
  }
  return { days: dayPart === 'FULL' ? counted.length : 0.5, skipped: states.length - counted.length }
}

// ---------------------------------------------------------------------------- Balances

export interface BalanceRow {
  leaveTypeId: string
  name: string
  code: string
  isPaid: boolean
  /** Null: no limit. */
  quota: number | null
  carriedForward: number
  allocated: number | null
  used: number
  pending: number
  remaining: number | null
}

const round = (n: number) => Math.round(n * 100) / 100

/**
 * Each leave type's balance for the workers, in the leave year of `atKey`. Carry-forward: what was
 * left of the year before (at most the type's carry-forward limit), year after year from the
 * worker's first approved leave of that type.
 */
export async function balancesFor(workerIds: string[], atKey = todayKey(), s?: LeaveSettings) {
  const st = s ?? (await getLeaveSettings())
  const year = leaveYearOf(atKey, st.leaveYearStartMonth)
  const [types, rows] = await Promise.all([
    db.select().from(leaveTypes).orderBy(asc(leaveTypes.sortOrder), asc(leaveTypes.name)),
    workerIds.length
      ? db
          .select({ workerId: leaveRequests.workerId, leaveTypeId: leaveRequests.leaveTypeId, startDate: leaveRequests.startDate, days: leaveRequests.days, status: leaveRequests.status })
          .from(leaveRequests)
          .where(and(inArray(leaveRequests.workerId, workerIds), inArray(leaveRequests.status, ['APPROVED', 'PENDING']), lte(leaveRequests.startDate, year.end)))
      : Promise.resolve([])
  ])
  const result = new Map<string, BalanceRow[]>()
  for (const workerId of workerIds) {
    const mine = rows.filter((r) => r.workerId === workerId)
    result.set(
      workerId,
      types
        .filter((t) => t.isActive || mine.some((r) => r.leaveTypeId === t.id && r.startDate >= year.start))
        .map((t) => {
          const ofType = mine.filter((r) => r.leaveTypeId === t.id)
          const inYear = ofType.filter((r) => r.startDate >= year.start)
          const used = round(inYear.filter((r) => r.status === 'APPROVED').reduce((n, r) => n + r.days, 0))
          const pending = round(inYear.filter((r) => r.status === 'PENDING').reduce((n, r) => n + r.days, 0))
          // Carry-forward, year by year from the first approved leave of this type before this year.
          let carried = 0
          if (t.annualQuota !== null && t.carryForwardMax > 0) {
            const earlier = ofType.filter((r) => r.status === 'APPROVED' && r.startDate < year.start).map((r) => r.startDate).sort()
            if (earlier.length) {
              let y = leaveYearOf(earlier[0], st.leaveYearStartMonth)
              while (y.start < year.start) {
                const usedThen = ofType.filter((r) => r.status === 'APPROVED' && r.startDate >= y.start && r.startDate <= y.end).reduce((n, r) => n + r.days, 0)
                carried = Math.min(t.carryForwardMax, Math.max(0, t.annualQuota + carried - usedThen))
                y = leaveYearOf(dateKey(addDays(parseDateKey(y.end), 1)), st.leaveYearStartMonth)
              }
            }
          }
          const allocated = t.annualQuota === null ? null : round(t.annualQuota + carried)
          return {
            leaveTypeId: t.id,
            name: t.name,
            code: t.code,
            isPaid: t.isPaid,
            quota: t.annualQuota,
            carriedForward: round(carried),
            allocated,
            used,
            pending,
            remaining: allocated === null ? null : round(allocated - used - pending)
          }
        })
    )
  }
  return { year, balances: result }
}

// ---------------------------------------------------------------------------- Day plans (checks, shifts)

export interface DayPlan {
  /** Approved leave on the date: the whole day, or one half of the shift. */
  leave?: DayPart
  /** Approved shift change: the shift worked on the date instead of the worker's own. */
  shift?: { id: string; name: string; startTime: string; endTime: string }
}

/**
 * Approved leave and shift changes per worker and date (YYYY-MM-DD) between two dates. Read by the
 * check generator and the shift sign-in (services/workerShifts.ts). `workerIds` null: everyone.
 */
export async function workerDayPlans(workerIds: string[] | null, fromKey: string, toKey: string) {
  const plans = new Map<string, Map<string, DayPlan>>()
  if (workerIds && !workerIds.length) return plans
  const [leaves, changes] = await Promise.all([
    db
      .select({ workerId: leaveRequests.workerId, startDate: leaveRequests.startDate, endDate: leaveRequests.endDate, dayPart: leaveRequests.dayPart })
      .from(leaveRequests)
      .where(
        and(
          eq(leaveRequests.status, 'APPROVED'),
          lte(leaveRequests.startDate, toKey),
          gte(leaveRequests.endDate, fromKey),
          workerIds ? inArray(leaveRequests.workerId, workerIds) : undefined
        )
      ),
    db
      .select({ workerId: shiftChangeRequests.workerId, startDate: shiftChangeRequests.startDate, endDate: shiftChangeRequests.endDate, shift: { id: shifts.id, name: shifts.name, startTime: shifts.startTime, endTime: shifts.endTime } })
      .from(shiftChangeRequests)
      .innerJoin(shifts, eq(shifts.id, shiftChangeRequests.requestedShiftId))
      .where(
        and(
          eq(shiftChangeRequests.status, 'APPROVED'),
          lte(shiftChangeRequests.startDate, toKey),
          gte(shiftChangeRequests.endDate, fromKey),
          workerIds ? inArray(shiftChangeRequests.workerId, workerIds) : undefined
        )
      )
  ])
  const planOf = (workerId: string, key: string) => {
    let m = plans.get(workerId)
    if (!m) plans.set(workerId, (m = new Map()))
    let p = m.get(key)
    if (!p) m.set(key, (p = {}))
    return p
  }
  const eachDay = (from: string, to: string, fn: (key: string) => void) => {
    const a = from < fromKey ? fromKey : from
    const b = to > toKey ? toKey : to
    for (let d = parseDateKey(a); dateKey(d) <= b; d = addDays(d, 1)) fn(dateKey(d))
  }
  for (const c of changes) eachDay(c.startDate, c.endDate, (key) => (planOf(c.workerId, key).shift = c.shift))
  for (const l of leaves) {
    eachDay(l.startDate, l.endDate, (key) => {
      const p = planOf(l.workerId, key)
      // Both halves of one day are the whole day.
      p.leave = p.leave && p.leave !== l.dayPart ? 'FULL' : (l.dayPart as DayPart)
    })
  }
  return plans
}

/**
 * A work window (a shift occurrence starting on `day`) under the day's plan: the shift change's
 * times instead, less the half on leave; null when the whole day is on leave.
 */
export function applyDayPlan(window: { start: Date; end: Date }, plan: DayPlan | undefined, useShift = true) {
  if (!plan) return window
  let { start, end } = window
  if (useShift && plan.shift) {
    const day = startOfDay(start)
    start = atTime(day, plan.shift.startTime)
    end = atTime(day, plan.shift.endTime)
    if (end <= start) end = addDays(end, 1)
  }
  if (plan.leave === 'FULL') return null
  const middle = new Date(start.getTime() + (end.getTime() - start.getTime()) / 2)
  if (plan.leave === 'FIRST_HALF') start = middle
  if (plan.leave === 'SECOND_HALF') end = middle
  return { start, end }
}

/**
 * After a leave or shift change is approved: the worker's checks not yet started in those dates
 * (pending or due) are removed, so the generator makes them again under the new plan (none on
 * leave, the requested shift's on a shift change). Started and submitted checks stay.
 */
async function replanChecks(workerId: string, startDate: string, endDate: string) {
  const from = parseDateKey(startDate)
  // An overnight shift starting on the last date runs into the next morning.
  const to = addDays(parseDateKey(endDate), 2)
  const removed = await db
    .delete(qualityChecks)
    .where(and(eq(qualityChecks.workerId, workerId), inArray(qualityChecks.status, ['PENDING', 'DUE']), gte(qualityChecks.scheduledAt, from), lt(qualityChecks.scheduledAt, to)))
    .returning({ id: qualityChecks.id })
  invalidateCheckGeneration()
  return removed.length
}

// ---------------------------------------------------------------------------- Attachments

const ATTACHMENT_TYPES: Record<string, string> = { '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024
export const ATTACHMENT_ERROR = 'Attach a PDF or a photo (JPG, PNG or WEBP), at most 10 MB.'

export const acceptsAttachment = (name: string) => path.extname(name).toLowerCase() in ATTACHMENT_TYPES

/** Moves an uploaded file into uploads/leave/YYYY-MM/ (never served without a permission check). */
export async function storeAttachment(file: Express.Multer.File | undefined) {
  if (!file) return null
  const ext = path.extname(file.originalname).toLowerCase()
  if (!(ext in ATTACHMENT_TYPES)) throw badRequest(ATTACHMENT_ERROR)
  const relative = path.posix.join('leave', todayKey().slice(0, 7), `${randomUUID()}${ext}`)
  const full = path.resolve(config.uploadDir, relative)
  await fs.mkdir(path.dirname(full), { recursive: true })
  await fs.rename(file.path, full).catch(async () => {
    await fs.copyFile(file.path, full)
    await fs.rm(file.path, { force: true })
  })
  return { attachmentPath: relative, attachmentName: file.originalname.slice(0, 200), attachmentType: ATTACHMENT_TYPES[ext] }
}

export const attachmentFile = (relative: string) => path.resolve(config.uploadDir, relative)

// ---------------------------------------------------------------------------- Requests: reading

const workers = alias(users, 'leave_worker')
const deciders = alias(users, 'leave_decider')
const currentShifts = alias(shifts, 'current_shift')

export interface RequestFilters {
  status?: RequestStatus
  from?: string
  to?: string
  workerId?: string
  departmentId?: string
  leaveTypeId?: string
  decidedById?: string
  q?: string
  ids?: string[]
  limit?: number
}

const leaveColumns = {
  request: leaveRequests,
  workerName: workers.name,
  workerEmployeeId: workers.employeeId,
  workerDesignation: workers.designation,
  workerEmail: workers.email,
  departmentName: departments.name,
  leaveTypeName: leaveTypes.name,
  leaveTypeCode: leaveTypes.code,
  isPaid: leaveTypes.isPaid,
  decidedByName: deciders.name
}

type LeaveRow = Awaited<ReturnType<typeof listLeaveRows>>[number]

function listLeaveRows(where: SQL | undefined, limit = 500) {
  return db
    .select(leaveColumns)
    .from(leaveRequests)
    .innerJoin(workers, eq(workers.id, leaveRequests.workerId))
    .innerJoin(leaveTypes, eq(leaveTypes.id, leaveRequests.leaveTypeId))
    .leftJoin(departments, eq(departments.id, workers.departmentId))
    .leftJoin(deciders, eq(deciders.id, leaveRequests.decidedById))
    .where(where)
    .orderBy(desc(leaveRequests.createdAt))
    .limit(limit)
}

const leaveDto = (r: LeaveRow) => {
  const { attachmentPath, ...rest } = r.request
  return {
    ...rest,
    hasAttachment: !!attachmentPath,
    dayPartLabel: DAY_PART_LABEL[r.request.dayPart as DayPart],
    workerName: r.workerName,
    workerEmployeeId: r.workerEmployeeId,
    workerDesignation: r.workerDesignation,
    departmentName: r.departmentName,
    // A custom leave shows the employee's own name for it: "Custom Leave – Marriage leave".
    leaveTypeName: r.request.customType ? `${r.leaveTypeName} – ${r.request.customType}` : r.leaveTypeName,
    leaveTypeCode: r.leaveTypeCode,
    isPaid: r.isPaid,
    decidedByName: r.decidedByName
  }
}
export type LeaveDto = ReturnType<typeof leaveDto>

function filterWhere(table: typeof leaveRequests | typeof shiftChangeRequests, f: RequestFilters) {
  const where: (SQL | undefined)[] = []
  if (f.status) where.push(eq(table.status, f.status))
  // Requests touching the period.
  if (f.from) where.push(gte(table.endDate, f.from))
  if (f.to) where.push(lte(table.startDate, f.to))
  if (f.workerId) where.push(eq(table.workerId, f.workerId))
  if (f.departmentId) where.push(eq(workers.departmentId, f.departmentId))
  if (f.decidedById) where.push(eq(table.decidedById, f.decidedById))
  if (f.ids?.length) where.push(inArray(table.id, f.ids))
  if (f.q) {
    const term = `%${f.q}%`
    where.push(or(sql`${workers.name} ilike ${term}`, sql`${workers.employeeId} ilike ${term}`, sql`${table.reason} ilike ${term}`))
  }
  return where
}

export async function listLeaveRequests(f: RequestFilters) {
  const where = filterWhere(leaveRequests, f)
  if (f.leaveTypeId) where.push(eq(leaveRequests.leaveTypeId, f.leaveTypeId))
  return (await listLeaveRows(and(...where), f.limit ?? 500)).map(leaveDto)
}

const shiftColumns = {
  request: shiftChangeRequests,
  workerName: workers.name,
  workerEmployeeId: workers.employeeId,
  workerDesignation: workers.designation,
  workerEmail: workers.email,
  departmentName: departments.name,
  currentShiftName: currentShifts.name,
  currentShiftStart: currentShifts.startTime,
  currentShiftEnd: currentShifts.endTime,
  requestedShiftName: shifts.name,
  requestedShiftStart: shifts.startTime,
  requestedShiftEnd: shifts.endTime,
  decidedByName: deciders.name
}
type ShiftRow = Awaited<ReturnType<typeof listShiftRows>>[number]

function listShiftRows(where: SQL | undefined, limit = 500) {
  return db
    .select(shiftColumns)
    .from(shiftChangeRequests)
    .innerJoin(workers, eq(workers.id, shiftChangeRequests.workerId))
    .innerJoin(shifts, eq(shifts.id, shiftChangeRequests.requestedShiftId))
    .leftJoin(currentShifts, eq(currentShifts.id, shiftChangeRequests.currentShiftId))
    .leftJoin(departments, eq(departments.id, workers.departmentId))
    .leftJoin(deciders, eq(deciders.id, shiftChangeRequests.decidedById))
    .where(where)
    .orderBy(desc(shiftChangeRequests.createdAt))
    .limit(limit)
}

const shiftDto = (r: ShiftRow) => {
  const { attachmentPath, ...rest } = r.request
  return {
    ...rest,
    hasAttachment: !!attachmentPath,
    workerName: r.workerName,
    workerEmployeeId: r.workerEmployeeId,
    workerDesignation: r.workerDesignation,
    departmentName: r.departmentName,
    currentShiftName: r.currentShiftName,
    currentShiftTime: r.currentShiftStart ? `${r.currentShiftStart}–${r.currentShiftEnd}` : null,
    requestedShiftName: r.requestedShiftName,
    requestedShiftTime: `${r.requestedShiftStart}–${r.requestedShiftEnd}`,
    decidedByName: r.decidedByName
  }
}
export type ShiftChangeDto = ReturnType<typeof shiftDto>

export async function listShiftChanges(f: RequestFilters) {
  return (await listShiftRows(and(...filterWhere(shiftChangeRequests, f)), f.limit ?? 500)).map(shiftDto)
}

/** Requests waiting for a decision (the Leave Approval badge). */
export async function pendingCounts() {
  const [[l], [s]] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int` }).from(leaveRequests).where(eq(leaveRequests.status, 'PENDING')),
    db.select({ n: sql<number>`count(*)::int` }).from(shiftChangeRequests).where(eq(shiftChangeRequests.status, 'PENDING'))
  ])
  return { leave: l.n, shiftChanges: s.n, total: l.n + s.n }
}

// ---------------------------------------------------------------------------- Requests: applying

interface Actor {
  id: string
  name: string
  employeeId: string
}

/** One request at a time per worker, so two taps (or two devices) cannot both pass the overlap check. */
const lockWorker = (tx: Transaction, workerId: string) => tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'leave:' + workerId}))`)

export interface LeaveInput {
  leaveTypeId: string
  /** A custom leave type's own name, entered by the employee. */
  customType?: string | null
  dayPart: DayPart
  startDate: string
  endDate: string
  reason: string
}

/** Checks a leave request against the rules; returns the days it counts. Used to apply and to preview. */
export async function checkLeave(workerId: string, input: LeaveInput, _hasAttachment: boolean, tx: Transaction | typeof db = db, excludeId?: string) {
  const s = await getLeaveSettings()
  const [type] = await tx.select().from(leaveTypes).where(eq(leaveTypes.id, input.leaveTypeId))
  if (!type || !type.isActive) throw badRequest('Choose a leave type')
  if (!isDateKey(input.startDate) || !isDateKey(input.endDate)) throw badRequest('Choose valid dates')
  if (input.endDate < input.startDate) throw badRequest('The end date must be on or after the start date')
  if (input.dayPart !== 'FULL') {
    if (!type.allowHalfDay) throw badRequest(`${type.name} cannot be taken as a half day`)
    if (input.startDate !== input.endDate) throw badRequest('A half day is one date: choose the same start and end date')
  }
  const today = todayKey()
  const earliest = dateKey(addDays(parseDateKey(today), -s.maxPastDays))
  if (input.startDate < earliest) {
    throw badRequest(s.maxPastDays ? `Leave can start at most ${s.maxPastDays} day${s.maxPastDays === 1 ? '' : 's'} back (from ${formatDateKey(earliest)})` : 'Leave cannot start in the past')
  }
  if (type.advanceNoticeDays > 0) {
    const first = dateKey(addDays(parseDateKey(today), type.advanceNoticeDays))
    if (input.startDate < first) throw badRequest(`${type.name} must be requested ${type.advanceNoticeDays} day${type.advanceNoticeDays === 1 ? '' : 's'} ahead: the earliest start is ${formatDateKey(first)}`)
  }
  const spanDays = (parseDateKey(input.endDate).getTime() - parseDateKey(input.startDate).getTime()) / 86_400_000 + 1
  if (spanDays > 366) throw badRequest('A leave request can cover at most one year')

  // Overlap with the worker's pending or approved leave (two different halves of one day are fine).
  const overlapping = await tx
    .select({ id: leaveRequests.id, startDate: leaveRequests.startDate, endDate: leaveRequests.endDate, dayPart: leaveRequests.dayPart, status: leaveRequests.status })
    .from(leaveRequests)
    .where(
      and(
        eq(leaveRequests.workerId, workerId),
        inArray(leaveRequests.status, ['PENDING', 'APPROVED']),
        lte(leaveRequests.startDate, input.endDate),
        gte(leaveRequests.endDate, input.startDate),
        excludeId ? ne(leaveRequests.id, excludeId) : undefined
      )
    )
  const clash = overlapping.find((o) => !(input.dayPart !== 'FULL' && o.dayPart !== 'FULL' && o.dayPart !== input.dayPart))
  if (clash) {
    throw conflict(
      `You already have ${clash.status === 'PENDING' ? 'a pending' : 'an approved'} leave for ${formatDateKey(clash.startDate)}${clash.endDate !== clash.startDate ? ` – ${formatDateKey(clash.endDate)}` : ''}. Cancel it first, or choose other dates.`
    )
  }

  const { days, skipped } = await countLeaveDays(input.startDate, input.endDate, input.dayPart, s)
  if (type.maxConsecutiveDays !== null && days > type.maxConsecutiveDays) {
    throw badRequest(`${type.name} can be at most ${type.maxConsecutiveDays} day${type.maxConsecutiveDays === 1 ? '' : 's'} at a time (this is ${days})`)
  }
  if (type.annualQuota !== null) {
    const { balances } = await balancesFor([workerId], input.startDate, s)
    const row = balances.get(workerId)?.find((b) => b.leaveTypeId === type.id)
    const left = row?.remaining ?? 0
    if (days > left) {
      throw badRequest(
        left <= 0
          ? `No ${type.name} balance left for this leave year${row && row.pending ? ` (${row.pending} day${row.pending === 1 ? '' : 's'} already pending)` : ''}.`
          : `Not enough ${type.name} balance: ${left} day${left === 1 ? '' : 's'} left, this request is ${days}.`
      )
    }
  }
  return { type, days, skipped, settings: s }
}

export async function applyForLeave(req: Request, worker: Actor, input: LeaveInput, file?: Express.Multer.File) {
  const stored = await storeAttachment(file)
  try {
    const row = await db.transaction(async (tx) => {
      await lockWorker(tx, worker.id)
      const { days, type } = await checkLeave(worker.id, input, !!stored, tx)
      const customType = type.isCustom ? (input.customType ?? '').trim() : ''
      if (type.isCustom && customType.length < 2) throw badRequest(`${type.name}: enter the name of your leave (e.g. Marriage leave)`)
      const [row] = await tx
        .insert(leaveRequests)
        .values({ workerId: worker.id, leaveTypeId: input.leaveTypeId, customType: customType || null, dayPart: input.dayPart, startDate: input.startDate, endDate: input.endDate, days, reason: input.reason, ...(stored ?? {}) })
        .returning()
      await audit(req, 'SUBMIT_LEAVE', 'LeaveRequest', row.id, { newValue: { worker: `${worker.name} (${worker.employeeId})`, ...input, days, attachment: stored?.attachmentName ?? null } }, tx)
      return row
    })
    const [dto] = await listLeaveRequests({ ids: [row.id] })
    void notifySubmitted('leave', dto)
    return dto
  } catch (err) {
    if (stored) await fs.rm(attachmentFile(stored.attachmentPath), { force: true }).catch(() => {})
    throw err
  }
}

export interface ShiftChangeInput {
  requestedShiftId: string
  startDate: string
  endDate: string
  reason: string
}

export async function checkShiftChange(workerId: string, input: ShiftChangeInput, tx: Transaction | typeof db = db) {
  const s = await getLeaveSettings()
  const [worker] = await tx.select({ shiftId: users.shiftId }).from(users).where(eq(users.id, workerId))
  const [shift] = await tx.select().from(shifts).where(eq(shifts.id, input.requestedShiftId))
  if (!shift || !shift.isActive) throw badRequest('Choose the shift you want to work')
  if (worker?.shiftId === shift.id) throw badRequest(`You already work ${shift.name}`)
  if (!isDateKey(input.startDate) || !isDateKey(input.endDate)) throw badRequest('Choose valid dates')
  if (input.endDate < input.startDate) throw badRequest('The end date must be on or after the start date')
  if (input.startDate < todayKey()) throw badRequest('A shift change cannot start in the past')
  const span = (parseDateKey(input.endDate).getTime() - parseDateKey(input.startDate).getTime()) / 86_400_000 + 1
  if (span > s.maxShiftChangeDays) throw badRequest(`A shift change can cover at most ${s.maxShiftChangeDays} days`)
  const [clash] = await tx
    .select({ startDate: shiftChangeRequests.startDate, endDate: shiftChangeRequests.endDate, status: shiftChangeRequests.status })
    .from(shiftChangeRequests)
    .where(
      and(
        eq(shiftChangeRequests.workerId, workerId),
        inArray(shiftChangeRequests.status, ['PENDING', 'APPROVED']),
        lte(shiftChangeRequests.startDate, input.endDate),
        gte(shiftChangeRequests.endDate, input.startDate)
      )
    )
    .limit(1)
  if (clash) {
    throw conflict(
      `You already have ${clash.status === 'PENDING' ? 'a pending' : 'an approved'} shift change for ${formatDateKey(clash.startDate)}${clash.endDate !== clash.startDate ? ` – ${formatDateKey(clash.endDate)}` : ''}.`
    )
  }
  return { currentShiftId: worker?.shiftId ?? null, shift }
}

export async function requestShiftChange(req: Request, worker: Actor, input: ShiftChangeInput, file?: Express.Multer.File) {
  const stored = await storeAttachment(file)
  try {
    const row = await db.transaction(async (tx) => {
      await lockWorker(tx, worker.id)
      const { currentShiftId, shift } = await checkShiftChange(worker.id, input, tx)
      const [row] = await tx
        .insert(shiftChangeRequests)
        .values({ workerId: worker.id, currentShiftId, requestedShiftId: shift.id, startDate: input.startDate, endDate: input.endDate, reason: input.reason, ...(stored ?? {}) })
        .returning()
      await audit(req, 'SUBMIT_SHIFT_CHANGE', 'ShiftChangeRequest', row.id, { newValue: { worker: `${worker.name} (${worker.employeeId})`, ...input, shift: shift.name } }, tx)
      return row
    })
    const [dto] = await listShiftChanges({ ids: [row.id] })
    void notifySubmitted('shift', dto)
    return dto
  } catch (err) {
    if (stored) await fs.rm(attachmentFile(stored.attachmentPath), { force: true }).catch(() => {})
    throw err
  }
}

// ---------------------------------------------------------------------------- Requests: deciding, cancelling

export type RequestKind = 'leave' | 'shift'

/**
 * Approves or rejects a pending request (Leave approve permission, checked by the route). Claimed
 * with the row locked, so a request is decided once: a second decision gets 409 and sends nothing.
 */
export async function decideRequest(req: Request, kind: RequestKind, id: string, approve: boolean, comment: string | null) {
  const actor = req.user!
  const table = kind === 'leave' ? leaveRequests : shiftChangeRequests
  const result = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(table).where(eq(table.id, id)).for('update')
    if (!row) throw notFound(kind === 'leave' ? 'Leave request' : 'Shift change request')
    if (row.status !== 'PENDING') throw conflict(`This request is already ${row.status.toLowerCase()}`)
    // Nobody decides their own request.
    if (row.workerId === actor.id) throw forbidden('You cannot decide your own request')
    if (approve && kind === 'leave') {
      // The balance is checked again: other leave may have been approved since it was sent.
      const r = row as typeof leaveRequests.$inferSelect
      const [type] = await tx.select().from(leaveTypes).where(eq(leaveTypes.id, r.leaveTypeId))
      if (type?.annualQuota !== null && type) {
        const { balances } = await balancesFor([r.workerId], r.startDate)
        const b = balances.get(r.workerId)?.find((x) => x.leaveTypeId === type.id)
        // This request is counted in pending; what is left without it must cover it.
        const left = (b?.remaining ?? 0) + r.days
        if (r.days > left) throw conflict(`Not enough ${type.name} balance to approve: ${round(left)} day${left === 1 ? '' : 's'} left, this request is ${r.days}`)
      }
    }
    const now = new Date()
    await tx
      .update(table)
      .set({ status: approve ? 'APPROVED' : 'REJECTED', decidedById: actor.id, decidedAt: now, decisionComment: comment, updatedAt: now })
      .where(eq(table.id, id))
    await audit(
      req,
      `${approve ? 'APPROVE' : 'REJECT'}_${kind === 'leave' ? 'LEAVE' : 'SHIFT_CHANGE'}`,
      kind === 'leave' ? 'LeaveRequest' : 'ShiftChangeRequest',
      id,
      { oldValue: { status: 'PENDING' }, newValue: { status: approve ? 'APPROVED' : 'REJECTED', comment, decidedBy: `${actor.name} (${actor.employeeId})`, at: now.toISOString() } },
      tx
    )
    return row
  })
  if (approve) await replanChecks(result.workerId, result.startDate, result.endDate)
  const dto = kind === 'leave' ? (await listLeaveRequests({ ids: [id] }))[0] : (await listShiftChanges({ ids: [id] }))[0]
  void notifyDecided(kind, dto)
  return dto
}

/**
 * Cancels a request. The worker: their own pending one, or an approved one not started yet (when the
 * settings allow it). Staff with Leave edit: any pending or approved one. Cancelling approved leave
 * gives the days back and the worker's checks on those days are made again.
 */
export async function cancelRequest(req: Request, kind: RequestKind, id: string, asWorker: boolean) {
  const actor = req.user!
  const table = kind === 'leave' ? leaveRequests : shiftChangeRequests
  const s = await getLeaveSettings()
  const row = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(table).where(eq(table.id, id)).for('update')
    if (!row || (asWorker && row.workerId !== actor.id)) throw notFound(kind === 'leave' ? 'Leave request' : 'Shift change request')
    if (row.status !== 'PENDING' && row.status !== 'APPROVED') throw conflict(`This request is already ${row.status.toLowerCase()}`)
    if (asWorker && row.status === 'APPROVED') {
      if (!s.workerCanCancelApproved) throw forbidden('An approved request can only be cancelled by your supervisor')
      if (row.startDate <= todayKey()) throw badRequest('It has already started: ask your supervisor to cancel it')
    }
    const now = new Date()
    await tx.update(table).set({ status: 'CANCELLED', cancelledById: actor.id, cancelledAt: now, updatedAt: now }).where(eq(table.id, id))
    await audit(req, `CANCEL_${kind === 'leave' ? 'LEAVE' : 'SHIFT_CHANGE'}`, kind === 'leave' ? 'LeaveRequest' : 'ShiftChangeRequest', id, {
      oldValue: { status: row.status },
      newValue: { status: 'CANCELLED', by: `${actor.name} (${actor.employeeId})` }
    }, tx)
    return row
  })
  // The days of an approved request are normal work days again.
  if (row.status === 'APPROVED') await replanChecks(row.workerId, row.startDate, row.endDate)
  return kind === 'leave' ? (await listLeaveRequests({ ids: [id] }))[0] : (await listShiftChanges({ ids: [id] }))[0]
}

// ---------------------------------------------------------------------------- Calendar and reports

/** Leave and shift changes between two dates, with the plant's closed days, for the calendar. */
export async function leaveCalendar(fromKey: string, toKey: string, includePending: boolean) {
  const statuses: RequestStatus[] = includePending ? ['APPROVED', 'PENDING'] : ['APPROVED']
  const [leave, changes, days] = await Promise.all([
    listLeaveRequests({ from: fromKey, to: toKey, limit: 2000 }),
    listShiftChanges({ from: fromKey, to: toKey, limit: 2000 }),
    dayStates(parseDateKey(fromKey), parseDateKey(toKey))
  ])
  return {
    leave: leave.filter((l) => statuses.includes(l.status)),
    shiftChanges: changes.filter((c) => statuses.includes(c.status)),
    closedDays: days.filter((d) => d.closed).map((d) => ({ date: d.date, label: d.label }))
  }
}

/** Every active worker's balance in the leave year of `atKey`, with taken days per type in the period. */
export async function leaveReport(atKey: string) {
  const s = await getLeaveSettings()
  const people = await db
    .select({ id: users.id, name: users.name, employeeId: users.employeeId, isActive: users.isActive, designation: users.designation, department: departments.name })
    .from(users)
    .leftJoin(departments, eq(departments.id, users.departmentId))
    .where(eq(users.role, 'WORKER'))
    .orderBy(asc(users.name))
  const { year, balances } = await balancesFor(
    people.map((p) => p.id),
    atKey,
    s
  )
  return {
    year,
    rows: people
      .filter((p) => p.isActive || (balances.get(p.id) ?? []).some((b) => b.used || b.pending))
      .map((p) => ({ workerId: p.id, name: p.name, employeeId: p.employeeId, designation: p.designation, department: p.department, balances: balances.get(p.id) ?? [] }))
  }
}

// ---------------------------------------------------------------------------- Emails and push

const esc = (v: unknown) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const unique = (list: (string | null | undefined)[]) => [...new Map(list.filter((e): e is string => !!e && EMAIL_RE.test(e.trim())).map((e) => [e.trim().toLowerCase(), e.trim()])).values()]

/** The staff who may approve requests and have an email on their account (Super Admins included). */
async function approverEmails() {
  const staff = await db
    .select({ id: users.id, role: users.role, email: users.email })
    .from(users)
    .where(and(inArray(users.role, ['SUPER_ADMIN', 'ADMIN', 'MANAGER']), eq(users.isActive, true)))
  const result: string[] = []
  for (const u of staff) {
    if (!u.email) continue
    if (u.role === 'SUPER_ADMIN' || (await loadActions(u.id, u.role)).leave.approve) result.push(u.email)
  }
  return result
}

function table(rows: [string, string][]) {
  return `<table cellpadding="6" style="border-collapse:collapse;font-size:14px">${rows
    .map(([k, v]) => `<tr><td style="color:#64748b;vertical-align:top;white-space:nowrap">${esc(k)}</td><td style="color:#0f172a"><b>${esc(v)}</b></td></tr>`)
    .join('')}</table>`
}
function emailHtml(intro: string, rows: [string, string][], outro: string) {
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1e293b;line-height:1.5">${intro}${table(rows)}${outro}</div>`
}
const text = (intro: string, rows: [string, string][], outro: string) =>
  `${intro.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ')}\n\n${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n${outro.replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, '')}`

const range = (a: string, b: string) => (a === b ? formatDateKey(a) : `${formatDateKey(a)} – ${formatDateKey(b)}`)

async function sendLeaveEmail(recipients: string[], subject: string, intro: string, rows: [string, string][], outro: string) {
  if (!recipients.length) return
  const { getReportSharingSettings } = await import('./automatedReports')
  const smtp = smtpOf(await getReportSharingSettings())
  await sendLoggedEmail({
    log: { trigger: 'LEAVE', recipients, subject, checkIds: [], checksCount: 0 },
    mail: { subject, html: emailHtml(intro, rows, outro), text: text(intro, rows, outro) },
    smtp
  }).catch((err) => console.error(JSON.stringify({ event: 'leave_email_failed', subject, error: err instanceof Error ? err.message : String(err) })))
}

const leaveRows = (d: LeaveDto): [string, string][] => [
  ['Employee Name', d.workerName],
  ['Employee ID', d.workerEmployeeId],
  ['Department', d.departmentName ?? '—'],
  ['Leave Type', d.leaveTypeName],
  ['Leave Duration', d.dayPart === 'FULL' ? 'Full Day' : d.dayPart === 'FIRST_HALF' ? 'Half Day (First Half)' : 'Half Day (Second Half)'],
  ['From Date', formatDateKey(d.startDate)],
  ['To Date', formatDateKey(d.endDate)],
  ['Total Leave Days', String(d.days)]
]
const shiftRows = (d: ShiftChangeDto): [string, string][] => [
  ['Employee Name', d.workerName],
  ['Employee ID', d.workerEmployeeId],
  ['Department', d.departmentName ?? '—'],
  ['Current Shift', d.currentShiftName ? `${d.currentShiftName} (${d.currentShiftTime})` : '—'],
  ['Requested Shift', `${d.requestedShiftName} (${d.requestedShiftTime})`],
  ['Dates', range(d.startDate, d.endDate)]
]

/** A new request: to the approvers (and the configured extra addresses), a copy to the Super Admin. */
async function notifySubmitted(kind: RequestKind, d: LeaveDto | ShiftChangeDto) {
  const s = await getLeaveSettings()
  const to = unique([...(s.notify.approvers ? await approverEmails() : []), ...s.notify.approverEmails, s.notify.copySuperAdmin ? s.notify.superAdminEmail : null, ...s.notify.ccEmails])
  if (kind === 'leave') {
    const l = d as LeaveDto
    await sendLeaveEmail(
      to,
      `New Leave Request – ${l.workerName}`,
      `<p>A new leave request is waiting for approval.</p>`,
      [...leaveRows(l), ['Reason', l.reason], ['Applied On', formatDateKey(dateKey(new Date(l.createdAt)))]],
      `<p>Open <b>Leave Management → Leave Approval</b> in the admin panel to approve or reject it.</p><p>Regards,<br>HR / Leave Management System</p>`
    )
  } else {
    const c = d as ShiftChangeDto
    await sendLeaveEmail(
      to,
      `New Shift Change Request – ${c.workerName}`,
      `<p>A new shift change request is waiting for approval.</p>`,
      [...shiftRows(c), ['Reason', c.reason], ['Applied On', formatDateKey(dateKey(new Date(c.createdAt)))]],
      `<p>Open <b>Leave Management → Shift Change Approval</b> in the admin panel to approve or reject it.</p><p>Regards,<br>HR / Leave Management System</p>`
    )
  }
}

/** A decision: to the worker (email on their account) and the copies; a push to the worker's phone. */
async function notifyDecided(kind: RequestKind, d: LeaveDto | ShiftChangeDto) {
  const s = await getLeaveSettings()
  const approved = d.status === 'APPROVED'
  const word = approved ? 'Approved' : 'Rejected'
  const what = kind === 'leave' ? 'Leave Request' : 'Shift Change Request'
  const [worker] = await db.select({ email: users.email }).from(users).where(eq(users.id, d.workerId))
  const to = unique([s.notify.worker ? worker?.email : null, s.notify.copySuperAdmin ? s.notify.superAdminEmail : null, ...s.notify.ccEmails])
  const rows: [string, string][] = [
    ...(kind === 'leave' ? leaveRows(d as LeaveDto) : shiftRows(d as ShiftChangeDto)),
    [approved ? 'Approved By' : 'Rejected By', d.decidedByName ?? '—'],
    ['Remarks', d.decisionComment || '—']
  ]
  await sendLeaveEmail(
    to,
    `${what} ${word} – ${d.workerName}`,
    `<p>Dear ${esc(d.workerName)},</p><p>Your ${what.toLowerCase()} has been reviewed and <b>${word.toLowerCase()}</b>.</p>`,
    rows,
    `<p>Please contact your manager if you need any further clarification.</p><p>Regards,<br>HR / Leave Management System</p>`
  )
  const dates = range(d.startDate, d.endDate)
  await sendToUser(
    d.workerId,
    `${kind === 'leave' ? 'Leave' : 'Shift change'} ${word.toLowerCase()}`,
    kind === 'leave' ? `${(d as LeaveDto).leaveTypeName}, ${dates}${d.decisionComment ? ` · ${d.decisionComment}` : ''}` : `${(d as ShiftChangeDto).requestedShiftName}, ${dates}${d.decisionComment ? ` · ${d.decisionComment}` : ''}`,
    { type: 'LEAVE_DECISION', kind, id: d.id, status: d.status }
  ).catch((err) => console.error(JSON.stringify({ event: 'leave_push_failed', id: d.id, error: err instanceof Error ? err.message : String(err) })))
}

/** The worker's own leave page in the app: types, balances, requests and the shifts to choose from. */
export async function workerLeaveOverview(workerId: string) {
  const s = await getLeaveSettings()
  const [types, { year, balances }, leave, changes, shiftList, [me]] = await Promise.all([
    db.select().from(leaveTypes).where(eq(leaveTypes.isActive, true)).orderBy(asc(leaveTypes.sortOrder), asc(leaveTypes.name)),
    balancesFor([workerId], todayKey(), s),
    listLeaveRequests({ workerId, limit: 200 }),
    listShiftChanges({ workerId, limit: 200 }),
    db.select({ id: shifts.id, name: shifts.name, startTime: shifts.startTime, endTime: shifts.endTime }).from(shifts).where(eq(shifts.isActive, true)).orderBy(asc(shifts.startTime)),
    db.select({ shiftId: users.shiftId }).from(users).where(eq(users.id, workerId))
  ])
  return {
    year,
    types: types.map((t) => ({
      id: t.id,
      name: t.name,
      code: t.code,
      isPaid: t.isPaid,
      allowHalfDay: t.allowHalfDay,
      requiresAttachment: t.requiresAttachment,
      isCustom: t.isCustom,
      advanceNoticeDays: t.advanceNoticeDays,
      maxConsecutiveDays: t.maxConsecutiveDays,
      quota: t.annualQuota
    })),
    balances: balances.get(workerId) ?? [],
    leave,
    shiftChanges: changes,
    shifts: shiftList,
    currentShiftId: me?.shiftId ?? null,
    rules: { maxPastDays: s.maxPastDays, maxShiftChangeDays: s.maxShiftChangeDays, workerCanCancelApproved: s.workerCanCancelApproved }
  }
}

