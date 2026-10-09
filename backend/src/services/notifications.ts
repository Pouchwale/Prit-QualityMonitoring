import { and, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { activities, jobs, machines, moduleNotificationAssignments, parameters, pushTokens, qualityChecks, users } from '../db/schema'
import { sendWebPush, type WebSubscription } from './webPush'
import { fcmEnabled, sendFcmAlert } from './fcm'
import { machineOffBetween } from './plantCalendar'
import { dateKey } from '../lib/time'

/**
 * "A check is due" push notifications, one system for every device:
 *  - Android/iOS app: Expo push (backed by Firebase on Android)
 *  - Web app / PWA on iPhone, Android browsers and PCs: Web Push (services/webPush.ts)
 * Both go to the same recipients, chosen below.
 *
 * A check's notification goes to the worker the check belongs to: whoever is running the job on
 * that machine (jobs.assigned_worker_id). A handover moves the open checks with it, so the alert
 * always reaches the worker who has the job now.
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

/**
 * Sends alerts to phones: through Firebase as a data message when the phone registered its Firebase
 * token (app 1.2.0+, so the app can speak it even when closed), otherwise, or when Firebase refuses or
 * fails, through Expo exactly as before. Each phone gets one copy. A Firebase token Firebase reports as
 * dead is cleared, so later alerts go through Expo until the app registers again.
 */
async function sendToPhones(sends: { fcmToken: string | null; message: ExpoMessage }[]) {
  const viaExpo: ExpoMessage[] = []
  const useFcm = fcmEnabled()
  await Promise.all(
    sends.map(async ({ fcmToken, message }) => {
      if (!useFcm || !fcmToken) return void viaExpo.push(message)
      const result = await sendFcmAlert(fcmToken, { title: message.title, body: message.body, data: message.data, channelId: message.channelId })
      if (result === 'sent') return
      if (result === 'unregistered') await db.update(pushTokens).set({ fcmToken: null }).where(eq(pushTokens.fcmToken, fcmToken)).catch(() => undefined)
      viaExpo.push(message)
    })
  )
  if (viaExpo.length) await sendToExpo(viaExpo)
  return viaExpo.length
}

/** Sends messages to Expo and drops tokens Expo reports as dead. */
async function sendToExpo(messages: ExpoMessage[]) {
  // Lets tests and offline development run the scheduler without contacting Expo.
  if (process.env.PUSH_DISABLED === '1') {
    // What each message would say (no device tokens in the log).
    console.log(`Push disabled, would have sent ${messages.length} message(s)`, JSON.stringify(messages.map((m) => ({ title: m.title, body: m.body, data: m.data }))))
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

/**
 * Dedicated Notification Routing:
 * Quality checks belong to either module 'IPQC' or 'QC'.
 * If check.workerId is set (schedule-based check), route directly to the assigned worker's phone.
 * Otherwise, fall back to module-configured device user.
 */
async function recipients(
  check: { id: string; module: 'IPQC' | 'QC'; workerId?: string | null; machineId?: string | null; shiftId?: string | null },
  moduleUsers: Map<string, string | null>
) {
  const targetUserId = check.workerId ?? moduleUsers.get(check.module)
  if (!targetUserId) {
    console.warn(`[notifications] No target user for check ${check.id} (module ${check.module}); notification skipped.`)
    return []
  }

  return db
    .selectDistinct({
      userId: users.id,
      token: pushTokens.token,
      kind: pushTokens.kind,
      subscription: pushTokens.subscription,
      fcmToken: pushTokens.fcmToken,
      voiceLanguage: users.voiceNotificationLanguage
    })
    .from(users)
    .innerJoin(pushTokens, eq(pushTokens.userId, users.id))
    // Only phones where the worker is signed in; a signed-out phone only gets shift login reminders.
    .where(and(eq(users.id, targetUserId), eq(users.isActive, true), eq(users.appAccess, true), isNull(pushTokens.signedOutAt)))
}

/** Item Codes are read out one character at a time ("R M L A 1 2 3 4 5"), which voices say clearly. */
const spokenCode = (code: string) => [...code.replace(/\s+/g, '')].join(' ')

/**
 * A machine name as the voice says it: a word of 2 to 5 capital letters is an abbreviation and is
 * spelled out ("AKO 320" -> "A K O 320", "GMP" -> "G M P", "IPQC7" -> "I P Q C 7"); other words and
 * numbers stay as they are ("Gallus", "Lombardi"). Only the spoken text; notifications show the name.
 */
export const spokenMachineName = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      const m = /^([A-Z]{2,5})(\d*)$/.exec(word)
      return m ? [...m[1].split(''), ...(m[2] ? [m[2]] : [])].join(' ') : word
    })
    .join(' ')

/**
 * What the phone says aloud for a due check (voice alerts in the worker app): what is due, for which
 * Item Code (or machine), how long the worker has, and what happens otherwise. The time is the
 * check's own window (due until it is missed), so it follows the configured grace period.
 */
export function voiceMessage(
  check: { module?: 'IPQC' | 'QC'; activityName?: string; parameterNames?: string[]; itemCode?: string | null; machineName?: string | null; minutes: number },
  language: VoiceLanguage = 'en'
) {
  const mod = check.module ?? 'IPQC'
  const minutes = Math.max(1, Math.round(check.minutes))
  const act = check.activityName ? check.activityName : `${mod} Check`
  if (language === 'hi') {
    return `${mod} चेक का समय हो गया है (${act})। क्वालिटी चेक पूरा करें। इसे पूरा करने के लिए आपके पास ${minutes} मिनट हैं।`
  }
  if (language === 'gu') {
    return `${mod} ચેકનો સમય થઈ ગયો છે (${act}). ક્વોલિટી ચેક પૂરો કરો. આ તપાસ પૂરી કરવા માટે તમારી પાસે ${minutes} મિનિટ છે.`
  }
  return `${mod} Check is due. Please complete the quality check. You have ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} to complete this check.`
}

/** The languages voice alerts can be spoken in (users.voice_notification_language). */
export const VOICE_LANGUAGES = ['en', 'hi', 'gu'] as const
export type VoiceLanguage = (typeof VOICE_LANGUAGES)[number]
const asVoiceLanguage = (value: string | null | undefined): VoiceLanguage => ((VOICE_LANGUAGES as readonly string[]).includes(value ?? '') ? (value as VoiceLanguage) : 'en')

/**
 * The voice part of a push's data. `voice` is always English: every app version speaks it, so a phone
 * on an older app still hears English. For Hindi or Gujarati, `voiceLocal` holds the same alert in that
 * language and `voiceLanguage` names it; app 1.3.0+ speaks that with a matching voice (and falls back to
 * `voice` when the phone has no voice for the language). The notification title and text stay English.
 */
export function voicePayload(english: string, local: string, language: VoiceLanguage) {
  return language === 'en' ? { voice: english, voiceLanguage: 'en' } : { voice: english, voiceLanguage: language, voiceLocal: local }
}

/** The test phrase of "test notification", in each language. */
function testPhrase(language: VoiceLanguage, machineName?: string) {
  if (machineName) machineName = spokenMachineName(machineName)
  if (language === 'hi') return `यह एक टेस्ट वॉइस अलर्ट है${machineName ? `, मशीन ${machineName}` : ''}। क्वालिटी चेक के अलर्ट इसी तरह बोले जाएँगे।`
  if (language === 'gu') return `આ એક ટેસ્ટ વૉઇસ એલર્ટ છે${machineName ? `, મશીન ${machineName}` : ''}. ક્વોલિટી ચેકના એલર્ટ આ રીતે બોલવામાં આવશે.`
  return `This is a test voice alert${machineName ? ` for ${machineName}` : ''}. Quality check alerts will be spoken like this.`
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
      windowEndsAt: qualityChecks.windowEndsAt,
      itemCode: qualityChecks.itemCode,
      machineName: machines.name,
      activityName: activities.name,
      activityModule: activities.module,
      checkModule: qualityChecks.module,
      kind: qualityChecks.kind,
      parameterIds: qualityChecks.parameterIds,
      jobNo: qualityChecks.jobNo
    })
    .from(qualityChecks)
    .leftJoin(machines, eq(qualityChecks.machineId, machines.id))
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
  const bodyOf = (check: (typeof due)[number]) => {
    const mod = (check.checkModule ?? check.activityModule ?? 'IPQC') as 'IPQC' | 'QC'
    return `${mod} Check is due. Please complete the quality check.`
  }

  // The same notification as before, plus what the app says aloud. voiceId (check + due time) lets the
  // phone say each check once, however often the notification is delivered or handled.
  const voiceData = (check: (typeof due)[number], language: VoiceLanguage) => {
    const mod = (check.checkModule ?? check.activityModule ?? 'IPQC') as 'IPQC' | 'QC'
    const facts = {
      module: mod,
      activityName: check.activityName,
      parameterNames: (check.parameterIds ?? []).map((id) => names.get(id) ?? ''),
      itemCode: check.itemCode,
      machineName: check.machineName,
      minutes: (check.windowEndsAt.getTime() - check.scheduledAt.getTime()) / 60_000
    }
    // English first: it is what a phone without a Hindi/Gujarati voice speaks instead.
    return { ...voicePayload(voiceMessage(facts, 'en'), voiceMessage(facts, language), language), voiceId: `${check.id}:${check.scheduledAt.toISOString()}` }
  }

  const messages: { fcmToken: string | null; message: ExpoMessage }[] = []
  const browserSends: { targets: { token: string; subscription: WebSubscription }[]; title: string; body: string; checkId: string }[] = []

  // Load configured notification recipients for IPQC and QC
  const assignments = await db
    .select({ module: moduleNotificationAssignments.module, userId: moduleNotificationAssignments.userId })
    .from(moduleNotificationAssignments)
  const moduleUsers = new Map(assignments.map((a) => [a.module, a.userId]))

  for (const check of due) {
    if (check.machineId && machineOff(check.machineId, dateKey(check.scheduledAt))) continue
    const module = (check.checkModule ?? check.activityModule ?? 'IPQC') as 'IPQC' | 'QC'
    const devices = await recipients({ ...check, module }, moduleUsers)
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
        fcmToken: r.fcmToken,
        message: {
          to: r.token,
          title: 'Quality check due',
          body: bodyOf(check),
          data: { checkId: check.id, ...voiceData(check, asVoiceLanguage(r.voiceLanguage)) },
          sound: 'default',
          priority: 'high',
          channelId: 'due-checks'
        }
      })
    }
  }

  if (messages.length) await sendToPhones(messages)
  for (const send of browserSends) await sendWebPush(send.targets, send)
  const browserCount = browserSends.reduce((n, s) => n + s.targets.length, 0)
  return { checks: due.length, messages: messages.length + browserCount }
}

/** Sends a one-off notification to a worker's phones, used by the admin to test setup. */
export async function sendTestNotification(userId: string, machineName?: string) {
  const devices = await db
    .select({ token: pushTokens.token, kind: pushTokens.kind, subscription: pushTokens.subscription, fcmToken: pushTokens.fcmToken })
    .from(pushTokens)
    .where(and(eq(pushTokens.userId, userId), isNull(pushTokens.signedOutAt)))
  if (devices.length === 0) return { devices: 0 }
  const [owner] = await db.select({ language: users.voiceNotificationLanguage }).from(users).where(eq(users.id, userId))
  const language = asVoiceLanguage(owner?.language)

  const body = machineName ? `Alerts are working for ${machineName}.` : 'Alerts are working.'
  const browsers = devices.filter((d) => d.kind === 'web' && d.subscription)
  if (browsers.length) {
    await sendWebPush(
      browsers.map((d) => ({ token: d.token, subscription: d.subscription! })),
      { title: 'Test notification', body }
    )
  }

  // A test phrase for voice alerts, with its own id so two tests in a row are both spoken (in turn).
  const voiceId = `test:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
  const viaExpo = await sendToPhones(
    devices.filter((d) => d.kind !== 'web').map((d) => ({
      fcmToken: d.fcmToken,
      message: {
        to: d.token,
        title: 'Test notification',
        body,
        data: { ...voicePayload(testPhrase('en', machineName), testPhrase(language, machineName), language), voiceId },
        sound: 'default' as const,
        priority: 'high' as const,
        channelId: 'due-checks'
      }
    }))
  )
  return { devices: devices.length, browsers: browsers.length, viaExpo }
}

/** The shift-start login reminder, spoken and shown, in each voice language. */
const SHIFT_LOGIN_TEXT: Record<VoiceLanguage, string> = {
  en: 'Your shift has started. Please log in to the Quality Monitoring App.',
  hi: 'आपकी शिफ्ट शुरू हो गई है। कृपया क्वालिटी मॉनिटरिंग ऐप में लॉग इन करें।',
  gu: 'તમારી શિફ્ટ શરૂ થઈ ગઈ છે. કૃપા કરીને ક્વોલિટી મોનિટરિંગ એપમાં લોગ ઇન કરો.'
}

/**
 * The shift-start login reminder (services/workerShifts.ts): a notification plus a voice alert on
 * every phone of the worker, through the same path as due-check alerts, so the app's voice service
 * speaks it with the app closed (Android app 1.2.0+) and queues it behind any alert already speaking.
 * The worker is signed out, so the reminder needs the phone's registration, which a logout at the
 * end of a shift keeps. `key` makes the voice id unique per shift and reminder, so a reminder is
 * spoken once however often it is delivered.
 */
export async function sendShiftLoginReminder(userId: string, key: string) {
  const devices = await db
    .select({ token: pushTokens.token, kind: pushTokens.kind, subscription: pushTokens.subscription, fcmToken: pushTokens.fcmToken, language: users.voiceNotificationLanguage })
    .from(pushTokens)
    .innerJoin(users, eq(pushTokens.userId, users.id))
    .where(and(eq(pushTokens.userId, userId), eq(users.isActive, true), eq(users.appAccess, true)))
  if (devices.length === 0) return { devices: 0 }
  const title = 'Shift started: please sign in'
  const body = SHIFT_LOGIN_TEXT.en
  const browsers = devices.filter((d) => d.kind === 'web' && d.subscription)
  if (browsers.length) {
    await sendWebPush(
      browsers.map((d) => ({ token: d.token, subscription: d.subscription! })),
      { title, body }
    )
  }
  const voiceId = `shift-login:${userId}:${key}`
  await sendToPhones(
    devices
      .filter((d) => d.kind !== 'web')
      .map((d) => {
        const language = asVoiceLanguage(d.language)
        return {
          fcmToken: d.fcmToken,
          message: {
            to: d.token,
            title,
            body,
            data: { type: 'SHIFT_LOGIN', ...voicePayload(SHIFT_LOGIN_TEXT.en, SHIFT_LOGIN_TEXT[language], language), voiceId },
            sound: 'default' as const,
            priority: 'high' as const,
            channelId: 'due-checks'
          }
        }
      })
  )
  return { devices: devices.length }
}

/** Sends a notification to every device of one user (e.g. "a job was handed over to you"). */
export async function sendToUser(userId: string, title: string, body: string, data: Record<string, unknown> = {}) {
  const devices = await db
    .select({ token: pushTokens.token, kind: pushTokens.kind, subscription: pushTokens.subscription })
    .from(pushTokens)
    .where(and(eq(pushTokens.userId, userId), isNull(pushTokens.signedOutAt)))
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
