import { and, eq, gte, inArray, isNotNull, isNull, lt, or } from 'drizzle-orm'
import { db } from '../db/client'
import { pushTokens, settings, users } from '../db/schema'
import { sendFcmData } from './fcm'
import { onShiftNow } from './workerShifts'

/**
 * Company Wi-Fi alert rule (Shifts page → Company Wi-Fi rule; the Super Admin turns it on).
 *
 * When it is on, a check alert goes only to a phone that is on company Wi-Fi now, and only while the
 * worker's shift is running. "On company Wi-Fi" = the phone reached this server within the last
 * `freshMinutes`: this server is reachable on the company network only (10.192.193.14), so a request
 * that arrives proves it. A phone that has not been seen recently cannot be verified and gets no
 * check alert (the Super Admin's choice): the alert is held, not dropped, and goes out as soon as the
 * phone is seen again while the check is still open.
 *
 * How phones are seen:
 *  - the app reports while it is open (POST /api/worker/presence) and when it registers for alerts;
 *  - with the app closed, the server sends a silent presence probe every `probeMinutes` during the
 *    shift; the native voice service (app 1.2.0+) receives it and sends its log to this server
 *    (/api/device/voice-events), which marks the phone as seen. Off the company network that request
 *    cannot arrive, so the phone stays unseen.
 *
 * Shift-start login reminders are not held: the worker is signed out then and has to be reminded.
 * A worker with no shift at all is not restricted by shifts, only by Wi-Fi.
 */

export interface WifiRuleSettings {
  enabled: boolean
  /** A phone counts as on company Wi-Fi this long after it last reached the server. */
  freshMinutes: number
  /** How often an unseen phone on shift is probed. */
  probeMinutes: number
}

export const WIFI_RULE_DEFAULTS: WifiRuleSettings = { enabled: false, freshMinutes: 10, probeMinutes: 4 }
const SETTINGS_KEY = 'wifiAlertRule'

export async function getWifiRule(): Promise<WifiRuleSettings> {
  const [row] = await db.select().from(settings).where(eq(settings.key, SETTINGS_KEY))
  return { ...WIFI_RULE_DEFAULTS, ...((row?.value as Partial<WifiRuleSettings> | undefined) ?? {}) }
}

export async function saveWifiRule(next: WifiRuleSettings) {
  await db
    .insert(settings)
    .values({ key: SETTINGS_KEY, value: next })
    .onConflictDoUpdate({ target: settings.key, set: { value: next, updatedAt: new Date() } })
  return next
}

/** A device reached this server, so it is on the company network now. */
export async function markOnNetwork(where: { fcmToken: string } | { token: string; userId: string } | { webOfUser: string }) {
  const now = new Date()
  const cond =
    'fcmToken' in where
      ? eq(pushTokens.fcmToken, where.fcmToken)
      : 'token' in where
        ? and(eq(pushTokens.token, where.token), eq(pushTokens.userId, where.userId))
        : and(eq(pushTokens.userId, where.webOfUser), eq(pushTokens.kind, 'web'))
  await db.update(pushTokens).set({ onNetworkAt: now }).where(cond!)
}

/**
 * Which of these users may get a check alert now, and the earliest "seen" time that counts.
 * Rule off: everyone (null). Rule on: users whose shift runs now (or who have no shift) and who have a
 * signed-in device seen on company Wi-Fi recently.
 */
export async function alertableUsers(userIds: string[], now = new Date()): Promise<{ allowed: Set<string>; seenSince: Date } | null> {
  const rule = await getWifiRule()
  if (!rule.enabled) return null
  const seenSince = new Date(now.getTime() - rule.freshMinutes * 60_000)
  const unique = [...new Set(userIds)]
  if (!unique.length) return { allowed: new Set(), seenSince }
  const [shiftState, seen] = await Promise.all([
    onShiftNow(unique, now),
    db
      .selectDistinct({ userId: pushTokens.userId })
      .from(pushTokens)
      .where(and(inArray(pushTokens.userId, unique), isNull(pushTokens.signedOutAt), gte(pushTokens.onNetworkAt, seenSince)))
  ])
  const seenUsers = new Set(seen.map((s) => s.userId))
  return { allowed: new Set(unique.filter((id) => shiftState.get(id) !== false && seenUsers.has(id))), seenSince }
}

/** When each unseen phone was last probed (this process). */
const lastProbe = new Map<string, number>()

/**
 * Probes the signed-in Android phones (with the native voice service) of workers on shift that have
 * not been seen recently. Run every scheduler tick; each phone is probed at most every `probeMinutes`.
 */
export async function sendPresenceProbes(now = new Date()): Promise<number> {
  const rule = await getWifiRule()
  if (!rule.enabled) return 0
  const every = rule.probeMinutes * 60_000
  const devices = await db
    .select({ userId: pushTokens.userId, fcmToken: pushTokens.fcmToken })
    .from(pushTokens)
    .innerJoin(users, eq(users.id, pushTokens.userId))
    .where(
      and(
        isNotNull(pushTokens.fcmToken),
        isNull(pushTokens.signedOutAt),
        eq(users.isActive, true),
        eq(users.appAccess, true),
        or(isNull(pushTokens.onNetworkAt), lt(pushTokens.onNetworkAt, new Date(now.getTime() - every)))
      )
    )
  if (!devices.length) return 0
  const shiftState = await onShiftNow([...new Set(devices.map((d) => d.userId))], now)
  let sent = 0
  for (const d of devices) {
    if (shiftState.get(d.userId) === false) continue
    const token = d.fcmToken!
    if (now.getTime() - (lastProbe.get(token) ?? 0) < every) continue
    lastProbe.set(token, now.getTime())
    // No title or text: Android does not show it. The native service logs it and sends the log here.
    if ((await sendFcmData(token, { body: JSON.stringify({ type: 'PRESENCE_PROBE', at: now.toISOString() }) })) === 'sent') sent++
  }
  return sent
}
