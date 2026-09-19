import { and, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { activities, jobs, machines, parameters, pushTokens, qualityChecks, users, workerMachines } from '../db/schema'
import { sendWebPush, type WebSubscription } from './webPush'
import { machineOffBetween } from './plantCalendar'
import { dateKey } from '../lib/time'

/**
 * "A check is due" push notifications, one system for every device:
 *  - Android/iOS app: Expo push (backed by Firebase on Android)
 *  - Web app / PWA on iPhone, Android browsers and PCs: Web Push (services/webPush.ts)
 * Both go to the same recipients, chosen below.
 *
 * A check's notification goes to the worker the check is assigned to (every check has one,
 * services/workerAssignment.ts), and only while the machine is still assigned to them.
 * Open checks follow assignment changes, so the alert reaches the current worker.
 */

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'
const EXPO_RECEIPT_URL = 'https://exp.host/--/api/v2/push/getReceipts'

/** Tickets waiting for a delivery receipt, checked a short while after sending. */
const pendingTickets: { id: string; token: string; sentAt: number }[] = []
const RECEIPT_DELAY_MS = 20_000

interface ExpoMessage {
  to: string
  title: string
  body: string
  data: Record<string, unknown>
  sound: 'default'
  priority: 'high'
  channelId: string
}

interface ExpoTicket {
  status: 'ok' | 'error'
  id?: string
  message?: string
  details?: { error?: string }
}

/** Sends messages to Expo and drops tokens Expo reports as dead. */
async function sendToExpo(messages: ExpoMessage[]) {
  // Lets tests and offline development run the scheduler without contacting Expo.
  if (process.env.PUSH_DISABLED === '1') {
    console.log(`Push disabled, would have sent ${messages.length} message(s)`)
    return
  }

  for (let i = 0; i < messages.length; i += 100) {
    const chunk = messages.slice(i, i + 100)
    let tickets: ExpoTicket[] = []
    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(chunk)
      })
      if (!res.ok) {
        console.error(`Push send failed: ${res.status} ${await res.text()}`)
        continue
      }
      tickets = ((await res.json()) as { data?: ExpoTicket[] }).data ?? []
    } catch (err) {
      console.error('Push send failed', err)
      continue
    }

    const dead: string[] = []
    tickets.forEach((ticket, index) => {
      const token = chunk[index]?.to
      if (!token) return
      if (ticket.status === 'error') {
        if (ticket.details?.error === 'DeviceNotRegistered') dead.push(token)
        else console.error(`Push rejected for ${token}: ${ticket.message ?? ticket.details?.error}`)
      } else if (ticket.id) {
        pendingTickets.push({ id: ticket.id, token, sentAt: Date.now() })
      }
    })
    if (dead.length) await db.delete(pushTokens).where(inArray(pushTokens.token, dead))
  }
}

/**
 * Expo accepts a message first and delivers it afterwards, so the real outcome arrives
 * in a receipt. This reports failures and forgets phones that uninstalled the app.
 */
export async function checkPushReceipts() {
  if (process.env.PUSH_DISABLED === '1') return
  const ready = pendingTickets.filter((t) => Date.now() - t.sentAt > RECEIPT_DELAY_MS)
  if (ready.length === 0) return
  pendingTickets.splice(0, pendingTickets.length, ...pendingTickets.filter((t) => !ready.includes(t)))

  for (let i = 0; i < ready.length; i += 300) {
    const chunk = ready.slice(i, i + 300)
    try {
      const res = await fetch(EXPO_RECEIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ ids: chunk.map((t) => t.id) })
      })
      if (!res.ok) continue
      const receipts = ((await res.json()) as { data?: Record<string, ExpoTicket> }).data ?? {}
      const dead: string[] = []
      for (const t of chunk) {
        const receipt = receipts[t.id]
        if (!receipt || receipt.status !== 'error') continue
        if (receipt.details?.error === 'DeviceNotRegistered') dead.push(t.token)
        else console.error(`Push not delivered to ${t.token}: ${receipt.message ?? receipt.details?.error}`)
      }
      if (dead.length) await db.delete(pushTokens).where(inArray(pushTokens.token, dead))
    } catch (err) {
      console.error('Could not read push receipts', err)
    }
  }
}

/** Workers who should hear about this check right now. */
async function recipients(check: { id: string; machineId: string; workerId: string | null; shiftId: string | null }) {
  const conditions = [
    eq(users.role, 'WORKER'),
    eq(users.isActive, true),
    eq(users.appAccess, true),
    // The machine assignment is the hard rule.
    eq(workerMachines.machineId, check.machineId)
  ]

  // A check without a worker has nobody to notify (such checks are not created any more).
  if (!check.workerId) return []
  conditions.push(eq(users.id, check.workerId))

  return db
    .selectDistinct({ userId: users.id, token: pushTokens.token, kind: pushTokens.kind, subscription: pushTokens.subscription })
    .from(users)
    .innerJoin(workerMachines, eq(workerMachines.userId, users.id))
    .innerJoin(pushTokens, eq(pushTokens.userId, users.id))
    .where(and(...conditions))
}

/** Sends notifications for checks that have just become due. Safe to call repeatedly. */
/**
 * A job check is only notified while its job still needs it: a scheduled job check while the job is
 * ACTIVE, the Job Start check while it is STARTING, the Job End check while it is ENDING. A completed
 * or closed job never produces a notification. Shift schedule checks have no job condition.
 */
const jobStillNeedsIt = or(
  eq(qualityChecks.kind, 'SCHEDULED'),
  sql`exists (select 1 from ${jobs} where ${jobs.id} = ${qualityChecks.jobId} and ${jobs.status} = case ${qualityChecks.kind}
    when 'JOB_START' then 'STARTING'::job_status when 'JOB_END' then 'ENDING'::job_status else 'ACTIVE'::job_status end)`
)!

export async function notifyDueChecks() {
  const candidates = await db
    .select({
      id: qualityChecks.id,
      machineId: qualityChecks.machineId,
      workerId: qualityChecks.workerId,
      shiftId: qualityChecks.shiftId,
      scheduledAt: qualityChecks.scheduledAt,
      machineName: machines.name,
      activityName: activities.name,
      kind: qualityChecks.kind,
      parameterIds: qualityChecks.parameterIds,
      jobNo: qualityChecks.jobNo
    })
    .from(qualityChecks)
    .innerJoin(machines, eq(qualityChecks.machineId, machines.id))
    .innerJoin(activities, eq(qualityChecks.activityId, activities.id))
    .where(
      and(
        eq(qualityChecks.status, 'DUE'),
        isNull(qualityChecks.notifiedAt),
        lte(qualityChecks.scheduledAt, new Date()),
        jobStillNeedsIt
      )
    )
    .limit(200)

  if (candidates.length === 0) return { checks: 0, messages: 0 }

  // Claim them first, in one statement that checks the job again: a check whose job was ended,
  // completed or force-closed a moment ago (its check removed, or the job no longer in that state) is
  // never sent, a failed send does not loop, and two servers never send the same notification.
  const claimed = new Set(
    (
      await db
        .update(qualityChecks)
        .set({ notifiedAt: new Date() })
        .where(and(inArray(qualityChecks.id, candidates.map((c) => c.id)), eq(qualityChecks.status, 'DUE'), isNull(qualityChecks.notifiedAt), jobStillNeedsIt))
        .returning({ id: qualityChecks.id })
    ).map((r) => r.id)
  )
  const due = candidates.filter((c) => claimed.has(c.id))
  if (due.length === 0) return { checks: 0, messages: 0 }

  // Plant Calendar: never alert for a check on a closed date, or of a machine not scheduled to
  // run that day (machine day plans); a planned machine is alerted even on a closed date.
  const times = due.map((c) => c.scheduledAt.getTime())
  const machineOff = await machineOffBetween(new Date(Math.min(...times)), new Date(Math.max(...times)))

  // A job check names exactly the parameters that are due, e.g. "Viscosity, Printing quality".
  const parameterIds = [...new Set(due.flatMap((c) => c.parameterIds ?? []))]
  const names = new Map(
    parameterIds.length
      ? (await db.select({ id: parameters.id, name: parameters.name }).from(parameters).where(inArray(parameters.id, parameterIds))).map((p) => [p.id, p.name])
      : []
  )
  const bodyOf = (check: (typeof due)[number]) =>
    check.kind === 'SCHEDULED' || !check.parameterIds?.length
      ? `${check.machineName} · ${check.activityName}`
      : `${check.machineName}${check.jobNo ? ` · Job ${check.jobNo}` : ''} · ${check.parameterIds.map((id) => names.get(id) ?? '').filter(Boolean).join(', ')}`

  const messages: ExpoMessage[] = []
  const browserSends: { targets: { token: string; subscription: WebSubscription }[]; title: string; body: string; checkId: string }[] = []
  for (const check of due) {
    if (machineOff(check.machineId, dateKey(check.scheduledAt))) continue
    const devices = await recipients(check)
    const browsers = devices.filter((d) => d.kind === 'web' && d.subscription)
    if (browsers.length) {
      browserSends.push({
        targets: browsers.map((d) => ({ token: d.token, subscription: d.subscription! })),
        title: 'Quality check due',
        body: bodyOf(check),
        checkId: check.id
      })
    }
    for (const r of devices.filter((d) => d.kind !== 'web')) {
      messages.push({
        to: r.token,
        title: 'Quality check due',
        body: bodyOf(check),
        data: { checkId: check.id },
        sound: 'default',
        priority: 'high',
        channelId: 'due-checks'
      })
    }
  }

  if (messages.length) await sendToExpo(messages)
  for (const send of browserSends) await sendWebPush(send.targets, send)
  const browserCount = browserSends.reduce((n, s) => n + s.targets.length, 0)
  return { checks: due.length, messages: messages.length + browserCount }
}

/** Sends a one-off notification to a worker's phones, used by the admin to test setup. */
export async function sendTestNotification(userId: string, machineName?: string) {
  const devices = await db
    .select({ token: pushTokens.token, kind: pushTokens.kind, subscription: pushTokens.subscription })
    .from(pushTokens)
    .where(eq(pushTokens.userId, userId))
  if (devices.length === 0) return { devices: 0 }

  const body = machineName ? `Alerts are working for ${machineName}.` : 'Alerts are working.'
  const browsers = devices.filter((d) => d.kind === 'web' && d.subscription)
  if (browsers.length) {
    await sendWebPush(
      browsers.map((d) => ({ token: d.token, subscription: d.subscription! })),
      { title: 'Test notification', body }
    )
  }

  await sendToExpo(
    devices.filter((d) => d.kind !== 'web').map((d) => ({
      to: d.token,
      title: 'Test notification',
      body,
      data: {},
      sound: 'default' as const,
      priority: 'high' as const,
      channelId: 'due-checks'
    }))
  )
  return { devices: devices.length, browsers: browsers.length }
}

/** Sends a notification to every device of one user (e.g. "a job was handed over to you"). */
export async function sendToUser(userId: string, title: string, body: string, data: Record<string, unknown> = {}) {
  const devices = await db
    .select({ token: pushTokens.token, kind: pushTokens.kind, subscription: pushTokens.subscription })
    .from(pushTokens)
    .where(eq(pushTokens.userId, userId))
  if (devices.length === 0) return { devices: 0 }
  const browsers = devices.filter((d) => d.kind === 'web' && d.subscription)
  if (browsers.length) {
    await sendWebPush(
      browsers.map((d) => ({ token: d.token, subscription: d.subscription! })),
      { title, body }
    )
  }
  const phones = devices.filter((d) => d.kind !== 'web')
  if (phones.length) {
    await sendToExpo(
      phones.map((d) => ({ to: d.token, title, body, data, sound: 'default' as const, priority: 'high' as const, channelId: 'due-checks' }))
    )
  }
  return { devices: devices.length }
}
