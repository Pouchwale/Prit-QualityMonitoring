import { Router } from 'express'
import { z } from 'zod'
import { eq, lt } from 'drizzle-orm'
import { db } from '../db/client'
import { pushTokens, voiceEvents } from '../db/schema'
import { HttpError } from '../lib/http'
import { markOnNetwork } from '../services/wifiRule'

/**
 * The remote voice log: the app's voice service (Android, native code, also with the app closed)
 * reports each step of a voice alert here, so voice alerts can be checked from the server.
 *
 * The voice service has no sign-in session when the app is closed, so the phone identifies itself
 * with its Firebase token (X-Device-Token), which only the phone and this server know. It can only
 * add log lines for its own worker; nothing reads them to decide anything.
 */
export const deviceRouter = Router()

const KEEP_DAYS = 14
const DAY = 24 * 60 * 60 * 1000
let lastCleanup = 0

const body = z.object({
  entries: z
    .array(
      z.object({
        at: z.number().int().positive(),
        step: z.string().trim().min(1).max(120),
        detail: z.string().max(400).nullish(),
        state: z.string().max(120).nullish()
      })
    )
    .min(1)
    .max(50)
})

deviceRouter.post('/voice-events', async (req, res) => {
  const deviceToken = String(req.get('x-device-token') ?? '').trim()
  if (!deviceToken || deviceToken.length > 4096) throw new HttpError(401, 'Unknown device')
  const [device] = await db.select({ userId: pushTokens.userId, platform: pushTokens.platform }).from(pushTokens).where(eq(pushTokens.fcmToken, deviceToken))
  if (!device) throw new HttpError(401, 'Unknown device')
  const { entries } = body.parse(req.body)
  // This server is reachable on the company network only: the phone is on company Wi-Fi now
  // (it also answers the Wi-Fi rule's presence probes this way, services/wifiRule.ts).
  await markOnNetwork({ fcmToken: deviceToken })
  const now = Date.now()
  await db.insert(voiceEvents).values(
    entries.map((e) => ({
      userId: device.userId,
      platform: device.platform,
      // A phone clock far off is replaced by the time it arrived.
      at: new Date(Math.abs(e.at - now) > DAY ? now : e.at),
      step: e.step,
      detail: e.detail ?? null,
      state: e.state ?? null
    }))
  )
  // Old lines are cleared at most once an hour, not on every report a phone sends.
  if (now - lastCleanup > 60 * 60_000) {
    lastCleanup = now
    await db.delete(voiceEvents).where(lt(voiceEvents.createdAt, new Date(now - KEEP_DAYS * DAY)))
  }
  res.status(204).end()
})
