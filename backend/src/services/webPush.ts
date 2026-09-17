import webpush from 'web-push'
import { eq, inArray } from 'drizzle-orm'
import { db } from '../db/client'
import { pushTokens, settings } from '../db/schema'

/**
 * Browser notifications (Web Push) for the worker web app on iPhone, Android browsers and PCs.
 *
 * Messages are signed with a VAPID key pair. The pair is created the first time it is needed
 * and stored in the settings table, so every browser subscription keeps working across
 * restarts. Set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY to supply your own pair instead.
 * Rotating the pair invalidates every browser subscription (workers re-allow alerts).
 */

const SETTINGS_KEY = 'webPushVapid'

export interface WebSubscription {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

export interface WebPushMessage {
  title: string
  body: string
  /** Check to open when the notification is tapped. */
  checkId?: string
}

let configured: { publicKey: string } | null = null

async function vapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY }
  }
  const [row] = await db.select().from(settings).where(eq(settings.key, SETTINGS_KEY))
  const stored = row?.value as { publicKey?: string; privateKey?: string } | undefined
  if (stored?.publicKey && stored.privateKey) return { publicKey: stored.publicKey, privateKey: stored.privateKey }

  const generated = webpush.generateVAPIDKeys()
  // Another process may have created a pair at the same moment; keep whichever was stored first.
  await db.insert(settings).values({ key: SETTINGS_KEY, value: generated }).onConflictDoNothing()
  const [saved] = await db.select().from(settings).where(eq(settings.key, SETTINGS_KEY))
  const pair = saved.value as { publicKey: string; privateKey: string }
  console.log('Created the Web Push key pair for browser notifications.')
  return pair
}

async function ensureConfigured() {
  if (configured) return configured
  const { publicKey, privateKey } = await vapidKeys()
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:quality@localhost', publicKey, privateKey)
  configured = { publicKey }
  return configured
}

/** The public key browsers need to subscribe. */
export async function webPushPublicKey() {
  return (await ensureConfigured()).publicKey
}

/**
 * Sends one message to each subscription. Subscriptions the push service reports as gone
 * (the worker cleared site data, uninstalled the PWA or revoked permission) are removed.
 */
export async function sendWebPush(targets: { token: string; subscription: WebSubscription }[], message: WebPushMessage) {
  if (targets.length === 0) return { sent: 0, failed: 0 }
  if (process.env.PUSH_DISABLED === '1') {
    console.log(`Push disabled, would have sent ${targets.length} browser notification(s)`)
    return { sent: 0, failed: 0 }
  }
  await ensureConfigured()

  const payload = JSON.stringify({
    title: message.title,
    body: message.body,
    checkId: message.checkId ?? null,
    // One notification per check: a repeat replaces the earlier one instead of stacking.
    tag: message.checkId ? `check-${message.checkId}` : 'quality-test'
  })

  const gone: string[] = []
  let sent = 0
  let failed = 0
  await Promise.all(
    targets.map(async (t) => {
      try {
        await webpush.sendNotification(t.subscription, payload, { TTL: 60 * 60, urgency: 'high' })
        sent++
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode
        if (status === 404 || status === 410) gone.push(t.token)
        else {
          failed++
          console.error(`Browser notification failed (${status ?? 'network'}): ${(err as Error).message}`)
        }
      }
    })
  )
  if (gone.length) await db.delete(pushTokens).where(inArray(pushTokens.token, gone))
  return { sent, failed, removed: gone.length }
}
