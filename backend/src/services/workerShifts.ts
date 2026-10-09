import { and, eq, gt, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { auditLogs, pushTokens, schedules, settings, shifts, users, workerShiftLogins } from '../db/schema'
import { addDays, atTime, dateKey, formatLocalTime, startOfDay } from '../lib/time'
import { closureOn } from './plantCalendar'
import { sendShiftLoginReminder } from './notifications'

/**
 * Shift-based sign-in for workers (mobile app).
 *
 *  - A worker's shifts are the shift on their account plus the shifts of the schedules given to them.
 *    Times are plant-local (lib/time.ts); an end at or before the start runs into the next day, so
 *    a 22:00-06:00 shift ends at 06:00 the next morning, not at midnight.
 *  - Signing in is tied to the shift running now (or starting within `earlyLoginMinutes`): the
 *    session ends when that shift ends (lib/auth.ts `sx` claim), and the backend refuses the
 *    worker's requests from then on. Back-to-back shifts count as one, so nobody is logged out
 *    between two shifts that follow each other.
 *  - When a shift starts and the worker has not signed in, the phone gets a notification and a voice
 *    alert (services/notifications.ts), repeated every `reminderIntervalMinutes` up to `maxReminders`
 *    times, and never on a plant-closed day. Signing in stops them.
 *  - A worker with no shift is not affected: no automatic logout, no reminders.
 *
 * Every step is recorded in worker_shift_logins (for the Workers page) and in the audit log.
 */

export interface ShiftLoginSettings {
  /** Send shift-start login reminders. */
  enabled: boolean
  /** Tie a worker's sign-in to their shift and log them out when it ends. */
  autoLogout: boolean
  /** Minutes between reminders while the worker has not signed in. */
  reminderIntervalMinutes: number
  /** Reminders per shift, the first one included. */
  maxReminders: number
  /** How early before a shift starts a worker may sign in for it. */
  earlyLoginMinutes: number
}

export const SHIFT_LOGIN_DEFAULTS: ShiftLoginSettings = {
  enabled: true,
  autoLogout: true,
  reminderIntervalMinutes: 10,
  maxReminders: 3,
  earlyLoginMinutes: 60
}

const SETTINGS_KEY = 'shiftLogin'

export async function getShiftLoginSettings(): Promise<ShiftLoginSettings> {
  const [row] = await db.select().from(settings).where(eq(settings.key, SETTINGS_KEY))
  return { ...SHIFT_LOGIN_DEFAULTS, ...((row?.value as Partial<ShiftLoginSettings> | undefined) ?? {}) }
}

export async function saveShiftLoginSettings(next: ShiftLoginSettings) {
  await db
    .insert(settings)
    .values({ key: SETTINGS_KEY, value: next })
    .onConflictDoUpdate({ target: settings.key, set: { value: next, updatedAt: new Date() } })
  return next
}

// ------------------------------------------------------------------------------- shift timing

interface ShiftRow {
  id: string
  name: string
  startTime: string
  endTime: string
}

/** A stretch of work: one shift occurrence, or several that follow each other without a gap. */
export interface ShiftBlock {
  shiftId: string
  shiftName: string
  start: Date
  end: Date
}

/** The occurrences of these shifts from the day before `at` to two days after, oldest first. */
function occurrences(list: ShiftRow[], at: Date): ShiftBlock[] {
  const today = startOfDay(at)
  const result: ShiftBlock[] = []
  for (const s of list) {
    for (const offset of [-1, 0, 1, 2]) {
      const day = addDays(today, offset)
      const start = atTime(day, s.startTime)
      let end = atTime(day, s.endTime)
      // Overnight: the shift ends on the next day.
      if (end <= start) end = addDays(end, 1)
      result.push({ shiftId: s.id, shiftName: s.name, start, end })
    }
  }
  return result.sort((a, b) => a.start.getTime() - b.start.getTime())
}

/** Occurrences that overlap or touch are joined, so back-to-back shifts are one stretch of work. */
function mergeBlocks(blocks: ShiftBlock[]): ShiftBlock[] {
  const merged: ShiftBlock[] = []
  for (const b of blocks) {
    const last = merged[merged.length - 1]
    if (last && b.start <= last.end) {
      if (b.end > last.end) last.end = b.end
    } else {
      merged.push({ ...b })
    }
  }
  return merged
}

/** The stretch of work running at `at`, and the next one starting after it. */
export function shiftBlocksAt(list: ShiftRow[], at: Date) {
  const blocks = mergeBlocks(occurrences(list, at))
  const current = blocks.find((b) => b.start <= at && at < b.end) ?? null
  const next = blocks.find((b) => b.start > at) ?? null
  return { current, next }
}

/** The active shifts a worker works: the one on their account and those of their schedules. */
export async function workerShiftList(workerId: string): Promise<ShiftRow[]> {
  const [user] = await db.select({ shiftId: users.shiftId }).from(users).where(eq(users.id, workerId))
  const fromSchedules = await db
    .select({ shiftId: schedules.shiftId })
    .from(schedules)
    .where(and(eq(schedules.workerId, workerId), eq(schedules.isActive, true), isNotNull(schedules.shiftId)))
  const ids = [...new Set([user?.shiftId, ...fromSchedules.map((s) => s.shiftId)].filter((id): id is string => !!id))]
  if (!ids.length) return []
  return db
    .select({ id: shifts.id, name: shifts.name, startTime: shifts.startTime, endTime: shifts.endTime })
    .from(shifts)
    .where(and(inArray(shifts.id, ids), eq(shifts.isActive, true)))
}

export type SignInWindow =
  /** No shift: sign-in works as before, with no shift limit. */
  | { kind: 'none' }
  /** On shift now (or about to start): the session lasts until `block.end`. */
  | { kind: 'on'; block: ShiftBlock }
  /** Between shifts: signing in waits for the next one. */
  | { kind: 'off'; next: ShiftBlock | null; earlyLoginMinutes: number }

/** Which shift a worker signing in at `at` belongs to, or why they cannot sign in yet. */
export async function signInWindow(workerId: string, at = new Date(), settingsNow?: ShiftLoginSettings): Promise<SignInWindow> {
  const config = settingsNow ?? (await getShiftLoginSettings())
  if (!config.autoLogout) return { kind: 'none' }
  const list = await workerShiftList(workerId)
  if (!list.length) return { kind: 'none' }
  const { current, next } = shiftBlocksAt(list, at)
  if (current) return { kind: 'on', block: current }
  if (next && next.start.getTime() - at.getTime() <= config.earlyLoginMinutes * 60_000) return { kind: 'on', block: next }
  return { kind: 'off', next, earlyLoginMinutes: config.earlyLoginMinutes }
}

/** "Your shift (Shift A, 9:00 AM – 6:00 PM) has not started yet. You can sign in from 8:00 AM." */
export function offShiftMessage(window: Extract<SignInWindow, { kind: 'off' }>) {
  if (!window.next) return 'You are not on shift now. Please sign in during your shift.'
  const from = new Date(window.next.start.getTime() - window.earlyLoginMinutes * 60_000)
  const day = dateKey(window.next.start) === dateKey(new Date()) ? '' : ` on ${dateKey(window.next.start).split('-').reverse().join('/')}`
  return `You are not on shift now. Your next shift (${window.next.shiftName}, ${formatLocalTime(window.next.start)} – ${formatLocalTime(window.next.end)}) starts${day} at ${formatLocalTime(window.next.start)}. You can sign in from ${formatLocalTime(from)}.`
}

// ------------------------------------------------------------------------------- sessions

/** Writes to the audit log from the scheduler, where there is no signed-in user. */
async function auditSystem(action: string, workerId: string, value: Record<string, unknown>, workerLabel?: string) {
  await db.insert(auditLogs).values({
    userId: null,
    userName: 'System (shift sign-in)',
    role: 'SYSTEM',
    action,
    entity: 'User',
    entityId: workerId,
    newValue: workerLabel ? { worker: workerLabel, ...value } : value
  })
}

/**
 * Records a worker's sign-in for a shift. Returns whether reminders had been sent for this shift
 * before (the worker signed in after being reminded).
 */
export async function recordShiftLogin(workerId: string, block: ShiftBlock, at = new Date()) {
  const [before] = await db
    .select({ loginAt: workerShiftLogins.loginAt, remindersSent: workerShiftLogins.remindersSent })
    .from(workerShiftLogins)
    .where(and(eq(workerShiftLogins.workerId, workerId), eq(workerShiftLogins.shiftStart, block.start)))
  await db
    .insert(workerShiftLogins)
    .values({ workerId, shiftId: block.shiftId, shiftStart: block.start, shiftEnd: block.end, loginAt: at, lastLoginAt: at })
    .onConflictDoUpdate({
      target: [workerShiftLogins.workerId, workerShiftLogins.shiftStart],
      set: {
        loginAt: sql`coalesce(${workerShiftLogins.loginAt}, ${at})`,
        lastLoginAt: at,
        shiftEnd: block.end,
        logoutAt: null,
        logoutReason: null
      }
    })
  return { afterReminder: !before?.loginAt && (before?.remindersSent ?? 0) > 0, remindersSent: before?.remindersSent ?? 0 }
}

/** The worker signed out on purpose during a shift. */
export async function recordShiftLogout(workerId: string, at = new Date()) {
  await db
    .update(workerShiftLogins)
    .set({ logoutAt: at, logoutReason: 'MANUAL' })
    .where(
      and(
        eq(workerShiftLogins.workerId, workerId),
        isNotNull(workerShiftLogins.loginAt),
        isNull(workerShiftLogins.logoutAt),
        sql`${workerShiftLogins.shiftEnd} > ${at}`
      )
    )
}

// ------------------------------------------------------------------------------- scheduler

/**
 * Every minute (index.ts tick): records the automatic logouts of shifts that have ended, and sends
 * the shift-start login reminders that are due. Safe to run from several processes at once: each
 * reminder is claimed in one conditional update before it is sent.
 */
export async function runShiftLoginTick(now = new Date()) {
  const config = await getShiftLoginSettings()

  // 1. Sessions whose shift has ended: the backend already refuses them (lib/auth.ts); record it.
  const ended = await db
    .update(workerShiftLogins)
    .set({ logoutAt: sql`${workerShiftLogins.shiftEnd}`, logoutReason: 'SHIFT_ENDED' })
    .where(and(isNotNull(workerShiftLogins.loginAt), isNull(workerShiftLogins.logoutAt), lte(workerShiftLogins.shiftEnd, now)))
    .returning({ workerId: workerShiftLogins.workerId, shiftEnd: workerShiftLogins.shiftEnd })
  if (ended.length) {
    // Their phones get no more due-check alerts, only next shift's login reminder.
    await db
      .update(pushTokens)
      .set({ signedOutAt: now })
      .where(and(inArray(pushTokens.userId, [...new Set(ended.map((e) => e.workerId))]), isNull(pushTokens.signedOutAt)))
  }
  for (const e of ended) await auditSystem('AUTO_LOGOUT_SHIFT_END', e.workerId, { shiftEnd: e.shiftEnd })

  if (!config.enabled) return { autoLoggedOut: ended.length, reminders: 0 }

  // 2. Shift-start reminders for workers on shift who have not signed in.
  const workers = await db
    .select({ id: users.id, name: users.name, employeeId: users.employeeId, shiftId: users.shiftId })
    .from(users)
    .where(and(eq(users.role, 'WORKER'), eq(users.isActive, true), eq(users.appAccess, true)))
  if (!workers.length) return { autoLoggedOut: ended.length, reminders: 0 }
  const [shiftRows, scheduleRows] = await Promise.all([
    db.select({ id: shifts.id, name: shifts.name, startTime: shifts.startTime, endTime: shifts.endTime }).from(shifts).where(eq(shifts.isActive, true)),
    db
      .select({ workerId: schedules.workerId, shiftId: schedules.shiftId })
      .from(schedules)
      .where(and(eq(schedules.isActive, true), isNotNull(schedules.workerId), isNotNull(schedules.shiftId)))
  ])
  const shiftById = new Map(shiftRows.map((s) => [s.id, s]))
  // Workers signed in now (also those who signed in early, before their shift started).
  const signedIn = new Set(
    (
      await db
        .select({ workerId: workerShiftLogins.workerId })
        .from(workerShiftLogins)
        .where(and(isNotNull(workerShiftLogins.loginAt), isNull(workerShiftLogins.logoutAt), gt(workerShiftLogins.shiftEnd, now)))
    ).map((r) => r.workerId)
  )
  const closedByDay = new Map<string, boolean>()
  const intervalMs = Math.max(1, config.reminderIntervalMinutes) * 60_000
  let sent = 0

  for (const w of workers) {
    if (signedIn.has(w.id)) continue
    const ids = new Set([w.shiftId, ...scheduleRows.filter((s) => s.workerId === w.id).map((s) => s.shiftId)])
    const list = [...ids].map((id) => (id ? shiftById.get(id) : undefined)).filter((s): s is ShiftRow => !!s)
    if (!list.length) continue
    const { current } = shiftBlocksAt(list, now)
    if (!current) continue

    // The plant is closed on the shift's day (weekly off, holiday): nobody is expected to sign in.
    const day = dateKey(current.start)
    if (!closedByDay.has(day)) closedByDay.set(day, !!(await closureOn(current.start)))
    if (closedByDay.get(day)) continue

    await db
      .insert(workerShiftLogins)
      .values({ workerId: w.id, shiftId: current.shiftId, shiftStart: current.start, shiftEnd: current.end })
      .onConflictDoNothing()
    const [row] = await db
      .select()
      .from(workerShiftLogins)
      .where(and(eq(workerShiftLogins.workerId, w.id), eq(workerShiftLogins.shiftStart, current.start)))
    if (!row || row.loginAt) continue
    if (row.remindersSent >= config.maxReminders) continue
    if (row.lastReminderAt && now.getTime() - row.lastReminderAt.getTime() < intervalMs) continue

    // Claim this reminder number first, so two servers never send the same one.
    const claimed = await db
      .update(workerShiftLogins)
      .set({ remindersSent: row.remindersSent + 1, lastReminderAt: now, firstReminderAt: row.firstReminderAt ?? now })
      .where(and(eq(workerShiftLogins.id, row.id), eq(workerShiftLogins.remindersSent, row.remindersSent), isNull(workerShiftLogins.loginAt)))
      .returning({ id: workerShiftLogins.id })
    if (!claimed.length) continue

    const number = row.remindersSent + 1
    const label = `${w.name} (${w.employeeId})`
    if (number === 1) {
      await auditSystem('SHIFT_STARTED_NOT_LOGGED_IN', w.id, { shift: current.shiftName, shiftStart: current.start, shiftEnd: current.end }, label)
    }
    const result = await sendShiftLoginReminder(w.id, `${current.start.toISOString()}:${number}`)
    await auditSystem(
      'SHIFT_LOGIN_REMINDER',
      w.id,
      { shift: current.shiftName, reminder: number, of: config.maxReminders, devices: result.devices, voice: result.devices > 0 },
      label
    )
    sent++
  }
  return { autoLoggedOut: ended.length, reminders: sent }
}

// ------------------------------------------------------------------------------- admin view

export interface WorkerShiftStatus {
  workerId: string
  name: string
  employeeId: string
  shiftName: string | null
  /** The stretch of work running now, or null between shifts. */
  shiftStart: string | null
  shiftEnd: string | null
  onShift: boolean
  nextShiftStart: string | null
  loggedIn: boolean
  loginAt: string | null
  /** When the current session ends automatically (the shift end), while signed in. */
  autoLogoutAt: string | null
  /** Signed in at some point during the current shift. */
  loggedInThisShift: boolean
  remindersSent: number
  lastReminderAt: string | null
  /** How the latest session ended, shown when the worker is signed out. */
  lastLogoutAt: string | null
  lastLogoutReason: 'MANUAL' | 'SHIFT_ENDED' | null
}

/** Shift sign-in status of every active worker with app access, for the Workers page. */
export async function workerShiftStatuses(now = new Date()): Promise<WorkerShiftStatus[]> {
  const workers = await db
    .select({ id: users.id, name: users.name, employeeId: users.employeeId, shiftId: users.shiftId })
    .from(users)
    .where(and(eq(users.role, 'WORKER'), eq(users.isActive, true)))
  const [shiftRows, scheduleRows, sessions] = await Promise.all([
    db.select({ id: shifts.id, name: shifts.name, startTime: shifts.startTime, endTime: shifts.endTime }).from(shifts).where(eq(shifts.isActive, true)),
    db
      .select({ workerId: schedules.workerId, shiftId: schedules.shiftId })
      .from(schedules)
      .where(and(eq(schedules.isActive, true), isNotNull(schedules.workerId), isNotNull(schedules.shiftId))),
    // The last two days are enough to show the current and the previous shift.
    db.select().from(workerShiftLogins).where(sql`${workerShiftLogins.shiftEnd} > ${addDays(now, -2)}`)
  ])
  const shiftById = new Map(shiftRows.map((s) => [s.id, s]))
  return workers.map((w) => {
    const ids = new Set([w.shiftId, ...scheduleRows.filter((s) => s.workerId === w.id).map((s) => s.shiftId)])
    const list = [...ids].map((id) => (id ? shiftById.get(id) : undefined)).filter((s): s is ShiftRow => !!s)
    const { current, next } = list.length ? shiftBlocksAt(list, now) : { current: null, next: null }
    const mine = sessions.filter((s) => s.workerId === w.id).sort((a, b) => b.shiftStart.getTime() - a.shiftStart.getTime())
    const row = current ? mine.find((s) => s.shiftStart.getTime() === current.start.getTime()) : undefined
    const latestLogin = mine.find((s) => s.loginAt)
    const loggedIn = !!latestLogin && !latestLogin.logoutAt && latestLogin.shiftEnd > now
    return {
      workerId: w.id,
      name: w.name,
      employeeId: w.employeeId,
      shiftName: current?.shiftName ?? (w.shiftId ? shiftById.get(w.shiftId)?.name : undefined) ?? list[0]?.name ?? null,
      shiftStart: current?.start.toISOString() ?? null,
      shiftEnd: current?.end.toISOString() ?? null,
      onShift: !!current,
      nextShiftStart: next?.start.toISOString() ?? null,
      loggedIn,
      loginAt: loggedIn ? latestLogin!.lastLoginAt?.toISOString() ?? latestLogin!.loginAt!.toISOString() : null,
      autoLogoutAt: loggedIn ? latestLogin!.shiftEnd.toISOString() : null,
      loggedInThisShift: !!row?.loginAt,
      remindersSent: row?.remindersSent ?? 0,
      lastReminderAt: row?.lastReminderAt?.toISOString() ?? null,
      lastLogoutAt: !loggedIn && latestLogin?.logoutAt ? latestLogin.logoutAt.toISOString() : null,
      lastLogoutReason: !loggedIn ? latestLogin?.logoutReason ?? null : null
    }
  })
}
